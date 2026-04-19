import { normName } from "./odds.js";

const BASE = "https://statsapi.mlb.com/api/v1";

// Daily caches
const _scheduleCache = new Map(); // dateKey → games[]
const _pitcherCache  = new Map(); // pitcherId → stats
const _teamBatCache  = new Map(); // teamId → stats

async function safeFetch(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/** Fetch today's MLB schedule with probable pitchers. Returns array of game objects. */
async function fetchMlbSchedule(dateKey) {
  if (_scheduleCache.has(dateKey)) return _scheduleCache.get(dateKey);
  const data = await safeFetch(
    `${BASE}/schedule?sportId=1&date=${dateKey}&hydrate=probablePitcher`
  );
  const games = data?.dates?.[0]?.games || [];
  _scheduleCache.set(dateKey, games);
  console.log(`[MLB] Schedule ${dateKey}: ${games.length} partidos`);
  return games;
}

/** Fetch season pitching stats for a pitcher by ID. */
async function fetchPitcherStats(pitcherId) {
  if (_pitcherCache.has(pitcherId)) return _pitcherCache.get(pitcherId);
  const year = new Date().getFullYear();
  const data = await safeFetch(
    `${BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${year}`
  );
  const stat = data?.stats?.[0]?.splits?.[0]?.stat || null;
  const result = stat ? {
    strikeOuts:    Number(stat.strikeOuts   || 0),
    gamesStarted:  Number(stat.gamesStarted || 1),
    inningsPitched: parseFloat(stat.inningsPitched || "0"),
    era:           parseFloat(stat.era || "4.50"),
    whip:          parseFloat(stat.whip || "1.30"),
    get kPerStart() { return this.gamesStarted > 0 ? this.strikeOuts / this.gamesStarted : 5.5; }
  } : null;
  _pitcherCache.set(pitcherId, result);
  return result;
}

/** Fetch season team batting stats by MLB team ID. */
async function fetchTeamBatting(teamId) {
  if (_teamBatCache.has(teamId)) return _teamBatCache.get(teamId);
  const year = new Date().getFullYear();
  const data = await safeFetch(
    `${BASE}/teams/${teamId}/stats?stats=season&group=hitting&season=${year}`
  );
  const stat = data?.stats?.[0]?.splits?.[0]?.stat || null;
  const gp = Number(stat?.gamesPlayed || 1);
  const result = stat ? {
    avg:         parseFloat(stat.avg || "0.250"),
    hitsPerGame: Number(stat.hits || 0) / gp,
    runsPerGame: Number(stat.runs || 0) / gp,
    hrPerGame:   Number(stat.homeRuns || 0) / gp,
    rbiPerGame:  Number(stat.rbi || 0) / gp,
    obp:         parseFloat(stat.obp || "0.320"),
    slg:         parseFloat(stat.slg || "0.400"),
    gamesPlayed: gp
  } : null;
  _teamBatCache.set(teamId, result);
  return result;
}

/**
 * Builds a store of MLB game data (pitchers + team batting) for a date.
 * Returns Map<normMatchKey, { homePitcher, awayPitcher, homeBatting, awayBatting }>
 * normMatchKey = `${normName(homeTeam)}|||${normName(awayTeam)}`
 */
export async function buildMlbStore(dateKey) {
  const games = await fetchMlbSchedule(dateKey);
  if (!games.length) return new Map();

  // Collect all pitcher IDs and team IDs to fetch in parallel
  const pitcherIds = new Set();
  const teamIds    = new Set();

  for (const g of games) {
    const hp = g.teams?.home?.probablePitcher?.id;
    const ap = g.teams?.away?.probablePitcher?.id;
    const ht = g.teams?.home?.team?.id;
    const at = g.teams?.away?.team?.id;
    if (hp) pitcherIds.add(hp);
    if (ap) pitcherIds.add(ap);
    if (ht) teamIds.add(ht);
    if (at) teamIds.add(at);
  }

  // Fetch all in parallel
  await Promise.allSettled([
    ...[...pitcherIds].map(id => fetchPitcherStats(id)),
    ...[...teamIds].map(id => fetchTeamBatting(id)),
  ]);

  const store = new Map();
  for (const g of games) {
    const homeInfo = g.teams?.home;
    const awayInfo = g.teams?.away;
    const homeName = homeInfo?.team?.name || "";
    const awayName = awayInfo?.team?.name || "";
    const key = `${normName(homeName)}|||${normName(awayName)}`;

    const homePitcherRaw = homeInfo?.probablePitcher;
    const awayPitcherRaw = awayInfo?.probablePitcher;

    const homePitcherStats = homePitcherRaw?.id ? await fetchPitcherStats(homePitcherRaw.id) : null;
    const awayPitcherStats = awayPitcherRaw?.id ? await fetchPitcherStats(awayPitcherRaw.id) : null;
    const homeBatting = homeInfo?.team?.id ? await fetchTeamBatting(homeInfo.team.id) : null;
    const awayBatting = awayInfo?.team?.id ? await fetchTeamBatting(awayInfo.team.id) : null;

    store.set(key, {
      homePitcher: homePitcherRaw ? {
        name: homePitcherRaw.fullName,
        id:   homePitcherRaw.id,
        ...(homePitcherStats || {})
      } : null,
      awayPitcher: awayPitcherRaw ? {
        name: awayPitcherRaw.fullName,
        id:   awayPitcherRaw.id,
        ...(awayPitcherStats || {})
      } : null,
      homeBatting,
      awayBatting,
    });
  }

  console.log(`[MLB] MlbStore: ${store.size} partidos con datos de lanzadores/bateo`);
  return store;
}

/** Look up MLB game data by ESPN team names (fuzzy). */
export function lookupMlbGame(store, homeTeam, awayTeam) {
  if (!store?.size || !homeTeam || !awayTeam) return null;
  const hn = normName(homeTeam);
  const an = normName(awayTeam);

  const direct = store.get(`${hn}|||${an}`);
  if (direct) return direct;

  for (const [key, val] of store) {
    const [kh, ka] = key.split("|||");
    const hm = kh === hn || kh.includes(hn) || hn.includes(kh);
    const am = ka === an || ka.includes(an) || an.includes(ka);
    if (hm && am) return val;
  }
  return null;
}
