'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createWsHub, createRoomSequencer } = require('../ws_hub');
const {
  createAuctionRealtime,
  sanitizeBidderLabel,
} = require('./realtime/auction_realtime');

describe('Auction Phase 3 — WS hub (unit)', () => {
  it('publishAuction assigns monotonic seq per auction room', () => {
    const hub = createWsHub({
      resolveUserFromToken: () => ({ id: 'viewer1' }),
    });
    const a1 = hub.publishAuction({
      type: 'bid.accepted',
      auctionId: 'auc-1',
      currentPrice: 1000,
      version: 2,
      state: 'live',
    });
    const a2 = hub.publishAuction({
      type: 'bid.accepted',
      auctionId: 'auc-1',
      currentPrice: 1100,
      version: 3,
      state: 'live',
    });
    assert.equal(a1.seq, 1);
    assert.equal(a2.seq, 2);
    assert.equal(hub.currentSeq('auction:auc-1'), 2);
  });

  it('replayAfter returns ascending seq without duplicates', () => {
    const seq = createRoomSequencer(500);
    const room = 'auction:replay-test';
    for (let i = 0; i < 5; i += 1) {
      seq.assignAndStore(room, {
        type: 'bid.accepted',
        auctionId: 'replay-test',
        currentPrice: 1000 + i * 100,
      });
    }
    const replay = seq.replayAfter(room, 2);
    assert.deepEqual(
      replay.map((e) => e.seq),
      [3, 4, 5],
    );
  });

  it('100 sequenced events remain ordered', () => {
    const hub = createWsHub({
      resolveUserFromToken: () => ({ id: 'load-test' }),
    });
    const auctionId = 'load-100';
    const seqs = [];
    for (let i = 0; i < 100; i += 1) {
      const ev = hub.publishAuction({
        type: 'bid.accepted',
        auctionId,
        currentPrice: 1000 + i,
        version: i + 1,
        state: 'live',
      });
      seqs.push(ev.seq);
    }
    assert.equal(seqs.length, 100);
    assert.equal(seqs[0], 1);
    assert.equal(seqs[99], 100);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal(seqs[i], seqs[i - 1] + 1);
    }
  });

  it('sanitized bidder label hides full user id', () => {
    assert.equal(sanitizeBidderLabel('user-abcdef12'), 'مزايد ···ef12');
    assert.equal(sanitizeBidderLabel('ab'), 'مزايد');
  });
});

describe('Auction Phase 3 — subscribe auth (PostgreSQL)', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let auctionService;
  let realtime;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    pool = db.getPool();
    await db.runMigrations();
    auctionService = require('./services/auction_service');
    realtime = createAuctionRealtime({
      wsHub: { publishAuction: () => null },
      getPool: () => pool,
    });
  });

  after(async () => {
    if (db?.closePool) await db.closePool();
  });

  async function wipe(client) {
    await client.query('DELETE FROM auction_risk_signals');
    await client.query('DELETE FROM auction_disputes');
    await client.query('DELETE FROM auction_events');
    await client.query('DELETE FROM bids');
    await client.query('DELETE FROM auctions');
    await client.query('DELETE FROM auction_lots');
  }

  async function seedLive(client) {
    const lot = await auctionService.upsertLot(client, {
      listingId: 'lst-ws',
      videoId: 'vid-ws',
      species: 'horse',
      title: 'WS Gate',
    });
    const start = new Date(Date.now() + 60_000);
    const end = new Date(Date.now() + 3600_000);
    const { rows } = await client.query(
      `INSERT INTO auctions (
        lot_id, owner_user_id, created_by_user_id, created_by_role,
        species, status, starting_price, minimum_increment, current_price,
        start_at, end_at, anti_sniping_seconds, settlement_note
      ) VALUES ($1,$2,$3,'seller','horse','live',1000,100,1000,$4,$5,30,$6)
      RETURNING *`,
      [lot.id, 'owner-ws', 'owner-ws', start.toISOString(), end.toISOString(), 'out of band'],
    );
    return { ...rows[0], listing_id: lot.listing_id, video_id: lot.video_id };
  }

  it('owner can subscribe to draft-like forbidden status only when owner', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const client = await pool.connect();
    try {
      await wipe(client);
      const row = await seedLive(client);
      assert.equal(await realtime.canSubscribe('bidder-1', row.id), true);
      await client.query(`UPDATE auctions SET status = 'draft' WHERE id = $1`, [row.id]);
      assert.equal(await realtime.canSubscribe('bidder-1', row.id), false);
      assert.equal(await realtime.canSubscribe('owner-ws', row.id), true);
    } finally {
      client.release();
    }
  });

  it('unknown auction subscribe denied', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    assert.equal(
      await realtime.canSubscribe('u1', '00000000-0000-0000-0000-000000000099'),
      false,
    );
  });
});

