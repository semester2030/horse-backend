'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  stableServiceToPlacePayload,
  syncAllStableServices,
  boardingVerticalMatches,
} = require('./stable_place_adapter');
const { createGeoDiscoveryEngine } = require('../discovery_engine');
const { createGeoVerticalFilterProvider } = require('./vertical_filter_provider');

describe('GDE-03A stable → boarding adapter', () => {
  it('maps stable service to boarding ServicePlace', () => {
    const payload = stableServiceToPlacePayload({
      id: 'svc1',
      type: 'stable',
      name: 'مربط الاختبار',
      providerId: 'p1',
      latitude: 24.71,
      longitude: 46.67,
      availableSpaces: 5,
      totalSpaces: 10,
      pricePerDay: 100,
      verified: true,
      applicableSpecies: ['horse'],
    });
    assert.ok(payload);
    assert.equal(payload.categories[0], 'boarding');
    assert.equal(payload.vertical.kind, 'boarding');
    assert.equal(payload.sourceServiceId, 'svc1');
  });

  it('syncs into store and discover finds boarding places', () => {
    const store = { services: new Map(), servicePlaces: new Map() };
    store.services.set('svc1', {
      id: 'svc1',
      type: 'stable',
      name: 'A',
      providerId: 'p1',
      latitude: 24.7136,
      longitude: 46.6753,
      availableSpaces: 3,
      pricePerDay: 80,
      verified: true,
      applicableSpecies: ['horse'],
    });
    const { synced } = syncAllStableServices(store);
    assert.equal(synced, 1);

    const engine = createGeoDiscoveryEngine({
      filterProvider: createGeoVerticalFilterProvider(),
    });
    const result = engine.discover(store, {
      bbox: { sw: [24.68, 46.64], ne: [24.75, 46.72] },
      zoom: 14,
      category: 'boarding',
      mode: 'places',
      filters: { verifiedOnly: true },
      verticalFilters: { minSpaces: 2 },
      limit: 40,
    });
    assert.equal(result.ok, true);
    assert.equal(result.response.items.length, 1);
    assert.equal(result.response.items[0].vertical.kind, 'boarding');
  });

  it('boardingVerticalMatches rejects low capacity', () => {
    const place = {
      vertical: { kind: 'boarding', availableSpaces: 1, pricePerDay: 50 },
    };
    assert.equal(boardingVerticalMatches(place, { minSpaces: 3 }), false);
    assert.equal(boardingVerticalMatches(place, { minSpaces: 1 }), true);
  });
});
