import { clamp, toNum } from "../utils/math.js";
import { normalizeTeamName, pickSeed } from "../utils/event.js";
import { oddsFromProbability, confidenceFromProbability, computeEdge, tennisProbFromRanks, bookHalfLine } from "../model/scoring.js";
import { buildMoneylinePick, buildTotalsPick } from "../picks/builders.js";

/**
 * Probabilidad Over/Under para total de juegos del partido.
 * A menor diferencia de ranking (más paridad) → partidos más largos.
 * rankGap=0 → máxima paridad → ~0.70 Over 22.5
 * rankGap=120+ → brecha grande → ~0.40 Under 22.5
 */
function tennisGamesTotalProb(rankGap) {
  const parity = clamp(1 - rankGap / 120, 0, 1);
  return clamp(0.40 + parity * 0.30, 0.40, 0.72);
}

/**
 * Línea dinámica de total de juegos según paridad.
 * Partidos paretos: 22.5–24.5; dominantes: 18.5–20.5.
 */
function dynamicGamesLine(rankGap) {
  const parity = clamp(1 - rankGap / 120, 0, 1);
  const est = clamp(19 + parity * 7, 17, 26);
  return parseFloat(bookHalfLine(est));
}

/**
 * Probabilidad de llegar a 3 sets (best-of-3).
 * Más paridad → más probable decisivo 3er set.
 */
function thirdSetProb(pFav, rankGap) {
  const parity = clamp(1 - rankGap / 120, 0, 1);
  return clamp(0.25 + parity * 0.38, 0.22, 0.65);
}

