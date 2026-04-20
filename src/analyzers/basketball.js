import { clamp, toNum } from "../utils/math.js";
import { normalizeTeamName, pickSeed } from "../utils/event.js";
import { gamesFromRecord, hasSignal } from "../utils/data.js";
import { soccerRecordStrength, findEspnLeaderSide, parseNbaTeamSeasonStatsFromBoxscore } from "../data/espn.js";
import { extractNbaPlayers, defenseAdjustment, paceMultiplier, rankPlayers } from "../data/nba.js";
import { estimatePropProbabilities } from "../model/props.js";
import { oddsFromProbability, confidenceFromProbability, confidenceFromCombo, computeEdge, bookHalfLine, winProbFromRecords } from "../model/scoring.js";
import { buildMoneylinePick, buildTotalsPick, buildPropPick } from "../picks/builders.js";

function pp(prob, odds) { return { modelProb: prob, odds, edge: computeEdge(prob, odds) }; }

/**
 * Genera un pick de prop NBA ajustando la proyección por defensa rival y pace.
 * Solo emite el pick si la señal supera el umbral.
 */
function makeNbaProp({ sport, league, eventName, eventDateUtc, leagueSlug, calibrationStore,
  playerName, stat, seasonMean, adjustedMean, signalThreshold = 0.08 }) {
  if (!Number.isFinite(seasonMean) || seasonMean <= 0) return null;
  const mean = adjustedMean ?? seasonMean;
  // Línea del libro basada en el promedio de temporada (no el ajustado)
  const line = parseFloat(bookHalfLine(seasonMean));
  const res = estimatePropProbabilities({ mean, line, sport, stat, leagueSlug, calibrationStore });
  const over = res.pOver >= res.pUnder;
  const prob = over ? res.pOver : res.pUnder;
  if (!hasSignal(prob, signalThreshold)) return null;
  const odds = oddsFromProbability(prob);
  return {
    pick: buildPropPick({
      sport, league, eventName, player: playerName,
      stat, line: String(line), over,
      ...pp(prob, odds),
      confidence: confidenceFromProbability(prob, 42, 88),
      argument: `${playerName} promedia ${seasonMean.toFixed(1)} ${stat}/partido. Proyección ajustada vs rival: ${mean.toFixed(1)} → ${over ? "superar" : "quedar bajo"} ${line}.`,
      eventDateUtc,
    }),
    prob, odds,
    short: `${playerName} ${over ? "O" : "U"} ${line} ${stat}`,
  };
}

