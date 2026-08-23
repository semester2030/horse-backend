'use strict';

const { effectiveEndAt } = require('../domain/states');

const VIEWABLE_STATUSES = new Set([
  'scheduled',
  'live',
  'extended',
  'ended',
  'sold',
  'unsold',
]);

function sanitizeBidderLabel(bidderUserId) {
  const id = String(bidderUserId || '').trim();
  if (id.length <= 4) return 'مزايد';
  return `مزايد ···${id.slice(-4)}`;
}

function auctionSnapshotPayload(auction, now = new Date()) {
  const rowLike = {
    end_at: auction.endAt || auction.end_at,
    extended_until: auction.extendedUntil || auction.extended_until,
  };
  const currentPrice = Number(auction.currentPrice ?? auction.current_price);
  const minimumIncrement = Number(
    auction.minimumIncrement ?? auction.minimum_increment ?? 0,
  );
  const nextMinimumBid = currentPrice + minimumIncrement;
  return {
    auctionId: auction.id,
    serverTimestamp: now.toISOString(),
    version: Number(auction.version),
    currentPrice,
    state: auction.status,
    effectiveEndAt: effectiveEndAt(rowLike, now).toISOString(),
    nextMinimumBid,
    nextValidBid: nextMinimumBid,
  };
}

function createAuctionRealtime({ wsHub, getPool }) {
  function publish(type, auction, extra = {}) {
    if (!wsHub || typeof wsHub.publishAuction !== 'function') return null;
    if (!auction?.id) return null;
    return wsHub.publishAuction({
      type,
      ...auctionSnapshotPayload(auction),
      ...extra,
    });
  }

  async function canSubscribe(userId, auctionId) {
    if (!userId || !auctionId) return false;
    let pool;
    try {
      pool = typeof getPool === 'function' ? getPool() : null;
    } catch (_) {
      return false;
    }
    if (!pool) return false;
    const { rows } = await pool.query(
      `SELECT status, owner_user_id FROM auctions WHERE id = $1`,
      [auctionId],
    );
    if (!rows[0]) return false;
    const { status, owner_user_id: ownerUserId } = rows[0];
    if (['draft', 'review', 'cancelled'].includes(status)) {
      return String(ownerUserId) === String(userId);
    }
    return VIEWABLE_STATUSES.has(status);
  }

  /**
   * Post-COMMIT delivery only. Optional metrics must come from PostgreSQL
   * aggregates — never invent client-side financial counters.
   */
  function publishBidAccepted(
    auction,
    bid,
    { wasExtended = false, metrics = {} } = {},
  ) {
    const out = [];
    const metricExtra = {};
    if (metrics.bidCount != null) metricExtra.bidCount = Number(metrics.bidCount);
    if (metrics.uniqueBidders != null) {
      metricExtra.uniqueBidders = Number(metrics.uniqueBidders);
    }
    if (metrics.extensionsCount != null) {
      metricExtra.extensionsCount = Number(metrics.extensionsCount);
    }
    out.push(
      publish('bid.accepted', auction, {
        bidId: bid.id || bid.bidId || null,
        bidAmount: Number(bid.amount),
        bidderLabel: sanitizeBidderLabel(bid.bidderUserId || bid.bidder_user_id),
        ...metricExtra,
      }),
    );
    if (wasExtended || auction.status === 'extended') {
      out.push(
        publish('auction.extended', auction, {
          antiSniping: true,
          ...(metricExtra.extensionsCount != null
            ? { extensionsCount: metricExtra.extensionsCount }
            : {}),
        }),
      );
    }
    return out.filter(Boolean);
  }

  /** Ephemeral presence — not sequenced, not financial SoT. */
  function publishPresence(auctionId, liveViewers) {
    if (!wsHub || typeof wsHub.publishAuctionPresence !== 'function') {
      return null;
    }
    return wsHub.publishAuctionPresence(auctionId, liveViewers);
  }

  function publishTransition(beforeStatus, auction, { reason } = {}) {
    const out = [];
    if (auction.status === 'live' && beforeStatus === 'scheduled') {
      out.push(publish('auction.started', auction));
    } else if (auction.status === 'cancelled') {
      out.push(publish('auction.cancelled', auction, { reason: reason || null }));
    } else if (auction.status === 'ended') {
      out.push(publish('auction.ended', auction));
    }
    return out.filter(Boolean);
  }

  function publishClosed(auction, closedPayload = {}) {
    const out = [];
    out.push(publish('auction.ended', auction));
    if (closedPayload.finalStatus === 'sold') {
      out.push(
        publish('auction.sold', auction, {
          finalPrice: closedPayload.finalPrice,
          winnerLabel: 'فائز',
        }),
      );
    } else {
      out.push(
        publish('auction.unsold', auction, {
          finalPrice: closedPayload.finalPrice,
        }),
      );
    }
    return out.filter(Boolean);
  }

  return {
    canSubscribe,
    publish,
    publishBidAccepted,
    publishPresence,
    publishTransition,
    publishClosed,
    sanitizeBidderLabel,
  };
}

module.exports = {
  createAuctionRealtime,
  sanitizeBidderLabel,
  auctionSnapshotPayload,
};
