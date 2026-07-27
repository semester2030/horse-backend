/**
 * Journey Execution Engine (T5A).
 * Booking = commercial contract. Trip = operational execution.
 * Strict state machine · append-only timeline · server timestamps.
 * No GPS / ETA / Evidence / Payments.
 */
'use strict';

const TRIP_STATUS = Object.freeze({
  created: 'created',
  driver_assigned: 'driver_assigned',
  vehicle_assigned: 'vehicle_assigned',
  driver_en_route: 'driver_en_route',
  arrived_at_pickup: 'arrived_at_pickup',
  loading_started: 'loading_started',
  loading_completed: 'loading_completed',
  in_transit: 'in_transit',
  arrived_at_destination: 'arrived_at_destination',
  unloading_started: 'unloading_started',
  unloading_completed: 'unloading_completed',
  delivered: 'delivered',
  closed: 'closed',
});

/** Ordered lifecycle — no shortcuts without admin override. */
const STATUS_ORDER = Object.freeze([
  TRIP_STATUS.created,
  TRIP_STATUS.driver_assigned,
  TRIP_STATUS.vehicle_assigned,
  TRIP_STATUS.driver_en_route,
  TRIP_STATUS.arrived_at_pickup,
  TRIP_STATUS.loading_started,
  TRIP_STATUS.loading_completed,
  TRIP_STATUS.in_transit,
  TRIP_STATUS.arrived_at_destination,
  TRIP_STATUS.unloading_started,
  TRIP_STATUS.unloading_completed,
  TRIP_STATUS.delivered,
  TRIP_STATUS.closed,
]);

/** Legal next status for providers (exactly one step forward). */
const TRANSITIONS = Object.freeze({
  [TRIP_STATUS.created]: [TRIP_STATUS.driver_assigned],
  [TRIP_STATUS.driver_assigned]: [TRIP_STATUS.vehicle_assigned],
  [TRIP_STATUS.vehicle_assigned]: [TRIP_STATUS.driver_en_route],
  [TRIP_STATUS.driver_en_route]: [TRIP_STATUS.arrived_at_pickup],
  [TRIP_STATUS.arrived_at_pickup]: [TRIP_STATUS.loading_started],
  [TRIP_STATUS.loading_started]: [TRIP_STATUS.loading_completed],
  [TRIP_STATUS.loading_completed]: [TRIP_STATUS.in_transit],
  [TRIP_STATUS.in_transit]: [TRIP_STATUS.arrived_at_destination],
  [TRIP_STATUS.arrived_at_destination]: [TRIP_STATUS.unloading_started],
  [TRIP_STATUS.unloading_started]: [TRIP_STATUS.unloading_completed],
  [TRIP_STATUS.unloading_completed]: [TRIP_STATUS.delivered],
  [TRIP_STATUS.delivered]: [TRIP_STATUS.closed],
  [TRIP_STATUS.closed]: [],
});

const EVENT_TYPE = Object.freeze({
  TripCreated: 'TripCreated',
  DriverAssigned: 'DriverAssigned',
  VehicleAssigned: 'VehicleAssigned',
  DriverStarted: 'DriverStarted',
  ArrivedPickup: 'ArrivedPickup',
  LoadingStarted: 'LoadingStarted',
  LoadingCompleted: 'LoadingCompleted',
  JourneyStarted: 'JourneyStarted',
  DestinationReached: 'DestinationReached',
  UnloadStarted: 'UnloadStarted',
  UnloadCompleted: 'UnloadCompleted',
  Delivered: 'Delivered',
  TripClosed: 'TripClosed',
  AdminOverride: 'AdminOverride',
  NoteAdded: 'NoteAdded',
});

const STATUS_TO_EVENT = Object.freeze({
  [TRIP_STATUS.created]: EVENT_TYPE.TripCreated,
  [TRIP_STATUS.driver_assigned]: EVENT_TYPE.DriverAssigned,
  [TRIP_STATUS.vehicle_assigned]: EVENT_TYPE.VehicleAssigned,
  [TRIP_STATUS.driver_en_route]: EVENT_TYPE.DriverStarted,
  [TRIP_STATUS.arrived_at_pickup]: EVENT_TYPE.ArrivedPickup,
  [TRIP_STATUS.loading_started]: EVENT_TYPE.LoadingStarted,
  [TRIP_STATUS.loading_completed]: EVENT_TYPE.LoadingCompleted,
  [TRIP_STATUS.in_transit]: EVENT_TYPE.JourneyStarted,
  [TRIP_STATUS.arrived_at_destination]: EVENT_TYPE.DestinationReached,
  [TRIP_STATUS.unloading_started]: EVENT_TYPE.UnloadStarted,
  [TRIP_STATUS.unloading_completed]: EVENT_TYPE.UnloadCompleted,
  [TRIP_STATUS.delivered]: EVENT_TYPE.Delivered,
  [TRIP_STATUS.closed]: EVENT_TYPE.TripClosed,
});

