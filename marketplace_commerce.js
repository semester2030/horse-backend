/**
 * أتمتة تجارة المتجر (supplies): مخزون + حجز مؤقت + تحقق سلة + انتقالات حالة.
 * لا يستبدل مسارات /cart /orders — يُستدعى منها فقط.
 */

'use strict';

const SELLER_STATUS_TRANSITIONS = {
  paid: ['preparing', 'cancelled'],
  preparing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
};

const CUSTOMER_CANCEL_FROM = new Set(['paid', 'preparing']);
const ADMIN_CANCEL_FROM = new Set(['paid', 'preparing', 'shipped']);

/** حجز مخزون في السلة (مللي ثانية) */
const HOLD_TTL_MS = 30 * 60 * 1000;

function purgeExpiredHolds(product) {
  if (!product || !product.stockHolds || typeof product.stockHolds !== 'object') {
    return;
  }
  const now = Date.now();
  for (const [uid, h] of Object.entries(product.stockHolds)) {
    const t = h?.updatedAt ? new Date(h.updatedAt).getTime() : 0;
    const qty = Math.floor(Number(h?.qty) || 0);
    if (!t || now - t > HOLD_TTL_MS || qty < 1) {
      delete product.stockHolds[uid];
    }
  }
}

function heldExcluding(product, exceptUserId) {
  purgeExpiredHolds(product);
  let sum = 0;
  for (const [uid, h] of Object.entries(product.stockHolds || {})) {
    if (exceptUserId && String(uid) === String(exceptUserId)) continue;
    sum += Math.max(0, Math.floor(Number(h.qty) || 0));
  }
  return sum;
}

/**
 * @param {object} product
 * @param {{ forUserId?: string }} [opts] — يستثني حجز هذا المستخدم من الخصم
 */
