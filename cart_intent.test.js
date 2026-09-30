'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addToCart } = require('./cart_intent');

function storeWithProduct() {
  const product = {
    id: 'item-1',
    sellerId: 'seller-1',
    category: 'supplies',
    status: 'active',
    inStock: true,
    name: 'لجام',
    price: 80,
    stockQuantity: 5,
    images: ['https://cdn.example/bridle.jpg'],
  };
  return {
    carts: new Map(),
    cartMutations: new Map(),
    catalogItems: new Map([[product.id, product]]),
  };
}

test('two intentional adds increase quantity and the same attempt does not', () => {
  const store = storeWithProduct();
  const first = addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'm1' },
  });
  assert.equal(first.cart.items[0].quantity, 1);
  const second = addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'm2' },
  });
  const replay = addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'm2' },
  });
  assert.equal(second.cart.items[0].quantity, 2);
  assert.equal(replay.replay, true);
  assert.equal(replay.cart.items[0].quantity, 2);
});

test('emptying the cart then using a new intent adds the product again', () => {
  const store = storeWithProduct();
  addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'm1' },
  });
  store.carts.set('buyer-1', { userId: 'buyer-1', items: [] });
  const again = addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'm3' },
  });
  assert.equal(again.replay, false);
  assert.equal(again.cart.items[0].quantity, 1);
});

test('the same mutation id with a different quantity is rejected', () => {
  const store = storeWithProduct();
  addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'm1' },
  });
  const clash = addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 2, clientMutationId: 'm1' },
  });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'MUTATION_PAYLOAD_MISMATCH');
  assert.equal(store.carts.get('buyer-1').items[0].quantity, 1);
});

test('buyers do not share mutation keys or carts', () => {
  const store = storeWithProduct();
  addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'same' },
  });
  const other = addToCart({
    store,
    userId: 'buyer-2',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'same' },
  });
  assert.equal(other.replay, false);
  assert.equal(other.cart.items[0].quantity, 1);
  assert.equal(store.carts.get('buyer-1').items[0].quantity, 1);
});

test('a missing price is not added as zero', () => {
  const store = storeWithProduct();
  store.catalogItems.get('item-1').price = 0;
  const result = addToCart({
    store,
    userId: 'buyer-1',
    body: { catalogItemId: 'item-1', quantity: 1, clientMutationId: 'm1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRICE_MISSING');
  assert.equal(store.carts.has('buyer-1'), false);
});
