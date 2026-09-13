'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const g13 = require('./services/haraj_history_analytics');

const SRC = fs.readFileSync(
  path.join(__dirname, 'services', 'haraj_history_analytics.js'),
  'utf8',
);

describe('G13 History & Analytics domain', () => {
  it('is deterministic read-only analytics with no AI and no settlement labels', () => {
    assert.equal(g13.AI_SCOPE, 'DEFERRED — OWNER DECISION');
    assert.equal(g13.AI_STATUS.implemented, false);
    assert.equal(g13.AI_STATUS.analytics, false);
    assert.equal(g13.AI_STATUS.recommendations, false);
    assert.equal(g13.PRESENTATION_TIMEZONE, 'Asia/Riyadh');
    assert.equal(g13.MONEY_TERMS.notRevenue, true);
    assert.equal(g13.MONEY_TERMS.notGmvSettled, true);
    assert.equal(g13.MONEY_TERMS.notCashReceived, true);
    assert.equal(g13.MONEY_TERMS.notSellerPayout, true);
    assert.match(g13.MONEY_TERMS.highestBidVolume, /NOT revenue/);
    assert.match(g13.MONEY_TERMS.acceptedOfferHandoff, /NOT settled cash/);
    assert.equal(/\b(INSERT INTO|UPDATE \w+|DELETE FROM|TRUNCATE)\b/i.test(SRC), false);
    assert.equal(/openai|anthropic|embedding|vector|llm|gpt-/i.test(SRC), false);
  });

  it('parses date-only ranges as Asia/Riyadh calendar days', () => {
    const range = g13.riyadhDayBounds('2026-09-05');
    assert.equal(range.from.toISOString(), '2026-09-04T21:00:00.000Z');
    assert.equal(range.to.toISOString(), '2026-09-05T20:59:59.999Z');
    assert.equal(range.timezone, 'Asia/Riyadh');
    assert.throws(() => g13.parseRange('2026-09-06', '2026-09-05'), (e) => e.code === 'HISTORY_RANGE_INVALID');
    assert.throws(() => g13.parseRange('not-a-date', null), (e) => e.code === 'HISTORY_RANGE_INVALID');
  });

  it('does not fabricate missing timeline phases', () => {
    const timeline = g13.timelineFromEvents([
      { event_type: 'auction.created', created_at: '2026-09-05T10:00:00.000Z', payload: {} },
      { event_type: 'bid.accepted', created_at: '2026-09-05T10:01:00.000Z', payload: {} },
      { event_type: 'unknown.future', created_at: '2026-09-05T10:02:00.000Z', payload: { status: 'x' } },
    ]);
    assert.equal(timeline.length, 3);
    assert.equal(timeline[0].phase, 'lot_submitted');
    assert.equal(timeline[1].phase, 'bid');
    assert.equal(timeline[2].phase, 'recorded_event');
    assert.equal(timeline.every((e) => e.fabricated === false && e.available === true), true);
    assert.equal(timeline.some((e) => e.phase === 'queued' || e.phase === 'room live'), false);
  });

  it('classifies viewer roles and strips private financial / contact fields', () => {
    assert.equal(g13.viewerRole({ actorRole: 'admin', actorUserId: 'x' }), 'admin');
    assert.equal(g13.viewerRole({ actorUserId: 's', ownerUserId: 's' }), 'seller');
    assert.equal(g13.viewerRole({ actorUserId: 'b', ownerUserId: 's', bidderIds: ['b'] }), 'buyer');
    assert.equal(g13.viewerRole({ actorUserId: 'o', ownerUserId: 's', offeredIds: ['o'] }), 'buyer');
    assert.equal(g13.viewerRole({ actorUserId: 'op', actorRole: 'auctioneer', ownerUserId: 's' }), 'auctioneer');
    assert.equal(g13.viewerRole({ actorUserId: 'z', ownerUserId: 's' }), 'none');
    assert.equal(g13.viewerRole({}), 'anon');

    const stripped = g13.stripPrivate({
      auctionId: 'a1',
      bidLimit: 50000,
      activeExposure: 12000,
      pspReference: 'psp_secret',
      inspectionEvidence: ['private'],
      operatorNotes: 'internal',
      riskFlags: ['x'],
      privateBuyerContact: '05',
      sellerUserId: 's',
      winnerUserId: 'w',
      highestBid: 28000,
    }, 'buyer');
    assert.equal(stripped.bidLimit, undefined);
    assert.equal(stripped.pspReference, undefined);
    assert.equal(stripped.inspectionEvidence, undefined);
    assert.equal(stripped.sellerUserId, undefined);
    assert.equal(stripped.winnerUserId, undefined);
    assert.equal(stripped.highestBid, 28000);
  });

  it('CSV export omits private and financial-custody columns', () => {
    const csv = g13.toCsv([{
      auctionId: 'a1',
      lotTitle: 'حصان, تجريبي',
      species: 'horse',
      auctionStatus: 'sold',
      highestBid: 28000,
      g11Outcome: 'cancelled',
      afterHarajMode: 're_auction',
      bidCount: 2,
      startAt: '2026-09-05T10:00:00.000Z',
      endAt: '2026-09-05T10:01:00.000Z',
      bidLimit: 999,
      pspReference: 'secret',
    }]);
    assert.match(csv, /auctionId,lotTitle/);
    assert.match(csv, /"حصان, تجريبي"/);
    assert.equal(csv.includes('bidLimit'), false);
    assert.equal(csv.includes('psp'), false);
    assert.equal(csv.includes('secret'), false);
    assert.equal(csv.includes('999'), false);
  });
});
