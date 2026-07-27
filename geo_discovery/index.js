/**
 * GDE-02 — Geo Discovery Core public exports.
 */
'use strict';

const { createGeoDiscoveryEngine } = require('./discovery_engine');
const { registerGeoDiscoveryRoutes } = require('./routes');
const { createGeohashGeoIndexProvider } = require('./geo_index_provider');
const { createCoreFilterProvider } = require('./filter_engine');
const { createDefaultRankingProvider } = require('./ranking_provider');
const { createCacheLayer } = require('./cache_layer');
const constants = require('./constants');

module.exports = {
  createGeoDiscoveryEngine,
  registerGeoDiscoveryRoutes,
  createGeohashGeoIndexProvider,
  createCoreFilterProvider,
  createDefaultRankingProvider,
  createCacheLayer,
  constants,
};
