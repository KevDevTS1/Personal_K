// Recalibra player props NBA con season averages REALES de balldontlie.
//
// Antes: el analyzer NBA usa promedios extraídos del summary ESPN (que a
// veces son últimos 5 partidos o solo el partido anterior, no toda la
// temporada). Esto crea picks raros con líneas movidas.
//
// Después: para cada player prop NBA, buscamos al jugador en balldontlie y
// si encontramos su season average real, lo usamos como mean honesto y
// recalculamos la probabilidad. Marcamos `hasBalldontlie = true` para que
// dataQuality reconozca la fuente.

import { getNbaSeasonAverages } from "../data/balldontlie.js";
import { estimatePropProbabilities } from "../model/props.js";
import { oddsFromProbability, computeEdge, confidenceFromProbability, bookHalfLine } from "../model/scoring.js";
import { hasSignal } from "../utils/data.js";

const STAT_TO_FIELD = {
  "puntos": "pts",
  "rebotes": "reb",
  "asistencias": "ast",
  "robos": "stl",
  "tapones": "blk",
  "turnovers": "tov",
  "triples anotados": "fg3m",
};

function pickStatField(statLabel) {
  const s = String(statLabel || "").toLowerCase();
  for (const [k, v] of Object.entries(STAT_TO_FIELD)) {
    if (s.includes(k)) return v;
  }
  return null;
}

function comboMean(stats, statLabel) {
  const s = String(statLabel || "").toLowerCase();
  if (s.includes("puntos más rebotes más asistencias")) return (stats.pts || 0) + (stats.reb || 0) + (stats.ast || 0);
  if (s.includes("puntos más rebotes")) return (stats.pts || 0) + (stats.reb || 0);
  if (s.includes("puntos más asistencias")) return (stats.pts || 0) + (stats.ast || 0);
  if (s.includes("rebotes más asistencias")) return (stats.reb || 0) + (stats.ast || 0);
  return null;
}

async function refineOnePick(pick) {
  if (pick.sport !== "baloncesto") return false;
  if (pick.market !== "player_props") return false;
  if (!pick.player) return false;
  if (pick.leagueSlug !== "nba") return false; // balldontlie solo NBA

  const stats = await getNbaSeasonAverages(pick.player);
  if (!stats || (stats.games || 0) < 5) return false;

  const field = pickStatField(pick.statLabel || pick.stat);
  let realMean = field ? Number(stats[field]) : null;
  if (realMean == null) realMean = comboMean(stats, pick.statLabel || pick.stat);
  if (!Number.isFinite(realMean) || realMean <= 0) {
    pick.hasBalldontlie = true;
    return true;
  }

  const line = parseFloat(pick.lineLabel || pick.line || bookHalfLine(realMean));
  if (!Number.isFinite(line) || line <= 0) return false;

  const res = estimatePropProbabilities({
    mean: realMean, line,
    sport: "baloncesto", stat: pick.statLabel || pick.stat,
    leagueSlug: pick.leagueSlug, calibrationStore: null
  });
  const over = res.pOver >= res.pUnder;
  const newProb = over ? res.pOver : res.pUnder;

  // Solo aplicar si la señal sigue válida
  if (!hasSignal(newProb, 0.05)) {
    pick.balldontlieDiscarded = true;
    pick.hasBalldontlie = true;
    return true;
  }

  const oldProb = Number(pick.modelProb) || 0.5;
  pick.balldontlieReal = {
    seasonMean: Number(realMean.toFixed(2)),
    seasonGames: stats.games,
    field: field || "combo",
    minutes: stats.minutes,
    diff_vs_espn: Number((realMean - (Number(pick.statValue) || realMean)).toFixed(2))
  };
  pick.modelProb = newProb;
  pick.sideLabel = over ? "Más de" : "Menos de";
  pick.selection = `${pick.player} ${over ? "más de" : "menos de"} ${line} ${pick.statLabel || pick.stat}`;
  pick.confidence = confidenceFromProbability(newProb, 42, 88);
  pick.odds = pick.odds || oddsFromProbability(newProb);
  pick.edge = computeEdge(newProb, pick.odds);
  pick.hasBalldontlie = true;

  pick.contextReasons = pick.contextReasons || [];
  pick.contextReasons.push(`balldontlie: ${pick.player} promedia ${realMean.toFixed(1)} ${pick.statLabel || pick.stat} en ${stats.games}J de la temporada (${(oldProb * 100).toFixed(1)}% → ${(newProb * 100).toFixed(1)}%)`);
  pick.hasContextAdjustments = true;
  return true;
}

/**
 * Enriquecedor batch. Se ejecuta antes de attachScores. Limita a 40 picks
 * NBA top por convicción para no martillar la API gratuita.
 */
export async function enrichPlayerPropsWithBalldontlie(picks, maxRequests = 40) {
  const candidates = picks
    .filter(p => p.sport === "baloncesto" && p.market === "player_props" && p.leagueSlug === "nba")
    .sort((a, b) => Math.max(b.modelProb, 1-b.modelProb) - Math.max(a.modelProb, 1-a.modelProb))
    .slice(0, maxRequests);

  if (!candidates.length) return;

  let touched = 0, refined = 0;
  for (const p of candidates) {
    try {
      const ok = await refineOnePick(p);
      if (ok) {
        touched++;
        if (p.balldontlieReal) refined++;
      }
    } catch { /* ignore */ }
  }
  console.log(`[balldontlie] player props NBA enriquecidos: ${refined}/${candidates.length} con season averages reales (${touched} buscados)`);
}
