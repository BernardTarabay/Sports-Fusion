// Man of the Month.
//
// Derived, never stored. There is no table where somebody writes down who won August;
// the answer is computed from what actually happened that month, so it cannot drift from
// the record and it corrects itself if a result is corrected.
//
// HOW THE WINNER IS PICKED
//
// Most man-of-the-match awards that month, and average rating breaks the tie.
//
// This is deliberately the simplest defensible rule. A composite score with weights is
// more sophisticated and much worse here: nobody can check it, an argument about who
// deserved it becomes an argument about the formula, and the formula is invisible. "He
// was man of the match three times, you were twice" ends the argument in one sentence.
//
// Average rating alone would not do it either -- a player who turns up twice, plays two
// quiet games and drifts upward would beat someone who was the best player on the pitch
// four times. Hence MOTM first, and a minimum number of appearances so one lucky night
// cannot win a month.

import { query } from '../../database/pool.js';

/**
 * The 0-10 scale players see, matching the frontend's toPlayerRating.
 *
 * Duplicated on purpose rather than shared: the frontend needs it for values it already
 * holds, and this needs it inside SQL-adjacent aggregation. Both sides centre 1500 on 6.5
 * at roughly a point per 150 rating; if that mapping ever changes it changes in both, and
 * a test would catch the drift faster than an import would prevent it.
 */
const toPlayerRating = (mu) => {
  if (mu == null) return null;
  return Math.max(1, Math.min(10, Math.round((6.5 + (Number(mu) - 1500) / 150) * 10) / 10));
};

/** Somebody has to show up this often before a month counts as theirs. */
const MIN_APPEARANCES = 2;

/**
 * One month's standings.
 *
 * `month` is the first day of the month, in the league's local time. Everything is bucketed
 * by the game's kickoff, not by when a result was entered -- an admin filling in Saturday's
 * score on Monday has not moved the game into a new month.
 */
async function standingsFor(monthStart, { districtId = null } = {}) {
  const { rows } = await query(
    `WITH month_games AS (
       SELECT g.id
         FROM games g
        WHERE g.kickoff_at >= $1::timestamptz
          AND g.kickoff_at <  ($1::timestamptz + interval '1 month')
          AND g.status = 'completed'
          AND ($2::uuid IS NULL OR g.district_id = $2)
     ),
     appearances AS (
       SELECT r.player_id, COUNT(*)::int AS games
         FROM registrations r
         JOIN month_games mg ON mg.id = r.game_id
        WHERE r.attendance IN ('attended', 'late')
        GROUP BY r.player_id
     ),
     awards AS (
       SELECT ma.player_id, COUNT(*)::int AS motm
         FROM match_awards ma
         JOIN month_games mg ON mg.id = ma.game_id
        WHERE ma.award_type = 'motm'
        GROUP BY ma.player_id
     ),
     -- Goals and assists come from TWO places and only one of them is usually filled in.
     --
     -- player_match_stats is written when an admin files a full result with a per-player
     -- stats array. Nothing in the app does that: goals are tapped in on the matchday
     -- screen during the game and land in match_events. So this read every player's
     -- contribution as zero, and the Man of the Month card -- the most prestigious thing
     -- the community awards -- showed "0 GOALS 0 ASSISTS" beside a player who had scored
     -- four.
     --
     -- Both are counted, and the larger wins per player. They are two records of the same
     -- fact rather than two different facts, so summing them would double-count a game
     -- that has both.
     live_events AS (
       SELECT e.player_id,
              COUNT(*) FILTER (WHERE e.type = 'goal')::int AS goals
         FROM match_events e
         JOIN month_games mg ON mg.id = e.game_id
        WHERE e.voided_at IS NULL AND e.player_id IS NOT NULL
        GROUP BY e.player_id
     ),
     live_assists AS (
       SELECT e.assist_id AS player_id, COUNT(*)::int AS assists
         FROM match_events e
         JOIN month_games mg ON mg.id = e.game_id
        WHERE e.voided_at IS NULL AND e.assist_id IS NOT NULL
        GROUP BY e.assist_id
     ),
     filed_stats AS (
       SELECT s.player_id,
              COALESCE(SUM(s.goals), 0)::int   AS goals,
              COALESCE(SUM(s.assists), 0)::int AS assists
         FROM player_match_stats s
         JOIN month_games mg ON mg.id = s.game_id
        GROUP BY s.player_id
     ),
     contributions AS (
       SELECT COALESCE(fs.player_id, le.player_id, la.player_id) AS player_id,
              GREATEST(COALESCE(fs.goals, 0),   COALESCE(le.goals, 0))   AS goals,
              GREATEST(COALESCE(fs.assists, 0), COALESCE(la.assists, 0)) AS assists
         FROM filed_stats fs
         FULL JOIN live_events  le ON le.player_id = fs.player_id
         FULL JOIN live_assists la ON la.player_id = COALESCE(fs.player_id, le.player_id)
     ),
     -- The rating a player carried through the month: the mean of where each game left
     -- them. A single blow-out game moves this less than taking the end-of-month value.
     form AS (
       SELECT pr.player_id, AVG(pr.mu)::numeric AS mu
         FROM player_ratings pr
         JOIN month_games mg ON mg.id = pr.game_id
        GROUP BY pr.player_id
     )
     SELECT a.player_id, a.games,
            COALESCE(w.motm, 0)     AS motm,
            COALESCE(c.goals, 0)    AS goals,
            COALESCE(c.assists, 0)  AS assists,
            f.mu,
            u.display_name, p.jersey_name, p.preferred_position, u.avatar_url,
            d.name AS district_name
       FROM appearances a
       JOIN players p  ON p.id = a.player_id
       JOIN users u    ON u.id = p.user_id
       LEFT JOIN districts d ON d.id = p.home_district_id
       LEFT JOIN awards w        ON w.player_id = a.player_id
       LEFT JOIN contributions c ON c.player_id = a.player_id
       LEFT JOIN form f          ON f.player_id = a.player_id
      WHERE a.games >= $3
      ORDER BY COALESCE(w.motm, 0) DESC,
               f.mu DESC NULLS LAST,
               COALESCE(c.goals, 0) DESC,
               a.games DESC`,
    [monthStart, districtId, MIN_APPEARANCES]
  );

  return rows.map((r) => ({
    player: {
      id: r.player_id,
      name: r.jersey_name || r.display_name,
      avatarUrl: r.avatar_url ?? null,
      position: r.preferred_position,
      districtName: r.district_name,
    },
    stats: {
      games: r.games,
      motm: r.motm,
      goals: r.goals,
      assists: r.assists,
      rating: toPlayerRating(r.mu),
    },
  }));
}

