// Scraping de cuotas en casas colombianas. Sin API publica oficial:
// fetch + cheerio sobre las paginas publicas de cada bookmaker.
//
// IMPORTANTE: estos sitios cambian su HTML con frecuencia. Cada parser tiene
// fallback silencioso. Si todos fallan, el motor cae a The Odds API (EU).
//
// Estructura de salida (CoOddsStore):
//   key: `${normHome}|||${normAway}` -> {
//     books: [{ name, h2h: {home,draw,away}, totals: {line,over,under} }],
//     averaged: { h2h: {home,draw,away}, totals: {line,over,under} },
//     fetchedAt: number,
//     sport: string
//   }

import * as cheerio from "cheerio";

const TTL_MS = 5 * 60 * 1000; // 5 minutos
const FETCH_TIMEOUT_MS = 6000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Cache global (sport+date -> store)
const _stores = new Map();

export function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|cf|sc|cd|club|deportivo|deportes)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "es-CO,es;q=0.9"
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJson(url, init = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        ...(init.headers || {})
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...init
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function num(v) {
  const n = Number(String(v || "").replace(",", "."));
  return Number.isFinite(n) && n > 1.01 ? n : null;
}

// ──────────────────────────────────────────────────────────────────────
// PARSERS POR CASA (best-effort, fallback silencioso)
// ──────────────────────────────────────────────────────────────────────

async function scrapeWplay(sport) {
  // Wplay expone su catalogo via SPA + JSON privado en /api/eventos.
  // Endpoint estable: https://m.wplay.co/api/sportsbook/events?sport=<sport>
  const sportMap = {
    futbol:     "soccer",
    baloncesto: "basketball",
    tenis:      "tennis",
    beisbol:    "baseball"
  };
  const key = sportMap[sport];
  if (!key) return [];
  const url = `https://m.wplay.co/api/sportsbook/events?sport=${key}&country=co`;
  const data = await fetchJson(url);
  const events = Array.isArray(data?.events) ? data.events : [];
  return events.map(ev => ({
    home: ev.homeTeam || ev.participants?.[0]?.name,
    away: ev.awayTeam || ev.participants?.[1]?.name,
    h2h: {
      home: num(ev.markets?.h2h?.home),
      draw: num(ev.markets?.h2h?.draw),
      away: num(ev.markets?.h2h?.away)
    },
    totals: {
      line:  num(ev.markets?.totals?.line),
      over:  num(ev.markets?.totals?.over),
      under: num(ev.markets?.totals?.under)
    },
    bookmaker: "Wplay"
  })).filter(e => e.home && e.away);
}

async function scrapeRushbet(sport) {
  // Rushbet expone su menu via /api/v1/menu y eventos via /sports/<sport>
  const sportMap = {
    futbol:     "futbol",
    baloncesto: "baloncesto",
    tenis:      "tenis",
    beisbol:    "beisbol"
  };
  const key = sportMap[sport];
  if (!key) return [];
  const html = await fetchHtml(`https://www.rushbet.co/sports/${key}/`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const events = [];
  $("[data-test='event-card'], [data-testid='event-card']").each((_, el) => {
    const $el = $(el);
    const teams = $el.find("[data-test='participant-name'], [data-testid='participant-name']");
    if (teams.length < 2) return;
    const odds = $el.find("[data-test='outcome-odds'], [data-testid='outcome-odds']");
    events.push({
      home: $(teams[0]).text().trim(),
      away: $(teams[1]).text().trim(),
      h2h: {
        home: num($(odds[0]).text()),
        draw: odds.length === 3 ? num($(odds[1]).text()) : null,
        away: num($(odds[odds.length - 1]).text())
      },
      totals: { line: null, over: null, under: null },
      bookmaker: "Rushbet"
    });
  });
  return events.filter(e => e.home && e.away);
}

async function scrapeBetssonCo(sport) {
  // Betsson CO usa Kambi: feed publico en `https://eu-offering-api.kambicdn.com/offering/v2018/betssonco/listView/<sport>.json`
  const kambiSport = {
    futbol:     "football",
    baloncesto: "basketball",
    tenis:      "tennis",
    beisbol:    "baseball"
  }[sport];
  if (!kambiSport) return [];
  const url = `https://eu-offering-api.kambicdn.com/offering/v2018/betssonco/listView/${kambiSport}.json?lang=es_CO&market=CO`;
  const data = await fetchJson(url);
  const events = Array.isArray(data?.events) ? data.events : [];
  return events.map(item => {
    const ev = item.event;
    const offers = item.betOffers || [];
    const h2h = offers.find(o => o.criterion?.label?.toLowerCase()?.includes("resultado") || o.betOfferType?.id === 2);
    const tot = offers.find(o => o.criterion?.label?.toLowerCase()?.includes("total")     || o.betOfferType?.id === 6);
    const findOutcome = (off, type) => off?.outcomes?.find(o => o.type === type);
    return {
      home: ev?.homeName,
      away: ev?.awayName,
      h2h: {
        home: num(findOutcome(h2h, "OT_ONE")?.odds  / 1000),
        draw: num(findOutcome(h2h, "OT_CROSS")?.odds / 1000),
        away: num(findOutcome(h2h, "OT_TWO")?.odds  / 1000)
      },
      totals: {
        line:  Number(tot?.outcomes?.[0]?.line) / 1000 || null,
        over:  num(findOutcome(tot, "OT_OVER")?.odds  / 1000),
        under: num(findOutcome(tot, "OT_UNDER")?.odds / 1000)
      },
      bookmaker: "Betsson CO"
    };
  }).filter(e => e.home && e.away);
}

async function scrapeYajuego(sport) {
  // Yajuego: parser HTML basico (fallback)
  const sportPath = {
    futbol:     "futbol",
    baloncesto: "baloncesto",
    tenis:      "tenis",
    beisbol:    "beisbol"
  }[sport];
  if (!sportPath) return [];
  const html = await fetchHtml(`https://www.yajuego.co/deportes/${sportPath}`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const events = [];
  $(".event-row, .match-row, [class*='Event']").each((_, el) => {
    const $el = $(el);
    const home = $el.find(".home-name, .participant-home, [class*='home']").first().text().trim();
    const away = $el.find(".away-name, .participant-away, [class*='away']").first().text().trim();
    const odds = $el.find(".odd-value, .price, [class*='odds']");
    if (!home || !away || odds.length < 2) return;
    events.push({
      home, away,
      h2h: {
        home: num($(odds[0]).text()),
        draw: odds.length >= 3 ? num($(odds[1]).text()) : null,
        away: num($(odds[odds.length - 1]).text())
      },
      totals: { line: null, over: null, under: null },
      bookmaker: "Yajuego"
    });
  });
  return events.filter(e => e.home && e.away);
}

async function scrapeSportium(sport) {
  // Sportium CO: igual estrategia HTML. Fallback silencioso.
  const html = await fetchHtml(`https://sportium.com.co/apuestas-deportivas/${sport === "futbol" ? "futbol" : sport}`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const events = [];
  $("[data-event], .event-item").each((_, el) => {
    const $el = $(el);
    const teams = $el.find(".team-name, [data-team]");
    if (teams.length < 2) return;
    const odds = $el.find(".odd, [data-odds]");
    events.push({
      home: $(teams[0]).text().trim(),
      away: $(teams[1]).text().trim(),
      h2h: {
        home: num($(odds[0]).text()),
        draw: odds.length === 3 ? num($(odds[1]).text()) : null,
        away: num($(odds[odds.length - 1]).text())
      },
      totals: { line: null, over: null, under: null },
      bookmaker: "Sportium"
    });
  });
  return events.filter(e => e.home && e.away);
}

const SCRAPERS = [scrapeWplay, scrapeRushbet, scrapeBetssonCo, scrapeYajuego, scrapeSportium];

// ──────────────────────────────────────────────────────────────────────
// AGREGACION
// ──────────────────────────────────────────────────────────────────────

function average(values) {
  const arr = values.filter(v => Number.isFinite(v) && v > 1.01);
  if (!arr.length) return null;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
}

function mergeEventsByPair(eventsByBook) {
  const pairs = new Map(); // `${normHome}|||${normAway}` -> books[]
  for (const ev of eventsByBook) {
    const key = `${normName(ev.home)}|||${normName(ev.away)}`;
    if (!pairs.has(key)) pairs.set(key, { homeRaw: ev.home, awayRaw: ev.away, books: [] });
    pairs.get(key).books.push(ev);
  }

  const out = new Map();
  for (const [key, agg] of pairs) {
    const books = agg.books;
    const averaged = {
      h2h: {
        home: average(books.map(b => b.h2h?.home)),
        draw: average(books.map(b => b.h2h?.draw)),
        away: average(books.map(b => b.h2h?.away))
      },
      totals: {
        line:  average(books.map(b => b.totals?.line)),
        over:  average(books.map(b => b.totals?.over)),
        under: average(books.map(b => b.totals?.under))
      }
    };
    out.set(key, {
      homeTeam: agg.homeRaw,
      awayTeam: agg.awayRaw,
      books,
      averaged,
      fetchedAt: Date.now()
    });
  }
  return out;
}

/**
 * Construye un store de cuotas CO promediadas por deporte.
 * Cache 5 min. Si todas las casas fallan, retorna Map vacio.
 */
export async function buildColombianOddsStore(sport) {
  const cacheKey = sport;
  const cached = _stores.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.store;

  const results = await Promise.allSettled(SCRAPERS.map(fn => fn(sport)));
  const all = [];
  let okBooks = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value) && r.value.length) {
      all.push(...r.value);
      okBooks++;
    }
  }
  const store = mergeEventsByPair(all);
  _stores.set(cacheKey, { store, fetchedAt: Date.now() });
  console.log(`[CO Odds] ${sport}: ${store.size} eventos agregados de ${okBooks}/${SCRAPERS.length} casas`);
  return store;
}

/**
 * Lookup tolerante: nombre exacto, contains, contains invertido.
 */
export function lookupColombianOdds(store, homeTeam, awayTeam) {
  if (!store?.size || !homeTeam || !awayTeam) return null;
  const hn = normName(homeTeam);
  const an = normName(awayTeam);
  const direct = store.get(`${hn}|||${an}`);
  if (direct) return direct;
  for (const [key, val] of store) {
    const [kh, ka] = key.split("|||");
    const hMatch = kh === hn || kh.includes(hn) || hn.includes(kh);
    const aMatch = ka === an || ka.includes(an) || an.includes(ka);
    if (hMatch && aMatch) return val;
  }
  return null;
}
