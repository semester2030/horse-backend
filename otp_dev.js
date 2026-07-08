/**
 * OTP ثابت لأرقام مطوّرين — لا يلمس Taqnyat/SNS.
 * OTP_DEV_PHONES=+966500756705,0500756705
 * OTP_DEV_CODE=123456
 */
const countries = require('./countries');

function parseDevPhoneList() {
  const raw = String(process.env.OTP_DEV_PHONES || '').trim();
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function devCodeValue() {
  const code = String(process.env.OTP_DEV_CODE || '123456').trim();
  if (code.length < 4 || code.length > 8) return null;
  if (!/^\d+$/.test(code)) return null;
  return code;
}

/** يُرجع الرمز الثابت إذا كان الرقم في قائمة المطوّرين */
function codeForPhone(normalizedE164Phone) {
  const code = devCodeValue();
  if (!code || !normalizedE164Phone) return null;

  for (const entry of parseDevPhoneList()) {
    const normalized = countries.normalizePhone(entry, countries.DEFAULT_COUNTRY);
    if (normalized && normalized === normalizedE164Phone) {
      return code;
    }
  }
  return null;
}

function isDevPhone(normalizedE164Phone) {
  return codeForPhone(normalizedE164Phone) != null;
}

function shouldExposeDevCodeInResponse() {
  const flag = String(process.env.OTP_DEV_EXPOSE_CODE || 'false').toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'yes';
}

function status() {
  const phones = parseDevPhoneList();
  const code = devCodeValue();
  return {
    enabled: phones.length > 0 && Boolean(code),
    phoneCount: phones.length,
    exposeCodeInApi: shouldExposeDevCodeInResponse(),
  };
}

module.exports = {
  codeForPhone,
  isDevPhone,
  shouldExposeDevCodeInResponse,
  status,
};
