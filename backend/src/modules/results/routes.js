import { Router } from 'express';
import { z } from 'zod';
import * as resultService from './service.js';
import * as gameService from '../games/service.js';
import * as playerService from '../players/service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate, optionalAuth } from '../../middleware/authenticate.js';
import { requireAdmin, requireDistrictAccess } from '../../middleware/authorize.js';
import { POSITIONS } from '../teams/formation.js';

const router = Router();

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const gameDistrict = (req) => gameService.getGameDistrictId(req.params.id);

const attendanceEntry = z.object({
  playerId: uuid,
  status: z.enum(['attended', 'late', 'no_show']),
});

const awardEntry = z.object({
  playerId: uuid,
  awardType: z.enum(['motm', 'best_player', 'worst_player', 'best_goalkeeper', 'most_improved', 'best_goal']),
  note: z.string().max(300).optional(),
});

const statEntry = z.object({
  playerId: uuid,
  goals: z.number().int().min(0).max(50).default(0),
  assists: z.number().int().min(0).max(50).default(0),
  ownGoals: z.number().int().min(0).max(20).default(0),
  saves: z.number().int().min(0).max(100).default(0),
  cleanSheet: z.boolean().default(false),
  minutes: z.number().int().min(0).max(240).optional(),
  positionPlayed: z.enum(POSITIONS).optional(),
});

const scoreEntry = z.object({
  teamId: uuid,
  score: z.number().int().min(0).max(99),
});

const submitSchema = z.object({
  scores: z.array(scoreEntry).min(2).max(4),
  // Only the exceptions. Everyone else confirmed is marked present.
  attendance: z.array(attendanceEntry).max(40).default([]),
  awards: z.array(awardEntry).max(10).default([]),
  stats: z.array(statEntry).max(40).default([]),
});

const correctSchema = z.object({
  scores: z.array(scoreEntry).min(2).max(4).optional(),
  attendance: z.array(attendanceEntry).max(40).optional(),
  awards: z.array(awardEntry).max(10).optional(),
  stats: z.array(statEntry).max(40).optional(),
  reason: z.string().trim().min(3).max(500),
});

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

router.get(
  '/:id/result',
  optionalAuth,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ result: await resultService.getResult(req.params.id) });
  })
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.post(
  '/:id/result',
  authenticate,
  requireAdmin,
  validate({ params: idParam, body: submitSchema }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const result = await resultService.submitResult({
      gameId: req.params.id, ...req.body, actorUserId: req.user.id,
    });
    res.status(201).json({ result });
  })
);

router.patch(
  '/:id/result',
  authenticate,
  requireAdmin,
  validate({ params: idParam, body: correctSchema }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const result = await resultService.correctResult({
      gameId: req.params.id, ...req.body, actorUserId: req.user.id,
    });
    res.json({ result });
  })
);

// Every version of the score, for when someone disputes it.
router.get(
  '/:id/result/history',
  authenticate,
  requireAdmin,
  validate({ params: idParam }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json({ history: await resultService.getResultHistory(req.params.id) });
  })
);

router.post(
  '/:id/attendance',
  authenticate,
  requireAdmin,
  validate({ params: idParam, body: z.object({ entries: z.array(attendanceEntry).max(40) }) }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json(await resultService.recordAttendance({
      gameId: req.params.id, entries: req.body.entries, actorUserId: req.user.id,
    }));
  })
);

// ---------------------------------------------------------------------------
// Peer ratings
// ---------------------------------------------------------------------------

router.post(
  '/:id/peer-ratings',
  authenticate,
  validate({
    params: idParam,
    body: z.object({
      ratings: z.array(z.object({
        playerId: uuid,
        scores: z.record(
          z.enum(['overall', 'passing', 'defending', 'effort', 'attitude']),
          z.number().int().min(1).max(5)
        ),
      })).min(1).max(30),
    }),
  }),
  asyncHandler(async (req, res) => {
    const raterPlayerId = await playerService.playerIdForUser(req.user.id);
    res.json(await resultService.submitPeerRatings({
      gameId: req.params.id, raterPlayerId, ratings: req.body.ratings,
    }));
  })
);

// Admin only. Peer consensus is an input to the admin's judgement, not a public
// scoreboard -- publishing "your teammates rated you 2.1" is how a community stops
// being one.
router.get(
  '/:id/peer-ratings',
  authenticate,
  requireAdmin,
  validate({ params: idParam }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json(await resultService.getPeerRatingSummary(req.params.id));
  })
);

export default router;
