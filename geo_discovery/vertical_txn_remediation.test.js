/**
 * GEO remediation — Feed/Equipment/Training server gates (post-fix).
 * Validates atomic stock, rental overlap, training capacity modules + wiring.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const feedStock = require('../vertical_feed_stock');
const equipmentRental = require('../vertical_equipment_rental');
const trainingCapacity = require('../vertical_training_capacity');
const txnRelease = require('../vertical_txn_release');
const txnPrim = require('../vertical_txn_primitives');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

describe('Transaction remediation — POST /bookings gates wired', () => {
  it('POST /bookings includes feed + equipment + training branches', () => {
    const src = read(INDEX_PATH);
    const postStart = src.indexOf("app.post('/bookings'");
    const patchStart = src.indexOf("app.patch('/bookings/:id'");
    const postBookings = src.slice(postStart, patchStart);
    assert.match(postBookings, /kind\s*===\s*['"]feed['"]/);
    assert.match(postBookings, /kind\s*===\s*['"]equipment['"]/);
    assert.match(postBookings, /kind\s*===\s*['"]training['"]/);
    assert.match(postBookings, /reserveFeedStock/);
    assert.match(postBookings, /evaluateAndAuthorizeEquipmentRental/);
    assert.match(postBookings, /evaluateTrainingCapacity/);
    assert.match(postBookings, /idempotencyLookup|readIdempotencyKey/);
  });
});

describe('Feed atomic stock', () => {
  it('prevents overselling qty=1 under two sequential reserves', () => {
    const service = {
      id: 's1',
      products: [{ id: 'p1', availableQuantity: 1 }],
    };
    const a = feedStock.reserveFeedStock({
      service,
      productId: 'p1',
      quantity: 1,
    });
    const b = feedStock.reserveFeedStock({
      service,
      productId: 'p1',
      quantity: 1,
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.code, 'OUT_OF_STOCK');
    assert.equal(service.products[0].availableQuantity, 0);
  });

  it('restores stock on cancel/expiry release', () => {
    const service = {
      id: 's1',
      products: [{ id: 'p1', availableQuantity: 0 }],
    };
    const store = {
      services: new Map([['s1', service]]),
    };
    const booking = {
      type: 'feed',
      serviceId: 's1',
      stockDeducted: true,
      stockReservedQty: 1,
      details: { productId: 'p1', quantity: 1 },
    };
    const r = txnRelease.releaseVerticalReservations(store, booking);
    assert.equal(r.ok, true);
    assert.equal(service.products[0].availableQuantity, 1);
    assert.equal(booking.stockRestored, true);
  });
});

describe('Equipment commercial mode + atomic rental', () => {
  it('rejects rental on sale-only equipment', () => {
    const service = {
      id: 's1',
      inventory: [
        { id: 'e1', availableQuantity: 2, commercialMode: 'sale' },
      ],
    };
    const gate = equipmentRental.evaluateAndAuthorizeEquipmentRental({
      service,
      bookings: [],
      equipmentId: 'e1',
      startDate: '2030-01-01',
      endDate: '2030-01-05',
      quantity: 1,
      body: { transactionKind: 'rental' },
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'RENTAL_NOT_ALLOWED');
  });

  it('allows sale path without rental overlap gate', () => {
    const service = {
      id: 's1',
      inventory: [
        { id: 'e1', availableQuantity: 1, commercialMode: 'sale' },
      ],
    };
    const gate = equipmentRental.evaluateAndAuthorizeEquipmentRental({
      service,
      bookings: [],
      equipmentId: 'e1',
      startDate: '2030-01-01',
      endDate: '2030-01-05',
      quantity: 1,
      body: { transactionKind: 'sale' },
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.transactionKind, 'sale');
    assert.equal(gate.skipRentalGate, true);
  });

  it('blocks overlapping rentals when qty=1', () => {
    const service = {
      id: 's1',
      inventory: [
        { id: 'e1', availableQuantity: 1, commercialMode: 'rental' },
      ],
    };
    const existing = [
      {
        id: 'b1',
        type: 'equipment',
        serviceId: 's1',
        status: 'pending',
        transactionKind: 'rental',
        details: {
          equipmentId: 'e1',
          quantity: 1,
          startDate: '2030-01-01',
          endDate: '2030-01-05',
        },
        startDate: '2030-01-01',
        endDate: '2030-01-05',
      },
    ];
    const gate = equipmentRental.evaluateAndAuthorizeEquipmentRental({
      service,
      bookings: existing,
      equipmentId: 'e1',
      startDate: '2030-01-03',
      endDate: '2030-01-07',
      quantity: 1,
      body: {},
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'RENTAL_CONFLICT');
  });
});

describe('Training server capacity', () => {
  it('rejects when blocking bookings fill capacity', () => {
    const service = {
      id: 's1',
      programs: [{ id: 'prog1', capacity: 1 }],
    };
    const bookings = [
      {
        id: 't1',
        type: 'training',
        serviceId: 's1',
        status: 'pending',
        details: { programId: 'prog1' },
      },
    ];
    const a = trainingCapacity.evaluateTrainingCapacity({
      service,
      bookings,
      programId: 'prog1',
    });
    assert.equal(a.ok, false);
    assert.equal(a.code, 'CAPACITY_FULL');
  });
});

describe('Shared primitives', () => {
  it('idempotency remembers and returns same booking id', () => {
    const store = {};
    txnPrim.idempotencyRemember(store, 'u1', 'key-a', 'b99');
    const hit = txnPrim.idempotencyLookup(store, 'u1', 'key-a');
    assert.equal(hit.bookingId, 'b99');
  });
});
