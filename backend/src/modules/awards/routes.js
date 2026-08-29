// Awards. Public, like the leaderboard: who is playing well is the thing a prospective
// player is shown before they have an account.

import { Router } from 'express';
import { z } from 'zod';
import * as awards from './service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { optionalAuth } from '../../middleware/authenticate.js';

const router = Router();

router.get(
  '/man-of-the-month',
  optionalAuth,
  validate({
    query: z.object({
      districtId: z.string().uuid().optional(),
      previousMonths: z.coerce.number().int().min(0).max(12).default(3),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await awards.getManOfTheMonth(req.query));
  })
);

export default router;
