'use strict';

/**
 * STEP 10–12 proofs: realtime metrics payload, presence, admin sections,
 * privacy, pagination bounds. PG tests skip without AUCTIONS_TEST_DATABASE_URL.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createWsHub } = require('../ws_hub');
const {
  createAuctionRealtime,
  sanitizeBidderLabel,
} = require('./realtime/auction_realtime');
const {
  getBidAggregates,
  recordQualifiedView,
  getViewAggregates,
} = require('./services/metrics_service');
const {
  getAdminAuctionDetail,
  listBidderAggregates,
  ADMIN_BIDS_PAGE,
  ADMIN_TIMELINE_CAP,
} = require('./services/admin_auction_service');
const { listBids, sanitizePublicBid } = require('./services/auction_query_service');

describe('STEP 10 — realtime metrics polish (unit)', () => {
  it('publishBidAccepted includes PG metrics extras and nextMinimumBid', () => {
    const published = [];
    const realtime = createAuctionRealtime({
      wsHub: {
        publishAuction: (ev) => {
          published.push(ev);
          return ev;
        },
      },
      getPool: () => null,
    });
    realtime.publishBidAccepted(
      {
        id: 'a1',
        version: 3,
        status: 'live',
        currentPrice: 105000,
        minimumIncrement: 1000,
        endAt: new Date('2026-08-23T20:00:00Z'),
      },
      { id: 'b1', amount: 105000, bidderUserId: 'user-abcd1234' },
      {
        metrics: { bidCount: 4, uniqueBidders: 2, extensionsCount: 1 },
      },
    );
    const bidEv = published.find((e) => e.type === 'bid.accepted');
    assert.ok(bidEv);
    assert.equal(bidEv.bidCount, 4);
    assert.equal(bidEv.uniqueBidders, 2);
    assert.equal(bidEv.extensionsCount, 1);
    assert.equal(bidEv.nextMinimumBid, 106000);
    assert.equal(bidEv.bidderLabel, sanitizeBidderLabel('user-abcd1234'));
    assert.equal(bidEv.bidderUserId, undefined);
  });

  it('presence fan-out is ephemeral (no seq) and multi-device counts once', () => {
    const hub = createWsHub({
      resolveUserFromToken: () => ({ id: 'u1' }),
    });
    const received = [];
    const fakeClient = {
      userId: 'u1',
      rooms: new Set(),
      send: (raw) => {
        received.push(JSON.parse(raw));
      },
    };
    hub._joinRoom(fakeClient, 'auction:a-presence');
    const secondDevice = {
      userId: 'u1',
      rooms: new Set(),
      send: () => {},
    };
    hub._joinRoom(secondDevice, 'auction:a-presence');
    assert.equal(hub.auctionLiveViewers('a-presence'), 1);
    hub.publishAuctionPresence('a-presence');
    const presence = received.find((e) => e.type === 'auction.presence');
    assert.ok(presence);
    assert.equal(presence.liveViewers, 1);
    assert.equal(presence.seq, undefined);
    assert.equal(presence.presenceAvailable, true);
  });
});

describe('STEP 10–12 — PostgreSQL proofs', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
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
    pool = db.getPool();
    await db.runMigrations();
    auctionService = require('./services/auction_service');
    bidService = require('./services/bid_service');
  });

  after(async () => {
    if (db?.closePool) await db.closePool();
  });

  async function wipe(client) {
    await client.query('DELETE FROM auction_ws_events').catch(() => {});
    await client.query('DELETE FROM auction_risk_signals');
    await client.query('DELETE FROM auction_disputes');
    await client.query('DELETE FROM auction_view_sessions').catch(() => {});
    await client.query('DELETE FROM audio_sessions').catch(() => {});
    await client.query('DELETE FROM host_bookings').catch(() => {});
    await client.query('DELETE FROM host_availability').catch(() => {});
    await client.query('DELETE FROM auction_events');
    await client.query('DELETE FROM bids');
    await client.query('DELETE FROM auctions');
    await client.query('DELETE FROM auction_lots');
    await client.query('DELETE FROM auction_hosts').catch(() => {});
  }

  const validLoc = {
    city: 'الرياض',
    district: 'رماح',
    address: 'حي تجريبي',
    lat: 24.7136,
    lng: 46.6753,
    sourceListingId: 'L-s1012',
    capturedAt: new Date().toISOString(),
  };

  async function seedLive(client, { listingId } = {}) {
    const now = Date.now();
    const a = await auctionService.createAuctionDraft(client, {
      listingId: listingId || `L-s1012-${now}`,
      videoId: `V-s1012-${now}`,
      species: 'horse',
      ownerUserId: 'owner-s1012',
      createdByUserId: 'owner-s1012',
      startingPrice: 100000,
      minimumIncrement: 1000,
      startAt: new Date(now - 60000).toISOString(),
      endAt: new Date(now + 3600000).toISOString(),
      locationSnapshot: { ...validLoc, sourceListingId: listingId || `L-s1012-${now}` },
    });
    await auctionService.transitionAuction(client, a.id, 'review', {
      actorUserId: 'admin',
    });
    const { approveAuctionReview } = require('./services/approval_flow');
    await approveAuctionReview(client, a.id, 'admin', { bypass: 'admin' });
    await auctionService.transitionAuction(client, a.id, 'live', {
      actorUserId: 'admin',
    });
    return a;
  }

  it('same bidder multiple bids does not inflate uniqueBidders', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client);
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bidder-same',
        amount: 101000,
        idempotencyKey: `k1-${a.id}`,
      });
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bidder-same',
        amount: 102000,
        idempotencyKey: `k2-${a.id}`,
      });
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bidder-other',
        amount: 103000,
        idempotencyKey: `k3-${a.id}`,
      });
      const agg = await getBidAggregates(client, a.id);
      assert.equal(agg.bidCount, 3);
      assert.equal(agg.uniqueBidders, 2);
    });
  });

  it('qualified view is idempotent on repeat viewer_key', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client, { listingId: 'lst-view' });
      const r1 = await recordQualifiedView(client, {
        auctionId: a.id,
        viewerKey: 'viewer-1',
      });
      const r2 = await recordQualifiedView(client, {
        auctionId: a.id,
        viewerKey: 'viewer-1',
      });
      assert.equal(r1.inserted, true);
      assert.equal(r2.inserted, false);
      const views = await getViewAggregates(client, a.id);
      assert.equal(views.viewCount, 1);
      assert.equal(views.uniqueViewers, 1);
    });
  });

  it('public listBids strips bidderUserId; admin aggregates keep internal id', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client, { listingId: 'lst-pii' });
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'secret-bidder-9999',
        amount: 101000,
        idempotencyKey: `pii1-${a.id}`,
      });
      const pub = await listBids(client, a.id, { limit: 10, includeBidderId: false });
      assert.equal(pub.bids[0].bidderUserId, undefined);
      assert.ok(pub.bids[0].bidderLabel);
      const admin = await listBids(client, a.id, { limit: 10, includeBidderId: true });
      assert.equal(admin.bids[0].bidderUserId, 'secret-bidder-9999');
      const aggs = await listBidderAggregates(client, a.id);
      assert.equal(aggs[0].bidderUserId, 'secret-bidder-9999');
      const stripped = sanitizePublicBid({
        id: 'x',
        bidderUserId: 'should-go',
        amount: 1,
      });
      assert.equal(stripped.bidderUserId, undefined);
    });
  });

  it('admin detail sections are bounded and include host/bidders/overview', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client, { listingId: 'lst-admin' });
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'admin-bidder',
        amount: 101000,
        idempotencyKey: `adm1-${a.id}`,
      });
      const detail = await getAdminAuctionDetail(client, a.id, { wsHub: null });
      assert.ok(detail.sections.overview);
      assert.ok(detail.sections.liveMetrics);
      assert.ok(Array.isArray(detail.sections.bids));
      assert.ok(detail.sections.bids.length <= ADMIN_BIDS_PAGE);
      assert.ok(Array.isArray(detail.sections.bidders));
      assert.ok(detail.sections.viewersAggregates);
      assert.ok(detail.sections.location);
      assert.ok(detail.sections.media);
      assert.ok(Array.isArray(detail.sections.timeline));
      assert.ok(detail.sections.timeline.length <= ADMIN_TIMELINE_CAP);
      assert.equal(detail.sections.viewersAggregates.note.includes('surveillance'), true);
      assert.ok('host' in detail.sections);
    });
  });

  it('EXPLAIN bids cursor path — index exists and is usable', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client, { listingId: 'lst-explain' });
      for (let i = 0; i < 3; i += 1) {
        await bidService.placeBid(client, {
          auctionId: a.id,
          bidderUserId: `ex-${i}`,
          amount: 101000 + i * 1000,
          idempotencyKey: `ex-${a.id}-${i}`,
        });
      }
      const idx = await client.query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'bids'
           AND indexdef ILIKE '%auction_id%'
           AND indexdef ILIKE '%created_at%'`,
      );
      assert.ok(idx.rows.length >= 1, 'expected bids(auction_id, created_at, …) index');
      // Tiny tables may Seq Scan under default cost model — prove index path when forced.
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(
        `EXPLAIN (FORMAT TEXT)
         SELECT * FROM bids
         WHERE auction_id = $1::uuid
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
        [a.id],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      assert.match(plan, /Index/i);
      // Persist evidence snippet for SSOT
      const fs = require('fs');
      const path = require('path');
      const out = path.join(__dirname, 'evidence', 'explain_bids_cursor_s1012.txt');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        `indexes:\n${idx.rows.map((r) => r.indexname).join('\n')}\n\nplan (enable_seqscan=off):\n${plan}\n`,
      );
    });
  });
});
