/**
 * GDE-02 — FilterProvider (pluggable) + core filter engine.
 * Core filters only. verticalFilters are ignored by default (pass-through policy: ignore).
 */
'use strict';

const { CORE_CATEGORIES } = require('./constants');
const crypto = require('crypto');

function stableHash(obj) {
  const json = JSON.stringify(obj, Object.keys(obj || {}).sort());
  return crypto.createHash('sha1').update(json).digest('hex').slice(0, 12);
}

/**
 * @typedef {object} FilterProvider
 * @property {string} id
 * @property {(place:object, ctx:object)=>boolean} matches
 * @property {(filters:object, category:string|null)=>string} filterHash
 * @property {(filters:object)=>object} normalize
 */

/** @returns {FilterProvider} */
function createCoreFilterProvider(opts = {}) {
  const id = opts.id || 'core-filters-v1';
  const unknownKeyPolicy = opts.unknownKeyPolicy || 'ignore'; // ignore | reject

  function normalize(filters = {}) {
    const out = {
      species: Array.isArray(filters.species)
        ? filters.species.map(String)
        : filters.species != null
          ? [String(filters.species)]
          : [],
      verifiedOnly: Boolean(filters.verifiedOnly),
      openNow: Boolean(filters.openNow),
    };
    return out;
  }

  function filterHash(filters, category) {
    const n = normalize(filters);
    return stableHash({ category: category || null, ...n });
  }

  function matches(place, ctx) {
    const category = ctx.category != null ? String(ctx.category) : null;
    const filters = normalize(ctx.filters || {});

    if (category) {
      if (!CORE_CATEGORIES.includes(category)) {
        return false;
      }
      if (!Array.isArray(place.categories) || !place.categories.includes(category)) {
        return false;
      }
    }

    if (filters.verifiedOnly && !place.verified) return false;

    if (filters.openNow) {
      const a = String(place.availability || '').toLowerCase();
      if (a !== 'open_now' && a !== 'open') return false;
    }

    if (filters.species.length > 0) {
      const placeSpecies = Array.isArray(place.labels?.species)
        ? place.labels.species.map((s) => String(s).toLowerCase())
        : [];
      const wanted = filters.species.map((s) => s.toLowerCase());
      const hit = wanted.some(
        (w) =>
          placeSpecies.includes(w) ||
          placeSpecies.includes('all') ||
          // Arabic common aliases accepted as opaque strings
          placeSpecies.some((ps) => ps.includes(w) || w.includes(ps)),
      );
      if (!hit) return false;
    }

    // verticalFilters: Core ignores (GDE-02). Verticals own them later.
    if (unknownKeyPolicy === 'reject' && ctx.verticalFilters) {
      const keys = Object.keys(ctx.verticalFilters);
      if (keys.length > 0) return false;
    }

    return true;
  }

  return { id, matches, filterHash, normalize };
}

function applyFilters(places, provider, ctx) {
  return places.filter((p) => provider.matches(p, ctx));
}

module.exports = {
  createCoreFilterProvider,
  applyFilters,
  stableHash,
};
