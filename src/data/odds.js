import { clamp } from "../utils/math.js";

// La key se lee de la variable de entorno ODDS_API_KEY (cargada por dotenv).
// Si no esta definida se desactivan todas las llamadas a The Odds API.
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
// FUENTE SECUNDARIA: para no quemar la cuota free (500 req/mes) la dejamos
// apagada por defecto. Se activa con ODDS_API_ENABLED=true en .env.
const ODDS_API_ENABLED = String(process.env.ODDS_API_ENABLED || "false").toLowerCase() === "true";
// Tope de sport_keys consultados por refresh (cada uno = 1 request).
const ODDS_API_MAX_SPORTS = Math.max(1, Number(process.env.ODDS_API_MAX_SPORTS) || 4);
const BASE = "https://api.the-odds-api.com/v4/sports";

// Regiones a consultar: plan free incluye 'us' y 'us2'; planes pagos agregan
// 'uk', 'eu', 'au'. Pedimos las cuatro y aceptamos las que el plan permita.
const REGIONS = "us,us2,uk,eu";

// ESPN league slug → Odds API sport key
// Solo incluye ligas habilitadas en src/config/leagues.js que The Odds API
// soporta hoy (verificado contra /v4/sports/). Las ligas no listadas (Liga
// Colombiana, Club World Cup, EFL Cup, Copa del Rey, Concacaf Champions, etc.)
// se omiten para no quemar requests con 404.
export const ESPN_TO_ODDS_SPORT = {
  // Ligas top
  "eng.1":                  "soccer_epl",
  "esp.1":                  "soccer_spain_la_liga",
  "ger.1":                  "soccer_germany_bundesliga",
  "ita.1":                  "soccer_italy_serie_a",
  "fra.1":                  "soccer_france_ligue_one",
  "por.1":                  "soccer_portugal_primeira_liga",
  "usa.1":                  "soccer_usa_mls",
  "mex.1":                  "soccer_mexico_ligamx",
  "arg.1":                  "soccer_argentina_primera_division",
  "bra.1":                  "soccer_brazil_campeonato",

  // Internacionales (UEFA + CONMEBOL + FIFA)
  "uefa.champions":         "soccer_uefa_champs_league",
  "uefa.europa":            "soccer_uefa_europa_league",
  "uefa.europa.conf":       "soccer_uefa_europa_conference_league",
  "fifa.world":             "soccer_fifa_world_cup",
  "conmebol.libertadores":  "soccer_conmebol_copa_libertadores",
  "conmebol.sudamericana":  "soccer_conmebol_copa_sudamericana",

  // Copas domesticas activas en The Odds API
  "eng.fa":                 "soccer_fa_cup",
  "ita.coppa_italia":       "soccer_italy_coppa_italia",

  // Baloncesto
  "nba":                    "basketball_nba",
  "wnba":                   "basketball_wnba",
  "euroleague":             "basketball_euroleague",

  // Beisbol
  "mlb":                    "baseball_mlb",
};

// Tenis: The Odds API no expone 'tennis_atp' / 'tennis_wta' globales; cada
// torneo activo aparece como sport key independiente (p.ej. 'tennis_atp_madrid_open').
// Se descubren dinamicamente en getActiveTennisSportKeys().

// Daily cache: `${dateKey}|${sportKey}` → array of game objects
const _cache = new Map();

export function normName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOddsSport(oddsKey, dateKey) {
  if (!ODDS_API_KEY || !ODDS_API_ENABLED) return [];
  const cacheKey = `${dateKey}|${oddsKey}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  try {
    const url = `${BASE}/${oddsKey}/odds/?apiKey=${ODDS_API_KEY}&regions=${REGIONS}&markets=h2h,totals&oddsFormat=decimal`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const reason = res.status === 401 ? "401 (key invalida o liga fuera de tu plan)"
                   : res.status === 404 ? "404 (sport key no existe)"
                   : res.status === 429 ? "429 (rate limit alcanzado)"
                   : `HTTP ${res.status}`;
      console.warn(`[OddsAPI] ${oddsKey}: ${reason}`);
      _cache.set(cacheKey, []);
      return [];
    }
    const data = await res.json();
    const games = Array.isArray(data) ? data : [];
    if (games.length) console.log(`[OddsAPI] ${oddsKey}: ${games.length} juegos con cuotas reales`);
    _cache.set(cacheKey, games);
    return games;
  } catch (err) {
    console.warn(`[OddsAPI] ${oddsKey}: ${err.message}`);
    _cache.set(cacheKey, []);
    return [];
  }
}

// Cache de sport keys activos por dia (descubiertos via /v4/sports/).
const _activeSportsCache = new Map();

async function fetchActiveSportKeys(dateKey) {
  if (!ODDS_API_KEY || !ODDS_API_ENABLED) return new Set();
  if (_activeSportsCache.has(dateKey)) return _activeSportsCache.get(dateKey);

  try {
    const url = `${BASE}/?apiKey=${ODDS_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`[OddsAPI] /sports list: HTTP ${res.status}`);
      _activeSportsCache.set(dateKey, new Set());
      return new Set();
    }
    const data = await res.json();
    const set = new Set((data || []).filter(s => s.active).map(s => s.key));
    _activeSportsCache.set(dateKey, set);
    console.log(`[OddsAPI] ${set.size} sport keys activos en /v4/sports/`);
    return set;
  } catch (err) {
    console.warn(`[OddsAPI] /sports list: ${err.message}`);
    _activeSportsCache.set(dateKey, new Set());
    return new Set();
  }
}

