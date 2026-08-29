// One-time codes over SMS, via Twilio.
//
// Raw fetch rather than the SDK. This is one POST to one endpoint with Basic auth, and
// the SDK is a few megabytes plus a dependency to keep current for exactly that.
//
// SMS rather than WhatsApp reaches everyone, not just people who use WhatsApp — which
// matters less in Lebanon than almost anywhere, but it does not need a Meta Business
// account, and that is why this exists.

import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';

/**
 * The messages a Twilio account actually sends you while you are setting it up.
 *
 * Twilio's own text for these is accurate and useless -- "The number is unverified"
 * does not say that trial accounts can ONLY send to numbers you added in the console,
 * which is the thing nobody knows the first time. The code is the reliable identifier;
 * the wording changes.
 */
const KNOWN = {
  21608: 'This is a trial account, which can only send to numbers you have verified in '
       + 'the Twilio console. Add the recipient under Phone Numbers > Verified Caller IDs, '
       + 'or upgrade the account.',
  21211: 'Twilio rejected the destination number. It must be in E.164 form, like +9613123456.',
  21606: 'The From number cannot send SMS. Check it is SMS-capable and that you own it.',
  21659: 'The From number is not one of yours, or is not SMS-capable in this region.',
  20003: 'Authentication failed. Check the Account SID and Auth Token.',
  21610: 'That recipient has unsubscribed by replying STOP, so Twilio will not deliver to them.',
};

/**
 * @returns {Promise<{ delivered: boolean, providerMessageId: string|null, error?: string }>}
 */
export async function sendSmsCode({ phone, code, ttlMinutes }) {
  const { accountSid, authToken, from, messagingServiceSid } = config.twilio;

  // No link. An SMS from an unrecognised number containing a URL is the shape of every
  // phishing message ever sent, and carriers filter on exactly that.
  const body = `${code} is your Sports Fusion code. It expires in ${ttlMinutes} minutes.`;

  const form = new URLSearchParams({ To: phone, Body: body });
  // A Messaging Service handles sender selection, opt-outs and per-country rules on
  // Twilio's side; a bare number does not. Preferred when configured.
  if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
  else form.set('From', from);

  let response;
  let payload;
  try {
    response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
        // The caller is a person watching an empty six-box input, not a queue worker.
        signal: AbortSignal.timeout(8_000),
      }
    );
    payload = await response.json().catch(() => ({}));
  } catch (err) {
    logger.error({ err, phone }, 'twilio request failed');
    return { delivered: false, providerMessageId: null, error: 'Could not reach the SMS provider' };
  }

  if (!response.ok) {
    const known = KNOWN[payload?.code];
    logger.error({
      status: response.status,
      twilioCode: payload?.code,
      twilioMessage: payload?.message,
      moreInfo: payload?.more_info,
      explanation: known,
      phone,
    }, 'sms code send failed');
    // Returned to the route, which decides what the user sees. Never rendered directly:
    // "that number is unverified" tells an attacker which numbers are registered.
    return { delivered: false, providerMessageId: null, error: known ?? payload?.message };
  }

  // Accepted, not delivered. Twilio queues, and a handset that is off or out of coverage
  // is somebody else's problem minutes from now. Treating the 201 as delivery is the
  // honest reading of what just happened.
  return { delivered: true, providerMessageId: payload?.sid ?? null };
}
