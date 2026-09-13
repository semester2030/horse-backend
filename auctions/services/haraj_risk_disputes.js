'use strict';

/**
 * G16 — Deterministic risk / disputes / fraud operations.
 * Signal ≠ guilt. No AI. No automatic high-impact sanctions.
 * Reuses auction_disputes + auction_risk_signals + G10 suspension.
 */

const disputeService = require('./dispute_service');
const { insertSignal, mapRiskRow } = require('./risk_service');
const harajG10 = require('./haraj_bidder_security');

const AI_STATUS = Object.freeze({
  scope: 'DEFERRED — OWNER DECISION',
  implemented: false,
  providerIntegrated: false,
  fraudDetection: false,
  disputeJudgment: false,
});

const CASE_TYPES = Object.freeze({
  MATERIAL_MISMATCH: 'material_description_dispute',
  BUYER_WITHDRAWAL: 'buyer_withdrawal',
  SELLER_DISCLOSURE: 'seller_disclosure_issue',
  BID_MANIPULATION: 'bid_manipulation_suspicion',
  AFTER_HARAJ_OFFER: 'after_haraj_offer_dispute',
  INSPECTION: 'inspection_dispute',
});

const RULES = Object.freeze({
  G16_R01_MISMATCH: {
    id: 'G16-R01',
    version: 1,
    trigger: 'G11 confirm_mismatch',
    evidenceSource: 'haraj_provisional_awards + inspection events',
    resulting: 'signal + case',
    automaticSanction: false,
    enabled: true,
  },
  G16_R02_WITHDRAWAL: {
    id: 'G16-R02',
    version: 1,
    trigger: 'G11 buyer withdrawn',
    evidenceSource: 'haraj.inspection.buyer_withdrawn',
    resulting: 'signal + case (no monetary penalty)',
    automaticSanction: false,
    enabled: true,
    financialPenalty: 'OWNER POLICY REQUIRED — deferred',
  },
  G16_R03_REPEAT_WITHDRAWAL_REVIEW: {
    id: 'G16-R03',
    version: 1,
    trigger: 'repeated withdrawn awards for same buyer',
    evidenceSource: 'haraj_provisional_awards.status=withdrawn',
    resulting: 'review signal only',
    automaticSanction: false,
    enabled: true,
    thresholdPolicy: 'OWNER POLICY REQUIRED — no hardcoded suspension count',
  },
  G16_R04_SELLER_SELF_BID: {
    id: 'G16-R04',
    version: 1,
    trigger: 'owner bid attempt evidence',
    evidenceSource: 'bids.bidder_user_id = auctions.owner_user_id',
    resulting: 'signal + case',
    automaticSanction: false,
    enabled: true,
  },
});

const FINDING = Object.freeze({
  NONE: 'none',
  REVIEW: 'review_required',
  /* never auto-assigned */
  FRAUDSTER: null,
});

const SELLER_RESTRICTION = Object.freeze({
  secondSystemCreated: false,
  reuse: 'No dedicated G16 seller-status engine. Historical Lots remain. Operator may use existing admin user controls; bidder sanctions reuse G10 only.',
});

function sameTimestamp(a, b) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && ta === tb;
}

function publicCaseView(detail) {
  return {
    caseId: detail.case.id,
    status: detail.case.status,
    category: detail.case.category,
    auctionId: detail.case.auctionId,
    signalIsNotGuilt: true,
    financialPenaltyImplemented: false,
    operatorNotesHidden: true,
    bidLimit: undefined,
    activeExposure: undefined,
    bidSecurity: undefined,
    ai: AI_STATUS,
  };
}

const RESOLUTIONS = Object.freeze({
  NO_ACTION: 'no_action',
  WARNING: 'warning',
  SUSPEND_BIDDER: 'suspend_bidder',
  REQUEST_INFORMATION: 'request_information',
  CLOSE: 'close',
});

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

async function findOpenCase(client, auctionId, category) {
  const { rows } = await client.query(
    `SELECT * FROM auction_disputes
     WHERE auction_id = $1 AND category = $2 AND status IN ('open','reviewing')
     ORDER BY created_at DESC LIMIT 1`,
    [auctionId, category],
  );
  return rows[0] ? disputeService.mapDisputeRow(rows[0]) : null;
}

async function openCase(client, {
  auctionId,
  category,
  description,
  reporterUserId,
  evidenceRefs = [],
  inspectionId,
  provisionalAwardId,
  bidId,
}) {
  const existing = await findOpenCase(client, auctionId, category);
  if (existing) return { case: existing, duplicate: true };
  const created = await disputeService.createDispute(client, {
    auctionId,
    bidId,
    reporterUserId,
    category,
    description,
    evidenceRefs,
  });
  if (inspectionId || provisionalAwardId) {
    await client.query(
      `UPDATE auction_disputes
       SET inspection_id = COALESCE($2, inspection_id),
           provisional_award_id = COALESCE($3, provisional_award_id),
           updated_at = NOW()
       WHERE id = $1`,
      [created.id, inspectionId || null, provisionalAwardId || null],
    );
  }
  return { case: created, duplicate: false };
}

