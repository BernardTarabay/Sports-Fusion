// Districts and venues.
//
// Districts are what replace the 1,600-member WhatsApp community cap. A player follows
// as many as they like rather than belonging to exactly one.

import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../database/pool.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRoles, requireAdmin, requireDistrictAccess } from '../../middleware/authorize.js';
import { NotFoundError } from '../../lib/errors.js';

const router = Router();
const uuid = z.string().uuid();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT d.id, d.slug, d.name, d.name_ar, d.region,
              (SELECT count(*)::int FROM district_followers f WHERE f.district_id = d.id) AS followers,
              (SELECT count(*)::int FROM games g
                WHERE g.district_id = d.id
                  AND g.status IN ('registration_open','full','teams_generated')
                  AND g.kickoff_at > now()) AS upcoming_games
         FROM districts d
        WHERE d.is_active
        ORDER BY d.name`
    );
    res.json({ districts: rows });
  })
);

router.get(
  '/:id/venues',
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, name, address, google_maps_url, pitch_type, default_capacity, logo_url
         FROM venues WHERE district_id = $1 AND is_active ORDER BY name`,
      [req.params.id]
    );
    res.json({ venues: rows });
  })
);

// Venues were readable but not creatable, so a fresh install had nowhere to play. An
// admin adding their own pitch is the first thing that happens after signing in.
router.post(
  '/:id/venues',
  authenticate,
  requireAdmin,
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      name: z.string().trim().min(2).max(120),
      address: z.string().trim().max(300).optional(),
      googleMapsUrl: z.string().url().max(500).optional(),
      pitchType: z.enum(['grass', 'turf', 'indoor', 'sand']).optional(),
      defaultCapacity: z.number().int().min(2).max(40).optional(),
      hourlyCost: z.number().nonnegative().optional(),
      currency: z.string().length(3).default('USD'),
      contactName: z.string().trim().max(120).optional(),
      contactPhone: z.string().trim().max(40).optional(),
      notes: z.string().max(1000).optional(),
      logoUrl: z.string()
        .regex(/^data:image\/(png|jpeg|webp|svg\+xml);/, 'The logo must be an inline image')
        .max(400_000)
        .optional(),
    }),
  }),
  requireDistrictAccess((req) => req.params.id),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await query(
      `INSERT INTO venues (district_id, name, address, google_maps_url, pitch_type,
                           default_capacity, hourly_cost, currency, contact_name,
                           contact_phone, notes, logo_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, name, address, google_maps_url, pitch_type, default_capacity, logo_url`,
      [req.params.id, b.name, b.address ?? null, b.googleMapsUrl ?? null, b.pitchType ?? null,
       b.defaultCapacity ?? null, b.hourlyCost ?? null, b.currency, b.contactName ?? null,
       b.contactPhone ?? null, b.notes ?? null, b.logoUrl ?? null]
    );
    res.status(201).json({ venue: rows[0] });
  })
);

// Remove a venue. Games reference venues, so one that has hosted anything is retired
// rather than deleted -- an old fixture that suddenly has no venue is a worse outcome
// than a venue that no longer appears in the picker.
router.delete(
  '/:id/venues/:venueId',
  authenticate,
  requireAdmin,
  validate({ params: z.object({ id: uuid, venueId: uuid }) }),
  requireDistrictAccess((req) => req.params.id),
  asyncHandler(async (req, res) => {
    const { rows: [used] } = await query(
      'SELECT COUNT(*)::int AS games FROM games WHERE venue_id = $1', [req.params.venueId]
    );
    if (used.games > 0) {
      await query('UPDATE venues SET is_active = false WHERE id = $1 AND district_id = $2',
        [req.params.venueId, req.params.id]);
      return res.json({ deleted: false, retired: true, games: used.games, reason: 'HAS_GAMES' });
    }
    const { rowCount } = await query('DELETE FROM venues WHERE id = $1 AND district_id = $2',
      [req.params.venueId, req.params.id]);
    if (!rowCount) throw new NotFoundError('Venue');
    res.json({ deleted: true, retired: false });
  })
);

// Edit a venue. The logo is the reason this exists, but renaming a pitch or correcting
// its address should not require deleting and recreating it either.
router.patch(
  '/:id/venues/:venueId',
  authenticate,
  requireAdmin,
  validate({
    params: z.object({ id: uuid, venueId: uuid }),
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      address: z.string().trim().max(300).optional(),
      googleMapsUrl: z.string().url().max(500).optional(),
      pitchType: z.enum(['grass', 'turf', 'indoor', 'sand']).optional(),
      defaultCapacity: z.number().int().min(2).max(40).optional(),
      // Inline only, and capped. The cap is what stops a venue row becoming a megabyte:
      // the client downscales to 256px before encoding, so anything arriving larger than
      // this was not produced by our upload path.
      logoUrl: z.string()
        .regex(/^data:image\/(png|jpeg|webp|svg\+xml);/, 'The logo must be an inline image')
        .max(400_000, 'That logo is too large -- it should be downscaled before upload')
        .nullable()
        .optional(),
    }).refine((v) => Object.keys(v).length > 0, 'Nothing to change'),
  }),
  requireDistrictAccess((req) => req.params.id),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await query(
      `UPDATE venues SET
         name              = COALESCE($3, name),
         address           = COALESCE($4, address),
         google_maps_url   = COALESCE($5, google_maps_url),
         pitch_type        = COALESCE($6, pitch_type),
         default_capacity  = COALESCE($7, default_capacity),
         -- Distinguishes "not mentioned" from "remove it": COALESCE cannot, because both
         -- arrive as null. The flag is only true when the key was actually present.
         logo_url          = CASE WHEN $9::boolean THEN $8 ELSE logo_url END
       WHERE id = $2 AND district_id = $1
       RETURNING id, name, address, google_maps_url, pitch_type, default_capacity, logo_url`,
      [
        req.params.id, req.params.venueId,
        b.name ?? null, b.address ?? null, b.googleMapsUrl ?? null,
        b.pitchType ?? null, b.defaultCapacity ?? null,
        b.logoUrl ?? null, Object.hasOwn(b, 'logoUrl'),
      ]
    );
    if (!rows[0]) throw new NotFoundError('Venue');
    res.json({ venue: rows[0] });
  })
);

router.post(
  '/:id/follow',
  authenticate,
  validate({ params: z.object({ id: uuid }), body: z.object({ isPrimary: z.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT id FROM districts WHERE id = $1 AND is_active', [req.params.id]);
    if (rows.length === 0) throw new NotFoundError('District');

    await query(
      `INSERT INTO district_followers (district_id, user_id, is_primary)
       VALUES ($1, $2, $3)
       ON CONFLICT (district_id, user_id) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
      [req.params.id, req.user.id, req.body.isPrimary]
    );
    res.status(204).end();
  })
);

router.delete(
  '/:id/follow',
  authenticate,
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    await query(
      'DELETE FROM district_followers WHERE district_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.status(204).end();
  })
);

router.post(
  '/',
  authenticate,
  requireRoles('admin', 'owner'),
  validate({
    body: z.object({
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/),
      name: z.string().trim().min(2).max(80),
      nameAr: z.string().trim().max(80).optional(),
      region: z.string().trim().max(80).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `INSERT INTO districts (slug, name, name_ar, region, launched_at)
       VALUES ($1,$2,$3,$4, CURRENT_DATE) RETURNING id, slug, name`,
      [req.body.slug, req.body.name, req.body.nameAr ?? null, req.body.region ?? null]
    );
    res.status(201).json({ district: rows[0] });
  })
);

export default router;
