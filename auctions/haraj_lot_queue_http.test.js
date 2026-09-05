'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITY } = require('./services/haraj_auctioneer_auth');

const url =
  process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

function buildApp(registerAuctionRoutes, registerAuctionAdminRoutes) {
  const accessTokens = new Map([
    ['tok-seller', { userId: 'g7-seller' }],
    ['tok-bidder', { userId: 'g7-bidder' }],
    ['tok-op', { userId: 'g7-auctioneer' }],
  ]);
  const store = {
    accessTokens,
    users: new Map([
      ['g7-seller', { id: 'g7-seller', name: 'Seller', capabilities: [] }],
      ['g7-bidder', { id: 'g7-bidder', name: 'Bidder', capabilities: [] }],
      ['g7-auctioneer', { id: 'g7-auctioneer', name: 'Op', capabilities: [CAPABILITY] }],
      ['g7-op', { id: 'g7-op', email: 'op@nomas.auctioneer.staging', capabilities: [CAPABILITY] }],
      ['g7-op-2', { id: 'g7-op-2', email: 'op2@nomas.auctioneer.staging', capabilities: [CAPABILITY] }],
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
  function requireAdminAuth(req, res, next) {
    const h = req.headers.authorization;
    const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) return res.status(401).json({ message: 'توكن الإدارة مطلوب', code: 'AUTH_REQUIRED' });
    if (t === 'tok-seller' || t === 'tok-bidder' || t === 'tok-op' || t === 'seller' || t === 'auctioneer') {
      return res.status(401).json({ message: 'توكن الإدارة مطلوب', code: 'AUTH_REQUIRED' });
    }
    if (t !== 'admin') return res.status(401).json({ message: 'جلسة الإدارة منتهية', code: 'AUTH_INVALID' });
    req.adminUser = { id: 'adm-g7', name: 'Admin', role: 'super_admin', active: true };
    req.adminUserId = 'adm-g7';
    next();
  }
  function requirePerm() {
    return (req, res, next) => next();
  }
  function logAudit() {}

  const express = require('express');
  const app = express();
  app.use(express.json());
  registerAuctionRoutes(app, { auth, requireSessionUser, store, auctionRealtime: null });
  const adminRouter = express.Router();
  registerAuctionAdminRoutes(adminRouter, { requireAdminAuth, requirePerm, logAudit, store });
  app.use('/admin/v2', adminRouter);
  return app;
}

async function httpJson(baseUrl, path, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
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
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }
  return { status: res.status, json };
}

function lotPayload(species = 'horse', title = 'G7 Lot') {
  const start = new Date(Date.now() + 7 * 86400000);
  return {
    channel: 'haraj',
    independent: true,
    species,
    title: `${title} ${Date.now()}`,
    startingPrice: 1500,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3600000).toISOString(),
    location: { city: 'الرياض', lat: 24.7136, lng: 46.6753 },
    mediaVideoHlsUrl: 'https://videodelivery.net/g7/manifest/video.m3u8',
    mediaVideoCloudflareId: 'g7-ph',
  };
}

function windowFor(hoursFromNow = 36) {
  const start = new Date(Date.now() + hoursFromNow * 3600000);
  return {
    scheduledStartAt: start.toISOString(),
    scheduledEndAt: new Date(start.getTime() + 4 * 3600000).toISOString(),
    timezone: 'Asia/Riyadh',
  };
}

