// Auto-evaluación de apuestas registradas en el tracker.
//
// Cada vez que corre:
//  1. Toma todas las bets con result === "pending"
//  2. Para cada una, determina la fecha del evento (eventDateUtc o sourceDateKey)
//  3. Busca el evento en el scoreboard ESPN del día
//  4. Si el evento está finalizado, evalúa el resultado según el mercado:
//       moneyline | double_chance | totals | spread | run_line | handicap
//  5. Llama updateBetResult con win/loss/push
//
// Mercados soportados ahora: moneyline, double_chance, totals, spread,
// run_line, handicap. Player props quedan como pending (requieren box score).

import { getAllBets, updateBetResult } from "./tracker.js";
import { fetchScoreboard } from "./espn.js";
import { bogotaTodayKey, bogotaDayKey } from "../utils/time.js";

const SPORT_TO_ESPN = {
  futbol: "soccer", baloncesto: "basketball", tenis: "tennis", beisbol: "baseball"
};

function normName(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function eventKeyFromBet(bet) {
  const dk = bet.sourceDateKey
    || (bet.eventDateUtc ? bogotaDayKey(new Date(bet.eventDateUtc)) : null);
  return dk;
}

function findEspnEvent(data, homeName, awayName, fallbackEventName) {
  const events = data?.events || [];
  if (!events.length) return null;
  const nh = normName(homeName);
  const na = normName(awayName);
  const fallbackKey = normName(fallbackEventName).replace(/\s*vs\s*/i, " ");

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === "home");
    const away = comp?.competitors?.find(c => c.homeAway === "away");
    const eh = normName(home?.team?.shortDisplayName || home?.team?.displayName);
    const ea = normName(away?.team?.shortDisplayName || away?.team?.displayName);
    if (nh && na && (eh.includes(nh) || nh.includes(eh)) && (ea.includes(na) || na.includes(ea))) {
      return ev;
    }
    // Fallback: si solo tenemos "Home vs Away" en el bet
    const evName = `${eh} ${ea}`;
    if (fallbackKey && evName.includes(fallbackKey.split(" ")[0]) && evName.includes(fallbackKey.split(" ").slice(-1)[0])) {
      return ev;
    }
  }
  return null;
}

function isEventFinal(event) {
  const state = event?.competitions?.[0]?.status?.type?.state;
  const completed = event?.competitions?.[0]?.status?.type?.completed;
  return state === "post" || completed === true;
}

function getScores(event) {
  const comp = event?.competitions?.[0];
  const home = comp?.competitors?.find(c => c.homeAway === "home");
  const away = comp?.competitors?.find(c => c.homeAway === "away");
  return {
    home: Number(home?.score) || 0,
    away: Number(away?.score) || 0,
    homeName: home?.team?.shortDisplayName || home?.team?.displayName || "",
    awayName: away?.team?.shortDisplayName || away?.team?.displayName || ""
  };
}

// ── Evaluadores por mercado ─────────────────────────────────────────────

function evalMoneyline(bet, scores) {
  const sel = normName(bet.selection);
  const home = normName(scores.homeName);
  const away = normName(scores.awayName);
  const draw = scores.home === scores.away;
  const homeWin = scores.home > scores.away;
  if (draw) {
    // En tenis y baloncesto no hay empate. En futbol sí.
    return bet.sport === "futbol" ? "loss" : null;
  }
  if (sel.includes(home)) return homeWin ? "win" : "loss";
  if (sel.includes(away)) return homeWin ? "loss" : "win";
  return null;
}

function evalDoubleChance(bet, scores) {
  const sel = normName(bet.lineLabel || bet.selection);
  const draw = scores.home === scores.away;
  const homeWin = scores.home > scores.away;
  if (sel.includes("1x")) return (homeWin || draw) ? "win" : "loss";
  if (sel.includes("x2")) return (!homeWin || draw) ? "win" : "loss";
  if (sel.includes("12") || sel.includes("local o visitante")) return draw ? "loss" : "win";
  return null;
}

function evalTotals(bet, scores) {
  const total = scores.home + scores.away;
  const lineMatch = String(bet.lineLabel || bet.selection || "").match(/(\d+(?:\.\d+)?)/);
  if (!lineMatch) return null;
  const line = parseFloat(lineMatch[1]);
  const isOver = String(bet.sideLabel || bet.selection || "").toLowerCase().includes("más");
  if (total === line) return "push";
  if (isOver) return total > line ? "win" : "loss";
  return total < line ? "win" : "loss";
}

function evalSpread(bet, scores) {
  const sel = normName(bet.selection);
  const home = normName(scores.homeName);
  const away = normName(scores.awayName);
  const lineMatch = String(bet.lineLabel || bet.selection || "").match(/(-?\d+(?:\.\d+)?)/);
  if (!lineMatch) return null;
  const line = parseFloat(lineMatch[1]);
  const homeAdj = scores.home + (sel.includes(home) ? line : 0);
  const awayAdj = scores.away + (sel.includes(away) ? line : 0);
  const target = sel.includes(home) ? homeAdj : awayAdj;
  const opp    = sel.includes(home) ? scores.away : scores.home;
  if (target === opp) return "push";
  return target > opp ? "win" : "loss";
}

