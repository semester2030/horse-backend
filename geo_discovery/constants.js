/**
 * GDE-02 — Geo Discovery Core constants (frozen budgets from GDE-01).
 * No vertical business logic.
 */
'use strict';

/** Shared discovery category keys — filter dimension only, not vertical models. */
const CORE_CATEGORIES = Object.freeze([
  'boarding',
  'training',
  'veterinary',
  'feed',
  'equipment',
]);

const RANKING_VERSION = 'v1';

const DEFAULT_PAGE_LIMIT = 40;
const MIN_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

/** Preferred visible individual markers on phone (UX budget). */
const PREFERRED_VISIBLE_MARKERS = 40;
const PREFERRED_VISIBLE_MARKERS_MIN = 20;

/** Zoom below this → prefer cluster mode when client asks hybrid. */
const CLUSTER_ZOOM_THRESHOLD = 13;

/** Default geohash precision for place cells. */
const DEFAULT_CELL_PRECISION = 6;

/** In-memory query cache TTL (ms). */
const QUERY_CACHE_TTL_MS = 45_000;
const PLACE_DETAIL_CACHE_TTL_MS = 180_000;

/** Soft debounce hint for clients (documented). */
const CAMERA_IDLE_DEBOUNCE_MS = 300;

/** Prefer clusters earlier when place density is high. */
const DENSITY_CLUSTER_TRIGGER = 35;

module.exports = {
  CORE_CATEGORIES,
  RANKING_VERSION,
  DEFAULT_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PREFERRED_VISIBLE_MARKERS,
  PREFERRED_VISIBLE_MARKERS_MIN,
  CLUSTER_ZOOM_THRESHOLD,
  DEFAULT_CELL_PRECISION,
  QUERY_CACHE_TTL_MS,
  PLACE_DETAIL_CACHE_TTL_MS,
  CAMERA_IDLE_DEBOUNCE_MS,
  DENSITY_CLUSTER_TRIGGER,
};
