/**
 * GDE-02 — GeoIndexProvider (pluggable).
 * Default: Geohash. Domain never couples to H3/S2/Geohash directly.
 */
'use strict';

const { DEFAULT_CELL_PRECISION } = require('./constants');

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encodeGeohash(lat, lng, precision = DEFAULT_CELL_PRECISION) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = '';
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        idx = (idx << 1) + 1;
        lngMin = mid;
      } else {
        idx = (idx << 1) + 0;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = (idx << 1) + 1;
        latMin = mid;
      } else {
        idx = (idx << 1) + 0;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      geohash += BASE32.charAt(idx);
      bit = 0;
      idx = 0;
    }
  }
  return geohash;
}

function decodeGeohashBounds(hash) {
  let evenBit = true;
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  for (let i = 0; i < hash.length; i++) {
    const cd = BASE32.indexOf(hash[i]);
    if (cd < 0) throw new Error(`Invalid geohash char: ${hash[i]}`);
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2;
        if (cd & mask) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (cd & mask) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return {
    sw: { lat: latMin, lng: lngMin },
    ne: { lat: latMax, lng: lngMax },
  };
}

function precisionForZoom(zoom) {
  const z = Number(zoom);
  if (!Number.isFinite(z)) return DEFAULT_CELL_PRECISION;
  if (z <= 6) return 3;
  if (z <= 8) return 4;
  if (z <= 10) return 5;
  if (z <= 12) return 6;
  if (z <= 14) return 7;
  return 8;
}

/**
 * @typedef {object} GeoIndexProvider
 * @property {string} id
 * @property {(lat:number,lng:number,precision?:number)=>string} encode
 * @property {(bbox:object, zoom:number)=>string[]} cellsForBBox
 * @property {(cellId:string)=>string[]} neighbors
 * @property {(cellId:string, zoom:number)=>string} clusterKey
 * @property {(cells:string[], category:string|null, filterHash:string)=>string} cacheKey
 */

/** @returns {GeoIndexProvider} */
function createGeohashGeoIndexProvider(opts = {}) {
  const id = opts.id || 'geohash-v1';

  function encode(lat, lng, precision = DEFAULT_CELL_PRECISION) {
    return encodeGeohash(lat, lng, precision);
  }

  function cellsForBBox(bbox, zoom) {
    const precision = precisionForZoom(zoom);
    const cells = new Set();
    // Sample a grid across the bbox at cell-scale steps.
    const latSpan = Math.max(0.0001, bbox.ne.lat - bbox.sw.lat);
    const lngSpan = Math.max(0.0001, bbox.ne.lng - bbox.sw.lng);
    const steps = Math.min(24, Math.max(4, Math.ceil(Math.max(latSpan, lngSpan) * (precision + 2) * 8)));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const lat = bbox.sw.lat + (latSpan * i) / steps;
        const lng = bbox.sw.lng + (lngSpan * j) / steps;
        cells.add(encode(lat, lng, precision));
      }
    }
    // Always include corners and center.
    cells.add(encode(bbox.sw.lat, bbox.sw.lng, precision));
    cells.add(encode(bbox.sw.lat, bbox.ne.lng, precision));
    cells.add(encode(bbox.ne.lat, bbox.sw.lng, precision));
    cells.add(encode(bbox.ne.lat, bbox.ne.lng, precision));
    cells.add(encode((bbox.sw.lat + bbox.ne.lat) / 2, (bbox.sw.lng + bbox.ne.lng) / 2, precision));
    return [...cells];
  }

  function neighbors(cellId) {
    // Approximate: return self + truncated parent prefixes for adjacency expand.
    const out = new Set([cellId]);
    if (cellId.length > 1) out.add(cellId.slice(0, -1));
    return [...out];
  }

  function clusterKey(cellId, zoom) {
    const z = Number.isFinite(Number(zoom)) ? Number(zoom) : 10;
    const trim = z <= 8 ? 3 : z <= 11 ? 4 : z <= 13 ? 5 : 6;
    return `${id}:${String(cellId).slice(0, Math.min(trim, cellId.length))}`;
  }

  function cacheKey(cells, category, filterHash) {
    const sorted = [...(cells || [])].map(String).sort().join(',');
    return `${id}|${sorted}|${category || '*'}|${filterHash || '-'}`;
  }

  return {
    id,
    encode,
    cellsForBBox,
    neighbors,
    clusterKey,
    cacheKey,
    decodeBounds: decodeGeohashBounds,
    precisionForZoom,
  };
}

module.exports = {
  createGeohashGeoIndexProvider,
  encodeGeohash,
  decodeGeohashBounds,
  precisionForZoom,
};
