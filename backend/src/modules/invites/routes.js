// Invite routes.
//
// Two audiences with opposite requirements in one file. /api/invites is admin-only:
// creating, listing and revoking links. /api/join/:token is deliberately public, because
// the entire point is somebody who has no account following a link from WhatsApp.
//
// The public side is rate limited hard and never reveals anything about the invite beyond
// what makes the page comprehensible -- not who made it, not who has claimed it, not how
// many uses are left. A scraper walking tokens should learn nothing worth having.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import * as invites from './service.js';
import * as phoneAuth from '../auth/phone.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
  requireAdmin, requireDistrictAccess, isGlobalAdmin, adminDistrictIds,
} from '../../middleware/authorize.js';
import { setAuthCookies } from '../../lib/tokens.js';
import { POSITIONS } from '../teams/formation.js';
import config from '../../config/index.js';

const uuid = z.string().uuid();
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +9613123456');

const context = (req) => ({
  userAgent: req.get('user-agent')?.slice(0, 500),
  ipAddress: req.ip,
});

// This is the one door in the system with no authentication in front of it, and it
// creates accounts and sends messages that cost money -- so it needs a ceiling. But the
// ceiling cannot be tight, because the intended use is a whole squad scanning the same
// QR code on the same venue wifi, and Lebanese carriers NAT heavily on top of that.
// Twenty of them onboarding together must not lock out the twenty-first.
//
// What actually stops abuse is downstream and per-identity: three codes per number per
// fifteen minutes, a six-digit code required before any account is created, and
// max_uses on the invite itself. This is a spend cap, not the security boundary.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' } },
  skip: () => config.isTest,
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminRouter = Router();

adminRouter.post(
  '/',
  authenticate,
  requireAdmin,
  validate({
    body: z.object({
      districtId: uuid.optional(),
      gameId: uuid.optional(),
      label: z.string().trim().max(120).optional(),
      maxUses: z.number().int().min(1).max(5000).optional(),
      expiresAt: z.coerce.date().optional(),
    }),
  }),
  // A district admin cannot mint a link into someone else's district. When no district is
  // given the invite is global, which only a global admin may do.
  requireDistrictAccess((req) => req.body.districtId),
  asyncHandler(async (req, res) => {
    const invite = await invites.createInvite({ ...req.body, actorUserId: req.user.id });
    // The only response that ever carries the raw token.
    res.status(201).json({ invite });
  })
);

// Creating an invite was district-scoped and listing them was not, so a district admin
// could read every other district's links -- and revoking was not either, so they could
// switch off somebody else's onboarding. A district admin sees their own districts; a
// global admin sees everything.
adminRouter.get(
  '/',
  authenticate,
  requireAdmin,
  validate({ query: z.object({ districtId: uuid.optional() }) }),
  asyncHandler(async (req, res) => {
    const scope = isGlobalAdmin(req.user) ? null : adminDistrictIds(req.user);
    res.json({
      invites: await invites.listInvites({ districtId: req.query.districtId, scope }),
    });
  })
);

adminRouter.delete(
  '/:id',
  authenticate,
  requireAdmin,
  validate({ params: z.object({ id: uuid }) }),
  requireDistrictAccess((req) => invites.districtOfInvite(req.params.id)),
  asyncHandler(async (req, res) => {
    res.json({ invite: await invites.revokeInvite({ inviteId: req.params.id, actorUserId: req.user.id }) });
  })
);

// ---------------------------------------------------------------------------
// Public join flow
//
// Three steps, because the number has to be proven before an account exists:
//   GET  /join/:token         what am I joining?
//   POST /join/:token/code    send me a code
//   POST /join/:token/claim   here is the code, my name and my position
// ---------------------------------------------------------------------------

export const publicRouter = Router();

const tokenParam = z.object({ token: z.string().min(16).max(64) });

publicRouter.get(
  '/:token',
  joinLimiter,
  validate({ params: tokenParam }),
  asyncHandler(async (req, res) => {
    res.json(await invites.getInviteForJoin(req.params.token));
  })
);

publicRouter.post(
  '/:token/code',
  joinLimiter,
  validate({ params: tokenParam, body: z.object({ phone }) }),
  asyncHandler(async (req, res) => {
    // Check the invite first: no point sending a code for a link that has been revoked,
    // and it stops a dead token being used as a free SMS gateway.
    await invites.getInviteForJoin(req.params.token);
    const challenge = await phoneAuth.startChallenge({
      phone: req.body.phone, purpose: 'login', context: context(req),
    });
    res.json(challenge);
  })
);

publicRouter.post(
  '/:token/claim',
  joinLimiter,
  validate({
    params: tokenParam,
    body: z.object({
      phone,
      code: z.string().regex(/^\d{6}$/, 'Enter the six digit code'),
      displayName: z.string().trim().min(2).max(80),
      preferredPosition: z.enum(POSITIONS).optional(),
      isGoalkeeper: z.boolean().default(false),
      districtId: uuid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { phone: number, code, ...profile } = req.body;

    // Verify the number FIRST, in its own step. An invite link on its own must never be
    // able to manufacture an account against a number the holder does not control --
    // otherwise one leaked link plus a script is a few thousand junk players.
    await phoneAuth.consumeForSignup({ phone: number, code });

    const result = await invites.claimInviteAndJoin({
      token: req.params.token, phone: number, ...profile, context: context(req),
    });

    setAuthCookies(res, result);
    res.status(result.created ? 201 : 200).json({
      user: result.user,
      created: result.created,
      joinedGame: result.joinedGame,
    });
  })
);
