/**
 * محرك أتمتة الحجوزات: إشغال إيواء + سعة نقل + تعارض عيادات + انتقالات حالة + انتهاء معلّق.
 * لا يكرر مسارات الحجوزات؛ يُستدعى من POST/PATCH /bookings و availability.
 */

'use strict';

const BLOCKING_STATUSES = new Set(['pending', 'confirmed', 'in_progress']);

/** مزوّد */
const PROVIDER_BOOKING_TRANSITIONS = {
  pending: ['confirmed', 'cancelled', 'rejected'],
  confirmed: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
};

/** عميل: إلغاء فقط من حالات مبكرة */
const CUSTOMER_CANCEL_FROM = new Set(['pending', 'confirmed']);

/** انتهاء حجز معلّق (ساعة) */
const PENDING_EXPIRE_HOURS = 48;

/** انتهاء طلب خبير مفتوح (ساعة) */
const EXPERT_REQUEST_EXPIRE_HOURS = 72;

const LISTING_STATUS_TRANSITIONS = {
  available: ['reserved', 'sold', 'removed', 'inactive'],
  reserved: ['available', 'sold', 'removed'],
  sold: ['available', 'removed'],
  removed: ['available'],
  inactive: ['available', 'removed'],
};

function bookingKind(booking) {
  return String(booking?.type || booking?.serviceType || '')
    .trim()
    .toLowerCase();
}

function isStableBooking(booking) {
  return bookingKind(booking) === 'stable';
}

