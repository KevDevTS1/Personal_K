import { colombianBookmakerOdds } from "../model/scoring.js";

const MARKET_LABELS = {
  moneyline: "Ganador del partido",
  totals: "Totales (Over/Under)",
  spread: "Spread / Handicap",
  corners: "Corners",
  handicap: "Handicap asiático",
  player_props: "Prop jugador / equipo",
  combo_same_game: "Combinada mismo partido",
  btts: "Ambos anotan (BTTS)",
  cards: "Tarjetas",
  team_totals: "Total goles por equipo",
  first_half: "Totales 1.er tiempo / mitad",
  "3PM": "Triples anotados (NBA)",
  "carreras equipo": "Carreras del equipo (MLB)",
  "dobles (bateador)": "Dobles (bateador MLB)",
  "rbi (bateador)": "RBI (bateador MLB)"
};

export function humanMarketLabel(market) {
  return MARKET_LABELS[market] || market;
}

export function enrichPick(p) {
  const base = typeof p.odds === "number" ? p.odds : 1.85;
  const playerName = p.playerName ?? p.player ?? null;
  const lineLabel = p.lineLabel ?? (p.line != null && p.line !== "" ? String(p.line) : null);
  const statLabel = p.statLabel ?? p.stat ?? null;
  const sideLabel = p.sideLabel ?? (typeof p.over === "boolean" ? (p.over ? "Over" : "Under") : null);
  return {
    ...p,
    marketLabel: p.marketLabel || humanMarketLabel(p.market),
    playerName,
    lineLabel,
    statLabel,
    sideLabel,
    propType: p.propType ?? (p.market === "player_props"
      ? ((/equipo/i.test(String(statLabel || ""))) || p.teamLabel ? "team" : "player")
      : null),
    bookmakerOdds: colombianBookmakerOdds(base),
    oddsSource: "referencia_mercado_co",
    oddsNote: "Cuotas de referencia para operadores en CO; confirma en la casa antes de apostar."
  };
}
