// Evidence Pack: bundle de datos crudos por evento que el motor de analisis y
// el generador de argumentos consumen. Centralizado para evitar fetch redundantes.
//
// Cada evento (homeName + awayName + sport + leagueSlug) produce un EvidencePack:
//   {
//     espn:          { homeRecord, awayRecord, summary, scoringRates, ... } | null
//     understat:     { home: xG/xGA, away: xG/xGA } | null
//     apifootball:   { home: form, away: form } | null
//     balldontlie:   { playerName -> stats } (NBA)
//     mlb:           { homePitcher, awayPitcher, homeBatting, awayBatting } | null
//     coOdds:        { books, averaged } | null
//     globalOdds:    { h2h, totals } | null
//     dataQuality:   0..1 (calidad agregada de inputs disponibles)
//     sources:       string[]  (fuentes activas para mostrar al usuario)
//   }

import { getUnderstatMatchStats, isUnderstatLeague } from "./understat.js";
import { getApiFootballTeamForm, isApiFootballSupported } from "./apifootball.js";
import { getNbaSeasonAverages } from "./balldontlie.js";

/**
 * Construye el evidence pack para un partido. Llama solo las fuentes
 * relevantes segun deporte y liga.
 */
export async function buildEvidencePack({
  sport,
  leagueSlug,
  homeName,
  awayName,
  espn = null,
  mlb = null,
  coOdds = null,
  globalOdds = null,
  nbaPlayerNames = []
}) {
  const tasks = [];
  const sources = ["espn"];

  // Understat (xG) para fútbol top europeo
  if (sport === "futbol" && isUnderstatLeague(leagueSlug)) {
    tasks.push(
      getUnderstatMatchStats(leagueSlug, homeName, awayName)
        .then(r => ({ key: "understat", value: r }))
        .catch(() => null)
    );
  }

  // API-Football para ligas no europeas (LATAM, copas, MLS)
  if (sport === "futbol" && isApiFootballSupported(leagueSlug)) {
    tasks.push(
      Promise.all([
        getApiFootballTeamForm(leagueSlug, homeName).catch(() => null),
        getApiFootballTeamForm(leagueSlug, awayName).catch(() => null)
      ]).then(([h, a]) => ({ key: "apifootball", value: h || a ? { home: h, away: a } : null }))
    );
  }

  // balldontlie para NBA (player props)
  if (sport === "baloncesto" && leagueSlug === "nba" && nbaPlayerNames.length) {
    tasks.push(
      Promise.all(nbaPlayerNames.slice(0, 8).map(n =>
        getNbaSeasonAverages(n).then(s => [n, s]).catch(() => [n, null])
      )).then(rows => {
        const map = {};
        for (const [name, stats] of rows) if (stats) map[name] = stats;
        return { key: "balldontlie", value: Object.keys(map).length ? map : null };
      })
    );
  }

  const results = await Promise.allSettled(tasks);
  const pack = {
    sport, leagueSlug, homeName, awayName,
    espn, mlb, coOdds, globalOdds,
    understat:    null,
    apifootball:  null,
    balldontlie:  null
  };
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const { key, value } = r.value;
    if (!value) continue;
    pack[key] = value;
    sources.push(key);
  }
  if (mlb)        sources.push("mlb_stats_api");
  if (coOdds)     sources.push("casas_colombia");
  if (globalOdds) sources.push("the_odds_api");

  pack.sources = [...new Set(sources)];
  pack.dataQuality = computeDataQuality(pack);
  return pack;
}

/**
 * Calidad del dato 0..1 segun cuantas fuentes "buenas" tenemos.
 * Pesa fuerte: cuotas reales (CO o EU) + datos especializados (Understat, MLB, BDL).
 */
export function computeDataQuality(pack) {
  let q = 0;
  // Base: ESPN siempre presente
  if (pack.espn)       q += 0.20;
  // Cuotas reales
  if (pack.coOdds)     q += 0.30;
  else if (pack.globalOdds) q += 0.18;
  // Datos especializados
  if (pack.understat)  q += 0.25;
  if (pack.apifootball) q += 0.18;
  if (pack.mlb)        q += 0.25;
  if (pack.balldontlie) q += 0.20;
  return Math.min(1, Number(q.toFixed(3)));
}
