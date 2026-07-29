/**
 * Catalog items (feed / equipment / supplies) → ServicePlace for geo map.
 */
'use strict';

const { upsertServicePlace, ensureServicePlaces } = require('../query_engine');

function resolveCatalogCategory(item) {
  const c = String(item.category || '').toLowerCase();
  if (c === 'feed') return 'feed';
  if (c === 'equipment' || c === 'supplies') return 'equipment';
  return null;
}

function parseCoords(item) {
  const loc = item.location && typeof item.location === 'object' ? item.location : item;
  const lat = Number(loc.lat ?? loc.latitude ?? item.latitude);
  const lng = Number(loc.lng ?? loc.longitude ?? item.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function catalogItemToPlacePayload(item) {
  if (!item || typeof item !== 'object') return null;
  const status = String(item.status || 'active').toLowerCase();
  if (status === 'inactive' || status === 'deleted' || status === 'removed') {
    return null;
  }
  const category = resolveCatalogCategory(item);
  if (!category) return null;
  const coords = parseCoords(item);
  if (!coords) return null;

  const id = `place_${category}_catalog_${item.id}`;
  const species = Array.isArray(item.applicableSpecies)
    ? item.applicableSpecies.map(String)
    : [];

  return {
    id,
    providerId: String(item.sellerId || item.providerId || ''),
    displayName: String(item.name || item.title || id),
    categories: [category],
    location: {
      lat: coords.lat,
      lng: coords.lng,
      address: (item.location && item.location.city) || item.city || item.address || null,
    },
    verified: Boolean(item.verified || item.isVerified),
    rating: item.rating != null ? Number(item.rating) : null,
    reviewCount: Number(item.reviewsCount || item.reviewCount || 0),
    availability: item.inStock === false ? 'closed' : 'open_now',
    thumbnailUrl:
      (Array.isArray(item.images) && item.images[0]) || item.imageUrl || null,
    labels: { species },
    offeringsSummary: [
      {
        type: category,
        title: String(item.name || category),
        id: String(item.id),
      },
    ],
    sourceServiceId: `catalog_${item.id}`,
    sourceCatalogItemId: String(item.id),
    vertical: {
      kind: category,
      productType: String(item.category || category),
      price: item.price != null ? Number(item.price) : null,
      unit: item.unit || null,
      commercialMode: 'sale',
      products: category === 'feed' ? [item] : [],
      inventory: category === 'equipment' ? [item] : [],
    },
    updatedAt: item.updatedAt || new Date().toISOString(),
  };
}

function syncCatalogItemToPlaces(store, item) {
  ensureServicePlaces(store);
  const payload = catalogItemToPlacePayload(item);
  if (!payload) return { ok: false, skipped: true };
  return upsertServicePlace(store, payload);
}

function removeCatalogItemPlace(store, itemId) {
  ensureServicePlaces(store);
  const map = store.servicePlaces;
  let removed = 0;
  const sid = String(itemId);
  for (const [id, raw] of [...map.entries()]) {
    if (
      String(raw.sourceCatalogItemId || '') === sid ||
      String(raw.sourceServiceId || '') === `catalog_${sid}` ||
      id === `place_feed_catalog_${sid}` ||
      id === `place_equipment_catalog_${sid}`
    ) {
      map.delete(id);
      removed += 1;
    }
  }
  return { removed };
}

function syncAllCatalogItems(store) {
  ensureServicePlaces(store);
  let synced = 0;
  if (!store.catalogItems) return { synced };
  for (const item of store.catalogItems.values()) {
    const r = syncCatalogItemToPlaces(store, item);
    if (r.ok) synced += 1;
  }
  return { synced };
}

module.exports = {
  catalogItemToPlacePayload,
  syncCatalogItemToPlaces,
  syncAllCatalogItems,
  removeCatalogItemPlace,
};