describe('G7 lot queue HTTP', { concurrency: 1 }, () => {
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
    const { registerAuctionRoutes, registerAuctionAdminRoutes } = require('./routes');
    server = buildApp(registerAuctionRoutes, registerAuctionAdminRoutes).listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.closePool();
  });

  async function approvedLot(species = 'horse') {
    const created = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-seller',
      body: lotPayload(species),
    });
    const id = created.json?.auction?.id;
    await httpJson(baseUrl, `/auctions/${id}/submit-review`, {
      method: 'POST',
      token: 'tok-seller',
      body: { channel: 'haraj' },
    });
    const accept = await httpJson(baseUrl, `/auctions/haraj/review/${id}/accept`, {
      method: 'POST',
      token: 'tok-op',
      body: { reason: 'G7' },
    });
    return { id, accept };
  }

  async function occurrence(category = 'horse', hours = 36) {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const session = await httpJson(baseUrl, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: 'admin',
      body: { category, ...windowFor(hours) },
    });
    const attach = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: 'admin',
      body: {
        category,
        code: `g7-${category}-${stamp}`,
        nameAr: `غرفة ${category}`,
        auctioneerUserId: hours > 40 ? 'g7-op-2' : 'g7-op',
      },
    });
    return {
      sessionId: session.json.session.id,
      roomSessionId: attach.json.roomSession.id,
      roomId: attach.json.roomSession.roomId,
    };
  }

  it('rejects unauthenticated, seller, bidder, and auctioneer Flutter tokens on queue write', async (t) => {
    if (!url) return t.skip('no DB');
    const occ = await occurrence();
    const lot = await approvedLot();
    const body = { auctionId: lot.id };
    const unauth = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue`, {
      method: 'POST',
      body,
    });
    assert.equal(unauth.status, 401);
    const seller = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue`, {
      method: 'POST',
      token: 'tok-seller',
      body,
    });
    assert.equal(seller.status, 401);
    const bidder = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue`, {
      method: 'POST',
      token: 'tok-bidder',
      body,
    });
    assert.equal(bidder.status, 401);
    const op = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue`, {
      method: 'POST',
      token: 'tok-op',
      body,
    });
    assert.equal(op.status, 401);
  });

  it('assigns an approved Lot as auction.id, rejects ineligible/mismatch, and protects duplicates', async (t) => {
    if (!url) return t.skip('no DB');
    const horseOcc = await occurrence('horse', 36);
    const camelOcc = await occurrence('camel', 48);
    const horse = await approvedLot('horse');
    const camel = await approvedLot('camel');

    const spoof = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOcc.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: horse.id, createdBy: 'spoof' },
    });
    assert.equal(spoof.status, 403);

    const assigned = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOcc.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      headers: { 'Idempotency-Key': `g7-${horse.id}` },
      body: { auctionId: horse.id },
    });
    assert.equal(assigned.status, 201);
    assert.equal(assigned.json.entry.auctionId, horse.id);
    assert.equal(assigned.json.entry.lotId, horse.id);
    assert.equal(assigned.json.lotId, horse.id);
    assert.equal(assigned.json.entry.financialAuthority, false);
    assert.equal(assigned.json.entry.liveActivated, false);

    const replay = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOcc.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      headers: { 'Idempotency-Key': `g7-${horse.id}` },
      body: { auctionId: horse.id },
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.json.entry.id, assigned.json.entry.id);

    const sameAgain = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOcc.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: horse.id },
    });
    assert.equal(sameAgain.status, 201);
    assert.equal(sameAgain.json.entry.id, assigned.json.entry.id);

    const otherRoom = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${camelOcc.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: horse.id },
    });
    assert.equal(otherRoom.status, 409);
    assert.equal(otherRoom.json.code, 'HARAJ_CATEGORY_MISMATCH');

    const horseOnCamelSession = await occurrence('horse', 60);
    const cross = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOnCamelSession.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: horse.id },
    });
    assert.equal(cross.status, 409);
    assert.equal(cross.json.code, 'HARAJ_LOT_ALREADY_QUEUED');

    const mismatch = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOcc.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: camel.id },
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.json.code, 'HARAJ_CATEGORY_MISMATCH');

    const draft = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-seller',
      body: lotPayload('horse', 'Draft'),
    });
    const draftAssign = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOcc.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: draft.json.auction.id },
    });
    assert.equal(draftAssign.status, 409);
    assert.equal(draftAssign.json.code, 'HARAJ_LOT_NOT_APPROVED');

    const review = await httpJson(baseUrl, '/auctions', {
      method: 'POST',
      token: 'tok-seller',
      body: lotPayload('horse', 'Review'),
    });
    await httpJson(baseUrl, `/auctions/${review.json.auction.id}/submit-review`, {
      method: 'POST',
      token: 'tok-seller',
      body: { channel: 'haraj' },
    });
    const reviewAssign = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOcc.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: review.json.auction.id },
    });
    assert.equal(reviewAssign.status, 409);

    const listed = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${horseOcc.roomSessionId}/queue`, {
      token: 'admin',
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.lotIdIsAuctionId, true);
    assert.equal(listed.json.liveActivated, false);
    assert.equal(listed.json.entries.filter((e) => e.status === 'queued').length, 1);
    assert.equal(listed.json.entries[0].auctionId, horse.id);
  });

  it('reorders and withdraws before live without deleting the Auction', async (t) => {
    if (!url) return t.skip('no DB');
    const occ = await occurrence('horse', 72);
    const a = await approvedLot('horse');
    const b = await approvedLot('horse');
    const first = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: a.id },
    });
    const second = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: b.id },
    });
    assert.equal(first.json.entry.position, 1);
    assert.equal(second.json.entry.position, 2);

    const reordered = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue/reorder`, {
      method: 'POST',
      token: 'admin',
      body: { entryIds: [second.json.entry.id, first.json.entry.id] },
    });
    assert.equal(reordered.status, 200);
    const queued = reordered.json.entries.filter((e) => e.status === 'queued');
    assert.equal(queued[0].id, second.json.entry.id);
    assert.equal(queued[0].position, 1);
    assert.equal(queued[1].id, first.json.entry.id);

    const noReason = await httpJson(baseUrl, `/admin/v2/haraj/queue-entries/${first.json.entry.id}/withdraw`, {
      method: 'POST',
      token: 'admin',
      body: {},
    });
    assert.equal(noReason.status, 400);

    const withdrawn = await httpJson(baseUrl, `/admin/v2/haraj/queue-entries/${first.json.entry.id}/withdraw`, {
      method: 'POST',
      token: 'admin',
      body: { reason: 'انسحاب قبل البث' },
    });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.json.entry.status, 'withdrawn');
    assert.equal(withdrawn.json.entry.auctionId, a.id);

    const auction = await httpJson(baseUrl, `/auctions/${a.id}`, { token: 'tok-seller' });
    assert.equal(auction.status, 200);
    assert.equal(auction.json.auction.id, a.id);

    const revived = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: a.id },
    });
    assert.equal(revived.status, 201);
    assert.equal(revived.json.entry.id, first.json.entry.id);
    assert.equal(revived.json.entry.status, 'queued');
  });

  it('forbids queue edits once the room occurrence is no longer idle', async (t) => {
    if (!url) return t.skip('no DB');
    const occ = await occurrence('horse', 84);
    const lot = await approvedLot('horse');
    await db.getPool().query(`UPDATE haraj_room_sessions SET status = 'pre_live' WHERE id = $1`, [occ.roomSessionId]);
    const assign = await httpJson(baseUrl, `/admin/v2/haraj/room-sessions/${occ.roomSessionId}/queue`, {
      method: 'POST',
      token: 'admin',
      body: { auctionId: lot.id },
    });
    assert.equal(assign.status, 409);
    assert.equal(assign.json.code, 'HARAJ_QUEUE_IMMUTABLE');
  });
});
