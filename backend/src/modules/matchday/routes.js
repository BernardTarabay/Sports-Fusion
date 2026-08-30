// Matchday routes. Everything here is admin-only and district-scoped.
//
// Mounted under /api/games, so the paths read as /api/games/:id/payments and so on.
//
// Authorisation is `authenticate` -> `requireAdmin` -> `requireDistrictAccess`, in that
// order, on every route without exception. The frontend hides controls an admin should
// not see, but that is presentation: a district admin for Metn calling Keserwan's game
// directly is stopped here, not by the UI that never rendered the button.

import { Router } from 'express';
import { z } from 'zod';
import * as matchday from './service.js';
import * as gameService from '../games/service.js';
import * as registrationService from '../registrations/service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAdmin, requireDistrictAccess } from '../../middleware/authorize.js';

const router = Router();

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const gameDistrict = (req) => gameService.getGameDistrictId(req.params.id);

// Admin + district guard, applied identically everywhere below.
const guard = [authenticate, requireAdmin];

const attendanceStatus = z.enum(['attended', 'late', 'no_show']);

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

router.get(
  '/:id/matchday',
  ...guard,
  validate({ params: idParam }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json({ game: await matchday.getMatchday(req.params.id) });
  })
);

// ---------------------------------------------------------------------------
// Roster (admin adds and removes on a player's behalf)
//
// An admin building a game from a WhatsApp thread is not going to wait for twenty-two
// people to tap "join". `via: 'admin'` records that it was not the player who signed up,
// which keeps the reliability statistics honest -- somebody added to a game they never
// agreed to should not be marked a no-show against their own record.
// ---------------------------------------------------------------------------

router.post(
  '/:id/roster',
  ...guard,
  validate({
    params: idParam,
    body: z.object({ playerId: uuid, allowWaitlist: z.boolean().default(true) }),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    await registrationService.registerPlayer({
      gameId: req.params.id,
      playerId: req.body.playerId,
      actorUserId: req.user.id,
      via: 'admin',
      allowWaitlist: req.body.allowWaitlist,
    });
    res.status(201).json({ game: await matchday.getMatchday(req.params.id) });
  })
);

router.delete(
  '/:id/roster/:playerId',
  ...guard,
  validate({ params: z.object({ id: uuid, playerId: uuid }) }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    await registrationService.cancelRegistration({
      gameId: req.params.id, playerId: req.params.playerId, actorUserId: req.user.id,
    });
    res.json({ game: await matchday.getMatchday(req.params.id) });
  })
);

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

router.post(
  '/:id/clock',
  ...guard,
  validate({
    params: idParam,
    body: z.object({
      action: z.enum([
        'start', 'halftime', 'resume', 'end', 'abandon', 'pause', 'unpause',
        // Puts a finished or abandoned match back to not-started. An admin who taps
        // "End" at half time currently has a completed game and no way back, which is
        // a harsh outcome for a mis-tap on a phone in the dark.
        'reset',
      ]),
    }),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const game = await matchday.advanceClock({
      gameId: req.params.id, action: req.body.action, actorUserId: req.user.id,
    });
    res.json({ game });
  })
);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

router.post(
  '/:id/payments',
  ...guard,
  validate({
    params: idParam,
    body: z.object({
      playerId: uuid,
      paid: z.boolean(),
      method: z.enum(['cash', 'card', 'transfer', 'credit', 'waived']).default('cash'),
    }),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const game = await matchday.setPayment({
      gameId: req.params.id, ...req.body, actorUserId: req.user.id,
    });
    res.json({ game });
  })
);

// ---------------------------------------------------------------------------
// Attendance and live stats
// ---------------------------------------------------------------------------

router.patch(
  '/:id/players/:playerId/stats',
  ...guard,
  validate({
    params: z.object({ id: uuid, playerId: uuid }),
    body: z.object({
      attendance: attendanceStatus.nullable().optional(),
      goals: z.number().int().min(0).max(30).optional(),
      assists: z.number().int().min(0).max(30).optional(),
      // The 1-10 slider on the player panel. It has always been there and this schema
      // has never mentioned it -- and validate() strips unknown keys BEFORE the
      // "nothing to change" refinement runs, so every drag answered 422 and no rating
      // was ever stored. Not the Glicko rating: that one is derived and replayed.
      rating: z.number().min(1).max(10).nullable().optional(),
    }).refine((v) => Object.keys(v).length > 0, 'Nothing to change'),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const game = await matchday.setPlayerStat({
      gameId: req.params.id, playerId: req.params.playerId,
      patch: req.body, actorUserId: req.user.id,
    });
    res.json({ game });
  })
);

// Bulk attendance. Omitting playerIds means everyone confirmed, which is the common case:
// "everyone was here", then flag the two exceptions.
router.post(
  '/:id/attendance/all',
  ...guard,
  validate({
    params: idParam,
    body: z.object({
      status: attendanceStatus,
      playerIds: z.array(uuid).max(60).optional(),
    }),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const game = await matchday.markAllAttendance({
      gameId: req.params.id, ...req.body, actorUserId: req.user.id,
    });
    res.json({ game });
  })
);

// ---------------------------------------------------------------------------
// Formation and awards
// ---------------------------------------------------------------------------

router.post(
  '/:id/formation',
  ...guard,
  validate({
    params: idParam,
    // Shape, not catalogue. The list of formations lives in the frontend, where the
    // pitch coordinates for each slot live too; duplicating the names here would mean
    // adding a formation in two places and getting a 422 when you forgot the second.
    // "4-3-3", "4-2-3-1", "3-2-1" pass; anything that is not outfield lines does not.
    body: z.object({
      formation: z.string().regex(/^[1-9](-[1-9]){1,4}$/, 'Use outfield lines, e.g. 4-3-3'),
    }),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const game = await matchday.setFormation({
      gameId: req.params.id, formation: req.body.formation, actorUserId: req.user.id,
    });
    res.json({ game });
  })
);

// Guarding the team sheet is a deliberate act, so it has its own route rather than
// riding along on a status change that discarded it.
router.post(
  '/:id/teams/lock',
  ...guard,
  validate({ params: idParam, body: z.object({ locked: z.boolean() }) }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json({
      game: await matchday.setTeamsLocked({
        gameId: req.params.id, locked: req.body.locked, actorUserId: req.user.id,
      }),
    });
  })
);

router.post(
  '/:id/motm',
  ...guard,
  validate({ params: idParam, body: z.object({ playerId: uuid.nullable() }) }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const game = await matchday.setMotm({
      gameId: req.params.id, playerId: req.body.playerId, actorUserId: req.user.id,
    });
    res.json({ game });
  })
);

export default router;
