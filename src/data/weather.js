// Clima en sede del partido.
//
// Fuentes:
//  1. OpenWeatherMap (PRIMARIO si OPENWEATHER_API_KEY esta definida)
//     - Resolucion por geocoding (ciudad → lat/lon → forecast hora a hora)
//     - 1000 req/dia free, suficiente para nuestro uso
//  2. wttr.in (FALLBACK gratuito sin key)
//
// Util para futbol y beisbol al aire libre: lluvia, viento y temperatura
// inciden en goles, tarjetas, corners y total de carreras.

const OWM_KEY = process.env.OPENWEATHER_API_KEY || "";
const OWM_GEO  = "https://api.openweathermap.org/geo/1.0/direct";
const OWM_FCST = "https://api.openweathermap.org/data/2.5/forecast";

const _cache = new Map();
const _geoCache = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 min

const now = () => Date.now();

async function fetchJson(url, timeoutMs = 6000, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "personal-k-pronos/1.0", ...headers } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ───── OpenWeatherMap ────────────────────────────────────────────────────

async function geocode(city, country = "") {
  const k = `${city}|${country}`.toLowerCase();
  if (_geoCache.has(k)) return _geoCache.get(k);
  const q = country ? `${city},${country}` : city;
  const url = `${OWM_GEO}?q=${encodeURIComponent(q)}&limit=1&appid=${OWM_KEY}`;
  const j = await fetchJson(url);
  const hit = j?.[0];
  const v = hit ? { lat: hit.lat, lon: hit.lon, name: hit.name, country: hit.country } : null;
  _geoCache.set(k, v);
  return v;
}

function pickClosestOwmSlot(list, eventDateUtc) {
  if (!list?.length) return null;
  if (!eventDateUtc) return list[0];
  const target = new Date(eventDateUtc).getTime();
  let best = null, bestDiff = Infinity;
  for (const slot of list) {
    const dt = new Date(slot.dt * 1000).getTime();
    const diff = Math.abs(dt - target);
    if (diff < bestDiff) { bestDiff = diff; best = slot; }
  }
  return best || list[0];
}

function summarizeOwm(slot) {
  if (!slot) return null;
  const tempC = slot.main?.temp;
  const wind  = slot.wind?.speed != null ? slot.wind.speed * 3.6 : null; // m/s → km/h
  const rainMm = (slot.rain?.["3h"] ?? slot.rain?.["1h"] ?? 0);
  const humidity = slot.main?.humidity;
  const cloud = slot.clouds?.all;
  const desc = slot.weather?.[0]?.description || "—";

  const isRain = rainMm >= 0.5 || /rain|drizzle|thunder/i.test(desc);
  const isWindy = wind != null && wind >= 25;
  const isCold  = tempC != null && tempC <= 6;
  const isHot   = tempC != null && tempC >= 30;

  return {
    descripcion: desc,
    temperaturaC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    vientoKmh:    Number.isFinite(wind) ? Math.round(wind) : null,
    lluviaMm:     Number(rainMm.toFixed(1)),
    humedad:      Number.isFinite(humidity) ? Math.round(humidity) : null,
    nubosidad:    Number.isFinite(cloud) ? Math.round(cloud) : null,
    fuente:       "openweathermap",
    flags: { lluvia: isRain, viento: isWindy, frio: isCold, calor: isHot }
  };
}

async function getWeatherFromOwm(city, country, eventDateUtc) {
  if (!OWM_KEY || !city) return null;
  const geo = await geocode(city, country);
  if (!geo) return null;
  const url = `${OWM_FCST}?lat=${geo.lat}&lon=${geo.lon}&appid=${OWM_KEY}&units=metric&lang=es`;
  const j = await fetchJson(url);
  const slot = pickClosestOwmSlot(j?.list, eventDateUtc);
  return summarizeOwm(slot);
}

// ───── wttr.in (fallback) ────────────────────────────────────────────────

function pickClosestWttrHour(weatherJson, eventDateUtc) {
  const hours = (weatherJson?.weather || []).flatMap(d => (d.hourly || []).map(h => ({ ...h, _date: d.date })));
  if (!hours.length) return null;
  if (!eventDateUtc) return hours[0];
  const target = new Date(eventDateUtc).getTime();
  let best = null, bestDiff = Infinity;
  for (const h of hours) {
    const t = parseInt(h.time || "0", 10);
    const hh = Math.floor(t / 100);
    const dt = new Date(`${h._date}T${String(hh).padStart(2, "0")}:00:00Z`).getTime();
    const diff = Math.abs(dt - target);
    if (diff < bestDiff) { bestDiff = diff; best = h; }
  }
  return best || hours[0];
}

function summarizeWttr(weatherJson, eventDateUtc) {
  const cur = weatherJson?.current_condition?.[0];
  const hr  = pickClosestWttrHour(weatherJson, eventDateUtc) || cur;
  if (!hr) return null;

  const desc = (hr.weatherDesc?.[0]?.value || cur?.weatherDesc?.[0]?.value || "").toLowerCase();
  const tempC = Number(hr.tempC ?? cur?.temp_C);
  const wind  = Number(hr.windspeedKmph ?? cur?.windspeedKmph);
  const rainMm = Number(hr.precipMM ?? cur?.precipMM);
  const humidity = Number(hr.humidity ?? cur?.humidity);
  const cloud   = Number(hr.cloudcover ?? cur?.cloudcover);

  const isRain = /rain|drizzle|shower|thunder/.test(desc) || rainMm >= 0.5;
  const isWindy = wind >= 25;
  const isCold  = tempC <= 6;
  const isHot   = tempC >= 30;

  return {
    descripcion: hr.weatherDesc?.[0]?.value || cur?.weatherDesc?.[0]?.value || "—",
    temperaturaC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    vientoKmh:    Number.isFinite(wind) ? Math.round(wind) : null,
    lluviaMm:     Number.isFinite(rainMm) ? Number(rainMm.toFixed(1)) : 0,
    humedad:      Number.isFinite(humidity) ? Math.round(humidity) : null,
    nubosidad:    Number.isFinite(cloud) ? Math.round(cloud) : null,
    fuente:       "wttr.in",
    flags: { lluvia: isRain, viento: isWindy, frio: isCold, calor: isHot }
  };
}

async function getWeatherFromWttr(city, eventDateUtc) {
  if (!city) return null;
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
  const json = await fetchJson(url);
  if (!json) return null;
  return summarizeWttr(json, eventDateUtc);
}

// ───── API publica ───────────────────────────────────────────────────────

/**
 * Obtiene clima para una sede.
 * @param {string} city ciudad (ej. "London", "Bogota")
 * @param {string} country opcional, codigo ISO o nombre
 * @param {string|null} eventDateUtc ISO string, para elegir hora mas cercana
 */
export async function getWeather(city, country = "", eventDateUtc = null) {
  if (!city) return null;
  const key = `${city}|${country}|${eventDateUtc || ""}`.toLowerCase();
  const cached = _cache.get(key);
  if (cached && now() - cached.t < TTL_MS) return cached.v;

  // 1) OpenWeather (mas preciso, con coordenadas)
  let v = await getWeatherFromOwm(city, country, eventDateUtc);
  // 2) Fallback: wttr.in
  if (!v) v = await getWeatherFromWttr(city, eventDateUtc);
  _cache.set(key, { t: now(), v });
  return v;
}

export function sportNeedsWeather(sport, indoor = false) {
  if (indoor) return false;
  return sport === "futbol" || sport === "beisbol";
}
