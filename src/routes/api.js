import { Router } from "express";
import { bogotaTodayKey } from "../utils/time.js";
import { BOGOTA_TZ, SOCCER_LEAGUES, SOCCER_LEAGUE_LABELS, BASKET_LEAGUES, BASKET_LEAGUE_LABELS, TENNIS_LEAGUES, TENNIS_LEAGUE_LABELS, BASEBALL_LEAGUES, BASEBALL_LEAGUE_LABELS } from "../config/leagues.js";
import { createPicksFromEvents } from "../picks/collector.js";
import { getCachedFeeds } from "../cache/feeds.js";
import { isGroqAvailable } from "../data/llm.js";
import { getSofascoreHealth } from "../data/sofascore.js";

const router = Router();

/**
 * Construye el reporte de estado de cada fuente de datos para el panel
 * "Fuentes activas" del front. status puede ser:
 *   "ok"      verde     funcionando con datos hoy
 *   "empty"   amarillo  conectada pero 0 datos hoy
 *   "missing_key" amarillo requiere variable de entorno
 *   "error"   rojo      respondio con error / scraping fallo
 *   "off"     gris      desactivada por configuracion
 */
function buildFeedHealth(feeds, picks) {
  const espnCount = feeds.espnFeeds.filter(f => (f.data?.events?.length || 0) > 0).length;
  const coCounts  = Object.fromEntries(
    Object.entries(feeds.coStoresBySport || {}).map(([k, v]) => [k, v?.size ?? 0])
  );
  const coTotal = Object.values(coCounts).reduce((a, b) => a + b, 0);
  const mlbCount = feeds.mlbStore?.size ?? 0;

  // Argumentos: cuantos picks tienen argumentLong de Groq vs fallback
  const argFromGroq = picks.filter(p => p.argumentModel && !String(p.argumentModel).startsWith("fallback")).length;
  const argFallback = picks.filter(p => p.argumentModel === "fallback-template").length;

  return {
    espn: {
      label: "ESPN",
      detail: `${feeds.espnFeeds.length} feeds · ${espnCount} con eventos`,
      status: espnCount > 0 ? "ok" : "empty",
      requiresKey: false
    },
    mlb: {
      label: "MLB Stats API",
      detail: mlbCount > 0 ? `${mlbCount} partidos con lanzadores/bateo` : "Sin partidos hoy",
      status: mlbCount > 0 ? "ok" : "empty",
      requiresKey: false
    },
    oddsApi: {
      label: "The Odds API (cuotas EU/UK)",
      detail: !process.env.ODDS_API_KEY
        ? "Falta ODDS_API_KEY"
        : String(process.env.ODDS_API_ENABLED || "false").toLowerCase() !== "true"
          ? "Secundaria · apagada (ODDS_API_ENABLED=false). Activala solo si necesitas cuotas reales (consume cuota free rapido)."
          : (feeds.oddsStore?.size ? `${feeds.oddsStore.size} partidos con cuotas reales` : "Key OK pero 0 cuotas hoy (rate limit o partidos no listados)"),
      status: !process.env.ODDS_API_KEY ? "missing_key"
            : String(process.env.ODDS_API_ENABLED || "false").toLowerCase() !== "true" ? "secondary"
            : (feeds.oddsStore?.size ? "ok" : "empty"),
      requiresKey: true,
      envVar: "ODDS_API_KEY"
    },
    coOdds: {
      label: "Casas Colombia (scraping)",
      detail: coTotal > 0
        ? `${coTotal} eventos: ${Object.entries(coCounts).filter(([,v])=>v>0).map(([k,v])=>`${k}=${v}`).join(", ")}`
        : "0 eventos · las casas usan SPA, el scraping HTML simple no extrae cuotas",
      status: coTotal > 0 ? "ok" : "error",
      requiresKey: false
    },
    weather: {
      label: process.env.OPENWEATHER_API_KEY ? "Clima (OpenWeatherMap + wttr.in)" : "Clima (wttr.in)",
      detail: process.env.OPENWEATHER_API_KEY
        ? "Activo · OpenWeather como primario (1000 req/dia), wttr.in como fallback"
        : "Activo · solo wttr.in (sin key, rate limit menor)",
      status: "ok",
      requiresKey: false
    },
    footballData: {
      label: "football-data.org (tabla oficial)",
      detail: process.env.FOOTBALLDATA_API_KEY
        ? "Activo · top 12 ligas europeas (LaLiga, EPL, Serie A, Bundesliga, Ligue 1, Champions, etc.) · 10 req/min"
        : "Falta FOOTBALLDATA_API_KEY · sin posiciones oficiales en pre-match",
      status: process.env.FOOTBALLDATA_API_KEY ? "ok" : "missing_key",
      requiresKey: true,
      envVar: "FOOTBALLDATA_API_KEY"
    },
    sportsdb: {
      label: "TheSportsDB (forma reciente)",
      detail: process.env.THESPORTSDB_KEY
        ? "Activo · key propia (rate limit alto)"
        : "Activo · free key '3' (rate limit estricto, cache disco mitiga)",
      status: "ok",
      requiresKey: false
    },
    sofascore: getSofascoreHealth(),
    clubelo: {
      label: "ClubElo (rating ELO oficial)",
      detail: "Activo · sin auth · rating ELO histórico de clubes europeos para baseline de moneyline en futbol",
      status: "ok",
      requiresKey: false
    },
    understat: {
      label: "Understat (xG Top Europa)",
      detail: "Activo · usado bajo demanda en Premier, LaLiga, Serie A, Bundesliga, Ligue 1",
      status: "ok",
      requiresKey: false
    },
    balldontlie: {
      label: "balldontlie (NBA)",
      detail: "Activo · stats por jugador NBA bajo demanda",
      status: "ok",
      requiresKey: false
    },
    groq: {
      label: "Groq · argumentos LLM",
      detail: isGroqAvailable()
        ? `Activo · ${argFromGroq} argumentos generados, ${argFallback} con plantilla`
        : "Falta GROQ_API_KEY · usando plantilla estadística como fallback",
      status: isGroqAvailable()
        ? (argFromGroq > 0 ? "ok" : "empty")
        : "missing_key",
      requiresKey: true,
      envVar: "GROQ_API_KEY"
    }
  };
}

