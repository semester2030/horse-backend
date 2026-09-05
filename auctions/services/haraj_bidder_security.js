'use strict';

/**
 * G10 domain + persistence — eligibility, Bid Security, Bid Limit, exposure.
 * Does NOT replace placeBid. Does NOT create a wallet/escrow.
 * HTTP path wraps existing placeBid after 011 tables exist.
 */

const { money } = require('./auction_service');

const ELIGIBILITY_STATES = Object.freeze([
  'not_verified',
  'pending',
  'verified',
  'suspended',
  'revoked',
]);

const SECURITY_STATES = Object.freeze([
  'required',
  'pending',
  'authorized',
  'active',
  'released',
  'expired',
  'failed',
  'cancelled',
]);

const SECURITY_SCOPES = Object.freeze([
  'global',
  'haraj',
  'session',
  'room',
  'lot',
  'policy_tier',
]);

/** G10 Staging policy: exposure is bidder-wide, not per WebSocket room. */
const G10_POLICY_SCOPE = 'global';

const BINDING_OPEN = new Set(['live', 'extended', 'frozen']);
const BINDING_CLOSED_WINNER = new Set(['ended', 'sold']);
const RELEASED = new Set(['cancelled', 'unsold', 'draft', 'review', 'scheduled']);

const STAGING_TEST_PROVIDER = Object.freeze({
  name: 'staging_test',
  mode: 'test_sandbox',
  implemented: true,
  productionReady: false,
  realMoney: false,
  label: 'TEST/SANDBOX ONLY — NOT PRODUCTION MONEY — NOT A REAL PSP',
});

const EXPOSURE_INVARIANT = [
  'TOTAL_ACTIVE_EXPOSURE is the sum of binding obligations for one bidder across all auctions.',
  'A live/extended/frozen obligation exists only while the bidder is the current highest valid bid.',
  'An ended/sold obligation exists only while winner_user_id = bidder, unless G11 award.status = cancelled (confirmed mismatch / authorized void).',
  'cancelled / unsold / draft / review / scheduled contribute 0.',
  'Outbid replaces the previous highest bidder — loser’s amount drops out (no double count).',
  'Raising your own high bid replaces that auction’s contribution (not prior+new).',
  'TOTAL_ACTIVE_EXPOSURE_AFTER_NEW_BID <= AUTHORIZED_BID_LIMIT.',
  'Same (auction_id, idempotency_key) must not consume exposure twice.',
  'Room/Session/Queue/WebSocket/LiveKit are not exposure authorities.',
].join(' ');

function fail(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  throw err;
}

function acquireBidderExposureLockSql() {
  return `SELECT pg_advisory_xact_lock(hashtext('nomas:bidder-exposure:' || $1::text))`;
}

function topBid(bids) {
  if (!bids || !bids.length) return null;
  return [...bids].sort((a, b) => {
    const d = Number(b.amount) - Number(a.amount);
    if (d !== 0) return d;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  })[0];
}

function obligationOnAuction(auction, bids, bidderUserId) {
  const status = String(auction.status || '');
  if (RELEASED.has(status)) return 0;
  const bidder = String(bidderUserId);
  if (BINDING_CLOSED_WINNER.has(status)) {
    if (String(auction.awardStatus || '') === 'cancelled') return 0;
    return String(auction.winnerUserId || '') === bidder ? money(auction.currentPrice) : 0;
  }
  if (!BINDING_OPEN.has(status)) return 0;
  const top = topBid(bids);
  if (!top || String(top.bidderUserId) !== bidder) return 0;
  return money(top.amount);
}

function totalActiveExposure(positions, bidderUserId) {
  return money(
    (positions || []).reduce(
      (sum, p) => sum + obligationOnAuction(p.auction, p.bids, bidderUserId),
      0,
    ),
  );
}

function exposureAfterNewBid({ positions, bidderUserId, auctionId, newAmount }) {
  const currentOnThis = (positions || [])
    .filter((p) => String(p.auction.id) === String(auctionId))
    .reduce((sum, p) => sum + obligationOnAuction(p.auction, p.bids, bidderUserId), 0);
  const prior = totalActiveExposure(positions, bidderUserId);
  return {
    prior,
    currentOnThis,
    resulting: money(prior - currentOnThis + money(newAmount)),
  };
}

