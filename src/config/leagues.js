export const SOCCER_LEAGUES = [
  "esp.1", "eng.1", "ger.1", "ita.1", "fra.1", "ned.1", "por.1", "bel.1",
  "tur.1", "aut.1", "uefa.champions", "uefa.europa", "conmebol.libertadores",
  "usa.1", "mex.1", "col.1"
];

export const SOCCER_LEAGUE_LABELS = {
  "esp.1": "LaLiga", "eng.1": "Premier League", "ger.1": "Bundesliga",
  "ita.1": "Serie A", "fra.1": "Ligue 1", "ned.1": "Eredivisie",
  "por.1": "Liga Portugal", "bel.1": "Pro League Belgica", "tur.1": "Super Lig",
  "aut.1": "Bundesliga Austria", "uefa.champions": "UEFA Champions League",
  "uefa.europa": "UEFA Europa League", "conmebol.libertadores": "Copa Libertadores",
  "usa.1": "MLS", "mex.1": "Liga MX", "col.1": "Primera A Colombia"
};

export const BASKET_LEAGUE_LABELS = {
  nba: "NBA", wnba: "WNBA", "mens-college-basketball": "NCAA Basketball",
  euroleague: "EuroLeague", "spain.1": "ACB España", "germany.bbl": "BBL Alemania", "france.pro.a": "Pro A Francia"
};

export const TENNIS_LEAGUE_LABELS = { atp: "ATP", wta: "WTA" };
export const BASEBALL_LEAGUE_LABELS = { mlb: "MLB" };

export const BASKET_LEAGUES = [
  "nba", "wnba", "mens-college-basketball",
  "euroleague", "spain.1", "germany.bbl", "france.pro.a"
];
export const TENNIS_LEAGUES = ["atp", "wta"];
export const BASEBALL_LEAGUES = ["mlb"];
export const SPORTSDB_SPORTS = ["Soccer", "Basketball", "Tennis", "Baseball"];
export const BOGOTA_TZ = "America/Bogota";

export function getLeagueDisplayName(feed) {
  const apiName = feed.data?.leagues?.[0]?.name;
  if (apiName) return apiName;
  if (feed.sport === "futbol") return SOCCER_LEAGUE_LABELS[feed.league] || feed.league;
  if (feed.sport === "baloncesto") return BASKET_LEAGUE_LABELS[feed.league] || feed.league;
  if (feed.sport === "tenis") return TENNIS_LEAGUE_LABELS[feed.league] || feed.league;
  if (feed.sport === "beisbol") return BASEBALL_LEAGUE_LABELS[feed.league] || feed.league;
  return feed.league;
}