/**
 * Builds an OddsStore Map from The Odds API for a set of active leagues.
 * Key: `${normHome}|||${normAway}`
 * Value: { homeTeam, awayTeam, h2h, totals }
 */
export async function buildOddsStore(activeLeagueSlugs, dateKey) {
  if (!ODDS_API_KEY) {
    console.log("[OddsAPI] ODDS_API_KEY no configurada — se omite The Odds API");
    return new Map();
  }
  if (!ODDS_API_ENABLED) {
    console.log("[OddsAPI] desactivada (ODDS_API_ENABLED=false). Activa solo si necesitas cuotas reales.");
    return new Map();
  }

  // Descubre que sport keys estan activos hoy (incluye torneos de tenis).
  const activeKeys = await fetchActiveSportKeys(dateKey);

  // Mapeo estatico de ligas ESPN.
  const mapped = activeLeagueSlugs
    .map(s => ESPN_TO_ODDS_SPORT[s])
    .filter(Boolean);

  // Tenis dinamico: si hay ATP/WTA habilitados en ESPN, agrega todos los
  // torneos tennis_* activos hoy.
  const tennisActive = activeLeagueSlugs.some(s => s === "atp" || s === "wta");
  const tennisKeys = tennisActive
    ? [...activeKeys].filter(k => k.startsWith("tennis_atp_") || k.startsWith("tennis_wta_"))
    : [];

  // Combina, deduplica y filtra contra los keys realmente activos.
  const candidates = [...new Set([...mapped, ...tennisKeys])];
  let sportKeys  = candidates.filter(k => activeKeys.size === 0 || activeKeys.has(k));

  // Aplicar tope de cuota: solo consultamos los primeros N (priorizando deportes top).
  if (sportKeys.length > ODDS_API_MAX_SPORTS) {
    const SPORT_PRIORITY = [
      "soccer_epl", "soccer_spain_la_liga", "soccer_uefa_champs_league",
      "basketball_nba", "baseball_mlb", "soccer_italy_serie_a",
      "soccer_germany_bundesliga", "soccer_france_ligue_one"
    ];
    sportKeys.sort((a, b) => {
      const ia = SPORT_PRIORITY.indexOf(a); const ib = SPORT_PRIORITY.indexOf(b);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    const trimmed = sportKeys.slice(ODDS_API_MAX_SPORTS);
    sportKeys = sportKeys.slice(0, ODDS_API_MAX_SPORTS);
    console.log(`[OddsAPI] tope ODDS_API_MAX_SPORTS=${ODDS_API_MAX_SPORTS} aplicado · omitidos: ${trimmed.join(", ")}`);
  }

  const skipped = candidates.filter(k => !sportKeys.includes(k) && (activeKeys.size === 0 || activeKeys.has(k)));
  if (skipped.length) {
    console.log(`[OddsAPI] omitidos: ${skipped.join(", ")}`);
  }

  if (!sportKeys.length) return new Map();

  const results = await Promise.allSettled(sportKeys.map(k => fetchOddsSport(k, dateKey)));

  const store = new Map();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const game of r.value) {
      const hn = normName(game.home_team);
      const an = normName(game.away_team);

      // Parse best available odds across bookmakers
      let homeOdds = null, awayOdds = null, drawOdds = null;
      let totalsLine = null, overOdds = null, underOdds = null;

      for (const bm of game.bookmakers || []) {
        for (const market of bm.markets || []) {
          if (market.key === "h2h" && !homeOdds) {
            for (const o of market.outcomes || []) {
              const on = normName(o.name);
              if (on === hn || hn.includes(on) || on.includes(hn)) homeOdds = o.price;
              else if (on === an || an.includes(on) || on.includes(an)) awayOdds = o.price;
              else if (on === "draw") drawOdds = o.price;
            }
          }
          if (market.key === "totals" && !totalsLine) {
            for (const o of market.outcomes || []) {
              if (o.name === "Over")  { overOdds = o.price; totalsLine = o.point; }
              if (o.name === "Under") { underOdds = o.price; }
            }
          }
        }
        if (homeOdds && overOdds) break; // found both markets
      }

      store.set(`${hn}|||${an}`, {
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceTime: game.commence_time,
        h2h: homeOdds ? { homeOdds, awayOdds, drawOdds } : null,
        totals: totalsLine ? { line: totalsLine, overOdds, underOdds } : null,
      });
    }
  }

  console.log(`[OddsAPI] OddsStore: ${store.size} partidos con cuotas reales`);
  return store;
}

