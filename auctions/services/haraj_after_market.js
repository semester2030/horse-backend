'use strict';

/**
 * G12 — After-Haraj Market around the SAME Lot.
 * Reuses 010 haraj_after_listings + append-only auction_events for offers.
 * Does NOT: placeBid, rewrite Haraj history, auto-copy last bid as price,
 * auto-award runner-up, settle money, create wallets/escrow, or add AI.
 */

const { randomUUID } = require('crypto');
const { appendEvent, money, createAuctionDraft } = require('./auction_service');
const { acquireAuctionLock } = require('../domain/locking');
const { serverNow } = require('../domain/states');

const AI_SCOPE = 'DEFERRED — OWNER DECISION';
const AI_STATUS = Object.freeze({
  scope: AI_SCOPE,
  implemented: false,
  providerIntegrated: false,
  recommendations: false,
  matching: false,
  pricing: false,
});

const SETTLEMENT_BOUNDARY =
  'G12 does not insert haraj_settlements, wallets, escrow, payouts, or capture purchase price. Offer accept / purchase intent is commercial handoff only.';

const RUNNER_UP_RULE =
  'RUNNER-UP MUST NEVER AUTOMATICALLY BECOME BUYER. After-Haraj never auto-creates an offer, purchase, or accepted offer for the previous runner-up.';

const LAST_BID_RULE =
  'LAST BID ≠ AUTOMATIC AFTER-HARAJ SALE PRICE, minimum offer, reserve, or re-auction starting price.';

const G10_BOUNDARY =
  'After-Haraj offers are not Auction Core bids and do not mutate G10 Haraj exposure. Do not use placeBid.';

const MEDIA_RULE =
  'Reuse existing Lot media references. Do not duplicate Cloudflare binaries.';

const MODES = Object.freeze({
  FIXED_PRICE: 'available_at_approved_price',
  ACCEPT_OFFERS: 'accept_offers',
  RE_AUCTION: 're_auction',
  HISTORY_ONLY: 'history_only',
  CLOSED: 'closed',
});

const LISTING_STATUS = Object.freeze({
  ELIGIBLE: 'eligible',
  LISTED: 'listed',
  SOLD_OFF_PLATFORM: 'sold_off_platform',
  RE_QUEUED: 're_queued',
  CLOSED: 'closed',
});

const OFFER_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded',
});

const EVENTS = Object.freeze({
  ACTIVATED: 'haraj.after.activated',
  MODE_CHANGED: 'haraj.after.mode_changed',
  OFFER_SUBMITTED: 'haraj.after.offer.submitted',
  OFFER_WITHDRAWN: 'haraj.after.offer.withdrawn',
  OFFER_ACCEPTED: 'haraj.after.offer.accepted',
  OFFER_REJECTED: 'haraj.after.offer.rejected',
  OFFER_SUPERSEDED: 'haraj.after.offer.superseded',
  PURCHASE_INTENT: 'haraj.after.purchase_intent',
  REAUCTION: 'haraj.after.reauction',
  REAUCTION_SOURCE: 'haraj.after.reauction.source',
  CLOSED: 'haraj.after.closed',
});

const BLOCKED_AUCTION_STATUSES = new Set([
  'draft',
  'review',
  'scheduled',
  'live',
  'extended',
  'frozen',
  'ended',
]);

const G11_UNRESOLVED = new Set(['provisional', 'inspection_pending', 'disputed']);

function fail(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  throw err;
}

function listingVersion(row) {
  return new Date(row.updated_at).toISOString();
}

function assertFresh(listing, expectedUpdatedAt) {
  if (!listing) return;
  if (expectedUpdatedAt == null || String(expectedUpdatedAt).trim() === '') {
    fail(409, 'AFTER_HARAJ_STALE_STATE', 'expectedUpdatedAt is required');
  }
  if (new Date(expectedUpdatedAt).toISOString() !== listingVersion(listing)) {
    fail(409, 'AFTER_HARAJ_STALE_STATE', 'After-Haraj state has changed');
  }
}

function offerTtlHours() {
  const env = Number(process.env.HARAJ_AFTER_OFFER_HOURS || 72);
  return Number.isFinite(env) && env > 0 && env <= 720 ? env : 72;
}

function isStagingAppEnv() {
  const app = String(process.env.APP_ENV || process.env.NOMAS_ENV || '')
    .trim()
    .toLowerCase();
  const node = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (app === 'production' || (node === 'production' && app !== 'staging')) return false;
  if (app === 'staging') return true;
  const service = String(process.env.RENDER_SERVICE_NAME || process.env.RENDER_SERVICE_ID || '');
  return /horse-backend-staging|srv-dabp5bek1f9s7391feq0/i.test(service);
}

function canonicalMode(raw) {
  const m = String(raw || '').trim();
  if (m === 'fixed_price' || m === 'FIXED_PRICE') return MODES.FIXED_PRICE;
  if (m === 'offers' || m === 'ACCEPT_OFFERS') return MODES.ACCEPT_OFFERS;
  if (m === 'reauction' || m === 'RE_AUCTION' || m === 're-auction') return MODES.RE_AUCTION;
  if (m === 'HISTORY_ONLY' || m === 'history-only') return MODES.HISTORY_ONLY;
  if (m === 'CLOSE' || m === 'close') return MODES.CLOSED;
  if (Object.values(MODES).includes(m)) return m;
  fail(400, 'AFTER_HARAJ_MODE_INVALID', `Unsupported After-Haraj mode: ${raw}`);
}

/**
 * Backend-authoritative G11 → G12 eligibility.
 * Fail closed. Do not guess.
 */
