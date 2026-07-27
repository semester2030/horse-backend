/**
 * HTTP routes for T5B Tracking / ETA.
 */
'use strict';

const tracking = require('./tracking_engine');
const journey = require('./journey_engine');

function registerTrackingRoutes(app, ctx) {
  const { store, saveStore, id, auth, requireSessionUser, wsHub } = ctx;

  function emitLive(event) {
    if (!wsHub || typeof wsHub.publishNegotiation !== 'function') return;
    const trip = store.trips?.get(String(event.tripId));
    const enriched = {
      ...event,
      // seq stream keyed by trip for replay (ws_hub uses requestId)
      requestId: event.requestId || `trip:${event.tripId}`,
      customerId: event.customerId || trip?.customerId,
      providerId: event.providerId || trip?.providerId,
    };
    wsHub.publishNegotiation(enriched);
  }

  function loadTripSession(req, res) {
    journey.ensureStoreMaps(store);
    tracking.ensureStoreMaps(store);
    const trip = store.trips.get(String(req.params.tripId));
    if (!trip) {
      res.status(404).json({ message: 'الرحلة غير موجودة' });
      return null;
    }
    return trip;
  }

  function requireParty(trip, userId, res) {
    const role = tracking.assertCanRead(
      {
        customerId: trip.customerId,
        providerId: trip.providerId,
      },
      userId,
    );
    if (!role) {
      res.status(403).json({ message: 'غير مصرح' });
      return null;
    }
    return role;
  }

  // Start tracking
  app.post(
    '/trips/:tripId/tracking/start',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTripSession(req, res);
      if (!trip) return;
      if (String(trip.providerId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'المقدم فقط يبدأ التتبع' });
      }
      const result = tracking.startTracking({
        store,
        trip,
        actorUserId: req.authUserId,
        actorRole: 'provider',
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      saveStore();
      emitLive({
        type: 'tracking.started',
        tripId: trip.id,
        sessionId: result.session.id,
        customerId: trip.customerId,
        providerId: trip.providerId,
        trackingStatus: result.session.status,
        at: new Date().toISOString(),
      });
      res.status(result.reused ? 200 : 201).json({
        session: result.session,
        reused: !!result.reused,
        view: tracking.getTrackingView(store, result.session.id),
      });
    },
  );

  function lifecycle(path, toStatus) {
    app.post(path, auth, requireSessionUser, (req, res) => {
      const trip = loadTripSession(req, res);
      if (!trip) return;
      if (String(trip.providerId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'غير مصرح' });
      }
      const session =
        tracking.findSessionByTripId(store, trip.id) ||
        store.trackingSessions.get(String(trip.trackingSessionId));
      if (!session) {
        return res.status(404).json({ message: 'لا توجد جلسة تتبع' });
      }
      const result = tracking.transitionTracking({
        store,
        sessionId: session.id,
        toStatus,
        actorUserId: req.authUserId,
        actorRole: 'provider',
        idFn: id,
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
      emitLive({
        type: `tracking.${toStatus}`,
        tripId: trip.id,
        sessionId: result.session.id,
        customerId: trip.customerId,
        providerId: trip.providerId,
        trackingStatus: result.session.status,
        at: new Date().toISOString(),
      });
      res.json({ session: result.session });
    });
  }

  lifecycle('/trips/:tripId/tracking/pause', 'paused');
  lifecycle('/trips/:tripId/tracking/resume', 'resumed');
  lifecycle('/trips/:tripId/tracking/stop', 'stopped');
  lifecycle('/trips/:tripId/tracking/complete', 'completed');

  // Push location (provider / driver publisher)
  app.post(
    '/trips/:tripId/tracking/location',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTripSession(req, res);
      if (!trip) return;
      const session = tracking.findSessionByTripId(store, trip.id);
      if (!session) {
        return res.status(404).json({ message: 'لا توجد جلسة تتبع' });
      }
      const pub = tracking.assertCanPublish(session, req.authUserId, store);
      if (!pub) {
        return res.status(403).json({ message: 'غير مصرح بنشر الموقع' });
      }
      const result = tracking.pushLocation({
        store,
        sessionId: session.id,
        body: req.body || {},
        actorUserId: req.authUserId,
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({
          message: result.message,
          code: result.code,
        });
      }
      if (result.shouldPersist) saveStore();
      if (result.liveEvent) emitLive(result.liveEvent);
      res.json({
        session: result.session,
        sample: result.sample,
        metrics: result.metrics,
      });
    },
  );

  // Current position + ETA
  app.get(
    '/trips/:tripId/tracking',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTripSession(req, res);
      if (!trip) return;
      if (!requireParty(trip, req.authUserId, res)) return;
      const session = tracking.findSessionByTripId(store, trip.id);
      if (!session) {
        return res.status(404).json({ message: 'لا توجد جلسة تتبع' });
      }
      res.json(tracking.getTrackingView(store, session.id));
    },
  );

  app.get(
    '/trips/:tripId/tracking/position',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTripSession(req, res);
      if (!trip) return;
      if (!requireParty(trip, req.authUserId, res)) return;
      const session = tracking.findSessionByTripId(store, trip.id);
      if (!session) {
        return res.status(404).json({ message: 'لا توجد جلسة تتبع' });
      }
      const metrics = tracking.computeRouteMetrics(session);
      res.json({
        position: session.currentPosition,
        trackingStatus: session.status,
        metrics,
      });
    },
  );

  app.get(
    '/trips/:tripId/tracking/history',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTripSession(req, res);
      if (!trip) return;
      if (!requireParty(trip, req.authUserId, res)) return;
      const session = tracking.findSessionByTripId(store, trip.id);
      if (!session) {
        return res.status(404).json({ message: 'لا توجد جلسة تتبع' });
      }
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      res.json({
        sessionId: session.id,
        tripId: trip.id,
        history: tracking.listHistory(store, session.id, { limit }),
      });
    },
  );

  app.get(
    '/trips/:tripId/tracking/eta',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTripSession(req, res);
      if (!trip) return;
      if (!requireParty(trip, req.authUserId, res)) return;
      const session = tracking.findSessionByTripId(store, trip.id);
      if (!session) {
        return res.status(404).json({ message: 'لا توجد جلسة تتبع' });
      }
      const metrics = tracking.computeRouteMetrics(session);
      res.json({
        tripId: trip.id,
        sessionId: session.id,
        etaSeconds: metrics.etaSeconds,
        etaAt: metrics.etaAt,
        method: metrics.etaMethod,
        distanceRemainingM: metrics.distanceRemainingM,
        distanceTravelledM: metrics.distanceTravelledM,
        plannedDistanceM: metrics.plannedDistanceM,
        progressPct: metrics.progressPct,
      });
    },
  );
}

module.exports = { registerTrackingRoutes };
