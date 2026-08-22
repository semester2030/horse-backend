'use strict';

const NOTIFY_CHANNEL = 'auction_ws_fanout';

function notifyPayloadLiteral(obj) {
  const raw = JSON.stringify(obj);
  return `'${raw.replace(/'/g, "''")}'`;
}

/**
 * Append one sequenced WS transport event — multi-instance safe via advisory lock.
 */
async function appendAuctionWsEvent(client, event) {
  const auctionId = String(event.auctionId || '');
  if (!auctionId) {
    throw new Error('auctionId required for WS event');
  }
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('nomas:auction:ws:' || $1::text))`,
    [auctionId],
  );
  const { rows: nextRows } = await client.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
     FROM auction_ws_events WHERE auction_id = $1`,
    [auctionId],
  );
  const seq = Number(nextRows[0].next_seq);
  const sequenced = {
    ...event,
    seq,
    serverTimestamp: event.serverTimestamp || new Date().toISOString(),
  };
  await client.query(
    `INSERT INTO auction_ws_events (auction_id, seq, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [auctionId, seq, JSON.stringify(sequenced)],
  );
  await client.query(
    `NOTIFY ${NOTIFY_CHANNEL}, ${notifyPayloadLiteral({ auctionId, seq })}`,
  );
  return sequenced;
}

async function fetchAuctionWsEvent(pool, auctionId, seq) {
  const { rows } = await pool.query(
    `SELECT payload FROM auction_ws_events
     WHERE auction_id = $1 AND seq = $2`,
    [auctionId, seq],
  );
  return rows[0]?.payload || null;
}

async function replayAuctionWsEvents(pool, auctionId, afterSeq) {
  const floor = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0;
  const { rows } = await pool.query(
    `SELECT payload FROM auction_ws_events
     WHERE auction_id = $1 AND seq > $2
     ORDER BY seq ASC`,
    [auctionId, floor],
  );
  return rows.map((r) => r.payload);
}

async function currentAuctionWsSeq(pool, auctionId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM auction_ws_events WHERE auction_id = $1`,
    [auctionId],
  );
  return Number(rows[0]?.seq || 0);
}

module.exports = {
  NOTIFY_CHANNEL,
  appendAuctionWsEvent,
  fetchAuctionWsEvent,
  replayAuctionWsEvents,
  currentAuctionWsSeq,
};
