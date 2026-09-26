const config = require('./config');
const { run } = require('./db');

/**
 * Send a text message through Twilio. When Twilio isn't configured the message is
 * logged as "simulated" so the whole flow can be exercised without an account.
 * Never throws: SMS problems must not break sign-ups or the technician's workflow.
 */
async function sendSms({ to, body, kind, signupId = null }) {
  let status = 'simulated';
  let error = null;
  if (config.smsEnabled) {
    try {
      const params = new URLSearchParams({ To: to, Body: body });
      if (config.twilioMessagingServiceSid) params.set('MessagingServiceSid', config.twilioMessagingServiceSid);
      else params.set('From', config.twilioFrom);
      const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) status = 'sent';
      else {
        status = 'failed';
        const data = await res.json().catch(() => ({}));
        error = data.message || `HTTP ${res.status}`;
      }
    } catch (err) {
      status = 'failed';
      error = err.message;
    }
  } else {
    console.log(`[sms:simulated] to ${to} (${kind}): ${body}`);
  }
  if (error) console.warn(`[sms] failed to ${to}: ${error}`);
  try {
    run(
      'INSERT INTO sms_log (signup_id, to_phone, kind, body, status, error) VALUES (?, ?, ?, ?, ?, ?)',
      signupId,
      to,
      kind,
      body,
      status,
      error
    );
  } catch (err) {
    console.warn(`[sms] could not write log: ${err.message}`);
  }
  return { status, error };
}

module.exports = { sendSms };
