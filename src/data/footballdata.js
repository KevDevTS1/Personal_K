// football-data.org · alineaciones, tabla oficial, h2h y proximos partidos
// para las top 12 ligas europeas + Champions/Europa.
//
// Plan free: 10 requests/minuto.
// Documentacion: https://www.football-data.org/documentation/api
//
// IDs de competicion:
//   2014 = La Liga (PD)        2002 = Bundesliga (BL1)
//   2021 = Premier (PL)        2015 = Ligue 1 (FL1)
//   2019 = Serie A (SA)        2003 = Eredivisie (DED)
//   2017 = Primeira Liga (PPL) 2001 = Champions (CL)
//   2018 = Euro Champion       2152 = Copa Libertadores (intermitente)

import { promises as fs } from "node:fs";
import path from "node:path";

const KEY = process.env.FOOTBALLDATA_API_KEY || "";
const BASE = "https://api.football-data.org/v4";
const HEADERS = { "X-Auth-Token": KEY };

// ESPN league slug → football-data.org competition id
const ESPN_TO_FD = {
  "esp.1":           "PD",     // La Liga
  "eng.1":           "PL",     // Premier League
  "ger.1":           "BL1",    // Bundesliga
  "ita.1":           "SA",     // Serie A
  "fra.1":           "FL1",    // Ligue 1
  "por.1":           "PPL",    // Primeira Liga
  "ned.1":           "DED",    // Eredivisie
  "uefa.champions":  "CL",     // Champions League
  "bra.1":           "BSA"     // Brasileirao Serie A
};

const CACHE_DIR = path.join(process.cwd(), "data", "footballdata");
const _stand = new Map();   // competitionId → { t, v }
const _team  = new Map();   // teamName → { t, v }
const _matches = new Map(); // `${competitionId}|${dateKey}` → { t, v }
const STAND_TTL   = 6  * 60 * 60 * 1000;
const TEAM_TTL    = 24 * 60 * 60 * 1000;
const MATCHES_TTL = 30 * 60 * 1000; // 30 min · matches cambian de estado
const now = () => Date.now();

let _rateLimitedUntil = 0;
let _rateLimitWarned  = false;

async function ensureCacheDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch {}
}

