/**
 * GDE-02 / GDE-08 — Cluster Engine (hybrid-ready).
 */
'use strict';

const {
  PREFERRED_VISIBLE_MARKERS,
  CLUSTER_ZOOM_THRESHOLD,
  DENSITY_CLUSTER_TRIGGER,
} = require('./constants');

function buildClusters(places, { geoIndex, zoom, category } = {}) {
  if (!geoIndex || typeof geoIndex.clusterKey !== 'function') {
    throw new Error('geoIndex.clusterKey required');
  }
  const buckets = new Map();

  for (const place of places) {
    const cell = geoIndex.encode(place.location.lat, place.location.lng);
    const key = geoIndex.clusterKey(cell, zoom);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        id: key,
        count: 0,
        latSum: 0,
        lngSum: 0,
        categories: new Set(),
        samplePlaceIds: [],
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.latSum += place.location.lat;
    bucket.lngSum += place.location.lng;
    for (const c of place.categories || []) bucket.categories.add(c);
    if (bucket.samplePlaceIds.length < 3) {
      bucket.samplePlaceIds.push(place.id);
    }
  }

  return [...buckets.values()].map((b) => ({
    id: b.id,
    count: b.count,
    center: {
      lat: b.latSum / b.count,
      lng: b.lngSum / b.count,
    },
    categories: [...b.categories].sort(),
    samplePlaceIds: b.samplePlaceIds,
    ...(category ? { category } : {}),
  }));
}

function resolveRenderMode({ requestedMode, zoom, placeCount }) {
  if (requestedMode === 'clusters') return 'clusters';
  if (requestedMode === 'places') {
    const densityTrigger = DENSITY_CLUSTER_TRIGGER || PREFERRED_VISIBLE_MARKERS;
    if (placeCount > densityTrigger && zoom < CLUSTER_ZOOM_THRESHOLD + 2) {
      return 'clusters';
    }
    return 'places';
  }
  return requestedMode === 'clusters' ? 'clusters' : 'places';
}

module.exports = {
  buildClusters,
  resolveRenderMode,
};
