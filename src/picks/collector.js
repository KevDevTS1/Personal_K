import { bogotaTodayKey, bogotaDayKey } from "../utils/time.js";
import { fetchScoreboard, enrichEspnFeedsWithSummaries } from "../data/espn.js";
import { fetchSportsDbEvents } from "../data/sportsdb.js";
import { buildOddsStore, applyRealOddsToPickList } from "../data/odds.js";
import { buildMlbStore, lookupMlbGame } from "../data/mlb.js";
import { getLeagueDisplayName, SOCCER_LEAGUES, BASKET_LEAGUES, TENNIS_LEAGUES, BASEBALL_LEAGUES, SPORTSDB_SPORTS } from "../config/leagues.js";
import { isEventLive, getLiveStatusLabel } from "../utils/event.js";
import { analyzeSoccerEvent } from "../analyzers/soccer.js";
import { analyzeBasketballEvent } from "../analyzers/basketball.js";
import { analyzeTennisEvent } from "../analyzers/tennis.js";
import { analyzeBaseballEvent } from "../analyzers/baseball.js";
import { analyzeSportsDbEvent } from "../analyzers/sportsdb.js";
import { enrichPick } from "./enricher.js";

export async function collectAllEvents(targetDateKey = null) {
  const dateKey = targetDateKey || bogotaTodayKey(0);
  const tasks = [];

  for (const league of SOCCER_LEAGUES) {
    tasks.push(fetchScoreboard("soccer", league, dateKey).then((data) => ({ sport: "futbol", league, dateKey, data })).catch(() => null));
  }
  for (const league of BASKET_LEAGUES) {
    tasks.push(fetchScoreboard("basketball", league, dateKey).then((data) => ({ sport: "baloncesto", league, dateKey, data })).catch(() => null));
  }
  for (const league of TENNIS_LEAGUES) {
    tasks.push(fetchScoreboard("tennis", league, dateKey).then((data) => ({ sport: "tenis", league, dateKey, data })).catch(() => null));
  }
  for (const league of BASEBALL_LEAGUES) {
    tasks.push(fetchScoreboard("baseball", league, dateKey).then((data) => ({ sport: "beisbol", league, dateKey, data })).catch(() => null));
  }

  const dbTasks = SPORTSDB_SPORTS.map((sportName) =>
    fetchSportsDbEvents(dateKey, sportName).then((data) => ({ sportName, dateKey, data })).catch(() => null)
  );

  // Fetch ESPN, SportsDB, and MLB data all in parallel
  const [espnRaw, sportDbFeeds, mlbStore] = await Promise.all([
    Promise.all(tasks),
    Promise.all(dbTasks),
    buildMlbStore(dateKey).catch(() => new Map()),
  ]);

  const espnFeeds = espnRaw.filter(Boolean);
  const filteredDbFeeds = sportDbFeeds.filter(Boolean);

  await enrichEspnFeedsWithSummaries(espnFeeds);

  // Determine which leagues actually have events today, then fetch real odds
  const activeLeagueSlugs = espnFeeds
    .filter(f => (f.data?.events?.length || 0) > 0)
    .map(f => f.league);

  const oddsStore = await buildOddsStore(activeLeagueSlugs, dateKey).catch(() => new Map());

  return { espnFeeds, sportDbFeeds: filteredDbFeeds, oddsStore, mlbStore };
}

export function createPicksFromEvents(feedSets, targetDateKey = null, calibrationStore = null, options = {}) {
  const { onlyLive = false } = options;
  const dateKey = targetDateKey || bogotaTodayKey(0);
  const { oddsStore, mlbStore } = feedSets;
  const picks = [];

  for (const feed of feedSets.espnFeeds) {
    const leagueName = getLeagueDisplayName(feed);
    for (const event of feed.data?.events || []) {
      if (onlyLive && !isEventLive(event)) continue;
      const summary = feed.summariesByEventId?.[event.id] || null;
      let generated = [];

      if (feed.sport === "futbol") {
        generated = analyzeSoccerEvent(event, leagueName, feed.dateKey, summary, calibrationStore, feed.league);
      } else if (feed.sport === "baloncesto") {
        generated = analyzeBasketballEvent(event, leagueName, feed.league, feed.dateKey, summary, calibrationStore);
      } else if (feed.sport === "tenis") {
        generated = analyzeTennisEvent(event, leagueName, feed.dateKey);
      } else if (feed.sport === "beisbol") {
        // Look up MLB real data (probable pitchers + team batting) for this event
        const comp = event.competitions?.[0];
        const homeC = comp?.competitors?.find(c => c.homeAway === "home");
        const awayC = comp?.competitors?.find(c => c.homeAway === "away");
        const hName = homeC?.team?.displayName || homeC?.team?.shortDisplayName || "";
        const aName = awayC?.team?.displayName || awayC?.team?.shortDisplayName || "";
        const mlbGameData = lookupMlbGame(mlbStore, hName, aName);
        generated = analyzeBaseballEvent(event, leagueName, feed.league, feed.dateKey, summary, calibrationStore, mlbGameData);
      }

      const comp = event.competitions?.[0];
      const homeC = comp?.competitors?.find(c => c.homeAway === "home");
      const awayC = comp?.competitors?.find(c => c.homeAway === "away");
      const eventMeta = {
        homeTeam:    homeC?.team?.shortDisplayName || homeC?.team?.displayName || null,
        awayTeam:    awayC?.team?.shortDisplayName || awayC?.team?.displayName || null,
        homeScore:   homeC?.score != null ? String(homeC.score) : null,
        awayScore:   awayC?.score != null ? String(awayC.score) : null,
        eventStatus: comp?.status?.type?.state || null,
      };

      picks.push(...generated.map(p => ({
        ...p,
        ...eventMeta,
        league: leagueName,
        leagueSlug: feed.league,
        sourceDateKey: feed.dateKey,
        forDate: dateKey,
        liveStatus: isEventLive(event) ? getLiveStatusLabel(event) : null,
      })));
    }
  }

  if (!onlyLive) {
    for (const feed of feedSets.sportDbFeeds) {
      for (const event of feed.data?.events || []) {
        picks.push(...analyzeSportsDbEvent(event, feed.sportName, feed.dateKey).map(p => ({
          ...p,
          sourceDateKey: feed.dateKey,
          forDate: dateKey,
        })));
      }
    }
  }

  const filtered = picks
    .filter(p => p && p.event && p.selection && p.eventDateUtc)
    .filter(p => {
      if (onlyLive) return true;
      const key = bogotaDayKey(p.eventDateUtc);
      if (key === dateKey) return true;
      return p.sport === "tenis" && p.sourceDateKey === dateKey;
    })
    .slice(0, 600)
    .map((p, idx) => {
      const withId = { ...p, id: `${Date.now()}-${idx}`, odds: Number((p.odds ?? 1.8).toFixed(2)) };
      return enrichPick(withId);
    });

  // Apply real bookmaker odds (moneyline + totals) and recompute edge
  applyRealOddsToPickList(filtered, oddsStore);

  return filtered;
}
