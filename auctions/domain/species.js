'use strict';

const { ALLOWED_SPECIES } = require('../config');

function assertSpecies(species) {
  const s = String(species || '').trim().toLowerCase();
  if (!ALLOWED_SPECIES.includes(s)) {
    const err = new Error(`Species not eligible in Auction V1: ${species}`);
    err.code = 'AUCTION_SPECIES_INVALID';
    err.status = 400;
    throw err;
  }
  return s;
}

function assertListingRef(listingId, videoId) {
  const lid = String(listingId || '').trim();
  const vid = String(videoId || '').trim();
  if (!lid || !vid) {
    const err = new Error('listingId and videoId are required references');
    err.code = 'AUCTION_REF_MISSING';
    err.status = 400;
    throw err;
  }
  return { listingId: lid, videoId: vid };
}

/** Optional legacy refs — empty strings become null for independent lots. */
function optionalListingRef(listingId, videoId) {
  const lid = String(listingId || '').trim() || null;
  const vid = String(videoId || '').trim() || null;
  return { listingId: lid, videoId: vid };
}

module.exports = {
  ALLOWED_SPECIES,
  assertSpecies,
  assertListingRef,
  optionalListingRef,
};
