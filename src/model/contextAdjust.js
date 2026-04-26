// Ajustes contextuales: tras enriquecer el pick (clima, lesiones, tabla
// oficial, forma reciente, home/away records) modificamos `modelProb` para
// que las predicciones reflejen el contexto real del partido en lugar de
// solo el promedio de ligas.
//
// Cada ajuste es pequeño (±2-6 puntos porcentuales) para no romper el modelo
// base, pero acumulados pueden empujar un pick borderline a un tier mayor o
// descartarlo del todo.

import { clamp } from "../utils/math.js";
import { computeEdge } from "./scoring.js";

// Top of utils
const PCT = (n) => `${(n * 100).toFixed(1)}%`;

function pushReason(pick, txt) {
  pick.contextReasons = pick.contextReasons || [];
  pick.contextReasons.push(txt);
}

function deltaProb(pick, delta, why) {
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.005) return;
  const before = Number(pick.modelProb) || 0.5;
  const after = clamp(before + delta, 0.04, 0.96);
  pick.modelProb = after;
  if (Number.isFinite(pick.odds)) pick.edge = computeEdge(after, pick.odds);
  pushReason(pick, `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp ${why} (${PCT(before)} → ${PCT(after)})`);
}

// ─── 1. Clima (futbol, beisbol al aire libre) ────────────────────────────

function adjustWeather(pick) {
  if (!pick.weather) return;
  const w = pick.weather;

  // Futbol: lluvia y viento bajan goles y suben tarjetas/corners
  if (pick.sport === "futbol") {
    if (pick.market === "totals" || pick.market === "goals_total") {
      // Si el pick es UNDER, lluvia/viento favorece. Si es OVER, perjudica.
      const isOver = String(pick.sideLabel || "").toLowerCase().includes("más");
      if (w.flags?.lluvia)  deltaProb(pick, isOver ? -0.04 : +0.04, "lluvia (suele bajar goles)");
      if (w.flags?.viento)  deltaProb(pick, isOver ? -0.02 : +0.02, "viento >25km/h");
      if (w.flags?.frio)    deltaProb(pick, isOver ? -0.015 : +0.015, "frío extremo (≤6°C)");
    }
    if (pick.market === "corners") {
      const isOver = String(pick.sideLabel || "").toLowerCase().includes("más");
      if (w.flags?.lluvia)  deltaProb(pick, isOver ? -0.025 : +0.025, "lluvia reduce corners");
      if (w.flags?.viento)  deltaProb(pick, isOver ? +0.02 : -0.02, "viento sube errores → más corners");
    }
    if (pick.market === "cards") {
      const isOver = String(pick.sideLabel || "").toLowerCase().includes("más");
      if (w.flags?.lluvia)  deltaProb(pick, isOver ? +0.02 : -0.02, "lluvia → más faltas/tarjetas");
    }
  }

  // Beisbol: viento sube/baja runs según dirección (no tenemos dirección, conservador)
  if (pick.sport === "beisbol") {
    if (pick.market === "totals" || pick.market === "runs_total") {
      const isOver = String(pick.sideLabel || "").toLowerCase().includes("más");
      if (w.flags?.lluvia)  deltaProb(pick, isOver ? -0.05 : +0.05, "lluvia (suspende, baja runs)");
      if (w.flags?.calor)   deltaProb(pick, isOver ? +0.025 : -0.025, "calor (la pelota viaja más)");
      if (w.flags?.frio)    deltaProb(pick, isOver ? -0.025 : +0.025, "frío (la pelota muere)");
      if (w.flags?.viento)  deltaProb(pick, isOver ? -0.02 : +0.02, "viento fuerte (varianza)");
    }
  }
}

// ─── 2. Lesiones (todas las disciplinas) ─────────────────────────────────

function teamSideOfPick(pick) {
  // ML: side ganador conocido. Otros: usamos `selection` como heurística.
  const sel = String(pick.selection || pick.sideLabel || "").toLowerCase();
  const home = String(pick.homeTeam || "").toLowerCase();
  const away = String(pick.awayTeam || "").toLowerCase();
  if (home && sel.includes(home)) return "home";
  if (away && sel.includes(away)) return "away";
  return null;
}

