import { clamp, toNum } from "../utils/math.js";
import { normalizeTeamName, pickPlayerName, pickSeed } from "../utils/event.js";
import { gamesFromRecord, hasSignal } from "../utils/data.js";
import { soccerRecordStrength, findEspnLeaderSide, getEspnCategoryLeader, parseNbaTeamSeasonStatsFromBoxscore } from "../data/espn.js";
import { estimatePropProbabilities } from "../model/props.js";
import { oddsFromProbability, confidenceFromProbability, confidenceFromCombo, computeEdge, bookHalfLine, winProbFromRecords } from "../model/scoring.js";
import { buildMoneylinePick, buildTotalsPick, buildPropPick } from "../picks/builders.js";

function p2pick(p, o) {
  return { modelProb: p, odds: o, edge: computeEdge(p, o) };
}

export function analyzeBasketballEvent(event, leagueName, leagueSlug, dateKey, summary = null, calibrationStore = null) {
  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return [];

  const homeName = normalizeTeamName(home);
  const awayName = normalizeTeamName(away);
  const eventName = `${homeName} vs ${awayName}`;
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;
  const s = pickSeed(dateKey, event, "nba");

  const homeScore = toNum(home.score);
  const awayScore = toNum(away.score);
  const diff = homeScore - awayScore;

  // Win probability desde records reales de temporada
  const homeGP = gamesFromRecord(home.records?.[0]?.summary || "");
  const awayGP = gamesFromRecord(away.records?.[0]?.summary || "");
  const hasRecords = homeGP >= 5 && awayGP >= 5;

  const hWR = soccerRecordStrength(home.records?.[0]?.summary || "0-0");
  const aWR = soccerRecordStrength(away.records?.[0]?.summary || "0-0");
  const pHomeWin = winProbFromRecords(hWR, aWR, 0.03);
  const favorite = pHomeWin >= 0.5 ? homeName : awayName;
  const underdog = pHomeWin >= 0.5 ? awayName : homeName;
  const pFavNba = clamp(Math.max(pHomeWin, 1 - pHomeWin), 0.35, 0.85);
  const favComp = pHomeWin >= 0.5 ? home : away;
  const favTeamId = favComp?.team?.id;

  const homeSeason = summary ? parseNbaTeamSeasonStatsFromBoxscore(summary, home.team?.id) : {};
  const awaySeason = summary ? parseNbaTeamSeasonStatsFromBoxscore(summary, away.team?.id) : {};
  const favSeason = summary ? parseNbaTeamSeasonStatsFromBoxscore(summary, favTeamId) : {};

  const favSide = summary && favTeamId ? findEspnLeaderSide(summary, favTeamId) : null;
  const ptsL = favSide ? getEspnCategoryLeader(favSide, "pointsPerGame") : null;
  const rebL = favSide ? getEspnCategoryLeader(favSide, "reboundsPerGame") : null;
  const astL = favSide ? getEspnCategoryLeader(favSide, "assistsPerGame") : null;
  const stlL = favSide ? getEspnCategoryLeader(favSide, "stealsPerGame") : null;
  const blkL = favSide ? getEspnCategoryLeader(favSide, "blocksPerGame") : null;
  const tpmL = favSide ? getEspnCategoryLeader(favSide, "threePointFieldGoalsPerGame") : null;

  const propPlayerPts = ptsL?.player || pickPlayerName(event, favorite, `Lider de ${favorite}`);
  const propPlayerReb = rebL?.player || propPlayerPts;
  const propPlayerAst = astL?.player || propPlayerPts;
  const propPlayerStl = stlL?.player || propPlayerPts;
  const propPlayerBlk = blkL?.player || propPlayerPts;
  const propPlayer3pm = tpmL?.player || propPlayerPts;

  const ppg = Number.isFinite(ptsL?.value) ? ptsL.value : 18;
  const teamAstAvg = favSeason.avgAssists;
  const sameStar = ptsL && rebL && astL && ptsL.player === rebL.player && ptsL.player === astL.player
    && Number.isFinite(ptsL.value) && Number.isFinite(rebL.value) && Number.isFinite(astL.value);
  const praEst = sameStar ? ptsL.value + rebL.value + astL.value : ppg * 1.72;
  const triEst = clamp(ppg * 0.14, 1.5, 4.5);

  const linePts = Number.isFinite(ptsL?.value) ? bookHalfLine(ptsL.value) : "20.5";
  const lineReb = Number.isFinite(rebL?.value) ? bookHalfLine(rebL.value) : "5.5";
  const lineAst = Number.isFinite(astL?.value) ? bookHalfLine(astL.value) : "5.5";
  const linePra = bookHalfLine(praEst);
  const lineTri = bookHalfLine(triEst);
  const lineTeamAst = Number.isFinite(teamAstAvg) ? bookHalfLine(teamAstAvg) : "26.5";

  const sumPpg = (homeSeason.avgPoints || 0) + (awaySeason.avgPoints || 0);
  const lineGameTot = sumPpg > 180 ? `${bookHalfLine(sumPpg)} puntos` : "219.5 puntos";
  const totNum = parseFloat(lineGameTot);
  // Over/Under solo desde datos reales: si la suma de PPG supera la línea → Over
  const overGame = Number.isFinite(totNum) ? (sumPpg >= totNum - 0.5) : (homeScore + awayScore > 200);

  const picks = [];

  // ── Moneyline ────────────────────────────────────────────────────────────
  const oddsMlNba = oddsFromProbability(pFavNba);
  picks.push(buildMoneylinePick({
    sport: "baloncesto", league: leagueName, eventName,
    favorite, underdog,
    ...p2pick(pFavNba, oddsMlNba),
    confidence: confidenceFromProbability(pFavNba, 40, 88),
    argument: `Win% local=${(hWR*100).toFixed(0)}%, visitante=${(aWR*100).toFixed(0)}% (records de temporada ESPN).`,
    eventDateUtc
  }));

  // ── Spread ───────────────────────────────────────────────────────────────
  // Spread estimado desde win%: brecha de win% × 25 pts promedio de partido NBA ≈ ventaja real
  const spreadEst = clamp((pFavNba - 0.5) * 22, 0.5, 14.5);
  const spreadLine = bookHalfLine(spreadEst);
  const pSpread = clamp(pFavNba - 0.04, 0.30, 0.78);
  const oddsSp = oddsFromProbability(pSpread);
  if (hasRecords && hasSignal(pSpread, 0.06)) {
    picks.push({
      sport: "baloncesto", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
      market: "spread", marketLabel: "Spread / Handicap",
      lineLabel: `-${spreadLine}`, sideLabel: favorite,
      selection: `${favorite} -${spreadLine}`,
      ...p2pick(pSpread, oddsSp),
      confidence: confidenceFromProbability(pSpread, 38, 84),
      argument: `Spread calculado desde win% temporada: ${(hWR*100).toFixed(0)}% local vs ${(aWR*100).toFixed(0)}% visitante → línea estimada -${spreadLine}.`
    });
  }

  // ── Total del partido ────────────────────────────────────────────────────
  const gameTotProb = Number.isFinite(sumPpg) && sumPpg > 180
    ? clamp(0.5 + (sumPpg - totNum) * 0.04, 0.35, 0.75)
    : 0.52;
  const oddsGame = oddsFromProbability(overGame ? gameTotProb : 1 - gameTotProb);
  if ((sumPpg > 180 || hasRecords) && hasSignal(gameTotProb, 0.04)) {
    picks.push(buildTotalsPick({
      sport: "baloncesto", league: leagueName, eventName,
      line: lineGameTot, over: overGame,
      ...p2pick(overGame ? gameTotProb : 1 - gameTotProb, oddsGame),
      confidence: confidenceFromProbability(overGame ? gameTotProb : 1 - gameTotProb, 40, 85),
      argument: sumPpg > 180
        ? `PPG combinado de temporada ~${sumPpg.toFixed(1)} puntos vs línea ${lineGameTot}.`
        : "Total estimado por promedio de la liga; sin PPG disponible de ESPN.",
      eventDateUtc
    }));
  }

  // ── Total 1er tiempo ─────────────────────────────────────────────────────
  const meanHalfTot = Number.isFinite(totNum) && totNum > 50 ? totNum * 0.485 : 108;
  const lineHalfNum = parseFloat(bookHalfLine(meanHalfTot));
  const fhRes = estimatePropProbabilities({ mean: meanHalfTot, line: lineHalfNum, sport: "baloncesto", stat: "puntos 1er tiempo", leagueSlug, calibrationStore });
  const pickHalfOver = fhRes.pOver >= fhRes.pUnder;
  const halfProb = pickHalfOver ? fhRes.pOver : fhRes.pUnder;
  const oddsHalf = oddsFromProbability(halfProb);
  if (sumPpg > 180 && hasSignal(halfProb, 0.05)) {
    picks.push({
      sport: "baloncesto", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
      market: "first_half", marketLabel: "Totales 1.er tiempo",
      lineLabel: `${lineHalfNum} pts`, sideLabel: pickHalfOver ? "Over" : "Under",
      selection: `${pickHalfOver ? "Over" : "Under"} ${lineHalfNum} puntos (1.er tiempo)`,
      ...p2pick(halfProb, oddsHalf),
      confidence: confidenceFromProbability(halfProb, 40, 85),
      argument: `1T estimado ~${meanHalfTot.toFixed(1)} pts (48.5% del total esperado).`
    });
  }

  const hasSummaryData = Number.isFinite(ptsL?.value);

  // ── Props individuales ────────────────────────────────────────────────────
  function makePropPick({ playerName, stat, line, meanVal, defaultMean, argExtra, shortLabel }) {
    const mean = Number.isFinite(meanVal) ? meanVal : defaultMean;
    const lineNum = parseFloat(line);
    const res = estimatePropProbabilities({ mean, line: lineNum, sport: "baloncesto", stat, leagueSlug, calibrationStore });
    const over = res.pOver >= res.pUnder;
    const prob = over ? res.pOver : res.pUnder;
    const odds = oddsFromProbability(prob);
    const propObj = buildPropPick({
      sport: "baloncesto", league: leagueName, eventName, player: playerName,
      stat, line, over,
      ...p2pick(prob, odds),
      confidence: confidenceFromProbability(prob, 42, 88),
      argument: argExtra,
      eventDateUtc
    });
    return { pick: propObj, prob, odds, short: `${playerName} ${over ? "O" : "U"} ${line} ${shortLabel}` };
  }

  const teamAstRes = estimatePropProbabilities({ mean: teamAstAvg || 26.5, line: parseFloat(lineTeamAst), sport: "baloncesto", stat: "asistencias del equipo", leagueSlug, calibrationStore });
  const pickTAstOver = teamAstRes.pOver >= teamAstRes.pUnder;
  const tAstProb = pickTAstOver ? teamAstRes.pOver : teamAstRes.pUnder;
  const oddsTa = oddsFromProbability(tAstProb);
  if (Number.isFinite(teamAstAvg) && hasSignal(tAstProb, 0.05)) {
    picks.push(buildPropPick({
      sport: "baloncesto", league: leagueName, eventName, player: favorite,
      propType: "team", teamLabel: favorite, stat: "asistencias del equipo", line: lineTeamAst, over: pickTAstOver,
      ...p2pick(tAstProb, oddsTa),
      confidence: confidenceFromProbability(tAstProb, 40, 86),
      argument: `Media asistencias de equipo (ESPN): ~${teamAstAvg.toFixed(1)}/partido.`,
      eventDateUtc
    }));
  }

  const propsList = [];
  if (hasSummaryData) {
    propsList.push(
      makePropPick({ playerName: propPlayerPts, stat: "puntos", line: linePts, meanVal: ptsL?.value, defaultMean: 20.5, shortLabel: "puntos", argExtra: `Líder anotador (ESPN): ${propPlayerPts}, ~${ptsL.value.toFixed(1)} puntos por partido.` }),
      makePropPick({ playerName: propPlayerReb, stat: "rebotes", line: lineReb, meanVal: rebL?.value, defaultMean: 5.5, shortLabel: "rebotes", argExtra: rebL ? `Líder en rebotes (ESPN): ${propPlayerReb}, ~${rebL.value.toFixed(1)} rebotes por partido.` : "Sin resumen ESPN." }),
      makePropPick({ playerName: propPlayerAst, stat: "asistencias", line: lineAst, meanVal: astL?.value, defaultMean: 5.5, shortLabel: "asistencias", argExtra: astL ? `Líder en asistencias (ESPN): ${propPlayerAst}, ~${astL.value.toFixed(1)} asistencias por partido.` : "Sin resumen ESPN." }),
      makePropPick({ playerName: propPlayerPts, stat: "puntos más rebotes más asistencias", line: linePra, meanVal: praEst, defaultMean: 30, shortLabel: "pts+reb+ast", argExtra: sameStar ? `Suma puntos, rebotes y asistencias del mismo jugador (ESPN): ~${praEst.toFixed(1)}.` : `Suma estimada ~${praEst.toFixed(1)} desde promedio anotador.` }),
      makePropPick({ playerName: propPlayerPts, stat: "triples anotados", line: lineTri, meanVal: triEst, defaultMean: 2.5, shortLabel: "triples", argExtra: `Triples estimados ~${triEst.toFixed(1)} por partido (14% del volumen anotador).` })
    );
  }

  for (const { pick: propPick } of propsList) picks.push(propPick);

  const legCandidates = [
    { prob: tAstProb, odds: oddsTa, short: `${favorite} ${pickTAstOver ? "más de" : "menos de"} ${lineTeamAst} asistencias` },
    ...propsList.map((r) => ({ prob: r.prob, odds: r.odds, short: r.short }))
  ];

  // Props opcionales: robos, tapones, 3PM (solo si ESPN tiene datos)
  for (const [ldr, statKey, shortS] of [[stlL, "robos", "rob"], [blkL, "tapones", "tap"], [tpmL, "3pm", "3PM"]]) {
    if (!Number.isFinite(ldr?.value)) continue;
    const player = ldr === stlL ? propPlayerStl : (ldr === blkL ? propPlayerBlk : propPlayer3pm);
    const lineX = bookHalfLine(ldr.value);
    const res = estimatePropProbabilities({ mean: ldr.value, line: parseFloat(lineX), sport: "baloncesto", stat: statKey, leagueSlug, calibrationStore });
    const over = res.pOver >= res.pUnder;
    const prob = over ? res.pOver : res.pUnder;
    const odds = oddsFromProbability(prob);
    picks.push(buildPropPick({
      sport: "baloncesto", league: leagueName, eventName, player, stat: statKey === "3pm" ? "triples anotados" : statKey, line: lineX, over,
      ...p2pick(prob, odds),
      confidence: confidenceFromProbability(prob, 40, 86),
      argument: `${statKey} (líder ESPN): ~${ldr.value.toFixed(1)}/partido.`,
      eventDateUtc
    }));
    const shortSLabel = shortS === "rob" ? "robos" : shortS === "tap" ? "tapones" : "triples";
    legCandidates.push({ prob, odds, short: `${player} ${over ? "más de" : "menos de"} ${lineX} ${shortSLabel}` });
  }

  // ── Combinada SGP x2 ─────────────────────────────────────────────────────
  const ranked = legCandidates.slice().sort((a, b) => Math.max(b.prob, 1-b.prob) - Math.max(a.prob, 1-a.prob));
  if (ranked.length >= 2 && Math.max(ranked[0].prob, 1-ranked[0].prob) >= 0.56 && Math.max(ranked[1].prob, 1-ranked[1].prob) >= 0.56) {
    const a = ranked[0], b = ranked[1];
    const oddsCombo = Number(Math.max(1.10, Math.min(1.92, a.odds * b.odds * 0.87)).toFixed(2));
    picks.push({
      sport: "baloncesto", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
      market: "combo_same_game", marketLabel: "Combinada mismo partido",
      selection: `${a.short} + ${b.short}`,
      odds: oddsCombo, confidence: confidenceFromCombo(a.prob, b.prob),
      modelProb: Math.min(a.prob, b.prob), edge: computeEdge(Math.min(a.prob, b.prob), oddsCombo),
      argument: "Dos líneas coherentes del mismo partido (ESPN + calibración rolling). Cuota combinada referencial; piernas correlacionadas."
    });
  }

  return picks;
}
