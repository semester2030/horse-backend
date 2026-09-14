'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeDetailMedia,
  applyDetailMediaToBody,
} = require('./detail_media');

describe('detail_media sanitize', () => {
  it('allows missing detailMedia (backward compatible)', () => {
    const r = applyDetailMediaToBody({ name: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.body.detailMedia, undefined);
  });

  it('rejects non-https url', () => {
    const r = sanitizeDetailMedia([
      { id: '1', url: 'ftp://x', type: 'image', role: 'DETAIL_IMAGE', order: 0 },
    ]);
    assert.equal(r.ok, false);
  });

  it('accepts mixed gallery and syncs legacy fields', () => {
    const r = sanitizeDetailMedia([
      {
        id: 'i1',
        url: 'https://cdn.example/i1.jpg',
        type: 'image',
        role: 'DETAIL_IMAGE',
        order: 0,
      },
      {
        id: 'v1',
        url: 'https://cdn.example/v1.m3u8',
        type: 'video',
        role: 'DETAIL_VIDEO',
        order: 1,
      },
      {
        id: 'v2',
        url: 'https://cdn.example/v2.m3u8',
        type: 'video',
        role: 'DETAIL_VIDEO',
        order: 2,
      },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.detailMedia.length, 3);
    assert.deepEqual(r.images, ['https://cdn.example/i1.jpg']);
    assert.equal(r.videoId, 'v1');
    assert.equal(r.videoUrl, 'https://cdn.example/v1.m3u8');
  });

  it('enforces existing heritage maxItems=15', () => {
    const arr = [];
    for (let i = 0; i < 16; i++) {
      arr.push({
        id: `i${i}`,
        url: `https://cdn.example/${i}.jpg`,
        type: 'image',
        role: 'DETAIL_IMAGE',
        order: i,
      });
    }
    const r = sanitizeDetailMedia(arr, { maxItems: 15 });
    assert.equal(r.ok, false);
  });
});
