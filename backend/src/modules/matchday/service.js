// Matchday: what an admin touches while standing at the side of a pitch.
//
// The clock, payments, live goals, attendance, formation, man of the match.
//
// ONE PROJECTION, RETURNED BY EVERYTHING
//
// Every mutation here returns the complete matchday state, not just the bit it changed.
// It costs one extra query and removes a whole class of bug: the pitch cannot render a
// player as paid while the payment rail still says unpaid, because both are reading the
// same response. It also halves the round trips on a phone with one bar of signal, which
// is the actual operating environment.
//
// GOALS ARE EVENTS, NOT COUNTERS
//
// `setPlayerStat({ goals: 3 })` does not write a 3 anywhere. It reconciles the player's
// live goal events to three -- appending or voiding until the count matches. The score
// stays a fold over match_events, so the header and the scorer list can never disagree.

import { withTransaction, query } from '../../database/pool.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';

// The database raises this when payments are attempted mid-match (see 015_matchday.sql).
const CHECK_VIOLATION = '23514';

const num = (v) => (v == null ? null : Number(v));

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * Play time in milliseconds at the instant `at`.
 *
 * Derived, never stored. Halftime and full time are frozen -- the banked total is the
 * answer, because no football is being played.
 */
export function elapsedMs(game, at = new Date()) {
  const banked = Number(game.elapsed_ms_at_period_start ?? 0);
  if (game.clock_state === 'not_started') return 0;
  if (!['first_half', 'second_half'].includes(game.clock_state)) return banked;

  const since = at.getTime() - new Date(game.period_started_at).getTime();
  const paused = Number(game.paused_ms ?? 0) +
    (game.paused_at ? at.getTime() - new Date(game.paused_at).getTime() : 0);

  return Math.max(banked, banked + since - paused);
}

/** Match minute, 1-indexed the way football counts it: the first minute is minute 1. */
export function currentMinute(game, at = new Date()) {
  if (game.clock_state === 'not_started') return null;
  return Math.floor(elapsedMs(game, at) / 60_000) + 1;
}

// What each action is allowed to follow. An admin tapping "start" twice, or a stale tab
// firing an old transition, must not rewind a match that has moved on.
const TRANSITIONS = {
  start:    { from: ['not_started'],                to: 'first_half' },
  halftime: { from: ['first_half'],                 to: 'halftime' },
  resume:   { from: ['halftime'],                   to: 'second_half' },
  end:      { from: ['first_half', 'second_half'],  to: 'finished' },
  abandon:  { from: ['first_half', 'halftime', 'second_half'], to: 'abandoned' },
  pause:    { from: ['first_half', 'second_half'],  to: null },
  unpause:  { from: ['first_half', 'second_half'],  to: null },
};

