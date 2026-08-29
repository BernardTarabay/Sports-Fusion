// The admin overview.
//
// Two people run this league in the evenings. The only question this screen answers is
// "what needs me tonight" — so `openActions` is the substance and the charts are
// context. Everything is derived from live rows; there is nothing stored here.

import { query } from '../../database/pool.js';

/**
 * Things that will go wrong if nobody touches them.
 *
 * Ordered by how close the deadline is, not by category. A result missing from three
 * weeks ago is a chore; a full game tomorrow with no teams is tonight's problem, and it
 * has to be at the top even though "missing result" sounds more serious in the abstract.
 */
async function openActions(districtIds) {
  const { rows } = await query(
    `WITH scoped AS (
       SELECT g.*, d.name AS district_name, v.name AS venue_name
         FROM games g
         JOIN districts d ON d.id = g.district_id
         LEFT JOIN venues v ON v.id = g.venue_id
        WHERE ($1::uuid[] IS NULL OR g.district_id = ANY($1))
          AND g.status <> 'cancelled'
     )
     SELECT * FROM (
       -- Full, kicking off, no teams. The one that ruins an evening.
       SELECT 'generate_teams' AS type, 'Teams not generated' AS label, 'high' AS severity,
              s.id, s.kickoff_at, s.district_name, s.venue_name, s.title,
              s.confirmed_count, s.capacity, s.status
         FROM scoped s
        WHERE s.kickoff_at > now()
          AND s.confirmed_count >= s.capacity
          AND NOT EXISTS (SELECT 1 FROM game_teams t WHERE t.game_id = s.id)

       UNION ALL

       -- Played, but the score was never entered, so nobody's rating moved.
       SELECT 'enter_result', 'Result not recorded', 'medium',
              s.id, s.kickoff_at, s.district_name, s.venue_name, s.title,
              s.confirmed_count, s.capacity, s.status
         FROM scoped s
        WHERE s.kickoff_at < now()
          AND s.status IN ('completed', 'in_progress', 'teams_generated', 'full')
          AND NOT EXISTS (
            SELECT 1 FROM match_results mr WHERE mr.game_id = s.id AND mr.is_current
          )

       UNION ALL

       -- Kicking off soon and less than half full. Still fixable with a message.
       SELECT 'low_signups', 'Filling slowly', 'low',
              s.id, s.kickoff_at, s.district_name, s.venue_name, s.title,
              s.confirmed_count, s.capacity, s.status
         FROM scoped s
        WHERE s.kickoff_at > now()
          AND s.kickoff_at < now() + interval '3 days'
          AND s.confirmed_count::numeric < s.capacity * 0.5
     ) actions
     ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              ABS(EXTRACT(EPOCH FROM (kickoff_at - now())))
     LIMIT 12`,
    [districtIds]
  );

  return rows.map((r) => ({
    type: r.type,
    label: r.label,
    severity: r.severity,
    gameId: r.id,
    game: {
      id: r.id,
      title: r.title,
      kickoffAt: r.kickoff_at,
      districtName: r.district_name,
      venue: r.venue_name ? { name: r.venue_name } : null,
      confirmedCount: r.confirmed_count,
      capacity: r.capacity,
      status: r.status,
      spotsLeft: Math.max(0, r.capacity - r.confirmed_count),
    },
  }));
}

