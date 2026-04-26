import { bogotaTodayKey, bogotaDayKey } from "../utils/time.js";
import { fetchScoreboard, enrichEspnFeedsWithSummaries } from "../data/espn.js";
import { buildOddsStore, applyRealOddsToPickList, lookupGameOdds } from "../data/odds.js";
import { buildColombianOddsStore, lookupColombianOdds } from "../data/colombian_odds.js";
import { buildMlbStore, lookupMlbGame } from "../data/mlb.js";
import {
  getLeagueDisplayName,
  SOCCER_LEAGUES, BASKET_LEAGUES, TENNIS_LEAGUES, BASEBALL_LEAGUES
} from "../config/leagues.js";
import { isEventLive, getLiveStatusLabel } from "../utils/event.js";
import { analyzeSoccerEvent } from "../analyzers/soccer.js";
import { analyzeBasketballEvent } from "../analyzers/basketball.js";
import { analyzeTennisEvent } from "../analyzers/tennis.js";
import { analyzeBaseballEvent } from "../analyzers/baseball.js";
import { analyzeLiveEvent } from "../analyzers/live.js";
import { enrichPick, attachScores } from "./enricher.js";
import { attachLongArguments } from "./argumentBuilder.js";
import { buildEventContext, enrichPicksWithContext } from "./context.js";
import { enrichPicksWithSportsDB } from "../data/thesportsdb.js";
import { enrichPicksWithFootballData } from "../data/footballdata.js";
import { applyContextAdjustmentsAll } from "../model/contextAdjust.js";
import { applyBaseballMatchupAll } from "../model/baseballMatchup.js";
import { enrichPlayerPropsWithBalldontlie } from "./playerStats.js";
import { enrichPicksWithSofascore } from "../data/sofascore.js";
import { enrichPicksWithClubElo } from "../data/clubelo.js";

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

  const [espnRaw, mlbStore] = await Promise.all([
    Promise.all(tasks),
    buildMlbStore(dateKey).catch(() => new Map()),
  ]);

  const espnFeeds = espnRaw.filter(Boolean);
  await enrichEspnFeedsWithSummaries(espnFeeds);

  // Determine which leagues actually have events today
  const activeLeagueSlugs = espnFeeds
    .filter(f => (f.data?.events?.length || 0) > 0)
    .map(f => f.league);

  // Detect which sports have events today (for CO odds scraping)
  const activeSports = [...new Set(
    espnFeeds.filter(f => (f.data?.events?.length || 0) > 0).map(f => f.sport)
  )];

  // Fetch in parallel: The Odds API (EU/UK) + Colombian bookies per sport
  const [oddsStore, ...coStores] = await Promise.all([
    buildOddsStore(activeLeagueSlugs, dateKey).catch(() => new Map()),
    ...activeSports.map(s => buildColombianOddsStore(s).catch(() => new Map()))
  ]);

  const coStoresBySport = Object.fromEntries(
    activeSports.map((s, i) => [s, coStores[i]])
  );

  return { espnFeeds, oddsStore, coStoresBySport, mlbStore };
}

