import { toNum, clamp } from "../utils/math.js";
import { parseSportsDbDate, bogotaDayKey } from "../utils/time.js";
import { normalizeSportDbSport } from "../data/sportsdb.js";
import { soccerRecordStrength } from "../data/espn.js";
import { oddsFromProbability, confidenceFromProbability, computeEdge, winProbFromRecords } from "../model/scoring.js";
import { buildMoneylinePick, buildTotalsPick, buildPropPick } from "../picks/builders.js";

export function analyzeSportsDbEvent(raw, sportName, dateKey) {
  const sport = normalizeSportDbSport(sportName);
  const home = raw.strHomeTeam || raw.strPlayer || "Local";
  const away = raw.strAwayTeam || raw.strAway || "Visitante";
  const eventName = raw.strEvent || `${home} vs ${away}`;
  const leagueName = raw.strLeague || "General";
  const eventDateUtc = parseSportsDbDate(raw);
  const homeScore = toNum(raw.intHomeScore);
  const awayScore = toNum(raw.intAwayScore);
  const diff = homeScore - awayScore;

  // Win probability simplificada desde marcador/diferencial
  const pHomeWin = clamp(0.5 + diff * 0.04 + 0.02, 0.2, 0.82);
  const favorite = pHomeWin >= 0.5 ? home : away;
  const underdog = pHomeWin >= 0.5 ? away : home;
  const pFav = Math.max(pHomeWin, 1 - pHomeWin);
  const oddsMl = oddsFromProbability(pFav);

  const fallbackPlayer = raw.strPlayer || raw.strPlayerHome || raw.strPlayerAway || `Jugador principal de ${favorite}`;

  if (sport === "futbol") {
    const pGoalsOver = 0.52; // leve sesgo Over 2.5 en fútbol
    const oddsGo = oddsFromProbability(pGoalsOver);
    return [
      buildMoneylinePick({
        sport, league: leagueName, eventName, favorite, underdog,
        modelProb: pFav, odds: oddsMl, edge: computeEdge(pFav, oddsMl),
        confidence: confidenceFromProbability(pFav, 38, 72),
        argument: "Fuente TheSportsDB. Favorito por marcador/condición de local.",
        eventDateUtc
      }),
      buildTotalsPick({
        sport, league: leagueName, eventName, line: "2.5 goles", over: true,
        modelProb: pGoalsOver, odds: oddsGo, edge: computeEdge(pGoalsOver, oddsGo),
        confidence: confidenceFromProbability(pGoalsOver, 38, 65),
        argument: "Over 2.5 goles: tendencia de marcador disponible.",
        eventDateUtc
      })
    ];
  }

  if (sport === "baloncesto") {
    const pSpread = clamp(pFav - 0.05, 0.28, 0.72);
    const oddsSp = oddsFromProbability(pSpread);
    return [
      {
        sport, league: leagueName, event: eventName, eventDateUtc,
        market: "spread", marketLabel: "Handicap por puntos",
        lineLabel: "-4.5", sideLabel: favorite,
        selection: `${favorite} gana por más de 4.5 puntos`,
        modelProb: pSpread, odds: oddsSp, edge: computeEdge(pSpread, oddsSp),
        confidence: confidenceFromProbability(pSpread, 38, 68),
        argument: "Spread estimado desde diferencial de puntos (TheSportsDB)."
      },
      buildPropPick({
        sport, league: leagueName, eventName,
        player: favorite, propType: "team", teamLabel: favorite,
        stat: "puntos del equipo", line: "109.5", over: true,
        modelProb: 0.52, odds: oddsFromProbability(0.52), edge: computeEdge(0.52, oddsFromProbability(0.52)),
        confidence: confidenceFromProbability(0.52, 38, 62),
        argument: "Prop de equipo por ritmo de posesiones (TheSportsDB).",
        eventDateUtc
      })
    ];
  }

  if (sport === "tenis") {
    const pGamesOver = 0.52;
    const oddsGames = oddsFromProbability(pGamesOver);
    return [
      buildMoneylinePick({
        sport, league: leagueName, eventName, favorite, underdog,
        modelProb: pFav, odds: oddsMl, edge: computeEdge(pFav, oddsMl),
        confidence: confidenceFromProbability(pFav, 38, 68),
        argument: "Fuente TheSportsDB; sin datos de ranking.",
        eventDateUtc
      }),
      buildTotalsPick({
        sport, league: leagueName, eventName, line: "22.5 juegos", over: true,
        modelProb: pGamesOver, odds: oddsGames, edge: computeEdge(pGamesOver, oddsGames),
        confidence: confidenceFromProbability(pGamesOver, 36, 62),
        argument: "Total de juegos estimado (TheSportsDB).",
        eventDateUtc
      })
    ];
  }

  // Béisbol fallback
  const pHitsOver = 0.53;
  const oddsH = oddsFromProbability(pHitsOver);
  return [
    buildMoneylinePick({
      sport, league: leagueName, eventName, favorite, underdog,
      modelProb: pFav, odds: oddsMl, edge: computeEdge(pFav, oddsMl),
      confidence: confidenceFromProbability(pFav, 38, 70),
      argument: "Béisbol TheSportsDB; favorito por diferencial de carreras.",
      eventDateUtc
    }),
    buildPropPick({
      sport, league: leagueName, eventName, player: fallbackPlayer,
      stat: "golpes de hit del equipo", line: "8.5", over: true,
      modelProb: pHitsOver, odds: oddsH, edge: computeEdge(pHitsOver, oddsH),
      confidence: confidenceFromProbability(pHitsOver, 36, 62),
      argument: "Prop derivado de contacto ofensivo (TheSportsDB).",
      eventDateUtc
    })
  ];
}
