'use strict';

/**
 * G11 — Inspection & Acceptance around existing Auction Core winner.
 * Reuses 010 haraj_provisional_awards + haraj_inspections.
 * Extra workflow (snapshot, deadline, mismatch review, version, evidence metadata)
 * lives in append-only auction_events.
 * Does NOT create a second winner, bid engine, settlement, wallet, or After-Haraj.
 */

const { appendEvent, money } = require('./auction_service');
const { acquireAuctionLock } = require('../domain/locking');
const { serverNow } = require('../domain/states');

const EVENTS = Object.freeze({
  SNAPSHOT: 'haraj.disclosure.snapshot',
  OPENED: 'haraj.inspection.opened',
  SCHEDULED: 'haraj.inspection.scheduled',
  ACCEPTED: 'haraj.inspection.buyer_accepted',
  MISMATCH: 'haraj.inspection.mismatch_claimed',
  SELLER_RESPONSE: 'haraj.inspection.seller_response',
  REVIEW: 'haraj.inspection.mismatch_review',
  WITHDRAWN: 'haraj.inspection.buyer_withdrawn',
  EXPIRED: 'haraj.inspection.expired_review_required',
  EXPERT: 'haraj.inspection.expert_finding',
});

const BUYER_OUTCOMES = Object.freeze({
  ACCEPTED: 'accepted',
  MATERIAL_MISMATCH: 'material_mismatch',
  WITHDRAWN: 'withdrawn',
});

const MISMATCH_CATEGORIES = Object.freeze([
  'identity',
  'species_or_category',
  'material_attribute',
  'condition_disclosure',
  'document',
  'media_identity',
  'inspection_availability',
  'other_material',
]);

const ALLOWED_EVIDENCE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
]);

const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;
const EVIDENCE_MAX_ITEMS = 8;

const QR_PROVES = 'attendance_check_in_only';
const QR_DOES_NOT_PROVE = Object.freeze([
  'animal_condition',
  'buyer_acceptance',
  'absence_of_defects',
  'legal_waiver',
  'payment',
  'ownership_transfer',
]);

const EXPOSURE_BY_AWARD = Object.freeze({
  provisional: 'REMAINS',
  inspection_pending: 'REMAINS',
  accepted: 'REMAINS — purchase obligation until later settlement; G11 does not release',
  disputed: 'REMAINS — mismatch under review; no automatic buyer-favorable finality',
  withdrawn: 'REMAINS — buyer walked away; reserved for later G16; not seller fault',
  cancelled: 'RELEASED — authorized void / confirmed material mismatch; winner_user_id unchanged',
});

const BID_SECURITY_POLICY =
  'G11 never releases Bid Security because an auction ended, a room closed, an inspection case was created, a screen opened, or a claim was submitted. Release is a later approved financial/risk policy.';

const SETTLEMENT_BOUNDARY =
  'G11 does not insert haraj_settlements, wallets, escrow, payouts, or capture purchase price.';

const RUNNER_UP_RULE =
  'RUNNER-UP MUST NEVER AUTOMATICALLY BECOME BUYER. Bid history and winner_user_id stay as the auction happened.';

const VET_BOUNDARY =
  'NOMAS auctioneer is not a veterinarian. Expert findings are observations only and are never final mismatch authority.';

const WINDOW_POLICY = 'STAGING_OPERATIONAL_NOT_LEGAL';

function fail(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  throw err;
}

