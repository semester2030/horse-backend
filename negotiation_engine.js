/**
 * Negotiation Engine (T4 / T4.1) — append-only offers + atomic accept → Booking.
 * ADR-014: TransportRequest → Matching → Negotiation → Accept → Booking.
 * ADR-015: AcceptLockProvider abstraction (InMemory now; Redis/DB later).
 */
'use strict';

const bookingOccupancy = require('./booking_occupancy');
const acceptLock = require('./accept_lock');
const {
  DEFAULT_OFFER_TTL_MS,
  resolveOfferTtlMs,
} = require('./transport_config');
const journey = require('./journey_engine');

const CURRENCY_DEFAULT = 'SAR';

const NEG_STATUS = Object.freeze({
  open: 'open',
  provider_offer: 'provider_offer',
  customer_counter: 'customer_counter',
  provider_counter: 'provider_counter',
  accepted: 'accepted',
  closed: 'closed',
  rejected: 'rejected',
  expired: 'expired',
});

const OFFER_STATUS = Object.freeze({
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  expired: 'expired',
  withdrawn: 'withdrawn',
});

const ACTOR = Object.freeze({
  customer: 'customer',
  provider: 'provider',
  system: 'system',
});

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function ensureStoreMaps(store) {
  if (!store.negotiations) store.negotiations = new Map();
  if (!store.offers) store.offers = new Map();
  if (!store.negotiationEvents) store.negotiationEvents = [];
  if (!store.transportRequests) store.transportRequests = new Map();
  if (!store.bookings) store.bookings = new Map();
}

function appendEvent(store, event) {
  ensureStoreMaps(store);
  store.negotiationEvents.unshift(event);
  if (store.negotiationEvents.length > 5000) {
    store.negotiationEvents.length = 5000;
  }
}

function findNegotiationByRequest(store, requestId) {
  ensureStoreMaps(store);
  for (const n of store.negotiations.values()) {
    if (String(n.requestId) === String(requestId)) return n;
  }
  return null;
}

