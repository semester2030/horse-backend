/**
 * Safe local/test geo re-index for legacy Place.vertical refresh.
 * Uses existing sync adapters only — no parallel indexer.
 *
 * Usage:
 *   node geo_discovery/tools/legacy_geo_reindex.js --dry-run --fixture path.json
 *   node geo_discovery/tools/legacy_geo_reindex.js --apply --fixture path.json
 *
 * Never run against production from this module.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  syncStableServiceToPlaces,
  syncAllStableServices,
  stableServiceToPlacePayload,
} = require('../adapters/stable_place_adapter');
const {
  syncServiceToPlaces,
  syncAllCategorizedServices,
  serviceToPlacePayload,
} = require('../adapters/vertical_place_adapter');
const {
  syncCatalogItemToPlaces,
  syncAllCatalogItems,
  catalogItemToPlacePayload,
} = require('../adapters/catalog_place_adapter');
const { ensureServicePlaces } = require('../query_engine');

function emptyStore() {
  return {
    services: new Map(),
    catalogItems: new Map(),
    servicePlaces: new Map(),
  };
}

function loadFixture(fixturePath) {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const store = emptyStore();
  for (const s of raw.services || []) {
    store.services.set(String(s.id), s);
  }
  for (const c of raw.catalogItems || []) {
    store.catalogItems.set(String(c.id), c);
  }
  for (const p of raw.servicePlaces || []) {
    store.servicePlaces.set(String(p.id), p);
  }
  return store;
}

function classifyUnknowns(store) {
  const unknown = [];
  for (const service of store.services.values()) {
    const t = String(service.type || '').toLowerCase();
    if (t === 'veterinary' || t === 'vet') {
      const hasHV =
        service.homeVisit != null ||
        service.offersHomeVisit != null ||
        service.homeVisitOnly != null;
      const specs = Array.isArray(service.specialties) ? service.specialties : [];
      if (!hasHV) {
        unknown.push({
          id: service.id,
          category: 'veterinary',
          field: 'offersHomeVisit',
          reason: 'source_never_stored',
        });
      }
      if (specs.length === 0) {
        unknown.push({
          id: service.id,
          category: 'veterinary',
          field: 'specialties',
          reason: 'source_never_stored',
        });
      }
    }
    if (t === 'training' || t === 'trainer') {
      if (service.pricePerSession == null && service.price == null) {
        unknown.push({
          id: service.id,
          category: 'training',
          field: 'pricePerSession',
          reason: 'source_never_stored',
        });
      }
    }
  }
  for (const item of store.catalogItems.values()) {
    const cat = String(item.category || '').toLowerCase();
    if ((cat === 'feed' || cat === 'equipment') && !item.subCategory) {
      unknown.push({
        id: item.id,
        category: cat,
        field: 'subCategory',
        reason: 'source_never_stored',
      });
    }
  }
  return unknown;
}

function plannedPayloads(store) {
  const plans = [];
  for (const service of store.services.values()) {
    const boarding = stableServiceToPlacePayload(service);
    if (boarding) {
      plans.push({ kind: 'boarding', sourceId: service.id, payload: boarding });
      continue;
    }
    const vertical = serviceToPlacePayload(service);
    if (vertical) {
      plans.push({
        kind: vertical.categories[0],
        sourceId: service.id,
        payload: vertical,
      });
    }
  }
  for (const item of store.catalogItems.values()) {
    const payload = catalogItemToPlacePayload(item);
    if (payload) {
      plans.push({
        kind: payload.categories[0],
        sourceId: item.id,
        payload,
      });
    }
  }
  return plans;
}

function diffPlace(existing, next) {
  if (!existing) return 'new';
  const a = JSON.stringify(existing.vertical || {});
  const b = JSON.stringify(next.vertical || {});
  if (a === b && existing.displayName === next.displayName) return 'unchanged';
  return 'changed';
}

/**
 * @param {object} store
 * @param {{ dryRun?: boolean }} opts
 */
function reindexGeoPlaces(store, opts = {}) {
  const dryRun = opts.dryRun !== false; // default dry-run safe
  ensureServicePlaces(store);

  const beforeSize = store.servicePlaces.size;
  const plans = plannedPayloads(store);
  const unknown = classifyUnknowns(store);

  let scanned = plans.length;
  let changed = 0;
  let unchanged = 0;
  let created = 0;
  const details = [];

  for (const plan of plans) {
    const existing = store.servicePlaces.get(plan.payload.id);
    const status = diffPlace(existing, plan.payload);
    details.push({
      id: plan.payload.id,
      kind: plan.kind,
      sourceId: plan.sourceId,
      status,
    });
    if (status === 'new') created += 1;
    else if (status === 'changed') changed += 1;
    else unchanged += 1;
  }

  let afterSize = beforeSize;
  if (!dryRun) {
    const boarding = syncAllStableServices(store);
    const other = syncAllCategorizedServices(store);
    const catalog = syncAllCatalogItems(store);
    afterSize = store.servicePlaces.size;
    return {
      ok: true,
      dryRun: false,
      scanned,
      created,
      changed,
      unchanged,
      unknown: unknown.length,
      unknownDetails: unknown,
      placesBefore: beforeSize,
      placesAfter: afterSize,
      synced: {
        boarding: boarding.synced,
        other: other.synced,
        catalog: catalog.synced,
      },
      details,
      duplicates: detectDuplicatePlaceIds(store),
    };
  }

  return {
    ok: true,
    dryRun: true,
    scanned,
    created,
    changed,
    unchanged,
    unknown: unknown.length,
    unknownDetails: unknown,
    placesBefore: beforeSize,
    placesAfter: beforeSize + created, // projected
    details,
    duplicates: detectDuplicatePlaceIds(store),
  };
}

function detectDuplicatePlaceIds(store) {
  const seen = new Set();
  const dups = [];
  for (const id of store.servicePlaces.keys()) {
    if (seen.has(id)) dups.push(id);
    seen.add(id);
  }
  // Map keys are unique by definition; also check source collisions
  const bySource = new Map();
  for (const p of store.servicePlaces.values()) {
    const sid = String(p.sourceServiceId || p.sourceCatalogItemId || '');
    if (!sid) continue;
    if (!bySource.has(sid)) bySource.set(sid, []);
    bySource.get(sid).push(p.id);
  }
  for (const [sid, ids] of bySource) {
    if (ids.length > 1) dups.push({ source: sid, placeIds: ids });
  }
  return dups;
}

function runCli(argv = process.argv.slice(2)) {
  const dryRun = !argv.includes('--apply');
  const fixIdx = argv.indexOf('--fixture');
  if (fixIdx < 0 || !argv[fixIdx + 1]) {
    console.error('Usage: --fixture <path.json> [--dry-run|--apply]');
    process.exit(2);
  }
  const fixturePath = path.resolve(argv[fixIdx + 1]);
  const store = loadFixture(fixturePath);
  const result = reindexGeoPlaces(store, { dryRun });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

module.exports = {
  emptyStore,
  loadFixture,
  reindexGeoPlaces,
  classifyUnknowns,
  plannedPayloads,
  detectDuplicatePlaceIds,
  runCli,
};

if (require.main === module) {
  runCli();
}
