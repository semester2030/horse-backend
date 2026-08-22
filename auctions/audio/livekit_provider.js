'use strict';

const { AccessToken } = require('livekit-server-sdk');
const { notConfiguredProvider } = require('./provider');

function createLiveKitAudioProvider() {
  const key = process.env.LIVEKIT_API_KEY || '';
  const secret = process.env.LIVEKIT_API_SECRET || '';
  const url = process.env.LIVEKIT_URL || '';
  if (!key || !secret || !url) {
    return notConfiguredProvider('livekit');
  }

  async function mintToken({
    roomName,
    identity,
    canPublish = false,
    canSubscribe = true,
    ttlSeconds = 600,
  }) {
    try {
      const at = new AccessToken(key, secret, {
        identity: String(identity),
        ttl: ttlSeconds,
      });
      at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish,
        canSubscribe,
        canPublishData: false,
      });
      const token = await at.toJwt();
      return {
        ok: true,
        token,
        url,
        roomName,
        expiresIn: ttlSeconds,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return {
    name: 'livekit',
    isConfigured: true,
    async createSession({ auctionId, roomName, hostUserId }) {
      const room = roomName || `nomas-auction-${auctionId}`;
      const tokenResult = await mintToken({
        roomName: room,
        identity: hostUserId,
        canPublish: true,
        canSubscribe: true,
      });
      if (!tokenResult.ok) {
        return { ok: false, error: tokenResult.error, roomId: room };
      }
      return {
        ok: true,
        provider: 'livekit',
        roomId: room,
        roomName: room,
        url,
      };
    },
    mintToken,
    async endSession() {
      return { ok: true };
    },
  };
}

module.exports = { createLiveKitAudioProvider };
