/**
 * Release vertical reservations when a booking reaches a terminal status.
 */
'use strict';

const feedStock = require('./vertical_feed_stock');

function releaseVerticalReservations(store, booking) {
  if (!store || !booking) return { ok: false };
  const kind = String(booking.type || booking.serviceType || '')
    .trim()
    .toLowerCase();

  if (kind === 'feed' || kind === 'nutrition' || kind === 'forage') {
    if (!feedStock.shouldRestoreFeedStock(booking)) {
      return { ok: true, skipped: true };
    }
    const service = store.services?.get?.(String(booking.serviceId || ''));
    const productId = feedStock.feedProductIdFromBooking(booking);
    const qty =
      Number(booking.stockReservedQty) ||
      feedStock.feedQtyFromBooking(booking);
    const result = feedStock.restoreFeedStock({
      service,
      productId,
      quantity: qty,
    });
    if (result.ok) {
      booking.stockRestored = true;
      booking.stockRestoredAt = new Date().toISOString();
    }
    return result;
  }

  // Equipment rental & training capacity are derived from active bookings —
  // cancelling/expiring automatically frees the slot (no mutable counter).
  return { ok: true, skipped: true };
}

module.exports = {
  releaseVerticalReservations,
};
