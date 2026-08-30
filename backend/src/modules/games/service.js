// Game lifecycle: create, list, open registration, cancel.

import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../../database/pool.js';
import { publish, EventTypes } from '../../lib/events.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { generateAnnouncement } from '../../integrations/whatsapp/announcements.js';
import { venueLogoPath } from '../../lib/venueLogo.js';
import config from '../../config/index.js';

const DAY_SLUGS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Short, human-readable, unguessable enough that share links are not enumerable. */
function buildSlug(kickoffAt, districtSlug) {
  const day = DAY_SLUGS[new Date(kickoffAt).getUTCDay()];
  return `${day}-${districtSlug}-${randomBytes(3).toString('hex')}`;
}

const publicUrl = (slug) => `${config.publicWebUrl}/g/${slug}`;

const GAME_COLUMNS = `
  g.id, g.district_id, g.venue_id, g.kickoff_at, g.duration_minutes, g.arrive_by_minutes,
  g.capacity, g.team_size, g.team_count, g.waitlist_capacity,
  g.status, g.registration_opens_at, g.registration_closes_at,
  g.price, g.currency, g.title, g.notes, g.public_slug, g.is_public,
  g.confirmed_count, g.waitlist_count, g.cancelled_reason, g.created_at,
  d.name AS district_name, d.slug AS district_slug,
  v.name AS venue_name, v.google_maps_url AS venue_maps_url, v.address AS venue_address,
  -- Whether there is a badge, and when it last changed. NOT the badge itself: it is
  -- 50-60kb of base64, it repeats on every game in the list, and it is the reason a
  -- four-game response weighed 238kb. The bytes come from /api/venues/:id/logo.
  (v.logo_url IS NOT NULL) AS venue_has_logo, v.updated_at AS venue_updated_at
`;

/**
 * The score of a finished game, folded into the shape the UI renders.
 *
 * Every result surface in the app -- the fixture card, the game page, match of the week,
 * the admin summary, a player's history -- reads `game.result`, and nothing was putting
 * one there, so a completed match showed no score anywhere. This is that object, and it
 * is deliberately built from the same rows `results/service.getResult` uses so the two
 * can never disagree about who won.
 *
 * Keyed by team COLOUR rather than by position, because that is what the team sheet, the
 * pitch and the announcement all say, and `{ a: 3, b: 1 }` needs a lookup to mean
 * anything to a person.
 */
export function shapeResult(row) {
  if (!row || row.team_a_score == null) return null;
  const score = { [row.team_a_color ?? 'a']: row.team_a_score };
  if (row.team_b_color || row.team_b_score != null) {
    score[row.team_b_color ?? 'b'] = row.team_b_score;
  }
  return {
    score,
    // Positional as well, for the two places that draw a scoreline left-to-right and
    // do not care what the shirts were.
    home: { color: row.team_a_color ?? null, score: row.team_a_score },
    away: { color: row.team_b_color ?? null, score: row.team_b_score },
    motm: row.motm_player_id
      ? { playerId: row.motm_player_id, name: row.motm_name }
      : null,
  };
}

/**
 * The viewer's own registration, as two columns on the game.
 *
 * `n` is the 1-based index of the bind parameter holding their player id. Null there --
 * an anonymous visitor -- makes both columns null, which is the right answer to "am I in
 * this game" for somebody who is not signed in.
 */
const VIEWER_COLUMNS = `
  vr.status AS my_registration_status,
  vr.waitlist_position AS my_waitlist_position
`;

const viewerJoin = (n) => `
  LEFT JOIN registrations vr
    ON vr.game_id = g.id
   AND vr.player_id = $${n}::uuid
   AND vr.status <> 'cancelled'
`;

// The current result for a game, as a correlated subquery on `games`. One join, no N+1.
export const RESULT_COLUMNS = `
  mr.team_a_score, mr.team_b_score,
  rta.color AS team_a_color, rtb.color AS team_b_color,
  motm.player_id AS motm_player_id, motm.name AS motm_name
`;