describe('Auction Phase 3 — publish after commit (PostgreSQL integration)', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let bidService;
  let auctionService;
  let published;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    pool = db.getPool();
    await db.runMigrations();
    bidService = require('./services/bid_service');
    auctionService = require('./services/auction_service');
    published = [];
  });

  after(async () => {
    if (db?.closePool) await db.closePool();
  });

  function mockHub() {
    return {
      publishAuction(ev) {
        published.push(ev);
        return { ...ev, seq: published.length };
      },
    };
  }

  async function wipe(client) {
    await client.query('DELETE FROM auction_risk_signals');
    await client.query('DELETE FROM auction_disputes');
    await client.query('DELETE FROM auction_events');
    await client.query('DELETE FROM bids');
    await client.query('DELETE FROM auctions');
    await client.query('DELETE FROM auction_lots');
  }

  async function seedLive(client) {
    const lot = await auctionService.upsertLot(client, {
      listingId: 'lst-rt',
      videoId: 'vid-rt',
      species: 'horse',
      title: 'Realtime',
    });
    const end = new Date(Date.now() + 3600_000);
    const { rows } = await client.query(
      `INSERT INTO auctions (
        lot_id, owner_user_id, created_by_user_id, created_by_role,
        species, status, starting_price, minimum_increment, current_price,
        start_at, end_at, anti_sniping_seconds, settlement_note, version
      ) VALUES ($1,$2,$3,'seller','horse','live',1000,100,1000,NOW(),$4,30,'note',1)
      RETURNING *`,
      [lot.id, 'owner-rt', 'owner-rt', end.toISOString()],
    );
    return rows[0];
  }

  it('bid commit publishes bid.accepted with sanitized bidder label', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    published.length = 0;
    const rt = createAuctionRealtime({ wsHub: mockHub(), getPool: () => pool });
    const client = await pool.connect();
    try {
      await wipe(client);
      const auction = await seedLive(client);
      const result = await db.withTransaction((tx) =>
        bidService.placeBid(tx, {
          auctionId: auction.id,
          bidderUserId: 'bidder-secret-id',
          amount: 1100,
          idempotencyKey: 'ws-bid-1',
          expectedVersion: 1,
        }),
      );
      rt.publishBidAccepted(result.auction, result.bid, {
        wasExtended: result.wasExtended,
      });
      assert.equal(published.length >= 1, true);
      assert.equal(published[0].type, 'bid.accepted');
      assert.equal(published[0].bidderLabel, 'مزايد ···t-id');
      assert.ok(!published[0].bidderUserId);
      assert.equal(published[0].currentPrice, 1100);
    } finally {
      client.release();
    }
  });

  it('concurrent bids — DB truth + single winner per amount race', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const client = await pool.connect();
    try {
      await wipe(client);
      const auction = await seedLive(client);
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          db.withTransaction((tx) =>
            bidService.placeBid(tx, {
              auctionId: auction.id,
              bidderUserId: `bidder-${i}`,
              amount: 1100,
              idempotencyKey: `race-${i}`,
              expectedVersion: 1,
            }),
          ),
        ),
      );
      const ok = attempts.filter((a) => a.status === 'fulfilled');
      const fail = attempts.filter((a) => a.status === 'rejected');
      assert.equal(ok.length, 1);
      assert.equal(fail.length, 4);
      const { rows: bids } = await client.query(
        'SELECT COUNT(*)::int AS n FROM bids WHERE auction_id = $1',
        [auction.id],
      );
      assert.equal(bids[0].n, 1);
    } finally {
      client.release();
    }
  });

  it('anti-sniping extension published as auction.extended', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    published.length = 0;
    const rt = createAuctionRealtime({ wsHub: mockHub(), getPool: () => pool });
    const client = await pool.connect();
    try {
      await wipe(client);
      const end = new Date(Date.now() + 15_000);
      const lot = await auctionService.upsertLot(client, {
        listingId: 'lst-snipe',
        videoId: 'vid-snipe',
        species: 'horse',
      });
      const { rows } = await client.query(
        `INSERT INTO auctions (
          lot_id, owner_user_id, created_by_user_id, created_by_role,
          species, status, starting_price, minimum_increment, current_price,
          start_at, end_at, anti_sniping_seconds, settlement_note, version
        ) VALUES ($1,$2,$3,'seller','horse','live',1000,100,1000,NOW(),$4,60,'note',1)
        RETURNING *`,
        [lot.id, 'owner-snipe', 'owner-snipe', end.toISOString()],
      );
      const result = await db.withTransaction((tx) =>
        bidService.placeBid(tx, {
          auctionId: rows[0].id,
          bidderUserId: 'bidder-snipe',
          amount: 1100,
          idempotencyKey: 'snipe-1',
          expectedVersion: 1,
        }),
      );
      rt.publishBidAccepted(result.auction, result.bid, {
        wasExtended: result.wasExtended,
      });
      const types = published.map((e) => e.type);
      assert.ok(types.includes('bid.accepted'));
      assert.ok(types.includes('auction.extended'));
    } finally {
      client.release();
    }
  });

  it('close race — exactly one winner after close', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    published.length = 0;
    const rt = createAuctionRealtime({ wsHub: mockHub(), getPool: () => pool });
    const client = await pool.connect();
    try {
      await wipe(client);
      const start = new Date(Date.now() - 7200_000);
      const end = new Date(Date.now() + 3600_000);
      const lot = await auctionService.upsertLot(client, {
        listingId: 'lst-close',
        videoId: 'vid-close',
        species: 'horse',
      });
      const { rows } = await client.query(
        `INSERT INTO auctions (
          lot_id, owner_user_id, created_by_user_id, created_by_role,
          species, status, starting_price, minimum_increment, current_price,
          start_at, end_at, anti_sniping_seconds, settlement_note, version
        ) VALUES ($1,$2,$3,'seller','horse','live',1000,100,1000,$4,$5,30,'note',1)
        RETURNING *`,
        [lot.id, 'owner-close', 'owner-close', start.toISOString(), end.toISOString()],
      );
      await db.withTransaction((tx) =>
        bidService.placeBid(tx, {
          auctionId: rows[0].id,
          bidderUserId: 'winner-1',
          amount: 1100,
          idempotencyKey: 'close-bid',
          expectedVersion: 1,
        }),
      );
      await client.query(
        `UPDATE auctions SET end_at = $1, extended_until = NULL WHERE id = $2`,
        [new Date(Date.now() - 1000).toISOString(), rows[0].id],
      );
      const closed = await db.withTransaction((tx) =>
        auctionService.closeAuctionAtomic(tx, rows[0].id, { actorUserId: 'system' }),
      );
      const { rows: ev } = await client.query(
        `SELECT payload FROM auction_events
         WHERE auction_id = $1 AND event_type = 'auction.closed' ORDER BY created_at DESC LIMIT 1`,
        [rows[0].id],
      );
      rt.publishClosed(closed, ev[0]?.payload || {});
      const types = published.map((e) => e.type);
      assert.ok(types.includes('auction.ended'));
      assert.ok(types.includes('auction.sold'));
      assert.equal(closed.status, 'sold');
      assert.equal(closed.winnerUserId, 'winner-1');
    } finally {
      client.release();
    }
  });

  it('WS disconnect does not lose accepted DB bid', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const client = await pool.connect();
    try {
      await wipe(client);
      const auction = await seedLive(client);
      await db.withTransaction((tx) =>
        bidService.placeBid(tx, {
          auctionId: auction.id,
          bidderUserId: 'persist-bidder',
          amount: 1100,
          idempotencyKey: 'persist-1',
          expectedVersion: 1,
        }),
      );
      const { rows } = await client.query(
        'SELECT amount FROM bids WHERE auction_id = $1',
        [auction.id],
      );
      assert.equal(Number(rows[0].amount), 1100);
    } finally {
      client.release();
    }
  });
});
