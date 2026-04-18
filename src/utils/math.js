export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function pct(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Aproximación CDF Normal (Abramowitz/Stegun). */
export function normalCdf(x, mean, sd) {
  if (!Number.isFinite(x) || !Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) return 0.5;
  const z = (x - mean) / sd;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-(z * z) / 2);
  const prob = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? prob : 1 - prob;
}

/** Función logística para convertir diferencia en probabilidad. */
export function logistic(x, k = 1) {
  return 1 / (1 + Math.exp(-k * x));
}

export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
