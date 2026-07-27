/**
 * GDE-02 — Viewport Engine
 * Validates bbox/zoom and decides places vs clusters mode.
 */
'use strict';

const {
  CLUSTER_ZOOM_THRESHOLD,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} = require('./constants');
const { parseBBox, bboxCenter } = require('./models');

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_LIMIT;
  const rounded = Math.floor(n);
  if (rounded < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, rounded));
}

/**
 * @param {object} input
 * @returns {{ ok:true, viewport:object } | { ok:false, status:number, message:string }}
 */
function normalizeViewportRequest(input = {}) {
  const bbox = parseBBox(input.bbox);
  if (!bbox) {
    return { ok: false, status: 400, message: 'bbox مطلوب: { sw, ne }' };
  }

  const zoom = Number(input.zoom);
  if (!Number.isFinite(zoom) || zoom < 0 || zoom > 22) {
    return { ok: false, status: 400, message: 'zoom مطلوب (0–22)' };
  }

  const limit = clampLimit(input.limit);
  const cursor = input.cursor != null && input.cursor !== '' ? String(input.cursor) : null;
  const preferredMode =
    input.mode === 'clusters' || input.mode === 'places' ? input.mode : 'auto';

  let mode = preferredMode;
  if (mode === 'auto') {
    mode = zoom < CLUSTER_ZOOM_THRESHOLD ? 'clusters' : 'places';
  }

  return {
    ok: true,
    viewport: {
      bbox,
      zoom,
      limit,
      cursor,
      mode,
      center: bboxCenter(bbox),
      category: input.category != null ? String(input.category) : null,
      filters: input.filters && typeof input.filters === 'object' ? input.filters : {},
      verticalFilters:
        input.verticalFilters && typeof input.verticalFilters === 'object'
          ? input.verticalFilters
          : {},
      includeScoreBreakdown: Boolean(input.includeScoreBreakdown),
    },
  };
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    const o = Number(parsed.o);
    return Number.isFinite(o) && o >= 0 ? Math.floor(o) : 0;
  } catch {
    return 0;
  }
}

module.exports = {
  normalizeViewportRequest,
  clampLimit,
  encodeCursor,
  decodeCursor,
  CLUSTER_ZOOM_THRESHOLD,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
};
