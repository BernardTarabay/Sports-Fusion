// Registration, cancellation, and waitlist promotion.
//
// This module is the one that replaces the WhatsApp argument. Its entire job is to make
// the following impossible:
//
//   * 23 people confirmed for a 22-player game
//   * two people believing they hold the same slot
//   * a spot opening up and nobody being told
//   * someone losing their place because a message arrived out of order
//
// The mechanism is a row lock on `games`. Every path that changes the size of a game
// takes `SELECT ... FOR UPDATE` on that game first, so all such operations for a given
// game are serialised by Postgres. Concurrency between DIFFERENT games is unaffected.
//
// The lock is taken deliberately (rather than relying on the CHECK constraint in
// migration 005) so that the loser of a race gets a waitlist position and a sensible
// message, instead of a 500 and a retry.

import { withTransaction, query } from '../../database/pool.js';
import { publish, EventTypes } from '../../lib/events.js';
import { NotFoundError, RegistrationErrors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

const LATE_CANCELLATION_HOURS = 24;

/** Lock the game row and return it. All size-changing paths start here. */
async function lockGame(client, gameId) {
  const { rows } = await client.query(
    `SELECT id, district_id, status, capacity, waitlist_capacity,
            confirmed_count, waitlist_count, kickoff_at,
            registration_opens_at, registration_closes_at
       FROM games
      WHERE id = $1
      FOR UPDATE`,
    [gameId]
  );
  if (rows.length === 0) throw new NotFoundError('Game');
  return rows[0];
}

function assertRegistrationOpen(game) {
  const now = new Date();
  if (game.status === 'cancelled') throw RegistrationErrors.gameCancelled();
  if (['in_progress', 'completed'].includes(game.status)) throw RegistrationErrors.alreadyStarted();
  if (game.status === 'draft') throw RegistrationErrors.registrationNotOpen(game.registration_opens_at);
  if (game.registration_opens_at && now < new Date(game.registration_opens_at)) {
    throw RegistrationErrors.registrationNotOpen(game.registration_opens_at);
  }
  if (game.registration_closes_at && now > new Date(game.registration_closes_at)) {
    throw RegistrationErrors.registrationClosed();
  }
  if (new Date(game.kickoff_at) < now) throw RegistrationErrors.alreadyStarted();
}

/**
 * Register a player for a game. Returns confirmed, or waitlisted with a position.
 *
 * Registering is idempotent for a live registration: calling it twice returns the same
 * answer rather than erroring, because a player double-tapping JOIN on a flaky
 * connection should not be punished for it.
 */
export async function registerPlayer({
  gameId,
  playerId,
  actorUserId = null,
  via = 'web',
  invitedBy = null,
  allowWaitlist = true,
}) {
  return withTransaction(async (client) => {
    const game = await lockGame(client, gameId);

    // Existing live registration wins immediately -- no state change, no event.
    const existing = await client.query(
      `SELECT id, status, waitlist_position
         FROM registrations
        WHERE game_id = $1 AND player_id = $2 AND status <> 'cancelled'`,
      [gameId, playerId]
    );
    if (existing.rows.length > 0) {
      const reg = existing.rows[0];
      return {
        registration: reg,
        status: reg.status,
        waitlistPosition: reg.waitlist_position,
        alreadyRegistered: true,
      };
    }

    assertRegistrationOpen(game);

    const hasSpace = game.confirmed_count < game.capacity;

    if (!hasSpace && !allowWaitlist) throw RegistrationErrors.gameFull(null);

    if (!hasSpace && game.waitlist_count >= game.waitlist_capacity) {
      throw RegistrationErrors.waitlistFull();
    }

    let waitlistPosition = null;
    if (!hasSpace) {
      // Next position after the current tail. Computed under the game lock, so two
      // simultaneous joiners cannot be handed the same number.
      const { rows } = await client.query(
        `SELECT COALESCE(MAX(waitlist_position), 0) + 1 AS next
           FROM registrations
          WHERE game_id = $1 AND status = 'waitlisted'`,
        [gameId]
      );
      waitlistPosition = rows[0].next;
    }

    const status = hasSpace ? 'confirmed' : 'waitlisted';

    const { rows: inserted } = await client.query(
      `INSERT INTO registrations
         (game_id, player_id, status, waitlist_position, registered_via, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status, waitlist_position, registered_at`,
      [gameId, playerId, status, waitlistPosition, via, invitedBy]
    );
    const registration = inserted[0];

    await publish(client, {
      eventType: status === 'confirmed' ? EventTypes.PlayerRegistered : EventTypes.PlayerWaitlisted,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: {
        registrationId: registration.id,
        playerId,
        gameId,
        waitlistPosition,
        confirmedCount: game.confirmed_count + (status === 'confirmed' ? 1 : 0),
        capacity: game.capacity,
      },
    });

    // The game just filled. Flip status and announce it once.
    if (status === 'confirmed' && game.confirmed_count + 1 >= game.capacity) {
      await client.query(
        `UPDATE games SET status = 'full' WHERE id = $1 AND status = 'registration_open'`,
        [gameId]
      );
      await publish(client, {
        eventType: EventTypes.GameFilled,
        aggregateType: 'game',
        aggregateId: gameId,
        actorUserId,
        payload: { gameId, capacity: game.capacity },
      });
    }

    return {
      registration,
      status,
      waitlistPosition,
      alreadyRegistered: false,
    };
  });
}

/**
 * Cancel a registration and, if it freed a confirmed slot, promote the top of the
 * waitlist in the same transaction.
 *
 * Promotion happening here rather than in a background job is deliberate. If the
 * promotion were asynchronous there would be a window in which the game has 21 confirmed
 * players and someone else could take the spot ahead of the person who has been waiting.
 */
export async function cancelRegistration({
  gameId,
  playerId,
  actorUserId = null,
  reason = null,
}) {
  return withTransaction(async (client) => {
    const game = await lockGame(client, gameId);

    if (['completed', 'in_progress'].includes(game.status)) {
      throw RegistrationErrors.alreadyStarted();
    }

    const { rows } = await client.query(
      `SELECT id, status, waitlist_position
         FROM registrations
        WHERE game_id = $1 AND player_id = $2 AND status <> 'cancelled'`,
      [gameId, playerId]
    );
    if (rows.length === 0) throw RegistrationErrors.notRegistered();

    const registration = rows[0];
    const freedConfirmedSlot = registration.status === 'confirmed';

    const leadHours = (new Date(game.kickoff_at) - new Date()) / 3_600_000;

    await client.query(
      `UPDATE registrations
          SET status = 'cancelled',
              waitlist_position = NULL,
              cancelled_at = now(),
              cancelled_by = $2,
              cancel_reason = $3,
              cancel_lead_hours = $4
        WHERE id = $1`,
      [registration.id, actorUserId, reason, leadHours.toFixed(2)]
    );

    // Close the gap left in the waitlist so positions stay 1..n with no holes.
    if (registration.status === 'waitlisted' && registration.waitlist_position != null) {
      await client.query(
        `UPDATE registrations
            SET waitlist_position = waitlist_position - 1
          WHERE game_id = $1 AND status = 'waitlisted' AND waitlist_position > $2`,
        [gameId, registration.waitlist_position]
      );
    }

    await publish(client, {
      eventType: EventTypes.PlayerCancelled,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: {
        registrationId: registration.id,
        playerId,
        gameId,
        previousStatus: registration.status,
        leadHours: Number(leadHours.toFixed(2)),
        isLateCancellation: leadHours < LATE_CANCELLATION_HOURS,
      },
    });

    let promoted = null;
    if (freedConfirmedSlot) {
      promoted = await promoteNextFromWaitlist(client, gameId, actorUserId);

      // If nobody was waiting, the game is no longer full.
      if (!promoted) {
        await client.query(
          `UPDATE games SET status = 'registration_open'
            WHERE id = $1 AND status = 'full'`,
          [gameId]
        );
      }
    }

    return { cancelled: registration.id, promoted, isLateCancellation: leadHours < LATE_CANCELLATION_HOURS };
  });
}

/**
 * Promote the player at the head of the waitlist. Caller must already hold the game lock.
 * Returns the promoted registration, or null if the waitlist is empty.
 */
export async function promoteNextFromWaitlist(client, gameId, actorUserId = null) {
  const { rows } = await client.query(
    `SELECT r.id, r.player_id, r.waitlist_position,
            COALESCE(p.jersey_name, u.display_name) AS name
       FROM registrations r
       JOIN players p ON p.id = r.player_id
       JOIN users u   ON u.id = p.user_id
      WHERE r.game_id = $1 AND r.status = 'waitlisted'
      ORDER BY r.waitlist_position ASC
      LIMIT 1`,
    [gameId]
  );
  if (rows.length === 0) return null;

  const next = rows[0];

  await client.query(
    `UPDATE registrations
        SET status = 'confirmed',
            waitlist_position = NULL,
            promoted_at = now()
      WHERE id = $1`,
    [next.id]
  );

  // Everyone behind them moves up one.
  await client.query(
    `UPDATE registrations
        SET waitlist_position = waitlist_position - 1
      WHERE game_id = $1 AND status = 'waitlisted' AND waitlist_position > $2`,
    [gameId, next.waitlist_position]
  );

  await publish(client, {
    eventType: EventTypes.PlayerPromotedFromWaitlist,
    aggregateType: 'game',
    aggregateId: gameId,
    actorUserId,
    payload: {
      registrationId: next.id,
      playerId: next.player_id,
      gameId,
      fromPosition: next.waitlist_position,
    },
  });

  logger.info({ gameId, playerId: next.player_id }, 'promoted from waitlist');

  // `name` is what the client tells the person who just left: "Fares has been moved off
  // the waiting list". Without it that sentence began with the word "undefined".
  return {
    registrationId: next.id,
    playerId: next.player_id,
    name: next.name,
    fromPosition: next.waitlist_position,
  };
}

/** Admin: move a player up or down the waitlist. Positions stay contiguous. */
export async function reorderWaitlist({ gameId, registrationId, newPosition, actorUserId }) {
  return withTransaction(async (client) => {
    await lockGame(client, gameId);

    const { rows } = await client.query(
      `SELECT id, waitlist_position FROM registrations
        WHERE id = $1 AND game_id = $2 AND status = 'waitlisted'`,
      [registrationId, gameId]
    );
    if (rows.length === 0) throw new NotFoundError('Waitlist entry');

    const current = rows[0].waitlist_position;
    if (current === newPosition) return { moved: false };

    // Park the row outside the range so the unique index does not trip mid-shuffle.
    await client.query(
      `UPDATE registrations SET waitlist_position = -1 WHERE id = $1`,
      [registrationId]
    );

    if (newPosition < current) {
      await client.query(
        `UPDATE registrations SET waitlist_position = waitlist_position + 1
          WHERE game_id = $1 AND status = 'waitlisted'
            AND waitlist_position >= $2 AND waitlist_position < $3`,
        [gameId, newPosition, current]
      );
    } else {
      await client.query(
        `UPDATE registrations SET waitlist_position = waitlist_position - 1
          WHERE game_id = $1 AND status = 'waitlisted'
            AND waitlist_position > $2 AND waitlist_position <= $3`,
        [gameId, current, newPosition]
      );
    }

    await client.query(
      `UPDATE registrations SET waitlist_position = $2 WHERE id = $1`,
      [registrationId, newPosition]
    );

    return { moved: true, from: current, to: newPosition };
  });
}

/**
 * The full roster for a game: confirmed players in order, then the waitlist.
 *
 * A plain read. It used to open a transaction around this single SELECT, which is a
 * BEGIN and a COMMIT of pure round-trip latency on an endpoint the public game page and
 * the matchday screen both hit. `client` is accepted so a caller who already holds a
 * transaction reads on it rather than reaching into the pool for a second connection --
 * the deadlock the rest of this codebase is careful about.
 */
export async function getRoster(gameId, client) {
  const run = client ?? { query };
  const { rows } = await run.query(
    `SELECT r.id, r.status, r.waitlist_position, r.registered_at, r.promoted_at,
            r.attendance,
            p.id AS player_id, p.jersey_name, p.preferred_position, p.is_goalkeeper,
            p.rating_mu, p.rating_sigma,
            u.display_name, u.avatar_url
       FROM registrations r
       JOIN players p ON p.id = r.player_id
       JOIN users u   ON u.id = p.user_id
      WHERE r.game_id = $1 AND r.status <> 'cancelled'
      ORDER BY
        CASE r.status WHEN 'confirmed' THEN 0 ELSE 1 END,
        r.waitlist_position NULLS FIRST,
        r.registered_at`,
    [gameId]
  );

  return {
    confirmed: rows.filter((r) => r.status === 'confirmed'),
    waitlist: rows.filter((r) => r.status === 'waitlisted'),
  };
}
