export function normalizeTeamName(comp) {
  return comp?.team?.shortDisplayName || comp?.team?.displayName
    || comp?.athlete?.shortName || comp?.athlete?.displayName || "Equipo";
}

export function extractCompetitorPlayers(comp) {
  const names = [];
  if (comp?.athlete?.displayName) names.push(comp.athlete.displayName);
  if (comp?.athlete?.shortName) names.push(comp.athlete.shortName);
  for (const group of comp?.leaders || []) {
    for (const entry of group?.leaders || []) {
      if (entry?.athlete?.displayName) names.push(entry.athlete.displayName);
      if (entry?.athlete?.shortName) names.push(entry.athlete.shortName);
    }
  }
  return [...new Set(names.filter(Boolean))];
}

export function pickPlayerName(event, preferredTeamName, fallbackText) {
  const competitors = event?.competitions?.[0]?.competitors || [];
  const preferred = competitors.find((c) => normalizeTeamName(c) === preferredTeamName) || competitors[0];
  const fromPreferred = extractCompetitorPlayers(preferred);
  if (fromPreferred.length) return fromPreferred[0];
  for (const c of competitors) {
    const names = extractCompetitorPlayers(c);
    if (names.length) return names[0];
  }
  return fallbackText;
}

export function eventKey(ev) {
  return String(ev?.id ?? ev?.uid ?? ev?.name ?? "sin-id");
}

export function pickSeed(dateKey, event, suffix) {
  return `${dateKey}|${eventKey(event)}|${suffix}`;
}

export function isEventLive(event) {
  const state = String(event?.competitions?.[0]?.status?.type?.state || "").toLowerCase();
  const completed = Boolean(event?.competitions?.[0]?.status?.type?.completed);
  return !completed && (state === "in" || state === "in_progress" || state === "live");
}

export function getLiveStatusLabel(event) {
  const comp = event?.competitions?.[0];
  const detail = comp?.status?.type?.detail || comp?.status?.type?.shortDetail || comp?.status?.type?.description;
  const clock = comp?.status?.displayClock || comp?.status?.clock;
  const period = comp?.status?.period;
  if (detail) return String(detail);
  if (clock && period != null) return `${clock} | P${period}`;
  if (clock) return String(clock);
  return "En vivo";
}
