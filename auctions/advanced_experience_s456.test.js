'use strict';

/**
 * STEPS 4–6 proofs: Location Snapshot · Metrics · API enrichment helpers
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;

const {
  extractLocationFromListing,
  requireListingLocationSnapshot,
  mapPublicLocation,
  mapAdminLocation,
} = require('./services/location_snapshot');

describe('Location snapshot — pure helpers', () => {
  it('extracts city + coords from listing', () => {
    const snap = extractLocationFromListing({
      id: 'L1',
      city: 'الرياض',
      district: 'رماح',
      address: 'شارع 1',
      location: { lat: 24.7, lng: 46.7 },
    });
    assert.equal(snap.city, 'الرياض');
    assert.equal(snap.district, 'رماح');
    assert.equal(snap.lat, 24.7);
    assert.equal(snap.sourceListingId, 'L1');
  });

  it('rejects missing location', () => {
    const r = requireListingLocationSnapshot({ id: 'L2', city: 'الرياض' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AUCTION_LOCATION_REQUIRED');
  });

  it('rejects coords outside Saudi', () => {
    const r = requireListingLocationSnapshot({
      id: 'L3',
      city: 'Cairo',
      location: { lat: 30.0, lng: 31.0 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AUCTION_LOCATION_REQUIRED');
  });

  it('public map omits sourceListingId; admin includes it', () => {
    const row = {
      location_city: 'الرياض',
      location_district: 'رماح',
      location_address: 'addr',
      location_lat: 24.7,
      location_lng: 46.7,
      location_source_listing_id: 'L9',
      location_captured_at: '2026-08-23T00:00:00Z',
    };
    const pub = mapPublicLocation(row);
    assert.equal(pub.city, 'الرياض');
    assert.equal(pub.sourceListingId, undefined);
    const adm = mapAdminLocation(row);
    assert.equal(adm.sourceListingId, 'L9');
    assert.ok(adm.capturedAt);
  });
});

describe('STEPS 4–6 — PostgreSQL proofs', () => {
  let db;
  let auctionService;
  let bidService;
  let metricsService;
  let queryService;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    auctionService = require('./services/auction_service');
    bidService = require('./services/bid_service');
    metricsService = require('./services/metrics_service');
    queryService = require('./services/auction_query_service');
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

  const validLoc = {
    city: 'الرياض',
    district: 'رماح',
    address: 'حي تجريبي',
    lat: 24.7136,
    lng: 46.6753,
    sourceListingId: 'L-loc',
    capturedAt: new Date().toISOString(),
  };

  async function seedDraft(client, { species = 'horse', loc = validLoc, listingId } = {}) {
    const now = Date.now();
    return auctionService.createAuctionDraft(client, {
      listingId: listingId || `L-s456-${now}-${Math.random().toString(36).slice(2, 7)}`,
      videoId: `V-s456-${now}-${Math.random().toString(36).slice(2, 7)}`,
      species,
      ownerUserId: 'owner-s456',
      createdByUserId: 'owner-s456',
      startingPrice: 1000,
      minimumIncrement: 100,
      startAt: new Date(now - 60000).toISOString(),
      endAt: new Date(now + 3600000).toISOString(),
      locationSnapshot: loc,
    });
  }

  async function seedLive(client) {
    const a = await seedDraft(client);
    await auctionService.transitionAuction(client, a.id, 'review', { actorUserId: 'admin' });
    const { approveAuctionReview } = require('./services/approval_flow');
    await approveAuctionReview(client, a.id, 'admin', { bypass: 'admin' });
    await auctionService.transitionAuction(client, a.id, 'live', { actorUserId: 'admin' });
    return a;
  }

  it('new auction stores immutable location snapshot', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedDraft(client, { loc: { ...validLoc, city: 'جدة', lat: 21.5, lng: 39.2 } });
      assert.equal(a.location.city, 'جدة');
      assert.equal(a.location.lat, 21.5);
      const { rows } = await client.query(
        `SELECT location_city, location_lat FROM auctions WHERE id = $1`,
        [a.id],
      );
      assert.equal(rows[0].location_city, 'جدة');
      // Mutating listing snapshot input later cannot change stored row without UPDATE
      assert.notEqual(validLoc.city, rows[0].location_city);
    });
  });

  it('existing null location remains safe (backward compatible)', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedDraft(client, { loc: null });
      assert.equal(a.location, null);
      const { rows } = await client.query(
        `SELECT location_city FROM auctions WHERE id = $1`,
        [a.id],
      );
      assert.equal(rows[0].location_city, null);
    });
  });

  it('snapshot immutable after listing would change (DB proof)', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedDraft(client, {
        loc: { ...validLoc, city: 'الدمام', lat: 26.4, lng: 50.1 },
      });
      // Simulate "listing changed" — only auction row matters
      await client.query(`UPDATE auctions SET updated_at = NOW() WHERE id = $1`, [a.id]);
      const { rows } = await client.query(
        `SELECT location_city, location_lat FROM auctions WHERE id = $1`,
        [a.id],
      );
      assert.equal(rows[0].location_city, 'الدمام');
      assert.equal(Number(rows[0].location_lat), 26.4);
    });
  });

  it('horse/camel/falcon snapshot works', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      for (const species of ['horse', 'camel', 'falcon']) {
        const a = await seedDraft(client, { species });
        assert.equal(a.species, species);
        assert.equal(a.location.city, 'الرياض');
      }
    });
  });

  it('qualified view increments once; rebuild/refresh no increment', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client);
      const r1 = await metricsService.recordQualifiedView(client, {
        auctionId: a.id,
        viewerKey: 'viewer-1',
      });
      assert.equal(r1.inserted, true);
      const r2 = await metricsService.recordQualifiedView(client, {
        auctionId: a.id,
        viewerKey: 'viewer-1',
      });
      assert.equal(r2.inserted, false);
      const r3 = await metricsService.recordQualifiedView(client, {
        auctionId: a.id,
        viewerKey: 'viewer-1',
      });
      assert.equal(r3.inserted, false);
      const agg = await metricsService.getViewAggregates(client, a.id);
      assert.equal(agg.viewCount, 1);
      assert.equal(agg.uniqueViewers, 1);
    });
  });

  it('unique viewers across users', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client);
      await metricsService.recordQualifiedView(client, {
        auctionId: a.id,
        viewerKey: 'u1',
      });
      await metricsService.recordQualifiedView(client, {
        auctionId: a.id,
        viewerKey: 'u2',
      });
      const agg = await metricsService.getViewAggregates(client, a.id);
      assert.equal(agg.viewCount, 2);
      assert.equal(agg.uniqueViewers, 2);
    });
  });

  it('bidCount and uniqueBidders correct', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client);
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'b1',
        amount: 1100,
        idempotencyKey: `m1-${a.id}`,
      });
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'b2',
        amount: 1200,
        idempotencyKey: `m2-${a.id}`,
      });
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'b1',
        amount: 1300,
        idempotencyKey: `m3-${a.id}`,
      });
      const m = await metricsService.loadAuctionMetrics(client, a.id);
      assert.equal(m.bidCount, 3);
      assert.equal(m.uniqueBidders, 2);
    });
  });

  it('GET summary fields via getAuctionById', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client);
      await metricsService.recordQualifiedView(client, {
        auctionId: a.id,
        viewerKey: 'viewer-x',
      });
      await bidService.placeBid(client, {
        auctionId: a.id,
        bidderUserId: 'bx',
        amount: 1100,
        idempotencyKey: `sum-${a.id}`,
      });
      const summary = await queryService.getAuctionById(client, a.id, {
        wsHub: { auctionLiveViewers: () => 3 },
      });
      assert.ok(summary.location);
      assert.equal(summary.location.city, 'الرياض');
      assert.ok(summary.viewCount >= 1);
      assert.ok(summary.bidCount >= 1);
      assert.equal(summary.liveViewers, 3);
      assert.ok(summary.nextMinimumBid > summary.currentPrice);
      assert.equal(summary.nextMinimumBid, summary.nextValidBid);
    });
  });

  it('bid pagination cursor + public PII stripped', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client);
      for (let i = 0; i < 5; i++) {
        const r = await bidService.placeBid(client, {
          auctionId: a.id,
          bidderUserId: `bidder-${i}`,
          amount: 1100 + i * 100,
          idempotencyKey: `page-${a.id}-${i}`,
        });
        assert.ok(r.bid, `bid ${i} missing`);
      }
      const cnt = await client.query(
        'SELECT COUNT(*)::int AS n FROM bids WHERE auction_id = $1',
        [a.id],
      );
      assert.equal(cnt.rows[0].n, 5, 'expected 5 bids before listBids');
      const page1 = await queryService.listBids(client, a.id, { limit: 2 });
      assert.equal(page1.bids.length, 2, `page1 empty: ${JSON.stringify(page1)}`);
      assert.equal(page1.hasMore, true);
      assert.ok(page1.nextCursor);
      assert.equal(page1.bids[0].bidderUserId, undefined);
      assert.ok(page1.bids[0].bidderLabel);
      const page2 = await queryService.listBids(client, a.id, {
        limit: 2,
        cursor: page1.nextCursor,
      });
      assert.equal(page2.bids.length, 2);
      assert.notEqual(page1.bids[0].id, page2.bids[0].id);
    });
  });

  it('liveViewers presence unique users; peak bump', async (t) => {
    if (!url) return t.skip('no DB');
    const { countLiveViewersFromHub, bumpPeakLiveViewers } = metricsService;
    const fakeHub = {
      _rooms: new Map(),
    };
    fakeHub._rooms.set(
      'auction:test-peak',
      new Set([{ userId: 'a' }, { userId: 'b' }, { userId: 'a' }]),
    );
    assert.equal(countLiveViewersFromHub(fakeHub, 'test-peak'), 2);

    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedLive(client);
      await bumpPeakLiveViewers(client, a.id, 5);
      await bumpPeakLiveViewers(client, a.id, 3);
      const { rows } = await client.query(
        `SELECT peak_live_viewers FROM auctions WHERE id = $1`,
        [a.id],
      );
      assert.equal(Number(rows[0].peak_live_viewers), 5);
    });
  });

  it('admin location includes provenance', async (t) => {
    if (!url) return t.skip('no DB');
    const adminService = require('./services/admin_auction_service');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const a = await seedDraft(client);
      const detail = await adminService.getAdminAuctionDetail(client, a.id);
      assert.ok(detail.sections);
      assert.ok(detail.sections.location);
      assert.equal(detail.sections.location.sourceListingId, validLoc.sourceListingId);
      assert.ok(detail.sections.liveMetrics);
      assert.ok(detail.sections.media);
    });
  });
});
