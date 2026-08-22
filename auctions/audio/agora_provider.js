'use strict';

const { notConfiguredProvider } = require('./provider');

/**
 * Agora stub — requires AGORA_APP_ID, AGORA_APP_CERTIFICATE.
 */
function createAgoraAudioProvider() {
  const appId = process.env.AGORA_APP_ID || '';
  const cert = process.env.AGORA_APP_CERTIFICATE || '';
  if (!appId || !cert) {
    return notConfiguredProvider('agora');
  }
  return {
    name: 'agora',
    isConfigured: true,
    async createSession({ auctionId, hostId, hostUserId }) {
      return {
        ok: false,
        error: 'Agora RTC token mint pending — provider selected but not fully wired',
        channel: `agora-${auctionId}`,
        hostId,
        hostUserId,
      };
    },
    async endSession() {
      return { ok: true, pending: true };
    },
  };
}

module.exports = { createAgoraAudioProvider };