/** Statuses that block driver/vehicle from another trip. */
const ACTIVE_TRIP_STATUSES = new Set(
  STATUS_ORDER.filter(
    (s) => s !== TRIP_STATUS.closed && s !== TRIP_STATUS.delivered,
  ),
);

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function ensureStoreMaps(store) {
  if (!store.trips) store.trips = new Map();
  if (!store.tripEvents) store.tripEvents = [];
  if (!store.drivers) store.drivers = new Map();
  if (!store.vehicles) store.vehicles = new Map();
  if (!store.bookings) store.bookings = new Map();
}

function appendTripEvent(store, event) {
  ensureStoreMaps(store);
  const seq = (store._tripEventSeq || 0) + 1;
  store._tripEventSeq = seq;
  store.tripEvents.unshift({ ...event, seq });
  if (store.tripEvents.length > 10000) {
    store.tripEvents.length = 10000;
  }
}

function listTimeline(store, tripId) {
  ensureStoreMaps(store);
  return store.tripEvents
    .filter((e) => String(e.tripId) === String(tripId))
    .sort((a, b) => {
      const sa = Number(a.seq) || 0;
      const sb = Number(b.seq) || 0;
      if (sa !== sb) return sa - sb;
      return String(a.at).localeCompare(String(b.at));
    });
}

function statusIndex(status) {
  return STATUS_ORDER.indexOf(status);
}

function isLegalProviderTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

function isForwardStatus(from, to) {
  const a = statusIndex(from);
  const b = statusIndex(to);
  return a >= 0 && b >= 0 && b > a;
}

function findTripByBookingId(store, bookingId) {
  ensureStoreMaps(store);
  const id = String(bookingId);
  for (const t of store.trips.values()) {
    if (String(t.bookingId) === id) return t;
  }
  return null;
}

function tripHasActiveConflict(store, { driverId, vehicleId, excludeTripId }) {
  ensureStoreMaps(store);
  for (const t of store.trips.values()) {
    if (excludeTripId && String(t.id) === String(excludeTripId)) continue;
    if (!ACTIVE_TRIP_STATUSES.has(t.status)) continue;
    if (driverId && String(t.driverId || '') === String(driverId)) return t;
    if (vehicleId && String(t.vehicleId || '') === String(vehicleId)) return t;
  }
  return null;
}

function isLicenseValid(driver, nowMs = Date.now()) {
  if (!driver || !driver.licenseNumber) return false;
  if (!driver.licenseValidUntil) return false;
  const exp = Date.parse(driver.licenseValidUntil);
  return Number.isFinite(exp) && exp > nowMs;
}

function isInsuranceValid(vehicle, nowMs = Date.now()) {
  if (!vehicle || !vehicle.insuranceValidUntil) return false;
  const exp = Date.parse(vehicle.insuranceValidUntil);
  return Number.isFinite(exp) && exp > nowMs;
}

function isWithinWorkingHours(driver, nowMs = Date.now()) {
  const wh = driver.workingHours;
  if (!wh || typeof wh !== 'object') return true;
  const d = new Date(nowMs);
  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const key = dayKeys[d.getUTCDay()];
  const slot = wh[key] || wh[d.getUTCDay()] || wh.default;
  if (slot === false || slot === 'off') return false;
  if (!slot || typeof slot !== 'object') return true;
  const start = String(slot.start || '00:00');
  const end = String(slot.end || '23:59');
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const from = (sh || 0) * 60 + (sm || 0);
  const to = (eh || 23) * 60 + (em || 59);
  return mins >= from && mins <= to;
}

function vehicleSupportsAnimal(vehicle, animalType) {
  const types = Array.isArray(vehicle.animalTypes)
    ? vehicle.animalTypes.map((t) => String(t).toLowerCase())
    : [];
  if (types.length === 0) return true;
  return types.includes(String(animalType || '').toLowerCase());
}

/**
 * Create exactly one Trip for an accepted Booking (idempotent).
 */
