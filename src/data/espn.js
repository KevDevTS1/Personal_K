import { toNum } from "../utils/math.js";

export async function fetchScoreboard(sport, league, dateKey = null) {
  const dateParam = dateKey ? `?dates=${dateKey.replaceAll("-", "")}` : "";
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard${dateParam}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ESPN ${sport}/${league}: ${response.status}`);
  return response.json();
}

export async function fetchEventSummary(sportPath, league, eventId) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/${league}/summary?event=${encodeURIComponent(eventId)}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

const MAX_SUMMARIES_PER_FEED = 18;
const SPORT_PATH_BY_FEED = { futbol: "soccer", baloncesto: "basketball", beisbol: "baseball" };

export async function enrichEspnFeedsWithSummaries(feeds) {
  for (const feed of feeds) {
    const sportPath = SPORT_PATH_BY_FEED[feed.sport];
    if (!sportPath) continue;
    const events = (feed.data?.events || []).slice(0, MAX_SUMMARIES_PER_FEED);
    const summaries = await mapWithConcurrency(events, 6, async (ev) => {
      const data = await fetchEventSummary(sportPath, feed.league, ev.id);
      return [ev.id, data];
    });
    feed.summariesByEventId = Object.fromEntries(summaries.filter(([, data]) => data));
  }
}

// ── ESPN data parsers ─────────────────────────────────────────────────────────

export function findEspnLeaderSide(summary, teamId) {
  return summary?.leaders?.find((l) => l.team?.id === teamId) || null;
}

export function getEspnCategoryLeader(sideBlock, categoryName) {
  const cat = sideBlock?.leaders?.find((c) => c.name === categoryName);
  const row = cat?.leaders?.[0];
  if (!row?.athlete) return null;
  let val = toNum(row.value, NaN);
  if (!Number.isFinite(val) && row.displayValue != null) {
    val = parseFloat(String(row.displayValue).replace(/[^0-9.]/g, ""));
  }
  return {
    player: row.athlete.displayName || row.athlete.shortName,
    value: val,
    displayValue: row.displayValue,
    athlete: row.athlete
  };
}

export function parseNbaTeamSeasonStatsFromBoxscore(summary, teamId) {
  const row = summary?.boxscore?.teams?.find((t) => t.team?.id === teamId);
  const out = {};
  for (const s of row?.statistics || []) {
    const v = parseFloat(String(s.displayValue ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(v)) out[s.name] = v;
  }
  return out;
}

export function parseMlbTeamBattingRates(summary, teamId) {
  const row = summary?.boxscore?.teams?.find((t) => t.team?.id === teamId);
  const bat = row?.statistics?.find((s) => s.name === "batting");
  const map = {};
  for (const st of bat?.stats || []) {
    if (st?.name) map[st.name] = toNum(st.value, NaN);
  }
  const gp = map.gamesPlayed || map.teamGamesPlayed || 1;
  const hits = map.hits;
  const runs = map.runs;
  if (!Number.isFinite(hits) || !Number.isFinite(gp) || gp <= 0) return null;
  return {
    hitsPerGame: hits / gp,
    runsPerGame: Number.isFinite(runs) ? runs / gp : null
  };
}

export function getMlbPitcherKProjection(leaderRow) {
  const stats = leaderRow?.statistics || [];
  const k = toNum(stats.find((x) => x.name === "strikeouts")?.value, NaN);
  const w = toNum(stats.find((x) => x.name === "wins")?.value, 0);
  if (!Number.isFinite(k) || k <= 0) return { kPerStart: null, seasonK: null };
  const estStarts = Math.max(3, Math.round(w * 2 + 4));
  return { kPerStart: k / estStarts, seasonK: k };
}

export function getRawEspnLeaderRow(sideBlock, categoryName) {
  const cat = sideBlock?.leaders?.find((c) => c.name === categoryName);
  return cat?.leaders?.[0] || null;
}

export function getMlbTeamGamesPlayed(summary, teamId) {
  const row = summary?.boxscore?.teams?.find((t) => t.team?.id === teamId);
  const bat = row?.statistics?.find((s) => s.name === "batting");
  const gp = bat?.stats?.find((s) => s.name === "gamesPlayed" || s.name === "teamGamesPlayed")?.value;
  return Math.max(1, toNum(gp, 1));
}

export function soccerLeaderTotalsPerAppearance(entry, totalNames = ["totalGoals"], appName = "appearances") {
  const stats = entry?.statistics || [];
  let total = NaN;
  for (const nm of totalNames) {
    const v = toNum(stats.find((s) => s.name === nm)?.value, NaN);
    if (Number.isFinite(v)) { total = v; break; }
  }
  const av = toNum(stats.find((s) => s.name === appName)?.value, NaN);
  if (!Number.isFinite(total) || !Number.isFinite(av) || av <= 0) return null;
  return total / av;
}

export function soccerLeaderGoalsPer90(entry) {
  return soccerLeaderTotalsPerAppearance(entry, ["totalGoals", "goals"]);
}

export function soccerLeaderAssistsPer90(entry) {
  return soccerLeaderTotalsPerAppearance(entry, ["assists", "totalAssists"]);
}

export function soccerLeaderShotsPer90(entry) {
  return soccerLeaderTotalsPerAppearance(entry, ["shots", "totalShots", "shotsOnGoal"]);
}

/** Fortaleza 0..1 desde record "W-D-L" o "W-L". */
export function soccerRecordStrength(recordSummary) {
  const raw = String(recordSummary || "").trim();
  // Formato europeo W-D-L
  const m3 = raw.match(/(\d+)\s*[-–]\s*(\d+)\s*[-–]\s*(\d+)/);
  if (m3) {
    const [, w, d, l] = m3.map(Number);
    const t = w + d + l;
    if (t <= 0) return 0.5;
    return Math.max(0.08, Math.min(0.95, (w * 3 + d) / (t * 3)));
  }
  // Formato W-L (MLB/NBA style)
  const m2 = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m2) {
    const [, w, l] = m2.map(Number);
    const t = w + l;
    if (t <= 0) return 0.5;
    return Math.max(0.1, Math.min(0.9, w / t));
  }
  return 0.5;
}
