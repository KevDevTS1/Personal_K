import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8787;

app.use(express.json());
app.use(express.static(__dirname));

/** Slugs ESPN soccer (site.api.espn.com) — incluye Libertadores, Europa, MLS, MX, Colombia y más ligas europeas. */
const SOCCER_LEAGUES = [
  "esp.1",
  "eng.1",
  "ger.1",
  "ita.1",
  "fra.1",
  "ned.1",
  "por.1",
  "bel.1",
  "tur.1",
  "aut.1",
  "uefa.champions",
  "uefa.europa",
  "conmebol.libertadores",
  "usa.1",
  "mex.1",
  "col.1"
];

const SOCCER_LEAGUE_LABELS = {
  "esp.1": "LaLiga",
  "eng.1": "Premier League",
  "ger.1": "Bundesliga",
  "ita.1": "Serie A",
  "fra.1": "Ligue 1",
  "ned.1": "Eredivisie",
  "por.1": "Liga Portugal",
  "bel.1": "Pro League Belgica",
  "tur.1": "Super Lig",
  "aut.1": "Bundesliga Austria",
  "uefa.champions": "UEFA Champions League",
  "uefa.europa": "UEFA Europa League",
  "conmebol.libertadores": "Copa Libertadores",
  "usa.1": "MLS",
  "mex.1": "Liga MX",
  "col.1": "Primera A Colombia"
};

const BASKET_LEAGUE_LABELS = {
  nba: "NBA",
  wnba: "WNBA",
  "mens-college-basketball": "NCAA Basketball"
};

const TENNIS_LEAGUE_LABELS = {
  atp: "ATP",
  wta: "WTA"
};

const BASEBALL_LEAGUE_LABELS = {
  mlb: "MLB"
};

function getLeagueDisplayName(feed) {
  const apiName = feed.data?.leagues?.[0]?.name;
  if (apiName) return apiName;
  if (feed.sport === "futbol") return SOCCER_LEAGUE_LABELS[feed.league] || feed.league;
  if (feed.sport === "baloncesto") return BASKET_LEAGUE_LABELS[feed.league] || feed.league;
  if (feed.sport === "tenis") return TENNIS_LEAGUE_LABELS[feed.league] || feed.league;
  if (feed.sport === "beisbol") return BASEBALL_LEAGUE_LABELS[feed.league] || feed.league;
  return feed.league;
}

const BASKET_LEAGUES = ["nba", "wnba", "mens-college-basketball"];
const TENNIS_LEAGUES = ["atp", "wta"];
const BASEBALL_LEAGUES = ["mlb"];
const SPORTSDB_SPORTS = ["Soccer", "Basketball", "Tennis", "Baseball"];
const BOGOTA_TZ = "America/Bogota";

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Valor estable 0..1 distinto por fecha + evento + sufijo (evita mismos % con 0-0 en vivo). */
function varyUnit(seedStr) {
  return hash32(seedStr) / 4294967295;
}

function oddsFromSeed(seedStr, min, max) {
  return Number((min + varyUnit(seedStr) * (max - min)).toFixed(2));
}

function eventKey(ev) {
  return String(ev?.id ?? ev?.uid ?? ev?.name ?? "sin-id");
}

function pickSeed(dateKey, event, suffix) {
  return `${dateKey}|${eventKey(event)}|${suffix}`;
}

/** Referencia de cuotas para operadores frecuentes en Colombia (sin API unificada oficial). */
const CO_BOOKMAKERS = [
  { name: "Wplay" },
  { name: "Rushbet" },
  { name: "Betsson CO" },
  { name: "Sportium" },
  { name: "Yajuego" }
];

function colombianBookmakerOdds(baseDecimal, seed = "") {
  const h0 = hash32(seed);
  const offsets = [-0.04, 0.02, -0.01, 0.05, -0.03];
  return CO_BOOKMAKERS.map((b, i) => {
    const jitter = ((h0 >>> (i * 4)) & 511) / 800;
    return {
      bookmaker: b.name,
      odds: Number(Math.max(1.01, baseDecimal + offsets[i] + jitter).toFixed(2))
    };
  });
}

function humanMarketLabel(market) {
  const map = {
    moneyline: "Ganador del partido",
    totals: "Totales (Over/Under)",
    spread: "Spread / Handicap",
    corners: "Corners",
    handicap: "Handicap asiatico",
    player_props: "Prop jugador / equipo",
    btts: "Ambos anotan (BTTS)",
    cards: "Tarjetas",
    team_totals: "Total goles por equipo",
    first_half: "Totales 1er tiempo",
    triples: "Triples (jugador)",
    doubles: "Dobles (jugador)",
    mlb_runs: "Carreras anotadas (bateador)",
    mlb_bases: "Bases totales (bateador)"
  };
  return map[market] || market;
}

