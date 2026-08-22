'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { canTransition, isBiddableStatus, effectiveEndAt } = require('./domain/states');
const { assertSpecies } = require('./domain/species');
const { ENABLE_AUCTIONS, SETTLEMENT_NOTE } = require('./config');
const { DECISION } = require('./audio/compare');
const { createNoopAudioProvider } = require('./audio/noop_provider');
const { money } = require('./services/auction_service');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const APP_CONFIG_PATH = path.join(__dirname, '..', '..', 'app', 'lib', 'shared', 'constants', 'app_config.dart');

describe('Auction V1 — unit (no PostgreSQL required)', () => {
  it('lifecycle transitions follow frozen state machine', () => {
    assert.equal(canTransition('draft', 'review'), true);
    assert.equal(canTransition('review', 'scheduled'), true);
    assert.equal(canTransition('scheduled', 'live'), true);
    assert.equal(canTransition('live', 'extended'), true);
    assert.equal(canTransition('extended', 'ended'), true);
    assert.equal(canTransition('ended', 'sold'), true);
    assert.equal(canTransition('draft', 'live'), false);
    assert.equal(isBiddableStatus('live'), true);
    assert.equal(isBiddableStatus('scheduled'), false);
  });

  it('V1 species gate rejects equipment/sheep', () => {
    assert.equal(assertSpecies('horse'), 'horse');
    assert.equal(assertSpecies('camel'), 'camel');
    assert.throws(() => assertSpecies('equipment'), /not eligible/);
    assert.throws(() => assertSpecies('sheep'), /not eligible/);
  });

  it('settlement note documents no financial completion in V1', () => {
    assert.match(SETTLEMENT_NOTE, /out of band/i);
  });

  it('feature flag defaults OFF in backend config', () => {
    const prev = process.env.ENABLE_AUCTIONS;
    delete process.env.ENABLE_AUCTIONS;
    delete require.cache[require.resolve('./config')];
    const { isAuctionsEnabled } = require('./config');
    assert.equal(isAuctionsEnabled(), false);
    if (prev == null) delete process.env.ENABLE_AUCTIONS;
    else process.env.ENABLE_AUCTIONS = prev;
    delete require.cache[require.resolve('./config')];
  });

  it('Store Release isolation — app_config enableAuctions default false', () => {
    const src = fs.readFileSync(APP_CONFIG_PATH, 'utf8');
    assert.match(src, /enableAuctions/);
    assert.match(src, /defaultValue: false/);
  });

  it('health payload includes auctions isolation block', () => {
    const src = fs.readFileSync(INDEX_PATH, 'utf8');
    assert.match(src, /auctions:\s*\{/);
    assert.match(src, /ENABLE_AUCTIONS/);
  });

  it('audio noop provider — failure does not throw (bidding continues pattern)', async () => {
    const p = createNoopAudioProvider();
    const session = await p.createSession({ auctionId: 'a1', hostId: 'h1', hostUserId: 'u1' });
    assert.equal(session.ok, true);
    assert.equal(p.name, 'noop');
  });

  it('audio decision prefers LiveKit and documents wiring path', () => {
    assert.equal(DECISION.selected, 'livekit');
    assert.equal(DECISION.wired, true);
  });

  it('money helper rounds currency', () => {
    assert.equal(money(10.005), 10.01);
  });

  it('anti-sniping uses effective end', () => {
    const end = effectiveEndAt({
      end_at: '2030-01-01T12:00:00Z',
      extended_until: '2030-01-01T12:05:00Z',
    });
    assert.equal(end.toISOString(), '2030-01-01T12:05:00.000Z');
  });
});

describe('Auction V1 — PostgreSQL integration', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let bidService;
  let auctionService;
  let hostService;

  before(async () => {
    if (!url) {
      console.log('[auctions test] SKIP integration — set AUCTIONS_TEST_DATABASE_URL');
      return;
    }
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    bidService = require('./services/bid_service');
    auctionService = require('./services/auction_service');
    hostService = require('./services/host_service');
    await db.runMigrations();
    pool = db.getPool();
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

  async function seedLiveAuction(client, opts = {}) {
    const now = Date.now();
    const auction = await auctionService.createAuctionDraft(client, {
      listingId: opts.listingId || `L-${now}`,
      videoId: opts.videoId || `V-${now}`,
      species: 'horse',
      ownerUserId: opts.ownerUserId || 'owner-1',
      createdByUserId: opts.ownerUserId || 'owner-1',
      createdByRole: 'seller',
      startingPrice: 1000,
      minimumIncrement: 50,
      reservePrice: opts.reservePrice ?? null,
      startAt: new Date(now - 60000).toISOString(),
      endAt: new Date(now + 60000).toISOString(),
      antiSnipingSeconds: opts.antiSnipingSeconds ?? 30,
    });
    await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
    const { approveAuctionReview } = require('./services/approval_flow');
    await approveAuctionReview(client, auction.id, 'admin', { bypass: 'admin' });
    await auctionService.transitionAuction(client, auction.id, 'live', { actorUserId: 'admin' });
    const { rows } = await client.query(
      `SELECT a.*, l.listing_id, l.video_id FROM auctions a JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
      [auction.id],
    );
    return auctionService.mapAuctionRow(rows[0]);
  }

  it('atomic bid + idempotency + minimum increment', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      const r1 = await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-1',
        amount: 1050,
        idempotencyKey: 'k1',
      });
      assert.equal(r1.replay, false);
      assert.equal(r1.bid.amount, 1050);

      const r1b = await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-1',
        amount: 1050,
        idempotencyKey: 'k1',
      });
      assert.equal(r1b.replay, true);

      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: auction.id,
            bidderUserId: 'bidder-2',
            amount: 1060,
            idempotencyKey: 'k2',
          }),
        (e) => e.code === 'BID_INCREMENT_TOO_LOW',
      );
    });
  });

  it('owner cannot bid — unauthorized', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client, { ownerUserId: 'owner-x' });
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: auction.id,
            bidderUserId: 'owner-x',
            amount: 1050,
            idempotencyKey: 'k-owner',
          }),
        (e) => e.code === 'BID_OWNER_FORBIDDEN',
      );
    });
  });

  it('close race yields exactly one winner', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await wipe(client);
      const auction = await seedLiveAuction(client, {
        antiSnipingSeconds: 0,
      });
      await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-a',
        amount: 1050,
        idempotencyKey: 'win-a',
      });
      await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-b',
        amount: 1100,
        idempotencyKey: 'win-b',
      });
      await client.query(
        `UPDATE auctions SET end_at = NOW() - INTERVAL '1 second', extended_until = NULL WHERE id = $1`,
        [auction.id],
      );
      await client.query('COMMIT');

      const closed = await db.withTransaction((c) =>
        auctionService.closeAuctionAtomic(c, auction.id),
      );
      assert.equal(closed.status, 'sold');
      assert.equal(closed.winnerUserId, 'bidder-b');
      assert.ok(closed.winningBidId);

      const again = await db.withTransaction((c) =>
        auctionService.closeAuctionAtomic(c, auction.id),
      );
      assert.equal(again.status, 'sold');
      assert.equal(again.winnerUserId, 'bidder-b');
    } finally {
      client.release();
    }
  });

  it('host scheduling conflict detected', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const host = await hostService.registerHost(client, {
        userId: 'host-user-1',
        displayName: 'Host',
      });
      await client.query(
        `UPDATE auction_hosts SET status = 'active', verified_at = NOW() WHERE id = $1`,
        [host.id],
      );
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await hostService.addAvailability(client, {
        hostId: host.id,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      const a1 = await auctionService.createAuctionDraft(client, {
        listingId: 'L-h1',
        videoId: 'V-h1',
        species: 'camel',
        ownerUserId: 'owner-h',
        createdByUserId: 'owner-h',
        startingPrice: 500,
        minimumIncrement: 25,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: true,
      });
      await auctionService.transitionAuction(client, a1.id, 'review', { actorUserId: 'admin' });
      const { recordAuctionApproval } = require('./services/approval_flow');
      await recordAuctionApproval(client, a1.id, 'admin', { bypass: 'admin' });
      await hostService.requestHostBooking(client, {
        auctionId: a1.id,
        hostId: host.id,
        requestedByUserId: 'owner-h',
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: end.toISOString(),
      });
      const a2 = await auctionService.createAuctionDraft(client, {
        listingId: 'L-h2',
        videoId: 'V-h2',
        species: 'falcon',
        ownerUserId: 'owner-h2',
        createdByUserId: 'owner-h2',
        startingPrice: 500,
        minimumIncrement: 25,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        requiresHost: true,
      });
      await auctionService.transitionAuction(client, a2.id, 'review', { actorUserId: 'admin' });
      await recordAuctionApproval(client, a2.id, 'admin', { bypass: 'admin' });
      await assert.rejects(
        () =>
          hostService.requestHostBooking(client, {
            auctionId: a2.id,
            hostId: host.id,
            requestedByUserId: 'owner-h2',
            scheduledStartAt: start.toISOString(),
            scheduledEndAt: end.toISOString(),
          }),
        (e) => e.code === 'HOST_SCHEDULE_CONFLICT',
      );
    });
  });

  it('immutable event timeline appended', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      const { rows } = await client.query(
        `SELECT event_type FROM auction_events WHERE auction_id = $1 ORDER BY created_at ASC`,
        [auction.id],
      );
      assert.ok(rows.length >= 4);
      assert.equal(rows[0].event_type, 'auction.created');
    });
  });

  it('stale bid rejected when expectedVersion mismatches', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: auction.id,
            bidderUserId: 'bidder-stale',
            amount: 1050,
            idempotencyKey: 'stale-1',
            expectedVersion: 999,
          }),
        (e) => e.code === 'BID_STALE_VERSION',
      );
    });
  });

  it('concurrent same-amount bids — exactly one accepted, others rejected', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client, { antiSnipingSeconds: 0 });
      auctionId = auction.id;
    });

    const sameAmount = 1050;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        db.withTransaction((client) =>
          bidService.placeBid(client, {
            auctionId,
            bidderUserId: `bidder-race-${i}`,
            amount: sameAmount,
            idempotencyKey: `race-${i}`,
          }),
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected' && r.reason?.code === 'BID_INCREMENT_TOO_LOW',
    );
    assert.equal(fulfilled.length, 1, 'exactly one concurrent same-amount bid wins');
    assert.equal(rejected.length, 4, 'losers fail increment check after winner commits');

    const { rows: bids } = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(amount) AS max_amount FROM bids WHERE auction_id = $1`,
      [auctionId],
    );
    assert.equal(bids[0].n, 1);
    assert.equal(Number(bids[0].max_amount), sameAmount);

    const { rows: aRows } = await pool.query(
      `SELECT current_price, version FROM auctions WHERE id = $1`,
      [auctionId],
    );
    assert.equal(Number(aRows[0].current_price), sameAmount);
    assert.equal(Number(aRows[0].version), 2);
  });

  it('anti-sniping extends end when bid lands inside window', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const now = Date.now();
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: `L-snipe-${now}`,
        videoId: `V-snipe-${now}`,
        species: 'horse',
        ownerUserId: 'owner-snipe',
        createdByUserId: 'owner-snipe',
        startingPrice: 1000,
        minimumIncrement: 50,
        startAt: new Date(now - 60000).toISOString(),
        endAt: new Date(now + 15000).toISOString(),
        antiSnipingSeconds: 30,
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
      const { approveAuctionReview } = require('./services/approval_flow');
      await approveAuctionReview(client, auction.id, 'admin', { bypass: 'admin' });
      await auctionService.transitionAuction(client, auction.id, 'live', { actorUserId: 'admin' });

      await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-snipe',
        amount: 1050,
        idempotencyKey: 'snipe-1',
      });

      const { rows } = await client.query(
        `SELECT status, extended_until, end_at FROM auctions WHERE id = $1`,
        [auction.id],
      );
      assert.equal(rows[0].status, 'extended');
      assert.ok(rows[0].extended_until);
      assert.ok(new Date(rows[0].extended_until) > new Date(rows[0].end_at));
    });
  });

  it('reserve price — unsold when top bid below reserve', async (t) => {
    if (!url) return t.skip('no AUCTIONS_TEST_DATABASE_URL');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await wipe(client);
      const auction = await seedLiveAuction(client, {
        reservePrice: 5000,
        antiSnipingSeconds: 0,
      });
      await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-low',
        amount: 1050,
        idempotencyKey: 'reserve-low',
      });
      await client.query(
        `UPDATE auctions SET end_at = NOW() - INTERVAL '1 second', extended_until = NULL WHERE id = $1`,
        [auction.id],
      );
      await client.query('COMMIT');

      const closed = await db.withTransaction((c) =>
        auctionService.closeAuctionAtomic(c, auction.id),
      );
      assert.equal(closed.status, 'unsold');
      assert.equal(closed.winnerUserId, null);
    } finally {
      client.release();
    }
  });
});
