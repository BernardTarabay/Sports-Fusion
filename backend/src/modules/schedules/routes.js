// Recurring game schedules. Admin only, district-scoped, like everything that runs the
// league. Players never see a schedule — they see the games it produced.

import { Router } from 'express';
import { z } from 'zod';
import * as schedules from './service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAdmin, requireDistrictAccess } from '../../middleware/authorize.js';

const router = Router();
const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

const guard = [authenticate, requireAdmin];

const scheduleDistrict = async (req) => (await schedules.getSchedule(req.params.id)).districtId;

/**
 * HTML forms send strings, and they send empty ones.
 *
 * A `<select>` with no choice made yields "", and a numeric `<select>` yields "22", not
 * 22. Rejecting those is technically correct and practically useless -- it turns "you did
 * not pick a venue" into a 422 with a message about UUIDs. Empty means absent, and a
 * numeric string means the number.
 */
const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);
const optionalUuid = z.preprocess(blankToUndefined, uuid.optional());
const optionalText = (max) => z.preprocess(blankToUndefined, z.string().max(max).optional());

const bodySchema = z.object({
  districtId: uuid,
  venueId: optionalUuid,
  // 0 = Sunday, matching both EXTRACT(DOW) and JavaScript's getDay().
  weekday: z.coerce.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM'),
  timezone: z.string().max(64).default('Asia/Beirut'),
  durationMinutes: z.coerce.number().int().min(20).max(240).default(90),
  capacity: z.coerce.number().int().min(2).max(30).default(22),
  teamSize: z.coerce.number().int().min(1).max(15).default(11),
  teamCount: z.coerce.number().int().min(2).max(4).default(2),
  waitlistCapacity: z.coerce.number().int().min(0).max(50).default(10),
  price: z.preprocess(blankToUndefined, z.coerce.number().nonnegative().optional()),
  currency: z.string().length(3).default('USD'),
  title: optionalText(120),
  notes: optionalText(2000),
  horizonDays: z.coerce.number().int().min(7).max(120).default(28),
  openImmediately: z.coerce.boolean().default(true),
}).refine((v) => v.capacity === v.teamSize * v.teamCount, {
  message: 'Capacity has to divide into whole teams',
  path: ['capacity'],
});

router.get(
  '/',
  ...guard,
  validate({ query: z.object({ districtId: uuid.optional() }) }),
  asyncHandler(async (req, res) => {
    // Top the horizon up on read. A schedule made three weeks ago should not run dry
    // because nothing happened to trigger generation; the unique index makes this free
    // when there is nothing to create.
    await schedules.generate({});
    res.json({ schedules: await schedules.listSchedules({ districtId: req.query.districtId }) });
  })
);

router.post(
  '/',
  ...guard,
  validate({ body: bodySchema }),
  requireDistrictAccess((req) => req.body.districtId),
  asyncHandler(async (req, res) => {
    const schedule = await schedules.createSchedule({ ...req.body, actorUserId: req.user.id });
    res.status(201).json({ schedule });
  })
);

router.get(
  '/:id/games',
  ...guard,
  validate({ params: idParam }),
  requireDistrictAccess(scheduleDistrict),
  asyncHandler(async (req, res) => {
    res.json({ games: await schedules.upcomingFor(req.params.id) });
  })
);

router.patch(
  '/:id',
  ...guard,
  validate({ params: idParam, body: z.object({ isActive: z.boolean() }) }),
  requireDistrictAccess(scheduleDistrict),
  asyncHandler(async (req, res) => {
    const schedule = await schedules.setActive({
      scheduleId: req.params.id, isActive: req.body.isActive, actorUserId: req.user.id,
    });
    res.json({ schedule });
  })
);

router.delete(
  '/:id',
  ...guard,
  validate({
    params: idParam,
    // Off by default: fixtures people have already signed up for outlive the rule that
    // created them. Deleting them too is a separate, deliberate choice.
    query: z.object({ withFuture: z.enum(['true', 'false']).default('false') }),
  }),
  requireDistrictAccess(scheduleDistrict),
  asyncHandler(async (req, res) => {
    res.json(await schedules.deleteSchedule({
      scheduleId: req.params.id,
      withFuture: req.query.withFuture === 'true',
      actorUserId: req.user.id,
    }));
  })
);

export default router;
