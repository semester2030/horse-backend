/**
 * Category-specific verticalFilters matchers (AND semantics with Core).
 * Derived from create/storage fields — not UI-only.
 */
'use strict';

function asList(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (raw == null || raw === '') return [];
  return [String(raw)];
}

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function verticalBag(place) {
  return place && place.vertical && typeof place.vertical === 'object'
    ? place.vertical
    : null;
}

function productSubCategories(v) {
  const out = new Set();
  if (!v) return out;
  if (v.subCategory) out.add(String(v.subCategory));
  for (const p of asList(v.products).concat(asList(v.inventory))) {
    if (p && typeof p === 'object') {
      if (p.subCategory) out.add(String(p.subCategory));
      if (p.category) out.add(String(p.category));
    } else if (typeof p === 'string') {
      out.add(p);
    }
  }
  return out;
}

function boolTruthy(val, defaultWhenMissing = false) {
  if (val === undefined || val === null) return defaultWhenMissing;
  return Boolean(val);
}

function priceOf(v) {
  if (!v) return null;
  const candidates = [
    v.price,
    v.pricePerSession,
    v.pricePerDay,
    v.pricePerVisit,
    v.consultationFee,
    v.maxPrice,
  ];
  for (const c of candidates) {
    if (c != null && Number.isFinite(Number(c))) return Number(c);
  }
  const products = asList(v.products).concat(asList(v.inventory));
  for (const p of products) {
    if (p && typeof p === 'object' && p.price != null && Number.isFinite(Number(p.price))) {
      return Number(p.price);
    }
  }
  return null;
}

function deliveryOk(v, want) {
  if (!want) return true;
  return (
    boolTruthy(v?.deliveryAvailable, true) &&
    boolTruthy(v?.delivery, true)
  );
}

function pickupOk(v, want) {
  if (!want) return true;
  return (
    boolTruthy(v?.pickupAvailable, true) &&
    boolTruthy(v?.pickup, true)
  );
}

function availableNowOk(place, v, want) {
  if (!want) return true;
  const a = String(place.availability || '').toLowerCase();
  if (a === 'open_now' || a === 'open') return true;
  const products = asList(v?.products);
  for (const p of products) {
    if (p && typeof p === 'object' && p.inStock !== false) return true;
  }
  return false;
}

function ratingOk(place, minRating) {
  if (minRating == null) return true;
  const min = Number(minRating);
  if (!Number.isFinite(min)) return true;
  if (place.rating == null) return false;
  return Number(place.rating) >= min;
}

function maxPriceOk(v, maxPrice) {
  if (maxPrice == null) return true;
  const max = Number(maxPrice);
  if (!Number.isFinite(max)) return true;
  const p = priceOf(v);
  if (p == null) return false;
  return p <= max;
}

/**
 * Feed: subCategory (تبن/برسيم/…), delivery, pickup, availableNow, maxPrice, minRating
 */
function feedVerticalMatches(place, verticalFilters = {}) {
  if (!verticalFilters || typeof verticalFilters !== 'object') return true;
  const vf = verticalFilters;
  const needs =
    vf.subCategory != null ||
    vf.feedSubCategory != null ||
    vf.delivery === true ||
    vf.pickup === true ||
    vf.availableNow === true ||
    vf.maxPrice != null ||
    vf.minRating != null;
  if (!needs) return true;

  const v = verticalBag(place);
  if (!v || (v.kind && v.kind !== 'feed')) {
    return false;
  }

  const wantedSub = String(vf.subCategory || vf.feedSubCategory || '').trim();
  if (wantedSub) {
    const set = productSubCategories(v);
    const hit = [...set].some(
      (s) => norm(s) === norm(wantedSub) || s.includes(wantedSub) || wantedSub.includes(s),
    );
    if (!hit) return false;
  }

  if (!deliveryOk(v, vf.delivery === true)) return false;
  if (!pickupOk(v, vf.pickup === true)) return false;
  if (!availableNowOk(place, v, vf.availableNow === true)) return false;
  if (!maxPriceOk(v, vf.maxPrice)) return false;
  if (!ratingOk(place, vf.minRating)) return false;
  return true;
}

/**
 * Equipment: subCategory, delivery, pickup, maxPrice, minRating
 */
