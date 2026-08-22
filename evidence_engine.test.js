'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const evidence = require('./evidence_engine');

function emptyStore() {
  return {
    trips: new Map(),
    evidenceRecords: new Map(),
    evidenceEvents: [],
  };
}

let seq = 0;
const idFn = () => `id-${++seq}`;

function seedTrip(store) {
  const trip = {
    id: 'trip1',
    bookingId: 'book1',
    customerId: 'cust1',
    providerId: 'prov1',
    status: 'arrived_at_pickup',
  };
  store.trips.set(trip.id, trip);
  return trip;
}

describe('evidence_engine T5C', () => {
  it('creates exactly one evidence per trip', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const a = evidence.createEvidenceForTrip({ store, trip, idFn });
    const b = evidence.createEvidenceForTrip({ store, trip, idFn });
    assert.equal(a.ok, true);
    assert.equal(a.reused, false);
    assert.equal(b.reused, true);
    assert.equal(store.evidenceRecords.size, 1);
    assert.equal(a.evidence.status, 'pending');
    assert.equal(store.trips.get('trip1').evidenceId, a.evidence.id);
  });

  it('generates OTP, rejects wrong code, locks after max attempts', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const { evidence: rec } = evidence.createEvidenceForTrip({
      store,
      trip,
      idFn,
    });
    const gen = evidence.generateOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(gen.ok, true);
    assert.equal(gen.otp.code.length, 6);

    const bad = evidence.verifyOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      code: '000000',
      actorUserId: 'cust1',
      actorRole: 'customer',
      idFn,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'OTP_INVALID');

    // burn remaining attempts
    for (let i = 0; i < 10; i += 1) {
      evidence.verifyOtp({
        store,
        evidenceId: rec.id,
        kind: 'pickup',
        code: '111111',
        actorUserId: 'cust1',
        actorRole: 'customer',
        idFn,
      });
    }
    const locked = evidence.verifyOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      code: gen.otp.code,
      actorUserId: 'cust1',
      actorRole: 'customer',
      idFn,
    });
    assert.equal(locked.code, 'OTP_LOCKED');
  });

  it('verifies pickup then delivery OTP and completes', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const { evidence: rec } = evidence.createEvidenceForTrip({
      store,
      trip,
      idFn,
    });

    const pickupOtp = evidence.generateOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    const pickupOk = evidence.verifyOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      code: pickupOtp.otp.code,
      actorUserId: 'cust1',
      actorRole: 'customer',
      idFn,
    });
    assert.equal(pickupOk.evidence.status, 'pickup_verified');

    const reuse = evidence.verifyOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      code: pickupOtp.otp.code,
      actorUserId: 'cust1',
      actorRole: 'customer',
      idFn,
    });
    assert.equal(reuse.reused, true);

    const deliveryOtp = evidence.generateOtp({
      store,
      evidenceId: rec.id,
      kind: 'delivery',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    const deliveryOk = evidence.verifyOtp({
      store,
      evidenceId: rec.id,
      kind: 'delivery',
      code: deliveryOtp.otp.code,
      actorUserId: 'cust1',
      actorRole: 'customer',
      idFn,
    });
    assert.equal(deliveryOk.evidence.status, 'delivery_verified');

    const photo = evidence.addPhoto({
      store,
      evidenceId: rec.id,
      kind: 'delivery',
      storageRef: 'https://cdn.example/pod.jpg',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(photo.ok, true);

    const sig = evidence.captureSignature({
      store,
      evidenceId: rec.id,
      kind: 'delivery',
      storageRef: 'https://cdn.example/sig.png',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(sig.ok, true);

    const done = evidence.completeEvidence({
      store,
      evidenceId: rec.id,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(done.evidence.status, 'completed');

    const timeline = evidence.listTimeline(store, rec.id);
    assert.ok(timeline.some((e) => e.type === 'EvidenceCreated'));
    assert.ok(timeline.some((e) => e.type === 'PickupVerified'));
    assert.ok(timeline.some((e) => e.type === 'DeliveryVerified'));
    assert.ok(timeline.some((e) => e.type === 'EvidenceCompleted'));
  });

  it('rejects expired OTP and embedded binary refs', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const { evidence: rec } = evidence.createEvidenceForTrip({
      store,
      trip,
      idFn,
    });
    const t0 = Date.parse('2026-07-20T12:00:00.000Z');
    const gen = evidence.generateOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
      nowMs: t0,
      ttlMs: 60_000,
    });
    const expired = evidence.verifyOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      code: gen.otp.code,
      actorUserId: 'cust1',
      actorRole: 'customer',
      idFn,
      nowMs: t0 + 120_000,
    });
    assert.equal(expired.code, 'OTP_EXPIRED');

    const blob = evidence.addPhoto({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      storageRef: 'data:image/png;base64,aaa',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(blob.ok, false);
  });

  it('rejects illegal complete and sanitizes OTP secrets', () => {
    seq = 0;
    const store = emptyStore();
    const trip = seedTrip(store);
    const { evidence: rec } = evidence.createEvidenceForTrip({
      store,
      trip,
      idFn,
    });
    const early = evidence.completeEvidence({
      store,
      evidenceId: rec.id,
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    assert.equal(early.ok, false);

    evidence.generateOtp({
      store,
      evidenceId: rec.id,
      kind: 'pickup',
      actorUserId: 'prov1',
      actorRole: 'provider',
      idFn,
    });
    const view = evidence.getEvidenceView(store, rec.id);
    assert.equal(view.evidence.pickup.otp.hash, undefined);
    assert.equal(view.evidence.pickup.otp.salt, undefined);
    assert.equal(view.evidence.pickup.otp.code, undefined);
  });

  it('authorization roles', () => {
    const rec = {
      customerId: 'c1',
      providerId: 'p1',
    };
    assert.equal(evidence.assertEvidenceRole(rec, 'c1'), 'customer');
    assert.equal(evidence.assertEvidenceRole(rec, 'p1'), 'provider');
    assert.equal(evidence.assertEvidenceRole(rec, 'x'), null);
  });
});
