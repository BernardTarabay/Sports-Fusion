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

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),

  // Parsed here so a malformed one fails at startup with a sentence, not fifty lines
  // down inside the driver with the value redacted. `pg` only rejects a connection
  // string outright when the PORT will not parse -- everything else it accepts and then
  // fails to connect much later -- so that is what this is really catching.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').refine(
    (v) => { try { new URL(v); return true; } catch { return false; } },
    'DATABASE_URL is not a valid URL. The usual cause is a partial paste: check the '
    + 'port is a number, as in @host:5432/postgres, and that the whole string is there.'
  ),
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

  WHATSAPP_ENABLED: flag(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),

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
if (env.WHATSAPP_ENABLED && (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN)) {
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

  whatsapp: {
    enabled: env.WHATSAPP_ENABLED,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    apiVersion: env.WHATSAPP_API_VERSION,
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
