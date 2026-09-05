'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultHorizonDays,
  schedulerIntervalMs,
  asDateOnly,
  asTime,
  previewPolicy,
  createClock,
} = require('./services/haraj_scheduling_engine');

describe('G6 scheduling engine helpers', () => {
  it('keeps horizon server-side and capped at 30', () => {
    const prev = process.env.HARAJ_SCHEDULE_HORIZON_DAYS;
    process.env.HARAJ_SCHEDULE_HORIZON_DAYS = '99';
    assert.equal(defaultHorizonDays(), 30);
    process.env.HARAJ_SCHEDULE_HORIZON_DAYS = '14';
    assert.equal(defaultHorizonDays(), 14);
    if (prev == null) delete process.env.HARAJ_SCHEDULE_HORIZON_DAYS;
    else process.env.HARAJ_SCHEDULE_HORIZON_DAYS = prev;
  });

  it('does not use a 5s lifecycle tick for the scheduler', () => {
    assert.ok(schedulerIntervalMs() >= 10000);
  });

  it('normalizes pg date/time values', () => {
    assert.equal(asDateOnly(new Date('2026-03-01T00:00:00.000Z')), '2026-03-01');
    assert.equal(asTime('18:00:00'), '18:00:00');
    assert.equal(asTime('18:00'), '18:00:00');
  });

  it('preview uses the same calculator and injected clock', () => {
    const clock = createClock(new Date('2026-03-01T00:00:00+03:00'));
    const preview = previewPolicy({
      recurrence: 'daily',
      start_time_local: '18:00:00',
      end_time_local: '20:00:00',
      timezone: 'Asia/Riyadh',
      effective_from: '2026-03-01',
      effective_until: '2026-03-03',
    }, { clock, horizonDays: 7 });
    assert.equal(preview.preview, true);
    assert.equal(preview.authoritative, true);
    assert.equal(preview.occurrences.length, 3);
    assert.equal(preview.occurrences[0].occurrenceKey, '2026-03-01T18:00:00');
  });
});