export async function advanceClock({ gameId, action, actorUserId }) {
  const step = TRANSITIONS[action];
  if (!step) throw new ValidationError(`Unknown clock action: ${action}`);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, clock_state, started_at, period_started_at,
              elapsed_ms_at_period_start, paused_at, paused_ms
         FROM games WHERE id = $1 FOR UPDATE`,
      [gameId]
    );
    const game = rows[0];
    if (!game) throw new NotFoundError('Game not found');

    if (!step.from.includes(game.clock_state)) {
      throw new ConflictError(
        `Cannot ${action} a match that is ${game.clock_state.replace(/_/g, ' ')}`,
        'CLOCK_STATE'
      );
    }

    const now = new Date();
    let sql;
    let params;

    if (action === 'pause') {
      if (game.paused_at) throw new ConflictError('The clock is already stopped', 'CLOCK_PAUSED');
      sql = `UPDATE games SET paused_at = $2 WHERE id = $1`;
      params = [gameId, now];
    } else if (action === 'unpause') {
      if (!game.paused_at) throw new ConflictError('The clock is already running', 'CLOCK_RUNNING');
      sql = `UPDATE games
                SET paused_ms = paused_ms + $2::bigint, paused_at = NULL
              WHERE id = $1`;
      params = [gameId, now.getTime() - new Date(game.paused_at).getTime()];
    } else if (action === 'start') {
      // status follows the clock: a match in play is in_progress, whatever the roster says.
      sql = `UPDATE games
                SET clock_state = 'first_half', status = 'in_progress',
                    started_at = $2, period_started_at = $2,
                    elapsed_ms_at_period_start = 0, paused_ms = 0, paused_at = NULL
              WHERE id = $1`;
      params = [gameId, now];
    } else if (action === 'halftime') {
      // Bank the first half, then stop counting.
      sql = `UPDATE games
                SET clock_state = 'halftime', period_started_at = $2,
                    elapsed_ms_at_period_start = $3::bigint, paused_ms = 0, paused_at = NULL
              WHERE id = $1`;
      params = [gameId, now, Math.round(elapsedMs(game, now))];
    } else if (action === 'resume') {
      sql = `UPDATE games
                SET clock_state = 'second_half', period_started_at = $2,
                    paused_ms = 0, paused_at = NULL
              WHERE id = $1`;
      params = [gameId, now];
    } else {
      // end | abandon
      sql = `UPDATE games
                SET clock_state = $3, status = $4, ended_at = $2,
                    elapsed_ms_at_period_start = $5::bigint, paused_at = NULL
              WHERE id = $1`;
      params = [
        gameId, now, step.to,
        step.to === 'finished' ? 'completed' : 'cancelled',
        Math.round(elapsedMs(game, now)),
      ];
    }

    await client.query(sql, params);
    await audit(client, actorUserId, `clock.${action}`, gameId, { clockState: game.clock_state }, { clockState: step.to ?? game.clock_state });

    return getMatchday(gameId, client);
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function setPayment({ gameId, playerId, paid, method = 'cash', actorUserId }) {
  return withTransaction(async (client) => {
    const game = await loadGame(client, gameId);
    // Recorded after the final whistle: someone settling up on the way to the car.
    const late = game.clock_state === 'finished';

    try {
      if (paid) {
        await client.query(
          `INSERT INTO game_payments (game_id, player_id, amount, currency, method, recorded_by, settled_late)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (game_id, player_id) WHERE voided_at IS NULL
           DO UPDATE SET method = EXCLUDED.method, recorded_by = EXCLUDED.recorded_by`,
          [gameId, playerId, game.price, game.currency, method, actorUserId ?? null, late]
        );
      } else {
        await client.query(
          `UPDATE game_payments SET voided_at = now(), voided_by = $3
            WHERE game_id = $1 AND player_id = $2 AND voided_at IS NULL`,
          [gameId, playerId, actorUserId ?? null]
        );
      }
    } catch (err) {
      if (err.code === CHECK_VIOLATION) {
        throw new ConflictError(
          'Payments are locked while the match is being played. They reopen at full time.',
          'PAYMENTS_LOCKED'
        );
      }
      throw err;
    }

    await audit(client, actorUserId, paid ? 'payment.record' : 'payment.void', gameId, null, { playerId });
    return getMatchday(gameId, client);
  });
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export async function setPlayerStat({ gameId, playerId, patch, actorUserId }) {
  return withTransaction(async (client) => {
    const game = await loadGame(client, gameId);

    if ('attendance' in patch) {
      const { rowCount } = await client.query(
        `UPDATE registrations SET attendance = $3
          WHERE game_id = $1 AND player_id = $2 AND status <> 'cancelled'`,
        [gameId, playerId, patch.attendance]
      );
      if (!rowCount) throw new NotFoundError('That player is not on this roster');
    }

    if ('goals' in patch) await reconcileEvents(client, game, playerId, 'goal', patch.goals, actorUserId);
    if ('assists' in patch) await reconcileAssists(client, game, playerId, patch.assists, actorUserId);

    return getMatchday(gameId, client);
  });
}

export async function markAllAttendance({ gameId, status, playerIds, actorUserId }) {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE registrations SET attendance = $2
        WHERE game_id = $1 AND status = 'confirmed'
          AND ($3::uuid[] IS NULL OR player_id = ANY($3))`,
      [gameId, status, playerIds?.length ? playerIds : null]
    );
    await audit(client, actorUserId, 'attendance.bulk', gameId, null, { status, count: rowCount });
    return getMatchday(gameId, client);
  });
}

// ---------------------------------------------------------------------------
// Goals, as events
// ---------------------------------------------------------------------------

