/**
 * موحّد إرسال OTP — Taqnyat (السعودية) أو AWS SNS.
 * SMS_PROVIDER=taqnyat | sns | auto (افتراضي: taqnyat إن وُجد، وإلا sns)
 */
const sns = require('./sns_otp');
const taqnyat = require('./taqnyat_otp');

function providerName() {
  const pref = String(process.env.SMS_PROVIDER || 'auto').toLowerCase().trim();
  if (pref === 'taqnyat') return taqnyat.isConfigured() ? 'taqnyat' : null;
  if (pref === 'sns') return sns.isConfigured() ? 'sns' : null;
  if (taqnyat.isConfigured()) return 'taqnyat';
  if (sns.isConfigured()) return 'sns';
  return null;
}

function activeProvider() {
  const name = providerName();
  if (name === 'taqnyat') return taqnyat;
  if (name === 'sns') return sns;
  return null;
}

function isConfigured() {
  return Boolean(activeProvider());
}

function exposeDevCodeOnScreen() {
  if (isConfigured()) return false;
  const flag = String(process.env.OTP_EXPOSE_CODE || 'true').toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'no';
}

function status() {
  const pref = String(process.env.SMS_PROVIDER || 'auto').toLowerCase().trim();
  const name = providerName();
  if (name === 'taqnyat') {
    return { ...taqnyat.status(), exposeDevCode: exposeDevCodeOnScreen() };
  }
  if (name === 'sns') {
    return { ...sns.status(), provider: 'sns', exposeDevCode: exposeDevCodeOnScreen() };
  }
  return {
    configured: false,
    provider: pref === 'auto' ? null : pref,
    exposeDevCode: exposeDevCodeOnScreen(),
    hint:
      pref === 'taqnyat'
        ? 'أضف TAQNYAT_BEARER_TOKEN و TAQNYAT_SENDER على Render'
        : null,
  };
}

async function sendOtpSms(e164Phone, code) {
  const p = activeProvider();
  if (!p) throw new Error('SMS غير مُعد');
  return p.sendOtpSms(e164Phone, code);
}

module.exports = {
  isConfigured,
  sendOtpSms,
  status,
  exposeDevCodeOnScreen,
};
