'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Mirrors GET /catalog/items/:id visibility rules (active public, opaque 404).
 */
function canPublicReadCatalogItem(item, viewerId) {
  if (!item) return { ok: false, code: 404 };
  const status = String(item.status || 'active');
  const isOwner =
    Boolean(viewerId) && String(item.sellerId || '') === String(viewerId);
  if (status !== 'active' && !isOwner) return { ok: false, code: 404 };
  return { ok: true, code: 200 };
}

test('active supplies item is readable without session', () => {
  const r = canPublicReadCatalogItem(
    {
      id: '1790810195856-1ag9j6o9q',
      sellerId: '1782530343489-n1lnyh1bb',
      status: 'active',
      category: 'supplies',
      price: 350,
      stockQuantity: 200,
    },
    null,
  );
  assert.equal(r.ok, true);
  assert.equal(r.code, 200);
});

test('paused item is opaque 404 to strangers', () => {
  const r = canPublicReadCatalogItem(
    { id: 'x', sellerId: 'owner', status: 'paused', price: 10 },
    'stranger',
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test('owner can read own paused item', () => {
  const r = canPublicReadCatalogItem(
    { id: 'x', sellerId: 'owner', status: 'paused', price: 10 },
    'owner',
  );
  assert.equal(r.ok, true);
});
