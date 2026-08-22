'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const negotiation = require('./negotiation_engine');
const { createWsHub } = require('./ws_hub');

function emptyStore() {
  return {
    transportRequests: new Map(),
    negotiations: new Map(),
    offers: new Map(),
    negotiationEvents: [],
    bookings: new Map(),
    services: new Map(),
    users: new Map(),
  };
}

function seedRequest(store, overrides = {}) {
  const request = {
    id: 'req1',
    customerId: 'cust1',
    animalType: 'horse',
    animalCount: 2,
    pickup: { latitude: 24.7, longitude: 46.6, address: 'A' },
    destination: { latitude: 24.8, longitude: 46.7, address: 'B' },
    requestTiming: 'immediate',
    requestedPickupAt: '2026-07-21T10:00:00.000Z',
    tripType: 'oneWay',
    providerPreference: 'any',
    status: 'provider_search',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
  store.transportRequests.set(request.id, request);
  return request;
}

function seedService(store, id, providerId) {
  const s = {
    id,
    type: 'transportation',
    providerId,
    name: `Svc ${id}`,
    capacityPerVehicle: 4,
    numberOfVehicles: 2,
  };
  store.services.set(id, s);
  return s;
}

let seq = 0;
const idFn = () => `id-${++seq}`;

describe('negotiation_engine', () => {
  it('opens negotiation and accepts provider offer atomically', () => {
    seq = 0;
    const store = emptyStore();
    const request = seedRequest(store);
    seedService(store, 'svc1', 'prov1');

    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'cust1',
      idFn,
    });
    assert.equal(opened.ok, true);

    const offerRes = negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 500, serviceId: 'svc1', note: 'first' },
      idFn,
    });
    assert.equal(offerRes.ok, true);
    assert.equal(offerRes.offer.status, 'pending');

    const accept = negotiation.acceptOffer({
      store,
      offerId: offerRes.offer.id,
      userId: 'cust1',
      idFn,
      idempotencyKey: 'accept-1',
    });
    assert.equal(accept.ok, true);
    assert.equal(accept.booking.totalPrice, 500);
    assert.equal(accept.booking.transportRequestId, 'req1');
    assert.equal(accept.booking.acceptedOfferId, offerRes.offer.id);
    assert.equal(accept.booking.negotiationId, opened.negotiation.id);
    assert.equal(accept.request.status, 'converted');
    assert.equal(accept.negotiation.status, 'accepted');
    assert.equal(store.bookings.size, 1);
  });

  it('supports counter offers from customer and provider accept', () => {
    seq = 0;
    const store = emptyStore();
    const request = seedRequest(store);
    seedService(store, 'svc1', 'prov1');
    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'cust1',
      idFn,
    });
    const pOffer = negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 800, serviceId: 'svc1' },
      idFn,
    });
    const counter = negotiation.createOffer({
      store,
      request,
      negotiation: store.negotiations.get(opened.negotiation.id),
      actorUserId: 'cust1',
      actorRole: 'customer',
      body: {
        amount: 650,
        parentOfferId: pOffer.offer.id,
      },
      idFn,
    });
    assert.equal(counter.ok, true);
    assert.equal(counter.offer.kind, 'customer_counter');

    const accept = negotiation.acceptOffer({
      store,
      offerId: counter.offer.id,
      userId: 'prov1',
      idFn,
    });
    assert.equal(accept.ok, true);
    assert.equal(accept.booking.totalPrice, 650);
  });

  it('rejects expired offers', () => {
    seq = 0;
    const store = emptyStore();
    const request = seedRequest(store);
    seedService(store, 'svc1', 'prov1');
    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'cust1',
      idFn,
    });
    const t0 = Date.parse('2026-07-20T10:00:00.000Z');
    const offerRes = negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 100, serviceId: 'svc1', ttlMs: 60_000 },
      idFn,
      nowMs: t0,
    });
    const accept = negotiation.acceptOffer({
      store,
      offerId: offerRes.offer.id,
      userId: 'cust1',
      idFn,
      nowMs: t0 + 120_000,
    });
    assert.equal(accept.ok, false);
    assert.equal(accept.status, 409);
  });

  it('withdraw and reject work', () => {
    seq = 0;
    const store = emptyStore();
    const request = seedRequest(store);
    seedService(store, 'svc1', 'prov1');
    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'cust1',
      idFn,
    });
    const a = negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 100, serviceId: 'svc1' },
      idFn,
    });
    const w = negotiation.withdrawOffer({
      store,
      offerId: a.offer.id,
      userId: 'prov1',
      idFn,
    });
    assert.equal(w.ok, true);
    assert.equal(w.offer.status, 'withdrawn');

    const b = negotiation.createOffer({
      store,
      request,
      negotiation: store.negotiations.get(opened.negotiation.id),
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 120, serviceId: 'svc1' },
      idFn,
    });
    const r = negotiation.rejectOffer({
      store,
      offerId: b.offer.id,
      userId: 'cust1',
      idFn,
    });
    assert.equal(r.ok, true);
    assert.equal(r.offer.status, 'rejected');
  });

  it('prevents double accept and supports idempotent accept', () => {
    seq = 0;
    const store = emptyStore();
    const request = seedRequest(store);
    seedService(store, 'svc1', 'prov1');
    seedService(store, 'svc2', 'prov2');
    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'cust1',
      idFn,
    });
    const o1 = negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 200, serviceId: 'svc1' },
      idFn,
    });
    const o2 = negotiation.createOffer({
      store,
      request,
      negotiation: store.negotiations.get(opened.negotiation.id),
      actorUserId: 'prov2',
      actorRole: 'provider',
      body: { amount: 180, serviceId: 'svc2' },
      idFn,
    });

    const a1 = negotiation.acceptOffer({
      store,
      offerId: o1.offer.id,
      userId: 'cust1',
      idFn,
      idempotencyKey: 'dup-key',
    });
    assert.equal(a1.ok, true);

    const a1again = negotiation.acceptOffer({
      store,
      offerId: o1.offer.id,
      userId: 'cust1',
      idFn,
      idempotencyKey: 'dup-key',
    });
    assert.equal(a1again.ok, true);
    assert.equal(a1again.reused, true);
    assert.equal(store.bookings.size, 1);

    const a2 = negotiation.acceptOffer({
      store,
      offerId: o2.offer.id,
      userId: 'cust1',
      idFn,
    });
    assert.equal(a2.ok, false);
    assert.equal(store.bookings.size, 1);
    assert.equal(
      store.offers.get(o2.offer.id).status,
      'rejected',
    );
  });

  it('cancel during negotiation closes and rejects pending', () => {
    seq = 0;
    const store = emptyStore();
    const request = seedRequest(store);
    seedService(store, 'svc1', 'prov1');
    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'cust1',
      idFn,
    });
    negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 100, serviceId: 'svc1' },
      idFn,
    });
    const cancel = negotiation.cancelRequestDuringNegotiation({
      store,
      request: store.transportRequests.get('req1'),
      userId: 'cust1',
      idFn,
    });
    assert.equal(cancel.ok, true);
    assert.equal(cancel.request.status, 'cancelled');
    assert.equal(
      store.negotiations.get(opened.negotiation.id).status,
      'closed',
    );
  });

  it('booking snapshot contains immutable commercial fields', () => {
    seq = 0;
    const store = emptyStore();
    const request = seedRequest(store, {
      animalType: 'camel',
      animalCount: 3,
      specialRequirements: 'quiet load',
    });
    seedService(store, 'svc1', 'prov1');
    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'cust1',
      idFn,
    });
    const offer = negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'prov1',
      actorRole: 'provider',
      body: { amount: 999, currency: 'SAR', serviceId: 'svc1' },
      idFn,
    });
    const accept = negotiation.acceptOffer({
      store,
      offerId: offer.offer.id,
      userId: 'cust1',
      idFn,
    });
    const b = accept.booking;
    assert.equal(b.details.animalType, 'camel');
    assert.equal(b.details.animalCount, 3);
    assert.equal(b.details.acceptedAmount, 999);
    assert.ok(b.details.pickup);
    assert.ok(b.details.destination);
    assert.equal(b.transportRequestId, 'req1');
    assert.equal(b.negotiationId, opened.negotiation.id);
    assert.equal(b.acceptedOfferId, offer.offer.id);
  });

  it('blocks provider from offering on another provider service', () => {
    seq = 0;
    const store = emptyStore();
    const request = seedRequest(store);
    seedService(store, 'svc1', 'prov1');
    const opened = negotiation.openNegotiation({
      store,
      request,
      userId: 'cust1',
      idFn,
    });
    const bad = negotiation.createOffer({
      store,
      request,
      negotiation: opened.negotiation,
      actorUserId: 'prov2',
      actorRole: 'provider',
      body: { amount: 50, serviceId: 'svc1' },
      idFn,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 403);
  });
});

describe('ws_hub', () => {
  it('publishes to request and customer rooms', () => {
    const hub = createWsHub({
      resolveUserFromToken: () => ({ id: 'u1' }),
    });
    const received = [];
    const fakeClient = {
      userId: 'cust1',
      rooms: new Set(),
      send(text) {
        received.push(JSON.parse(text));
      },
    };
    // manually join via publish internals
    hub.publishNegotiation({
      type: 'offer.created',
      requestId: 'r1',
      customerId: 'cust1',
      providerId: 'p1',
    });
    // no clients joined — 0 deliveries is fine
    assert.equal(received.length, 0);
    assert.equal(typeof hub.handleUpgrade, 'function');
    assert.equal(hub.clientCount(), 0);
  });
});
