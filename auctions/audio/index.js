'use strict';

const { AUDIO_PROVIDER } = require('../config');
const { createNoopAudioProvider } = require('./noop_provider');
const { createLiveKitAudioProvider } = require('./livekit_provider');
const { createAgoraAudioProvider } = require('./agora_provider');
const { DECISION } = require('./compare');

function createAuctionAudioProvider(name = AUDIO_PROVIDER) {
  const n = String(name || 'noop').toLowerCase();
  switch (n) {
    case 'livekit':
      return createLiveKitAudioProvider();
    case 'agora':
      return createAgoraAudioProvider();
    case 'noop':
    default:
      return createNoopAudioProvider();
  }
}

module.exports = {
  createAuctionAudioProvider,
  DECISION,
};