async function readDiskCache(label, ttlMs) {
  try {
    const p = path.join(CACHE_DIR, `${label}.json`);
    const stat = await fs.stat(p);
    if (now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch { return null; }
}

async function writeDiskCache(label, value) {
  try {
    await ensureCacheDir();
    await fs.writeFile(path.join(CACHE_DIR, `${label}.json`), JSON.stringify(value), "utf8");
  } catch {}
}

async function fetchJson(url, timeoutMs = 7000) {
  if (!KEY) return null;
  if (now() < _rateLimitedUntil) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
    if (r.status === 429) {
      _rateLimitedUntil = now() + 90 * 1000; // back off 90s
      if (!_rateLimitWarned) {
        console.warn("[football-data] rate limit (10 req/min) alcanzado, backing off 90s");
        _rateLimitWarned = true;
      }
      return null;
    }
    if (r.status === 403) {
      console.warn("[football-data] 403: clave no autorizada para esta competicion (plan free no incluye)");
      return null;
    }
    if (!r.ok) return null;
    _rateLimitWarned = false;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ───── Tabla oficial de la liga ─────────────────────────────────────────

export async function getLeagueStandings(espnLeagueSlug) {
  const compId = ESPN_TO_FD[espnLeagueSlug];
  if (!compId) return null;

  const cached = _stand.get(compId);
  if (cached && now() - cached.t < STAND_TTL) return cached.v;

  const disk = await readDiskCache(`stand_${compId}`, STAND_TTL);
  if (disk) {
    _stand.set(compId, { t: now(), v: disk });
    return disk;
  }

  const j = await fetchJson(`${BASE}/competitions/${compId}/standings`);
  if (!j) {
    _stand.set(compId, { t: now(), v: null });
    return null;
  }
  const main = (j.standings || []).find(s => s.type === "TOTAL");
  if (!main) return null;
  const table = (main.table || []).map(row => ({
    posicion:    row.position,
    equipo:      row.team?.name,
    equipoCorto: row.team?.shortName || row.team?.tla,
    teamId:      row.team?.id,
    crest:       row.team?.crest,
    pj:          row.playedGames,
    pts:         row.points,
    g:           row.won, e: row.draw, p: row.lost,
    gf:          row.goalsFor, gc: row.goalsAgainst, dif: row.goalDifference,
    forma:       row.form || null
  }));
  const v = { liga: j.competition?.name, temporada: j.season?.startDate, table };
  _stand.set(compId, { t: now(), v });
  await writeDiskCache(`stand_${compId}`, v);
  return v;
}

// Devuelve la fila concreta de un equipo dentro de la tabla
export async function getTeamStandingRow(espnLeagueSlug, teamName) {
  const t = await getLeagueStandings(espnLeagueSlug);
  if (!t) return null;
  const norm = String(teamName || "").toLowerCase().trim();
  return t.table.find(r =>
    r.equipo?.toLowerCase().includes(norm) ||
    r.equipoCorto?.toLowerCase().includes(norm) ||
    norm.includes(r.equipoCorto?.toLowerCase() || "___")
  ) || null;
}

// ───── Matches del día (referee, matchday, estado) ─────────────────────

function normTeam(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getCompetitionMatches(espnLeagueSlug, dateKey) {
  const compId = ESPN_TO_FD[espnLeagueSlug];
  if (!compId || !dateKey) return null;

  const cacheKey = `${compId}|${dateKey}`;
  const cached = _matches.get(cacheKey);
  if (cached && now() - cached.t < MATCHES_TTL) return cached.v;

  const disk = await readDiskCache(`matches_${cacheKey}`, MATCHES_TTL);
  if (disk) {
    _matches.set(cacheKey, { t: now(), v: disk });
    return disk;
  }

  // football-data permite ±1 dia con dateFrom/dateTo
  const url = `${BASE}/competitions/${compId}/matches?dateFrom=${dateKey}&dateTo=${dateKey}`;
  const j = await fetchJson(url);
  if (!j?.matches) {
    _matches.set(cacheKey, { t: now(), v: null });
    return null;
  }
  const v = (j.matches || []).map(m => ({
    id: m.id,
    matchday: m.matchday,
    status: m.status,
    homeName: m.homeTeam?.shortName || m.homeTeam?.name,
    awayName: m.awayTeam?.shortName || m.awayTeam?.name,
    referee:  (m.referees || []).find(r => /referee|arbitro|main/i.test(r.role || ""))?.name
            || m.referees?.[0]?.name || null,
    season:   m.season ? { startDate: m.season.startDate, endDate: m.season.endDate } : null,
    stage:    m.stage,
    group:    m.group,
    utcDate:  m.utcDate
  }));
  _matches.set(cacheKey, { t: now(), v });
  await writeDiskCache(`matches_${cacheKey}`, v);
  return v;
}

export async function getMatchInfoForTeams(espnLeagueSlug, dateKey, homeTeam, awayTeam) {
  const matches = await getCompetitionMatches(espnLeagueSlug, dateKey);
  if (!matches?.length) return null;
  const h = normTeam(homeTeam);
  const a = normTeam(awayTeam);
  return matches.find(m => {
    const mh = normTeam(m.homeName);
    const ma = normTeam(m.awayName);
    return (mh.includes(h) || h.includes(mh)) && (ma.includes(a) || a.includes(ma));
  }) || null;
}

// ───── Próximo partido del equipo (con alineaciones cuando estén) ──────

export async function getTeamNextMatch(teamName) {
  // Necesitamos teamId; resolvemos via /teams?name=...
  const k = teamName.toLowerCase();
  const cached = _team.get(k);
  if (cached && now() - cached.t < TEAM_TTL) return cached.v;

  const disk = await readDiskCache(`team_${k.replace(/[^\w]+/g, "_")}`, TEAM_TTL);
  if (disk) {
    _team.set(k, { t: now(), v: disk });
    return disk;
  }
  // football-data no tiene busqueda libre de equipos en plan free, así que
  // dependemos de la tabla. Devolvemos null hasta que tengamos teamId via
  // standings.
  _team.set(k, { t: now(), v: null });
  return null;
}

// ───── Enriquecer un pick con tabla oficial + standing del equipo ──────

export async function enrichPickWithFootballData(pick) {
  if (!KEY) return pick;
  if (pick.sport !== "futbol") return pick;
  if (!ESPN_TO_FD[pick.leagueSlug]) return pick; // liga no soportada en plan free
  const dk = pick.sourceDateKey || pick.forDate;
  const [home, away, matchInfo] = await Promise.all([
    getTeamStandingRow(pick.leagueSlug, pick.homeTeam),
    getTeamStandingRow(pick.leagueSlug, pick.awayTeam),
    dk ? getMatchInfoForTeams(pick.leagueSlug, dk, pick.homeTeam, pick.awayTeam) : Promise.resolve(null)
  ]);
  if (home || away) {
    pick.officialStandings = { home, away };
    pick.hasOfficialStandings = true;
  }
  if (matchInfo) {
    pick.matchInfo = matchInfo;
    pick.hasMatchInfo = true;
  }
  return pick;
}

export async function enrichPicksWithFootballData(picks, concurrency = 1) {
  if (!KEY) return;
  const eligibles = picks.filter(p =>
    p.sport === "futbol" && ESPN_TO_FD[p.leagueSlug] && (p.homeTeam || p.awayTeam)
  );
  if (!eligibles.length) return;

  // Dedup por evento
  const seen = new Map();
  for (const p of eligibles) {
    const k = `${p.homeTeam || ""}|${p.awayTeam || ""}|${p.leagueSlug}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(p);
  }
  const groups = [...seen.values()];
  let next = 0, enriched = 0;
  async function worker() {
    while (next < groups.length) {
      const i = next++;
      const plist = groups[i];
      try {
        await enrichPickWithFootballData(plist[0]);
        if (plist[0].hasOfficialStandings) enriched++;
        for (let k = 1; k < plist.length; k++) {
          plist[k].officialStandings    = plist[0].officialStandings;
          plist[k].hasOfficialStandings = plist[0].hasOfficialStandings;
          plist[k].matchInfo            = plist[0].matchInfo;
          plist[k].hasMatchInfo         = plist[0].hasMatchInfo;
        }
      } catch { /* ignore */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, () => worker()));
  console.log(`[football-data] tabla oficial añadida en ${enriched}/${groups.length} eventos`);
}
