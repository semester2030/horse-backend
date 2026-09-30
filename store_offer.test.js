'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publishStoreOffer, syncCommercialFromVideo } = require('./store_offer');
const { catalogItemToPlacePayload } = require('./geo_discovery/adapters/catalog_place_adapter');
const {
  SELLER_STATUS_TRANSITIONS,
  shouldRestoreStock,
  canCustomerCancel,
  assertCashCollection,
} = require('./marketplace_commerce');

function freshStore() {
  return { videos: new Map(), catalogItems: new Map(), storeOfferAttempts: new Map() };
}

let seq = 0;
const createId = () => `id-${++seq}`;

test('informational photo offer does not create a catalog item', () => {
  const store = freshStore();
  const result = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'attempt-info',
      serviceName: 'تعريف السرج',
      targetSpecies: 'horse',
      purchasable: false,
      primaryImages: [{ id: 'img-1', url: 'https://cdn.example/a.jpg' }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.catalogItem, null);
  assert.equal(store.catalogItems.size, 0);
  assert.equal(result.payload.video.primaryImages.length, 1);
  assert.equal(result.payload.video.hidden, false);
});

test('commercial photo offer reuses one supplies record and retries the same ids', () => {
  const store = freshStore();
  const body = {
    idempotencyKey: 'attempt-sale',
    serviceName: 'لجام',
    targetSpecies: 'camel',
    purchasable: true,
    price: 250,
    stockQuantity: 4,
    primaryImages: [{ url: 'https://cdn.example/bridle.jpg' }],
    detailMedia: [{ id: 'd1', url: 'https://cdn.example/detail.m3u8', type: 'video', role: 'DETAIL_VIDEO' }],
  };
  const first = publishStoreOffer({ store, userId: 'seller-1', createId, body });
  assert.equal(first.status, 201);
  assert.equal(first.payload.catalogItem.category, 'supplies');
  assert.equal(first.payload.catalogItem.listingChannel, 'video_store');
  assert.equal(first.payload.catalogItem.status, 'active');
  assert.equal(first.payload.catalogItem.images[0], 'https://cdn.example/bridle.jpg');
  assert.equal(first.payload.video.catalogItemId, first.payload.catalogItem.id);
  const second = publishStoreOffer({ store, userId: 'seller-1', createId, body });
  assert.equal(second.replay, true);
  assert.equal(store.videos.size, 1);
  assert.equal(store.catalogItems.size, 1);
  assert.equal(second.payload.video.id, first.payload.video.id);
});

test('missing stock is rejected and does not invent 100', () => {
  const store = freshStore();
  const result = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'no-stock',
      serviceName: 'حبل',
      targetSpecies: 'horse',
      purchasable: true,
      price: 10,
      primaryImages: [{ url: 'https://cdn.example/rope.jpg' }],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(store.catalogItems.size, 0);
});

test('zero price cannot be purchased', () => {
  const store = freshStore();
  const result = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'zero',
      serviceName: 'مجاني',
      targetSpecies: 'falcon',
      purchasable: true,
      price: 0,
      stockQuantity: 3,
      primaryImages: [{ url: 'https://cdn.example/free.jpg' }],
    },
  });
  assert.equal(result.ok, false);
});

test('video store catalog row is not a services-map place', () => {
  const place = catalogItemToPlacePayload({
    id: 'c-store',
    category: 'supplies',
    listingChannel: 'video_store',
    name: 'متجر',
    sellerId: 'u',
    status: 'active',
    location: { lat: 24.7, lng: 46.7 },
    images: ['https://cdn.example/a.jpg'],
  });
  assert.equal(place, null);
  const feed = catalogItemToPlacePayload({
    id: 'c-feed',
    category: 'feed',
    name: 'شعير',
    sellerId: 'u',
    status: 'active',
    location: { lat: 24.7, lng: 46.7 },
    images: ['https://cdn.example/b.jpg'],
  });
  assert.equal(feed.categories[0], 'feed');
});

test('resume after catalog save does not create a second product', () => {
  const store = freshStore();
  const body = {
    idempotencyKey: 'partial',
    serviceName: 'غطاء',
    targetSpecies: 'horse',
    purchasable: true,
    price: 80,
    stockQuantity: 2,
    primaryImages: [{ url: 'https://cdn.example/cover.jpg' }],
  };
  store.storeOfferAttempts.set('seller-1::partial', {
    status: 'catalog_saved',
    catalogItemId: 'kept-id',
    videoId: null,
    userId: 'seller-1',
  });
  store.catalogItems.set('kept-id', {
    id: 'kept-id',
    sellerId: 'seller-1',
    category: 'supplies',
    listingChannel: 'video_store',
    status: 'draft',
    name: 'قديم',
    price: 1,
    stockQuantity: 2,
  });
  const result = publishStoreOffer({ store, userId: 'seller-1', createId, body });
  assert.equal(result.ok, true);
  assert.equal(store.catalogItems.size, 1);
  assert.equal(result.payload.catalogItem.id, 'kept-id');
  assert.equal(result.payload.catalogItem.name, 'غطاء');
  assert.equal(result.payload.catalogItem.status, 'active');
});

test('same attempt with a different payload does not pretend the edit was saved', () => {
  const store = freshStore();
  const body = {
    idempotencyKey: 'attempt-sale',
    serviceName: 'لجام',
    targetSpecies: 'camel',
    purchasable: true,
    price: 250,
    stockQuantity: 4,
    primaryImages: [{ url: 'https://cdn.example/bridle.jpg' }],
  };
  const first = publishStoreOffer({ store, userId: 'seller-1', createId, body });
  const changed = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: { ...body, price: 300 },
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.status, 409);
  assert.equal(changed.code, 'PAYLOAD_MISMATCH');
  assert.equal(store.catalogItems.get(first.payload.catalogItem.id).price, 250);
  assert.equal(store.videos.size, 1);
});

