import { clamp } from "../utils/math.js";

/**
 * Maps ESPN leaders category names → internal field names.
 * Each entry: [espnName, fieldName, sigma]
 */
const ESPN_CAT_MAP = {
  pointsPerGame:                  "pts",
  reboundsPerGame:                "reb",
  assistsPerGame:                 "ast",
  stealsPerGame:                  "stl",
  blocksPerGame:                  "blk",
  threePointFieldGoalsPerGame:    "tpm",
  fieldGoalPct:                   "fgPct",
  freeThrowPct:                   "ftPct",
  minutesPerGame:                 "mpg",
  turnoversPerGame:               "tov",
  offensiveReboundsPerGame:       "oreb",
  defensiveReboundsPerGame:       "dreb",
  fieldGoalsAttemptedPerGame:     "fga",
  freeThrowsAttemptedPerGame:     "fta",
  pointsPerGameRank:              null, // skip rank fields
};

/**
 * Extract all NBA players with their season averages from an ESPN summary object.
 * Returns Map<playerDisplayName, PlayerStat>
 */
export function extractNbaPlayers(summary) {
  if (!summary?.leaders?.length) return new Map();

  const players = new Map(); // displayName → stat object

  for (const teamBlock of summary.leaders) {
    const teamId   = teamBlock.team?.id   ?? null;
    const teamName = teamBlock.team?.displayName || teamBlock.team?.name || "";

    for (const catBlock of teamBlock.leaders || []) {
      const field = ESPN_CAT_MAP[catBlock.name];
      if (!field) continue;

      // Take up to top 4 leaders per stat category
      const entries = Array.isArray(catBlock.leaders) ? catBlock.leaders.slice(0, 4) : [];
      for (const entry of entries) {
        const name = entry.athlete?.displayName;
        if (!name) continue;

        let val = Number(entry.value);
        if (!Number.isFinite(val)) {
          val = parseFloat(String(entry.displayValue || "").replace(/[^0-9.]/g, ""));
        }
        if (!Number.isFinite(val) || val < 0) continue;

        if (!players.has(name)) {
          players.set(name, {
            name,
            shortName: entry.athlete?.shortName || name,
            teamId, teamName,
            pts: null, reb: null, ast: null, stl: null, blk: null,
            tpm: null, fgPct: null, ftPct: null, mpg: null,
            tov: null, oreb: null, dreb: null, fga: null, fta: null,
          });
        }
        const p = players.get(name);
        // Only overwrite if this is a better (closer to #1) reading
        if (p[field] === null) p[field] = val;
      }
    }
  }

  return players;
}

/**
 * Defense quality multiplier for a player's scoring projection.
 * opponentWR: opponent's season win rate (0..1)
 * Returns a multiplier: < 1 means expect less (tough defense), > 1 means expect more.
 */
export function defenseAdjustment(opponentWR) {
  const diff = clamp(Number(opponentWR) || 0.5, 0.1, 0.9) - 0.5;
  // Scale: 0.3 diff → ±8% adjustment
  return clamp(1 - diff * 0.27, 0.86, 1.14);
}

/**
 * Pace multiplier: fast-paced games (high combined PPG) inflate all scoring props.
 * sumTeamPpg: sum of both teams' PPG averages
 */
export function paceMultiplier(sumTeamPpg) {
  const base = 220; // league average combined PPG
  const diff = clamp((Number(sumTeamPpg) || base) - base, -20, 20);
  return clamp(1 + diff * 0.004, 0.92, 1.08);
}

/**
 * Filters players to those with enough data to generate meaningful props.
 * Returns players sorted by "star" score (pts desc).
 */
export function rankPlayers(playerMap) {
  return [...playerMap.values()]
    .filter(p => p.pts !== null || p.reb !== null || p.ast !== null)
    .sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0));
}
