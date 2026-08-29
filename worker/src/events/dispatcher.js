// Domain event dispatcher.
//
// Claims a batch of unprocessed events, runs each handler, and marks it done -- ALL IN
// ONE TRANSACTION per event. That matters:
//
//   * Handlers only write to the database. Doing the work and marking the event processed
//     in the same transaction means a crash rolls both back and the event is simply
//     retried. No event is silently dropped, and no work is applied twice.
//   * Actual message sending is NOT done here. It happens in the notification dispatcher,
//     because sending is an external side effect that cannot be rolled back. Handlers
//     queue a notification row; the sender is a separate, separately-retried step.
//
// FOR UPDATE SKIP LOCKED lets several workers run at once without processing the same
// event twice and without blocking each other.

import { pool } from '@sports-fusion/backend/database/pool';
import { logger } from '@sports-fusion/backend/lib/logger';
import { handlers } from './handlers.js';

export const MAX_ATTEMPTS = 5;

/** Exponential backoff with a ceiling: 30s, 2m, 8m, 32m, capped at 1h. */
export function backoffSeconds(attempt) {
  return Math.min(30 * 4 ** (attempt - 1), 3600);
}

/**
 * Process up to `batchSize` due events.
 * @returns {Promise<{processed: number, failed: number, deadLettered: number}>}
 */
export async function dispatchEvents({ batchSize = 20 } = {}) {
  const stats = { processed: 0, failed: 0, deadLettered: 0 };

  for (let i = 0; i < batchSize; i += 1) {
    const handled = await dispatchOne();
    if (handled === null) break; // nothing left to claim
    if (handled.ok) stats.processed += 1;
    else if (handled.deadLettered) stats.deadLettered += 1;
    else stats.failed += 1;
  }

  return stats;
}

/**
 * Claim and process exactly one event.
 * @returns {Promise<null|{ok: boolean, deadLettered?: boolean}>} null when the queue is empty
 */
async function dispatchOne() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload,
              attempts, actor_user_id, correlation_id, occurred_at
         FROM domain_events
        WHERE processed_at IS NULL
          AND dead_lettered_at IS NULL
          AND available_at <= now()
        ORDER BY available_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    const event = rows[0];
    const handler = handlers[event.event_type];

    // An event with no handler is not a failure. Plenty of events exist for the audit
    // trail alone; retrying them forever would fill the queue with noise.
    if (!handler) {
      await client.query(
        `UPDATE domain_events SET processed_at = now() WHERE id = $1`, [event.id]
      );
      await client.query('COMMIT');
      logger.debug({ eventId: event.id, type: event.event_type }, 'no handler; skipping');
      return { ok: true };
    }

    try {
      await handler(client, event);
      await client.query(
        `UPDATE domain_events SET processed_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE id = $1`,
        [event.id]
      );
      await client.query('COMMIT');
      logger.info(
        { eventId: event.id, type: event.event_type, aggregateId: event.aggregate_id },
        'event processed'
      );
      return { ok: true };
    } catch (err) {
      // The handler's writes are discarded, then the failure is recorded in a fresh
      // transaction -- otherwise the rollback would erase the record of the failure too,
      // and the event would retry forever with attempts stuck at zero.
      await client.query('ROLLBACK');

      const attempts = event.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;

      await client.query(
        `UPDATE domain_events
            SET attempts = $2,
                last_error = $3,
                available_at = now() + ($4 || ' seconds')::interval,
                dead_lettered_at = CASE WHEN $5 THEN now() ELSE NULL END
          WHERE id = $1`,
        [event.id, attempts, String(err.message).slice(0, 2000), backoffSeconds(attempts), dead]
      );

      logger[dead ? 'error' : 'warn'](
        { eventId: event.id, type: event.event_type, attempts, err },
        dead ? 'event dead-lettered' : 'event failed; will retry'
      );

      return { ok: false, deadLettered: dead };
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    logger.error({ err }, 'dispatcher error');
    throw err;
  } finally {
    client.release();
  }
}

/** Operational view: what is stuck, and why. */
export async function queueDepth() {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL)::int AS pending,
       count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int                      AS dead_lettered,
       count(*) FILTER (WHERE processed_at IS NULL AND attempts > 0
                          AND dead_lettered_at IS NULL)::int                          AS retrying,
       min(occurred_at) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending
     FROM domain_events`
  );
  return rows[0];
}
