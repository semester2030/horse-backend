/**
 * GDE-02 — Geo Discovery Core Engine (orchestrator).
 * Generic only: no Boarding / Training / Veterinary / Feed / Equipment / Transport / Marketplace logic.
 */
'use strict';

const { CORE_CATEGORIES, RANKING_VERSION } = require('./constants');
const { toDiscoveryCard } = require('./models');
const { createGeohashGeoIndexProvider } = require('./geo_index_provider');
const { createCoreFilterProvider, applyFilters } = require('./filter_engine');
const { createDefaultRankingProvider } = require('./ranking_provider');
const { createCacheLayer } = require('./cache_layer');
const {
  normalizeViewportRequest,
  encodeCursor,
  decodeCursor,
} = require('./viewport_engine');
const { buildClusters, resolveRenderMode } = require('./cluster_engine');
const {
  ensureServicePlaces,
  queryPlacesInViewport,
  getPlaceById,
  upsertServicePlace,
} = require('./query_engine');

function createGeoDiscoveryEngine(opts = {}) {
  const geoIndex = opts.geoIndex || createGeohashGeoIndexProvider();
  const filterProvider = opts.filterProvider || createCoreFilterProvider();
  const rankingProvider = opts.rankingProvider || createDefaultRankingProvider();
  const cache = opts.cache || createCacheLayer();

  function discover(store, body = {}) {
    ensureServicePlaces(store);
    const parsed = normalizeViewportRequest(body);
    if (!parsed.ok) return parsed;

    const vp = parsed.viewport;
    if (vp.category && !CORE_CATEGORIES.includes(vp.category)) {
      return {
        ok: false,
        status: 400,
        message: `category غير مدعومة: ${vp.category}`,
      };
    }

    const filterHash = filterProvider.filterHash(
      vp.filters,
      vp.category,
      vp.verticalFilters,
    );
    const cells = geoIndex.cellsForBBox(vp.bbox, vp.zoom);
    const cacheKey = geoIndex.cacheKey(cells, vp.category, `${filterHash}|${vp.mode}|${vp.limit}|${vp.cursor || ''}|${rankingProvider.version}`);

    const cached = cache.getQuery(cacheKey);
    if (cached) {
      return { ok: true, cached: true, response: cached };
    }

    const inViewport = queryPlacesInViewport({
      store,
      bbox: vp.bbox,
      geoIndex,
      zoom: vp.zoom,
    });

    const filtered = applyFilters(inViewport, filterProvider, {
      category: vp.category,
      filters: vp.filters,
      verticalFilters: vp.verticalFilters,
    });

    const mode = resolveRenderMode({
      requestedMode: vp.mode,
      zoom: vp.zoom,
      placeCount: filtered.length,
    });

    if (mode === 'clusters') {
      const clusters = buildClusters(filtered, {
        geoIndex,
        zoom: vp.zoom,
        category: vp.category,
      });
      const response = {
        generatedAt: new Date().toISOString(),
        mode: 'clusters',
        items: clusters,
        nextCursor: null,
        limit: vp.limit,
        rankingVersion: rankingProvider.version || RANKING_VERSION,
        totalMatched: filtered.length,
        meta: {
          geoIndex: geoIndex.id,
          filterProvider: filterProvider.id,
          rankingProvider: rankingProvider.id,
          cacheGeneration: cache.generation,
        },
      };
      cache.setQuery(cacheKey, response);
      return { ok: true, cached: false, response };
    }

    const ranked = rankingProvider.rank(filtered, {
      bbox: vp.bbox,
      center: vp.center,
      category: vp.category,
    });

    const offset = decodeCursor(vp.cursor);
    const page = ranked.slice(offset, offset + vp.limit);
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < ranked.length ? encodeCursor(nextOffset) : null;

    const items = page.map((row) =>
      toDiscoveryCard(row.place, {
        score: Math.round(row.score * 1000) / 1000,
        distanceKm:
          row.distanceKm != null
            ? Math.round(row.distanceKm * 100) / 100
            : undefined,
        scoreBreakdown: vp.includeScoreBreakdown ? row.scoreBreakdown : undefined,
      }),
    );

    const response = {
      generatedAt: new Date().toISOString(),
      mode: 'places',
      items,
      nextCursor,
      limit: vp.limit,
      rankingVersion: rankingProvider.version || RANKING_VERSION,
      totalMatched: filtered.length,
      meta: {
        geoIndex: geoIndex.id,
        filterProvider: filterProvider.id,
        rankingProvider: rankingProvider.id,
        cacheGeneration: cache.generation,
        offset,
      },
    };

    cache.setQuery(cacheKey, response);
    return { ok: true, cached: false, response };
  }

  function clustersOnly(store, body = {}) {
    return discover(store, { ...body, mode: 'clusters' });
  }

  function placeDetails(store, placeId) {
    const cached = cache.getPlace(placeId);
    if (cached) return { ok: true, cached: true, place: cached };

    const place = getPlaceById(store, placeId);
    if (!place) {
      return { ok: false, status: 404, message: 'ServicePlace غير موجود' };
    }
    cache.setPlace(placeId, place);
    return { ok: true, cached: false, place };
  }

  function listCategories() {
    return {
      categories: CORE_CATEGORIES.map((id) => ({
        id,
        // Labels are UI concern; Core exposes stable ids only.
        filterKeys: ['species', 'verifiedOnly', 'openNow'],
      })),
      coreFilters: ['category', 'species', 'verifiedOnly', 'openNow'],
      rankingVersion: rankingProvider.version || RANKING_VERSION,
      providers: {
        geoIndex: geoIndex.id,
        filter: filterProvider.id,
        ranking: rankingProvider.id,
      },
    };
  }

  function upsertPlace(store, raw, idFn) {
    const result = upsertServicePlace(store, raw, idFn);
    if (result.ok) cache.bumpGeneration();
    return result;
  }

  return {
    discover,
    clustersOnly,
    placeDetails,
    listCategories,
    upsertPlace,
    ensureStore: ensureServicePlaces,
    providers: { geoIndex, filterProvider, rankingProvider, cache },
  };
}

module.exports = {
  createGeoDiscoveryEngine,
};
