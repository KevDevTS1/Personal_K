/**
 * Shared in-memory cache for ESPN + Odds + MLB feeds.
 * Stale-while-revalidate: always returns cached data instantly,
 * refreshes in background every TTL minutes.
 */
import { bogotaTodayKey } from "../utils/time.js";
import { getCalibrationStore } from "../model/calibration.js";
import { collectAllEvents } from "../picks/collector.js";

const TTL_MS = 12 * 60 * 1000; // 12 minutes

const _state = {
  dateKey:          null,
  feeds:            null,
  calibrationStore: null,
  fetchedAt:        null,
  inflight:         null,
};

function isFresh(dateKey) {
  return (
    _state.feeds &&
    _state.dateKey === dateKey &&
    _state.fetchedAt &&
    Date.now() - _state.fetchedAt < TTL_MS
  );
}

async function _doFetch(dateKey) {
  console.log(`[Cache] Refreshing feeds for ${dateKey}…`);
  const [calibrationStore, feeds] = await Promise.all([
    getCalibrationStore(dateKey),
    collectAllEvents(dateKey),
  ]);
  _state.dateKey          = dateKey;
  _state.feeds            = feeds;
  _state.calibrationStore = calibrationStore;
  _state.fetchedAt        = Date.now();
  _state.inflight         = null;
  console.log(`[Cache] Feeds ready — ${feeds.espnFeeds.length} ESPN feeds, oddsStore size ${feeds.oddsStore?.size ?? 0}`);
  return { feeds, calibrationStore };
}

/**
 * Returns { feeds, calibrationStore } from cache if fresh,
 * or waits for an in-flight fetch, or starts a new fetch.
 */
export async function getCachedFeeds(dateKey) {
  if (isFresh(dateKey)) {
    return { feeds: _state.feeds, calibrationStore: _state.calibrationStore };
  }
  if (_state.inflight) {
    return _state.inflight;
  }
  _state.inflight = _doFetch(dateKey);
  return _state.inflight;
}

/**
 * Fire-and-forget warmup. Call on server start so the first request is instant.
 */
export function warmup() {
  const dateKey = bogotaTodayKey(0);
  if (!isFresh(dateKey) && !_state.inflight) {
    _doFetch(dateKey).catch(err => console.error("[Cache] Warmup error:", err.message));
  }
}

/**
 * Background auto-refresh every TTL_MS.
 */
export function startAutoRefresh() {
  setInterval(() => {
    const dateKey = bogotaTodayKey(0);
    if (!isFresh(dateKey) && !_state.inflight) {
      _doFetch(dateKey).catch(err => console.error("[Cache] Auto-refresh error:", err.message));
    }
  }, TTL_MS);
}
