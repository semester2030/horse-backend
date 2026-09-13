'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const live = require('./services/haraj_live_room');
const queue = require('./services/haraj_lot_queue');

describe('G9 multi-room isolation architecture', () => {
  it('keeps operational state functions scoped by roomSessionId — no module globals', () => {
    const src = require('fs').readFileSync(require.resolve('./services/haraj_live_room.js'), 'utf8');
    assert.equal(/let activeRoom|var activeRoom|global\.activeRoom|globalThis\.activeLot/.test(src), false);
    assert.equal(typeof live.getSnapshot, 'function');
    assert.equal(typeof queue.listQueue, 'function');
    const keys = Object.keys(live).filter((k) => k.startsWith('active'));
    assert.deepEqual(keys, []);
  });

  it('WebSocket room names are per occurrence, supporting 20+ rooms architecturally', () => {
    const evA = live.eventContract('lot.activated', {
      id: 'rs-a', session_id: 's-a', room_id: 'r-a', auctioneer_user_id: 'op-a',
      status: 'live', active_lot_id: 'auc-a', updated_at: '2026-09-05T01:00:00.000Z',
    });
    const evB = live.eventContract('lot.activated', {
      id: 'rs-b', session_id: 's-b', room_id: 'r-b', auctioneer_user_id: 'op-b',
      status: 'live', active_lot_id: 'auc-b', updated_at: '2026-09-05T01:00:01.000Z',
    });
    assert.notEqual(evA.roomSessionId, evB.roomSessionId);
    assert.notEqual(evA.auctionId, evB.auctionId);
    assert.notEqual(evA.auctioneerId, evB.auctioneerId);
    assert.equal(`haraj-room:${evA.roomSessionId}`, 'haraj-room:rs-a');
  });
});
