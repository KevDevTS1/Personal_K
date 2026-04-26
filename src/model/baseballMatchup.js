// Ajustes específicos de béisbol basados en el duelo de lanzadores y los
// promedios de bateo de cada equipo (datos de MLB Stats API).
//
// Heurísticas principales:
//   - Total carreras Más  ↓ si AMBOS pitchers son aces (ERA<3.40, WHIP<1.15)
//   - Total carreras Menos ↑ si los dos abridores tienen ERA bajo
//   - Total carreras Más  ↑ si AMBOS pitchers son débiles (ERA>4.50)
//   - Moneyline favorito  ↓ si el lanzador rival es ace
//   - Run line -1.5       ↑ si el rival lanza un pitcher débil + ofensiva top
//   - Ponches del abridor ↑ si el rival hace mucho contacto (BB+OBP bajos)
//
// Cada ajuste va a `pick.contextReasons` para mantener transparencia.

import { clamp } from "../utils/math.js";
import { computeEdge } from "./scoring.js";

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
  pick.hasContextAdjustments = true;
  pick.hasPitcherMatchup = true;
}

// ── Métricas derivadas ───────────────────────────────────────────────────

function pitcherRating(p) {
  if (!p) return null;
  const era  = Number.isFinite(p.era)  ? p.era  : 4.50;
  const whip = Number.isFinite(p.whip) ? p.whip : 1.30;
  // Score 0..1 (1 = ace). Pesos: ERA 60%, WHIP 40%
  const eraScore  = clamp((4.80 - era) / 2.40, 0, 1);   // ERA 2.4 → 1, ERA 4.8 → 0
  const whipScore = clamp((1.45 - whip) / 0.45, 0, 1);  // WHIP 1.0 → 1, WHIP 1.45 → 0
  return clamp(eraScore * 0.6 + whipScore * 0.4, 0, 1);
}

function offenseRating(b) {
  if (!b) return null;
  const r = Number.isFinite(b.runsPerGame) ? b.runsPerGame : 4.50;
  const obp = Number.isFinite(b.obp) ? b.obp : 0.320;
  const slg = Number.isFinite(b.slg) ? b.slg : 0.400;
  const runScore = clamp((r - 3.50) / 2.20, 0, 1);
  const opsScore = clamp(((obp + slg) - 0.680) / 0.220, 0, 1);
  return clamp(runScore * 0.6 + opsScore * 0.4, 0, 1);
}

function teamSideOfPick(pick) {
  const sel = String(pick.selection || pick.sideLabel || "").toLowerCase();
  const home = String(pick.homeTeam || "").toLowerCase();
  const away = String(pick.awayTeam || "").toLowerCase();
  if (home && sel.includes(home)) return "home";
  if (away && sel.includes(away)) return "away";
  return null;
}

// ── Ajustes por mercado ──────────────────────────────────────────────────

function adjustTotals(pick, mm) {
  const isOver = String(pick.sideLabel || pick.selection || "").toLowerCase().includes("más");
  const hpR = pitcherRating(mm.homePitcher);
  const apR = pitcherRating(mm.awayPitcher);
  const ofH = offenseRating(mm.homeBatting);
  const ofA = offenseRating(mm.awayBatting);

  // Promedio de calidad de pitching y de ofensiva
  const pAvg = [hpR, apR].filter(x => x != null);
  const oAvg = [ofH, ofA].filter(x => x != null);
  if (!pAvg.length) return;
  const pMean = pAvg.reduce((a, b) => a + b, 0) / pAvg.length;
  const oMean = oAvg.length ? oAvg.reduce((a, b) => a + b, 0) / oAvg.length : 0.5;

  // Pitching duel (ambos altos) → menos carreras
  if (pMean >= 0.65) {
    const eraInfo = `${mm.homePitcher?.name || "L?"} ERA ${(mm.homePitcher?.era ?? 0).toFixed(2)} vs ${mm.awayPitcher?.name || "V?"} ERA ${(mm.awayPitcher?.era ?? 0).toFixed(2)}`;
    deltaProb(pick, isOver ? -0.06 : +0.06, `duelo de aces (${eraInfo})`);
  }
  // Lanzadores flojos + ofensivas potentes → más carreras
  else if (pMean <= 0.35 && oMean >= 0.55) {
    deltaProb(pick, isOver ? +0.05 : -0.05, "lanzadores flojos vs ofensivas top");
  }
  // Asimetría: si solo uno es ace, el efecto es menor
  else if (Math.abs((hpR ?? 0.5) - (apR ?? 0.5)) >= 0.30) {
    // No movemos el total, solo lo dejamos
  }
}

