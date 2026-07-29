/**
 * Smoke tests: catalog → place + rebuild helpers.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  catalogItemToPlacePayload,
  syncCatalogItemToPlaces,
  syncAllCatalogItems,
} = require('./catalog_place_adapter');
const {
  syncAllStableServices,
} = require('./stable_place_adapter');
const {
  syncAllCategorizedServices,
} = require('./vertical_place_adapter');

test('catalog feed item with coords becomes feed place', () => {
  const item = {
    id: 'c1',
    category: 'feed',
    name: 'شعير',
    sellerId: 'u1',
    applicableSpecies: ['horse'],
    location: { lat: 24.7, lng: 46.7, city: 'الرياض' },
    images: ['https://x/y.png'],
    price: 100,
    status: 'active',
  };
  const payload = catalogItemToPlacePayload(item);
  assert.ok(payload);
  assert.equal(payload.categories[0], 'feed');
  assert.equal(payload.id, 'place_feed_catalog_c1');
});

test('catalog without coords is skipped', () => {
  const payload = catalogItemToPlacePayload({
    id: 'c2',
    category: 'equipment',
    name: 'مقطورة',
    location: { city: 'جدة' },
  });
  assert.equal(payload, null);
});

test('rebuild syncs stable + veterinary + catalog', () => {
  const store = {
    services: new Map([
      [
        's1',
        {
          id: 's1',
          type: 'stable',
          name: 'إسطبل',
          latitude: 24.82,
          longitude: 46.87,
          applicableSpecies: ['horse'],
          availableSpaces: 10,
        },
      ],
      [
        's2',
        {
          id: 's2',
          type: 'veterinary',
          name: 'عيادة',
          latitude: 24.71,
          longitude: 46.67,
          applicableSpecies: ['horse', 'camel'],
        },
      ],
      [
        's3',
        {
          id: 's3',
          type: 'training',
          name: 'تدريب',
          latitude: 24.75,
          longitude: 46.7,
          applicableSpecies: ['horse'],
        },
      ],
    ]),
    catalogItems: new Map([
      [
        'c1',
        {
          id: 'c1',
          category: 'feed',
          name: 'علف',
          sellerId: 'u1',
          location: { lat: 24.8, lng: 46.8 },
          applicableSpecies: ['horse'],
          status: 'active',
        },
      ],
    ]),
    servicePlaces: new Map(),
  };

  const a = syncAllStableServices(store);
  const b = syncAllCategorizedServices(store);
  const c = syncAllCatalogItems(store);
  assert.equal(a.synced, 1);
  assert.equal(b.synced, 2);
  assert.equal(c.synced, 1);
  assert.equal(store.servicePlaces.size, 4);
});
