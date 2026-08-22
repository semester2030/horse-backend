'use strict';

const { ALLOWED_SPECIES } = require('../config');

function listingOwnerId(listing) {
  return String(listing.sellerId || listing.userId || listing.ownerId || '').trim();
}

function videoOwnerId(video) {
  return String(video.userId || video.ownerId || '').trim();
}

function listingSpecies(listing) {
  return String(listing.species || listing.listingSpecies || 'horse')
    .trim()
    .toLowerCase();
}

function videoSpecies(video) {
  const type = String(video.type || '').trim().toLowerCase();
  if (ALLOWED_SPECIES.includes(type)) return type;
  return String(video.species || type || 'horse').trim().toLowerCase();
}

function videoLinkedToListing(video, listingId, listing) {
  const lid = String(listingId || '').trim();
  if (!lid) return false;
  const vid = String(video.id || '').trim();
  if (String(video.horseId || video.horse_id || '').trim() === lid) return true;
  if (String(video.listingId || video.listing_id || '').trim() === lid) return true;
  if (listing) {
    const ref = String(listing.videoId || listing.cloudflareVideoId || '').trim();
    if (ref && ref === vid) return true;
  }
  return false;
}

/**
 * Server-side ownership + asset linkage for POST /auctions.
 * @returns {{ ok: true } | { ok: false, code: string, message: string, status: number }}
 */
function validateAuctionAssetOwnership(store, input) {
  if (!store || !store.horses || !store.videos) {
    return {
      ok: false,
      code: 'AUCTION_STORE_UNAVAILABLE',
      message: 'Listing store unavailable for ownership validation',
      status: 503,
    };
  }

  const listingId = String(input.listingId || '').trim();
  const videoId = String(input.videoId || '').trim();
  const ownerUserId = String(input.ownerUserId || '').trim();
  const species = String(input.species || '').trim().toLowerCase();

  if (!listingId || !videoId || !ownerUserId) {
    return {
      ok: false,
      code: 'AUCTION_ASSET_REF_INVALID',
      message: 'listingId, videoId, and ownerUserId are required',
      status: 400,
    };
  }

  if (!ALLOWED_SPECIES.includes(species)) {
    return {
      ok: false,
      code: 'AUCTION_SPECIES_INVALID',
      message: 'Species not eligible for auctions V1',
      status: 400,
    };
  }

  const listing = store.horses.get(listingId);
  if (!listing) {
    return {
      ok: false,
      code: 'AUCTION_LISTING_NOT_FOUND',
      message: 'Listing not found',
      status: 404,
    };
  }

  const video = store.videos.get(videoId);
  if (!video) {
    return {
      ok: false,
      code: 'AUCTION_VIDEO_NOT_FOUND',
      message: 'Video not found',
      status: 404,
    };
  }

  if (listing.hidden || listing.status === 'removed') {
    return {
      ok: false,
      code: 'AUCTION_LISTING_INELIGIBLE',
      message: 'Listing is not eligible for auction',
      status: 409,
    };
  }

  if (video.hidden || video.status === 'removed') {
    return {
      ok: false,
      code: 'AUCTION_VIDEO_INELIGIBLE',
      message: 'Video is not eligible for auction',
      status: 409,
    };
  }

  const listingOwner = listingOwnerId(listing);
  if (!listingOwner || listingOwner !== ownerUserId) {
    return {
      ok: false,
      code: 'AUCTION_LISTING_OWNER_MISMATCH',
      message: 'Listing does not belong to ownerUserId',
      status: 403,
    };
  }

  const videoOwner = videoOwnerId(video);
  if (!videoOwner || videoOwner !== ownerUserId) {
    return {
      ok: false,
      code: 'AUCTION_VIDEO_OWNER_MISMATCH',
      message: 'Video does not belong to ownerUserId',
      status: 403,
    };
  }

  const listingSp = listingSpecies(listing);
  const videoSp = videoSpecies(video);
  if (listingSp !== species || videoSp !== species) {
    return {
      ok: false,
      code: 'AUCTION_SPECIES_MISMATCH',
      message: 'Species mismatch between auction, listing, and video',
      status: 409,
    };
  }

  if (!videoLinkedToListing(video, listingId, listing)) {
    return {
      ok: false,
      code: 'AUCTION_VIDEO_NOT_LINKED',
      message: 'Video is not linked to the listing',
      status: 409,
    };
  }

  return { ok: true };
}

module.exports = {
  validateAuctionAssetOwnership,
  listingOwnerId,
  videoOwnerId,
  listingSpecies,
  videoSpecies,
  videoLinkedToListing,
};
