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
      // No provider. How local development works with no WhatsApp account: the code goes
      // to the server log and comes back in the response so the sign-in form can show it.
      //
      // NEITHER OF THOSE MAY HAPPEN IN PRODUCTION.
      //
      // 'log' is not an opt-in for development, it is the DEFAULT -- which means a deploy
      // that simply has not been given WhatsApp credentials lands here. Returning the code
      // there is total account takeover: anyone who knows a number, and this community's
      // numbers are in a WhatsApp group, asks for its login code and is handed it. Writing
      // it to the log is the same secret sitting in a log aggregator forever.
      //
      // So both are gated on config.otp.exposeCode, which is false in production whatever
      // the provider says.
      if (!config.otp.exposeCode) {
        logger.error(
          { phone },
          'phone sign-in requested but no OTP provider is configured; the code was NOT sent '
          + 'and is deliberately not logged. Set OTP_PROVIDER=whatsapp or twilio.'
        );
        return { delivered: false, providerMessageId: null, error: 'no_provider' };
      }
      logger.info({ phone, code, ttlMinutes }, 'no OTP provider configured; code not sent');
      return { delivered: false, providerMessageId: null, devCode: code };
  }
}
