'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const g15 = require('./services/haraj_admin_command_center');

const SRC = fs.readFileSync(
  path.join(__dirname, 'services', 'haraj_admin_command_center.js'),
  'utf8',
);

describe('G15 Admin Command Center domain', () => {
  it('reuses existing Admin, forbids a second app, AI, bid edits, and money movement', () => {
    assert.equal(g15.AI_STATUS.implemented, false);
    assert.equal(g15.AI_STATUS.summaries, false);
    assert.equal(g15.AI_STATUS.recommendations, false);
    assert.equal(g15.FORBIDDEN.editAcceptedBid, false);
    assert.equal(g15.FORBIDDEN.editWinner, false);
    assert.equal(g15.FORBIDDEN.wallet, false);
    assert.equal(g15.FORBIDDEN.escrow, false);
    assert.equal(g15.FORBIDDEN.payout, false);
    assert.equal(/\b(INSERT INTO|UPDATE \w+|DELETE FROM)\b/i.test(SRC), false);
    assert.equal(/openai|llm|embedding/i.test(SRC), false);
  });

  it('classifies high-risk actions against existing auctions:ops permission', () => {
    const actions = g15.HIGH_RISK_ACTIONS.map((a) => a.action);
    assert.equal(actions.includes('bidder.suspend'), true);
    assert.equal(actions.includes('inspection.resolve'), true);
    assert.equal(actions.includes('after_haraj.close'), true);
    assert.equal(g15.HIGH_RISK_ACTIONS.every((a) => a.permission === 'auctions:ops'), true);
    assert.equal(g15.HIGH_RISK_ACTIONS.every((a) => a.money === false && a.bidTruth === false), true);
  });
});