// LATERAL, not a plain join, for the award. `match_awards` is unique on
// (game_id, award_type, player_id), so nothing at the schema level stopped two players
// both holding man of the match for one game -- and a plain join on that would silently
// return the SAME GAME TWICE in a list. Migration 021 now forbids it; this is written so
// that it could not multiply rows even if it were somehow reintroduced.
export const RESULT_JOINS = `
  LEFT JOIN match_results mr ON mr.game_id = g.id AND mr.is_current
  LEFT JOIN game_teams rta   ON rta.id = mr.team_a_id
  LEFT JOIN game_teams rtb   ON rtb.id = mr.team_b_id
  LEFT JOIN LATERAL (
    SELECT ma.player_id, COALESCE(mp.jersey_name, mu.display_name) AS name
      FROM match_awards ma
      JOIN players mp ON mp.id = ma.player_id
      JOIN users mu   ON mu.id = mp.user_id
     WHERE ma.game_id = g.id AND ma.award_type = 'motm'
     ORDER BY ma.created_at
     LIMIT 1
  ) motm ON true
`;

function shape(row) {
  return {
    id: row.id,
    districtId: row.district_id,
    districtName: row.district_name,
    venue: row.venue_id
      ? {
          id: row.venue_id,
          name: row.venue_name,
          address: row.venue_address,
          mapsUrl: row.venue_maps_url,
          hasLogo: !!row.venue_has_logo,
          logoUrl: row.venue_has_logo
            ? venueLogoPath(row.venue_id, row.venue_updated_at)
            : null,
        }
      : null,
    kickoffAt: row.kickoff_at,
    durationMinutes: row.duration_minutes,
    arriveByMinutes: row.arrive_by_minutes,
    capacity: row.capacity,
    teamSize: row.team_size,
    teamCount: row.team_count,
    status: row.status,
    registrationOpensAt: row.registration_opens_at,
    registrationClosesAt: row.registration_closes_at,
    price: row.price == null ? null : Number(row.price),
    currency: row.currency,
    title: row.title,
    notes: row.notes,
    slug: row.public_slug,
    url: row.public_slug ? publicUrl(row.public_slug) : null,
    confirmedCount: row.confirmed_count,
    waitlistCount: row.waitlist_count,
    spotsLeft: Math.max(0, row.capacity - row.confirmed_count),
    cancelledReason: row.cancelled_reason,
    result: shapeResult(row),

    // The viewer's own place in this game. Absent for an anonymous visitor, which is why
    // `isRegistered` is a boolean rather than being left undefined: a card that cannot
    // tell "not registered" from "nobody asked" renders the same either way.
    isRegistered: row.my_registration_status != null,
    myRegistrationStatus: row.my_registration_status ?? null,
    myWaitlistPosition: row.my_waitlist_position ?? null,
  };
}

