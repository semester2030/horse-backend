/**
 * Transport requests (T2 create + T3 matching).
 * Dedicated RFQ resource: bookings still require serviceId at creation (ADR-014).
 */
'use strict';

const matchingEngine = require('./matching_engine');

const ALLOWED_ANIMALS = new Set(['camel', 'horse', 'falcon']);
const ALLOWED_TIMING = new Set(['immediate', 'scheduled']);
const ALLOWED_TRIP = new Set(['oneWay', 'roundTrip']);
const ALLOWED_PREF = new Set(['any', 'individual', 'company']);

function parseLatLng(obj) {
  return matchingEngine.parseLatLng(obj);
}

function extractServiceCoords(service) {
  return matchingEngine.extractServiceCoords(service);
}

/**
 * @returns {{ ok: true, request: object } | { ok: false, status: number, message: string }}
 */
function createTransportRequest({ store, userId, body, idFn, nowIso }) {
  const src = body && typeof body === 'object' ? body : {};
  const animalType = String(src.animalType || src.species || '')
    .trim()
    .toLowerCase();
  if (!ALLOWED_ANIMALS.has(animalType)) {
    return {
      ok: false,
      status: 400,
      message: 'animalType يجب أن يكون camel أو horse أو falcon',
    };
  }

  const animalCount = Number(
    src.animalCount ??
      src.unitsRequested ??
      src.numberOfHorses ??
      src.headCount ??
      src.birdCount ??
      0,
  );
  if (!Number.isFinite(animalCount) || animalCount < 1) {
    return {
      ok: false,
      status: 400,
      message: 'animalCount يجب أن يكون عدداً موجباً',
    };
  }

  const pickupIn = src.pickup || src.origin || src.details?.origin;
  const destIn = src.destination || src.details?.destination;
  const pickupCoords = parseLatLng(pickupIn);
  const destCoords = parseLatLng(destIn);
  if (!pickupCoords) {
    return {
      ok: false,
      status: 400,
      message: 'إحداثيات نقطة الاستلام مطلوبة وصالحة',
    };
  }
  if (!destCoords) {
    return {
      ok: false,
      status: 400,
      message: 'إحداثيات الوجهة مطلوبة وصالحة',
    };
  }

  const requestTiming = String(src.requestTiming || 'immediate')
    .trim()
    .toLowerCase();
  if (!ALLOWED_TIMING.has(requestTiming)) {
    return {
      ok: false,
      status: 400,
      message: 'requestTiming يجب أن يكون immediate أو scheduled',
    };
  }

  let requestedPickupAt = src.requestedPickupAt
    ? String(src.requestedPickupAt)
    : null;
  if (requestTiming === 'scheduled') {
    if (!requestedPickupAt) {
      return {
        ok: false,
        status: 400,
        message: 'requestedPickupAt مطلوب للطلب المجدول',
      };
    }
    const when = Date.parse(requestedPickupAt);
    if (!Number.isFinite(when)) {
      return { ok: false, status: 400, message: 'requestedPickupAt غير صالح' };
    }
    if (when < Date.now() - 60_000) {
      return {
        ok: false,
        status: 400,
        message: 'لا يمكن جدولة طلب في الماضي',
      };
    }
  } else {
    requestedPickupAt = requestedPickupAt || nowIso;
  }

  const tripType = String(src.tripType || 'oneWay')
    .trim()
    .replace('one-way', 'oneWay')
    .replace('round-trip', 'roundTrip');
  const tripNorm = tripType === 'roundTrip' ? 'roundTrip' : 'oneWay';
  if (!ALLOWED_TRIP.has(tripNorm)) {
    return { ok: false, status: 400, message: 'tripType غير صالح' };
  }

  const providerPreference = String(src.providerPreference || 'any')
    .trim()
    .toLowerCase();
  if (!ALLOWED_PREF.has(providerPreference)) {
    return {
      ok: false,
      status: 400,
      message: 'providerPreference يجب أن يكون any أو individual أو company',
    };
  }

  const idempotencyKey = String(
    src.idempotencyKey || src.clientRequestId || '',
  ).trim();
  if (idempotencyKey && store.transportRequests) {
    for (const existing of store.transportRequests.values()) {
      if (
        String(existing.customerId) === String(userId) &&
        String(existing.idempotencyKey || '') === idempotencyKey
      ) {
        return { ok: true, request: existing, reused: true };
      }
    }
  }

  const requestId = idFn();
  const request = {
    id: requestId,
    customerId: String(userId),
    animalType,
    animalCount: Math.floor(animalCount),
    animalDetails: {
      horseType: src.horseType || src.details?.horseType || null,
      camelAgeGrade: src.camelAgeGrade || src.details?.camelAgeGrade || null,
      camelTransportMode:
        src.camelTransportMode || src.details?.camelTransportMode || null,
      falconCarrierType:
        src.falconCarrierType || src.details?.falconCarrierType || null,
    },
    pickup: {
      ...pickupCoords,
      address: String(
        pickupIn?.address || src.pickupAddress || src.originAddress || '',
      ).trim() || null,
    },
    destination: {
      ...destCoords,
      address: String(
        destIn?.address ||
          src.destinationAddress ||
          src.dropoffAddress ||
          '',
      ).trim() || null,
    },
    requestTiming,
    requestedPickupAt,
    tripType: tripNorm,
    providerPreference,
    specialRequirements: String(src.specialRequirements || src.notes || '')
      .trim() || null,
    status: 'provider_search',
    idempotencyKey: idempotencyKey || null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  store.transportRequests.set(requestId, request);
  return { ok: true, request, reused: false };
}

function getOwnedRequest(store, requestId, userId) {
  const req = store.transportRequests.get(String(requestId));
  if (!req) return { status: 404, message: 'طلب النقل غير موجود' };
  if (String(req.customerId) !== String(userId)) {
    return { status: 403, message: 'غير مصرح بالوصول إلى هذا الطلب' };
  }
  return { request: req };
}

/**
 * T3: Matching Engine result only — Transport Map must not re-filter.
 */
function listProvidersForRequest(store, request) {
  return matchingEngine.matchProvidersForRequest(store, request);
}

module.exports = {
  createTransportRequest,
  getOwnedRequest,
  listProvidersForRequest,
  extractServiceCoords,
  parseLatLng,
  ALLOWED_ANIMALS,
};