function toDayKey(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * أيام الإقامة: من البداية inclusive إلى النهاية exclusive (ليلة المغادرة لا تُحسب).
 * إن تساوى اليومان → يوم واحد.
 */
function stayDayKeys(startIso, endIso) {
  const start = toDayKey(startIso);
  const end = toDayKey(endIso);
  if (!start) return [];
  const keys = [];
  const cur = new Date(`${start}T00:00:00.000Z`);
  const endD = end
    ? new Date(`${end}T00:00:00.000Z`)
    : new Date(`${start}T00:00:00.000Z`);
  if (!(endD > cur)) {
    keys.push(start);
    return keys;
  }
  while (cur < endD) {
    keys.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return keys;
}

function readRange(booking) {
  const details =
    booking?.details && typeof booking.details === 'object' ? booking.details : {};
  const start = booking?.startDate || details.startDate || booking?.bookingDate;
  const end = booking?.endDate || details.endDate || start;
  return { start, end };
}

function spacesRequestedOf(booking) {
  const details =
    booking?.details && typeof booking.details === 'object' ? booking.details : {};
  const raw = booking?.spacesRequested ?? details.spacesRequested ?? 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function serviceCapacity(service) {
  if (!service || typeof service !== 'object') return 0;
  const candidates = [
    service.totalSpaces,
    service.totalCapacity,
    service.availableSpaces,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

function isBlocking(booking, excludeBookingId) {
  if (!booking) return false;
  if (excludeBookingId && String(booking.id) === String(excludeBookingId)) {
    return false;
  }
  const status = String(booking.status || 'pending').toLowerCase();
  return BLOCKING_STATUSES.has(status);
}

/**
 * أعلى إشغال يومي ضمن الفترة المطلوبة (بعد إضافة المساحات المطلوبة).
 * @returns {{ ok: boolean, totalSpaces: number, minAvailable: number, peakUsed: number, days: Array<{date:string,used:number,available:number}> , message?: string }}
 */
function evaluateStableOccupancy({
  service,
  bookings,
  startDate,
  endDate,
  spacesRequested = 1,
  excludeBookingId = null,
}) {
  const totalSpaces = serviceCapacity(service);
  const need = Math.max(1, Math.floor(Number(spacesRequested) || 1));
  const daysWanted = stayDayKeys(startDate, endDate);

  if (!startDate || daysWanted.length === 0) {
    return {
      ok: false,
      totalSpaces,
      minAvailable: 0,
      peakUsed: 0,
      days: [],
      message: 'تواريخ الإيواء غير صالحة',
    };
  }

  if (totalSpaces <= 0) {
    return {
      ok: false,
      totalSpaces: 0,
      minAvailable: 0,
      peakUsed: 0,
      days: daysWanted.map((date) => ({ date, used: 0, available: 0 })),
      message: 'لا توجد سعة مسجّلة لهذا المرفق',
    };
  }

  const usedByDay = Object.create(null);
  for (const day of daysWanted) usedByDay[day] = 0;

  for (const b of bookings || []) {
    if (!isStableBooking(b)) continue;
    if (!isBlocking(b, excludeBookingId)) continue;
    if (String(b.serviceId || '') !== String(service.id || '')) continue;
    const { start, end } = readRange(b);
    const occupied = stayDayKeys(start, end);
    const spaces = spacesRequestedOf(b);
    for (const day of occupied) {
      if (Object.prototype.hasOwnProperty.call(usedByDay, day)) {
        usedByDay[day] += spaces;
      }
    }
  }

  const days = daysWanted.map((date) => {
    const used = usedByDay[date] || 0;
    return { date, used, available: Math.max(0, totalSpaces - used) };
  });

  const minAvailable = days.reduce(
    (min, d) => Math.min(min, d.available),
    totalSpaces,
  );
  const peakUsed = days.reduce((max, d) => Math.max(max, d.used), 0);
  const ok = minAvailable >= need;

  return {
    ok,
    totalSpaces,
    minAvailable,
    peakUsed,
    days,
    message: ok
      ? undefined
      : minAvailable <= 0
        ? 'هذه الفترة مكتملة الحجز — اختر تواريخ أخرى'
        : `المتاح لهذه الفترة ${minAvailable} مكان فقط (مطلوب ${need})`,
  };
}

function buildAvailabilityPayload({ service, bookings, from, to }) {
  const result = evaluateStableOccupancy({
    service,
    bookings,
    startDate: from,
    endDate: to,
    spacesRequested: 1,
  });
  return {
    serviceId: service?.id,
    totalSpaces: result.totalSpaces,
    from: toDayKey(from),
    to: toDayKey(to),
    minAvailable: result.minAvailable,
    peakUsed: result.peakUsed,
    canBook: result.ok && result.totalSpaces > 0,
    message: result.message,
    days: result.days,
  };
}

/**
 * تطبيع حجز إيواء + إثراء من سجل الخدمة (مدينة/عنوان/اسم) دون حذف حقول العميل.
 */
function normalizeStableBookingPayload(body, service) {
  const src = body && typeof body === 'object' ? body : {};
  const detailsIn =
    src.details && typeof src.details === 'object' ? { ...src.details } : {};

  const startDate = src.startDate || detailsIn.startDate;
  const endDate = src.endDate || detailsIn.endDate;
  const spacesRequested = Math.max(
    1,
    Math.floor(Number(src.spacesRequested ?? detailsIn.spacesRequested ?? 1) || 1),
  );

  const city =
    src.city ||
    detailsIn.city ||
    service?.city ||
    (Array.isArray(service?.serviceAreas) && service.serviceAreas[0]
      ? String(service.serviceAreas[0])
      : '') ||
    '';

  const address =
    src.address ||
    detailsIn.address ||
    src.fullAddress ||
    service?.fullAddress ||
    service?.address ||
    '';

  const paymentMethod = String(
    src.paymentMethod || detailsIn.paymentMethod || 'cash',
  )
    .trim()
    .toLowerCase();

  const serviceName =
    src.serviceName || detailsIn.serviceName || service?.name || '';

  const customerName = src.customerName || detailsIn.customerName || '';
  const customerPhone = src.customerPhone || detailsIn.customerPhone || '';

  const details = {
    ...detailsIn,
    startDate,
    endDate,
    spacesRequested,
    customerName,
    customerPhone,
    paymentMethod,
    city,
    address,
    serviceName,
  };

  return {
    ...src,
    type: 'stable',
    serviceType: 'stable',
    serviceId: src.serviceId || service?.id,
    providerId: src.providerId || service?.providerId,
    serviceName,
    startDate,
    endDate,
    bookingDate: src.bookingDate || startDate,
    spacesRequested,
    customerName,
    customerPhone,
    paymentMethod,
    city,
    address,
    status: src.status || 'pending',
    details,
  };
}

/**
 * تطبيع حجز النقل: ملاحظات أعلى المستند + details مكتملة + عناوين.
 */
function normalizeTransportationBookingPayload(body) {
  const src = body && typeof body === 'object' ? body : {};
  const detailsIn =
    src.details && typeof src.details === 'object' ? { ...src.details } : {};

  const customerName = src.customerName || detailsIn.customerName || '';
  const customerPhone = src.customerPhone || detailsIn.customerPhone || '';
  const paymentMethod = String(
    src.paymentMethod || detailsIn.paymentMethod || 'cash',
  )
    .trim()
    .toLowerCase();
  const notes = src.notes || detailsIn.notes || '';
  const serviceName = src.serviceName || detailsIn.serviceName || '';

  const origin = detailsIn.origin && typeof detailsIn.origin === 'object'
    ? { ...detailsIn.origin }
    : {};
  const destination =
    detailsIn.destination && typeof detailsIn.destination === 'object'
      ? { ...detailsIn.destination }
      : {};

  if (src.originAddress && !origin.address) origin.address = src.originAddress;
  if (src.destinationAddress && !destination.address) {
    destination.address = src.destinationAddress;
  }

  const details = {
    ...detailsIn,
    origin,
    destination,
    customerName,
    customerPhone,
    paymentMethod,
    notes,
    serviceName,
    horseType: detailsIn.horseType || src.horseType,
    numberOfHorses: detailsIn.numberOfHorses ?? src.numberOfHorses,
    headCount: detailsIn.headCount ?? src.headCount,
    birdCount: detailsIn.birdCount ?? src.birdCount,
    camelAgeGrade: detailsIn.camelAgeGrade || src.camelAgeGrade,
    camelTransportMode: detailsIn.camelTransportMode || src.camelTransportMode,
    falconCarrierType: detailsIn.falconCarrierType || src.falconCarrierType,
    species: detailsIn.species || src.species,
    unitsRequested:
      detailsIn.unitsRequested ||
      src.unitsRequested ||
      detailsIn.headCount ||
      detailsIn.numberOfHorses ||
      detailsIn.birdCount ||
      1,
  };

  return {
    ...src,
    type: 'transportation',
    serviceType: 'transportation',
    customerName,
    customerPhone,
    paymentMethod,
    notes,
    serviceName,
    details,
  };
}

function bookingTypeOf(booking) {
  return String(booking?.type || booking?.serviceType || '')
    .trim()
    .toLowerCase();
}

function isTransportBooking(booking) {
  const t = bookingTypeOf(booking);
  return t === 'transportation' || t === 'transport';
}

function isVetBooking(booking) {
  const t = bookingTypeOf(booking);
  return t === 'veterinary' || t === 'vet';
}

function unitsRequestedOf(booking) {
  const details =
    booking?.details && typeof booking.details === 'object' ? booking.details : {};
  const raw =
    booking?.unitsRequested ??
    details.unitsRequested ??
    details.headCount ??
    details.numberOfHorses ??
    details.birdCount ??
    1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function fleetCapacity(service) {
  if (!service || typeof service !== 'object') return 0;
  const per = Number(service.capacityPerVehicle ?? service.capacityPerTrip ?? 0);
  const vehicles = Number(service.numberOfVehicles ?? service.fleetSize ?? 1);
  const total = Number(service.totalCapacity ?? service.maxUnitsPerDay ?? 0);
  if (Number.isFinite(total) && total > 0) return Math.floor(total);
  const p = Number.isFinite(per) && per > 0 ? Math.floor(per) : 0;
  const v = Number.isFinite(vehicles) && vehicles > 0 ? Math.floor(vehicles) : 1;
  return p * v;
}

function bookingDayKey(booking) {
  const details =
    booking?.details && typeof booking.details === 'object' ? booking.details : {};
  return (
    toDayKey(booking?.bookingDate) ||
    toDayKey(details.bookingDate) ||
    toDayKey(booking?.startDate) ||
    toDayKey(details.startDate)
  );
}

/**
 * سعة أسطول النقل لنفس اليوم (وحدات).
 */
function evaluateTransportCapacity({
  service,
  bookings,
  unitsRequested = 1,
  bookingDate,
  excludeBookingId = null,
}) {
  const capacity = fleetCapacity(service);
  const need = Math.max(1, Math.floor(Number(unitsRequested) || 1));
  const day = toDayKey(bookingDate);
  if (!day) {
    return {
      ok: false,
      capacity,
      used: 0,
      available: 0,
      message: 'تاريخ النقل مطلوب',
    };
  }
  if (capacity <= 0) {
    return {
      ok: false,
      capacity: 0,
      used: 0,
      available: 0,
      message: 'لا توجد سعة مسجّلة لأسطول هذا الناقل',
    };
  }
  let used = 0;
  for (const b of bookings || []) {
    if (!isTransportBooking(b)) continue;
    if (!isBlocking(b, excludeBookingId)) continue;
    if (String(b.serviceId || '') !== String(service?.id || '')) continue;
    if (bookingDayKey(b) !== day) continue;
    used += unitsRequestedOf(b);
  }
  const available = Math.max(0, capacity - used);
  const ok = available >= need;
  return {
    ok,
    capacity,
    used,
    available,
    message: ok
      ? undefined
      : available <= 0
        ? 'سعة النقل ممتلئة لهذا اليوم'
        : `المتاح ${available} وحدة فقط (مطلوب ${need})`,
  };
}

function appointmentSlotOf(booking) {
  const details =
    booking?.details && typeof booking.details === 'object' ? booking.details : {};
  const raw =
    booking?.appointmentTime ||
    details.appointmentTime ||
    booking?.timeSlot ||
    details.timeSlot ||
    '';
  return String(raw).trim().toLowerCase();
}

function maxAppointmentsPerDay(service) {
  const n = Number(
    service?.maxAppointmentsPerDay ?? service?.dailySlots ?? service?.maxBookingsPerDay,
  );
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 12;
}

/**
 * تعارض مواعيد العيادة: نفس اليوم + نفس الوقت إن وُجد، أو سقف يومي.
 */
function evaluateVetAvailability({
  service,
  bookings,
  bookingDate,
  appointmentTime,
  excludeBookingId = null,
}) {
  const day = toDayKey(bookingDate);
  if (!day) {
    return { ok: false, message: 'تاريخ الموعد مطلوب' };
  }
  const slot = String(appointmentTime || '')
    .trim()
    .toLowerCase();
  const max = maxAppointmentsPerDay(service);
  let sameDay = 0;
  for (const b of bookings || []) {
    if (!isVetBooking(b)) continue;
    if (!isBlocking(b, excludeBookingId)) continue;
    if (String(b.serviceId || '') !== String(service?.id || '')) continue;
    if (bookingDayKey(b) !== day) continue;
    sameDay += 1;
    if (slot && appointmentSlotOf(b) === slot) {
      return {
        ok: false,
        message: 'هذا الموعد محجوز — اختر وقتاً آخر',
        code: 'SLOT_TAKEN',
      };
    }
  }
  if (sameDay >= max) {
    return {
      ok: false,
      message: `اكتمل جدول العيادة لهذا اليوم (حد ${max} مواعيد)`,
      code: 'DAY_FULL',
    };
  }
  return { ok: true, sameDay, max };
}

function canProviderBookingTransition(from, to) {
  const allowed = PROVIDER_BOOKING_TRANSITIONS[String(from || '')] || [];
  return allowed.includes(String(to || ''));
}

function canCustomerCancelBooking(from) {
  return CUSTOMER_CANCEL_FROM.has(String(from || ''));
}

/**
 * يغيّر الحجوزات المعلّقة الأقدم من العتبة إلى expired.
 * @returns {number} عدد المحدَّث
 */
function expireStalePendingBookings(bookingsMap, hours = PENDING_EXPIRE_HOURS) {
  const cutoff = Date.now() - Math.max(1, hours) * 3600 * 1000;
  let n = 0;
  for (const [bid, b] of bookingsMap.entries()) {
    if (String(b.status || '') !== 'pending') continue;
    const t = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (!t || t > cutoff) continue;
    bookingsMap.set(bid, {
      ...b,
      status: 'expired',
      updatedAt: new Date().toISOString(),
      expiredAt: new Date().toISOString(),
    });
    n += 1;
  }
  return n;
}

function expireStaleExpertRequests(requestsMap, hours = EXPERT_REQUEST_EXPIRE_HOURS) {
  const cutoff = Date.now() - Math.max(1, hours) * 3600 * 1000;
  let n = 0;
  for (const [rid, r] of requestsMap.entries()) {
    if (String(r.status || '') !== 'open') continue;
    const t = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    if (!t || t > cutoff) continue;
    requestsMap.set(rid, {
      ...r,
      status: 'expired',
      updatedAt: new Date().toISOString(),
      expiredAt: new Date().toISOString(),
    });
    n += 1;
  }
  return n;
}

function listingStatusOf(listing) {
  const s = String(listing?.listingStatus || listing?.status || 'available')
    .trim()
    .toLowerCase();
  if (LISTING_STATUS_TRANSITIONS[s]) return s;
  if (s === 'active' || s === '' || s === 'published') return 'available';
  return 'available';
}

function canListingStatusTransition(from, to) {
  const allowed = LISTING_STATUS_TRANSITIONS[String(from || 'available')] || [];
  return allowed.includes(String(to || ''));
}

function isListingPubliclyVisible(listing) {
  const s = listingStatusOf(listing);
  return s === 'available' || s === 'reserved' || s === 'sold';
}

module.exports = {
  BLOCKING_STATUSES,
  PROVIDER_BOOKING_TRANSITIONS,
  PENDING_EXPIRE_HOURS,
  EXPERT_REQUEST_EXPIRE_HOURS,
  isStableBooking,
  isTransportBooking,
  isVetBooking,
  stayDayKeys,
  toDayKey,
  serviceCapacity,
  fleetCapacity,
  unitsRequestedOf,
  evaluateStableOccupancy,
  evaluateTransportCapacity,
  evaluateVetAvailability,
  buildAvailabilityPayload,
  normalizeStableBookingPayload,
  normalizeTransportationBookingPayload,
  canProviderBookingTransition,
  canCustomerCancelBooking,
  expireStalePendingBookings,
  expireStaleExpertRequests,
  listingStatusOf,
  canListingStatusTransition,
  isListingPubliclyVisible,
};