/** Bring a player's live event count for `type` to exactly `target`. */
async function reconcileEvents(client, game, playerId, type, target, actorUserId) {
  const { rows } = await client.query(
    `SELECT id FROM match_events
      WHERE game_id = $1 AND player_id = $2 AND type = $3 AND voided_at IS NULL
      ORDER BY created_at`,
    [game.id, playerId, type]
  );

  if (rows.length > target) {
    // Void the most recent first: an admin correcting a count is undoing their last tap.
    const doomed = rows.slice(target).map((r) => r.id);
    await client.query(
      `UPDATE match_events SET voided_at = now(), voided_by = $2 WHERE id = ANY($1::uuid[])`,
      [doomed, actorUserId ?? null]
    );
    return;
  }

  const teamId = await teamOf(client, game.id, playerId);
  const minute = currentMinute(game);
  const period = ['first_half', 'second_half'].includes(game.clock_state) ? game.clock_state : null;

  for (let i = rows.length; i < target; i += 1) {
    await client.query(
      `INSERT INTO match_events (game_id, team_id, player_id, type, minute, period, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [game.id, teamId, playerId, type, minute, period, actorUserId ?? null]
    );
  }
}

/**
 * Assists hang off goals rather than being their own event: an assist without a goal is
 * not a thing that happened. Credited to the player's team's most recent unassisted goal.
 */
async function reconcileAssists(client, game, playerId, target, actorUserId) {
  const teamId = await teamOf(client, game.id, playerId);
  const { rows: credited } = await client.query(
    `SELECT id FROM match_events
      WHERE game_id = $1 AND assist_id = $2 AND voided_at IS NULL ORDER BY created_at`,
    [game.id, playerId]
  );

  if (credited.length > target) {
    const doomed = credited.slice(target).map((r) => r.id);
    await client.query(`UPDATE match_events SET assist_id = NULL WHERE id = ANY($1::uuid[])`, [doomed]);
    return;
  }

  const wanted = target - credited.length;
  if (wanted <= 0) return;

  const { rows: open } = await client.query(
    `SELECT id FROM match_events
      WHERE game_id = $1 AND team_id = $2 AND type = 'goal'
        AND assist_id IS NULL AND player_id <> $3 AND voided_at IS NULL
      ORDER BY created_at DESC LIMIT $4`,
    [game.id, teamId, playerId, wanted]
  );
  if (open.length < wanted) {
    throw new ConflictError(
      'There is no unassisted goal left to credit that assist to. Record the goal first.',
      'NO_GOAL_FOR_ASSIST'
    );
  }
  await client.query(
    `UPDATE match_events SET assist_id = $2 WHERE id = ANY($1::uuid[])`,
    [open.map((r) => r.id), playerId]
  );
  await audit(client, actorUserId, 'assist.credit', game.id, null, { playerId, count: wanted });
}

async function teamOf(client, gameId, playerId) {
  const { rows } = await client.query(
    `SELECT team_id FROM team_players WHERE game_id = $1 AND player_id = $2 LIMIT 1`,
    [gameId, playerId]
  );
  if (!rows[0]) {
    throw new ConflictError('Generate teams before recording goals', 'NO_TEAMS');
  }
  return rows[0].team_id;
}

// ---------------------------------------------------------------------------
// Formation, man of the match
// ---------------------------------------------------------------------------

export async function setFormation({ gameId, formation, actorUserId }) {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE games SET formation = $2 WHERE id = $1`, [gameId, formation]
    );
    if (!rowCount) throw new NotFoundError('Game not found');
    await audit(client, actorUserId, 'formation.set', gameId, null, { formation });
    return getMatchday(gameId, client);
  });
}

