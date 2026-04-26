// SofaScore — alineaciones reales, ratings y eventos por partido.
//
// Endpoints públicos no documentados pero estables:
//   - /api/v1/search/all?q=...                 → buscar evento/equipo
//   - /api/v1/event/{id}/lineups               → alineaciones (XI + suplentes + ratings)
//   - /api/v1/event/{id}                       → meta del evento
//
// Sin auth ni rate limit explícito, pero conviene:
//   - Cachear agresivamente en disco
//   - Usar concurrency = 1 + delay
//   - Limitar a top-N picks de futbol por convicción

import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = "https://api.sofascore.com/api/v1";
const CACHE_DIR = path.join(process.cwd(), "data", "sofascore");
const CACHE_TTL = 6 * 60 * 60 * 1000;
const _mem = new Map();
let _backoffUntil = 0;
let _consecutiveFails = 0;

function now() { return Date.now(); }

function cleanFilename(s) {
  return String(s).replace(/[^\w]+/g, "_").slice(0, 80);
}

async function ensureDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch {}
}

async function readDisk(label) {
  try {
    const p = path.join(CACHE_DIR, `${label}.json`);
    const stat = await fs.stat(p);
    if (now() - stat.mtimeMs > CACHE_TTL) return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch { return null; }
}

async function writeDisk(label, value) {
  try {
    await ensureDir();
    await fs.writeFile(path.join(CACHE_DIR, `${label}.json`), JSON.stringify(value), "utf8");
  } catch {}
}

async function fetchJson(url) {
  if (now() < _backoffUntil) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Headers que imitan navegador real para evitar bloqueo Cloudflare.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
        "Referer": "https://www.sofascore.com/",
        "Origin": "https://www.sofascore.com",
        "sec-ch-ua": '"Chromium";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site"
      }
    });
    if (r.status === 429 || r.status === 403) {
      _consecutiveFails++;
      _backoffUntil = now() + Math.min(300, 30 * _consecutiveFails) * 1000;
      console.warn(`[sofascore] rate limit / bloqueo (${r.status}), backing off ${Math.round((_backoffUntil - now()) / 1000)}s`);
      return null;
    }
    if (!r.ok) return null;
    _consecutiveFails = 0;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*fc\s*$/i, "")
    .replace(/^(real|club|cf|cd|sd|ud|ac|fc|sc|os)\s+/i, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ───── Búsqueda del evento ──────────────────────────────────────────────

export async function findEventId(homeTeam, awayTeam, dateKey) {
  if (!homeTeam || !awayTeam) return null;
  const labelKey = `find_${cleanFilename(`${homeTeam}_${awayTeam}_${dateKey || "any"}`)}`;
  if (_mem.has(labelKey)) return _mem.get(labelKey);
  const disk = await readDisk(labelKey);
  if (disk !== null) { _mem.set(labelKey, disk); return disk; }

  const q = encodeURIComponent(`${homeTeam} ${awayTeam}`);
  const j = await fetchJson(`${BASE}/search/all?q=${q}`);
  const evs = (j?.results || []).filter(r => r.type === "event").map(r => r.entity);
  if (!evs.length) {
    _mem.set(labelKey, null); await writeDisk(labelKey, null); return null;
  }

  const nh = normName(homeTeam);
  const na = normName(awayTeam);
  let best = null;
  for (const ev of evs) {
    const eh = normName(ev.homeTeam?.shortName || ev.homeTeam?.name);
    const ea = normName(ev.awayTeam?.shortName || ev.awayTeam?.name);
    const homeMatch = eh === nh || eh.includes(nh) || nh.includes(eh);
    const awayMatch = ea === na || ea.includes(na) || na.includes(ea);
    if (homeMatch && awayMatch) {
      // Si nos pasan dateKey, exigir mismo día
      if (dateKey && ev.startTimestamp) {
        const evDk = new Date(ev.startTimestamp * 1000).toISOString().slice(0, 10);
        if (evDk !== dateKey) continue;
      }
      best = ev.id;
      break;
    }
  }
  _mem.set(labelKey, best);
  await writeDisk(labelKey, best);
  return best;
}

// ───── Alineaciones ─────────────────────────────────────────────────────

function parseLineupSide(side) {
  if (!side?.players) return [];
  return side.players.map(p => {
    const info = p.player || {};
    const stats = p.statistics || {};
    return {
      nombre: info.shortName || info.name || "—",
      numero: p.shirtNumber || info.jerseyNumber || null,
      posicion: p.position || info.position || null,
      suplente: p.substitute === true,
      capitan: p.captain === true,
      rating: stats.rating ? Number(stats.rating).toFixed(1) : null
    };
  });
}

export async function getLineups(eventId) {
  if (!eventId) return null;
  const label = `lineup_${eventId}`;
  if (_mem.has(label)) return _mem.get(label);
  const disk = await readDisk(label);
  if (disk !== null) { _mem.set(label, disk); return disk; }

  const j = await fetchJson(`${BASE}/event/${eventId}/lineups`);
  if (!j || (!j.home && !j.away)) {
    _mem.set(label, null); await writeDisk(label, null); return null;
  }
  const v = {
    confirmed: j.confirmed !== false,
    homeLineup: parseLineupSide(j.home),
    awayLineup: parseLineupSide(j.away),
    homeFormation: j.home?.formation || null,
    awayFormation: j.away?.formation || null
  };
  _mem.set(label, v);
  await writeDisk(label, v);
  return v;
}

// ───── Enrich picks ─────────────────────────────────────────────────────

export async function enrichPickWithSofascore(pick) {
  if (pick.sport !== "futbol") return pick;
  if (!pick.homeTeam || !pick.awayTeam) return pick;
  const dk = pick.sourceDateKey || pick.forDate || null;
  try {
    const id = await findEventId(pick.homeTeam, pick.awayTeam, dk);
    if (!id) return pick;
    const lu = await getLineups(id);
    if (!lu || (!lu.homeLineup?.length && !lu.awayLineup?.length)) return pick;
    pick.sofascore = lu;
    pick.sofascoreEventId = id;
    pick.hasSofascore = true;
  } catch { /* ignore */ }
  return pick;
}

/**
 * Solo procesa picks de futbol top-N (por convicción) para no saturar la API.
 * Trabaja en serie con un pequeño delay.
 */
export async function enrichPicksWithSofascore(picks, maxEvents = 25) {
  const candidates = picks
    .filter(p => p.sport === "futbol" && p.homeTeam && p.awayTeam)
    .sort((a, b) => Math.max(b.modelProb, 1-b.modelProb) - Math.max(a.modelProb, 1-a.modelProb));

  // Dedup por evento
  const seen = new Map();
  for (const p of candidates) {
    const k = `${p.homeTeam}|${p.awayTeam}|${p.sourceDateKey || ""}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(p);
  }
  const groups = [...seen.values()].slice(0, maxEvents);
  if (!groups.length) return;

  let enriched = 0;
  for (const plist of groups) {
    if (now() < _backoffUntil) break;
    try {
      await enrichPickWithSofascore(plist[0]);
      if (plist[0].hasSofascore) {
        enriched++;
        for (let k = 1; k < plist.length; k++) {
          plist[k].sofascore        = plist[0].sofascore;
          plist[k].sofascoreEventId = plist[0].sofascoreEventId;
          plist[k].hasSofascore     = true;
        }
      }
      // pequeño delay entre eventos (1.5s)
      await new Promise(res => setTimeout(res, 1500));
    } catch { /* ignore */ }
  }
  console.log(`[sofascore] alineaciones obtenidas para ${enriched}/${groups.length} eventos top`);
}
