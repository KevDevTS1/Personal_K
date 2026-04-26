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

/**
 * Recomendacion de stake para el bettor colombiano.
 *
 * Filosofia (post-feedback usuario): SIEMPRE devolvemos una recomendacion
 * de stake; nunca decimos "no apostar". El usuario quiere ver una sugerencia
 * concreta y decidir el mismo si el edge le convence o no.
 *
 * Logica:
 *  - Edge positivo: cuarto-Kelly clasico (riesgo bajo, valor matematico).
 *  - Edge cero o negativo: stake conservador basado en la conviccion del
 *    modelo (max(p, 1-p)). Etiqueta "Mínima" o "Baja" para que sepas que
 *    la cuota no tiene valor de mercado pero el modelo cree en el lado.
 *
 * Rangos COP (sobre bankroll mensual default 200.000):
 *   Mínima  5.000     conviccion baja o sin valor
 *   Baja   10.000     señal clara pero edge debil/negativo
 *   Media  20.000     edge positivo + conviccion solida
 *   Alta   35.000     edge fuerte (>=8%) + alta conviccion
 *   Top    50.000     tope absoluto
 */
export function kellyStakeCOP(modelProb, decimalOdds, bankroll = 200000) {
  const p     = clamp(Number(modelProb) || 0.5, 0.01, 0.99);
  const odds  = Math.max(1.01, Number(decimalOdds) || 1.85);
  const b     = odds - 1;
  const q     = 1 - p;
  const fullKelly  = (b * p - q) / b;
  const conviction = Math.max(p, 1 - p);   // 0.5..0.97
  const edge       = p - 1 / odds;         // mismo calculo que computeEdge

  let raw;     // % del bankroll a apostar
  let basis;   // de donde viene el numero (info para el advice)

  if (fullKelly > 0) {
    // Cuarto-Kelly clasico cuando hay valor matematico
    raw   = fullKelly * 0.25;
    basis = "kelly";
  } else {
    // Sin valor de mercado: stake derivado de conviccion (1%..3% del bankroll)
    // segun que tan lejos de 50/50 esta la probabilidad.
    raw   = clamp((conviction - 0.5) * 0.06 + 0.005, 0.005, 0.030);
    basis = "convicción";
  }

  // Redondeo a multiplos de 5.000 COP, piso 5.000, techo 50.000
  const rawCOP = raw * bankroll;
  const stake  = clamp(Math.round(rawCOP / 5000) * 5000, 5000, 50000);

  let label;
  if (stake >= 35000)      label = "Alta";
  else if (stake >= 20000) label = "Media";
  else if (stake >= 10000) label = "Baja";
  else                     label = "Mínima";

  const edgePct = (edge * 100).toFixed(1);
  let advice;
  if (basis === "kelly") {
    advice = `Recomendado: $${stake.toLocaleString("es-CO")} COP. Edge ${edgePct}% positivo (¼-Kelly).`;
  } else if (edge >= 0) {
    advice = `Recomendado: $${stake.toLocaleString("es-CO")} COP. Edge neutro: stake bajo por convicción del modelo.`;
  } else {
    advice = `Recomendado: $${stake.toLocaleString("es-CO")} COP. La cuota tiene mejor margen para la casa (edge ${edgePct}%); apuesta solo el mínimo si confías en la lectura.`;
  }

  return {
    stake,
    label,
    advice,
    edgePct: Number(edgePct),
    kellyPct: Number((Math.max(0, fullKelly) * 25).toFixed(1)),  // % del bankroll si Kelly fuera positivo
    basis
  };
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

// ──────────────────────────────────────────────────────────────────────────
// Score unificado 0-100 (Tarea 5)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Calcula calidad de datos (0..1) a partir de banderas reales del pick.
 * Sube la base para reflejar que ESPN ya provee marcadores, records y
 * (en muchos casos) summary con leaders/lesiones; suma extras por cada
 * fuente especializada confirmada.
 */
export function dataQualityFromPick(pick) {
  let q = 0.32; // base ESPN scoreboard + summary

  if (pick.hasCoOdds) q += 0.22;
  else if (pick.hasEuOdds) q += 0.16;

  if (pick.oddsSource === "casas_colombia") q += 0.05;
  if (pick.oddsSource === "the_odds_api")    q += 0.03;
  if (pick.bookmakerCount >= 3) q += 0.05;

  if (pick.argumentWords && pick.argumentWords >= 500
      && pick.argumentModel && !pick.argumentModel.startsWith("fallback")
      && pick.argumentModel !== "live-context") {
    q += 0.10;
  }

  // Mercados con más datos derivados (props, team totals)
  if (pick.market === "player_props" || pick.market === "team_totals") q += 0.04;

  // Banderas de fuentes especializadas, si el pipeline las añade en el futuro
  if (pick.hasUnderstat)   q += 0.06;
  if (pick.hasMlbStats)    q += 0.06;
  if (pick.hasBalldontlie) q += 0.05;
  if (pick.hasApiFootball) q += 0.04;
  if (pick.hasWeather)     q += 0.03;
  if (pick.hasInjuries)    q += 0.04;
  if (pick.hasStandings)   q += 0.03;
  if (pick.hasRecentForm)  q += 0.05;
  if (pick.hasOfficialStandings) q += 0.05;
  if (pick.hasPitcherMatchup) q += 0.04;
  if (pick.hasBalldontlie) q += 0.04;
  if (pick.hasSofascore) q += 0.05;
  if (pick.hasClubElo) q += 0.04;

  // Convicción modesta: si el modelo se aleja de 50/50, la señal es real
  if (Number.isFinite(pick.modelProb) && Math.abs(pick.modelProb - 0.5) >= 0.08) q += 0.03;

  return clamp(Number(q.toFixed(3)), 0, 1);
}

/**
 * Score unificado 0-100. Adapta los pesos según haya o no cuota real:
 *
 *  Sin cuota real (edge no es confiable):
 *    score = convicción * 0.65 + dataQuality * 0.35
 *
 *  Con cuota real (CO o EU):
 *    edgeScore centrado en 50 (edge=0 → 50pts, edge=+5% → 100pts,
 *    edge=-5% → 0pts) para no premiar demasiado situaciones marginales.
 *    score = convicción * 0.45 + edgeScore * 0.30 + dataQuality * 0.25
 */
export function pickScore({ modelProb, edge = 0, dataQuality = 0.5, hasRealOdds = false }) {
  const p = clamp(Number(modelProb) || 0.5, 0.03, 0.97);
  const conviction = Math.max(p, 1 - p);                          // 0.5..0.97
  const convScore  = clamp((conviction - 0.5) / 0.45, 0, 1) * 100; // 0..100
  const dqScore    = clamp(Number(dataQuality) || 0, 0, 1) * 100;

  if (!hasRealOdds) {
    const score = convScore * 0.65 + dqScore * 0.35;
    return clamp(Math.round(score), 0, 100);
  }

  // edge = -0.05 → 0pts ; 0 → 50pts ; +0.05 → 100pts
  const edgeScore = clamp(50 + (Number(edge) || 0) * 1000, 0, 100);
  const score     = convScore * 0.45 + edgeScore * 0.30 + dqScore * 0.25;
  return clamp(Math.round(score), 0, 100);
}

/**
 * Etiqueta cualitativa segun el score:
 *   80+  Pick élite
 *   65+  Pick fuerte
 *   50+  Pick razonable
 *   <50  Pick especulativo
 */
export function scoreTier(score) {
  const s = Number(score) || 0;
  if (s >= 80) return { label: "Pick élite", tone: "elite" };
  if (s >= 65) return { label: "Pick fuerte", tone: "fuerte" };
  if (s >= 50) return { label: "Pick razonable", tone: "razonable" };
  return { label: "Pick especulativo", tone: "especulativo" };
}

/**
 * Texto corto para el usuario sobre el contexto del mercado/cuota.
 */
export function buildMarketNote(pick) {
  const src = pick.oddsSource === "casas_colombia"
    ? `Cuota promedio CO (${pick.bookmakerCount || "≥1"} casas)`
    : pick.oddsSource === "the_odds_api"
      ? "Cuota mercado EU/UK (The Odds API)"
      : "Cuota estimada por el modelo";
  const line = pick.realLine != null ? ` · línea ${pick.realLine}` : "";
  const edgeTxt = Number.isFinite(pick.edge)
    ? ` · edge ${(pick.edge * 100).toFixed(1)}%`
    : "";
  return `${src}${line}${edgeTxt}`;
}

