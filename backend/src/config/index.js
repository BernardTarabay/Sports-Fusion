// Configuration. Read once, validated at boot, immutable afterwards.
//
// The process refuses to start on a bad config rather than failing on the first request
// that needs it. Finding out at 8:55pm on a Friday that JWT_ACCESS_SECRET was empty is
// not a debugging experience anyone should have.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env') });

const duration = (fallback) => z.string().default(fallback);

// NOT z.coerce.boolean(): Boolean("false") is true, so every flag in .env would read as
// enabled. Environment variables are strings and have to be parsed as such.
const flag = (fallback = false) =>
  z.enum(['true', 'false', '1', '0', 'yes', 'no', ''])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

/**
 * Enough of a connection string to debug it, without any of the secret.
 *
 * Hosting platforms redact environment variables in their logs, which is right up until
 * the value is malformed and nobody -- including you -- can see how. Everything between
 * `//` and `@` is credentials and never appears; the scheme, host and port are what is
 * actually wrong, and they are not sensitive.
 */
function describeConnectionString(value) {
  const raw = String(value ?? '');
  const shape = raw.match(/^([a-zA-Z][\w+.-]*):\/\/(?:[^@]*@)?([^/?#]*)/);
  if (!shape) {
    return `${raw.length} characters that do not start with a scheme like "postgres://"`;
  }
  return `scheme "${shape[1]}", host and port "${shape[2]}", ${raw.length} characters total`;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),

  // Parsed here so a malformed one fails at startup with a sentence, not fifty lines
  // down inside the driver with the value redacted. `pg` only rejects a connection
  // string outright when the PORT will not parse -- everything else it accepts and then
  // fails to connect much later -- so that is what this is really catching.
  // Parsed here so a malformed one fails at startup with a sentence, not fifty lines
  // down inside the driver with the value redacted. `pg` only rejects a connection
  // string outright when the PORT will not parse -- everything else it accepts and then
  // fails to connect much later -- so that is what this is really catching.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').superRefine((v, ctx) => {
    try {
      new URL(v);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL is not a valid URL. It looks like this: '
          + `${describeConnectionString(v)}. The usual cause is a partial paste -- the `
          + 'port has to be a number, as in @host:5432/postgres.',
      });
    }
  }),
  // PGlite (the Docker-free dev database) serves one connection at a time; anything
  // above 1 there queues until it times out. Real Postgres wants the default.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  ACCESS_TOKEN_TTL: duration('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().default('localhost'),

  BALANCER_SHORTLIST_SIZE: z.coerce.number().int().positive().default(50),
  BALANCER_ALGORITHM_VERSION: z.string().default('exhaustive_v1'),

  // Where login codes go. 'log' writes them to the server log and returns them to the
  // client, which is right for development and is the default precisely so that a
  // half-configured deploy cannot silently swallow them.
  OTP_PROVIDER: z.enum(['log', 'whatsapp', 'twilio']).optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  // A bare number, or a Messaging Service that owns several. The service handles sender
  // selection, opt-outs and per-country rules; a number does none of that.
  TWILIO_FROM: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),

  WHATSAPP_ENABLED: flag(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  // Meta's own name for the template, which is whatever you called it when you created
  // it. Hardcoding ours meant a working account still failed, with an error that only
  // said the template did not exist.
  WHATSAPP_TEMPLATE_NAME: z.string().default('login_code'),
  // Authentication templates usually carry a copy-code button, and the API then REQUIRES
  // the code repeated as a button parameter. If yours has no button, sending one is
  // rejected outright -- so which shape it is has to be stated, not assumed.
  WHATSAPP_TEMPLATE_HAS_BUTTON: flag(true),
  // Meta matches the template to the recipient by language. 'en' and 'en_US' are
  // different templates as far as the API is concerned.
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),

  SHOPIFY_ENABLED: flag(),
  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  GEMINI_ENABLED: flag(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\nInvalid configuration:\n${issues}\n\nCheck your .env against .env.example.\n`);
  process.exit(1);
}

const env = parsed.data;

// Integrations that are switched on must actually be configured.
// OTP_PROVIDER is authoritative, but WHATSAPP_ENABLED=true already means "send codes over
// WhatsApp" on deployed environments, so it still selects the provider when nothing else
// does. Setting OTP_PROVIDER explicitly overrides it.
const otpProvider = env.OTP_PROVIDER ?? (env.WHATSAPP_ENABLED ? 'whatsapp' : 'log');

// Refuse to start half-configured rather than accept codes and drop them. A login code
// that is silently never sent looks, to the person waiting, exactly like a broken app.
if (otpProvider === 'twilio' && (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN)) {
  console.error('\nOTP_PROVIDER is twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are missing.\n');
  process.exit(1);
}
if (otpProvider === 'twilio' && !env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) {
  console.error('\nOTP_PROVIDER is twilio but neither TWILIO_FROM nor TWILIO_MESSAGING_SERVICE_SID is set.\n');
  process.exit(1);
}

if (otpProvider === 'whatsapp' && (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN)) {
  console.error('\nWHATSAPP_ENABLED is true but phone number id / access token are missing.\n');
  process.exit(1);
}
if (env.SHOPIFY_ENABLED && (!env.SHOPIFY_SHOP_DOMAIN || !env.SHOPIFY_ADMIN_ACCESS_TOKEN)) {
  console.error('\nSHOPIFY_ENABLED is true but the shop domain / admin access token are missing.\n');
  process.exit(1);
}
if (env.GEMINI_ENABLED && !env.GEMINI_API_KEY) {
  console.error('\nGEMINI_ENABLED is true but GEMINI_API_KEY is missing.\n');
  process.exit(1);
}

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  publicWebUrl: env.PUBLIC_WEB_URL,

  database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
  redis: { url: env.REDIS_URL },

  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.ACCESS_TOKEN_TTL,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    cookieDomain: env.COOKIE_DOMAIN,
  },

  balancer: {
    shortlistSize: env.BALANCER_SHORTLIST_SIZE,
    algorithmVersion: env.BALANCER_ALGORITHM_VERSION,
  },

  otp: { provider: otpProvider },

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_FROM,
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
  },

  whatsapp: {
    enabled: env.WHATSAPP_ENABLED,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    apiVersion: env.WHATSAPP_API_VERSION,
    templateName: env.WHATSAPP_TEMPLATE_NAME,
    templateHasButton: env.WHATSAPP_TEMPLATE_HAS_BUTTON,
    templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE,
  },

  shopify: {
    enabled: env.SHOPIFY_ENABLED,
    shopDomain: env.SHOPIFY_SHOP_DOMAIN,
    accessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    webhookSecret: env.SHOPIFY_WEBHOOK_SECRET,
  },
  gemini: {
    enabled: env.GEMINI_ENABLED,
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
  },
});

export default config;
