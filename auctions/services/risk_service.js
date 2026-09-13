'use strict';

const { appendEvent } = require('./auction_service');

const RULES = {
  RAPID_REPEATED_BIDS: {
    code: 'rapid_repeated_bids',
    windowSeconds: 30,
    threshold: 5,
    severity: 'medium',
    summary: 'Bidder placed many bids in a short window',
  },
  ABNORMAL_VELOCITY: {
    code: 'abnormal_bid_velocity',
    windowSeconds: 60,
    threshold: 20,
    severity: 'high',
    summary: 'Unusually high bid velocity on auction',
  },
  OWNER_RELATIONSHIP: {
    code: 'bidder_owner_relationship',
    severity: 'high',
    summary: 'Bidder shares identity marker with auction creator',
  },
  LAST_SECOND_PATTERN: {
    code: 'last_second_bid_pattern',
    windowSeconds: 10,
    threshold: 3,
    severity: 'medium',
    summary: 'Cluster of bids in final seconds',
  },
  REPEATED_CANCELLATIONS: {
    code: 'repeated_owner_cancellations',
    threshold: 3,
    severity: 'low',
    summary: 'Owner has multiple cancelled auctions',
  },
};

function mapRiskRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    auctionId: row.auction_id,
    bidId: row.bid_id,
    ruleCode: row.rule_code,
    severity: row.severity,
    summary: row.summary,
    payload: row.payload || {},
    acknowledged: row.acknowledged,
    acknowledgedByAdminId: row.acknowledged_by_admin_id,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
  };
}

async function insertSignal(client, { auctionId, bidId, rule, payload }) {
  const { rows: existing } = await client.query(
    `SELECT id FROM auction_risk_signals
     WHERE auction_id = $1 AND rule_code = $2 AND acknowledged = false
     LIMIT 1`,
    [auctionId, rule.code],
  );
  if (existing[0]) return mapRiskRow(existing[0]);

  const { rows } = await client.query(
    `INSERT INTO auction_risk_signals (auction_id, bid_id, rule_code, severity, summary, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING *`,
    [
      auctionId,
      bidId || null,
      rule.code,
      rule.severity,
      rule.summary,
      JSON.stringify(payload || {}),
    ],
  );

  await appendEvent(client, {
    auctionId,
    eventType: 'risk.signal',
    payload: {
      signalId: rows[0].id,
      ruleCode: rule.code,
      severity: rule.severity,
    },
    actorUserId: 'system',
  });

  return mapRiskRow(rows[0]);
}

async function evaluateRiskSignals(client, auctionId) {
  const signals = [];
  const { rows: auctionRows } = await client.query(
    `SELECT * FROM auctions WHERE id = $1`,
    [auctionId],
  );
  const auction = auctionRows[0];
  if (!auction) return signals;

  const { rows: rapid } = await client.query(
    `SELECT bidder_user_id, COUNT(*)::int AS c
     FROM bids WHERE auction_id = $1 AND created_at >= NOW() - INTERVAL '30 seconds'
     GROUP BY bidder_user_id HAVING COUNT(*) >= $2`,
    [auctionId, RULES.RAPID_REPEATED_BIDS.threshold],
  );
  for (const r of rapid) {
    signals.push(
      await insertSignal(client, {
        auctionId,
        rule: RULES.RAPID_REPEATED_BIDS,
        payload: { bidderUserId: r.bidder_user_id, count: r.c },
      }),
    );
  }

  const { rows: velocity } = await client.query(
    `SELECT COUNT(*)::int AS c FROM bids
     WHERE auction_id = $1 AND created_at >= NOW() - INTERVAL '60 seconds'`,
    [auctionId],
  );
  if (velocity[0]?.c >= RULES.ABNORMAL_VELOCITY.threshold) {
    signals.push(
      await insertSignal(client, {
        auctionId,
        rule: RULES.ABNORMAL_VELOCITY,
        payload: { count: velocity[0].c },
      }),
    );
  }

  if (String(auction.created_by_user_id) === String(auction.owner_user_id)) {
    const { rows: relatedBidders } = await client.query(
      `SELECT DISTINCT bidder_user_id FROM bids
       WHERE auction_id = $1 AND bidder_user_id = $2 LIMIT 1`,
      [auctionId, auction.owner_user_id],
    );
    if (relatedBidders[0]) {
      signals.push(
        await insertSignal(client, {
          auctionId,
          rule: RULES.OWNER_RELATIONSHIP,
          payload: { bidderUserId: relatedBidders[0].bidder_user_id },
        }),
      );
    }
  }

  const end = auction.extended_until || auction.end_at;
  const { rows: lastSecond } = await client.query(
    `SELECT COUNT(*)::int AS c FROM bids
     WHERE auction_id = $1 AND created_at >= $2::timestamptz - INTERVAL '10 seconds'`,
    [auctionId, end],
  );
  if (lastSecond[0]?.c >= RULES.LAST_SECOND_PATTERN.threshold) {
    signals.push(
      await insertSignal(client, {
        auctionId,
        rule: RULES.LAST_SECOND_PATTERN,
        payload: { count: lastSecond[0].c },
      }),
    );
  }

  const { rows: cancelledCount } = await client.query(
    `SELECT COUNT(*)::int AS c FROM auctions
     WHERE owner_user_id = $1 AND status = 'cancelled'`,
    [auction.owner_user_id],
  );
  if (cancelledCount[0]?.c >= RULES.REPEATED_CANCELLATIONS.threshold) {
    signals.push(
      await insertSignal(client, {
        auctionId,
        rule: RULES.REPEATED_CANCELLATIONS,
        payload: { ownerUserId: auction.owner_user_id, count: cancelledCount[0].c },
      }),
    );
  }

  return signals.filter(Boolean);
}

async function listRiskSignals(pool, { auctionId, acknowledged, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  let n = 1;
  if (auctionId) {
    clauses.push(`auction_id = $${n++}`);
    params.push(auctionId);
  }
  if (acknowledged != null) {
    clauses.push(`acknowledged = $${n++}`);
    params.push(Boolean(acknowledged));
  }
  params.push(Math.min(Number(limit) || 50, 100));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM auction_risk_signals ${where} ORDER BY created_at DESC LIMIT $${n}`,
    params,
  );
  return rows.map(mapRiskRow);
}

async function acknowledgeRiskSignal(client, signalId, { adminId } = {}) {
  const { rows } = await client.query(
    `UPDATE auction_risk_signals SET acknowledged = true, acknowledged_by_admin_id = $1,
            acknowledged_at = NOW()
     WHERE id = $2 RETURNING *`,
    [adminId, signalId],
  );
  if (!rows[0]) {
    const err = new Error('Risk signal not found');
    err.code = 'RISK_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  await appendEvent(client, {
    auctionId: rows[0].auction_id,
    eventType: 'risk.acknowledged',
    payload: { signalId, ruleCode: rows[0].rule_code },
    actorUserId: adminId,
  });
  return mapRiskRow(rows[0]);
}

module.exports = {
  RULES,
  mapRiskRow,
  insertSignal,
  evaluateRiskSignals,
  listRiskSignals,
  acknowledgeRiskSignal,
};
