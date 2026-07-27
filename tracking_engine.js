/**
 * Tracking Engine (T5B) — GPS / ETA / route progress attached to Trip.
 * Tracking belongs only to Trip (never Booking).
 * Default ETA: haversine distance + speed (pluggable provider).
 * No POD / OTP / Photos / Payments.
 */
'use strict';

const TRACKING_STATUS = Object.freeze({
  inactive: 'inactive',
  started: 'started',
  tracking: 'tracking',
  paused: 'paused',
  resumed: 'resumed',
  stopped: 'stopped',
  completed: 'completed',
});

const TRACKING_TRANSITIONS = Object.freeze({
  [TRACKING_STATUS.inactive]: [TRACKING_STATUS.started],
  [TRACKING_STATUS.started]: [TRACKING_STATUS.tracking, TRACKING_STATUS.stopped],
  [TRACKING_STATUS.tracking]: [
    TRACKING_STATUS.paused,
    TRACKING_STATUS.stopped,
    TRACKING_STATUS.completed,
  ],
  [TRACKING_STATUS.paused]: [TRACKING_STATUS.resumed, TRACKING_STATUS.stopped],
  [TRACKING_STATUS.resumed]: [
    TRACKING_STATUS.tracking,
    TRACKING_STATUS.paused,
    TRACKING_STATUS.stopped,
    TRACKING_STATUS.completed,
  ],
  [TRACKING_STATUS.stopped]: [TRACKING_STATUS.completed],
  [TRACKING_STATUS.completed]: [],
});

const EVENT_TYPE = Object.freeze({
  TrackingStarted: 'TrackingStarted',
  TrackingPaused: 'TrackingPaused',
  TrackingResumed: 'TrackingResumed',
  TrackingStopped: 'TrackingStopped',
  TrackingCompleted: 'TrackingCompleted',
  LocationUpdated: 'LocationUpdated',
});

/** Active trip statuses that may have live tracking. */
const TRACKABLE_TRIP = new Set([
  'driver_en_route',
  'arrived_at_pickup',
  'loading_started',
  'loading_completed',
  'in_transit',
  'arrived_at_destination',
  'unloading_started',
  'unloading_completed',
]);

const EARTH_RADIUS_M = 6371000;
const MAX_HISTORY = 2000;
const MAX_ACCURACY_M = 500;
const MAX_SPEED_MPS = 55; // ~198 km/h hard ceiling for validation
const MAX_JUMP_MPS = 70;
const STALE_MS = 5 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 30 * 1000;
const DEFAULT_AVG_SPEED_MPS = 12; // ~43 km/h city/highway blend
const PERSIST_EVERY_N = 10;

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function ensureStoreMaps(store) {
  if (!store.trackingSessions) store.trackingSessions = new Map();
  if (!store.trackingHistory) store.trackingHistory = [];
  if (!store.trackingEvents) store.trackingEvents = [];
  if (!store.trips) store.trips = new Map();
}

