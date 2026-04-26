// ─────────────────────────────────────────────────────────────────────────
// FUTBOL
// ─────────────────────────────────────────────────────────────────────────
//
// Ligas pedidas por el usuario:
//   - Ligas top: Liga MX, MLS, Premier, Serie A, Ligue 1, LaLiga,
//     Liga Portuguesa, Liga Colombiana, Liga Argentina.
//   - Ligas extra mantenidas por relevancia: Bundesliga (Alemania), Brasileirao.
//   - Internacionales: Libertadores, Sudamericana, Champions, Europa,
//     Conference, Mundial (FIFA World Cup), Mundial de Clubes (FIFA Club WC).
//   - Copas regionales/domesticas: FA Cup, Carabao Cup, Copa del Rey,
//     Coppa Italia, Coupe de France, Taca de Portugal, US Open Cup,
//     Copa BetPlay (Colombia), Copa Argentina, Concachampions.
// ─────────────────────────────────────────────────────────────────────────

export const SOCCER_LEAGUE_LABELS = {
  // Top domesticas
  "esp.1":                  "LaLiga",
  "eng.1":                  "Premier League",
  "ita.1":                  "Serie A",
  "fra.1":                  "Ligue 1",
  "ger.1":                  "Bundesliga",
  "por.1":                  "Liga Portugal",
  "usa.1":                  "MLS",
  "mex.1":                  "Liga MX",
  "col.1":                  "Primera A Colombia",
  "arg.1":                  "Liga Profesional Argentina",
  "bra.1":                  "Brasileirao Serie A",

  // Internacionales
  "uefa.champions":         "UEFA Champions League",
  "uefa.europa":            "UEFA Europa League",
  "uefa.europa.conf":       "UEFA Conference League",
  "fifa.world":             "Copa del Mundo",
  "fifa.cwc":               "Mundial de Clubes FIFA",
  "conmebol.libertadores":  "Copa Libertadores",
  "conmebol.sudamericana":  "Copa Sudamericana",
  "concacaf.champions_cup": "Concachampions",

  // Copas domesticas
  "eng.fa":                 "FA Cup",
  "eng.league_cup":         "Carabao Cup",
  "esp.copa_del_rey":       "Copa del Rey",
  "ita.coppa_italia":       "Coppa Italia",
  "fra.coupe_de_france":    "Coupe de France",
  "por.taca":               "Taca de Portugal",
  "usa.open":               "US Open Cup",
  "col.copa":               "Copa BetPlay",
  "arg.copa":               "Copa Argentina"
};

export const SOCCER_LEAGUES = Object.keys(SOCCER_LEAGUE_LABELS);

// Subgrupos utiles para el motor (priorizacion / xG / cuotas)
export const SOCCER_TIER1_LEAGUES = new Set([
  "esp.1", "eng.1", "ita.1", "fra.1", "ger.1"
]);

export const SOCCER_LATAM_LEAGUES = new Set([
  "mex.1", "col.1", "arg.1", "bra.1", "usa.1",
  "conmebol.libertadores", "conmebol.sudamericana",
  "concacaf.champions_cup", "col.copa", "arg.copa", "usa.open"
]);

// ─────────────────────────────────────────────────────────────────────────
// BALONCESTO — pedido por el usuario: NBA, WNBA, EuroLeague, ACB Espana
// ─────────────────────────────────────────────────────────────────────────

export const BASKET_LEAGUE_LABELS = {
  nba:          "NBA",
  wnba:         "WNBA",
  euroleague:   "EuroLeague",
  "spain.1":    "Liga ACB Espana"
};

export const BASKET_LEAGUES = Object.keys(BASKET_LEAGUE_LABELS);

// ─────────────────────────────────────────────────────────────────────────
// TENIS — solo tour principal (ATP / WTA)
// ─────────────────────────────────────────────────────────────────────────

export const TENNIS_LEAGUE_LABELS = {
  atp: "ATP Tour",
  wta: "WTA Tour"
};

export const TENNIS_LEAGUES = Object.keys(TENNIS_LEAGUE_LABELS);

// ─────────────────────────────────────────────────────────────────────────
// BEISBOL — MLB
// ─────────────────────────────────────────────────────────────────────────

export const BASEBALL_LEAGUE_LABELS = {
  mlb: "MLB"
};

export const BASEBALL_LEAGUES = Object.keys(BASEBALL_LEAGUE_LABELS);

// ─────────────────────────────────────────────────────────────────────────
// META
// ─────────────────────────────────────────────────────────────────────────

export const BOGOTA_TZ = "America/Bogota";

export function getLeagueDisplayName(feed) {
  const apiName = feed.data?.leagues?.[0]?.name;
  if (apiName) return apiName;
  if (feed.sport === "futbol")     return SOCCER_LEAGUE_LABELS[feed.league]    || feed.league;
  if (feed.sport === "baloncesto") return BASKET_LEAGUE_LABELS[feed.league]    || feed.league;
  if (feed.sport === "tenis")      return TENNIS_LEAGUE_LABELS[feed.league]    || feed.league;
  if (feed.sport === "beisbol")    return BASEBALL_LEAGUE_LABELS[feed.league]  || feed.league;
  return feed.league;
}
