'use strict';

/**
 * G4 — Auctioneer review of G3 seller lots.
 * Does not schedule, assign room/session/queue, or touch bid truth.
 * Uses existing auctions.status values + append-only auction_events.
 */

const { mapAuctionRow, appendEvent, transitionAuction } = require('./auction_service');
const { isAuctionApproved } = require('./approval_flow');

const EVENTS = {
  ACCEPTED: 'haraj.auctioneer.accepted',
  CHANGES: 'haraj.auctioneer.changes_requested',
  REJECTED: 'haraj.auctioneer.rejected',
  NOTE: 'haraj.auctioneer.internal_note',
};

const HARAJ_MARKERS = [
  'haraj.seller.submitted',
  'haraj.seller.draft_created',
  'haraj.seller.draft_updated',
];

const DECISION_EVENTS = [EVENTS.ACCEPTED, EVENTS.CHANGES, EVENTS.REJECTED];
const AUCTIONEER_TOUCH = [...DECISION_EVENTS, EVENTS.NOTE];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

function correlationId(req) {
  const h = req && (req.headers?.['x-request-id'] || req.headers?.['x-correlation-id']);
  if (h) return String(h).slice(0, 80);
  return `g4-${Date.now().toString(36)}`;
}

function assertAuctionId(auctionId) {
  if (!UUID_RE.test(String(auctionId || ''))) {
    fail(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  }
}

async function latestSubmit(client, auctionId) {
  const { rows } = await client.query(
    `SELECT payload FROM auction_events
     WHERE auction_id = $1 AND event_type = 'haraj.seller.submitted'
     ORDER BY created_at DESC
     LIMIT 1`,
    [auctionId],
  );
  return rows[0] || null;
}

async function lockAuction(client, auctionId) {
  assertAuctionId(auctionId);
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
     FROM auctions a
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1
     FOR UPDATE`,
    [auctionId],
  );
  if (!rows[0]) fail(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  return rows[0];
}

async function isHarajLot(client, auctionId) {
  const { rows } = await client.query(
    `SELECT 1 FROM auction_events
     WHERE auction_id = $1 AND event_type = ANY($2::text[])
     LIMIT 1`,
    [auctionId, HARAJ_MARKERS],
  );
  return rows.length > 0;
}

async function latestDecision(client, auctionId) {
  const { rows } = await client.query(
    `SELECT event_type, payload, actor_user_id, created_at
     FROM auction_events
     WHERE auction_id = $1 AND event_type = ANY($2::text[])
     ORDER BY created_at DESC
     LIMIT 1`,
    [auctionId, DECISION_EVENTS],
  );
  return rows[0] || null;
}

async function hasAccepted(client, auctionId) {
  const { rows } = await client.query(
    `SELECT 1 FROM auction_events
     WHERE auction_id = $1 AND event_type = $2
     LIMIT 1`,
    [auctionId, EVENTS.ACCEPTED],
  );
  return rows.length > 0;
}

function operationalStatus(row, decision, approved) {
  const status = String(row.status || '');
  const last = decision?.event_type;
  if (status === 'cancelled' && last === EVENTS.REJECTED) return 'rejected';
  if (status === 'review' && (approved || last === EVENTS.ACCEPTED)) {
    return 'approved_for_haraj';
  }
  if (status === 'draft' && last === EVENTS.CHANGES) return 'needs_changes';
  if (status === 'review') return 'under_review';
  if (status === 'draft') return 'draft';
  return status;
}

function sellerMessageFrom(decision) {
  if (!decision) return null;
  const p = decision.payload || {};
  if (decision.event_type === EVENTS.CHANGES) {
    return p.sellerMessage || p.reason || null;
  }
  if (decision.event_type === EVENTS.REJECTED) {
    return p.sellerMessage || p.reason || null;
  }
  if (decision.event_type === EVENTS.ACCEPTED) {
    return p.sellerMessage || null;
  }
  return null;
}

function mapLot(row, extras = {}) {
  const auction = mapAuctionRow(row);
  auction.lotTitle = row.lot_title || auction.lotTitle;
  return { ...auction, ...extras };
}

function sellerSafeReview(row, decision, approved) {
  return {
    operationalStatus: operationalStatus(row, decision, approved),
    sellerMessage: sellerMessageFrom(decision),
    lastAction: decision
      ? {
          type: decision.event_type,
          at: decision.created_at,
        }
      : null,
    roomAssigned: false,
    sessionAssigned: false,
    queueAssigned: false,
  };
}

async function attachReview(client, row, { internal = false } = {}) {
  const decision = await latestDecision(client, row.id);
  const approved = await isAuctionApproved(client, row.id);
  const harajReview = sellerSafeReview(row, decision, approved);
  const submitted = await latestSubmit(client, row.id);
  if (submitted?.payload?.inspection) {
    harajReview.inspection = submitted.payload.inspection;
    harajReview.inspectionSource = 'SELLER_PROVIDED';
  }
  if (internal && decision?.payload?.internalNote) {
    harajReview.internalNote = decision.payload.internalNote;
  }
  return mapLot(row, { harajReview, isApproved: approved });
}

function assertNotSelfReview(row, actorUserId) {
  if (String(row.owner_user_id) === String(actorUserId)) {
    fail(403, 'AUCTIONEER_SELF_REVIEW_FORBIDDEN', 'Lot owner cannot review their own lot');
  }
}

function assertExpected(row, expectedStatus, expectedVersion) {
  if (expectedStatus && String(expectedStatus) !== String(row.status)) {
    fail(409, 'AUCTION_REVIEW_CONFLICT', 'Lot state changed; refresh and retry');
  }
  if (expectedVersion != null && Number(expectedVersion) !== Number(row.version)) {
    fail(409, 'AUCTION_REVIEW_CONFLICT', 'Stale lot version');
  }
}

async function assertHarajReviewable(client, row) {
  if (!(await isHarajLot(client, row.id))) {
    fail(404, 'AUCTION_NOT_HARAJ', 'Lot is not a Haraj seller submission');
  }
}

function auditPayload({ action, fromStatus, toStatus, reason, sellerMessage, internalNote, correlationId: cid }) {
  const payload = {
    action,
    fromStatus,
    toStatus,
    reason: reason || null,
    at: new Date().toISOString(),
    correlationId: cid || null,
    roomAssigned: false,
    sessionAssigned: false,
    queueAssigned: false,
    bidTruthUnchanged: true,
  };
  if (sellerMessage) payload.sellerMessage = String(sellerMessage).slice(0, 2000);
  if (internalNote) payload.internalNote = String(internalNote).slice(0, 2000);
  return payload;
}

async function listQueue(pool, { bucket = 'under_review', species, ownerUserId, city, limit = 50 } = {}) {
  const cap = Math.min(Number(limit) || 50, 100);
  const params = [HARAJ_MARKERS];
  let n = 2;
  const clauses = [
    `EXISTS (
      SELECT 1 FROM auction_events e
      WHERE e.auction_id = a.id AND e.event_type = ANY($1::text[])
    )`,
  ];

  const b = String(bucket || 'under_review');
  if (b === 'new') {
    clauses.push(`a.status = 'review'`);
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM auction_events x
      WHERE x.auction_id = a.id AND x.event_type = ANY($${n++}::text[])
    )`);
    params.push(AUCTIONEER_TOUCH);
  } else if (b === 'under_review') {
    clauses.push(`a.status = 'review'`);
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM auction_events x
      WHERE x.auction_id = a.id AND x.event_type = '${EVENTS.ACCEPTED}'
    )`);
  } else if (b === 'needs_changes') {
    clauses.push(`a.status = 'draft'`);
    clauses.push(`EXISTS (
      SELECT 1 FROM auction_events x
      WHERE x.auction_id = a.id AND x.event_type = '${EVENTS.CHANGES}'
    )`);
  } else if (b === 'accepted') {
    clauses.push(`a.status = 'review'`);
    clauses.push(`EXISTS (
      SELECT 1 FROM auction_events x
      WHERE x.auction_id = a.id AND x.event_type = '${EVENTS.ACCEPTED}'
    )`);
  } else if (b === 'rejected') {
    clauses.push(`a.status = 'cancelled'`);
    clauses.push(`EXISTS (
      SELECT 1 FROM auction_events x
      WHERE x.auction_id = a.id AND x.event_type = '${EVENTS.REJECTED}'
    )`);
  } else {
    fail(400, 'AUCTION_REVIEW_BUCKET_INVALID', 'Unknown review bucket');
  }

  if (species) {
    clauses.push(`a.species = $${n++}`);
    params.push(String(species).toLowerCase());
  }
  if (ownerUserId) {
    clauses.push(`a.owner_user_id = $${n++}`);
    params.push(String(ownerUserId));
  }
  if (city) {
    clauses.push(`a.location_city ILIKE $${n++}`);
    params.push(`%${String(city).trim()}%`);
  }
  params.push(cap);

  const sql = `
    SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
    FROM auctions a
    JOIN auction_lots l ON l.id = a.lot_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC
    LIMIT $${n}`;
  const { rows } = await pool.query(sql, params);
  const out = [];
  for (const row of rows) {
    const decision = await latestDecision(pool, row.id);
    const approved = await isAuctionApproved(pool, row.id);
    out.push(mapLot(row, { harajReview: sellerSafeReview(row, decision, approved) }));
  }
  return out;
}

async function summaryCounts(pool) {
  const buckets = ['new', 'under_review', 'needs_changes', 'accepted', 'rejected'];
  const counts = {};
  for (const bucket of buckets) {
    const list = await listQueue(pool, { bucket, limit: 100 });
    counts[bucket] = list.length;
  }
  return counts;
}

async function getReviewable(client, auctionId, actorUserId) {
  const row = await lockAuction(client, auctionId);
  await assertHarajReviewable(client, row);
  assertNotSelfReview(row, actorUserId);
  return attachReview(client, row, { internal: true });
}

async function acceptLot(client, { auctionId, actorUserId, reason, sellerMessage, internalNote, expectedStatus, expectedVersion, correlationId: cid }) {
  const row = await lockAuction(client, auctionId);
  await assertHarajReviewable(client, row);
  assertNotSelfReview(row, actorUserId);
  assertExpected(row, expectedStatus, expectedVersion);

  if (await hasAccepted(client, auctionId) && row.status === 'review') {
    return attachReview(client, row, { internal: true });
  }
  if (row.status !== 'review') {
    fail(409, 'AUCTION_REVIEW_INVALID', 'Lot must be under review to accept');
  }

  await appendEvent(client, {
    auctionId,
    eventType: EVENTS.ACCEPTED,
    payload: auditPayload({
      action: 'accept',
      fromStatus: row.status,
      toStatus: 'review',
      reason,
      sellerMessage,
      internalNote,
      correlationId: cid,
    }),
    actorUserId,
  });
  return attachReview(client, row, { internal: true });
}

async function requestChanges(client, { auctionId, actorUserId, reason, sellerMessage, internalNote, expectedStatus, expectedVersion, correlationId: cid }) {
  const row = await lockAuction(client, auctionId);
  await assertHarajReviewable(client, row);
  assertNotSelfReview(row, actorUserId);
  assertExpected(row, expectedStatus, expectedVersion);

  if (!reason || !String(reason).trim()) {
    fail(400, 'AUCTION_REVIEW_REASON_REQUIRED', 'Correction reason is required');
  }
  if (await hasAccepted(client, auctionId)) {
    fail(409, 'AUCTION_ALREADY_APPROVED', 'Accepted lots cannot request changes');
  }

  if (row.status === 'draft') {
    const last = await latestDecision(client, auctionId);
    if (last?.event_type === EVENTS.CHANGES) {
      return attachReview(client, row, { internal: true });
    }
  }
  if (row.status !== 'review') {
    fail(409, 'AUCTION_REVIEW_INVALID', 'Lot must be under review to request changes');
  }

  await transitionAuction(client, auctionId, 'draft', {
    actorUserId,
    reason,
  });
  await appendEvent(client, {
    auctionId,
    eventType: EVENTS.CHANGES,
    payload: auditPayload({
      action: 'request_changes',
      fromStatus: 'review',
      toStatus: 'draft',
      reason,
      sellerMessage: sellerMessage || reason,
      internalNote,
      correlationId: cid,
    }),
    actorUserId,
  });
  const fresh = await lockAuction(client, auctionId);
  return attachReview(client, fresh, { internal: true });
}

async function rejectLot(client, { auctionId, actorUserId, reason, sellerMessage, internalNote, expectedStatus, expectedVersion, correlationId: cid }) {
  const row = await lockAuction(client, auctionId);
  await assertHarajReviewable(client, row);
  assertNotSelfReview(row, actorUserId);
  assertExpected(row, expectedStatus, expectedVersion);

  if (!reason || !String(reason).trim()) {
    fail(400, 'AUCTION_REVIEW_REASON_REQUIRED', 'Rejection reason is required');
  }
  if (await hasAccepted(client, auctionId) && row.status === 'review') {
    fail(409, 'AUCTION_ALREADY_APPROVED', 'Accepted lots cannot be rejected');
  }

  if (row.status === 'cancelled') {
    const last = await latestDecision(client, auctionId);
    if (last?.event_type === EVENTS.REJECTED) {
      return attachReview(client, row, { internal: true });
    }
  }

  const fromReview = row.status === 'review';
  const fromChanges = row.status === 'draft' && (await latestDecision(client, auctionId))?.event_type === EVENTS.CHANGES;
  if (!fromReview && !fromChanges) {
    fail(409, 'AUCTION_REVIEW_INVALID', 'Lot is not in a rejectable review state');
  }

  await transitionAuction(client, auctionId, 'cancelled', {
    actorUserId,
    reason,
  });
  await appendEvent(client, {
    auctionId,
    eventType: EVENTS.REJECTED,
    payload: auditPayload({
      action: 'reject',
      fromStatus: row.status,
      toStatus: 'cancelled',
      reason,
      sellerMessage: sellerMessage || reason,
      internalNote,
      correlationId: cid,
    }),
    actorUserId,
  });
  const fresh = await lockAuction(client, auctionId);
  return attachReview(client, fresh, { internal: true });
}

async function addInternalNote(client, { auctionId, actorUserId, note, correlationId: cid }) {
  const row = await lockAuction(client, auctionId);
  await assertHarajReviewable(client, row);
  assertNotSelfReview(row, actorUserId);
  if (!note || !String(note).trim()) {
    fail(400, 'AUCTION_NOTE_REQUIRED', 'Internal note is required');
  }
  await appendEvent(client, {
    auctionId,
    eventType: EVENTS.NOTE,
    payload: {
      internalNote: String(note).slice(0, 2000),
      sellerVisible: false,
      at: new Date().toISOString(),
      correlationId: cid || null,
    },
    actorUserId,
  });
  return attachReview(client, row, { internal: true });
}

async function listHistory(client, auctionId, { includeInternal = false } = {}) {
  assertAuctionId(auctionId);
  const types = includeInternal
    ? [...DECISION_EVENTS, EVENTS.NOTE, ...HARAJ_MARKERS]
    : [...DECISION_EVENTS, ...HARAJ_MARKERS];
  const { rows } = await client.query(
    `SELECT event_type, payload, actor_user_id, created_at
     FROM auction_events
     WHERE auction_id = $1 AND event_type = ANY($2::text[])
     ORDER BY created_at ASC`,
    [auctionId, types],
  );
  return rows.map((r) => {
    const payload = { ...(r.payload || {}) };
    if (!includeInternal) {
      delete payload.internalNote;
    }
    return {
      type: r.event_type,
      payload,
      actorUserId: includeInternal ? r.actor_user_id : undefined,
      createdAt: r.created_at,
    };
  });
}

async function sellerReviewSummary(client, row) {
  const decision = await latestDecision(client, row.id);
  const approved = await isAuctionApproved(client, row.id);
  return sellerSafeReview(row, decision, approved);
}

module.exports = {
  EVENTS,
  HARAJ_MARKERS,
  operationalStatus,
  sellerSafeReview,
  sellerReviewSummary,
  listQueue,
  summaryCounts,
  getReviewable,
  acceptLot,
  requestChanges,
  rejectLot,
  addInternalNote,
  listHistory,
  correlationId,
};
