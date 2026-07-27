/**
 * Matching Engine (T3) — deterministic pipeline for TransportRequest providers.
 * Stages (in order): status → species → provider type → location → availability
 * → capacity (via availability) → radius expand → rank.
 * No ML. No negotiation. No mock providers.
 */
'use strict';

const bookingOccupancy = require('./booking_occupancy');
const availability = require('./availability_engine');

/** Search radii in km — expand until match or max. */
const SEARCH_RADII_KM = [25, 50, 100, 200, 500];
const AVG_SPEED_KMH = 40;

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

function parseLatLng(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const lat = Number(obj.latitude ?? obj.lat);
  const lng = Number(obj.longitude ?? obj.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { latitude: lat, longitude: lng };
}

function extractServiceCoords(service) {
  if (!service || typeof service !== 'object') return null;
  if (service.location) {
    const fromLoc = parseLatLng(service.location);
    if (fromLoc) return fromLoc;
  }
  return parseLatLng({
    latitude: service.latitude,
    longitude: service.longitude,
  });
}

function speciesCompatible(service, animalType) {
  const apps = service.applicableSpecies;
  if (apps == null || (Array.isArray(apps) && apps.length === 0)) return true;
  const sp = String(animalType).toLowerCase();
  if (Array.isArray(apps)) {
    return apps
      .map(String)
      .map((s) => s.toLowerCase())
      .some((s) => s === sp || s === 'all');
  }
  const one = String(apps).toLowerCase();
  return one === sp || one === 'all';
}

function supportedAnimalTypesOf(service) {
  const apps = service.applicableSpecies;
  if (Array.isArray(apps) && apps.length > 0) return apps.map(String);
  if (apps != null && apps !== '') return [String(apps)];
  return [];
}

function classifyProviderType(service, user) {
  const explicit = String(
    service.providerType || service.companyType || user?.providerType || '',
  )
    .trim()
    .toLowerCase();
  if (explicit === 'company' || explicit === 'individual') return explicit;
  if (service.companyId || service.companyName || service.companyLogoUrl) {
    return 'company';
  }
  if (user && (user.companyId || user.companyName)) return 'company';
  return 'individual';
}

function matchesProviderPreference(providerType, pref) {
  if (!pref || pref === 'any') return true;
  return providerType === pref;
}

function vehicleImageUrl(service) {
  const imgs = service.vehicleImages;
  if (Array.isArray(imgs) && imgs.length > 0) {
    const first = imgs[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object' && first.url) return String(first.url);
  }
  if (typeof service.imageUrl === 'string' && service.imageUrl.trim()) {
    return service.imageUrl.trim();
  }
  return null;
}

function estimatedArrivalMinutes(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;
  const mins = Math.max(5, Math.round((distanceKm / AVG_SPEED_KMH) * 60));
  return mins;
}

function buildMatchingReason({ stages, distanceKm, availStatus, verified }) {
  const parts = [];
  parts.push('species_ok');
  parts.push('type_ok');
  if (Number.isFinite(distanceKm)) {
    parts.push(`distance_${distanceKm.toFixed(1)}km`);
  }
  parts.push(`availability_${availStatus}`);
  if (verified) parts.push('verified');
  if (stages.includes('radius_expanded')) parts.push('radius_expanded');
  return parts.join('|');
}

/**
 * Single-pass candidate scan (no N+1): services + users + bookings already in memory Maps.
 */
function collectCandidates(store, request) {
  const pickup = request.pickup || {};
  const pickupLat = Number(pickup.latitude);
  const pickupLng = Number(pickup.longitude);
  const hasPickup =
    Number.isFinite(pickupLat) &&
    Number.isFinite(pickupLng) &&
    !(pickupLat === 0 && pickupLng === 0);

  const services = [...store.services.values()];
  const candidates = [];
  const rejectStats = {
    not_transportation: 0,
    inactive: 0,
    deleted: 0,
    species: 0,
    provider_type: 0,
    location: 0,
    availability: 0,
    capacity: 0,
  };

  for (const service of services) {
    // Stage 1 — Provider Status
    if (availability.isDeleted(service)) {
      rejectStats.deleted += 1;
      continue;
    }
    if (!availability.isTransportation(service)) {
      rejectStats.not_transportation += 1;
      continue;
    }
    if (availability.isSuspendedOrInactive(service)) {
      rejectStats.inactive += 1;
      continue;
    }

    // Stage 2 — Species
    if (!speciesCompatible(service, request.animalType)) {
      rejectStats.species += 1;
      continue;
    }

    const user = store.users.get(String(service.providerId || ''));
    const providerType = classifyProviderType(service, user);

    // Stage 3 — Provider type preference
    if (!matchesProviderPreference(providerType, request.providerPreference)) {
      rejectStats.provider_type += 1;
      continue;
    }

    // Stage 4 — Location
    const coords = extractServiceCoords(service);
    if (!coords) {
      rejectStats.location += 1;
      continue;
    }

    const distanceKm = hasPickup
      ? haversineKm(pickupLat, pickupLng, coords.latitude, coords.longitude)
      : null;

    // Stage 5 — Availability Engine (includes capacity + journey conflict + hours)
    const avail = availability.evaluateAvailability({
      store,
      service,
      user,
      request,
    });
    if (!avail.eligible) {
      if (
        avail.reasons.some((r) => String(r).startsWith('capacity'))
      ) {
        rejectStats.capacity += 1;
      } else {
        rejectStats.availability += 1;
      }
      continue;
    }

    const capacity = bookingOccupancy.fleetCapacity(service);
    const vehicles = Number(service.numberOfVehicles ?? service.fleetSize ?? 0);
    const ratingRaw = service.rating ?? user?.rating;
    const rating =
      ratingRaw != null && Number.isFinite(Number(ratingRaw))
        ? Number(ratingRaw)
        : null;
    const verified = Boolean(
      service.verified ||
        service.isVerified ||
        user?.merchantVerified ||
        user?.isVerified,
    );

    const company =
      providerType === 'company'
        ? {
            companyId: service.companyId || user?.companyId || null,
            companyName:
              service.companyName ||
              user?.companyName ||
              service.name ||
              null,
            companyLogoUrl:
              service.companyLogoUrl ||
              service.logoUrl ||
              user?.companyLogoUrl ||
              null,
          }
        : {
            companyId: null,
            companyName: null,
            companyLogoUrl: null,
          };

    candidates.push({
      service,
      user,
      providerType,
      coords,
      distanceKm,
      avail,
      capacity: capacity > 0 ? capacity : null,
      fleetCount:
        providerType === 'company' && Number.isFinite(vehicles) && vehicles > 0
          ? Math.floor(vehicles)
          : null,
      rating,
      verified,
      company,
    });
  }

  return { candidates, rejectStats, hasPickup };
}

function filterByRadius(candidates, radiusKm) {
  return candidates.filter((c) => {
    if (c.distanceKm == null) return true; // no pickup — keep (edge)
    return c.distanceKm <= radiusKm;
  });
}

/**
 * Deterministic ranking:
 * 1. nearest
 * 2. available status
 * 3. higher rating
 * 4. verified
 * 5. company/fleet preference
 */
function rankCandidates(candidates, request) {
  const pref = String(request.providerPreference || 'any');
  return [...candidates].sort((a, b) => {
    const da = a.distanceKm == null ? Number.POSITIVE_INFINITY : a.distanceKm;
    const db = b.distanceKm == null ? Number.POSITIVE_INFINITY : b.distanceKm;
    if (da !== db) return da - db;

    const availScore = (x) =>
      x.avail.status === 'available' ? 2 : x.avail.status === 'unknown' ? 1 : 0;
    const as = availScore(a);
    const bs = availScore(b);
    if (as !== bs) return bs - as;

    const ra = a.rating == null ? -1 : a.rating;
    const rb = b.rating == null ? -1 : b.rating;
    if (ra !== rb) return rb - ra;

    if (a.verified !== b.verified) return a.verified ? -1 : 1;

    if (pref === 'company') {
      if (a.providerType !== b.providerType) {
        return a.providerType === 'company' ? -1 : 1;
      }
      const fa = a.fleetCount || 0;
      const fb = b.fleetCount || 0;
      if (fa !== fb) return fb - fa;
    } else if (pref === 'individual') {
      if (a.providerType !== b.providerType) {
        return a.providerType === 'individual' ? -1 : 1;
      }
    } else {
      // any: slight fleet preference as tie-breaker when both company
      const fa = a.fleetCount || 0;
      const fb = b.fleetCount || 0;
      if (fa !== fb) return fb - fa;
    }

    return String(a.service.id).localeCompare(String(b.service.id));
  });
}

function toMatchedProvider(c, { radiusExpanded }) {
  const distanceKm =
    c.distanceKm == null ? null : Math.round(c.distanceKm * 10) / 10;
  const stages = radiusExpanded ? ['radius_expanded'] : [];
  return {
    providerId: String(c.service.providerId || ''),
    serviceId: String(c.service.id || ''),
    providerType: c.providerType,
    displayName:
      c.providerType === 'company'
        ? c.company.companyName || c.service.name || 'شركة نقل'
        : c.service.name ||
          c.user?.displayName ||
          c.user?.name ||
          'مقدم نقل',
    companyId: c.company.companyId,
    companyName: c.company.companyName,
    companyLogoUrl: c.company.companyLogoUrl,
    vehicleId: null,
    vehicleName: Array.isArray(c.service.vehicleTypes)
      ? c.service.vehicleTypes[0] || null
      : c.service.vehicleTypes || null,
    vehicleModel: null,
    vehicleImageUrl: vehicleImageUrl(c.service),
    latitude: c.coords.latitude,
    longitude: c.coords.longitude,
    distanceKm,
    estimatedArrivalMinutes: estimatedArrivalMinutes(c.distanceKm),
    supportedAnimalTypes: supportedAnimalTypesOf(c.service),
    capacity: c.capacity,
    fleetCount: c.fleetCount,
    availability: c.avail.status,
    rating: c.rating,
    verified: c.verified,
    matchingReason: buildMatchingReason({
      stages,
      distanceKm: c.distanceKm,
      availStatus: c.avail.status,
      verified: c.verified,
    }),
  };
}

/**
 * Run matching for a TransportRequest.
 * @returns matching payload for GET …/providers
 */
function matchProvidersForRequest(store, request, options = {}) {
  const radii = options.radiiKm || SEARCH_RADII_KM;
  const { candidates, rejectStats, hasPickup } = collectCandidates(
    store,
    request,
  );

  let selected = [];
  let usedRadiusKm = null;
  let radiusExpanded = false;
  let radiusSteps = [];

  if (!hasPickup) {
    selected = candidates;
    usedRadiusKm = null;
  } else {
    for (let i = 0; i < radii.length; i += 1) {
      const r = radii[i];
      const inRadius = filterByRadius(candidates, r);
      radiusSteps.push({ radiusKm: r, count: inRadius.length });
      if (inRadius.length > 0) {
        selected = inRadius;
        usedRadiusKm = r;
        radiusExpanded = i > 0;
        break;
      }
    }
    if (selected.length === 0) {
      usedRadiusKm = radii[radii.length - 1];
      radiusExpanded = radii.length > 1;
    }
  }

  const ranked = rankCandidates(selected, request);
  const providers = ranked.map((c) =>
    toMatchedProvider(c, { radiusExpanded }),
  );

  return {
    requestId: request.id,
    generatedAt: new Date().toISOString(),
    matchingStatus:
      providers.length === 0 ? 'no_match' : 'matched',
    matchingVersion: 't3.1',
    searchRadiusKm: usedRadiusKm,
    radiusExpanded,
    radiusSteps,
    rejectStats,
    providers,
  };
}

module.exports = {
  matchProvidersForRequest,
  haversineKm,
  rankCandidates,
  SEARCH_RADII_KM,
  extractServiceCoords,
  parseLatLng,
  speciesCompatible,
  classifyProviderType,
};
