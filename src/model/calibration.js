import { toNum, normalCdf } from "../utils/math.js";
import { rangeKeysInBogota } from "../utils/time.js";
import { fetchScoreboard, enrichEspnFeedsWithSummaries, findEspnLeaderSide, getEspnCategoryLeader, parseNbaTeamSeasonStatsFromBoxscore, parseMlbTeamBattingRates, getMlbPitcherKProjection, getRawEspnLeaderRow, getMlbTeamGamesPlayed, soccerLeaderGoalsPer90, soccerLeaderAssistsPer90 } from "../data/espn.js";
import { BASKET_LEAGUES, BASEBALL_LEAGUES, SOCCER_LEAGUES } from "../config/leagues.js";

const HISTORY_DAYS = 7;
const CACHE_TTL_MS = 15 * 60 * 1000;
const calibrationCache = new Map();

function makeCalibKey(sport, leagueSlug, stat) {
  return `${sport}|${leagueSlug || "unknown"}|${String(stat || "").toLowerCase()}`;
}

function createStore() {
  return { stats: new Map(), updatedAt: new Date().toISOString() };
}

export function observeCalibration(store, { sport, leagueSlug, stat, value }) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return;
  const key = makeCalibKey(sport, leagueSlug, stat);
  const curr = store.stats.get(key) || { n: 0, sum: 0, sumSq: 0 };
  curr.n += 1;
  curr.sum += v;
  curr.sumSq += v * v;
  store.stats.set(key, curr);
}

export function getCalibrationStats(store, { sport, leagueSlug, stat }) {
  if (!store?.stats) return null;
  const raw = store.stats.get(makeCalibKey(sport, leagueSlug, stat));
  if (!raw || raw.n < 3) return null;
  const mean = raw.sum / raw.n;
  const variance = Math.max(0.0001, (raw.sumSq / raw.n) - mean * mean);
  return { n: raw.n, mean, sd: Math.sqrt(variance) };
}

function buildStoreFromFeeds(feeds) {
  const store = createStore();
  for (const feed of feeds) {
    for (const event of feed.data?.events || []) {
      const summary = feed.summariesByEventId?.[event.id];
      if (!summary) continue;
      for (const comp of event.competitions?.[0]?.competitors || []) {
        const teamId = comp?.team?.id;
        if (!teamId) continue;
        const side = findEspnLeaderSide(summary, teamId);

        if (feed.sport === "baloncesto") {
          const pts = side ? getEspnCategoryLeader(side, "pointsPerGame") : null;
          const reb = side ? getEspnCategoryLeader(side, "reboundsPerGame") : null;
          const ast = side ? getEspnCategoryLeader(side, "assistsPerGame") : null;
          const stl = side ? getEspnCategoryLeader(side, "stealsPerGame") : null;
          const blk = side ? getEspnCategoryLeader(side, "blocksPerGame") : null;
          const tpm = side ? getEspnCategoryLeader(side, "threePointFieldGoalsPerGame") : null;
          const teamStats = parseNbaTeamSeasonStatsFromBoxscore(summary, teamId);
          observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "puntos", value: pts?.value });
          observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "rebotes", value: reb?.value });
          observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "asistencias", value: ast?.value });
          observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "robos", value: stl?.value });
          observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "tapones", value: blk?.value });
          observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "3pm", value: tpm?.value });
          observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "asistencias-equipo", value: teamStats.avgAssists });
          if (Number.isFinite(pts?.value)) {
            observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "pra (puntos+rebotes+asistencias)", value: pts.value * 1.72 });
            observeCalibration(store, { sport: "baloncesto", leagueSlug: feed.league, stat: "triples", value: Math.max(1.2, Math.min(4.8, pts.value * 0.14)) });
          }
        }

        if (feed.sport === "beisbol") {
          const rates = parseMlbTeamBattingRates(summary, teamId);
          observeCalibration(store, { sport: "beisbol", leagueSlug: feed.league, stat: "hits-equipo", value: rates?.hitsPerGame });
          observeCalibration(store, { sport: "beisbol", leagueSlug: feed.league, stat: "carreras equipo", value: rates?.runsPerGame });
          const kRow = side ? getRawEspnLeaderRow(side, "strikeouts") : null;
          const kProj = getMlbPitcherKProjection(kRow);
          observeCalibration(store, { sport: "beisbol", leagueSlug: feed.league, stat: "strikeouts lanzador", value: kProj.kPerStart });
          const rbiRow = side ? getRawEspnLeaderRow(side, "RBIs") : null;
          const rgp = getMlbTeamGamesPlayed(summary, teamId);
          const rbiV = toNum(rbiRow?.statistics?.find((x) => x.name === "RBIs")?.value, NaN);
          const dblV = toNum(rbiRow?.statistics?.find((x) => x.name === "doubles")?.value, NaN);
          if (Number.isFinite(rbiV) && rgp > 0) observeCalibration(store, { sport: "beisbol", leagueSlug: feed.league, stat: "rbi (bateador)", value: rbiV / rgp });
          if (Number.isFinite(dblV) && rgp > 0) observeCalibration(store, { sport: "beisbol", leagueSlug: feed.league, stat: "dobles (bateador)", value: dblV / rgp });
        }

        if (feed.sport === "futbol") {
          const goalsCat = side?.leaders?.find((c) => c.name === "goalsLeaders");
          const gpg = soccerLeaderGoalsPer90(goalsCat?.leaders?.[0]);
          if (Number.isFinite(gpg)) observeCalibration(store, { sport: "futbol", leagueSlug: feed.league, stat: "goles (jugador)", value: gpg });
          const assistsCat = side?.leaders?.find((c) => ["assistsLeaders", "assists", "assistLeaders"].includes(c.name));
          const apg = soccerLeaderAssistsPer90(assistsCat?.leaders?.[0]);
          if (Number.isFinite(apg)) observeCalibration(store, { sport: "futbol", leagueSlug: feed.league, stat: "asistencias (jugador)", value: apg });
        }
      }
    }
  }
  return store;
}

export async function getCalibrationStore(targetDateKey) {
  const cacheKey = String(targetDateKey);
  const cached = calibrationCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) return cached.store;

  const dateKeys = rangeKeysInBogota(HISTORY_DAYS, 1, targetDateKey).filter((d) => d < targetDateKey);
  if (!dateKeys.length) return createStore();

  const tasks = [];
  for (const league of BASKET_LEAGUES) {
    for (const dk of dateKeys) {
      tasks.push(fetchScoreboard("basketball", league, dk).then((data) => ({ sport: "baloncesto", league, dateKey: dk, data })).catch(() => null));
    }
  }
  for (const league of BASEBALL_LEAGUES) {
    for (const dk of dateKeys) {
      tasks.push(fetchScoreboard("baseball", league, dk).then((data) => ({ sport: "beisbol", league, dateKey: dk, data })).catch(() => null));
    }
  }
  for (const league of SOCCER_LEAGUES) {
    for (const dk of dateKeys) {
      tasks.push(fetchScoreboard("soccer", league, dk).then((data) => ({ sport: "futbol", league, dateKey: dk, data })).catch(() => null));
    }
  }

  const feeds = (await Promise.all(tasks)).filter(Boolean);
  await enrichEspnFeedsWithSummaries(feeds);
  const store = buildStoreFromFeeds(feeds);
  calibrationCache.set(cacheKey, { ts: Date.now(), store });
  return store;
}
