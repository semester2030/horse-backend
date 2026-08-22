'use strict';

/**
 * LiveKit vs Agora — evidence-based V1 selection (audio-only, host publish / audience listen).
 *
 * | Criterion              | LiveKit              | Agora                |
 * |------------------------|----------------------|----------------------|
 * | Self-host option       | Yes                  | Limited              |
 * | Token model            | JWT room token       | RTC token            |
 * | Latency (typical)      | ~200-400ms           | ~200-400ms           |
 * | Node SDK maturity      | livekit-server-sdk   | agora-access-token   |
 * | Cost predictability    | Cloud + self-host    | Per-minute           |
 * | NOMAS fit (audio-only) | Strong SFU model     | Strong               |
 *
 * Decision for V1 foundation: **LiveKit preferred** when credentials available;
 * default **noop** until LIVEKIT_* env set. Agora remains swappable via AUCTION_AUDIO_PROVIDER.
 */
const DECISION = {
  selected: 'livekit',
  fallback: 'noop',
  rationale: [
    'Both suitable for one-to-many host audio; WebSocket unsuitable.',
    'LiveKit aligns with self-host path and clear JWT room tokens from backend.',
    'Neither wired without credentials — noop keeps bidding independent of audio.',
  ],
  wired: true,
  wiredWhen: 'LIVEKIT_* credentials configured or AUCTION_AUDIO_PROVIDER=noop for dev',
};

module.exports = { DECISION };
