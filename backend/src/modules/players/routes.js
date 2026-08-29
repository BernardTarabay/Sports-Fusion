import { Router } from 'express';
import { z } from 'zod';
import * as playerService from './service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAdmin } from '../../middleware/authorize.js';
import { POSITIONS } from '../teams/formation.js';

const router = Router();

const uuid = z.string().uuid();
const position = z.enum(POSITIONS);

const preferencesSchema = z.object({
  jerseyName: z.string().trim().min(1).max(40).optional(),
  preferredPosition: position.optional(),
  secondaryPositions: z.array(position).max(4).optional(),
  preferredFoot: z.enum(['left', 'right', 'both']).optional(),
  isGoalkeeper: z.boolean().optional(),
  homeDistrictId: uuid.optional(),
  shirtSize: z.enum(['XS', 'S', 'M', 'L', 'XL', 'XXL']).optional(),
});

const ratingSchema = z.object({
  // A 1-10 admin opinion maps onto the rating scale; 1500 is the mid-point.
  mu: z.number().min(0).max(3000),
  sigma: z.number().min(1).max(600).default(200),
  reason: z.string().max(500).optional(),
});

// Admin adds a player who has never signed in. The bulk path into a real roster.
router.post(
  '/',
  authenticate,
  requireAdmin,
  validate({
    body: z.object({
      displayName: z.string().trim().min(2).max(80),
      phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +9613123456').optional(),
      email: z.string().email().optional(),
      districtId: uuid.optional(),
      preferredPosition: position.optional(),
      isGoalkeeper: z.boolean().default(false),
    }).refine((v) => v.phone || v.email, 'A phone number or an email address is required'),
  }),
  asyncHandler(async (req, res) => {
    const { player, created } = await playerService.createPlayerAsAdmin({
      ...req.body, actorUserId: req.user.id,
    });
    res.status(created ? 201 : 200).json({ player, created });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ player: await playerService.getProfileByUserId(req.user.id) });
  })
);

router.patch(
  '/me',
  authenticate,
  validate({ body: preferencesSchema }),
  asyncHandler(async (req, res) => {
    const playerId = await playerService.playerIdForUser(req.user.id);
    res.json({ player: await playerService.updatePreferences({ playerId, patch: req.body }) });
  })
);

router.get(
  '/me/games',
  authenticate,
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }) }),
  asyncHandler(async (req, res) => {
    const playerId = await playerService.playerIdForUser(req.user.id);
    res.json({ games: await playerService.getGameHistory(playerId, req.query.limit) });
  })
);

// Declared team preferences, which the balancer weights more heavily than the ones it
// infers from admin overrides.
router.put(
  '/me/relationships',
  authenticate,
  validate({
    body: z.object({
      otherPlayerId: uuid,
      kind: z.enum(['play_with', 'play_against', 'avoid']),
      weight: z.number().min(0).max(10).default(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const playerId = await playerService.playerIdForUser(req.user.id);
    res.json(await playerService.setRelationship({ playerId, ...req.body }));
  })
);

router.delete(
  '/me/relationships',
  authenticate,
  validate({
    body: z.object({ otherPlayerId: uuid, kind: z.enum(['play_with', 'play_against', 'avoid']) }),
  }),
  asyncHandler(async (req, res) => {
    const playerId = await playerService.playerIdForUser(req.user.id);
    res.json(await playerService.removeRelationship({ playerId, ...req.body }));
  })
);

// Another player's profile.
//
// Requires a session. It was public, which meant anyone who could guess a UUID could read
// a named person's rating, appearance count and reliability without an account -- and the
// invite links make ids easy enough to come by. Inside the community this is ordinary
// information; outside it, it is a stranger's activity record. Any signed-in player may
// read it, because tapping a name on the leaderboard has to work.
router.get(
  '/:id',
  authenticate,
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({ player: await playerService.getProfile(req.params.id) });
  })
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// Remove a player who should not be there. Someone with match history is deactivated
// rather than deleted -- see deletePlayer. The response says which happened.
router.delete(
  '/:id',
  authenticate,
  requireAdmin,
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json(await playerService.deletePlayer({ playerId: req.params.id, actorUserId: req.user.id }));
  })
);

router.put(
  '/:id/rating',
  authenticate,
  requireAdmin,
  validate({ params: z.object({ id: uuid }), body: ratingSchema }),
  asyncHandler(async (req, res) => {
    const player = await playerService.setRating({
      playerId: req.params.id, ...req.body, actorUserId: req.user.id,
    });
    res.json({ player });
  })
);

router.get(
  '/:id/rating-history',
  authenticate,
  requireAdmin,
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({ history: await playerService.getRatingHistory(req.params.id) });
  })
);

export default router;