function assertEligibility(profile) {
  if (!profile) fail(403, 'HARAJ_BIDDER_NOT_VERIFIED', 'Bidder profile is missing');
  const s = String(profile.eligibilityStatus || profile.eligibility_status || '');
  if (s === 'pending') fail(403, 'HARAJ_BIDDER_PENDING', 'Bidder verification is pending');
  if (s === 'suspended') fail(403, 'HARAJ_BIDDER_SUSPENDED', 'Bidder is suspended');
  if (s === 'revoked') fail(403, 'HARAJ_BIDDER_REVOKED', 'Bidder eligibility is revoked');
  if (s !== 'verified') fail(403, 'HARAJ_BIDDER_NOT_VERIFIED', 'Bidder is not verified');
}

function assertSecurityActive(security, now = new Date()) {
  if (!security) fail(403, 'HARAJ_BID_SECURITY_MISSING', 'Bid Security is required');
  const status = String(security.status || '');
  if (status === 'expired') fail(403, 'HARAJ_BID_SECURITY_EXPIRED', 'Bid Security expired');
  if (status === 'failed') fail(403, 'HARAJ_BID_SECURITY_FAILED', 'Bid Security failed');
  if (status === 'cancelled' || status === 'released') {
    fail(403, 'HARAJ_BID_SECURITY_INACTIVE', 'Bid Security is not active');
  }
  if (status === 'required' || status === 'pending') {
    fail(403, 'HARAJ_BID_SECURITY_PENDING', 'Bid Security is not authorized');
  }
  if (status !== 'authorized' && status !== 'active') {
    fail(403, 'HARAJ_BID_SECURITY_INACTIVE', 'Bid Security is not active');
  }
  const exp = security.expiresAt || security.expires_at;
  if (exp && now >= new Date(exp)) {
    fail(403, 'HARAJ_BID_SECURITY_EXPIRED', 'Bid Security expired');
  }
  if (String(security.scopeType || security.scope_type || G10_POLICY_SCOPE) !== G10_POLICY_SCOPE) {
    fail(409, 'HARAJ_BID_SECURITY_SCOPE', 'G10 Staging security scope must be global');
  }
}

function assertBidLimit({ bidLimit, resultingExposure }) {
  const limit = money(bidLimit);
  if (limit <= 0) fail(403, 'HARAJ_BID_LIMIT_MISSING', 'Bid Limit is not authorized');
  if (money(resultingExposure) > limit) {
    fail(409, 'HARAJ_EXPOSURE_LIMIT', 'Bid would exceed authorized Bid Limit', {
      resultingExposure: money(resultingExposure),
      bidLimit: limit,
    });
  }
}

function assertLimitReduction({ currentExposure, newLimit }) {
  if (money(newLimit) < money(currentExposure)) {
    fail(409, 'HARAJ_BID_LIMIT_BELOW_EXPOSURE', 'Cannot reduce Bid Limit below active exposure', {
      currentExposure: money(currentExposure),
      newLimit: money(newLimit),
    });
  }
}

function assertSecurityReleasable({ currentExposure, security }) {
  if (money(currentExposure) > 0) {
    fail(409, 'HARAJ_SECURITY_HELD_BY_EXPOSURE', 'Cannot release Bid Security while exposure remains');
  }
  return security;
}

function rejectClientAuthority(body = {}) {
  const forbidden = [
    'bidLimit',
    'eligibilityStatus',
    'securityStatus',
    'providerRef',
    'bidderUserId',
    'ownerUserId',
    'exposure',
  ];
  for (const key of forbidden) {
    if (body[key] != null) {
      fail(403, 'HARAJ_CLIENT_AUTHORITY_FORBIDDEN', `Client cannot supply ${key}`);
    }
  }
}

