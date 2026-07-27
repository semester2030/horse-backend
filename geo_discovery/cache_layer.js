/**
 * GDE-02 — Cache Layer (query + place detail). Never stores a full catalog blob.
 */
'use strict';

const {
  QUERY_CACHE_TTL_MS,
  PLACE_DETAIL_CACHE_TTL_MS,
} = require('./constants');

function createCacheLayer(opts = {}) {
  const queryTtl = opts.queryTtlMs ?? QUERY_CACHE_TTL_MS;
  const detailTtl = opts.detailTtlMs ?? PLACE_DETAIL_CACHE_TTL_MS;
  const maxEntries = opts.maxEntries ?? 256;

  /** @type {Map<string, { expiresAt:number, value:any, generation:string|null }>} */
  const queryCache = new Map();
  /** @type {Map<string, { expiresAt:number, value:any, generation:string|null }>} */
  const detailCache = new Map();

  let generation = opts.generation != null ? String(opts.generation) : 'g0';

  function _prune(map) {
    const now = Date.now();
    for (const [k, v] of map) {
      if (v.expiresAt <= now) map.delete(k);
    }
    while (map.size > maxEntries) {
      const first = map.keys().next().value;
      map.delete(first);
    }
  }

  function getQuery(key) {
    _prune(queryCache);
    const hit = queryCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      queryCache.delete(key);
      return null;
    }
    if (hit.generation != null && hit.generation !== generation) {
      queryCache.delete(key);
      return null;
    }
    return hit.value;
  }

  function setQuery(key, value, ttlMs = queryTtl) {
    _prune(queryCache);
    queryCache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      generation,
    });
  }

  function getPlace(placeId) {
    _prune(detailCache);
    const hit = detailCache.get(String(placeId));
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      detailCache.delete(String(placeId));
      return null;
    }
    if (hit.generation != null && hit.generation !== generation) {
      detailCache.delete(String(placeId));
      return null;
    }
    return hit.value;
  }

  function setPlace(placeId, value, ttlMs = detailTtl) {
    _prune(detailCache);
    detailCache.set(String(placeId), {
      value,
      expiresAt: Date.now() + ttlMs,
      generation,
    });
  }

  function bumpGeneration(token) {
    generation = token != null ? String(token) : `g${Date.now()}`;
    queryCache.clear();
    detailCache.clear();
    return generation;
  }

  function clear() {
    queryCache.clear();
    detailCache.clear();
  }

  function stats() {
    return {
      generation,
      queryEntries: queryCache.size,
      detailEntries: detailCache.size,
    };
  }

  return {
    getQuery,
    setQuery,
    getPlace,
    setPlace,
    bumpGeneration,
    clear,
    stats,
    get generation() {
      return generation;
    },
  };
}

module.exports = { createCacheLayer };