function createTripFromBooking({ store, booking, idFn, nowMs = Date.now() }) {
  ensureStoreMaps(store);
  if (!booking || !booking.id) {
    return { ok: false, status: 400, message: 'الحجز مطلوب' };
  }
  const existing = findTripByBookingId(store, booking.id);
  if (existing) {
    return { ok: true, reused: true, trip: existing };
  }

  const tripId = idFn();
  const trip = {
    id: tripId,
    bookingId: String(booking.id),
    transportRequestId: booking.transportRequestId || null,
    negotiationId: booking.negotiationId || null,
    acceptedOfferId: booking.acceptedOfferId || null,
    customerId: String(booking.userId || booking.customerId || ''),
    providerId: String(booking.providerId || ''),
    serviceId: String(booking.serviceId || ''),
    status: TRIP_STATUS.created,
    driverId: null,
    vehicleId: null,
    operationalNotes: [],
    milestones: {},
    animalType: booking.details?.animalType || booking.details?.species || null,
    animalCount:
      booking.details?.animalCount || booking.details?.unitsRequested || null,
    pickup: booking.details?.pickup || booking.details?.origin || null,
    destination: booking.details?.destination || null,
    version: 1,
    createdAt: nowIso(nowMs),
    updatedAt: nowIso(nowMs),
    closedAt: null,
  };
  store.trips.set(tripId, trip);

  store.bookings.set(booking.id, {
    ...booking,
    tripId,
    updatedAt: nowIso(nowMs),
  });

  appendTripEvent(store, {
    id: idFn(),
    type: EVENT_TYPE.TripCreated,
    tripId,
    bookingId: booking.id,
    actor: 'system',
    actorId: null,
    fromStatus: null,
    toStatus: TRIP_STATUS.created,
    note: null,
    at: nowIso(nowMs),
    serverTime: true,
  });

  return { ok: true, reused: false, trip };
}

function upsertDriver({ store, providerId, body, idFn, nowMs = Date.now() }) {
  ensureStoreMaps(store);
  const name = String(body.name || '').trim();
  const licenseNumber = String(body.licenseNumber || '').trim();
  if (!name || !licenseNumber) {
    return { ok: false, status: 400, message: 'اسم السائق ورخصة القيادة مطلوبان' };
  }
  const licenseValidUntil = String(body.licenseValidUntil || '').trim();
  if (!licenseValidUntil || !Number.isFinite(Date.parse(licenseValidUntil))) {
    return { ok: false, status: 400, message: 'صلاحية الرخصة مطلوبة' };
  }
  const id = body.id ? String(body.id) : idFn();
  const existing = store.drivers.get(id);
  if (existing && String(existing.providerId) !== String(providerId)) {
    return { ok: false, status: 403, message: 'غير مصرح' };
  }
  const driver = {
    id,
    providerId: String(providerId),
    name,
    licenseNumber,
    licenseValidUntil,
    available: body.available !== false,
    workingHours: body.workingHours || null,
    vehicleIds: Array.isArray(body.vehicleIds)
      ? body.vehicleIds.map(String)
      : existing?.vehicleIds || [],
    status: body.status === 'inactive' ? 'inactive' : 'active',
    createdAt: existing?.createdAt || nowIso(nowMs),
    updatedAt: nowIso(nowMs),
  };
  store.drivers.set(id, driver);
  return { ok: true, driver, created: !existing };
}

function upsertVehicle({ store, providerId, body, idFn, nowMs = Date.now() }) {
  ensureStoreMaps(store);
  const plate = String(body.plate || body.plateNumber || '').trim();
  if (!plate) {
    return { ok: false, status: 400, message: 'رقم اللوحة مطلوب' };
  }
  const capacity = Math.max(1, Math.floor(Number(body.capacity) || 1));
  const insuranceValidUntil = String(body.insuranceValidUntil || '').trim();
  if (!insuranceValidUntil || !Number.isFinite(Date.parse(insuranceValidUntil))) {
    return { ok: false, status: 400, message: 'صلاحية التأمين مطلوبة' };
  }
  const id = body.id ? String(body.id) : idFn();
  const existing = store.vehicles.get(id);
  if (existing && String(existing.providerId) !== String(providerId)) {
    return { ok: false, status: 403, message: 'غير مصرح' };
  }
  const animalTypes = Array.isArray(body.animalTypes)
    ? body.animalTypes.map((t) => String(t).toLowerCase())
    : ['horse', 'camel', 'falcon'];
  const vehicle = {
    id,
    providerId: String(providerId),
    plate,
    name: body.name != null ? String(body.name).trim() : null,
    capacity,
    animalTypes,
    insuranceValidUntil,
    active: body.active !== false,
    status: body.status === 'inactive' ? 'inactive' : 'active',
    createdAt: existing?.createdAt || nowIso(nowMs),
    updatedAt: nowIso(nowMs),
  };
  store.vehicles.set(id, vehicle);
  return { ok: true, vehicle, created: !existing };
}