function raceInvariantHolds(acceptedAmounts, bidLimit) {
  const sum = money((acceptedAmounts || []).reduce((s, n) => s + money(n), 0));
  return sum <= money(bidLimit);
}

const LOCK_ORDER = [
  '1. pg_advisory_xact_lock(hashtext(nomas:bidder-exposure:<bidderUserId>))',
  '2. existing acquireAuctionLock(auctionId) inside placeBid',
  '3. authoritative exposure from auctions+bids',
  '4. existing placeBid mutation',
  '5. snapshot + append-only audit',
  '6. commit',
].join(' → ');

const DEADLOCK_ANALYSIS = [
  'Same bidder on two auctions: one bidder key serializes both; auction locks acquired only after bidder lock; no cycle.',
  'Two bidders on one auction: different bidder keys then the same auction lock; waiters serialize on auction; no reverse order.',
  'Cross-room A/B: never lock auction then bidder. HTTP G10 path is the only Haraj bid entry.',
].join(' ');

async function g10TablesReady(client) {
  const { rows } = await client.query(`SELECT to_regclass('public.haraj_bidder_profiles') AS t`);
  return Boolean(rows[0] && rows[0].t);
}

async function loadAuctionHarajMode(client, auctionId) {
  const { rows } = await client.query(
    `SELECT id, haraj_mode, status FROM auctions WHERE id = $1`,
    [auctionId],
  );
  return rows[0] || null;
}

async function loadProfile(client, userId) {
  const { rows } = await client.query(
    `SELECT user_id, eligibility_status, bid_limit, currency, suspended_reason, revoked_reason,
            verified_at, verified_by_admin_id, version, created_at, updated_at
     FROM haraj_bidder_profiles WHERE user_id = $1`,
    [String(userId)],
  );
  return rows[0] || null;
}

async function loadActiveSecurity(client, userId) {
  const { rows } = await client.query(
    `SELECT * FROM haraj_bid_securities
     WHERE bidder_user_id = $1
       AND scope_type = $2
       AND status IN ('authorized', 'active')
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(userId), G10_POLICY_SCOPE],
  );
  return rows[0] || null;
}

async function awardTablesReady(client) {
  const { rows } = await client.query(`SELECT to_regclass('public.haraj_provisional_awards') AS t`);
  return Boolean(rows[0] && rows[0].t);
}

async function loadPositionsForBidder(client, bidderUserId) {
  const hasAwards = await awardTablesReady(client);
  const { rows: auctions } = await client.query(
    hasAwards
      ? `SELECT a.id, a.status, a.current_price, a.winner_user_id, p.status AS award_status
         FROM auctions a
         LEFT JOIN haraj_provisional_awards p ON p.auction_id = a.id
         WHERE a.status = ANY($2::text[])
           AND (
             a.winner_user_id = $1
             OR EXISTS (
               SELECT 1 FROM bids b
               WHERE b.auction_id = a.id AND b.bidder_user_id = $1
             )
           )`
      : `SELECT a.id, a.status, a.current_price, a.winner_user_id, NULL::text AS award_status
         FROM auctions a
         WHERE a.status = ANY($2::text[])
           AND (
             a.winner_user_id = $1
             OR EXISTS (
               SELECT 1 FROM bids b
               WHERE b.auction_id = a.id AND b.bidder_user_id = $1
             )
           )`,
    [String(bidderUserId), ['live', 'extended', 'frozen', 'ended', 'sold']],
  );
  const positions = [];
  for (const auction of auctions) {
    const bids = await client.query(
      `SELECT bidder_user_id, amount, created_at
       FROM bids WHERE auction_id = $1
       ORDER BY amount DESC, created_at ASC`,
      [auction.id],
    );
    positions.push({
      auction: {
        id: auction.id,
        status: auction.status,
        currentPrice: Number(auction.current_price),
        winnerUserId: auction.winner_user_id,
        awardStatus: auction.award_status || null,
      },
      bids: bids.rows.map((row) => ({
        bidderUserId: row.bidder_user_id,
        amount: Number(row.amount),
        createdAt: row.created_at,
      })),
    });
  }
  return positions;
}

function mapProfile(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    eligibilityStatus: row.eligibility_status,
    bidLimit: money(row.bid_limit),
    currency: row.currency,
    suspendedReason: row.suspended_reason || null,
    revokedReason: row.revoked_reason || null,
    verifiedAt: row.verified_at,
    verifiedByAdminId: row.verified_by_admin_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicSecurity(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    scopeType: row.scope_type,
    authorizedLimit: money(row.authorized_limit),
    currency: row.currency,
    provider: row.provider,
    providerMode: row.provider_mode,
    expiresAt: row.expires_at,
    label: STAGING_TEST_PROVIDER.label,
  };
}

function adminSecurity(row) {
  if (!row) return null;
  return {
    ...publicSecurity(row),
    providerRef: row.provider_ref,
    providerState: row.provider_state,
    providerIdempotencyKey: row.provider_idempotency_key,
    createdByAdminId: row.created_by_admin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function computeActiveExposure(client, bidderUserId) {
  const positions = await loadPositionsForBidder(client, bidderUserId);
  return {
    positions,
    total: totalActiveExposure(positions, bidderUserId),
  };
}

async function appendAudit(client, {
  bidderUserId,
  eventType,
  actorUserId,
  actorRole,
  auctionId,
  correlationId,
  payload,
}) {
  await client.query(
    `INSERT INTO haraj_bidder_audit_events
      (bidder_user_id, event_type, actor_user_id, actor_role, auction_id, correlation_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      String(bidderUserId),
      eventType,
      actorUserId || null,
      actorRole || null,
      auctionId || null,
      correlationId || null,
      JSON.stringify(payload || {}),
    ],
  );
}

