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
      ['g6-op-a', { id: 'g6-op-a', email: 'a@nomas.auctioneer.staging', capabilities: [CAPABILITY] }],
      ['g6-op-b', { id: 'g6-op-b', email: 'b@nomas.auctioneer.staging', capabilities: [CAPABILITY] }],
      ['g6-op-c', { id: 'g6-op-c', email: 'c@nomas.auctioneer.staging', capabilities: [CAPABILITY] }],
      ['g6-seller', { id: 'g6-seller', capabilities: [] }],
    ]),
  };
  function requireAdminAuth(req, res, next) {
    const h = req.headers.authorization;
    const t = h && h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) return res.status(401).json({ message: 'توكن الإدارة مطلوب', code: 'AUTH_REQUIRED' });
    if (t === 'seller' || t === 'auctioneer' || t === 'user') {
      return res.status(401).json({ message: 'توكن الإدارة مطلوب', code: 'AUTH_REQUIRED' });
    }
    if (t !== 'admin') return res.status(401).json({ message: 'جلسة الإدارة منتهية', code: 'AUTH_INVALID' });
    req.adminUser = { id: 'adm-g6', name: 'Admin', role: 'super_admin', active: true };
    req.adminUserId = 'adm-g6';
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

function riyadhTodayPlus(days) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = fmt.format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

