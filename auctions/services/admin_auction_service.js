'use strict';

const { mapAuctionRow } = require('./auction_service');
const { mapBidRow } = require('./bid_service');
const { mapDisputeRow } = require('./dispute_service');
const { mapRiskRow } = require('./risk_service');
const { effectiveEndAt } = require('../domain/states');

async function listAdminAuctions(pool, filters = {}) {
  const clauses = ['1=1'];
  const params = [];
  let n = 1;

  if (filters.status) {
    if (filters.status === 'disputed') {
      clauses.push(
        `EXISTS (SELECT 1 FROM auction_disputes d WHERE d.auction_id = a.id AND d.status IN ('open','reviewing'))`,
      );
    } else {
      clauses.push(`a.status = $${n++}`);
      params.push(String(filters.status).toLowerCase());
    }
  }

  if (filters.species) {
    clauses.push(`a.species = $${n++}`);
    params.push(String(filters.species).toLowerCase());
  }
  if (filters.ownerUserId) {
    clauses.push(`a.owner_user_id = $${n++}`);
    params.push(String(filters.ownerUserId));
  }
  if (filters.hostId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM host_bookings hb WHERE hb.auction_id = a.id AND hb.host_id = $${n++} AND hb.status IN ('requested','accepted','scheduled'))`,
    );
    params.push(filters.hostId);
  }
  if (filters.liveNow === 'true' || filters.liveNow === true) {
    clauses.push(`a.status IN ('live','extended')`);
  }
  if (filters.fromDate) {
    clauses.push(`a.start_at >= $${n++}`);
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    clauses.push(`a.start_at <= $${n++}`);
    params.push(filters.toDate);
  }
  if (filters.minPrice != null) {
    clauses.push(`a.current_price >= $${n++}`);
    params.push(Number(filters.minPrice));
  }
  if (filters.maxPrice != null) {
    clauses.push(`a.current_price <= $${n++}`);
    params.push(Number(filters.maxPrice));
  }
  if (filters.q) {
    clauses.push(
      `(l.listing_id ILIKE $${n} OR l.video_id ILIKE $${n} OR l.title ILIKE $${n} OR a.id::text ILIKE $${n})`,
    );
    params.push(`%${filters.q}%`);
    n++;
  }

  params.push(Math.min(Number(filters.limit) || 50, 100));

  const sql = `
    SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title,
           hb.host_id, ah.display_name AS host_display_name,
           (SELECT COUNT(*)::int FROM auction_disputes d
            WHERE d.auction_id = a.id AND d.status IN ('open','reviewing')) AS open_disputes,
           (SELECT COUNT(*)::int FROM auction_risk_signals rs
            WHERE rs.auction_id = a.id AND rs.acknowledged = false) AS open_risk_signals
    FROM auctions a
    JOIN auction_lots l ON l.id = a.lot_id
    LEFT JOIN host_bookings hb ON hb.auction_id = a.id AND hb.status IN ('requested','accepted','scheduled')
    LEFT JOIN auction_hosts ah ON ah.id = hb.host_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY
      CASE a.status WHEN 'live' THEN 0 WHEN 'extended' THEN 1 WHEN 'frozen' THEN 2
                    WHEN 'review' THEN 3 WHEN 'scheduled' THEN 4 ELSE 5 END,
      a.updated_at DESC
    LIMIT $${n}`;

  const { rows } = await pool.query(sql, params);
  const now = new Date();
  return rows.map((row) => {
    const a = mapAuctionRow(row);
    a.lotTitle = row.lot_title;
    a.hostId = row.host_id;
    a.hostDisplayName = row.host_display_name;
    a.openDisputes = row.open_disputes;
    a.openRiskSignals = row.open_risk_signals;
    a.serverTime = now.toISOString();
    a.effectiveEndAt = effectiveEndAt(row, now).toISOString();
    return a;
  });
}

async function getAdminAuctionDetail(pool, auctionId) {
  const { rows } = await pool.query(
    `SELECT a.*, l.listing_id, l.video_id, l.title AS lot_title
     FROM auctions a JOIN auction_lots l ON l.id = a.lot_id WHERE a.id = $1`,
    [auctionId],
  );
  if (!rows[0]) return null;
  const now = new Date();
  const auction = mapAuctionRow(rows[0]);
  auction.lotTitle = rows[0].lot_title;
  auction.serverTime = now.toISOString();
  auction.effectiveEndAt = effectiveEndAt(rows[0], now).toISOString();

  const [bids, events, disputes, risks] = await Promise.all([
    pool.query(
      `SELECT * FROM bids WHERE auction_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [auctionId],
    ),
    pool.query(
      `SELECT * FROM auction_events WHERE auction_id = $1 ORDER BY created_at ASC`,
      [auctionId],
    ),
    pool.query(
      `SELECT * FROM auction_disputes WHERE auction_id = $1 ORDER BY created_at DESC`,
      [auctionId],
    ),
    pool.query(
      `SELECT * FROM auction_risk_signals WHERE auction_id = $1 ORDER BY created_at DESC`,
      [auctionId],
    ),
  ]);

  auction.bids = bids.rows.map(mapBidRow);
  auction.timeline = events.rows.map((e) => ({
    id: e.id,
    type: 'event',
    eventType: e.event_type,
    payload: e.payload,
    actorUserId: e.actor_user_id,
    createdAt: e.created_at,
  }));
  for (const d of disputes.rows) {
    auction.timeline.push({
      id: d.id,
      type: 'dispute',
      eventType: `dispute.${d.status}`,
      payload: mapDisputeRow(d),
      actorUserId: d.reporter_user_id,
      createdAt: d.created_at,
    });
  }
  for (const r of risks.rows) {
    auction.timeline.push({
      id: r.id,
      type: 'risk',
      eventType: 'risk.signal',
      payload: mapRiskRow(r),
      actorUserId: 'system',
      createdAt: r.created_at,
    });
  }
  auction.timeline.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  auction.disputes = disputes.rows.map(mapDisputeRow);
  auction.riskSignals = risks.rows.map(mapRiskRow);
  return auction;
}

module.exports = {
  listAdminAuctions,
  getAdminAuctionDetail,
};
