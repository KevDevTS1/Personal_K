// balldontlie API: stats NBA gratuitas y sin auth.
// Docs: https://www.balldontlie.io/
//
// Usamos:
//   - /season_averages?season=YYYY&player_ids[]=...
//   - /players/active (cache mensual)

const BASE = "https://api.balldontlie.io/v1";
const API_KEY = process.env.BALLDONTLIE_API_KEY || ""; // opcional
const TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

const _seasonAvgCache = new Map(); // playerId -> { stats, fetchedAt }
const _playerByNameCache = new Map(); // normName -> playerId
let _activePlayersFetched = false;

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function safeFetch(url) {
  try {
    const res = await fetch(url, {
      headers: API_KEY ? { Authorization: API_KEY } : {},
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`[balldontlie] ${err.message}`);
    return null;
  }
}

async function ensureActivePlayers() {
  if (_activePlayersFetched) return;
  _activePlayersFetched = true;
  let cursor = 0;
  for (let page = 0; page < 20; page++) {
    const data = await safeFetch(`${BASE}/players/active?per_page=100&cursor=${cursor}`);
    if (!data?.data?.length) break;
    for (const p of data.data) {
      const full = `${p.first_name} ${p.last_name}`;
      _playerByNameCache.set(normName(full), p.id);
    }
    cursor = data.meta?.next_cursor;
    if (!cursor) break;
  }
}

function currentSeason() {
  const d = new Date();
  // NBA season comienza en oct: si mes >=10 → temporada del anio actual, sino del anterior
  return d.getMonth() >= 9 ? d.getFullYear() : d.getFullYear() - 1;
}

/**
 * Devuelve season averages de un jugador NBA por nombre.
 * Retorna null si no se encuentra.
 */
export async function getNbaSeasonAverages(playerName) {
  if (!playerName) return null;
  await ensureActivePlayers();
  const id = _playerByNameCache.get(normName(playerName));
  if (!id) return null;

  const cached = _seasonAvgCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.stats;

  const season = currentSeason();
  const data = await safeFetch(`${BASE}/season_averages?season=${season}&player_ids[]=${id}`);
  const row = data?.data?.[0] || null;
  if (!row) return null;

  const stats = {
    games:    row.games_played,
    pts:      row.pts,
    reb:      row.reb,
    ast:      row.ast,
    stl:      row.stl,
    blk:      row.blk,
    tov:      row.turnover,
    fg3m:     row.fg3m,
    minutes:  row.min,
    source:   "balldontlie"
  };
  _seasonAvgCache.set(id, { stats, fetchedAt: Date.now() });
  return stats;
}