function listOffersForNegotiation(store, negotiationId) {
  ensureStoreMaps(store);
  return [...store.offers.values()]
    .filter((o) => String(o.negotiationId) === String(negotiationId))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function expireOfferIfNeeded(store, offer, nowMs = Date.now()) {
  if (!offer || offer.status !== OFFER_STATUS.pending) return offer;
  const exp = Date.parse(offer.expiresAt);
  if (Number.isFinite(exp) && exp <= nowMs) {
    const updated = {
      ...offer,
      status: OFFER_STATUS.expired,
      updatedAt: nowIso(nowMs),
    };
    store.offers.set(offer.id, updated);
    appendEvent(store, {
      id: `evt-${offer.id}-exp`,
      type: 'offer.expired',
      negotiationId: offer.negotiationId,
      requestId: offer.requestId,
      offerId: offer.id,
      actor: ACTOR.system,
      at: nowIso(nowMs),
    });
    return updated;
  }
  return offer;
}

function expirePendingInNegotiation(store, negotiationId, nowMs = Date.now()) {
  const offers = listOffersForNegotiation(store, negotiationId);
  return offers.map((o) => expireOfferIfNeeded(store, o, nowMs));
}

function isNegotiationOpen(neg) {
  if (!neg) return false;
  return ![
    NEG_STATUS.accepted,
    NEG_STATUS.closed,
    NEG_STATUS.rejected,
    NEG_STATUS.expired,
  ].includes(neg.status);
}

/**
 * Open or return existing negotiation for a transport request (customer).
 */
function openNegotiation({ store, request, userId, idFn, nowMs = Date.now() }) {
  ensureStoreMaps(store);
  if (!request) {
    return { ok: false, status: 404, message: 'طلب النقل غير موجود' };
  }
  if (String(request.customerId) !== String(userId)) {
    return { ok: false, status: 403, message: 'غير مصرح' };
  }
  if (request.status === 'converted' || request.bookingId) {
    return { ok: false, status: 409, message: 'الطلب محوّل إلى حجز بالفعل' };
  }
  if (request.status === 'cancelled') {
    return { ok: false, status: 409, message: 'الطلب ملغى' };
  }

  const existing = findNegotiationByRequest(store, request.id);
  if (existing) {
    expirePendingInNegotiation(store, existing.id, nowMs);
    return { ok: true, negotiation: existing, created: false };
  }

  const negotiationId = idFn();
  const negotiation = {
    id: negotiationId,
    requestId: request.id,
    customerId: String(request.customerId),
    status: NEG_STATUS.open,
    acceptedOfferId: null,
    bookingId: null,
    version: 1,
    createdAt: nowIso(nowMs),
    updatedAt: nowIso(nowMs),
  };
  store.negotiations.set(negotiationId, negotiation);
  appendEvent(store, {
    id: idFn(),
    type: 'negotiation.opened',
    negotiationId,
    requestId: request.id,
    actor: ACTOR.customer,
    actorId: userId,
    at: nowIso(nowMs),
  });
  return { ok: true, negotiation, created: true };
}

function getNegotiationView(store, negotiationId, nowMs = Date.now()) {
  ensureStoreMaps(store);
  const neg = store.negotiations.get(String(negotiationId));
  if (!neg) return null;
  const offers = expirePendingInNegotiation(store, neg.id, nowMs);
  return { ...neg, offers };
}

function assertParticipant(store, negotiation, userId) {
  if (String(negotiation.customerId) === String(userId)) {
    return { role: ACTOR.customer };
  }
  // Provider participant if they own a transport service OR have an offer on this negotiation
  const offers = listOffersForNegotiation(store, negotiation.id);
  if (offers.some((o) => String(o.providerId) === String(userId))) {
    return { role: ACTOR.provider };
  }
  for (const s of store.services.values()) {
    const t = String(s.type || s.serviceType || '').toLowerCase();
    if (t !== 'transportation' && t !== 'transport') continue;
    if (String(s.providerId) === String(userId)) {
      return { role: ACTOR.provider };
    }
  }
  return null;
}

function validateAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Provider (or customer) creates a new offer — append only.
 */
function createOffer({
  store,
  request,
  negotiation,
  actorUserId,
  actorRole,
  body,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  if (!isNegotiationOpen(negotiation)) {
    return { ok: false, status: 409, message: 'التفاوض مغلق' };
  }
  if (request.status === 'converted' || request.bookingId) {
    return { ok: false, status: 409, message: 'الطلب محوّل بالفعل' };
  }

  const amount = validateAmount(body.amount);
  if (amount == null) {
    return { ok: false, status: 400, message: 'المبلغ مطلوب ويجب أن يكون موجباً' };
  }
  const currency = String(body.currency || CURRENCY_DEFAULT).trim().toUpperCase() || CURRENCY_DEFAULT;
  const note = body.note != null ? String(body.note).trim() : null;
  const ttlMs = resolveOfferTtlMs(process.env, body.ttlMs);

  let providerId;
  let serviceId;
  let offerKind;

  if (actorRole === ACTOR.provider) {
    providerId = String(actorUserId);
    serviceId = String(body.serviceId || '').trim();
    if (!serviceId) {
      return { ok: false, status: 400, message: 'serviceId مطلوب لعرض المقدم' };
    }
    const service = store.services.get(serviceId);
    if (!service) {
      return { ok: false, status: 404, message: 'الخدمة غير موجودة' };
    }
    if (String(service.providerId) !== providerId) {
      return { ok: false, status: 403, message: 'الخدمة لا تخص هذا المقدم' };
    }
    const parentId = body.parentOfferId ? String(body.parentOfferId) : null;
    if (parentId) {
      const parent = expireOfferIfNeeded(store, store.offers.get(parentId), nowMs);
      if (!parent || String(parent.negotiationId) !== String(negotiation.id)) {
        return { ok: false, status: 404, message: 'العرض الأصلي غير موجود' };
      }
      if (parent.status !== OFFER_STATUS.pending) {
        return { ok: false, status: 409, message: 'لا يمكن الرد على عرض غير معلّق' };
      }
      if (String(parent.actor) !== ACTOR.customer) {
        return { ok: false, status: 400, message: 'المقدم يرد فقط على عرض العميل' };
      }
      offerKind = 'provider_counter';
    } else {
      offerKind = 'provider_offer';
    }
  } else if (actorRole === ACTOR.customer) {
    if (String(request.customerId) !== String(actorUserId)) {
      return { ok: false, status: 403, message: 'غير مصرح' };
    }
    const parentId = String(body.parentOfferId || '').trim();
    if (!parentId) {
      return {
        ok: false,
        status: 400,
        message: 'parentOfferId مطلوب لعرض مضاد من العميل',
      };
    }
    const parent = expireOfferIfNeeded(store, store.offers.get(parentId), nowMs);
    if (!parent || String(parent.negotiationId) !== String(negotiation.id)) {
      return { ok: false, status: 404, message: 'العرض الأصلي غير موجود' };
    }
    if (parent.status !== OFFER_STATUS.pending) {
      return { ok: false, status: 409, message: 'لا يمكن الرد على عرض غير معلّق' };
    }
    if (String(parent.actor) !== ACTOR.provider) {
      return { ok: false, status: 400, message: 'العميل يرد فقط على عرض المقدم' };
    }
    providerId = String(parent.providerId);
    serviceId = String(parent.serviceId);
    offerKind = 'customer_counter';
  } else {
    return { ok: false, status: 403, message: 'دور غير مصرح' };
  }

  const offerId = idFn();
  const version =
    listOffersForNegotiation(store, negotiation.id).length + 1;
  const offer = {
    id: offerId,
    negotiationId: negotiation.id,
    requestId: request.id,
    providerId,
    customerId: String(request.customerId),
    serviceId,
    amount,
    currency,
    note,
    actor: actorRole,
    kind: offerKind,
    status: OFFER_STATUS.pending,
    parentOfferId: body.parentOfferId ? String(body.parentOfferId) : null,
    version,
    createdAt: nowIso(nowMs),
    updatedAt: nowIso(nowMs),
    expiresAt: nowIso(nowMs + ttlMs),
  };
  store.offers.set(offerId, offer);

  let nextNegStatus = negotiation.status;
  if (offerKind === 'provider_offer') nextNegStatus = NEG_STATUS.provider_offer;
  if (offerKind === 'customer_counter') nextNegStatus = NEG_STATUS.customer_counter;
  if (offerKind === 'provider_counter') nextNegStatus = NEG_STATUS.provider_counter;

  const updatedNeg = {
    ...negotiation,
    status: nextNegStatus,
    version: Number(negotiation.version || 1) + 1,
    updatedAt: nowIso(nowMs),
  };
  store.negotiations.set(negotiation.id, updatedNeg);

  appendEvent(store, {
    id: idFn(),
    type: 'offer.created',
    negotiationId: negotiation.id,
    requestId: request.id,
    offerId,
    actor: actorRole,
    actorId: actorUserId,
    kind: offerKind,
    amount,
    at: nowIso(nowMs),
  });

  return { ok: true, offer, negotiation: updatedNeg };
}

function rejectOffer({
  store,
  offerId,
  userId,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  let offer = store.offers.get(String(offerId));
  if (!offer) return { ok: false, status: 404, message: 'العرض غير موجود' };
  offer = expireOfferIfNeeded(store, offer, nowMs);
  if (offer.status !== OFFER_STATUS.pending) {
    return { ok: false, status: 409, message: 'العرض غير قابل للرفض' };
  }

  const negotiation = store.negotiations.get(String(offer.negotiationId));
  if (!negotiation || !isNegotiationOpen(negotiation)) {
    return { ok: false, status: 409, message: 'التفاوض مغلق' };
  }

  const isCustomer = String(offer.customerId) === String(userId);
  const isProvider = String(offer.providerId) === String(userId);
  if (!isCustomer && !isProvider) {
    return { ok: false, status: 403, message: 'غير مصرح' };
  }
  // Customer rejects provider offers; provider rejects customer counters
  if (isCustomer && offer.actor !== ACTOR.provider) {
    return { ok: false, status: 400, message: 'يمكن للعميل رفض عروض المقدم فقط' };
  }
  if (isProvider && offer.actor !== ACTOR.customer) {
    return { ok: false, status: 400, message: 'يمكن للمقدم رفض عروض العميل المضادة فقط' };
  }

  const updated = {
    ...offer,
    status: OFFER_STATUS.rejected,
    updatedAt: nowIso(nowMs),
  };
  store.offers.set(offer.id, updated);
  appendEvent(store, {
    id: idFn(),
    type: 'offer.rejected',
    negotiationId: offer.negotiationId,
    requestId: offer.requestId,
    offerId: offer.id,
    actor: isCustomer ? ACTOR.customer : ACTOR.provider,
    actorId: userId,
    at: nowIso(nowMs),
  });
  return { ok: true, offer: updated, negotiation };
}

function withdrawOffer({
  store,
  offerId,
  userId,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  let offer = store.offers.get(String(offerId));
  if (!offer) return { ok: false, status: 404, message: 'العرض غير موجود' };
  offer = expireOfferIfNeeded(store, offer, nowMs);
  if (offer.status !== OFFER_STATUS.pending) {
    return { ok: false, status: 409, message: 'لا يمكن سحب هذا العرض' };
  }
  if (String(offer.providerId) !== String(userId) || offer.actor !== ACTOR.provider) {
    return { ok: false, status: 403, message: 'المقدم يسحب عروضه فقط' };
  }
  const negotiation = store.negotiations.get(String(offer.negotiationId));
  if (!negotiation || !isNegotiationOpen(negotiation)) {
    return { ok: false, status: 409, message: 'التفاوض مغلق' };
  }

  const updated = {
    ...offer,
    status: OFFER_STATUS.withdrawn,
    updatedAt: nowIso(nowMs),
  };
  store.offers.set(offer.id, updated);
  appendEvent(store, {
    id: idFn(),
    type: 'offer.withdrawn',
    negotiationId: offer.negotiationId,
    requestId: offer.requestId,
    offerId: offer.id,
    actor: ACTOR.provider,
    actorId: userId,
    at: nowIso(nowMs),
  });
  return { ok: true, offer: updated, negotiation };
}

/**
 * Atomic accept: lock → validate → booking → convert request → close negotiation.
 * Customer accepts provider offers; provider accepts customer counters.
 */
function acceptOffer({
  store,
  offerId,
  userId,
  idFn,
  idempotencyKey,
  nowMs = Date.now(),
  lockProvider,
}) {
  ensureStoreMaps(store);
  const key = String(offerId);
  /** @type {import('./accept_lock').AcceptLockProvider} */
  const locks = lockProvider || acceptLock.getAcceptLockProvider();
  if (!locks.tryAcquire(key)) {
    return { ok: false, status: 409, message: 'قبول قيد التنفيذ — أعد المحاولة' };
  }

  try {
    let offer = store.offers.get(key);
    if (!offer) {
      return { ok: false, status: 404, message: 'العرض غير موجود' };
    }
    offer = expireOfferIfNeeded(store, offer, nowMs);

    if (offer.status === OFFER_STATUS.accepted && offer.bookingId) {
      const booking = store.bookings.get(String(offer.bookingId));
      const negotiation = store.negotiations.get(String(offer.negotiationId));
      const request = store.transportRequests.get(String(offer.requestId));
      let trip = journey.findTripByBookingId(store, offer.bookingId);
      if (!trip && booking) {
        const tr = journey.createTripFromBooking({
          store,
          booking,
          idFn,
          nowMs,
        });
        trip = tr.ok ? tr.trip : null;
      }
      return {
        ok: true,
        reused: true,
        booking,
        offer,
        negotiation,
        request,
        trip,
      };
    }

    if (idempotencyKey) {
      for (const b of store.bookings.values()) {
        if (
          String(b.acceptIdempotencyKey || '') === String(idempotencyKey) &&
          (String(b.userId) === String(userId) ||
            String(b.providerId) === String(userId))
        ) {
          let trip = journey.findTripByBookingId(store, b.id);
          if (!trip) {
            const tr = journey.createTripFromBooking({
              store,
              booking: b,
              idFn,
              nowMs,
            });
            trip = tr.ok ? tr.trip : null;
          }
          return {
            ok: true,
            reused: true,
            booking: b,
            offer: store.offers.get(String(b.acceptedOfferId)) || offer,
            negotiation: store.negotiations.get(String(b.negotiationId)),
            request: store.transportRequests.get(String(b.transportRequestId)),
            trip,
          };
        }
      }
    }

    if (offer.status !== OFFER_STATUS.pending) {
      return { ok: false, status: 409, message: 'العرض غير قابل للقبول' };
    }

    const request = store.transportRequests.get(String(offer.requestId));
    if (!request) {
      return { ok: false, status: 404, message: 'طلب النقل غير موجود' };
    }
    if (request.status === 'converted' || request.bookingId) {
      return { ok: false, status: 409, message: 'الطلب محوّل بالفعل' };
    }
    if (request.status === 'cancelled') {
      return { ok: false, status: 409, message: 'الطلب ملغى' };
    }

    const isCustomer = String(request.customerId) === String(userId);
    const isProvider = String(offer.providerId) === String(userId);
    if (!isCustomer && !isProvider) {
      return { ok: false, status: 403, message: 'غير مصرح بقبول هذا العرض' };
    }
    if (isCustomer && offer.actor !== ACTOR.provider) {
      return {
        ok: false,
        status: 400,
        message: 'العميل يقبل عروض المقدم فقط',
      };
    }
    if (isProvider && offer.actor !== ACTOR.customer) {
      return {
        ok: false,
        status: 400,
        message: 'المقدم يقبل عروض العميل المضادة فقط',
      };
    }

    const negotiation = store.negotiations.get(String(offer.negotiationId));
    if (!negotiation || !isNegotiationOpen(negotiation)) {
      return { ok: false, status: 409, message: 'التفاوض مغلق' };
    }
    if (negotiation.acceptedOfferId) {
      return { ok: false, status: 409, message: 'تم قبول عرض آخر مسبقاً' };
    }

    const service = store.services.get(String(offer.serviceId));
    if (!service) {
      return { ok: false, status: 404, message: 'خدمة النقل غير موجودة' };
    }
    if (String(service.providerId) !== String(offer.providerId)) {
      return { ok: false, status: 409, message: 'عدم تطابق مقدم الخدمة' };
    }

    const bookingDate =
      request.requestedPickupAt || request.createdAt || nowIso(nowMs);
    const units = Math.max(1, Math.floor(Number(request.animalCount) || 1));
    const fleetCap = bookingOccupancy.fleetCapacity(service);
    if (fleetCap > 0) {
      const cap = bookingOccupancy.evaluateTransportCapacity({
        service,
        bookings: [...store.bookings.values()],
        unitsRequested: units,
        bookingDate,
      });
      if (!cap.ok) {
        return {
          ok: false,
          status: 409,
          message: cap.message || 'سعة النقل غير كافية',
          code: 'TRANSPORT_CAPACITY',
        };
      }
    }

    const bookingId = idFn();
    const snapshot = {
      animalType: request.animalType,
      animalCount: request.animalCount,
      animalDetails: request.animalDetails || null,
      pickup: request.pickup,
      destination: request.destination,
      requestTiming: request.requestTiming,
      requestedPickupAt: request.requestedPickupAt,
      tripType: request.tripType,
      specialRequirements: request.specialRequirements,
      acceptedAmount: offer.amount,
      currency: offer.currency,
    };

    const booking = {
      id: bookingId,
      type: 'transportation',
      serviceType: 'transportation',
      serviceId: String(offer.serviceId),
      providerId: String(offer.providerId),
      userId: String(request.customerId),
      status: 'pending',
      bookingDate,
      totalPrice: offer.amount,
      currency: offer.currency,
      serviceName: service.name || null,
      notes: offer.note || request.specialRequirements || null,
      transportRequestId: request.id,
      negotiationId: negotiation.id,
      acceptedOfferId: offer.id,
      acceptIdempotencyKey: idempotencyKey || null,
      details: {
        ...snapshot,
        origin: request.pickup,
        destination: request.destination,
        species: request.animalType,
        unitsRequested: units,
        numberOfHorses: request.animalType === 'horse' ? units : undefined,
        headCount: request.animalType === 'camel' ? units : undefined,
        birdCount: request.animalType === 'falcon' ? units : undefined,
        paymentMethod: 'cash',
        source: 'negotiation_accept',
      },
      createdAt: nowIso(nowMs),
      updatedAt: nowIso(nowMs),
    };
    store.bookings.set(bookingId, booking);

    const acceptedOffer = {
      ...offer,
      status: OFFER_STATUS.accepted,
      bookingId,
      updatedAt: nowIso(nowMs),
    };
    store.offers.set(offer.id, acceptedOffer);

    for (const o of listOffersForNegotiation(store, negotiation.id)) {
      if (o.id === offer.id) continue;
      const fresh = expireOfferIfNeeded(store, o, nowMs);
      if (fresh.status === OFFER_STATUS.pending) {
        store.offers.set(fresh.id, {
          ...fresh,
          status: OFFER_STATUS.rejected,
          updatedAt: nowIso(nowMs),
          rejectedReason: 'another_offer_accepted',
        });
        appendEvent(store, {
          id: idFn(),
          type: 'offer.rejected',
          negotiationId: negotiation.id,
          requestId: request.id,
          offerId: fresh.id,
          actor: ACTOR.system,
          reason: 'another_offer_accepted',
          at: nowIso(nowMs),
        });
      }
    }

    const closedNeg = {
      ...negotiation,
      status: NEG_STATUS.accepted,
      acceptedOfferId: offer.id,
      bookingId,
      version: Number(negotiation.version || 1) + 1,
      updatedAt: nowIso(nowMs),
      closedAt: nowIso(nowMs),
    };
    store.negotiations.set(negotiation.id, closedNeg);

    const convertedRequest = {
      ...request,
      status: 'converted',
      bookingId,
      negotiationId: negotiation.id,
      acceptedOfferId: offer.id,
      updatedAt: nowIso(nowMs),
      convertedAt: nowIso(nowMs),
    };
    store.transportRequests.set(request.id, convertedRequest);

    const accepterRole = isCustomer ? ACTOR.customer : ACTOR.provider;
    appendEvent(store, {
      id: idFn(),
      type: 'offer.accepted',
      negotiationId: negotiation.id,
      requestId: request.id,
      offerId: offer.id,
      bookingId,
      actor: accepterRole,
      actorId: userId,
      at: nowIso(nowMs),
    });
    appendEvent(store, {
      id: idFn(),
      type: 'booking.created',
      negotiationId: negotiation.id,
      requestId: request.id,
      offerId: offer.id,
      bookingId,
      actor: ACTOR.system,
      at: nowIso(nowMs),
    });

    // T5A: exactly one Trip per accepted Booking (idempotent).
    const tripResult = journey.createTripFromBooking({
      store,
      booking: store.bookings.get(bookingId) || booking,
      idFn,
      nowMs,
    });
    const trip = tripResult.ok ? tripResult.trip : null;
    const bookingFinal = store.bookings.get(bookingId) || booking;

    return {
      ok: true,
      reused: false,
      booking: bookingFinal,
      offer: acceptedOffer,
      negotiation: closedNeg,
      request: convertedRequest,
      trip,
    };
  } finally {
    locks.release(key);
  }
}

function cancelRequestDuringNegotiation({
  store,
  request,
  userId,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  if (String(request.customerId) !== String(userId)) {
    return { ok: false, status: 403, message: 'غير مصرح' };
  }
  if (request.status === 'converted' || request.bookingId) {
    return { ok: false, status: 409, message: 'لا يمكن إلغاء طلب محوّل' };
  }
  if (request.status === 'cancelled') {
    return { ok: true, request, reused: true };
  }

  const negotiation = findNegotiationByRequest(store, request.id);
  if (negotiation && isNegotiationOpen(negotiation)) {
    expirePendingInNegotiation(store, negotiation.id, nowMs);
    for (const o of listOffersForNegotiation(store, negotiation.id)) {
      if (o.status === OFFER_STATUS.pending) {
        store.offers.set(o.id, {
          ...o,
          status: OFFER_STATUS.rejected,
          updatedAt: nowIso(nowMs),
          rejectedReason: 'request_cancelled',
        });
      }
    }
    store.negotiations.set(negotiation.id, {
      ...negotiation,
      status: NEG_STATUS.closed,
      updatedAt: nowIso(nowMs),
      closedAt: nowIso(nowMs),
      closeReason: 'request_cancelled',
    });
    appendEvent(store, {
      id: idFn(),
      type: 'negotiation.closed',
      negotiationId: negotiation.id,
      requestId: request.id,
      actor: ACTOR.customer,
      actorId: userId,
      reason: 'request_cancelled',
      at: nowIso(nowMs),
    });
  }

  const updated = {
    ...request,
    status: 'cancelled',
    updatedAt: nowIso(nowMs),
    cancelledAt: nowIso(nowMs),
  };
  store.transportRequests.set(request.id, updated);
  appendEvent(store, {
    id: idFn(),
    type: 'request.cancelled',
    requestId: request.id,
    negotiationId: negotiation?.id || null,
    actor: ACTOR.customer,
    actorId: userId,
    at: nowIso(nowMs),
  });
  return { ok: true, request: updated, negotiation };
}

module.exports = {
  NEG_STATUS,
  OFFER_STATUS,
  ACTOR,
  DEFAULT_OFFER_TTL_MS,
  resolveOfferTtlMs,
  ensureStoreMaps,
  findNegotiationByRequest,
  listOffersForNegotiation,
  openNegotiation,
  getNegotiationView,
  assertParticipant,
  createOffer,
  rejectOffer,
  withdrawOffer,
  acceptOffer,
  cancelRequestDuringNegotiation,
  expireOfferIfNeeded,
  expirePendingInNegotiation,
  isNegotiationOpen,
};
