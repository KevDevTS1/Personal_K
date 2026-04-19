import { clamp } from "../utils/math.js";

const ODDS_API_KEY = "3ca5dc0edf96e62bc4d12b4b397a56de";
const BASE = "https://api.the-odds-api.com/v4/sports";

// ESPN league slug → Odds API sport key
export const ESPN_TO_ODDS_SPORT = {
  "eng.1":                  "soccer_epl",
  "esp.1":                  "soccer_spain_la_liga",
  "ger.1":                  "soccer_germany_bundesliga",
  "ita.1":                  "soccer_italy_serie_a",
  "fra.1":                  "soccer_france_ligue_one",
  "ned.1":                  "soccer_netherlands_eredivisie",
  "por.1":                  "soccer_portugal_primeira_liga",
  "bel.1":                  "soccer_belgium_first_div",
  "tur.1":                  "soccer_turkey_super_league",
  "aut.1":                  "soccer_austria_bundesliga",
  "uefa.champions":         "soccer_uefa_champs_league",
  "uefa.europa":            "soccer_uefa_europa_league",
  "conmebol.libertadores":  "soccer_conmebol_copa_libertadores",
  "conmebol.sudamericana":  "soccer_conmebol_copa_sudamericana",
  "bra.1":                  "soccer_brazil_campeonato",
  "usa.1":                  "soccer_usa_mls",
  "mex.1":                  "soccer_mexico_ligamx",
  "col.1":                  "soccer_colombia_primera_a",
  "nba":                    "basketball_nba",
  "wnba":                   "basketball_wnba",
  "euroleague":             "basketball_euroleague",
  "mlb":                    "baseball_mlb",
};

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
  const cacheKey = `${dateKey}|${oddsKey}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  try {
    const url = `${BASE}/${oddsKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h,totals&oddsFormat=decimal`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`[OddsAPI] ${oddsKey}: HTTP ${res.status}`);
      _cache.set(cacheKey, []);
      return [];
    }
    const data = await res.json();
    const games = Array.isArray(data) ? data : [];
    console.log(`[OddsAPI] ${oddsKey}: ${games.length} juegos con cuotas reales`);
    _cache.set(cacheKey, games);
    return games;
  } catch (err) {
    console.warn(`[OddsAPI] ${oddsKey}: ${err.message}`);
    _cache.set(cacheKey, []);
    return [];
  }
}

/**
 * Builds an OddsStore Map from The Odds API for a set of active leagues.
 * Key: `${normHome}|||${normAway}`
 * Value: { homeTeam, awayTeam, h2h, totals }
 */
export async function buildOddsStore(activeLeagueSlugs, dateKey) {
  const sportKeys = [...new Set(
    activeLeagueSlugs.map(s => ESPN_TO_ODDS_SPORT[s]).filter(Boolean)
  )];

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

/**
 * Post-processing: replaces synthetic odds with real bookmaker odds for
 * moneyline and totals picks. Recomputes edge with real market odds.
 */
export function applyRealOddsToPickList(picks, oddsStore) {
  if (!oddsStore?.size) return;

  for (const p of picks) {
    const gameOdds = lookupGameOdds(oddsStore, p.homeTeam, p.awayTeam);
    if (!gameOdds) continue;

    let realOdds = null;

    if (p.market === "moneyline" && gameOdds.h2h) {
      const favN = normName(p.favorite || "");
      const homeN = normName(gameOdds.homeTeam);
      const favIsHome = favN === homeN || homeN.includes(favN) || favN.includes(homeN);
      realOdds = favIsHome ? gameOdds.h2h.homeOdds : gameOdds.h2h.awayOdds;
    } else if (p.market === "totals" && gameOdds.totals) {
      realOdds = p.over ? gameOdds.totals.overOdds : gameOdds.totals.underOdds;
    }

    if (realOdds && realOdds > 1.01) {
      p.odds = Number(realOdds.toFixed(2));
      p.edge = Number((clamp(Number(p.modelProb) || 0.5, 0.01, 0.99) - 1 / realOdds).toFixed(4));
      p.oddsSource = "the_odds_api";
      p.realLine = gameOdds.totals?.line ?? null;
    }
  }
}