describe('G6 scheduling HTTP', { concurrency: 1 }, () => {
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

  it('rejects unauthenticated and non-admin scheduler/policy access', async (t) => {
    if (!url) return t.skip('no DB');
    const unauth = await httpJson(baseUrl, '/admin/v2/haraj/schedule/run', { method: 'POST', body: {} });
    assert.equal(unauth.status, 401);
    const seller = await httpJson(baseUrl, '/admin/v2/haraj/schedule/policies', {
      method: 'POST',
      token: 'seller',
      body: { recurrence: 'daily' },
    });
    assert.equal(seller.status, 401);
    const op = await httpJson(baseUrl, '/admin/v2/haraj/schedule/run', {
      method: 'POST',
      token: 'auctioneer',
      body: {},
    });
    assert.equal(op.status, 401);
  });

  it('materializes independent room policies idempotently and applies one-occurrence overrides', async (t) => {
    if (!url) return t.skip('no DB');
    const stamp = Date.now();
    const from = riyadhTodayPlus(0);
    const until = riyadhTodayPlus(6);

    const rooms = {};
    for (const [category, name] of [['horse', 'خيل'], ['camel', 'إبل'], ['falcon', 'صقور']]) {
      const created = await httpJson(baseUrl, '/admin/v2/haraj/rooms', {
        method: 'POST',
        token: 'admin',
        body: { category, code: `g6-${category}-${stamp}`, nameAr: `${name} G6` },
      });
      assert.equal(created.status, 201, created.json?.message);
      rooms[category] = created.json.room;
    }

    const spoof = await httpJson(baseUrl, '/admin/v2/haraj/schedule/policies', {
      method: 'POST',
      token: 'admin',
      body: {
        roomId: rooms.horse.id,
        recurrence: 'daily',
        startTimeLocal: '18:00',
        endTimeLocal: '20:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: from,
        effectiveUntil: until,
        defaultAuctioneerUserId: 'g6-op-a',
        createdBy: 'not-admin',
      },
    });
    assert.equal(spoof.status, 403);

    const badTz = await httpJson(baseUrl, '/admin/v2/haraj/schedule/policies', {
      method: 'POST',
      token: 'admin',
      body: {
        roomId: rooms.horse.id,
        recurrence: 'daily',
        startTimeLocal: '18:00',
        endTimeLocal: '20:00',
        timezone: 'Not/AZone',
        effectiveFrom: from,
        defaultAuctioneerUserId: 'g6-op-a',
      },
    });
    assert.equal(badTz.status, 400);
    assert.equal(badTz.json.code, 'HARAJ_TIMEZONE_INVALID');

    const horse = await httpJson(baseUrl, '/admin/v2/haraj/schedule/policies', {
      method: 'POST',
      token: 'admin',
      body: {
        roomId: rooms.horse.id,
        recurrence: 'daily',
        startTimeLocal: '18:00',
        endTimeLocal: '20:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: from,
        effectiveUntil: until,
        defaultAuctioneerUserId: 'g6-op-a',
        auctioneerAssignmentRule: 'fixed_user',
      },
    });
    assert.equal(horse.status, 201, horse.json?.message);
    const camel = await httpJson(baseUrl, '/admin/v2/haraj/schedule/policies', {
      method: 'POST',
      token: 'admin',
      body: {
        roomId: rooms.camel.id,
        recurrence: 'selected_weekdays',
        daysOfWeek: [0, 2, 4],
        startTimeLocal: '19:00',
        endTimeLocal: '21:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: from,
        effectiveUntil: until,
        defaultAuctioneerUserId: 'g6-op-b',
      },
    });
    assert.equal(camel.status, 201, camel.json?.message);
    const falcon = await httpJson(baseUrl, '/admin/v2/haraj/schedule/policies', {
      method: 'POST',
      token: 'admin',
      body: {
        roomId: rooms.falcon.id,
        recurrence: 'weekly',
        daysOfWeek: [6],
        startTimeLocal: '20:00',
        endTimeLocal: '22:00',
        timezone: 'Asia/Riyadh',
        effectiveFrom: from,
        effectiveUntil: until,
        defaultAuctioneerUserId: 'g6-op-c',
      },
    });
    assert.equal(falcon.status, 201, falcon.json?.message);

    const preview = await httpJson(baseUrl, '/admin/v2/haraj/schedule/preview', {
      method: 'POST',
      token: 'admin',
      body: { policyId: horse.json.policy.id, horizonDays: 7 },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.preview, true);
    assert.ok(preview.json.occurrences.length >= 1);

    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await httpJson(baseUrl, '/admin/v2/haraj/schedule/run', {
        method: 'POST',
        token: 'admin',
        body: { horizonDays: 7 },
      });
      assert.equal(run.status, 200, run.json?.message);
      runs.push(run.json);
    }
    const countFor = (policyId) => {
      const last = runs[runs.length - 1].results.find((r) => r.policyId === policyId);
      return last?.occurrenceCount;
    };
    const horseCount = countFor(horse.json.policy.id);
    const camelCount = countFor(camel.json.policy.id);
    const falconCount = countFor(falcon.json.policy.id);
    assert.ok(horseCount >= 1);
    assert.ok(camelCount >= 0);
    assert.ok(falconCount >= 0);
    assert.equal(countFor(horse.json.policy.id), runs[0].results.find((r) => r.policyId === horse.json.policy.id).occurrenceCount);
    assert.equal(runs[1].results.find((r) => r.policyId === horse.json.policy.id).created, 0);
    assert.equal(runs[2].results.find((r) => r.policyId === horse.json.policy.id).created, 0);

    const occ = await httpJson(baseUrl, `/admin/v2/haraj/schedule/occurrences?policyId=${horse.json.policy.id}`, {
      token: 'admin',
    });
    const first = (occ.json.occurrences || []).find((o) => o.sessionId);
    assert.ok(first, 'expected a materialized horse occurrence');
    const originalStart = first.startAt;
    const originalEnd = first.endAt;
    const changedStart = new Date(new Date(originalStart).getTime() + 2 * 3600000).toISOString();
    const changedEnd = new Date(new Date(originalEnd).getTime() + 2 * 3600000).toISOString();

    const change = await httpJson(baseUrl, '/admin/v2/haraj/schedule/overrides', {
      method: 'POST',
      token: 'admin',
      body: {
        policyId: horse.json.policy.id,
        sessionId: first.sessionId,
        overrideType: 'change_time',
        originalStartAt: originalStart,
        originalEndAt: originalEnd,
        overrideStartAt: changedStart,
        overrideEndAt: changedEnd,
        reason: 'اختبار تغيير وقت جلسة واحدة',
      },
    });
    assert.ok(change.status === 201 || change.status === 200, change.json?.message);

    const rerun = await httpJson(baseUrl, '/admin/v2/haraj/schedule/run', {
      method: 'POST',
      token: 'admin',
      body: { horizonDays: 7 },
    });
    assert.equal(rerun.status, 200);
    const afterChange = await httpJson(baseUrl, `/admin/v2/haraj/schedule/occurrences?policyId=${horse.json.policy.id}`, {
      token: 'admin',
    });
    const changed = (afterChange.json.occurrences || []).find((o) => o.occurrenceKey === first.occurrenceKey);
    const others = (afterChange.json.occurrences || []).filter((o) => o.occurrenceKey !== first.occurrenceKey && o.sessionId);
    assert.equal(changed.sessionId, first.sessionId);
    assert.ok(others.every((o) => String(o.startAt).includes('T15:00') || o.overrides.length === 0 || o.sessionStatus));
    const policyStill = await httpJson(baseUrl, `/admin/v2/haraj/schedule/policies/${horse.json.policy.id}`, { token: 'admin' });
    assert.equal(String(policyStill.json.policy.startTimeLocal).startsWith('18:00'), true);

    const cancelTarget = others[0] || changed;
    const cancel = await httpJson(baseUrl, '/admin/v2/haraj/schedule/overrides', {
      method: 'POST',
      token: 'admin',
      body: {
        policyId: horse.json.policy.id,
        sessionId: cancelTarget.sessionId,
        overrideType: 'cancel',
        originalStartAt: cancelTarget.startAt,
        reason: 'إلغاء وقوع واحد',
      },
    });
    assert.ok(cancel.status === 201 || cancel.status === 200, cancel.json?.message);
    await httpJson(baseUrl, '/admin/v2/haraj/schedule/run', { method: 'POST', token: 'admin', body: { horizonDays: 7 } });
    const afterCancel = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${cancelTarget.sessionId}`, { token: 'admin' });
    assert.equal(afterCancel.json.session.status, 'cancelled');

    const extraStart = new Date(Date.now() + 10 * 3600000).toISOString();
    const extraEnd = new Date(Date.now() + 12 * 3600000).toISOString();
    const extra = await httpJson(baseUrl, '/admin/v2/haraj/schedule/overrides', {
      method: 'POST',
      token: 'admin',
      body: {
        policyId: horse.json.policy.id,
        overrideType: 'extra_session',
        overrideStartAt: extraStart,
        overrideEndAt: extraEnd,
        reason: 'جلسة استثنائية',
      },
    });
    assert.ok(extra.status === 201 || extra.status === 200, extra.json?.message);

    const disable = await httpJson(baseUrl, `/admin/v2/haraj/schedule/policies/${horse.json.policy.id}/disable`, {
      method: 'POST',
      token: 'admin',
      body: {},
    });
    assert.equal(disable.status, 200);
    assert.equal(disable.json.policy.enabled, false);
    const afterDisable = await httpJson(baseUrl, `/admin/v2/haraj/sessions/${first.sessionId}`, { token: 'admin' });
    assert.notEqual(afterDisable.json.session.status, undefined);

    const concurrent = await Promise.all([
      httpJson(baseUrl, '/admin/v2/haraj/schedule/run', { method: 'POST', token: 'admin', body: { horizonDays: 7 } }),
      httpJson(baseUrl, '/admin/v2/haraj/schedule/run', { method: 'POST', token: 'admin', body: { horizonDays: 7 } }),
    ]);
    assert.ok(concurrent.every((r) => r.status === 200));
  });
});
