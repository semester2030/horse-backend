/**
 * Generic service → ServicePlace sync for training/veterinary/feed/equipment.
 */
'use strict';

const { upsertServicePlace, ensureServicePlaces } = require('../query_engine');

const TYPE_TO_CATEGORY = {
  training: 'training',
  trainer: 'training',
  veterinary: 'veterinary',
  vet: 'veterinary',
  feed: 'feed',
  equipment: 'equipment',
  supplies: 'equipment',
};

function resolveCategory(service) {
  const t = String(service.type || service.serviceType || '').toLowerCase();
  return TYPE_TO_CATEGORY[t] || null;
}

function parseCoords(service) {
  const loc = service.location && typeof service.location === 'object' ? service.location : service;
  const lat = Number(loc.lat ?? loc.latitude ?? service.latitude);
  const lng = Number(loc.lng ?? loc.longitude ?? service.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function serviceToPlacePayload(service) {
  const category = resolveCategory(service);
  if (!category) return null;
  const coords = parseCoords(service);
  if (!coords) return null;
  const id = `place_${category}_${service.id}`;
  return {
    id,
    providerId: String(service.providerId || ''),
    displayName: String(service.name || service.title || id),
    categories: [category],
    location: {
      lat: coords.lat,
      lng: coords.lng,
      address: service.fullAddress || service.address || null,
    },
    verified: Boolean(service.verified || service.isVerified),
    rating: service.rating != null ? Number(service.rating) : null,
    reviewCount: Number(service.reviewsCount || service.reviewCount || 0),
    availability: service.openNow === false ? 'closed' : 'open_now',
    thumbnailUrl: service.imageUrl || null,
    labels: {
      species: Array.isArray(service.applicableSpecies)
        ? service.applicableSpecies.map(String)
        : [],
    },
    offeringsSummary: [
      { type: category, title: service.name || category, id: String(service.id) },
    ],
    sourceServiceId: String(service.id),
    vertical: {
      kind: category,
      productType: String(service.type || category),
      homeVisit: Boolean(service.homeVisit),
      emergency: Boolean(service.emergency || service.emergencyAvailable),
      programs: Array.isArray(service.programs) ? service.programs : [],
      trainers: Array.isArray(service.trainers) ? service.trainers : [],
      sessions: Array.isArray(service.sessions) ? service.sessions : [],
      services: Array.isArray(service.services) ? service.services : [],
      doctors: Array.isArray(service.doctors)
        ? service.doctors
        : Array.isArray(service.veterinarians)
          ? service.veterinarians
          : [],
      clinicHours: service.clinicHours || service.hours || null,
      availableDates: Array.isArray(service.availableDates)
        ? service.availableDates
        : [],
      availableSlots: Array.isArray(service.availableSlots)
        ? service.availableSlots
        : Array.isArray(service.timeSlots)
          ? service.timeSlots
          : [],
      closedDates: Array.isArray(service.closedDates)
        ? service.closedDates
        : [],
      bookedSlots: Array.isArray(service.bookedSlots) ? service.bookedSlots : [],
      mobileCoverageKm:
        service.mobileCoverageKm != null
          ? Number(service.mobileCoverageKm)
          : service.coverageKm != null
            ? Number(service.coverageKm)
            : null,
      features: Array.isArray(service.features)
        ? service.features
        : Array.isArray(service.amenities)
          ? service.amenities
          : [],
      rental: Boolean(service.rental || category === 'equipment'),
      commercialMode: service.commercialMode || service.offerType || null,
      // Feed / nutrition catalog fields (Feed vertical owned on client)
      products: Array.isArray(service.products)
        ? service.products
        : Array.isArray(service.catalog) && category === 'feed'
          ? service.catalog
          : [],
      // Equipment inventory — each item carries commercialMode: sale | rental | sale_or_rental
      inventory: (() => {
        const inv = Array.isArray(service.inventory)
          ? service.inventory
          : Array.isArray(service.equipment)
            ? service.equipment
            : Array.isArray(service.items)
              ? service.items
              : Array.isArray(service.catalog) && category === 'equipment'
                ? service.catalog
                : [];
        return inv.map((item) => {
          if (!item || typeof item !== 'object') return item;
          if (item.commercialMode) return item;
          const raw = String(
            item.offerType ||
              item.listingMode ||
              service.commercialMode ||
              '',
          )
            .trim()
            .toLowerCase();
          let commercialMode = 'rental';
          if (['sale', 'sell', 'purchase', 'buy'].includes(raw)) {
            commercialMode = 'sale';
          } else if (
            ['sale_or_rental', 'both', 'sale_and_rental', 'hybrid'].includes(
              raw,
            )
          ) {
            commercialMode = 'sale_or_rental';
          } else if (['rental', 'rent', 'lease'].includes(raw)) {
            commercialMode = 'rental';
          } else if (
            item.rental === false &&
            (item.sale === true || item.forSale === true)
          ) {
            commercialMode = 'sale';
          } else if (category !== 'equipment') {
            return item;
          }
          return { ...item, commercialMode };
        });
      })(),
      depositPolicy: service.depositPolicy || null,
      returnInstructions: service.returnInstructions || null,
      lateReturnPolicy: service.lateReturnPolicy || null,
      delivery: service.delivery !== false && service.deliveryAvailable !== false,
      deliveryAvailable: service.deliveryAvailable !== false && service.delivery !== false,
      pickup: service.pickup !== false && service.pickupAvailable !== false,
      pickupAvailable: service.pickupAvailable !== false && service.pickup !== false,
      deliveryFee:
        service.deliveryFee != null ? Number(service.deliveryFee) : 0,
      minimumOrder:
        service.minimumOrder != null
          ? Number(service.minimumOrder)
          : service.minimumOrderAmount != null
            ? Number(service.minimumOrderAmount)
            : null,
      deliveryCoverage: Array.isArray(service.deliveryCoverage)
        ? service.deliveryCoverage
        : Array.isArray(service.deliveryAreas)
          ? service.deliveryAreas
          : service.coverage != null
            ? service.coverage
            : null,
      hours: service.hours || service.workingHours || service.clinicHours || null,
      pickupInstructions: service.pickupInstructions || null,
    },
    updatedAt: service.updatedAt || new Date().toISOString(),
  };
}

function syncServiceToPlaces(store, service) {
  ensureServicePlaces(store);
  const payload = serviceToPlacePayload(service);
  if (!payload) return { ok: false, skipped: true };
  return upsertServicePlace(store, payload);
}

function syncAllCategorizedServices(store) {
  ensureServicePlaces(store);
  let synced = 0;
  if (!store.services) return { synced };
  for (const service of store.services.values()) {
    const r = syncServiceToPlaces(store, service);
    if (r.ok) synced += 1;
  }
  return { synced };
}

module.exports = {
  TYPE_TO_CATEGORY,
  resolveCategory,
  serviceToPlacePayload,
  syncServiceToPlaces,
  syncAllCategorizedServices,
};
