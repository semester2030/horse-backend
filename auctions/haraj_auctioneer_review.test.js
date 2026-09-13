'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  EVENTS,
  operationalStatus,
  sellerSafeReview,
} = require('./services/haraj_auctioneer_review');

describe('G4 review operational status', () => {
  it('maps existing statuses without inventing auction.status values', () => {
    assert.equal(operationalStatus({ status: 'review' }, null, false), 'under_review');
    assert.equal(
      operationalStatus({ status: 'review' }, { event_type: EVENTS.ACCEPTED }, true),
      'approved_for_haraj',
    );
    assert.equal(
      operationalStatus({ status: 'draft' }, { event_type: EVENTS.CHANGES }, false),
      'needs_changes',
    );
    assert.equal(
      operationalStatus({ status: 'cancelled' }, { event_type: EVENTS.REJECTED }, false),
      'rejected',
    );
    assert.equal(operationalStatus({ status: 'draft' }, null, false), 'draft');
  });

  it('seller-safe review never exposes internal notes', () => {
    const review = sellerSafeReview(
      { status: 'draft' },
      {
        event_type: EVENTS.CHANGES,
        payload: { sellerMessage: 'أضف فيديو أوضح', internalNote: 'SECRET' },
        created_at: '2026-09-05T00:00:00Z',
      },
      false,
    );
    assert.equal(review.sellerMessage, 'أضف فيديو أوضح');
    assert.equal(review.internalNote, undefined);
    assert.equal(review.roomAssigned, false);
    assert.equal(review.queueAssigned, false);
  });
});
