'use strict';

const { AUDIO_PROVIDER } = require('../config');

/**
 * Phase 5 live audio contract — optional host audio; bids remain REST+PostgreSQL authoritative.
 */
const PRE_AUDIO_CONTRACT = {
  version: '2.0.0-phase5',
  chain: ['HostBooking', 'Auction', 'AudioSession'],
  publisher: {
    role: 'assigned_host_only',
    userIdField: 'host.userId',
    auctionBinding: 'audioSession.auctionId === auction.id',
  },
  audience: {
    mode: 'listen_only',
    bidAuthority: 'rest_postgresql_only',
  },
  window: {
    opensAt: 'auction.startAt - 15 minutes',
    closesAt: 'auction.effectiveEndAt',
    serverAuthoritative: true,
  },
  authorization: {
    requiredHostStatus: ['active'],
    requiredHostVerified: true,
    requiredBookingStatus: ['scheduled'],
    requiredAuctionStatusForPublish: ['live', 'extended'],
  },
  sessionStatus: ['inactive', 'ready', 'live', 'paused', 'ended', 'failed'],
  phase4Behavior: {
    wired: false,
    microphonePermission: false,
    provider: 'noop',
    note: 'Phase 4 stub — superseded by phase5Behavior',
  },
  phase5Behavior: {
    wired: true,
    microphonePermission: true,
    provider: AUDIO_PROVIDER,
    tokenTtlSeconds: Number(process.env.AUCTION_AUDIO_TOKEN_TTL_SECONDS || 600),
    audienceCanPublish: false,
  },
};

function validatePreAudioReadiness({ host, booking, auction }, { requireLive = false } = {}) {
  const errors = [];
  if (!host || host.status !== 'active' || !(host.verified_at || host.verifiedAt)) {
    errors.push('HOST_NOT_AUTHORIZED_FOR_AUDIO');
  }
  if (!booking || booking.status !== 'scheduled') {
    errors.push('BOOKING_NOT_SCHEDULED');
  }
  const auctionStatus = auction?.status;
  const allowed = requireLive
    ? ['live', 'extended']
    : ['scheduled', 'live', 'extended'];
  if (!auction || !allowed.includes(auctionStatus)) {
    errors.push(requireLive ? 'AUCTION_NOT_LIVE_FOR_AUDIO' : 'AUCTION_NOT_IN_AUDIO_WINDOW');
  }
  if (booking && auction && String(booking.auction_id || booking.auctionId) !== String(auction.id)) {
    errors.push('BOOKING_AUCTION_MISMATCH');
  }
  return { ok: errors.length === 0, errors, contract: PRE_AUDIO_CONTRACT };
}

module.exports = { PRE_AUDIO_CONTRACT, validatePreAudioReadiness };