async function g11TablesReady(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.haraj_provisional_awards') AS a,
            to_regclass('public.haraj_inspections') AS i`,
  );
  return Boolean(rows[0] && rows[0].a && rows[0].i);
}

function inspectionWindowHours(input) {
  const role = String(input?.actorRole || '');
  if ((role === 'admin' || role === 'system') && input?.windowHours != null) {
    const n = Number(input.windowHours);
    if (Number.isFinite(n) && n >= 0 && n <= 720) return n;
  }
  const env = Number(process.env.HARAJ_INSPECTION_WINDOW_HOURS || 72);
  return Number.isFinite(env) && env > 0 ? env : 72;
}

function awardVersion(row) {
  return new Date(row.updated_at).toISOString();
}

function assertFresh(award, expectedUpdatedAt) {
  if (expectedUpdatedAt == null || String(expectedUpdatedAt).trim() === '') {
    fail(409, 'INSPECTION_STALE_STATE', 'expectedUpdatedAt is required');
  }
  const expected = new Date(expectedUpdatedAt).toISOString();
  if (expected !== awardVersion(award)) {
    fail(409, 'INSPECTION_STALE_STATE', 'Inspection state has changed');
  }
}

function sanitizeEvidence(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) {
    fail(400, 'INSPECTION_EVIDENCE_INVALID', 'evidence must be an array of metadata objects');
  }
  if (list.length > EVIDENCE_MAX_ITEMS) {
    fail(400, 'INSPECTION_EVIDENCE_INVALID', 'too many evidence items');
  }
  return list.map((item) => {
    if (!item || typeof item !== 'object') {
      fail(400, 'INSPECTION_EVIDENCE_INVALID', 'evidence item must be an object');
    }
    if (item.url || item.href || item.src) {
      fail(400, 'INSPECTION_EVIDENCE_URL_FORBIDDEN', 'Arbitrary URLs are not authoritative evidence');
    }
    const contentType = String(item.contentType || '').trim().toLowerCase();
    if (!ALLOWED_EVIDENCE_TYPES.includes(contentType)) {
      fail(400, 'INSPECTION_EVIDENCE_TYPE', 'Unsupported evidence content type');
    }
    const size = Number(item.sizeBytes);
    if (!Number.isFinite(size) || size <= 0 || size > EVIDENCE_MAX_BYTES) {
      fail(400, 'INSPECTION_EVIDENCE_SIZE', 'Evidence size is missing or exceeds 25MB');
    }
    const objectRef = String(item.objectRef || '').trim();
    if (!objectRef || /^https?:/i.test(objectRef) || objectRef.includes('://')) {
      fail(400, 'INSPECTION_EVIDENCE_REF', 'Evidence must be a validated object reference, not a URL');
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(objectRef)) {
      fail(400, 'INSPECTION_EVIDENCE_REF', 'Evidence objectRef failed validation');
    }
    const checksum = item.checksum != null ? String(item.checksum).trim().slice(0, 128) : '';
    return {
      contentType,
      sizeBytes: Math.round(size),
      objectRef,
      checksum: checksum || null,
    };
  });
}

function parseMediaImages(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean).slice(0, 24);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean).slice(0, 24);
    } catch (_) {
      return [];
    }
  }
  return [];
}

function buildDisclosureSnapshot(row) {
  return {
    auctionId: row.id,
    lotId: row.lot_id,
    species: row.species,
    title: row.lot_title || null,
    description: row.description || null,
    breed: row.breed || null,
    gender: row.gender || null,
    color: row.color || null,
    ageLabel: row.age_label || null,
    startingPrice: money(row.starting_price),
    reservePrice: row.reserve_price != null ? money(row.reserve_price) : null,
    location: {
      city: row.location_city || null,
      district: row.location_district || null,
      address: row.location_address || null,
    },
    media: {
      images: parseMediaImages(row.media_images),
      videoCloudflareId: row.media_video_cloudflare_id || null,
      videoHlsUrl: row.media_video_hls_url || null,
      videoThumbnailUrl: row.media_video_thumbnail_url || null,
    },
    capturedAt: new Date().toISOString(),
    immutable: true,
    binariesDuplicated: false,
  };
}

function outcomeLabelAr(decision) {
  if (decision === BUYER_OUTCOMES.ACCEPTED) return 'مطابق — إتمام الشراء';
  if (decision === BUYER_OUTCOMES.MATERIAL_MISMATCH) return 'غير مطابق للوصف';
  if (decision === BUYER_OUTCOMES.WITHDRAWN) return 'عدلت عن الشراء';
  if (decision === 'expired_review_required') return 'انتهت المهلة — بانتظار مراجعة المشغّل';
  return null;
}

function viewerRole({ auction, award, actorUserId, actorRole }) {
  const role = String(actorRole || '');
  if (role === 'admin') return 'admin';
  if (role === 'auctioneer') return 'auctioneer';
  const actor = String(actorUserId || '');
  if (actor && award && actor === String(award.winner_user_id)) return 'buyer';
  if (actor && auction && actor === String(auction.owner_user_id)) return 'seller';
  return 'none';
}

function assertCanView(role) {
  if (role === 'none') {
    fail(403, 'INSPECTION_FORBIDDEN', 'Not authorized to view this inspection case');
  }
}

async function latestEvent(client, auctionId, eventType) {
  const { rows } = await client.query(
    `SELECT payload, actor_user_id, created_at
     FROM auction_events
     WHERE auction_id = $1 AND event_type = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [auctionId, eventType],
  );
  return rows[0] || null;
}

