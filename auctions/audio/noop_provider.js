'use strict';

/**
 * No-op audio provider — default for Auction V1 foundation.
 * Auction continues if audio fails or is unavailable.
 */
function createNoopAudioProvider() {
  async function mintToken({
    roomName,
    identity,
    canPublish = false,
    canSubscribe = true,
    ttlSeconds = 600,
  }) {
    return {
      ok: true,
      token: `noop-${identity}-${canPublish ? 'pub' : 'sub'}-${roomName}`,
      url: 'noop://localhost',
      roomName,
      expiresIn: ttlSeconds,
    };
  }

  return {
    name: 'noop',
    isConfigured: true,
    async createSession({ auctionId, hostId, roomName }) {
      const room = roomName || `noop-${auctionId}`;
      return {
        ok: true,
        provider: 'noop',
        roomId: room,
        roomName: room,
        message: 'Audio optional — noop provider active',
        hostId,
      };
    },
    mintToken,
    async endSession() {
      return { ok: true };
    },
  };
}

module.exports = { createNoopAudioProvider };
