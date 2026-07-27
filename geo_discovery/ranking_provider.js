/**
 * GDE-02 — RankingProvider (pluggable) + default v1 signals.
 * Server-authoritative ranking within the current query set only.
 */
'use strict';

const { RANKING_VERSION } = require('./constants');
const { haversineKm, bboxCenter } = require('./models');

/**
 * @typedef {object} RankingProvider
 * @property {string} id
 * @property {string} version
 * @property {(places:object[], ctx:object)=>object[]} rank
 */

function distanceScore(distanceKm, maxKm = 50) {
  if (!Number.isFinite(distanceKm)) return 0.3;
  if (distanceKm <= 0) return 1;
  return Math.max(0, 1 - distanceKm / maxKm);
}

function ratingScore(rating, reviewCount) {
  const r = Number(rating);
  if (!Number.isFinite(r)) return 0.4;
  const base = Math.min(1, Math.max(0, r / 5));
  const n = Number(reviewCount) || 0;
  const confidence = Math.min(1, Math.log10(n + 1) / 2.5);
  return base * (0.55 + 0.45 * confidence);
}

function verifiedBoost(verified) {
  return verified ? 1 : 0;
}

function availabilityBoost(availability) {
  const a = String(availability || '').toLowerCase();
  if (a === 'open_now' || a === 'open') return 1;
  if (a === 'accepts_bookings') return 0.7;
  if (a === 'unknown') return 0.35;
  return 0.2;
}

function freshnessScore(updatedAt, now = Date.now()) {
  if (!updatedAt) return 0.4;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0.4;
  const days = Math.max(0, (now - t) / (86400 * 1000));
  if (days <= 7) return 1;
  if (days <= 30) return 0.75;
  if (days <= 90) return 0.5;
  return 0.25;
}

function categoryFit(place, category) {
  if (!category) return 0.6;
  return Array.isArray(place.categories) && place.categories.includes(category)
    ? 1
    : 0.2;
}

/** @returns {RankingProvider} */
function createDefaultRankingProvider(opts = {}) {
  const id = opts.id || 'default-rank-v1';
  const version = opts.version || RANKING_VERSION;
  const weights = {
    distanceScore: 0.32,
    ratingScore: 0.22,
    verifiedBoost: 0.14,
    availabilityBoost: 0.12,
    freshnessScore: 0.08,
    categoryFit: 0.12,
    ...(opts.weights || {}),
  };

  function scorePlace(place, ctx) {
    const center = ctx.center || (ctx.bbox ? bboxCenter(ctx.bbox) : null);
    const distanceKm = center
      ? haversineKm(center.lat, center.lng, place.location.lat, place.location.lng)
      : null;

    const parts = {
      distanceScore: distanceScore(distanceKm),
      ratingScore: ratingScore(place.rating, place.reviewCount),
      verifiedBoost: verifiedBoost(place.verified),
      availabilityBoost: availabilityBoost(place.availability),
      freshnessScore: freshnessScore(place.updatedAt),
      categoryFit: categoryFit(place, ctx.category),
    };

    let score = 0;
    for (const [k, w] of Object.entries(weights)) {
      score += (parts[k] || 0) * w;
    }

    return {
      place,
      score,
      distanceKm,
      scoreBreakdown: parts,
    };
  }

  function rank(places, ctx = {}) {
    const scored = places.map((p) => scorePlace(p, ctx));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.place.id).localeCompare(String(b.place.id));
    });
    return scored;
  }

  return { id, version, rank, weights };
}

module.exports = {
  createDefaultRankingProvider,
  distanceScore,
  ratingScore,
};