async function findReplay(client, auctionId, idempotencyKey) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return null;
  const { rows } = await client.query(
    `SELECT event_type, payload, created_at
     FROM auction_events
     WHERE auction_id = $1 AND payload->>'idempotencyKey' = $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [auctionId, key],
  );
  return rows[0] || null;
}

async function loadAuctionForUpdate(client, auctionId) {
  await acquireAuctionLock(client, auctionId);
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

async function loadAward(client, auctionId) {
  const { rows } = await client.query(
    `SELECT * FROM haraj_provisional_awards WHERE auction_id = $1 FOR UPDATE`,
    [auctionId],
  );
  return rows[0] || null;
}

async function loadInspection(client, awardId) {
  const { rows } = await client.query(
    `SELECT * FROM haraj_inspections
     WHERE provisional_award_id = $1
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE`,
    [awardId],
  );
  return rows[0] || null;
}

function assertEligibleAuction(row) {
  const status = String(row.status || '');
  if (status === 'extended' || row.extended_until) {
    if (status !== 'sold' && status !== 'ended' && status !== 'unsold') {
      fail(409, 'AUCTION_STILL_ACTIVE', 'Inspection requires an actual ended auction, not an anti-snipe extension');
    }
  }
  const blocked = new Set([
    'draft',
    'review',
    'scheduled',
    'live',
    'extended',
    'frozen',
    'cancelled',
    'unsold',
  ]);
  if (blocked.has(status)) {
    fail(409, 'INSPECTION_NOT_ELIGIBLE', `Auction status ${status} is not eligible for inspection`);
  }
  if (status !== 'sold') {
    fail(409, 'INSPECTION_NOT_ELIGIBLE', 'Inspection requires an authoritative sold/provisional-award state');
  }
  if (!row.winner_user_id || !row.winning_bid_id) {
    fail(409, 'INSPECTION_NO_WINNER', 'Auction has no authoritative provisional winner');
  }
}

function deriveDecision(award, events) {
  if (!award) return null;
  if (award.status === 'accepted') return BUYER_OUTCOMES.ACCEPTED;
  if (award.status === 'withdrawn') return BUYER_OUTCOMES.WITHDRAWN;
  if (award.status === 'disputed' || award.status === 'cancelled') return BUYER_OUTCOMES.MATERIAL_MISMATCH;
  if (events.expired && award.status === 'inspection_pending') return 'expired_review_required';
  return null;
}

function stripPrivate(view, role) {
  const next = { ...view };
  delete next.bidLimit;
  delete next.activeExposure;
  delete next.providerRef;
  delete next.internalNotes;
  if (role === 'seller' || role === 'auctioneer') {
    delete next.buyerStatement;
    if (role === 'auctioneer') {
      next.evidence = (next.evidence || []).map((e) => ({
        contentType: e.contentType,
        sizeBytes: e.sizeBytes,
      }));
    }
  }
  if (role !== 'admin') {
    delete next.operatorNote;
    delete next.expertInternal;
  }
  return next;
}

function buildView({ auction, award, inspection, events, role }) {
  const decision = deriveDecision(award, events);
  const review = events.review?.payload || null;
  const opened = events.opened?.payload || {};
  const snapshot = events.snapshot?.payload || null;
  const mismatch = events.mismatch?.payload || null;
  const view = {
    auctionId: auction.id,
    lotId: auction.lot_id,
    species: auction.species,
    auctionStatus: auction.status,
    winnerUserId: auction.winner_user_id,
    winningBidId: auction.winning_bid_id,
    currentPrice: money(auction.current_price),
    sellerUserId: auction.owner_user_id,
    awardId: award?.id || null,
    awardStatus: award?.status || null,
    inspectionId: inspection?.id || null,
    inspectionStatus: inspection?.status || null,
    scheduledAt: inspection?.scheduled_at || null,
    completedAt: inspection?.completed_at || null,
    startsAt: opened.startsAt || award?.awarded_at || null,
    deadlineAt: opened.deadlineAt || null,
    windowHours: opened.windowHours || null,
    windowPolicy: opened.policy || WINDOW_POLICY,
    expectedUpdatedAt: award ? awardVersion(award) : null,
    buyerDecision: decision,
    buyerDecisionLabelAr: outcomeLabelAr(decision),
    reviewRequired: Boolean(events.expired && award?.status === 'inspection_pending'),
    mismatch: mismatch
      ? {
          category: mismatch.category,
          statement: role === 'buyer' || role === 'admin' ? mismatch.statement : undefined,
          evidence: mismatch.evidence || [],
          claimedAt: events.mismatch.created_at,
        }
      : null,
    mismatchReview: review
      ? {
          resolution: review.resolution,
          material: review.material,
          at: events.review.created_at,
        }
      : null,
    disclosureSnapshot: snapshot,
    settlementImplemented: false,
    runnerUpAutoAward: false,
    qrProves: QR_PROVES,
    qrDoesNotProve: QR_DOES_NOT_PROVE,
    exposureResult: award ? EXPOSURE_BY_AWARD[award.status] || 'REMAINS' : null,
    bidSecurityPolicy: BID_SECURITY_POLICY,
    settlementBoundary: SETTLEMENT_BOUNDARY,
    runnerUpRule: RUNNER_UP_RULE,
    vetBoundary: VET_BOUNDARY,
    livekit: { implemented: false, classification: 'NOT IMPLEMENTED / NOT TESTED' },
  };
  if (role === 'admin') {
    view.operatorNote = review?.note || null;
    view.expertFindings = events.expert?.payload || null;
  }
  if (role === 'buyer' && mismatch) view.buyerStatement = mismatch.statement;
  return stripPrivate(view, role);
}

async function loadEvents(client, auctionId) {
  const [snapshot, opened, mismatch, review, expired, expert] = await Promise.all([
    latestEvent(client, auctionId, EVENTS.SNAPSHOT),
    latestEvent(client, auctionId, EVENTS.OPENED),
    latestEvent(client, auctionId, EVENTS.MISMATCH),
    latestEvent(client, auctionId, EVENTS.REVIEW),
    latestEvent(client, auctionId, EVENTS.EXPIRED),
    latestEvent(client, auctionId, EVENTS.EXPERT),
  ]);
  return { snapshot, opened, mismatch, review, expired, expert };
}

async function expireIfDue(client, { auction, award, inspection }) {
  if (!award || award.status !== 'inspection_pending') return { expired: false, award, inspection };
  const opened = await latestEvent(client, auction.id, EVENTS.OPENED);
  const deadlineAt = opened?.payload?.deadlineAt;
  if (!deadlineAt) return { expired: false, award, inspection };
  const already = await latestEvent(client, auction.id, EVENTS.EXPIRED);
  const now = serverNow();
  if (now < new Date(deadlineAt)) return { expired: false, award, inspection };
  if (already) return { expired: true, award, inspection };
  await appendEvent(client, {
    auctionId: auction.id,
    eventType: EVENTS.EXPIRED,
    payload: {
      deadlineAt,
      expiredAt: now.toISOString(),
      conversion: 'none',
      note: 'No silent final sale and no silent buyer withdrawal. Operator review required.',
    },
    actorUserId: 'system',
  });
  return { expired: true, award, inspection };
}

async function compose(client, { auction, award, inspection, actorUserId, actorRole }) {
  const expired = await expireIfDue(client, { auction, award, inspection });
  const events = await loadEvents(client, auction.id);
  const role = viewerRole({ auction, award, actorUserId, actorRole });
  return buildView({
    auction,
    award: expired.award,
    inspection: expired.inspection,
    events,
    role: role === 'none' ? 'seller' : role,
  });
}

async function ensureInspectionCase(client, input) {
  if (!(await g11TablesReady(client))) {
    fail(503, 'G11_TABLES_MISSING', '010 inspection tables are not available');
  }
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  assertEligibleAuction(auction);

  const existingAward = await loadAward(client, auction.id);
  let award = existingAward;
  if (!award) {
    const { rows } = await client.query(
      `INSERT INTO haraj_provisional_awards (
         auction_id, winning_bid_id, winner_user_id, final_amount, status
       ) VALUES ($1, $2, $3, $4, 'inspection_pending')
       ON CONFLICT (auction_id) DO UPDATE SET
         updated_at = haraj_provisional_awards.updated_at
       RETURNING *`,
      [
        auction.id,
        auction.winning_bid_id,
        String(auction.winner_user_id),
        money(auction.current_price),
      ],
    );
    award = rows[0];
    if (award.status === 'provisional') {
      const moved = await client.query(
        `UPDATE haraj_provisional_awards
         SET status = 'inspection_pending', updated_at = NOW()
         WHERE id = $1 AND status = 'provisional'
         RETURNING *`,
        [award.id],
      );
      if (moved.rows[0]) award = moved.rows[0];
    }
  } else if (award.status === 'provisional') {
    const moved = await client.query(
      `UPDATE haraj_provisional_awards
       SET status = 'inspection_pending', updated_at = NOW()
       WHERE id = $1 AND status = 'provisional'
       RETURNING *`,
      [award.id],
    );
    if (moved.rows[0]) award = moved.rows[0];
  }

  if (String(award.winner_user_id) !== String(auction.winner_user_id)) {
    fail(409, 'WINNER_AUTHORITY_CONFLICT', 'Award winner must match Auction Core winner_user_id');
  }
  if (String(award.winning_bid_id) !== String(auction.winning_bid_id)) {
    fail(409, 'WINNER_AUTHORITY_CONFLICT', 'Award winning bid must match Auction Core winning_bid_id');
  }

  let inspection = await loadInspection(client, award.id);
  let created = false;
  if (!inspection) {
    const { rows } = await client.query(
      `INSERT INTO haraj_inspections (
         provisional_award_id, auction_id, status, buyer_user_id, seller_user_id
       ) VALUES ($1, $2, 'requested', $3, $4)
       RETURNING *`,
      [award.id, auction.id, String(auction.winner_user_id), String(auction.owner_user_id)],
    );
    inspection = rows[0];
    created = true;
  }

  if (!(await latestEvent(client, auction.id, EVENTS.SNAPSHOT))) {
    await appendEvent(client, {
      auctionId: auction.id,
      eventType: EVENTS.SNAPSHOT,
      payload: buildDisclosureSnapshot(auction),
      actorUserId: input.actorUserId || 'system',
    });
  }

  if (!(await latestEvent(client, auction.id, EVENTS.OPENED))) {
    const hours = inspectionWindowHours(input);
    const startsAt = serverNow();
    const deadlineAt = new Date(startsAt.getTime() + hours * 3600 * 1000);
    await appendEvent(client, {
      auctionId: auction.id,
      eventType: EVENTS.OPENED,
      payload: {
        startsAt: startsAt.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
        windowHours: hours,
        policy: WINDOW_POLICY,
        inspectionId: inspection.id,
        awardId: award.id,
        idempotencyKey: input.idempotencyKey || `inspect-open:${auction.id}`,
      },
      actorUserId: input.actorUserId || 'system',
    });
    created = true;
  }

  const view = await compose(client, {
    auction,
    award,
    inspection,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
  return {
    case: view,
    replay: !created,
    notifications: created
      ? [
          {
            userId: auction.winner_user_id,
            title: 'ترسية مشروطة بالمعاينة',
            body: 'انتهى المزاد. يلزم المعاينة قبل إتمام الشراء.',
            meta: { type: 'haraj.inspection.required', auctionId: auction.id },
          },
          {
            userId: auction.owner_user_id,
            title: 'فائز مؤقت — بانتظار المعاينة',
            body: 'يوجد فائز مؤقت. المعاينة لم تُحسم بعد.',
            meta: { type: 'haraj.inspection.pending', auctionId: auction.id },
          },
        ]
      : [],
  };
}

async function ensureAfterClose(client, { auction, actorUserId }) {
  if (!auction || auction.status !== 'sold' || !auction.winnerUserId) {
    return null;
  }
  if (!(await g11TablesReady(client))) return null;
  try {
    return await ensureInspectionCase(client, {
      auctionId: auction.id,
      actorUserId: actorUserId || 'system',
      actorRole: 'system',
    });
  } catch (err) {
    if (err.code === 'INSPECTION_NOT_ELIGIBLE' || err.code === 'INSPECTION_NO_WINNER') {
      return null;
    }
    throw err;
  }
}

async function getInspectionCase(client, {
  auctionId,
  actorUserId,
  actorRole,
  allowPublicSummary = false,
}) {
  if (!(await g11TablesReady(client))) return { present: false };
  const auction = await loadAuctionForUpdate(client, auctionId);
  const award = await loadAward(client, auction.id);
  if (!award) {
    if (allowPublicSummary) {
      return {
        present: false,
        auctionStatus: auction.status,
        winnerUserId: auction.winner_user_id || null,
      };
    }
    fail(404, 'INSPECTION_NOT_FOUND', 'No inspection case for this auction');
  }
  const inspection = await loadInspection(client, award.id);
  const role = viewerRole({ auction, award, actorUserId, actorRole });
  if (!allowPublicSummary) assertCanView(role);
  const view = await compose(client, {
    auction,
    award,
    inspection,
    actorUserId,
    actorRole: allowPublicSummary && role === 'none' ? 'seller' : actorRole,
  });
  if (allowPublicSummary && role === 'none') {
    return {
      present: true,
      awardStatus: view.awardStatus,
      inspectionStatus: view.inspectionStatus,
      buyerDecision: view.buyerDecision,
      buyerDecisionLabelAr: view.buyerDecisionLabelAr,
      reviewRequired: view.reviewRequired,
      deadlineAt: view.deadlineAt,
      settlementImplemented: false,
    };
  }
  return view;
}

async function publicSummary(client, auctionId) {
  try {
    if (!(await g11TablesReady(client))) return { present: false };
    const { rows } = await client.query(
      `SELECT a.id, a.status, a.winner_user_id, a.winning_bid_id, a.current_price,
              a.owner_user_id, a.species, a.lot_id, p.status AS award_status,
              i.status AS inspection_status
       FROM auctions a
       LEFT JOIN haraj_provisional_awards p ON p.auction_id = a.id
       LEFT JOIN LATERAL (
         SELECT status FROM haraj_inspections h
         WHERE h.provisional_award_id = p.id
         ORDER BY created_at ASC LIMIT 1
       ) i ON true
       WHERE a.id = $1`,
      [auctionId],
    );
    const row = rows[0];
    if (!row) return { present: false };
    if (!row.award_status) {
      return { present: false, auctionStatus: row.status, winnerUserId: row.winner_user_id || null };
    }
    const opened = await latestEvent(client, auctionId, EVENTS.OPENED);
    const expired = await latestEvent(client, auctionId, EVENTS.EXPIRED);
    const decision = deriveDecision({ status: row.award_status }, { expired });
    return {
      present: true,
      awardStatus: row.award_status,
      inspectionStatus: row.inspection_status || null,
      buyerDecision: decision,
      buyerDecisionLabelAr: outcomeLabelAr(decision),
      reviewRequired: Boolean(expired && row.award_status === 'inspection_pending'),
      deadlineAt: opened?.payload?.deadlineAt || null,
      settlementImplemented: false,
    };
  } catch (_) {
    return { present: false };
  }
}

function assertBuyer(auction, award, actorUserId) {
  if (!actorUserId || String(actorUserId) !== String(award.winner_user_id)) {
    fail(403, 'INSPECTION_BUYER_ONLY', 'Only the Auction Core provisional winner may submit this decision');
  }
  if (String(actorUserId) === String(auction.owner_user_id)) {
    fail(403, 'INSPECTION_SELLER_FORBIDDEN', 'Seller cannot act as winning buyer');
  }
}

async function submitBuyerDecision(client, input) {
  const replay = await findReplay(client, input.auctionId, input.idempotencyKey);
  if (replay) {
    return { replay: true, case: await getInspectionCase(client, input) };
  }

  const auction = await loadAuctionForUpdate(client, input.auctionId);
  assertEligibleAuction(auction);
  const award = await loadAward(client, auction.id);
  if (!award) fail(404, 'INSPECTION_NOT_FOUND', 'Inspection case has not been created');
  assertBuyer(auction, award, input.actorUserId);
  assertFresh(award, input.expectedUpdatedAt);

  const expired = await expireIfDue(client, {
    auction,
    award,
    inspection: await loadInspection(client, award.id),
  });
  const expiredEvent = await latestEvent(client, auction.id, EVENTS.EXPIRED);
  if ((expired.expired || expiredEvent) && award.status === 'inspection_pending') {
    fail(409, 'INSPECTION_EXPIRED_REVIEW_REQUIRED', 'Deadline passed. Operator review is required');
  }

  const outcome = String(input.outcome || '').trim();
  if (!Object.values(BUYER_OUTCOMES).includes(outcome)) {
    fail(400, 'INSPECTION_OUTCOME_INVALID', 'Outcome must be accepted, material_mismatch, or withdrawn');
  }

  if (['accepted', 'withdrawn', 'cancelled', 'disputed'].includes(award.status)) {
    fail(409, 'INSPECTION_ALREADY_DECIDED', 'A buyer/operator outcome already exists');
  }

  const inspection = await loadInspection(client, award.id);
  if (!inspection) fail(404, 'INSPECTION_NOT_FOUND', 'Inspection row missing');

  let nextAward = award.status;
  let nextInspection = inspection.status;
  let eventType = EVENTS.ACCEPTED;
  let payload = { outcome, idempotencyKey: input.idempotencyKey || null };

  if (outcome === BUYER_OUTCOMES.ACCEPTED) {
    if (award.status !== 'inspection_pending') {
      fail(409, 'INSPECTION_STATE_CONFLICT', 'Acceptance is only valid from inspection_pending');
    }
    nextAward = 'accepted';
    nextInspection = 'passed';
    eventType = EVENTS.ACCEPTED;
    payload = {
      ...payload,
      labelAr: 'مطابق — إتمام الشراء',
      settlement: false,
    };
  } else if (outcome === BUYER_OUTCOMES.MATERIAL_MISMATCH) {
    const category = String(input.reasonCategory || '').trim();
    if (!MISMATCH_CATEGORIES.includes(category)) {
      fail(400, 'INSPECTION_MISMATCH_CATEGORY', 'A structured mismatch category is required');
    }
    const statement = String(input.statement || '').trim();
    if (statement.length < 8) {
      fail(400, 'INSPECTION_MISMATCH_STATEMENT', 'Buyer statement is required');
    }
    nextAward = 'disputed';
    nextInspection = 'in_progress';
    eventType = EVENTS.MISMATCH;
    payload = {
      ...payload,
      category,
      statement: statement.slice(0, 4000),
      evidence: sanitizeEvidence(input.evidence),
      labelAr: 'غير مطابق للوصف',
      selfApproved: false,
      financialFinality: false,
    };
  } else if (outcome === BUYER_OUTCOMES.WITHDRAWN) {
    if (award.status !== 'inspection_pending') {
      fail(409, 'INSPECTION_STATE_CONFLICT', 'Withdrawal is only valid from inspection_pending');
    }
    nextAward = 'withdrawn';
    nextInspection = 'cancelled';
    eventType = EVENTS.WITHDRAWN;
    payload = {
      ...payload,
      labelAr: 'عدلت عن الشراء',
      sellerFault: false,
      mismatch: false,
      runnerUpAwarded: false,
    };
  }

  const updatedAward = await client.query(
    `UPDATE haraj_provisional_awards
     SET status = $2, updated_at = NOW()
     WHERE id = $1 AND status = $3
     RETURNING *`,
    [award.id, nextAward, award.status],
  );
  if (!updatedAward.rows[0]) {
    fail(409, 'INSPECTION_STATE_CONFLICT', 'Competing inspection transition won');
  }

  const updatedInspection = await client.query(
    `UPDATE haraj_inspections
     SET status = $2,
         completed_at = CASE WHEN $2 IN ('passed', 'failed', 'cancelled') THEN NOW() ELSE completed_at END,
         notes = COALESCE($3, notes),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [inspection.id, nextInspection, payload.labelAr || null],
  );

  await appendEvent(client, {
    auctionId: auction.id,
    eventType,
    payload,
    actorUserId: input.actorUserId,
  });

  const { rows: winnerCheck } = await client.query(
    `SELECT winner_user_id, winning_bid_id, status FROM auctions WHERE id = $1`,
    [auction.id],
  );
  if (
    String(winnerCheck[0].winner_user_id) !== String(auction.winner_user_id) ||
    String(winnerCheck[0].winning_bid_id) !== String(auction.winning_bid_id)
  ) {
    fail(500, 'AUCTION_TRUTH_MUTATED', 'G11 must not rewrite Auction Core winner/history');
  }

  const view = await compose(client, {
    auction,
    award: updatedAward.rows[0],
    inspection: updatedInspection.rows[0],
    actorUserId: input.actorUserId,
    actorRole: 'buyer',
  });
  return {
    replay: false,
    case: view,
    notifications: [
      {
        userId: auction.owner_user_id,
        title: 'قرار المشتري بعد المعاينة',
        body: payload.labelAr || outcome,
        meta: { type: 'haraj.inspection.buyer_decision', auctionId: auction.id, outcome },
      },
    ],
  };
}

