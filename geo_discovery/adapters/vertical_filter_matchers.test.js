/**
 * Vertical filter matchers — category-specific AND semantics.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  feedVerticalMatches,
  equipmentVerticalMatches,
  trainingVerticalMatches,
  veterinaryVerticalMatches,
} = require('./vertical_filter_matchers');
const { createGeoVerticalFilterProvider } = require('./vertical_filter_provider');
const { catalogItemToPlacePayload } = require('./catalog_place_adapter');

test('feed: برسيم matches catalog place; شعير does not', () => {
  const place = catalogItemToPlacePayload({
    id: 'f1',
    category: 'feed',
    name: 'برسيم فاخر',
    subCategory: 'برسيم',
    price: 80,
    location: { lat: 24.7, lng: 46.7 },
    inStock: true,
  });
  assert.equal(feedVerticalMatches(place, { subCategory: 'برسيم' }), true);
  assert.equal(feedVerticalMatches(place, { subCategory: 'شعير' }), false);
  assert.equal(
    feedVerticalMatches(place, {
      subCategory: 'برسيم',
      delivery: true,
      maxPrice: 100,
    }),
    true,
  );
  assert.equal(
    feedVerticalMatches(place, {
      subCategory: 'برسيم',
      maxPrice: 50,
    }),
    false,
  );
});

test('equipment: subCategory filter', () => {
  const place = catalogItemToPlacePayload({
    id: 'e1',
    category: 'equipment',
    name: 'مقطورة',
    subCategory: 'مقطورة خيل',
    price: 500,
    location: { lat: 24.7, lng: 46.7 },
  });
  assert.equal(
    equipmentVerticalMatches(place, { subCategory: 'مقطورة خيل' }),
    true,
  );
  assert.equal(
    equipmentVerticalMatches(place, { subCategory: 'مولد كهرباء' }),
    false,
  );
});

test('training: maxPricePerSession', () => {
  const place = {
    categories: ['training'],
    vertical: { kind: 'training', pricePerSession: 150 },
  };
  assert.equal(
    trainingVerticalMatches(place, { maxPricePerSession: 200 }),
    true,
  );
  assert.equal(
    trainingVerticalMatches(place, { maxPricePerSession: 100 }),
    false,
  );
});

test('veterinary: specialty + homeVisit', () => {
  const place = {
    categories: ['veterinary'],
    vertical: {
      kind: 'veterinary',
      specialties: ['جراحة', 'فحص'],
      homeVisit: true,
      pricePerVisit: 120,
    },
  };
  assert.equal(veterinaryVerticalMatches(place, { specialty: 'جراحة' }), true);
  assert.equal(veterinaryVerticalMatches(place, { specialty: 'تطعيم' }), false);
  assert.equal(veterinaryVerticalMatches(place, { homeVisit: true }), true);
  assert.equal(
    veterinaryVerticalMatches(place, { maxConsultationFee: 100 }),
    false,
  );
  assert.equal(
    veterinaryVerticalMatches(place, { maxConsultationFee: 150 }),
    true,
  );
});

test('provider applies feed vertical through single engine', () => {
  const provider = createGeoVerticalFilterProvider();
  const place = catalogItemToPlacePayload({
    id: 'f2',
    category: 'feed',
    name: 'تبن',
    subCategory: 'تبن',
    price: 40,
    location: { lat: 24.7, lng: 46.7 },
    verified: true,
  });
  assert.equal(
    provider.matches(place, {
      category: 'feed',
      filters: {},
      verticalFilters: { subCategory: 'تبن' },
    }),
    true,
  );
  assert.equal(
    provider.matches(place, {
      category: 'feed',
      filters: {},
      verticalFilters: { subCategory: 'برسيم' },
    }),
    false,
  );
});
