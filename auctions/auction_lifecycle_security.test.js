'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { recordAuctionApproval } = require('./services/approval_flow');

const url =
  process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

function buildLifecycleTestApp(registerAuctionRoutes) {
  const accessTokens = new Map([
    ['tok-owner', { userId: 'sec-owner' }],
    ['tok-attacker', { userId: 'sec-attacker' }],
  ]);
  const store = {
    accessTokens,
    users: new Map([
      ['sec-owner', { id: 'sec-owner', name: 'Owner' }],
      ['sec-attacker', { id: 'sec-attacker', name: 'Attacker' }],
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

describe('G0.2 — Auction lifecycle security (HTTP + PostgreSQL)', { concurrency: 1 }, () => {
  let db;
  let auctionService;
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
    assert.equal(db.areMigrationsReady(), true, 'migrations must be ready for HTTP tests');
    auctionService = require('./services/auction_service');
    const { registerAuctionRoutes } = require('./routes');
    const app = buildLifecycleTestApp(registerAuctionRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.closePool();
  });

  async function wipe(client) {
    await client.query('DELETE FROM auction_events');
    await client.query('DELETE FROM bids');
    await client.query('DELETE FROM auctions');
    await client.query('DELETE FROM auction_lots');
  }

  async function seedDraft(ownerId = 'sec-owner') {
    const now = Date.now();
    return db.withTransaction(async (client) => {
      await wipe(client);
      return auctionService.createAuctionDraft(client, {
        listingId: `L-sec-${now}`,
        videoId: `V-sec-${now}`,
        species: 'horse',
        ownerUserId: ownerId,
        createdByUserId: ownerId,
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: new Date(now + 3600000).toISOString(),
        endAt: new Date(now + 7200000).toISOString(),
        requiresHost: false,
      });
    });
  }

  async function seedScheduled(ownerId = 'sec-owner', { startOffsetMs = -60000 } = {}) {
    const now = Date.now();
    return db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: `L-sch-${now}`,
        videoId: `V-sch-${now}`,
        species: 'horse',
        ownerUserId: ownerId,
        createdByUserId: ownerId,
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: new Date(now + startOffsetMs).toISOString(),
        endAt: new Date(now + 7200000).toISOString(),
        requiresHost: false,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', {
        actorUserId: ownerId,
      });
      await recordAuctionApproval(client, auction.id, 'admin-test', { bypass: 'admin' });
      const scheduled = await auctionService.transitionAuction(client, auction.id, 'scheduled', {
        actorUserId: ownerId,
      });
      return scheduled;
    });
  }

  it('UNAUTHENTICATED → submit-review DENIED 401', async (t) => {
    if (!url) return t.skip('no DB');
    const auction = await seedDraft();
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/submit-review`, {
      method: 'POST',
    });
    assert.equal(res.status, 401);
  });

  it('NORMAL USER + OTHER AUCTION submit-review → DENIED 403', async (t) => {
    if (!url) return t.skip('no DB');
    const auction = await seedDraft('sec-owner');
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/submit-review`, {
      method: 'POST',
      token: 'tok-attacker',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'AUCTION_LIFECYCLE_FORBIDDEN');
  });

  it('OWNER + OWN AUCTION submit-review → ALLOWED', async (t) => {
    if (!url) return t.skip('no DB');
    const auction = await seedDraft('sec-owner');
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/submit-review`, {
      method: 'POST',
      token: 'tok-owner',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.auction.status, 'review');
  });

  it('developer bypass does not apply when attacker submits for developer-owned auction', async (t) => {
    if (!url) return t.skip('no DB');
    const prev = process.env.AUCTION_DEVELOPER_USER_ID;
    process.env.AUCTION_DEVELOPER_USER_ID = 'sec-owner';
    try {
      delete require.cache[require.resolve('./dev_testing')];
      delete require.cache[require.resolve('./routes')];
      const auction = await seedDraft('sec-owner');
      const res = await httpJson(baseUrl, `/auctions/${auction.id}/submit-review`, {
        method: 'POST',
        token: 'tok-attacker',
      });
      assert.equal(res.status, 403);
    } finally {
      if (prev == null) delete process.env.AUCTION_DEVELOPER_USER_ID;
      else process.env.AUCTION_DEVELOPER_USER_ID = prev;
    }
  });

  it('NORMAL USER + OTHER AUCTION schedule → DENIED 403', async (t) => {
    if (!url) return t.skip('no DB');
    const auction = await seedScheduled('sec-owner');
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/schedule`, {
      method: 'POST',
      token: 'tok-attacker',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'AUCTION_LIFECYCLE_FORBIDDEN');
  });

  it('EARLY GO-LIVE before start_at → DENIED 409', async (t) => {
    if (!url) return t.skip('no DB');
    const auction = await seedScheduled('sec-owner', { startOffsetMs: 3600000 });
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/go-live`, {
      method: 'POST',
      token: 'tok-owner',
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'AUCTION_NOT_STARTED');
  });

  it('NORMAL USER + OTHER AUCTION go-live → DENIED 403', async (t) => {
    if (!url) return t.skip('no DB');
    const auction = await seedScheduled('sec-owner', { startOffsetMs: -60000 });
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/go-live`, {
      method: 'POST',
      token: 'tok-attacker',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'AUCTION_LIFECYCLE_FORBIDDEN');
  });

  it('OWNER + scheduled + past start_at go-live → ALLOWED', async (t) => {
    if (!url) return t.skip('no DB');
    const auction = await seedScheduled('sec-owner', { startOffsetMs: -60000 });
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/go-live`, {
      method: 'POST',
      token: 'tok-owner',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.auction.status, 'live');
  });

  it('NORMAL USER + OTHER AUCTION close → DENIED 403', async (t) => {
    if (!url) return t.skip('no DB');
    const now = Date.now();
    const auction = await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await auctionService.createAuctionDraft(client, {
        listingId: `L-cl-${now}`,
        videoId: `V-cl-${now}`,
        species: 'horse',
        ownerUserId: 'sec-owner',
        createdByUserId: 'sec-owner',
        startingPrice: 1000,
        minimumIncrement: 100,
        startAt: new Date(now - 7200000).toISOString(),
        endAt: new Date(now - 3600000).toISOString(),
        requiresHost: false,
      });
      await auctionService.transitionAuction(client, a.id, 'review', { actorUserId: 'sec-owner' });
      await auctionService.transitionAuction(client, a.id, 'scheduled', { actorUserId: 'sec-owner' });
      await auctionService.transitionAuction(client, a.id, 'live', { actorUserId: 'sec-owner' });
      return a;
    });
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/close`, {
      method: 'POST',
      token: 'tok-attacker',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'AUCTION_LIFECYCLE_FORBIDDEN');
  });

  it('INVALID STATE draft go-live → DENIED 409', async (t) => {
    if (!url) return t.skip('no DB');
    const auction = await seedDraft('sec-owner');
    const res = await httpJson(baseUrl, `/auctions/${auction.id}/go-live`, {
      method: 'POST',
      token: 'tok-owner',
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'AUCTION_GO_LIVE_INVALID');
  });
});

describe('G0.2 — lifecycle_auth unit', () => {
  const {
    assertAuctionOwner,
    assertManualGoLiveTimeAllowed,
  } = require('./services/lifecycle_auth');

  it('assertAuctionOwner rejects non-owner', () => {
    assert.throws(
      () => assertAuctionOwner({ owner_user_id: 'a' }, 'b'),
      (e) => e.code === 'AUCTION_LIFECYCLE_FORBIDDEN',
    );
  });

  it('assertManualGoLiveTimeAllowed rejects early start', () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    assert.throws(
      () =>
        assertManualGoLiveTimeAllowed(
          { status: 'scheduled', start_at: future },
          new Date(),
        ),
      (e) => e.code === 'AUCTION_NOT_STARTED',
    );
  });
});