export async function getOverview({ districtIds = null } = {}) {
  const [today, upcoming, trend, byDistrict, actions] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS games,
              COALESCE(SUM(g.confirmed_count), 0)::int AS registered,
              COALESCE(SUM(g.waitlist_count), 0)::int  AS waitlisted
         FROM games g
        WHERE g.status <> 'cancelled'
          AND (g.kickoff_at AT TIME ZONE 'Asia/Beirut')::date
              = (now() AT TIME ZONE 'Asia/Beirut')::date
          AND ($1::uuid[] IS NULL OR g.district_id = ANY($1))`,
      [districtIds]
    ),
    query(
      `SELECT g.id, g.title, g.kickoff_at, g.status, g.capacity, g.confirmed_count,
              g.waitlist_count, d.name AS district_name, v.name AS venue_name
         FROM games g
         JOIN districts d ON d.id = g.district_id
         LEFT JOIN venues v ON v.id = g.venue_id
        WHERE g.kickoff_at > now() AND g.status <> 'cancelled'
          AND ($1::uuid[] IS NULL OR g.district_id = ANY($1))
        ORDER BY g.kickoff_at LIMIT 8`,
      [districtIds]
    ),
    // Occupancy over the last twelve weeks. Empty weeks are dropped rather than plotted
    // as zero: a league that did not exist yet is not a league with nobody turning up.
    query(
      `SELECT to_char(date_trunc('week', g.kickoff_at), 'DD Mon') AS label,
              ROUND(AVG(g.confirmed_count::numeric / NULLIF(g.capacity, 0)), 3)::float8 AS value,
              COUNT(*)::int AS games
         FROM games g
        WHERE g.kickoff_at > now() - interval '12 weeks'
          AND g.kickoff_at < now()
          AND g.status = 'completed'
          AND ($1::uuid[] IS NULL OR g.district_id = ANY($1))
        GROUP BY date_trunc('week', g.kickoff_at)
        ORDER BY date_trunc('week', g.kickoff_at)`,
      [districtIds]
    ),
    query(
      `SELECT d.name,
              COUNT(g.id)::int AS games_played,
              COALESCE(ROUND(AVG(
                CASE WHEN g.status = 'completed'
                     THEN g.confirmed_count::numeric / NULLIF(g.capacity, 0) END
              ), 3), 0)::float8 AS occupancy,
              (SELECT COUNT(*)::int FROM players p
                WHERE p.home_district_id = d.id AND p.status = 'active') AS players
         FROM districts d
         LEFT JOIN games g ON g.district_id = d.id AND g.status <> 'cancelled'
        WHERE d.is_active
          AND ($1::uuid[] IS NULL OR d.id = ANY($1))
        GROUP BY d.id, d.name
        ORDER BY d.name`,
      [districtIds]
    ),
    openActions(districtIds),
  ]);

  // Attendance is only meaningful once games have actually been marked. Null rather than
  // a confident 0%, which would read as "nobody came" instead of "nobody has recorded it".
  const { rows: [att] } = await query(
    `SELECT COUNT(*) FILTER (WHERE r.attendance IN ('attended','late'))::int AS present,
            COUNT(*) FILTER (WHERE r.attendance IS NOT NULL)::int            AS recorded
       FROM registrations r
       JOIN games g ON g.id = r.game_id
      WHERE g.kickoff_at > now() - interval '90 days'
        AND ($1::uuid[] IS NULL OR g.district_id = ANY($1))`,
    [districtIds]
  );

  return {
    today: {
      games: today.rows[0].games,
      registered: today.rows[0].registered,
      waitlisted: today.rows[0].waitlisted,
      attendance: att.recorded > 0 ? att.present / att.recorded : null,
    },
    openActions: actions,
    upcoming: upcoming.rows.map((g) => ({
      id: g.id,
      title: g.title,
      kickoffAt: g.kickoff_at,
      status: g.status,
      capacity: g.capacity,
      confirmedCount: g.confirmed_count,
      waitlistCount: g.waitlist_count,
      districtName: g.district_name,
      venue: g.venue_name ? { name: g.venue_name } : null,
      spotsLeft: Math.max(0, g.capacity - g.confirmed_count),
    })),
    occupancyTrend: trend.rows.map((r) => ({ label: r.label, value: r.value ?? 0 })),
    districtPerformance: byDistrict.rows.map((r) => ({
      name: r.name, gamesPlayed: r.games_played, occupancy: r.occupancy, players: r.players,
    })),
  };
}
