// Periodic jobs.
//
// Every job here is a SWEEP, not a schedule: it looks at current state and makes it
// right, rather than relying on something having been queued earlier at the correct time.
// A sweep survives a worker being down for six hours; a queued timer does not.
//
// Sweeps therefore have to be idempotent, and they are -- reminders lean on
// notifications_dedupe_idx, lifecycle transitions are guarded by their WHERE clause.

import { pool } from '@sports-fusion/backend/database/pool';
import { logger } from '@sports-fusion/backend/lib/logger';
import { publish, EventTypes } from '@sports-fusion/backend/lib/events';
import { reclaimStale } from '../notifications/dispatcher.js';
import { decayInactiveRatings } from '@sports-fusion/backend/modules/ratings/service';
import {
  fulfilPending, reclaimStaleFulfilments,
} from '@sports-fusion/backend/modules/rewards/service';

/**
 * Queue reminders for games about to kick off.
 *
 * Runs against every confirmed player of every game inside the window. Re-running it
 * creates nothing new: the dedupe index keys on
 * (user, channel, template, reference_type, reference_id), and the template key differs
 * per reminder, so the 24-hour and 3-hour reminders coexist but neither can duplicate.
 */
export async function queueReminders() {
  const specs = [
    { templateKey: 'game_reminder_24h', within: '24 hours', after: '3 hours' },
    { templateKey: 'game_reminder_3h', within: '3 hours', after: '0 hours' },
  ];

  let queued = 0;

  for (const spec of specs) {
    const { rowCount } = await pool.query(
      `INSERT INTO notifications
         (user_id, player_id, channel, template_key, payload, reference_type, reference_id)
       SELECT p.user_id,
              p.id,
              'in_app',
              $1,
              jsonb_build_object(
                'gameId', g.id,
                'kickoffAt', g.kickoff_at,
                'districtName', d.name,
                'venueName', v.name,
                'venueMapsUrl', v.google_maps_url,
                'arriveByMinutes', g.arrive_by_minutes,
                'capacity', g.capacity,
                'confirmedCount', g.confirmed_count
              ),
              'game',
              g.id
         FROM games g
         JOIN districts d ON d.id = g.district_id
         LEFT JOIN venues v ON v.id = g.venue_id
         JOIN registrations r ON r.game_id = g.id AND r.status = 'confirmed'
         JOIN players p ON p.id = r.player_id
        WHERE g.status IN ('registration_open', 'full', 'teams_generated')
          AND g.kickoff_at > now() + ($3)::interval
          AND g.kickoff_at <= now() + ($2)::interval
       ON CONFLICT DO NOTHING`,
      [spec.templateKey, spec.within, spec.after]
    );
    queued += rowCount;
  }

  if (queued > 0) logger.info({ queued }, 'reminders queued');
  return queued;
}

/**
 * Move games whose kickoff has passed into `in_progress`.
 *
 * Deliberately does NOT auto-complete. A completed game means a result was recorded, and
 * only a human knows the score. Games that sit in `in_progress` are a prompt for the
 * admin, and that is the intended behaviour rather than a gap.
 */
