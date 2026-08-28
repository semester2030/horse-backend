'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cleanup = require('./video_media_cleanup');
const videoOwnership = require('./video_ownership');

describe('video_media_cleanup durability', () => {
  it('repeated replacement keeps both old UIDs on the queue', () => {
    let v = {
      id: 'v1',
      cloudflareVideoId: 'A',
      hlsUrl: 'https://a/manifest/video.m3u8',
      likes: 9,
    };
    v = videoOwnership.applyMediaSwitch(v, {
      cloudflareVideoId: 'B',
      hlsUrl: 'https://b/manifest/video.m3u8',
    });
    assert.deepEqual(v.pendingCleanupCloudflareVideoIds, ['A']);
    assert.equal(v.cloudflareVideoId, 'B');
    assert.equal(v.likes, 9);

    v = videoOwnership.applyMediaSwitch(v, {
      cloudflareVideoId: 'C',
      hlsUrl: 'https://c/manifest/video.m3u8',
    });
    assert.equal(v.cloudflareVideoId, 'C');
    assert.deepEqual(v.pendingCleanupCloudflareVideoIds, ['A', 'B']);
    assert.ok(!v.pendingCleanupCloudflareVideoId);
  });

  it('migrates legacy single pendingCleanupCloudflareVideoId', () => {
    const q = cleanup.readCleanupQueue({
      pendingCleanupCloudflareVideoId: 'legacy-old',
      pendingCleanupCloudflareVideoIds: ['kept'],
    });
    assert.deepEqual(q, ['kept', 'legacy-old']);
  });

  it('cleanup success removes UID; failure keeps it; live UID skipped', async () => {
    const store = {
      videos: new Map([
        [
          'v1',
          {
            id: 'v1',
            cloudflareVideoId: 'LIVE',
            pendingCleanupCloudflareVideoIds: ['OLD1', 'LIVE', 'OLD2'],
          },
        ],
      ]),
    };
    const calls = [];
    const stats = await cleanup.runVideoMediaCleanupTick({
      store,
      saveStore: () => {},
      deleteStreamUid: async (uid) => {
        calls.push(uid);
        if (uid === 'OLD2') return { ok: false, retryable: true, error: 'timeout' };
        return { ok: true };
      },
    });
    assert.ok(calls.includes('OLD1'));
    assert.ok(calls.includes('OLD2'));
    assert.ok(!calls.includes('LIVE')); // skipped while live
    assert.equal(stats.skipped >= 1, true);
    const v = store.videos.get('v1');
    assert.deepEqual(v.pendingCleanupCloudflareVideoIds, ['LIVE', 'OLD2']);
    assert.equal(v.cloudflareVideoId, 'LIVE');
  });

  it('Cloudflare 404 is idempotent success', async () => {
    const store = {
      videos: new Map([
        [
          'v1',
          {
            id: 'v1',
            cloudflareVideoId: 'LIVE',
            pendingCleanupCloudflareVideoIds: ['GONE'],
          },
        ],
      ]),
    };
    await cleanup.runVideoMediaCleanupTick({
      store,
      saveStore: () => {},
      deleteStreamUid: async () => ({ ok: true, notFound: true }),
    });
    assert.deepEqual(store.videos.get('v1').pendingCleanupCloudflareVideoIds, []);
  });

  it('delete failure does not roll back canonical media', async () => {
    const store = {
      videos: new Map([
        [
          'v1',
          {
            id: 'v1',
            cloudflareVideoId: 'NEW',
            hlsUrl: 'https://new/manifest/video.m3u8',
            pendingCleanupCloudflareVideoIds: ['OLD'],
          },
        ],
      ]),
    };
    await cleanup.runVideoMediaCleanupTick({
      store,
      saveStore: () => {},
      deleteStreamUid: async () => ({
        ok: false,
        retryable: true,
        error: 'network',
      }),
    });
    const v = store.videos.get('v1');
    assert.equal(v.cloudflareVideoId, 'NEW');
    assert.equal(v.hlsUrl, 'https://new/manifest/video.m3u8');
    assert.deepEqual(v.pendingCleanupCloudflareVideoIds, ['OLD']);
  });

  it('soft-delete enqueues current Stream UID for cleanup', () => {
    const deleted = videoOwnership.applySoftDelete({
      id: 'v1',
      cloudflareVideoId: 'DEL-ME',
      hlsUrl: 'https://x',
    });
    assert.equal(deleted.status, 'removed');
    assert.deepEqual(deleted.pendingCleanupCloudflareVideoIds, ['DEL-ME']);
    assert.equal(deleted.mediaCleanupAllowCurrentUid, true);
  });

  it('createCloudflareStreamDeleter treats 404 as notFound', async () => {
    const del = cleanup.createCloudflareStreamDeleter({
      accountId: 'acc',
      apiToken: 'tok',
      fetchImpl: async () => ({
        status: 404,
        ok: false,
        text: async () => '',
      }),
    });
    const r = await del('uid-x');
    assert.equal(r.ok, true);
    assert.equal(r.notFound, true);
  });
});
