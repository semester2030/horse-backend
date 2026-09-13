'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TRANSITIONS, LIVEKIT, versionOf, eventContract } = require('./services/haraj_live_room');

describe('G8 live room domain helpers', () => {
  it('documents the existing 009 room_session transition matrix', () => {
    const pairs = TRANSITIONS.map((t) => `${t.from}:${t.action}:${t.to}`);
    assert.ok(pairs.includes('idle:ready:pre_live'));
    assert.ok(pairs.includes('pre_live:start:live'));
    assert.ok(pairs.includes('live:pause:paused'));
    assert.ok(pairs.includes('paused:resume:live'));
    assert.ok(pairs.includes('live:complete:closed'));
    assert.equal(LIVEKIT.implemented, false);
    assert.equal(LIVEKIT.tested, false);
    assert.equal(LIVEKIT.productionFallback, false);
  });

  it('versions events from updatedAt so stale events cannot silently win', () => {
    const older = versionOf('2026-09-05T00:00:00.000Z');
    const newer = versionOf('2026-09-05T00:01:00.000Z');
    assert.ok(newer > older);
    const ev = eventContract('lot.activated', {
      id: 'rs-1',
      session_id: 's-1',
      room_id: 'r-1',
      auctioneer_user_id: 'op',
      status: 'live',
      active_lot_id: 'auc-1',
      updated_at: '2026-09-05T00:01:00.000Z',
    }, { auctionId: 'auc-1' });
    assert.equal(ev.financialAuthority, false);
    assert.equal(ev.bidAuthority, false);
    assert.equal(ev.auctionId, 'auc-1');
    assert.ok(ev.version >= newer);
  });
});