export async function setMotm({ gameId, playerId, actorUserId }) {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM match_awards WHERE game_id = $1 AND award_type = 'motm'`, [gameId]);
    if (playerId) {
      await client.query(
        `INSERT INTO match_awards (game_id, player_id, award_type, awarded_by)
         VALUES ($1, $2, 'motm', $3)`,
        [gameId, playerId, actorUserId ?? null]
      );
    }
    await audit(client, actorUserId, 'motm.set', gameId, null, { playerId });
    return getMatchday(gameId, client);
  });
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

async function loadGame(client, gameId) {
  const { rows } = await client.query(`SELECT * FROM games WHERE id = $1`, [gameId]);
  if (!rows[0]) throw new NotFoundError('Game not found');
  return rows[0];
}

async function audit(client, actorUserId, action, gameId, before, after) {
  await client.query(
    `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, before, after)
     VALUES ($1, $2, 'game', $3, $4, $5)`,
    [actorUserId ?? null, action, gameId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

/**
 * Everything the pitch needs, in one object.
 *
 * Pass `client` when already inside a transaction. Reading through the pool while holding
 * a transaction deadlocks the moment the pool saturates, and with DATABASE_POOL_MAX=1 it
 * deadlocks immediately -- which is exactly why that setting stays at 1 in development.
 */
export async function getMatchday(gameId, client) {
  const run = client ?? { query };

  const { rows: gameRows } = await run.query(
    `SELECT g.*, d.name AS district_name, d.slug AS district_slug,
            v.name AS venue_name, v.address AS venue_address,
            v.google_maps_url AS venue_maps_url, v.logo_url AS venue_logo
       FROM games g
       JOIN districts d ON d.id = g.district_id
       LEFT JOIN venues v ON v.id = g.venue_id
      WHERE g.id = $1`,
    [gameId]
  );
  const g = gameRows[0];
  if (!g) throw new NotFoundError('Game not found');

  const [{ rows: roster }, { rows: teamRows }, { rows: scores }, { rows: awards }, { rows: events }] =
    await Promise.all([
      run.query(
        `SELECT r.status, r.waitlist_position, r.registered_at, r.attendance,
                p.id AS player_id, p.jersey_name, p.preferred_position, p.is_goalkeeper,
                p.rating_mu, p.rating_sigma,
                u.display_name, u.avatar_url,
                pay.paid_at, pay.method AS paid_method,
                COALESCE(ev.goals, 0)   AS goals,
                COALESCE(ev.assists, 0) AS assists
           FROM registrations r
           JOIN players p ON p.id = r.player_id
           JOIN users u   ON u.id = p.user_id
           LEFT JOIN game_payments pay
             ON pay.game_id = r.game_id AND pay.player_id = p.id AND pay.voided_at IS NULL
           LEFT JOIN LATERAL (
             SELECT COUNT(*) FILTER (WHERE e.type = 'goal' AND e.player_id = p.id)::int AS goals,
                    COUNT(*) FILTER (WHERE e.assist_id = p.id)::int                     AS assists
               FROM match_events e
              WHERE e.game_id = r.game_id AND e.voided_at IS NULL
                AND (e.player_id = p.id OR e.assist_id = p.id)
           ) ev ON true
          WHERE r.game_id = $1 AND r.status <> 'cancelled'
          ORDER BY CASE r.status WHEN 'confirmed' THEN 0 ELSE 1 END,
                   r.waitlist_position NULLS FIRST, r.registered_at`,
        [gameId]
      ),
      run.query(
        `SELECT gt.id AS team_id, gt.color, gt.strength,
                tp.player_id, tp.assigned_position,
                p.is_goalkeeper, p.jersey_name, p.rating_mu, u.display_name
           FROM game_teams gt
           LEFT JOIN team_players tp ON tp.team_id = gt.id
           LEFT JOIN players p ON p.id = tp.player_id
           LEFT JOIN users u ON u.id = p.user_id
          WHERE gt.game_id = $1
          ORDER BY gt.color, tp.assigned_position`,
        [gameId]
      ),
      run.query(`SELECT team_id, color, score FROM game_live_score WHERE game_id = $1`, [gameId]),
      run.query(`SELECT player_id, award_type FROM match_awards WHERE game_id = $1`, [gameId]),
      run.query(
        `SELECT e.id, e.type, e.minute, e.period, e.team_id, e.player_id, e.assist_id,
                u.display_name AS player_name
           FROM match_events e
           LEFT JOIN players p ON p.id = e.player_id
           LEFT JOIN users u ON u.id = p.user_id
          WHERE e.game_id = $1 AND e.voided_at IS NULL
          ORDER BY e.created_at`,
        [gameId]
      ),
    ]);

  const mapPlayer = (r) => ({
    playerId: r.player_id,
    name: r.jersey_name || r.display_name,
    avatarUrl: r.avatar_url ?? null,
    position: r.preferred_position,
    isGoalkeeper: r.is_goalkeeper,
    ratingMu: num(r.rating_mu),
    ratingSigma: num(r.rating_sigma),
    registeredAt: r.registered_at,
    attendance: r.attendance,
    paid: r.paid_at != null,
    paidAt: r.paid_at ?? null,
    paidMethod: r.paid_method ?? null,
    goals: r.goals,
    assists: r.assists,
  });

  const teams = [];
  for (const r of teamRows) {
    let team = teams.find((t) => t.id === r.team_id);
    if (!team) {
      team = {
        id: r.team_id,
        color: r.color,
        strength: num(r.strength),
        score: scores.find((s) => s.team_id === r.team_id)?.score ?? 0,
        players: [],
      };
      teams.push(team);
    }
    if (r.player_id) {
      team.players.push({
        id: r.player_id,
        name: r.jersey_name || r.display_name,
        position: r.assigned_position,
        isGoalkeeper: r.is_goalkeeper,
        ratingMu: num(r.rating_mu),
      });
    }
  }

  const now = new Date();

  return {
    id: g.id,
    districtId: g.district_id,
    districtName: g.district_name,
    districtSlug: g.district_slug,
    venue: g.venue_id
      ? {
          id: g.venue_id, name: g.venue_name, address: g.venue_address,
          mapsUrl: g.venue_maps_url, logo_url: g.venue_logo,
        }
      : null,
    kickoffAt: g.kickoff_at,
    durationMinutes: g.duration_minutes,
    halftimeMinutes: g.halftime_minutes,
    arriveByMinutes: g.arrive_by_minutes,
    capacity: g.capacity,
    teamSize: g.team_size,
    teamCount: g.team_count,
    status: g.status,
    price: num(g.price),
    currency: g.currency,
    title: g.title,
    notes: g.notes,
    slug: g.public_slug,
    formation: g.formation,
    confirmedCount: g.confirmed_count,
    waitlistCount: g.waitlist_count,
    spotsLeft: Math.max(0, g.capacity - g.confirmed_count),

    // The clock, as the three numbers a client needs to run it itself. `serverNow` lets a
    // phone with a wrong system clock correct for its own drift instead of showing a
    // match that started in the future.
    clock: {
      state: g.clock_state,
      startedAt: g.started_at,
      endedAt: g.ended_at,
      periodStartedAt: g.period_started_at,
      elapsedMsAtPeriodStart: Number(g.elapsed_ms_at_period_start),
      pausedAt: g.paused_at,
      pausedMs: Number(g.paused_ms),
      elapsedMs: Math.round(elapsedMs(g, now)),
      minute: currentMinute(g, now),
      durationMinutes: g.duration_minutes,
      halftimeMinutes: g.halftime_minutes,
      serverNow: now.toISOString(),
    },

    roster: roster.filter((r) => r.status === 'confirmed').map(mapPlayer),
    waitlist: roster.filter((r) => r.status === 'waitlisted').map((r) => ({
      ...mapPlayer(r),
      waitlistPosition: r.waitlist_position,
    })),
    teams,
    score: teams.map((t) => ({ teamId: t.id, color: t.color, score: t.score })),
    events: events.map((e) => ({
      id: e.id, type: e.type, minute: e.minute, period: e.period,
      teamId: e.team_id, playerId: e.player_id, playerName: e.player_name, assistId: e.assist_id,
    })),
    motmPlayerId: awards.find((a) => a.award_type === 'motm')?.player_id ?? null,
    lockedTeams: ['in_progress', 'completed'].includes(g.status),

    payments: {
      // The rail on the touchline: who still owes, and what has been collected.
      paidCount: roster.filter((r) => r.status === 'confirmed' && r.paid_at).length,
      unpaidCount: roster.filter((r) => r.status === 'confirmed' && !r.paid_at).length,
      locked: ['first_half', 'halftime', 'second_half'].includes(g.clock_state),
      settlementOpen: g.clock_state === 'finished',
    },
  };
}