function assignDriver({
  store,
  tripId,
  driverId,
  actorUserId,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  const trip = store.trips.get(String(tripId));
  if (!trip) return { ok: false, status: 404, message: 'الرحلة غير موجودة' };
  if (String(trip.providerId) !== String(actorUserId)) {
    return { ok: false, status: 403, message: 'المقدم فقط يعيّن السائق' };
  }
  if (
    trip.status !== TRIP_STATUS.created &&
    trip.status !== TRIP_STATUS.driver_assigned
  ) {
    return {
      ok: false,
      status: 409,
      message: 'تعيين السائق مسموح فقط في بداية الرحلة',
    };
  }
  const driver = store.drivers.get(String(driverId));
  if (!driver) return { ok: false, status: 404, message: 'السائق غير موجود' };
  if (String(driver.providerId) !== String(trip.providerId)) {
    return { ok: false, status: 403, message: 'السائق لا يتبع هذا المقدم' };
  }
  if (driver.status !== 'active' || driver.available === false) {
    return { ok: false, status: 409, message: 'السائق غير متاح' };
  }
  if (!isLicenseValid(driver, nowMs)) {
    return { ok: false, status: 409, message: 'رخصة السائق غير سارية' };
  }
  if (!isWithinWorkingHours(driver, nowMs)) {
    return { ok: false, status: 409, message: 'خارج ساعات عمل السائق' };
  }
  const conflict = tripHasActiveConflict(store, {
    driverId: driver.id,
    excludeTripId: trip.id,
  });
  if (conflict) {
    return {
      ok: false,
      status: 409,
      message: 'السائق مرتبط برحلة نشطة أخرى',
      conflictTripId: conflict.id,
    };
  }

  const from = trip.status;
  const updated = {
    ...trip,
    driverId: driver.id,
    status: TRIP_STATUS.driver_assigned,
    version: Number(trip.version || 1) + 1,
    updatedAt: nowIso(nowMs),
    milestones: {
      ...(trip.milestones || {}),
      driverAssignedAt: nowIso(nowMs),
    },
  };
  store.trips.set(trip.id, updated);
  appendTripEvent(store, {
    id: idFn(),
    type: EVENT_TYPE.DriverAssigned,
    tripId: trip.id,
    bookingId: trip.bookingId,
    actor: 'provider',
    actorId: actorUserId,
    driverId: driver.id,
    fromStatus: from,
    toStatus: TRIP_STATUS.driver_assigned,
    note: null,
    at: nowIso(nowMs),
    serverTime: true,
  });
  return { ok: true, trip: updated, driver };
}

function assignVehicle({
  store,
  tripId,
  vehicleId,
  actorUserId,
  idFn,
  nowMs = Date.now(),
}) {
  ensureStoreMaps(store);
  const trip = store.trips.get(String(tripId));
  if (!trip) return { ok: false, status: 404, message: 'الرحلة غير موجودة' };
  if (String(trip.providerId) !== String(actorUserId)) {
    return { ok: false, status: 403, message: 'المقدم فقط يعيّن المركبة' };
  }
  if (!trip.driverId) {
    return { ok: false, status: 409, message: 'عيّن السائق أولاً' };
  }
  if (
    trip.status !== TRIP_STATUS.driver_assigned &&
    trip.status !== TRIP_STATUS.vehicle_assigned
  ) {
    return {
      ok: false,
      status: 409,
      message: 'تعيين المركبة مسموح بعد تعيين السائق مباشرة',
    };
  }
  const vehicle = store.vehicles.get(String(vehicleId));
  if (!vehicle) return { ok: false, status: 404, message: 'المركبة غير موجودة' };
  if (String(vehicle.providerId) !== String(trip.providerId)) {
    return { ok: false, status: 403, message: 'المركبة لا تتبع هذا المقدم' };
  }
  if (vehicle.status !== 'active' || vehicle.active === false) {
    return { ok: false, status: 409, message: 'المركبة غير نشطة' };
  }
  if (!isInsuranceValid(vehicle, nowMs)) {
    return { ok: false, status: 409, message: 'تأمين المركبة غير ساري' };
  }
  if (!vehicleSupportsAnimal(vehicle, trip.animalType)) {
    return { ok: false, status: 409, message: 'المركبة لا تدعم نوع الحيوان' };
  }
  const need = Math.max(1, Math.floor(Number(trip.animalCount) || 1));
  if (Number(vehicle.capacity) < need) {
    return { ok: false, status: 409, message: 'سعة المركبة غير كافية' };
  }
  const driver = store.drivers.get(String(trip.driverId));
  if (
    driver &&
    Array.isArray(driver.vehicleIds) &&
    driver.vehicleIds.length > 0 &&
    !driver.vehicleIds.map(String).includes(String(vehicle.id))
  ) {
    return {
      ok: false,
      status: 409,
      message: 'المركبة غير مصرّحة لهذا السائق',
    };
  }
  const conflict = tripHasActiveConflict(store, {
    vehicleId: vehicle.id,
    excludeTripId: trip.id,
  });
  if (conflict) {
    return {
      ok: false,
      status: 409,
      message: 'المركبة مرتبطة برحلة نشطة أخرى',
      conflictTripId: conflict.id,
    };
  }

  const from = trip.status;
  const updated = {
    ...trip,
    vehicleId: vehicle.id,
    status: TRIP_STATUS.vehicle_assigned,
    version: Number(trip.version || 1) + 1,
    updatedAt: nowIso(nowMs),
    milestones: {
      ...(trip.milestones || {}),
      vehicleAssignedAt: nowIso(nowMs),
    },
  };
  store.trips.set(trip.id, updated);
  appendTripEvent(store, {
    id: idFn(),
    type: EVENT_TYPE.VehicleAssigned,
    tripId: trip.id,
    bookingId: trip.bookingId,
    actor: 'provider',
    actorId: actorUserId,
    vehicleId: vehicle.id,
    fromStatus: from,
    toStatus: TRIP_STATUS.vehicle_assigned,
    note: null,
    at: nowIso(nowMs),
    serverTime: true,
  });
  return { ok: true, trip: updated, vehicle };
}

/**
 * Advance trip status. Customer cannot call.
 * Provider: one step only. Admin override: any forward jump + audit.
 */
function transitionTrip({
  store,
  tripId,
  toStatus,
  actorUserId,
  actorRole,
  note,
  idFn,
  nowMs = Date.now(),
  adminOverride = false,
  auditFn,
}) {
  ensureStoreMaps(store);
  const trip = store.trips.get(String(tripId));
  if (!trip) return { ok: false, status: 404, message: 'الرحلة غير موجودة' };

  const target = String(toStatus || '').trim();
  if (!STATUS_ORDER.includes(target)) {
    return { ok: false, status: 400, message: 'حالة غير معروفة' };
  }

  if (actorRole === 'customer') {
    return { ok: false, status: 403, message: 'العميل لا يغيّر حالة الرحلة' };
  }

  if (actorRole === 'provider') {
    if (String(trip.providerId) !== String(actorUserId)) {
      return { ok: false, status: 403, message: 'غير مصرح' };
    }
    if (adminOverride) {
      return { ok: false, status: 403, message: 'التجاوز للإدارة فقط' };
    }
    if (
      target === TRIP_STATUS.driver_assigned ||
      target === TRIP_STATUS.vehicle_assigned
    ) {
      return {
        ok: false,
        status: 400,
        message: 'استخدم مسارات التعيين لتعيين السائق/المركبة',
      };
    }
    if (!trip.driverId || !trip.vehicleId) {
      return {
        ok: false,
        status: 409,
        message: 'أكمل تعيين السائق والمركبة أولاً',
      };
    }
    if (!isLegalProviderTransition(trip.status, target)) {
      return {
        ok: false,
        status: 409,
        message: 'انتقال غير قانوني — لا يُسمح بتخطي الحالات',
        from: trip.status,
        to: target,
        allowed: TRANSITIONS[trip.status] || [],
      };
    }
  } else if (actorRole === 'admin') {
    if (!adminOverride && !isLegalProviderTransition(trip.status, target)) {
      return {
        ok: false,
        status: 409,
        message: 'استخدم override للتخطي مع تدقيق',
        from: trip.status,
        to: target,
      };
    }
    if (adminOverride) {
      if (!isForwardStatus(trip.status, target) && trip.status !== target) {
        return {
          ok: false,
          status: 409,
          message: 'التجاوز للإدارة للأمام فقط',
        };
      }
      if (!note || !String(note).trim()) {
        return {
          ok: false,
          status: 400,
          message: 'ملاحظة التدقيق مطلوبة للتجاوز',
        };
      }
    }
  } else {
    return { ok: false, status: 403, message: 'دور غير مصرح' };
  }

  if (trip.status === target) {
    return { ok: true, reused: true, trip };
  }

  const from = trip.status;
  const milestoneKey = `${target}At`;
  const updated = {
    ...trip,
    status: target,
    version: Number(trip.version || 1) + 1,
    updatedAt: nowIso(nowMs),
    closedAt: target === TRIP_STATUS.closed ? nowIso(nowMs) : trip.closedAt,
    milestones: {
      ...(trip.milestones || {}),
      [milestoneKey]: nowIso(nowMs),
    },
  };
  if (note) {
    updated.operationalNotes = [
      ...(trip.operationalNotes || []),
      {
        at: nowIso(nowMs),
        by: actorUserId,
        role: actorRole,
        text: String(note).trim().slice(0, 1000),
      },
    ];
  }
  store.trips.set(trip.id, updated);

  const eventType =
    adminOverride && !isLegalProviderTransition(from, target)
      ? EVENT_TYPE.AdminOverride
      : STATUS_TO_EVENT[target] || 'StatusChanged';

  appendTripEvent(store, {
    id: idFn(),
    type: eventType,
    tripId: trip.id,
    bookingId: trip.bookingId,
    actor: actorRole,
    actorId: actorUserId,
    fromStatus: from,
    toStatus: target,
    note: note ? String(note).trim().slice(0, 1000) : null,
    override: !!adminOverride,
    at: nowIso(nowMs),
    serverTime: true,
  });

  if (adminOverride && typeof auditFn === 'function') {
    auditFn({
      action: 'trip.admin_override',
      entityType: 'trip',
      entityId: trip.id,
      note: String(note).trim(),
      meta: { from, to: target },
    });
  }

  return { ok: true, reused: false, trip: updated };
}

function assertTripViewer(trip, userId) {
  if (!trip) return false;
  const uid = String(userId);
  return String(trip.customerId) === uid || String(trip.providerId) === uid;
}

function getTripView(store, tripId) {
  ensureStoreMaps(store);
  const trip = store.trips.get(String(tripId));
  if (!trip) return null;
  const timeline = listTimeline(store, trip.id);
  const driver = trip.driverId ? store.drivers.get(String(trip.driverId)) : null;
  const vehicle = trip.vehicleId
    ? store.vehicles.get(String(trip.vehicleId))
    : null;
  const allowedNext =
    trip.status === TRIP_STATUS.created
      ? []
      : trip.status === TRIP_STATUS.driver_assigned
        ? []
        : TRANSITIONS[trip.status] || [];
  return {
    trip,
    timeline,
    driver: driver
      ? {
          id: driver.id,
          name: driver.name,
          licenseNumber: driver.licenseNumber,
          status: driver.status,
        }
      : null,
    vehicle: vehicle
      ? {
          id: vehicle.id,
          plate: vehicle.plate,
          name: vehicle.name,
          capacity: vehicle.capacity,
          status: vehicle.status,
        }
      : null,
    allowedNext,
    assignmentRequired:
      trip.status === TRIP_STATUS.created
        ? 'driver'
        : trip.status === TRIP_STATUS.driver_assigned
          ? 'vehicle'
          : null,
    statusOrder: STATUS_ORDER,
  };
}

function listTripsForUser(store, userId, roleHint) {
  ensureStoreMaps(store);
  const uid = String(userId);
  return [...store.trips.values()]
    .filter((t) => {
      if (roleHint === 'provider') return String(t.providerId) === uid;
      if (roleHint === 'customer') return String(t.customerId) === uid;
      return String(t.providerId) === uid || String(t.customerId) === uid;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  TRIP_STATUS,
  STATUS_ORDER,
  TRANSITIONS,
  EVENT_TYPE,
  ACTIVE_TRIP_STATUSES,
  ensureStoreMaps,
  createTripFromBooking,
  findTripByBookingId,
  listTimeline,
  upsertDriver,
  upsertVehicle,
  assignDriver,
  assignVehicle,
  transitionTrip,
  assertTripViewer,
  getTripView,
  listTripsForUser,
  isLegalProviderTransition,
  tripHasActiveConflict,
};
