// Notification sender.
//
// Unlike the event dispatcher, this CANNOT do its work inside one transaction: sending a
// WhatsApp message is an external side effect that no ROLLBACK can undo. So it uses the
// claim-send-settle pattern:
//
//   1. Claim: status pending -> sending, COMMITTED before anything is sent. A crash after
//      this leaves the row visibly stuck in `sending` rather than being sent twice.
//   2. Send.
//   3. Settle: sending -> sent, or -> pending with backoff, or -> failed if permanent.
//
// A worker that dies between 1 and 3 leaves an orphan. reclaimStale() below returns those
// to the queue after a grace period. The trade-off is deliberate: at-most-once during the
// window, at-least-once after reclaim. For a message saying "you're in", sending twice is
// far better than never sending at all.

import { pool } from '@sports-fusion/backend/database/pool';
import { logger } from '@sports-fusion/backend/lib/logger';
import { render } from './templates.js';
import { channels } from './channels.js';

export const MAX_ATTEMPTS = 4;
const STALE_SENDING_MINUTES = 10;

/** 1m, 5m, 25m, capped at 2h. */
export function backoffSeconds(attempt) {
  return Math.min(60 * 5 ** (attempt - 1), 7200);
}

async function claimOne() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `WITH claimed AS (
         SELECT id FROM notifications
          WHERE status = 'pending' AND scheduled_for <= now()
          ORDER BY scheduled_for, created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE notifications n
          SET status = 'sending', attempts = n.attempts + 1
         FROM claimed
        WHERE n.id = claimed.id
       RETURNING n.id, n.user_id, n.channel, n.template_key, n.payload,
                 n.attempts, n.reference_type, n.reference_id`
    );
    await client.query('COMMIT');
    if (rows.length === 0) return null;

    // Recipient details are read on the SAME client, after the commit. Calling
    // pool.query() here would ask the pool for a second connection while still holding
    // one, which deadlocks the moment every connection is held by a claimer.
    const { rows: userRows } = await client.query(
      `SELECT u.phone_e164, u.email, u.locale FROM users u WHERE u.id = $1`,
      [rows[0].user_id]
    );

    return { ...rows[0], ...(userRows[0] ?? {}) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection gone */ }
    throw err;
  } finally {
    client.release();
  }
}

async function settleSent(notification, result) {
  await pool.query(
    `UPDATE notifications
        SET status = 'sent', sent_at = now(), error = NULL,
            provider = $2, provider_message_id = $3,
            provider_conversation_id = $4, provider_cost = $5, provider_currency = $6
      WHERE id = $1`,
    [
      notification.id, notification.channel, result.providerMessageId ?? null,
      result.providerConversationId ?? null, result.cost ?? null, result.currency ?? null,
    ]
  );
}

async function settleFailed(notification, err) {
  const permanent = err.permanent === true || notification.attempts >= MAX_ATTEMPTS;

  if (permanent) {
    await pool.query(
      `UPDATE notifications SET status = 'failed', failed_at = now(), error = $2 WHERE id = $1`,
      [notification.id, String(err.message).slice(0, 2000)]
    );
  } else {
    await pool.query(
      `UPDATE notifications
          SET status = 'pending',
              scheduled_for = now() + ($3 || ' seconds')::interval,
              error = $2
        WHERE id = $1`,
      [notification.id, String(err.message).slice(0, 2000), backoffSeconds(notification.attempts)]
    );
  }

  logger[permanent ? 'error' : 'warn'](
    {
      notificationId: notification.id,
      channel: notification.channel,
      template: notification.template_key,
      attempts: notification.attempts,
      err,
    },
    permanent ? 'notification failed permanently' : 'notification failed; will retry'
  );

  return permanent;
}

export async function dispatchNotifications({ batchSize = 25 } = {}) {
  const stats = { sent: 0, retrying: 0, failed: 0 };

  for (let i = 0; i < batchSize; i += 1) {
    const notification = await claimOne();
    if (!notification) break;

    const channel = channels[notification.channel];
    if (!channel) {
      await settleFailed(notification, Object.assign(
        new Error(`Unknown channel: ${notification.channel}`), { permanent: true }
      ));
      stats.failed += 1;
      continue;
    }

    try {
      const rendered = render(notification.template_key, notification.payload);
      const result = await channel.send(notification, rendered);
      await settleSent(notification, result);
      stats.sent += 1;
    } catch (err) {
      const permanent = await settleFailed(notification, err);
      if (permanent) stats.failed += 1;
      else stats.retrying += 1;
    }
  }

  return stats;
}

/**
 * Return notifications abandoned by a worker that died mid-send.
 *
 * These MAY have been delivered, so reclaiming risks a duplicate. That is the right
 * trade: a player receiving "you're in" twice is a minor annoyance; not receiving it
 * means they miss the game.
 */
export async function reclaimStale() {
  const { rowCount } = await pool.query(
    `UPDATE notifications
        SET status = 'pending', error = 'reclaimed after worker restart'
      WHERE status = 'sending'
        AND updated_at < now() - ($1 || ' minutes')::interval`,
    [STALE_SENDING_MINUTES]
  );
  if (rowCount > 0) logger.warn({ reclaimed: rowCount }, 'reclaimed stale notifications');
  return rowCount;
}

export async function notificationDepth() {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')::int AS pending,
       count(*) FILTER (WHERE status = 'sending')::int AS sending,
       count(*) FILTER (WHERE status = 'failed')::int  AS failed,
       count(*) FILTER (WHERE status = 'sent')::int    AS sent
     FROM notifications`
  );
  return rows[0];
}