async function upsertBidderProfile(client, {
  userId,
  eligibilityStatus,
  bidLimit,
  adminId,
  suspendedReason,
  revokedReason,
}) {
  const existing = await loadProfile(client, userId);
  const nextStatus = eligibilityStatus || (existing && existing.eligibility_status) || 'verified';
  if (!ELIGIBILITY_STATES.includes(nextStatus)) {
    fail(400, 'HARAJ_ELIGIBILITY_INVALID', 'Unknown eligibility status');
  }
  const nextLimit = bidLimit == null
    ? (existing ? Number(existing.bid_limit) : 0)
    : money(bidLimit);
  if (existing && bidLimit != null) {
    const exposure = await computeActiveExposure(client, userId);
    assertLimitReduction({ currentExposure: exposure.total, newLimit: nextLimit });
  }
  const { rows } = await client.query(
    `INSERT INTO haraj_bidder_profiles (
       user_id, eligibility_status, bid_limit, currency, suspended_reason, revoked_reason,
       verified_at, verified_by_admin_id, version
     ) VALUES ($1, $2, $3, 'SAR', $4, $5, CASE WHEN $2 = 'verified' THEN NOW() ELSE NULL END, $6, 1)
     ON CONFLICT (user_id) DO UPDATE SET
       eligibility_status = EXCLUDED.eligibility_status,
       bid_limit = EXCLUDED.bid_limit,
       suspended_reason = EXCLUDED.suspended_reason,
       revoked_reason = EXCLUDED.revoked_reason,
       verified_at = CASE
         WHEN EXCLUDED.eligibility_status = 'verified' THEN COALESCE(haraj_bidder_profiles.verified_at, NOW())
         ELSE haraj_bidder_profiles.verified_at
       END,
       verified_by_admin_id = COALESCE(EXCLUDED.verified_by_admin_id, haraj_bidder_profiles.verified_by_admin_id),
       version = haraj_bidder_profiles.version + 1,
       updated_at = NOW()
     RETURNING *`,
    [
      String(userId),
      nextStatus,
      nextLimit,
      nextStatus === 'suspended' ? (suspendedReason || 'admin_suspend') : null,
      nextStatus === 'revoked' ? (revokedReason || 'admin_revoke') : null,
      adminId || null,
    ],
  );
  await appendAudit(client, {
    bidderUserId: userId,
    eventType: existing ? 'bidder.profile.updated' : 'bidder.profile.created',
    actorUserId: adminId,
    actorRole: 'admin',
    payload: {
      eligibilityStatus: nextStatus,
      bidLimit: nextLimit,
      previous: existing
        ? { eligibilityStatus: existing.eligibility_status, bidLimit: money(existing.bid_limit) }
        : null,
    },
  });
  return mapProfile(rows[0]);
}

