'use strict';

/**
 * Pure helpers for GET /videos scope + pagination.
 * Keeps store browsing isolation off the hot path of ad-hoc client filtering.
 */

function videoOwnerId(video) {
  return String(video?.userId || video?.ownerId || '').trim();
}

/**
 * Restrict list to a single merchant/store owner (store-scoped feed).
 * Identity is userId/ownerId — never displayName.
 */
function filterVideosByOwner(list, ownerId) {
  const oid = ownerId != null ? String(ownerId).trim() : '';
  if (!oid) return list;
  return list.filter((v) => videoOwnerId(v) === oid);
}

/**
 * Slice with offset/limit. Returns page metadata for headers/clients.
 * When limit is absent/invalid, returns the full list (legacy behaviour).
 */
function paginateList(list, { limit, offset } = {}) {
  const total = Array.isArray(list) ? list.length : 0;
  const offRaw = offset != null ? parseInt(offset, 10) : 0;
  const off = Number.isFinite(offRaw) && offRaw > 0 ? offRaw : 0;
  const limRaw = limit != null ? parseInt(limit, 10) : NaN;
  if (!Number.isFinite(limRaw) || limRaw <= 0) {
    return {
      items: list,
      total,
      offset: 0,
      limit: null,
      hasMore: false,
    };
  }
  const lim = Math.min(limRaw, 100);
  const items = list.slice(off, off + lim);
  return {
    items,
    total,
    offset: off,
    limit: lim,
    hasMore: off + items.length < total,
  };
}

module.exports = {
  videoOwnerId,
  filterVideosByOwner,
  paginateList,
};