function evalHandicap(bet, scores) {
  // Handicap asiático -0.5 / +0.5 en futbol equivale a moneyline
  const lineMatch = String(bet.lineLabel || bet.selection || "").match(/(-?\d+(?:\.\d+)?)/);
  if (!lineMatch) return null;
  const line = parseFloat(lineMatch[1]);
  const sel = normName(bet.selection);
  const home = normName(scores.homeName);
  const adj = sel.includes(home) ? scores.home + line : scores.away + line;
  const opp = sel.includes(home) ? scores.away : scores.home;
  if (adj === opp) return "push";
  return adj > opp ? "win" : "loss";
}

function evalRunLine(bet, scores) {
  // -1.5 favorito, +1.5 underdog
  const sel = normName(bet.selection);
  const home = normName(scores.homeName);
  const lineMatch = String(bet.lineLabel || bet.selection || "").match(/(-?\d+(?:\.\d+)?)/);
  if (!lineMatch) return null;
  const line = parseFloat(lineMatch[1]);
  const adj = sel.includes(home) ? scores.home + line : scores.away + line;
  const opp = sel.includes(home) ? scores.away : scores.home;
  return adj > opp ? "win" : adj < opp ? "loss" : "push";
}

const EVALUATORS = {
  moneyline:        evalMoneyline,
  double_chance:    evalDoubleChance,
  totals:           evalTotals,
  goals_total:      evalTotals,
  runs_total:       evalTotals,
  spread:           evalSpread,
  handicap:         evalHandicap,
  run_line:         evalRunLine
};

function evaluateBet(bet, scores) {
  const evaluator = EVALUATORS[bet.market];
  if (!evaluator) return { result: null, reason: `mercado ${bet.market} no soportado en auto-eval` };
  try {
    const r = evaluator(bet, scores);
    return r ? { result: r, reason: `${scores.homeName} ${scores.home}-${scores.away} ${scores.awayName}` } : { result: null, reason: "no se pudo determinar resultado" };
  } catch (err) {
    return { result: null, reason: `error: ${err.message}` };
  }
}

// ── Loop principal ──────────────────────────────────────────────────────

const _scoreboardCache = new Map(); // `${sport}|${dateKey}|${leagueSlug}` → data
async function getScoreboardCached(sport, leagueSlug, dateKey) {
  if (!sport || !leagueSlug || !dateKey) return null;
  const key = `${sport}|${dateKey}|${leagueSlug}`;
  if (_scoreboardCache.has(key)) return _scoreboardCache.get(key);
  try {
    const espnSport = SPORT_TO_ESPN[sport];
    const data = await fetchScoreboard(espnSport, leagueSlug, dateKey);
    _scoreboardCache.set(key, data);
    return data;
  } catch {
    _scoreboardCache.set(key, null);
    return null;
  }
}

export async function autoEvaluatePendingBets({ verbose = false } = {}) {
  const all = getAllBets();
  const pending = all.filter(b => b.result === "pending");
  if (!pending.length) {
    if (verbose) console.log("[autoEval] no hay bets pending");
    return { evaluated: 0, win: 0, loss: 0, push: 0, skipped: 0 };
  }

  let win = 0, loss = 0, push = 0, skipped = 0, evaluated = 0;
  for (const bet of pending) {
    if (!bet.leagueSlug || !bet.sport) { skipped++; continue; }
    const dk = eventKeyFromBet(bet);
    if (!dk) { skipped++; continue; }

    const data = await getScoreboardCached(bet.sport, bet.leagueSlug, dk);
    if (!data) { skipped++; continue; }

    const event = findEspnEvent(data, bet.homeTeam, bet.awayTeam, bet.event);
    if (!event) {
      if (verbose) console.log(`[autoEval] evento no encontrado: ${bet.event} (${bet.leagueSlug} ${dk})`);
      skipped++; continue;
    }
    if (!isEventFinal(event)) {
      // Aún no termina, dejar pending
      skipped++; continue;
    }

    const scores = getScores(event);
    const { result, reason } = evaluateBet(bet, scores);
    if (!result) {
      if (verbose) console.log(`[autoEval] sin resultado para ${bet.event} ${bet.market}: ${reason}`);
      skipped++; continue;
    }

    updateBetResult(bet.id, result);
    evaluated++;
    if (result === "win") win++;
    else if (result === "loss") loss++;
    else if (result === "push") push++;
    if (verbose) console.log(`[autoEval] ${bet.event} ${bet.market} → ${result} · ${reason}`);
  }

  console.log(`[autoEval] evaluados ${evaluated} (W:${win} L:${loss} P:${push}) · ${skipped} sin cerrar/sin data · pending restantes: ${pending.length - evaluated}`);
  return { evaluated, win, loss, push, skipped };
}

// ── Auto-refresh periódico ──────────────────────────────────────────────

let _autoEvalTimer = null;
export function startAutoEvaluator(intervalMs = 30 * 60 * 1000) {
  if (_autoEvalTimer) clearInterval(_autoEvalTimer);
  // Evaluación inicial a los 60s del arranque
  setTimeout(() => autoEvaluatePendingBets().catch(err => console.warn("[autoEval]", err.message)), 60_000);
  _autoEvalTimer = setInterval(() => {
    autoEvaluatePendingBets().catch(err => console.warn("[autoEval]", err.message));
  }, intervalMs);
  console.log(`[autoEval] auto-evaluación cada ${Math.round(intervalMs / 60000)} min`);
}