function equipmentVerticalMatches(place, verticalFilters = {}) {
  if (!verticalFilters || typeof verticalFilters !== 'object') return true;
  const vf = verticalFilters;
  const needs =
    vf.subCategory != null ||
    vf.category != null ||
    vf.delivery === true ||
    vf.pickup === true ||
    vf.maxPrice != null ||
    vf.minRating != null;
  if (!needs) return true;

  const v = verticalBag(place);
  if (!v || (v.kind && v.kind !== 'equipment')) return false;

  const wantedSub = String(vf.subCategory || vf.category || '').trim();
  if (wantedSub) {
    const set = productSubCategories(v);
    const hit = [...set].some(
      (s) => norm(s) === norm(wantedSub) || s.includes(wantedSub) || wantedSub.includes(s),
    );
    if (!hit) return false;
  }

  if (!deliveryOk(v, vf.delivery === true)) return false;
  if (!pickupOk(v, vf.pickup === true)) return false;
  if (!maxPriceOk(v, vf.maxPrice)) return false;
  if (!ratingOk(place, vf.minRating)) return false;
  return true;
}

/**
 * Training: maxPricePerSession only (create form has no programType/homeVisit)
 */
function trainingVerticalMatches(place, verticalFilters = {}) {
  if (!verticalFilters || typeof verticalFilters !== 'object') return true;
  const vf = verticalFilters;
  if (vf.maxPricePerSession == null) return true;

  const v = verticalBag(place);
  if (!v || (v.kind && v.kind !== 'training')) return false;

  const max = Number(vf.maxPricePerSession);
  if (!Number.isFinite(max)) return true;
  const p =
    v.pricePerSession != null
      ? Number(v.pricePerSession)
      : priceOf(v);
  if (p == null) return false;
  return p <= max;
}

/**
 * Veterinary: specialty, emergency, homeVisit, maxConsultationFee
 */
function veterinaryVerticalMatches(place, verticalFilters = {}) {
  if (!verticalFilters || typeof verticalFilters !== 'object') return true;
  const vf = verticalFilters;
  const needs =
    vf.specialty != null ||
    vf.specialties != null ||
    vf.emergency === true ||
    vf.homeVisit === true ||
    vf.maxConsultationFee != null;
  if (!needs) return true;

  const v = verticalBag(place);
  if (!v || (v.kind && v.kind !== 'veterinary')) return false;

  const specialties = asList(v.specialties).map(norm);
  const wantedSpecialty = String(vf.specialty || '').trim();
  if (wantedSpecialty) {
    const w = norm(wantedSpecialty);
    if (!specialties.some((s) => s === w || s.includes(w) || w.includes(s))) {
      return false;
    }
  }

  if (vf.emergency === true) {
    // Positive filter: known true only. UNKNOWN and false fail closed.
    const emergencyHit =
      v.emergency === true ||
      specialties.some(
        (s) => s.includes('emergency') || s.includes('طوارئ'),
      );
    if (!emergencyHit) return false;
  }

  if (vf.homeVisit === true) {
    // UNKNOWN ≠ FALSE: missing fields must not match homeVisit=true.
    // Only explicit true matches. Explicit false and null/undefined fail closed.
    const hv = v.homeVisit;
    const oh = v.offersHomeVisit;
    if (hv !== true && oh !== true) return false;
  }

  if (vf.maxConsultationFee != null) {
    const max = Number(vf.maxConsultationFee);
    if (Number.isFinite(max)) {
      const fee =
        v.pricePerVisit != null
          ? Number(v.pricePerVisit)
          : v.consultationFee != null
            ? Number(v.consultationFee)
            : null;
      if (fee == null || fee > max) return false;
    }
  }

  return true;
}

/**
 * Boarding: extend existing matcher with spaceTypes label match
 */
function boardingSpaceTypeMatches(place, verticalFilters, boardingVerticalMatches) {
  if (!boardingVerticalMatches(place, verticalFilters)) return false;
  const vf = verticalFilters || {};
  if (vf.stableType == null || vf.stableType === '') return true;
  const v = verticalBag(place);
  if (!v) return false;
  const wanted = String(vf.stableType);
  if (String(v.stableType || '') === wanted) return true;
  const types = asList(v.spaceTypes).concat(asList(v.features));
  return types.some((t) => String(t) === wanted || norm(t) === norm(wanted));
}

module.exports = {
  feedVerticalMatches,
  equipmentVerticalMatches,
  trainingVerticalMatches,
  veterinaryVerticalMatches,
  boardingSpaceTypeMatches,
  productSubCategories,
};