function adjustInjuries(pick) {
  if (!pick.injuries) return;
  const homeInj = pick.injuries.home || [];
  const awayInj = pick.injuries.away || [];
  const sideMl = teamSideOfPick(pick);

  // Pesos: titular descartado pesa más que duda
  const weight = (list) => list.reduce((acc, i) => {
    const status = String(i.status || "").toLowerCase();
    if (status.includes("out") || status.includes("baja")) return acc + 1.0;
    if (status.includes("doubt") || status.includes("duda")) return acc + 0.4;
    return acc + 0.2;
  }, 0);
  const wH = weight(homeInj);
  const wA = weight(awayInj);

  if (pick.market === "moneyline" || pick.market === "double_chance" || pick.market === "handicap") {
    // Si el equipo elegido tiene más bajas, perdemos prob.
    const diff = (sideMl === "home" ? wH - wA : sideMl === "away" ? wA - wH : 0);
    if (diff !== 0) {
      const delta = clamp(-diff * 0.012, -0.06, +0.06); // hasta ±6pp
      deltaProb(pick, delta, `lesiones rivales: ${sideMl} pierde ${diff.toFixed(1)} pts vs rival`);
    }
  }

  // Totals: si AMBOS equipos tienen muchas bajas, baja la calidad y baja goles/runs.
  if ((pick.market === "totals" || pick.market === "goals_total" || pick.market === "runs_total") && (wH + wA) >= 4) {
    const isOver = String(pick.sideLabel || "").toLowerCase().includes("más");
    deltaProb(pick, isOver ? -0.025 : +0.025, `${wH + wA} bajas combinadas perjudican calidad ofensiva`);
  }
}

// ─── 3. Tabla oficial (futbol europeo) ───────────────────────────────────

function adjustOfficialStandings(pick) {
  if (pick.sport !== "futbol") return;
  const o = pick.officialStandings;
  if (!o || !o.home || !o.away) return;

  if (pick.market === "moneyline" || pick.market === "double_chance" || pick.market === "handicap") {
    const sideMl = teamSideOfPick(pick);
    if (!sideMl) return;
    const ptsHome = o.home.pts || 0;
    const ptsAway = o.away.pts || 0;
    const diff = ptsHome - ptsAway;
    // Hasta ±5pp si la diferencia de puntos es muy grande
    const norm = clamp(diff / 30, -1, 1); // 30 pts de diferencia = max
    const signed = sideMl === "home" ? norm : -norm;
    deltaProb(pick, signed * 0.05, `tabla oficial: ${ptsHome}pts (L) vs ${ptsAway}pts (V)`);
  }
}

// ─── 4. Forma reciente real (TheSportsDB) ────────────────────────────────

function pointsFromForm(letters) {
  if (!letters) return null;
  let pts = 0, n = 0;
  for (const ch of String(letters).toUpperCase()) {
    if (ch === "W") { pts += 3; n++; }
    else if (ch === "D") { pts += 1; n++; }
    else if (ch === "L") { n++; }
  }
  return n > 0 ? pts / (n * 3) : null; // 0..1
}

function adjustRecentForm(pick) {
  if (!pick.recentForm) return;
  const homeStr = pickFormString(pick.recentForm.home);
  const awayStr = pickFormString(pick.recentForm.away);
  const fH = pointsFromForm(homeStr);
  const fA = pointsFromForm(awayStr);
  if (fH == null || fA == null) return;
  if (pick.market !== "moneyline" && pick.market !== "double_chance" && pick.market !== "handicap") return;
  const sideMl = teamSideOfPick(pick);
  if (!sideMl) return;
  const diff = (sideMl === "home" ? fH - fA : fA - fH); // -1..1
  deltaProb(pick, diff * 0.04, `forma reciente real ${sideMl} (${homeStr || "?"} vs ${awayStr || "?"})`);
}

