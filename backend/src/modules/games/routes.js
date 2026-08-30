import { Router } from 'express';
import { z } from 'zod';
import * as gameService from './service.js';
import * as registrationService from '../registrations/service.js';
import * as teamService from '../teams/service.js';
import * as matchdayService from '../matchday/service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate, optionalAuth } from '../../middleware/authenticate.js';
import {
  requireAdmin, requireDistrictAccess, isGlobalAdmin, adminDistrictIds,
} from '../../middleware/authorize.js';
import { ANNOUNCEMENT_KINDS } from '../../integrations/whatsapp/announcements.js';
import { query } from '../../database/pool.js';
import { NotFoundError } from '../../lib/errors.js';

/** Map an authenticated user to their player record. */
async function playerIdFor(userId) {
  const { rows } = await query('SELECT id FROM players WHERE user_id = $1', [userId]);
  if (rows.length === 0) throw new NotFoundError('Player profile');
  return rows[0].id;
}

/**
 * The viewer's player id, or null.
 *
 * Non-throwing, unlike playerIdFor. These are the public reads: an anonymous visitor has
 * no player, and so does an admin account with no football profile. Neither is an error,
 * and both should see the fixture list.
 */
async function viewerPlayerId(req) {
  if (!req.user) return null;
  const { rows } = await query('SELECT id FROM players WHERE user_id = $1', [req.user.id]);
  return rows[0]?.id ?? null;
}

const router = Router();

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

const listQuery = z.object({
  districtId: uuid.optional(),
  status: z.union([z.string(), z.array(z.string())]).optional()
    .transform((v) => (v == null ? undefined : Array.isArray(v) ? v : v.split(','))),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // Clients ask in these terms far more often than they ask for a date range. Without
  // it, `?when=upcoming` was silently ignored and every caller got the whole list --
  // which showed up as the same game rendered twice in the admin timeline.
  when: z.enum(['upcoming', 'past', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createSchema = z.object({
  districtId: uuid,
  venueId: uuid.optional(),
  kickoffAt: z.coerce.date().refine((d) => d > new Date(), 'Kickoff must be in the future'),
  capacity: z.number().int().min(2).max(30).default(22),
  teamSize: z.number().int().min(1).max(15).default(11),
  teamCount: z.number().int().min(2).max(4).default(2),
  waitlistCapacity: z.number().int().min(0).max(50).default(10),
  durationMinutes: z.number().int().min(20).max(240).default(90),
  arriveByMinutes: z.number().int().min(0).max(120).default(15),
  registrationOpensAt: z.coerce.date().optional(),
  registrationClosesAt: z.coerce.date().optional(),
  price: z.number().nonnegative().optional(),
  currency: z.string().length(3).default('USD'),
  // .nullish(), not .optional(): a form with an empty title sends null, and rejecting
  // that produced a 422 on 'Expected string, received null' for a field nobody filled in.
  title: z.string().max(120).nullish().transform((v) => v ?? undefined),
  notes: z.string().max(2000).nullish().transform((v) => v ?? undefined),
  openImmediately: z.boolean().default(false),
});

// The district a game belongs to, for the authorisation guard.
const gameDistrict = (req) => gameService.getGameDistrictId(req.params.id);

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

router.get(
  '/',
  optionalAuth,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    // A draft is an admin's private working state, so it is hidden -- but it was hidden
    // from DISTRICT admins too, who are the people who create them. They could open
    // registration on a game they had no way to find. A global admin sees every draft;
    // a district admin sees their own districts'; everyone else sees none.
    // The viewer's own registration travels with each fixture. Without it the "You're in"
    // badge never appeared and the Games page's "Mine" tab -- which filters on
    // `g.isRegistered` -- was permanently empty for everybody.
    const games = await gameService.listGames({
      ...req.query,
      includePrivate: isGlobalAdmin(req.user),
      privateDistrictIds: isGlobalAdmin(req.user) ? null : adminDistrictIds(req.user),
      viewerPlayerId: await viewerPlayerId(req),
    });
    res.json({ games });
  })
);

// Shareable link. This is the growth loop: a player sends it to a friend who does not
// need to join a 1,600-person WhatsApp community to see a game and sign up.
router.get(
  '/slug/:slug',
  optionalAuth,
  validate({ params: z.object({ slug: z.string().min(3).max(60) }) }),
  asyncHandler(async (req, res) => {
    const game = await gameService.getGameBySlug(req.params.slug, undefined, await viewerPlayerId(req));
    const roster = await registrationService.getRoster(game.id);
    res.json({ game, roster: { confirmed: roster.confirmed.length, waitlist: roster.waitlist.length } });
  })
);

router.get(
  '/:id',
  optionalAuth,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const game = await gameService.getGame(req.params.id, undefined, await viewerPlayerId(req));

    // Fanned out. The three reads below depend on the game's id and on nothing else, and
    // awaiting them one after another spends three round trips of latency on a page a
    // player opens standing outside a pitch on a mobile connection.
    //
    // Teams are fetched whenever they exist, not only at 'teams_generated': a player
    // wants the team sheet while the match is on and after it has finished, and gating on
    // one status made the pitch go blank the moment the game kicked off.
    const [roster, teams, clock] = await Promise.all([
      registrationService.getRoster(game.id),
      teamService.getTeams(game.id),
      // Read-only. The match clock is not privileged information -- anyone watching the
      // game can see a clock -- and without it a player's pitch has no time on it.
      gameService.getPublicClock(game.id),
    ]);

    res.json({ game, roster, teams, clock });
  })
);

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