export async function advanceGameLifecycle() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE games
          SET status = 'in_progress'
        WHERE status IN ('registration_open', 'full', 'teams_generated')
          AND kickoff_at <= now()
        RETURNING id, district_id`
    );

    for (const game of rows) {
      await publish(client, {
        eventType: EventTypes.GameStarted,
        aggregateType: 'game',
        aggregateId: game.id,
        payload: { gameId: game.id },
      });
    }

    await client.query('COMMIT');
    if (rows.length > 0) logger.info({ started: rows.length }, 'games moved to in_progress');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Expire points past their expiry date.
 *
 * Writes a negative ledger entry rather than editing the original, so the balance falls,
 * the liability falls, and the reason a player's points disappeared stays on the record.
 */
export async function expirePoints() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: due } = await client.query(
      `SELECT pt.id, pt.player_id, pt.season_id, pt.delta, pt.liability_value,
              p.points_balance
         FROM point_transactions pt
         JOIN players p ON p.id = pt.player_id
        WHERE pt.expires_at IS NOT NULL AND pt.expires_at <= now()
          AND pt.expired_at IS NULL AND pt.delta > 0
        ORDER BY pt.id
        LIMIT 500
        FOR UPDATE OF pt SKIP LOCKED`
    );

    // Points that have already been SPENT must not also expire. Without lot tracking
    // there is no way to know which specific points a redemption consumed, so expiry is
    // capped at what the player still holds. Otherwise a player who earns 100, spends
    // 100, and then sees the original 100 expire ends up at -100 -- which the
    // players_points_non_negative constraint (migration 014) would reject outright,
    // turning a modelling gap into a stuck job.
    const remaining = new Map();

    for (const row of due) {
      const held = remaining.get(row.player_id) ?? row.points_balance;
      const amount = Math.min(row.delta, held);

      if (amount > 0) {
        await client.query(
          `INSERT INTO point_transactions
             (player_id, season_id, delta, reason, reference_type, reference_id, liability_value)
           VALUES ($1, $2, $3, 'expiry', 'point_transaction', NULL, $4)`,
          [
            row.player_id, row.season_id, -amount,
            row.liability_value ? -Number(row.liability_value) * (amount / row.delta) : null,
          ]
        );
        remaining.set(row.player_id, held - amount);
      } else {
        remaining.set(row.player_id, held);
      }

      // Marked expired either way: these points can never be spent again.
      await client.query(
        'UPDATE point_transactions SET expired_at = now() WHERE id = $1', [row.id]
      );
    }

    await client.query('COMMIT');
    if (due.length > 0) logger.info({ expired: due.length }, 'points expired');
    return due.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Delete refresh tokens that expired long ago. Housekeeping, not security. */
export async function pruneExpiredTokens() {
  const { rowCount } = await pool.query(
    `DELETE FROM refresh_tokens WHERE expires_at < now() - interval '30 days'`
  );
  return rowCount;
}

// ---------------------------------------------------------------------------

export const jobs = [
  { name: 'reclaim_stale_notifications', run: reclaimStale, everySeconds: 300 },
  { name: 'queue_reminders', run: queueReminders, everySeconds: 300 },
  { name: 'advance_game_lifecycle', run: advanceGameLifecycle, everySeconds: 120 },
  { name: 'expire_points', run: expirePoints, everySeconds: 3600 },
  // Someone last seen in March is not still known to within 40 points in September.
  { name: 'decay_inactive_ratings', run: () => decayInactiveRatings({ inactiveDays: 30 }), everySeconds: 86_400 },
  // Redemptions are fulfilled by an external call, so they get their own claim-settle
  // loop and a reclaim for anything a dying worker left mid-flight.
  { name: 'fulfil_redemptions', run: () => fulfilPending({ batchSize: 20 }), everySeconds: 30 },
  { name: 'reclaim_stale_fulfilments', run: reclaimStaleFulfilments, everySeconds: 300 },
  { name: 'prune_expired_tokens', run: pruneExpiredTokens, everySeconds: 86_400 },
];

/**
 * Run any job whose interval has elapsed.
 *
 * Due-ness is stored in `job_runs`, not in memory, so several workers do not all run the
 * same sweep at once and a restart does not re-run everything immediately.
 */
export async function runDueJobs({ force = false } = {}) {
  const results = {};

  for (const job of jobs) {
    // The claim runs in its own scope with a finally, so that every exit path -- due,
    // not due, or failed -- returns the connection. An early `continue` that skips
    // release() leaks one connection per not-due job and eventually kills the pool.
    let claimed = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO job_runs (job_name, last_run_at, run_count)
         VALUES ($1, now(), 1)
         ON CONFLICT (job_name) DO UPDATE
           SET last_run_at = now(), run_count = job_runs.run_count + 1
         WHERE job_runs.last_run_at IS NULL
            OR job_runs.last_run_at < now() - ($2 || ' seconds')::interval
            OR $3
         RETURNING job_name`,
        [job.name, job.everySeconds, force]
      );
      await client.query('COMMIT');

      claimed = rows.length > 0; // otherwise not due, or another worker took it
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err, job: job.name }, 'could not claim job');
    } finally {
      client.release();
    }

    if (!claimed) continue;

    try {
      results[job.name] = await job.run();
      await pool.query(
        `UPDATE job_runs SET last_success_at = now(), last_error = NULL WHERE job_name = $1`,
        [job.name]
      );
    } catch (err) {
      results[job.name] = { error: err.message };
      await pool.query(
        `UPDATE job_runs SET last_error = $2 WHERE job_name = $1`,
        [job.name, String(err.message).slice(0, 2000)]
      );
      logger.error({ err, job: job.name }, 'job failed');
    }
  }

  return results;
}
