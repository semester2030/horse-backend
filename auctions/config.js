'use strict';

/**
 * Auction V1 — feature flag + env (PostgreSQL isolated from store.json).
 * Default OFF — does not affect Store Release v1 builds.
 */

function envBool(key, defaultValue) {
  const raw = process.env[key];
  if (raw == null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function getAuctionsDatabaseUrl() {
  return (
    process.env.AUCTIONS_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  );
}

function isAuctionsEnabled() {
  return envBool('ENABLE_AUCTIONS', false);
}

const ANTI_SNIPE_SECONDS = Number(process.env.AUCTION_ANTI_SNIPE_SECONDS || 120);

const SETTLEMENT_NOTE =
  'Financial settlement is out of band for Auction V1 — winner and final price only; not a paid/completed transaction.';

const ALLOWED_SPECIES = ['horse', 'camel', 'falcon'];

const AUCTION_STATUSES = [
  'draft',
  'review',
  'scheduled',
  'live',
  'extended',
  'ended',
  'sold',
  'unsold',
  'cancelled',
  'frozen',
];

const DISPUTE_STATUSES = ['open', 'reviewing', 'resolved', 'rejected'];

const RISK_SEVERITIES = ['low', 'medium', 'high'];

const HOST_STATUSES = ['pending', 'verified', 'active', 'suspended'];

const AUDIO_PROVIDER = String(process.env.AUCTION_AUDIO_PROVIDER || 'noop').toLowerCase();

module.exports = {
  get ENABLE_AUCTIONS() {
    return isAuctionsEnabled();
  },
  get AUCTIONS_DATABASE_URL() {
    return getAuctionsDatabaseUrl();
  },
  getAuctionsDatabaseUrl,
  isAuctionsEnabled,
  ANTI_SNIPE_SECONDS,
  SETTLEMENT_NOTE,
  ALLOWED_SPECIES,
  AUCTION_STATUSES,
  DISPUTE_STATUSES,
  RISK_SEVERITIES,
  HOST_STATUSES,
  AUDIO_PROVIDER,
  envBool,
};