export async function createGame({
  districtId, venueId, kickoffAt, capacity = 22, teamSize = 11, teamCount = 2,
  waitlistCapacity = 10, durationMinutes = 90, arriveByMinutes = 15,
  registrationOpensAt, registrationClosesAt, price, currency = 'USD',
  title, notes, openImmediately = false, actorUserId,
}) {
  if (capacity !== teamSize * teamCount) {
    throw new ConflictError(
      `Capacity ${capacity} does not divide into ${teamCount} teams of ${teamSize}`,
      'INVALID_CAPACITY'
    );
  }

  return withTransaction(async (client) => {
    const { rows: districtRows } = await client.query(
      'SELECT slug FROM districts WHERE id = $1 AND is_active', [districtId]
    );
    if (districtRows.length === 0) throw new NotFoundError('District');

    if (venueId) {
      const { rows: venueRows } = await client.query(
        'SELECT district_id FROM venues WHERE id = $1 AND is_active', [venueId]
      );
      if (venueRows.length === 0) throw new NotFoundError('Venue');
      if (venueRows[0].district_id !== districtId) {
        throw new ConflictError('That venue is in a different district', 'VENUE_DISTRICT_MISMATCH');
      }
    }

    const status = openImmediately ? 'registration_open' : 'draft';
    const slug = buildSlug(kickoffAt, districtRows[0].slug);

    const { rows } = await client.query(
      `INSERT INTO games (
         district_id, venue_id, kickoff_at, duration_minutes, arrive_by_minutes,
         capacity, team_size, team_count, waitlist_capacity, status,
         registration_opens_at, registration_closes_at, price, currency,
         title, notes, public_slug, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        districtId, venueId ?? null, kickoffAt, durationMinutes, arriveByMinutes,
        capacity, teamSize, teamCount, waitlistCapacity, status,
        registrationOpensAt ?? (openImmediately ? new Date() : null),
        registrationClosesAt ?? null, price ?? null, currency,
        title ?? null, notes ?? null, slug, actorUserId,
      ]
    );
    const gameId = rows[0].id;

    await publish(client, {
      eventType: EventTypes.GameCreated,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: { gameId, districtId, kickoffAt, capacity },
    });

    if (openImmediately) {
      await publish(client, {
        eventType: EventTypes.GameRegistrationOpened,
        aggregateType: 'game',
        aggregateId: gameId,
        actorUserId,
        payload: { gameId },
      });
    }

    const { rows: full } = await client.query(
      `SELECT ${GAME_COLUMNS}, ${RESULT_COLUMNS}, ${VIEWER_COLUMNS} FROM games g
         JOIN districts d ON d.id = g.district_id
         LEFT JOIN venues v ON v.id = g.venue_id
         ${RESULT_JOINS}
         ${viewerJoin(2)}
        WHERE g.id = $1`,
      [gameId, null]
    );
    return shape(full[0]);
  });
}

export async function listGames({
  districtId, status, from, to, when, limit = 50, offset = 0,
  includePrivate = false, privateDistrictIds = null, viewerPlayerId = null,
}) {
  const conditions = [];
  // $1 is always the viewer's player id, so the join's placeholder is fixed and the rest
  // of the filters number from $2. Null for an anonymous visitor.
  const params = [viewerPlayerId];

  if (districtId) { params.push(districtId); conditions.push(`g.district_id = $${params.length}`); }
  if (status?.length) { params.push(status); conditions.push(`g.status = ANY($${params.length})`); }
  if (from) { params.push(from); conditions.push(`g.kickoff_at >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`g.kickoff_at <= $${params.length}`); }
  // A finished match is past even if its kickoff time has not arrived -- which happens
  // whenever a game is played early, or rescheduled after the fact. Ordering flips too:
  // "upcoming" means soonest first, "past" means most recent first.
  if (when === 'upcoming') conditions.push(`g.kickoff_at >= now() AND g.status NOT IN ('completed','cancelled')`);
  if (when === 'past') conditions.push(`(g.kickoff_at < now() OR g.status IN ('completed','cancelled'))`);
  if (!includePrivate) {
    // Public games, plus the private ones belonging to a district this caller administers.
    if (privateDistrictIds?.length) {
      params.push(privateDistrictIds);
      conditions.push(
        `((g.is_public AND g.status <> 'draft') OR g.district_id = ANY($${params.length}))`
      );
    } else {
      conditions.push(`g.is_public AND g.status <> 'draft'`);
    }
  }

  params.push(limit, offset);

  const { rows } = await query(
    `SELECT ${GAME_COLUMNS}, ${RESULT_COLUMNS}, ${VIEWER_COLUMNS} FROM games g
       JOIN districts d ON d.id = g.district_id
       LEFT JOIN venues v ON v.id = g.venue_id
       ${RESULT_JOINS}
       ${viewerJoin(1)}
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY g.kickoff_at ${when === 'past' ? 'DESC' : 'ASC'}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return rows.map(shape);
}

// `client` lets callers read on an already-open transaction. Reaching for a second
// connection from inside a transaction deadlocks once the pool is saturated: every
// holder waits for a connection that only another holder can release.
async function fetchGame(where, value, client, viewerPlayerId = null) {
  const run = client ?? { query };
  const { rows } = await run.query(
    `SELECT ${GAME_COLUMNS}, ${RESULT_COLUMNS}, ${VIEWER_COLUMNS} FROM games g
       JOIN districts d ON d.id = g.district_id
       LEFT JOIN venues v ON v.id = g.venue_id
       ${RESULT_JOINS}
       ${viewerJoin(2)}
      WHERE ${where}`,
    [value, viewerPlayerId]
  );
  if (rows.length === 0) throw new NotFoundError('Game');
  return shape(rows[0]);
}

export const getGame = (id, client, viewerPlayerId = null) =>
  fetchGame('g.id = $1', id, client, viewerPlayerId);
export const getGameBySlug = (slug, client, viewerPlayerId = null) =>
  fetchGame('g.public_slug = $1', slug, client, viewerPlayerId);

/** The district a game belongs to. Used by the district authorisation guard. */
export async function getGameDistrictId(gameId) {
  const { rows } = await query('SELECT district_id FROM games WHERE id = $1', [gameId]);
  return rows[0]?.district_id ?? null;
}

export async function openRegistration({ gameId, actorUserId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE games SET status = 'registration_open',
              registration_opens_at = COALESCE(registration_opens_at, now())
        WHERE id = $1 AND status = 'draft'
        RETURNING id`,
      [gameId]
    );
    if (rows.length === 0) {
      throw new ConflictError('That game is not a draft', 'INVALID_STATE_TRANSITION');
    }

    await publish(client, {
      eventType: EventTypes.GameRegistrationOpened,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: { gameId },
    });

    return getGame(gameId, client);
  });
}

