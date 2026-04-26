// ClubElo — rating ELO real de cualquier club europeo (api.clubelo.com).
// Sin auth, sin rate limit explícito, sin Cloudflare. Devuelve CSV con
// la historia ELO. Tomamos el último rating (fecha más reciente).
//
// Uso: clubElo("Real Madrid") → 1922.5
// Comparar dos ELOs ofrece una probabilidad robusta de ganador previo a
// la información de forma reciente — ELO incorpora ~10 años de resultados.

import { promises as fs } from "node:fs";
import path from "node:path";

const CACHE_DIR = path.join(process.cwd(), "data", "clubelo");
const CACHE_TTL = 24 * 60 * 60 * 1000; // ELO se actualiza diariamente

const _mem = new Map();
const _missing = new Set();

function clubKey(name) {
  return String(name || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*fc\s*$/i, "")
    .replace(/^(real|club|cf|cd|sd|ud|ac|fc|sc|os)\s+/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .trim();
}

async function ensureDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch {}
}

async function readDisk(key) {
  try {
    const p = path.join(CACHE_DIR, `${key}.json`);
    const stat = await fs.stat(p);
    if (Date.now() - stat.mtimeMs > CACHE_TTL) return undefined;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch { return undefined; }
}

async function writeDisk(key, value) {
  try {
    await ensureDir();
    await fs.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value), "utf8");
  } catch {}
}

async function fetchClubCsv(slug) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(`http://api.clubelo.com/${slug}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function lastEloFromCsv(csv) {
  if (!csv) return null;
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return null;
  const last = lines[lines.length - 1].split(",");
  // Rank,Club,Country,Level,Elo,From,To
  const elo = parseFloat(last[4]);
  return Number.isFinite(elo) ? elo : null;
}

export async function getClubElo(teamName) {
  const k = clubKey(teamName);
  if (!k || k.length < 3) return null;
  if (_mem.has(k)) return _mem.get(k);
  if (_missing.has(k)) return null;

  const disk = await readDisk(k);
  if (disk !== undefined) { _mem.set(k, disk); return disk; }

  const csv = await fetchClubCsv(k);
  const elo = lastEloFromCsv(csv);
  if (elo == null) {
    _missing.add(k);
    await writeDisk(k, null);
    return null;
  }
  _mem.set(k, elo);
  await writeDisk(k, elo);
  return elo;
}

/**
 * Probabilidad de victoria local según ELO (clásica fórmula 1/(1+10^(diff/400))).
 * Devuelve null si no hay ELO de algún equipo.
 */
export async function eloProbHomeWin(homeTeam, awayTeam, homeAdvantage = 65) {
  const [eH, eA] = await Promise.all([getClubElo(homeTeam), getClubElo(awayTeam)]);
  if (eH == null || eA == null) return { p: null, eloHome: eH, eloAway: eA };
  const diff = (eH + homeAdvantage) - eA;
  const p = 1 / (1 + Math.pow(10, -diff / 400));
  return { p, eloHome: eH, eloAway: eA, diff };
}

/**
 * Enriquecer picks de futbol con ELO. Solo añade `pick.clubElo = { home, away, eloHome, eloAway, pHomeFromElo }`.
 * Los ajustes a modelProb los hace contextAdjust.
 */
export async function enrichPicksWithClubElo(picks, maxEvents = 60) {
  const candidates = picks
    .filter(p => p.sport === "futbol" && p.homeTeam && p.awayTeam)
    .sort((a, b) => Math.max(b.modelProb, 1-b.modelProb) - Math.max(a.modelProb, 1-a.modelProb));

  const seen = new Map();
  for (const p of candidates) {
    const k = `${p.homeTeam}|${p.awayTeam}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(p);
  }
  const groups = [...seen.values()].slice(0, maxEvents);
  let enriched = 0;
  for (const plist of groups) {
    try {
      const r = await eloProbHomeWin(plist[0].homeTeam, plist[0].awayTeam);
      if (r.p == null) continue;
      const data = {
        eloHome: Math.round(r.eloHome),
        eloAway: Math.round(r.eloAway),
        pHomeFromElo: Number(r.p.toFixed(3))
      };
      for (const p of plist) {
        p.clubElo = data;
        p.hasClubElo = true;
      }
      enriched++;
    } catch { /* ignore */ }
  }
  console.log(`[clubelo] ELO oficial añadido en ${enriched}/${groups.length} eventos top de futbol`);
}
