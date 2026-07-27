/**
 * Shared technical layer for vertical transactions.
 * NOT a unified business Booking Engine — business rules stay per-vertical.
 *
 * Provides: Idempotency · Concurrency locks · Audit · Safe cancellation helpers.
 */
'use strict';

const MAX_AUDIT = 2000;
const MAX_IDEMPOTENCY = 5000;

function ensureMaps(store) {
  if (!store.idempotencyKeys || typeof store.idempotencyKeys.set !== 'function') {
    store.idempotencyKeys = new Map(
      store.idempotencyKeys && typeof store.idempotencyKeys === 'object'
        ? Object.entries(store.idempotencyKeys)
        : [],
    );
  }
  if (!Array.isArray(store.auditEvents)) {
    store.auditEvents = store.auditEvents || [];
  }
}

/** In-process mutex (Node request handlers are sync for store mutations). */
const _locks = new Map();

function withLock(resourceKey, fn) {
  const key = String(resourceKey || '*');
  if (_locks.get(key)) {
    // Nested or concurrent attempt — still run sync; Node won't interleave sync code.
    // Queue marker prevents accidental re-entry confusion in future async paths.
  }
  _locks.set(key, true);
  try {
    return fn();
  } finally {
    _locks.delete(key);
  }
}

function readIdempotencyKey(req, body) {
  const h =
    req?.headers?.['idempotency-key'] ||
    req?.headers?.['Idempotency-Key'] ||
    body?.idempotencyKey ||
    body?.clientRequestId;
  if (h == null || h === '') return null;
  return String(h).trim().slice(0, 128);
}

function idempotencyLookup(store, userId, key) {
  ensureMaps(store);
  if (!key) return null;
  const id = `${userId}::${key}`;
  const hit = store.idempotencyKeys.get(id);
  if (!hit) return null;
  return hit;
}

function idempotencyRemember(store, userId, key, bookingId) {
  ensureMaps(store);
  if (!key || !bookingId) return;
  const id = `${userId}::${key}`;
  store.idempotencyKeys.set(id, {
    bookingId: String(bookingId),
    userId: String(userId),
    key: String(key),
    at: new Date().toISOString(),
  });
  if (store.idempotencyKeys.size > MAX_IDEMPOTENCY) {
    const first = store.idempotencyKeys.keys().next().value;
    store.idempotencyKeys.delete(first);
  }
}

function appendAudit(store, idFn, entry) {
  ensureMaps(store);
  try {
    store.auditEvents.unshift({
      id: typeof idFn === 'function' ? idFn() : `${Date.now()}-aud`,
      at: new Date().toISOString(),
      ...entry,
    });
    if (store.auditEvents.length > MAX_AUDIT) {
      store.auditEvents.length = MAX_AUDIT;
    }
  } catch (_) {
    /* audit optional */
  }
}

/**
 * Safe cancellation gate — customer may only cancel from early statuses.
 * Does not encode vertical business rules.
 */
function canSafelyCancel({ prevStatus, nextStatus, isCustomer, isProvider, canCustomerCancel, canProviderTransition }) {
  if (!nextStatus || nextStatus === prevStatus) {
    return { ok: true };
  }
  if (isCustomer && !isProvider) {
    if (nextStatus !== 'cancelled') {
      return { ok: false, status: 403, message: 'يمكن للعميل إلغاء الحجز فقط (حالة cancelled)' };
    }
    if (!canCustomerCancel(prevStatus)) {
      return { ok: false, status: 400, message: 'لا يمكن إلغاء الحجز في هذه المرحلة' };
    }
    return { ok: true, releasing: true };
  }
  if (isProvider && nextStatus === 'cancelled') {
    if (!canProviderTransition(prevStatus, nextStatus)) {
      return {
        ok: false,
        status: 400,
        message: `انتقال غير مسموح من ${prevStatus} إلى ${nextStatus}`,
      };
    }
    return { ok: true, releasing: true };
  }
  if (isProvider) {
    if (!canProviderTransition(prevStatus, nextStatus)) {
      return {
        ok: false,
        status: 400,
        message: `انتقال غير مسموح من ${prevStatus} إلى ${nextStatus}`,
      };
    }
  }
  return { ok: true };
}

function isTerminalReleaseStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'cancelled' || s === 'canceled' || s === 'expired' || s === 'rejected';
}

module.exports = {
  withLock,
  readIdempotencyKey,
  idempotencyLookup,
  idempotencyRemember,
  appendAudit,
  canSafelyCancel,
  isTerminalReleaseStatus,
  ensureMaps,
};
