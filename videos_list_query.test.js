'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterVideosByOwner,
  paginateList,
  videoOwnerId,
} = require('./videos_list_query');

function offer(id, userId, extras = {}) {
  return { id, userId, type: 'service', serviceCategory: 'supplies', ...extras };
}

test('videoOwnerId prefers userId then ownerId', () => {
  assert.equal(videoOwnerId({ userId: 'a', ownerId: 'b' }), 'a');
  assert.equal(videoOwnerId({ ownerId: 'b' }), 'b');
  assert.equal(videoOwnerId({}), '');
});

test('U07 store A never leaks store B across all pages', () => {
  const list = [];
  for (let i = 0; i < 200; i++) list.push(offer(`a-${i}`, 'store-a'));
  for (let i = 0; i < 40; i++) list.push(offer(`b-${i}`, 'store-b'));

  const scoped = filterVideosByOwner(list, 'store-a');
  assert.equal(scoped.length, 200);
  assert.ok(scoped.every((v) => v.userId === 'store-a'));

  let offset = 0;
  const pageSize = 24;
  const seen = new Set();
  while (offset < scoped.length) {
    const page = paginateList(scoped, { limit: pageSize, offset });
    for (const item of page.items) {
      assert.equal(item.userId, 'store-a');
      assert.ok(!String(item.id).startsWith('b-'));
      seen.add(item.id);
    }
    if (!page.hasMore) break;
    offset += page.items.length;
  }
  assert.equal(seen.size, 200);
});

test('U08 empty owner scope stays empty (no silent broaden)', () => {
  const list = [offer('x', 'other')];
  const scoped = filterVideosByOwner(list, 'missing-store');
  assert.equal(scoped.length, 0);
  const page = paginateList(scoped, { limit: 20, offset: 0 });
  assert.equal(page.items.length, 0);
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false);
});

test('U09 stale page metadata still belongs to requested owner only', () => {
  const a = filterVideosByOwner(
    [offer('a1', 'A'), offer('b1', 'B')],
    'A',
  );
  const b = filterVideosByOwner(
    [offer('a1', 'A'), offer('b1', 'B')],
    'B',
  );
  assert.deepEqual(
    a.map((v) => v.id),
    ['a1'],
  );
  assert.deepEqual(
    b.map((v) => v.id),
    ['b1'],
  );
});

test('paginateList legacy: no limit returns full array', () => {
  const list = [offer('1', 'u'), offer('2', 'u')];
  const page = paginateList(list, {});
  assert.equal(page.items.length, 2);
  assert.equal(page.limit, null);
  assert.equal(page.hasMore, false);
});

test('paginateList caps limit at 100', () => {
  const list = Array.from({ length: 150 }, (_, i) => offer(`i-${i}`, 'u'));
  const page = paginateList(list, { limit: 500, offset: 0 });
  assert.equal(page.limit, 100);
  assert.equal(page.items.length, 100);
  assert.equal(page.hasMore, true);
});