export async function cancelGame({ gameId, reason, actorUserId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT status FROM games WHERE id = $1 FOR UPDATE`, [gameId]
    );
    if (rows.length === 0) throw new NotFoundError('Game');
    if (rows[0].status === 'completed') {
      throw new ConflictError('That game has already been played', 'GAME_COMPLETED');
    }
    if (rows[0].status === 'cancelled') return getGame(gameId, client);

    await client.query(
      `UPDATE games SET status = 'cancelled', cancelled_at = now(), cancelled_reason = $2
        WHERE id = $1`,
      [gameId, reason ?? null]
    );

    // Registrations are cancelled, not deleted. Who was signed up for a game that got
    // called off is exactly the sort of thing someone asks about later.
    await client.query(
      `UPDATE registrations
          SET status = 'cancelled', waitlist_position = NULL, cancelled_at = now(),
              cancelled_by = $2, cancel_reason = 'game_cancelled'
        WHERE game_id = $1 AND status <> 'cancelled'`,
      [gameId, actorUserId]
    );

    await publish(client, {
      eventType: EventTypes.GameCancelled,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: { gameId, reason },
    });

    return getGame(gameId, client);
  });
}

/**
 * Build a WhatsApp announcement for an admin to copy into the community, and record that
 * it was generated. The platform cannot post to groups; this is the bridge.
 */
export async function buildAnnouncement({ gameId, kind, actorUserId }) {
  const game = await getGame(gameId);

  const extra = {};
  if (kind === 'teams') {
    const { rows } = await query(
      `SELECT gt.color, tp.assigned_position, u.display_name, p.jersey_name
         FROM game_teams gt
         JOIN team_players tp ON tp.team_id = gt.id
         JOIN players p ON p.id = tp.player_id
         JOIN users u ON u.id = p.user_id
        WHERE gt.game_id = $1
        ORDER BY gt.color, tp.assigned_position`,
      [gameId]
    );
    if (rows.length === 0) {
      throw new ConflictError('Teams have not been generated for this game', 'NO_TEAMS');
    }
    const byColor = new Map();
    for (const r of rows) {
      if (!byColor.has(r.color)) byColor.set(r.color, { color: r.color, players: [] });
      byColor.get(r.color).players.push({
        assignedPosition: r.assigned_position,
        name: r.jersey_name || r.display_name,
      });
    }
    extra.teams = [...byColor.values()];
  }

  if (kind === 'result') {
    const { rows } = await query(
      `SELECT mr.team_a_score, mr.team_b_score,
              ta.color AS team_a_color, tb.color AS team_b_color,
              (SELECT u.display_name FROM match_awards ma
                 JOIN players p ON p.id = ma.player_id
                 JOIN users u ON u.id = p.user_id
                WHERE ma.game_id = mr.game_id AND ma.award_type = 'motm' LIMIT 1) AS motm
         FROM match_results mr
         LEFT JOIN game_teams ta ON ta.id = mr.team_a_id
         LEFT JOIN game_teams tb ON tb.id = mr.team_b_id
        WHERE mr.game_id = $1 AND mr.is_current`,
      [gameId]
    );
    if (rows.length === 0) throw new ConflictError('No result recorded yet', 'NO_RESULT');
    extra.result = {
      teamAName: rows[0].team_a_color ?? 'Team A',
      teamBName: rows[0].team_b_color ?? 'Team B',
      teamAScore: rows[0].team_a_score,
      teamBScore: rows[0].team_b_score,
      motm: rows[0].motm,
    };
  }

  const body = generateAnnouncement(kind, {
    kickoffAt: game.kickoffAt,
    districtName: game.districtName,
    venueName: game.venue?.name,
    venueMapsUrl: game.venue?.mapsUrl,
    capacity: game.capacity,
    confirmedCount: game.confirmedCount,
    waitlistCount: game.waitlistCount,
    arriveByMinutes: game.arriveByMinutes,
    price: game.price,
    currency: game.currency,
    publicUrl: game.url,
  }, extra);

  const { rows } = await query(
    `INSERT INTO announcements (game_id, district_id, kind, body, generated_by)
     VALUES ($1, $2, $3, $4, 'template')
     RETURNING id, created_at`,
    [gameId, game.districtId, kind, body]
  );

  return { id: rows[0].id, kind, body, createdAt: rows[0].created_at };
}

/**
 * Delete a game outright.
 *
 * Cancelling and deleting answer different questions. A game that was called off happened
 * -- people signed up, arranged their evening, and were let down, and the reliability
 * numbers depend on knowing that. A game created by mistake, or a test fixture, or a
 * duplicate of next Tuesday, never happened at all and should leave no trace.
 *
 * WHAT STOPS A DELETE
 *
 * One thing: whether the game has already changed the record. Once ratings have been
 * applied or points awarded, the game is not an entry any more, it is the reason
 * twenty-two people's numbers are what they are. Deleting it would silently move every
 * one of them, and nothing in the app would explain why. The schema already refuses --
 * player_ratings.game_id is ON DELETE NO ACTION -- but a raw foreign key error is a 500
 * and a stack trace, so the check happens here and says what to do instead.
 *
 * Everything else cascades: registrations, teams, payments, events, results, invites.
 */
export async function deleteGame({ gameId, actorUserId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, title, kickoff_at, confirmed_count FROM games WHERE id = $1 FOR UPDATE`,
      [gameId]
    );
    if (rows.length === 0) throw new NotFoundError('Game');
    const game = rows[0];

    const { rows: [impact] } = await client.query(
      `SELECT (SELECT COUNT(*) FROM player_ratings WHERE game_id = $1)::int      AS ratings,
              (SELECT COUNT(*) FROM point_transactions
                WHERE reference_type = 'game' AND reference_id = $1)::int         AS points,
              (SELECT COUNT(*) FROM player_achievements WHERE game_id = $1)::int  AS achievements`,
      [gameId]
    );

    if (impact.ratings > 0 || impact.points > 0 || impact.achievements > 0) {
      throw new ConflictError(
        'This game has already been rated and paid out, so deleting it would move every '
        + 'player\'s rating with no record of why. Cancel it instead.',
        'GAME_SETTLED'
      );
    }

    // Written before the row goes, so the audit trail keeps what was destroyed. This is
    // the only record that will survive the delete.
    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, before, reason)
       VALUES ($1, 'game.delete', 'game', $2, $3, $4)`,
      [actorUserId ?? null, gameId,
        JSON.stringify({
          title: game.title, kickoffAt: game.kickoff_at,
          status: game.status, confirmedCount: game.confirmed_count,
        }),
        `deleted with ${game.confirmed_count} player(s) registered`]
    );

    await client.query(`DELETE FROM games WHERE id = $1`, [gameId]);
    return { deleted: true, id: gameId, hadPlayers: game.confirmed_count };
  });
}

/**
 * The clock, for anyone allowed to look at the game.
 *
 * Same three timestamps the admin projection returns, minus everything a player has no
 * business seeing. Kept here rather than reaching into the matchday module so the public
 * game endpoint does not depend on an admin-only service.
 */
export async function getPublicClock(gameId) {
  const { rows } = await query(
    `SELECT clock_state, started_at, ended_at, period_started_at,
            elapsed_ms_at_period_start, paused_at, paused_ms,
            duration_minutes, halftime_minutes
       FROM games WHERE id = $1`,
    [gameId]
  );
  const g = rows[0];
  if (!g) return null;

  return {
    state: g.clock_state,
    startedAt: g.started_at,
    endedAt: g.ended_at,
    periodStartedAt: g.period_started_at,
    elapsedMsAtPeriodStart: Number(g.elapsed_ms_at_period_start),
    pausedAt: g.paused_at,
    pausedMs: Number(g.paused_ms),
    durationMinutes: g.duration_minutes,
    halftimeMinutes: g.halftime_minutes,
    serverNow: new Date().toISOString(),
  };
}
