/**
 * Equipment vertical — commercial mode + atomic rental overlap protection.
 * Sale items must not use rental booking semantics.
 */
'use strict';

const { withLock } = require('./vertical_txn_primitives');

const BLOCKING = new Set(['pending', 'confirmed', 'in_progress']);

function toDayKey(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function dayOnlyMs(isoDay) {
  return new Date(`${isoDay}T00:00:00.000Z`).getTime();
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = dayOnlyMs(aStart);
  const ae = dayOnlyMs(aEnd);
  const bs = dayOnlyMs(bStart);
  const be = dayOnlyMs(bEnd);
  return !(ae < bs || be < as);
}

function inventoryLists(service) {
  if (!service || typeof service !== 'object') return [];
  const out = [];
  for (const key of ['inventory', 'equipment', 'items', 'catalog']) {
    if (Array.isArray(service[key])) out.push(service[key]);
  }
  return out;
}

function findEquipmentItem(service, equipmentId) {
  const eid = String(equipmentId || '').trim();
  if (!eid) return null;
  for (const list of inventoryLists(service)) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (String(item.id || item.equipmentId || '') === eid) return item;
    }
  }
  return null;
}

/**
 * @returns {'sale'|'rental'|'sale_or_rental'}
 */
function resolveCommercialMode(item, service) {
  const raw = String(
    item?.commercialMode ||
      item?.offerType ||
      item?.listingMode ||
      service?.commercialMode ||
      service?.offerType ||
      '',
  )
    .trim()
    .toLowerCase();

  if (['sale', 'sell', 'purchase', 'buy'].includes(raw)) return 'sale';
  if (['sale_or_rental', 'both', 'sale_and_rental', 'hybrid'].includes(raw)) {
    return 'sale_or_rental';
  }
  if (['rental', 'rent', 'lease'].includes(raw)) return 'rental';

  if (item?.rental === false && (item?.sale === true || item?.forSale === true)) {
    return 'sale';
  }
  if (item?.sale === false && item?.rental === true) return 'rental';
  if (service?.rental === false && service?.sale !== false) return 'sale';

  // Geo Equipment default: rental platform
  return 'rental';
}

function resolveTransactionKind(body, mode) {
  const requested = String(
    body?.transactionKind || body?.details?.transactionKind || '',
  )
    .trim()
    .toLowerCase();
  if (requested === 'sale' || requested === 'order') return 'sale';
  if (requested === 'rental' || requested === 'rent') return 'rental';
  if (mode === 'sale') return 'sale';
  if (mode === 'rental') return 'rental';
  // sale_or_rental defaults to rental for current Geo Equipment flow
  return 'rental';
}

