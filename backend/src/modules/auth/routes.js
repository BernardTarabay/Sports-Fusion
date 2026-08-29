import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import * as authService from './service.js';
import * as phoneAuth from './phone.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from '../../lib/tokens.js';
import config from '../../config/index.js';

const router = Router();

// Credential endpoints are rate limited by IP. Without this, a 4,000-member community's
// phone numbers are a very short list to spray passwords at.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' } },
  // Integration tests create dozens of accounts from one address. Rate limiting is
  // therefore NOT covered by the test suite and must be verified against a deployed
  // environment.
  skip: () => config.isTest,
});

// Phone codes get their own, looser IP ceiling.
//
// The password limiter is 10 per 15 minutes per IP, which is right for password guessing
// and badly wrong here. Lebanese mobile carriers NAT aggressively and a whole team scans
// the same QR code on the same venue wifi -- twenty-two people onboarding at a pitch
// would lock each other out with a limit meant to stop one attacker.
//
// The real protection for this endpoint is per-NUMBER (three codes per fifteen minutes,
// in startChallenge), which an attacker cannot dodge by changing IP and which is what
// actually stops someone's phone being used as a message target. The IP limit here is
// only a ceiling on total spend.
const phoneCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' } },
  skip: () => config.isTest,
});

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +9613123456');
const password = z.string().min(8, 'Use at least 8 characters').max(200);

const signupSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  email: z.string().email().optional(),
  phone: phone.optional(),
  password,
  districtId: z.string().uuid().optional(),
}).refine((v) => v.email || v.phone, {
  message: 'An email address or a phone number is required',
  path: ['phone'],
});

const loginSchema = z.object({
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
});

const context = (req) => ({
  userAgent: req.get('user-agent')?.slice(0, 500),
  ipAddress: req.ip,
});

router.post(
  '/signup',
  credentialLimiter,
  validate({ body: signupSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.signup({ ...req.body, context: context(req) });
    setAuthCookies(res, result);
    res.status(201).json({ user: result.user, accessToken: result.accessToken });
  })
);

router.post(
  '/login',
  credentialLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.login({ ...req.body, context: context(req) });
    setAuthCookies(res, result);
    res.json({ user: result.user, accessToken: result.accessToken });
  })
);

// ---------------------------------------------------------------------------
// Phone sign-in
//
// Two calls: ask for a code, send it back. Works identically for a player and for an
// admin -- the roles come from the database once the number is proven, never from
// anything the client says.
// ---------------------------------------------------------------------------

router.post(
  '/phone/start',
  phoneCodeLimiter,
  validate({ body: z.object({ phone }) }),
  asyncHandler(async (req, res) => {
    const challenge = await phoneAuth.startChallenge({
      phone: req.body.phone, purpose: 'login', context: context(req),
    });
    // Identical response whether or not that number has an account. Anything else turns
    // this endpoint into a "is this person registered?" oracle for the whole community.
    res.json(challenge);
  })
);

router.post(
  '/phone/verify',
  phoneCodeLimiter,
  validate({
    body: z.object({
      phone,
      code: z.string().regex(/^\d{6}$/, 'Enter the six digit code'),
      // Only used when the number has no account yet.
      displayName: z.string().trim().min(2).max(80).optional(),
      districtId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await phoneAuth.verifyChallenge({ ...req.body, context: context(req) });
    setAuthCookies(res, result);
    res.status(result.created ? 201 : 200).json({
      user: result.user, accessToken: result.accessToken, created: result.created,
    });
  })
);

// Attach a number to the account already signed in. How the seeded email/password admin
// becomes reachable on WhatsApp and can then sign in the same way everyone else does.
router.post(
  '/phone/link/start',
  authenticate,
  phoneCodeLimiter,
  validate({ body: z.object({ phone }) }),
  asyncHandler(async (req, res) => {
    res.json(await phoneAuth.startChallenge({
      phone: req.body.phone, purpose: 'link_phone', context: context(req),
    }));
  })
);

router.post(
  '/phone/link/verify',
  authenticate,
  phoneCodeLimiter,
  validate({ body: z.object({ phone, code: z.string().regex(/^\d{6}$/) }) }),
  asyncHandler(async (req, res) => {
    res.json(await phoneAuth.linkPhone({
      userId: req.user.id, phone: req.body.phone, code: req.body.code,
    }));
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    // Accept the token from the body too, for clients that cannot use cookies.
    const refreshToken = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
    try {
      const result = await authService.refresh({ refreshToken, context: context(req) });
      setAuthCookies(res, result);
      res.json({ user: result.user, accessToken: result.accessToken });
    } catch (err) {
      // A failed refresh means the session is unusable; do not leave stale cookies behind
      // for the client to keep retrying with.
      clearAuthCookies(res);
      throw err;
    }
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
    await authService.logout({ refreshToken, allDevices: false });
    clearAuthCookies(res);
    res.status(204).end();
  })
);

router.post(
  '/logout-all',
  authenticate,
  asyncHandler(async (req, res) => {
    await authService.logout({ userId: req.user.id, allDevices: true });
    clearAuthCookies(res);
    res.status(204).end();
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: await authService.getCurrentUser(req.user.id) });
  })
);

export default router;