router.get("/picks", async (req, res) => {
  try {
    const rawDate = String(req.query.targetDate || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : bogotaTodayKey(0);

    const { feeds, calibrationStore } = await getCachedFeeds(targetDate);
    const picks = await createPicksFromEvents(feeds, targetDate, calibrationStore);

    const valuePicks = [...picks]
      .filter(p => Number(p.edge) >= 0.04 && Number(p.score) >= 60)
      .sort((a, b) => Number(b.score) - Number(a.score))
      .slice(0, 12);

    const topTips = [...picks]
      .filter(p => Number(p.score) >= 75)
      .sort((a, b) => Number(b.score) - Number(a.score))
      .slice(0, 12);

    res.json({
      date: new Date().toISOString(),
      source: "ESPN + Casas CO (Wplay/Rushbet/Betsson/Yajuego/Sportium scraping) + The Odds API EU/UK (fallback) + MLB Stats API + Understat xG + balldontlie + API-Football + Groq llama-3.3-70b",
      modelNote: "v5: cuotas reales priorizadas a casas colombianas; argumentos de 500+ palabras generados por Groq; mercados habilitados por whitelist (futbol/baloncesto/tenis/beisbol). Edge ≥ 4% y confianza ≥ 72% para value picks.",
      total: picks.length,
      range: { targetDate, timezone: BOGOTA_TZ },
      feedHealth: buildFeedHealth(feeds, picks),
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
    const picks = await createPicksFromEvents(feeds, targetDate, calibrationStore, { onlyLive: true });
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