async function sellerRespond(client, input) {
  const replay = await findReplay(client, input.auctionId, input.idempotencyKey);
  if (replay) return { replay: true, case: await getInspectionCase(client, input) };

  const auction = await loadAuctionForUpdate(client, input.auctionId);
  const award = await loadAward(client, auction.id);
  if (!award) fail(404, 'INSPECTION_NOT_FOUND', 'Inspection case has not been created');
  if (String(input.actorUserId) !== String(auction.owner_user_id)) {
    fail(403, 'INSPECTION_SELLER_ONLY', 'Only the lot seller may record a response');
  }
  if (award.status !== 'disputed') {
    fail(409, 'INSPECTION_STATE_CONFLICT', 'Seller response is only valid while a mismatch is under review');
  }
  assertFresh(award, input.expectedUpdatedAt);
  const statement = String(input.statement || '').trim();
  if (statement.length < 4) fail(400, 'INSPECTION_SELLER_STATEMENT', 'Seller statement is required');

  await appendEvent(client, {
    auctionId: auction.id,
    eventType: EVENTS.SELLER_RESPONSE,
    payload: {
      statement: statement.slice(0, 4000),
      finalAuthority: false,
      idempotencyKey: input.idempotencyKey || null,
    },
    actorUserId: input.actorUserId,
  });
  await client.query(
    `UPDATE haraj_provisional_awards SET updated_at = NOW() WHERE id = $1`,
    [award.id],
  );
  return { replay: false, case: await getInspectionCase(client, { ...input, actorRole: 'seller' }) };
}

