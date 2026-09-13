'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITY } = require('./services/haraj_auctioneer_auth');

const url =
  process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

function buildApp(registerAuctionRoutes) {
  const accessTokens = new Map([
    ['tok-a', { userId: 'g4-seller-a' }],
    ['tok-b', { userId: 'g4-seller-b' }],
    ['tok-op', { userId: 'g4-auctioneer' }],
    ['tok-op2', { userId: 'g4-auctioneer-2' }],
    ['tok-both', { userId: 'g4-seller-op' }],
  ]);
  const store = {
    accessTokens,
    users: new Map([
      ['g4-seller-a', { id: 'g4-seller-a', name: 'Seller A', capabilities: [] }],
      ['g4-seller-b', { id: 'g4-seller-b', name: 'Seller B', capabilities: [] }],
      ['g4-auctioneer', { id: 'g4-auctioneer', name: 'Op', capabilities: [CAPABILITY] }],
      ['g4-auctioneer-2', { id: 'g4-auctioneer-2', name: 'Op2', capabilities: [CAPABILITY] }],
      ['g4-seller-op', { id: 'g4-seller-op', name: 'Both', capabilities: [CAPABILITY] }],
    ]),
    horses: new Map(),
    videos: new Map(),
  };

  function auth(req, res, next) {
    const h = req.headers.authorization;
    const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) return res.status(401).json({ message: 'Unauthorized', code: 'AUTH_REQUIRED' });
    req.token = t;
    next();
  }
  function requireSessionUser(req, res, next) {
    const entry = store.accessTokens.get(req.token);
    if (!entry?.userId) return res.status(401).json({ message: 'Invalid session', code: 'AUTH_INVALID' });
    req.authUserId = String(entry.userId);
    req.authUser = store.users.get(req.authUserId);
    next();
  }
  const express = require('express');
  const app = express();
  app.use(express.json());
  registerAuctionRoutes(app, { auth, requireSessionUser, store, auctionRealtime: null });
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
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }
  return { status: res.status, json };
}

function payload() {
  const start = new Date(Date.now() + 7 * 86400000);
  return {
    channel: 'haraj',
    independent: true,
    species: 'horse',
    title: 'G4 Lot',
    startingPrice: 1500,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g4/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g4-ph',
  };
}

