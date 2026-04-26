// TheSportsDB · gratis (free key "3"), sin registro.
// Documentación: https://www.thesportsdb.com/api.php
//
// Útil para:
//  - Forma reciente REAL (últimos 5 partidos) → más confiable que el "streak"
//    de ESPN, que solo dice "W3" o "L1" sin desglose.
//  - Capacidad y tipo de estadio (techado/aire libre).
//  - Alineaciones tipicas del equipo.
//
// Cache agresivo: equipos no cambian rápido y la free key tiene rate limit.

import { promises as fs } from "node:fs";
import path from "node:path";

const KEY = process.env.THESPORTSDB_KEY || "3"; // "3" es la free key pública (rate limit estricto)
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;
const HAS_PAID_KEY = KEY !== "3";

const CACHE_DIR = path.join(process.cwd(), "data", "sportsdb");
const _teamIdByName = new Map();
const _teamMeta     = new Map();
const _formByTeam   = new Map();
const TEAM_TTL = 24 * 60 * 60 * 1000;
const FORM_TTL = 6  * 60 * 60 * 1000; // 6h
const now = () => Date.now();

let _rateLimitedUntil = 0;

async function ensureCacheDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch {}
}

function diskKey(label) {
  return path.join(CACHE_DIR, `${label.replace(/[^\w-]+/g, "_")}.json`);
}

