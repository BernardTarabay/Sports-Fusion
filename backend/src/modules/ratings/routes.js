import { Router } from 'express';
import { z } from 'zod';
import * as ratingService from './service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate, optionalAuth } from '../../middleware/authenticate.js';
import { requireRoles } from '../../middleware/authorize.js';
import { DEFAULTS } from './glicko2.js';
import { LEADERBOARD_METRICS } from './service.js';

const router = Router();
const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

router.get(
  '/leaderboard',
  optionalAuth,
  validate({
    query: z.object({
      districtId: uuid.optional(),
      // Which board. The client has always sent this and the schema never accepted it --
      // and because `validate` REPLACES req.query with what it parsed, an unlisted key
      // is not merely ignored, it is deleted. Six of the seven tabs rendered the rating
      // table. An unknown value falls back to 'rating' rather than 422: a stale tab
      // asking for a board that has been renamed should show a leaderboard, not an error.
      metric: z.enum(LEADERBOARD_METRICS).catch('rating').default('rating'),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      // Each board carries its own qualifying floor (see METRICS); this overrides it.
      // Ranking someone the system barely knows is how a leaderboard loses credibility.
      minGames: z.coerce.number().int().min(0).max(100).optional(),
      includeProvisional: z.enum(['true', 'false']).default('false')
        .transform((v) => v === 'true'),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ leaderboard: await ratingService.getLeaderboard(req.query) });
  })
);

router.get(
  '/players/:id/timeline',
  optionalAuth,
  validate({
    params: z.object({ id: uuid }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  }),
  asyncHandler(async (req, res) => {
    res.json({
      timeline: await ratingService.getPlayerRatingTimeline(req.params.id, req.query),
    });
  })
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const replaySchema = z.object({
  // A dry run reports what would change without writing anything. Worth doing before
  // retuning parameters on a league with real history.
  dryRun: z.boolean().default(false),
  tau: z.number().min(0.1).max(2).optional(),
  maxDeviation: z.number().min(50).max(500).optional(),
  minDeviation: z.number().min(1).max(200).optional(),
});

/**
 * Recompute every rating from the immutable record.
 *
 * Owner-only. It rewrites every derived rating in the league, and while it never touches
 * admin seeds or overrides, it is not something a district admin should be able to do to
 * everyone else's numbers on a whim.
 */
router.post(
  '/replay',
  authenticate,
  requireRoles('owner', 'admin'),
  validate({ body: replaySchema }),
  asyncHandler(async (req, res) => {
    const { dryRun, ...options } = req.body;
    const result = await ratingService.replayRatings({
      triggeredBy: req.user.id,
      dryRun,
      options,
    });
    res.json(result);
  })
);

router.get(
  '/replays',
  authenticate,
  requireRoles('owner', 'admin'),
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) }),
  asyncHandler(async (req, res) => {
    res.json({ replays: await ratingService.getReplayHistory(req.query) });
  })
);

router.get(
  '/parameters',
  authenticate,
  requireRoles('owner', 'admin'),
  asyncHandler(async (_req, res) => {
    res.json({ defaults: DEFAULTS });
  })
);

// Repair hatch: rate a single completed game the worker missed.
router.post(
  '/games/:id/rate',
  authenticate,
  requireRoles('owner', 'admin'),
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json(await ratingService.rateGame({ gameId: req.params.id }));
  })
);

router.post(
  '/decay',
  authenticate,
  requireRoles('owner', 'admin'),
  validate({
    body: z.object({
      inactiveDays: z.number().int().min(7).max(365).default(30),
      limit: z.number().int().min(1).max(5000).default(500),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ decayed: await ratingService.decayInactiveRatings(req.body) });
  })
);

export default router;
