'use strict';

/**
 * AuctionAudioProvider — abstraction for optional live host audio.
 * WebSocket (ws_hub) is NOT used for audio transport.
 *
 * @typedef {Object} AuctionAudioProvider
 * @property {string} name
 * @property {boolean} isConfigured
 * @property {(ctx: { auctionId: string, hostId: string, hostUserId: string }) => Promise<{ roomId: string, token?: string, joinUrl?: string }>} createSession
 * @property {(ctx: { sessionId: string }) => Promise<{ ok: boolean }>} endSession
 */

function notConfiguredProvider(name) {
  return {
    name,
    isConfigured: false,
    async createSession() {
      return {
        ok: false,
        error: `${name} not configured — credentials missing`,
        roomId: null,
      };
    },
    async endSession() {
      return { ok: true, skipped: true };
    },
  };
}

module.exports = {
  notConfiguredProvider,
};
