// Recurring games.
//
// A schedule is a rule — "every Tuesday at ten in Metn" — and real games are materialised
// from it a few weeks ahead. Everything downstream (registration, teams, the clock, the
// result) works on those games and never has to know a schedule exists.
//
// THE DATE ARITHMETIC IS DONE IN POSTGRES, ON PURPOSE
//
// "Tuesday at 22:00 Asia/Beirut" is not a fixed offset from UTC: Lebanon observes
// daylight saving, so half the year it is 19:00Z and half the year it is 20:00Z. Getting
// that right in JavaScript without a timezone library means parsing Intl output and
// hoping, and getting it wrong means every fixture silently shifts by an hour twice a
// year. Postgres has the tz database built in, and `(date + time) AT TIME ZONE zone` is
// exactly this calculation, correct across the transition.

import { withTransaction, query } from '../../database/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';

const num = (v) => (v == null ? null : Number(v));

// 0 = Sunday, matching EXTRACT(DOW) and JavaScript's getDay(). Sent to the client so the
// mapping lives in one place rather than being re-derived in every screen that shows it.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function shape(row) {
  return {
    id: row.id,
    districtId: row.district_id,
    districtName: row.district_name ?? null,
    venueId: row.venue_id,
    venueName: row.venue_name ?? null,
    weekday: row.weekday,
    weekdayName: WEEKDAYS[row.weekday],
    // 'HH:MM', which is what a time input wants. Postgres hands back 'HH:MM:SS'.
    time: String(row.kickoff_time).slice(0, 5),
    timezone: row.timezone,
    durationMinutes: row.duration_minutes,
    capacity: row.capacity,
    teamSize: row.team_size,
    teamCount: row.team_count,
    price: num(row.price),
    currency: row.currency,
    title: row.title,
    notes: row.notes,
    horizonDays: row.horizon_days,
    openImmediately: row.open_immediately,
    isActive: row.is_active,
    upcomingCount: row.upcoming_count ?? 0,
    upcoming: (row.upcoming ?? []).map((d) => new Date(d).toISOString()),
    nextKickoffAt: row.next_kickoff_at ?? null,
    createdAt: row.created_at,
  };
}

const SELECT = `
  s.*, d.name AS district_name, v.name AS venue_name,
  (SELECT COUNT(*)::int FROM games g
    WHERE g.schedule_id = s.id AND g.kickoff_at > now()
      AND g.status NOT IN ('cancelled')) AS upcoming_count,
  (SELECT MIN(g.kickoff_at) FROM games g
    WHERE g.schedule_id = s.id AND g.kickoff_at > now()
      AND g.status NOT IN ('cancelled')) AS next_kickoff_at,
  -- The next few kickoffs, so the card can show what this rule actually produces rather
  -- than just asserting that it will produce something.
  (SELECT COALESCE(ARRAY_AGG(k ORDER BY k), '{}')
     FROM (SELECT g.kickoff_at AS k FROM games g
            WHERE g.schedule_id = s.id AND g.kickoff_at > now()
              AND g.status NOT IN ('cancelled')
            ORDER BY g.kickoff_at LIMIT 5) nxt) AS upcoming
`;

export async function listSchedules({ districtId } = {}) {
  const { rows } = await query(
    `SELECT ${SELECT}
       FROM game_schedules s
       JOIN districts d ON d.id = s.district_id
       LEFT JOIN venues v ON v.id = s.venue_id
      WHERE ($1::uuid IS NULL OR s.district_id = $1)
      ORDER BY s.is_active DESC, s.weekday, s.kickoff_time`,
    [districtId ?? null]
  );
  return rows.map(shape);
}