function itemAvailableQty(item) {
  const n = Number(
    item?.availableQuantity ?? item?.available ?? item?.quantity ?? 0,
  );
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function bookingEquipmentId(b) {
  const d = b?.details && typeof b.details === 'object' ? b.details : {};
  return String(d.equipmentId || b.equipmentId || '').trim();
}

function bookingRange(b) {
  const d = b?.details && typeof b.details === 'object' ? b.details : {};
  const start = toDayKey(b.startDate || d.startDate);
  const end = toDayKey(b.endDate || d.endDate || start);
  return { start, end };
}

function bookingQty(b) {
  const d = b?.details && typeof b.details === 'object' ? b.details : {};
  const n = Number(d.quantity ?? b.quantity ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function isEquipmentBooking(b) {
  const t = String(b?.type || b?.serviceType || '')
    .trim()
    .toLowerCase();
  return t === 'equipment' || t === 'rental';
}

function isBlocking(b, excludeId) {
  if (!b) return false;
  if (excludeId && String(b.id) === String(excludeId)) return false;
  const kind =
    b.transactionKind ||
    (b.details && b.details.transactionKind) ||
    'rental';
  if (String(kind).toLowerCase() === 'sale') return false;
  return BLOCKING.has(String(b.status || 'pending').toLowerCase());
}

function dateBlockedByItem(item, startKey, endKey) {
  const unavailable = Array.isArray(item.unavailableDates)
    ? item.unavailableDates
    : [];
  for (const u of unavailable) {
    const d = toDayKey(u);
    if (!d) continue;
    if (d >= startKey && d <= endKey) {
      return { ok: false, code: 'UNAVAILABLE_DATE', message: 'يوجد يوم غير متاح ضمن فترة التأجير' };
    }
  }
  const periods = Array.isArray(item.maintenancePeriods)
    ? item.maintenancePeriods
    : [];
  for (const p of periods) {
    if (!p || typeof p !== 'object') continue;
    const ps = toDayKey(p.start);
    const pe = toDayKey(p.end || p.start);
    if (!ps || !pe) continue;
    if (rangesOverlap(startKey, endKey, ps, pe)) {
      return {
        ok: false,
        code: 'MAINTENANCE',
        message: 'الفترة تتقاطع مع صيانة مجدولة',
      };
    }
  }
  if (item.underMaintenance === true || item.maintenance === true) {
    return { ok: false, code: 'MAINTENANCE', message: 'المعدة قيد الصيانة حالياً' };
  }
  return { ok: true };
}

/**
 * Atomic rental evaluation + soft reservation via booking record only
 * (quantity held by summing overlapping blocking rentals).
 */
function evaluateAndAuthorizeEquipmentRental({
  service,
  bookings,
  equipmentId,
  startDate,
  endDate,
  quantity,
  body,
  excludeBookingId = null,
}) {
  const lockKey = `equipment:${service?.id || 'x'}:${equipmentId}`;
  return withLock(lockKey, () => {
    const item = findEquipmentItem(service, equipmentId);
    if (!item) {
      return {
        ok: false,
        code: 'ITEM_NOT_FOUND',
        message: 'المعدة غير موجودة لدى المزوّد',
      };
    }
    if (item.active === false) {
      return { ok: false, code: 'INACTIVE', message: 'المعدة غير نشطة' };
    }

    const mode = resolveCommercialMode(item, service);
    const txn = resolveTransactionKind(body || {}, mode);

    if (txn === 'sale') {
      if (mode === 'rental') {
        return {
          ok: false,
          code: 'SALE_NOT_ALLOWED',
          message: 'هذه المعدة للتأجير فقط',
        };
      }
      // Sale path: not a rental — caller should not apply rental overlap.
      return {
        ok: true,
        commercialMode: mode,
        transactionKind: 'sale',
        skipRentalGate: true,
      };
    }

    // Rental path
    if (mode === 'sale') {
      return {
        ok: false,
        code: 'RENTAL_NOT_ALLOWED',
        message: 'هذه المعدة للبيع فقط — لا يُطبق منطق التأجير',
      };
    }

    const startKey = toDayKey(startDate);
    const endKey = toDayKey(endDate || startDate);
    if (!startKey || !endKey) {
      return { ok: false, code: 'BAD_DATES', message: 'تواريخ التأجير غير صالحة' };
    }
    if (endKey < startKey) {
      return {
        ok: false,
        code: 'BAD_DATES',
        message: 'تاريخ النهاية يجب أن يكون بعد البداية',
      };
    }

    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty < 1) {
      return { ok: false, code: 'INVALID_QTY', message: 'كمية غير صالحة' };
    }

    const block = dateBlockedByItem(item, startKey, endKey);
    if (!block.ok) return block;

    const capacity = itemAvailableQty(item);
    if (capacity < 1) {
      return { ok: false, code: 'NO_STOCK', message: 'لا توجد وحدات متاحة للتأجير' };
    }

    let used = 0;
    for (const b of bookings || []) {
      if (!isEquipmentBooking(b)) continue;
      if (!isBlocking(b, excludeBookingId)) continue;
      if (bookingEquipmentId(b) !== String(equipmentId)) continue;
      if (String(b.serviceId || '') !== String(service.id || '')) continue;
      const { start, end } = bookingRange(b);
      if (!start || !end) continue;
      if (!rangesOverlap(startKey, endKey, start, end)) continue;
      used += bookingQty(b);
    }

    if (used + qty > capacity) {
      return {
        ok: false,
        code: 'RENTAL_CONFLICT',
        message: `التعارض في الفترة أو الكمية (المتاح ${Math.max(0, capacity - used)})`,
        capacity,
        used,
      };
    }

    return {
      ok: true,
      commercialMode: mode,
      transactionKind: 'rental',
      capacity,
      used,
      remaining: capacity - used - qty,
    };
  });
}

module.exports = {
  resolveCommercialMode,
  resolveTransactionKind,
  findEquipmentItem,
  evaluateAndAuthorizeEquipmentRental,
  toDayKey,
  rangesOverlap,
};
