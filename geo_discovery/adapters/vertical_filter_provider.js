/**
 * Extended FilterProvider: Core filters + boarding verticalFilters.
 * Training/vet/… hooks can be added similarly without forking Core.
 */
'use strict';

const { createCoreFilterProvider } = require('../filter_engine');
const { boardingVerticalMatches } = require('./stable_place_adapter');
const { stableHash } = require('../filter_engine');

function createGeoVerticalFilterProvider(opts = {}) {
  const core = createCoreFilterProvider(opts);
  return {
    id: 'geo-core+vertical-v1',
    normalize: core.normalize,
    filterHash(filters, category, verticalFilters) {
      const base = core.filterHash(filters, category);
      if (!verticalFilters || Object.keys(verticalFilters).length === 0) return base;
      return `${base}|vf:${stableHash(verticalFilters)}`;
    },
    matches(place, ctx) {
      if (!core.matches(place, ctx)) return false;
      const category = ctx.category != null ? String(ctx.category) : null;
      const vf = ctx.verticalFilters || {};
      if (category === 'boarding' || (place.categories || []).includes('boarding')) {
        if (!boardingVerticalMatches(place, vf)) return false;
      }
      return true;
    },
  };
}

module.exports = { createGeoVerticalFilterProvider };
