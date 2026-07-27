/**
 * Feed vertical — product sale stock rules (atomic reserve / restore).
 * Business logic owned by Feed; uses shared locks from vertical_txn_primitives.
 */
'use strict';

const { withLock } = require('./vertical_txn_primitives');

function productLists(service) {
  if (!service || typeof service !== 'object') return [];
  const out = [];
  if (Array.isArray(service.products)) out.push(service.products);
  if (Array.isArray(service.catalog)) out.push(service.catalog);
  return out;
}

function findProduct(service, productId) {
  const pid = String(productId || '').trim();
  if (!pid) return null;
  for (const list of productLists(service)) {
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      if (String(p.id || p.productId || '') === pid) {
        return p;
      }
    }
  }
  return null;
}

function readAvailable(product) {
  if (product.availableQuantity != null && product.availableQuantity !== '') {
    return Number(product.availableQuantity);
  }
  if (product.stock != null && product.stock !== '') {
    return Number(product.stock);
  }
  if (product.stockQuantity != null && product.stockQuantity !== '') {
    return Number(product.stockQuantity);
  }
  if (product.quantity != null && product.quantity !== '') {
    return Number(product.quantity);
  }
  return null;
}

function writeAvailable(product, next) {
  const n = Math.max(0, Math.floor(next));
  if (product.availableQuantity != null || product.availableQuantity === 0) {
    product.availableQuantity = n;
  }
  if (product.stock != null || product.stock === 0) {
    product.stock = n;
  }
  if (product.stockQuantity != null || product.stockQuantity === 0) {
    product.stockQuantity = n;
  }
  if (
    product.availableQuantity == null &&
    product.stock == null &&
    product.stockQuantity == null
  ) {
    product.availableQuantity = n;
  }
  if (product.inStock != null) {
    product.inStock = n > 0;
  }
  if (product.stockStatus != null || n === 0) {
    product.stockStatus = n <= 0 ? 'out_of_stock' : n <= 5 ? 'limited' : 'in_stock';
  }
}

/**
 * Atomically reserve feed stock on the provider service record.
 * @returns {{ ok: boolean, code?: string, message?: string, reserved?: number }}
 */
function reserveFeedStock({ service, productId, quantity }) {
  const qty = Math.floor(Number(quantity));
  if (!Number.isFinite(qty) || qty < 1) {
    return { ok: false, code: 'INVALID_QTY', message: 'كمية غير صالحة' };
  }
  if (!service) {
    return { ok: false, code: 'SERVICE_MISSING', message: 'خدمة الأعلاف غير موجودة' };
  }
  const lockKey = `feed:${service.id}:${productId}`;
  return withLock(lockKey, () => {
    const product = findProduct(service, productId);
    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_FOUND',
        message: 'المنتج غير موجود لدى المزوّد',
      };
    }
    if (product.active === false || product.status === 'inactive') {
      return { ok: false, code: 'INACTIVE', message: 'المنتج غير متاح' };
    }
    const avail = readAvailable(product);
    if (avail == null || !Number.isFinite(avail)) {
      return {
        ok: false,
        code: 'STOCK_UNKNOWN',
        message: 'كمية المخزون غير معرّفة — لا يمكن إتمام الطلب بأمان',
      };
    }
    if (avail < qty) {
      return {
        ok: false,
        code: 'OUT_OF_STOCK',
        message: `المخزون غير كافٍ (المتاح ${Math.floor(avail)})`,
        available: Math.floor(avail),
      };
    }
    writeAvailable(product, avail - qty);
    return { ok: true, reserved: qty, remaining: Math.floor(avail - qty) };
  });
}

function restoreFeedStock({ service, productId, quantity }) {
  const qty = Math.floor(Number(quantity));
  if (!service || !productId || !Number.isFinite(qty) || qty < 1) {
    return { ok: false };
  }
  const lockKey = `feed:${service.id}:${productId}`;
  return withLock(lockKey, () => {
    const product = findProduct(service, productId);
    if (!product) return { ok: false };
    const avail = readAvailable(product);
    const base = Number.isFinite(avail) ? avail : 0;
    writeAvailable(product, base + qty);
    return { ok: true, remaining: base + qty };
  });
}

function feedQtyFromBooking(booking) {
  const d =
    booking?.details && typeof booking.details === 'object' ? booking.details : {};
  const q = Number(d.quantity ?? booking.quantity ?? 0);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 0;
}

function feedProductIdFromBooking(booking) {
  const d =
    booking?.details && typeof booking.details === 'object' ? booking.details : {};
  return String(d.productId || booking.productId || '').trim();
}

function shouldRestoreFeedStock(booking) {
  if (!booking) return false;
  if (booking.stockDeducted !== true && booking.stockReserved !== true) {
    return false;
  }
  if (booking.stockRestored === true) return false;
  return true;
}

module.exports = {
  findProduct,
  readAvailable,
  reserveFeedStock,
  restoreFeedStock,
  feedQtyFromBooking,
  feedProductIdFromBooking,
  shouldRestoreFeedStock,
};
