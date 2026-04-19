import { clamp, toNum } from "../utils/math.js";
import { normalizeTeamName, pickPlayerName, pickSeed } from "../utils/event.js";
import { gamesFromRecord, hasSignal } from "../utils/data.js";
import {
  soccerRecordStrength, findEspnLeaderSide, getEspnCategoryLeader,
  parseMlbTeamBattingRates, getMlbPitcherKProjection, getRawEspnLeaderRow, getMlbTeamGamesPlayed
} from "../data/espn.js";
import { estimatePropProbabilities } from "../model/props.js";
import { oddsFromProbability, confidenceFromProbability, confidenceFromCombo, computeEdge, bookHalfLine, winProbFromRecords } from "../model/scoring.js";
import { buildMoneylinePick, buildTotalsPick, buildPropPick } from "../picks/builders.js";

function pp(prob, odds) {
  return { modelProb: prob, odds, edge: computeEdge(prob, odds) };
}

export function analyzeBaseballEvent(event, leagueName, leagueSlug, dateKey, summary = null, calibrationStore = null, mlbGameData = null) {
  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return [];

  const homeName = normalizeTeamName(home);
  const awayName = normalizeTeamName(away);
  const eventName = `${homeName} vs ${awayName}`;
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;

  const homeScore = toNum(home.score);
  const awayScore = toNum(away.score);
  const totalRuns = homeScore + awayScore;
  const diff = homeScore - awayScore;

  // Win probability desde records reales de temporada
  const homeGP = gamesFromRecord(home.records?.[0]?.summary || "");
  const awayGP = gamesFromRecord(away.records?.[0]?.summary || "");
  const hasRecords = homeGP >= 5 && awayGP >= 5;

  const hWR = soccerRecordStrength(home.records?.[0]?.summary || "0-0");
  const aWR = soccerRecordStrength(away.records?.[0]?.summary || "0-0");
  const pHomeWin = winProbFromRecords(hWR, aWR, 0.03);
  const favorite = pHomeWin >= 0.5 ? homeName : awayName;
  const favComp = pHomeWin >= 0.5 ? home : away;
  const favTeamId = favComp?.team?.id;
  const pFav = clamp(Math.max(pHomeWin, 1 - pHomeWin), 0.35, 0.82);

  const favSide = summary && favTeamId ? findEspnLeaderSide(summary, favTeamId) : null;
  const espnRates = summary && favTeamId ? parseMlbTeamBattingRates(summary, favTeamId) : null;
  const gp = summary && favTeamId ? getMlbTeamGamesPlayed(summary, favTeamId) : 1;

  // ── MLB Stats API data (preferred over ESPN summary when available) ────────
  const favIsHome = pHomeWin >= 0.5;
  const mlbFavBatting = favIsHome ? mlbGameData?.homeBatting : mlbGameData?.awayBatting;
  const mlbFavPitcher = favIsHome ? mlbGameData?.homePitcher : mlbGameData?.awayPitcher;
  // Merge: MLB Stats API rates override ESPN if available
  const rates = mlbFavBatting || espnRates;
  const hasRates = rates != null && Number.isFinite(rates.hitsPerGame);

  const avgH = favSide ? getEspnCategoryLeader(favSide, "avg") : null;
  const rbiRow = favSide ? getRawEspnLeaderRow(favSide, "RBIs") : null;
  const kRow = favSide ? getRawEspnLeaderRow(favSide, "strikeouts") : null;
  const kProj = kRow ? getMlbPitcherKProjection(kRow) : { kPerStart: null, seasonK: null };

  // Real probable pitcher from MLB Stats API supersedes ESPN summary
  const realKPerStart = mlbFavPitcher?.kPerStart;
  const hasPitcher = Number.isFinite(realKPerStart) || (kRow != null && Number.isFinite(kProj.kPerStart));
  const kPerStartFinal = Number.isFinite(realKPerStart) ? realKPerStart : (kProj.kPerStart || null);
  const pitcherName = mlbFavPitcher?.name || kRow?.athlete?.displayName || `Abridor de ${favorite}`;
  const pitcherSeasonK = mlbFavPitcher?.strikeOuts || kProj.seasonK;
  const pitcherEra = mlbFavPitcher?.era ?? null;

  const hitterPlayer = avgH?.player || pickPlayerName(event, favorite, `Bateador principal de ${favorite}`);
  const pitcherPlayer = pitcherName;

  const hitsPg = rates?.hitsPerGame;
  const lineHits = Number.isFinite(hitsPg) ? bookHalfLine(hitsPg) : "8.5";
  const hitsRes = estimatePropProbabilities({ mean: hitsPg || 8.5, line: parseFloat(lineHits), sport: "beisbol", stat: "golpes de hit del equipo", leagueSlug, calibrationStore });
  const pickHitsOver = hitsRes.pOver >= hitsRes.pUnder;
  const hitsProb = pickHitsOver ? hitsRes.pOver : hitsRes.pUnder;

  const lineK = Number.isFinite(kPerStartFinal) ? bookHalfLine(kPerStartFinal) : "6.5";
  const kRes = estimatePropProbabilities({ mean: kPerStartFinal || 6.5, line: parseFloat(lineK), sport: "beisbol", stat: "ponches del lanzador", leagueSlug, calibrationStore });
  const pickKOver = kRes.pOver >= kRes.pUnder;
  const kProb = pickKOver ? kRes.pOver : kRes.pUnder;

  const rbiVal = toNum(rbiRow?.statistics?.find((x) => x.name === "RBIs")?.value, NaN);
  // Use MLB Stats API rbi/game if available
  const rbiPgMlb = mlbFavBatting?.rbiPerGame;
  const rbiPg = Number.isFinite(rbiPgMlb) && rbiPgMlb > 0
    ? rbiPgMlb
    : (Number.isFinite(rbiVal) && gp > 0 ? rbiVal / gp : 0);
  const hrrEst = clamp(rbiPg > 0 ? rbiPg * 2.4 + 0.6 : 2.5, 1.5, 4.5);
  const lineHrr = bookHalfLine(hrrEst);

  const hrPerGame = mlbFavBatting?.hrPerGame ?? 0;
  const batAvg = mlbFavBatting?.avg ?? avgH?.value ?? 0.250;
  const slug = toNum(rbiRow?.statistics?.find((x) => x.name === "homeRuns")?.value, 0);
  const tbEst = clamp(1.2 + (hrPerGame || slug * 0.15) + batAvg * 6, 1.5, 4.5);
  const lineTb = bookHalfLine(tbEst);

  // MLB Stats API runs/game takes priority over ESPN
  const runsPgTeam = mlbFavBatting?.runsPerGame ?? rates?.runsPerGame;
  const lineRnTeam = Number.isFinite(runsPgTeam) ? bookHalfLine(runsPgTeam) : "4.5";
  let runsTeamProb = null, oddsRunsTeam = null, pickRunsTeamOver = true;
  if (Number.isFinite(runsPgTeam) && runsPgTeam > 0) {
    const rnRes = estimatePropProbabilities({ mean: runsPgTeam, line: parseFloat(lineRnTeam), sport: "beisbol", stat: "carreras del equipo", leagueSlug, calibrationStore });
    pickRunsTeamOver = rnRes.pOver >= rnRes.pUnder;
    runsTeamProb = pickRunsTeamOver ? rnRes.pOver : rnRes.pUnder;
    oddsRunsTeam = oddsFromProbability(runsTeamProb);
  }

  const dblTot = toNum(rbiRow?.statistics?.find((x) => x.name === "doubles")?.value, NaN);
  const dblPg = Number.isFinite(dblTot) && gp > 0 ? dblTot / gp : Math.max(0.35, (Number(hitsPg) || 8) * 0.11);
  const lineDbl = bookHalfLine(Math.max(0.25, dblPg));
  const dblRes = estimatePropProbabilities({ mean: dblPg, line: parseFloat(lineDbl), sport: "beisbol", stat: "dobles del bateador", leagueSlug, calibrationStore });
  const pickDblOver = dblRes.pOver >= dblRes.pUnder;
  const dblProb = pickDblOver ? dblRes.pOver : dblRes.pUnder;

  const rbiMean = Math.max(0.2, rbiPg || 0.38);
  const lineRbi = bookHalfLine(rbiMean);
  const rbiRes = estimatePropProbabilities({ mean: rbiMean, line: parseFloat(lineRbi), sport: "beisbol", stat: "carreras impulsadas", leagueSlug, calibrationStore });
  const pickRbiOver = rbiRes.pOver >= rbiRes.pUnder;
  const rbiProb = pickRbiOver ? rbiRes.pOver : rbiRes.pUnder;

  const hrrRes = estimatePropProbabilities({ mean: hrrEst, line: parseFloat(lineHrr), sport: "beisbol", stat: "hits más carreras más impulsadas", leagueSlug, calibrationStore });
  const pickHrrOver = hrrRes.pOver >= hrrRes.pUnder;
  const hrrProb = pickHrrOver ? hrrRes.pOver : hrrRes.pUnder;

  const runScoredMean = clamp((rbiPg || 0.38) * 0.52 + slug * 0.025 + 0.1, 0.22, 1.15);
  const runRes = estimatePropProbabilities({ mean: runScoredMean, line: 0.5, sport: "beisbol", stat: "carreras bateador", leagueSlug, calibrationStore });
  const pickRunPOver = runRes.pOver >= runRes.pUnder;
  const runProb = pickRunPOver ? runRes.pOver : runRes.pUnder;

  const tbRes = estimatePropProbabilities({ mean: tbEst, line: parseFloat(lineTb), sport: "beisbol", stat: "bases totales", leagueSlug, calibrationStore });
  const pickTbOver = tbRes.pOver >= tbRes.pUnder;
  const tbProb = pickTbOver ? tbRes.pOver : tbRes.pUnder;

  const oddsMl = oddsFromProbability(pFav);
  const oddsHits = oddsFromProbability(hitsProb);
  const oddsK = oddsFromProbability(kProb);
  const oddsDbl = oddsFromProbability(dblProb);
  const oddsRbi = oddsFromProbability(rbiProb);
  const oddsHrr = oddsFromProbability(hrrProb);
  const oddsRun = oddsFromProbability(runProb);
  const oddsTb = oddsFromProbability(tbProb);

  // Total de carreras: Over si totalRuns actual > 7 OR avg runs/g es alto
  const expRuns = (runsPgTeam || 4.5) * 2;
  const overTotal = expRuns >= 8.0 || (Number.isFinite(totalRuns) && totalRuns >= 7);
  const totProb = clamp(0.5 + (expRuns - 8.5) * 0.03, 0.35, 0.72);
  const oddsTot = oddsFromProbability(overTotal ? totProb : 1 - totProb);

  const picks = [];

  // Moneyline always
  picks.push(buildMoneylinePick({
    sport: "beisbol", league: leagueName, eventName,
    favorite, underdog: favorite === homeName ? awayName : homeName,
    ...pp(pFav, oddsMl),
    confidence: confidenceFromProbability(pFav, 38, 86),
    argument: `Win% local=${(hWR*100).toFixed(0)}%, visitante=${(aWR*100).toFixed(0)}% (records temporada ESPN).`,
    eventDateUtc
  }));

  // Total carreras: only if hasSignal
  if (hasSignal(overTotal ? totProb : 1 - totProb, 0.04)) {
    picks.push(buildTotalsPick({
      sport: "beisbol", league: leagueName, eventName,
      line: "8.5 carreras", over: overTotal,
      ...pp(overTotal ? totProb : 1 - totProb, oddsTot),
      confidence: confidenceFromProbability(overTotal ? totProb : 1 - totProb, 38, 82),
      argument: `Carreras esperadas ~${expRuns.toFixed(1)} (2× runs/partido del equipo favorito).`,
      eventDateUtc
    }));
  }

  // Hits equipo: only if hasRates
  if (hasRates) {
    picks.push(buildPropPick({
      sport: "beisbol", league: leagueName, eventName,
      player: favorite, propType: "team", teamLabel: favorite,
      stat: "golpes de hit del equipo", line: lineHits, over: pickHitsOver,
      ...pp(hitsProb, oddsHits),
      confidence: confidenceFromProbability(hitsProb, 40, 86),
      argument: `Hits/partido del equipo: ~${hitsPg.toFixed(2)}${mlbFavBatting ? ` (MLB Stats API, AVG ${batAvg.toFixed(3)})` : " (ESPN)"}.`,
      eventDateUtc
    }));
  }

  // Ponches lanzador: only if hasPitcher
  if (hasPitcher) {
    picks.push(buildPropPick({
      sport: "beisbol", league: leagueName, eventName,
      player: pitcherPlayer, stat: "ponches del lanzador", line: lineK, over: pickKOver,
      ...pp(kProb, oddsK),
      confidence: confidenceFromProbability(kProb, 40, 86),
      argument: pitcherSeasonK
        ? `${pitcherPlayer}: ${pitcherSeasonK} K en temporada, ~${(kPerStartFinal||0).toFixed(1)}/salida${pitcherEra != null ? `, ERA ${Number(pitcherEra).toFixed(2)}` : ""}.`
        : `Prop de ponches por rendimiento del abridor (${pitcherPlayer}).`,
      eventDateUtc
    }));
  }

  // Carreras equipo: only if hasRates and real runs data
  if (hasRates && runsTeamProb != null && oddsRunsTeam && Number.isFinite(runsPgTeam)) {
    picks.push(buildPropPick({
      sport: "beisbol", league: leagueName, eventName,
      player: favorite, propType: "team", teamLabel: favorite,
      stat: "carreras del equipo", line: lineRnTeam, over: pickRunsTeamOver,
      ...pp(runsTeamProb, oddsRunsTeam),
      confidence: confidenceFromProbability(runsTeamProb, 40, 85),
      argument: `Carreras por partido del equipo (ESPN): ~${runsPgTeam.toFixed(2)} vs línea ${lineRnTeam}.`,
      eventDateUtc
    }));
  }

  // Batter props: only if real batter data from ESPN
  if (Number.isFinite(rbiPg) && rbiPg > 0) {
    picks.push(buildPropPick({ sport: "beisbol", league: leagueName, eventName, player: hitterPlayer, stat: "dobles del bateador", line: lineDbl, over: pickDblOver, ...pp(dblProb, oddsDbl), confidence: confidenceFromProbability(dblProb, 38, 84), argument: `Dobles por partido estimados: ~${dblPg.toFixed(2)} (ESPN).`, eventDateUtc }));
    picks.push(buildPropPick({ sport: "beisbol", league: leagueName, eventName, player: hitterPlayer, stat: "carreras impulsadas", line: lineRbi, over: pickRbiOver, ...pp(rbiProb, oddsRbi), confidence: confidenceFromProbability(rbiProb, 38, 84), argument: `Carreras impulsadas por partido del líder ESPN: ~${rbiPg.toFixed(2)}.`, eventDateUtc }));
    picks.push(buildPropPick({ sport: "beisbol", league: leagueName, eventName, player: hitterPlayer, stat: "hits más carreras más impulsadas", line: lineHrr, over: pickHrrOver, ...pp(hrrProb, oddsHrr), confidence: confidenceFromProbability(hrrProb, 38, 84), argument: `Hits + Carreras + Impulsadas combinados: media ~${hrrEst.toFixed(2)} vs línea ${lineHrr}.`, eventDateUtc }));
    picks.push(buildPropPick({ sport: "beisbol", league: leagueName, eventName, player: hitterPlayer, stat: "carreras anotadas", line: "0.5", over: pickRunPOver, ...pp(runProb, oddsRun), confidence: confidenceFromProbability(runProb, 38, 82), argument: `Carreras anotadas: media ~${runScoredMean.toFixed(2)} vs 0.5.`, eventDateUtc }));
    picks.push(buildPropPick({ sport: "beisbol", league: leagueName, eventName, player: hitterPlayer, stat: "bases totales alcanzadas", line: lineTb, over: pickTbOver, ...pp(tbProb, oddsTb), confidence: confidenceFromProbability(tbProb, 38, 84), argument: avgH ? `Bases totales: ~${tbEst.toFixed(2)} (promedio de bateo ESPN ${avgH.displayValue || avgH.value}).` : "Bases totales por contacto y enfrentamiento.", eventDateUtc }));
  }

  // ── Combinada SGP x2 ─────────────────────────────────────────────────────
  const mlbLegs = [
    { prob: hitsProb, odds: oddsHits, short: `${favorite} ${pickHitsOver ? "más de" : "menos de"} ${lineHits} hits` },
    { prob: kProb, odds: oddsK, short: `${pitcherPlayer} ${pickKOver ? "más de" : "menos de"} ${lineK} ponches` },
    ...(runsTeamProb ? [{ prob: runsTeamProb, odds: oddsRunsTeam, short: `${favorite} ${pickRunsTeamOver ? "más de" : "menos de"} ${lineRnTeam} carreras` }] : []),
    { prob: dblProb, odds: oddsDbl, short: `${hitterPlayer} ${pickDblOver ? "más de" : "menos de"} ${lineDbl} dobles` },
    { prob: rbiProb, odds: oddsRbi, short: `${hitterPlayer} ${pickRbiOver ? "más de" : "menos de"} ${lineRbi} carreras impulsadas` },
    { prob: hrrProb, odds: oddsHrr, short: `${hitterPlayer} ${pickHrrOver ? "más de" : "menos de"} ${lineHrr} hits+carreras+impulsadas` }
  ].sort((a, b) => Math.max(b.prob, 1-b.prob) - Math.max(a.prob, 1-a.prob));

  if (mlbLegs.length >= 2 && Math.max(mlbLegs[0].prob, 1-mlbLegs[0].prob) >= 0.56 && Math.max(mlbLegs[1].prob, 1-mlbLegs[1].prob) >= 0.56) {
    const a = mlbLegs[0], b = mlbLegs[1];
    const oddsCombo = Number(Math.max(1.10, Math.min(1.92, a.odds * b.odds * 0.87)).toFixed(2));
    picks.push({
      sport: "beisbol", league: leagueName, event: eventName, eventDateUtc, sourceDateKey: null,
      market: "combo_same_game", marketLabel: "Combinada mismo partido",
      selection: `${a.short} + ${b.short}`,
      odds: oddsCombo, confidence: confidenceFromCombo(a.prob, b.prob),
      modelProb: Math.min(a.prob, b.prob), edge: computeEdge(Math.min(a.prob, b.prob), oddsCombo),
      argument: "Hits del equipo y K del abridor desde ESPN + calibración rolling; piernas correlacionadas."
    });
  }

  return picks;
}
