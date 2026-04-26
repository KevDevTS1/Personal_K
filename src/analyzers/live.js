// Analizador de PRONOSTICOS EN VIVO.
//
// A diferencia del analizador pre-match, este toma como entrada el marcador
// actual, el minuto/periodo/inning/set y proyecta el desenlace residual del
// partido. Cada pick generado lleva pickKind="live" y un liveContext con la
// situacion del cronometro para que el frontend lo muestre como tal.

import { clamp } from "../utils/math.js";
import { normalizeTeamName } from "../utils/event.js";
import { oddsFromProbability, computeEdge, confidenceFromProbability } from "../model/scoring.js";

function pickPayload(modelProb, odds) {
  return { modelProb, odds, edge: computeEdge(modelProb, odds) };
}

function annotateLivePicks(out, base, ctx) {
  return out.map(p => ({
    sport:         base.sport,
    league:        base.league,
    leagueSlug:    base.leagueSlug,
    sourceDateKey: base.sourceDateKey,
    event:         base.event,
    eventDateUtc:  base.eventDateUtc,
    homeScore:     String(base.homeScore),
    awayScore:     String(base.awayScore),
    ...p,
    pickKind:      "live",
    liveContext:   ctx,
  }));
}

function num(x, fb = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fb;
}

function buildObservationPick(base, sport, message) {
  return {
    sport, league: base.league, leagueSlug: base.leagueSlug, sourceDateKey: base.sourceDateKey,
    event: base.event, eventDateUtc: base.eventDateUtc,
    market: "observation", marketLabel: "Seguimiento en vivo",
    sideLabel: "Sin señal clara", selection: "Esperando contexto",
    modelProb: 0.5, odds: 2.0, edge: 0,
    confidence: 50,
    argument: message,
  };
}

