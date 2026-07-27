'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createGeoDiscoveryEngine,
  createGeohashGeoIndexProvider,
  createCacheLayer,
  constants,
} = require('./index');

function emptyStore() {
  return { servicePlaces: new Map() };
}

function seedRiyadh(store, engine) {
  const samples = [
    {
      id: 'place_a',
      providerId: 'prov1',
      displayName: 'Place A',
      categories: ['boarding'],
      location: { lat: 24.7136, lng: 46.6753, address: 'Riyadh' },
      verified: true,
      rating: 4.8,
      reviewCount: 100,
      availability: 'open_now',
      labels: { species: ['horse'] },
      offeringsSummary: [{ type: 'boarding', title: 'Generic offering' }],
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'place_b',
      providerId: 'prov2',
      displayName: 'Place B',
      categories: ['training'],
      location: { lat: 24.72, lng: 46.68 },
      verified: false,
      rating: 4.0,
      reviewCount: 10,
      availability: 'unknown',
      labels: { species: ['camel'] },
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'place_c',
      providerId: 'prov3',
      displayName: 'Place C Far',
      categories: ['boarding'],
      location: { lat: 21.3891, lng: 39.8579 }, // Jeddah — outside Riyadh bbox
      verified: true,
      rating: 5,
      reviewCount: 200,
      availability: 'open_now',
      labels: { species: ['horse'] },
      updatedAt: new Date().toISOString(),
    },
  ];
  for (const s of samples) {
    const r = engine.upsertPlace(store, s);
    assert.equal(r.ok, true);
  }
}

describe('GDE-02 Geo Discovery Core', () => {
  it('rejects discover without bbox', () => {
    const engine = createGeoDiscoveryEngine();
    const store = emptyStore();
    const result = engine.discover(store, { zoom: 12, limit: 40 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });

  it('never returns places outside viewport', () => {
    const engine = createGeoDiscoveryEngine();
    const store = emptyStore();
    seedRiyadh(store, engine);

    const result = engine.discover(store, {
      bbox: { sw: [24.68, 46.64], ne: [24.75, 46.72] },
      zoom: 14,
      limit: 40,
    });
    assert.equal(result.ok, true);
    assert.equal(result.response.mode, 'places');
    const ids = result.response.items.map((i) => i.id);
    assert.ok(ids.includes('place_a'));
    assert.ok(ids.includes('place_b'));
    assert.ok(!ids.includes('place_c'));
  });

  it('requires filters + limit + cursor contract fields on response', () => {
    const engine = createGeoDiscoveryEngine();
    const store = emptyStore();
    seedRiyadh(store, engine);
    const result = engine.discover(store, {
      bbox: { sw: [24.68, 46.64], ne: [24.75, 46.72] },
      zoom: 14,
      category: 'boarding',
      filters: { verifiedOnly: true, species: ['horse'] },
      limit: 25,
      cursor: null,
    });
    assert.equal(result.ok, true);
    const r = result.response;
    assert.ok(r.generatedAt);
    assert.equal(r.mode, 'places');
    assert.equal(r.limit, 25);
    assert.ok('nextCursor' in r);
    assert.equal(r.rankingVersion, constants.RANKING_VERSION);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].id, 'place_a');
  });

  it('caps page size at MAX_PAGE_LIMIT', () => {
    const engine = createGeoDiscoveryEngine();
    const store = emptyStore();
    seedRiyadh(store, engine);
    const result = engine.discover(store, {
      bbox: { sw: [24.68, 46.64], ne: [24.75, 46.72] },
      zoom: 14,
      limit: 500,
    });
    assert.equal(result.ok, true);
    assert.equal(result.response.limit, constants.MAX_PAGE_LIMIT);
  });

  it('returns clusters at low zoom', () => {
    const engine = createGeoDiscoveryEngine();
    const store = emptyStore();
    seedRiyadh(store, engine);
    const result = engine.discover(store, {
      bbox: { sw: [24.0, 46.0], ne: [25.0, 47.0] },
      zoom: 10,
      mode: 'auto',
    });
    assert.equal(result.ok, true);
    assert.equal(result.response.mode, 'clusters');
    assert.ok(Array.isArray(result.response.items));
    assert.ok(result.response.items.length >= 1);
    assert.ok(result.response.items[0].count >= 1);
    assert.ok(result.response.items[0].center);
  });

  it('paginates with cursor', () => {
    const engine = createGeoDiscoveryEngine();
    const store = emptyStore();
    seedRiyadh(store, engine);
    // Add more places in bbox
    for (let i = 0; i < 5; i++) {
      engine.upsertPlace(store, {
        id: `p_${i}`,
        providerId: 'p',
        displayName: `P${i}`,
        categories: ['feed'],
        location: { lat: 24.71 + i * 0.001, lng: 46.67 + i * 0.001 },
        verified: true,
        rating: 3 + i * 0.2,
        reviewCount: i,
        availability: 'open_now',
      });
    }
    const first = engine.discover(store, {
      bbox: { sw: [24.68, 46.64], ne: [24.75, 46.72] },
      zoom: 14,
      limit: 2,
      mode: 'places',
    });
    assert.equal(first.ok, true);
    assert.equal(first.response.items.length, 2);
    assert.ok(first.response.nextCursor);

    const second = engine.discover(store, {
      bbox: { sw: [24.68, 46.64], ne: [24.75, 46.72] },
      zoom: 14,
      limit: 2,
      mode: 'places',
      cursor: first.response.nextCursor,
    });
    assert.equal(second.ok, true);
    assert.equal(second.response.items.length, 2);
    assert.notEqual(
      first.response.items[0].id,
      second.response.items[0].id,
    );
  });

  it('cache hits identical queries', () => {
    const cache = createCacheLayer({ queryTtlMs: 60_000 });
    const engine = createGeoDiscoveryEngine({ cache });
    const store = emptyStore();
    seedRiyadh(store, engine);
    const body = {
      bbox: { sw: [24.68, 46.64], ne: [24.75, 46.72] },
      zoom: 14,
      limit: 40,
      mode: 'places',
    };
    const a = engine.discover(store, body);
    const b = engine.discover(store, body);
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
  });

  it('GeoIndexProvider is pluggable by id', () => {
    const geoIndex = createGeohashGeoIndexProvider({ id: 'geohash-test' });
    const engine = createGeoDiscoveryEngine({ geoIndex });
    const cats = engine.listCategories();
    assert.equal(cats.providers.geoIndex, 'geohash-test');
  });

  it('place details returns ServicePlace only', () => {
    const engine = createGeoDiscoveryEngine();
    const store = emptyStore();
    seedRiyadh(store, engine);
    const result = engine.placeDetails(store, 'place_a');
    assert.equal(result.ok, true);
    assert.equal(result.place.id, 'place_a');
    assert.ok(result.place.location.lat);
    assert.ok(!('transportRequestId' in result.place));
  });
});
