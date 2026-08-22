'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const journey = require('./journey_engine');
const negotiation = require('./negotiation_engine');

function emptyStore() {
  return {
    transportRequests: new Map(),
    negotiations: new Map(),
    offers: new Map(),
    negotiationEvents: [],
    bookings: new Map(),
    trips: new Map(),
    tripEvents: [],
    drivers: new Map(),
    vehicles: new Map(),
    services: new Map(),
    users: new Map(),
  };
}

let seq = 0;
const idFn = () => `id-${++seq}`;

function seedBooking(store) {
  const booking = {
    id: 'book1',
    type: 'transportation',
    serviceId: 'svc1',
    providerId: 'prov1',
    userId: 'cust1',
    status: 'pending',
    totalPrice: 400,
    currency: 'SAR',
    details: {
      animalType: 'horse',
      animalCount: 2,
      unitsRequested: 2,
      pickup: { latitude: 1, longitude: 1 },
      destination: { latitude: 2, longitude: 2 },
    },
    createdAt: '2026-07-20T00:00:00.000Z',
  };
  store.bookings.set(booking.id, booking);
  store.services.set('svc1', {
    id: 'svc1',
    type: 'transportation',
    providerId: 'prov1',
    capacityPerVehicle: 4,
    numberOfVehicles: 1,
  });
  return booking;
}

function seedFleet(store, nowMs) {
  const future = new Date(nowMs + 365 * 24 * 3600 * 1000).toISOString();
  const d = journey.upsertDriver({
    store,
    providerId: 'prov1',
    body: {
      name: 'Driver A',
      licenseNumber: 'LIC-1',
      licenseValidUntil: future,
      available: true,
    },
    idFn,
    nowMs,
  });
  const v = journey.upsertVehicle({
    store,
    providerId: 'prov1',
    body: {
      plate: 'ABC-123',
      capacity: 4,
      animalTypes: ['horse', 'camel'],
      insuranceValidUntil: future,
    },
    idFn,
    nowMs,
  });
  return { driver: d.driver, vehicle: v.vehicle };
}