async function scheduleInspection(client, input) {
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  const award = await loadAward(client, auction.id);
  if (!award) fail(404, 'INSPECTION_NOT_FOUND', 'Inspection case has not been created');
  if (!['inspection_pending', 'disputed'].includes(award.status)) {
    fail(409, 'INSPECTION_STATE_CONFLICT', 'Cannot schedule after a terminal buyer/operator outcome');
  }
  const inspection = await loadInspection(client, award.id);
  if (!inspection) fail(404, 'INSPECTION_NOT_FOUND', 'Inspection row missing');
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : serverNow();
  if (Number.isNaN(scheduledAt.getTime())) {
    fail(400, 'INSPECTION_SCHEDULE_INVALID', 'scheduledAt must be a valid timestamp');
  }
  const updated = await client.query(
    `UPDATE haraj_inspections
     SET status = CASE WHEN status IN ('requested', 'scheduled') THEN 'scheduled' ELSE status END,
         scheduled_at = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [inspection.id, scheduledAt.toISOString()],
  );
  await appendEvent(client, {
    auctionId: auction.id,
    eventType: EVENTS.SCHEDULED,
    payload: {
      scheduledAt: scheduledAt.toISOString(),
      notes: input.notes ? String(input.notes).slice(0, 1000) : null,
      idempotencyKey: input.idempotencyKey || null,
    },
    actorUserId: input.actorUserId,
  });
  return compose(client, {
    auction,
    award,
    inspection: updated.rows[0],
    actorUserId: input.actorUserId,
    actorRole: input.actorRole || 'auctioneer',
  });
}

async function resolveMismatch(client, input) {
  const replay = await findReplay(client, input.auctionId, input.idempotencyKey);
  if (replay) return { replay: true, case: await getInspectionCase(client, { ...input, actorRole: 'admin' }) };

  const auction = await loadAuctionForUpdate(client, input.auctionId);
  const award = await loadAward(client, auction.id);
  if (!award) fail(404, 'INSPECTION_NOT_FOUND', 'Inspection case has not been created');
  assertFresh(award, input.expectedUpdatedAt);

  const resolution = String(input.resolution || '').trim();
  const allowed = new Set(['confirm_mismatch', 'reject_not_material', 'void']);
  if (!allowed.has(resolution)) {
    fail(400, 'INSPECTION_RESOLUTION_INVALID', 'Unknown operator resolution');
  }

  if (resolution !== 'void' && award.status !== 'disputed' && award.status !== 'inspection_pending') {
    fail(409, 'INSPECTION_STATE_CONFLICT', 'Operator resolution is not valid in this state');
  }
  if (resolution === 'void' && ['accepted'].includes(award.status)) {
    fail(409, 'INSPECTION_STATE_CONFLICT', 'Accepted cases are not silently voided in G11');
  }

  let nextAward = award.status;
  let nextInspection = null;
  let material = null;
  if (resolution === 'confirm_mismatch') {
    nextAward = 'cancelled';
    nextInspection = 'failed';
    material = true;
  } else if (resolution === 'reject_not_material') {
    nextAward = 'accepted';
    nextInspection = 'passed';
    material = false;
  } else if (resolution === 'void') {
    nextAward = 'cancelled';
    nextInspection = 'cancelled';
    material = null;
  }

  const updatedAward = await client.query(
    `UPDATE haraj_provisional_awards
     SET status = $2, updated_at = NOW()
     WHERE id = $1 AND status = $3
     RETURNING *`,
    [award.id, nextAward, award.status],
  );
  if (!updatedAward.rows[0]) {
    fail(409, 'INSPECTION_STATE_CONFLICT', 'Competing inspection transition won');
  }
  const inspection = await loadInspection(client, award.id);
  const updatedInspection = await client.query(
    `UPDATE haraj_inspections
     SET status = COALESCE($2, status),
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [inspection.id, nextInspection],
  );

  await appendEvent(client, {
    auctionId: auction.id,
    eventType: EVENTS.REVIEW,
    payload: {
      resolution,
      material,
      note: input.note ? String(input.note).slice(0, 2000) : null,
      runnerUpAwarded: false,
      settlement: false,
      idempotencyKey: input.idempotencyKey || null,
    },
    actorUserId: input.actorUserId,
  });

  const { rows: truth } = await client.query(
    `SELECT winner_user_id, winning_bid_id FROM auctions WHERE id = $1`,
    [auction.id],
  );
  if (
    String(truth[0].winner_user_id) !== String(auction.winner_user_id) ||
    String(truth[0].winning_bid_id) !== String(auction.winning_bid_id)
  ) {
    fail(500, 'AUCTION_TRUTH_MUTATED', 'G11 must not rewrite Auction Core winner/history');
  }

  return {
    replay: false,
    case: await compose(client, {
      auction,
      award: updatedAward.rows[0],
      inspection: updatedInspection.rows[0],
      actorUserId: input.actorUserId,
      actorRole: 'admin',
    }),
    notifications: [
      {
        userId: award.winner_user_id,
        title: 'نتيجة مراجعة المعاينة',
        body: resolution,
        meta: { type: 'haraj.inspection.resolved', auctionId: auction.id, resolution },
      },
      {
        userId: auction.owner_user_id,
        title: 'نتيجة مراجعة المعاينة',
        body: resolution,
        meta: { type: 'haraj.inspection.resolved', auctionId: auction.id, resolution },
      },
    ],
  };
}

