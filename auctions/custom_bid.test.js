'use strict';

/**
 * Custom Bid domain proofs — formula must remain:
 * amount >= money(current_price + minimum_increment)
 * No multiple-of-increment requirement.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

describe('Custom Bid — PostgreSQL domain proofs', () => {
  let db;
  let auctionService;
  let bidService;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    auctionService = require('./services/auction_service');
    bidService = require('./services/bid_service');
    await db.runMigrations();
  });

  after(async () => {
    if (db) await db.closePool();
  });

  async function wipe(client) {
    await client.query('DELETE FROM auction_view_sessions');
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

  async function seedLiveAt(client, { currentPrice = 100000, minimumIncrement = 1000 } = {}) {
    const now = Date.now();
    const auction = await auctionService.createAuctionDraft(client, {
      listingId: `L-cb-${now}`,
      videoId: `V-cb-${now}`,
      species: 'horse',
      ownerUserId: 'owner-cb',
      createdByUserId: 'owner-cb',
      startingPrice: currentPrice,
      minimumIncrement,
      startAt: new Date(now - 60000).toISOString(),
      endAt: new Date(now + 3600000).toISOString(),
      antiSnipingSeconds: 120,
    });
    await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
    const { approveAuctionReview } = require('./services/approval_flow');
    await approveAuctionReview(client, auction.id, 'admin', { bypass: 'admin' });
    await auctionService.transitionAuction(client, auction.id, 'live', { actorUserId: 'admin' });
    await client.query(`UPDATE auctions SET current_price = $1 WHERE id = $2`, [
      currentPrice,
      auction.id,
    ]);
    const { rows } = await client.query(
      `SELECT a.*, l.listing_id, l.video_id FROM auctions a JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
      [auction.id],
    );
    return auctionService.mapAuctionRow(rows[0]);
  }

  it('exact minimum 101000 PASS', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      const r = await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bidder-a',
        amount: 101000,
        idempotencyKey: `cb-exact-${a.id}`,
      });
      assert.equal(r.bid.amount, 101000);
      assert.equal(r.auction.currentPrice, 101000);
    });
  });

  it('non-multiple 101300 PASS', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      const r = await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bidder-b',
        amount: 101300,
        idempotencyKey: `cb-jump-${a.id}`,
      });
      assert.equal(r.bid.amount, 101300);
      assert.equal(r.auction.currentPrice, 101300);
    });
  });

  it('102500 and 110000 PASS', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      const r1 = await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bidder-c1',
        amount: 102500,
        idempotencyKey: `cb-1025-${a.id}`,
      });
      assert.equal(r1.auction.currentPrice, 102500);
      const r2 = await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bidder-c2',
        amount: 110000,
        idempotencyKey: `cb-110-${a.id}`,
      });
      assert.equal(r2.auction.currentPrice, 110000);
    });
  });

  it('100999 below minimum REJECT', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: a.id,
            bidderUserId: 'bidder-low',
            amount: 100999,
            idempotencyKey: `cb-low-${a.id}`,
          }),
        (e) => e.code === 'BID_INCREMENT_TOO_LOW',
      );
    });
  });

  it('concurrent custom bids — one authoritative order', async (t) => {
    if (!url) return t.skip('no DB');
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      auctionId = a.id;
    });

    const results = await Promise.allSettled([
      db.withTransaction((client) =>
        bidService.placeBid(client, {
          auctionId,
          bidderUserId: 'A',
          amount: 101000,
          idempotencyKey: `conc-A-${auctionId}`,
        }),
      ),
      db.withTransaction((client) =>
        bidService.placeBid(client, {
          auctionId,
          bidderUserId: 'B',
          amount: 103500,
          idempotencyKey: `conc-B-${auctionId}`,
        }),
      ),
      db.withTransaction((client) =>
        bidService.placeBid(client, {
          auctionId,
          bidderUserId: 'C',
          amount: 102000,
          idempotencyKey: `conc-C-${auctionId}`,
        }),
      ),
    ]);

    const accepted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.ok(accepted.length >= 1);
    assert.equal(accepted.length + rejected.length, 3);

    await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT current_price, version FROM auctions WHERE id = $1`,
        [auctionId],
      );
      const { rows: bids } = await client.query(
        `SELECT amount FROM bids WHERE auction_id = $1 ORDER BY amount DESC`,
        [auctionId],
      );
      assert.equal(Number(rows[0].current_price), Number(bids[0].amount));
      assert.equal(bids.length, accepted.length);
    });
  });

  it('stale expectedVersion rejects custom bid', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: a.id,
            bidderUserId: 'stale-b',
            amount: 105000,
            expectedVersion: a.version - 1,
            idempotencyKey: `cb-stale-${a.id}`,
          }),
        (e) => e.code === 'BID_STALE_VERSION',
      );
    });
  });

  it('owner custom bid REJECT', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: a.id,
            bidderUserId: 'owner-cb',
            amount: 150000,
            idempotencyKey: `cb-owner-${a.id}`,
          }),
        (e) => e.code === 'BID_OWNER_FORBIDDEN',
      );
    });
  });

  it('frozen auction rejects custom bid', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      const { freezeAuction } = require('./services/ops_service');
      await freezeAuction(client, a.id, { adminId: 'admin', reason: 'test' });
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: a.id,
            bidderUserId: 'bidder-fz',
            amount: 120000,
            idempotencyKey: `cb-fz-${a.id}`,
          }),
        (e) => e.code === 'BID_NOT_ALLOWED' || e.code === 'AUCTION_FROZEN',
      );
    });
  });

  it('ended auction rejects custom bid', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      await client.query(
        `UPDATE auctions
         SET start_at = NOW() - INTERVAL '2 hours',
             end_at = NOW() - INTERVAL '1 minute',
             extended_until = NULL
         WHERE id = $1`,
        [a.id],
      );
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: a.id,
            bidderUserId: 'bidder-end',
            amount: 120000,
            idempotencyKey: `cb-end-${a.id}`,
          }),
        (e) => e.code === 'AUCTION_CLOSED',
      );
    });
  });

  it('anti-sniping extends with custom amount', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLiveAt(client);
      await client.query(
        `UPDATE auctions SET end_at = NOW() + INTERVAL '30 seconds', anti_sniping_seconds = 120 WHERE id = $1`,
        [a.id],
      );
      const r = await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bidder-snipe',
        amount: 101500,
        idempotencyKey: `cb-snipe-${a.id}`,
      });
      assert.equal(r.wasExtended, true);
      assert.equal(r.auction.status, 'extended');
      assert.ok(r.auction.extendedUntil);
    });
  });
});
