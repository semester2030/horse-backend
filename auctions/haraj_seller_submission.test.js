'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isHarajChannel,
  assertNoOwnershipSpoof,
  rejectForbiddenSellerControls,
  applyHarajCreateDefaults,
  validateHarajSellerPayload,
  mergeDescriptionWithInspection,
  HARAJ_DEFAULT_INCREMENT,
} = require('./services/haraj_seller_submission');

describe('G3 haraj seller submission helpers', () => {
  it('detects haraj channel', () => {
    assert.equal(isHarajChannel({ channel: 'haraj' }), true);
    assert.equal(isHarajChannel({ haraj: true }), true);
    assert.equal(isHarajChannel({ channel: 'listing' }), false);
    assert.equal(isHarajChannel({}), false);
  });

  it('rejects client ownership spoof', () => {
    const bad = assertNoOwnershipSpoof(
      { ownerUserId: 'attacker', sellerId: 'attacker' },
      'seller-a',
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 403);
    assert.equal(bad.code, 'AUCTION_OWNER_FORBIDDEN');

    const okSame = assertNoOwnershipSpoof({ ownerUserId: 'seller-a' }, 'seller-a');
    assert.equal(okSame.ok, true);

    const hostOk = assertNoOwnershipSpoof(
      { ownerUserId: 'other-owner' },
      'host-1',
      { allowHostProxyOwner: true },
    );
    assert.equal(hostOk.ok, true);
  });

  it('rejects seller control of bid/winner/queue/room', () => {
    const r = rejectForbiddenSellerControls({ currentPrice: 999, winnerUserId: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AUCTION_FIELD_FORBIDDEN');
  });

  it('applies system commercial defaults and strips identity', () => {
    const next = applyHarajCreateDefaults({
      channel: 'haraj',
      ownerUserId: 'spoof',
      sellerId: 'spoof',
      createdByRole: 'host_proxy',
      requiresHost: true,
    });
    assert.equal(next.independent, true);
    assert.equal(next.createdByRole, 'seller');
    assert.equal(next.requiresHost, false);
    assert.equal(next.minimumIncrement, HARAJ_DEFAULT_INCREMENT);
    assert.equal(next.ownerUserId, undefined);
    assert.ok(Date.parse(next.startAt) < Date.parse(next.endAt));
  });

  it('validates required haraj fields and rejects sheep', () => {
    const sheep = validateHarajSellerPayload({
      species: 'sheep',
      title: 'x',
      startingPrice: 100,
      inspection: { available: true },
    });
    assert.equal(sheep.ok, false);
    assert.equal(sheep.code, 'AUCTION_SPECIES_INVALID');

    const missingTitle = validateHarajSellerPayload({
      species: 'horse',
      startingPrice: 100,
      inspection: { available: true },
    });
    assert.equal(missingTitle.code, 'AUCTION_TITLE_REQUIRED');

    const missingInsp = validateHarajSellerPayload({
      species: 'camel',
      title: 'قعدان',
      startingPrice: 500,
    });
    assert.equal(missingInsp.code, 'AUCTION_INSPECTION_REQUIRED');

    const ok = validateHarajSellerPayload({
      species: 'falcon',
      title: 'حر',
      startingPrice: 2000,
      reservePrice: 2500,
      description: 'وصف',
      inspection: { available: true, windows: 'بعد العصر' },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.species, 'falcon');
    assert.match(ok.description, /المعاينة: متاحة/);
  });

  it('merges inspection appendix without inventing workflow', () => {
    const text = mergeDescriptionWithInspection('جمل أصيل', {
      available: false,
      windows: null,
      locationReference: 'قرب الحراج',
      notes: null,
    });
    assert.match(text, /جمل أصيل/);
    assert.match(text, /غير متاحة/);
    assert.match(text, /ليست سير عمل المعاينة/);
  });
});