function adjustMoneyline(pick, mm) {
  const sideMl = teamSideOfPick(pick);
  if (!sideMl) return;
  const ourPit  = sideMl === "home" ? mm.homePitcher : mm.awayPitcher;
  const oppPit  = sideMl === "home" ? mm.awayPitcher : mm.homePitcher;
  const ourBat  = sideMl === "home" ? mm.homeBatting : mm.awayBatting;
  const oppBat  = sideMl === "home" ? mm.awayBatting : mm.homeBatting;

  const oR = pitcherRating(ourPit);
  const opR = pitcherRating(oppPit);
  if (oR == null && opR == null) return;
  // Un ace propio sube prob; un ace rival la baja.
  const diff = (oR ?? 0.5) - (opR ?? 0.5);
  const delta = clamp(diff * 0.10, -0.07, +0.07);
  if (Math.abs(delta) >= 0.01) {
    deltaProb(pick, delta, `duelo lanzadores: ${ourPit?.name || "?"} (ERA ${(ourPit?.era ?? 0).toFixed(2)}) vs ${oppPit?.name || "?"} (ERA ${(oppPit?.era ?? 0).toFixed(2)})`);
  }
  // Bonus pequeño si ofensiva propia es muy superior
  const off = offenseRating(ourBat);
  const oppOff = offenseRating(oppBat);
  if (off != null && oppOff != null) {
    const oDiff = off - oppOff;
    const oDelta = clamp(oDiff * 0.06, -0.04, +0.04);
    if (Math.abs(oDelta) >= 0.01) {
      deltaProb(pick, oDelta, `ofensiva: ${(ourBat?.runsPerGame ?? 0).toFixed(2)} runs/g vs ${(oppBat?.runsPerGame ?? 0).toFixed(2)}`);
    }
  }
}

function adjustRunLine(pick, mm) {
  // Run line favorece a quien manda en ambas vertientes (pitching + ofensiva)
  const sideMl = teamSideOfPick(pick);
  if (!sideMl) return;
  const ourPit = sideMl === "home" ? mm.homePitcher : mm.awayPitcher;
  const oppPit = sideMl === "home" ? mm.awayPitcher : mm.homePitcher;
  const ourBat = sideMl === "home" ? mm.homeBatting : mm.awayBatting;
  const oppBat = sideMl === "home" ? mm.awayBatting : mm.homeBatting;

  const pitDiff = (pitcherRating(ourPit) ?? 0.5) - (pitcherRating(oppPit) ?? 0.5);
  const offDiff = (offenseRating(ourBat) ?? 0.5) - (offenseRating(oppBat) ?? 0.5);
  const total = pitDiff + offDiff;
  // -1.5 funciona si dominamos en ambas (~+0.7 acumulado)
  const delta = clamp(total * 0.05, -0.06, +0.06);
  if (Math.abs(delta) >= 0.01) {
    deltaProb(pick, delta, `run line dominio combinado (pitching ${(pitDiff*100).toFixed(0)}% · ofensiva ${(offDiff*100).toFixed(0)}%)`);
  }
}

function adjustPitcherKs(pick, mm) {
  // Solo aplica a "ponches del lanzador". Aumentamos prob over si el rival
  // hace poco contacto (OPS bajo) y reducimos si es lineup que no fanea.
  const stat = String(pick.statLabel || pick.stat || "").toLowerCase();
  if (!stat.includes("ponches")) return;
  // Identificar de qué lado es el lanzador
  const player = String(pick.player || "").toLowerCase();
  const isHomeP = mm.homePitcher && player.includes(String(mm.homePitcher.name || "").toLowerCase());
  const isAwayP = mm.awayPitcher && player.includes(String(mm.awayPitcher.name || "").toLowerCase());
  const oppBat = isHomeP ? mm.awayBatting : isAwayP ? mm.homeBatting : null;
  if (!oppBat) return;
  const ops = (Number(oppBat.obp) || 0.320) + (Number(oppBat.slg) || 0.400);
  // OPS rival bajo → más ponches
  const isOver = String(pick.sideLabel || pick.selection || "").toLowerCase().includes("más");
  if (ops <= 0.700) deltaProb(pick, isOver ? +0.04 : -0.04, `lineup rival débil contra K (OPS ${ops.toFixed(3)})`);
  else if (ops >= 0.780) deltaProb(pick, isOver ? -0.03 : +0.03, `lineup rival difícil de ponchar (OPS ${ops.toFixed(3)})`);
}

// ── API ──────────────────────────────────────────────────────────────────

export function applyBaseballMatchupAdjustment(pick) {
  if (pick?.sport !== "beisbol") return pick;
  const mm = pick.mlbMatchup;
  if (!mm) return pick;
  if (!mm.homePitcher && !mm.awayPitcher) return pick;

  try {
    if (pick.market === "totals" || pick.market === "runs_total") adjustTotals(pick, mm);
    if (pick.market === "moneyline") adjustMoneyline(pick, mm);
    if (pick.market === "run_line") adjustRunLine(pick, mm);
    if (pick.market === "player_props") adjustPitcherKs(pick, mm);
  } catch (err) {
    pick.baseballMatchupError = err?.message || String(err);
  }
  return pick;
}

export function applyBaseballMatchupAll(picks) {
  if (!Array.isArray(picks)) return picks;
  let touched = 0;
  for (const p of picks) {
    const before = (p.contextReasons || []).length;
    applyBaseballMatchupAdjustment(p);
    if ((p.contextReasons || []).length > before) touched++;
  }
  console.log(`[mlbMatchup] ajustes aplicados en ${touched} picks de béisbol`);
  return picks;
}
