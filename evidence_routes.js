/**
 * HTTP routes for T5C Evidence / POD / OTP.
 */
'use strict';

const evidence = require('./evidence_engine');
const journey = require('./journey_engine');

function registerEvidenceRoutes(app, ctx) {
  const { store, saveStore, id, auth, requireSessionUser, wsHub, notifyEvent } =
    ctx;

  function emitLive(event) {
    if (!wsHub || typeof wsHub.publishNegotiation !== 'function') return;
    wsHub.publishNegotiation({
      ...event,
      requestId: event.requestId || `trip:${event.tripId}`,
    });
  }

  function loadTrip(req, res) {
    journey.ensureStoreMaps(store);
    evidence.ensureStoreMaps(store);
    const trip = store.trips.get(String(req.params.tripId));
    if (!trip) {
      res.status(404).json({ message: 'الرحلة غير موجودة' });
      return null;
    }
    return trip;
  }

  function ensureEvidence(trip, idFn) {
    let rec = evidence.findEvidenceByTripId(store, trip.id);
    if (!rec) {
      const created = evidence.createEvidenceForTrip({
        store,
        trip,
        idFn,
      });
      if (!created.ok) return created;
      rec = created.evidence;
    }
    return { ok: true, evidence: rec };
  }

  // Get or create evidence for trip
  app.get('/trips/:tripId/evidence', auth, requireSessionUser, (req, res) => {
    const trip = loadTrip(req, res);
    if (!trip) return;
    const role = evidence.assertEvidenceRole(
      {
        customerId: trip.customerId,
        providerId: trip.providerId,
      },
      req.authUserId,
    );
    if (!role) return res.status(403).json({ message: 'غير مصرح' });

    const ensured = ensureEvidence(trip, id);
    if (!ensured.ok) {
      return res.status(ensured.status).json({ message: ensured.message });
    }
    saveStore();
    const view = evidence.getEvidenceView(store, ensured.evidence.id);
    res.json({ ...view, viewerRole: role });
  });

  app.get(
    '/trips/:tripId/evidence/timeline',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTrip(req, res);
      if (!trip) return;
      const role = evidence.assertEvidenceRole(
        { customerId: trip.customerId, providerId: trip.providerId },
        req.authUserId,
      );
      if (!role) return res.status(403).json({ message: 'غير مصرح' });
      const rec = evidence.findEvidenceByTripId(store, trip.id);
      if (!rec) return res.status(404).json({ message: 'لا توجد أدلة' });
      res.json({
        evidenceId: rec.id,
        timeline: evidence.listTimeline(store, rec.id),
      });
    },
  );

  // Generate OTP (provider)
  app.post(
    '/trips/:tripId/evidence/otp/generate',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTrip(req, res);
      if (!trip) return;
      if (String(trip.providerId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'المقدم فقط يولّد OTP' });
      }
      const ensured = ensureEvidence(trip, id);
      if (!ensured.ok) {
        return res.status(ensured.status).json({ message: ensured.message });
      }
      const result = evidence.generateOtp({
        store,
        evidenceId: ensured.evidence.id,
        kind: req.body?.kind || 'pickup',
        actorUserId: req.authUserId,
        actorRole: 'provider',
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      saveStore();
      emitLive({
        type: 'evidence.otp_generated',
        tripId: trip.id,
        customerId: trip.customerId,
        providerId: trip.providerId,
        kind: result.otp.kind,
        at: new Date().toISOString(),
      });
      if (notifyEvent) {
        notifyEvent(
          trip.customerId,
          'رمز التحقق',
          `رمز ${result.otp.kind}: ${result.otp.code}`,
          {
            type: 'evidence_otp',
            tripId: trip.id,
            kind: result.otp.kind,
          },
        );
      }
      res.status(201).json({
        evidence: evidence.sanitizeEvidenceForViewer(result.evidence),
        otp: result.otp,
      });
    },
  );

  // Verify OTP (customer — or provider for ops)
  app.post(
    '/trips/:tripId/evidence/otp/verify',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTrip(req, res);
      if (!trip) return;
      const role = evidence.assertEvidenceRole(
        { customerId: trip.customerId, providerId: trip.providerId },
        req.authUserId,
      );
      if (!role) return res.status(403).json({ message: 'غير مصرح' });
      // Customer confirms OTP; provider may also verify if acting as receiver
      const rec = evidence.findEvidenceByTripId(store, trip.id);
      if (!rec) return res.status(404).json({ message: 'لا توجد أدلة' });

      const result = evidence.verifyOtp({
        store,
        evidenceId: rec.id,
        kind: req.body?.kind || 'pickup',
        code: req.body?.code || req.body?.otp,
        actorUserId: req.authUserId,
        actorRole: role,
        idFn: id,
        note: req.body?.note,
      });
      if (!result.ok) {
        if (result.attemptsRemaining != null) saveStore();
        return res.status(result.status).json({
          message: result.message,
          code: result.code,
          attemptsRemaining: result.attemptsRemaining,
        });
      }
      saveStore();
      emitLive({
        type: 'evidence.verified',
        tripId: trip.id,
        customerId: trip.customerId,
        providerId: trip.providerId,
        status: result.evidence.status,
        kind: req.body?.kind || 'pickup',
        at: new Date().toISOString(),
      });
      res.json({
        evidence: evidence.sanitizeEvidenceForViewer(result.evidence),
        reused: !!result.reused,
      });
    },
  );

  // Add photo (provider) — metadata/ref only
  app.post(
    '/trips/:tripId/evidence/photos',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTrip(req, res);
      if (!trip) return;
      if (String(trip.providerId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'المقدم فقط يرفع الصور' });
      }
      const ensured = ensureEvidence(trip, id);
      if (!ensured.ok) {
        return res.status(ensured.status).json({ message: ensured.message });
      }
      const result = evidence.addPhoto({
        store,
        evidenceId: ensured.evidence.id,
        kind: req.body?.kind || 'delivery',
        storageRef: req.body?.storageRef || req.body?.url,
        mimeType: req.body?.mimeType,
        caption: req.body?.caption,
        actorUserId: req.authUserId,
        actorRole: 'provider',
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      saveStore();
      emitLive({
        type: 'evidence.photo_added',
        tripId: trip.id,
        customerId: trip.customerId,
        providerId: trip.providerId,
        photoId: result.photo.id,
        at: new Date().toISOString(),
      });
      res.status(201).json({
        photo: result.photo,
        evidence: evidence.sanitizeEvidenceForViewer(result.evidence),
      });
    },
  );

  app.post(
    '/trips/:tripId/evidence/attachments',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTrip(req, res);
      if (!trip) return;
      if (String(trip.providerId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'المقدم فقط يضيف المرفقات' });
      }
      const ensured = ensureEvidence(trip, id);
      if (!ensured.ok) {
        return res.status(ensured.status).json({ message: ensured.message });
      }
      const result = evidence.addAttachment({
        store,
        evidenceId: ensured.evidence.id,
        storageRef: req.body?.storageRef || req.body?.url,
        mimeType: req.body?.mimeType,
        fileName: req.body?.fileName,
        actorUserId: req.authUserId,
        actorRole: 'provider',
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      saveStore();
      res.status(201).json({
        attachment: result.attachment,
        evidence: evidence.sanitizeEvidenceForViewer(result.evidence),
      });
    },
  );

  app.post(
    '/trips/:tripId/evidence/signature',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTrip(req, res);
      if (!trip) return;
      if (String(trip.providerId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'المقدم فقط يلتقط التوقيع' });
      }
      const ensured = ensureEvidence(trip, id);
      if (!ensured.ok) {
        return res.status(ensured.status).json({ message: ensured.message });
      }
      const result = evidence.captureSignature({
        store,
        evidenceId: ensured.evidence.id,
        kind: req.body?.kind || 'delivery',
        storageRef: req.body?.storageRef || req.body?.url,
        actorUserId: req.authUserId,
        actorRole: 'provider',
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      saveStore();
      emitLive({
        type: 'evidence.signature_captured',
        tripId: trip.id,
        customerId: trip.customerId,
        providerId: trip.providerId,
        kind: req.body?.kind || 'delivery',
        at: new Date().toISOString(),
      });
      res.json({
        evidence: evidence.sanitizeEvidenceForViewer(result.evidence),
      });
    },
  );

  app.post(
    '/trips/:tripId/evidence/complete',
    auth,
    requireSessionUser,
    (req, res) => {
      const trip = loadTrip(req, res);
      if (!trip) return;
      if (String(trip.providerId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'المقدم فقط يكمل الأدلة' });
      }
      const rec = evidence.findEvidenceByTripId(store, trip.id);
      if (!rec) return res.status(404).json({ message: 'لا توجد أدلة' });
      const result = evidence.completeEvidence({
        store,
        evidenceId: rec.id,
        actorUserId: req.authUserId,
        actorRole: 'provider',
        idFn: id,
        note: req.body?.note,
      });
      if (!result.ok) {
        return res.status(result.status).json({
          message: result.message,
          from: result.from,
          allowed: result.allowed,
        });
      }
      saveStore();
      emitLive({
        type: 'evidence.completed',
        tripId: trip.id,
        customerId: trip.customerId,
        providerId: trip.providerId,
        status: result.evidence.status,
        at: new Date().toISOString(),
      });
      res.json({
        evidence: evidence.sanitizeEvidenceForViewer(result.evidence),
        reused: !!result.reused,
      });
    },
  );
}

module.exports = { registerEvidenceRoutes };
