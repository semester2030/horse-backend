'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createWsHub } = require('../ws_hub');
const { createPgAuctionWsBridge } = require('../ws_pg_broker');

function createMockClient(hub, userId = 'viewer-1') {
  const sent = [];
  const client = {
    connectionId: `mock-${Math.random().toString(36).slice(2)}`,
    userId,
    rooms: new Set(),
    lastPongAt: Date.now(),
    lastReceivedSequenceByRoom: new Map(),
    send(text) {
      sent.push(JSON.parse(text));
    },
  };
  hub._joinRoom(client, `customer:${userId}`);
  return { client, sent };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
}

describe('PR-01 — WS multi-instance PostgreSQL fan-out', () => {
  const url = process.env.AUCTIONS_TEST_DATABASE_URL || process.env.AUCTIONS_DATABASE_URL;
  let pool;
  let db;
  let auctionService;

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
  });

  after(async () => {
    if (db?.closePool) await db.closePool();
  });

  async function wipe(client) {
    await client.query('DELETE FROM auction_ws_events');
    await client.query('DELETE FROM auction_risk_signals');
    await client.query('DELETE FROM auction_disputes');
    await client.query('DELETE FROM auction_events');
    await client.query('DELETE FROM bids');
    await client.query('DELETE FROM auctions');
    await client.query('DELETE FROM auction_lots');
  }

  async function seedAuction(client) {
    const lot = await auctionService.upsertLot(client, {
      listingId: `lst-ws-mi-${Date.now()}`,
      videoId: `vid-ws-mi-${Date.now()}`,
      species: 'horse',
      title: 'WS MI',
    });
    const end = new Date(Date.now() + 3600_000);
    const { rows } = await client.query(
      `INSERT INTO auctions (
        lot_id, owner_user_id, created_by_user_id, created_by_role,
        species, status, starting_price, minimum_increment, current_price,
        start_at, end_at, anti_sniping_seconds, settlement_note, version
      ) VALUES ($1,$2,$3,'seller','horse','live',1000,100,1000,NOW(),$4,30,'note',1)
      RETURNING id`,
      [lot.id, 'owner-mi', 'owner-mi', end.toISOString()],
    );
    return rows[0].id;
  }

  function createInstancePair() {
    const hubA = createWsHub({
      resolveUserFromToken: () => ({ id: 'viewer-1' }),
    });
    const hubB = createWsHub({
      resolveUserFromToken: () => ({ id: 'viewer-1' }),
    });
    const bridgeA = createPgAuctionWsBridge({
      getPool: () => pool,
      wsHub: hubA,
      replayWindow: 500,
    });
    const bridgeB = createPgAuctionWsBridge({
      getPool: () => pool,
      wsHub: hubB,
      replayWindow: 500,
    });
    hubA.setAuctionCrossInstance(bridgeA);
    hubB.setAuctionCrossInstance(bridgeB);
    return { hubA, hubB, bridgeA, bridgeB };
  }

  it('instance B receives event published via instance A append', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const client = await pool.connect();
    const { hubB, bridgeA, bridgeB } = createInstancePair();
    try {
      await wipe(client);
      const auctionId = await seedAuction(client);
      await bridgeA.startListening();
      await bridgeB.startListening();
      const room = `auction:${auctionId}`;
      const { client: wsClient, sent } = createMockClient(hubB);
      hubB._joinRoom(wsClient, room);

      const sequenced = await bridgeA.append({
        type: 'bid.accepted',
        auctionId,
        bidAmount: 1100,
        currentPrice: 1100,
        version: 2,
        state: 'live',
        bidderLabel: 'مزايد ···1234',
      });

      assert.equal(sequenced.seq, 1);
      await waitFor(() =>
        sent.some((m) => m.type === 'bid.accepted' && m.seq === 1 && m.bidAmount === 1100),
      );
      assert.equal(sent.filter((m) => m.type === 'bid.accepted').length, 1);
    } finally {
      await bridgeA.stopListening();
      await bridgeB.stopListening();
      client.release();
    }
  });

  it('monotonic seq across two instances — no duplicates', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const client = await pool.connect();
    const { bridgeA, bridgeB } = createInstancePair();
    try {
      await wipe(client);
      const auctionId = await seedAuction(client);
      await bridgeA.startListening();
      await bridgeB.startListening();

      const events = [];
      for (let i = 0; i < 5; i += 1) {
        const bridge = i % 2 === 0 ? bridgeA : bridgeB;
        events.push(
          await bridge.append({
            type: 'bid.accepted',
            auctionId,
            bidAmount: 1000 + (i + 1) * 100,
            currentPrice: 1000 + (i + 1) * 100,
            version: i + 2,
            state: 'live',
          }),
        );
      }
      const seqs = events.map((e) => e.seq);
      assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
      const { rows } = await client.query(
        `SELECT seq FROM auction_ws_events WHERE auction_id = $1 ORDER BY seq`,
        [auctionId],
      );
      assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2, 3, 4, 5]);
    } finally {
      await bridgeA.stopListening();
      await bridgeB.stopListening();
      client.release();
    }
  });

  it('replayAfter from PostgreSQL returns ascending events without gaps', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const client = await pool.connect();
    const { bridgeA, bridgeB } = createInstancePair();
    try {
      await wipe(client);
      const auctionId = await seedAuction(client);
      for (let i = 0; i < 4; i += 1) {
        await bridgeA.append({
          type: 'bid.accepted',
          auctionId,
          currentPrice: 1000 + i * 100,
          version: i + 1,
          state: 'live',
        });
      }
      const replay = await bridgeB.replayAfter(auctionId, 2);
      assert.deepEqual(replay.map((e) => e.seq), [3, 4]);
    } finally {
      client.release();
    }
  });

  it('concurrent append race — exactly one seq winner per slot', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const client = await pool.connect();
    const { bridgeA, bridgeB } = createInstancePair();
    try {
      await wipe(client);
      const auctionId = await seedAuction(client);
      await bridgeA.startListening();
      await bridgeB.startListening();

      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? bridgeA : bridgeB).append({
            type: 'bid.accepted',
            auctionId,
            currentPrice: 1100,
            version: 2,
            state: 'live',
            race: i,
          }),
        ),
      );
      const ok = attempts.filter((a) => a.status === 'fulfilled');
      assert.equal(ok.length, 8);
      const seqs = ok.map((a) => a.value.seq).sort((a, b) => a - b);
      assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8]);
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM auction_ws_events WHERE auction_id = $1`,
        [auctionId],
      );
      assert.equal(rows[0].n, 8);
    } finally {
      await bridgeA.stopListening();
      await bridgeB.stopListening();
      client.release();
    }
  });

  it('hub publishAuction delegates to cross-instance bridge', async (t) => {
    if (!url) return t.skip('AUCTIONS_TEST_DATABASE_URL not set');
    const client = await pool.connect();
    const { hubA, hubB, bridgeA, bridgeB } = createInstancePair();
    try {
      await wipe(client);
      const auctionId = await seedAuction(client);
      await bridgeA.startListening();
      await bridgeB.startListening();
      const room = `auction:${auctionId}`;
      const { client: wsClient, sent } = createMockClient(hubB);
      hubB._joinRoom(wsClient, room);

      const sequenced = await hubA.publishAuctionAsync({
        type: 'bid.accepted',
        auctionId,
        currentPrice: 1200,
        version: 2,
        state: 'live',
      });

      assert.equal(sequenced.seq, 1);
      await waitFor(() => sent.some((m) => m.type === 'bid.accepted' && m.seq === 1));
    } finally {
      await bridgeA.stopListening();
      await bridgeB.stopListening();
      client.release();
    }
  });
});