export function analyzeBasketballEvent(event, leagueName, leagueSlug, dateKey, summary = null, calibrationStore = null) {
  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const home = comp.competitors.find(c => c.homeAway === "home");
  const away = comp.competitors.find(c => c.homeAway === "away");
  if (!home || !away) return [];

  const homeName = normalizeTeamName(home);
  const awayName  = normalizeTeamName(away);
  const eventName = `${homeName} vs ${awayName}`;
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;

  const homeGP = gamesFromRecord(home.records?.[0]?.summary || "");
  const awayGP  = gamesFromRecord(away.records?.[0]?.summary  || "");
  const hasRecords = homeGP >= 5 && awayGP >= 5;

  const hWR = soccerRecordStrength(home.records?.[0]?.summary || "0-0");
  const aWR = soccerRecordStrength(away.records?.[0]?.summary  || "0-0");
  const pHomeWin = winProbFromRecords(hWR, aWR, 0.03);
  const favorite  = pHomeWin >= 0.5 ? homeName : awayName;
  const underdog  = pHomeWin >= 0.5 ? awayName  : homeName;
  const pFavNba   = clamp(Math.max(pHomeWin, 1 - pHomeWin), 0.35, 0.85);

  // Team season stats for game total
  const homeSeason = summary ? parseNbaTeamSeasonStatsFromBoxscore(summary, home.team?.id) : {};
  const awaySeason  = summary ? parseNbaTeamSeasonStatsFromBoxscore(summary, away.team?.id) : {};
  const sumPpg = (homeSeason.avgPoints || 0) + (awaySeason.avgPoints || 0);

  // ── Moneyline ──────────────────────────────────────────────────────────────
  const picks = [];
  const legPool = []; // para combinadas

  if (Math.abs(pFavNba - 0.5) >= 0.05) {
    const oddsMl = oddsFromProbability(pFavNba);
    picks.push(buildMoneylinePick({
      sport: "baloncesto", league: leagueName, eventName,
      favorite, underdog,
      ...pp(pFavNba, oddsMl),
      confidence: confidenceFromProbability(pFavNba, 40, 88),
      argument: `Win% temporada: ${homeName} ${(hWR*100).toFixed(0)}% vs ${awayName} ${(aWR*100).toFixed(0)}%. Ventaja local +3%.`,
      eventDateUtc,
    }));
  }

  // ── Spread ─────────────────────────────────────────────────────────────────
  if (hasRecords && hasSignal(pFavNba, 0.07)) {
    const spreadEst  = clamp((pFavNba - 0.5) * 22, 0.5, 14.5);
    const spreadLine = bookHalfLine(spreadEst);
    const pSpread    = clamp(pFavNba - 0.04, 0.30, 0.78);
    const oddsSp     = oddsFromProbability(pSpread);
    picks.push({
      sport: "baloncesto", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
      market: "spread", marketLabel: "Spread / Handicap",
      lineLabel: `-${spreadLine}`, sideLabel: favorite,
      selection: `${favorite} -${spreadLine}`,
      ...pp(pSpread, oddsSp),
      confidence: confidenceFromProbability(pSpread, 38, 84),
      argument: `Spread estimado -${spreadLine} pts desde brecha de win% temporada (${(hWR*100).toFixed(0)}% vs ${(aWR*100).toFixed(0)}%).`,
    });
    legPool.push({ prob: pSpread, odds: oddsSp, short: `${favorite} -${spreadLine} spread` });
  }

  // ── Total del partido ──────────────────────────────────────────────────────
  if (sumPpg > 180) {
    const lineGameTot = parseFloat(bookHalfLine(sumPpg));
    const pace = paceMultiplier(sumPpg);
    const projTot = sumPpg * pace;
    const overGame = projTot >= lineGameTot;
    const gameTotProb = clamp(0.5 + (projTot - lineGameTot) * 0.035, 0.36, 0.74);
    const oddsGame = oddsFromProbability(overGame ? gameTotProb : 1 - gameTotProb);
    if (hasSignal(overGame ? gameTotProb : 1 - gameTotProb, 0.05)) {
      picks.push(buildTotalsPick({
        sport: "baloncesto", league: leagueName, eventName,
        line: `${lineGameTot} puntos`, over: overGame,
        ...pp(overGame ? gameTotProb : 1 - gameTotProb, oddsGame),
        confidence: confidenceFromProbability(overGame ? gameTotProb : 1 - gameTotProb, 40, 85),
        argument: `PPG combinado temporada ${sumPpg.toFixed(1)} pts; ritmo de partido → proyección ${projTot.toFixed(1)} vs línea ${lineGameTot}.`,
        eventDateUtc,
      }));
      legPool.push({ prob: gameTotProb, odds: oddsGame, short: `total del partido ${overGame ? "O" : "U"} ${lineGameTot}` });
    }
  }

  // ── PLAYER PROPS ──────────────────────────────────────────────────────────
  if (!summary) return picks;

  const playerMap = extractNbaPlayers(summary);
  const allPlayers = rankPlayers(playerMap);
  if (!allPlayers.length) return picks;

  // Ajuste de defensa por equipo
  // Para jugador del equipo local, el rival es el visitante (aWR)
  // Para jugador del equipo visitante, el rival es el local (hWR)
  function getDefAdj(player) {
    const isHome = String(player.teamId) === String(home.team?.id);
    const oppWR  = isHome ? aWR : hWR;
    return defenseAdjustment(oppWR);
  }

  // Ritmo global del partido
  const pace = paceMultiplier(sumPpg);

  const propCtx = { sport: "baloncesto", league: leagueName, eventName, eventDateUtc, leagueSlug, calibrationStore };

  // Genera props para los top jugadores de cada equipo (máx 3 por equipo)
  const homePlayersUsed = new Set();
  const awayPlayersUsed = new Set();

  for (const player of allPlayers) {
    const isHome = String(player.teamId) === String(home.team?.id);
    const usedSet = isHome ? homePlayersUsed : awayPlayersUsed;
    if (usedSet.size >= 3) continue; // máx 3 jugadores por equipo
    usedSet.add(player.name);

    const defAdj = getDefAdj(player);

    // ── Puntos ──────────────────────────────────────────────────────────────
    if (player.pts >= 8) {
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "puntos",
        seasonMean: player.pts, adjustedMean: player.pts * defAdj * pace });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── Rebotes ─────────────────────────────────────────────────────────────
    if (player.reb >= 2) {
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "rebotes",
        seasonMean: player.reb, adjustedMean: player.reb * defAdj * 0.98,
        signalThreshold: 0.07 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── Asistencias ─────────────────────────────────────────────────────────
    if (player.ast >= 2) {
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "asistencias",
        seasonMean: player.ast, adjustedMean: player.ast * clamp(defAdj, 0.90, 1.10),
        signalThreshold: 0.07 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── Puntos + Rebotes ────────────────────────────────────────────────────
    if (player.pts >= 8 && player.reb >= 2) {
      const mean = player.pts + player.reb;
      const adj  = player.pts * defAdj * pace + player.reb;
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "puntos más rebotes",
        seasonMean: mean, adjustedMean: adj, signalThreshold: 0.07 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── Puntos + Asistencias ────────────────────────────────────────────────
    if (player.pts >= 8 && player.ast >= 2) {
      const mean = player.pts + player.ast;
      const adj  = player.pts * defAdj * pace + player.ast;
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "puntos más asistencias",
        seasonMean: mean, adjustedMean: adj, signalThreshold: 0.07 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── PRA (Puntos + Rebotes + Asistencias) ────────────────────────────────
    if (player.pts >= 12 && player.reb >= 2 && player.ast >= 2) {
      const mean = player.pts + player.reb + player.ast;
      const adj  = player.pts * defAdj * pace + player.reb + player.ast;
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "puntos más rebotes más asistencias",
        seasonMean: mean, adjustedMean: adj, signalThreshold: 0.07 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── Triples anotados ────────────────────────────────────────────────────
    if (player.tpm >= 0.5) {
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "triples anotados",
        seasonMean: player.tpm, adjustedMean: player.tpm * clamp(defAdj, 0.92, 1.08),
        signalThreshold: 0.08 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── Robos ────────────────────────────────────────────────────────────────
    if (player.stl >= 0.5) {
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "robos",
        seasonMean: player.stl, adjustedMean: player.stl, signalThreshold: 0.10 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── Tapones ──────────────────────────────────────────────────────────────
    if (player.blk >= 0.5) {
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "tapones",
        seasonMean: player.blk, adjustedMean: player.blk, signalThreshold: 0.10 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }

    // ── Turnovers (apostar Under) ────────────────────────────────────────────
    if (player.tov >= 1.0) {
      // Bajo presión de buena defensa rival → esperamos más turnovers
      const adjTov = player.tov * clamp(2 - defAdj, 0.88, 1.12);
      const r = makeNbaProp({ ...propCtx, playerName: player.name, stat: "turnovers",
        seasonMean: player.tov, adjustedMean: adjTov, signalThreshold: 0.09 });
      if (r) { picks.push(r.pick); legPool.push({ ...r, short: r.short }); }
    }
  }

  // ── Asistencias del equipo favorito ────────────────────────────────────────
  const favSide = summary && (pHomeWin >= 0.5 ? home.team?.id : away.team?.id)
    ? findEspnLeaderSide(summary, pHomeWin >= 0.5 ? home.team?.id : away.team?.id)
    : null;
  const favSeason = summary ? parseNbaTeamSeasonStatsFromBoxscore(summary, pHomeWin >= 0.5 ? home.team?.id : away.team?.id) : {};
  const teamAstAvg = favSeason.avgAssists;
  if (Number.isFinite(teamAstAvg) && teamAstAvg > 0) {
    const lineTeamAst = bookHalfLine(teamAstAvg);
    const tAstRes = estimatePropProbabilities({
      mean: teamAstAvg, line: parseFloat(lineTeamAst),
      sport: "baloncesto", stat: "asistencias del equipo", leagueSlug, calibrationStore
    });
    const pickTAstOver = tAstRes.pOver >= tAstRes.pUnder;
    const tAstProb = pickTAstOver ? tAstRes.pOver : tAstRes.pUnder;
    const oddsTa = oddsFromProbability(tAstProb);
    if (hasSignal(tAstProb, 0.06)) {
      picks.push(buildPropPick({
        sport: "baloncesto", league: leagueName, eventName, player: favorite,
        propType: "team", teamLabel: favorite, stat: "asistencias del equipo",
        line: lineTeamAst, over: pickTAstOver,
        ...pp(tAstProb, oddsTa),
        confidence: confidenceFromProbability(tAstProb, 40, 86),
        argument: `${favorite} promedia ${teamAstAvg.toFixed(1)} asistencias de equipo/partido (ESPN).`,
        eventDateUtc,
      }));
      legPool.push({ prob: tAstProb, odds: oddsTa, short: `${favorite} asistencias equipo ${pickTAstOver ? "O" : "U"} ${lineTeamAst}` });
    }
  }

  // ── Combinadas SGP (x2 y x3) ──────────────────────────────────────────────
  const strongLegs = legPool
    .filter(l => Math.abs(l.prob - 0.5) >= 0.08)
    .sort((a, b) => Math.max(b.prob, 1-b.prob) - Math.max(a.prob, 1-a.prob));

  // SGP x2
  if (strongLegs.length >= 2) {
    const a = strongLegs[0], b = strongLegs[1];
    const oddsCombo = Number(Math.max(1.10, Math.min(2.10, a.odds * b.odds * 0.87)).toFixed(2));
    picks.push({
      sport: "baloncesto", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
      market: "combo_same_game", marketLabel: "Combinada mismo partido",
      selection: `${a.short} + ${b.short}`,
      odds: oddsCombo, confidence: confidenceFromCombo(a.prob, b.prob),
      modelProb: Math.min(a.prob, b.prob), edge: computeEdge(Math.min(a.prob, b.prob), oddsCombo),
      argument: `SGP x2: dos props con señal ≥8% sobre 50/50. Ajuste defensa rival aplicado.`,
    });
  }

  // SGP x3 (solo si las tres piernas tienen señal muy alta ≥12%)
  const veryStrongLegs = strongLegs.filter(l => Math.abs(l.prob - 0.5) >= 0.12);
  if (veryStrongLegs.length >= 3) {
    const [la, lb, lc] = veryStrongLegs;
    const oddsTriple = Number(Math.max(1.30, Math.min(3.20,
      la.odds * lb.odds * lc.odds * 0.80)).toFixed(2));
    picks.push({
      sport: "baloncesto", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
      market: "combo_same_game", marketLabel: "Combinada x3",
      selection: `${la.short} + ${lb.short} + ${lc.short}`,
      odds: oddsTriple, confidence: confidenceFromCombo(la.prob, lb.prob) - 8,
      modelProb: Math.min(la.prob, lb.prob, lc.prob),
      edge: computeEdge(Math.min(la.prob, lb.prob, lc.prob), oddsTriple),
      argument: `SGP x3: tres props con señal ≥12% sobre 50/50. Mayor riesgo — apuesta pequeña.`,
    });
  }

  return picks;
}
