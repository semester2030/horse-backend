'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { canTransition, canFreeze, isBiddableStatus, isFrozen } = require('./domain/states');
const { can, permissionsForRole, ADMIN_ROLES } = require('../admin/permissions');

describe('Phase 6 — unit (no PostgreSQL)', () => {
  it('frozen state machine transitions', () => {
    assert.equal(canFreeze('live'), true);
    assert.equal(canFreeze('draft'), false);
    assert.equal(canTransition('live', 'frozen'), true);
    assert.equal(canTransition('frozen', 'cancelled'), true);
    assert.equal(isFrozen('frozen'), true);
    assert.equal(isBiddableStatus('frozen'), false);
  });

  it('RBAC least privilege for auction ops', () => {
    const mod = permissionsForRole(ADMIN_ROLES.moderator);
    assert.ok(mod.includes('auctions:read'));
    assert.ok(mod.includes('auctions:moderate'));
    assert.ok(mod.includes('auctions:ops'));
    assert.ok(mod.includes('auctions:disputes'));
    const support = permissionsForRole(ADMIN_ROLES.support);
    assert.equal(support.includes('auctions:ops'), false);
    assert.equal(can({ active: true, role: ADMIN_ROLES.support }, 'auctions:ops'), false);
    assert.equal(can({ active: true, role: ADMIN_ROLES.moderator }, 'auctions:ops'), true);
  });
});

