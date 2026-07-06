/**
 * إرسال OTP عبر تقنيات (Taqnyat) — مخصص للسعودية +966.
 * https://dev.taqnyat.sa/doc/sms/
 */
const API_URL = 'https://api.taqnyat.sa/v1/messages';

function bearerToken() {
  return (
    process.env.TAQNYAT_BEARER_TOKEN ||
    process.env.TAQNYAT_API_KEY ||
    ''
  ).trim();
}

function senderName() {
  return (process.env.TAQNYAT_SENDER || process.env.TAQNYAT_SENDER_ID || '').trim();
}

function isConfigured() {
  return Boolean(bearerToken() && senderName());
}

/** +9665xxxxxxxx → 9665xxxxxxxx (بدون + أو 00) */
function toTaqnyatRecipient(e164Phone) {
  const digits = String(e164Phone || '').replace(/\D/g, '');
  if (!digits.startsWith('966')) {
    throw new Error('Taqnyat يدعم أرقام السعودية (+966) فقط');
  }
  const local = digits.slice(3);
  if (local.length !== 9 || !local.startsWith('5')) {
    throw new Error('رقم الجوال السعودي غير صالح (+9665xxxxxxxx)');
  }
  return digits;
}

function mapTaqnyatError(status, data, raw) {
  const text = String(
    data?.message ||
      data?.status?.description ||
      data?.status?.message ||
      data?.error ||
      raw ||
      '',
  ).toLowerCase();

  if (status === 401 || text.includes('bearer') || text.includes('token')) {
    return 'مفتاح Taqnyat غير صحيح — تحقق من TAQNYAT_BEARER_TOKEN على Render';
  }
  if (status === 400 && (text.includes('sender') || text.includes('مرسل'))) {
    return 'اسم المرسل غير مفعّل — فعّل NOMAS في portal.taqnyat.sa (أسماء المرسل)';
  }
  if (status === 403 || text.includes('forbidden') || text.includes('balance')) {
    return 'حساب Taqnyat غير مفعّل — أكمل الوثائق أو اشحن الرصيد في portal.taqnyat.sa';
  }
  if (data?.message) return data.message;
  if (data?.status?.description) return data.status.description;
  return raw || `Taqnyat HTTP ${status}`;
}

function status() {
  return {
    configured: isConfigured(),
    sender: senderName() || null,
    provider: 'taqnyat',
    hasToken: Boolean(bearerToken()),
    hasSender: Boolean(senderName()),
  };
}

/**
 * @param {string} e164Phone
 * @param {string} code
 */
async function sendOtpSms(e164Phone, code) {
  if (!isConfigured()) {
    throw new Error('Taqnyat غير مُعد — أضف TAQNYAT_BEARER_TOKEN و TAQNYAT_SENDER على Render');
  }

  const recipient = toTaqnyatRecipient(e164Phone);
  const body = `رمز التحقق في نوماس: ${code}\nصالح 5 دقائق.`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      recipients: [recipient],
      body,
      sender: senderName(),
    }),
  });

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  if (!res.ok) {
    const msg = mapTaqnyatError(res.status, data, raw);
    console.error('[OTP/Taqnyat] فشل:', res.status, msg, raw.slice(0, 300));
    throw new Error(msg);
  }

  const messageId =
    data?.messageId ||
    data?.id ||
    data?.status?.messageId ||
    data?.status?.id ||
    null;
  console.log(`[OTP/Taqnyat] نجح MessageId=${messageId || '?'} to=${recipient}`);
  return messageId;
}

module.exports = {
  isConfigured,
  sendOtpSms,
  status,
};
