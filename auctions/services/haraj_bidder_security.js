'use strict';

/**
 * G10 domain helpers — eligibility, Bid Security, Bid Limit, exposure.
 * Does NOT replace placeBid. Does NOT create a wallet/escrow.
 * Persistence requires proposed 011 — not executed.
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
  'An ended/sold obligation exists only while winner_user_id = bidder (provisional award until G11/G19).',
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
};
