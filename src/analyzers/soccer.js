import { clamp, toNum } from "../utils/math.js";
import { pickSeed } from "../utils/event.js";
import { normalizeTeamName } from "../utils/event.js";
import {
  findEspnLeaderSide, getEspnCategoryLeader,
  soccerLeaderGoalsPer90, soccerLeaderAssistsPer90, soccerLeaderShotsPer90,
  soccerRecordStrength
} from "../data/espn.js";
import { estimatePropProbabilities } from "../model/props.js";
import {
  oddsFromProbability, confidenceFromProbability, confidenceFromCombo,
  computeEdge, bookHalfLine, winProbFromRecords
} from "../model/scoring.js";
import { buildMoneylinePick, buildTotalsPick, buildPropPick } from "../picks/builders.js";

function pick(p, o) {
  return { modelProb: p, odds: o, edge: computeEdge(p, o) };
}

export function analyzeSoccerEvent(event, leagueName, dateKey, summary = null, calibrationStore = null, leagueSlug = "esp.1") {
  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return [];

  const homeName = normalizeTeamName(home);
  const awayName = normalizeTeamName(away);
  const eventName = `${homeName} vs ${awayName}`;
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;

  const homeRecord = home.records?.[0]?.summary || "0-0-0";
  const awayRecord = away.records?.[0]?.summary || "0-0-0";
  const homeScore = toNum(home.score);
  const awayScore = toNum(away.score);
  const scoreDiff = homeScore - awayScore;

  const hStr = soccerRecordStrength(homeRecord);
  const aStr = soccerRecordStrength(awayRecord);

  // Ganador: win probability pura desde records + ventaja local
  const pHomeWin = winProbFromRecords(hStr, aStr, 0.03);
  const favorite = pHomeWin >= 0.5 ? homeName : awayName;
  const underdog = pHomeWin >= 0.5 ? awayName : homeName;
  const pFavWin = clamp(Math.max(pHomeWin, 1 - pHomeWin), 0.35, 0.88);
  const favComp = pHomeWin >= 0.5 ? home : away;
  const favTeamId = favComp?.team?.id;

  // Proyección de goles: función determinística de forma y diferencial
  const projectedGoals = clamp(
    2.05 + Math.abs(scoreDiff) * 0.22 + (hStr + aStr - 1.0) * 0.45,
    1.2, 5.0
  );

  const s = pickSeed(dateKey, event, "futbol");
  const picks = [];

  // ── Moneyline ────────────────────────────────────────────────────────────
  const oddsMl = oddsFromProbability(pFavWin);
  picks.push(buildMoneylinePick({
    sport: "futbol", league: leagueName, eventName,
    favorite, underdog,
    ...pick(pFavWin, oddsMl),
    confidence: confidenceFromProbability(pFavWin, 40, 88),
    argument: `Forma (${homeName}: ${homeRecord}, ${awayName}: ${awayRecord}). Win% local=${(hStr*100).toFixed(0)}%, visitante=${(aStr*100).toFixed(0)}%.`,
    eventDateUtc
  }));

  // ── Over/Under goles ─────────────────────────────────────────────────────
  const lineGNum = projectedGoals >= 2.75 ? 2.5 : 3.5;
  const totRes = estimatePropProbabilities({ mean: projectedGoals, line: lineGNum, sport: "futbol", stat: "goles partido", leagueSlug, calibrationStore });
  const pickGoalsOver = totRes.pOver >= totRes.pUnder;
  const goalsProb = pickGoalsOver ? totRes.pOver : totRes.pUnder;
  const oddsTot = oddsFromProbability(goalsProb);
  picks.push(buildTotalsPick({
    sport: "futbol", league: leagueName, eventName,
    line: `${lineGNum} goles`, over: pickGoalsOver,
    ...pick(goalsProb, oddsTot),
    confidence: confidenceFromProbability(goalsProb, 42, 88),
    argument: `Proyección xG ~${projectedGoals.toFixed(2)} goles; línea ${lineGNum} (calibración rolling por liga).`,
    eventDateUtc
  }));

  // ── Corners ──────────────────────────────────────────────────────────────
  const meanCorners = clamp(9.25 + (projectedGoals - 2.35) * 0.82 + (hStr + aStr - 1) * 0.55, 6.0, 14.0);
  const lineCn = parseFloat(bookHalfLine(meanCorners));
  const cornRes = estimatePropProbabilities({ mean: meanCorners, line: lineCn, sport: "futbol", stat: "corners partido", leagueSlug, calibrationStore });
  const pickCornOver = cornRes.pOver >= cornRes.pUnder;
  const cornProb = pickCornOver ? cornRes.pOver : cornRes.pUnder;
  const oddsCo = oddsFromProbability(cornProb);
  picks.push({
    sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "corners", marketLabel: "Tiros de esquina",
    lineLabel: String(lineCn), sideLabel: pickCornOver ? "Más de" : "Menos de",
    selection: `${pickCornOver ? "Más de" : "Menos de"} ${lineCn} tiros de esquina`,
    odds: oddsCo, confidence: confidenceFromProbability(cornProb, 42, 88),
    modelProb: cornProb, edge: computeEdge(cornProb, oddsCo),
    argument: `Media corners inferida ~${meanCorners.toFixed(1)} (ritmo ofensivo + forma de equipos).`
  });

  // ── Handicap asiático ─────────────────────────────────────────────────────
  const pHc = clamp(0.5 + (hStr - aStr) * 0.35, 0.22, 0.85);
  const oddsHc = oddsFromProbability(pHc);
  picks.push({
    sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "handicap", marketLabel: "Handicap asiático",
    lineLabel: "-0.5", sideLabel: favorite,
    selection: `${favorite} -0.5 handicap asiático`,
    odds: oddsHc, confidence: confidenceFromProbability(pHc, 40, 86),
    modelProb: pHc, edge: computeEdge(pHc, oddsHc),
    argument: `Brecha de forma entre equipos: local=${(hStr*100).toFixed(0)}% vs visitante=${(aStr*100).toFixed(0)}%.`
  });

  // ── BTTS ──────────────────────────────────────────────────────────────────
  const pBtts = clamp(0.34 + projectedGoals * 0.13 + (hStr + aStr) * 0.12, 0.15, 0.88);
  const pickBtYes = pBtts >= 0.5;
  const bttsProb = pickBtYes ? pBtts : 1 - pBtts;
  const oddsBt = oddsFromProbability(bttsProb);
  picks.push({
    sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "btts", marketLabel: "Ambos equipos anotan",
    lineLabel: "Ambos anotan", sideLabel: pickBtYes ? "Sí" : "No",
    selection: `${pickBtYes ? "Sí" : "No"} - ambos equipos anotan`,
    odds: oddsBt, confidence: confidenceFromProbability(bttsProb, 40, 86),
    modelProb: bttsProb, edge: computeEdge(bttsProb, oddsBt),
    argument: `Ambos anotan modelado con goles esperados ~${projectedGoals.toFixed(2)} y capacidades ofensivas de ambos equipos.`
  });

  // ── Tarjetas ──────────────────────────────────────────────────────────────
  const meanCards = clamp(4.15 + Math.abs(hStr - aStr) * 1.95 + (projectedGoals - 2.2) * 0.35, 2.5, 8.0);
  const lineCard = 4.5;
  const cardRes = estimatePropProbabilities({ mean: meanCards, line: lineCard, sport: "futbol", stat: "tarjetas partido", leagueSlug, calibrationStore });
  const pickCardOver = cardRes.pOver >= cardRes.pUnder;
  const cardProb = pickCardOver ? cardRes.pOver : cardRes.pUnder;
  const oddsCa = oddsFromProbability(cardProb);
  picks.push({
    sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "cards", marketLabel: "Tarjetas amarillas",
    lineLabel: String(lineCard), sideLabel: pickCardOver ? "Más de" : "Menos de",
    selection: `${pickCardOver ? "Más de" : "Menos de"} ${lineCard} tarjetas amarillas`,
    odds: oddsCa, confidence: confidenceFromProbability(cardProb, 40, 86),
    modelProb: cardProb, edge: computeEdge(cardProb, oddsCa),
    argument: `Disciplina esperada ~${meanCards.toFixed(1)} tarjetas (tensión del duelo por brecha de forma).`
  });

  // ── Goles 1.er tiempo ────────────────────────────────────────────────────
  const mean1h = clamp(projectedGoals * 0.42, 0.3, 2.5);
  const line1h = 1.5;
  const fhRes = estimatePropProbabilities({ mean: mean1h, line: line1h, sport: "futbol", stat: "goles 1T", leagueSlug, calibrationStore });
  const pick1hOver = fhRes.pOver >= fhRes.pUnder;
  const fhProb = pick1hOver ? fhRes.pOver : fhRes.pUnder;
  const odds1t = oddsFromProbability(fhProb);
  picks.push({
    sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "first_half", marketLabel: "Goles en el primer tiempo",
    lineLabel: "1.5 goles primer tiempo", sideLabel: pick1hOver ? "Más de" : "Menos de",
    selection: `${pick1hOver ? "Más de" : "Menos de"} 1.5 goles en el primer tiempo`,
    odds: odds1t, confidence: confidenceFromProbability(fhProb, 40, 86),
    modelProb: fhProb, edge: computeEdge(fhProb, odds1t),
    argument: `Goles en el primer tiempo estimados ~${mean1h.toFixed(2)} (42% del ritmo total esperado).`
  });

  // ── Total goles equipo local ──────────────────────────────────────────────
  const meanHomeGoals = clamp(projectedGoals * (0.5 + (hStr - 0.5) * 0.25), 0.4, 3.5);
  const lineTt = 1.5;
  const ttRes = estimatePropProbabilities({ mean: meanHomeGoals, line: lineTt, sport: "futbol", stat: "goles local equipo", leagueSlug, calibrationStore });
  const pickTtOver = ttRes.pOver >= ttRes.pUnder;
  const ttProb = pickTtOver ? ttRes.pOver : ttRes.pUnder;
  const oddsTt = oddsFromProbability(ttProb);
  picks.push({
    sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "team_totals", marketLabel: "Total goles por equipo",
    playerName: null, teamLabel: homeName,
    lineLabel: String(lineTt), sideLabel: pickTtOver ? "Más de" : "Menos de",
    selection: `${homeName} ${pickTtOver ? "más de" : "menos de"} ${lineTt} goles como local`,
    odds: oddsTt, confidence: confidenceFromProbability(ttProb, 40, 86),
    modelProb: ttProb, edge: computeEdge(ttProb, oddsTt),
    argument: `Total local: media modelo ~${meanHomeGoals.toFixed(2)} goles (ajustado por win% local ${(hStr*100).toFixed(0)}%).`
  });

  // Pool de piernas para combo + props de jugador desde ESPN summary
  const legPool = [
    { prob: goalsProb, odds: oddsTot, short: `${pickGoalsOver ? "más de" : "menos de"} ${lineGNum} goles` },
    { prob: cornProb, odds: oddsCo, short: `${pickCornOver ? "más de" : "menos de"} ${lineCn} tiros de esquina` },
    { prob: cardProb, odds: oddsCa, short: `${pickCardOver ? "más de" : "menos de"} ${lineCard} tarjetas` },
    { prob: bttsProb, odds: oddsBt, short: `ambos equipos ${pickBtYes ? "sí anotan" : "no anotan"}` },
    { prob: fhProb, odds: odds1t, short: `${pick1hOver ? "más de" : "menos de"} 1.5 goles en el primer tiempo` },
    { prob: ttProb, odds: oddsTt, short: `${homeName} ${pickTtOver ? "más de" : "menos de"} ${lineTt} goles` }
  ];

  if (summary && favTeamId) {
    const side = findEspnLeaderSide(summary, favTeamId);

    // Props de goleador
    const goalsCat = side?.leaders?.find((c) => c.name === "goalsLeaders");
    const gRow = goalsCat?.leaders?.[0];
    const gpg = soccerLeaderGoalsPer90(gRow);
    if (gRow?.athlete?.displayName && Number.isFinite(gpg) && gpg > 0) {
      const lineG = bookHalfLine(Math.max(0.35, gpg));
      const gRes = estimatePropProbabilities({ mean: gpg, line: parseFloat(lineG), sport: "futbol", stat: "goles (jugador)", leagueSlug, calibrationStore });
      const pickGOver = gRes.pOver >= gRes.pUnder;
      const gProb = pickGOver ? gRes.pOver : gRes.pUnder;
      const oddsG = oddsFromProbability(gProb);
      picks.push(buildPropPick({
        sport: "futbol", league: leagueName, eventName,
        player: gRow.athlete.displayName, stat: "goles (jugador)", line: lineG, over: pickGOver,
        ...pick(gProb, oddsG),
        confidence: confidenceFromProbability(gProb, 42, 88),
        argument: `Goleador ESPN: ~${gpg.toFixed(2)} goles/partido (temporada); línea ${lineG}.`,
        eventDateUtc
      }));
      legPool.push({ prob: gProb, odds: oddsG, short: `${gRow.athlete.displayName} ${pickGOver ? "más de" : "menos de"} ${lineG} goles` });
    }

    // Props de asistente
    const assistsCat = side?.leaders?.find((c) => ["assistsLeaders", "assists", "assistLeaders"].includes(c.name));
    const aRow = assistsCat?.leaders?.[0];
    const apg = soccerLeaderAssistsPer90(aRow);
    if (aRow?.athlete?.displayName && Number.isFinite(apg) && apg > 0) {
      const lineA = bookHalfLine(Math.max(0.05, apg));
      const aRes = estimatePropProbabilities({ mean: apg, line: parseFloat(lineA), sport: "futbol", stat: "asistencias (jugador)", leagueSlug, calibrationStore });
      const pickAOver = aRes.pOver >= aRes.pUnder;
      const aProb = pickAOver ? aRes.pOver : aRes.pUnder;
      const oddsA = oddsFromProbability(aProb);
      picks.push(buildPropPick({
        sport: "futbol", league: leagueName, eventName,
        player: aRow.athlete.displayName, stat: "asistencias (jugador)", line: lineA, over: pickAOver,
        ...pick(aProb, oddsA),
        confidence: confidenceFromProbability(aProb, 42, 88),
        argument: `Asistencias ESPN: ~${apg.toFixed(2)}/partido; línea ${lineA}.`,
        eventDateUtc
      }));
      legPool.push({ prob: aProb, odds: oddsA, short: `${aRow.athlete.displayName} ${pickAOver ? "más de" : "menos de"} ${lineA} asistencias` });
    }

    // Props de tiros
    const shotCat = side?.leaders?.find((c) => String(c.name || "").toLowerCase().includes("shot"));
    const shRow = shotCat?.leaders?.[0];
    const spg = soccerLeaderShotsPer90(shRow);
    if (shRow?.athlete?.displayName && Number.isFinite(spg) && spg > 0.15) {
      const lineS = bookHalfLine(spg);
      const shRes = estimatePropProbabilities({ mean: spg, line: parseFloat(lineS), sport: "futbol", stat: "tiros (jugador)", leagueSlug, calibrationStore });
      const pickSOver = shRes.pOver >= shRes.pUnder;
      const sProb = pickSOver ? shRes.pOver : shRes.pUnder;
      const oddsSh = oddsFromProbability(sProb);
      picks.push(buildPropPick({
        sport: "futbol", league: leagueName, eventName,
        player: shRow.athlete.displayName, stat: "tiros (jugador)", line: lineS, over: pickSOver,
        ...pick(sProb, oddsSh),
        confidence: confidenceFromProbability(sProb, 42, 88),
        argument: `Tiros ESPN: ~${spg.toFixed(2)}/partido; línea ${lineS}.`,
        eventDateUtc
      }));
      legPool.push({ prob: sProb, odds: oddsSh, short: `${shRow.athlete.displayName} ${pickSOver ? "más de" : "menos de"} ${lineS} tiros` });
    }
  }

  // ── Combinada (SGP x2) ────────────────────────────────────────────────────
  const ranked = legPool.slice().sort((a, b) => Math.max(b.prob, 1-b.prob) - Math.max(a.prob, 1-a.prob));
  if (ranked.length >= 2 && Math.max(ranked[0].prob, 1-ranked[0].prob) >= 0.56 && Math.max(ranked[1].prob, 1-ranked[1].prob) >= 0.56) {
    const x0 = ranked[0], x1 = ranked[1];
    const oddsCombo = Number(Math.max(1.12, Math.min(1.92, x0.odds * x1.odds * 0.87)).toFixed(2));
    const comboConf = confidenceFromCombo(x0.prob, x1.prob);
    picks.push({
      sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
      market: "combo_same_game", marketLabel: "Combinada mismo partido",
      statLabel: "SGP x2",
      selection: `${x0.short} + ${x1.short}`,
      odds: oddsCombo, confidence: comboConf,
      modelProb: Math.min(x0.prob, x1.prob),
      edge: computeEdge(Math.min(x0.prob, x1.prob), oddsCombo),
      argument: "Dos mercados fútbol con datos ESPN + calibración rolling; cuota combinada referencial (correlación ajustada)."
    });
  }

  return picks;
}
