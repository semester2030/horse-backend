/**
 * GDE-02 — Geo Discovery HTTP routes (API contracts).
 */
'use strict';

const { createGeoDiscoveryEngine } = require('./discovery_engine');
const { createGeoVerticalFilterProvider } = require('./adapters/vertical_filter_provider');
const {
  syncStableServiceToPlaces,
  syncAllStableServices,
} = require('./adapters/stable_place_adapter');
const {
  syncServiceToPlaces,
  syncAllCategorizedServices,
} = require('./adapters/vertical_place_adapter');
const {
  syncCatalogItemToPlaces,
  syncAllCatalogItems,
  removeCatalogItemPlace,
} = require('./adapters/catalog_place_adapter');
const { removePlacesForServiceId } = require('./query_engine');
const { healMissingServicePlaces } = require('./heal_service_places');

function registerGeoDiscoveryRoutes(app, ctx) {
  const { store, saveStore, id, auth, requireSessionUser } = ctx;
  const engine =
    ctx.geoDiscoveryEngine ||
    createGeoDiscoveryEngine({
      filterProvider: createGeoVerticalFilterProvider(),
    });

  engine.ensureStore(store);

  function bumpCache() {
    if (engine.providers && engine.providers.cache) {
      engine.providers.cache.bumpGeneration();
    }
  }

  function syncAnyService(service) {
    const a = syncStableServiceToPlaces(store, service);
    if (a.ok) return a;
    return syncServiceToPlaces(store, service);
  }

  /** Rebuild full geo index from services + catalog (boot / repair). */
  function rebuildGeoIndex() {
    const boarding = syncAllStableServices(store);
    const other = syncAllCategorizedServices(store);
    const catalog = syncAllCatalogItems(store);
    bumpCache();
    return {
      ok: true,
      boarding: boarding.synced,
      other: other.synced,
      catalog: catalog.synced,
      places: store.servicePlaces ? store.servicePlaces.size : 0,
    };
  }

  function healThenDiscover(body) {
    const heal = healMissingServicePlaces(store, syncAnyService);
    if (heal.healed > 0) {
      bumpCache();
      try {
        saveStore();
      } catch (_) {
        /* persist best-effort */
      }
      console.log(`[geo] healed ${heal.healed}/${heal.checked} missing places`);
    }
    return engine.discover(store, body || {});
  }

  // Lightweight metrics for GDE-09 observability
  app.use('/geo', (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      if (!store.apiMetrics) store.apiMetrics = { routes: {}, recent: [] };
      const key = `${req.method} ${req.path}`;
      const bucket = store.apiMetrics.routes[key] || { count: 0, totalMs: 0 };
      bucket.count += 1;
      bucket.totalMs += ms;
      store.apiMetrics.routes[key] = bucket;
      store.apiMetrics.recent.push({
        at: new Date().toISOString(),
        key,
        ms,
        status: res.statusCode,
      });
      if (store.apiMetrics.recent.length > 200) {
        store.apiMetrics.recent = store.apiMetrics.recent.slice(-200);
      }
    });
    next();
  });

  function canonicalizeMapSpecies(raw) {
    const allow = new Set(['horse', 'camel', 'falcon']);
    const list = [];
    const src = Array.isArray(raw)
      ? raw
      : raw != null && String(raw).trim()
        ? [raw]
        : [];
    for (const item of src) {
      const s = String(item).trim().toLowerCase();
      if (s === 'all') {
        for (const c of allow) {
          if (!list.includes(c)) list.push(c);
        }
        continue;
      }
      if (allow.has(s) && !list.includes(s)) list.push(s);
    }
    return list;
  }

  /** Fail-closed: discover/clusters require ≥1 canonical species. Empty ≠ all. */
  function requireCanonicalSpeciesOrEmptyResult(body) {
    const filters =
      body && typeof body.filters === 'object' && body.filters
        ? { ...body.filters }
        : {};
    const species = canonicalizeMapSpecies(filters.species);
    if (species.length === 0) {
      return {
        ok: true,
        emptyBecauseNoSpecies: true,
        response: {
          mode: 'places',
          places: [],
          clusters: [],
          totalMatched: 0,
          meta: { speciesRequired: true, reason: 'missing_or_invalid_species' },
        },
      };
    }
    filters.species = species;
    return {
      ok: true,
      emptyBecauseNoSpecies: false,
      body: { ...(body || {}), filters },
    };
  }

  // Discover — viewport + filters + limit + cursor (server-authoritative)
  app.post('/geo/discover', (req, res) => {
    const gated = requireCanonicalSpeciesOrEmptyResult(req.body || {});
    if (gated.emptyBecauseNoSpecies) {
      res.setHeader('X-GDE-Species', 'REQUIRED');
      return res.json(gated.response);
    }
    const result = healThenDiscover(gated.body);
    if (!result.ok) {
      return res.status(result.status || 400).json({ message: result.message });
    }
    if (result.cached) res.setHeader('X-GDE-Cache', 'HIT');
    else res.setHeader('X-GDE-Cache', 'MISS');
    return res.json(result.response);
  });

  // Clusters — explicit cluster mode
  app.post('/geo/clusters', (req, res) => {
    const gated = requireCanonicalSpeciesOrEmptyResult(req.body || {});
    if (gated.emptyBecauseNoSpecies) {
      res.setHeader('X-GDE-Species', 'REQUIRED');
      return res.json(gated.response);
    }
    const heal = healMissingServicePlaces(store, syncAnyService);
    if (heal.healed > 0) {
      bumpCache();
      try {
        saveStore();
      } catch (_) {
        /* ignore */
      }
    }
    const result = engine.clustersOnly(store, gated.body);
    if (!result.ok) {
      return res.status(result.status || 400).json({ message: result.message });
    }
    if (result.cached) res.setHeader('X-GDE-Cache', 'HIT');
    else res.setHeader('X-GDE-Cache', 'MISS');
    return res.json(result.response);
  });

  // Place details (discovery payload — not booking)
  app.get('/geo/places/:id', (req, res) => {
    const result = engine.placeDetails(store, req.params.id);
    if (!result.ok) {
      return res.status(result.status || 404).json({ message: result.message });
    }
    return res.json({ place: result.place });
  });

  // Categories + shared filter keys
  app.get('/geo/categories', (_req, res) => {
    res.json(engine.listCategories());
  });

  // GDE-09 — geo metrics snapshot (auth)
  app.get('/geo/metrics', auth, requireSessionUser, (_req, res) => {
    const routes = (store.apiMetrics && store.apiMetrics.routes) || {};
    const geoRoutes = {};
    for (const [k, v] of Object.entries(routes)) {
      if (k.includes('/geo')) {
        geoRoutes[k] = {
          count: v.count,
          avgMs: v.count ? Math.round(v.totalMs / v.count) : 0,
        };
      }
    }
    res.json({
      ok: true,
      cache: engine.providers.cache.stats(),
      routes: geoRoutes,
      recent: ((store.apiMetrics && store.apiMetrics.recent) || [])
        .filter((r) => String(r.key).includes('/geo'))
        .slice(-50),
    });
  });

  // Sync stable services → boarding ServicePlaces (GDE-03A)
  app.post('/geo/sync/stable', auth, requireSessionUser, (req, res) => {
    const out = syncAllStableServices(store);
    bumpCache();
    saveStore();
    res.json({ ok: true, ...out });
  });

  // Sync all verticals (training/vet/feed/equipment + stable + catalog)
  app.post('/geo/sync/all', auth, requireSessionUser, (req, res) => {
    const out = rebuildGeoIndex();
    saveStore();
    res.json(out);
  });

  // Admin/dev upsert for Core indexing (authenticated). No vertical fields required.
  app.put('/geo/places/:id', auth, requireSessionUser, (req, res) => {
    const body = { ...(req.body || {}), id: req.params.id };
    const result = engine.upsertPlace(store, body, id);
    if (!result.ok) {
      return res.status(result.status || 400).json({ message: result.message });
    }
    saveStore();
    return res.json({ place: result.place });
  });

  app.post('/geo/places', auth, requireSessionUser, (req, res) => {
    const result = engine.upsertPlace(store, req.body || {}, id);
    if (!result.ok) {
      return res.status(result.status || 400).json({ message: result.message });
    }
    saveStore();
    return res.status(201).json({ place: result.place });
  });

  return {
    engine,
    syncStableServiceToPlaces: syncAnyService,
    syncAllStableServices,
    syncAllCategorizedServices,
    syncCatalogItemToPlaces,
    syncAllCatalogItems,
    removeCatalogItemPlace,
    removePlacesForServiceId: (serviceId) =>
      removePlacesForServiceId(store, serviceId),
    rebuildGeoIndex,
    bumpCache,
  };
}

module.exports = { registerGeoDiscoveryRoutes };