async function issueStagingTestSecurity(client, {
  userId,
  authorizedLimit,
  adminId,
  expiresAt,
  idempotencyKey,
}) {
  const profile = await loadProfile(client, userId);
  if (!profile) fail(404, 'HARAJ_BIDDER_NOT_FOUND', 'Bidder profile required before Bid Security');
  const limit = money(authorizedLimit);
  if (limit <= 0) fail(400, 'HARAJ_SECURITY_LIMIT_INVALID', 'authorizedLimit must be > 0');
  const key = String(idempotencyKey || `staging-test:${userId}:${limit}`).trim();
  const existing = await client.query(
    `SELECT * FROM haraj_bid_securities
     WHERE provider = $1 AND provider_idempotency_key = $2`,
    [STAGING_TEST_PROVIDER.name, key],
  );
  if (existing.rows[0]) return adminSecurity(existing.rows[0]);
  const { rows } = await client.query(
    `INSERT INTO haraj_bid_securities (
       bidder_user_id, status, scope_type, authorized_limit, currency,
       provider, provider_mode, provider_state, provider_ref, provider_idempotency_key,
       expires_at, created_by_admin_id
     ) VALUES (
       $1, 'active', $2, $3, 'SAR',
       $4, $5, 'provider_authorized', $6, $7,
       $8, $9
     )
     RETURNING *`,
    [
      String(userId),
      G10_POLICY_SCOPE,
      limit,
      STAGING_TEST_PROVIDER.name,
      STAGING_TEST_PROVIDER.mode,
      `TEST-SANDBOX-ONLY-${key}`,
      key,
      expiresAt || null,
      adminId || null,
    ],
  );
  await appendAudit(client, {
    bidderUserId: userId,
    eventType: 'bidder.security.issued',
    actorUserId: adminId,
    actorRole: 'admin',
    correlationId: key,
    payload: {
      securityId: rows[0].id,
      authorizedLimit: limit,
      provider: STAGING_TEST_PROVIDER.name,
      providerMode: STAGING_TEST_PROVIDER.mode,
      label: STAGING_TEST_PROVIDER.label,
      realMoney: false,
    },
  });
  return adminSecurity(rows[0]);
}

