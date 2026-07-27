/**
 * AcceptLockProvider — distributed-ready accept lock (T4.1 / ADR-015).
 *
 * Negotiation Engine depends only on this interface.
 * Current: InMemoryAcceptLockProvider (single process).
 * Future (documented, not implemented): RedisAcceptLockProvider,
 * DatabaseAcceptLockProvider — swap without changing accept business logic.
 *
 * Interface (sync):
 *   tryAcquire(key: string): boolean
 *   release(key: string): void
 *   readonly name: string
 *
 * No Redis / DB runtime dependency in this phase.
 */
'use strict';

/**
 * @typedef {Object} AcceptLockProvider
 * @property {string} name
 * @property {(key: string) => boolean} tryAcquire
 * @property {(key: string) => void} release
 */

/**
 * In-process Map lock — correct for one Node instance only.
 * @returns {AcceptLockProvider}
 */
function createInMemoryAcceptLockProvider() {
  /** @type {Map<string, true>} */
  const locks = new Map();
  return {
    name: 'InMemoryAcceptLockProvider',
    tryAcquire(key) {
      const k = String(key);
      if (locks.has(k)) return false;
      locks.set(k, true);
      return true;
    },
    release(key) {
      locks.delete(String(key));
    },
    /** Test helper */
    _size() {
      return locks.size;
    },
    _clear() {
      locks.clear();
    },
  };
}

/**
 * Future stub shape — not wired. Documents Redis migration contract.
 * Would use SET key NX PX ttl + DEL on release (or Redlock).
 */
function RedisAcceptLockProvider_SPEC() {
  return {
    name: 'RedisAcceptLockProvider',
    status: 'not_implemented',
    notes: [
      'SET accept:lock:{offerId} {owner} NX PX 15000',
      'release via Lua compare-and-del',
      'same tryAcquire/release interface; engine unchanged',
    ],
  };
}

/**
 * Future stub shape — not wired. Documents DB row-lock migration.
 */
function DatabaseAcceptLockProvider_SPEC() {
  return {
    name: 'DatabaseAcceptLockProvider',
    status: 'not_implemented',
    notes: [
      'BEGIN; SELECT … FROM negotiations WHERE id=$1 FOR UPDATE',
      'or advisory lock / unique accepted_offer constraint',
      'same tryAcquire/release interface; engine unchanged',
    ],
  };
}

/** Process-wide default used by negotiation_engine when no override passed. */
let defaultProvider = createInMemoryAcceptLockProvider();

function getAcceptLockProvider() {
  return defaultProvider;
}

/**
 * Swap provider (tests / future Redis bootstrap). Must implement the interface.
 * @param {AcceptLockProvider} provider
 */
function setAcceptLockProvider(provider) {
  if (
    !provider ||
    typeof provider.tryAcquire !== 'function' ||
    typeof provider.release !== 'function'
  ) {
    throw new Error('AcceptLockProvider requires tryAcquire and release');
  }
  defaultProvider = provider;
  return defaultProvider;
}

function resetAcceptLockProvider() {
  defaultProvider = createInMemoryAcceptLockProvider();
  return defaultProvider;
}

module.exports = {
  createInMemoryAcceptLockProvider,
  getAcceptLockProvider,
  setAcceptLockProvider,
  resetAcceptLockProvider,
  RedisAcceptLockProvider_SPEC,
  DatabaseAcceptLockProvider_SPEC,
};