/** First instant of the month `offset` months before now, in the league's timezone. */
async function monthStart(offset) {
  const { rows } = await query(
    `SELECT date_trunc('month', (now() AT TIME ZONE 'Asia/Beirut')) - make_interval(months => $1)
              AS start_local`,
    [offset]
  );
  const local = rows[0].start_local;
  const { rows: [conv] } = await query(
    `SELECT ($1::timestamp AT TIME ZONE 'Asia/Beirut') AS start_utc`, [local]
  );
  return { startUtc: conv.start_utc, local };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function label(localDate) {
  const d = new Date(localDate);
  // 'YYYY-MM', not an instant. The month is a local calendar fact; handing back a UTC
  // timestamp invites a client to render "July" for August in a negative offset.
  const monthIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return { month: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, monthIso };
}

/**
 * This month plus the last three, in the shape the leaderboard page renders.
 *
 * `player` is null for a month nobody qualified in -- a new league, or a quiet month.
 * That is a real answer and the UI says so, rather than inventing a winner.
 */
export async function getManOfTheMonth({ districtId = null, previousMonths = 3 } = {}) {
  const build = async (offset) => {
    const { startUtc, local } = await monthStart(offset);
    const standings = await standingsFor(startUtc, { districtId });
    const top = standings[0] ?? null;
    return {
      ...label(local),
      inProgress: offset === 0,
      player: top?.player ?? null,
      stats: top?.stats ?? null,
      // The runners-up, so the page can show why -- and so a disputed month has an answer.
      contenders: standings.slice(1, 4).map((s) => ({ ...s.player, ...s.stats })),
      reward: top
        ? { name: 'Any item from the Sports Fusion store', slug: 'motm-voucher', claimed: false }
        : null,
      qualified: standings.length,
      minAppearances: MIN_APPEARANCES,
    };
  };

  const current = await build(0);
  const previous = [];
  for (let i = 1; i <= previousMonths; i += 1) previous.push(await build(i));

  return { current, previous: previous.filter((m) => m.player) };
}
