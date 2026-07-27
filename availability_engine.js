/**
 * Availability Engine (T3) — deterministic provider availability.
 * Uses real service/user/booking fields only. No Trip entity yet:
 * blocking bookings (confirmed/in_progress/pending) act as journey conflicts.
 */
'use strict';

const bookingOccupancy = require('./booking_occupancy');

const AVAIL = Object.freeze({
  available: 'available',
  busy: 'busy',
  offline: 'offline',
  vacation: 'vacation',
  maintenance: 'maintenance',
  unavailable: 'unavailable',
  unknown: 'unknown',
});

/** Statuses that make a provider ineligible for matching. */
const REJECT_STATUSES = new Set([
  AVAIL.busy,
  AVAIL.offline,
  AVAIL.vacation,
  AVAIL.maintenance,
  AVAIL.unavailable,
]);

function lower(v) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase();
}

function isDeleted(service) {
  if (!service) return true;
  if (service.deleted === true || service.isDeleted === true) return true;
  const st = lower(service.status || service.reviewStatus);
  return st === 'deleted' || st === 'removed';
}

function isSuspendedOrInactive(service) {
  const st = lower(service?.status || service?.reviewStatus);
  if (!st) return false;
  return (
    st === 'suspended' ||
    st === 'rejected' ||
    st === 'inactive' ||
    st === 'blocked' ||
    st === 'disabled'
  );
}

function isTransportation(service) {
  const t = lower(service?.type || service?.serviceType);
  return t === 'transportation' || t === 'transport';
}

/**
 * Parse free-text working hours into { startHour, endHour } in local 0–23.
 * Returns null when unparseable (do not reject solely for unknown format).
 */
function parseWorkingHours(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/24|على مدار|طوال|دائم|always/i.test(text)) {
    return { startHour: 0, endHour: 24, always: true };
  }

  // HH:MM - HH:MM or H - H
  const colon = text.match(
    /(\d{1,2})\s*[:.]\s*(\d{2})\s*[-– إلىالى]+\s*(\d{1,2})\s*[:.]\s*(\d{2})/,
  );
  if (colon) {
    const sh = Number(colon[1]);
    const eh = Number(colon[3]);
    if (Number.isFinite(sh) && Number.isFinite(eh)) {
      return { startHour: sh, endHour: eh === 0 ? 24 : eh, always: false };
    }
  }

  const nums = text.match(/(\d{1,2})\s*(?:ص|صباح|am)?[^\d]{0,20}(\d{1,2})\s*(?:م|مساء|pm)?/i);
  if (nums) {
    let sh = Number(nums[1]);
    let eh = Number(nums[2]);
    if (!Number.isFinite(sh) || !Number.isFinite(eh)) return null;
    // Arabic evening hint: if end looks like 1–11 and text has مساء, treat as PM
    if (/مساء|م\b|pm/i.test(text) && eh < 12) eh += 12;
    if (/مساء|م\b|pm/i.test(text) && sh < 12 && /صباح|ص\b|am/i.test(text) === false) {
      // start may still be morning; leave as-is if صباح present
    }
    if (eh === sh) return { startHour: 0, endHour: 24, always: true };
    return { startHour: sh, endHour: eh, always: false };
  }

  return null;
}

function hourInWindow(hour, window) {
  if (!window || window.always) return true;
  const { startHour, endHour } = window;
  if (startHour === endHour) return true;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // overnight window e.g. 22–6
  return hour >= startHour || hour < endHour;
}

function explicitAvailabilityFlag(service, user) {
  const candidates = [
    service?.availabilityStatus,
    service?.availability,
    service?.providerAvailability,
    user?.availabilityStatus,
    user?.availability,
  ];
  for (const c of candidates) {
    const v = lower(c);
    if (!v) continue;
    if (v === 'available' || v === 'online' || v === 'active') return AVAIL.available;
    if (v === 'busy' || v === 'occupied' || v === 'in_trip' || v === 'on_trip') {
      return AVAIL.busy;
    }
    if (v === 'offline' || v === 'off') return AVAIL.offline;
    if (v === 'vacation' || v === 'leave' || v === 'holiday') return AVAIL.vacation;
    if (v === 'maintenance' || v === 'under_maintenance') return AVAIL.maintenance;
    if (v === 'unavailable' || v === 'closed') return AVAIL.unavailable;
  }

  if (
    service?.onVacation === true ||
    service?.vacation === true ||
    user?.onVacation === true
  ) {
    return AVAIL.vacation;
  }
  const vacUntil = service?.vacationUntil || user?.vacationUntil;
  if (vacUntil) {
    const t = Date.parse(String(vacUntil));
    if (Number.isFinite(t) && t > Date.now()) return AVAIL.vacation;
  }
  if (
    service?.underMaintenance === true ||
    service?.maintenance === true ||
    service?.vehicleMaintenance === true
  ) {
    return AVAIL.maintenance;
  }
  if (service?.offline === true || service?.isOffline === true || user?.offline === true) {
    return AVAIL.offline;
  }
  if (service?.busy === true || user?.busy === true) return AVAIL.busy;
  return null;
}

/**
 * Journey conflict proxy: blocking bookings for same service/provider
 * overlapping the requested day (Trip entity not implemented yet).
 */
