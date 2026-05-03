// API-Sports / API-Football: stats de equipo (forma, H2H, lineups) para
// ligas no europeas que ESPN cubre con menos detalle (MLS, Liga MX, Liga
// Argentina, Liga Colombiana, copas regionales).
//
// Free tier: ~100 requests/dia (RapidAPI). Control local con
// API_FOOTBALL_MAX_REQUESTS_PER_DAY + persistencia en disco.
// https://www.api-football.com/

import fs from "fs";
import path from "path";

const RAPIDAPI_HOST = "v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY || process.env.RAPIDAPI_KEY || "";
const TTL_MS = 30 * 60 * 1000;

/** Tope por defecto ligeramente bajo 100 para margen frente a otros clientes. */
const DEFAULT_DAILY_CAP = 90;
/**
 * Antes de pedir local+visitante reservamos este mínimo (peor caso: 2× /teams search
 * + 2× /teams/statistics). Ajustable con env.
 */
const DEFAULT_RESERVE_PER_MATCH = 4;

const STATE_FILE = process.env.API_FOOTBALL_QUOTA_FILE
  || path.join(process.cwd(), "data", ".api-football-quota.json");

let _quota = { dayUtc: "", used: 0 };
let _quotaFileRead = false;
let _warnedQuotaExhausted = false;

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dailyCap() {
  const n = Number(process.env.API_FOOTBALL_MAX_REQUESTS_PER_DAY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_DAILY_CAP;
}

function reservePerMatch() {
  const n = Number(process.env.API_FOOTBALL_RESERVE_REQUESTS_PER_MATCH);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RESERVE_PER_MATCH;
}

function readQuotaFileOnce() {
  if (_quotaFileRead) return;
  _quotaFileRead = true;
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.dayUtc === "string" && typeof j.used === "number") {
      _quota = { dayUtc: j.dayUtc, used: j.used };
    }
  } catch {
    // sin archivo o JSON inválido
  }
}

function warnApiFootball(msg) {
  console.warn(`[API-Football] ${msg}`);
}

function persistQuota() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ dayUtc: _quota.dayUtc, used: _quota.used }, null, 0) + "\n",
      "utf8"
    );
  } catch (err) {
    warnApiFootball(`No se pudo guardar cuota: ${err.message}`);
  }
}

function ensureQuotaDayRolled() {
  readQuotaFileOnce();
  const today = utcDayKey();
  if (_quota.dayUtc !== today) {
    _quota = { dayUtc: today, used: 0 };
    _warnedQuotaExhausted = false;
    persistQuota();
  }
}

/**
 * Una solicitud HTTP entrante: devuelve false si ya se alcanzó el tope diario.
 */
function consumeApiFootballQuotaSlot() {
  if (!API_KEY) return false;
  ensureQuotaDayRolled();
  const cap = dailyCap();
  if (_quota.used >= cap) return false;
  _quota.used += 1;
  persistQuota();
  return true;
}

/**
 * Usado por el panel / hints: cuántas quedan y si conviene abrir un partido nuevo.
 */
export function getApiFootballQuotaSnapshot() {
  ensureQuotaDayRolled();
  const cap = dailyCap();
  const used = _quota.used;
  return {
    dayUtc: _quota.dayUtc,
    used,
    cap,
    remaining: Math.max(0, cap - used),
    reservePerMatch: reservePerMatch()
  };
}

/** Evita empezar local+visitante si no caben ~4 requests en el peor caso. */
export function apiFootballQuotaAllowsMatchHint() {
  if (!API_KEY) return false;
  const s = getApiFootballQuotaSnapshot();
  return s.remaining >= s.reservePerMatch;
}

// ESPN slug -> API-Football leagueId (temporada actual)
const ESPN_TO_APIF = {
  "usa.1":   { id: 253, name: "MLS" },
  "mex.1":   { id: 262, name: "Liga MX" },
  "col.1":   { id: 239, name: "Primera A" },
  "arg.1":   { id: 128, name: "Liga Profesional" },
  "bra.1":   { id: 71,  name: "Serie A Brasil" },
  "col.copa":{ id: 240, name: "Copa BetPlay" },
  "arg.copa":{ id: 130, name: "Copa Argentina" },
  "usa.open":{ id: 257, name: "US Open Cup" }
};

const _teamStatsCache = new Map(); // `${leagueId}|${teamId}` -> { stats, fetchedAt }
const _teamIdByName = new Map();   // `${leagueId}|${normName}` -> teamId

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function safeFetch(path) {
  if (!API_KEY) return null;
  if (!consumeApiFootballQuotaSlot()) {
    if (!_warnedQuotaExhausted) {
      _warnedQuotaExhausted = true;
      const cap = dailyCap();
      warnApiFootball(
        `Cuota diaria agotada (${cap} req · día UTC ${_quota.dayUtc}). `
        + `Aumenta API_FOOTBALL_MAX_REQUESTS_PER_DAY (máx. según tu plan) o espera al reset.`
      );
    }
    return null;
  }
  try {
    const url = `https://${RAPIDAPI_HOST}${path}`;
    const res = await fetch(url, {
      headers: {
        "x-rapidapi-key":  API_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      console.warn(`[API-Football] ${path}: HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[API-Football] ${path}: ${err.message}`);
    return null;
  }
}

function currentSeason() {
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}

async function findTeamId(leagueId, teamName) {
  const cacheKey = `${leagueId}|${normName(teamName)}`;
  if (_teamIdByName.has(cacheKey)) return _teamIdByName.get(cacheKey);

  const data = await safeFetch(
    `/teams?league=${leagueId}&season=${currentSeason()}&search=${encodeURIComponent(teamName)}`
  );
  const team = data?.response?.[0]?.team;
  const id = team?.id || null;
  if (id) _teamIdByName.set(cacheKey, id);
  return id;
}

/**
 * Stats agregadas (forma, goles a favor/en contra) de un equipo en su liga.
 * Retorna null si no hay key o no se encuentra el equipo.
 */
export async function getApiFootballTeamForm(espnLeagueSlug, teamName) {
  const meta = ESPN_TO_APIF[espnLeagueSlug];
  if (!meta || !API_KEY) return null;

  const teamId = await findTeamId(meta.id, teamName);
  if (!teamId) return null;

  const cacheKey = `${meta.id}|${teamId}`;
  const cached = _teamStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.stats;

  const data = await safeFetch(
    `/teams/statistics?league=${meta.id}&season=${currentSeason()}&team=${teamId}`
  );
  const r = data?.response;
  if (!r) return null;

  const played = r.fixtures?.played?.total || 0;
  const stats = {
    league:        meta.name,
    played,
    wins:          r.fixtures?.wins?.total || 0,
    draws:         r.fixtures?.draws?.total || 0,
    losses:        r.fixtures?.loses?.total || 0,
    goalsFor:      r.goals?.for?.total?.total || 0,
    goalsAgainst:  r.goals?.against?.total?.total || 0,
    goalsForAvg:   Number(r.goals?.for?.average?.total)     || 0,
    goalsAgAvg:    Number(r.goals?.against?.average?.total) || 0,
    cleanSheets:   r.clean_sheet?.total || 0,
    failedToScore: r.failed_to_score?.total || 0,
    formStr:       r.form || "",
    source:        "api-football"
  };
  _teamStatsCache.set(cacheKey, { stats, fetchedAt: Date.now() });
  return stats;
}

export function isApiFootballSupported(slug) {
  return Boolean(ESPN_TO_APIF[slug]);
}

export function isApiFootballConfigured() {
  return Boolean(API_KEY);
}
