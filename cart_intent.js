'use strict';

const marketplaceCommerce = require('./marketplace_commerce');

function mutationKey(userId, mutationId) {
  return `${userId}::${mutationId}`;
}

/**
 * Adds a supplies line to the existing cart.
 * A mutation id replays the same user/product/quantity and rejects a different payload.
 */
function addToCart({ store, userId, body }) {
  const catalogItemId = String(body?.catalogItemId || '');
  const qty = Math.max(1, parseInt(body?.quantity, 10) || 1);
  const mutationId = String(body?.clientMutationId || '').trim();
  if (!store.cartMutations) store.cartMutations = new Map();
  const key = mutationId ? mutationKey(userId, mutationId) : '';
  if (key && store.cartMutations.has(key)) {
    const prev = store.cartMutations.get(key);
    const same = String(prev.catalogItemId) === catalogItemId
      && Number(prev.quantity) === qty
      && String(prev.userId) === String(userId);
    if (!same) {
      return {
        ok: false,
        status: 409,
        code: 'MUTATION_PAYLOAD_MISMATCH',
        message: 'مفتاح الإضافة مستخدم لعملية مختلفة',
      };
    }
    const cart = store.carts.get(userId) || { userId, items: [], updatedAt: prev.at };
    return { ok: true, status: 200, cart, replay: true };
  }

  const product = store.catalogItems.get(catalogItemId);
  if (!product || product.category !== 'supplies') {
    return { ok: false, status: 400, message: 'المنتج غير موجود أو ليس من قسم الأدوات' };
  }
  if ((product.status || 'active') !== 'active' || product.inStock === false) {
    return { ok: false, status: 400, message: 'المنتج غير متوفر' };
  }
  if (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0) {
    return { ok: false, status: 400, code: 'PRICE_MISSING', message: 'سعر المنتج غير صالح للشراء' };
  }
  let cart = store.carts.get(userId);
  if (!cart) cart = { userId, items: [], updatedAt: new Date().toISOString() };
  const idx = cart.items.findIndex((line) => line.catalogItemId === product.id);
  const currentQty = idx >= 0 ? cart.items[idx].quantity || 0 : 0;
  const nextQty = currentQty + qty;
  const avail = marketplaceCommerce.availableStock(product, { forUserId: userId });
  if (avail < nextQty) {
    const availLabel = avail === Number.POSITIVE_INFINITY ? null : avail;
    return {
      ok: false,
      status: 409,
      code: 'OUT_OF_STOCK',
      message: avail <= 0 ? 'المنتج نفذ من المخزون' : `الكمية المتاحة ${availLabel} فقط`,
    };
  }
  const imageUrl = Array.isArray(product.images) && product.images.length > 0
    ? product.images[0]
    : '';
  const snapshot = {
    name: product.name,
    price: Number(product.price) || 0,
    imageUrl,
    sellerId: product.sellerId,
    unit: product.unit || '',
    subCategory: product.subCategory || '',
  };
  if (idx >= 0) {
    cart.items[idx].quantity = nextQty;
    cart.items[idx].snapshot = snapshot;
  } else {
    cart.items.push({ catalogItemId: product.id, quantity: qty, snapshot });
  }
  marketplaceCommerce.setCartHold(product, userId, nextQty);
  store.catalogItems.set(product.id, product);
  cart.updatedAt = new Date().toISOString();
  store.carts.set(userId, cart);
  if (key) {
    store.cartMutations.set(key, {
      userId,
      catalogItemId: product.id,
      quantity: qty,
      at: cart.updatedAt,
    });
  }
  return { ok: true, status: 200, cart, replay: false };
}

module.exports = { addToCart, mutationKey };
