// Admin overview. Scoped to the districts the caller actually runs: a district admin for
// Metn sees Metn's numbers, and a global admin sees everything.

import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../database/pool.js';
import * as admin from './service.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAdmin, isGlobalAdmin, adminDistrictIds } from '../../middleware/authorize.js';

const router = Router();

router.get(
  '/overview',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    // null means every district. A district admin gets their own list, so the same screen
    // answers "what needs me tonight" correctly for both.
    const districtIds = isGlobalAdmin(req.user) ? null : adminDistrictIds(req.user);
    res.json(await admin.getOverview({ districtIds }));
  })
);

/**
 * The audit trail.
 *
 * Every administrative mutation already writes an admin_actions row -- creating a game,
 * taking a payment, starting the clock, deleting anything. This exposes it, which is what
 * the assistant panel shows and what answers "who changed that, and when".
 *
 * The frontend used to keep this list itself. It cannot: a client cannot be the audit
 * trail for its own actions, because the record then disappears with the tab and can be
 * edited by whoever is being audited.
 */
router.get(
  '/actions',
  authenticate,
  requireAdmin,
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      entityId: z.string().uuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    // Scoped, like /overview above. This route sat on requireAdmin alone, so a district
    // admin for Metn read every administrative action in the league: Keserwan's payments,
    // who was deleted where, what another district's admin did last night. An audit trail
    // is exactly the sort of thing that should be visible to the people it is about and
    // to nobody else.
    //
    // Rows about a game are matched on that game's district; everything else -- a player
    // record, a reward, a district -- is a global object and stays global-admin only.
    const districtIds = isGlobalAdmin(req.user) ? null : adminDistrictIds(req.user);

    const { rows } = await query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.before, a.after, a.reason,
              a.created_at, u.display_name AS actor
         FROM admin_actions a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::uuid IS NULL OR a.entity_id = $1)
          AND ($2::uuid[] IS NULL OR EXISTS (
                SELECT 1 FROM games g
                 WHERE g.id = a.entity_id AND g.district_id = ANY($2)))
        ORDER BY a.created_at DESC
        LIMIT $3`,
      // NOT `districtIds?.length ? districtIds : null`: an empty list means this admin
      // administers no district, and the answer to that is no rows, not all of them.
      [req.query.entityId ?? null, districtIds, req.query.limit]
    );
    res.json({
      actions: rows.map((r) => ({
        id: String(r.id),
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        actor: r.actor,
        reason: r.reason,
        before: r.before,
        after: r.after,
        at: r.created_at,
      })),
    });
  })
);

export default router;
