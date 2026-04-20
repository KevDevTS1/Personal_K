import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, "../../data");
const BETS_FILE = join(DATA_DIR, "bets.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readBets() {
  ensureDir();
  if (!existsSync(BETS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(BETS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeBets(bets) {
  ensureDir();
  writeFileSync(BETS_FILE, JSON.stringify(bets, null, 2), "utf8");
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function getAllBets() {
  return readBets().sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
}

export function addBet(bet) {
  const bets = readBets();
  const newBet = {
    id: `bet-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    recordedAt: new Date().toISOString(),
    result: "pending",
    profit: null,
    ...bet,
  };
  bets.push(newBet);
  writeBets(bets);
  return newBet;
}

export function updateBetResult(id, result, oddsActual = null) {
  const bets = readBets();
  const idx = bets.findIndex(b => b.id === id);
  if (idx === -1) return null;

  const bet = bets[idx];
  const odds = oddsActual ?? bet.odds;
  let profit = null;
  if (result === "win")  profit = Math.round((odds - 1) * bet.stake);
  if (result === "loss") profit = -bet.stake;
  if (result === "push") profit = 0;

  bets[idx] = { ...bet, result, profit, oddsActual: odds, resolvedAt: new Date().toISOString() };
  writeBets(bets);
  return bets[idx];
}

export function deleteBet(id) {
  const bets = readBets();
  const filtered = bets.filter(b => b.id !== id);
  writeBets(filtered);
  return filtered.length < bets.length;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export function computeStats(bets = null) {
  const all = bets ?? readBets();
  const resolved = all.filter(b => b.result !== "pending");

  function statsFor(list) {
    const res = list.filter(b => b.result !== "pending");
    if (!res.length) return { bets: list.length, resolved: 0, wins: 0, losses: 0, pushes: 0, winRate: null, roi: null, profit: 0, staked: 0 };
    const wins   = res.filter(b => b.result === "win").length;
    const losses = res.filter(b => b.result === "loss").length;
    const pushes = res.filter(b => b.result === "push").length;
    const profit = res.reduce((s, b) => s + (b.profit ?? 0), 0);
    const staked = res.reduce((s, b) => s + (b.stake ?? 0), 0);
    return {
      bets: list.length, resolved: res.length,
      wins, losses, pushes,
      winRate: res.length ? Number(((wins / res.length) * 100).toFixed(1)) : null,
      roi:    staked > 0  ? Number(((profit / staked) * 100).toFixed(2))   : null,
      profit, staked,
    };
  }

  // Group by sport
  const bySport = {};
  for (const b of all) {
    const key = b.sport || "otro";
    (bySport[key] = bySport[key] || []).push(b);
  }

  // Group by market
  const byMarket = {};
  for (const b of all) {
    const key = b.market || "otro";
    (byMarket[key] = byMarket[key] || []).push(b);
  }

  // Group by confidence tier
  const byConf = { "alto (≥75%)": [], "medio (65-74%)": [], "bajo (<65%)": [] };
  for (const b of all) {
    const c = Number(b.modelConfidence || 0);
    if (c >= 75) byConf["alto (≥75%)"].push(b);
    else if (c >= 65) byConf["medio (65-74%)"].push(b);
    else byConf["bajo (<65%)"].push(b);
  }

  // Rolling windows
  const now = Date.now();
  const last7  = all.filter(b => now - new Date(b.recordedAt).getTime() < 7  * 864e5);
  const last30 = all.filter(b => now - new Date(b.recordedAt).getTime() < 30 * 864e5);

  return {
    overall:   statsFor(all),
    last7d:    statsFor(last7),
    last30d:   statsFor(last30),
    bySport:   Object.fromEntries(Object.entries(bySport).map(([k,v])  => [k,  statsFor(v)])),
    byMarket:  Object.fromEntries(Object.entries(byMarket).map(([k,v]) => [k,  statsFor(v)])),
    byConf:    Object.fromEntries(Object.entries(byConf).map(([k,v])   => [k,  statsFor(v)])),
  };
}
