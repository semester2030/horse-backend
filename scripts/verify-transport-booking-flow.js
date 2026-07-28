#!/usr/bin/env node
/**
 * تحقق سريع من فلو حجز النقل (بدون تشغيل الخادم).
 * يشغّل: node scripts/verify-transport-booking-flow.js
 */
'use strict';

const assert = require('assert');
const bo = require('../booking_occupancy');

const service = {
  id: 'svc_t1',
  name: 'نقل نوماس',
  type: 'transportation',
  providerId: 'prov1',
  capacityPerVehicle: 4,
  numberOfVehicles: 2,
  basePrice: 200,
  pricePerKm: 2,
  pricePerUnit: 50,
  currency: 'SAR',
};

function pass(label) {
  console.log(`✓ ${label}`);
}

// 1) تطبيع من lat/lng أعلى الجسم
const normalized = bo.normalizeTransportationBookingPayload(
  {
    serviceId: 'svc_t1',
    bookingDate: '2026-08-01',
    unitsRequested: 2,
    origin: { lat: 24.7136, lng: 46.6753, address: 'الرياض' },
    destination: { lat: 21.4858, lng: 39.1925, address: 'جدة' },
    customerName: 'فارس',
  },
  service,
);
assert.strictEqual(normalized.type, 'transportation');
assert.ok(bo.hasValidCoordinates(normalized.details.origin));
assert.ok(bo.hasValidCoordinates(normalized.details.destination));
assert.strictEqual(normalized.serviceName, 'نقل نوماس');
assert.strictEqual(normalized.unitsRequested, 2);
assert.ok(normalized.details.distanceKm > 0);
assert.ok(normalized.details.estimatedPrice > 0);
pass('normalize accepts lat/lng and enriches quote fields');

// 2) سعة يومية
const bookings = [
  {
    id: 'b1',
    type: 'transportation',
    serviceId: 'svc_t1',
    status: 'confirmed',
    bookingDate: '2026-08-01',
    unitsRequested: 6,
  },
];
const capOk = bo.evaluateTransportCapacity({
  service,
  bookings,
  unitsRequested: 2,
  bookingDate: '2026-08-01',
});
assert.strictEqual(capOk.ok, true);
assert.strictEqual(capOk.available, 2);
pass('capacity allows remaining 2 units');

const capFull = bo.evaluateTransportCapacity({
  service,
  bookings,
  unitsRequested: 3,
  bookingDate: '2026-08-01',
});
assert.strictEqual(capFull.ok, false);
pass('capacity blocks overbooking');

// 3) توفر فترة
const avail = bo.buildTransportAvailabilityPayload({
  service,
  bookings,
  from: '2026-08-01',
  to: '2026-08-03',
  unitsRequested: 2,
});
assert.strictEqual(avail.type, 'transportation');
assert.strictEqual(avail.days.length, 3);
assert.strictEqual(avail.days[0].canBook, true);
assert.strictEqual(avail.days[1].canBook, true);
pass('availability payload covers date range');

// 4) عرض سعر
const quote = bo.estimateTransportQuote({
  service,
  origin: { latitude: 24.7136, longitude: 46.6753 },
  destination: { latitude: 21.4858, longitude: 39.1925 },
  unitsRequested: 2,
});
assert.ok(quote.pricingConfigured);
assert.ok(quote.distanceKm > 700 && quote.distanceKm < 1000);
assert.ok(quote.estimatedPrice >= 200);
pass('transport quote estimates distance and price');

// 5) استثناء الحجز الحالي عند إعادة الجدولة
const self = {
  id: 'b2',
  type: 'transportation',
  serviceId: 'svc_t1',
  status: 'pending',
  bookingDate: '2026-08-02',
  unitsRequested: 8,
};
const withSelf = [...bookings, self];
const reschedule = bo.evaluateTransportCapacity({
  service,
  bookings: withSelf,
  unitsRequested: 8,
  bookingDate: '2026-08-02',
  excludeBookingId: 'b2',
});
assert.strictEqual(reschedule.ok, true);
pass('excludeBookingId allows reschedule of same booking');

console.log('\nTransport booking flow checks passed.');
