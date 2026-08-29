// Shopify Admin API client.
//
// Sports Fusion does not rebuild commerce. Shopify handles the store; this platform
// handles community, football, identity and loyalty. The only thing crossing the boundary
// is a discount code: points are spent here, and the result is something the player can
// use over there.
//
// Disabled by default. With SHOPIFY_ENABLED=false the client returns a deterministic
// dry-run code and logs what it would have created, so the whole redemption pipeline is
// exercisable with no store, no credentials and no risk of issuing real money off.
//
// > VERIFY THE MUTATION SHAPE AND API VERSION against Shopify's current Admin API docs
// > before enabling this against a live store. Shopify versions its API quarterly and
// > deprecates old versions; a discount mutation that was correct a year ago may not be.
// > Getting this wrong issues broken codes to real players, or worse, working ones with
// > the wrong value.

import { createHash, randomBytes } from 'node:crypto';
import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';

export class ShopifyPermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShopifyPermanentError';
    this.permanent = true;
  }
}

const API_VERSION = '2025-01';

/**
 * Human-typeable code. No ambiguous characters -- someone reads this off a phone screen
 * and types it on a laptop, and O/0 and I/1 are where that goes wrong.
 */
export function generateCode(prefix = 'SF') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return `${prefix}-${code}`;
}

async function graphql(query, variables) {
  const url = `https://${config.shopify.shopDomain}/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': config.shopify.accessToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 429) {
    // Shopify throttles by leaky bucket. Worth retrying.
    throw new Error('Shopify rate limited');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ShopifyPermanentError(`Shopify rejected the credentials (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}`);
  }

  const body = await response.json();

  // GraphQL returns 200 with an errors array. A malformed query will never succeed, so
  // it is permanent; retrying it just burns quota.
  if (body.errors?.length) {
    throw new ShopifyPermanentError(`Shopify GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }

  return body.data;
}

const DISCOUNT_MUTATION = `
  mutation createDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }
`;

/**
 * Create a single-use discount code.
 *
 * @param {object} input
 * @param {string} input.code             the code the player will type
 * @param {number} [input.percentage]     e.g. 10 for 10% off
 * @param {number} [input.amount]         fixed amount off, in the shop's currency
 * @param {string} [input.currency]
 * @param {Date}   [input.expiresAt]
 * @param {string} [input.title]
 * @returns {Promise<{code: string, discountId: string|null, dryRun: boolean}>}
 */
export async function createDiscountCode({
  code, percentage, amount, currency = 'USD', expiresAt, title,
}) {
  if (!percentage && !amount) {
    throw new ShopifyPermanentError('A discount needs either a percentage or an amount');
  }

  if (!config.shopify.enabled) {
    logger.info(
      { code, percentage, amount, title, expiresAt },
      'shopify disabled; discount code not created'
    );
    return { code, discountId: null, dryRun: true };
  }

  const customerGets = {
    value: percentage
      // Shopify expects a fraction, not a percentage. Sending 10 instead of 0.1 gives
      // every player 1000% off, which is the single most expensive typo available here.
      ? { percentage: percentage / 100 }
      : { discountAmount: { amount: String(amount), appliesOnEachItem: false } },
    items: { all: true },
  };

  const data = await graphql(DISCOUNT_MUTATION, {
    basicCodeDiscount: {
      title: title ?? `Sports Fusion reward ${code}`,
      code,
      startsAt: new Date().toISOString(),
      endsAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      customerSelection: { all: true },
      customerGets,
      appliesOncePerCustomer: true,
      // One code, one use. A reward that can be shared is not a reward, it is a leak.
      usageLimit: 1,
    },
  });

  const result = data?.discountCodeBasicCreate;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length > 0) {
    const message = userErrors.map((e) => `${e.field?.join('.') ?? ''} ${e.message}`).join('; ');
    // A duplicate code is our fault and retrying the same one will never work.
    throw new ShopifyPermanentError(`Shopify rejected the discount: ${message}`);
  }

  return {
    code,
    discountId: result?.codeDiscountNode?.id ?? null,
    dryRun: false,
  };
}

/**
 * Verify the webhook signature Shopify sends with order notifications.
 *
 * Not yet wired to a route -- recorded here because order webhooks are how purchases
 * would eventually earn points, and an unverified webhook endpoint is an open door for
 * anyone who wants to grant themselves points.
 */
export function verifyWebhookSignature(rawBody, hmacHeader) {
  if (!config.shopify.webhookSecret) return false;
  const digest = createHash('sha256').update(rawBody).digest('base64');
  return digest === hmacHeader;
}

export default { createDiscountCode, generateCode, verifyWebhookSignature };
