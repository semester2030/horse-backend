'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateOccurrences,
  normalizePolicy,
  horizonRange,
  localWallToUtc,
  addMonthsClamped,
  weekdayUtcDate,
  parseCustomRrule,
} = require('./services/haraj_schedule_calc');
const { createClock } = require('./services/haraj_clock');

function iso(d) {
  return d.toISOString();
}

describe('G6 occurrence calculator', () => {
  it('rejects sheep-like invalid recurrence and invalid timezone', () => {
    assert.throws(
      () => normalizePolicy({
        recurrence: 'hourly',
        startTime: '18:00',
        endTime: '20:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: '2026-03-01',
      }),
      (err) => err.code === 'HARAJ_RECURRENCE_INVALID',
    );
    assert.throws(
      () => normalizePolicy({
        recurrence: 'daily',
        startTime: '18:00',
        endTime: '20:00',
        timezone: 'Not/AZone',
        effectiveFrom: '2026-03-01',
      }),
      (err) => err.code === 'HARAJ_TIMEZONE_INVALID',
    );
  });

  it('ONE_TIME produces exactly one occurrence', () => {
    const rows = calculateOccurrences(
      {
        recurrence: 'one_time',
        oneTimeDate: '2026-03-10',
        startTime: '18:00',
        endTime: '22:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: '2026-03-01',
        effectiveUntil: '2026-03-31',
      },
      '2026-03-01T00:00:00+03:00',
      '2026-03-31T00:00:00+03:00',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].localDate, '2026-03-10');
    assert.equal(iso(rows[0].startAt), '2026-03-10T15:00:00.000Z');
    assert.equal(iso(rows[0].endAt), '2026-03-10T19:00:00.000Z');
  });

  it('DAILY at 18:00 yields one occurrence per valid day', () => {
    const rows = calculateOccurrences(
      {
        recurrence: 'daily',
        startTime: '18:00',
        endTime: '20:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: '2026-03-01',
        effectiveUntil: '2026-03-03',
      },
      '2026-03-01T00:00:00+03:00',
      '2026-03-05T00:00:00+03:00',
    );
    assert.deepEqual(rows.map((r) => r.localDate), ['2026-03-01', '2026-03-02', '2026-03-03']);
  });

  it('EVERY_N_DAYS interval 2 and 3 from authoritative anchor', () => {
    const p = {
      startTime: '18:00',
      endTime: '19:00',
      timezone: 'Asia/Riyadh',
      effectiveFrom: '2026-03-01',
      effectiveUntil: '2026-03-10',
    };
    const two = calculateOccurrences(
      { ...p, recurrence: 'every_n_days', recurrenceInterval: 2 },
      '2026-03-01T00:00:00+03:00',
      '2026-03-11T00:00:00+03:00',
    ).map((r) => r.localDate);
    const three = calculateOccurrences(
      { ...p, recurrence: 'every_n_days', recurrenceInterval: 3 },
      '2026-03-01T00:00:00+03:00',
      '2026-03-11T00:00:00+03:00',
    ).map((r) => r.localDate);
    assert.deepEqual(two, ['2026-03-01', '2026-03-03', '2026-03-05', '2026-03-07', '2026-03-09']);
    assert.deepEqual(three, ['2026-03-01', '2026-03-04', '2026-03-07', '2026-03-10']);
  });

  it('SELECTED_WEEKDAYS one and multiple weekdays', () => {
    assert.equal(weekdayUtcDate('2026-03-01'), 0);
    const base = {
      recurrence: 'selected_weekdays',
      startTime: '19:00',
      endTime: '21:00',
      timezone: 'Asia/Riyadh',
      effectiveFrom: '2026-03-01',
      effectiveUntil: '2026-03-08',
    };
    const one = calculateOccurrences(
      { ...base, daysOfWeek: [2] },
      '2026-03-01T00:00:00+03:00',
      '2026-03-09T00:00:00+03:00',
    ).map((r) => r.localDate);
    const multi = calculateOccurrences(
      { ...base, daysOfWeek: [0, 2, 4] },
      '2026-03-01T00:00:00+03:00',
      '2026-03-09T00:00:00+03:00',
    ).map((r) => r.localDate);
    assert.deepEqual(one, ['2026-03-03']);
    assert.deepEqual(multi, ['2026-03-01', '2026-03-03', '2026-03-05', '2026-03-08']);
  });

  it('WEEKLY respects weekday list and interval', () => {
    const rows = calculateOccurrences(
      {
        recurrence: 'weekly',
        daysOfWeek: [6],
        recurrenceInterval: 1,
        startTime: '20:00',
        endTime: '22:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: '2026-03-01',
        effectiveUntil: '2026-03-21',
      },
      '2026-03-01T00:00:00+03:00',
      '2026-03-22T00:00:00+03:00',
    ).map((r) => r.localDate);
    assert.deepEqual(rows, ['2026-03-07', '2026-03-14', '2026-03-21']);
  });

  it('MONTHLY is deterministic including month and leap-year clamp', () => {
    assert.equal(addMonthsClamped('2024-01-31', 1), '2024-02-29');
    assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28');
    const rows = calculateOccurrences(
      {
        recurrence: 'monthly',
        startTime: '18:00',
        endTime: '20:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: '2026-01-31',
        effectiveUntil: '2026-04-30',
      },
      '2026-01-01T00:00:00+03:00',
      '2026-05-01T00:00:00+03:00',
    ).map((r) => r.localDate);
    assert.deepEqual(rows, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('effective period excludes before, includes from/until, excludes after', () => {
    const policy = {
      recurrence: 'daily',
      startTime: '18:00',
      endTime: '19:00',
      timezone: 'Asia/Riyadh',
      effectiveFrom: '2026-03-03',
      effectiveUntil: '2026-03-05',
    };
    const dates = calculateOccurrences(
      policy,
      '2026-03-01T00:00:00+03:00',
      '2026-03-08T00:00:00+03:00',
    ).map((r) => r.localDate);
    assert.deepEqual(dates, ['2026-03-03', '2026-03-04', '2026-03-05']);
  });

  it('converts a non-Riyadh timezone (America/New_York) deterministically', () => {
    const start = localWallToUtc('2026-03-10', '18:00:00', 'America/New_York');
    assert.equal(iso(start), '2026-03-10T22:00:00.000Z');
    const rows = calculateOccurrences(
      {
        recurrence: 'one_time',
        oneTimeDate: '2026-03-10',
        startTime: '18:00',
        endTime: '20:00',
        timezone: 'America/New_York',
        effectiveFrom: '2026-03-01',
      },
      '2026-03-01T00:00:00Z',
      '2026-03-15T00:00:00Z',
    );
    assert.equal(rows.length, 1);
    assert.equal(iso(rows[0].startAt), '2026-03-10T22:00:00.000Z');
  });

  it('maps supported CUSTOM_RRULE and rejects unknown FREQ', () => {
    const daily = parseCustomRrule('FREQ=DAILY;INTERVAL=3');
    assert.equal(daily.recurrence, 'every_n_days');
    assert.equal(daily.recurrenceInterval, 3);
    const weekly = parseCustomRrule('FREQ=WEEKLY;BYDAY=SU,TU,TH');
    assert.equal(weekly.recurrence, 'selected_weekdays');
    assert.deepEqual(weekly.daysOfWeek, [0, 2, 4]);
    assert.throws(() => parseCustomRrule('FREQ=HOURLY'), (err) => err.code === 'HARAJ_RRULE_UNSUPPORTED');
  });

  it('year boundary stays deterministic', () => {
    const rows = calculateOccurrences(
      {
        recurrence: 'daily',
        startTime: '18:00',
        endTime: '19:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: '2025-12-31',
        effectiveUntil: '2026-01-02',
      },
      '2025-12-30T00:00:00+03:00',
      '2026-01-05T00:00:00+03:00',
    ).map((r) => r.localDate);
    assert.deepEqual(rows, ['2025-12-31', '2026-01-01', '2026-01-02']);
  });

  it('horizon uses the injected clock, not wall clock', () => {
    const clock = createClock(() => new Date('2026-06-15T09:00:00+03:00'));
    const range = horizonRange(clock, 7, 'Asia/Riyadh');
    assert.equal(range.horizonDays, 7);
    assert.equal(iso(range.start), '2026-06-14T21:00:00.000Z');
    assert.equal(iso(range.end), '2026-06-21T21:00:00.000Z');
  });

  it('overnight window ends the next local day', () => {
    const rows = calculateOccurrences(
      {
        recurrence: 'one_time',
        oneTimeDate: '2026-03-10',
        startTime: '22:00',
        endTime: '01:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: '2026-03-01',
      },
      '2026-03-01T00:00:00+03:00',
      '2026-03-12T00:00:00+03:00',
    );
    assert.equal(iso(rows[0].startAt), '2026-03-10T19:00:00.000Z');
    assert.equal(iso(rows[0].endAt), '2026-03-10T22:00:00.000Z');
  });
});
