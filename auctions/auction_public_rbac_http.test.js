'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { createAdminRouter } = require('../admin/routes');
const { signToken } = require('../admin/auth');
const { ADMIN_ROLES, permissionsForRole } = require('../admin/permissions');

function makeAdmin(id, role) {
  return {
    id,
    email: `${role}@rbac-test.nomas`,
    name: role,
    role,
    permissions: permissionsForRole(role),
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildAdminTestApp() {
  const supportId = 'admin-rbac-support';
  const moderatorId = 'admin-rbac-moderator';
  const analystId = 'admin-rbac-analyst';
  const adminUsers = new Map([
    [supportId, makeAdmin(supportId, ADMIN_ROLES.support)],
    [moderatorId, makeAdmin(moderatorId, ADMIN_ROLES.moderator)],
    [analystId, makeAdmin(analystId, ADMIN_ROLES.analyst)],
  ]);
  const store = {
    adminUsers,
    users: new Map(),
    horses: new Map(),
    catalogItems: new Map(),
    videos: new Map(),
    orders: new Map(),
    bookings: new Map(),
    trips: new Map(),
    expertRequests: new Map(),
    experts: new Map(),
    contentReports: new Map(),
    listings: new Map(),
    auditLog: [],
  };
  const adminJwtSecret = 'test-auction-rbac-http-secret';
  const adminCtx = {
    store,
    saveStore: () => {},
    id: () => crypto.randomUUID(),
    roles: require('../account_roles'),
    verificationDir: '/tmp/nomas-rbac-test',
    adminJwtSecret,
    marketplaceCommerce: {},
    bookingOccupancy: {},
    notifyEvent: () => {},
  };
  const app = express();
  app.use(express.json());
  app.use('/admin/v2', createAdminRouter(adminCtx));
  const token = (adminId) => signToken({ sub: adminId }, adminJwtSecret);
  return {
    app,
    tokens: {
      support: token(supportId),
      moderator: token(moderatorId),
      analyst: token(analystId),
    },
  };
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

describe('PR-02 — HTTP RBAC denial (admin auction routes)', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let auctionService;
  let server;
  let baseUrl;
  let tokens;
  let liveAuctionId;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    await db.runMigrations();
    pool = db.getPool();
    auctionService = require('./services/auction_service');

    const { app, tokens: t } = buildAdminTestApp();
    tokens = t;
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/admin/v2`;

    const client = await pool.connect();
    try {
      await client.query('DELETE FROM auction_ws_events');
      await client.query('DELETE FROM auction_risk_signals');
      await client.query('DELETE FROM auction_disputes');
      await client.query('DELETE FROM auction_events');
      await client.query('DELETE FROM bids');
      await client.query('DELETE FROM auctions');
      await client.query('DELETE FROM auction_lots');
      const lot = await auctionService.upsertLot(client, {
        listingId: `lst-rbac-${Date.now()}`,
        videoId: `vid-rbac-${Date.now()}`,
        species: 'horse',
        title: 'RBAC HTTP',
      });
      const end = new Date(Date.now() + 3600_000);
      const { rows } = await client.query(
        `INSERT INTO auctions (
          lot_id, owner_user_id, created_by_user_id, created_by_role,
          species, status, starting_price, minimum_increment, current_price,
          start_at, end_at, anti_sniping_seconds, settlement_note, version
        ) VALUES ($1,$2,$3,'seller','horse','live',1000,100,1000,NOW(),$4,30,'note',1)
        RETURNING id`,
        [lot.id, 'owner-rbac', 'owner-rbac', end.toISOString()],
      );
      liveAuctionId = rows[0].id;
    } finally {
      client.release();
    }
  });

  after(async () => {
    if (server) server.close();
    if (db?.closePool) await db.closePool();
  });

  it('unauthenticated GET /auctions → 401', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, '/auctions');
    assert.equal(res.status, 401);
  });

  it('support denied auctions:read — GET /auctions → 403', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, '/auctions', { token: tokens.support });
    assert.equal(res.status, 403);
    assert.match(res.json?.message || '', /صلاحية/);
  });

  it('support denied auctions:ops — POST freeze → 403', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, `/auctions/${liveAuctionId}/freeze`, {
      method: 'POST',
      token: tokens.support,
      body: { reason: 'test' },
    });
    assert.equal(res.status, 403);
  });

  it('support denied auctions:disputes — GET disputes → 403', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, '/auctions/disputes', { token: tokens.support });
    assert.equal(res.status, 403);
  });

  it('support denied auctions:moderate — POST review → 403', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, `/auctions/${liveAuctionId}/review`, {
      method: 'POST',
      token: tokens.support,
      body: { decision: 'approve' },
    });
    assert.equal(res.status, 403);
  });

  it('analyst denied auctions:read — GET /auctions → 403', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, '/auctions', { token: tokens.analyst });
    assert.equal(res.status, 403);
  });

  it('moderator allowed auctions:read — GET /auctions → 200', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, '/auctions', { token: tokens.moderator });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json?.auctions));
  });

  it('moderator allowed auctions:read — GET /auctions/:id → 200', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, `/auctions/${liveAuctionId}`, {
      token: tokens.moderator,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.auction?.id, liveAuctionId);
  });

  it('moderator allowed auctions:disputes — GET disputes → 200', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, '/auctions/disputes', { token: tokens.moderator });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json?.disputes));
  });

  it('moderator allowed auctions:ops — POST freeze → not 403', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, `/auctions/${liveAuctionId}/freeze`, {
      method: 'POST',
      token: tokens.moderator,
      body: { reason: 'rbac-http-test' },
    });
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 200);
    assert.equal(res.json?.auction?.status, 'frozen');
  });

  it('moderator allowed auctions:moderate — POST risk evaluate → not 403', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const res = await httpJson(baseUrl, `/auctions/${liveAuctionId}/risk-signals/evaluate`, {
      method: 'POST',
      token: tokens.moderator,
      body: {},
    });
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json?.signals));
  });
});
