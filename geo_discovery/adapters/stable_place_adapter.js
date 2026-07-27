/**
 * GDE-03A — Adapter: stable service → ServicePlace (category boarding).
 * Lives outside Core domain interpretation.
 */
'use strict';

const { upsertServicePlace, ensureServicePlaces } = require('../query_engine');

const SERVICE_TYPE_STABLE = 'stable';
const CATEGORY_BOARDING = 'boarding';

function parseCoords(service) {
  const loc = service.location && typeof service.location === 'object' ? service.location : service;
  const lat = Number(loc.lat ?? loc.latitude ?? service.latitude);
  const lng = Number(loc.lng ?? loc.longitude ?? service.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function isStableService(service) {
  if (!service || typeof service !== 'object') return false;
  const t = String(service.type || service.serviceType || '').toLowerCase();
  return t === SERVICE_TYPE_STABLE || t === 'boarding' || t === 'إيواء';
}

/**
 * Map a stable service record into a ServicePlace upsert payload.
 */
function stableServiceToPlacePayload(service) {
  if (!isStableService(service)) return null;
  const coords = parseCoords(service);
  if (!coords) return null;

  const id = `place_boarding_${service.id}`;
  const species = Array.isArray(service.applicableSpecies)
    ? service.applicableSpecies.map(String)
    : service.species
      ? [String(service.species)]
      : [];

  const available = Number(service.availableSpaces);
  const availability =
    Number.isFinite(available) && available <= 0
      ? 'full'
      : service.openNow === false
        ? 'closed'
        : 'open_now';

  return {
    id,
    providerId: String(service.providerId || service.ownerId || ''),
    displayName: String(service.name || service.title || service.displayName || id),
    categories: [CATEGORY_BOARDING],
    location: {
      lat: coords.lat,
      lng: coords.lng,
      address: service.fullAddress || service.address || (service.location && service.location.address) || null,
    },
    verified: Boolean(service.verified || service.isVerified),
    rating: service.rating != null ? Number(service.rating) : null,
    reviewCount: service.reviewsCount != null ? Number(service.reviewsCount) : service.reviewCount || 0,
    availability,
    thumbnailUrl:
      service.imageUrl ||
      (Array.isArray(service.stableImages) && service.stableImages[0]) ||
      null,
    labels: { species },
    offeringsSummary: [
      {
        type: CATEGORY_BOARDING,
        title: 'إيواء',
        id: String(service.id),
      },
    ],
    sourceServiceId: String(service.id),
    vertical: {
      kind: CATEGORY_BOARDING,
      productType: SERVICE_TYPE_STABLE,
      totalSpaces: Number(service.totalSpaces) || null,
      availableSpaces: Number.isFinite(available) ? available : null,
      pricePerDay: service.pricePerDay != null ? Number(service.pricePerDay) : null,
      pricePerWeek: service.pricePerWeek != null ? Number(service.pricePerWeek) : null,
      pricePerMonth: service.pricePerMonth != null ? Number(service.pricePerMonth) : null,
      stableType: service.stableType || service.stableKind || null,
      features: Array.isArray(service.features) ? service.features.map(String) : [],
    },
    updatedAt: service.updatedAt || new Date().toISOString(),
  };
}

function syncStableServiceToPlaces(store, service) {
  ensureServicePlaces(store);
  const payload = stableServiceToPlacePayload(service);
  if (!payload) return { ok: false, skipped: true };
  return upsertServicePlace(store, payload);
}

function syncAllStableServices(store) {
  ensureServicePlaces(store);
  if (!store.services) return { synced: 0 };
  let synced = 0;
  for (const service of store.services.values()) {
    const r = syncStableServiceToPlaces(store, service);
    if (r.ok) synced += 1;
  }
  return { synced };
}

/**
 * Boarding verticalFilters (applied via extended FilterProvider).
 * Keys: minSpaces, maxPricePerDay, stableType
 */
function boardingVerticalMatches(place, verticalFilters = {}) {
  if (!verticalFilters || typeof verticalFilters !== 'object') return true;
  const v = place.vertical && place.vertical.kind === CATEGORY_BOARDING ? place.vertical : null;
  if (!v) {
    // Allow places without vertical bag (generic) unless filters require it
    const needs =
      verticalFilters.minSpaces != null ||
      verticalFilters.maxPricePerDay != null ||
      verticalFilters.stableType != null;
    return !needs;
  }

  if (verticalFilters.minSpaces != null) {
    const min = Number(verticalFilters.minSpaces);
    if (Number.isFinite(min) && Number(v.availableSpaces || 0) < min) return false;
  }
  if (verticalFilters.maxPricePerDay != null) {
    const max = Number(verticalFilters.maxPricePerDay);
    if (Number.isFinite(max) && v.pricePerDay != null && Number(v.pricePerDay) > max) {
      return false;
    }
  }
  if (verticalFilters.stableType != null && verticalFilters.stableType !== '') {
    if (String(v.stableType || '') !== String(verticalFilters.stableType)) return false;
  }
  return true;
}

module.exports = {
  SERVICE_TYPE_STABLE,
  CATEGORY_BOARDING,
  isStableService,
  stableServiceToPlacePayload,
  syncStableServiceToPlaces,
  syncAllStableServices,
  boardingVerticalMatches,
};
