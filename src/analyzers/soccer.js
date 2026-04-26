import { clamp, toNum } from "../utils/math.js";
import { normalizeTeamName } from "../utils/event.js";
import { gamesFromRecord, hasSignal } from "../utils/data.js";
import {
  findEspnLeaderSide,
  soccerLeaderGoalsPer90, soccerLeaderAssistsPer90, soccerLeaderShotsPer90,
  soccerRecordStrength
} from "../data/espn.js";
import { estimatePropProbabilities } from "../model/props.js";
import {
  oddsFromProbability, confidenceFromProbability, confidenceFromCombo,
  computeEdge, bookHalfLine, winProbFromRecords
} from "../model/scoring.js";
import { isMarketEnabled } from "../config/markets.js";
import { buildMoneylinePick, buildTotalsPick, buildPropPick } from "../picks/builders.js";

function pick(p, o) { return { modelProb: p, odds: o, edge: computeEdge(p, o) }; }

const RELIABLE_LEAGUES = new Set([
  "esp.1", "eng.1", "ger.1", "ita.1", "fra.1", "por.1"
]);

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

  const homeGP = gamesFromRecord(homeRecord);
  const awayGP = gamesFromRecord(awayRecord);
  // Umbral mas estricto: 8 partidos minimo
  const hasRecords = homeGP >= 8 && awayGP >= 8;
  const isReliableLeague = RELIABLE_LEAGUES.has(leagueSlug);

  const hStr = soccerRecordStrength(homeRecord);
  const aStr = soccerRecordStrength(awayRecord);

  const pHomeWin = winProbFromRecords(hStr, aStr, 0.03);
  const favorite = pHomeWin >= 0.5 ? homeName : awayName;
  const underdog = pHomeWin >= 0.5 ? awayName : homeName;
  const pFavWin = clamp(Math.max(pHomeWin, 1 - pHomeWin), 0.35, 0.88);
  const favComp = pHomeWin >= 0.5 ? home : away;
  const favTeamId = favComp?.team?.id;

  // Scoring rate real desde ESPN summary
  let homeScoringRate = null;
  let awayScoringRate = null;
  let favSide = null;

  if (summary && favTeamId) {
    favSide = findEspnLeaderSide(summary, favTeamId);
    const goalsCat = favSide?.leaders?.find(c => c.name === "goalsLeaders");
    const gRow = goalsCat?.leaders?.[0];
    const gpg = soccerLeaderGoalsPer90(gRow);
    if (Number.isFinite(gpg) && gpg > 0) {
      if (pHomeWin >= 0.5) {
        homeScoringRate = gpg;
        awayScoringRate = gpg * (aStr / Math.max(hStr, 0.01)) * 0.85;
      } else {
        awayScoringRate = gpg;
        homeScoringRate = gpg * (hStr / Math.max(aStr, 0.01)) * 0.85;
      }
    }
  }

  const hasRealGoalData = homeScoringRate != null && awayScoringRate != null;
  const projectedGoals  = hasRealGoalData
    ? clamp(homeScoringRate + awayScoringRate, 0.8, 6.0)
    : null;

  const picks = [];
  const legPool = [];

  // ── Moneyline ──────────────────────────────────────────────────────────────
  if (isMarketEnabled("futbol", "moneyline") && Math.abs(pFavWin - 0.5) >= 0.05) {
    const oddsMl = oddsFromProbability(pFavWin);
    picks.push(buildMoneylinePick({
      sport: "futbol", league: leagueName, eventName,
      favorite, underdog,
      ...pick(pFavWin, oddsMl),
      confidence: confidenceFromProbability(pFavWin, 40, 88),
      argument: `Forma ${homeName}: ${homeRecord} (${homeGP}J), ${awayName}: ${awayRecord} (${awayGP}J). Ventaja local +3%.`,
      eventDateUtc
    }));
  }

  // ── Doble oportunidad ─────────────────────────────────────────────────────
  // Mercado pedido explicitamente. 1X (local o empate), X2 (visitante o empate)
  // o 12 (cualquiera gana, no empate). Probabilidad de empate base ~25%.
  if (isMarketEnabled("futbol", "double_chance") && hasRecords) {
    const pDraw   = clamp(0.27 - Math.abs(hStr - aStr) * 0.18, 0.16, 0.33);
    const pHomeOnly = clamp(pHomeWin - pDraw / 2, 0.10, 0.85);
    const pAwayOnly = clamp((1 - pHomeWin) - pDraw / 2, 0.10, 0.85);
    const p1X = clamp(pHomeOnly + pDraw, 0.40, 0.93);
    const pX2 = clamp(pAwayOnly + pDraw, 0.40, 0.93);
    const p12 = clamp(pHomeOnly + pAwayOnly, 0.55, 0.95);

    const opciones = [
      { label: "1X", desc: `${homeName} o empate`, prob: p1X },
      { label: "X2", desc: `${awayName} o empate`, prob: pX2 },
      { label: "12", desc: "Local o visitante (no empate)", prob: p12 }
    ].sort((a, b) => b.prob - a.prob);

    const top = opciones[0];
    if (top.prob >= 0.62) {
      const oddsDc = oddsFromProbability(top.prob);
      picks.push({
        sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
        market: "double_chance", marketLabel: "Doble oportunidad",
        lineLabel: top.label, sideLabel: top.desc,
        selection: `${top.desc} (${top.label})`,
        ...pick(top.prob, oddsDc),
        confidence: confidenceFromProbability(top.prob, 50, 88),
        argument: `Doble oportunidad ${top.label}: prob ${(top.prob * 100).toFixed(0)}% combinando win% local ${(hStr*100).toFixed(0)}% vs visitante ${(aStr*100).toFixed(0)}% y empate base ${(pDraw*100).toFixed(0)}%.`
      });
      legPool.push({ prob: top.prob, odds: oddsDc, short: `doble oportunidad ${top.label}` });
    }
  }

  // ── Over/Under goles — SOLO con datos reales de scoring ───────────────────
  if (isMarketEnabled("futbol", "totals") && hasRealGoalData && hasRecords) {
    const lineGNum = projectedGoals >= 3.2 ? 3.5 : 2.5;
    const totRes = estimatePropProbabilities({
      mean: projectedGoals, line: lineGNum,
      sport: "futbol", stat: "goles partido", leagueSlug, calibrationStore
    });
    const pickGoalsOver = totRes.pOver >= totRes.pUnder;
    const goalsProb = pickGoalsOver ? totRes.pOver : totRes.pUnder;
    const oddsTot = oddsFromProbability(goalsProb);
    if (hasSignal(goalsProb, 0.08) && (isReliableLeague || hasRealGoalData)) {
      picks.push(buildTotalsPick({
        sport: "futbol", league: leagueName, eventName,
        line: `${lineGNum} goles`, over: pickGoalsOver,
        ...pick(goalsProb, oddsTot),
        confidence: confidenceFromProbability(goalsProb, 42, 86),
        argument: `Goles esperados ~${projectedGoals.toFixed(2)} (tasa ESPN ${homeName}+${awayName}). Linea ${lineGNum}.`,
        eventDateUtc
      }));
      legPool.push({ prob: goalsProb, odds: oddsTot, short: `${pickGoalsOver ? "más de" : "menos de"} ${lineGNum} goles` });
    }
  }

  // ── Tiros de esquina ──────────────────────────────────────────────────────
  if (isMarketEnabled("futbol", "corners") && hasRecords && isReliableLeague && hasRealGoalData) {
    const baseCorners = clamp(8.5 + (projectedGoals - 2.2) * 0.9 + (hStr + aStr - 1) * 0.6, 6.0, 13.5);
    const lineCn = parseFloat(bookHalfLine(baseCorners));
    const cornRes = estimatePropProbabilities({
      mean: baseCorners, line: lineCn,
      sport: "futbol", stat: "tiros de esquina partido", leagueSlug, calibrationStore
    });
    const pickCornOver = cornRes.pOver >= cornRes.pUnder;
    const cornProb = pickCornOver ? cornRes.pOver : cornRes.pUnder;
    const oddsCo = oddsFromProbability(cornProb);
    if (hasSignal(cornProb, 0.08)) {
      picks.push({
        sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
        market: "corners", marketLabel: "Tiros de esquina",
        lineLabel: String(lineCn), sideLabel: pickCornOver ? "Más de" : "Menos de",
        selection: `${pickCornOver ? "Más de" : "Menos de"} ${lineCn} tiros de esquina`,
        ...pick(cornProb, oddsCo),
        confidence: confidenceFromProbability(cornProb, 42, 86),
        argument: `Media corners estimada ~${baseCorners.toFixed(1)} (xG implícito + ritmo ofensivo).`
      });
      legPool.push({ prob: cornProb, odds: oddsCo, short: `${pickCornOver ? "más de" : "menos de"} ${lineCn} tiros de esquina` });
    }
  }

  // ── Handicap asiatico ─────────────────────────────────────────────────────
  if (isMarketEnabled("futbol", "handicap") && hasRecords && isReliableLeague) {
    const formGap = Math.abs(hStr - aStr);
    const pHc = clamp(0.5 + (hStr - aStr) * 0.35, 0.22, 0.85);
    const oddsHc = oddsFromProbability(pHc);
    if (formGap >= 0.12 && hasSignal(pHc, 0.09)) {
      picks.push({
        sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
        market: "handicap", marketLabel: "Handicap asiático",
        lineLabel: "-0.5", sideLabel: favorite,
        selection: `${favorite} -0.5 handicap asiático`,
        ...pick(pHc, oddsHc),
        confidence: confidenceFromProbability(pHc, 40, 86),
        argument: `Brecha de forma ${(formGap*100).toFixed(0)}%: ${homeName} ${(hStr*100).toFixed(0)}% vs ${awayName} ${(aStr*100).toFixed(0)}% win rate.`
      });
      legPool.push({ prob: pHc, odds: oddsHc, short: `${favorite} -0.5 handicap` });
    }
  }

  // ── Tarjetas amarillas ────────────────────────────────────────────────────
  if (isMarketEnabled("futbol", "cards") && hasRecords && isReliableLeague) {
    const formGap = Math.abs(hStr - aStr);
    const meanCards = clamp(3.8 + formGap * 2.2, 2.5, 7.5);
    const lineCard = 4.5;
    const cardRes = estimatePropProbabilities({
      mean: meanCards, line: lineCard,
      sport: "futbol", stat: "tarjetas amarillas partido", leagueSlug, calibrationStore
    });
    const pickCardOver = cardRes.pOver >= cardRes.pUnder;
    const cardProb = pickCardOver ? cardRes.pOver : cardRes.pUnder;
    const oddsCa = oddsFromProbability(cardProb);
    if (hasSignal(cardProb, 0.09)) {
      picks.push({
        sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
        market: "cards", marketLabel: "Tarjetas amarillas",
        lineLabel: String(lineCard), sideLabel: pickCardOver ? "Más de" : "Menos de",
        selection: `${pickCardOver ? "Más de" : "Menos de"} ${lineCard} tarjetas amarillas`,
        ...pick(cardProb, oddsCa),
        confidence: confidenceFromProbability(cardProb, 40, 86),
        argument: `Disciplina estimada ~${meanCards.toFixed(1)} tarjetas (brecha de forma ${(formGap*100).toFixed(0)}%).`
      });
      legPool.push({ prob: cardProb, odds: oddsCa, short: `${pickCardOver ? "más de" : "menos de"} ${lineCard} tarjetas` });
    }
  }

  // ── Player props desde ESPN summary ───────────────────────────────────────
  if (isMarketEnabled("futbol", "player_props") && summary && favTeamId && favSide && hasRecords) {
    const goalsCat = favSide?.leaders?.find(c => c.name === "goalsLeaders");
    const gRow = goalsCat?.leaders?.[0];
    const gpg = soccerLeaderGoalsPer90(gRow);
    if (gRow?.athlete?.displayName && Number.isFinite(gpg) && gpg >= 0.25) {
      const lineG = bookHalfLine(Math.max(0.35, gpg));
      const gRes = estimatePropProbabilities({ mean: gpg, line: parseFloat(lineG), sport: "futbol", stat: "goles (jugador)", leagueSlug, calibrationStore });
      const pickGOver = gRes.pOver >= gRes.pUnder;
      const gProb = pickGOver ? gRes.pOver : gRes.pUnder;
      const oddsG = oddsFromProbability(gProb);
      if (hasSignal(gProb, 0.07)) {
        picks.push(buildPropPick({
          sport: "futbol", league: leagueName, eventName,
          player: gRow.athlete.displayName, stat: "goles (jugador)", line: lineG, over: pickGOver,
          ...pick(gProb, oddsG),
          confidence: confidenceFromProbability(gProb, 42, 88),
          argument: `${gRow.athlete.displayName} — ${gpg.toFixed(2)} goles/90 min (ESPN).`,
          eventDateUtc
        }));
        legPool.push({ prob: gProb, odds: oddsG, short: `${gRow.athlete.displayName} ${pickGOver ? "más de" : "menos de"} ${lineG} goles` });
      }
    }

    const assistsCat = favSide?.leaders?.find(c => ["assistsLeaders","assists","assistLeaders"].includes(c.name));
    const aRow = assistsCat?.leaders?.[0];
    const apg = soccerLeaderAssistsPer90(aRow);
    if (aRow?.athlete?.displayName && Number.isFinite(apg) && apg >= 0.18) {
      const lineA = bookHalfLine(Math.max(0.05, apg));
      const aRes = estimatePropProbabilities({ mean: apg, line: parseFloat(lineA), sport: "futbol", stat: "asistencias (jugador)", leagueSlug, calibrationStore });
      const pickAOver = aRes.pOver >= aRes.pUnder;
      const aProb = pickAOver ? aRes.pOver : aRes.pUnder;
      const oddsA = oddsFromProbability(aProb);
      if (hasSignal(aProb, 0.07)) {
        picks.push(buildPropPick({
          sport: "futbol", league: leagueName, eventName,
          player: aRow.athlete.displayName, stat: "asistencias (jugador)", line: lineA, over: pickAOver,
          ...pick(aProb, oddsA),
          confidence: confidenceFromProbability(aProb, 42, 88),
          argument: `${aRow.athlete.displayName} — ${apg.toFixed(2)} asistencias/90 (ESPN).`,
          eventDateUtc
        }));
        legPool.push({ prob: aProb, odds: oddsA, short: `${aRow.athlete.displayName} ${pickAOver ? "más de" : "menos de"} ${lineA} asistencias` });
      }
    }

    const shotCat = favSide?.leaders?.find(c => String(c.name || "").toLowerCase().includes("shot"));
    const shRow = shotCat?.leaders?.[0];
    const spg = soccerLeaderShotsPer90(shRow);
    if (shRow?.athlete?.displayName && Number.isFinite(spg) && spg >= 0.4) {
      const lineS = bookHalfLine(spg);
      const shRes = estimatePropProbabilities({ mean: spg, line: parseFloat(lineS), sport: "futbol", stat: "tiros (jugador)", leagueSlug, calibrationStore });
      const pickSOver = shRes.pOver >= shRes.pUnder;
      const sProb = pickSOver ? shRes.pOver : shRes.pUnder;
      const oddsSh = oddsFromProbability(sProb);
      if (hasSignal(sProb, 0.07)) {
        picks.push(buildPropPick({
          sport: "futbol", league: leagueName, eventName,
          player: shRow.athlete.displayName, stat: "tiros (jugador)", line: lineS, over: pickSOver,
          ...pick(sProb, oddsSh),
          confidence: confidenceFromProbability(sProb, 42, 88),
          argument: `${shRow.athlete.displayName} — ${spg.toFixed(2)} tiros/90 (ESPN).`,
          eventDateUtc
        }));
        legPool.push({ prob: sProb, odds: oddsSh, short: `${shRow.athlete.displayName} ${pickSOver ? "más de" : "menos de"} ${lineS} tiros` });
      }
    }
  }

  // ── Combinada (SGP x2) ────────────────────────────────────────────────────
  if (isMarketEnabled("futbol", "combo_same_game")) {
    const strongLegs = legPool
      .filter(l => Math.abs(l.prob - 0.5) >= 0.08)
      .sort((a, b) => Math.max(b.prob, 1-b.prob) - Math.max(a.prob, 1-a.prob));

    if (strongLegs.length >= 2) {
      const x0 = strongLegs[0], x1 = strongLegs[1];
      const oddsCombo = Number(Math.max(1.12, Math.min(2.05, x0.odds * x1.odds * 0.87)).toFixed(2));
      picks.push({
        sport: "futbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
        market: "combo_same_game", marketLabel: "Combinada mismo partido",
        statLabel: "SGP x2",
        selection: `${x0.short} + ${x1.short}`,
        odds: oddsCombo, confidence: confidenceFromCombo(x0.prob, x1.prob),
        modelProb: Math.min(x0.prob, x1.prob),
        edge: computeEdge(Math.min(x0.prob, x1.prob), oddsCombo),
        argument: "Dos mercados con señal fuerte (≥8% sobre 50/50) + datos ESPN reales."
      });
    }
  }

  return picks;
}