router.post(
  '/:id/join',
  authenticate,
  validate({ params: idParam, body: z.object({ allowWaitlist: z.boolean().default(true) }) }),
  asyncHandler(async (req, res) => {
    const result = await registrationService.registerPlayer({
      gameId: req.params.id,
      playerId: await playerIdFor(req.user.id),
      actorUserId: req.user.id,
      allowWaitlist: req.body.allowWaitlist,
    });
    res.status(result.alreadyRegistered ? 200 : 201).json(result);
  })
);

router.post(
  '/:id/leave',
  authenticate,
  validate({ params: idParam, body: z.object({ reason: z.string().max(500).optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await registrationService.cancelRegistration({
      gameId: req.params.id,
      playerId: await playerIdFor(req.user.id),
      actorUserId: req.user.id,
      reason: req.body.reason,
    });
    res.json(result);
  })
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.post(
  '/',
  authenticate,
  requireAdmin,
  validate({ body: createSchema }),
  requireDistrictAccess((req) => req.body.districtId),
  asyncHandler(async (req, res) => {
    const game = await gameService.createGame({ ...req.body, actorUserId: req.user.id });
    res.status(201).json({ game });
  })
);

router.post(
  '/:id/open',
  authenticate,
  requireAdmin,
  validate({ params: idParam }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json({ game: await gameService.openRegistration({ gameId: req.params.id, actorUserId: req.user.id }) });
  })
);

router.post(
  '/:id/cancel',
  authenticate,
  requireAdmin,
  validate({ params: idParam, body: z.object({ reason: z.string().max(500).optional() }) }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const game = await gameService.cancelGame({
      gameId: req.params.id, reason: req.body.reason, actorUserId: req.user.id,
    });
    res.json({ game });
  })
);

// Delete, as distinct from cancel. Cancel records that a game was called off; delete is
// for a game that should never have existed -- a mistake, a duplicate, a test fixture.
// Refused once ratings or points have been settled; see deleteGame.
router.delete(
  '/:id',
  authenticate,
  requireAdmin,
  validate({ params: idParam }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json(await gameService.deleteGame({ gameId: req.params.id, actorUserId: req.user.id }));
  })
);

router.get(
  '/:id/roster',
  authenticate,
  requireAdmin,
  validate({ params: idParam }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json(await registrationService.getRoster(req.params.id));
  })
);

router.post(
  '/:id/waitlist/reorder',
  authenticate,
  requireAdmin,
  validate({
    params: idParam,
    body: z.object({ registrationId: uuid, newPosition: z.number().int().min(1) }),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json(await registrationService.reorderWaitlist({
      gameId: req.params.id, ...req.body, actorUserId: req.user.id,
    }));
  })
);

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

router.post(
  '/:id/teams/generate',
  authenticate,
  requireAdmin,
  validate({
    params: idParam,
    body: z.object({
      // Passing the seed of a previous run reproduces it exactly.
      seed: z.number().int().nonnegative().optional(),
      weights: z.record(z.number()).optional(),
      force: z.boolean().default(false),
    }),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const result = await teamService.generateTeams({
      gameId: req.params.id, ...req.body, actorUserId: req.user.id,
    });
    res.status(201).json(result);
  })
);

// Teams WITHOUT the balancer.
//
// /teams/generate refuses anything short of a full roster, which is correct for a
// balanced split and useless as the only way to have a team sheet at all. This seats
// whoever has joined so an admin can arrange the board days before the game fills.
router.post(
  '/:id/teams/draft',
  authenticate,
  requireAdmin,
  validate({ params: idParam }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const result = await teamService.draftTeams({
      gameId: req.params.id, actorUserId: req.user.id,
    });
    res.status(result.created ? 201 : 200).json({
      ...result, game: await matchdayService.getMatchday(req.params.id),
    });
  })
);

router.get(
  '/:id/teams',
  optionalAuth,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ teams: await teamService.getTeams(req.params.id) });
  })
);

router.post(
  '/:id/teams/override',
  authenticate,
  requireAdmin,
  validate({
    params: idParam,
    body: z.object({
      moves: z.array(z.object({
        playerId: uuid,
        toTeamId: uuid,
        // Where on the tactical board. Optional, because a move can be "put them on the
        // other team, anywhere"; when present it is a specific place, and that place may
        // currently be empty.
        slotIndex: z.number().int().min(0).max(29).optional(),
      })).min(1).max(30),
    }),
  }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    const result = await teamService.applyOverride({
      gameId: req.params.id, moves: req.body.moves, actorUserId: req.user.id,
    });
    // The whole game comes back, not just the teams.
    //
    // Every caller of this endpoint is a tactical board that has just moved somebody and
    // needs to redraw -- and the board draws from the matchday projection, not from a
    // bare team list. Returning only { moved, teams, uneven } meant the client read
    // `game` off the response, got undefined, and spread it over its cache: the fixture
    // lost its kickoff time and the screen went blank mid-drag.
    res.json({ ...result, game: await matchdayService.getMatchday(req.params.id) });
  })
);

// What did the admin's edits cost, measured with the generator's own objective?
router.get(
  '/:id/teams/explain',
  authenticate,
  requireAdmin,
  validate({ params: idParam }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json({ explanation: await teamService.explainCurrentTeams(req.params.id) });
  })
);

// ---------------------------------------------------------------------------
// WhatsApp announcement, for the admin to copy into the community.
// ---------------------------------------------------------------------------

router.post(
  '/:id/announcement',
  authenticate,
  requireAdmin,
  validate({ params: idParam, body: z.object({ kind: z.enum(ANNOUNCEMENT_KINDS) }) }),
  requireDistrictAccess(gameDistrict),
  asyncHandler(async (req, res) => {
    res.json(await gameService.buildAnnouncement({
      gameId: req.params.id, kind: req.body.kind, actorUserId: req.user.id,
    }));
  })
);

export default router;
