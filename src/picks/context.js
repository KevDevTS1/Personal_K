// Extrae contexto adicional del summary de ESPN (gratis, sin keys nuevas):
//  - bajas/lesiones por equipo
//  - posición en la tabla y forma reciente
//  - venue (estadio + indoor/outdoor) para activar clima
//  - record local/visitante separado
//
// Y enriquece los picks con esa información. Después llama a wttr.in
// (si el partido es al aire libre) para añadir clima.

import { getWeather, sportNeedsWeather } from "../data/weather.js";

function safeArr(v) { return Array.isArray(v) ? v : []; }

// ───── Lesiones ──────────────────────────────────────────────────────────────

function extractInjuriesFromSummary(summary) {
  const out = { home: [], away: [] };
  const inj = safeArr(summary?.injuries);
  if (!inj.length) return out;

  const teams = safeArr(summary?.boxscore?.teams || summary?.header?.competitions?.[0]?.competitors);
  if (teams.length < 2) return out;

  const homeId = teams.find(t => t.homeAway === "home")?.team?.id || teams[0]?.team?.id;
  const awayId = teams.find(t => t.homeAway === "away")?.team?.id || teams[1]?.team?.id;

  for (const block of inj) {
    const tid = block.team?.id;
    const list = safeArr(block.injuries).map(i => ({
      jugador: i.athlete?.displayName || i.athlete?.shortName || "—",
      estado:  i.status || i.type?.description || "",
      detalle: i.details?.detail || i.details?.type || ""
    }));
    if (tid && tid === String(homeId)) out.home.push(...list);
    else if (tid && tid === String(awayId)) out.away.push(...list);
  }
  return out;
}

// ───── Standings (posición + forma reciente) ────────────────────────────────

function extractStandingsFromSummary(summary) {
  const out = { home: null, away: null };
  const standings = summary?.standings;
  if (!standings) return out;

  const teamRows = [];
  // Estructura habitual: standings.groups[*].standings.entries[*]
  for (const grp of safeArr(standings?.groups)) {
    for (const ent of safeArr(grp?.standings?.entries)) {
      teamRows.push(ent);
    }
  }
  // Algunos formatos: standings.entries directamente
  for (const ent of safeArr(standings?.entries)) teamRows.push(ent);

  if (!teamRows.length) return out;

  const compIds = safeArr(summary?.header?.competitions?.[0]?.competitors).map(c => c.team?.id);
  const homeId = compIds[0];
  const awayId = compIds[1];

  function rowFor(teamId) {
    const r = teamRows.find(e => String(e.team?.id) === String(teamId));
    if (!r) return null;
    const stats = safeArr(r.stats);
    const get = name => stats.find(s => s.name === name || s.type === name)?.displayValue;
    return {
      posicion:    get("rank") || get("playoffSeed") || null,
      puntos:      get("points") || null,
      partidos:    get("gamesPlayed") || null,
      diferencia:  get("pointDifferential") || get("pointsDifferential") || null,
      forma:       get("streak") || null
    };
  }

  out.home = rowFor(homeId);
  out.away = rowFor(awayId);
  return out;
}

// ───── Venue (estadio + indoor) ─────────────────────────────────────────────

function extractVenueFromSummary(summary) {
  const v = summary?.gameInfo?.venue || summary?.header?.competitions?.[0]?.venue;
  if (!v) return null;
  const city = v.address?.city || v.address?.country || v.fullName || "";
  return {
    nombre:  v.fullName || v.shortName || "—",
    ciudad:  city,
    pais:    v.address?.country || "",
    indoor:  Boolean(v.indoor),
    geo:     v.address?.city || null
  };
}

// ───── Records local/visitante separados ────────────────────────────────────

function extractHomeAwayRecord(summary) {
  const competitors = safeArr(summary?.header?.competitions?.[0]?.competitors);
  const out = { home: null, away: null };
  for (const c of competitors) {
    const records = safeArr(c.records);
    const home = records.find(r => /home/i.test(r.name || r.type || ""))?.summary;
    const away = records.find(r => /road|away/i.test(r.name || r.type || ""))?.summary;
    const total = records.find(r => /total|overall/i.test(r.name || r.type || ""))?.summary || records[0]?.summary;
    const block = { local: home || null, visita: away || null, total: total || null };
    if (c.homeAway === "home") out.home = block;
    else if (c.homeAway === "away") out.away = block;
  }
  return out;
}

// ───── Builder principal ────────────────────────────────────────────────────

export function buildEventContext(summary, sport) {
  if (!summary) return null;
  return {
    injuries:   extractInjuriesFromSummary(summary),
    standings:  extractStandingsFromSummary(summary),
    venue:      extractVenueFromSummary(summary),
    record:     extractHomeAwayRecord(summary),
    sport
  };
}

/**
 * Toma el mapa { eventId → context } y enriquece cada pick:
 *  - p.injuries / p.standings / p.venue / p.record
 *  - p.weather (vía wttr.in si el deporte lo requiere y NO es indoor)
 *  - banderas hasInjuries / hasStandings / hasWeather → suben dataQuality
 */
export async function enrichPicksWithContext(picks, contextByEventId, options = {}) {
  const { weatherConcurrency = 4 } = options;

  const eventIdByPick = (p) => p.event ? `${p.event}|${p.sourceDateKey}` : null;

  for (const p of picks) {
    const ctx = contextByEventId.get(eventIdByPick(p));
    if (!ctx) continue;

    if (ctx.injuries && (ctx.injuries.home.length || ctx.injuries.away.length)) {
      p.injuries     = ctx.injuries;
      p.hasInjuries  = true;
    }
    if (ctx.standings && (ctx.standings.home || ctx.standings.away)) {
      p.standings    = ctx.standings;
      p.hasStandings = true;
    }
    if (ctx.venue) {
      p.venue = ctx.venue;
    }
    if (ctx.record && (ctx.record.home || ctx.record.away)) {
      p.record = ctx.record;
    }
  }

  // Clima en paralelo (limitado a deportes outdoor, ciudad disponible)
  const weatherTasks = picks
    .filter(p => p.venue?.ciudad && sportNeedsWeather(p.sport, p.venue?.indoor))
    .map(p => ({ p, key: `${p.venue.ciudad}|${p.venue.pais}` }));

  // Dedupe por ciudad+país para no llamar 50 veces a la misma sede
  const uniqueLocations = new Map();
  for (const t of weatherTasks) {
    if (!uniqueLocations.has(t.key)) uniqueLocations.set(t.key, t.p);
  }

  const items = [...uniqueLocations.entries()];
  let next = 0;
  const weatherByKey = new Map();
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const [key, p] = items[i];
      const w = await getWeather(p.venue.ciudad, p.venue.pais || "", p.eventDateUtc).catch(() => null);
      weatherByKey.set(key, w);
    }
  }
  await Promise.all(Array.from({ length: Math.min(weatherConcurrency, items.length || 1) }, () => worker()));

  for (const t of weatherTasks) {
    const w = weatherByKey.get(t.key);
    if (w) {
      t.p.weather    = w;
      t.p.hasWeather = true;
    }
  }
}