async function getBidderDossier(client, userId) {
  if (!(await g10TablesReady(client))) {
    fail(503, 'HARAJ_G10_SCHEMA_MISSING', 'Migration 011 is not applied');
  }
  const profile = mapProfile(await loadProfile(client, userId));
  const security = adminSecurity(await loadActiveSecurity(client, userId));
  const exposure = await computeActiveExposure(client, userId);
  const audit = await client.query(
    `SELECT id, event_type, actor_user_id, actor_role, auction_id, correlation_id, payload, created_at
     FROM haraj_bidder_audit_events
     WHERE bidder_user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [String(userId)],
  );
  return {
    profile,
    security,
    activeExposure: exposure.total,
    authoritativeSource: 'auctions+bids',
    snapshotRole: 'audit/idempotency only',
    audit: audit.rows,
    provider: STAGING_TEST_PROVIDER,
  };
}

async function getSelfEligibility(client, userId) {
  if (!(await g10TablesReady(client))) {
    return { profile: null, security: null, activeExposure: 0, bidLimit: 0, schemaReady: false };
  }
  const profile = mapProfile(await loadProfile(client, userId));
  const security = publicSecurity(await loadActiveSecurity(client, userId));
  const exposure = await computeActiveExposure(client, userId);
  return {
    profile,
    security,
    activeExposure: exposure.total,
    bidLimit: profile ? profile.bidLimit : 0,
    schemaReady: true,
  };
}

async function placeBidGuarded(client, {
  auctionId,
  bidderUserId,
  amount,
  idempotencyKey,
  expectedVersion,
  clientBody,
  correlationId,
}) {
  rejectClientAuthority(clientBody || {});
  const ready = await g10TablesReady(client);
  const auction = await loadAuctionHarajMode(client, auctionId);
  if (!auction) {
    fail(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  }
  // After 011, every HTTP bid is a financial event. Restricting to haraj_queued
  // allowed standalone go-live lots to bypass bidder-wide exposure (70k+70k).
  const enforce = ready;
  const { placeBid } = require('./bid_service');
  if (!enforce) {
    return placeBid(client, {
      auctionId,
      bidderUserId,
      amount,
      idempotencyKey,
      expectedVersion,
    });
  }

  await client.query(acquireBidderExposureLockSql(), [String(bidderUserId)]);

  const key = String(idempotencyKey || '').trim();
  if (key) {
    const replayed = await client.query(
      `SELECT id FROM bids WHERE auction_id = $1 AND idempotency_key = $2`,
      [auctionId, key],
    );
    if (replayed.rows[0]) {
      return placeBid(client, {
        auctionId,
        bidderUserId,
        amount,
        idempotencyKey,
        expectedVersion,
      });
    }
  }

  const profile = await loadProfile(client, bidderUserId);
  assertEligibility(profile);
  const security = await loadActiveSecurity(client, bidderUserId);
  assertSecurityActive(security);
  const positions = await loadPositionsForBidder(client, bidderUserId);
  const exp = exposureAfterNewBid({
    positions,
    bidderUserId,
    auctionId,
    newAmount: amount,
  });
  const effectiveLimit = money(Math.min(Number(profile.bid_limit), Number(security.authorized_limit)));
  assertBidLimit({ bidLimit: effectiveLimit, resultingExposure: exp.resulting });

  const result = await placeBid(client, {
    auctionId,
    bidderUserId,
    amount,
    idempotencyKey,
    expectedVersion,
  });
  if (result.replay) return result;

  await client.query(
    `INSERT INTO haraj_bidder_exposure_snapshots (
       bidder_user_id, auction_id, bid_id, bid_amount, prior_exposure,
       resulting_exposure, bid_limit, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (auction_id, idempotency_key) DO NOTHING`,
    [
      String(bidderUserId),
      auctionId,
      result.bid.id,
      money(result.bid.amount),
      exp.prior,
      exp.resulting,
      effectiveLimit,
      key,
    ],
  );
  await appendAudit(client, {
    bidderUserId,
    eventType: 'bidder.bid.accepted',
    actorUserId: bidderUserId,
    actorRole: 'bidder',
    auctionId,
    correlationId: correlationId || key,
    payload: {
      bidId: result.bid.id,
      amount: money(result.bid.amount),
      priorExposure: exp.prior,
      resultingExposure: exp.resulting,
      bidLimit: effectiveLimit,
    },
  });
  return {
    ...result,
    exposure: {
      prior: exp.prior,
      resulting: exp.resulting,
      bidLimit: effectiveLimit,
      source: 'auctions+bids',
    },
  };
}

module.exports = {
  ELIGIBILITY_STATES,
  SECURITY_STATES,
  SECURITY_SCOPES,
  G10_POLICY_SCOPE,
  STAGING_TEST_PROVIDER,
  EXPOSURE_INVARIANT,
  acquireBidderExposureLockSql,
  obligationOnAuction,
  totalActiveExposure,
  exposureAfterNewBid,
  assertEligibility,
  assertSecurityActive,
  assertBidLimit,
  assertLimitReduction,
  assertSecurityReleasable,
  rejectClientAuthority,
  raceInvariantHolds,
  topBid,
  LOCK_ORDER,
  DEADLOCK_ANALYSIS,
  g10TablesReady,
  loadProfile,
  loadActiveSecurity,
  loadPositionsForBidder,
  computeActiveExposure,
  upsertBidderProfile,
  issueStagingTestSecurity,
  getBidderDossier,
  getSelfEligibility,
  placeBidGuarded,
  mapProfile,
  publicSecurity,
  adminSecurity,
};