function availableStock(product, opts = {}) {
  if (!product) return 0;
  if ((product.status || 'active') !== 'active') return 0;
  if (product.inStock === false) return 0;
  if (product.stockQuantity == null || product.stockQuantity === '') {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number(product.stockQuantity);
  if (!Number.isFinite(n) || n < 0) return 0;
  const base = Math.floor(n);
  const held = heldExcluding(product, opts.forUserId);
  return Math.max(0, base - held);
}

function setCartHold(product, userId, qty) {
  if (!product || !userId) return;
  if (product.stockQuantity == null || product.stockQuantity === '') return;
  purgeExpiredHolds(product);
  if (!product.stockHolds || typeof product.stockHolds !== 'object') {
    product.stockHolds = {};
  }
  const q = Math.floor(Number(qty) || 0);
  if (q < 1) {
    delete product.stockHolds[String(userId)];
    return;
  }
  product.stockHolds[String(userId)] = {
    qty: q,
    updatedAt: new Date().toISOString(),
  };
}

function clearCartHold(product, userId) {
  if (!product?.stockHolds || !userId) return;
  delete product.stockHolds[String(userId)];
}

function clearCartHoldsForUser(catalogItems, userId, catalogItemIds) {
  const ids = catalogItemIds || [];
  for (const cid of ids) {
    const p = catalogItems.get(String(cid));
    if (p) clearCartHold(p, userId);
  }
}

function normalizeStockQuantity(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function syncInStockFlag(product) {
  if (!product) return;
  if (product.stockQuantity == null || product.stockQuantity === '') {
    if (product.inStock == null) product.inStock = true;
    return;
  }
  product.inStock = Number(product.stockQuantity) > 0;
}

function decrementStock(product, qty) {
  const q = Math.max(1, Math.floor(Number(qty) || 1));
  if (product.stockQuantity == null || product.stockQuantity === '') {
    product.inStock = true;
    return;
  }
  product.stockQuantity = Math.max(0, Number(product.stockQuantity) - q);
  syncInStockFlag(product);
}

function restoreStock(product, qty) {
  const q = Math.max(1, Math.floor(Number(qty) || 1));
  if (product.stockQuantity == null || product.stockQuantity === '') {
    return;
  }
  product.stockQuantity = Math.max(0, Number(product.stockQuantity) + q);
  syncInStockFlag(product);
}

/**
 * يتحقق من بنود السلة مقابل الكتالوج الحالي.
 * @returns {{ ok: boolean, issues: Array, lines: Array }}
 */
function validateCartLines(cartItems, catalogMap, opts = {}) {
  const issues = [];
  const lines = [];
  const forUserId = opts.forUserId;
  for (const line of cartItems || []) {
    const id = String(line.catalogItemId || '');
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
    const product = catalogMap.get(id);
    if (!product || product.category !== 'supplies') {
      issues.push({
        catalogItemId: id,
        code: 'NOT_FOUND',
        message: 'منتج غير موجود أو لم يعد من المتجر',
      });
      continue;
    }
    if ((product.status || 'active') !== 'active') {
      issues.push({
        catalogItemId: id,
        code: 'INACTIVE',
        message: `${product.name || id}: المنتج موقوف`,
      });
      continue;
    }
    const avail = availableStock(product, { forUserId });
    if (avail < qty) {
      issues.push({
        catalogItemId: id,
        code: 'OUT_OF_STOCK',
        message:
          avail <= 0
            ? `${product.name || id}: نفذ من المخزون`
            : `${product.name || id}: المتاح ${avail} فقط (مطلوب ${qty})`,
        available: avail === Number.POSITIVE_INFINITY ? null : avail,
      });
      continue;
    }
    const unit = Number(product.price) || 0;
    const imageUrl =
      Array.isArray(product.images) && product.images.length > 0
        ? product.images[0]
        : '';
    lines.push({
      catalogItemId: product.id,
      quantity: qty,
      title: product.name || '',
      unitPrice: unit,
      imageUrl,
      sellerId: product.sellerId,
      product,
    });
  }
  return { ok: issues.length === 0 && lines.length > 0, issues, lines };
}

function canSellerTransition(from, to) {
  const allowed = SELLER_STATUS_TRANSITIONS[String(from || '')] || [];
  return allowed.includes(String(to || ''));
}

function canCustomerCancel(from) {
  return CUSTOMER_CANCEL_FROM.has(String(from || ''));
}

function canAdminTransition(from, to) {
  if (String(to) === 'cancelled') {
    return ADMIN_CANCEL_FROM.has(String(from || ''));
  }
  return canSellerTransition(from, to);
}

function shouldRestoreStock(previousStatus, nextStatus, stockDeducted) {
  if (!stockDeducted) return false;
  if (String(nextStatus) !== 'cancelled') return false;
  const prev = String(previousStatus || '');
  return prev === 'paid' || prev === 'preparing' || prev === 'shipped';
}

/**
 * تطبيق انتقال حالة طلب مع استعادة مخزون عند الإلغاء.
 * role: 'seller' | 'customer' | 'admin'
 */
function applyOrderStatusChange({
  order,
  nextStatus,
  catalogItems,
  role,
  trackingNumber,
}) {
  const prev = String(order.status || '');
  const next = String(nextStatus || '');
  if (!next || next === prev) {
    return { ok: true, order, changed: false };
  }

  let allowed = false;
  if (role === 'admin') allowed = canAdminTransition(prev, next);
  else if (role === 'seller') allowed = canSellerTransition(prev, next);
  else if (role === 'customer') {
    allowed = next === 'cancelled' && canCustomerCancel(prev);
  }

  if (!allowed) {
    return {
      ok: false,
      message: `انتقال غير مسموح من ${prev} إلى ${next}`,
    };
  }

  const updated = {
    ...order,
    status: next,
    updatedAt: new Date().toISOString(),
  };
  if (trackingNumber != null) {
    updated.trackingNumber = String(trackingNumber);
  }

  if (shouldRestoreStock(prev, next, order.stockDeducted)) {
    for (const line of order.lines || []) {
      const product = catalogItems.get(String(line.catalogItemId || ''));
      if (!product) continue;
      restoreStock(product, line.quantity || 1);
      catalogItems.set(product.id, product);
    }
    updated.stockDeducted = false;
    updated.stockRestoredAt = new Date().toISOString();
  }

  return { ok: true, order: updated, changed: true };
}

module.exports = {
  SELLER_STATUS_TRANSITIONS,
  HOLD_TTL_MS,
  availableStock,
  setCartHold,
  clearCartHold,
  clearCartHoldsForUser,
  normalizeStockQuantity,
  syncInStockFlag,
  decrementStock,
  restoreStock,
  validateCartLines,
  canSellerTransition,
  canCustomerCancel,
  canAdminTransition,
  shouldRestoreStock,
  applyOrderStatusChange,
};