function appendEvent(store, event) {
  ensureStoreMaps(store);
  const seq = (store._trackingEventSeq || 0) + 1;
  store._trackingEventSeq = seq;
  store.trackingEvents.unshift({ ...event, seq });
  if (store.trackingEvents.length > 8000) {
    store.trackingEvents.length = 8000;
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Pluggable ETA provider — swap via setEtaProvider without changing routes.
 * @typedef {{ estimate: (ctx: object) => { etaSeconds: number, etaAt: string, method: string, distanceRemainingM: number } }} EtaProvider
 */
let etaProvider = null;

function defaultEtaProvider() {
  return {
    name: 'haversine_speed_v1',
    estimate({ current, destination, speedMps, distanceTravelledM, plannedDistanceM }) {
      if (!current || !destination) {
        return {
          etaSeconds: null,
          etaAt: null,
          method: 'haversine_speed_v1',
          distanceRemainingM: null,
        };
      }
      const remaining = haversineMeters(
        current.latitude,
        current.longitude,
        destination.latitude,
        destination.longitude,
      );
      const speed =
        Number.isFinite(speedMps) && speedMps > 1
          ? speedMps
          : DEFAULT_AVG_SPEED_MPS;
      const etaSeconds = Math.max(0, Math.round(remaining / speed));
      const etaAt = nowIso(Date.now() + etaSeconds * 1000);
      const planned =
        Number.isFinite(plannedDistanceM) && plannedDistanceM > 0
          ? plannedDistanceM
          : (distanceTravelledM || 0) + remaining;
      const progressPct =
        planned > 0
          ? Math.min(100, Math.round(((distanceTravelledM || 0) / planned) * 100))
          : 0;
      return {
        etaSeconds,
        etaAt,
        method: 'haversine_speed_v1',
        distanceRemainingM: Math.round(remaining),
        distanceTravelledM: Math.round(distanceTravelledM || 0),
        plannedDistanceM: Math.round(planned),
        progressPct,
      };
    },
  };
}

function getEtaProvider() {
  return etaProvider || defaultEtaProvider();
}

function setEtaProvider(provider) {
  if (!provider || typeof provider.estimate !== 'function') {
    throw new Error('EtaProvider requires estimate()');
  }
  etaProvider = provider;
  return etaProvider;
}

function resetEtaProvider() {
  etaProvider = null;
}

function findSessionByTripId(store, tripId) {
  ensureStoreMaps(store);
  for (const s of store.trackingSessions.values()) {
    if (String(s.tripId) === String(tripId)) return s;
  }
  return null;
}

function listHistory(store, sessionId, { limit = 200 } = {}) {
  ensureStoreMaps(store);
  return store.trackingHistory
    .filter((h) => String(h.sessionId) === String(sessionId))
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
    .slice(-Math.max(1, limit));
}

/**
 * Validate GPS sample. Returns { ok, sample } or { ok:false, status, message, code }.
 */
function validateLocationSample(body, { previous, nowMs = Date.now() } = {}) {
  const latitude = Number(body.latitude ?? body.lat);
  const longitude = Number(body.longitude ?? body.lng ?? body.lon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_LATITUDE',
      message: 'خط العرض غير صالح',
    };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_LONGITUDE',
      message: 'خط الطول غير صالح',
    };
  }

  let clientMs = nowMs;
  if (body.timestamp != null || body.at != null) {
    const parsed = Date.parse(String(body.timestamp || body.at));
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_TIMESTAMP',
        message: 'الطابع الزمني غير صالح',
      };
    }
    clientMs = parsed;
  }
  if (clientMs > nowMs + FUTURE_TOLERANCE_MS) {
    return {
      ok: false,
      status: 400,
      code: 'FUTURE_TIMESTAMP',
      message: 'الطابع الزمني في المستقبل',
    };
  }
  if (nowMs - clientMs > STALE_MS) {
    return {
      ok: false,
      status: 400,
      code: 'STALE_TIMESTAMP',
      message: 'عينة موقع قديمة',
    };
  }

  const accuracy =
    body.accuracy != null ? Number(body.accuracy) : null;
  if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_ACCURACY_M * 4)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_ACCURACY',
      message: 'دقة الموقع غير صالحة',
    };
  }

  const heading =
    body.heading != null ? Number(body.heading) : null;
  if (
    heading != null &&
    (!Number.isFinite(heading) || heading < 0 || heading > 360)
  ) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_HEADING',
      message: 'الاتجاه غير صالح',
    };
  }

  const speed =
    body.speed != null ? Number(body.speed) : null;
  if (speed != null && (!Number.isFinite(speed) || speed < 0 || speed > MAX_SPEED_MPS)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SPEED',
      message: 'السرعة غير صالحة',
    };
  }

  const altitude =
    body.altitude != null ? Number(body.altitude) : null;

  if (previous) {
    const same =
      Math.abs(previous.latitude - latitude) < 1e-7 &&
      Math.abs(previous.longitude - longitude) < 1e-7 &&
      Math.abs(Date.parse(previous.timestamp) - clientMs) < 500;
    if (same) {
      return {
        ok: false,
        status: 409,
        code: 'DUPLICATE_SAMPLE',
        message: 'عينة مكررة',
      };
    }
    const dtSec = Math.max(
      0.001,
      (clientMs - Date.parse(previous.timestamp)) / 1000,
    );
    if (dtSec > 0) {
      const dist = haversineMeters(
        previous.latitude,
        previous.longitude,
        latitude,
        longitude,
      );
      const implied = dist / dtSec;
      if (implied > MAX_JUMP_MPS && dist > 80) {
        return {
          ok: false,
          status: 409,
          code: 'IMPOSSIBLE_JUMP',
          message: 'قفزة موقع غير ممكنة',
        };
      }
    }
  }

  return {
    ok: true,
    sample: {
      latitude,
      longitude,
      timestamp: nowIso(clientMs),
      clientTimestamp: nowIso(clientMs),
      serverReceivedAt: nowIso(nowMs),
      accuracy: accuracy != null && Number.isFinite(accuracy) ? accuracy : null,
      heading: heading != null && Number.isFinite(heading) ? heading : null,
      speed: speed != null && Number.isFinite(speed) ? speed : null,
      altitude: altitude != null && Number.isFinite(altitude) ? altitude : null,
    },
  };
}

