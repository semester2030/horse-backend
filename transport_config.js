/**
 * Centralized transport / negotiation configuration (T4.1).
 * Override via environment — no code change required for TTL.
 *
 * Env:
 *   OFFER_TTL_MS | TRANSPORT_OFFER_TTL_MS  — default offer lifetime (ms)
 *   WS_REPLAY_WINDOW                       — max sequenced events retained per request room
 *   WS_HEARTBEAT_MS                        — server ping interval
 *   WS_HEARTBEAT_TIMEOUT_MS                — disconnect if no pong
 */
'use strict';

const DEFAULT_OFFER_TTL_MS = 15 * 60 * 1000;
const MIN_OFFER_TTL_MS = 60 * 1000;
const MAX_OFFER_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_WS_REPLAY_WINDOW = 500;
const DEFAULT_WS_HEARTBEAT_MS = 25_000;
const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 60_000;

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Resolve offer TTL in ms from env + optional per-request override.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number|string|null|undefined} [overrideMs] — body.ttlMs when allowed
 */
function resolveOfferTtlMs(env = process.env, overrideMs) {
  const fromEnv = parsePositiveInt(
    env.OFFER_TTL_MS || env.TRANSPORT_OFFER_TTL_MS,
    DEFAULT_OFFER_TTL_MS,
  );
  const base = Math.min(MAX_OFFER_TTL_MS, Math.max(MIN_OFFER_TTL_MS, fromEnv));
  if (overrideMs == null || overrideMs === '') return base;
  const o = Number(overrideMs);
  if (!Number.isFinite(o)) return base;
  return Math.min(MAX_OFFER_TTL_MS, Math.max(MIN_OFFER_TTL_MS, Math.floor(o)));
}

function getTransportConfig(env = process.env) {
  return Object.freeze({
    offerTtlMs: resolveOfferTtlMs(env),
    minOfferTtlMs: MIN_OFFER_TTL_MS,
    maxOfferTtlMs: MAX_OFFER_TTL_MS,
    defaultOfferTtlMs: DEFAULT_OFFER_TTL_MS,
    wsReplayWindow: parsePositiveInt(
      env.WS_REPLAY_WINDOW,
      DEFAULT_WS_REPLAY_WINDOW,
    ),
    wsHeartbeatMs: parsePositiveInt(env.WS_HEARTBEAT_MS, DEFAULT_WS_HEARTBEAT_MS),
    wsHeartbeatTimeoutMs: parsePositiveInt(
      env.WS_HEARTBEAT_TIMEOUT_MS,
      DEFAULT_WS_HEARTBEAT_TIMEOUT_MS,
    ),
  });
}

module.exports = {
  DEFAULT_OFFER_TTL_MS,
  MIN_OFFER_TTL_MS,
  MAX_OFFER_TTL_MS,
  DEFAULT_WS_REPLAY_WINDOW,
  DEFAULT_WS_HEARTBEAT_MS,
  DEFAULT_WS_HEARTBEAT_TIMEOUT_MS,
  resolveOfferTtlMs,
  getTransportConfig,
};
