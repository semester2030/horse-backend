/**
 * HTTP routes for T5A Journey / Trip / Driver / Vehicle.
 */
'use strict';

const journey = require('./journey_engine');

function registerJourneyRoutes(app, ctx) {
  const { store, saveStore, id, auth, requireSessionUser, wsHub, notifyEvent } =
    ctx;

  function emitTrip(event) {
    if (wsHub && typeof wsHub.publishNegotiation === 'function') {
      wsHub.publishNegotiation(event);
    }
  }

  function roleForTrip(trip, userId) {
    if (String(trip.customerId) === String(userId)) return 'customer';
    if (String(trip.providerId) === String(userId)) return 'provider';
    return null;
  }

  // ——— Fleet: drivers ———
  app.get('/providers/me/drivers', auth, requireSessionUser, (req, res) => {
    journey.ensureStoreMaps(store);
    const list = [...store.drivers.values()].filter(
      (d) => String(d.providerId) === String(req.authUserId),
    );
    res.json({ drivers: list });
  });

  app.post('/providers/me/drivers', auth, requireSessionUser, (req, res) => {
    const result = journey.upsertDriver({
      store,
      providerId: req.authUserId,
      body: req.body || {},
      idFn: id,
    });
    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }
    saveStore();
    res.status(result.created ? 201 : 200).json({ driver: result.driver });
  });

  // ——— Fleet: vehicles ———
  app.get('/providers/me/vehicles', auth, requireSessionUser, (req, res) => {
    journey.ensureStoreMaps(store);
    const list = [...store.vehicles.values()].filter(
      (v) => String(v.providerId) === String(req.authUserId),
    );
    res.json({ vehicles: list });
  });

  app.post('/providers/me/vehicles', auth, requireSessionUser, (req, res) => {
    const result = journey.upsertVehicle({
      store,
      providerId: req.authUserId,
      body: req.body || {},
      idFn: id,
    });
    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }
    saveStore();
    res.status(result.created ? 201 : 200).json({ vehicle: result.vehicle });
  });

  // ——— Trips ———
  app.get('/trips', auth, requireSessionUser, (req, res) => {
    const role = req.query.role === 'provider' ? 'provider' : req.query.role === 'customer' ? 'customer' : null;
    const trips = journey.listTripsForUser(store, req.authUserId, role);
    res.json({ trips });
  });

  app.get('/trips/:tripId', auth, requireSessionUser, (req, res) => {
    journey.ensureStoreMaps(store);
    const trip = store.trips.get(String(req.params.tripId));
    if (!trip) return res.status(404).json({ message: 'الرحلة غير موجودة' });
    if (!journey.assertTripViewer(trip, req.authUserId)) {
      return res.status(403).json({ message: 'غير مصرح' });
    }
    const view = journey.getTripView(store, trip.id);
    const role = roleForTrip(trip, req.authUserId);
    res.json({
      ...view,
      viewerRole: role,
      canMutate: role === 'provider',
    });
  });

  app.get('/bookings/:bookingId/trip', auth, requireSessionUser, (req, res) => {
    const booking = store.bookings.get(String(req.params.bookingId));
    if (!booking) return res.status(404).json({ message: 'الحجز غير موجود' });
    const isParty =
      String(booking.userId) === String(req.authUserId) ||
      String(booking.providerId) === String(req.authUserId);
    if (!isParty) return res.status(403).json({ message: 'غير مصرح' });
    let trip = journey.findTripByBookingId(store, booking.id);
    if (!trip) {
      const created = journey.createTripFromBooking({
        store,
        booking,
        idFn: id,
      });
      if (!created.ok) {
        return res.status(created.status).json({ message: created.message });
      }
      trip = created.trip;
      saveStore();
    }
    if (!journey.assertTripViewer(trip, req.authUserId)) {
      return res.status(403).json({ message: 'غير مصرح' });
    }
    res.json(journey.getTripView(store, trip.id));
  });

  app.get('/trips/:tripId/timeline', auth, requireSessionUser, (req, res) => {
    journey.ensureStoreMaps(store);
    const trip = store.trips.get(String(req.params.tripId));
    if (!trip) return res.status(404).json({ message: 'الرحلة غير موجودة' });
    if (!journey.assertTripViewer(trip, req.authUserId)) {
      return res.status(403).json({ message: 'غير مصرح' });
    }
    res.json({
      tripId: trip.id,
      timeline: journey.listTimeline(store, trip.id),
    });
  });

  app.post('/trips/:tripId/assign-driver', auth, requireSessionUser, (req, res) => {
    const result = journey.assignDriver({
      store,
      tripId: req.params.tripId,
      driverId: req.body?.driverId,
      actorUserId: req.authUserId,
      idFn: id,
    });
    if (!result.ok) {
      return res
        .status(result.status)
        .json({ message: result.message, conflictTripId: result.conflictTripId });
    }
    saveStore();
    emitTrip({
      type: 'trip.driver_assigned',
      tripId: result.trip.id,
      bookingId: result.trip.bookingId,
      customerId: result.trip.customerId,
      providerId: result.trip.providerId,
      driverId: result.driver.id,
      status: result.trip.status,
      at: new Date().toISOString(),
    });
    if (notifyEvent) {
      notifyEvent(result.trip.customerId, 'تعيين سائق', 'تم تعيين سائق لرحلتك', {
        type: 'trip',
        tripId: result.trip.id,
        status: result.trip.status,
      });
    }
    res.json({ trip: result.trip, driver: result.driver });
  });

  app.post('/trips/:tripId/assign-vehicle', auth, requireSessionUser, (req, res) => {
    const result = journey.assignVehicle({
      store,
      tripId: req.params.tripId,
      vehicleId: req.body?.vehicleId,
      actorUserId: req.authUserId,
      idFn: id,
    });
    if (!result.ok) {
      return res
        .status(result.status)
        .json({ message: result.message, conflictTripId: result.conflictTripId });
    }
    saveStore();
    emitTrip({
      type: 'trip.vehicle_assigned',
      tripId: result.trip.id,
      bookingId: result.trip.bookingId,
      customerId: result.trip.customerId,
      providerId: result.trip.providerId,
      vehicleId: result.vehicle.id,
      status: result.trip.status,
      at: new Date().toISOString(),
    });
    res.json({ trip: result.trip, vehicle: result.vehicle });
  });

  app.post('/trips/:tripId/transition', auth, requireSessionUser, (req, res) => {
    journey.ensureStoreMaps(store);
    const trip = store.trips.get(String(req.params.tripId));
    if (!trip) return res.status(404).json({ message: 'الرحلة غير موجودة' });
    const role = roleForTrip(trip, req.authUserId);
    if (!role) return res.status(403).json({ message: 'غير مصرح' });
    if (role === 'customer') {
      return res.status(403).json({ message: 'العميل لا يغيّر حالة الرحلة' });
    }
    const result = journey.transitionTrip({
      store,
      tripId: trip.id,
      toStatus: req.body?.toStatus || req.body?.status,
      actorUserId: req.authUserId,
      actorRole: 'provider',
      note: req.body?.note,
      idFn: id,
      adminOverride: false,
    });
    if (!result.ok) {
      return res.status(result.status).json({
        message: result.message,
        from: result.from,
        to: result.to,
        allowed: result.allowed,
      });
    }
    saveStore();
    emitTrip({
      type: 'trip.status_changed',
      tripId: result.trip.id,
      bookingId: result.trip.bookingId,
      customerId: result.trip.customerId,
      providerId: result.trip.providerId,
      status: result.trip.status,
      at: new Date().toISOString(),
    });
    if (notifyEvent) {
      notifyEvent(
        result.trip.customerId,
        'تحديث الرحلة',
        `الحالة: ${result.trip.status}`,
        { type: 'trip', tripId: result.trip.id, status: result.trip.status },
      );
    }
    res.json({ trip: result.trip, reused: !!result.reused });
  });
}

module.exports = { registerJourneyRoutes };
