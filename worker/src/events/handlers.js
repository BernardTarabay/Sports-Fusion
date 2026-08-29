// Event handlers.
//
// Every handler receives the dispatcher's transaction client and must be IDEMPOTENT --
// the dispatcher is at-least-once, so a handler can run again after a crash.
//
// Idempotency is enforced by the database wherever possible rather than by checking
// first and then writing, which races:
//   * notifications_dedupe_idx      one notification per (user, channel, template, cause)
//   * point_transactions_once_per_reference   one automatic award per player per game
//   * game_pair_history_applied     pair history counted once per game
//
// So handlers use ON CONFLICT DO NOTHING and let Postgres be the arbiter.

import { logger } from '@sports-fusion/backend/lib/logger';
import { recordPairHistory } from '@sports-fusion/backend/modules/teams/service';
import { applyGameRatings } from '@sports-fusion/backend/modules/ratings/service';

// Points are priced in reward_catalogue, but the earn side is defined here. These
// numbers are placeholders until real Shopify margin exists -- see the liability note in
// migration 008. Do not raise them without checking reward_liability.
const POINTS = {
  game_played: 100,
  on_time_bonus: 25,
  motm: 250,
};

// Cash value of one point, for the liability ledger. A guess until the reward catalogue
// is priced against real margin; recorded so the guess is visible rather than implicit.
const POINT_VALUE = 0.001;

/**
 * Queue a notification. Relies on notifications_dedupe_idx so re-running the handler
 * cannot produce a second message.
 */
async function queueNotification(client, {
  userId, playerId = null, channel, templateKey, payload = {},
  referenceType = null, referenceId = null, eventId = null, scheduledFor = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO notifications
       (user_id, player_id, channel, template_key, payload,
        reference_type, reference_id, event_id, scheduled_for)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8, COALESCE($9, now()))
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      userId, playerId, channel, templateKey, JSON.stringify(payload),
      referenceType, referenceId, eventId, scheduledFor,
    ]
  );
  return rows[0]?.id ?? null;
}

/**
 * Which channels should reach this user for this category?
 *
 * Opt-out is respected, and WhatsApp additionally requires an explicit opt-in: sending a
 * business message to someone who never agreed to receive one is a policy violation, not
 * merely rude. Absence of a preference row means "not opted in" for WhatsApp and
 * "enabled" for in-app.
 */
async function channelsFor(client, userId, category) {
  const { rows } = await client.query(
    `SELECT channel, is_enabled, opted_in_at
       FROM notification_preferences
      WHERE user_id = $1 AND category = $2`,
    [userId, category]
  );
  const prefs = new Map(rows.map((r) => [r.channel, r]));

  const channels = ['in_app'];
  const whatsapp = prefs.get('whatsapp');
  if (whatsapp?.is_enabled && whatsapp.opted_in_at) channels.push('whatsapp');

  const push = prefs.get('push');
  if (push ? push.is_enabled : false) channels.push('push');

  return channels;
}

async function notifyPlayer(client, { playerId, category, templateKey, payload, event }) {
  const { rows } = await client.query(
    `SELECT p.id AS player_id, p.user_id FROM players p WHERE p.id = $1`, [playerId]
  );
  if (rows.length === 0) return 0;

  const { user_id: userId } = rows[0];
  const channels = await channelsFor(client, userId, category);

  let queued = 0;
  for (const channel of channels) {
    const id = await queueNotification(client, {
      userId, playerId, channel, templateKey, payload,
      referenceType: 'game', referenceId: payload.gameId ?? null, eventId: event.id,
    });
    if (id) queued += 1;
  }
  return queued;
}

/** Context every game notification needs. */
async function gameContext(client, gameId) {
  const { rows } = await client.query(
    `SELECT g.id, g.kickoff_at, g.capacity, g.confirmed_count, g.arrive_by_minutes,
            g.public_slug, g.price, g.currency,
            d.name AS district_name,
            v.name AS venue_name, v.google_maps_url AS venue_maps_url
       FROM games g
       JOIN districts d ON d.id = g.district_id
       LEFT JOIN venues v ON v.id = g.venue_id
      WHERE g.id = $1`,
    [gameId]
  );
  if (rows.length === 0) return null;
  const g = rows[0];
  return {
    gameId: g.id,
    kickoffAt: g.kickoff_at,
    districtName: g.district_name,
    venueName: g.venue_name,
    venueMapsUrl: g.venue_maps_url,
    capacity: g.capacity,
    confirmedCount: g.confirmed_count,
    arriveByMinutes: g.arrive_by_minutes,
    slug: g.public_slug,
    price: g.price == null ? null : Number(g.price),
    currency: g.currency,
  };
}

