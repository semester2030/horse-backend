'use strict';

/**
 * STAGE 1+2+3 — Video ownership / edit / replace security regression.
 * Run: node --test video_ownership.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const videoOwnership = require('./video_ownership');

describe('video_ownership helpers', () => {
  it('isVideoOwner matches session to stored userId only', () => {
    assert.equal(videoOwnership.isVideoOwner('u1', { userId: 'u1' }), true);
    assert.equal(videoOwnership.isVideoOwner('u1', { userId: 'u2' }), false);
  });

  it('pickOwnerEditablePatch strips media and ownership keys', () => {
    const picked = videoOwnership.pickOwnerEditablePatch({
      title: 'T',
      price: 10,
      userId: 'x',
      cloudflareVideoId: 'cf',
      hlsUrl: 'https://x',
      likes: 99,
      hidden: true,
    });
    assert.equal(picked.ok, true);
    assert.equal(picked.patch.title, 'T');
    assert.equal(picked.patch.price, 10);
    assert.equal(picked.patch.hidden, true);
    assert.equal(picked.patch.userId, undefined);
    assert.equal(picked.patch.cloudflareVideoId, undefined);
    assert.equal(picked.patch.hlsUrl, undefined);
    assert.equal(picked.patch.likes, undefined);
  });

  it('validatePrice rejects negatives', () => {
    assert.equal(videoOwnership.validatePrice(-1), 'السعر غير صالح');
    assert.equal(videoOwnership.validatePrice(10), null);
  });

  it('includeVideoForViewer shows owner hidden but not removed', () => {
    assert.equal(
      videoOwnership.includeVideoForViewer(
        { userId: 'a', hidden: true },
        'a',
      ),
      true,
    );
    assert.equal(
      videoOwnership.includeVideoForViewer(
        { userId: 'a', hidden: true },
        'b',
      ),
      false,
    );
    assert.equal(
      videoOwnership.includeVideoForViewer(
        { userId: 'a', status: 'removed' },
        'a',
      ),
      false,
    );
  });

  it('validateReplaceMediaPayload requires playable HLS', () => {
    const bad = videoOwnership.validateReplaceMediaPayload(
      { cloudflareVideoId: 'uid1' },
      { uid: 'uid1', playback: {} },
    );
    assert.equal(bad.ok, false);
    const good = videoOwnership.validateReplaceMediaPayload(
      {
        cloudflareVideoId: 'uid1',
        hlsUrl: 'https://customer.cloudflarestream.com/uid1/manifest/video.m3u8',
      },
      null,
    );
    assert.equal(good.ok, true);
  });

  it('applyMediaSwitch keeps old uid for cleanup queue', () => {
    const next = videoOwnership.applyMediaSwitch(
      { id: 'v1', cloudflareVideoId: 'old', hlsUrl: 'https://old' },
      {
        cloudflareVideoId: 'new',
        hlsUrl: 'https://new/manifest/video.m3u8',
        thumbnailUrl: 'https://thumb',
      },
    );
    assert.equal(next.cloudflareVideoId, 'new');
    assert.equal(next.previousCloudflareVideoId, 'old');
    assert.deepEqual(next.pendingCleanupCloudflareVideoIds, ['old']);
  });
});

function buildTestApp() {
  const store = {
    users: new Map([
      ['owner-a', { id: 'owner-a', phone: '+966500000001' }],
      ['owner-b', { id: 'owner-b', phone: '+966500000002' }],
    ]),
    accessTokens: new Map([
      ['tok-a', { userId: 'owner-a' }],
      ['tok-b', { userId: 'owner-b' }],
    ]),
    videos: new Map([
      [
        'vid-a',
        {
          id: 'vid-a',
          userId: 'owner-a',
          title: 'Mine',
          price: 100,
          hidden: false,
          cloudflareVideoId: 'cf-old',
          hlsUrl: 'https://old/manifest/video.m3u8',
          likes: 5,
        },
      ],
      [
        'vid-b',
        {
          id: 'vid-b',
          userId: 'owner-b',
          title: 'Theirs',
          price: 200,
          hidden: false,
        },
      ],
      [
        'vid-legacy',
        {
          id: 'vid-legacy',
          title: 'No owner',
          price: 1,
        },
      ],
    ]),
  };

  const auth = (req, res, next) => {
    const h = req.headers.authorization;
    const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) return res.status(401).json({ message: 'المصادقة مطلوبة' });
    req.token = t;
    next();
  };

  const requireSessionUser = (req, res, next) => {
    const entry = store.accessTokens.get(req.token);
    if (!entry || !entry.userId) {
      return res.status(401).json({ message: 'توكن الجلسة غير معروف' });
    }
    req.authUserId = String(entry.userId);
    next();
  };

  const app = express();
  app.use(express.json());

  app.post('/videos', auth, requireSessionUser, (req, res) => {
    const body = videoOwnership.stripClientOwnershipFields(req.body || {});
    const id = String(body.id || `v-${Date.now()}`);
    const video = {
      ...body,
      id,
      userId: videoOwnership.resolveCreateVideoUserId(req.authUserId),
    };
    store.videos.set(id, video);
    res.status(201).json(video);
  });

  app.patch('/videos/:id', auth, requireSessionUser, (req, res) => {
    const existing = store.videos.get(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: 'الفيديو غير موجود' });
    }
    const gate = videoOwnership.assertVideoOwner(req.authUserId, existing);
    if (!gate.ok) {
      return res.status(gate.status).json({ message: gate.message, code: gate.code });
    }
    const picked = videoOwnership.pickOwnerEditablePatch(req.body || {});
    if (!picked.ok) {
      return res.status(picked.status).json({ message: picked.message });
    }
    const priceErr = videoOwnership.validatePrice(picked.patch.price);
    if (priceErr) return res.status(400).json({ message: priceErr });
    if (
      picked.patch.hidden === false &&
      String(existing.status || '') === 'removed'
    ) {
      return res.status(400).json({ code: 'VIDEO_REPUBLISH_DELETED' });
    }
    const updated = {
      ...existing,
      ...picked.patch,
      id: existing.id,
      userId: existing.userId,
      cloudflareVideoId: existing.cloudflareVideoId,
      hlsUrl: existing.hlsUrl,
      likes: existing.likes,
    };
    store.videos.set(existing.id, updated);
    res.json(updated);
  });

  app.delete('/videos/:id', auth, requireSessionUser, (req, res) => {
    const existing = store.videos.get(req.params.id);
    if (!existing) return res.status(404).json({ message: 'missing' });
    const gate = videoOwnership.assertVideoOwner(req.authUserId, existing);
    if (!gate.ok) {
      return res.status(gate.status).json({ message: gate.message });
    }
    const updated = videoOwnership.applySoftDelete(existing);
    store.videos.set(existing.id, updated);
    res.json({ ok: true, video: updated });
  });

  app.post('/videos/:id/replace-media', auth, requireSessionUser, (req, res) => {
    const existing = store.videos.get(req.params.id);
    if (!existing) return res.status(404).json({ message: 'missing' });
    const gate = videoOwnership.assertVideoOwner(req.authUserId, existing);
    if (!gate.ok) {
      return res.status(gate.status).json({ message: gate.message });
    }
    const validated = videoOwnership.validateReplaceMediaPayload(req.body || {}, null);
    if (!validated.ok) {
      return res.status(validated.status).json({ code: validated.code });
    }
    const updated = videoOwnership.applyMediaSwitch(existing, validated.media);
    store.videos.set(existing.id, updated);
    res.json(updated);
  });

  const ADMIN_SECRET = 'test-admin-secret';
  app.patch('/admin/videos/:id', (req, res) => {
    const key = req.headers['x-admin-key'] || '';
    if (key !== ADMIN_SECRET) {
      return res.status(403).json({ message: 'صلاحية الإدارة مطلوبة' });
    }
    const existing = store.videos.get(req.params.id);
    if (!existing) return res.status(404).json({ message: 'الفيديو غير موجود' });
    const updated = { ...existing, ...req.body, id: existing.id };
    store.videos.set(existing.id, updated);
    res.json(updated);
  });

  return { app, store, ADMIN_SECRET };
}

async function httpJson(baseUrl, path, { method = 'GET', token, body, headers } = {}) {
  const h = { Accept: 'application/json', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body != null) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: h,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

describe('video ownership HTTP contract', () => {
  let server;
  let baseUrl;
  let store;
  let ADMIN_SECRET;

  before(async () => {
    const built = buildTestApp();
    store = built.store;
    ADMIN_SECRET = built.ADMIN_SECRET;
    server = built.app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('1. Owner PATCH own video → PASS', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-a', {
      method: 'PATCH',
      token: 'tok-a',
      body: { title: 'Updated by owner', price: 150 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.title, 'Updated by owner');
    assert.equal(res.json.price, 150);
    assert.equal(res.json.userId, 'owner-a');
  });

  it('2. User A PATCH User B video → 403', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-b', {
      method: 'PATCH',
      token: 'tok-a',
      body: { title: 'hijack' },
    });
    assert.equal(res.status, 403);
  });

  it('3. Anonymous PATCH → 401', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-a', {
      method: 'PATCH',
      body: { title: 'anon' },
    });
    assert.equal(res.status, 401);
  });

  it('4. Owner attempt userId/hls change → ownership+media unchanged', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-a', {
      method: 'PATCH',
      token: 'tok-a',
      body: {
        userId: 'owner-b',
        cloudflareVideoId: 'hack',
        hlsUrl: 'https://evil',
        title: 'still mine',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.userId, 'owner-a');
    assert.equal(res.json.cloudflareVideoId, 'cf-old');
    assert.equal(res.json.hlsUrl, 'https://old/manifest/video.m3u8');
    assert.equal(res.json.title, 'still mine');
  });

  it('5. POST spoofed userId → session UID', async () => {
    const res = await httpJson(baseUrl, '/videos', {
      method: 'POST',
      token: 'tok-a',
      body: { id: 'vid-spoof', title: 'Spoof', userId: 'owner-b' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.userId, 'owner-a');
  });

  it('6. Anonymous POST → 401', async () => {
    const res = await httpJson(baseUrl, '/videos', {
      method: 'POST',
      body: { title: 'no auth' },
    });
    assert.equal(res.status, 401);
  });

  it('7. Admin privileged path remains valid', async () => {
    const res = await httpJson(baseUrl, '/admin/videos/vid-b', {
      method: 'PATCH',
      headers: { 'x-admin-key': ADMIN_SECRET },
      body: { title: 'admin edit' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.title, 'admin edit');
  });

  it('8. Non-owner HLS repair style PATCH → 403', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-b', {
      method: 'PATCH',
      token: 'tok-a',
      body: { hlsUrl: 'https://example.com/repaired.m3u8' },
    });
    assert.equal(res.status, 403);
  });

  it('9. Owner unpublish + republish', async () => {
    let res = await httpJson(baseUrl, '/videos/vid-a', {
      method: 'PATCH',
      token: 'tok-a',
      body: { hidden: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.hidden, true);
    res = await httpJson(baseUrl, '/videos/vid-a', {
      method: 'PATCH',
      token: 'tok-a',
      body: { hidden: false },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.hidden, false);
  });

  it('10. Non-owner cannot unpublish', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-b', {
      method: 'PATCH',
      token: 'tok-a',
      body: { hidden: true },
    });
    assert.equal(res.status, 403);
  });

  it('11. Owner soft-delete', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-a', {
      method: 'DELETE',
      token: 'tok-a',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.video.status, 'removed');
    assert.equal(res.json.video.hidden, true);
    // restore for later tests
    store.videos.set('vid-a', {
      ...store.videos.get('vid-a'),
      status: 'active',
      hidden: false,
      deletedAt: undefined,
    });
  });

  it('12. Legacy missing userId PATCH → 403 fail-closed', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-legacy', {
      method: 'PATCH',
      token: 'tok-a',
      body: { title: 'nope' },
    });
    assert.equal(res.status, 403);
  });

  it('13. Owner replace-media switches when HLS ready', async () => {
    const beforeLikes = store.videos.get('vid-a').likes;
    const res = await httpJson(baseUrl, '/videos/vid-a/replace-media', {
      method: 'POST',
      token: 'tok-a',
      body: {
        cloudflareVideoId: 'cf-new',
        hlsUrl: 'https://customer.cloudflarestream.com/cf-new/manifest/video.m3u8',
        thumbnailUrl: 'https://thumb',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.cloudflareVideoId, 'cf-new');
    assert.equal(res.json.previousCloudflareVideoId, 'cf-old');
    assert.deepEqual(res.json.pendingCleanupCloudflareVideoIds, ['cf-old']);
    assert.equal(res.json.likes, beforeLikes);
  });

  it('13b. Repeated replace keeps A and B on cleanup queue', async () => {
    // vid-a currently cf-new from previous test with queue [cf-old]
    const res = await httpJson(baseUrl, '/videos/vid-a/replace-media', {
      method: 'POST',
      token: 'tok-a',
      body: {
        cloudflareVideoId: 'cf-newer',
        hlsUrl: 'https://customer.cloudflarestream.com/cf-newer/manifest/video.m3u8',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.cloudflareVideoId, 'cf-newer');
    assert.deepEqual(res.json.pendingCleanupCloudflareVideoIds, [
      'cf-old',
      'cf-new',
    ]);
  });

  it('14. Non-owner replace-media → 403', async () => {
    const res = await httpJson(baseUrl, '/videos/vid-b/replace-media', {
      method: 'POST',
      token: 'tok-a',
      body: {
        cloudflareVideoId: 'x',
        hlsUrl: 'https://x/manifest/video.m3u8',
      },
    });
    assert.equal(res.status, 403);
  });

  it('15. Replace without HLS rejected; old media untouched', async () => {
    const before = store.videos.get('vid-a').cloudflareVideoId;
    const res = await httpJson(baseUrl, '/videos/vid-a/replace-media', {
      method: 'POST',
      token: 'tok-a',
      body: { cloudflareVideoId: 'not-ready' },
    });
    assert.equal(res.status, 400);
    assert.equal(store.videos.get('vid-a').cloudflareVideoId, before);
  });
});
