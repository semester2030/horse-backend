'use strict';

/**
 * Authoritative listing → auction location snapshot.
 * Never trust client-supplied lat/lng for auction create.
 */

const SA_LAT_MIN = 16.0;
const SA_LAT_MAX = 32.5;
const SA_LNG_MIN = 34.5;
const SA_LNG_MAX = 56.0;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

function inSaudi(lat, lng) {
  return (
    lat >= SA_LAT_MIN &&
    lat <= SA_LAT_MAX &&
    lng >= SA_LNG_MIN &&
    lng <= SA_LNG_MAX
  );
}

/**
 * Read location fields from a NOMAS listing (store.horses record).
 */
function extractLocationFromListing(listing) {
  if (!listing || typeof listing !== 'object') return null;
  const loc =
    listing.location && typeof listing.location === 'object' ? listing.location : {};
  const lat = num(loc.lat ?? loc.latitude ?? listing.lat ?? listing.latitude);
  const lng = num(loc.lng ?? loc.longitude ?? listing.lng ?? listing.longitude);
  const city = str(listing.city || loc.city);
  const district = str(listing.district || loc.district);
  const address = str(
    listing.address || loc.address || listing.displayAddress || loc.displayAddress,
  );
  if (lat == null || lng == null || !city) return null;
  if (!inSaudi(lat, lng)) return null;
  return {
    city,
    district,
    address,
    lat,
    lng,
    sourceListingId: str(listing.id) || null,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * @returns {{ ok: true, snapshot } | { ok: false, code, message, status }}
 */
function requireListingLocationSnapshot(listing) {
  const snapshot = extractLocationFromListing(listing);
  if (!snapshot) {
    return {
      ok: false,
      code: 'AUCTION_LOCATION_REQUIRED',
      message:
        'Listing must have a valid Saudi location (city + coordinates) before creating an auction',
      status: 400,
    };
  }
  return { ok: true, snapshot };
}

/**
 * Independent auction create — owner-supplied location (validated Saudi bounds).
 * Accepts body.location or flat lat/lng/city fields.
 */
function requireAuctionOwnerLocation(body) {
  const src =
    body && typeof body.location === 'object' && body.location
      ? body.location
      : body || {};
  const lat = num(src.lat ?? src.latitude);
  const lng = num(src.lng ?? src.longitude);
  const city = str(src.city);
  const district = str(src.district);
  const address = str(src.address || src.displayAddress);
  if (lat == null || lng == null || !city) {
    return {
      ok: false,
      code: 'AUCTION_LOCATION_REQUIRED',
      message:
        'Auction location requires city + valid Saudi coordinates (lat/lng)',
      status: 400,
    };
  }
  if (!inSaudi(lat, lng)) {
    return {
      ok: false,
      code: 'AUCTION_LOCATION_OUT_OF_BOUNDS',
      message: 'Auction location must be within Saudi Arabia bounds',
      status: 400,
    };
  }
  return {
    ok: true,
    snapshot: {
      city,
      district,
      address,
      lat,
      lng,
      sourceListingId: null,
      capturedAt: new Date().toISOString(),
    },
  };
}

function displayLabel(snapshotOrRow) {
  if (!snapshotOrRow) return null;
  const city =
    snapshotOrRow.city || snapshotOrRow.location_city || null;
  const district =
    snapshotOrRow.district || snapshotOrRow.location_district || null;
  if (city && district) return `${city} · ${district}`;
  return city || district || null;
}

/** Public-safe location (no source listing id / capture metadata). */
function mapPublicLocation(row) {
  if (!row) return null;
  const city = row.location_city || null;
  const lat = row.location_lat != null ? Number(row.location_lat) : null;
  const lng = row.location_lng != null ? Number(row.location_lng) : null;
  if (!city && lat == null) return null;
  return {
    city,
    district: row.location_district || null,
    displayLabel: displayLabel(row),
    address: row.location_address || null,
    lat,
    lng,
  };
}

/** Admin location — includes provenance. */
function mapAdminLocation(row) {
  const pub = mapPublicLocation(row);
  if (!pub) return null;
  return {
    ...pub,
    sourceListingId: row.location_source_listing_id || null,
    capturedAt: row.location_captured_at || null,
  };
}

module.exports = {
  extractLocationFromListing,
  requireListingLocationSnapshot,
  requireAuctionOwnerLocation,
  displayLabel,
  mapPublicLocation,
  mapAdminLocation,
  inSaudi,
  SA_LAT_MIN,
  SA_LAT_MAX,
  SA_LNG_MIN,
  SA_LNG_MAX,
};
