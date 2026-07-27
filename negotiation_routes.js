/**
 * HTTP routes for T4 negotiation / offers / atomic accept.
 */
'use strict';

const negotiation = require('./negotiation_engine');

function registerNegotiationRoutes(app, ctx) {
  const { store, saveStore, id, auth, requireSessionUser, wsHub, notifyEvent } =
    ctx;

  function emitLive(event) {
    if (wsHub && typeof wsHub.publishNegotiation === 'function') {
      wsHub.publishNegotiation(event);
    }
  }

  function loadOwnedRequest(req, res) {
    negotiation.ensureStoreMaps(store);
    const request = store.transportRequests.get(String(req.params.requestId));
    if (!request) {
      res.status(404).json({ message: 'طلب النقل غير موجود' });
      return null;
    }
    return request;
  }

  // Open / get negotiation for a transport request
  app.post(
    '/transport-requests/:requestId/negotiation',
    auth,
    requireSessionUser,
    (req, res) => {
      const request = loadOwnedRequest(req, res);
      if (!request) return;
      const result = negotiation.openNegotiation({
        store,
        request,
        userId: req.authUserId,
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      if (result.created) saveStore();
      const view = negotiation.getNegotiationView(store, result.negotiation.id);
      emitLive({
        type: 'negotiation.opened',
        requestId: request.id,
        customerId: request.customerId,
        negotiationId: result.negotiation.id,
        at: new Date().toISOString(),
      });
      res.status(result.created ? 201 : 200).json(view);
    },
  );

  app.get(
    '/transport-requests/:requestId/negotiation',
    auth,
    requireSessionUser,
    (req, res) => {
      const request = loadOwnedRequest(req, res);
      if (!request) return;
      const participantOk =
        String(request.customerId) === String(req.authUserId) ||
        negotiation.assertParticipant(
          store,
          { customerId: request.customerId, id: 'tmp' },
          req.authUserId,
        );
      // Providers may view if they are transport providers; customers if owners
      if (String(request.customerId) !== String(req.authUserId)) {
        const role = negotiation.assertParticipant(
          store,
          negotiation.findNegotiationByRequest(store, request.id) || {
            customerId: request.customerId,
            id: 'x',
          },
          req.authUserId,
        );
        if (!role) {
          return res.status(403).json({ message: 'غير مصرح' });
        }
      }
      let neg = negotiation.findNegotiationByRequest(store, request.id);
      if (!neg) {
        return res.status(404).json({ message: 'لا يوجد تفاوض لهذا الطلب' });
      }
      res.json(negotiation.getNegotiationView(store, neg.id));
    },
  );

  app.get(
    '/transport-requests/:requestId/offers',
    auth,
    requireSessionUser,
    (req, res) => {
      const request = loadOwnedRequest(req, res);
      if (!request) return;
      const neg = negotiation.findNegotiationByRequest(store, request.id);
      if (!neg) return res.json({ requestId: request.id, offers: [] });
      const role = negotiation.assertParticipant(store, neg, req.authUserId);
      if (!role && String(request.customerId) !== String(req.authUserId)) {
        return res.status(403).json({ message: 'غير مصرح' });
      }
      let offers = negotiation.listOffersForNegotiation(store, neg.id);
      offers = offers.map((o) =>
        negotiation.expireOfferIfNeeded(store, o),
      );
      // Provider only sees own offers + customer counters directed at them
      if (role?.role === 'provider') {
        offers = offers.filter(
          (o) => String(o.providerId) === String(req.authUserId),
        );
      }
      res.json({
        requestId: request.id,
        negotiationId: neg.id,
        offers,
      });
    },
  );

  // Create offer / counter
  app.post(
    '/transport-requests/:requestId/offers',
    auth,
    requireSessionUser,
    (req, res) => {
      const request = loadOwnedRequest(req, res);
      if (!request) return;
      let neg = negotiation.findNegotiationByRequest(store, request.id);
      if (!neg) {
        const opened = negotiation.openNegotiation({
          store,
          request,
          userId: request.customerId,
          idFn: id,
        });
        if (!opened.ok) {
          return res.status(opened.status).json({ message: opened.message });
        }
        neg = opened.negotiation;
      }
      const roleInfo = negotiation.assertParticipant(
        store,
        neg,
        req.authUserId,
      );
      if (!roleInfo) {
        return res.status(403).json({ message: 'غير مصرح بالتفاوض' });
      }
      const result = negotiation.createOffer({
        store,
        request,
        negotiation: neg,
        actorUserId: req.authUserId,
        actorRole: roleInfo.role,
        body: req.body || {},
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      saveStore();
      const live = {
        type: 'offer.created',
        requestId: request.id,
        customerId: request.customerId,
        providerId: result.offer.providerId,
        negotiationId: neg.id,
        offerId: result.offer.id,
        offer: result.offer,
        at: new Date().toISOString(),
      };
      emitLive(live);
      if (notifyEvent) {
        const target =
          roleInfo.role === 'provider'
            ? request.customerId
            : result.offer.providerId;
        notifyEvent(target, 'عرض تفاوض جديد', `مبلغ ${result.offer.amount}`, {
          type: 'negotiation_offer',
          requestId: request.id,
          offerId: result.offer.id,
        });
      }
      res.status(201).json({
        offer: result.offer,
        negotiation: result.negotiation,
      });
    },
  );

  app.post('/offers/:offerId/counter', auth, requireSessionUser, (req, res) => {
    negotiation.ensureStoreMaps(store);
    const parent = store.offers.get(String(req.params.offerId));
    if (!parent) return res.status(404).json({ message: 'العرض غير موجود' });
    const request = store.transportRequests.get(String(parent.requestId));
    if (!request) return res.status(404).json({ message: 'الطلب غير موجود' });
    let neg = store.negotiations.get(String(parent.negotiationId));
    if (!neg) return res.status(404).json({ message: 'التفاوض غير موجود' });
    const roleInfo = negotiation.assertParticipant(
      store,
      neg,
      req.authUserId,
    );
    if (!roleInfo) return res.status(403).json({ message: 'غير مصرح' });
    const body = {
      ...(req.body || {}),
      parentOfferId: parent.id,
      serviceId: req.body?.serviceId || parent.serviceId,
    };
    const result = negotiation.createOffer({
      store,
      request,
      negotiation: neg,
      actorUserId: req.authUserId,
      actorRole: roleInfo.role,
      body,
      idFn: id,
    });
    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }
    saveStore();
    emitLive({
      type: 'offer.counter',
      requestId: request.id,
      customerId: request.customerId,
      providerId: result.offer.providerId,
      negotiationId: neg.id,
      offerId: result.offer.id,
      offer: result.offer,
      parentOfferId: parent.id,
      at: new Date().toISOString(),
    });
    res.status(201).json({
      offer: result.offer,
      negotiation: result.negotiation,
    });
  });

  app.post('/offers/:offerId/accept', auth, requireSessionUser, (req, res) => {
    const idem =
      req.headers['idempotency-key'] ||
      req.body?.idempotencyKey ||
      null;
    const result = negotiation.acceptOffer({
      store,
      offerId: req.params.offerId,
      userId: req.authUserId,
      idFn: id,
      idempotencyKey: idem ? String(idem) : null,
    });
    if (!result.ok) {
      return res
        .status(result.status)
        .json({ message: result.message, code: result.code });
    }
    if (!result.reused) saveStore();
    emitLive({
      type: 'offer.accepted',
      requestId: result.request?.id,
      customerId: result.request?.customerId,
      providerId: result.offer?.providerId,
      negotiationId: result.negotiation?.id,
      offerId: result.offer?.id,
      bookingId: result.booking?.id,
      booking: result.booking,
      at: new Date().toISOString(),
    });
    emitLive({
      type: 'booking.created',
      requestId: result.request?.id,
      customerId: result.request?.customerId,
      providerId: result.offer?.providerId,
      bookingId: result.booking?.id,
      booking: result.booking,
      at: new Date().toISOString(),
    });
    if (result.trip) {
      emitLive({
        type: 'trip.created',
        requestId: result.request?.id,
        customerId: result.request?.customerId,
        providerId: result.offer?.providerId,
        bookingId: result.booking?.id,
        tripId: result.trip.id,
        trip: result.trip,
        at: new Date().toISOString(),
      });
    }
    if (notifyEvent && result.booking) {
      notifyEvent(
        result.booking.providerId,
        'تم قبول العرض',
        'تم إنشاء حجز نقل من التفاوض',
        {
          type: 'booking',
          bookingId: result.booking.id,
          status: 'pending',
        },
      );
    }
    res.status(result.reused ? 200 : 201).json({
      booking: result.booking,
      offer: result.offer,
      negotiation: result.negotiation,
      request: result.request,
      trip: result.trip || null,
      reused: result.reused,
    });
  });

  app.post('/offers/:offerId/reject', auth, requireSessionUser, (req, res) => {
    const result = negotiation.rejectOffer({
      store,
      offerId: req.params.offerId,
      userId: req.authUserId,
      idFn: id,
    });
    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }
    saveStore();
    emitLive({
      type: 'offer.rejected',
      requestId: result.offer.requestId,
      customerId: result.offer.customerId,
      providerId: result.offer.providerId,
      negotiationId: result.offer.negotiationId,
      offerId: result.offer.id,
      offer: result.offer,
      at: new Date().toISOString(),
    });
    res.json({ offer: result.offer });
  });

  app.post('/offers/:offerId/withdraw', auth, requireSessionUser, (req, res) => {
    const result = negotiation.withdrawOffer({
      store,
      offerId: req.params.offerId,
      userId: req.authUserId,
      idFn: id,
    });
    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }
    saveStore();
    emitLive({
      type: 'offer.withdrawn',
      requestId: result.offer.requestId,
      customerId: result.offer.customerId,
      providerId: result.offer.providerId,
      negotiationId: result.offer.negotiationId,
      offerId: result.offer.id,
      offer: result.offer,
      at: new Date().toISOString(),
    });
    res.json({ offer: result.offer });
  });

  app.post(
    '/transport-requests/:requestId/cancel',
    auth,
    requireSessionUser,
    (req, res) => {
      const request = loadOwnedRequest(req, res);
      if (!request) return;
      const result = negotiation.cancelRequestDuringNegotiation({
        store,
        request,
        userId: req.authUserId,
        idFn: id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      saveStore();
      emitLive({
        type: 'request.cancelled',
        requestId: result.request.id,
        customerId: result.request.customerId,
        at: new Date().toISOString(),
      });
      res.json({ request: result.request });
    },
  );
}

module.exports = { registerNegotiationRoutes };
