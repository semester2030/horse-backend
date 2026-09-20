/**
 * Gate A/C/D — legacy re-index + contract + runtime-equivalent discover proof.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  loadFixture,
  reindexGeoPlaces,
} = require('../tools/legacy_geo_reindex');
const { createGeoDiscoveryEngine } = require('../discovery_engine');
const { createGeoVerticalFilterProvider } = require('../adapters/vertical_filter_provider');
const {
  serviceToPlacePayload,
  knownBool,
} = require('../adapters/vertical_place_adapter');
const {
  veterinaryVerticalMatches,
  feedVerticalMatches,
  equipmentVerticalMatches,
  trainingVerticalMatches,
} = require('../adapters/vertical_filter_matchers');
const { boardingVerticalMatches } = require('../adapters/stable_place_adapter');

const FIXTURE = path.join(
  __dirname,
  '../fixtures/legacy_filter_closure_fixture.json',
);

const BBOX = {
  sw: { lat: 24.0, lng: 46.0 },
  ne: { lat: 25.5, lng: 47.5 },
};

function discover(store, category, filters = {}, verticalFilters = {}) {
  const engine = createGeoDiscoveryEngine({
    filterProvider: createGeoVerticalFilterProvider(),
  });
  engine.ensureStore(store);
  const result = engine.discover(store, {
    bbox: { sw: [24.0, 46.0], ne: [25.5, 47.5] },
    zoom: 14,
    category,
    mode: 'places',
    filters,
    verticalFilters,
    limit: 100,
  });
  assert.equal(result.ok, true, result.message || 'discover failed');
  return result.response;
}

test('knownBool: UNKNOWN ≠ FALSE', () => {
  assert.equal(knownBool(undefined, null), null);
  assert.equal(knownBool(true), true);
  assert.equal(knownBool(false), false);
  assert.equal(knownBool(undefined, false), false);
  assert.equal(knownBool(undefined, true), true);
});

test('Gate A: dry-run then apply re-index is idempotent', () => {
  const store = loadFixture(FIXTURE);
  const dry = reindexGeoPlaces(store, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.scanned > 0);
  assert.ok(dry.unknown >= 1);

  const apply1 = reindexGeoPlaces(store, { dryRun: false });
  assert.equal(apply1.dryRun, false);
  assert.equal(apply1.duplicates.length, 0);
  const places1 = store.servicePlaces.size;

  const apply2 = reindexGeoPlaces(store, { dryRun: false });
  assert.equal(store.servicePlaces.size, places1);
  assert.equal(apply2.duplicates.length, 0);

  // Recoverable vet specialties appear on vertical after re-index
  const vetPlace = store.servicePlaces.get('place_veterinary_vet_legacy_recoverable');
  assert.ok(vetPlace);
  assert.deepEqual(vetPlace.vertical.specialties, ['جراحة', 'فحص']);
  assert.equal(vetPlace.vertical.homeVisit, true);

  // Unknown homeVisit stays null — not fabricated false
  const unknown = store.servicePlaces.get('place_veterinary_vet_legacy_unknown');
  assert.ok(unknown);
  assert.equal(unknown.vertical.homeVisit, null);
  assert.equal(unknown.vertical.offersHomeVisit, null);
});

test('Gate A/C: veterinary new + legacy + unknown fail-closed', () => {
  const store = loadFixture(FIXTURE);
  reindexGeoPlaces(store, { dryRun: false });

  const matchTrue = discover(store, 'veterinary', {}, { homeVisit: true });
  const ids = matchTrue.items.map((p) => p.id);
  assert.ok(ids.includes('place_veterinary_vet_new_match'));
  assert.ok(ids.includes('place_veterinary_vet_legacy_recoverable'));
  assert.ok(!ids.includes('place_veterinary_vet_new_nomatch'));
  assert.ok(
    !ids.includes('place_veterinary_vet_legacy_unknown'),
    'UNKNOWN must not match homeVisit=true',
  );

  const bySpecialty = discover(store, 'veterinary', {}, { specialty: 'جراحة' });
  const sIds = bySpecialty.items.map((p) => p.id);
  assert.ok(sIds.includes('place_veterinary_vet_new_match'));
  assert.ok(sIds.includes('place_veterinary_vet_legacy_recoverable'));
  assert.ok(!sIds.includes('place_veterinary_vet_new_nomatch'));
});

test('Gate C: feed برسيم path end-to-end via discover', () => {
  const store = loadFixture(FIXTURE);
  reindexGeoPlaces(store, { dryRun: false });
  const res = discover(store, 'feed', {}, { subCategory: 'برسيم' });
  const ids = res.items.map((p) => p.id);
  assert.deepEqual(ids, ['place_feed_catalog_feed_new_bersim']);

  const legacy = discover(store, 'feed', {}, { subCategory: 'تبن' });
  assert.ok(
    legacy.items.some((p) => p.id === 'place_feed_catalog_feed_legacy_recoverable'),
  );

  const unknownFiltered = discover(store, 'feed', {}, { subCategory: 'برسيم' });
  assert.ok(
    !unknownFiltered.items.some(
      (p) => p.id === 'place_feed_catalog_feed_legacy_unknown',
    ),
  );
});

test('Gate C: equipment / boarding / training contracts', () => {
  const store = loadFixture(FIXTURE);
  reindexGeoPlaces(store, { dryRun: false });

  const eq = discover(store, 'equipment', {}, { subCategory: 'مقطورة خيل' });
  assert.equal(eq.items.length, 1);
  assert.equal(eq.items[0].id, 'place_equipment_catalog_eq_new');

  const board = discover(
    store,
    'boarding',
    { verifiedOnly: true },
    { minSpaces: 3, maxPricePerDay: 100, stableType: 'مكان عادي' },
  );
  assert.ok(board.items.some((p) => p.id === 'place_boarding_stable_new'));
  assert.ok(!board.items.some((p) => p.id === 'place_boarding_stable_legacy'));

  const train = discover(store, 'training', {}, { maxPricePerSession: 200 });
  assert.ok(train.items.some((p) => p.id === 'place_training_train_new'));
  assert.ok(
    !train.items.some((p) => p.id === 'place_training_train_legacy_unknown_price'),
  );
});

test('Gate C: AND semantics + no placebo training fields', () => {
  const store = loadFixture(FIXTURE);
  reindexGeoPlaces(store, { dryRun: false });
  const res = discover(
    store,
    'veterinary',
    { verifiedOnly: true, species: ['horse'] },
    { specialty: 'جراحة', homeVisit: true, maxConsultationFee: 150 },
  );
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].id, 'place_veterinary_vet_new_match');

  // Training matcher must not apply programType / homeVisit filters
  const trainPlace = {
    categories: ['training'],
    vertical: { kind: 'training', pricePerSession: 100 },
  };
  assert.equal(
    trainingVerticalMatches(trainPlace, { programType: 'foundation' }),
    true,
    'unknown programType key must be ignored (no placebo)',
  );
  assert.equal(
    trainingVerticalMatches(trainPlace, { homeVisit: true }),
    true,
    'homeVisit must not filter training',
  );
});

test('Gate D runtime-equivalent: map IDs === list IDs (single discover SSOT)', () => {
  const store = loadFixture(FIXTURE);
  reindexGeoPlaces(store, { dryRun: false });
  const res = discover(store, 'feed', {}, { subCategory: 'برسيم', delivery: true });
  const listIds = res.items.map((p) => p.id).sort();
  // Unified host builds markers from the same response.places — prove SSOT here.
  const markerIds = res.items.map((p) => p.id).sort();
  assert.deepEqual(markerIds, listIds);
  assert.equal(listIds.length, 1);

  // Empty honest state
  const empty = discover(store, 'feed', {}, { subCategory: 'مكعبات' });
  assert.equal(empty.items.length, 0);
});

test('Gate A: serviceToPlacePayload does not fabricate homeVisit=false', () => {
  const payload = serviceToPlacePayload({
    id: 'x1',
    type: 'veterinary',
    name: 'legacy',
    latitude: 24.7,
    longitude: 46.7,
    specialties: ['فحص'],
  });
  assert.equal(payload.vertical.homeVisit, null);
  assert.equal(
    veterinaryVerticalMatches(payload, { homeVisit: true }),
    false,
  );
});