/**
 * Bring a game's point awards into line with what its current attendance and awards say
 * they should be.
 *
 * Not "add points" -- reconcile. Attendance gets corrected after the fact, so this
 * computes the NET position per (player, award) and writes only the difference:
 *
 *   nothing owed, nothing paid  -> no row
 *   owed but unpaid             -> the original award
 *   paid but no longer owed     -> a compensating 'correction' row
 *   already correct             -> nothing
 *
 * That makes it safe to run on every GameCompleted, however many times the event is
 * replayed and however often the admin revises who actually turned up.
 */
async function reconcileGamePoints(client, gameId) {
  const seasonId = await currentSeasonId(client);

  // What the current records say each player is owed.
  const { rows: attendees } = await client.query(
    `SELECT player_id, attendance FROM registrations
      WHERE game_id = $1 AND status = 'confirmed' AND attendance IN ('attended', 'late')`,
    [gameId]
  );
  const { rows: motm } = await client.query(
    `SELECT player_id FROM match_awards WHERE game_id = $1 AND award_type = 'motm'`,
    [gameId]
  );

  const desired = new Map(); // `${playerId}:${reason}` -> points
  const owe = (playerId, reason) => desired.set(`${playerId}:${reason}`, POINTS[reason]);

  for (const row of attendees) {
    owe(row.player_id, 'game_played');
    if (row.attendance === 'attended') owe(row.player_id, 'on_time_bonus');
  }
  for (const row of motm) owe(row.player_id, 'motm');

  // What has actually been paid, netted across originals and corrections.
  const { rows: paid } = await client.query(
    `SELECT player_id,
            COALESCE(corrects_reason, reason) AS award,
            SUM(delta)::int AS net,
            bool_or(reason <> 'correction') AS has_original
       FROM point_transactions
      WHERE reference_type = 'game' AND reference_id = $1
        AND COALESCE(corrects_reason, reason) IN ('game_played', 'on_time_bonus', 'motm')
      GROUP BY player_id, COALESCE(corrects_reason, reason)`,
    [gameId]
  );

  const current = new Map(
    paid.map((r) => [`${r.player_id}:${r.award}`, { net: r.net, hasOriginal: r.has_original }])
  );

  let adjustments = 0;
  const keys = new Set([...desired.keys(), ...current.keys()]);

  for (const key of keys) {
    const [playerId, reason] = key.split(':');
    const target = desired.get(key) ?? 0;
    const state = current.get(key) ?? { net: 0, hasOriginal: false };
    const delta = target - state.net;
    if (delta === 0) continue;

    // The first payment for an award uses that award's own reason, which the unique
    // index protects. Every later adjustment is a correction, which is exempt -- so an
    // attendance record can be revised more than once.
    const isFirst = !state.hasOriginal && delta > 0;

    await client.query(
      `INSERT INTO point_transactions
         (player_id, season_id, delta, reason, corrects_reason,
          reference_type, reference_id, liability_value)
       VALUES ($1,$2,$3,$4,$5,'game',$6,$7)`,
      [
        playerId, seasonId, delta,
        isFirst ? reason : 'correction',
        isFirst ? null : reason,
        gameId, delta * POINT_VALUE,
      ]
    );
    adjustments += 1;
  }

  return { attendees: attendees.length, adjustments };
}

