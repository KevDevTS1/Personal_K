import { getUnderstatMatchStats, isUnderstatLeague } from "./understat.js";
import {
  getApiFootballTeamForm,
  isApiFootballSupported,
  isApiFootballConfigured,
  apiFootballQuotaAllowsMatchHint
} from "./apifootball.js";
import { normalizeTeamName } from "../utils/event.js";

/**
 * Understat (Top 5 EU) y/o API-Football (MLS, MX, CONMEBOL, etc.) para enriquecer
 * la proyección de goles antes de analyzeSoccerEvent.
 */
export async function fetchSoccerExternalHint(leagueSlug, homeComp, awayComp) {
  if (!homeComp || !awayComp) return null;
  const homeN = normalizeTeamName(homeComp);
  const awayN = normalizeTeamName(awayComp);
  const hint = {};

  const understatLeague = isUnderstatLeague(leagueSlug);
  if (understatLeague) {
    const u = await getUnderstatMatchStats(leagueSlug, homeN, awayN).catch(() => null);
    if (u?.home && u?.away) hint.understat = u;
  }

  const tryApi =
    isApiFootballSupported(leagueSlug) &&
    isApiFootballConfigured() &&
    apiFootballQuotaAllowsMatchHint() &&
    (!understatLeague || !hint.understat);

  if (tryApi) {
    const [hf, af] = await Promise.all([
      getApiFootballTeamForm(leagueSlug, homeN).catch(() => null),
      getApiFootballTeamForm(leagueSlug, awayN).catch(() => null)
    ]);
    if (hf && af) hint.apiFoot = { home: hf, away: af };
  }

  return Object.keys(hint).length ? hint : null;
}
