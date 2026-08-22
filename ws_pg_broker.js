'use strict';

const { createRoomSequencer } = require('./ws_hub');
const {
  NOTIFY_CHANNEL,
  appendAuctionWsEvent,
  fetchAuctionWsEvent,
  replayAuctionWsEvents,
  currentAuctionWsSeq,
} = require('./auctions/services/ws_event_store');

/**
 * PostgreSQL NOTIFY bridge — all Node instances LISTEN and fan-out to local WS clients.
 * REST/PostgreSQL bid truth unchanged; this layer is transport + replay only.
 */
function createPgAuctionWsBridge({ getPool, wsHub, replayWindow = 500 }) {
  const localCache = createRoomSequencer(replayWindow);
  let listenClient = null;
  let stopped = false;

  async function fanOutSequenced(auctionId, seq) {
    const pool = getPool();
    const payload = await fetchAuctionWsEvent(pool, auctionId, seq);
    if (!payload) return null;
    const room = `auction:${auctionId}`;
    localCache.storeAt(room, seq, payload);
    if (wsHub && typeof wsHub.publishSequenced === 'function') {
      wsHub.publishSequenced(room, payload);
    }
    return payload;
  }

  async function append(event) {
    const pool = getPool();
    const client = await pool.connect();
    let sequenced;
    try {
      await client.query('BEGIN');
      sequenced = await appendAuctionWsEvent(client, event);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return sequenced;
  }

  async function replayAfter(auctionId, afterSeq) {
    const pool = getPool();
    const events = await replayAuctionWsEvents(pool, auctionId, afterSeq);
    const room = `auction:${auctionId}`;
    for (const ev of events) {
      if (ev?.seq) localCache.storeAt(room, ev.seq, ev);
    }
    return events;
  }

  async function currentSeq(auctionId) {
    const pool = getPool();
    const pgSeq = await currentAuctionWsSeq(pool, auctionId);
    const room = `auction:${auctionId}`;
    const localSeq = localCache.currentSeq(room);
    return Math.max(pgSeq, localSeq);
  }

  async function replayToClient(client, room, lastReceivedSequence) {
    const auctionId = String(room).slice('auction:'.length);
    const floor = Number.isFinite(Number(lastReceivedSequence))
      ? Number(lastReceivedSequence)
      : 0;
    const missed = await replayAfter(auctionId, floor);
    if (!wsHub || typeof wsHub.safeSend !== 'function') return missed.length;

    if (missed.length === 0) {
      wsHub.safeSend(client, {
        type: 'replay.complete',
        room,
        lastReceivedSequence: floor,
        currentSeq: await currentSeq(auctionId),
        replayed: 0,
      });
      return 0;
    }
    wsHub.safeSend(client, {
      type: 'replay.begin',
      room,
      fromSeq: missed[0].seq,
      toSeq: missed[missed.length - 1].seq,
      count: missed.length,
    });
    for (const ev of missed) {
      wsHub.safeSend(client, { ...ev, replay: true });
    }
    wsHub.safeSend(client, {
      type: 'replay.complete',
      room,
      lastReceivedSequence: missed[missed.length - 1].seq,
      currentSeq: await currentSeq(auctionId),
      replayed: missed.length,
    });
    return missed.length;
  }

  async function startListening() {
    if (listenClient || stopped) return;
    const pool = getPool();
    listenClient = await pool.connect();
    await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
    listenClient.on('notification', (msg) => {
      if (!msg?.payload) return;
      try {
        const { auctionId, seq } = JSON.parse(msg.payload);
        if (!auctionId || !seq) return;
        void fanOutSequenced(auctionId, seq).catch(() => {});
      } catch (_) {
        /* ignore malformed NOTIFY */
      }
    });
    listenClient.on('error', () => {
      listenClient = null;
    });
  }

  async function stopListening() {
    stopped = true;
    if (listenClient) {
      try {
        await listenClient.query(`UNLISTEN ${NOTIFY_CHANNEL}`);
      } catch (_) {
        /* ignore */
      }
      listenClient.release();
      listenClient = null;
    }
  }

  return {
    append,
    replayAfter,
    currentSeq,
    replayToClient,
    fanOutSequenced,
    startListening,
    stopListening,
    localCache,
    NOTIFY_CHANNEL,
  };
}

module.exports = {
  createPgAuctionWsBridge,
};
