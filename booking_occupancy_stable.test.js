/**
 * Boarding Occupancy Engine — Phase A unit tests.
 * Pure evaluateStableOccupancy / availability / status release (no HTTP).
 */
'use strict';

const assert = require('assert');
const {
  evaluateStableOccupancy,
  buildAvailabilityPayload,
  stayDayKeys,
  isStableBooking,
  BLOCKING_STATUSES,
  FREEING_STATUSES,
  expireStalePendingBookings,
} = require('./booking_occupancy');

function service(id, totalSpaces) {
  return { id, type: 'stable', totalSpaces };
}

function booking(partial) {
  return {
    id: partial.id || `b-${Math.random().toString(36).slice(2, 8)}`,
    type: 'stable',
    serviceType: 'stable',
    serviceId: partial.serviceId || 'svc1',
    status: partial.status || 'pending',
    startDate: partial.startDate,
    endDate: partial.endDate,
    spacesRequested: partial.spacesRequested ?? 1,
    details: partial.details,
    createdAt: partial.createdAt,
  };
}

function suite(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

suite('stayDayKeys: inclusive start, exclusive end', () => {
  assert.deepStrictEqual(stayDayKeys('2026-07-01', '2026-07-01'), [
    '2026-07-01',
  ]);
  assert.deepStrictEqual(stayDayKeys('2026-07-01', '2026-07-03'), [
    '2026-07-01',
    '2026-07-02',
  ]);
});

suite('isStableBooking accepts boarding alias', () => {
  assert.strictEqual(isStableBooking({ type: 'boarding' }), true);
  assert.strictEqual(isStableBooking({ type: 'stable' }), true);
  assert.strictEqual(isStableBooking({ type: 'training' }), false);
});

suite('blocking vs freeing status sets', () => {
  for (const s of ['pending', 'confirmed', 'in_progress']) {
    assert.ok(BLOCKING_STATUSES.has(s), s);
    assert.ok(!FREEING_STATUSES.has(s), s);
  }
  for (const s of ['cancelled', 'rejected', 'completed', 'expired']) {
    assert.ok(FREEING_STATUSES.has(s), s);
    assert.ok(!BLOCKING_STATUSES.has(s), s);
  }
});

suite('no double booking — full overlap rejects 2nd', () => {
  const svc = service('svc1', 1);
  const existing = [
    booking({
      id: 'a',
      startDate: '2026-08-01',
      endDate: '2026-08-05',
      status: 'confirmed',
    }),
  ];
  const r = evaluateStableOccupancy({
    service: svc,
    bookings: existing,
    startDate: '2026-08-01',
    endDate: '2026-08-05',
    spacesRequested: 1,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.minAvailable, 0);
});

suite('partial overlap rejects when capacity 1', () => {
  const svc = service('svc1', 1);
  const existing = [
    booking({
      id: 'a',
      startDate: '2026-08-01',
      endDate: '2026-08-10',
      status: 'pending',
    }),
  ];
  const r = evaluateStableOccupancy({
    service: svc,
    bookings: existing,
    startDate: '2026-08-08',
    endDate: '2026-08-12',
    spacesRequested: 1,
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.days.some((d) => d.date === '2026-08-08' && d.available === 0));
});

suite('adjacent non-overlapping stays both ok (end exclusive)', () => {
  const svc = service('svc1', 1);
  const existing = [
    booking({
      id: 'a',
      startDate: '2026-08-01',
      endDate: '2026-08-05',
      status: 'confirmed',
    }),
  ];
  const r = evaluateStableOccupancy({
    service: svc,
    bookings: existing,
    startDate: '2026-08-05',
    endDate: '2026-08-08',
    spacesRequested: 1,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.minAvailable, 1);
});

suite('cancel frees capacity for new booking', () => {
  const svc = service('svc1', 1);
  const existing = [
    booking({
      id: 'a',
      startDate: '2026-08-01',
      endDate: '2026-08-05',
      status: 'cancelled',
    }),
  ];
  const r = evaluateStableOccupancy({
    service: svc,
    bookings: existing,
    startDate: '2026-08-01',
    endDate: '2026-08-05',
    spacesRequested: 1,
  });
  assert.strictEqual(r.ok, true);
});

suite('completed / rejected / expired free capacity', () => {
  const svc = service('svc1', 1);
  for (const status of ['completed', 'rejected', 'expired']) {
    const r = evaluateStableOccupancy({
      service: svc,
      bookings: [
        booking({
          id: status,
          startDate: '2026-09-01',
          endDate: '2026-09-04',
          status,
        }),
      ],
      startDate: '2026-09-01',
      endDate: '2026-09-04',
      spacesRequested: 1,
    });
    assert.strictEqual(r.ok, true, status);
  }
});

suite('fill capacity 8 — 9th booking rejected', () => {
  const svc = service('svc1', 8);
  const existing = [];
  for (let i = 0; i < 8; i += 1) {
    existing.push(
      booking({
        id: `b${i}`,
        startDate: '2026-10-01',
        endDate: '2026-10-05',
        status: i % 2 === 0 ? 'pending' : 'confirmed',
        spacesRequested: 1,
      }),
    );
  }
  const eighthOk = evaluateStableOccupancy({
    service: svc,
    bookings: existing.slice(0, 7),
    startDate: '2026-10-01',
    endDate: '2026-10-05',
    spacesRequested: 1,
  });
  assert.strictEqual(eighthOk.ok, true);
  assert.strictEqual(eighthOk.minAvailable, 1);

  const ninth = evaluateStableOccupancy({
    service: svc,
    bookings: existing,
    startDate: '2026-10-01',
    endDate: '2026-10-05',
    spacesRequested: 1,
  });
  assert.strictEqual(ninth.ok, false);
  assert.strictEqual(ninth.minAvailable, 0);
  assert.strictEqual(ninth.peakUsed, 8);
});

suite('spacesRequested > 1 consumes multiple units', () => {
  const svc = service('svc1', 3);
  const existing = [
    booking({
      id: 'a',
      startDate: '2026-11-01',
      endDate: '2026-11-03',
      status: 'in_progress',
      spacesRequested: 2,
    }),
  ];
  const okOne = evaluateStableOccupancy({
    service: svc,
    bookings: existing,
    startDate: '2026-11-01',
    endDate: '2026-11-03',
    spacesRequested: 1,
  });
  assert.strictEqual(okOne.ok, true);
  assert.strictEqual(okOne.minAvailable, 1);

  const failTwo = evaluateStableOccupancy({
    service: svc,
    bookings: existing,
    startDate: '2026-11-01',
    endDate: '2026-11-03',
    spacesRequested: 2,
  });
  assert.strictEqual(failTwo.ok, false);
});

suite('availability payload: availableSpaces + full/available days', () => {
  const svc = service('svc1', 2);
  const bookings = [
    booking({
      id: 'a',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      status: 'confirmed',
      spacesRequested: 2,
    }),
  ];
  const payload = buildAvailabilityPayload({
    service: svc,
    bookings,
    from: '2026-12-01',
    to: '2026-12-05',
  });
  assert.strictEqual(payload.totalSpaces, 2);
  assert.strictEqual(payload.availableSpaces, 0);
  assert.strictEqual(payload.minAvailable, 0);
  assert.strictEqual(payload.canBook, false);
  assert.ok(payload.fullDays.includes('2026-12-01'));
  assert.ok(payload.fullDays.includes('2026-12-02'));
  assert.ok(payload.availableDays.includes('2026-12-03'));
  assert.ok(payload.availableDays.includes('2026-12-04'));
});

suite('excludeBookingId allows reschedule of same booking', () => {
  const svc = service('svc1', 1);
  const existing = [
    booking({
      id: 'mine',
      startDate: '2026-08-01',
      endDate: '2026-08-05',
      status: 'confirmed',
    }),
  ];
  const r = evaluateStableOccupancy({
    service: svc,
    bookings: existing,
    startDate: '2026-08-01',
    endDate: '2026-08-05',
    spacesRequested: 1,
    excludeBookingId: 'mine',
  });
  assert.strictEqual(r.ok, true);
});

suite('expireStalePendingBookings frees capacity', () => {
  const map = new Map();
  const old = booking({
    id: 'old',
    startDate: '2026-07-01',
    endDate: '2026-07-03',
    status: 'pending',
    createdAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
  });
  map.set('old', old);
  const n = expireStalePendingBookings(map, 48);
  assert.strictEqual(n, 1);
  assert.strictEqual(map.get('old').status, 'expired');
  const r = evaluateStableOccupancy({
    service: service('svc1', 1),
    bookings: [...map.values()],
    startDate: '2026-07-01',
    endDate: '2026-07-03',
    spacesRequested: 1,
  });
  assert.strictEqual(r.ok, true);
});

console.log('\nAll boarding occupancy Phase A tests passed.');