async function readDiskCache(label, ttlMs) {
  try {
    const p = diskKey(label);
    const stat = await fs.stat(p);
    if (now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch { return null; }
}

async function writeDiskCache(label, value) {
  try {
    await ensureCacheDir();
    await fs.writeFile(diskKey(label), JSON.stringify(value), "utf8");
  } catch {}
}

async function fetchJson(url, timeoutMs = 6000) {
  if (now() < _rateLimitedUntil) return null; // Backoff global tras 1015/429
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (r.status === 429 || r.status === 1015) {
      _rateLimitedUntil = now() + 5 * 60 * 1000;
      return null;
    }
    if (!r.ok) return null;
    const txt = await r.text();
    if (txt.startsWith("error code:")) {
      _rateLimitedUntil = now() + 5 * 60 * 1000;
      return null;
    }
    try { return JSON.parse(txt); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function normalizeKey(name) {
  return String(name || "").toLowerCase().trim().replace(/\s+/g, " ");
}

async function resolveTeamId(teamName) {
  const k = normalizeKey(teamName);
  if (!k) return null;
  if (_teamIdByName.has(k)) return _teamIdByName.get(k);

  const disk = await readDiskCache(`team_${k}`, TEAM_TTL);
  if (disk) {
    _teamIdByName.set(k, disk.id);
    if (disk.id && disk.meta) _teamMeta.set(disk.id, disk.meta);
    return disk.id;
  }

  const j = await fetchJson(`${BASE}/searchteams.php?t=${encodeURIComponent(teamName)}`);
  const team = j?.teams?.[0];
  if (!team) {
    _teamIdByName.set(k, null);
    await writeDiskCache(`team_${k}`, { id: null, meta: null });
    return null;
  }
  const meta = {
    estadio:    team.strStadium || null,
    capacidad:  team.intStadiumCapacity ? Number(team.intStadiumCapacity) : null,
    pais:       team.strCountry || null,
    fundado:    team.intFormedYear ? Number(team.intFormedYear) : null,
    descripcion: team.strDescriptionEN || null
  };
  _teamIdByName.set(k, team.idTeam);
  _teamMeta.set(team.idTeam, meta);
  await writeDiskCache(`team_${k}`, { id: team.idTeam, meta });
  return team.idTeam;
}

export async function getTeamMeta(teamName) {
  const id = await resolveTeamId(teamName);
  if (!id) return null;
  return _teamMeta.get(id) || null;
}

/**
 * Devuelve los últimos N partidos del equipo con resultado.
 * { partidos: [{ rival, fecha, marcador, resultado: "W"|"D"|"L", local: bool }] }
 * Cache 1h.
 */
export async function getRecentForm(teamName, n = 5) {
  const id = await resolveTeamId(teamName);
  if (!id) return null;

  const cached = _formByTeam.get(id);
  if (cached && now() - cached.t < FORM_TTL) return cached.v;

  const disk = await readDiskCache(`form_${id}`, FORM_TTL);
  if (disk) {
    _formByTeam.set(id, { t: now(), v: disk });
    return disk;
  }

  const j = await fetchJson(`${BASE}/eventslast.php?id=${id}`);
  const events = j?.results || j?.events || [];
  if (!events.length) {
    _formByTeam.set(id, { t: now(), v: null });
    return null;
  }

  const partidos = events.slice(0, n).map(e => {
    const home = e.strHomeTeam, away = e.strAwayTeam;
    const hs = Number(e.intHomeScore), as = Number(e.intAwayScore);
    const isLocal = String(e.idHomeTeam) === String(id);
    const ourScore = isLocal ? hs : as;
    const oppScore = isLocal ? as : hs;
    let resultado = "D";
    if (ourScore > oppScore) resultado = "W";
    else if (ourScore < oppScore) resultado = "L";
    return {
      rival:     isLocal ? away : home,
      fecha:     e.dateEvent,
      marcador:  Number.isFinite(hs) && Number.isFinite(as) ? `${hs}-${as}` : null,
      resultado, local: isLocal,
      liga:      e.strLeague || null
    };
  });

  const wins   = partidos.filter(p => p.resultado === "W").length;
  const draws  = partidos.filter(p => p.resultado === "D").length;
  const losses = partidos.filter(p => p.resultado === "L").length;

  const v = {
    partidos,
    resumen: { W: wins, D: draws, L: losses, total: partidos.length },
    forma:   partidos.map(p => p.resultado).join("")
  };
  _formByTeam.set(id, { t: now(), v });
  await writeDiskCache(`form_${id}`, v);
  return v;
}

/**
 * Enriquece un pick con metadatos de TheSportsDB (estadio, forma reciente).
 * Solo si tenemos homeTeam y awayTeam ya normalizados.
 */
export async function enrichPickWithSportsDB(pick) {
  const tasks = [];
  if (pick.homeTeam) tasks.push(getRecentForm(pick.homeTeam, 5).then(v => ["home", v]));
  if (pick.awayTeam) tasks.push(getRecentForm(pick.awayTeam, 5).then(v => ["away", v]));
  const results = await Promise.allSettled(tasks);
  const formByTeam = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value && r.value[1]) {
      formByTeam[r.value[0]] = r.value[1];
    }
  }
  if (Object.keys(formByTeam).length) {
    pick.recentForm    = formByTeam;
    pick.hasRecentForm = true;
  }
  return pick;
}

/**
 * Enriquece varias picks en lotes (limitado por rate limit free).
 * - Dedup por evento (no llamar 2 veces el mismo equipo)
 * - Procesa en serie (concurrency=1) para respetar el rate limit free
 * - Limita a `maxEvents` partidos para evitar 1015 cuando se usa la free key
 */
export async function enrichPicksWithSportsDB(picks, concurrency = 1, maxEvents = HAS_PAID_KEY ? 200 : 30) {
  if (!picks?.length) return;

  const seen = new Map();
  for (const p of picks) {
    const key = `${p.homeTeam || ""}|${p.awayTeam || ""}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(p);
  }
  let groups = [...seen.entries()];

  // Prioriza eventos con mayor convicción del modelo (más útil para los top picks)
  groups.sort((a, b) => {
    const ma = Math.max(...a[1].map(p => Math.abs((p.modelProb || 0.5) - 0.5)));
    const mb = Math.max(...b[1].map(p => Math.abs((p.modelProb || 0.5) - 0.5)));
    return mb - ma;
  });
  groups = groups.slice(0, maxEvents);

  let next = 0;
  let enriched = 0;
  async function worker() {
    while (next < groups.length) {
      const i = next++;
      const [, plist] = groups[i];
      const head = plist[0];
      try {
        await enrichPickWithSportsDB(head);
        if (head.hasRecentForm) enriched++;
        for (let k = 1; k < plist.length; k++) {
          plist[k].recentForm    = head.recentForm;
          plist[k].hasRecentForm = head.hasRecentForm;
        }
      } catch { /* ignore */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, () => worker()));
  console.log(`[TheSportsDB] forma reciente añadida en ${enriched}/${groups.length} eventos (key: ${HAS_PAID_KEY ? "propia" : "free '3'"})`);
}
