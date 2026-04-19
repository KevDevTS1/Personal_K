import { Router } from "express";
import { bogotaTodayKey } from "../utils/time.js";
import { BOGOTA_TZ, SOCCER_LEAGUES, SOCCER_LEAGUE_LABELS, BASKET_LEAGUES, BASKET_LEAGUE_LABELS, TENNIS_LEAGUES, TENNIS_LEAGUE_LABELS, BASEBALL_LEAGUES, BASEBALL_LEAGUE_LABELS } from "../config/leagues.js";
import { createPicksFromEvents } from "../picks/collector.js";
import { getCachedFeeds } from "../cache/feeds.js";

const router = Router();

router.get("/picks", async (req, res) => {
  try {
    const rawDate = String(req.query.targetDate || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : bogotaTodayKey(0);

    const { feeds, calibrationStore } = await getCachedFeeds(targetDate);
    const picks = createPicksFromEvents(feeds, targetDate, calibrationStore);

    const valuePicks = [...picks]
      .filter(p => Number(p.edge) >= 0.04 && Number(p.confidence) >= 72)
      .sort((a, b) => Number(b.edge) - Number(a.edge))
      .slice(0, 12);

    const topTips = [...picks]
      .filter(p => Number(p.confidence) >= 80)
      .sort((a, b) => Number(b.confidence) - Number(a.confidence))
      .slice(0, 12);

    res.json({
      date: new Date().toISOString(),
      source: "ESPN + The Odds API (cuotas reales) + MLB Stats API (lanzadores/bateo) + TheSportsDB + modelo estadístico v4",
      modelNote: "v4: cuotas reales de casas europeas via The Odds API → edge real vs. mercado. Béisbol: lanzador probable + stats de bateo desde MLB Stats API oficial. Edge ≥ 4% y confianza ≥ 72% para value picks.",
      total: picks.length,
      range: { targetDate, timezone: BOGOTA_TZ },
      feedHealth: { espnFeeds: feeds.espnFeeds.length, sportsDbFeeds: feeds.sportDbFeeds.length },
      cacheAge: feeds._fetchedAt ? Math.round((Date.now() - feeds._fetchedAt) / 1000) + "s" : null,
      valuePicks,
      topTips,
      picks,
    });
  } catch (error) {
    console.error("[/api/picks]", error);
    res.status(500).json({ error: "No se pudieron generar picks", details: error.message });
  }
});

router.get("/live-picks", async (_req, res) => {
  try {
    const targetDate = bogotaTodayKey(0);
    const { feeds, calibrationStore } = await getCachedFeeds(targetDate);
    const picks = createPicksFromEvents(feeds, targetDate, calibrationStore, { onlyLive: true });
    const liveEvents = new Set(picks.map(p => p.event)).size;
    res.json({
      date: new Date().toISOString(),
      range: { targetDate, timezone: BOGOTA_TZ },
      liveEvents, total: picks.length, picks,
    });
  } catch (error) {
    console.error("[/api/live-picks]", error);
    res.status(500).json({ error: "No se pudieron generar picks en vivo", details: error.message });
  }
});

router.get("/league-catalog", (_req, res) => {
  res.json({
    futbol:     SOCCER_LEAGUES.map(slug => ({ slug, label: SOCCER_LEAGUE_LABELS[slug] || slug })),
    baloncesto: BASKET_LEAGUES.map(slug => ({ slug, label: BASKET_LEAGUE_LABELS[slug] || slug })),
    tenis:      TENNIS_LEAGUES.map(slug => ({ slug, label: TENNIS_LEAGUE_LABELS[slug] || slug })),
    beisbol:    BASEBALL_LEAGUES.map(slug => ({ slug, label: BASEBALL_LEAGUE_LABELS[slug] || slug })),
  });
});

export default router;