function hasJourneyConflict({ store, service, providerId, atMs }) {
  if (!store?.bookings) return false;
  const day = bookingOccupancy.toDayKey(new Date(atMs).toISOString());
  if (!day) return false;
  const sid = String(service?.id || '');
  const pid = String(providerId || service?.providerId || '');

  for (const b of store.bookings.values()) {
    if (!bookingOccupancy.isTransportBooking(b)) continue;
    if (!bookingOccupancy.BLOCKING_STATUSES.has(lower(b.status || 'pending'))) {
      continue;
    }
    const sameService = sid && String(b.serviceId || '') === sid;
    const sameProvider = pid && String(b.providerId || '') === pid;
    if (!sameService && !sameProvider) continue;
    if (bookingOccupancy.bookingDayKey(b) === day) return true;
  }

  // Future trips map (empty today) — ready without inventing data
  if (store.trips && typeof store.trips.values === 'function') {
    for (const trip of store.trips.values()) {
      const st = lower(trip.status);
      if (!['accepted', 'scheduled', 'in_progress', 'driver_assigned', 'loading', 'in_transit'].includes(st)) {
        continue;
      }
      const same =
        (sid && String(trip.serviceId || '') === sid) ||
        (pid && String(trip.providerId || '') === pid);
      if (!same) continue;
      const tripDay =
        bookingOccupancy.toDayKey(trip.scheduledAt || trip.startAt || trip.requestedPickupAt);
      if (tripDay === day) return true;
    }
  }
  return false;
}

function capacityOk({ service, store, request, atIso }) {
  const need = Math.max(1, Math.floor(Number(request.animalCount) || 1));
  const capacity = bookingOccupancy.fleetCapacity(service);
  if (capacity <= 0) {
    // No reliable capacity registered — do not invent; treat as unknown capacity fit
    return { ok: true, capacity: null, reason: 'capacity_unknown' };
  }
  if (need > capacity) {
    return { ok: false, capacity, reason: 'capacity_overflow' };
  }
  const dayIso = atIso || request.requestedPickupAt || new Date().toISOString();
  const evalCap = bookingOccupancy.evaluateTransportCapacity({
    service,
    bookings: store?.bookings ? [...store.bookings.values()] : [],
    unitsRequested: need,
    bookingDate: dayIso,
  });
  if (!evalCap.ok) {
    return {
      ok: false,
      capacity,
      available: evalCap.available,
      reason: 'capacity_day_full',
    };
  }
  return { ok: true, capacity, available: evalCap.available, reason: 'capacity_ok' };
}

/**
 * Evaluate availability for a transport service against a request time.
 * @returns {{ status: string, eligible: boolean, reasons: string[], details: object }}
 */
function evaluateAvailability({ store, service, user, request, nowMs = Date.now() }) {
  const reasons = [];
  const details = {};

  if (!service || isDeleted(service)) {
    return {
      status: AVAIL.unavailable,
      eligible: false,
      reasons: ['deleted'],
      details,
    };
  }
  if (!isTransportation(service)) {
    return {
      status: AVAIL.unavailable,
      eligible: false,
      reasons: ['not_transportation'],
      details,
    };
  }
  if (isSuspendedOrInactive(service)) {
    return {
      status: AVAIL.unavailable,
      eligible: false,
      reasons: ['inactive_or_suspended'],
      details: { status: service.status || service.reviewStatus },
    };
  }

  const flag = explicitAvailabilityFlag(service, user);
  if (flag && flag !== AVAIL.available) {
    return {
      status: flag,
      eligible: false,
      reasons: [`explicit_${flag}`],
      details,
    };
  }

  const atMs = request?.requestedPickupAt
    ? Date.parse(request.requestedPickupAt)
    : nowMs;
  const when = Number.isFinite(atMs) ? atMs : nowMs;
  const whenDate = new Date(when);
  details.evaluatedAt = whenDate.toISOString();

  const hoursRaw = service.workingHours || user?.workingHours || null;
  details.workingHoursRaw = hoursRaw;
  const window = parseWorkingHours(hoursRaw);
  details.workingHoursParsed = window;
  if (window) {
    const hour = whenDate.getUTCHours(); // store times are typically UTC ISO; local TZ unknown
    // Prefer Asia/Riyadh-ish offset for KSA (+3) when evaluating display hours
    const ksaHour = (hour + 3) % 24;
    details.evaluatedHourKsa = ksaHour;
    if (!hourInWindow(ksaHour, window)) {
      return {
        status: AVAIL.unavailable,
        eligible: false,
        reasons: ['outside_working_hours'],
        details,
      };
    }
  } else if (hoursRaw) {
    reasons.push('working_hours_unparsed');
  }

  const providerId = String(service.providerId || user?.id || '');
  if (hasJourneyConflict({ store, service, providerId, atMs: when })) {
    return {
      status: AVAIL.busy,
      eligible: false,
      reasons: ['journey_conflict'],
      details,
    };
  }

  const cap = capacityOk({
    service,
    store,
    request,
    atIso: whenDate.toISOString(),
  });
  details.capacity = cap;
  if (!cap.ok) {
    return {
      status: AVAIL.busy,
      eligible: false,
      reasons: [cap.reason || 'capacity'],
      details,
    };
  }

  // Immediate: prefer currently available; scheduled already checked window/conflict
  const status = flag === AVAIL.available ? AVAIL.available : AVAIL.available;
  if (reasons.length === 0) reasons.push('available');
  return { status, eligible: true, reasons, details };
}

module.exports = {
  AVAIL,
  REJECT_STATUSES,
  evaluateAvailability,
  parseWorkingHours,
  hourInWindow,
  isDeleted,
  isSuspendedOrInactive,
  isTransportation,
  hasJourneyConflict,
  capacityOk,
  explicitAvailabilityFlag,
};
