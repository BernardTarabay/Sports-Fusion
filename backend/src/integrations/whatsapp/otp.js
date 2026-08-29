// Sends a one-time code over WhatsApp.
//
// WHY THIS DOES NOT GO THROUGH THE WORKER
//
// Every other message in the system is queued: reminders, promotions, cancellations.
// They can wait for the next tick, and queuing buys retries, idempotency and a delivery
// record. A login code cannot wait for a tick. Somebody is holding a phone looking at an
// empty six-box input, and a code that arrives forty seconds later has already been
// abandoned. So this one call goes out inline.
//
// It also means a failure is visible to the caller immediately, which matters: if the
// code cannot be sent, the right answer is to say so rather than to leave the person
// waiting for something that is never coming.

import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';

/** Codes expire quickly; the template says so, so the message is self-explanatory. */
const TEMPLATE_NAME = 'login_code';

/**
 * @returns {Promise<{ delivered: boolean, providerMessageId: string|null, devCode?: string }>}
 */
export async function sendLoginCode({ phone, code, ttlMinutes }) {
  if (!config.whatsapp.enabled) {
    // Dry run. The code goes to the log so local development works with no WhatsApp
    // account at all -- and `devCode` is returned so the dev UI can show it. Both are
    // gated on the integration being disabled, which is never true in production.
    logger.info({ phone, code, ttlMinutes }, 'whatsapp disabled; login code not sent');
    return { delivered: false, providerMessageId: null, devCode: code };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}` +
              `/${config.whatsapp.phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.whatsapp.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          // Meta requires the code to be repeated as a button parameter on
          // authentication templates, so the recipient gets a one-tap copy.
          {
            type: 'button', sub_type: 'url', index: '0',
            parameters: [{ type: 'text', text: code }],
          },
        ],
      },
    }),
    // Shorter than the worker's 15s: the caller is a person waiting on a form.
    signal: AbortSignal.timeout(8_000),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Deliberately vague to the caller, specific in the log. "That number is not on
    // WhatsApp" tells an attacker which numbers exist.
    logger.error({ status: response.status, error: body?.error, phone }, 'login code send failed');
    return { delivered: false, providerMessageId: null };
  }

  return { delivered: true, providerMessageId: body?.messages?.[0]?.id ?? null };
}
