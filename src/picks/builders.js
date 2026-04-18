export function buildMoneylinePick({ sport, league, eventName, favorite, underdog, confidence, argument, eventDateUtc, odds, modelProb, edge }) {
  return {
    sport, league,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "moneyline",
    marketLabel: "Ganador",
    selection: `${favorite} gana`,
    odds, confidence, modelProb, edge,
    argument: `${argument} Favorito: ${favorite} vs ${underdog}.`
  };
}

export function buildTotalsPick({ sport, league, eventName, line, over, confidence, argument, eventDateUtc, odds, modelProb, edge }) {
  return {
    sport, league,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "totals",
    marketLabel: "Totales",
    lineLabel: String(line),
    sideLabel: over ? "Más de" : "Menos de",
    selection: `${over ? "Más de" : "Menos de"} ${line}`,
    odds, confidence, modelProb, edge,
    argument
  };
}

export function buildPropPick({
  sport, league, eventName, player, stat, line, over, confidence, argument,
  eventDateUtc, propType = "player", teamLabel = null, odds, modelProb, edge
}) {
  const lineStr = String(line);
  const side = over ? "Over" : "Under";
  return {
    sport, league,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "player_props",
    marketLabel: propType === "team" ? "Prop de equipo" : "Prop de jugador",
    playerName: propType === "team" ? null : player,
    teamLabel: propType === "team" ? (teamLabel || player) : teamLabel,
    statLabel: stat,
    lineLabel: lineStr,
    sideLabel: side,
    propType,
    selection: `${player} ${over ? "más de" : "menos de"} ${lineStr} ${stat}`,
    odds, confidence, modelProb, edge,
    argument
  };
}