function liveBaseFields(event, leagueName, leagueSlug, dateKey, sport) {
  const comp = event.competitions?.[0];
  const home = comp?.competitors?.find(c => c.homeAway === "home");
  const away = comp?.competitors?.find(c => c.homeAway === "away");
  const homeName = normalizeTeamName(home);
  const awayName = normalizeTeamName(away);
  const eventName = `${homeName} vs ${awayName}`;
  const homeScore = num(home?.score, 0);
  const awayScore = num(away?.score, 0);
  return {
    sport,
    league: leagueName, leagueSlug, sourceDateKey: dateKey,
    event: eventName, eventDateUtc: event.date ? new Date(event.date).toISOString() : null,
    homeName, awayName, homeScore, awayScore,
    period: comp?.status?.period ?? null,
    clock:  comp?.status?.displayClock || null,
    detail: comp?.status?.type?.detail || comp?.status?.type?.shortDetail || "En vivo",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// FUTBOL EN VIVO  ·  Mercados:
//   - Resultado final (ML del lider)
//   - Doble oportunidad
//   - Más/Menos de X.5 goles
//   - Próximo equipo en marcar
//   - Ambos equipos marcan en lo que resta
//   - Resultado al descanso (cuando estamos en 1T avanzada)
// ──────────────────────────────────────────────────────────────────────────

function parseSoccerMinute(base) {
  const m = String(base.detail || "").match(/(\d+)\s*'/);
  if (m) return Math.min(120, Number(m[1]));
  if (base.period === 1) return 25;
  if (base.period === 2) return 70;
  return null;
}

function analyzeSoccerLive(event, leagueName, leagueSlug, dateKey) {
  const base = liveBaseFields(event, leagueName, leagueSlug, dateKey, "futbol");
  const minute = parseSoccerMinute(base) ?? 1;
  const remain = clamp(95 - minute, 0, 95);
  const totalGoals = base.homeScore + base.awayScore;
  const diff = base.homeScore - base.awayScore;
  const leader = diff > 0 ? base.homeName : diff < 0 ? base.awayName : null;
  const trailer = diff > 0 ? base.awayName : diff < 0 ? base.homeName : null;
  const ctx = { minute, remain, totalGoals, diff };

  const out = [];

  // 1) Resultado final del lider
  if (leader && Math.abs(diff) >= 1 && remain <= 50) {
    const advBoost = clamp(0.10 * Math.abs(diff) - 0.003 * remain, 0.04, 0.40);
    const pLeader = clamp(0.55 + advBoost, 0.55, 0.93);
    const odds = oddsFromProbability(pLeader);
    out.push({
      market: "moneyline", marketLabel: "Resultado final (en vivo)",
      sideLabel: leader, selection: `${leader} gana`,
      ...pickPayload(pLeader, odds),
      confidence: confidenceFromProbability(pLeader, 55, 90),
      argument: `Va ${base.homeScore}-${base.awayScore} al ${minute}'. Quedan ~${remain} min y ${leader} controla el marcador con ${Math.abs(diff)} de ventaja.`,
    });
  }

  // 2) Doble oportunidad para el que va ganando
  if (leader && Math.abs(diff) >= 1 && remain > 25) {
    const code = leader === base.homeName ? "1X" : "X2";
    const desc = leader === base.homeName ? `${base.homeName} o empate` : `${base.awayName} o empate`;
    const pDc = clamp(0.66 + 0.05 * Math.abs(diff) - 0.002 * remain, 0.62, 0.92);
    const odds = oddsFromProbability(pDc);
    out.push({
      market: "double_chance", marketLabel: "Doble oportunidad (en vivo)",
      lineLabel: code, sideLabel: desc, selection: `${desc} (${code})`,
      ...pickPayload(pDc, odds),
      confidence: confidenceFromProbability(pDc, 60, 90),
      argument: `Con ventaja ${diff > 0 ? "local" : "visitante"} y ~${remain} min restantes, basta que ${leader} no pierda. La doble oportunidad amortigua riesgo si el rival se vuelca al ataque.`,
    });
  }

  // 3) Menos de X.5 goles
  if (totalGoals <= 2 && remain <= 35 && minute >= 50) {
    const line = totalGoals === 0 ? 1.5 : totalGoals === 1 ? 2.5 : 3.5;
    const expRest = 2.6 * (remain / 90);
    const need = Math.max(0, line - totalGoals - 0.5);
    const pUnder = clamp(Math.exp(-expRest * Math.max(0.6, need)), 0.55, 0.93);
    const odds = oddsFromProbability(pUnder);
    out.push({
      market: "totals", marketLabel: "Total de goles (en vivo)",
      lineLabel: `${line} goles`, sideLabel: "Menos de", selection: `Menos de ${line} goles`,
      ...pickPayload(pUnder, odds),
      confidence: confidenceFromProbability(pUnder, 55, 90),
      argument: `Marcador ${base.homeScore}-${base.awayScore} al ${minute}'; con apenas ${remain} min y ritmo bajo, la línea de menos de ${line} se favorece.`,
    });
  }

  // 4) Mas de X.5 goles
  if (totalGoals >= 2 && minute <= 60) {
    const projected = totalGoals + 2.6 * ((90 - minute) / 90);
    const line = projected >= 4.2 ? 4.5 : projected >= 3.6 ? 3.5 : 2.5;
    if (projected > line + 0.3) {
      const pOver = clamp(0.55 + (projected - line) * 0.15, 0.55, 0.86);
      const odds = oddsFromProbability(pOver);
      out.push({
        market: "totals", marketLabel: "Total de goles (en vivo)",
        lineLabel: `${line} goles`, sideLabel: "Más de", selection: `Más de ${line} goles`,
        ...pickPayload(pOver, odds),
        confidence: confidenceFromProbability(pOver, 55, 88),
        argument: `Ya hay ${totalGoals} goles al ${minute}', proyección final ~${projected.toFixed(1)} con el ritmo actual. La línea ${line} se queda corta.`,
      });
    }
  }

  // 5) Próximo equipo en marcar (cuando el que pierde necesita reaccionar y queda tiempo)
  if (trailer && Math.abs(diff) >= 1 && remain >= 20 && minute <= 75) {
    // El que pierde aprieta más → mayor prob de ser el próximo en marcar
    const pNext = clamp(0.50 + 0.06 * Math.abs(diff) - 0.003 * remain, 0.50, 0.72);
    const odds = oddsFromProbability(pNext);
    out.push({
      market: "next_goal", marketLabel: "Próximo equipo en marcar",
      sideLabel: trailer, selection: `${trailer} marca el próximo gol`,
      ...pickPayload(pNext, odds),
      confidence: confidenceFromProbability(pNext, 55, 80),
      argument: `${trailer} pierde por ${Math.abs(diff)} y debe atacar para evitar la derrota. Históricamente el equipo que va abajo aumenta su xG en el último tercio del partido.`,
    });
  }

  // 6) Ambos equipos marcan en lo que resta (si solo uno marcó y queda tiempo)
  if (totalGoals >= 1 && (base.homeScore === 0 || base.awayScore === 0) && minute <= 65 && remain >= 25) {
    const scorer = base.homeScore > 0 ? base.homeName : base.awayName;
    const dryTeam = base.homeScore > 0 ? base.awayName : base.homeName;
    const expGoalsRest = 1.4 * (remain / 90);
    const pBtts = clamp(1 - Math.exp(-expGoalsRest * 0.6), 0.45, 0.78);
    if (pBtts >= 0.55) {
      const odds = oddsFromProbability(pBtts);
      out.push({
        market: "btts_rest", marketLabel: "Ambos marcan (en lo que resta)",
        sideLabel: "Sí", selection: `${dryTeam} también marca antes del final`,
        ...pickPayload(pBtts, odds),
        confidence: confidenceFromProbability(pBtts, 55, 82),
        argument: `${scorer} ya rompió el cero al ${minute}'. Quedan ${remain} min, expectativa de gol residual ${expGoalsRest.toFixed(2)}: ${dryTeam} tiene incentivo y tiempo para responder.`,
      });
    }
  }

  // 7) Resultado al descanso (cuando aún estamos en 1T avanzada)
  if (base.period === 1 && minute >= 30 && minute <= 44) {
    if (Math.abs(diff) >= 1) {
      const pHt = clamp(0.62 + 0.10 * Math.abs(diff), 0.62, 0.85);
      const odds = oddsFromProbability(pHt);
      out.push({
        market: "halftime_result", marketLabel: "Resultado al descanso",
        sideLabel: leader, selection: `${leader} gana al descanso`,
        ...pickPayload(pHt, odds),
        confidence: confidenceFromProbability(pHt, 55, 85),
        argument: `Faltan ${45 - minute} min para el descanso y ${leader} va arriba por ${Math.abs(diff)}. Mantener la diferencia hasta el HT es el escenario más probable.`,
      });
    } else {
      // Empate al descanso muy probable si el partido es trabado
      const pHtX = clamp(0.50 + 0.005 * (45 - minute), 0.55, 0.62);
      const odds = oddsFromProbability(pHtX);
      out.push({
        market: "halftime_result", marketLabel: "Resultado al descanso",
        sideLabel: "Empate", selection: `Empate al descanso`,
        ...pickPayload(pHtX, odds),
        confidence: confidenceFromProbability(pHtX, 55, 70),
        argument: `Marcador igualado al ${minute}', ritmo controlado y sin urgencia: el empate al HT es el escenario base.`,
      });
    }
  }

  if (!out.length) {
    out.push(buildObservationPick(base, "futbol",
      diff === 0
        ? `${base.homeScore}-${base.awayScore} al ${minute}'. Marcador parejo, sin señal clara aún. El analizador esperará a que se abra una ventaja o el partido entre en su tramo final.`
        : `${base.homeScore}-${base.awayScore} al ${minute}'. Quedan ~${remain} min, contexto temprano para emitir un pronóstico estadísticamente sólido.`
    ));
  }

  return annotateLivePicks(out, base, ctx);
}

// ──────────────────────────────────────────────────────────────────────────
// BALONCESTO EN VIVO  ·  Mercados:
//   - ML del lider
//   - Handicap del lider
//   - Total puntos del partido (Más/Menos)
//   - Total puntos del equipo (team total)
//   - Ganador del cuarto actual
// ──────────────────────────────────────────────────────────────────────────

function quarterMinutes(leagueSlug) {
  return leagueSlug === "nba" ? 12 : 10;
}

function parseClockToSec(clock) {
  if (!clock) return null;
  const m = String(clock).match(/(\d+):(\d+)/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function analyzeBasketballLive(event, leagueName, leagueSlug, dateKey) {
  const base = liveBaseFields(event, leagueName, leagueSlug, dateKey, "baloncesto");
  const qLen = quarterMinutes(leagueSlug);
  const totalQ = 4;
  const period = base.period || 1;
  const secLeft = parseClockToSec(base.clock);
  const minPlayed = (period - 1) * qLen + (secLeft != null ? (qLen - secLeft / 60) : qLen / 2);
  const minTotal  = qLen * totalQ;
  const minRemain = Math.max(0, minTotal - minPlayed);
  const totalPts  = base.homeScore + base.awayScore;
  const diff      = base.homeScore - base.awayScore;
  const leader    = diff > 0 ? base.homeName : diff < 0 ? base.awayName : null;
  const ctx = { period, clock: base.clock, minRemain, totalPts, diff };

  const out = [];

  // 1) ML del lider
  if (leader && period >= 2 && Math.abs(diff) >= 8) {
    const pLeader = clamp(0.55 + 0.022 * Math.abs(diff) - 0.010 * minRemain, 0.55, 0.95);
    const odds = oddsFromProbability(pLeader);
    out.push({
      market: "moneyline", marketLabel: "Ganador del partido (en vivo)",
      sideLabel: leader, selection: `${leader} gana`,
      ...pickPayload(pLeader, odds),
      confidence: confidenceFromProbability(pLeader, 55, 92),
      argument: `${leader} domina por ${Math.abs(diff)} puntos en el Q${period} (${base.clock || "—"}). Quedan ~${minRemain.toFixed(1)} min para cerrarlo.`,
    });
  }

  // 2) Handicap del líder
  if (leader && period >= 2 && Math.abs(diff) >= 4 && Math.abs(diff) < 8 && minRemain >= 5) {
    const handicap = -2.5;
    const p = clamp(0.55 + 0.025 * (Math.abs(diff) - 2.5), 0.55, 0.85);
    const odds = oddsFromProbability(p);
    out.push({
      market: "handicap", marketLabel: "Handicap (en vivo)",
      lineLabel: String(handicap), sideLabel: leader,
      selection: `${leader} ${handicap}`,
      ...pickPayload(p, odds),
      confidence: confidenceFromProbability(p, 55, 88),
      argument: `${leader} arriba por ${Math.abs(diff)} en Q${period}; con ${minRemain.toFixed(1)} min restantes el handicap ${handicap} ofrece valor sin obligar a ampliar mucho la diferencia.`,
    });
  }

  // 3) Total puntos del partido
  if (minPlayed >= 6 && minRemain >= 4) {
    const pace = totalPts / Math.max(1, minPlayed);
    const projected = pace * minTotal;
    const baseline = leagueSlug === "nba" ? 224 : leagueSlug === "wnba" ? 162 : 158;
    const line = Math.round((baseline + (projected - baseline) * 0.2) / 0.5) * 0.5;
    if (Math.abs(projected - line) > 4) {
      const over = projected > line;
      const p = clamp(0.55 + Math.min(0.30, Math.abs(projected - line) / 40), 0.55, 0.86);
      const odds = oddsFromProbability(p);
      out.push({
        market: "totals", marketLabel: "Puntos totales del partido (en vivo)",
        lineLabel: String(line), sideLabel: over ? "Más de" : "Menos de",
        selection: `${over ? "Más de" : "Menos de"} ${line} puntos`,
        ...pickPayload(p, odds),
        confidence: confidenceFromProbability(p, 55, 88),
        argument: `Ritmo actual ${pace.toFixed(2)} ptos/min; proyección final ~${projected.toFixed(0)} puntos vs línea ${line}.`,
      });
    }
  }

  // 4) Team total: si el equipo viene con ritmo alto/bajo destacable
  if (minPlayed >= 8 && minRemain >= 4) {
    for (const side of ["home", "away"]) {
      const sc = side === "home" ? base.homeScore : base.awayScore;
      const name = side === "home" ? base.homeName : base.awayName;
      const proj = (sc / Math.max(1, minPlayed)) * minTotal;
      const baseTeam = leagueSlug === "nba" ? 112 : leagueSlug === "wnba" ? 81 : 79;
      const line = Math.round((baseTeam + (proj - baseTeam) * 0.25) / 0.5) * 0.5;
      if (Math.abs(proj - line) > 5) {
        const over = proj > line;
        const p = clamp(0.55 + Math.min(0.27, Math.abs(proj - line) / 22), 0.55, 0.84);
        const odds = oddsFromProbability(p);
        out.push({
          market: "team_totals", marketLabel: `Puntos del equipo (en vivo)`,
          lineLabel: String(line), sideLabel: `${name} ${over ? "Más" : "Menos"} de ${line}`,
          selection: `${name}: ${over ? "Más" : "Menos"} de ${line} puntos`,
          ...pickPayload(p, odds),
          confidence: confidenceFromProbability(p, 55, 84),
          argument: `${name} lleva ${sc} en ${minPlayed.toFixed(1)} min jugados; proyección final ~${proj.toFixed(0)} puntos. La línea de equipo ${line} queda ${over ? "corta" : "alta"}.`,
        });
      }
    }
  }

  // 5) Ganador del cuarto actual: si el cuarto va parejo y queda poco
  if (leader && Math.abs(diff) >= 4 && Math.abs(diff) < 12 && period >= 2 && (secLeft || 0) <= 240) {
    const p = clamp(0.55 + 0.02 * Math.abs(diff), 0.55, 0.78);
    const odds = oddsFromProbability(p);
    out.push({
      market: "quarter_winner", marketLabel: `Ganador del Q${period}`,
      sideLabel: leader, selection: `${leader} gana el Q${period}`,
      ...pickPayload(p, odds),
      confidence: confidenceFromProbability(p, 55, 80),
      argument: `${leader} domina globalmente y el Q${period} entra en sus minutos finales (${base.clock || "—"}). Mantener iniciativa hasta el cierre del cuarto es el escenario más probable.`,
    });
  }

  if (!out.length) {
    out.push(buildObservationPick(base, "baloncesto",
      `${base.homeScore}-${base.awayScore} en Q${period} (${base.clock || "—"}). Diferencia ${Math.abs(diff)} pts y ritmo ${(totalPts / Math.max(1, minPlayed)).toFixed(2)} pts/min: aún no hay un pronóstico con margen claro.`
    ));
  }

  return annotateLivePicks(out, base, ctx);
}

// ──────────────────────────────────────────────────────────────────────────
// TENIS EN VIVO  ·  Mercados:
//   - ML
//   - Total de sets (más/menos 2.5)
//   - Hándicap de sets
// ──────────────────────────────────────────────────────────────────────────

function analyzeTennisLive(event, leagueName, leagueSlug, dateKey) {
  const base = liveBaseFields(event, leagueName, leagueSlug, dateKey, "tenis");
  const setsHome = base.homeScore;
  const setsAway = base.awayScore;
  const setLead = Math.abs(setsHome - setsAway);
  const leader = setsHome > setsAway ? base.homeName : setsAway > setsHome ? base.awayName : null;
  const totalSets = setsHome + setsAway;
  const ctx = { setsHome, setsAway, leader, setLead };

  const out = [];

  // 1) ML
  if (leader && setLead >= 1) {
    const p = clamp(0.62 + 0.16 * setLead, 0.62, 0.92);
    const odds = oddsFromProbability(p);
    out.push({
      market: "moneyline", marketLabel: "Ganador del partido (en vivo)",
      sideLabel: leader, selection: `${leader} gana`,
      ...pickPayload(p, odds),
      confidence: confidenceFromProbability(p, 55, 92),
      argument: `${leader} domina ${Math.max(setsHome, setsAway)}-${Math.min(setsHome, setsAway)} en sets. Romper desde abajo en best-of-3 es estadísticamente cuesta arriba.`,
    });
  }

  // 2) Total de sets — Menos de 2.5 si hay barrida en marcha
  if (leader && setLead === 1 && totalSets === 1) {
    const pUnder = 0.62;
    const odds = oddsFromProbability(pUnder);
    out.push({
      market: "totals", marketLabel: "Total de sets",
      lineLabel: "2.5", sideLabel: "Menos de",
      selection: `Menos de 2.5 sets (barrida ${leader})`,
      ...pickPayload(pUnder, odds),
      confidence: confidenceFromProbability(pUnder, 55, 78),
      argument: `${leader} ganó el primer set y normalmente cerca del 65% de los partidos en los que el favorito gana el primero terminan en barrida 2-0.`,
    });
  }

  // 3) Total de sets — Más de 2.5 si vamos 1-1
  if (totalSets === 2 && setLead === 0) {
    const pOver = 0.85;
    const odds = oddsFromProbability(pOver);
    out.push({
      market: "totals", marketLabel: "Total de sets",
      lineLabel: "2.5", sideLabel: "Más de",
      selection: "Más de 2.5 sets (irá a 3er set)",
      ...pickPayload(pOver, odds),
      confidence: confidenceFromProbability(pOver, 70, 92),
      argument: `Sets 1-1, partido obligatoriamente al tercer set. Esta es matemáticamente una de las apuestas más seguras del live tenis.`,
    });
  }

  // 4) Hándicap de sets para barrida
  if (leader && setLead >= 1) {
    const pHcap = clamp(0.55 + 0.10 * setLead, 0.55, 0.78);
    const odds = oddsFromProbability(pHcap);
    out.push({
      market: "set_handicap", marketLabel: "Hándicap de sets",
      lineLabel: "-1.5", sideLabel: leader,
      selection: `${leader} -1.5 sets`,
      ...pickPayload(pHcap, odds),
      confidence: confidenceFromProbability(pHcap, 55, 80),
      argument: `Para que ${leader} cubra -1.5 sets necesita ganar 2-0 en best-of-3. Con la ventaja actual y el ímpetu, es el resultado más probable.`,
    });
  }

  if (!out.length) {
    out.push(buildObservationPick(base, "tenis",
      `Partido en disputa, sets ${setsHome}-${setsAway}. Aún no hay un set definido a favor de ningún jugador para emitir un pronóstico fiable.`
    ));
  }

  return annotateLivePicks(out, base, ctx);
}

// ──────────────────────────────────────────────────────────────────────────
// BEISBOL EN VIVO  ·  Mercados:
//   - ML del lider
//   - Total de carreras (Más)
//   - Total de carreras (Menos) si juego cerrado
//   - Próximo equipo en anotar
// ──────────────────────────────────────────────────────────────────────────

function analyzeBaseballLive(event, leagueName, leagueSlug, dateKey) {
  const base = liveBaseFields(event, leagueName, leagueSlug, dateKey, "beisbol");
  const inning = base.period || 1;
  const totalRuns = base.homeScore + base.awayScore;
  const diff = base.homeScore - base.awayScore;
  const leader = diff > 0 ? base.homeName : diff < 0 ? base.awayName : null;
  const trailer = diff > 0 ? base.awayName : diff < 0 ? base.homeName : null;
  const ctx = { inning, totalRuns, diff };

  const out = [];

  // 1) ML del lider
  if (leader && Math.abs(diff) >= 2 && inning >= 5) {
    const p = clamp(0.55 + 0.05 * Math.abs(diff) + 0.05 * (inning - 5), 0.55, 0.95);
    const odds = oddsFromProbability(p);
    out.push({
      market: "moneyline", marketLabel: "Ganador del partido (en vivo)",
      sideLabel: leader, selection: `${leader} gana`,
      ...pickPayload(p, odds),
      confidence: confidenceFromProbability(p, 55, 92),
      argument: `${leader} ${diff > 0 ? "local" : "visitante"} con ${Math.abs(diff)} carreras de ventaja al ${inning}° inning. Quedan ${Math.max(0, 9 - inning)} entradas.`,
    });
  }

  // 2) Total Más
  if (inning >= 3 && inning <= 7 && totalRuns >= 3) {
    const projected = totalRuns * (9 / inning);
    const line = Math.round(projected) - 0.5;
    if (projected - line > 0.6) {
      const p = clamp(0.55 + Math.min(0.25, (projected - line) / 6), 0.55, 0.85);
      const odds = oddsFromProbability(p);
      out.push({
        market: "totals", marketLabel: "Total de carreras (en vivo)",
        lineLabel: String(line), sideLabel: "Más de",
        selection: `Más de ${line} carreras`,
        ...pickPayload(p, odds),
        confidence: confidenceFromProbability(p, 55, 86),
        argument: `Ya van ${totalRuns} carreras tras ${inning} innings; proyección lineal ~${projected.toFixed(1)} para el cierre.`,
      });
    }
  }

  // 3) Total Menos: juego cerrado, pocos hits
  if (inning >= 4 && inning <= 7 && totalRuns <= 4) {
    const projected = totalRuns * (9 / inning);
    const line = Math.round(projected + 1.5) + 0.5;
    if (line - projected > 1.0) {
      const p = clamp(0.55 + Math.min(0.25, (line - projected) / 5), 0.55, 0.84);
      const odds = oddsFromProbability(p);
      out.push({
        market: "totals", marketLabel: "Total de carreras (en vivo)",
        lineLabel: String(line), sideLabel: "Menos de",
        selection: `Menos de ${line} carreras`,
        ...pickPayload(p, odds),
        confidence: confidenceFromProbability(p, 55, 84),
        argument: `Solo ${totalRuns} carrera(s) en ${inning} innings; ritmo bajo, los pitchers están dominando. Proyección al cierre ${projected.toFixed(1)}.`,
      });
    }
  }

  // 4) Próximo equipo en anotar (cuando hay rezagado y aún quedan entradas)
  if (trailer && Math.abs(diff) >= 2 && inning >= 4 && inning <= 7) {
    const pNext = clamp(0.50 + 0.04 * Math.abs(diff), 0.50, 0.66);
    const odds = oddsFromProbability(pNext);
    out.push({
      market: "next_to_score", marketLabel: "Próximo equipo en anotar",
      sideLabel: trailer, selection: `${trailer} anota la próxima carrera`,
      ...pickPayload(pNext, odds),
      confidence: confidenceFromProbability(pNext, 55, 75),
      argument: `${trailer} pierde por ${Math.abs(diff)} y necesita reacción ofensiva. Estadísticamente, equipos perdiendo entrando al 7° aumentan presión y porcentaje de embasarse.`,
    });
  }

  if (!out.length) {
    out.push(buildObservationPick(base, "beisbol",
      `${base.homeScore}-${base.awayScore} al ${inning}° inning. Diferencia ${Math.abs(diff)} carrera(s); aún sin contexto suficiente para emitir un pronóstico estadístico claro.`
    ));
  }

  return annotateLivePicks(out, base, ctx);
}

// ──────────────────────────────────────────────────────────────────────────
// API publica
// ──────────────────────────────────────────────────────────────────────────

export function analyzeLiveEvent(sport, event, leagueName, leagueSlug, dateKey) {
  if (sport === "futbol")     return analyzeSoccerLive(event, leagueName, leagueSlug, dateKey);
  if (sport === "baloncesto") return analyzeBasketballLive(event, leagueName, leagueSlug, dateKey);
  if (sport === "tenis")      return analyzeTennisLive(event, leagueName, leagueSlug, dateKey);
  if (sport === "beisbol")    return analyzeBaseballLive(event, leagueName, leagueSlug, dateKey);
  return [];
}
