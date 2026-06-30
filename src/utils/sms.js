/**
 * SMS sender utility.
 *
 * Priority order:
 *   1. FAST2SMS_API_KEY set  → Fast2SMS (India, OTP route)
 *   2. MSG91_AUTH_KEY set    → MSG91 (India, flow-based OTP)
 *   3. TWILIO_ACCOUNT_SID   → Twilio (international)
 *
 * Set exactly one provider's env vars. Others are ignored.
 */

const FAST2SMS_KEY  = process.env.FAST2SMS_API_KEY;
const MSG91_KEY     = process.env.MSG91_AUTH_KEY;
const MSG91_TMPL    = process.env.MSG91_TEMPLATE_ID;  // OTP template ID
const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM   = process.env.TWILIO_FROM_NUMBER; // e.g. +14155552671

const primaryMode = FAST2SMS_KEY ? 'fast2sms' : MSG91_KEY ? 'msg91' : TWILIO_SID ? 'twilio' : 'none';
console.log(`[SMS] Primary mode: ${primaryMode.toUpperCase()}`);

// ── Fast2SMS (India) ──────────────────────────────────────────────────────────
const sendViaFast2SMS = async (phone, otp) => {
  if (!FAST2SMS_KEY) throw new Error('FAST2SMS_API_KEY not set');
  // Strip country code if present — Fast2SMS needs 10-digit Indian numbers
  const number = String(phone).replace(/^\+91/, '').replace(/\D/g, '').slice(-10);
  console.log(`[SMS/Fast2SMS] Sending OTP to ${number}`);
  const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      'authorization': FAST2SMS_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      route:            'otp',
      variables_values: String(otp),
      numbers:          number,
    }),
  });
  const data = await res.json();
  if (!data.return) {
    console.error('[SMS/Fast2SMS] ❌ FAILED:', JSON.stringify(data));
    throw new Error(data.message?.join(', ') || 'Fast2SMS failed');
  }
  console.log('[SMS/Fast2SMS] ✅ Sent OK. requestId:', data.request_id);
  return data;
};

// ── MSG91 (India) ─────────────────────────────────────────────────────────────
const sendViaMSG91 = async (phone, otp) => {
  if (!MSG91_KEY) throw new Error('MSG91_AUTH_KEY not set');
  const number = String(phone).replace(/^\+?91/, '91').replace(/\D/g, '');
  console.log(`[SMS/MSG91] Sending OTP to ${number}`);
  const res = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: {
      'authkey':      MSG91_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      template_id: MSG91_TMPL,
      mobile:      number,
      otp:         String(otp),
    }),
  });
  const data = await res.json();
  if (data.type !== 'success') {
    console.error('[SMS/MSG91] ❌ FAILED:', JSON.stringify(data));
    throw new Error(data.message || 'MSG91 failed');
  }
  console.log('[SMS/MSG91] ✅ Sent OK');
  return data;
};

// ── Twilio (international) ────────────────────────────────────────────────────
const sendViaTwilio = async (phone, otp) => {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM)
    throw new Error('Twilio credentials not set');
  // Ensure E.164 format
  const to = String(phone).startsWith('+') ? phone : `+91${phone}`;
  console.log(`[SMS/Twilio] Sending OTP to ${to}`);
  const body = `Your BRP AMS verification code is ${otp}. Valid for 10 minutes. Do not share.`;
  const params = new URLSearchParams({
    From: TWILIO_FROM,
    To:   to,
    Body: body,
  });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
      },
      body: params.toString(),
    }
  );
  const data = await res.json();
  if (data.error_code) {
    console.error('[SMS/Twilio] ❌ FAILED:', JSON.stringify(data));
    throw new Error(data.message || 'Twilio failed');
  }
  console.log('[SMS/Twilio] ✅ Sent OK. sid:', data.sid);
  return data;
};

/**
 * Send an OTP via SMS to a phone number.
 * @param {string} phone - 10-digit Indian mobile or E.164 format
 * @param {string|number} otp - the OTP code to send
 * @returns {Promise<boolean>} true if sent, false if no provider configured
 */
const sendSMS = async (phone, otp) => {
  if (FAST2SMS_KEY) {
    return sendViaFast2SMS(phone, otp);
  }
  if (MSG91_KEY) {
    return sendViaMSG91(phone, otp);
  }
  if (TWILIO_SID) {
    return sendViaTwilio(phone, otp);
  }
  console.warn('[SMS] ⚠️  No SMS provider configured. Set FAST2SMS_API_KEY, MSG91_AUTH_KEY, or TWILIO_ACCOUNT_SID.');
  return false;
};

module.exports = { sendSMS, mode: primaryMode };
