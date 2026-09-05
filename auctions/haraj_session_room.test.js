'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertCategoryCode,
  assertTimezone,
  assertTimeRange,
  parseTime,
  overlaps,
  canEditSession,
  CATEGORY_CODES,
  DEFAULT_TZ,
} = require('./services/haraj_session_room');

describe('G5 session/room domain helpers', () => {
  it('reuses horse/camel/falcon category SSOT and rejects sheep', () => {
    assert.deepEqual(CATEGORY_CODES, ['horse', 'camel', 'falcon']);
    assert.equal(assertCategoryCode('HORSE'), 'horse');
    assert.throws(() => assertCategoryCode('sheep'), (err) => err.code === 'HARAJ_CATEGORY_INVALID');
  });

  it('treats timezone explicitly and defaults to Asia/Riyadh', () => {
    assert.equal(DEFAULT_TZ, 'Asia/Riyadh');
    assert.equal(assertTimezone(''), 'Asia/Riyadh');
    assert.equal(assertTimezone('Asia/Riyadh'), 'Asia/Riyadh');
    assert.throws(() => assertTimezone('Not/AZone'), (err) => err.code === 'HARAJ_TIMEZONE_INVALID');
  });

  it('rejects inverted session windows', () => {
    const start = parseTime('2026-09-10T15:00:00+03:00', 'scheduledStartAt');
    const end = parseTime('2026-09-10T22:00:00+03:00', 'scheduledEndAt');
    assertTimeRange(start, end);
    assert.throws(() => assertTimeRange(end, start), (err) => err.code === 'HARAJ_TIME_RANGE_INVALID');
  });

  it('detects overlapping assignment windows', () => {
    const a1 = new Date('2026-09-10T15:00:00Z');
    const a2 = new Date('2026-09-10T19:00:00Z');
    const b1 = new Date('2026-09-10T18:00:00Z');
    const b2 = new Date('2026-09-10T21:00:00Z');
    const c1 = new Date('2026-09-10T19:00:00Z');
    const c2 = new Date('2026-09-10T22:00:00Z');
    assert.equal(overlaps(a1, a2, b1, b2), true);
    assert.equal(overlaps(a1, a2, c1, c2), false);
  });

  it('uses G2 session states — planned/upcoming editable, not live', () => {
    assert.equal(canEditSession('planned'), true);
    assert.equal(canEditSession('upcoming'), true);
    assert.equal(canEditSession('live'), false);
    assert.equal(canEditSession('cancelled'), false);
  });
});
