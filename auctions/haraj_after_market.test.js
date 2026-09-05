'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const g12 = require('./services/haraj_after_market');
const g10 = require('./services/haraj_bidder_security');

describe('G12 After-Haraj market domain', () => {
  it('reuses 010 modes and does not invent settlement, AI, or a second bid engine', () => {
    assert.equal(g12.MODES.FIXED_PRICE, 'available_at_approved_price');
    assert.equal(g12.MODES.ACCEPT_OFFERS, 'accept_offers');
    assert.equal(g12.MODES.RE_AUCTION, 're_auction');
    assert.equal(g12.MODES.HISTORY_ONLY, 'history_only');
    assert.match(g12.SETTLEMENT_BOUNDARY, /does not insert haraj_settlements/);
    assert.match(g12.LAST_BID_RULE, /LAST BID/);
    assert.match(g12.G10_BOUNDARY, /placeBid/);
    assert.match(g12.RUNNER_UP_RULE, /NEVER AUTOMATICALLY/);
    assert.equal(g12.AI_SCOPE, 'DEFERRED — OWNER DECISION');
    assert.equal(g12.AI_STATUS.implemented, false);
    assert.equal(g12.AI_STATUS.providerIntegrated, false);
    assert.equal(g12.AI_STATUS.recommendations, false);
  });

  it('blocks After-Haraj while live, extended, or G11 unresolved / accepted / withdrawn', () => {
    assert.equal(g12.assessEligibility({ auctionStatus: 'live' }).eligible, false);
    assert.equal(g12.assessEligibility({ auctionStatus: 'extended' }).eligible, false);
    assert.equal(g12.assessEligibility({ auctionStatus: 'scheduled' }).eligible, false);
    assert.equal(g12.assessEligibility({ auctionStatus: 'sold', awardStatus: 'accepted' }).reason, 'BINDING_PURCHASE_ACTIVE');
    assert.equal(g12.assessEligibility({ auctionStatus: 'sold', awardStatus: 'disputed' }).reason, 'G11_UNRESOLVED');
    assert.equal(g12.assessEligibility({ auctionStatus: 'sold', awardStatus: 'inspection_pending' }).reason, 'G11_UNRESOLVED');
    assert.equal(g12.assessEligibility({ auctionStatus: 'sold', awardStatus: 'withdrawn' }).reason, 'G11_WITHDRAWAL_OBLIGATION');
    assert.equal(g12.assessEligibility({ auctionStatus: 'sold' }).reason, 'G11_CASE_MISSING');
  });

  it('allows After-Haraj only after unsold or G11 cancelled award', () => {
    assert.equal(g12.assessEligibility({ auctionStatus: 'unsold' }).eligible, true);
    assert.equal(g12.assessEligibility({ auctionStatus: 'sold', awardStatus: 'cancelled' }).eligible, true);
    assert.equal(g12.assessEligibility({ auctionStatus: 'cancelled' }).eligible, true);
  });

  it('never prefills approved price, min offer, or re-auction terms from last bid', () => {
    const flags = g12.lastBidFlags();
    assert.equal(flags.lastBidUsedAsPrice, false);
    assert.equal(flags.lastBidUsedAsMinOffer, false);
    assert.equal(flags.lastBidUsedAsReauctionStart, false);
    assert.equal(flags.lastBidUsedAsReserve, false);
    const fixed = g12.listingWriteValues(g12.MODES.FIXED_PRICE, 32000);
    assert.equal(fixed.approved_price, 32000);
    assert.throws(
      () => g12.listingWriteValues(g12.MODES.FIXED_PRICE, null),
      (e) => e.code === 'AFTER_HARAJ_PRICE_REQUIRED',
    );
    const offers = g12.listingWriteValues(g12.MODES.ACCEPT_OFFERS);
    assert.equal(offers.approved_price, null);
    assert.equal(offers.offers_enabled, true);
  });

  it('keeps one active disposition mode at a time', () => {
    const fixed = g12.listingWriteValues(g12.MODES.FIXED_PRICE, 1000);
    const offers = g12.listingWriteValues(g12.MODES.ACCEPT_OFFERS);
    const close = g12.listingWriteValues(g12.MODES.HISTORY_ONLY);
    assert.equal(fixed.offers_enabled, false);
    assert.equal(offers.mode, 'accept_offers');
    assert.equal(close.status, 'closed');
    assert.notEqual(fixed.mode, offers.mode);
  });

  it('rebuilds offers without silent deletion and expires by server time', () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    const events = [
      {
        event_type: g12.EVENTS.OFFER_SUBMITTED,
        created_at: '2026-09-05T10:00:00.000Z',
        payload: {
          offerId: 'o1',
          buyerUserId: 'a',
          amount: 30000,
          expiresAt: '2026-09-06T10:00:00.000Z',
        },
      },
      {
        event_type: g12.EVENTS.OFFER_SUBMITTED,
        created_at: '2026-09-05T10:05:00.000Z',
        payload: {
          offerId: 'o2',
          buyerUserId: 'b',
          amount: 35000,
          expiresAt: '2026-09-05T11:00:00.000Z',
        },
      },
      {
        event_type: g12.EVENTS.OFFER_SUPERSEDED,
        created_at: '2026-09-05T11:30:00.000Z',
        payload: { offerId: 'o1', deleted: false, reason: 'mode_switch' },
      },
    ];
    const offers = g12.rebuildOffers(events, now);
    assert.equal(offers.find((o) => o.offerId === 'o1').status, 'superseded');
    assert.equal(offers.find((o) => o.offerId === 'o2').status, 'expired');
    assert.equal(offers.length, 2);
  });

  it('does not treat After-Haraj amounts as G10 Haraj exposure', () => {
    const sold = {
      auction: {
        id: 'W',
        status: 'sold',
        currentPrice: 28000,
        winnerUserId: 'x',
        awardStatus: 'cancelled',
      },
      bids: [],
    };
    assert.equal(g10.totalActiveExposure([sold], 'x'), 0);
    assert.equal(g10.totalActiveExposure([{
      auction: { ...sold.auction, awardStatus: 'accepted' },
      bids: [],
    }], 'x'), 28000);
    assert.match(g12.G10_BOUNDARY, /not Auction Core bids/);
  });

  it('keeps seller vs auctioneer vs buyer roles separate', () => {
    const auction = { owner_user_id: 'seller' };
    assert.equal(g12.viewerRole({ auction, actorUserId: 'seller' }), 'seller');
    assert.equal(g12.viewerRole({ auction, actorUserId: 'buyer' }), 'buyer');
    assert.equal(g12.viewerRole({ auction, actorUserId: 'op', actorRole: 'admin' }), 'admin');
    assert.equal(g12.viewerRole({ auction, actorUserId: null }), 'anon');
  });

  it('maps seller-facing aliases onto 010 canonical modes', () => {
    assert.equal(g12.canonicalMode('FIXED_PRICE'), 'available_at_approved_price');
    assert.equal(g12.canonicalMode('ACCEPT_OFFERS'), 'accept_offers');
    assert.equal(g12.canonicalMode('RE_AUCTION'), 're_auction');
    assert.equal(g12.canonicalMode('HISTORY_ONLY'), 'history_only');
  });
});