export async function createSchedule(input) {
  const created = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO game_schedules
         (district_id, venue_id, weekday, kickoff_time, timezone, duration_minutes,
          capacity, team_size, team_count, waitlist_capacity, price, currency,
          title, notes, horizon_days, open_immediately, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        input.districtId, input.venueId ?? null, input.weekday, input.time,
        input.timezone ?? 'Asia/Beirut', input.durationMinutes ?? 90,
        input.capacity ?? 22, input.teamSize ?? 11, input.teamCount ?? 2,
        input.waitlistCapacity ?? 10, input.price ?? null, input.currency ?? 'USD',
        input.title ?? null, input.notes ?? null, input.horizonDays ?? 28,
        input.openImmediately ?? true, input.actorUserId ?? null,
      ]
    );
    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, after)
       VALUES ($1, 'schedule.create', 'schedule', $2, $3)`,
      [input.actorUserId ?? null, rows[0].id, JSON.stringify({ weekday: input.weekday, time: input.time })]
    );
    return rows[0].id;
  });

  // Fill the horizon immediately. A schedule that produces nothing until a timer fires
  // looks broken to the admin who just made it.
  await generate({ scheduleId: created });
  return getSchedule(created);
}

export async function getSchedule(id) {
  const { rows } = await query(
    `SELECT ${SELECT}
       FROM game_schedules s
       JOIN districts d ON d.id = s.district_id
       LEFT JOIN venues v ON v.id = s.venue_id
      WHERE s.id = $1`,
    [id]
  );
  if (!rows[0]) throw new NotFoundError('Schedule');
  return shape(rows[0]);
}

export async function setActive({ scheduleId, isActive, actorUserId }) {
  const { rowCount } = await query(
    `UPDATE game_schedules SET is_active = $2 WHERE id = $1`, [scheduleId, isActive]
  );
  if (!rowCount) throw new NotFoundError('Schedule');
  await query(
    `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, after)
     VALUES ($1, $2, 'schedule', $3, $4)`,
    [actorUserId ?? null, isActive ? 'schedule.resume' : 'schedule.pause', scheduleId,
      JSON.stringify({ isActive })]
  );
  if (isActive) await generate({ scheduleId });
  return getSchedule(scheduleId);
}

/**
 * Delete a schedule.
 *
 * `games.schedule_id` is ON DELETE SET NULL, so fixtures already created survive as
 * ordinary one-off games. That is the right default: people have signed up for them, and
 * removing the rule that made them is not a reason to cancel next Tuesday.
 *
 * `withFuture` deletes the unplayed ones too, for a schedule created by mistake.
 */
export async function deleteSchedule({ scheduleId, withFuture = false, actorUserId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, weekday, kickoff_time FROM game_schedules WHERE id = $1 FOR UPDATE`,
      [scheduleId]
    );
    if (!rows[0]) throw new NotFoundError('Schedule');

    let removedGames = 0;
    if (withFuture) {
      // Only games nobody has played. A settled game is history and is refused deletion
      // for the same reason a settled game cannot be deleted directly.
      const { rowCount } = await client.query(
        `DELETE FROM games g
          WHERE g.schedule_id = $1
            AND g.kickoff_at > now()
            AND g.status NOT IN ('in_progress','completed')
            AND NOT EXISTS (SELECT 1 FROM player_ratings pr WHERE pr.game_id = g.id)`,
        [scheduleId]
      );
      removedGames = rowCount;
    }

    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, before, reason)
       VALUES ($1, 'schedule.delete', 'schedule', $2, $3, $4)`,
      [actorUserId ?? null, scheduleId, JSON.stringify(rows[0]),
        withFuture ? `also removed ${removedGames} unplayed fixture(s)` : 'fixtures kept as one-offs']
    );

    await client.query('DELETE FROM game_schedules WHERE id = $1', [scheduleId]);
    return { deleted: true, id: scheduleId, removedGames };
  });
}

/**
 * Materialise fixtures for the horizon.
 *
 * Safe to run as often as you like: `games_one_per_schedule_slot` makes a repeat insert a
 * no-op, so this can be called on a timer, on page load, and after every edit without
 * anybody having to reason about whether it already ran.
 *
 * `generate_series` walks each day in the window; the WHERE clause keeps the matching
 * weekday; `AT TIME ZONE` turns the local date and clock time into the correct instant,
 * daylight saving included.
 */
export async function generate({ scheduleId = null } = {}) {
  const { rows } = await query(
    `WITH active AS (
       SELECT * FROM game_schedules
        WHERE is_active AND ($1::uuid IS NULL OR id = $1)
     ),
     slots AS (
       SELECT a.*,
              ((day::date + a.kickoff_time) AT TIME ZONE a.timezone) AS kickoff_at
         FROM active a
         CROSS JOIN LATERAL generate_series(
           (now() AT TIME ZONE a.timezone)::date,
           (now() AT TIME ZONE a.timezone)::date + a.horizon_days,
           interval '1 day'
         ) AS day
        WHERE EXTRACT(DOW FROM day) = a.weekday
     )
     INSERT INTO games
       (schedule_id, district_id, venue_id, kickoff_at, duration_minutes, halftime_minutes,
        arrive_by_minutes, capacity, team_size, team_count, waitlist_capacity,
        price, currency, title, notes, status, created_by)
     SELECT s.id, s.district_id, s.venue_id, s.kickoff_at, s.duration_minutes,
            s.halftime_minutes, s.arrive_by_minutes, s.capacity, s.team_size, s.team_count,
            s.waitlist_capacity, s.price, s.currency, s.title, s.notes,
            CASE WHEN s.open_immediately THEN 'registration_open' ELSE 'draft' END,
            s.created_by
       FROM slots s
      WHERE s.kickoff_at > now()
     ON CONFLICT (schedule_id, kickoff_at) WHERE schedule_id IS NOT NULL DO NOTHING
     RETURNING id, schedule_id, kickoff_at`,
    [scheduleId]
  );
  return { created: rows.length, games: rows };
}

/**
 * A public_slug is generated per game elsewhere; schedules produce games without one so
 * that the share link is only minted for fixtures somebody actually opens. Backfilled
 * lazily by the games module when a slug is first needed.
 */
export async function upcomingFor(scheduleId) {
  const { rows } = await query(
    `SELECT id, kickoff_at, status, confirmed_count, capacity
       FROM games WHERE schedule_id = $1 AND kickoff_at > now()
      ORDER BY kickoff_at LIMIT 12`,
    [scheduleId]
  );
  return rows.map((r) => ({
    id: r.id,
    kickoffAt: r.kickoff_at,
    status: r.status,
    confirmedCount: r.confirmed_count,
    capacity: r.capacity,
  }));
}