test('same attempt with a different subCategory is not a silent success', () => {
  const store = freshStore();
  const body = {
    idempotencyKey: 'subcat-lock',
    serviceName: 'وكر',
    targetSpecies: 'falcon',
    subCategory: 'أقفاص',
    purchasable: true,
    price: 90,
    stockQuantity: 1,
    primaryImages: [{ url: 'https://cdn.example/cage.jpg' }],
  };
  publishStoreOffer({ store, userId: 'seller-1', createId, body });
  const changed = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: { ...body, subCategory: 'برقع' },
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'PAYLOAD_MISMATCH');
});

test('existing owned catalogItemId is reused for a visual offer', () => {
  const store = freshStore();
  store.catalogItems.set('cat-old', {
    id: 'cat-old',
    sellerId: 'seller-1',
    category: 'supplies',
    name: 'قديم',
    price: 40,
    stockQuantity: 3,
    status: 'active',
  });
  const result = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'reuse-cat',
      catalogItemId: 'cat-old',
      serviceName: 'قديم مع عرض',
      targetSpecies: 'horse',
      purchasable: true,
      price: 55,
      stockQuantity: 3,
      primaryImages: [{ url: 'https://cdn.example/old.jpg' }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.catalogItem.id, 'cat-old');
  assert.equal(store.catalogItems.size, 1);
  assert.equal(result.payload.video.catalogItemId, 'cat-old');
});

test('a video media edit does not copy a stale video price over the catalog', () => {
  const store = freshStore();
  const published = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'price-lock',
      serviceName: 'سرج',
      targetSpecies: 'horse',
      purchasable: true,
      price: 100,
      stockQuantity: 2,
      primaryImages: [{ url: 'https://cdn.example/saddle.jpg' }],
    },
  });
  const item = published.payload.catalogItem;
  item.price = 175;
  const video = published.payload.video;
  video.primaryImages = [{ id: 'n', url: 'https://cdn.example/saddle-2.jpg', order: 0 }];
  const synced = syncCommercialFromVideo(store, video, {
    primaryImages: video.primaryImages,
  });
  assert.equal(synced.changed, true);
  assert.equal(item.price, 175);
  assert.equal(item.images[0], 'https://cdn.example/saddle-2.jpg');
});

test('a cloudflare id without an https playback url is not a video', () => {
  const store = freshStore();
  const result = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'fake-video',
      serviceName: 'وهم',
      targetSpecies: 'horse',
      purchasable: false,
      cloudflareVideoId: 'not-a-video',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(store.videos.size, 0);
});

test('invalid detail media is rejected', () => {
  const store = freshStore();
  const result = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'bad-detail',
      serviceName: 'تفاصيل',
      targetSpecies: 'falcon',
      purchasable: false,
      primaryImages: [{ url: 'https://cdn.example/a.jpg' }],
      detailMedia: [{ url: 'notaurl', type: 'image' }],
    },
  });
  assert.equal(result.ok, false);
});

test('sold out commercial offer keeps its catalog link', () => {
  const store = freshStore();
  const result = publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'empty-stock',
      serviceName: 'نافد',
      targetSpecies: 'horse',
      purchasable: true,
      price: 40,
      stockQuantity: 0,
      primaryImages: [{ url: 'https://cdn.example/gone.jpg' }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.video.offerIntent, 'commercial');
  assert.ok(result.payload.catalogItem);
  assert.equal(result.payload.catalogItem.inStock, false);
  assert.equal(result.payload.video.purchasable, false);
});

test('collection is refused for a cancelled or undelivered cash order', () => {
  assert.equal(assertCashCollection({
    status: 'cancelled',
    paymentMethod: 'cash',
    paymentStatus: 'unpaid',
  }).ok, false);
  assert.equal(assertCashCollection({
    status: 'placed',
    paymentMethod: 'cash',
    paymentStatus: 'unpaid',
  }).ok, false);
  assert.equal(assertCashCollection({
    status: 'delivered',
    paymentMethod: 'cash',
    paymentStatus: 'unpaid',
  }).ok, true);
  assert.equal(assertCashCollection({
    status: 'delivered',
    paymentMethod: 'cash',
    paymentStatus: 'collected',
  }).ok, false);
});

test('completed attempts survive a JSON reload', () => {
  const store = freshStore();
  publishStoreOffer({
    store,
    userId: 'seller-1',
    createId,
    body: {
      idempotencyKey: 'persist',
      serviceName: 'ثابت',
      targetSpecies: 'horse',
      purchasable: false,
      primaryImages: [{ url: 'https://cdn.example/keep.jpg' }],
    },
  });
  const raw = JSON.parse(JSON.stringify({
    storeOfferAttempts: Object.fromEntries(store.storeOfferAttempts),
  }));
  const reloaded = new Map(Object.entries(raw.storeOfferAttempts));
  assert.equal(reloaded.get('seller-1::persist').status, 'completed');
  assert.equal(reloaded.get('seller-1::persist').videoId, store.videos.keys().next().value);
});

test('new cash orders can move from placed without treating collection as paid', () => {
  assert.ok(SELLER_STATUS_TRANSITIONS.placed.includes('preparing'));
  assert.equal(canCustomerCancel('placed'), true);
  assert.equal(shouldRestoreStock('placed', 'cancelled', true), true);
  assert.equal(shouldRestoreStock('paid', 'cancelled', true), true);
});
