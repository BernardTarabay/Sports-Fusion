// Delivery channels.
//
// Each channel exports send(notification, rendered) and returns
// { providerMessageId, providerConversationId, cost, currency } or throws.
//
// A throw means "retry later". To refuse permanently -- an unreachable number, a revoked
// opt-in -- throw a PermanentFailure, which the dispatcher records without retrying.

import config from '@sports-fusion/backend/config';
import { logger } from '@sports-fusion/backend/lib/logger';

export class PermanentFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentFailure';
    this.permanent = true;
  }
}

// ---------------------------------------------------------------------------
// In-app: the notification row IS the message. Nothing to send.
// ---------------------------------------------------------------------------
const inApp = {
  name: 'in_app',
  async send() {
    return { providerMessageId: null, cost: null };
  },
};

// ---------------------------------------------------------------------------
// WhatsApp Business Platform (Cloud API).
//
// 1:1 only. This cannot and must not post to groups or communities -- group messages are
// generated for an admin to paste (see integrations/whatsapp/announcements.js).
//
// Outside the 24-hour customer service window only a pre-approved template may be sent,
// so this always sends the template form. Each template conversation is billed, and the
// cost is recorded on the notification row so spend is visible before the invoice.
// ---------------------------------------------------------------------------
const whatsapp = {
  name: 'whatsapp',

  async send(notification, rendered) {
    if (!notification.phone_e164) {
      throw new PermanentFailure('No phone number on file');
    }

    const template = rendered.whatsappTemplate;
    if (!template) {
      throw new PermanentFailure(`Template ${notification.template_key} has no WhatsApp form`);
    }

    if (!config.whatsapp.enabled) {
      // Development and test: log what WOULD be sent, so the copy can be reviewed before
      // it is submitted to Meta for approval, without spending money or needing credentials.
      logger.info(
        {
          to: notification.phone_e164.replace(/\d(?=\d{3})/g, '*'),
          template: template.name,
          variables: template.variables,
          preview: rendered.body,
        },
        'whatsapp disabled; message not sent'
      );
      return { providerMessageId: `dry-run-${notification.id}`, cost: null };
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
        to: notification.phone_e164,
        type: 'template',
        template: {
          name: template.name,
          language: { code: notification.locale === 'ar' ? 'ar' : 'en' },
          components: [{
            type: 'body',
            parameters: template.variables.map((text) => ({ type: 'text', text: String(text) })),
          }],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = body?.error ?? {};
      // 4xx other than rate limiting is a request that will never succeed as written --
      // an unregistered number, an unapproved template. Retrying wastes quota.
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
      const message = `WhatsApp ${response.status}: ${error.message ?? 'unknown'} (code ${error.code ?? '?'})`;
      throw permanent ? new PermanentFailure(message) : new Error(message);
    }

    return {
      providerMessageId: body?.messages?.[0]?.id ?? null,
      providerConversationId: body?.messages?.[0]?.message_status ?? null,
      cost: null, // Billing arrives asynchronously on the webhook, not in this response.
      currency: 'USD',
    };
  },
};

// ---------------------------------------------------------------------------
// Push and email: not wired up. They fail permanently rather than retrying forever, so
// an unimplemented channel is visible in the failure count instead of silently
// accumulating in the queue.
// ---------------------------------------------------------------------------
const notImplemented = (name) => ({
  name,
  async send() {
    throw new PermanentFailure(`${name} channel is not implemented yet`);
  },
});

export const channels = {
  in_app: inApp,
  whatsapp,
  push: notImplemented('push'),
  email: notImplemented('email'),
  sms: notImplemented('sms'),
};

export default channels;
