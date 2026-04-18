import { clamp, pct, logistic } from "../utils/math.js";

const MARGIN = 0.055; // margen de la casa (~5.5% vig)

/** Cuota decimal a partir de probabilidad del modelo. */
export function oddsFromProbability(prob, margin = MARGIN) {
  const p = clamp(Number(prob) || 0.5, 0.03, 0.97);
  return Number((1 / (p * (1 + margin))).toFixed(2));
}

/** Probabilidad implícita de la cuota (sin margen de vig). */
export function impliedProb(decimalOdds) {
  return 1 / Math.max(1.01, Number(decimalOdds) || 1.85);
}

/**
 * Edge de valor: diferencia entre probabilidad del modelo y probabilidad implícita de mercado.
 * Edge > 0 → modelo piensa que hay valor sobre la cuota ofrecida.
 * Edge > 0.04 es el umbral mínimo recomendado para apostar.
 */
export function computeEdge(modelProb, decimalOdds) {
  return Number((clamp(modelProb, 0.01, 0.99) - impliedProb(decimalOdds)).toFixed(4));
}

/**
 * Confianza (38–90%) puramente desde la probabilidad del modelo.
 * Sin jitter aleatorio: mismos datos → misma confianza.
 * Fórmula: strength lineal alrededor de 0.5
 *   p=0.50 → 50%, p=0.60 → 70%, p=0.70 → 90%
 */
export function confidenceFromProbability(prob, minPct = 48, maxPct = 90) {
  const p = clamp(Number(prob) || 0.5, 0.03, 0.97);
  const chosen = Math.max(p, 1 - p); // lado más fuerte
  const strength = 50 + (chosen - 0.5) * 200;
  return pct(strength, minPct, maxPct);
}

/** Confianza para combinada: promedio ponderado con descuento de correlación. */
export function confidenceFromCombo(p1, p2) {
  const c1 = Math.max(p1, 1 - p1);
  const c2 = Math.max(p2, 1 - p2);
  const minC = Math.min(c1, c2);
  const str = (c) => 50 + (c - 0.5) * 200;
  const synergy = 20 + Math.max(0, minC - 0.55) * 80;
  const raw = (str(c1) + str(c2)) / 2 - 5 + synergy;
  return pct(raw, 76, 90);
}

/**
 * Probabilidad de victoria en tenis basada en diferencia de ranking.
 * Usa función logística: mayor brecha → mayor ventaja.
 * delta = rank_rival - rank_favorito (positivo si el jugador 1 es mejor)
 */
export function tennisProbFromRanks(rank1, rank2) {
  const delta = (rank2 - rank1); // positivo → p1 mejor
  return clamp(logistic(delta * 0.015), 0.22, 0.88);
}

/**
 * Probabilidad de victoria desde record de victorias/derrotas.
 * Usa win% ajustado con home field advantage para el local (+3%).
 */
export function winProbFromRecords(homeWR, awayWR, homeField = 0.03) {
  const diff = (homeWR - awayWR) * 0.8; // atenúa la señal
  return clamp(0.5 + diff + homeField, 0.15, 0.85);
}

/**
 * Línea de libro (nearest 0.5) desde un promedio real.
 */
export function bookHalfLine(avg) {
  const a = Number(avg);
  if (!Number.isFinite(a) || a <= 0) return "0.5";
  return String(Math.round(a * 2) / 2);
}

/** Cuotas de referencia para casas colombianas con spread mínimo de mercado. */
const CO_BOOKMAKERS = [
  { name: "Wplay",    offset: -0.04 },
  { name: "Rushbet",  offset:  0.02 },
  { name: "Betsson",  offset: -0.01 },
  { name: "Sportium", offset:  0.05 },
  { name: "Yajuego",  offset: -0.03 }
];

export function colombianBookmakerOdds(baseDecimal) {
  return CO_BOOKMAKERS.map((b) => ({
    bookmaker: b.name,
    odds: Number(Math.max(1.01, baseDecimal + b.offset).toFixed(2))
  }));
}