export function analyzeTennisEvent(event, leagueName, dateKey) {
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;
  const s = pickSeed(dateKey, event, "tenis");

  // Caso sin competitions (solo nombre del cruce)
  if (!event.competitions?.length) {
    const rawName = event.shortName || event.name || "Jugador A vs Jugador B";
    const sep = rawName.includes(" vs ") ? " vs " : " at ";
    const [p1Name = "Jugador A", p2Name = "Jugador B"] = rawName.split(sep);
    const eventName = `${p1Name} vs ${p2Name}`;
    const pFav = 0.54;
    const oddsMl = oddsFromProbability(pFav);
    const pGamesOver = 0.52;
    const gamesLine = 22.5;
    const oddsGames = oddsFromProbability(pGamesOver);
    return [
      buildMoneylinePick({
        sport: "tenis", league: leagueName, eventName,
        favorite: p1Name, underdog: p2Name,
        modelProb: pFav, odds: oddsMl, edge: computeEdge(pFav, oddsMl),
        confidence: confidenceFromProbability(pFav, 38, 65),
        argument: "Sin datos de ranking disponibles; leve ventaja al primer jugador listado.",
        eventDateUtc
      }),
      buildTotalsPick({
        sport: "tenis", league: leagueName, eventName,
        line: `${gamesLine} juegos`, over: true,
        modelProb: pGamesOver, odds: oddsGames, edge: computeEdge(pGamesOver, oddsGames),
        confidence: confidenceFromProbability(pGamesOver, 38, 62),
        argument: "Total estimado sin datos de ranking; paridad asumida.",
        eventDateUtc
      })
    ];
  }

  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const p1 = comp.competitors[0];
  const p2 = comp.competitors[1];
  if (!p1 || !p2) return [];

  const p1Name = normalizeTeamName(p1);
  const p2Name = normalizeTeamName(p2);
  const eventName = `${p1Name} vs ${p2Name}`;

  // Rankings reales desde ESPN curatedRank
  const rank1 = toNum(p1.curatedRank?.current, 100);
  const rank2 = toNum(p2.curatedRank?.current, 100);
  const rankGap = Math.abs(rank1 - rank2);

  // Scores de sets actuales (si el partido está en curso)
  const p1Sets = toNum(p1.sets, 0);
  const p2Sets = toNum(p2.sets, 0);
  const totalSetsPlayed = p1Sets + p2Sets;

  // Probabilidad de victoria basada en ranking (logística)
  const rawProb1 = tennisProbFromRanks(rank1, rank2);
  const p1IsFav = rawProb1 >= 0.5;
  const favorite = p1IsFav ? p1Name : p2Name;
  const underdog = p1IsFav ? p2Name : p1Name;
  const favRank = p1IsFav ? rank1 : rank2;
  const undRank = p1IsFav ? rank2 : rank1;
  const pFav = Math.max(rawProb1, 1 - rawProb1);

  // Línea de juegos dinámica según paridad de rankings
  const gamesLine = dynamicGamesLine(rankGap);
  const pGamesOver = tennisGamesTotalProb(rankGap);
  const pickGamesOver = pGamesOver >= 0.5;
  const gamesProb = pickGamesOver ? pGamesOver : 1 - pGamesOver;

  const oddsMl = oddsFromProbability(pFav);
  const oddsGames = oddsFromProbability(gamesProb);

  const picks = [];

  // ── Moneyline ────────────────────────────────────────────────────────────
  picks.push(buildMoneylinePick({
    sport: "tenis", league: leagueName, eventName,
    favorite, underdog,
    modelProb: pFav, odds: oddsMl, edge: computeEdge(pFav, oddsMl),
    confidence: confidenceFromProbability(pFav, 40, 86),
    argument: `Rankings ESPN: ${p1Name} #${rank1} vs ${p2Name} #${rank2}. Favorito por función logística de brecha (Δ=${rankGap}).`,
    eventDateUtc
  }));

  // ── Total de juegos (línea dinámica) ─────────────────────────────────────
  picks.push(buildTotalsPick({
    sport: "tenis", league: leagueName, eventName,
    line: `${gamesLine} juegos`, over: pickGamesOver,
    modelProb: gamesProb, odds: oddsGames, edge: computeEdge(gamesProb, oddsGames),
    confidence: confidenceFromProbability(gamesProb, 38, 78),
    argument: `Línea calculada ~${gamesLine} juegos (paridad Δ=${rankGap}). ${pickGamesOver ? "Over" : "Under"}: ${rankGap < 30 ? "partido parejo, más juegos esperados" : "brecha de ranking amplia, partido más corto"}.`,
    eventDateUtc
  }));

  // ── Total de sets (Over/Under 2.5) ───────────────────────────────────────
  const p3Sets = thirdSetProb(pFav, rankGap);
  const pickOver25Sets = p3Sets >= 0.5;
  const setsProb = pickOver25Sets ? p3Sets : 1 - p3Sets;
  const oddsSets = oddsFromProbability(setsProb);
  picks.push({
    sport: "tenis", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "totals", marketLabel: "Total de sets",
    lineLabel: "2.5 sets", sideLabel: pickOver25Sets ? "Over" : "Under",
    selection: `${pickOver25Sets ? "Over" : "Under"} 2.5 sets`,
    modelProb: setsProb, odds: oddsSets, edge: computeEdge(setsProb, oddsSets),
    confidence: confidenceFromProbability(setsProb, 38, 76),
    argument: `Sets estimado: Δ ranking=${rankGap}. ${pickOver25Sets ? `Partido parejo → ~${(p3Sets*100).toFixed(0)}% de llegar al 3er set.` : `Brecha de ranking → favorito gana en 2 sets (prob ~${((1-p3Sets)*100).toFixed(0)}%).`}`
  });

  // ── Juegos en set 1 (Over/Under línea dinámica) ──────────────────────────
  const meanSet1Games = clamp(9.5 + clamp(1 - rankGap / 120, 0, 1) * 2.5, 8, 13);
  const set1Line = parseFloat(bookHalfLine(meanSet1Games));
  const pSet1Over = clamp(0.38 + clamp(1 - rankGap / 120, 0, 1) * 0.28, 0.38, 0.70);
  const pickS1Over = pSet1Over >= 0.5;
  const s1Prob = pickS1Over ? pSet1Over : 1 - pSet1Over;
  const oddsS1 = oddsFromProbability(s1Prob);
  picks.push({
    sport: "tenis", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "totals", marketLabel: "Juegos en el 1er set",
    lineLabel: `${set1Line} juegos`, sideLabel: pickS1Over ? "Over" : "Under",
    selection: `${pickS1Over ? "Over" : "Under"} ${set1Line} juegos (1er set)`,
    modelProb: s1Prob, odds: oddsS1, edge: computeEdge(s1Prob, oddsS1),
    confidence: confidenceFromProbability(s1Prob, 38, 72),
    argument: `Juegos 1er set estimados ~${meanSet1Games.toFixed(1)} (paridad de ranking Δ=${rankGap}). ${pickS1Over ? "Over: set competido entre jugadores parejos." : "Under: dominio del favorito esperado."}`
  });

  // ── Tie-break en el partido ───────────────────────────────────────────────
  const pTiebreak = clamp(0.18 + clamp(1 - rankGap / 120, 0, 1) * 0.30, 0.15, 0.52);
  const pickTbYes = pTiebreak >= 0.5;
  const tbProb = pickTbYes ? pTiebreak : 1 - pTiebreak;
  const oddsTb = oddsFromProbability(tbProb);
  picks.push({
    sport: "tenis", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
    market: "player_props", marketLabel: "Tie-break en el partido",
    lineLabel: "tie-break", sideLabel: pickTbYes ? "Sí" : "No",
    selection: `${pickTbYes ? "Sí" : "No"} habrá tie-break`,
    modelProb: tbProb, odds: oddsTb, edge: computeEdge(tbProb, oddsTb),
    confidence: confidenceFromProbability(tbProb, 36, 70),
    argument: `Tie-break: prob ~${(pTiebreak*100).toFixed(0)}% estimada desde paridad de ranking (Δ=${rankGap}). ${rankGap < 20 ? "Jugadores muy parejos → tie-break probable." : "Brecha de ranking sugiere dominio sin tie-break."}`
  });

  return picks;
}
