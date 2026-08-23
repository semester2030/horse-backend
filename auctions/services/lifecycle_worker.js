'use strict';

/**
 * Server-side auction lifecycle automation.
 * PostgreSQL is authoritative — Flutter timers must not drive go-live/close.
 *
 * - scheduled + start_at <= NOW() → live (system)
 * - live|extended + effective end <= NOW() → sold|unsold (system)
 * Multi-instance safe via pg_try_advisory_xact_lock on a shared key.
 */

const { withTransaction } = require('../db');
const {
  goLiveIfDue,
  closeAuctionAtomic,
} = require('./auction_service');

const LIFECYCLE_LOCK_KEY = 'nomas:auction:lifecycle_worker';

function lifecycleIntervalMs() {
  const n = Number(process.env.AUCTION_LIFECYCLE_INTERVAL_MS || 5000);
  return Number.isFinite(n) && n >= 1000 ? n : 5000;
}

/**
 * One tick: claim worker lock, advance due auctions, return transitions for WS publish after COMMIT.
 */
async function runLifecycleTick({ auctionRealtime } = {}) {
  const result = await withTransaction(async (client) => {
    const { rows: lockRows } = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
      [LIFECYCLE_LOCK_KEY],
    );
    if (!lockRows[0]?.ok) {
      return { skipped: true, reason: 'lock_held', goLive: [], closed: [] };
    }

    const goLive = [];
    const closed = [];

    const { rows: dueLive } = await client.query(
      `SELECT id FROM auctions
       WHERE status = 'scheduled' AND start_at <= NOW()
       ORDER BY start_at ASC
       LIMIT 50`,
    );
    for (const row of dueLive) {
      const before = 'scheduled';
      const auction = await goLiveIfDue(client, row.id);
      if (auction && auction.status === 'live') {
        goLive.push({ beforeStatus: before, auction });
      }
    }

    const { rows: dueClose } = await client.query(
      `SELECT id FROM auctions
       WHERE status IN ('live', 'extended')
         AND COALESCE(extended_until, end_at) <= NOW()
       ORDER BY COALESCE(extended_until, end_at) ASC
       LIMIT 50`,
    );
    for (const row of dueClose) {
      try {
        const auction = await closeAuctionAtomic(client, row.id, {
          actorUserId: 'system',
        });
        const { rows: ev } = await client.query(
          `SELECT payload FROM auction_events
           WHERE auction_id = $1 AND event_type = 'auction.closed'
           ORDER BY created_at DESC LIMIT 1`,
          [row.id],
        );
        closed.push({ auction, payload: ev[0]?.payload || {} });
      } catch (err) {
        if (
          err.code === 'AUCTION_STILL_ACTIVE' ||
          err.code === 'AUCTION_FROZEN' ||
          err.code === 'AUCTION_NOT_CLOSABLE'
        ) {
          continue;
        }
        throw err;
      }
    }

    return { skipped: false, goLive, closed };
  });

  if (auctionRealtime && !result.skipped) {
    for (const item of result.goLive) {
      try {
        auctionRealtime.publishTransition(item.beforeStatus, item.auction);
      } catch (e) {
        console.warn('[auctions:lifecycle] publish go-live failed:', e.message);
      }
    }
    for (const item of result.closed) {
      try {
        auctionRealtime.publishClosed(item.auction, item.payload);
      } catch (e) {
        console.warn('[auctions:lifecycle] publish close failed:', e.message);
      }
    }
  }

  return result;
}

function startAuctionLifecycleWorker({ auctionRealtime } = {}) {
  const intervalMs = lifecycleIntervalMs();
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    runLifecycleTick({ auctionRealtime }).catch((e) => {
      console.error('[auctions:lifecycle] tick failed:', e.message);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[auctions:lifecycle] worker started intervalMs=${intervalMs}`);

  return {
    intervalMs,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runOnce: () => runLifecycleTick({ auctionRealtime }),
  };
}

module.exports = {
  LIFECYCLE_LOCK_KEY,
  lifecycleIntervalMs,
  runLifecycleTick,
  startAuctionLifecycleWorker,
};