function assessEligibility({
  auctionStatus,
  awardStatus,
  listingStatus,
  extendedUntil,
}) {
  const status = String(auctionStatus || '');
  if (status === 'extended' || (extendedUntil && !['sold', 'unsold', 'cancelled'].includes(status))) {
    return {
      eligible: false,
      reason: 'AUCTION_STILL_ACTIVE',
      detail: 'After-Haraj is blocked while the auction is live or anti-snipe extended',
    };
  }
  if (BLOCKED_AUCTION_STATUSES.has(status)) {
    return {
      eligible: false,
      reason: 'AUCTION_NOT_TERMINAL',
      detail: `Auction status ${status} cannot enter After-Haraj`,
    };
  }

  if (listingStatus === LISTING_STATUS.SOLD_OFF_PLATFORM) {
    return {
      eligible: false,
      reason: 'AFTER_HARAJ_ALREADY_ACCEPTED',
      detail: 'An accepted After-Haraj commercial handoff is already active',
      viewOnly: true,
    };
  }
  if (listingStatus === LISTING_STATUS.RE_QUEUED) {
    return {
      eligible: false,
      reason: 'AFTER_HARAJ_REAUCTION_ACTIVE',
      detail: 'A re-auction occurrence already exists for this Lot',
      viewOnly: true,
    };
  }

  if (status === 'unsold') {
    return { eligible: true, reason: 'UNSOLD', detail: 'No winner — seller may choose disposition' };
  }

  if (status === 'cancelled') {
    if (awardStatus === 'accepted') {
      return {
        eligible: false,
        reason: 'BINDING_PURCHASE_ACTIVE',
        detail: 'Cancelled auction still has an accepted award — fail closed',
      };
    }
    return {
      eligible: true,
      reason: 'AUCTION_CANCELLED',
      detail: 'No completed binding purchase — seller may choose disposition',
    };
  }

  if (status === 'sold') {
    if (!awardStatus) {
      return {
        eligible: false,
        reason: 'G11_CASE_MISSING',
        detail: 'Sold Lot without G11 award is unresolved — After-Haraj blocked',
      };
    }
    if (awardStatus === 'accepted') {
      return {
        eligible: false,
        reason: 'BINDING_PURCHASE_ACTIVE',
        detail: 'Buyer accepted — competing After-Haraj sale is forbidden',
      };
    }
    if (G11_UNRESOLVED.has(awardStatus)) {
      return {
        eligible: false,
        reason: 'G11_UNRESOLVED',
        detail: `G11 award ${awardStatus} still blocks seller disposition`,
      };
    }
    if (awardStatus === 'withdrawn') {
      return {
        eligible: false,
        reason: 'G11_WITHDRAWAL_OBLIGATION',
        detail: 'Buyer withdrawal keeps G10 exposure for later G16 — do not bypass',
      };
    }
    if (awardStatus === 'cancelled') {
      return {
        eligible: true,
        reason: 'G11_AWARD_VOIDED',
        detail: 'Confirmed material mismatch / authorized void — Lot may be disposed',
      };
    }
    return {
      eligible: false,
      reason: 'G11_UNKNOWN_AWARD',
      detail: `Unknown award status ${awardStatus}`,
    };
  }

  return {
    eligible: false,
    reason: 'AUCTION_STATUS_UNKNOWN',
    detail: `Auction status ${status} is not eligible`,
  };
}

function availableModes(eligibility, listing) {
  if (!eligibility.eligible) return [];
  if (listing && listing.status === LISTING_STATUS.LISTED) {
    return [MODES.FIXED_PRICE, MODES.ACCEPT_OFFERS, MODES.RE_AUCTION, MODES.HISTORY_ONLY, MODES.CLOSED];
  }
  return [MODES.FIXED_PRICE, MODES.ACCEPT_OFFERS, MODES.RE_AUCTION, MODES.HISTORY_ONLY, MODES.CLOSED];
}

function lastBidFlags() {
  return {
    lastBidUsedAsPrice: false,
    lastBidUsedAsMinOffer: false,
    lastBidUsedAsReauctionStart: false,
    lastBidUsedAsReserve: false,
  };
}

function viewerRole({ auction, actorUserId, actorRole }) {
  const role = String(actorRole || '');
  if (role === 'admin') return 'admin';
  const actor = String(actorUserId || '');
  if (actor && auction && actor === String(auction.owner_user_id)) return 'seller';
  if (actor) return 'buyer';
  return 'anon';
}

function assertSeller(auction, actorUserId) {
  if (!actorUserId || String(auction.owner_user_id) !== String(actorUserId)) {
    fail(403, 'AFTER_HARAJ_SELLER_ONLY', 'Only the Lot seller may choose After-Haraj disposition');
  }
}

function stripPrivate(view, role) {
  const next = { ...view };
  delete next.bidLimit;
  delete next.activeExposure;
  delete next.authorizedLimit;
  delete next.psp;
  delete next.pspReference;
  delete next.privateBuyerContact;
  delete next.privateSellerContact;
  delete next.inspectionEvidence;
  delete next.operatorNotes;
  delete next.riskFlags;
  if (role !== 'admin' && role !== 'seller') {
    delete next.sellerUserId;
  }
  if (role !== 'admin' && role !== 'seller' && role !== 'buyer') {
    next.offers = [];
  }
  return next;
}

