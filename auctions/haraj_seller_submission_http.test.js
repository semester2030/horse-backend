'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const url =
  process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

function buildApp(registerAuctionRoutes) {
  const accessTokens = new Map([
    ['tok-a', { userId: 'g3-seller-a' }],
    ['tok-b', { userId: 'g3-seller-b' }],
  ]);
  const store = {
    accessTokens,
    users: new Map([
      ['g3-seller-a', { id: 'g3-seller-a', name: 'Seller A' }],
      ['g3-seller-b', { id: 'g3-seller-b', name: 'Seller B' }],
    ]),
    horses: new Map(),
    videos: new Map(),
  };

  function auth(req, res, next) {
    const h = req.headers.authorization;
    const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) {
      return res.status(401).json({ message: 'Unauthorized', code: 'AUTH_REQUIRED' });
    }
    req.token = t;
    next();
  }

  function requireSessionUser(req, res, next) {
    const entry = store.accessTokens.get(req.token);
    if (!entry?.userId) {
      return res.status(401).json({ message: 'Invalid session', code: 'AUTH_INVALID' });
    }
    req.authUserId = String(entry.userId);
    req.authUser = store.users.get(req.authUserId);
    next();
  }

  const express = require('express');
  const app = express();
  app.use(express.json());
  registerAuctionRoutes(app, {
    auth,
    requireSessionUser,
    store,
    auctionRealtime: null,
  });
  return app;
}

async function httpJson(baseUrl, path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
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

function harajPayload(overrides = {}) {
  return {
    channel: 'haraj',
    independent: true,
    species: 'horse',
    title: 'G3 Lot حصان',
    startingPrice: 1500,
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g3-test/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g3-test',
    inspection: { available: true, windows: 'بعد العصر' },
    ...overrides,
  };
}

describe('G3 seller lot submission HTTP', { concurrency: 1 }, () => {
  let db;
  let server;
  let baseUrl;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete process.env.AUCTION_DEVELOPER_USER_ID;
    for (const mod of ['./db', './config', './routes', './services/lifecycle_auth']) {
      delete require.cache[require.resolve(mod)];
    }
    db = require('./db');
    await db.runMigrations();
    const { registerAuctionRoutes } = require('./routes');
    const app = buildApp(registerAuctionRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.closePool();
  });

  it('unauthenticated cannot create or list mine', async (t) => {
    if (!url) return t.skip('no DB');
    const create = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      body: harajPayload(),
    });
    assert.equal(create.status, 401);
    const mine = await httpJson(baseUrl, '/auctions/mine');
    assert.equal(mine.status, 401);
  });

  it('seller A creates own haraj lot and submits to review', async (t) => {
    if (!url) return t.skip('no DB');
    const spoofed = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-a',
      body: harajPayload({ ownerUserId: 'g3-seller-b' }),
    });
    assert.equal(spoofed.status, 403);
    assert.equal(spoofed.json.code, 'AUCTION_OWNER_FORBIDDEN');

    const created = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-a',
      body: harajPayload(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.auction.ownerUserId, 'g3-seller-a');
    assert.equal(created.json.auction.status, 'draft');
    assert.equal(created.json.auction.species, 'horse');
    assert.ok(created.json.auction.id);

    const mine = await httpJson(baseUrl, '/auctions/mine', { token: 'tok-a' });
    assert.equal(mine.status, 200);
    assert.ok(mine.json.auctions.some((a) => a.id === created.json.auction.id));

    const submitted = await httpJson(
      baseUrl,
      `/auctions/${created.json.auction.id}/submit-review`,
      {
        method: 'POST',
        token: 'tok-a',
        body: { channel: 'haraj', inspection: { available: true } },
      },
    );
    assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
    assert.equal(submitted.json.auction.status, 'review');

    const dup = await httpJson(
      baseUrl,
      `/auctions/${created.json.auction.id}/submit-review`,
      { method: 'POST', token: 'tok-a', body: { channel: 'haraj' } },
    );
    assert.equal(dup.status, 200);
    assert.equal(dup.json.auction.status, 'review');
    assert.equal(dup.json.auction.id, created.json.auction.id);
  });

  it('seller B cannot edit or submit seller A lot', async (t) => {
    if (!url) return t.skip('no DB');
    const created = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-a',
      body: harajPayload({ title: 'Owned by A' }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.auction.id;

    const patch = await httpJson(baseUrl, `/auctions/${id}`, {
      method: 'PATCH',
      token: 'tok-b',
      body: { title: 'hacked' },
    });
    assert.equal(patch.status, 403);

    const submit = await httpJson(baseUrl, `/auctions/${id}/submit-review`, {
      method: 'POST',
      token: 'tok-b',
    });
    assert.equal(submit.status, 403);

    const mineB = await httpJson(baseUrl, '/auctions/mine', { token: 'tok-b' });
    assert.equal(mineB.status, 200);
    assert.equal(
      (mineB.json.auctions || []).some((a) => a.id === id),
      false,
    );
  });

  it('rejects sheep, missing title, and forbidden financial fields', async (t) => {
    if (!url) return t.skip('no DB');
    const sheep = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-a',
      body: harajPayload({ species: 'sheep' }),
    });
    assert.equal(sheep.status, 400);
    assert.equal(sheep.json.code, 'AUCTION_SPECIES_INVALID');

    const noTitle = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-a',
      body: harajPayload({ title: '' }),
    });
    assert.equal(noTitle.status, 400);
    assert.equal(noTitle.json.code, 'AUCTION_TITLE_REQUIRED');

    const forbidden = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-a',
      body: harajPayload({ currentPrice: 9, winnerUserId: 'x' }),
    });
    assert.equal(forbidden.status, 400);
    assert.equal(forbidden.json.code, 'AUCTION_FIELD_FORBIDDEN');
  });

  it('owner can patch draft then cannot patch after review', async (t) => {
    if (!url) return t.skip('no DB');
    const created = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-a',
      body: harajPayload({ title: 'Draft edit' }),
    });
    assert.equal(created.status, 201);
    const id = created.json.auction.id;
    const patched = await httpJson(baseUrl, `/auctions/${id}`, {
      method: 'PATCH',
      token: 'tok-a',
      body: { title: 'Draft edited', startingPrice: 1800 },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.auction.startingPrice, 1800);

    await httpJson(baseUrl, `/auctions/${id}/submit-review`, {
      method: 'POST',
      token: 'tok-a',
      body: { channel: 'haraj' },
    });
    const locked = await httpJson(baseUrl, `/auctions/${id}`, {
      method: 'PATCH',
      token: 'tok-a',
      body: { title: 'should fail' },
    });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.code, 'AUCTION_EDIT_LOCKED');
  });
});
