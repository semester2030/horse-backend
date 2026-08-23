'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

describe('Auction lifecycle worker — scheduled→live / live→close', () => {
  let db;
  let auctionService;
  let bidService;
  let runLifecycleTick;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    delete require.cache[require.resolve('./services/auction_service')];
    delete require.cache[require.resolve('./services/lifecycle_worker')];
    db = require('./db');
    auctionService = require('./services/auction_service');
    bidService = require('./services/bid_service');
    ({ runLifecycleTick } = require('./services/lifecycle_worker'));
    await db.runMigrations();
  });

  after(async () => {
    if (db) await db.closePool();
  });

  async function wipe(client) {
    await client.query('DELETE FROM auction_risk_signals');
    await client.query('DELETE FROM auction_disputes');
    await client.query('DELETE FROM audio_sessions');
    await client.query('UPDATE auctions SET host_booking_id = NULL');
    await client.query('DELETE FROM host_bookings');
    await client.query('DELETE FROM host_availability');
    await client.query('DELETE FROM auction_events');
    await client.query('DELETE FROM bids');
    await client.query('DELETE FROM auctions');
    await client.query('DELETE FROM auction_lots');
    await client.query('DELETE FROM auction_hosts');
  }

  async function seedScheduled(client, { startOffsetMs, endOffsetMs, requiresHost = false } = {}) {
    const now = Date.now();
    const auction = await auctionService.createAuctionDraft(client, {
      listingId: `L-life-${now}-${Math.random().toString(36).slice(2, 7)}`,
      videoId: `V-life-${now}-${Math.random().toString(36).slice(2, 7)}`,
      species: 'horse',
      ownerUserId: 'owner-life',
      createdByUserId: 'owner-life',
      startingPrice: 1000,
      minimumIncrement: 100,
      startAt: new Date(now + (startOffsetMs ?? 3600000)).toISOString(),
      endAt: new Date(now + (endOffsetMs ?? 7200000)).toISOString(),
      requiresHost,
    });
    await auctionService.transitionAuction(client, auction.id, 'review', {
      actorUserId: 'owner-life',
    });
    const { approveAuctionReview } = require('./services/approval_flow');
    const scheduled = await approveAuctionReview(client, auction.id, 'admin', {
      bypass: 'admin',
    });
    assert.equal(scheduled.status, 'scheduled');
    return scheduled;
  }

  it('unit: lifecycle worker + goLiveIfDue are exported', () => {
    const svc = require('./services/auction_service');
    const lw = require('./services/lifecycle_worker');
    assert.equal(typeof svc.goLiveIfDue, 'function');
    assert.equal(typeof lw.runLifecycleTick, 'function');
    assert.equal(typeof lw.startAuctionLifecycleWorker, 'function');
  });

  it('scheduled before startAt stays upcoming after tick', async (t) => {
    if (!url) return t.skip('no DB');
    let id;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedScheduled(client, { startOffsetMs: 3600000, endOffsetMs: 7200000 });
      id = a.id;
    });
    const tick = await runLifecycleTick();
    assert.equal(tick.skipped, false);
    assert.equal(tick.goLive.length, 0);
    await db.withTransaction(async (client) => {
      const { rows } = await client.query('SELECT status FROM auctions WHERE id = $1', [id]);
      assert.equal(rows[0].status, 'scheduled');
    });
  });

  it('startAt reached → auto live (idempotent second tick)', async (t) => {
    if (!url) return t.skip('no DB');
    let id;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedScheduled(client, { startOffsetMs: 3600000, endOffsetMs: 7200000 });
      id = a.id;
      await client.query(
        `UPDATE auctions SET start_at = NOW() - INTERVAL '1 minute', end_at = NOW() + INTERVAL '1 hour' WHERE id = $1`,
        [id],
      );
    });

    const tick1 = await runLifecycleTick();
    assert.equal(tick1.goLive.length, 1);
    assert.equal(tick1.goLive[0].auction.id, id);
    assert.equal(tick1.goLive[0].auction.status, 'live');

    const tick2 = await runLifecycleTick();
    assert.equal(tick2.goLive.length, 0);

    await db.withTransaction(async (client) => {
      const { rows } = await client.query('SELECT status FROM auctions WHERE id = $1', [id]);
      assert.equal(rows[0].status, 'live');
      const { rows: events } = await client.query(
        `SELECT payload FROM auction_events
         WHERE auction_id = $1 AND event_type = 'auction.status_changed'`,
        [id],
      );
      const liveEvents = events.filter((e) => e.payload?.to === 'live');
      assert.equal(liveEvents.length, 1);
    });
  });

  it('past endAt → auto terminal (sold/unsold), idempotent', async (t) => {
    if (!url) return t.skip('no DB');
    let id;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedScheduled(client, { startOffsetMs: 3600000, endOffsetMs: 7200000 });
      id = a.id;
      await client.query(
        `UPDATE auctions SET start_at = NOW() - INTERVAL '2 hours', end_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [id],
      );
    });

    // Same tick may go-live then close when both start and end are due.
    const tick1 = await runLifecycleTick();
    await db.withTransaction(async (client) => {
      const { rows } = await client.query('SELECT status FROM auctions WHERE id = $1', [id]);
      assert.ok(['sold', 'unsold'].includes(rows[0].status), rows[0].status);
    });
    assert.ok(
      tick1.closed.some((c) => c.auction.id === id) ||
        (tick1.goLive.some((g) => g.auction.id === id) &&
          (await runLifecycleTick()).closed.some((c) => c.auction.id === id)),
    );

    const tick2 = await runLifecycleTick();
    assert.equal(tick2.closed.filter((c) => c.auction.id === id).length, 0);
  });

  it('requiresHost=false does not block auto go-live', async (t) => {
    if (!url) return t.skip('no DB');
    let id;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedScheduled(client, {
        startOffsetMs: -60000,
        endOffsetMs: 3600000,
        requiresHost: false,
      });
      id = a.id;
      await client.query(
        `UPDATE auctions SET start_at = NOW() - INTERVAL '30 seconds' WHERE id = $1`,
        [id],
      );
    });
    const tick = await runLifecycleTick();
    assert.ok(tick.goLive.some((g) => g.auction.id === id && g.auction.status === 'live'));
  });

  it('concurrent ticks do not double-transition', async (t) => {
    if (!url) return t.skip('no DB');
    let id;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedScheduled(client, { startOffsetMs: 3600000, endOffsetMs: 7200000 });
      id = a.id;
      await client.query(
        `UPDATE auctions SET start_at = NOW() - INTERVAL '10 seconds', end_at = NOW() + INTERVAL '1 hour' WHERE id = $1`,
        [id],
      );
    });

    const [a, b] = await Promise.all([runLifecycleTick(), runLifecycleTick()]);
    const liveCount = [...a.goLive, ...b.goLive].filter((g) => g.auction.id === id).length;
    assert.equal(liveCount, 1);

    await db.withTransaction(async (client) => {
      const { rows: events } = await client.query(
        `SELECT payload FROM auction_events
         WHERE auction_id = $1 AND event_type = 'auction.status_changed'`,
        [id],
      );
      assert.equal(events.filter((e) => e.payload?.to === 'live').length, 1);
    });
  });

  it('hub bucket contract: upcoming=scheduled, live=live|extended (source)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'services/auction_query_service.js'),
      'utf8',
    );
    assert.match(src, /upcoming[\s\S]*scheduled/);
    assert.match(src, /live[\s\S]*extended/);
  });
});