describe('journey_engine T5A', () => {
  it('creates exactly one trip per booking (idempotent)', () => {
    seq = 0;
    const store = emptyStore();
    const booking = seedBooking(store);
    const a = journey.createTripFromBooking({ store, booking, idFn });
    const b = journey.createTripFromBooking({ store, booking, idFn });
    assert.equal(a.ok, true);
    assert.equal(a.reused, false);
    assert.equal(b.reused, true);
    assert.equal(a.trip.id, b.trip.id);
    assert.equal(store.trips.size, 1);
    assert.equal(store.bookings.get('book1').tripId, a.trip.id);
    assert.equal(a.trip.status, 'created');
  });

  it('assigns driver and vehicle with validation', () => {
    seq = 0;
    const store = emptyStore();
    const nowMs = Date.parse('2026-07-20T12:00:00.000Z');
    const booking = seedBooking(store);
    const { trip } = journey.createTripFromBooking({
      store,
      booking,
      idFn,
      nowMs,
    });
    const { driver, vehicle } = seedFleet(store, nowMs);

    const badCustomer = journey.assignDriver({
      store,
      tripId: trip.id,
      driverId: driver.id,
      actorUserId: 'cust1',
      idFn,
      nowMs,
    });
    assert.equal(badCustomer.status, 403);

    const ad = journey.assignDriver({
      store,
      tripId: trip.id,
      driverId: driver.id,
      actorUserId: 'prov1',
      idFn,
      nowMs,
    });
    assert.equal(ad.ok, true);
    assert.equal(ad.trip.status, 'driver_assigned');

    const av = journey.assignVehicle({
      store,
      tripId: trip.id,
      vehicleId: vehicle.id,
      actorUserId: 'prov1',
      idFn,
      nowMs,
    });
    assert.equal(av.ok, true);
    assert.equal(av.trip.status, 'vehicle_assigned');
    assert.equal(av.trip.vehicleId, vehicle.id);
  });

  it('rejects illegal transitions and customer mutations', () => {
    seq = 0;
    const store = emptyStore();
    const nowMs = Date.parse('2026-07-20T12:00:00.000Z');
    const booking = seedBooking(store);
    const { trip } = journey.createTripFromBooking({
      store,
      booking,
      idFn,
      nowMs,
    });
    const { driver, vehicle } = seedFleet(store, nowMs);
    journey.assignDriver({
      store,
      tripId: trip.id,
      driverId: driver.id,
      actorUserId: 'prov1',
      idFn,
      nowMs,
    });
    journey.assignVehicle({
      store,
      tripId: trip.id,
      vehicleId: vehicle.id,
      actorUserId: 'prov1',
      idFn,
      nowMs,
    });

    const skip = journey.transitionTrip({
      store,
      tripId: trip.id,
      toStatus: 'delivered',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
      nowMs,
    });
    assert.equal(skip.ok, false);
    assert.equal(skip.status, 409);

    const cust = journey.transitionTrip({
      store,
      tripId: trip.id,
      toStatus: 'driver_en_route',
      actorUserId: 'cust1',
      actorRole: 'customer',
      idFn,
      nowMs,
    });
    assert.equal(cust.status, 403);

    const ok = journey.transitionTrip({
      store,
      tripId: trip.id,
      toStatus: 'driver_en_route',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
      nowMs,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.trip.status, 'driver_en_route');
  });

  it('walks full legal state machine and builds timeline', () => {
    seq = 0;
    const store = emptyStore();
    const nowMs = Date.parse('2026-07-20T12:00:00.000Z');
    const booking = seedBooking(store);
    let { trip } = journey.createTripFromBooking({
      store,
      booking,
      idFn,
      nowMs,
    });
    const { driver, vehicle } = seedFleet(store, nowMs);
    trip = journey.assignDriver({
      store,
      tripId: trip.id,
      driverId: driver.id,
      actorUserId: 'prov1',
      idFn,
      nowMs,
    }).trip;
    trip = journey.assignVehicle({
      store,
      tripId: trip.id,
      vehicleId: vehicle.id,
      actorUserId: 'prov1',
      idFn,
      nowMs,
    }).trip;

    const steps = [
      'driver_en_route',
      'arrived_at_pickup',
      'loading_started',
      'loading_completed',
      'in_transit',
      'arrived_at_destination',
      'unloading_started',
      'unloading_completed',
      'delivered',
      'closed',
    ];
    for (const toStatus of steps) {
      const r = journey.transitionTrip({
        store,
        tripId: trip.id,
        toStatus,
        actorUserId: 'prov1',
        actorRole: 'provider',
        idFn,
        nowMs,
      });
      assert.equal(r.ok, true, toStatus);
      trip = r.trip;
    }
    assert.equal(trip.status, 'closed');
    const timeline = journey.listTimeline(store, trip.id);
    assert.ok(timeline.length >= steps.length + 3);
    assert.equal(timeline[0].type, 'TripCreated');
    assert.ok(timeline.every((e) => e.serverTime === true));
  });

  it('admin override jumps forward with audit note', () => {
    seq = 0;
    const store = emptyStore();
    const nowMs = Date.parse('2026-07-20T12:00:00.000Z');
    const booking = seedBooking(store);
    const { trip } = journey.createTripFromBooking({
      store,
      booking,
      idFn,
      nowMs,
    });
    const audits = [];
    const r = journey.transitionTrip({
      store,
      tripId: trip.id,
      toStatus: 'in_transit',
      actorUserId: 'admin1',
      actorRole: 'admin',
      note: 'ops recovery',
      idFn,
      nowMs,
      adminOverride: true,
      auditFn: (e) => audits.push(e),
    });
    assert.equal(r.ok, true);
    assert.equal(r.trip.status, 'in_transit');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'trip.admin_override');
  });

  it('acceptOffer creates booking linked trip (no duplicate)', () => {
    seq = 0;
    const store = emptyStore();
    store.transportRequests.set('req1', {
      id: 'req1',
      customerId: 'cust1',
      animalType: 'horse',
      animalCount: 1,
      pickup: { latitude: 1, longitude: 1 },
      destination: { latitude: 2, longitude: 2 },
      status: 'provider_search',
      requestedPickupAt: '2026-07-21T10:00:00.000Z',
    });
    store.services.set('svc1', {
      id: 'svc1',
      type: 'transportation',
      providerId: 'prov1',
      capacityPerVehicle: 4,
      numberOfVehicles: 2,
    });
    const opened = negotiation.openNegotiation({
      store,
      request: store.transportRequests.get('req1'),
      userId: 'cust1',
      idFn,
    });
    const offerRes = negotiation.createOffer({
      store,
      request: store.transportRequests.get('req1'),
      negotiation: opened.negotiation,
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 300, serviceId: 'svc1' },
      idFn,
    });
    const accept = negotiation.acceptOffer({
      store,
      offerId: offerRes.offer.id,
      userId: 'cust1',
      idFn,
      idempotencyKey: 'k1',
    });
    assert.equal(accept.ok, true);
    assert.ok(accept.trip);
    assert.equal(accept.trip.bookingId, accept.booking.id);
    assert.equal(accept.booking.tripId, accept.trip.id);
    assert.equal(store.trips.size, 1);

    const again = negotiation.acceptOffer({
      store,
      offerId: offerRes.offer.id,
      userId: 'cust1',
      idFn,
      idempotencyKey: 'k1',
    });
    assert.equal(again.reused, true);
    assert.equal(store.trips.size, 1);
  });

  it('blocks conflicting driver assignment', () => {
    seq = 0;
    const store = emptyStore();
    const nowMs = Date.parse('2026-07-20T12:00:00.000Z');
    const b1 = seedBooking(store);
    const b2 = {
      ...b1,
      id: 'book2',
    };
    store.bookings.set('book2', b2);
    const t1 = journey.createTripFromBooking({
      store,
      booking: b1,
      idFn,
      nowMs,
    }).trip;
    const t2 = journey.createTripFromBooking({
      store,
      booking: b2,
      idFn,
      nowMs,
    }).trip;
    const { driver } = seedFleet(store, nowMs);
    assert.equal(
      journey.assignDriver({
        store,
        tripId: t1.id,
        driverId: driver.id,
        actorUserId: 'prov1',
        idFn,
        nowMs,
      }).ok,
      true,
    );
    const conflict = journey.assignDriver({
      store,
      tripId: t2.id,
      driverId: driver.id,
      actorUserId: 'prov1',
      idFn,
      nowMs,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.status, 409);
  });
});
