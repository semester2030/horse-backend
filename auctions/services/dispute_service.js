'use strict';

const { DISPUTE_STATUSES } = require('../config');
const { appendEvent } = require('./auction_service');

function mapDisputeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    auctionId: row.auction_id,
    bidId: row.bid_id,
    reporterUserId: row.reporter_user_id,
    category: row.category,
    description: row.description,
    evidenceRefs: row.evidence_refs || [],
    status: row.status,
    assignedAdminId: row.assigned_admin_id,
    resolution: row.resolution,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

async function createDispute(client, input) {
  const category = String(input.category || '').trim();
  const description = String(input.description || '').trim();
  if (!category || !description) {
    const err = new Error('category and description required');
    err.code = 'DISPUTE_INVALID';
    err.status = 400;
    throw err;
  }

  const { rows: auctions } = await client.query(
    `SELECT id FROM auctions WHERE id = $1`,
    [input.auctionId],
  );
  if (!auctions[0]) {
    const err = new Error('Auction not found');
    err.code = 'AUCTION_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const { rows } = await client.query(
    `INSERT INTO auction_disputes (
      auction_id, bid_id, reporter_user_id, category, description, evidence_refs, status
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'open')
    RETURNING *`,
    [
      input.auctionId,
      input.bidId || null,
      String(input.reporterUserId),
      category,
      description,
      JSON.stringify(input.evidenceRefs || []),
    ],
  );

  await appendEvent(client, {
    auctionId: input.auctionId,
    eventType: 'dispute.opened',
    payload: {
      disputeId: rows[0].id,
      category,
      bidId: input.bidId || null,
    },
    actorUserId: input.reporterUserId,
  });

  return mapDisputeRow(rows[0]);
}

async function assignDispute(client, disputeId, { adminId } = {}) {
  const { rows } = await client.query(
    `UPDATE auction_disputes SET status = 'reviewing', assigned_admin_id = $1, updated_at = NOW()
     WHERE id = $2 AND status = 'open'
     RETURNING *`,
    [adminId, disputeId],
  );
  if (!rows[0]) {
    const err = new Error('Dispute not found or not open');
    err.code = 'DISPUTE_INVALID';
    err.status = 409;
    throw err;
  }
  await appendEvent(client, {
    auctionId: rows[0].auction_id,
    eventType: 'dispute.reviewing',
    payload: { disputeId, assignedAdminId: adminId },
    actorUserId: adminId,
  });
  return mapDisputeRow(rows[0]);
}

async function resolveDispute(client, disputeId, { adminId, resolution, note } = {}) {
  const { rows } = await client.query(
    `UPDATE auction_disputes SET status = 'resolved', resolution = $1, resolution_note = $2,
            resolved_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND status IN ('open','reviewing')
     RETURNING *`,
    [resolution || 'resolved', note || null, disputeId],
  );
  if (!rows[0]) {
    const err = new Error('Dispute not found or already closed');
    err.code = 'DISPUTE_INVALID';
    err.status = 409;
    throw err;
  }
  await appendEvent(client, {
    auctionId: rows[0].auction_id,
    eventType: 'dispute.resolved',
    payload: { disputeId, resolution: resolution || 'resolved' },
    actorUserId: adminId,
  });
  return mapDisputeRow(rows[0]);
}

async function rejectDispute(client, disputeId, { adminId, note } = {}) {
  const { rows } = await client.query(
    `UPDATE auction_disputes SET status = 'rejected', resolution = 'rejected', resolution_note = $1,
            resolved_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND status IN ('open','reviewing')
     RETURNING *`,
    [note || null, disputeId],
  );
  if (!rows[0]) {
    const err = new Error('Dispute not found or already closed');
    err.code = 'DISPUTE_INVALID';
    err.status = 409;
    throw err;
  }
  await appendEvent(client, {
    auctionId: rows[0].auction_id,
    eventType: 'dispute.rejected',
    payload: { disputeId, note: note || null },
    actorUserId: adminId,
  });
  return mapDisputeRow(rows[0]);
}

async function listDisputes(pool, { status, auctionId, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  let n = 1;
  if (status) {
    clauses.push(`status = $${n++}`);
    params.push(String(status));
  }
  if (auctionId) {
    clauses.push(`auction_id = $${n++}`);
    params.push(auctionId);
  }
  params.push(Math.min(Number(limit) || 50, 100));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM auction_disputes ${where} ORDER BY created_at DESC LIMIT $${n}`,
    params,
  );
  return rows.map(mapDisputeRow);
}

module.exports = {
  DISPUTE_STATUSES,
  mapDisputeRow,
  createDispute,
  assignDispute,
  resolveDispute,
  rejectDispute,
  listDisputes,
};
