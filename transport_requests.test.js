'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const tr = require('./transport_requests');

function emptyStore() {
  return {
    transportRequests: new Map(),
    services: new Map(),
    users: new Map(),
  };
}

function baseBody(overrides = {}) {
  return {
    animalType: 'horse',
    animalCount: 2,
    pickup: { latitude: 24.7, longitude: 46.6, address: 'A' },
    destination: { latitude: 24.8, longitude: 46.7, address: 'B' },
    requestTiming: 'immediate',
    tripType: 'oneWay',
    providerPreference: 'any',
    ...overrides,
  };
}

describe('transport_requests create', () => {
  it('creates camel/horse/falcon requests', () => {
    for (const animalType of ['camel', 'horse', 'falcon']) {
      const store = emptyStore();
      const r = tr.createTransportRequest({
        store,
        userId: 'u1',
        body: baseBody({ animalType, animalCount: 1 }),
        idFn: () => `id-${animalType}`,
        nowIso: '2026-07-20T00:00:00.000Z',
      });
      assert.equal(r.ok, true);
      assert.equal(r.request.animalType, animalType);
      assert.equal(r.request.status, 'provider_search');
      assert.equal(r.request.customerId, 'u1');
    }
  });

  it('rejects zero/negative count', () => {
    const r = tr.createTransportRequest({
      store: emptyStore(),
      userId: 'u1',
      body: baseBody({ animalCount: 0 }),
      idFn: () => 'x',
      nowIso: '2026-07-20T00:00:00.000Z',
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it('rejects missing pickup/destination', () => {
    const r1 = tr.createTransportRequest({
      store: emptyStore(),
      userId: 'u1',
      body: baseBody({ pickup: { latitude: null, longitude: 1 } }),
      idFn: () => 'x',
      nowIso: '2026-07-20T00:00:00.000Z',
    });
    assert.equal(r1.ok, false);
    const r2 = tr.createTransportRequest({
      store: emptyStore(),
      userId: 'u1',
      body: baseBody({ destination: undefined }),
      idFn: () => 'x',
      nowIso: '2026-07-20T00:00:00.000Z',
    });
    assert.equal(r2.ok, false);
  });

  it('rejects past scheduled time', () => {
    const r = tr.createTransportRequest({
      store: emptyStore(),
      userId: 'u1',
      body: baseBody({
        requestTiming: 'scheduled',
        requestedPickupAt: '2020-01-01T00:00:00.000Z',
      }),
      idFn: () => 'x',
      nowIso: '2026-07-20T00:00:00.000Z',
    });
    assert.equal(r.ok, false);
  });

  it('idempotency returns same request', () => {
    const store = emptyStore();
    const a = tr.createTransportRequest({
      store,
      userId: 'u1',
      body: baseBody({ idempotencyKey: 'k1' }),
      idFn: () => 'first',
      nowIso: '2026-07-20T00:00:00.000Z',
    });
    const b = tr.createTransportRequest({
      store,
      userId: 'u1',
      body: baseBody({ idempotencyKey: 'k1' }),
      idFn: () => 'second',
      nowIso: '2026-07-20T00:00:01.000Z',
    });
    assert.equal(a.ok && b.ok, true);
    assert.equal(b.reused, true);
    assert.equal(b.request.id, 'first');
  });
});

describe('transport_requests providers', () => {
  it('ownership 403/404', () => {
    const store = emptyStore();
    store.transportRequests.set('r1', {
      id: 'r1',
      customerId: 'owner',
      animalType: 'horse',
      animalCount: 1,
    });
    assert.equal(tr.getOwnedRequest(store, 'missing', 'owner').status, 404);
    assert.equal(tr.getOwnedRequest(store, 'r1', 'other').status, 403);
    assert.ok(tr.getOwnedRequest(store, 'r1', 'owner').request);
  });

  it('returns only transportation providers', () => {
    const store = emptyStore();
    const request = {
      id: 'r1',
      customerType: 'horse',
      animalType: 'horse',
      animalCount: 1,
      providerPreference: 'any',
    };
    store.services.set('vet', {
      id: 'vet',
      type: 'veterinary',
      providerId: 'p0',
      location: { latitude: 24.7, longitude: 46.6 },
    });
    store.services.set('tr', {
      id: 'tr',
      type: 'transportation',
      providerId: 'p1',
      name: 'Truck',
      capacityPerVehicle: 4,
      numberOfVehicles: 1,
      location: { latitude: 24.71, longitude: 46.67 },
    });
    const payload = tr.listProvidersForRequest(store, request);
    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0].serviceId, 'tr');
  });

  it('filters transportation + species + capacity + coords', () => {
    const store = emptyStore();
    const request = {
      id: 'r1',
      customerId: 'c1',
      animalType: 'horse',
      animalCount: 2,
      providerPreference: 'any',
    };
    store.services.set('s1', {
      id: 's1',
      type: 'transportation',
      providerId: 'p1',
      name: 'Individual Truck',
      capacityPerVehicle: 4,
      numberOfVehicles: 1,
      location: { latitude: 24.71, longitude: 46.67 },
      applicableSpecies: ['horse'],
    });
    store.services.set('s2', {
      id: 's2',
      type: 'transportation',
      providerId: 'p2',
      name: 'Camel Only',
      capacityPerVehicle: 10,
      numberOfVehicles: 1,
      location: { latitude: 24.72, longitude: 46.68 },
      applicableSpecies: ['camel'],
    });
    store.services.set('s3', {
      id: 's3',
      type: 'veterinary',
      providerId: 'p3',
      name: 'Vet',
      location: { latitude: 24.73, longitude: 46.69 },
    });
    store.services.set('s4', {
      id: 's4',
      type: 'transportation',
      providerId: 'p4',
      name: 'No coords',
      capacityPerVehicle: 4,
      numberOfVehicles: 1,
    });
    store.services.set('s5', {
      id: 's5',
      type: 'transportation',
      providerId: 'p5',
      name: 'Too small',
      capacityPerVehicle: 1,
      numberOfVehicles: 1,
      location: { latitude: 24.74, longitude: 46.7 },
      applicableSpecies: ['horse'],
    });
    store.services.set('s6', {
      id: 's6',
      type: 'transportation',
      providerId: 'p6',
      name: 'Fleet Co',
      companyName: 'Fleet Co',
      capacityPerVehicle: 3,
      numberOfVehicles: 5,
      location: { latitude: 24.75, longitude: 46.71 },
    });

    const payload = tr.listProvidersForRequest(store, request);
    const ids = payload.providers.map((p) => p.serviceId).sort();
    assert.deepEqual(ids, ['s1', 's6']);
    const company = payload.providers.find((p) => p.serviceId === 's6');
    assert.equal(company.providerType, 'company');
    const ind = payload.providers.find((p) => p.serviceId === 's1');
    assert.equal(ind.providerType, 'individual');
  });

  it('filters incompatible animal type', () => {
    const store = emptyStore();
    store.services.set('s1', {
      id: 's1',
      type: 'transportation',
      providerId: 'p1',
      name: 'Horse',
      capacityPerVehicle: 4,
      numberOfVehicles: 1,
      location: { latitude: 24.71, longitude: 46.67 },
      applicableSpecies: ['horse'],
    });
    const payload = tr.listProvidersForRequest(store, {
      id: 'r1',
      animalType: 'falcon',
      animalCount: 1,
      providerPreference: 'any',
    });
    assert.equal(payload.providers.length, 0);
  });

  it('ignores invalid provider coordinates', () => {
    const store = emptyStore();
    store.services.set('s1', {
      id: 's1',
      type: 'transportation',
      providerId: 'p1',
      name: 'Zero island',
      capacityPerVehicle: 4,
      numberOfVehicles: 1,
      location: { latitude: 0, longitude: 0 },
    });
    const payload = tr.listProvidersForRequest(store, {
      id: 'r1',
      animalType: 'horse',
      animalCount: 1,
      providerPreference: 'any',
    });
    assert.equal(payload.providers.length, 0);
  });

  it('company/individual normalization', () => {
    const store = emptyStore();
    store.services.set('co', {
      id: 'co',
      type: 'transportation',
      providerId: 'p1',
      companyName: 'Fleet LLC',
      capacityPerVehicle: 2,
      numberOfVehicles: 3,
      location: { latitude: 24.71, longitude: 46.67 },
    });
    store.services.set('ind', {
      id: 'ind',
      type: 'transportation',
      providerId: 'p2',
      name: 'Solo Driver',
      capacityPerVehicle: 2,
      numberOfVehicles: 1,
      location: { latitude: 24.72, longitude: 46.68 },
    });
    const payload = tr.listProvidersForRequest(store, {
      id: 'r1',
      animalType: 'horse',
      animalCount: 1,
      providerPreference: 'any',
    });
    const co = payload.providers.find((p) => p.serviceId === 'co');
    const ind = payload.providers.find((p) => p.serviceId === 'ind');
    assert.equal(co.providerType, 'company');
    assert.equal(ind.providerType, 'individual');
  });

  it('empty providers result', () => {
    const store = emptyStore();
    const payload = tr.listProvidersForRequest(store, {
      id: 'r1',
      animalType: 'falcon',
      animalCount: 1,
      providerPreference: 'any',
    });
    assert.equal(payload.providers.length, 0);
  });

  it('duplicate provider records both appear when distinct services', () => {
    const store = emptyStore();
    for (const id of ['dup1', 'dup2']) {
      store.services.set(id, {
        id,
        type: 'transportation',
        providerId: 'same-provider',
        name: 'Dup',
        capacityPerVehicle: 4,
        numberOfVehicles: 1,
        location: { latitude: 24.71, longitude: 46.67 },
      });
    }
    const payload = tr.listProvidersForRequest(store, {
      id: 'r1',
      animalType: 'horse',
      animalCount: 1,
      providerPreference: 'any',
    });
    assert.equal(payload.providers.length, 2);
  });
});
