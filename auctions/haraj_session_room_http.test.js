'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITY } = require('./services/haraj_auctioneer_auth');

const url =
  process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

function buildApp(registerAuctionAdminRoutes) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  const store = {
    users: new Map([
      ['g5-op', { id: 'g5-op', email: 'op@nomas.auctioneer.staging', capabilities: [CAPABILITY] }],
      ['g5-op-2', { id: 'g5-op-2', email: 'op2@nomas.auctioneer.staging', capabilities: [CAPABILITY] }],
      ['g5-seller', { id: 'g5-seller', capabilities: [] }],
    ]),
  };
  function requireAdminAuth(req, res, next) {
    const h = req.headers.authorization;
    const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) return res.status(401).json({ message: 'توكن الإدارة مطلوب', code: 'AUTH_REQUIRED' });
    if (t === 'seller' || t === 'auctioneer') {
      return res.status(401).json({ message: 'توكن الإدارة مطلوب', code: 'AUTH_REQUIRED' });
    }
    if (t !== 'admin') return res.status(401).json({ message: 'جلسة الإدارة منتهية', code: 'AUTH_INVALID' });
    req.adminUser = { id: 'adm-1', name: 'Admin', role: 'super_admin', active: true };
    req.adminUserId = 'adm-1';
    next();
  }
  function requirePerm() {
    return (req, res, next) => next();
  }
  function logAudit() {}
  const adminRouter = express.Router();
  registerAuctionAdminRoutes(adminRouter, {
    requireAdminAuth,
    requirePerm,
    logAudit,
    store,
  });
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

describe('G5 session/room HTTP', { concurrency: 1 }, () => {
  let db;
  let server;
  let baseUrl;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    for (const mod of ['./db', './config', './routes']) {
      delete require.cache[require.resolve(mod)];
    }
    db = require('./db');
    await db.runMigrations();
    const { registerAuctionAdminRoutes } = require('./routes');
    server = buildApp(registerAuctionAdminRoutes).listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close());
    if (db) await db.closePool();
  });

  function windowFor(hoursFromNow = 24) {
    const start = new Date(Date.now() + hoursFromNow * 3600000);
    return {
      scheduledStartAt: start.toISOString(),
      scheduledEndAt: new Date(start.getTime() + 4 * 3600000).toISOString(),
      timezone: 'Asia/Riyadh',
    };
  }

  it('rejects unauthenticated and non-admin actors', async (t) => {
    if (!url) return t.skip('no DB');
    const unauth = await httpJson(baseUrl, '/admin/v2/haraj/sessions', { method: 'POST', body: {} });
    assert.equal(unauth.status, 401);
    const seller = await httpJson(baseUrl, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: 'seller',
      body: { category: 'horse', ...windowFor() },
    });
    assert.equal(seller.status, 401);
    const op = await httpJson(baseUrl, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: 'auctioneer',
      body: { category: 'horse', ...windowFor() },
    });
    assert.equal(op.status, 401);
  });

  it('creates category-scoped session and attaches matching rooms only', async (t) => {
    if (!url) return t.skip('no DB');
    const stamp = Date.now();
    const created = await httpJson(baseUrl, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: 'admin',
      body: { category: 'horse', ...windowFor(), createdBy: 'spoof' },
    });
    assert.equal(created.status, 403);

    const session = await httpJson(baseUrl, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: 'admin',
      headers: { 'Idempotency-Key': `g5-${stamp}` },
      body: { category: 'horse', ...windowFor() },
    });
    assert.equal(session.status, 201);
    assert.equal(session.json.session.status, 'planned');
    assert.equal(session.json.session.generationSource, 'manual_admin');
    assert.equal(session.json.session.categoryCode, 'horse');
    assert.equal(session.json.session.financialAuthority, false);

    const replay = await httpJson(baseUrl, '/admin/v2/haraj/sessions', {
      method: 'POST',
      token: 'admin',
      headers: { 'Idempotency-Key': `g5-${stamp}` },
      body: { category: 'horse', ...windowFor(30) },
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.json.session.id, session.json.session.id);

    const camelRoom = await httpJson(baseUrl, '/admin/v2/haraj/rooms', {
      method: 'POST',
      token: 'admin',
      body: { category: 'camel', code: `camel-${stamp}`, nameAr: 'غرفة الإبل' },
    });
    assert.equal(camelRoom.status, 201);

    const mismatch = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: 'admin',
      body: {
        roomId: camelRoom.json.room.id,
        auctioneerUserId: 'g5-op',
      },
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.json.code, 'HARAJ_CATEGORY_MISMATCH');

    const attach = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: 'admin',
      body: {
        category: 'horse',
        code: `horse-a-${stamp}`,
        nameAr: 'غرفة الخيل أ',
        auctioneerUserId: 'g5-op',
      },
    });
    assert.equal(attach.status, 201);
    assert.equal(attach.json.session.rooms.length >= 1, true);
    assert.equal(attach.json.roomSession.activeLotId == null, true);

    const overlap = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: 'admin',
      body: {
        category: 'horse',
        code: `horse-b-${stamp}`,
        nameAr: 'غرفة الخيل ب',
        auctioneerUserId: 'g5-op',
      },
    });
    assert.equal(overlap.status, 409);
    assert.equal(overlap.json.code, 'HARAJ_AUCTIONEER_CONFLICT');

    const second = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: 'admin',
      body: {
        category: 'horse',
        code: `horse-b-${stamp}`,
        nameAr: 'غرفة الخيل ب',
        auctioneerUserId: 'g5-op-2',
      },
    });
    assert.equal(second.status, 201);
    assert.equal(second.json.session.rooms.length, 2);

    const cancel = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${session.json.session.id}/cancel`, {
      method: 'POST',
      token: 'admin',
      body: { reason: 'اختبار' },
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.json.session.status, 'cancelled');

    const afterCancel = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${session.json.session.id}/rooms`, {
      method: 'POST',
      token: 'admin',
      body: {
        category: 'horse',
        code: `horse-c-${stamp}`,
        auctioneerUserId: 'g5-op-2',
      },
    });
    assert.equal(afterCancel.status, 409);
  });
});
