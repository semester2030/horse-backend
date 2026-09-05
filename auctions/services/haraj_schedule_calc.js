'use strict';

/**
 * Pure G6 occurrence calculator. No I/O. Backend-authoritative.
 * Recurrence names match 009: daily | every_n_days | selected_weekdays | weekly | monthly | one_time | custom_rrule
 * Weekdays: 0=Sunday … 6=Saturday (G1).
 * effectiveUntil is inclusive of the local calendar date.
 */

const DEFAULT_TZ = 'Asia/Riyadh';
const RECURRENCES = [
  'daily',
  'every_n_days',
  'selected_weekdays',
  'weekly',
  'monthly',
  'one_time',
  'custom_rrule',
];
const WEEKDAY_NAME = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function fail(code, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  throw err;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function assertTimezone(tz) {
  const value = String(tz || DEFAULT_TZ).trim() || DEFAULT_TZ;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    fail('HARAJ_TIMEZONE_INVALID', 'Timezone must be a valid IANA name');
  }
  return value;
}

function parseHm(value, field) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) fail('HARAJ_TIME_INVALID', `${field} must be HH:MM or HH:MM:SS`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3] || 0);
  if (h > 23 || min > 59 || s > 59) fail('HARAJ_TIME_INVALID', `${field} is out of range`);
  return `${pad(h)}:${pad(min)}:${pad(s)}`;
}

function parseDateOnly(value, field) {
  const raw = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    fail('HARAJ_DATE_INVALID', `${field} must be YYYY-MM-DD`);
  }
  const [y, mo, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    fail('HARAJ_DATE_INVALID', `${field} is not a real calendar date`);
  }
  return raw;
}

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function addMonthsClamped(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const total = y * 12 + (mo - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

function weekdayUtcDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function isoWeekStart(dateStr) {
  const wd = weekdayUtcDate(dateStr);
  return addDays(dateStr, -wd);
}

function weeksBetween(a, b) {
  const startA = isoWeekStart(a);
  const startB = isoWeekStart(b);
  const [ay, amo, ad] = startA.split('-').map(Number);
  const [by, bmo, bd] = startB.split('-').map(Number);
  const diff = (Date.UTC(by, bmo - 1, bd) - Date.UTC(ay, amo - 1, ad)) / 86400000;
  return Math.round(diff / 7);
}

function daysBetween(a, b) {
  const [ay, amo, ad] = a.split('-').map(Number);
  const [by, bmo, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bmo - 1, bd) - Date.UTC(ay, amo - 1, ad)) / 86400000);
}

function tzOffsetMs(instant, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

function localWallToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi, s] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let instant = guess - tzOffsetMs(new Date(guess), tz);
  instant = guess - tzOffsetMs(new Date(instant), tz);
  return new Date(instant);
}

function datePartsInTz(instant, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(instant);
}

function normalizeDays(days) {
  if (days == null) return null;
  const list = (Array.isArray(days) ? days : String(days).split(','))
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isInteger(n));
  if (!list.length) fail('HARAJ_WEEKDAY_INVALID', 'daysOfWeek is required');
  if (list.some((n) => n < 0 || n > 6)) fail('HARAJ_WEEKDAY_INVALID', 'Weekdays must be 0=Sun … 6=Sat');
  return [...new Set(list)].sort((a, b) => a - b);
}

function parseCustomRrule(rrule) {
  const raw = String(rrule || '').trim();
  if (!raw) fail('HARAJ_RRULE_INVALID', 'custom_rrule is required');
  const body = raw.replace(/^RRULE:/i, '');
  const parts = {};
  for (const token of body.split(';')) {
    const [k, v] = token.split('=');
    if (k && v) parts[k.toUpperCase()] = v;
  }
  const freq = String(parts.FREQ || '').toUpperCase();
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) {
    fail('HARAJ_RRULE_UNSUPPORTED', 'RRULE INTERVAL must be an integer >= 1');
  }
  if (freq === 'DAILY') {
    return interval === 1
      ? { recurrence: 'daily', recurrenceInterval: null, daysOfWeek: null }
      : { recurrence: 'every_n_days', recurrenceInterval: interval, daysOfWeek: null };
  }
  if (freq === 'WEEKLY') {
    const byday = String(parts.BYDAY || '')
      .split(',')
      .map((x) => WEEKDAY_NAME[x.trim().toUpperCase()])
      .filter((n) => n != null);
    if (!byday.length) fail('HARAJ_RRULE_UNSUPPORTED', 'WEEKLY RRULE requires BYDAY');
    return {
      recurrence: interval > 1 ? 'weekly' : 'selected_weekdays',
      recurrenceInterval: interval > 1 ? interval : null,
      daysOfWeek: [...new Set(byday)].sort((a, b) => a - b),
    };
  }
  if (freq === 'MONTHLY') {
    return { recurrence: 'monthly', recurrenceInterval: interval, daysOfWeek: null };
  }
  fail('HARAJ_RRULE_UNSUPPORTED', 'Only FREQ=DAILY|WEEKLY|MONTHLY RRULEs are supported');
}

