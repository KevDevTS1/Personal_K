/** Returns number of games from a record string like "10-5-3" or "12-8" */
export function gamesFromRecord(recordSummary) {
  const raw = String(recordSummary || "").trim();
  const m3 = raw.match(/(\d+)\s*[-–]\s*(\d+)\s*[-–]\s*(\d+)/);
  if (m3) return m3.slice(1,4).map(Number).reduce((a,b)=>a+b, 0);
  const m2 = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m2) return m2.slice(1,3).map(Number).reduce((a,b)=>a+b, 0);
  return 0;
}

/** True if record has at least `minGames` played */
export function hasRealRecord(recordSummary, minGames = 5) {
  return gamesFromRecord(recordSummary) >= minGames;
}

/** True if modelProb has meaningful signal (not near 50/50) */
export function hasSignal(modelProb, minDelta = 0.05) {
  return Math.abs(Number(modelProb) - 0.5) >= minDelta;
}
