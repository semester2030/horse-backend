'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const tracking = require('./tracking_engine');
const { createWsHub } = require('./ws_hub');

function emptyStore() {
  return {
    trips: new Map(),
    tripEvents: [],
    drivers: new Map(),
    vehicles: new Map(),
    trackingSessions: new Map(),
    trackingHistory: [],
    trackingEvents: [],
    bookings: new Map(),
  };
}

let seq = 0;
const idFn = () => `id-${++seq}`;

function seedTrip(store, overrides = {}) {
  const trip = {
    id: 'trip1',
    bookingId: 'book1',
    customerId: 'cust1',
    providerId: 'prov1',
    driverId: 'drv1',
    vehicleId: 'veh1',
    status: 'driver_en_route',
    pickup: { latitude: 24.7, longitude: 46.6 },
    destination: { latitude: 24.8, longitude: 46.75 },
    ...overrides,
  };
  store.trips.set(trip.id, trip);
  return trip;
}

describe('tracking_engine T5B', () => {
  afterEach(() => {
    tracking.resetEtaProvider();
  });

  it('creates one tracking session per trip (idempotent start)', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const a = tracking.startTracking({
      store,
      trip,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(a.ok, true);
    assert.equal(a.session.status, 'tracking');
    const b = tracking.startTracking({
      store,
      trip: store.trips.get('trip1'),
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(b.reused, true);
    assert.equal(store.trackingSessions.size, 1);
    assert.equal(store.trips.get('trip1').trackingSessionId, a.session.id);
  });

  it('validates GPS: lat/lon/stale/future/duplicate/jump', () => {
    const nowMs = Date.parse('2026-07-20T12:00:00.000Z');
    assert.equal(
      tracking.validateLocationSample({ latitude: 100, longitude: 46 }, { nowMs })
        .code,
      'INVALID_LATITUDE',
    );
    assert.equal(
      tracking.validateLocationSample({ latitude: 24, longitude: 200 }, { nowMs })
        .code,
      'INVALID_LONGITUDE',
    );
    assert.equal(
      tracking.validateLocationSample(
        {
          latitude: 24,
          longitude: 46,
          timestamp: new Date(nowMs - 10 * 60 * 1000).toISOString(),
        },
        { nowMs },
      ).code,
      'STALE_TIMESTAMP',
    );
    assert.equal(
      tracking.validateLocationSample(
        {
          latitude: 24,
          longitude: 46,
          timestamp: new Date(nowMs + 120 * 1000).toISOString(),
        },
        { nowMs },
      ).code,
      'FUTURE_TIMESTAMP',
    );

    const first = tracking.validateLocationSample(
      { latitude: 24.7, longitude: 46.6, timestamp: new Date(nowMs).toISOString() },
      { nowMs },
    );
    assert.equal(first.ok, true);
    const dup = tracking.validateLocationSample(
      { latitude: 24.7, longitude: 46.6, timestamp: new Date(nowMs).toISOString() },
      { previous: first.sample, nowMs },
    );
    assert.equal(dup.code, 'DUPLICATE_SAMPLE');

    const jump = tracking.validateLocationSample(
      {
        latitude: 25.5,
        longitude: 47.5,
        timestamp: new Date(nowMs + 1000).toISOString(),
      },
      { previous: first.sample, nowMs: nowMs + 1000 },
    );
    assert.equal(jump.code, 'IMPOSSIBLE_JUMP');
  });

  it('lifecycle pause/resume/stop and rejects illegal transition', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const started = tracking.startTracking({
      store,
      trip,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    const bad = tracking.transitionTracking({
      store,
      sessionId: started.session.id,
      toStatus: 'inactive',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 409);

    const paused = tracking.transitionTracking({
      store,
      sessionId: started.session.id,
      toStatus: 'paused',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(paused.session.status, 'paused');
    const illegal = tracking.transitionTracking({
      store,
      sessionId: started.session.id,
      toStatus: 'started',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(illegal.ok, false);
    const resumed = tracking.transitionTracking({
      store,
      sessionId: started.session.id,
      toStatus: 'resumed',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(resumed.session.status, 'resumed');
  });

  it('pushes location, appends history, computes ETA and distance', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const started = tracking.startTracking({
      store,
      trip,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    const nowMs = Date.parse('2026-07-20T12:00:00.000Z');
    const p1 = tracking.pushLocation({
      store,
      sessionId: started.session.id,
      body: {
        latitude: 24.71,
        longitude: 46.61,
        speed: 10,
        heading: 90,
        accuracy: 12,
        timestamp: new Date(nowMs).toISOString(),
      },
      actorUserId: 'prov1',
      idFn,
      nowMs,
    });
    assert.equal(p1.ok, true);
    assert.ok(p1.metrics.distanceRemainingM > 0);
    assert.ok(p1.metrics.etaSeconds != null);
    assert.equal(p1.metrics.etaMethod, 'haversine_speed_v1');

    const p2 = tracking.pushLocation({
      store,
      sessionId: started.session.id,
      body: {
        latitude: 24.72,
        longitude: 46.62,
        speed: 12,
        timestamp: new Date(nowMs + 30_000).toISOString(),
      },
      actorUserId: 'prov1',
      idFn,
      nowMs: nowMs + 30_000,
    });
    assert.equal(p2.ok, true);
    assert.ok(p2.session.distanceTravelledM > 0);
    assert.equal(tracking.listHistory(store, started.session.id).length, 2);
  });

  it('rejects location while paused', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const started = tracking.startTracking({
      store,
      trip,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    tracking.transitionTracking({
      store,
      sessionId: started.session.id,
      toStatus: 'paused',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    const nowMs = Date.now();
    const r = tracking.pushLocation({
      store,
      sessionId: started.session.id,
      body: { latitude: 24.7, longitude: 46.6, timestamp: new Date(nowMs).toISOString() },
      actorUserId: 'prov1',
      idFn,
      nowMs,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
  });

  it('requires trip with driver/vehicle; auth read roles', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store, { driverId: null });
    const r = tracking.startTracking({
      store,
      trip,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(r.ok, false);

    const trip2 = seedTrip(store, { id: 't2', driverId: 'd', vehicleId: 'v' });
    store.trips.set('t2', trip2);
    const s = tracking.startTracking({
      store,
      trip: trip2,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(tracking.assertCanRead(s.session, 'cust1'), 'customer');
    assert.equal(tracking.assertCanRead(s.session, 'prov1'), 'provider');
    assert.equal(tracking.assertCanRead(s.session, 'other'), null);
    assert.equal(tracking.assertCanPublish(s.session, 'prov1', store), 'provider');
    assert.equal(tracking.assertCanPublish(s.session, 'cust1', store), null);
  });

  it('eta provider is swappable', () => {
    tracking.setEtaProvider({
      name: 'mock_eta',
      estimate() {
        return {
          etaSeconds: 42,
          etaAt: '2026-07-20T12:00:42.000Z',
          method: 'mock_eta',
          distanceRemainingM: 100,
          distanceTravelledM: 50,
          plannedDistanceM: 150,
          progressPct: 33,
        };
      },
    });
    const store = emptyStore();
    const trip = seedTrip(store);
    const s = tracking.startTracking({
      store,
      trip,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn: () => 'x1',
    });
    const nowMs = Date.now();
    tracking.pushLocation({
      store,
      sessionId: s.session.id,
      body: { latitude: 24.7, longitude: 46.6, timestamp: new Date(nowMs).toISOString() },
      actorUserId: 'prov1',
      idFn: () => 'x2',
      nowMs,
    });
    const metrics = tracking.computeRouteMetrics(
      store.trackingSessions.get(s.session.id),
    );
    assert.equal(metrics.etaSeconds, 42);
    assert.equal(metrics.etaMethod, 'mock_eta');
  });

  it('publishes tracking events with seq via ws hub', () => {
    const hub = createWsHub({
      resolveUserFromToken: () => ({ id: 'u1' }),
    });
    const ev = hub.publishNegotiation({
      type: 'tracking.location',
      requestId: 'trip:trip1',
      tripId: 'trip1',
      customerId: 'c1',
      providerId: 'p1',
      position: { latitude: 1, longitude: 2 },
    });
    assert.equal(ev.seq, 1);
    const replay = hub.replayAfter('request:trip:trip1', 0);
    assert.equal(replay.length, 1);
  });
});
