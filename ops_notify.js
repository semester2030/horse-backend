/**
 * إشعارات أحداث عبر صندوق الرسائل الحالي (بدون مسار/شاشة موازية).
 * fromUserId = system — تظهر في GET /messages للمستقبل.
 */

'use strict';

const SYSTEM_USER_ID = 'system';

function ensureMessages(store) {
  if (!Array.isArray(store.messages)) store.messages = [];
}

/**
 * @param {{ store: object, id: Function, saveStore?: Function }} ctx
 * @param {{ userId: string, title: string, body?: string, meta?: object }} payload
 */
function notifyUser(ctx, payload) {
  const userId = String(payload?.userId || '').trim();
  if (!userId || userId === SYSTEM_USER_ID) return null;
  ensureMessages(ctx.store);
  const title = String(payload.title || 'تنبيه').trim();
  const body = String(payload.body || '').trim();
  const text = body ? `${title}\n${body}` : title;
  const msg = {
    id: ctx.id(),
    fromUserId: SYSTEM_USER_ID,
    toUserId: userId,
    text,
    kind: 'notification',
    meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {},
    createdAt: new Date().toISOString(),
    read: false,
  };
  ctx.store.messages.push(msg);
  return msg;
}

function notifyMany(ctx, userIds, payload) {
  const seen = new Set();
  const out = [];
  for (const uid of userIds || []) {
    const id = String(uid || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const m = notifyUser(ctx, { ...payload, userId: id });
    if (m) out.push(m);
  }
  return out;
}

module.exports = {
  SYSTEM_USER_ID,
  notifyUser,
  notifyMany,
};