describe('G4 auctioneer HTTP', { concurrency: 1 }, () => {
  let db;
  let server;
  let baseUrl;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete process.env.AUCTION_DEVELOPER_USER_ID;
    for (const mod of ['./db', './config', './routes']) {
      delete require.cache[require.resolve(mod)];
    }
    db = require('./db');
    await db.runMigrations();
    const { registerAuctionRoutes } = require('./routes');
    server = buildApp(registerAuctionRoutes).listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.closePool();
  });

  async function submittedLot(token = 'tok-a') {
    const created = await httpJson(baseUrl, '/auctions', { method: 'POST', token, body: payload() });
    const id = created.json?.auction?.id;
    await httpJson(baseUrl, `/auctions/${id}/submit-review`, {
      method: 'POST',
      token,
      body: { channel: 'haraj' },
    });
    return id;
  }

  it('unauthenticated list and decision are rejected', async (t) => {
    if (!url) return t.skip('no DB');
    const q = await httpJson(baseUrl, '/auctions/haraj/review/queue');
    assert.equal(q.status, 401);
    const d = await httpJson(baseUrl, '/auctions/haraj/review/x/accept', { method: 'POST', body: {} });
    assert.equal(d.status, 401);
  });

  it('seller cannot list or decide', async (t) => {
    if (!url) return t.skip('no DB');
    const id = await submittedLot();
    const q = await httpJson(baseUrl, '/auctions/haraj/review/queue', { token: 'tok-a' });
    assert.equal(q.status, 403);
    const acc = await httpJson(baseUrl, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: 'tok-a',
      body: {},
    });
    assert.equal(acc.status, 403);
    const rej = await httpJson(baseUrl, `/auctions/haraj/review/${id}/reject`, {
      method: 'POST',
      token: 'tok-b',
      body: { reason: 'no' },
    });
    assert.equal(rej.status, 403);
  });

  it('owner who is also auctioneer cannot self-review', async (t) => {
    if (!url) return t.skip('no DB');
    const id = await submittedLot('tok-both');
    const acc = await httpJson(baseUrl, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: 'tok-both',
      body: {},
    });
    assert.equal(acc.status, 403);
    assert.equal(acc.json.code, 'AUCTIONEER_SELF_REVIEW_FORBIDDEN');
  });

  it('spoofed auctioneerId is rejected; accept/request/reject/idempotent/concurrency', async (t) => {
    if (!url) return t.skip('no DB');
    const id = await submittedLot();
    const spoof = await httpJson(baseUrl, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: 'tok-op',
      body: { auctioneerId: 'someone-else' },
    });
    assert.equal(spoof.status, 403);

    const seen = await httpJson(baseUrl, '/auctions/haraj/review/queue?bucket=under_review', {
      token: 'tok-op',
    });
    assert.equal(seen.status, 200);
    assert.equal((seen.json.auctions || []).some((a) => a.id === id), true);

    const got = await httpJson(baseUrl, `/auctions/haraj/review/${id}`, { token: 'tok-op' });
    assert.equal(got.status, 200);
    assert.equal(got.json.auction.harajReview.operationalStatus, 'under_review');
    assert.equal(got.json.auction.status, 'review');

    const first = await httpJson(baseUrl, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: 'tok-op',
      body: { reason: 'مكتمل', expectedStatus: 'review' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.auction.harajReview.operationalStatus, 'approved_for_haraj');
    assert.equal(first.json.auction.status, 'review');
    assert.equal(first.json.auction.harajReview.roomAssigned, false);

    const dup = await httpJson(baseUrl, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: 'tok-op',
      body: {},
    });
    assert.equal(dup.status, 200);

    const staleReject = await httpJson(baseUrl, `/auctions/haraj/review/${id}/reject`, {
      method: 'POST',
      token: 'tok-op2',
      body: { reason: 'متأخر', expectedStatus: 'review' },
    });
    assert.equal(staleReject.status, 409);
  });

  it('request-changes returns lot to draft and seller can resubmit', async (t) => {
    if (!url) return t.skip('no DB');
    const id = await submittedLot();
    const ch = await httpJson(baseUrl, `/auctions/haraj/review/${id}/request-changes`, {
      method: 'POST',
      token: 'tok-op',
      body: { reason: 'أضف صور', sellerMessage: 'نحتاج صور أوضح' },
    });
    assert.equal(ch.status, 200);
    assert.equal(ch.json.auction.status, 'draft');
    assert.equal(ch.json.auction.harajReview.operationalStatus, 'needs_changes');

    const mine = await httpJson(baseUrl, '/auctions/mine', { token: 'tok-a' });
    const row = (mine.json.auctions || []).find((a) => a.id === id);
    assert.equal(row.harajReview.operationalStatus, 'needs_changes');
    assert.equal(row.harajReview.sellerMessage.includes('صور'), true);

    const resub = await httpJson(baseUrl, `/auctions/${id}/submit-review`, {
      method: 'POST',
      token: 'tok-a',
      body: { channel: 'haraj' },
    });
    assert.equal(resub.status, 200);
    assert.equal(resub.json.auction.status, 'review');
  });

  it('reject requires reason and preserves lot id', async (t) => {
    if (!url) return t.skip('no DB');
    const id = await submittedLot();
    const missing = await httpJson(baseUrl, `/auctions/haraj/review/${id}/reject`, {
      method: 'POST',
      token: 'tok-op',
      body: {},
    });
    assert.equal(missing.status, 400);
    const rej = await httpJson(baseUrl, `/auctions/haraj/review/${id}/reject`, {
      method: 'POST',
      token: 'tok-op',
      body: { reason: 'خارج السياسة' },
    });
    assert.equal(rej.status, 200);
    assert.equal(rej.json.auction.status, 'cancelled');
    assert.equal(rej.json.auction.id, id);
    const again = await httpJson(baseUrl, `/auctions/haraj/review/${id}/reject`, {
      method: 'POST',
      token: 'tok-op',
      body: { reason: 'خارج السياسة' },
    });
    assert.equal(again.status, 200);
  });

  it('invalid lot, spoofed role, notes privacy, unauth notes', async (t) => {
    if (!url) return t.skip('no DB');
    const bad = await httpJson(baseUrl, '/auctions/haraj/review/not-a-uuid', { token: 'tok-op' });
    assert.equal(bad.status, 404);

    const id = await submittedLot();
    const spoofRole = await httpJson(baseUrl, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: 'tok-a',
      body: { role: 'AUCTIONEER', accountRole: 'admin', auctioneerId: 'g4-auctioneer' },
    });
    assert.equal(spoofRole.status, 403);

    const note = await httpJson(baseUrl, `/auctions/haraj/review/${id}/notes`, {
      method: 'POST',
      token: 'tok-op',
      body: { note: 'ملاحظة داخلية سرية' },
    });
    assert.equal(note.status, 200);
    assert.equal(note.json.auction.harajReview.internalNote.includes('سرية'), true);

    const publicGet = await httpJson(baseUrl, `/auctions/${id}`);
    assert.equal(publicGet.status, 200);
    assert.equal(publicGet.json.auction.harajReview.internalNote, undefined);

    const sellerMine = await httpJson(baseUrl, '/auctions/mine', { token: 'tok-a' });
    const row = (sellerMine.json.auctions || []).find((a) => a.id === id);
    assert.equal(row.harajReview.internalNote, undefined);

    const unauthNote = await httpJson(baseUrl, `/auctions/haraj/review/${id}/notes`, {
      method: 'POST',
      body: { note: 'x' },
    });
    assert.equal(unauthNote.status, 401);
  });
});