function pickFormString(team) {
  if (!team) return null;
  if (typeof team === "string") return team;
  // TheSportsDB devuelve array de partidos { result: 'W'|'D'|'L' }
  if (Array.isArray(team)) return team.map(m => (m.result || "?").toUpperCase()).join("").slice(0, 5);
  return null;
}

// ─── 5. Records casa/visitante (NBA, MLB, futbol) ────────────────────────

function recordToRate(rec) {
  if (!rec) return null;
  const m = String(rec).match(/^(\d+)-(\d+)/);
  if (!m) return null;
  const w = +m[1], l = +m[2];
  return (w + l) > 0 ? w / (w + l) : null;
}

function adjustClubElo(pick) {
  if (!pick.clubElo) return;
  if (pick.market !== "moneyline" && pick.market !== "double_chance" && pick.market !== "handicap") return;
  const sideMl = teamSideOfPick(pick);
  if (!sideMl) return;
  const pHomeElo = pick.clubElo.pHomeFromElo;
  if (!Number.isFinite(pHomeElo)) return;
  // Probabilidad ELO (incluye ventaja de cancha) vs probabilidad del modelo.
  // Suavizamos hacia ELO con peso 0.30 — ELO es muy estable a largo plazo
  // pero no captura noticias del último partido (que sí captura forma reciente).
  const targetSide = sideMl === "home" ? pHomeElo : (1 - pHomeElo);
  const before = Number(pick.modelProb) || 0.5;
  const blended = before * 0.70 + targetSide * 0.30;
  const delta = blended - before;
  if (Math.abs(delta) >= 0.005) {
    deltaProb(pick, delta, `ELO oficial (${pick.clubElo.eloHome} vs ${pick.clubElo.eloAway} → p${sideMl} ${PCT(targetSide)})`);
  }
}

function adjustHomeAwayRecords(pick) {
  if (!pick.homeAwayRecord) return;
  if (pick.market !== "moneyline" && pick.market !== "double_chance" && pick.market !== "handicap") return;
  const homeAtHome = recordToRate(pick.homeAwayRecord.homeAtHome);
  const awayAtAway = recordToRate(pick.homeAwayRecord.awayAtAway);
  if (homeAtHome == null && awayAtAway == null) return;
  const sideMl = teamSideOfPick(pick);
  if (!sideMl) return;
  // Empuja a favor de quien tiene mejor record en su contexto
  const homeStrength = homeAtHome != null ? (homeAtHome - 0.5) : 0;
  const awayStrength = awayAtAway != null ? (awayAtAway - 0.5) : 0;
  const signed = (sideMl === "home" ? homeStrength : awayStrength) - (sideMl === "home" ? awayStrength : homeStrength);
  deltaProb(pick, signed * 0.06, `records L/V (L:${pick.homeAwayRecord.homeAtHome || "?"} · V:${pick.homeAwayRecord.awayAtAway || "?"})`);
}

// ─── API publica ─────────────────────────────────────────────────────────

export function applyContextAdjustments(pick) {
  if (!pick) return pick;
  try {
    adjustWeather(pick);
    adjustInjuries(pick);
    adjustOfficialStandings(pick);
    adjustRecentForm(pick);
    adjustHomeAwayRecords(pick);
    adjustClubElo(pick);
  } catch (err) {
    // Nunca dejamos que un fallo de ajuste rompa el pipeline.
    pick.contextAdjustError = err?.message || String(err);
  }
  if (pick.contextReasons?.length) {
    pick.hasContextAdjustments = true;
  }
  return pick;
}

export function applyContextAdjustmentsAll(picks) {
  if (!Array.isArray(picks)) return picks;
  let count = 0;
  for (const p of picks) {
    applyContextAdjustments(p);
    if (p.hasContextAdjustments) count++;
  }
  console.log(`[contextAdjust] modelProb ajustado por contexto en ${count}/${picks.length} picks`);
  return picks;
}