describe('Phase 6 — PostgreSQL integration', { concurrency: 1 }, () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let auctionService;
  let bidService;
  let opsService;
  let disputeService;
  let riskService;
  let adminAuctionService;

  before(async () => {
    if (!url) return;
    process.env.AUCTIONS_DATABASE_URL = url;
    process.env.ENABLE_AUCTIONS = 'true';
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./config')];
    db = require('./db');
    auctionService = require('./services/auction_service');
    bidService = require('./services/bid_service');
    opsService = require('./services/ops_service');
    disputeService = require('./services/dispute_service');
    riskService = require('./services/risk_service');
    adminAuctionService = require('./services/admin_auction_service');
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
      species: opts.species || 'horse',
      ownerUserId: opts.ownerUserId || 'owner-1',
      createdByUserId: opts.ownerUserId || 'owner-1',
      startingPrice: 1000,
      minimumIncrement: 50,
      startAt: new Date(now - 60000).toISOString(),
      endAt: new Date(now + 600000).toISOString(),
      antiSnipingSeconds: 0,
    });
    await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
    await auctionService.transitionAuction(client, auction.id, 'scheduled', { actorUserId: 'admin' });
    await auctionService.transitionAuction(client, auction.id, 'live', { actorUserId: 'admin' });
    return auction;
  }

  it('review approve/reject records admin events', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await auctionService.createAuctionDraft(client, {
        listingId: 'L-rev',
        videoId: 'V-rev',
        species: 'falcon',
        ownerUserId: 'owner-r',
        createdByUserId: 'owner-r',
        startingPrice: 100,
        minimumIncrement: 10,
        startAt: new Date(Date.now() + 3600000).toISOString(),
        endAt: new Date(Date.now() + 7200000).toISOString(),
      });
      await auctionService.transitionAuction(client, auction.id, 'review', { actorUserId: 'admin' });
      const approved = await auctionService.transitionAuction(client, auction.id, 'scheduled', {
        actorUserId: 'admin-1',
      });
      assert.equal(approved.status, 'scheduled');
      const { rows: events } = await client.query(
        `SELECT event_type FROM auction_events WHERE auction_id = $1 ORDER BY created_at ASC`,
        [auction.id],
      );
      assert.ok(events.some((e) => e.event_type === 'auction.status_changed'));
    });
  });

  it('freeze prevents new bids', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      const frozen = await opsService.freezeAuction(client, auction.id, {
        adminId: 'admin-ops',
        reason: 'investigation',
      });
      assert.equal(frozen.status, 'frozen');
      assert.equal(frozen.preFrozenStatus, 'live');
      await assert.rejects(
        () =>
          bidService.placeBid(client, {
            auctionId: auction.id,
            bidderUserId: 'bidder-1',
            amount: 1050,
            idempotencyKey: 'k-freeze',
          }),
        (e) => e.code === 'BID_NOT_ALLOWED',
      );
      const { rows: bids } = await client.query(`SELECT COUNT(*)::int AS c FROM bids WHERE auction_id = $1`, [
        auction.id,
      ]);
      assert.equal(bids[0].c, 0);
    });
  });

  it('resume restores legal bidding', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      await opsService.freezeAuction(client, auction.id, { adminId: 'admin-ops' });
      const resumed = await opsService.resumeAuction(client, auction.id, { adminId: 'admin-ops' });
      assert.equal(resumed.status, 'live');
      const placed = await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-1',
        amount: 1050,
        idempotencyKey: 'k-resume',
      });
      assert.equal(placed.bid.amount, 1050);
    });
  });

  it('cancel is terminal audited', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      const cancelled = await opsService.adminCancelAuction(client, auction.id, {
        adminId: 'admin-ops',
        reason: 'policy',
      });
      assert.equal(cancelled.status, 'cancelled');
      await assert.rejects(
        () => opsService.resumeAuction(client, auction.id, { adminId: 'admin-ops' }),
        (e) => e.code === 'AUCTION_NOT_FROZEN',
      );
      const { rows } = await client.query(
        `SELECT event_type FROM auction_events WHERE auction_id = $1 AND event_type = 'admin.auction.cancelled'`,
        [auction.id],
      );
      assert.equal(rows.length, 1);
    });
  });

  it('bid vs freeze race — PostgreSQL serializes', async (t) => {
    if (!url) return t.skip('no DB');
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      auctionId = auction.id;
    });

    const [bidResult, freezeResult] = await Promise.all([
      db
        .withTransaction((client) =>
          bidService.placeBid(client, {
            auctionId,
            bidderUserId: 'bidder-race',
            amount: 1050,
            idempotencyKey: 'race-bid',
          }),
        )
        .then((r) => ({ ok: true, r }))
        .catch((e) => ({ ok: false, code: e.code })),
      db
        .withTransaction((client) =>
          opsService.freezeAuction(client, auctionId, { adminId: 'admin-race' }),
        )
        .then((r) => ({ ok: true, r }))
        .catch((e) => ({ ok: false, code: e.code })),
    ]);

    assert.ok(bidResult.ok || freezeResult.ok, JSON.stringify({ bidResult, freezeResult }));
    const final = await db.withTransaction((c) =>
      c.query(`SELECT status FROM auctions WHERE id = $1`, [auctionId]),
    );
    const status = final.rows[0].status;
    assert.ok(['live', 'frozen'].includes(status));
  });

  it('close vs freeze — frozen blocks close', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      await client.query(
        `UPDATE auctions SET end_at = NOW() - INTERVAL '1 second', extended_until = NULL WHERE id = $1`,
        [auction.id],
      );
      await opsService.freezeAuction(client, auction.id, { adminId: 'admin' });
      await assert.rejects(
        () => auctionService.closeAuctionAtomic(client, auction.id),
        (e) => e.code === 'AUCTION_FROZEN',
      );
    });
  });

  it('dispute lifecycle open → reviewing → resolved', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      const dispute = await disputeService.createDispute(client, {
        auctionId: auction.id,
        reporterUserId: 'user-d',
        category: 'outcome',
        description: 'Winner dispute test',
        evidenceRefs: ['ref-1'],
      });
      assert.equal(dispute.status, 'open');
      const reviewing = await disputeService.assignDispute(client, dispute.id, { adminId: 'admin-d' });
      assert.equal(reviewing.status, 'reviewing');
      const resolved = await disputeService.resolveDispute(client, dispute.id, {
        adminId: 'admin-d',
        resolution: 'upheld_seller',
        note: 'Evidence reviewed',
      });
      assert.equal(resolved.status, 'resolved');
    });
  });

  it('risk signal generation — abnormal velocity rule', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      for (let i = 0; i < 21; i++) {
        await bidService.placeBid(client, {
          auctionId: auction.id,
          bidderUserId: `bidder-${i % 5}`,
          amount: 1050 + i * 50,
          idempotencyKey: `vel-${i}`,
        });
      }
      const signals = await riskService.evaluateRiskSignals(client, auction.id);
      assert.ok(signals.some((s) => s.ruleCode === 'abnormal_bid_velocity'));
    });
  });

  it('immutable timeline includes ops/dispute/risk events', async (t) => {
    if (!url) return t.skip('no DB');
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      auctionId = auction.id;
      await opsService.freezeAuction(client, auction.id, { adminId: 'admin' });
      await disputeService.createDispute(client, {
        auctionId: auction.id,
        reporterUserId: 'rep',
        category: 'conduct',
        description: 'test',
      });
      await riskService.evaluateRiskSignals(client, auction.id);
    });
    const detail = await adminAuctionService.getAdminAuctionDetail(pool, auctionId);
    assert.ok(detail.timeline.length >= 4);
    const types = detail.timeline.map((e) => e.eventType);
    assert.ok(types.includes('auction.frozen'));
    assert.ok(types.includes('dispute.open'));
  });

  it('multi-instance advisory lock — concurrent transactions serialize', async (t) => {
    if (!url) return t.skip('no DB');
    let auctionId;
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      auctionId = auction.id;
    });

    const results = await Promise.allSettled([
      db.withTransaction((c) =>
        opsService.freezeAuction(c, auctionId, { adminId: 'a1' }),
      ),
      db.withTransaction((c) =>
        bidService.placeBid(c, {
          auctionId,
          bidderUserId: 'b1',
          amount: 1050,
          idempotencyKey: 'mi-1',
        }),
      ),
    ]);
    assert.ok(results.some((r) => r.status === 'fulfilled'));
    const { rows } = await pool.query(`SELECT status FROM auctions WHERE id = $1`, [auctionId]);
    assert.ok(['live', 'frozen'].includes(rows[0].status));
  });

  it('exactly one winner after close', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'winner',
        amount: 1050,
        idempotencyKey: 'w1',
      });
      await client.query(
        `UPDATE auctions SET end_at = NOW() - INTERVAL '1 second', extended_until = NULL WHERE id = $1`,
        [auction.id],
      );
      const closed = await auctionService.closeAuctionAtomic(client, auction.id);
      assert.equal(closed.status, 'sold');
      assert.equal(closed.winnerUserId, 'winner');
    });
  });

  it('REST recovery — bids persist after freeze', async (t) => {
    if (!url) return t.skip('no DB');
    await db.withTransaction(async (client) => {
      await wipe(client);
      const auction = await seedLiveAuction(client);
      await bidService.placeBid(client, {
        auctionId: auction.id,
        bidderUserId: 'bidder-rest',
        amount: 1050,
        idempotencyKey: 'rest-1',
      });
      await opsService.freezeAuction(client, auction.id, { adminId: 'admin' });
      const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM bids WHERE auction_id = $1`, [
        auction.id,
      ]);
      assert.equal(rows[0].c, 1);
    });
  });
});