export async function createPicksFromEvents(feedSets, targetDateKey = null, calibrationStore = null, options = {}) {
  const { onlyLive = false } = options;
  const dateKey = targetDateKey || bogotaTodayKey(0);
  const { oddsStore, coStoresBySport, mlbStore } = feedSets;
  const picks = [];
  const contextByEventId = new Map(); // key: "<eventName>|<sourceDateKey>"

  for (const feed of feedSets.espnFeeds) {
    const leagueName = getLeagueDisplayName(feed);
    for (const event of feed.data?.events || []) {
      const live = isEventLive(event);
      if (onlyLive && !live) continue;
      const summary = feed.summariesByEventId?.[event.id] || null;
      let generated = [];

      if (onlyLive) {
        // Modo en vivo: usa el analizador especializado que considera
        // marcador, minuto/periodo/inning y proyecta el desenlace residual.
        generated = analyzeLiveEvent(feed.sport, event, leagueName, feed.league, feed.dateKey);
      } else if (feed.sport === "futbol") {
        generated = analyzeSoccerEvent(event, leagueName, feed.dateKey, summary, calibrationStore, feed.league);
      } else if (feed.sport === "baloncesto") {
        generated = analyzeBasketballEvent(event, leagueName, feed.league, feed.dateKey, summary, calibrationStore);
      } else if (feed.sport === "tenis") {
        generated = analyzeTennisEvent(event, leagueName, feed.dateKey);
      } else if (feed.sport === "beisbol") {
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
        homeLogo:    homeC?.team?.logo || homeC?.team?.logos?.[0]?.href || null,
        awayLogo:    awayC?.team?.logo || awayC?.team?.logos?.[0]?.href || null,
      };

      // Detectar disponibilidad de cuotas reales (para dataQuality)
      const coGame = coStoresBySport?.[feed.sport]
        ? lookupColombianOdds(coStoresBySport[feed.sport], eventMeta.homeTeam, eventMeta.awayTeam)
        : null;
      const euGame = oddsStore && oddsStore.size
        ? lookupGameOdds(oddsStore, eventMeta.homeTeam, eventMeta.awayTeam)
        : null;
      const hasCoOdds = Boolean(coGame);
      const hasEuOdds = Boolean(euGame);

      picks.push(...generated.map(p => ({
        ...p,
        ...eventMeta,
        league: leagueName,
        leagueSlug: feed.league,
        sourceDateKey: feed.dateKey,
        forDate: dateKey,
        liveStatus: isEventLive(event) ? getLiveStatusLabel(event) : null,
        hasCoOdds, hasEuOdds,
        coOddsContext: coGame ? { books: coGame.books, averaged: coGame.averaged } : null,
      })));

      // Guardar contexto por evento (clave: "<event>|<dateKey>" igual que en enrich)
      const eventName = generated[0]?.event;
      if (eventName && summary) {
        const ctx = buildEventContext(summary, feed.sport);
        if (ctx) contextByEventId.set(`${eventName}|${feed.dateKey}`, ctx);
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

  applyRealOddsToPickList(filtered, oddsStore, coStoresBySport);

  // Enriquecer con contexto extra (lesiones, standings, venue, clima outdoor).
  // Hacemos esto antes de attachScores para que dataQuality lo refleje.
  await enrichPicksWithContext(filtered, contextByEventId).catch((err) => {
    console.warn("[context] enriquecimiento parcial:", err?.message || err);
  });

  // Forma reciente real (últimos 5 partidos) vía TheSportsDB. Solo en pre-match
  // — en live no aporta porque ya estamos viendo el partido en curso.
  if (!onlyLive) {
    await enrichPicksWithSportsDB(filtered, 3).catch((err) => {
      console.warn("[sportsdb] enriquecimiento parcial:", err?.message || err);
    });
    // Tabla oficial + posicion del equipo via football-data.org (top 12 ligas).
    await enrichPicksWithFootballData(filtered, 1).catch((err) => {
      console.warn("[football-data] enriquecimiento parcial:", err?.message || err);
    });
  }

  if (onlyLive) {
    // En vivo: el contexto cambia minuto a minuto, no tiene sentido cachear
    // 500+ palabras por jugada. Usamos el argumento corto del analizador
    // como argumentLong para que el modal y la tarjeta lo muestren igual.
    for (const p of filtered) {
      p.argumentLong   = p.argument || "";
      p.argumentModel  = "live-context";
      p.argumentWords  = String(p.argument || "").trim().split(/\s+/).filter(Boolean).length;
    }
  } else {
    // Argumento extenso (Groq + cache). Se hace despues de fijar la cuota real
    // para que el LLM razone con la cuota correcta.
    await attachLongArguments(filtered, 4);
  }

  // Recalibra player props NBA con season averages reales (balldontlie).
  // Solo en pre-match — en live ya tenemos data del partido en curso.
  if (!onlyLive) {
    await enrichPlayerPropsWithBalldontlie(filtered, 40).catch(err => {
      console.warn("[balldontlie] enriquecimiento parcial:", err?.message || err);
    });
    // SofaScore: alineaciones reales para top 25 partidos de futbol.
    // Cloudflare suele bloquear desde IP de servidor → softfail si 403.
    await enrichPicksWithSofascore(filtered, 25).catch(err => {
      console.warn("[sofascore] enriquecimiento parcial:", err?.message || err);
    });
    // ClubElo: rating oficial de clubes europeos. Sirve de baseline robusto
    // para moneyline de futbol cuando la forma reciente es contradictoria.
    await enrichPicksWithClubElo(filtered, 60).catch(err => {
      console.warn("[clubelo] enriquecimiento parcial:", err?.message || err);
    });
  }

  // Ajustes específicos de béisbol: duelo de lanzadores, ofensivas, run line.
  applyBaseballMatchupAll(filtered);

  // Ajustes contextuales sobre modelProb: clima, lesiones, tabla oficial,
  // forma reciente real, records L/V. Cada ajuste es pequeño (±2-6pp) pero
  // acumulados afinan probabilidad antes de calcular score/edge final.
  applyContextAdjustmentsAll(filtered);

  // Score unificado 0-100 (Tarea 5). Despues de cuotas reales y argumentos
  // para que dataQuality refleje todas las fuentes activas.
  attachScores(filtered);

  return filtered;
}
