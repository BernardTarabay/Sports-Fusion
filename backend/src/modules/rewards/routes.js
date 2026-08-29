import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import * as rewardService from './service.js';
import * as playerService from '../players/service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate, optionalAuth } from '../../middleware/authenticate.js';
import { requireRoles, isGlobalAdmin } from '../../middleware/authorize.js';
import config from '../../config/index.js';

const router = Router();
const uuid = z.string().uuid();

// Redemption spends real money. Rate limited per account so a scripted client cannot
// hammer the endpoint, on top of the idempotency key and the row lock.
const redeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  message: { error: { code: 'RATE_LIMITED', message: 'Slow down a moment.' } },
  skip: () => config.isTest,
});

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    // Signed in is not the same as being a player: an admin account need not have a
    // football profile. The catalogue is public either way; the player id only adds
    // "can you afford this", so its absence drops the annotation, not the page.
    const playerId = req.user
      ? await playerService.playerIdForUser(req.user.id).catch(() => null)
      : null;
    res.json({
      rewards: await rewardService.listCatalogue({
        playerId,
        includeInactive: isGlobalAdmin(req.user),
      }),
    });
  })
);

// Balance, spending history, redemptions and achievements together. The rewards screen
// is one view, so it is one request rather than four loading states.
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const playerId = await playerService.playerIdForUser(req.user.id);
    const overview = await rewardService.getRewardsOverview(playerId);
    res.json({
      ...overview,
      rewards: await rewardService.listCatalogue({ playerId }),
    });
  })
);

router.post(
  '/:slug/redeem',
  authenticate,
  redeemLimiter,
  validate({
    params: z.object({ slug: z.string().min(1).max(60) }),
    body: z.object({
      // Send the same key on retry and the player is charged once.
      idempotencyKey: z.string().min(8).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const playerId = await playerService.playerIdForUser(req.user.id);
    const result = await rewardService.redeem({
      playerId,
      rewardSlug: req.params.slug,
      idempotencyKey: req.body.idempotencyKey,
      actorUserId: req.user.id,
    });
    res.status(result.deduplicated ? 200 : 201).json(result);
  })
);

router.get(
  '/me/redemptions',
  authenticate,
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }) }),
  asyncHandler(async (req, res) => {
    const playerId = await playerService.playerIdForUser(req.user.id);
    res.json({
      redemptions: await rewardService.listRedemptions({ playerId, limit: req.query.limit }),
    });
  })
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const rewardSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().max(1000).optional(),
  pointCost: z.number().int().positive().max(1_000_000).optional(),
  // What this costs Sports Fusion when redeemed. The number that decides whether the
  // economy works, so it is worth being asked for explicitly.
  unitCost: z.number().nonnegative().max(100_000).optional(),
  currency: z.string().length(3).optional(),
  fulfilmentType: z.enum(['shopify_discount', 'shopify_product', 'free_game', 'manual']).optional(),
  shopifyVariantId: z.string().max(100).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  valueAmount: z.number().nonnegative().max(100_000).optional(),
  stockRemaining: z.number().int().min(0).max(100_000).nullable().optional(),
  maxPerPlayer: z.number().int().min(1).max(100).nullable().optional(),
  minGamesPlayed: z.number().int().min(0).max(500).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

router.put(
  '/:slug',
  authenticate,
  requireRoles('owner', 'admin'),
  validate({
    params: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,60}$/) }),
    body: rewardSchema,
  }),
  asyncHandler(async (req, res) => {
    // The response carries the implied cost per point, so whoever sets the price sees
    // what it means before anyone redeems it.
    res.json(await rewardService.upsertReward({
      slug: req.params.slug, patch: req.body, actorUserId: req.user.id,
    }));
  })
);

router.get(
  '/admin/redemptions',
  authenticate,
  requireRoles('owner', 'admin'),
  validate({
    query: z.object({
      status: z.enum(['pending', 'fulfilling', 'fulfilled', 'cancelled', 'refunded', 'failed']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ redemptions: await rewardService.listRedemptions(req.query) });
  })
);

router.post(
  '/admin/redemptions/:id/refund',
  authenticate,
  requireRoles('owner', 'admin'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ reason: z.string().trim().min(3).max(500) }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await rewardService.refundRedemption({
      redemptionId: req.params.id, reason: req.body.reason, actorUserId: req.user.id,
    }));
  })
);

/**
 * Outstanding liability.
 *
 * Owner-facing, and the single most important number in the rewards system: every
 * unredeemed point is a promise against real margin.
 */
router.get(
  '/admin/liability',
  authenticate,
  requireRoles('owner', 'admin'),
  validate({ query: z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }) }),
  asyncHandler(async (req, res) => {
    res.json(await rewardService.getLiabilityReport(req.query));
  })
);

export default router;
