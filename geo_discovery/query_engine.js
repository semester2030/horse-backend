/**
 * GDE-02 — Geo Query Engine
 * Viewport-bounded lookup via GeoIndexProvider + point-in-bbox.
 * Never returns an unbounded catalog.
 */
'use strict';

const { normalizeServicePlace, pointInBBox } = require('./models');

function ensureServicePlaces(store) {
  if (!store.servicePlaces) store.servicePlaces = new Map();
  return store.servicePlaces;
}

function listNormalizedPlaces(store) {
  const map = ensureServicePlaces(store);
  const out = [];
  for (const raw of map.values()) {
    const place = normalizeServicePlace(raw);
    if (place) out.push(place);
  }
  return out;
}

/**
 * Query places inside bbox. Optional cell prefilter via geoIndex.
 */
function queryPlacesInViewport({ store, bbox, geoIndex, zoom }) {
  const all = listNormalizedPlaces(store);
  let candidates = all;

  if (geoIndex && typeof geoIndex.cellsForBBox === 'function') {
    const cells = new Set(geoIndex.cellsForBBox(bbox, zoom));
    // Precision used for encoding places should match zoom precision.
    const precision =
      typeof geoIndex.precisionForZoom === 'function'
        ? geoIndex.precisionForZoom(zoom)
        : 6;
    candidates = all.filter((p) => {
      const cell = geoIndex.encode(p.location.lat, p.location.lng, precision);
      if (cells.has(cell)) return true;
      // Safety: still include if point is in bbox (cell sampling may miss edges).
      return pointInBBox(p.location.lat, p.location.lng, bbox);
    });
  }

  return candidates.filter((p) =>
    pointInBBox(p.location.lat, p.location.lng, bbox),
  );
}

function getPlaceById(store, placeId) {
  const map = ensureServicePlaces(store);
  const raw = map.get(String(placeId));
  return normalizeServicePlace(raw);
}

function upsertServicePlace(store, raw, idFn) {
  const map = ensureServicePlaces(store);
  const place = normalizeServicePlace({
    ...raw,
    id: raw.id || (idFn ? idFn() : null),
  });
  if (!place) {
    return { ok: false, status: 400, message: 'ServicePlace غير صالح (id + location مطلوبان)' };
  }
  const existing = map.get(place.id);
  const record = {
    ...(existing || {}),
    ...raw,
    id: place.id,
    location: place.location,
    categories: place.categories,
    updatedAt: new Date().toISOString(),
    generation: place.generation || (existing && existing.generation) || '1',
  };
  map.set(place.id, record);
  return { ok: true, place: normalizeServicePlace(record) };
}

module.exports = {
  ensureServicePlaces,
  listNormalizedPlaces,
  queryPlacesInViewport,
  getPlaceById,
  upsertServicePlace,
};
