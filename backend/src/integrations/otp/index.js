// Where a login code goes.
//
// One function, three destinations. Phone sign-in does not care which — it asks for a
// code to reach a number and gets told whether it did, and everything else about
// providers stays behind this line.
//
// That mattered more than it looked when it was written: WhatsApp turned out to require
// a Meta Business account, business verification, and a template Meta has to approve.
// Switching to SMS was a provider argument rather than a change to how anyone signs in.

import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { sendLoginCode as sendViaWhatsApp } from '../whatsapp/otp.js';
import { sendSmsCode } from '../twilio/sms.js';

/**
 * @param {object} args
 * @param {string} args.phone       E.164
 * @param {string} args.code        six digits
 * @param {number} args.ttlMinutes
 * @returns {Promise<{ delivered: boolean, providerMessageId: string|null, devCode?: string, error?: string }>}
 */
export async function sendLoginCode({ phone, code, ttlMinutes }) {
  switch (config.otp.provider) {
    case 'whatsapp':
      return sendViaWhatsApp({ phone, code, ttlMinutes });

    case 'twilio':
      return sendSmsCode({ phone, code, ttlMinutes });

    case 'log':
    default:
      // Not a failure mode — the default, and how local development works with no
      // provider account at all. `devCode` comes back so the sign-in form can show it,
      // which is safe precisely because it only happens when no provider is configured.
      logger.info({ phone, code, ttlMinutes }, 'no OTP provider configured; code not sent');
      return { delivered: false, providerMessageId: null, devCode: code };
  }
}
