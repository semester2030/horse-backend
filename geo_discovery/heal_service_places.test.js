'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { healMissingServicePlaces, expectedPlaceId } = require('./heal_service_places');
const { syncStableServiceToPlaces } = require('./adapters/stable_place_adapter');
const { syncServiceToPlaces } = require('./adapters/vertical_place_adapter');
const { resolveRenderMode } = require('./cluster_engine');

test('heal indexes missing training place', () => {
  const store = {
    services: new Map([
      [
        't1',
        {
          id: 't1',
          type: 'training',
          name: 'تدريب',
          latitude: 24.68,
          longitude: 46.63,
          applicableSpecies: ['horse'],
        },
      ],
    ]),
    servicePlaces: new Map(),
  };
  function syncAny(service) {
    const a = syncStableServiceToPlaces(store, service);
    if (a.ok) return a;
    return syncServiceToPlaces(store, service);
  }
  assert.equal(expectedPlaceId(store.services.get('t1')), 'place_training_t1');
  const out = healMissingServicePlaces(store, syncAny);
  assert.equal(out.healed, 1);
  assert.ok(store.servicePlaces.has('place_training_t1'));
});

test('few places force places mode even if client asked clusters', () => {
  assert.equal(
    resolveRenderMode({ requestedMode: 'clusters', zoom: 11, placeCount: 1 }),
    'places',
  );
  assert.equal(
    resolveRenderMode({ requestedMode: 'clusters', zoom: 11, placeCount: 20 }),
    'clusters',
  );
});
