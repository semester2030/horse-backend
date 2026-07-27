/**
 * Training vertical — server-side capacity gate.
 */
'use strict';

const { withLock } = require('./vertical_txn_primitives');

const BLOCKING = new Set(['pending', 'confirmed', 'in_progress']);

function isTrainingBooking(b) {
  const t = String(b?.type || b?.serviceType || '')
    .trim()
    .toLowerCase();
  return t === 'training' || t === 'trainer';
}

function findProgram(service, programId) {
  const pid = String(programId || '').trim();
  if (!service || !Array.isArray(service.programs)) return null;
  if (!pid) return service.programs[0] || null;
  return (
    service.programs.find(
      (p) => p && String(p.id || p.programId || '') === pid,
    ) || null
  );
}

function programCapacity(program) {
  if (!program) return null;
  const cap = Number(program.capacity ?? program.maxParticipants ?? program.seats);
  if (!Number.isFinite(cap) || cap < 1) return null;
  return Math.floor(cap);
}

function programRemainingHint(program) {
  if (program?.remaining != null && Number.isFinite(Number(program.remaining))) {
    return Math.floor(Number(program.remaining));
  }
  const cap = programCapacity(program);
  if (cap == null) return null;
  const enrolled = Number(program.enrolled ?? program.booked ?? 0);
  if (Number.isFinite(enrolled)) return Math.max(0, cap - Math.floor(enrolled));
  return cap;
}

function evaluateTrainingCapacity({
  service,
  bookings,
  programId,
  excludeBookingId = null,
}) {
  const lockKey = `training:${service?.id || 'x'}:${programId || '*'}`;
  return withLock(lockKey, () => {
    if (!service) {
      return { ok: false, code: 'SERVICE_MISSING', message: 'خدمة التدريب غير موجودة' };
    }
    const program = findProgram(service, programId);
    if (!program) {
      // No structured programs — allow (compat) but flag
      return { ok: true, skipped: true, reason: 'no_program_catalog' };
    }

    if (
      program.waitlistReady === true ||
      String(program.status || '').toLowerCase() === 'waitlist' ||
      String(program.status || '').toLowerCase() === 'full'
    ) {
      return {
        ok: false,
        code: 'PROGRAM_FULL',
        message: 'لا توجد مقاعد متاحة حاليًا',
      };
    }

    const capacity = programCapacity(program);
    if (capacity == null) {
      return { ok: true, skipped: true, reason: 'no_capacity_field' };
    }

    let used = 0;
    const pid = String(program.id || program.programId || programId || '');
    for (const b of bookings || []) {
      if (!isTrainingBooking(b)) continue;
      if (excludeBookingId && String(b.id) === String(excludeBookingId)) continue;
      if (!BLOCKING.has(String(b.status || 'pending').toLowerCase())) continue;
      if (String(b.serviceId || '') !== String(service.id || '')) continue;
      const d = b.details && typeof b.details === 'object' ? b.details : {};
      const bPid = String(d.programId || b.programId || '');
      if (pid && bPid && bPid !== pid) continue;
      if (pid && !bPid) {
        // legacy booking without programId on same service counts toward capacity
      }
      used += 1;
    }

    if (used >= capacity) {
      return {
        ok: false,
        code: 'CAPACITY_FULL',
        message: 'لا توجد مقاعد متاحة حاليًا',
        capacity,
        used,
      };
    }

    const hint = programRemainingHint(program);
    if (hint != null && hint <= 0 && used >= capacity) {
      return {
        ok: false,
        code: 'CAPACITY_FULL',
        message: 'لا توجد مقاعد متاحة حاليًا',
        capacity,
        used,
      };
    }

    return { ok: true, capacity, used, remaining: capacity - used };
  });
}

module.exports = {
  evaluateTrainingCapacity,
  findProgram,
  isTrainingBooking,
};
