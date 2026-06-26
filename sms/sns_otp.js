/**
 * إرسال OTP عبر Amazon SNS (SMS) — للإنتاج و App Store.
 */
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

function isConfigured() {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_ACCESS_KEY_ID.trim() &&
      process.env.AWS_SECRET_ACCESS_KEY.trim(),
  );
}

function region() {
  return (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-north-1').trim();
}

function status() {
  return {
    configured: isConfigured(),
    region: region(),
    smsType: process.env.AWS_SNS_SMS_TYPE || 'Transactional',
    exposeDevCode: !isConfigured(),
  };
}

/**
 * @param {string} e164Phone مثل +9665xxxxxxxx
 * @param {string} code
 */
async function sendOtpSms(e164Phone, code) {
  if (!isConfigured()) {
    throw new Error('AWS SNS غير مُعد');
  }
  if (!e164Phone || !String(e164Phone).startsWith('+')) {
    throw new Error('رقم الجوال بصيغة E.164 مطلوب');
  }

  const client = new SNSClient({
    region: region(),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim(),
    },
  });

  const message = `رمز التحقق في نوماس: ${code}\nصالح 5 دقائق.`;

  /** @type {import('@aws-sdk/client-sns').PublishCommandInput} */
  const input = {
    PhoneNumber: e164Phone,
    Message: message,
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': {
        DataType: 'String',
        StringValue: process.env.AWS_SNS_SMS_TYPE || 'Transactional',
      },
    },
  };

  const senderId = (process.env.AWS_SNS_SENDER_ID || '').trim();
  if (senderId) {
    input.MessageAttributes['AWS.SNS.SMS.SenderID'] = {
      DataType: 'String',
      StringValue: senderId.slice(0, 11),
    };
  }

  const result = await client.send(new PublishCommand(input));
  return result.MessageId || null;
}

module.exports = {
  isConfigured,
  sendOtpSms,
  status,
};