async function emitSignal(client, { auctionId, rule, payload, bidId }) {
  return insertSignal(client, {
    auctionId,
    bidId,
    rule: {
      code: rule.id,
      severity: 'medium',
      summary: `${rule.id} v${rule.version}: ${rule.trigger}`,
    },
    payload: {
      ...payload,
      ruleVersion: rule.version,
      evidenceSource: rule.evidenceSource,
      automaticSanction: false,
      finding: FINDING.REVIEW,
      guilt: false,
      ai: false,
    },
  });
}

async function escalateMismatch(client, { auctionId, actorUserId, inspectionId, awardId, evidenceRefs }) {
  const signal = await emitSignal(client, {
    auctionId,
    rule: RULES.G16_R01_MISMATCH,
    payload: { inspectionId, awardId },
  });
  const opened = await openCase(client, {
    auctionId,
    category: CASE_TYPES.MATERIAL_MISMATCH,
    description: 'G11 confirmed material mismatch — human review required. Not an automatic fraud finding.',
    reporterUserId: actorUserId || 'system',
    evidenceRefs,
    inspectionId,
    provisionalAwardId: awardId,
  });
  return { signal, case: opened.case, duplicate: opened.duplicate, finding: FINDING.REVIEW, guilt: false };
}

async function escalateWithdrawal(client, { auctionId, actorUserId, buyerUserId, awardId }) {
  const signal = await emitSignal(client, {
    auctionId,
    rule: RULES.G16_R02_WITHDRAWAL,
    payload: { buyerUserId, awardId, financialPenalty: false },
  });
  const opened = await openCase(client, {
    auctionId,
    category: CASE_TYPES.BUYER_WITHDRAWAL,
    description: 'Buyer withdrew after provisional award. Financial penalty deferred — OWNER POLICY REQUIRED.',
    reporterUserId: actorUserId || buyerUserId || 'system',
    provisionalAwardId: awardId,
  });
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM haraj_provisional_awards
     WHERE winner_user_id = $1 AND status = 'withdrawn'`,
    [buyerUserId],
  );
  let repeat = null;
  if (buyerUserId && Number(rows[0]?.c || 0) >= 2) {
    repeat = await emitSignal(client, {
      auctionId,
      rule: RULES.G16_R03_REPEAT_WITHDRAWAL_REVIEW,
      payload: { buyerUserId, withdrawnCount: Number(rows[0].c), autoSuspend: false },
    });
  }
  return {
    signal,
    repeatSignal: repeat,
    case: opened.case,
    duplicate: opened.duplicate,
    finding: FINDING.REVIEW,
    guilt: false,
    financialPenaltyImplemented: false,
  };
}

async function evaluateDeterministic(client, auctionId) {
  const { rows: auctions } = await client.query('SELECT * FROM auctions WHERE id = $1', [auctionId]);
  if (!auctions[0]) fail(404, 'AUCTION_NOT_FOUND', 'Auction not found');
  const auction = auctions[0];
  const out = { signals: [], cases: [], automaticSanctions: [] };

  const { rows: awards } = await client.query(
    'SELECT * FROM haraj_provisional_awards WHERE auction_id = $1',
    [auctionId],
  );
  const award = awards[0];
  if (award?.status === 'cancelled') {
    const { rows: events } = await client.query(
      `SELECT 1 FROM auction_events
       WHERE auction_id = $1 AND event_type = 'haraj.inspection.operator_resolved'
         AND payload->>'resolution' = 'confirm_mismatch' LIMIT 1`,
      [auctionId],
    );
    if (events[0]) {
      out.cases.push(await escalateMismatch(client, {
        auctionId,
        actorUserId: 'system',
        awardId: award.id,
      }));
    }
  }
  if (award?.status === 'withdrawn') {
    out.cases.push(await escalateWithdrawal(client, {
      auctionId,
      buyerUserId: award.winner_user_id,
      awardId: award.id,
    }));
  }

  const { rows: selfBids } = await client.query(
    `SELECT id, bidder_user_id FROM bids
     WHERE auction_id = $1 AND bidder_user_id = $2 LIMIT 1`,
    [auctionId, auction.owner_user_id],
  );
  if (selfBids[0]) {
    const signal = await emitSignal(client, {
      auctionId,
      bidId: selfBids[0].id,
      rule: RULES.G16_R04_SELLER_SELF_BID,
      payload: { bidderUserId: selfBids[0].bidder_user_id },
    });
    const opened = await openCase(client, {
      auctionId,
      category: CASE_TYPES.BID_MANIPULATION,
      description: 'Seller identity appears on an accepted bid row. Signal only — not an automatic fraudster label.',
      reporterUserId: 'system',
      bidId: selfBids[0].id,
    });
    out.signals.push(signal);
    out.cases.push(opened);
  }

  return {
    ...out,
    guilt: false,
    ai: AI_STATUS,
    automaticHighImpactSanction: false,
    financialPenaltyImplemented: false,
  };
}

async function listCases(client, { status, category, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  let n = 1;
  if (status) {
    clauses.push(`status = $${n++}`);
    params.push(status);
  }
  if (category) {
    clauses.push(`category = $${n++}`);
    params.push(category);
  }
  params.push(Math.min(Number(limit) || 50, 100));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await client.query(
    `SELECT * FROM auction_disputes ${where} ORDER BY created_at DESC LIMIT $${n}`,
    params,
  );
  return rows.map(disputeService.mapDisputeRow);
}

async function getCase(client, caseId) {
  const { rows } = await client.query('SELECT * FROM auction_disputes WHERE id = $1', [caseId]);
  if (!rows[0]) fail(404, 'CASE_NOT_FOUND', 'Case not found');
  const dispute = disputeService.mapDisputeRow(rows[0]);
  const { rows: signals } = await client.query(
    `SELECT * FROM auction_risk_signals WHERE auction_id = $1 ORDER BY created_at DESC`,
    [dispute.auctionId],
  );
  const { rows: events } = await client.query(
    `SELECT event_type, payload, created_at, actor_user_id
     FROM auction_events WHERE auction_id = $1
       AND (event_type LIKE 'dispute.%' OR event_type LIKE 'risk.%' OR event_type LIKE 'haraj.inspection.%')
     ORDER BY created_at ASC`,
    [dispute.auctionId],
  );
  return {
    case: dispute,
    signals: signals.map(mapRiskRow),
    evidence: events,
    signalIsNotGuilt: true,
    financialPenaltyImplemented: false,
    ai: AI_STATUS,
  };
}

async function resolveCase(client, {
  caseId,
  adminId,
  resolution,
  note,
  expectedUpdatedAt,
  subjectUserId,
}) {
  if (!Object.values(RESOLUTIONS).includes(resolution)) {
    fail(400, 'CASE_RESOLUTION_INVALID', 'Unknown resolution');
  }
  const { rows } = await client.query(
    'SELECT * FROM auction_disputes WHERE id = $1 FOR UPDATE',
    [caseId],
  );
  if (!rows[0]) fail(404, 'CASE_NOT_FOUND', 'Case not found');
  const current = rows[0];
  if (expectedUpdatedAt && !sameTimestamp(current.updated_at, expectedUpdatedAt)) {
    fail(409, 'CASE_STALE_STATE', 'Case was updated by another operator');
  }
  if (!['open', 'reviewing'].includes(current.status)) {
    fail(409, 'CASE_STATE_CONFLICT', 'Case is already closed');
  }

  let suspend = null;
  if (resolution === RESOLUTIONS.SUSPEND_BIDDER) {
    const subject = subjectUserId || current.reporter_user_id;
    if (!subject) fail(400, 'CASE_SUBJECT_REQUIRED', 'subjectUserId required to reuse G10 suspension');
    if (!note) fail(400, 'CASE_REASON_REQUIRED', 'Human-review reason required for suspension');
    suspend = await harajG10.upsertBidderProfile(client, {
      userId: subject,
      eligibilityStatus: 'suspended',
      adminId,
      suspendedReason: note,
    });
  }

  const resolved = resolution === RESOLUTIONS.REQUEST_INFORMATION
    ? await disputeService.assignDispute(client, caseId, { adminId })
    : await disputeService.resolveDispute(client, caseId, {
      adminId,
      resolution,
      note: note || resolution,
    });

  return {
    case: resolved,
    suspension: suspend ? { reusedG10: true, status: suspend.eligibilityStatus || 'suspended' } : null,
    automatic: false,
    financialPenaltyImplemented: false,
    historicalBidsRewritten: false,
    ai: AI_STATUS,
  };
}

module.exports = {
  AI_STATUS,
  CASE_TYPES,
  RULES,
  FINDING,
  RESOLUTIONS,
  SELLER_RESTRICTION,
  publicCaseView,
  openCase,
  escalateMismatch,
  escalateWithdrawal,
  evaluateDeterministic,
  listCases,
  getCase,
  resolveCase,
};