async function currentSeasonId(client) {
  const { rows } = await client.query('SELECT id FROM seasons WHERE is_current LIMIT 1');
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------

export const handlers = {
  async PlayerRegistered(client, event) {
    const game = await gameContext(client, event.payload.gameId);
    if (!game) return;
    await notifyPlayer(client, {
      playerId: event.payload.playerId,
      category: 'registration',
      templateKey: 'registration_confirmed',
      payload: game,
      event,
    });
  },

  async PlayerWaitlisted(client, event) {
    const game = await gameContext(client, event.payload.gameId);
    if (!game) return;
    await notifyPlayer(client, {
      playerId: event.payload.playerId,
      category: 'waitlist',
      templateKey: 'waitlist_joined',
      payload: { ...game, waitlistPosition: event.payload.waitlistPosition },
      event,
    });
  },

  // The one that replaces "FUCK SOMEONE REMOVE GEORGE".
  async PlayerPromotedFromWaitlist(client, event) {
    const game = await gameContext(client, event.payload.gameId);
    if (!game) return;
    await notifyPlayer(client, {
      playerId: event.payload.playerId,
      category: 'waitlist',
      templateKey: 'waitlist_promoted',
      payload: { ...game, fromPosition: event.payload.fromPosition },
      event,
    });
  },

  async TeamsGenerated(client, event) {
    const game = await gameContext(client, event.payload.gameId);
    if (!game) return;

    const { rows } = await client.query(
      `SELECT tp.player_id, gt.color, tp.assigned_position
         FROM team_players tp
         JOIN game_teams gt ON gt.id = tp.team_id
        WHERE tp.game_id = $1`,
      [event.payload.gameId]
    );

    for (const row of rows) {
      await notifyPlayer(client, {
        playerId: row.player_id,
        category: 'teams',
        templateKey: 'teams_announced',
        payload: { ...game, teamColor: row.color, position: row.assigned_position },
        event,
      });
    }
  },

  async GameCancelled(client, event) {
    const game = await gameContext(client, event.payload.gameId);
    if (!game) return;

    // Everyone who held a place, including the waiting list -- they were counting on it.
    const { rows } = await client.query(
      `SELECT DISTINCT player_id FROM registrations
        WHERE game_id = $1 AND cancel_reason = 'game_cancelled'`,
      [event.payload.gameId]
    );

    for (const row of rows) {
      await notifyPlayer(client, {
        playerId: row.player_id,
        category: 'registration',
        templateKey: 'game_cancelled',
        payload: { ...game, reason: event.payload.reason ?? null },
        event,
      });
    }
  },

  async GameCompleted(client, event) {
    const gameId = event.payload.gameId;

    // Pair history feeds the balancer's anti-repetition term. Guarded by its own table so
    // a retry cannot inflate the counts.
    const { rows: claim } = await client.query(
      `INSERT INTO game_pair_history_applied (game_id) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING game_id`,
      [gameId]
    );
    if (claim.length > 0) {
      await recordPairHistory(client, gameId);
    }

    const points = await reconcileGamePoints(client, gameId);

    // Glicko-2. Guarded inside applyGameRatings: rating the same match twice would
    // double every movement, and this handler is at-least-once.
    //
    // A game is rated against ratings as they stand now, which is right only when games
    // are rated in the order they were played. Corrections to older history are handled
    // by a full replay, not by patching one game in the middle -- every later game
    // depended on the numbers this one produced.
    const ratings = await applyGameRatings(client, gameId);

    logger.info({ gameId, ...points, ratings }, 'game completed; points and ratings applied');
  },

  // A corrected score does not change who played, so points are untouched. Attendance
  // corrections republish GameCompleted instead, which reconciles them.
  async MatchResultCorrected(client, event) {
    const game = await gameContext(client, event.payload.gameId);
    if (!game) return;

    const { rows } = await client.query(
      `SELECT player_id FROM registrations
        WHERE game_id = $1 AND status = 'confirmed' AND attendance IN ('attended', 'late')`,
      [event.payload.gameId]
    );

    for (const row of rows) {
      await notifyPlayer(client, {
        playerId: row.player_id,
        category: 'result',
        templateKey: 'result_corrected',
        payload: { ...game, version: event.payload.version, reason: event.payload.reason },
        event,
      });
    }
  },

  async RewardRedeemed(client, event) {
    await notifyPlayer(client, {
      playerId: event.payload.playerId,
      category: 'rewards',
      templateKey: 'reward_redeemed',
      payload: {
        rewardName: event.payload.rewardName,
        pointsSpent: event.payload.pointsSpent,
        redemptionId: event.payload.redemptionId,
      },
      event,
    });
  },

  async MatchResultSubmitted(client, event) {
    const game = await gameContext(client, event.payload.gameId);
    if (!game) return;

    const { rows } = await client.query(
      `SELECT player_id FROM registrations
        WHERE game_id = $1 AND status = 'confirmed' AND attendance IN ('attended', 'late')`,
      [event.payload.gameId]
    );

    for (const row of rows) {
      await notifyPlayer(client, {
        playerId: row.player_id,
        category: 'result',
        templateKey: 'result_published',
        payload: { ...game, ...event.payload },
        event,
      });
    }
  },
};

export default handlers;
