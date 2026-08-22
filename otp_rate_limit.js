/**
 * OTP send/verify rate limiting + attempt lockout (in-memory).
 * Single-instance only — same constraint as JSON store.
 */

const SEND_WINDOW_MS = 15 * 60 * 1000;
const SEND_MAX_PER_PHONE = 5;
const SEND_MAX_PER_IP = 20;
const VERIFY_MAX_FAILS = 5;
const VERIFY_LOCK_MS = 15 * 60 * 1000;

const sendByPhone = new Map();
const sendByIp = new Map();
const verifyFails = new Map();

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || req.socket?.remoteAddress || 'unknown';
}

function bump(map, key, windowMs) {
  const now = Date.now();
  let e = map.get(key);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + windowMs };
  }
  e.count += 1;
  map.set(key, e);
  return e;
}

function checkOtpSend(req, phone) {
  const ip = clientIp(req);
  const byPhone = bump(sendByPhone, phone, SEND_WINDOW_MS);
  if (byPhone.count > SEND_MAX_PER_PHONE) {
    return {
      ok: false,
      status: 429,
      message: 'تم تجاوز حد إرسال رمز التحقق لهذا الرقم. حاول لاحقاً.',
      code: 'OTP_SEND_RATE_PHONE',
    };
  }
  const byIp = bump(sendByIp, ip, SEND_WINDOW_MS);
  if (byIp.count > SEND_MAX_PER_IP) {
    return {
      ok: false,
      status: 429,
      message: 'تم تجاوز حد إرسال رمز التحقق. حاول لاحقاً.',
      code: 'OTP_SEND_RATE_IP',
    };
  }
  return { ok: true };
}

function checkOtpVerifyAllowed(phone) {
  const now = Date.now();
  const e = verifyFails.get(phone);
  if (e && e.lockedUntil && e.lockedUntil > now) {
    return {
      ok: false,
      status: 429,
      message: 'تم قفل التحقق مؤقتاً بعد محاولات فاشلة. حاول لاحقاً.',
      code: 'OTP_VERIFY_LOCKED',
    };
  }
  return { ok: true };
}

function recordOtpVerifyFailure(phone) {
  const now = Date.now();
  let e = verifyFails.get(phone);
  if (!e || (e.lockedUntil && e.lockedUntil <= now)) {
    e = { fails: 0, lockedUntil: 0 };
  }
  e.fails += 1;
  if (e.fails >= VERIFY_MAX_FAILS) {
    e.lockedUntil = now + VERIFY_LOCK_MS;
    e.fails = 0;
  }
  verifyFails.set(phone, e);
}

function clearOtpVerifyFailures(phone) {
  verifyFails.delete(phone);
}

module.exports = {
  checkOtpSend,
  checkOtpVerifyAllowed,
  recordOtpVerifyFailure,
  clearOtpVerifyFailures,
  clientIp,
};