async function addExpertFinding(client, input) {
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  const award = await loadAward(client, auction.id);
  if (!award) fail(404, 'INSPECTION_NOT_FOUND', 'Inspection case has not been created');
  if (String(input.actorRole || '') !== 'admin') {
    fail(403, 'INSPECTION_EXPERT_FORBIDDEN', 'Only an authorized operator may record expert findings');
  }
  const observations = String(input.observations || '').trim();
  if (observations.length < 4) {
    fail(400, 'INSPECTION_FINDING_REQUIRED', 'Structured observations are required');
  }
  await appendEvent(client, {
    auctionId: auction.id,
    eventType: EVENTS.EXPERT,
    payload: {
      performed: input.performed !== false,
      observations: observations.slice(0, 4000),
      documents: sanitizeEvidence(input.documents || []),
      finalAuthority: false,
      veterinaryDiagnosis: false,
      idempotencyKey: input.idempotencyKey || null,
    },
    actorUserId: input.actorUserId,
  });
  return getInspectionCase(client, { ...input, actorRole: 'admin' });
}

async function expireCheck(client, input) {
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  const award = await loadAward(client, auction.id);
  if (!award) fail(404, 'INSPECTION_NOT_FOUND', 'Inspection case has not been created');
  const inspection = await loadInspection(client, award.id);
  const stagingForce = input.stagingForce === true
    && String(process.env.APP_ENV || '').toLowerCase() === 'staging';
  if (stagingForce && award.status === 'inspection_pending') {
    const already = await latestEvent(client, auction.id, EVENTS.EXPIRED);
    if (!already) {
      await appendEvent(client, {
        auctionId: auction.id,
        eventType: EVENTS.EXPIRED,
        payload: {
          deadlineAt: serverNow().toISOString(),
          expiredAt: serverNow().toISOString(),
          conversion: 'none',
          stagingForce: true,
          note: 'Staging time control. No silent final sale and no silent buyer withdrawal.',
        },
        actorUserId: input.actorUserId || 'system',
      });
    }
  } else {
    await expireIfDue(client, { auction, award, inspection });
  }
  return getInspectionCase(client, input);
}

