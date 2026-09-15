'use strict';

/**
 * Species-aware transport matching — fail-closed contract tests (T1–T6, T14).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const matching = require('./matching_engine');

function emptyStore() {
  return {
    transportRequests: new Map(),
    services: new Map(),
    users: new Map(),
    bookings: new Map(),
    trips: new Map(),
  };
}

function req(animalType) {
  return {
    id: 'r1',
    customerId: 'c1',
    animalType,
    animalCount: 1,
    pickup: { latitude: 24.7, longitude: 46.6 },
    destination: { latitude: 24.8, longitude: 46.7 },
    requestTiming: 'immediate',
    requestedPickupAt: '2026-07-20T10:00:00.000Z',
    tripType: 'oneWay',
    providerPreference: 'any',
  };
}

function svc(id, applicableSpecies) {
  return {
    id,
    type: 'transportation',
    providerId: `p-${id}`,
    name: `Svc ${id}`,
    capacityPerVehicle: 4,
    numberOfVehicles: 1,
    location: { latitude: 24.71, longitude: 46.67 },
    applicableSpecies,
    workingHours: '24',
  };
}

function ids(payload) {
  return payload.providers.map((p) => p.serviceId).sort();
}

describe('species_aware_transport_fail_closed', () => {
  it('T1 horse-only appears under horse only', () => {
    const store = emptyStore();
    store.services.set('h', svc('h', ['horse']));
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('horse'))), ['h']);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('camel'))), []);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('falcon'))), []);
  });

  it('T2 camel-only appears under camel only', () => {
    const store = emptyStore();
    store.services.set('c', svc('c', ['camel']));
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('camel'))), ['c']);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('horse'))), []);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('falcon'))), []);
  });

  it('T3 falcon-only appears under falcon only', () => {
    const store = emptyStore();
    store.services.set('f', svc('f', ['falcon']));
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('falcon'))), ['f']);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('horse'))), []);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('camel'))), []);
  });

  it('T4 horse+camel appears under horse and camel, not falcon', () => {
    const store = emptyStore();
    store.services.set('hc', svc('hc', ['horse', 'camel']));
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('horse'))), ['hc']);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('camel'))), ['hc']);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('falcon'))), []);
  });

  it('T5 empty applicableSpecies never matches', () => {
    const store = emptyStore();
    store.services.set('e', svc('e', []));
    for (const sp of ['horse', 'camel', 'falcon']) {
      assert.equal(matching.speciesCompatible(svc('e', []), sp), false);
      assert.deepEqual(ids(matching.matchProvidersForRequest(store, req(sp))), []);
    }
  });

  it('T6 legacy missing applicableSpecies never matches', () => {
    const store = emptyStore();
    const legacy = svc('legacy', undefined);
    delete legacy.applicableSpecies;
    store.services.set('legacy', legacy);
    for (const sp of ['horse', 'camel', 'falcon']) {
      assert.equal(matching.speciesCompatible(legacy, sp), false);
      assert.deepEqual(ids(matching.matchProvidersForRequest(store, req(sp))), []);
    }
  });

  it('T14 horse-only new registration shape is discoverable only for horse', () => {
    const store = emptyStore();
    const normalized = matching.normalizeApplicableSpecies(['Horse', 'HORSE']);
    assert.deepEqual(normalized, ['horse']);
    store.services.set('new', svc('new', normalized));
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('horse'))), ['new']);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('camel'))), []);
    assert.deepEqual(ids(matching.matchProvidersForRequest(store, req('falcon'))), []);
  });

  it('normalize drops unknown tokens; explicit all expands', () => {
    assert.deepEqual(matching.normalizeApplicableSpecies(['sheep', 'goat']), []);
    assert.deepEqual(
      matching.normalizeApplicableSpecies('all').sort(),
      ['camel', 'falcon', 'horse'],
    );
  });
});
