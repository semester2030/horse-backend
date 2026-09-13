'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const g16 = require('./services/haraj_risk_disputes');

const SRC = fs.readFileSync(
  path.join(__dirname, 'services', 'haraj_risk_disputes.js'),
  'utf8',
);

describe('G16 Risk / Disputes / Fraud domain', () => {
  it('is deterministic, explictly not AI, and never auto-labels fraud', () => {
    assert.equal(g16.AI_STATUS.implemented, false);
    assert.equal(g16.AI_STATUS.providerIntegrated, false);
    assert.equal(g16.AI_STATUS.fraudDetection, false);
    assert.equal(g16.AI_STATUS.disputeJudgment, false);
    assert.equal(g16.FINDING.FRAUDSTER, null);
    assert.equal(g16.FINDING.REVIEW, 'review_required');
    assert.equal(/openai|anthropic|embedding|vector|llm|gpt-|ml.?score/i.test(SRC), false);
    assert.equal(/FRAUDSTER/.test(SRC) && /null/.test(SRC), true);
  });

  it('versions deterministic rules and defers unapproved penalties / thresholds', () => {
    const rules = Object.values(g16.RULES);
    assert.equal(rules.length >= 4, true);
    assert.equal(rules.every((r) => r.id && r.version >= 1 && r.enabled === true), true);
    assert.equal(rules.every((r) => r.automaticSanction === false), true);
    assert.match(g16.RULES.G16_R02_WITHDRAWAL.financialPenalty, /OWNER POLICY REQUIRED/);
    assert.match(g16.RULES.G16_R03_REPEAT_WITHDRAWAL_REVIEW.thresholdPolicy, /OWNER POLICY REQUIRED/);
    assert.equal(/3 withdrawals/.test(SRC), false);
  });

  it('reuses G10 suspension and does not invent a second seller-status engine', () => {
    assert.match(SRC, /upsertBidderProfile/);
    assert.match(SRC, /eligibilityStatus: 'suspended'/);
    assert.equal(g16.SELLER_RESTRICTION.secondSystemCreated, false);
    assert.equal(Object.values(g16.RESOLUTIONS).includes('delete_account'), false);
    assert.equal(/wallet|escrow|payout|penaltySar/i.test(SRC), false);
  });

  it('exposes a privacy-safe public case view without financial or operator fields', () => {
    const view = g16.publicCaseView({
      case: {
        id: 'c1',
        status: 'open',
        category: 'buyer_withdrawal',
        auctionId: 'a1',
        resolutionNote: 'internal',
        reporterUserId: 'u1',
      },
    });
    assert.equal(view.caseId, 'c1');
    assert.equal(view.operatorNotesHidden, true);
    assert.equal(view.signalIsNotGuilt, true);
    assert.equal(view.financialPenaltyImplemented, false);
    assert.equal(view.bidLimit, undefined);
    assert.equal(view.bidSecurity, undefined);
    assert.equal(view.resolutionNote, undefined);
    assert.equal(view.ai.implemented, false);
  });
});
