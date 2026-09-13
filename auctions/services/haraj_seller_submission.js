'use strict';

/**
 * G3 — Seller lot submission helpers.
 * Reuses existing Auction create (Auction = Lot). Does not create a second bid engine.
 * Seller never controls current bid, winner, queue, or room assignment.
 */

const { ALLOWED_SPECIES } = require('../config');

const HARAJ_DEFAULT_INCREMENT = 100;
const HARAJ_PLACEHOLDER_START_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;
const HARAJ_PLACEHOLDER_DURATION_MS = 2 * 60 * 60 * 1000;
const TITLE_MAX = 120;
const TEXT_MAX = 4000;

const FORBIDDEN_SELLER_FIELDS = [
  'currentPrice',
  'current_price',
  'winnerUserId',
  'winner_user_id',
  'winningBidId',
  'winning_bid_id',
  'highestBid',
  'queuePosition',
  'queue_position',
  'roomId',
  'room_id',
  'haraj_mode',
  'harajMode',
];

function isHarajChannel(body) {
  if (!body || typeof body !== 'object') return false;
  const c = String(body.channel || body.submissionChannel || '').trim().toLowerCase();
  return c === 'haraj' || body.haraj === true;
}

function fail(status, code, message) {
  return { ok: false, status, code, message };
}

function ok(extra) {
  return { ok: true, ...extra };
}

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return max ? s.slice(0, max) : s;
}

function assertNoOwnershipSpoof(body, authUserId, { allowHostProxyOwner = false } = {}) {
  if (!body || typeof body !== 'object') return ok();
  const auth = String(authUserId || '').trim();
  if (!auth) return fail(401, 'AUTH_REQUIRED', 'Authentication required');

  const claims = [];
  if (!allowHostProxyOwner && body.ownerUserId != null && String(body.ownerUserId).trim()) {
    claims.push(String(body.ownerUserId).trim());
  }
  for (const key of ['sellerId', 'userId', 'createdByUserId']) {
    if (body[key] != null && String(body[key]).trim()) {
      claims.push(String(body[key]).trim());
    }
  }
  for (const claimed of claims) {
    if (claimed !== auth) {
      return fail(
        403,
        'AUCTION_OWNER_FORBIDDEN',
        'Client-supplied owner/seller identity is not authoritative',
      );
    }
  }
  return ok();
}

function rejectForbiddenSellerControls(body) {
  if (!body || typeof body !== 'object') return ok();
  for (const key of FORBIDDEN_SELLER_FIELDS) {
    if (body[key] != null) {
      return fail(
        400,
        'AUCTION_FIELD_FORBIDDEN',
        `Seller cannot set ${key}`,
      );
    }
  }
  return ok();
}

function normalizeInspection(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: fail(400, 'AUCTION_INSPECTION_INVALID', 'inspection must be an object') };
  }
  if (typeof raw.available !== 'boolean') {
    return {
      error: fail(
        400,
        'AUCTION_INSPECTION_REQUIRED',
        'inspection.available (boolean) is required for Haraj submission',
      ),
    };
  }
  return {
    value: {
      available: raw.available === true,
      windows: str(raw.windows || raw.preferredPeriods, 500) || null,
      locationReference: str(raw.locationReference || raw.reference, 300) || null,
      notes: str(raw.notes, 1000) || null,
    },
  };
}

function mergeDescriptionWithInspection(description, inspection) {
  const base = str(description, TEXT_MAX);
  if (!inspection) return base || null;
  const lines = [
    base,
    base ? '' : null,
    '— بيانات المعاينة (مدخل البائع — ليست سير عمل المعاينة) —',
    `المعاينة: ${inspection.available ? 'متاحة' : 'غير متاحة حالياً'}`,
  ];
  if (inspection.windows) lines.push(`الفترات المفضلة: ${inspection.windows}`);
  if (inspection.locationReference) {
    lines.push(`مرجع الموقع: ${inspection.locationReference}`);
  }
  if (inspection.notes) lines.push(`ملاحظات: ${inspection.notes}`);
  return lines.filter((x) => x != null).join('\n').slice(0, TEXT_MAX);
}

function applyHarajCreateDefaults(body) {
  const next = { ...(body || {}) };
  next.independent = true;
  next.createdByRole = 'seller';
  next.requiresHost = false;
  delete next.ownerUserId;
  delete next.sellerId;
  delete next.userId;
  delete next.createdByUserId;
  if (next.minimumIncrement == null || next.minimumIncrement === '') {
    next.minimumIncrement = HARAJ_DEFAULT_INCREMENT;
  }
  const hasStart = Boolean(str(next.startAt));
  const hasEnd = Boolean(str(next.endAt));
  if (!hasStart || !hasEnd) {
    const start = new Date(Date.now() + HARAJ_PLACEHOLDER_START_OFFSET_MS);
    next.startAt = start.toISOString();
    next.endAt = new Date(start.getTime() + HARAJ_PLACEHOLDER_DURATION_MS).toISOString();
  }
  return next;
}

function validateHarajSellerPayload(body) {
  const species = String(body?.species || '').trim().toLowerCase();
  if (species === 'sheep') {
    return fail(400, 'AUCTION_SPECIES_INVALID', 'Sheep is not enabled for NOMAS Haraj');
  }
  if (!ALLOWED_SPECIES.includes(species)) {
    return fail(400, 'AUCTION_SPECIES_INVALID', 'Species not eligible for auctions V1');
  }
  const title = str(body?.title, TITLE_MAX);
  if (!title) {
    return fail(400, 'AUCTION_TITLE_REQUIRED', 'Lot title is required for Haraj submission');
  }
  const starting = Number(body?.startingPrice);
  if (!Number.isFinite(starting) || starting <= 0) {
    return fail(400, 'AUCTION_STARTING_PRICE_INVALID', 'startingPrice must be > 0');
  }
  if (body?.reservePrice != null && body.reservePrice !== '') {
    const reserve = Number(body.reservePrice);
    if (!Number.isFinite(reserve) || reserve < starting) {
      return fail(
        400,
        'AUCTION_RESERVE_INVALID',
        'reservePrice must be a number >= startingPrice',
      );
    }
  }
  const forbidden = rejectForbiddenSellerControls(body);
  if (!forbidden.ok) return forbidden;
  const inspection = normalizeInspection(body.inspection);
  if (inspection?.error) return inspection.error;
  if (!inspection?.value) {
    return fail(
      400,
      'AUCTION_INSPECTION_REQUIRED',
      'inspection.available is required for Haraj submission',
    );
  }
  return ok({
    title,
    species,
    inspection: inspection.value,
    description: mergeDescriptionWithInspection(body.description, inspection.value),
  });
}

module.exports = {
  ALLOWED_SPECIES,
  HARAJ_DEFAULT_INCREMENT,
  FORBIDDEN_SELLER_FIELDS,
  isHarajChannel,
  assertNoOwnershipSpoof,
  rejectForbiddenSellerControls,
  normalizeInspection,
  mergeDescriptionWithInspection,
  applyHarajCreateDefaults,
  validateHarajSellerPayload,
};