function normalizePolicy(input) {
  const tz = assertTimezone(input.timezone);
  let recurrence = String(input.recurrence || '').trim().toLowerCase();
  if (recurrence === 'weekdays') recurrence = 'selected_weekdays';
  if (!RECURRENCES.includes(recurrence)) {
    fail('HARAJ_RECURRENCE_INVALID', 'Unsupported recurrence type');
  }
  let interval = input.recurrenceInterval != null ? Number(input.recurrenceInterval) : null;
  let days = input.daysOfWeek != null ? normalizeDays(input.daysOfWeek) : null;
  if (recurrence === 'custom_rrule') {
    const mapped = parseCustomRrule(input.customRrule || input.custom_rrule);
    recurrence = mapped.recurrence;
    interval = mapped.recurrenceInterval;
    days = mapped.daysOfWeek;
  }
  if (recurrence === 'every_n_days') {
    if (!Number.isInteger(interval) || interval < 1) {
      fail('HARAJ_INTERVAL_INVALID', 'every_n_days requires recurrenceInterval >= 1');
    }
  }
  if (recurrence === 'weekly') {
    days = normalizeDays(days);
    if (interval != null && (!Number.isInteger(interval) || interval < 1)) {
      fail('HARAJ_INTERVAL_INVALID', 'weekly interval must be >= 1');
    }
    interval = interval || 1;
  }
  if (recurrence === 'selected_weekdays') {
    days = normalizeDays(days);
    interval = null;
  }
  if (recurrence === 'monthly') {
    interval = interval && interval >= 1 ? interval : 1;
  }
  const startTime = parseHm(input.startTimeLocal || input.startTime || input.start_time_local, 'startTime');
  const endTime = parseHm(input.endTimeLocal || input.endTime || input.end_time_local, 'endTime');
  const effectiveFrom = parseDateOnly(input.effectiveFrom || input.effective_from, 'effectiveFrom');
  const effectiveUntil = input.effectiveUntil || input.effective_until
    ? parseDateOnly(input.effectiveUntil || input.effective_until, 'effectiveUntil')
    : null;
  if (effectiveUntil && effectiveUntil < effectiveFrom) {
    fail('HARAJ_EFFECTIVE_PERIOD_INVALID', 'effectiveUntil must be on or after effectiveFrom');
  }
  let oneTimeDate = null;
  if (recurrence === 'one_time') {
    oneTimeDate = parseDateOnly(input.oneTimeDate || input.one_time_date, 'oneTimeDate');
  }
  return {
    recurrence,
    recurrenceInterval: interval,
    daysOfWeek: days,
    startTimeLocal: startTime,
    endTimeLocal: endTime,
    timezone: tz,
    effectiveFrom,
    effectiveUntil,
    oneTimeDate,
    overnight: endTime <= startTime,
  };
}

function windowForDate(dateStr, policy) {
  const start = localWallToUtc(dateStr, policy.startTimeLocal, policy.timezone);
  const endDate = policy.overnight ? addDays(dateStr, 1) : dateStr;
  const end = localWallToUtc(endDate, policy.endTimeLocal, policy.timezone);
  if (!(end > start)) {
    fail('HARAJ_TIME_RANGE_INVALID', 'Session end must be after start');
  }
  return { start, end };
}