async function tablesReady(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.haraj_after_listings') AS l,
            to_regclass('public.haraj_provisional_awards') AS a`,
  );
  return Boolean(rows[0] && rows[0].l && rows[0].a);
}

async function assertTables(client) {
  if (!(await tablesReady(client))) {
    fail(503, 'AFTER_HARAJ_SCHEMA_MISSING', 'haraj_after_listings is not available');
  }
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

async function loadAuction(client, auctionId) {
  const { rows } = await client.query(
    `SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
     FROM auctions a
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE a.id = $1`,
    [auctionId],
  );
  if (!rows[0]) fail(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  return rows[0];
}

async function loadAward(client, auctionId) {
  const { rows } = await client.query(
    `SELECT * FROM haraj_provisional_awards WHERE auction_id = $1`,
    [auctionId],
  );
  return rows[0] || null;
}

async function loadListingForUpdate(client, auctionId) {
  const { rows } = await client.query(
    `SELECT * FROM haraj_after_listings WHERE auction_id = $1 FOR UPDATE`,
    [auctionId],
  );
  return rows[0] || null;
}

async function loadListing(client, auctionId) {
  const { rows } = await client.query(
    `SELECT * FROM haraj_after_listings WHERE auction_id = $1`,
    [auctionId],
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

function requireIdempotency(key) {
  const k = String(key || '').trim();
  if (!k || k.length < 6 || k.length > 180) {
    fail(400, 'AFTER_HARAJ_IDEMPOTENCY_REQUIRED', 'idempotencyKey is required');
  }
  return k;
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

function mediaReuse(row) {
  return {
    reused: true,
    binariesDuplicated: false,
    images: parseMediaImages(row.media_images),
    videoCloudflareId: row.media_video_cloudflare_id || null,
    videoHlsUrl: row.media_video_hls_url || null,
    videoThumbnailUrl: row.media_video_thumbnail_url || null,
  };
}

function historicalHaraj(row) {
  return {
    auctionId: row.id,
    highestBid: row.current_price != null ? money(row.current_price) : null,
    startingPrice: money(row.starting_price),
    reservePrice: row.reserve_price != null ? money(row.reserve_price) : null,
    result: row.status,
    winnerUserId: row.winner_user_id || null,
    startAt: row.start_at,
    endAt: row.end_at,
    note: 'Historical Haraj truth. Not the current After-Haraj sale price.',
  };
}

async function loadOfferEvents(client, auctionId) {
  const { rows } = await client.query(
    `SELECT event_type, payload, created_at, actor_user_id
     FROM auction_events
     WHERE auction_id = $1
       AND event_type LIKE 'haraj.after.offer.%'
     ORDER BY created_at ASC`,
    [auctionId],
  );
  return rows;
}

function rebuildOffers(events, now) {
  const map = new Map();
  for (const row of events) {
    const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const id = p.offerId;
    if (!id) continue;
    if (row.event_type === EVENTS.OFFER_SUBMITTED) {
      map.set(id, {
        offerId: id,
        buyerUserId: p.buyerUserId,
        amount: money(p.amount),
        status: OFFER_STATUS.PENDING,
        expiresAt: p.expiresAt || null,
        createdAt: row.created_at,
        idempotencyKey: p.idempotencyKey || null,
      });
    } else if (row.event_type === EVENTS.OFFER_WITHDRAWN && map.has(id)) {
      map.set(id, { ...map.get(id), status: OFFER_STATUS.WITHDRAWN, withdrawnAt: row.created_at });
    } else if (row.event_type === EVENTS.OFFER_ACCEPTED && map.has(id)) {
      map.set(id, { ...map.get(id), status: OFFER_STATUS.ACCEPTED, acceptedAt: row.created_at });
    } else if (row.event_type === EVENTS.OFFER_REJECTED && map.has(id)) {
      map.set(id, { ...map.get(id), status: OFFER_STATUS.REJECTED, rejectedAt: row.created_at });
    } else if (row.event_type === EVENTS.OFFER_SUPERSEDED && map.has(id)) {
      map.set(id, { ...map.get(id), status: OFFER_STATUS.SUPERSEDED, supersededAt: row.created_at });
    }
  }
  const nowMs = new Date(now).getTime();
  for (const [id, offer] of map) {
    if (
      offer.status === OFFER_STATUS.PENDING &&
      offer.expiresAt &&
      new Date(offer.expiresAt).getTime() <= nowMs
    ) {
      map.set(id, { ...offer, status: OFFER_STATUS.EXPIRED });
    }
  }
  return [...map.values()];
}

function filterOffers(offers, role, actorUserId) {
  if (role === 'admin' || role === 'seller') return offers;
  if (role === 'buyer') {
    return offers.filter((o) => String(o.buyerUserId) === String(actorUserId));
  }
  return [];
}

function publicOffer(offer, role) {
  const row = {
    offerId: offer.offerId,
    amount: offer.amount,
    status: offer.status,
    expiresAt: offer.expiresAt,
    createdAt: offer.createdAt,
  };
  if (role === 'admin' || role === 'seller') {
    row.buyerUserId = offer.buyerUserId;
  }
  return row;
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

function listingView(listing) {
  if (!listing) return null;
  return {
    id: listing.id,
    mode: listing.mode,
    status: listing.status,
    approvedPrice: listing.approved_price != null ? money(listing.approved_price) : null,
    offersEnabled: listing.offers_enabled === true,
    sellerChoseAt: listing.seller_chose_at,
    expiresAt: listing.expires_at,
    expectedUpdatedAt: listingVersion(listing),
  };
}

function currentCommercial(listing) {
  if (!listing || listing.status !== LISTING_STATUS.LISTED) {
    return {
      mode: listing?.mode || null,
      status: listing?.status || null,
      approvedPrice: null,
      offersEnabled: false,
      ...lastBidFlags(),
    };
  }
  return {
    mode: listing.mode,
    status: listing.status,
    approvedPrice:
      listing.mode === MODES.FIXED_PRICE && listing.approved_price != null
        ? money(listing.approved_price)
        : null,
    offersEnabled: listing.mode === MODES.ACCEPT_OFFERS && listing.offers_enabled === true,
    ...lastBidFlags(),
  };
}

async function assembleView(client, {
  auction,
  award,
  listing,
  actorUserId,
  actorRole,
}) {
  const role = viewerRole({ auction, actorUserId, actorRole });
  const eligibility = assessEligibility({
    auctionStatus: auction.status,
    awardStatus: award?.status || null,
    listingStatus: listing?.status || null,
    extendedUntil: auction.extended_until,
  });
  const offers = rebuildOffers(await loadOfferEvents(client, auction.id), serverNow());
  const accepted = offers.find((o) => o.status === OFFER_STATUS.ACCEPTED) || null;
  const reauction = await latestEvent(client, auction.id, EVENTS.REAUCTION);
  const purchase = await latestEvent(client, auction.id, EVENTS.PURCHASE_INTENT);
  const visibleOffers = filterOffers(offers, role, actorUserId).map((o) => publicOffer(o, role));
  const view = {
    auctionId: auction.id,
    lotId: auction.lot_id,
    lotTitle: auction.lot_title || null,
    species: auction.species,
    auctionStatus: auction.status,
    sellerUserId: auction.owner_user_id,
    eligible: eligibility.eligible,
    eligibilityReason: eligibility.reason,
    eligibilityDetail: eligibility.detail,
    availableModes: availableModes(eligibility, listing),
    listing: listingView(listing),
    historicalHaraj: historicalHaraj(auction),
    currentCommercial: currentCommercial(listing),
    currentPresentation: (await latestEvent(client, auction.id, EVENTS.MODE_CHANGED))?.payload?.currentPresentation
      || (await latestEvent(client, auction.id, EVENTS.ACTIVATED))?.payload?.currentPresentation
      || null,
    media: mediaReuse(auction),
    offers: visibleOffers,
    acceptedOffer: accepted ? publicOffer(accepted, role) : null,
    purchaseIntent: purchase
      ? {
          status: 'handoff',
          settlementImplemented: false,
          createdAt: purchase.created_at,
        }
      : null,
    reauction: reauction
      ? {
          newAuctionId: reauction.payload?.newAuctionId || null,
          startingPrice: reauction.payload?.startingPrice ?? null,
          reservePrice: reauction.payload?.reservePrice ?? null,
          lastBidCopied: false,
        }
      : null,
    g11: {
      awardStatus: award?.status || null,
      inspectionHistoryPreserved: true,
    },
    settlementImplemented: false,
    walletCreated: false,
    escrowCreated: false,
    nomasCustody: false,
    ai: AI_STATUS,
    livekit: { implemented: false, classification: 'NOT IMPLEMENTED / NOT TESTED' },
    viewerRole: role,
    serverTime: new Date().toISOString(),
  };
  return stripPrivate(view, role);
}

async function getAfterHaraj(client, input) {
  await assertTables(client);
  const auction = await loadAuction(client, input.auctionId);
  const award = await loadAward(client, input.auctionId);
  const listing = await loadListing(client, input.auctionId);
  const role = viewerRole({ auction, actorUserId: input.actorUserId, actorRole: input.actorRole });
  if (role === 'anon') {
    fail(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return assembleView(client, {
    auction,
    award,
    listing,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
}

async function publicSummary(client, auctionId) {
  try {
    if (!(await tablesReady(client))) return null;
    const listing = await loadListing(client, auctionId);
    if (!listing) return null;
    return {
      mode: listing.mode,
      status: listing.status,
      approvedPrice:
        listing.mode === MODES.FIXED_PRICE && listing.status === LISTING_STATUS.LISTED
          ? money(listing.approved_price)
          : null,
      offersEnabled: listing.mode === MODES.ACCEPT_OFFERS && listing.status === LISTING_STATUS.LISTED,
      lastBidUsedAsPrice: false,
    };
  } catch (_) {
    return null;
  }
}

async function supersedePendingOffers(client, auctionId, actorUserId, reason) {
  const offers = rebuildOffers(await loadOfferEvents(client, auctionId), serverNow());
  const pending = offers.filter((o) => o.status === OFFER_STATUS.PENDING);
  for (const offer of pending) {
    await appendEvent(client, {
      auctionId,
      eventType: EVENTS.OFFER_SUPERSEDED,
      payload: {
        offerId: offer.offerId,
        buyerUserId: offer.buyerUserId,
        amount: offer.amount,
        reason,
        deleted: false,
      },
      actorUserId,
    });
  }
  return pending.length;
}

function listingWriteValues(mode, approvedPrice) {
  if (mode === MODES.FIXED_PRICE) {
    if (approvedPrice == null) {
      fail(400, 'AFTER_HARAJ_PRICE_REQUIRED', 'Seller must explicitly enter the After-Haraj asking price');
    }
    const price = money(approvedPrice);
    if (!(price > 0)) {
      fail(400, 'AFTER_HARAJ_PRICE_INVALID', 'approvedPrice must be > 0 SAR');
    }
    return {
      mode,
      approved_price: price,
      offers_enabled: false,
      status: LISTING_STATUS.LISTED,
    };
  }
  if (mode === MODES.ACCEPT_OFFERS) {
    return {
      mode,
      approved_price: null,
      offers_enabled: true,
      status: LISTING_STATUS.LISTED,
    };
  }
  if (mode === MODES.RE_AUCTION) {
    return {
      mode,
      approved_price: null,
      offers_enabled: false,
      status: LISTING_STATUS.RE_QUEUED,
    };
  }
  return {
    mode: mode === MODES.CLOSED ? MODES.CLOSED : MODES.HISTORY_ONLY,
    approved_price: null,
    offers_enabled: false,
    status: LISTING_STATUS.CLOSED,
  };
}

async function upsertListing(client, auctionId, values) {
  const { rows } = await client.query(
    `INSERT INTO haraj_after_listings (
       auction_id, mode, approved_price, offers_enabled, status, seller_chose_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (auction_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       approved_price = EXCLUDED.approved_price,
       offers_enabled = EXCLUDED.offers_enabled,
       status = EXCLUDED.status,
       seller_chose_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [auctionId, values.mode, values.approved_price, values.offers_enabled, values.status],
  );
  return rows[0];
}

async function createReauctionDraft(client, { source, actorUserId, body }) {
  if (body.startingPrice == null || body.startingPrice === '') {
    fail(400, 'REAUCTION_STARTING_PRICE_REQUIRED', 'Seller must explicitly enter the new starting price');
  }
  if (!body.startAt || !body.endAt) {
    fail(400, 'REAUCTION_WINDOW_REQUIRED', 'Seller must explicitly enter the new auction window');
  }
  const startingPrice = money(body.startingPrice);
  if (!(startingPrice > 0)) {
    fail(400, 'REAUCTION_STARTING_PRICE_INVALID', 'startingPrice must be > 0 SAR');
  }
  const historical = money(source.current_price);
  if (body.copyLastBid === true || body.useHighestBid === true) {
    fail(400, 'LAST_BID_AUTO_COPY_FORBIDDEN', LAST_BID_RULE);
  }
  const reserve = body.reservePrice != null && body.reservePrice !== ''
    ? money(body.reservePrice)
    : null;
  const increment = body.minimumIncrement != null
    ? money(body.minimumIncrement)
    : money(source.minimum_increment);
  const created = await createAuctionDraft(client, {
    reuseLotId: source.lot_id,
    ownerUserId: source.owner_user_id,
    createdByUserId: actorUserId,
    createdByRole: 'seller',
    species: source.species,
    title: source.lot_title || source.species,
    startingPrice,
    reservePrice: reserve,
    minimumIncrement: increment,
    startAt: body.startAt,
    endAt: body.endAt,
    antiSnipingSeconds: body.antiSnipingSeconds != null ? Number(body.antiSnipingSeconds) : 0,
    description: body.currentPresentation?.description || source.description || null,
    breed: source.breed,
    gender: source.gender,
    color: source.color,
    ageLabel: source.age_label,
    locationSnapshot: {
      city: source.location_city,
      district: source.location_district,
      address: source.location_address,
      lat: source.location_lat,
      lng: source.location_lng,
      sourceListingId: source.location_source_listing_id,
      capturedAt: source.location_captured_at,
    },
    media: {
      mediaVideoCloudflareId: source.media_video_cloudflare_id,
      mediaVideoHlsUrl: source.media_video_hls_url,
      mediaVideoThumbnailUrl: source.media_video_thumbnail_url,
      mediaImages: parseMediaImages(source.media_images),
    },
  });
  return {
    created,
    startingPrice,
    reservePrice: reserve,
    historicalHighestBid: historical,
    lastBidCopied: false,
    mediaReused: {
      videoCloudflareId: source.media_video_cloudflare_id,
      binariesDuplicated: false,
    },
  };
}

async function activateDisposition(client, input) {
  await assertTables(client);
  const idempotencyKey = requireIdempotency(input.idempotencyKey);
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  if (input.actorRole === 'auctioneer' && String(auction.owner_user_id) !== String(input.actorUserId)) {
    fail(403, 'AFTER_HARAJ_AUCTIONEER_FORBIDDEN', 'Auctioneer cannot control seller After-Haraj disposition');
  }
  assertSeller(auction, input.actorUserId);
  const award = await loadAward(client, input.auctionId);
  const listing = await loadListingForUpdate(client, input.auctionId);
  const replay = await findReplay(client, input.auctionId, idempotencyKey);
  if (replay) {
    return { replay: true, view: await assembleView(client, { auction, award, listing, actorUserId: input.actorUserId, actorRole: input.actorRole }) };
  }
  const eligibility = assessEligibility({
    auctionStatus: auction.status,
    awardStatus: award?.status || null,
    listingStatus: listing?.status || null,
    extendedUntil: auction.extended_until,
  });
  if (!eligibility.eligible) {
    fail(409, eligibility.reason, eligibility.detail);
  }
  if (listing) assertFresh(listing, input.expectedUpdatedAt);

  const mode = canonicalMode(input.mode);
  const values = listingWriteValues(mode, input.approvedPrice);
  let reauction = null;
  if (mode === MODES.RE_AUCTION) {
    reauction = await createReauctionDraft(client, {
      source: auction,
      actorUserId: input.actorUserId,
      body: input,
    });
  }

  const supersededCount = listing && listing.mode === MODES.ACCEPT_OFFERS && mode !== MODES.ACCEPT_OFFERS
    ? await supersedePendingOffers(client, input.auctionId, input.actorUserId, `mode_switch:${mode}`)
    : 0;

  const next = await upsertListing(client, input.auctionId, values);
  const eventType = listing ? EVENTS.MODE_CHANGED : EVENTS.ACTIVATED;
  await appendEvent(client, {
    auctionId: input.auctionId,
    eventType,
    payload: {
      idempotencyKey,
      mode,
      previousMode: listing?.mode || null,
      approvedPrice: values.approved_price,
      lastBidAutoUsed: false,
      historicalHighestBid: money(auction.current_price),
      supersededPendingOffers: supersededCount,
      pendingOffersDeleted: false,
      currentPresentation: input.currentPresentation || null,
      newAuctionId: reauction?.created?.id || null,
    },
    actorUserId: input.actorUserId,
  });
  if (reauction) {
    await appendEvent(client, {
      auctionId: input.auctionId,
      eventType: EVENTS.REAUCTION,
      payload: {
        idempotencyKey: `${idempotencyKey}:reauction`,
        sourceAuctionId: input.auctionId,
        newAuctionId: reauction.created.id,
        lotId: auction.lot_id,
        startingPrice: reauction.startingPrice,
        reservePrice: reauction.reservePrice,
        lastBidCopied: false,
        mediaReused: true,
        binariesDuplicated: false,
      },
      actorUserId: input.actorUserId,
    });
    await appendEvent(client, {
      auctionId: reauction.created.id,
      eventType: EVENTS.REAUCTION_SOURCE,
      payload: {
        sourceAuctionId: input.auctionId,
        lotId: auction.lot_id,
        lastBidCopied: false,
      },
      actorUserId: input.actorUserId,
    });
  }
  if (mode === MODES.HISTORY_ONLY || mode === MODES.CLOSED) {
    await appendEvent(client, {
      auctionId: input.auctionId,
      eventType: EVENTS.CLOSED,
      payload: { idempotencyKey: `${idempotencyKey}:close`, mode, historyPreserved: true },
      actorUserId: input.actorUserId,
    });
  }

  const view = await assembleView(client, {
    auction,
    award,
    listing: next,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
  });
  return {
    replay: false,
    view,
    notifications: buildSellerModeNotifications(auction, next, input.actorUserId),
  };
}

function buildSellerModeNotifications(auction, listing, sellerUserId) {
  return [
    {
      userId: sellerUserId,
      title: 'تم حفظ قرار ما بعد الحراج',
      body: `الوضع الحالي: ${listing.mode}`,
      meta: { auctionId: auction.id, mode: listing.mode, gate: 'G12' },
    },
  ];
}

async function submitOffer(client, input) {
  await assertTables(client);
  const idempotencyKey = requireIdempotency(input.idempotencyKey);
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  if (!input.actorUserId) fail(401, 'AUTH_REQUIRED', 'Authentication required');
  if (String(auction.owner_user_id) === String(input.actorUserId)) {
    fail(403, 'AFTER_HARAJ_SELLER_CANNOT_OFFER', 'Seller cannot submit a buyer offer on own Lot');
  }
  const listing = await loadListingForUpdate(client, input.auctionId);
  const replay = await findReplay(client, input.auctionId, idempotencyKey);
  if (replay) {
    const award = await loadAward(client, input.auctionId);
    return {
      replay: true,
      view: await assembleView(client, {
        auction,
        award,
        listing,
        actorUserId: input.actorUserId,
        actorRole: 'buyer',
      }),
    };
  }
  if (!listing || listing.status !== LISTING_STATUS.LISTED || listing.mode !== MODES.ACCEPT_OFFERS) {
    fail(409, 'AFTER_HARAJ_OFFERS_NOT_ACTIVE', 'Lot is not accepting After-Haraj offers');
  }
  const amount = money(input.amount);
  if (!(amount > 0)) fail(400, 'AFTER_HARAJ_OFFER_AMOUNT', 'Offer amount must be > 0 SAR');
  const now = serverNow();
  let ttlMs = offerTtlHours() * 3600 * 1000;
  if (isStagingAppEnv() && input.stagingExpiresInSeconds != null) {
    const sec = Number(input.stagingExpiresInSeconds);
    if (Number.isFinite(sec) && sec >= 0 && sec <= 120) ttlMs = Math.round(sec * 1000);
  }
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const offerId = randomUUID();
  await appendEvent(client, {
    auctionId: input.auctionId,
    eventType: EVENTS.OFFER_SUBMITTED,
    payload: {
      idempotencyKey,
      offerId,
      buyerUserId: String(input.actorUserId),
      amount,
      status: OFFER_STATUS.PENDING,
      expiresAt,
      notAuctionBid: true,
      placeBidUsed: false,
    },
    actorUserId: input.actorUserId,
  });
  const award = await loadAward(client, input.auctionId);
  return {
    replay: false,
    offerId,
    view: await assembleView(client, {
      auction,
      award,
      listing,
      actorUserId: input.actorUserId,
      actorRole: 'buyer',
    }),
    notifications: [
      {
        userId: auction.owner_user_id,
        title: 'عرض جديد بعد الحراج',
        body: `عرض بمبلغ ${amount} ر.س`,
        meta: { auctionId: input.auctionId, offerId, gate: 'G12' },
      },
    ],
  };
}

function assertOfferPending(offer, now) {
  if (!offer) fail(404, 'AFTER_HARAJ_OFFER_NOT_FOUND', 'Offer not found');
  if (offer.status === OFFER_STATUS.EXPIRED || (offer.expiresAt && new Date(offer.expiresAt) <= now)) {
    fail(409, 'AFTER_HARAJ_OFFER_EXPIRED', 'Expired offer cannot be accepted or withdrawn as pending');
  }
  if (offer.status !== OFFER_STATUS.PENDING) {
    fail(409, 'AFTER_HARAJ_OFFER_NOT_PENDING', `Offer is ${offer.status}`);
  }
}

async function withdrawOffer(client, input) {
  await assertTables(client);
  const idempotencyKey = requireIdempotency(input.idempotencyKey);
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  const listing = await loadListingForUpdate(client, input.auctionId);
  const replay = await findReplay(client, input.auctionId, idempotencyKey);
  if (replay) {
    const award = await loadAward(client, input.auctionId);
    return { replay: true, view: await assembleView(client, { auction, award, listing, actorUserId: input.actorUserId, actorRole: 'buyer' }) };
  }
  const offers = rebuildOffers(await loadOfferEvents(client, input.auctionId), serverNow());
  const offer = offers.find((o) => o.offerId === input.offerId);
  if (!offer) fail(404, 'AFTER_HARAJ_OFFER_NOT_FOUND', 'Offer not found');
  if (String(offer.buyerUserId) !== String(input.actorUserId)) {
    fail(403, 'AFTER_HARAJ_OFFER_NOT_OWNED', 'Buyer may withdraw only their own offer');
  }
  if (offer.status === OFFER_STATUS.ACCEPTED) {
    fail(409, 'AFTER_HARAJ_OFFER_ALREADY_ACCEPTED', 'Accepted offer cannot be withdrawn');
  }
  assertOfferPending(offer, serverNow());
  await appendEvent(client, {
    auctionId: input.auctionId,
    eventType: EVENTS.OFFER_WITHDRAWN,
    payload: {
      idempotencyKey,
      offerId: offer.offerId,
      buyerUserId: offer.buyerUserId,
      amount: offer.amount,
    },
    actorUserId: input.actorUserId,
  });
  const award = await loadAward(client, input.auctionId);
  return {
    replay: false,
    view: await assembleView(client, { auction, award, listing, actorUserId: input.actorUserId, actorRole: 'buyer' }),
    notifications: [
      {
        userId: auction.owner_user_id,
        title: 'سُحب عرض بعد الحراج',
        body: `العرض ${offer.offerId} سُحب`,
        meta: { auctionId: input.auctionId, offerId: offer.offerId, gate: 'G12' },
      },
    ],
  };
}

async function decideOffer(client, input) {
  await assertTables(client);
  const idempotencyKey = requireIdempotency(input.idempotencyKey);
  const decision = String(input.decision || '');
  if (decision !== 'accept' && decision !== 'reject') {
    fail(400, 'AFTER_HARAJ_DECISION_INVALID', 'decision must be accept or reject');
  }
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  if (input.actorRole === 'auctioneer' && String(auction.owner_user_id) !== String(input.actorUserId)) {
    fail(403, 'AFTER_HARAJ_AUCTIONEER_FORBIDDEN', 'Auctioneer cannot accept or reject seller offers');
  }
  assertSeller(auction, input.actorUserId);
  const listing = await loadListingForUpdate(client, input.auctionId);
  const replay = await findReplay(client, input.auctionId, idempotencyKey);
  if (replay) {
    const award = await loadAward(client, input.auctionId);
    return { replay: true, view: await assembleView(client, { auction, award, listing, actorUserId: input.actorUserId, actorRole: 'seller' }) };
  }
  if (listing) assertFresh(listing, input.expectedUpdatedAt);
  if (!listing || listing.status !== LISTING_STATUS.LISTED || listing.mode !== MODES.ACCEPT_OFFERS) {
    fail(409, 'AFTER_HARAJ_OFFERS_NOT_ACTIVE', 'Lot is not in accept-offers mode');
  }
  const offers = rebuildOffers(await loadOfferEvents(client, input.auctionId), serverNow());
  if (decision === 'accept' && offers.some((o) => o.status === OFFER_STATUS.ACCEPTED)) {
    fail(409, 'AFTER_HARAJ_ALREADY_ACCEPTED', 'Exactly one accepted After-Haraj offer is allowed');
  }
  const offer = offers.find((o) => o.offerId === input.offerId);
  assertOfferPending(offer, serverNow());

  if (decision === 'accept') {
    const { rows } = await client.query(
      `UPDATE haraj_after_listings
       SET status = $2, offers_enabled = false, updated_at = NOW()
       WHERE auction_id = $1 AND status = $3 AND mode = $4
       RETURNING *`,
      [input.auctionId, LISTING_STATUS.SOLD_OFF_PLATFORM, LISTING_STATUS.LISTED, MODES.ACCEPT_OFFERS],
    );
    if (!rows[0]) {
      fail(409, 'AFTER_HARAJ_ACCEPT_CONFLICT', 'Another acceptance already won');
    }
    await appendEvent(client, {
      auctionId: input.auctionId,
      eventType: EVENTS.OFFER_ACCEPTED,
      payload: {
        idempotencyKey,
        offerId: offer.offerId,
        buyerUserId: offer.buyerUserId,
        amount: offer.amount,
        settlementImplemented: false,
        handoffOnly: true,
      },
      actorUserId: input.actorUserId,
    });
    const remaining = offers.filter((o) => o.offerId !== offer.offerId && o.status === OFFER_STATUS.PENDING);
    for (const other of remaining) {
      await appendEvent(client, {
        auctionId: input.auctionId,
        eventType: EVENTS.OFFER_SUPERSEDED,
        payload: {
          offerId: other.offerId,
          buyerUserId: other.buyerUserId,
          amount: other.amount,
          reason: 'another_offer_accepted',
          deleted: false,
        },
        actorUserId: input.actorUserId,
      });
    }
    const award = await loadAward(client, input.auctionId);
    return {
      replay: false,
      view: await assembleView(client, { auction, award, listing: rows[0], actorUserId: input.actorUserId, actorRole: 'seller' }),
      notifications: [
        {
          userId: offer.buyerUserId,
          title: 'قُبل عرضك بعد الحراج',
          body: 'قبول تجاري فقط — لا تحصيل ولا تحويل ملكية تلقائي.',
          meta: { auctionId: input.auctionId, offerId: offer.offerId, gate: 'G12' },
        },
      ],
    };
  }

  await appendEvent(client, {
    auctionId: input.auctionId,
    eventType: EVENTS.OFFER_REJECTED,
    payload: {
      idempotencyKey,
      offerId: offer.offerId,
      buyerUserId: offer.buyerUserId,
      amount: offer.amount,
    },
    actorUserId: input.actorUserId,
  });
  const award = await loadAward(client, input.auctionId);
  return {
    replay: false,
    view: await assembleView(client, { auction, award, listing, actorUserId: input.actorUserId, actorRole: 'seller' }),
    notifications: [
      {
        userId: offer.buyerUserId,
        title: 'رُفض عرضك بعد الحراج',
        body: `العرض ${offer.offerId} رُفض`,
        meta: { auctionId: input.auctionId, offerId: offer.offerId, gate: 'G12' },
      },
    ],
  };
}

async function createPurchaseIntent(client, input) {
  await assertTables(client);
  const idempotencyKey = requireIdempotency(input.idempotencyKey);
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  if (!input.actorUserId) fail(401, 'AUTH_REQUIRED', 'Authentication required');
  if (String(auction.owner_user_id) === String(input.actorUserId)) {
    fail(403, 'AFTER_HARAJ_SELLER_CANNOT_BUY', 'Seller cannot create a buyer purchase intent on own Lot');
  }
  const listing = await loadListingForUpdate(client, input.auctionId);
  const replay = await findReplay(client, input.auctionId, idempotencyKey);
  if (replay) {
    const award = await loadAward(client, input.auctionId);
    return { replay: true, view: await assembleView(client, { auction, award, listing, actorUserId: input.actorUserId, actorRole: 'buyer' }) };
  }
  if (!listing || listing.status !== LISTING_STATUS.LISTED || listing.mode !== MODES.FIXED_PRICE) {
    fail(409, 'AFTER_HARAJ_FIXED_PRICE_NOT_ACTIVE', 'Lot is not listed at a seller-approved fixed price');
  }
  const price = money(listing.approved_price);
  const { rows } = await client.query(
    `UPDATE haraj_after_listings
     SET status = $2, updated_at = NOW()
     WHERE auction_id = $1 AND status = $3 AND mode = $4
     RETURNING *`,
    [input.auctionId, LISTING_STATUS.SOLD_OFF_PLATFORM, LISTING_STATUS.LISTED, MODES.FIXED_PRICE],
  );
  if (!rows[0]) {
    fail(409, 'AFTER_HARAJ_ACCEPT_CONFLICT', 'Another purchase intent already won');
  }
  await appendEvent(client, {
    auctionId: input.auctionId,
    eventType: EVENTS.PURCHASE_INTENT,
    payload: {
      idempotencyKey,
      buyerUserId: String(input.actorUserId),
      amount: price,
      status: 'handoff',
      settlementImplemented: false,
      lastBidUsedAsPrice: false,
    },
    actorUserId: input.actorUserId,
  });
  const award = await loadAward(client, input.auctionId);
  return {
    replay: false,
    view: await assembleView(client, { auction, award, listing: rows[0], actorUserId: input.actorUserId, actorRole: 'buyer' }),
    notifications: [
      {
        userId: auction.owner_user_id,
        title: 'نية شراء بسعر ثابت بعد الحراج',
        body: 'قبول تجاري / تسليم لاحق — لا تحصيل الآن.',
        meta: { auctionId: input.auctionId, gate: 'G12' },
      },
    ],
  };
}

async function adminClose(client, input) {
  await assertTables(client);
  const idempotencyKey = requireIdempotency(input.idempotencyKey);
  const auction = await loadAuctionForUpdate(client, input.auctionId);
  const listing = await loadListingForUpdate(client, input.auctionId);
  const replay = await findReplay(client, input.auctionId, idempotencyKey);
  if (replay) {
    const award = await loadAward(client, input.auctionId);
    return { replay: true, view: await assembleView(client, { auction, award, listing, actorUserId: input.actorUserId, actorRole: 'admin' }) };
  }
  if (listing) assertFresh(listing, input.expectedUpdatedAt);
  if (listing && listing.status === LISTING_STATUS.SOLD_OFF_PLATFORM) {
    fail(409, 'AFTER_HARAJ_ALREADY_ACCEPTED', 'Cannot close an accepted commercial handoff');
  }
  await supersedePendingOffers(client, input.auctionId, input.actorUserId, 'admin_close');
  const next = await upsertListing(client, input.auctionId, listingWriteValues(MODES.HISTORY_ONLY));
  await appendEvent(client, {
    auctionId: input.auctionId,
    eventType: EVENTS.CLOSED,
    payload: {
      idempotencyKey,
      mode: MODES.HISTORY_ONLY,
      admin: true,
      reason: input.reason || 'admin_close',
      historyPreserved: true,
    },
    actorUserId: input.actorUserId,
  });
  const award = await loadAward(client, input.auctionId);
  return {
    replay: false,
    view: await assembleView(client, { auction, award, listing: next, actorUserId: input.actorUserId, actorRole: 'admin' }),
  };
}

async function listDiscovery(client, { species, limit } = {}) {
  await assertTables(client);
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const params = [];
  let speciesSql = '';
  if (species) {
    params.push(String(species));
    speciesSql = `AND a.species = $${params.length}`;
  }
  params.push(cap);
  const { rows } = await client.query(
    `SELECT a.id, a.species, a.status, a.current_price, a.start_at, a.end_at,
            a.media_video_cloudflare_id, a.media_video_hls_url, a.media_video_thumbnail_url,
            a.media_images, l.title AS lot_title,
            al.mode, al.status AS listing_status, al.approved_price, al.offers_enabled, al.seller_chose_at
     FROM haraj_after_listings al
     JOIN auctions a ON a.id = al.auction_id
     JOIN auction_lots l ON l.id = a.lot_id
     WHERE al.status = 'listed'
       AND (al.expires_at IS NULL OR al.expires_at > NOW())
       ${speciesSql}
     ORDER BY al.seller_chose_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    auctionId: row.id,
    lotTitle: row.lot_title,
    species: row.species,
    mode: row.mode,
    listingStatus: row.listing_status,
    approvedPrice: row.mode === MODES.FIXED_PRICE ? money(row.approved_price) : null,
    offersEnabled: row.mode === MODES.ACCEPT_OFFERS,
    historicalHighestBid: money(row.current_price),
    historicalHighestBidIsNotCurrentPrice: true,
    media: mediaReuse(row),
    lastBidUsedAsPrice: false,
    aiRanked: false,
  }));
}

async function listOperatorCases(client, { limit } = {}) {
  await assertTables(client);
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await client.query(
    `SELECT a.id, a.species, a.status, a.owner_user_id, a.current_price, a.winner_user_id,
            l.title AS lot_title, al.mode, al.status AS listing_status, al.approved_price,
            al.offers_enabled, al.updated_at, p.status AS award_status
     FROM haraj_after_listings al
     JOIN auctions a ON a.id = al.auction_id
     JOIN auction_lots l ON l.id = a.lot_id
     LEFT JOIN haraj_provisional_awards p ON p.auction_id = a.id
     ORDER BY al.updated_at DESC
     LIMIT $1`,
    [cap],
  );
  return rows.map((row) => ({
    auctionId: row.id,
    lotTitle: row.lot_title,
    species: row.species,
    auctionStatus: row.status,
    sellerUserId: row.owner_user_id,
    mode: row.mode,
    listingStatus: row.listing_status,
    approvedPrice: row.approved_price != null ? money(row.approved_price) : null,
    offersEnabled: row.offers_enabled === true,
    awardStatus: row.award_status || null,
    historicalHighestBid: money(row.current_price),
    lastBidUsedAsPrice: false,
    expectedUpdatedAt: listingVersion(row),
  }));
}

function isProductionNotifyForbidden() {
  const appEnv = String(process.env.APP_ENV || '').toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  return appEnv === 'production' || (nodeEnv === 'production' && appEnv !== 'staging');
}

module.exports = {
  AI_SCOPE,
  AI_STATUS,
  SETTLEMENT_BOUNDARY,
  RUNNER_UP_RULE,
  LAST_BID_RULE,
  G10_BOUNDARY,
  MEDIA_RULE,
  MODES,
  LISTING_STATUS,
  OFFER_STATUS,
  EVENTS,
  assessEligibility,
  availableModes,
  canonicalMode,
  lastBidFlags,
  rebuildOffers,
  listingWriteValues,
  viewerRole,
  getAfterHaraj,
  publicSummary,
  activateDisposition,
  submitOffer,
  withdrawOffer,
  decideOffer,
  createPurchaseIntent,
  adminClose,
  listDiscovery,
  listOperatorCases,
  tablesReady,
  isProductionNotifyForbidden,
};
