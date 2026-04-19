import { clamp, normalCdf } from "../utils/math.js";
import { getCalibrationStats } from "./calibration.js";

/**
 * Sigmas base por deporte+stat derivados de datos históricos de liga.
 * Representan la desviación estándar típica por partido de cada métrica.
 */
const SIGMA_TABLE = {
  "baloncesto|puntos": 6.5,
  "baloncesto|rebotes": 2.8,
  "baloncesto|asistencias": 2.3,
  "baloncesto|triples": 1.2,
  "baloncesto|robos": 0.85,
  "baloncesto|tapones": 0.75,
  "baloncesto|triples anotados": 0.95,
  "baloncesto|puntos 1er tiempo": 9.2,
  "baloncesto|puntos más rebotes más asistencias": 8.5,
  "baloncesto|asistencias del equipo": 4.1,
  "futbol|goles partido": 1.35,
  "futbol|goles (jugador)": 0.42,
  "futbol|asistencias (jugador)": 0.35,
  "futbol|tiros de esquina partido": 2.35,
  "futbol|tarjetas amarillas partido": 1.65,
  "futbol|tiros (jugador)": 0.55,
  "futbol|goles en el primer tiempo partido": 0.68,
  "futbol|goles del equipo local": 0.45,
  "beisbol|golpes de hit del equipo": 1.9,
  "beisbol|ponches del lanzador": 1.8,
  "beisbol|carreras del equipo": 1.45,
  "beisbol|dobles del bateador": 0.55,
  "beisbol|carreras impulsadas": 0.62,
  "beisbol|bases totales": 1.15,
  "beisbol|hits más carreras más impulsadas": 1.25,
  "beisbol|carreras anotadas": 0.32
};

function baseSigma(sport, stat) {
  const key = `${sport}|${String(stat || "").toLowerCase()}`;
  return SIGMA_TABLE[key] ?? null;
}

/**
 * Estima P(over) y P(under) dada la media del jugador/equipo y la línea.
 * Usa calibración histórica si está disponible (blending 70% actual / 30% histórico).
 */
export function estimatePropProbabilities({ mean, line, sport, stat, leagueSlug = null, calibrationStore = null }) {
  const m = Number(mean);
  const l = Number(line);
  if (!Number.isFinite(m) || !Number.isFinite(l) || m <= 0 || l <= 0) {
    return { pOver: 0.5, pUnder: 0.5 };
  }

  const cal = calibrationStore ? getCalibrationStats(calibrationStore, { sport, leagueSlug, stat }) : null;
  const bs = baseSigma(sport, stat) ?? Math.max(1.2, m * 0.24);

  let effMean = m;
  let effSd = bs;

  if (cal) {
    // Blend: más peso al dato actual (70%) que al histórico de la liga (30%)
    effMean = m * 0.7 + cal.mean * 0.3;
    // Sigma efectiva: calibrada para la liga + base del tipo de stat
    effSd = clamp(bs * 0.55 + cal.sd * 0.45, 0.8, 14);
  }

  const pUnder = normalCdf(l, effMean, effSd);
  const pOver = clamp(1 - pUnder, 0.03, 0.97);
  return { pOver, pUnder: clamp(1 - pOver, 0.03, 0.97) };
}