function inEffectivePeriod(dateStr, policy) {
  if (dateStr < policy.effectiveFrom) return false;
  if (policy.effectiveUntil && dateStr > policy.effectiveUntil) return false;
  return true;
}

function enumerateDates(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function matchesRecurrence(dateStr, policy) {
  if (!inEffectivePeriod(dateStr, policy)) return false;
  const wd = weekdayUtcDate(dateStr);
  switch (policy.recurrence) {
    case 'one_time':
      return dateStr === policy.oneTimeDate;
    case 'daily':
      return true;
    case 'every_n_days': {
      const delta = daysBetween(policy.effectiveFrom, dateStr);
      return delta >= 0 && delta % policy.recurrenceInterval === 0;
    }
    case 'selected_weekdays':
      return policy.daysOfWeek.includes(wd);
    case 'weekly': {
      if (!policy.daysOfWeek.includes(wd)) return false;
      const w = weeksBetween(policy.effectiveFrom, dateStr);
      return w >= 0 && w % (policy.recurrenceInterval || 1) === 0;
    }
    case 'monthly': {
      const [ey, em] = policy.effectiveFrom.split('-').map(Number);
      const [y, m] = dateStr.split('-').map(Number);
      const months = (y - ey) * 12 + (m - em);
      if (months < 0 || months % (policy.recurrenceInterval || 1) !== 0) return false;
      return dateStr === addMonthsClamped(policy.effectiveFrom, months);
    }
    default:
      return false;
  }
}

function calculateOccurrences(input, rangeStart, rangeEnd) {
  const policy = normalizePolicy(input);
  const start = rangeStart instanceof Date ? rangeStart : new Date(rangeStart);
  const end = rangeEnd instanceof Date ? rangeEnd : new Date(rangeEnd);
  if (!(end > start)) fail('HARAJ_TIME_RANGE_INVALID', 'Calculation range end must be after start');

  const fromDate = datePartsInTz(start, policy.timezone);
  const toDate = datePartsInTz(new Date(end.getTime() + 36 * 3600000), policy.timezone);
  const scanFrom = fromDate < policy.effectiveFrom ? policy.effectiveFrom : addDays(fromDate, -1);
  const scanTo = policy.effectiveUntil && policy.effectiveUntil < toDate ? policy.effectiveUntil : toDate;

  const out = [];
  if (policy.recurrence === 'one_time') {
    if (matchesRecurrence(policy.oneTimeDate, policy)) {
      const win = windowForDate(policy.oneTimeDate, policy);
      if (win.start < end && win.end > start) {
        out.push({
          localDate: policy.oneTimeDate,
          startAt: win.start,
          endAt: win.end,
          timezone: policy.timezone,
          occurrenceKey: `${policy.oneTimeDate}T${policy.startTimeLocal}`,
        });
      }
    }
    return out;
  }

  for (const dateStr of enumerateDates(scanFrom, scanTo)) {
    if (!matchesRecurrence(dateStr, policy)) continue;
    const win = windowForDate(dateStr, policy);
    if (win.start >= end || win.end <= start) continue;
    out.push({
      localDate: dateStr,
      startAt: win.start,
      endAt: win.end,
      timezone: policy.timezone,
      occurrenceKey: `${dateStr}T${policy.startTimeLocal}`,
    });
  }
  return out;
}

function horizonRange(clock, horizonDays, tz) {
  const days = Number(horizonDays);
  const n = Number.isFinite(days) && days >= 1 ? Math.min(Math.floor(days), 30) : 14;
  const now = clock.now();
  const zone = assertTimezone(tz || DEFAULT_TZ);
  const today = datePartsInTz(now, zone);
  const start = localWallToUtc(today, '00:00:00', zone);
  const endDate = addDays(today, n);
  const end = localWallToUtc(endDate, '00:00:00', zone);
  return { start, end, horizonDays: n, timezone: zone };
}

module.exports = {
  DEFAULT_TZ,
  RECURRENCES,
  fail,
  assertTimezone,
  parseHm,
  parseDateOnly,
  addDays,
  addMonthsClamped,
  weekdayUtcDate,
  localWallToUtc,
  datePartsInTz,
  normalizePolicy,
  calculateOccurrences,
  horizonRange,
  parseCustomRrule,
  inEffectivePeriod,
  daysBetween,
};