async function listCases(client, { actorUserId, actorRole, limit = 50 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const role = String(actorRole || '');
  let sql;
  let params;
  if (role === 'admin' || role === 'auctioneer') {
    sql = `
      SELECT p.auction_id, p.status AS award_status, p.winner_user_id, p.final_amount,
             p.updated_at, a.status AS auction_status, a.species, a.owner_user_id,
             l.title AS lot_title, i.status AS inspection_status, i.scheduled_at
      FROM haraj_provisional_awards p
      JOIN auctions a ON a.id = p.auction_id
      JOIN auction_lots l ON l.id = a.lot_id
      LEFT JOIN LATERAL (
        SELECT status, scheduled_at FROM haraj_inspections h
        WHERE h.provisional_award_id = p.id
        ORDER BY created_at ASC LIMIT 1
      ) i ON true
      ORDER BY p.updated_at DESC
      LIMIT $1`;
    params = [cap];
  } else {
    sql = `
      SELECT p.auction_id, p.status AS award_status, p.winner_user_id, p.final_amount,
             p.updated_at, a.status AS auction_status, a.species, a.owner_user_id,
             l.title AS lot_title, i.status AS inspection_status, i.scheduled_at
      FROM haraj_provisional_awards p
      JOIN auctions a ON a.id = p.auction_id
      JOIN auction_lots l ON l.id = a.lot_id
      LEFT JOIN LATERAL (
        SELECT status, scheduled_at FROM haraj_inspections h
        WHERE h.provisional_award_id = p.id
        ORDER BY created_at ASC LIMIT 1
      ) i ON true
      WHERE p.winner_user_id = $2 OR a.owner_user_id = $2
      ORDER BY p.updated_at DESC
      LIMIT $1`;
    params = [cap, String(actorUserId || '')];
  }
  const { rows } = await client.query(sql, params);
  return rows.map((row) => ({
    auctionId: row.auction_id,
    lotTitle: row.lot_title,
    species: row.species,
    auctionStatus: row.auction_status,
    awardStatus: row.award_status,
    inspectionStatus: row.inspection_status,
    scheduledAt: row.scheduled_at,
    buyerDecisionLabelAr: outcomeLabelAr(
      row.award_status === 'accepted'
        ? 'accepted'
        : row.award_status === 'withdrawn'
          ? 'withdrawn'
          : row.award_status === 'disputed' || row.award_status === 'cancelled'
            ? 'material_mismatch'
            : null,
    ),
    sellerUserId: role === 'admin' ? row.owner_user_id : undefined,
    winnerUserId: role === 'admin' || role === 'auctioneer' ? row.winner_user_id : undefined,
    amount: role === 'admin' ? money(row.final_amount) : undefined,
    exposureResult: EXPOSURE_BY_AWARD[row.award_status] || 'REMAINS',
  }));
}

function isProductionNotifyForbidden() {
  const appEnv = String(process.env.APP_ENV || '').toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  return appEnv === 'production' || (nodeEnv === 'production' && appEnv !== 'staging');
}

module.exports = {
  EVENTS,
  BUYER_OUTCOMES,
  MISMATCH_CATEGORIES,
  EXPOSURE_BY_AWARD,
  BID_SECURITY_POLICY,
  SETTLEMENT_BOUNDARY,
  RUNNER_UP_RULE,
  VET_BOUNDARY,
  QR_PROVES,
  QR_DOES_NOT_PROVE,
  WINDOW_POLICY,
  g11TablesReady,
  inspectionWindowHours,
  sanitizeEvidence,
  buildDisclosureSnapshot,
  outcomeLabelAr,
  viewerRole,
  ensureInspectionCase,
  ensureAfterClose,
  getInspectionCase,
  publicSummary,
  submitBuyerDecision,
  sellerRespond,
  scheduleInspection,
  resolveMismatch,
  addExpertFinding,
  expireCheck,
  listCases,
  isProductionNotifyForbidden,
};
