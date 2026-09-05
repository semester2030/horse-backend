'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const g10 = require('./services/haraj_bidder_security');

function pos(id, status, price, bids, winnerUserId) {
  return {
    auction: { id, status, currentPrice: price, winnerUserId: winnerUserId || null },
    bids,
  };
}

describe('G10 bidder eligibility / exposure domain', () => {
  it('documents the frozen exposure invariant and test-only PSP', () => {
    assert.match(g10.EXPOSURE_INVARIANT, /TOTAL_ACTIVE_EXPOSURE_AFTER_NEW_BID/);
    assert.equal(g10.STAGING_TEST_PROVIDER.realMoney, false);
    assert.equal(g10.STAGING_TEST_PROVIDER.productionReady, false);
    assert.equal(g10.G10_POLICY_SCOPE, 'global');
    assert.match(g10.acquireBidderExposureLockSql(), /nomas:bidder-exposure:/);
    assert.match(g10.LOCK_ORDER, /bidder-exposure/);
    assert.match(g10.LOCK_ORDER, /acquireAuctionLock/);
    assert.match(g10.DEADLOCK_ANALYSIS, /never lock auction then bidder/);
  });

  it('counts only the current highest live bid and drops outbid exposure', () => {
    const positions = [
      pos('A', 'live', 60000, [
        { bidderUserId: 'x', amount: 60000, createdAt: '2026-09-05T00:00:00Z' },
      ]),
    ];
    assert.equal(g10.totalActiveExposure(positions, 'x'), 60000);
    const afterY = [
      pos('A', 'live', 65000, [
        { bidderUserId: 'x', amount: 60000, createdAt: '2026-09-05T00:00:00Z' },
        { bidderUserId: 'y', amount: 65000, createdAt: '2026-09-05T00:00:01Z' },
      ]),
    ];
    assert.equal(g10.totalActiveExposure(afterY, 'x'), 0);
    assert.equal(g10.totalActiveExposure(afterY, 'y'), 65000);
  });

  it('counts closed winner exposure and ignores cancelled / unsold / losers', () => {
    const positions = [
      pos('W', 'sold', 80000, [], 'x'),
      pos('C', 'cancelled', 50000, [{ bidderUserId: 'x', amount: 50000, createdAt: 't' }]),
      pos('U', 'unsold', 1000, [{ bidderUserId: 'x', amount: 1000, createdAt: 't' }]),
    ];
    assert.equal(g10.totalActiveExposure(positions, 'x'), 80000);
  });

  it('rejects 70k+70k against a 100k limit and allows 50k+60k against 200k', () => {
    const horse = pos('H', 'live', 1000, []);
    const camel = pos('C', 'live', 1000, []);
    const first = g10.exposureAfterNewBid({
      positions: [horse, camel],
      bidderUserId: 'x',
      auctionId: 'H',
      newAmount: 70000,
    });
    assert.equal(first.resulting, 70000);
    const afterHorse = [
      pos('H', 'live', 70000, [{ bidderUserId: 'x', amount: 70000, createdAt: 't' }]),
      camel,
    ];
    const second = g10.exposureAfterNewBid({
      positions: afterHorse,
      bidderUserId: 'x',
      auctionId: 'C',
      newAmount: 70000,
    });
    assert.equal(second.resulting, 140000);
    assert.throws(
      () => g10.assertBidLimit({ bidLimit: 100000, resultingExposure: second.resulting }),
      (e) => e.code === 'HARAJ_EXPOSURE_LIMIT',
    );
    const ok = g10.exposureAfterNewBid({
      positions: [pos('H', 'live', 50000, [{ bidderUserId: 'x', amount: 50000, createdAt: 't' }]), camel],
      bidderUserId: 'x',
      auctionId: 'C',
      newAmount: 60000,
    });
    assert.equal(ok.resulting, 110000);
    g10.assertBidLimit({ bidLimit: 200000, resultingExposure: ok.resulting });
    assert.equal(g10.raceInvariantHolds([70000, 70000], 100000), false);
    assert.equal(g10.raceInvariantHolds([50000, 60000], 200000), true);
  });

  it('replaces rather than doubles exposure when the same bidder raises the same Lot', () => {
    const positions = [
      pos('H', 'live', 50000, [{ bidderUserId: 'x', amount: 50000, createdAt: 't' }]),
    ];
    const next = g10.exposureAfterNewBid({
      positions,
      bidderUserId: 'x',
      auctionId: 'H',
      newAmount: 80000,
    });
    assert.equal(next.currentOnThis, 50000);
    assert.equal(next.resulting, 80000);
  });

  it('enforces eligibility, expiry, client spoof, and limit-below-exposure', () => {
    assert.throws(() => g10.assertEligibility({ eligibilityStatus: 'pending' }), (e) => e.code === 'HARAJ_BIDDER_PENDING');
    assert.throws(() => g10.assertEligibility({ eligibilityStatus: 'suspended' }), (e) => e.code === 'HARAJ_BIDDER_SUSPENDED');
    g10.assertEligibility({ eligibilityStatus: 'verified' });
    assert.throws(
      () => g10.assertSecurityActive({
        status: 'active',
        scopeType: 'global',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }, new Date('2026-09-05T00:00:00.000Z')),
      (e) => e.code === 'HARAJ_BID_SECURITY_EXPIRED',
    );
    assert.throws(() => g10.rejectClientAuthority({ bidLimit: 999 }), (e) => e.code === 'HARAJ_CLIENT_AUTHORITY_FORBIDDEN');
    assert.throws(
      () => g10.assertLimitReduction({ currentExposure: 80000, newLimit: 50000 }),
      (e) => e.code === 'HARAJ_BID_LIMIT_BELOW_EXPOSURE',
    );
    assert.throws(
      () => g10.assertSecurityReleasable({ currentExposure: 1, security: { status: 'active' } }),
      (e) => e.code === 'HARAJ_SECURITY_HELD_BY_EXPOSURE',
    );
  });
});
