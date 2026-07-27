/**
 * GDE-02 — Shared Geo Discovery models (generic ServicePlace only).
 */
'use strict';

const { CORE_CATEGORIES } = require('./constants');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseLatLng(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const lat = num(obj.lat ?? obj.latitude);
  const lng = num(obj.lng ?? obj.longitude);
  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Normalize a ServicePlace record for discovery.
 * Rejects transport / marketplace shapes silently by requiring location + id.
 */
function normalizeServicePlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id != null ? String(raw.id) : '';
  if (!id) return null;
  const locSrc = raw.location && typeof raw.location === 'object' ? raw.location : raw;
  const coords = parseLatLng(locSrc);
  if (!coords) return null;

  const categories = Array.isArray(raw.categories)
    ? raw.categories.map(String).filter((c) => CORE_CATEGORIES.includes(c))
    : [];

  const labels =
    raw.labels && typeof raw.labels === 'object' ? { ...raw.labels } : {};
  if (Array.isArray(labels.species)) {
    labels.species = labels.species.map(String);
  }

  const offeringsSummary = Array.isArray(raw.offeringsSummary)
    ? raw.offeringsSummary
        .filter((o) => o && typeof o === 'object')
        .map((o) => ({
          type: o.type != null ? String(o.type) : '',
          title: o.title != null ? String(o.title) : '',
          id: o.id != null ? String(o.id) : undefined,
        }))
        .filter((o) => o.type)
    : [];

  return {
    id,
    providerId: raw.providerId != null ? String(raw.providerId) : '',
    displayName: raw.displayName != null ? String(raw.displayName) : id,
    categories,
    location: {
      lat: coords.lat,
      lng: coords.lng,
      address: locSrc.address != null ? String(locSrc.address) : raw.address != null ? String(raw.address) : null,
    },
    verified: Boolean(raw.verified),
    rating: num(raw.rating),
    reviewCount: num(raw.reviewCount) ?? 0,
    availability: raw.availability != null ? String(raw.availability) : 'unknown',
    thumbnailUrl: raw.thumbnailUrl != null ? String(raw.thumbnailUrl) : null,
    labels,
    offeringsSummary,
    updatedAt: raw.updatedAt != null ? String(raw.updatedAt) : null,
    generation: raw.generation != null ? String(raw.generation) : null,
    // Opaque vertical bag — Core does not interpret keys.
    vertical:
      raw.vertical && typeof raw.vertical === 'object' ? { ...raw.vertical } : undefined,
    sourceServiceId:
      raw.sourceServiceId != null ? String(raw.sourceServiceId) : undefined,
  };
}

function toDiscoveryCard(place, extras = {}) {
  return {
    id: place.id,
    providerId: place.providerId,
    displayName: place.displayName,
    categories: place.categories,
    location: {
      lat: place.location.lat,
      lng: place.location.lng,
      address: place.location.address,
    },
    verified: place.verified,
    rating: place.rating,
    reviewCount: place.reviewCount,
    availability: place.availability,
    thumbnailUrl: place.thumbnailUrl,
    labels: place.labels,
    offeringsSummary: place.offeringsSummary,
    ...(place.vertical ? { vertical: place.vertical } : {}),
    ...(place.sourceServiceId ? { sourceServiceId: place.sourceServiceId } : {}),
    ...(extras.score != null ? { score: extras.score } : {}),
    ...(extras.scoreBreakdown ? { scoreBreakdown: extras.scoreBreakdown } : {}),
    ...(extras.distanceKm != null ? { distanceKm: extras.distanceKm } : {}),
  };
}

function parseBBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let sw;
  let ne;
  if (Array.isArray(raw.sw) && Array.isArray(raw.ne)) {
    sw = { lat: num(raw.sw[0]), lng: num(raw.sw[1]) };
    ne = { lat: num(raw.ne[0]), lng: num(raw.ne[1]) };
  } else {
    sw = parseLatLng(raw.sw);
    ne = parseLatLng(raw.ne);
  }
  if (!sw || !ne) return null;
  if (sw.lat > ne.lat) {
    const t = sw.lat;
    sw = { lat: ne.lat, lng: sw.lng };
    ne = { lat: t, lng: ne.lng };
  }
  // Handle antimeridian loosely: require west < east for v1.
  if (sw.lng > ne.lng) return null;
  return { sw, ne };
}

function bboxCenter(bbox) {
  return {
    lat: (bbox.sw.lat + bbox.ne.lat) / 2,
    lng: (bbox.sw.lng + bbox.ne.lng) / 2,
  };
}

function pointInBBox(lat, lng, bbox) {
  return (
    lat >= bbox.sw.lat &&
    lat <= bbox.ne.lat &&
    lng >= bbox.sw.lng &&
    lng <= bbox.ne.lng
  );
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = {
  parseLatLng,
  normalizeServicePlace,
  toDiscoveryCard,
  parseBBox,
  bboxCenter,
  pointInBBox,
  haversineKm,
};
