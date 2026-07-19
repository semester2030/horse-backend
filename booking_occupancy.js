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
 * دمج نقطة موقع من الجسم أو details (يدعم lat/lng أو latitude/longitude).
 */
function coalesceGeoPoint(primary, fallback) {
  const a = primary && typeof primary === 'object' ? primary : null;
  const b = fallback && typeof fallback === 'object' ? fallback : null;
  if (!a && !b) return {};
  const merged = { ...(b || {}), ...(a || {}) };
  const lat = merged.latitude ?? merged.lat;
  const lng = merged.longitude ?? merged.lng ?? merged.lon;
  if (lat != null && merged.latitude == null) merged.latitude = Number(lat);
  if (lng != null && merged.longitude == null) merged.longitude = Number(lng);
  return merged;
}

function hasValidCoordinates(point) {
  if (!point || typeof point !== 'object') return false;
  const lat = Number(point.latitude ?? point.lat);
  const lng = Number(point.longitude ?? point.lng ?? point.lon);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/** مسافة هافرساين بالكيلومتر */
function haversineKm(origin, destination) {
  if (!hasValidCoordinates(origin) || !hasValidCoordinates(destination)) {
    return null;
  }
  const lat1 = Number(origin.latitude ?? origin.lat);
  const lon1 = Number(origin.longitude ?? origin.lng ?? origin.lon);
  const lat2 = Number(destination.latitude ?? destination.lat);
  const lon2 = Number(destination.longitude ?? destination.lng ?? destination.lon);
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/**
 * تقدير سعر النقل إن وُجدت حقول تسعير على الخدمة.
 * pricePerKm / pricePerUnit / basePrice / minimumPrice
 */
function estimateTransportQuote({ service, origin, destination, unitsRequested = 1 }) {
  const distanceKm = haversineKm(origin, destination);
  const units = Math.max(1, Math.floor(Number(unitsRequested) || 1));
  const base = Number(service?.basePrice ?? service?.startingPrice ?? 0);
  const perKm = Number(service?.pricePerKm ?? service?.ratePerKm ?? 0);
  const perUnit = Number(service?.pricePerUnit ?? service?.pricePerHead ?? 0);
  const minimum = Number(service?.minimumPrice ?? service?.minPrice ?? 0);

  let estimatedPrice = null;
  const hasPricing =
    (Number.isFinite(base) && base > 0) ||
    (Number.isFinite(perKm) && perKm > 0) ||
    (Number.isFinite(perUnit) && perUnit > 0);

  if (hasPricing) {
    let total = Number.isFinite(base) && base > 0 ? base : 0;
    if (Number.isFinite(perKm) && perKm > 0 && distanceKm != null) {
      total += perKm * distanceKm;
    }
    if (Number.isFinite(perUnit) && perUnit > 0) {
      total += perUnit * units;
    }
    if (Number.isFinite(minimum) && minimum > 0) {
      total = Math.max(total, minimum);
    }
    estimatedPrice = Math.round(total);
  }

  return {
    distanceKm,
    unitsRequested: units,
    currency: service?.currency || 'SAR',
    estimatedPrice,
    pricingConfigured: hasPricing,
    breakdown: {
      basePrice: Number.isFinite(base) && base > 0 ? base : 0,
      pricePerKm: Number.isFinite(perKm) && perKm > 0 ? perKm : 0,
      pricePerUnit: Number.isFinite(perUnit) && perUnit > 0 ? perUnit : 0,
      minimumPrice: Number.isFinite(minimum) && minimum > 0 ? minimum : 0,
    },
  };
}

/**
 * تطبيع حجز النقل: ملاحظات أعلى المستند + details مكتملة + عناوين + إثراء من الخدمة.
 */
function normalizeTransportationBookingPayload(body, service) {
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
  const serviceName =
    src.serviceName || detailsIn.serviceName || service?.name || '';

  const origin = coalesceGeoPoint(src.origin, detailsIn.origin);
  const destination = coalesceGeoPoint(src.destination, detailsIn.destination);

  if (src.originAddress && !origin.address) origin.address = src.originAddress;
  if (src.destinationAddress && !destination.address) {
    destination.address = src.destinationAddress;
  }

  const bookingDate =
    src.bookingDate ||
    detailsIn.bookingDate ||
    src.startDate ||
    detailsIn.startDate ||
    null;

  const unitsRequested = Math.max(
    1,
    Math.floor(
      Number(
        src.unitsRequested ??
          detailsIn.unitsRequested ??
          detailsIn.headCount ??
          src.headCount ??
          detailsIn.numberOfHorses ??
          src.numberOfHorses ??
          detailsIn.birdCount ??
          src.birdCount ??
          1,
      ) || 1,
    ),
  );

  const quote = estimateTransportQuote({
    service,
    origin,
    destination,
    unitsRequested,
  });

  const details = {
    ...detailsIn,
    origin,
    destination,
    bookingDate,
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
    unitsRequested,
    distanceKm: quote.distanceKm,
    estimatedPrice: quote.estimatedPrice,
    currency: quote.currency,
  };

  return {
    ...src,
    type: 'transportation',
    serviceType: 'transportation',
    serviceId: src.serviceId || service?.id,
    providerId: src.providerId || service?.providerId,
    customerName,
    customerPhone,
    paymentMethod,
    notes,
    serviceName,
    bookingDate,
    startDate: src.startDate || bookingDate,
    unitsRequested,
    status: src.status || 'pending',
    details,
  };
}

/**
 * توفر سعة النقل ليوم أو فترة (وحدات/يوم).
 */
function buildTransportAvailabilityPayload({
  service,
  bookings,
  from,
  to,
  unitsRequested = 1,
}) {
  const start = toDayKey(from);
  const end = toDayKey(to) || start;
  const capacity = fleetCapacity(service);
  const need = Math.max(1, Math.floor(Number(unitsRequested) || 1));
  const days = [];

  if (!start) {
    return {
      serviceId: service?.id,
      type: 'transportation',
      capacity,
      from: null,
      to: null,
      unitsRequested: need,
      canBook: false,
      message: 'تاريخ غير صالح',
      days: [],
    };
  }

  const cur = new Date(`${start}T00:00:00.000Z`);
  const endD = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(endD.getTime())) {
    return {
      serviceId: service?.id,
      type: 'transportation',
      capacity,
      from: start,
      to: end,
      unitsRequested: need,
      canBook: false,
      message: 'تاريخ غير صالح',
      days: [],
    };
  }

  while (cur <= endD) {
    const date = cur.toISOString().slice(0, 10);
    const cap = evaluateTransportCapacity({
      service,
      bookings,
      unitsRequested: need,
      bookingDate: date,
    });
    days.push({
      date,
      capacity: cap.capacity,
      used: cap.used,
      available: cap.available,
      canBook: cap.ok,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const bookableDays = days.filter((d) => d.canBook).length;
  const minAvailable = days.reduce(
    (min, d) => Math.min(min, d.available),
    capacity > 0 ? capacity : 0,
  );

  return {
    serviceId: service?.id,
    type: 'transportation',
    capacity,
    from: start,
    to: end,
    unitsRequested: need,
    minAvailable,
    bookableDays,
    canBook: bookableDays > 0 && capacity > 0,
    message:
      capacity <= 0
        ? 'لا توجد سعة مسجّلة لأسطول هذا الناقل'
        : bookableDays === 0
          ? 'لا تتوفر سعة كافية في هذه الفترة'
          : undefined,
    days,
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
  hasValidCoordinates,
  haversineKm,
  estimateTransportQuote,
  evaluateStableOccupancy,
  evaluateTransportCapacity,
  evaluateVetAvailability,
  buildAvailabilityPayload,
  buildTransportAvailabilityPayload,
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
