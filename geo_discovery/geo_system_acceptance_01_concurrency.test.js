/**
 * GEO-SYSTEM-ACCEPTANCE-01 — Feed/Equipment concurrency evidence (post-remediation).
 * Asserts server gates exist and atomic helpers prevent oversell / double rental.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const feedStock = require('../vertical_feed_stock');
const equipmentRental = require('../vertical_equipment_rental');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

describe('GEO-SYSTEM-ACCEPTANCE-01 concurrency contracts', () => {
  it('POST /bookings source has stable + transport + vet occupancy gates', () => {
    const src = read(INDEX_PATH);
    assert.match(src, /evaluateStableOccupancy/);
    assert.match(src, /evaluateTransportCapacity/);
    assert.match(src, /evaluateVetAvailability/);
  });

  it('POST /bookings wires feed stock + equipment rental + training capacity', () => {
    const src = read(INDEX_PATH);
    const postStart = src.indexOf("app.post('/bookings'");
    const patchStart = src.indexOf("app.patch('/bookings/:id'");
    assert.ok(postStart >= 0 && patchStart > postStart, 'POST /bookings block locatable');
    const postBookings = src.slice(postStart, patchStart);

    assert.match(postBookings, /kind\s*===\s*['"]feed['"]/);
    assert.match(postBookings, /kind\s*===\s*['"]equipment['"]/);
    assert.match(postBookings, /kind\s*===\s*['"]training['"]/);
    assert.match(postBookings, /reserveFeedStock/);
    assert.match(postBookings, /evaluateAndAuthorizeEquipmentRental/);
    assert.match(postBookings, /evaluateTrainingCapacity/);
  });

  it('atomic feed reserve prevents oversell qty=1', () => {
    const product = { id: 'p1', availableQuantity: 1 };
    const service = { id: 's1', products: [product] };

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
    assert.equal(product.availableQuantity, 0);
  });

  it('atomic equipment rental rejects overlapping qty=1', () => {
    const item = { id: 'e1', availableQuantity: 1, commercialMode: 'rental' };
    const service = { id: 's1', inventory: [item] };
    const bookings = [
      {
        id: 'r_u1',
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
      bookings,
      equipmentId: 'e1',
      startDate: '2030-01-03',
      endDate: '2030-01-07',
      quantity: 1,
      body: {},
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'RENTAL_CONFLICT');
  });

  it('training capacity branch exists in POST /bookings', () => {
    const src = read(INDEX_PATH);
    assert.match(src, /kind\s*===\s*['"]training['"]/);
  });
});
