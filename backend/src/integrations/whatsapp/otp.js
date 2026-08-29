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

/**
 * Meta rejects the whole message if the components do not match the approved template
 * exactly, and the error it returns names a parameter index rather than the problem. So
 * the shape is configuration, not an assumption: see WHATSAPP_TEMPLATE_* in .env.example.
 */

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
        name: config.whatsapp.templateName,
        language: { code: config.whatsapp.templateLanguage },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          // The code repeated as a button parameter, which authentication templates with
          // a copy-code button require. Omitted when the template has no button, because
          // sending a component the template does not declare is rejected.
          ...(config.whatsapp.templateHasButton
            ? [{
                type: 'button', sub_type: 'url', index: '0',
                parameters: [{ type: 'text', text: code }],
              }]
            : []),
        ],
      },
    }),
    // Shorter than the worker's 15s: the caller is a person waiting on a form.
    signal: AbortSignal.timeout(8_000),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const meta = body?.error ?? {};
    // Deliberately vague to the CALLER -- "that number is not on WhatsApp" tells an
    // attacker which numbers exist. Specific in the log, including the fields Meta only
    // puts in error_data: during setup the difference between a wrong template name, an
    // unapproved template and a bad token is the whole problem, and the top-level
    // message says the same thing for all three.
    logger.error({
      status: response.status,
      code: meta.code,
      subcode: meta.error_subcode,
      metaMessage: meta.message,
      details: meta.error_data?.details,
      template: config.whatsapp.templateName,
      language: config.whatsapp.templateLanguage,
      hasButton: config.whatsapp.templateHasButton,
      phone,
    }, 'login code send failed');
    return { delivered: false, providerMessageId: null, error: meta.error_data?.details ?? meta.message };
  }

  return { delivered: true, providerMessageId: body?.messages?.[0]?.id ?? null };
}
