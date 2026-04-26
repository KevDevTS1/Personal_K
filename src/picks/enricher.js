import { colombianBookmakerOdds, kellyStakeCOP, dataQualityFromPick, pickScore, scoreTier, buildMarketNote } from "../model/scoring.js";
import { humanMarketLabel } from "../config/markets.js";

export { humanMarketLabel };

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
    oddsSource: p.oddsSource || "referencia_mercado_co",
    oddsNote: "Cuotas de referencia para operadores en CO; confirma en la casa antes de apostar.",
    stake: kellyStakeCOP(p.modelProb, base)
  };
}

/**
 * Aplica el score unificado 0-100 y la etiqueta cualitativa.
 * Se invoca DESPUES de enrichPick + applyRealOddsToPickList + attachLongArguments,
 * para que dataQualityFromPick lea las banderas finales.
 */
export function attachScores(picks) {
  for (const p of picks) {
    const dataQuality = dataQualityFromPick(p);
    const hasRealOdds = p.oddsSource === "casas_colombia" || p.oddsSource === "the_odds_api";
    const score = pickScore({
      modelProb:   p.modelProb,
      edge:        p.edge,
      dataQuality,
      hasRealOdds
    });
    const tier = scoreTier(score);
    p.score          = score;
    p.scoreLabel     = tier.label;
    p.scoreTone      = tier.tone;
    p.dataQuality    = dataQuality;
    p.marketNote     = buildMarketNote(p);
  }
}