function enrichPick(p) {
  const base = typeof p.odds === "number" ? p.odds : 1.85;
  const seed = `${p.forDate || ""}|${p.event}|${p.market}|${p.selection}|${p.statLabel || ""}`;
  const playerName = p.playerName ?? p.player ?? null;
  const lineLabel = p.lineLabel ?? (p.line != null && p.line !== "" ? String(p.line) : null);
  const statLabel = p.statLabel ?? p.stat ?? null;
  const sideLabel = p.sideLabel ?? (typeof p.over === "boolean" ? (p.over ? "Over" : "Under") : null);
  const teamLabel = p.teamLabel ?? null;
  return {
    ...p,
    marketLabel: p.marketLabel || humanMarketLabel(p.market),
    playerName,
    teamLabel,
    lineLabel,
    statLabel,
    sideLabel,
    propType: p.propType ?? (p.market === "player_props"
      ? (((/equipo/i.test(String(statLabel || ""))) || teamLabel) ? "team" : "player")
      : null),
    bookmakerOdds: colombianBookmakerOdds(base, seed),
    oddsSource: "referencia_mercado_co",
    oddsNote: "Cuotas de referencia para operadores frecuentes en CO; confirma en la casa antes de apostar."
  };
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeTeamName(comp) {
  return comp?.team?.shortDisplayName || comp?.team?.displayName || comp?.athlete?.shortName || comp?.athlete?.displayName || "Equipo";
}

function extractCompetitorPlayers(comp) {
  const names = [];
  if (comp?.athlete?.displayName) names.push(comp.athlete.displayName);
  if (comp?.athlete?.shortName) names.push(comp.athlete.shortName);
  const leaders = comp?.leaders || [];
  for (const group of leaders) {
    const list = group?.leaders || [];
    for (const entry of list) {
      if (entry?.athlete?.displayName) names.push(entry.athlete.displayName);
      if (entry?.athlete?.shortName) names.push(entry.athlete.shortName);
    }
  }
  return [...new Set(names.filter(Boolean))];
}

function pickPlayerName(event, preferredTeamName, fallbackText) {
  const comp = event?.competitions?.[0];
  const competitors = comp?.competitors || [];
  const preferred = competitors.find((c) => normalizeTeamName(c) === preferredTeamName) || competitors[0];
  const fromPreferred = extractCompetitorPlayers(preferred);
  if (fromPreferred.length) return fromPreferred[0];
  for (const c of competitors) {
    const names = extractCompetitorPlayers(c);
    if (names.length) return names[0];
  }
  return fallbackText;
}

function buildMoneylinePick({ sport, league, eventName, favorite, underdog, confidence, argument, eventDateUtc, odds }) {
  return {
    sport,
    league,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "moneyline",
    marketLabel: "Ganador del partido",
    selection: `${favorite} gana`,
    odds,
    confidence,
    argument: `${argument} Favorito detectado: ${favorite}. Rival: ${underdog}.`
  };
}

function buildTotalsPick({ sport, league, eventName, line, over, confidence, argument, eventDateUtc, odds }) {
  return {
    sport,
    league,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "totals",
    marketLabel: "Totales (Over/Under)",
    lineLabel: String(line),
    sideLabel: over ? "Over" : "Under",
    selection: `${over ? "Over" : "Under"} ${line}`,
    odds,
    confidence,
    argument
  };
}

function buildPropPick({
  sport, league, eventName, player, stat, line, over, confidence, argument, eventDateUtc,
  propType = "player", teamLabel = null, odds
}) {
  const lineStr = String(line);
  const side = over ? "Over" : "Under";
  return {
    sport,
    league,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "player_props",
    marketLabel: propType === "team" ? "Prop de equipo" : "Prop de jugador",
    playerName: propType === "team" ? null : player,
    teamLabel: propType === "team" ? (teamLabel || player) : teamLabel,
    statLabel: stat,
    lineLabel: lineStr,
    sideLabel: side,
    propType,
    selection: `${player} ${over ? "+" : "-"}${lineStr} ${stat}`,
    odds,
    confidence,
    argument
  };
}

async function fetchScoreboard(sport, league, dateKey = null) {
  const dateParam = dateKey ? `?dates=${dateKey.replaceAll("-", "")}` : "";
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard${dateParam}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Error ESPN ${sport}/${league}: ${response.status}`);
  return response.json();
}

async function fetchSportsDbEvents(dateISO, sportName) {
  const url = `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${dateISO}&s=${encodeURIComponent(sportName)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Error TheSportsDB ${sportName}: ${response.status}`);
  return response.json();
}

function toISODate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function addDaysToIsoDate(baseIso, offsetDays) {
  const [y, m, d] = baseIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}

function rangeKeysInBogota(daysBefore = 3, daysAfter = 3, baseDateKey = null) {
  const keys = [];
  const anchor = baseDateKey || bogotaTodayKey(0);
  for (let i = -daysBefore; i <= daysAfter; i++) {
    keys.push(addDaysToIsoDate(anchor, i));
  }
  return keys;
}

function bogotaDayKey(dateIso) {
  if (!dateIso) return "";
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: BOGOTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function bogotaTodayKey(offset = 0) {
  const base = bogotaDayKey(new Date().toISOString());
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
}

function parseSportsDbDate(raw) {
  if (raw.strTimestamp) {
    const d = new Date(raw.strTimestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (raw.dateEvent && raw.strTime) {
    const d = new Date(`${raw.dateEvent}T${raw.strTime}Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (raw.dateEvent) {
    const d = new Date(`${raw.dateEvent}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function analyzeSoccerEvent(event, leagueName, dateKey) {
  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return [];

  const s = pickSeed(dateKey, event, "futbol");
  const homeName = normalizeTeamName(home);
  const awayName = normalizeTeamName(away);
  const eventName = `${homeName} vs ${awayName}`;
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;
  const homeRecord = home.records?.[0]?.summary || "0-0-0";
  const awayRecord = away.records?.[0]?.summary || "0-0-0";
  const homeScore = toNum(home.score);
  const awayScore = toNum(away.score);
  const scoreDiff = homeScore - awayScore;

  const favorite = scoreDiff >= 0 ? homeName : awayName;
  const underdog = scoreDiff >= 0 ? awayName : homeName;
  const modeloBase = 54 + Math.abs(scoreDiff) * 4 + varyUnit(s + "|forma") * 20;
  const confidenceMl = pct(modeloBase, 52, 88);

  const picks = [];
  picks.push(buildMoneylinePick({
    sport: "futbol",
    league: leagueName,
    eventName,
    favorite,
    underdog,
    confidence: confidenceMl,
    odds: oddsFromSeed(s + "|moneyline", 1.58, 2.55),
    argument: `Analisis por diferencia de rendimiento reciente y record (${homeName}: ${homeRecord}, ${awayName}: ${awayRecord}).`,
    eventDateUtc
  }));

  const projectedGoals = 2.2 + Math.abs(scoreDiff) * 0.25 + varyUnit(s + "|xg") * 0.6;
  const confTot = pct(50 + varyUnit(s + "|totconf") * 28 + Math.abs(scoreDiff) * 3, 52, 86);
  picks.push(buildTotalsPick({
    sport: "futbol",
    league: leagueName,
    eventName,
    line: projectedGoals >= 2.8 ? "2.5 goles" : "3.5 goles",
    over: projectedGoals >= 2.8,
    confidence: confTot,
    odds: oddsFromSeed(s + "|totales", 1.65, 2.45),
    argument: "Proyeccion de goles basada en forma ofensiva/defensiva y tendencia reciente del marcador.",
    eventDateUtc
  }));

  picks.push({
    sport: "futbol",
    league: leagueName,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "corners",
    marketLabel: "Corners",
    lineLabel: "8.5",
    sideLabel: "Over",
    selection: "Over 8.5 corners",
    odds: oddsFromSeed(s + "|corners", 1.68, 2.38),
    confidence: pct(48 + varyUnit(s + "|cornconf") * 32, 52, 84),
    argument: "Mercado de corners por volumen ofensivo, amplitud por bandas y ritmo de ataque esperado."
  });

  picks.push({
    sport: "futbol",
    league: leagueName,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "handicap",
    marketLabel: "Handicap asiatico",
    lineLabel: "-0.5",
    sideLabel: favorite,
    selection: `${favorite} -0.5 handicap asiatico`,
    odds: oddsFromSeed(s + "|hcap", 1.65, 2.35),
    confidence: pct(50 + varyUnit(s + "|hcapconf") * 30 + Math.abs(scoreDiff) * 2, 53, 86),
    argument: "Handicap basado en diferencia de forma, localia y consistencia defensiva del favorito."
  });

  picks.push({
    sport: "futbol",
    league: leagueName,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "btts",
    marketLabel: "Ambos anotan (BTTS)",
    lineLabel: "BTTS",
    sideLabel: "Si",
    selection: "Si - ambos equipos anotan",
    odds: oddsFromSeed(s + "|btts", 1.65, 2.42),
    confidence: pct(49 + varyUnit(s + "|bttsconf") * 28, 52, 83),
    argument: "BTTS por perfil ofensivo de ambos y tendencia a conceder en transiciones."
  });

  picks.push({
    sport: "futbol",
    league: leagueName,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "cards",
    marketLabel: "Tarjetas amarillas",
    lineLabel: "4.5",
    sideLabel: "Over",
    selection: "Over 4.5 tarjetas amarillas",
    odds: oddsFromSeed(s + "|cards", 1.7, 2.4),
    confidence: pct(47 + varyUnit(s + "|cardsconf") * 30, 51, 82),
    argument: "Tarjetas esperadas por ritmo, duelos de mediocampo y arbitraje habitual del torneo."
  });

  picks.push({
    sport: "futbol",
    league: leagueName,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "team_totals",
    marketLabel: "Total goles por equipo",
    playerName: null,
    teamLabel: homeName,
    lineLabel: "1.5",
    sideLabel: "Over",
    selection: `Over 1.5 goles ${homeName} (local)`,
    odds: oddsFromSeed(s + "|ttot", 1.68, 2.35),
    confidence: pct(50 + varyUnit(s + "|ttotconf") * 28, 52, 83),
    argument: "Total local por xG reciente y ventaja de condicion de localia."
  });

  picks.push({
    sport: "futbol",
    league: leagueName,
    event: eventName,
    eventDateUtc,
    sourceDateKey: null,
    market: "first_half",
    marketLabel: "Totales 1er tiempo",
    lineLabel: "1.5 goles 1T",
    sideLabel: "Over",
    selection: "Over 1.5 goles en la primera mitad",
    odds: oddsFromSeed(s + "|1t", 1.7, 2.38),
    confidence: pct(48 + varyUnit(s + "|1tconf") * 29, 51, 82),
    argument: "Ritmo alto al inicio por presion y transiciones tempranas."
  });

  return picks;
}

function analyzeBasketballEvent(event, leagueName, dateKey) {
  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return [];

  const s = pickSeed(dateKey, event, "nba");
  const homeName = normalizeTeamName(home);
  const awayName = normalizeTeamName(away);
  const eventName = `${homeName} vs ${awayName}`;
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;
  const homeScore = toNum(home.score);
  const awayScore = toNum(away.score);
  const paceSignal = Math.abs(homeScore + awayScore);
  const diff = homeScore - awayScore;
  const baseConf = 54 + Math.abs(diff) * 3 + varyUnit(s + "|nbaform") * 24;
  const confidence = pct(baseConf, 55, 89);
  const favorite = diff >= 0 ? homeName : awayName;
  const propPlayer = pickPlayerName(event, favorite, `Jugador principal de ${favorite}`);

  const picks = [];
  picks.push({
    sport: "baloncesto",
    league: leagueName,
    event: eventName,
    eventDateUtc,
    market: "spread",
    marketLabel: "Spread / Handicap",
    lineLabel: "-4.5",
    sideLabel: favorite,
    selection: `${favorite} -4.5`,
    odds: oddsFromSeed(s + "|spread", 1.72, 2.32),
    confidence: pct(52 + varyUnit(s + "|spreadconf") * 30 + Math.abs(diff) * 2, 54, 88),
    argument: "Modelo pondera diferencial de puntos reciente, localia y consistencia de cuartos finales."
  });

  const over = paceSignal > 200 || varyUnit(s + "|pace") > 0.45;
  picks.push(buildTotalsPick({
    sport: "baloncesto",
    league: leagueName,
    eventName,
    line: "219.5 puntos",
    over,
    confidence: pct(50 + varyUnit(s + "|totnba") * 32, 53, 85),
    odds: oddsFromSeed(s + "|game_tot", 1.7, 2.38),
    argument: "Estimacion de total por ritmo de posesiones, eficiencia ofensiva y perfil defensivo.",
    eventDateUtc
  }));

  picks.push(buildPropPick({
    sport: "baloncesto",
    league: leagueName,
    eventName,
    player: favorite,
    propType: "team",
    teamLabel: favorite,
    stat: "asistencias-equipo",
    line: "26.5",
    over: true,
    confidence: pct(52 + varyUnit(s + "|tast") * 28 + Math.abs(diff), 54, 86),
    odds: oddsFromSeed(s + "|tast", 1.75, 2.42),
    argument: "Prop de equipo inferido por tendencia de creacion de tiro y porcentaje de conversion asistida.",
    eventDateUtc
  }));

  picks.push(buildPropPick({
    sport: "baloncesto",
    league: leagueName,
    eventName,
    player: propPlayer,
    stat: "puntos",
    line: "27.5",
    over: true,
    confidence: pct(53 + varyUnit(s + "|pts") * 28, 55, 87),
    odds: oddsFromSeed(s + "|pts", 1.78, 2.48),
    argument: "Prop de puntos por uso ofensivo, pace del partido y volumen de tiros esperado.",
    eventDateUtc
  }));

  picks.push(buildPropPick({
    sport: "baloncesto",
    league: leagueName,
    eventName,
    player: propPlayer,
    stat: "rebotes",
    line: "8.5",
    over: true,
    confidence: pct(51 + varyUnit(s + "|reb") * 30, 53, 85),
    odds: oddsFromSeed(s + "|reb", 1.76, 2.4),
    argument: "Prop de rebotes por porcentaje de rebote, emparejamiento interior y ritmo proyectado.",
    eventDateUtc
  }));

  picks.push(buildPropPick({
    sport: "baloncesto",
    league: leagueName,
    eventName,
    player: propPlayer,
    stat: "asistencias",
    line: "7.5",
    over: true,
    confidence: pct(52 + varyUnit(s + "|ast") * 29, 54, 86),
    odds: oddsFromSeed(s + "|ast", 1.77, 2.45),
    argument: "Prop de asistencias por tiempo de posesion y creacion primaria de juego.",
    eventDateUtc
  }));

  picks.push(buildPropPick({
    sport: "baloncesto",
    league: leagueName,
    eventName,
    player: propPlayer,
    stat: "PRA (puntos+rebotes+asistencias)",
    line: "38.5",
    over: true,
    confidence: pct(50 + varyUnit(s + "|pra") * 30, 53, 84),
    odds: oddsFromSeed(s + "|pra", 1.74, 2.4),
    argument: "Combo PRA por proyeccion integral de volumen ofensivo y minutos esperados.",
    eventDateUtc
  }));

  picks.push(buildPropPick({
    sport: "baloncesto",
    league: leagueName,
    eventName,
    player: propPlayer,
    stat: "triples",
    line: "2.5",
    over: true,
    confidence: pct(51 + varyUnit(s + "|tri") * 29, 53, 85),
    odds: oddsFromSeed(s + "|tri", 1.8, 2.5),
    argument: "Prop de triples por volumen de tiro exterior y defensas que colapsan en el pintado.",
    eventDateUtc
  }));

  return picks;
}

function analyzeTennisEvent(event, leagueName, dateKey) {
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;
  const s = pickSeed(dateKey, event, "tenis");

  // En tenis (ESPN) algunos eventos no traen "competitions", solo nombre del cruce.
  if (!event.competitions?.length) {
    const rawName = event.shortName || event.name || "Jugador A vs Jugador B";
    const separator = rawName.includes(" vs ") ? " vs " : " at ";
    const split = rawName.split(separator);
    const p1Name = split[0] || "Jugador A";
    const p2Name = split[1] || "Jugador B";
    const eventName = `${p1Name} vs ${p2Name}`;
    const confidence = pct(55 + varyUnit(s + "|norank") * 28, 54, 84);
    return [
      buildMoneylinePick({
        sport: "tenis",
        league: leagueName,
        eventName,
        favorite: p1Name,
        underdog: p2Name,
        confidence,
        odds: oddsFromSeed(s + "|ml", 1.55, 2.65),
        argument: "Proyeccion de tenis basada en cruce oficial del dia y ajuste de forma reciente disponible.",
        eventDateUtc
      }),
      buildTotalsPick({
        sport: "tenis",
        league: leagueName,
        eventName,
        line: "22.5 juegos",
        over: varyUnit(s + "|games") > 0.4,
        confidence: pct(50 + varyUnit(s + "|totconf") * 30, 52, 82),
        odds: oddsFromSeed(s + "|totgames", 1.65, 2.38),
        argument: "Total de juegos estimado por volatilidad habitual del matchup en torneos ATP/WTA.",
        eventDateUtc
      })
    ];
  }

  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const p1 = comp.competitors[0];
  const p2 = comp.competitors[1];
  if (!p1 || !p2) return [];

  const p1Name = normalizeTeamName(p1);
  const p2Name = normalizeTeamName(p2);
  const eventName = `${p1Name} vs ${p2Name}`;
  const rank1 = toNum(p1.curatedRank?.current, 60);
  const rank2 = toNum(p2.curatedRank?.current, 60);
  const better = rank1 <= rank2 ? p1Name : p2Name;
  const rankGap = Math.abs(rank1 - rank2);
  const confidence = pct(52 + rankGap * 0.9 + varyUnit(s + "|elo") * 18, 54, 87);

  return [
    buildMoneylinePick({
      sport: "tenis",
      league: leagueName,
      eventName,
      favorite: better,
      underdog: better === p1Name ? p2Name : p1Name,
      confidence,
      odds: oddsFromSeed(s + "|rankml", 1.52, 2.6),
      argument: `Ventaja por ranking y forma estimada en circuito (${p1Name} #${rank1}, ${p2Name} #${rank2}).`,
      eventDateUtc
    }),
    buildTotalsPick({
      sport: "tenis",
      league: leagueName,
      eventName,
      line: "22.5 juegos",
      over: rankGap < 20 || varyUnit(s + "|parity") > 0.5,
      confidence: pct(49 + varyUnit(s + "|tot2") * 32 + rankGap * 0.5, 51, 83),
      odds: oddsFromSeed(s + "|tot2", 1.62, 2.42),
      argument: "Total proyectado segun paridad competitiva y probabilidad de sets largos.",
      eventDateUtc
    })
  ];
}

function analyzeBaseballEvent(event, leagueName, dateKey) {
  const comp = event.competitions?.[0];
  if (!comp?.competitors?.length) return [];
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return [];

  const s = pickSeed(dateKey, event, "mlb");
  const homeName = normalizeTeamName(home);
  const awayName = normalizeTeamName(away);
  const eventName = `${homeName} vs ${awayName}`;
  const eventDateUtc = event.date ? new Date(event.date).toISOString() : null;
  const homeScore = toNum(home.score);
  const awayScore = toNum(away.score);
  const totalRuns = homeScore + awayScore;
  const diff = homeScore - awayScore;
  const favorite = diff >= 0 ? homeName : awayName;
  const baseConf = 56 + Math.abs(diff) * 3 + varyUnit(s + "|mlbform") * 22;
  const confidence = pct(baseConf, 54, 88);
  const hitterPropPlayer = pickPlayerName(event, favorite, `Bateador principal de ${favorite}`);
  const pitcherPropPlayer = `Abridor probable de ${favorite}`;

  return [
    buildMoneylinePick({
      sport: "beisbol",
      league: leagueName,
      eventName,
      favorite,
      underdog: favorite === homeName ? awayName : homeName,
      confidence,
      odds: oddsFromSeed(s + "|mlbml", 1.58, 2.55),
      argument: "Modelo considera diferencial de carreras, bullpen reciente y ventaja de localia.",
      eventDateUtc
    }),
    buildTotalsPick({
      sport: "beisbol",
      league: leagueName,
      eventName,
      line: "8.5 carreras",
      over: totalRuns >= 7 || varyUnit(s + "|runcnt") > 0.55,
      confidence: pct(50 + varyUnit(s + "|totmlb") * 32, 52, 84),
      odds: oddsFromSeed(s + "|mlbtot", 1.65, 2.4),
      argument: "Total esperado por promedio de anotacion reciente y perfil de pitcheo.",
      eventDateUtc
    }),
    buildPropPick({
      sport: "beisbol",
      league: leagueName,
      eventName,
      player: hitterPropPlayer,
      stat: "hits-equipo",
      line: "8.5",
      over: true,
      confidence: pct(49 + varyUnit(s + "|hits") * 30, 52, 83),
      odds: oddsFromSeed(s + "|hits", 1.72, 2.38),
      argument: "Prop derivado de contacto ofensivo y matchup probable contra pitcheo rival.",
      eventDateUtc
    }),
    buildPropPick({
      sport: "beisbol",
      league: leagueName,
      eventName,
      player: pitcherPropPlayer,
      stat: "strikeouts lanzador",
      line: "6.5",
      over: true,
      confidence: pct(51 + varyUnit(s + "|k") * 28, 53, 84),
      odds: oddsFromSeed(s + "|k", 1.74, 2.45),
      argument: "Prop de strikeouts por K-rate del abridor y propension al ponche del lineup rival.",
      eventDateUtc
    }),
    buildPropPick({
      sport: "beisbol",
      league: leagueName,
      eventName,
      player: hitterPropPlayer,
      stat: "hits+runs+rbi",
      line: "2.5",
      over: true,
      confidence: pct(50 + varyUnit(s + "|hrr") * 29, 52, 83),
      odds: oddsFromSeed(s + "|hrr", 1.75, 2.42),
      argument: "Combo H+R+RBI por perfil de contacto del lineup y condiciones ofensivas del parque.",
      eventDateUtc
    }),
    buildPropPick({
      sport: "beisbol",
      league: leagueName,
      eventName,
      player: hitterPropPlayer,
      stat: "carreras anotadas",
      line: "0.5",
      over: true,
      confidence: pct(52 + varyUnit(s + "|run") * 26, 53, 84),
      odds: oddsFromSeed(s + "|runp", 1.78, 2.48),
      argument: "Prop de carreras por slot de bateo y oportunidades con corredores en base.",
      eventDateUtc
    }),
    buildPropPick({
      sport: "beisbol",
      league: leagueName,
      eventName,
      player: hitterPropPlayer,
      stat: "bases totales",
      line: "1.5",
      over: true,
      confidence: pct(50 + varyUnit(s + "|tb") * 28, 52, 82),
      odds: oddsFromSeed(s + "|tb", 1.76, 2.44),
      argument: "Bases totales por contacto duro, velocidad en bases y matchup contra pitcheo.",
      eventDateUtc
    })
  ];
}

function normalizeSportDbSport(sportName) {
  if (sportName === "Soccer") return "futbol";
  if (sportName === "Basketball") return "baloncesto";
  if (sportName === "Tennis") return "tenis";
  if (sportName === "Baseball") return "beisbol";
  return "futbol";
}

function analyzeSportsDbEvent(raw, sportName, dateKey) {
  const sport = normalizeSportDbSport(sportName);
  const home = raw.strHomeTeam || raw.strPlayer || "Local";
  const away = raw.strAwayTeam || raw.strAway || "Visitante";
  const eventName = raw.strEvent || `${home} vs ${away}`;
  const leagueName = raw.strLeague || "General";
  const eventDateUtc = parseSportsDbDate(raw);
  const homeScore = toNum(raw.intHomeScore);
  const awayScore = toNum(raw.intAwayScore);
  const diff = homeScore - awayScore;
  const favorite = diff >= 0 ? home : away;
  const pseudo = { id: raw.idEvent || raw.idAPIfootball || raw.strEvent || eventName, name: eventName };
  const s = pickSeed(dateKey, pseudo, "sdb");
  const confidence = pct(54 + Math.abs(diff) * 3 + varyUnit(s + "|base") * 22, 53, 86);
  const fallbackPlayer = raw.strPlayer || raw.strPlayerHome || raw.strPlayerAway || `Jugador principal de ${favorite}`;

  if (sport === "futbol") {
    return [
      buildMoneylinePick({
        sport,
        league: leagueName,
        eventName,
        favorite,
        underdog: favorite === home ? away : home,
        confidence,
        odds: oddsFromSeed(s + "|fml", 1.58, 2.5),
        argument: "Fuente TheSportsDB con ajuste estadistico por marcador, condicion local/visitante y forma reciente.",
        eventDateUtc
      }),
      buildTotalsPick({
        sport,
        league: leagueName,
        eventName,
        line: "2.5 goles",
        over: (homeScore + awayScore) >= 2,
        confidence: pct(49 + varyUnit(s + "|ftot") * 32, 51, 83),
        odds: oddsFromSeed(s + "|ftot", 1.62, 2.4),
        argument: "Proyeccion de goles por dinamica anotadora y equilibrio defensivo.",
        eventDateUtc
      })
    ];
  }

  if (sport === "baloncesto") {
    return [
      {
        sport,
        league: leagueName,
        event: eventName,
        eventDateUtc,
        market: "spread",
        marketLabel: "Spread / Handicap",
        lineLabel: "-4.5",
        sideLabel: favorite,
        selection: `${favorite} -4.5`,
        odds: oddsFromSeed(s + "|sdbsp", 1.72, 2.35),
        confidence: pct(52 + varyUnit(s + "|sdbsp") * 28, 53, 85),
        argument: "Proyeccion por diferencial de puntos y rendimiento reciente por cuartos."
      },
      buildPropPick({
        sport,
        league: leagueName,
        eventName,
        player: favorite,
        propType: "team",
        teamLabel: favorite,
        stat: "puntos-equipo",
        line: "109.5",
        over: true,
        confidence: pct(51 + varyUnit(s + "|sdpt") * 28, 53, 84),
        odds: oddsFromSeed(s + "|sdpt", 1.74, 2.4),
        argument: "Prop de equipo inferido por ritmo de posesiones y eficiencia ofensiva.",
        eventDateUtc
      })
    ];
  }

  if (sport === "tenis") {
    return [
      buildMoneylinePick({
        sport,
        league: leagueName,
        eventName,
        favorite,
        underdog: favorite === home ? away : home,
        confidence,
        odds: oddsFromSeed(s + "|tml", 1.55, 2.48),
        argument: "Ventaja inferida por resultados recientes y competitividad del duelo.",
        eventDateUtc
      }),
      buildTotalsPick({
        sport,
        league: leagueName,
        eventName,
        line: "22.5 juegos",
        over: varyUnit(s + "|tj") > 0.42,
        confidence: pct(49 + varyUnit(s + "|tjconf") * 30, 51, 81),
        odds: oddsFromSeed(s + "|tj", 1.64, 2.38),
        argument: "Total de juegos estimado por paridad del cruce y probabilidad de sets largos.",
        eventDateUtc
      })
    ];
  }

  return [
    buildMoneylinePick({
      sport,
      league: leagueName,
      eventName,
      favorite,
      underdog: favorite === home ? away : home,
      confidence,
      odds: oddsFromSeed(s + "|bbml", 1.58, 2.45),
      argument: "Modelo de beisbol por diferencial de carreras y ventaja contextual.",
      eventDateUtc
    }),
    buildPropPick({
      sport,
      league: leagueName,
      eventName,
      player: fallbackPlayer,
      stat: "hits-equipo",
      line: "8.5",
      over: true,
      confidence: pct(50 + varyUnit(s + "|bbh") * 28, 52, 82),
      odds: oddsFromSeed(s + "|bbh", 1.7, 2.42),
      argument: "Prop derivado de contacto ofensivo y tendencia de embasado reciente.",
      eventDateUtc
    })
  ];
}

async function collectAllEvents(targetDateKey = null) {
  const tasks = [];
  const dateKey = targetDateKey || bogotaTodayKey(0);
  const rangeDates = [dateKey];

  for (const league of SOCCER_LEAGUES) {
    for (const dateKey of rangeDates) {
      tasks.push(fetchScoreboard("soccer", league, dateKey).then((data) => ({ sport: "futbol", league, dateKey, data })).catch(() => null));
    }
  }
  for (const league of BASKET_LEAGUES) {
    for (const dateKey of rangeDates) {
      tasks.push(fetchScoreboard("basketball", league, dateKey).then((data) => ({ sport: "baloncesto", league, dateKey, data })).catch(() => null));
    }
  }
  for (const league of TENNIS_LEAGUES) {
    for (const dateKey of rangeDates) {
      tasks.push(fetchScoreboard("tennis", league, dateKey).then((data) => ({ sport: "tenis", league, dateKey, data })).catch(() => null));
    }
  }
  for (const league of BASEBALL_LEAGUES) {
    for (const dateKey of rangeDates) {
      tasks.push(fetchScoreboard("baseball", league, dateKey).then((data) => ({ sport: "beisbol", league, dateKey, data })).catch(() => null));
    }
  }

  const results = await Promise.all(tasks);
  const espnFeeds = results.filter(Boolean);

  const sportDbTasks = [];
  for (const sportName of SPORTSDB_SPORTS) {
    for (const dateKey of rangeDates) {
      sportDbTasks.push(fetchSportsDbEvents(dateKey, sportName).then((data) => ({ sportName, dateKey, data })).catch(() => null));
    }
  }
  const sportDbFeeds = (await Promise.all(sportDbTasks)).filter(Boolean);

  return { espnFeeds, sportDbFeeds };
}

function createPicksFromEvents(feedSets, targetDateKey = null) {
  const picks = [];
  const dateKey = targetDateKey || bogotaTodayKey(0);

  for (const feed of feedSets.espnFeeds) {
    const leagueName = getLeagueDisplayName(feed);
    const events = feed.data?.events || [];
    for (const event of events) {
      let generated = [];
      if (feed.sport === "futbol") generated = analyzeSoccerEvent(event, leagueName, feed.dateKey);
      if (feed.sport === "baloncesto") generated = analyzeBasketballEvent(event, leagueName, feed.dateKey);
      if (feed.sport === "tenis") generated = analyzeTennisEvent(event, leagueName, feed.dateKey);
      if (feed.sport === "beisbol") generated = analyzeBaseballEvent(event, leagueName, feed.dateKey);
      generated = generated.map((p) => ({
        ...p,
        league: leagueName,
        leagueSlug: feed.league,
        sourceDateKey: feed.dateKey,
        forDate: dateKey
      }));
      picks.push(...generated);
    }
  }

  for (const feed of feedSets.sportDbFeeds) {
    const events = feed.data?.events || [];
    for (const event of events) {
      picks.push(...analyzeSportsDbEvent(event, feed.sportName, feed.dateKey).map((p) => ({
        ...p,
        sourceDateKey: feed.dateKey,
        forDate: dateKey
      })));
    }
  }

  return picks
    .filter((p) => p && p.event && p.selection && p.eventDateUtc)
    .filter((p) => {
      const key = bogotaDayKey(p.eventDateUtc);
      if (key === dateKey) return true;
      // Fallback: para tenis, algunas fuentes reportan horario UTC que cae en dia previo local.
      return p.sport === "tenis" && p.sourceDateKey === dateKey;
    })
    .slice(0, 600)
    .map((p, idx) => {
      const id = `${Date.now()}-${idx}`;
      const withOdds = { ...p, id, odds: Number((p.odds ?? 1.8).toFixed(2)) };
      return enrichPick(withOdds);
    });
}

app.get("/api/picks", async (req, res) => {
  try {
    const rawTargetDate = String(req.query.targetDate || "");
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawTargetDate) ? rawTargetDate : bogotaTodayKey(0);
    const feeds = await collectAllEvents(targetDate);
    const picks = createPicksFromEvents(feeds, targetDate);
    res.json({
      date: new Date().toISOString(),
      source: "ESPN + TheSportsDB + modelo estadistico propio",
      modelNote: "Confianza y cuotas media varian por id de evento y fecha consultada (incluye partidos 0-0 sin goles aun).",
      total: picks.length,
      range: { targetDate, timezone: BOGOTA_TZ },
      feedHealth: {
        espnFeeds: feeds.espnFeeds.length,
        sportsDbFeeds: feeds.sportDbFeeds.length
      },
      picks
    });
  } catch (error) {
    res.status(500).json({
      error: "No se pudieron generar picks reales",
      details: error.message
    });
  }
});

app.get("/api/league-catalog", (_req, res) => {
  res.json({
    futbol: SOCCER_LEAGUES.map((slug) => ({ slug, label: SOCCER_LEAGUE_LABELS[slug] || slug })),
    baloncesto: BASKET_LEAGUES.map((slug) => ({ slug, label: BASKET_LEAGUE_LABELS[slug] || slug })),
    tenis: TENNIS_LEAGUES.map((slug) => ({ slug, label: TENNIS_LEAGUE_LABELS[slug] || slug })),
    beisbol: BASEBALL_LEAGUES.map((slug) => ({ slug, label: BASEBALL_LEAGUE_LABELS[slug] || slug }))
  });
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
