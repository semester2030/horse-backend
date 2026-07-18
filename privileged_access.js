/**
 * أرقام المطوّر/الأدمن ذات الصلاحيات الكاملة.
 * لا تحتاج موافقة تحقق تاجر، ويمكنها نشر أي خدمة/منتج/خبير.
 *
 * PRIVILEGED_PHONES=+966500756705,0500756705
 * (إن لم تُضبط، يُستخدم الرقم الافتراضي للمطوّر)
 */
const countries = require('./countries');

const DEFAULT_PRIVILEGED_PHONES = ['+966500756705', '0500756705', '500756705'];

/** يحوّل الأرقام العربية/الفارسية إلى لاتينية قبل التطبيع */
function toAsciiDigits(raw) {
  return String(raw || '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function parsePhoneList() {
  const raw = String(process.env.PRIVILEGED_PHONES || '').trim();
  const entries = raw
    ? raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
    : DEFAULT_PRIVILEGED_PHONES;
  return entries;
}

function privilegedPhoneSet() {
  const set = new Set();
  for (const entry of parsePhoneList()) {
    const normalized = countries.normalizePhone(
      toAsciiDigits(entry),
      countries.DEFAULT_COUNTRY,
    );
    if (normalized) set.add(normalized);
  }
  return set;
}

function isPrivilegedPhone(phone, countryCode) {
  if (!phone) return false;
  const normalized = countries.normalizePhone(
    toAsciiDigits(phone),
    countryCode || countries.DEFAULT_COUNTRY,
  );
  if (!normalized) return false;
  return privilegedPhoneSet().has(normalized);
}

function isPrivilegedUser(user) {
  if (!user || typeof user !== 'object') return false;
  return isPrivilegedPhone(user.phone, user.countryCode);
}

/** يفعّل حالة التحقق والصلاحيات الواسعة للمطوّر دون تغيير دوره الظاهر. */
function elevatePrivilegedUser(user) {
  if (!user || typeof user !== 'object') return user;
  if (!isPrivilegedUser(user)) return user;
  user.verificationStatus = 'approved';
  user.verificationNote = user.verificationNote || 'حساب مطوّر — صلاحيات كاملة';
  user.isPrivileged = true;
  // كل الفصائل دائماً — حتى لو كان الحساب معلناً لخيل/إبل/صقور فقط
  user.allowedSpecies = ['horse', 'camel', 'falcon', 'sheep', 'all'];
  user.advertiserSpecies = ['horse', 'camel', 'falcon', 'sheep'];
  return user;
}

module.exports = {
  isPrivilegedPhone,
  isPrivilegedUser,
  elevatePrivilegedUser,
  privilegedPhoneSet,
};