function isLegalTransition(from, to) {
  return (TRACKING_TRANSITIONS[from] || []).includes(to);
}

function computeRouteMetrics(session) {
  const current = session.currentPosition;
  const dest = session.destination;
  const start = session.startPosition;
  const travelled = Number(session.distanceTravelledM) || 0;
  const planned =
    Number(session.plannedDistanceM) ||
    (start && dest
      ? haversineMeters(
          start.latitude,
          start.longitude,
          dest.latitude,
          dest.longitude,
        )
      : null);

  const eta = getEtaProvider().estimate({
    current,
    destination: dest,
    speedMps: current?.speed,
    distanceTravelledM: travelled,
    plannedDistanceM: planned,
  });

  return {
    distanceTravelledM: eta.distanceTravelledM ?? Math.round(travelled),
    distanceRemainingM: eta.distanceRemainingM,
    plannedDistanceM:
      eta.plannedDistanceM ??
      (planned != null ? Math.round(planned) : null),
    progressPct: eta.progressPct ?? 0,
    etaSeconds: eta.etaSeconds,
    etaAt: eta.etaAt,
    etaMethod: eta.method || getEtaProvider().name || 'haversine_speed_v1',
  };
}

/**
 * Start tracking for a trip (exactly one session per trip).
 */
function startTracking({
  store,
  trip,
  actorUserId,
  actorRole,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  if (!trip) return { ok: false, status: 404, message: 'الرحلة غير موجودة' };
  if (['delivered', 'closed', 'created'].includes(trip.status)) {
    return {
      ok: false,
      status: 409,
      message: 'الرحلة غير جاهزة للتتبع',
    };
  }
  if (!trip.driverId || !trip.vehicleId) {
    return {
      ok: false,
      status: 409,
      message: 'عيّن السائق والمركبة قبل التتبع',
    };
  }
  if (!TRACKABLE_TRIP.has(trip.status) && trip.status !== 'vehicle_assigned') {
    // allow from vehicle_assigned so provider can start early
  }

  const existing = findSessionByTripId(store, trip.id);
  if (existing && !['stopped', 'completed', 'inactive'].includes(existing.status)) {
    return { ok: true, reused: true, session: existing };
  }
  if (existing && existing.status === 'completed') {
    return {
      ok: false,
      status: 409,
      message: 'جلسة التتبع مكتملة مسبقاً',
    };
  }

  const pickup = trip.pickup || null;
  const destination = trip.destination || null;
  let startPosition = null;
  if (pickup?.latitude != null && pickup?.longitude != null) {
    startPosition = {
      latitude: Number(pickup.latitude),
      longitude: Number(pickup.longitude),
    };
  }

  let plannedDistanceM = null;
  if (
    startPosition &&
    destination?.latitude != null &&
    destination?.longitude != null
  ) {
    plannedDistanceM = haversineMeters(
      startPosition.latitude,
      startPosition.longitude,
      Number(destination.latitude),
      Number(destination.longitude),
    );
  }

  const sessionId = existing?.id || idFn();
  const session = {
    id: sessionId,
    tripId: String(trip.id),
    bookingId: trip.bookingId || null,
    driverId: String(trip.driverId),
    vehicleId: String(trip.vehicleId),
    providerId: String(trip.providerId),
    customerId: String(trip.customerId),
    status: TRACKING_STATUS.started,
    currentPosition: null,
    heading: null,
    speed: null,
    accuracy: null,
    altitude: null,
    timestamp: null,
    startPosition,
    destination:
      destination?.latitude != null
        ? {
            latitude: Number(destination.latitude),
            longitude: Number(destination.longitude),
          }
        : null,
    distanceTravelledM: existing?.distanceTravelledM || 0,
    plannedDistanceM:
      plannedDistanceM != null
        ? Math.round(plannedDistanceM)
        : existing?.plannedDistanceM || null,
    sampleCount: existing?.sampleCount || 0,
    lastPersistedSample: existing?.lastPersistedSample || 0,
    version: Number(existing?.version || 0) + 1,
    createdAt: existing?.createdAt || nowIso(nowMs),
    updatedAt: nowIso(nowMs),
    startedAt: nowIso(nowMs),
    stoppedAt: null,
    completedAt: null,
  };
  store.trackingSessions.set(sessionId, session);

  store.trips.set(trip.id, {
    ...trip,
    trackingSessionId: sessionId,
    updatedAt: nowIso(nowMs),
  });

  appendEvent(store, {
    id: idFn(),
    type: EVENT_TYPE.TrackingStarted,
    sessionId,
    tripId: trip.id,
    actor: actorRole,
    actorId: actorUserId,
    at: nowIso(nowMs),
    serverTime: true,
  });

  // Auto-enter tracking state (started → tracking is legal)
  const tracking = {
    ...session,
    status: TRACKING_STATUS.tracking,
    updatedAt: nowIso(nowMs),
  };
  store.trackingSessions.set(sessionId, tracking);

  return { ok: true, reused: false, session: tracking };
}

function transitionTracking({
  store,
  sessionId,
  toStatus,
  actorUserId,
  actorRole,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  const session = store.trackingSessions.get(String(sessionId));
  if (!session) {
    return { ok: false, status: 404, message: 'جلسة التتبع غير موجودة' };
  }
  const target = String(toStatus || '').trim();
  if (!Object.values(TRACKING_STATUS).includes(target)) {
    return { ok: false, status: 400, message: 'حالة تتبع غير معروفة' };
  }
  if (!isLegalTransition(session.status, target)) {
    return {
      ok: false,
      status: 409,
      message: 'انتقال تتبع غير قانوني',
      from: session.status,
      to: target,
      allowed: TRACKING_TRANSITIONS[session.status] || [],
    };
  }

  const from = session.status;
  const updated = {
    ...session,
    status: target,
    version: Number(session.version || 1) + 1,
    updatedAt: nowIso(nowMs),
  };
  if (target === TRACKING_STATUS.stopped) updated.stoppedAt = nowIso(nowMs);
  if (target === TRACKING_STATUS.completed) {
    updated.completedAt = nowIso(nowMs);
    updated.stoppedAt = updated.stoppedAt || nowIso(nowMs);
  }
  store.trackingSessions.set(session.id, updated);

  const typeMap = {
    [TRACKING_STATUS.paused]: EVENT_TYPE.TrackingPaused,
    [TRACKING_STATUS.resumed]: EVENT_TYPE.TrackingResumed,
    [TRACKING_STATUS.stopped]: EVENT_TYPE.TrackingStopped,
    [TRACKING_STATUS.completed]: EVENT_TYPE.TrackingCompleted,
  };
  appendEvent(store, {
    id: idFn(),
    type: typeMap[target] || `Tracking:${target}`,
    sessionId: session.id,
    tripId: session.tripId,
    actor: actorRole,
    actorId: actorUserId,
    fromStatus: from,
    toStatus: updated.status,
    at: nowIso(nowMs),
    serverTime: true,
  });

  return { ok: true, session: updated };
}

/**
 * Push a location sample. Returns shouldPersist hint for routes.
 */
function pushLocation({
  store,
  sessionId,
  body,
  actorUserId,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  const session = store.trackingSessions.get(String(sessionId));
  if (!session) {
    return { ok: false, status: 404, message: 'جلسة التتبع غير موجودة' };
  }
  if (![TRACKING_STATUS.tracking, TRACKING_STATUS.started, TRACKING_STATUS.resumed].includes(session.status)) {
    return {
      ok: false,
      status: 409,
      message: 'التتبع غير نشط لاستقبال المواقع',
      statusTracking: session.status,
    };
  }

  const validated = validateLocationSample(body, {
    previous: session.currentPosition,
    nowMs,
  });
  if (!validated.ok) return validated;

  const sample = validated.sample;
  let distanceTravelledM = Number(session.distanceTravelledM) || 0;
  if (session.currentPosition) {
    distanceTravelledM += haversineMeters(
      session.currentPosition.latitude,
      session.currentPosition.longitude,
      sample.latitude,
      sample.longitude,
    );
  } else if (!session.startPosition) {
    session.startPosition = {
      latitude: sample.latitude,
      longitude: sample.longitude,
    };
  }

  const histSeq = (store._trackingHistorySeq || 0) + 1;
  store._trackingHistorySeq = histSeq;
  const historyRow = {
    id: idFn(),
    seq: histSeq,
    sessionId: session.id,
    tripId: session.tripId,
    ...sample,
  };
  store.trackingHistory.push(historyRow);
  while (store.trackingHistory.length > MAX_HISTORY * 5) {
    store.trackingHistory.shift();
  }
  // Cap per-session roughly via trimming oldest for this session if too many
  const mine = store.trackingHistory.filter(
    (h) => String(h.sessionId) === String(session.id),
  );
  if (mine.length > MAX_HISTORY) {
    const drop = mine.length - MAX_HISTORY;
    let removed = 0;
    store.trackingHistory = store.trackingHistory.filter((h) => {
      if (String(h.sessionId) !== String(session.id)) return true;
      if (removed < drop) {
        removed += 1;
        return false;
      }
      return true;
    });
  }

  const sampleCount = Number(session.sampleCount || 0) + 1;
  const updated = {
    ...session,
    status: TRACKING_STATUS.tracking,
    currentPosition: sample,
    heading: sample.heading,
    speed: sample.speed,
    accuracy: sample.accuracy,
    altitude: sample.altitude,
    timestamp: sample.timestamp,
    distanceTravelledM,
    sampleCount,
    version: Number(session.version || 1) + 1,
    updatedAt: nowIso(nowMs),
  };
  store.trackingSessions.set(session.id, updated);

  const metrics = computeRouteMetrics(updated);
  const shouldPersist =
    sampleCount - Number(session.lastPersistedSample || 0) >= PERSIST_EVERY_N;
  if (shouldPersist) {
    updated.lastPersistedSample = sampleCount;
    store.trackingSessions.set(session.id, updated);
  }

  return {
    ok: true,
    session: updated,
    sample: historyRow,
    metrics,
    shouldPersist,
    liveEvent: {
      type: 'tracking.location',
      tripId: session.tripId,
      requestId: null,
      customerId: session.customerId,
      providerId: session.providerId,
      sessionId: session.id,
      position: sample,
      metrics,
      trackingStatus: updated.status,
      at: nowIso(nowMs),
    },
  };
}

function getTrackingView(store, sessionId) {
  ensureStoreMaps(store);
  const session = store.trackingSessions.get(String(sessionId));
  if (!session) return null;
  const metrics = computeRouteMetrics(session);
  const history = listHistory(store, session.id, { limit: 50 });
  return {
    session,
    metrics,
    historyPreview: history,
    eta: {
      etaSeconds: metrics.etaSeconds,
      etaAt: metrics.etaAt,
      method: metrics.etaMethod,
    },
  };
}

function assertCanPublish(session, userId, store) {
  // Driver user may equal provider (owner-operator) or dedicated driver record
  if (String(session.providerId) === String(userId)) return 'provider';
  const driver = store.drivers?.get(String(session.driverId));
  // Drivers are fleet entities owned by provider; publisher is provider account
  // Optional: body.asDriver if user is linked — for now provider publishes.
  if (driver && String(driver.userId || '') === String(userId)) return 'driver';
  return null;
}

function assertCanRead(session, userId) {
  if (String(session.customerId) === String(userId)) return 'customer';
  if (String(session.providerId) === String(userId)) return 'provider';
  return null;
}

module.exports = {
  TRACKING_STATUS,
  TRACKING_TRANSITIONS,
  EVENT_TYPE,
  TRACKABLE_TRIP,
  PERSIST_EVERY_N,
  ensureStoreMaps,
  haversineMeters,
  validateLocationSample,
  startTracking,
  transitionTracking,
  pushLocation,
  findSessionByTripId,
  listHistory,
  getTrackingView,
  computeRouteMetrics,
  assertCanPublish,
  assertCanRead,
  getEtaProvider,
  setEtaProvider,
  resetEtaProvider,
  defaultEtaProvider,
  isLegalTransition,
};
