export async function fetchSportsDbEvents(dateISO, sportName) {
  const url = `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${dateISO}&s=${encodeURIComponent(sportName)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TheSportsDB ${sportName}: ${response.status}`);
  return response.json();
}

export function normalizeSportDbSport(sportName) {
  if (sportName === "Soccer") return "futbol";
  if (sportName === "Basketball") return "baloncesto";
  if (sportName === "Tennis") return "tenis";
  if (sportName === "Baseball") return "beisbol";
  return "futbol";
}
