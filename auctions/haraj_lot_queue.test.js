'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SNAPSHOT, assertLotLifecycle, mapEntry } = require('./services/haraj_lot_queue');

describe('G7 lot queue domain helpers', () => {
  it('keeps Auction Core as SSOT and never copies financial fields into the queue', () => {
    assert.ok(SNAPSHOT.ssotAuction.includes('id'));
    assert.ok(SNAPSHOT.ssotAuction.includes('current_price'));
    assert.ok(SNAPSHOT.ssotAuction.includes('winner_user_id'));
    assert.ok(SNAPSHOT.ssotAuction.includes('bid history'));
    assert.ok(SNAPSHOT.neverCopied.includes('current_price'));
    assert.ok(SNAPSHOT.neverCopied.includes('winner_user_id'));
    assert.ok(SNAPSHOT.neverCopied.includes('settlement'));
    assert.equal(SNAPSHOT.operationalQueue.includes('auction_id'), true);
    assert.match(SNAPSHOT.immutableOnceQueued, /Auction Core/);
  });

  it('maps Lot ID to the existing auction.id only', () => {
    const entry = mapEntry({
      id: 'qe-1',
      room_session_id: 'rs-1',
      auction_id: 'auc-1',
      position: 1,
      status: 'queued',
      auction_status: 'review',
      auction_species: 'horse',
    });
    assert.equal(entry.lotId, 'auc-1');
    assert.equal(entry.auctionId, 'auc-1');
    assert.equal(entry.financialAuthority, false);
    assert.equal(entry.bidAuthority, false);
    assert.equal(entry.liveActivated, false);
    assert.equal(entry.auction.id, 'auc-1');
  });

  it('rejects draft, cancelled, and non-review lots', () => {
    assert.throws(() => assertLotLifecycle({ status: 'draft' }), (err) => err.code === 'HARAJ_LOT_NOT_APPROVED');
    assert.throws(() => assertLotLifecycle({ status: 'cancelled' }), (err) => err.code === 'HARAJ_LOT_NOT_APPROVED');
    assert.throws(() => assertLotLifecycle({ status: 'live' }), (err) => err.code === 'HARAJ_LOT_NOT_APPROVED');
    assert.throws(() => assertLotLifecycle({ status: 'scheduled' }), (err) => err.code === 'HARAJ_LOT_NOT_APPROVED');
    assert.doesNotThrow(() => assertLotLifecycle({ status: 'review' }));
  });
});