/** Fuzzy lookup: tries exact key then substring matching. */
export function lookupGameOdds(store, homeTeam, awayTeam) {
  if (!store?.size || !homeTeam || !awayTeam) return null;
  const hn = normName(homeTeam);
  const an = normName(awayTeam);

  const direct = store.get(`${hn}|||${an}`);
  if (direct) return direct;

  // Fuzzy: check if any stored team name contains or is contained by the query
  for (const [key, val] of store) {
    const [kh, ka] = key.split("|||");
    const homeMatch = kh === hn || kh.includes(hn) || hn.includes(kh);
    const awayMatch = ka === an || ka.includes(an) || an.includes(ka);
    if (homeMatch && awayMatch) return val;
  }
  return null;
}

import { lookupColombianOdds } from "./colombian_odds.js";

function recomputeEdge(p, realOdds) {
  return Number(
    (clamp(Number(p.modelProb) || 0.5, 0.01, 0.99) - 1 / realOdds).toFixed(4)
  );
}

function favIsHome(p, homeRaw) {
  const favN  = normName(p.favorite || "");
  const homeN = normName(homeRaw);
  return favN === homeN || homeN.includes(favN) || favN.includes(homeN);
}

/**
 * Post-processing: prefiere cuotas promedio de casas colombianas; si no las
 * hay, cae a The Odds API (EU/UK). Recompone el edge con la cuota usada.
 *
 * coStoresBySport: { futbol: Map, baloncesto: Map, tenis: Map, beisbol: Map }
 *                  donde cada Map viene de buildColombianOddsStore.
 */
export function applyRealOddsToPickList(picks, oddsStore, coStoresBySport = {}) {
  for (const p of picks) {
    let realOdds = null;
    let realLine = null;
    let oddsSource = null;
    let bookmakerCount = 0;

    // 1) Casas colombianas (preferido)
    const coStore = coStoresBySport[p.sport];
    const coGame  = coStore ? lookupColombianOdds(coStore, p.homeTeam, p.awayTeam) : null;
    if (coGame) {
      bookmakerCount = coGame.books?.length || 0;
      const a = coGame.averaged;
      if (p.market === "moneyline" && a?.h2h) {
        realOdds = favIsHome(p, coGame.homeTeam) ? a.h2h.home : a.h2h.away;
      } else if (p.market === "totals" && a?.totals) {
        realOdds = p.over ? a.totals.over : a.totals.under;
        realLine = a.totals.line;
      }
      if (realOdds && realOdds > 1.01) oddsSource = "casas_colombia";
    }

    // 2) Fallback The Odds API (EU/UK)
    if (!realOdds && oddsStore?.size) {
      const gameOdds = lookupGameOdds(oddsStore, p.homeTeam, p.awayTeam);
      if (gameOdds) {
        if (p.market === "moneyline" && gameOdds.h2h) {
          realOdds = favIsHome(p, gameOdds.homeTeam) ? gameOdds.h2h.homeOdds : gameOdds.h2h.awayOdds;
        } else if (p.market === "totals" && gameOdds.totals) {
          realOdds = p.over ? gameOdds.totals.overOdds : gameOdds.totals.underOdds;
          realLine = gameOdds.totals.line;
        }
        if (realOdds && realOdds > 1.01) oddsSource = "the_odds_api";
      }
    }

    if (realOdds && realOdds > 1.01) {
      p.odds        = Number(realOdds.toFixed(2));
      p.edge        = recomputeEdge(p, realOdds);
      p.oddsSource  = oddsSource;
      p.realLine    = realLine;
      p.bookmakerCount = bookmakerCount || null;
    }
  }
}
