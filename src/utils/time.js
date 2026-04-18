import { BOGOTA_TZ } from "../config/leagues.js";

export function bogotaDayKey(dateIso) {
  if (!dateIso) return "";
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: BOGOTA_TZ,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function bogotaTodayKey(offset = 0) {
  const base = bogotaDayKey(new Date().toISOString());
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
}

export function addDaysToIsoDate(baseIso, offsetDays) {
  const [y, m, d] = baseIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}

export function rangeKeysInBogota(daysBefore = 3, daysAfter = 3, baseDateKey = null) {
  const keys = [];
  const anchor = baseDateKey || bogotaTodayKey(0);
  for (let i = -daysBefore; i <= daysAfter; i++) {
    keys.push(addDaysToIsoDate(anchor, i));
  }
  return keys;
}

export function parseSportsDbDate(raw) {
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
