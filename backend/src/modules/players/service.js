// Player profiles, preferences, and admin rating seeding.

import { query, withTransaction } from '../../database/pool.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { shapeResult, RESULT_COLUMNS, RESULT_JOINS } from '../games/service.js';

// `client` lets this run on an open transaction; see the note in games/service.js.
export async function getProfile(playerId, client) {
  const run = client ?? { query };
  const { rows } = await run.query(
    `SELECT p.id, p.user_id, p.jersey_name, p.preferred_position, p.secondary_positions,
            p.preferred_foot, p.is_goalkeeper, p.home_district_id, p.status,
            p.rating_mu, p.rating_sigma, p.rating_system, p.rating_updated_at,
            p.points_balance, p.games_registered, p.games_attended, p.joined_at, p.joined_via,
            u.display_name, u.avatar_url,
            d.name AS district_name,
            rel.registrations, rel.attended, rel.no_shows, rel.late_cancellations,
            rel.attendance_rate,
            (SELECT count(*)::int FROM match_awards ma
              WHERE ma.player_id = p.id AND ma.award_type = 'motm') AS motm_count,
            -- Goals live in TWO places and only one is normally filled in.
            -- player_match_stats is written when an admin files a result with a
            -- per-player stats array; nothing in the app does that. Goals are tapped in
            -- on the matchday screen and land in match_events. Reading only the first
            -- meant every profile showed 0 goals for a player who had scored all season.
            --
            -- GREATEST, never the sum: they are two records of the same fact, so adding
            -- them would double-count any game that has both.
            GREATEST(
              (SELECT COALESCE(SUM(pms.goals), 0)::int FROM player_match_stats pms
                WHERE pms.player_id = p.id),
              (SELECT count(*)::int FROM match_events e
                WHERE e.player_id = p.id AND e.type = 'goal' AND e.voided_at IS NULL)
            ) AS goals,
            GREATEST(
              (SELECT COALESCE(SUM(pms.assists), 0)::int FROM player_match_stats pms
                WHERE pms.player_id = p.id),
              (SELECT count(*)::int FROM match_events e
                WHERE e.assist_id = p.id AND e.voided_at IS NULL)
            ) AS assists
       FROM players p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN districts d ON d.id = p.home_district_id
       LEFT JOIN player_reliability rel ON rel.player_id = p.id
      WHERE p.id = $1`,
    [playerId]
  );
  if (rows.length === 0) throw new NotFoundError('Player');

  const r = rows[0];
  return {
    id: r.id,
    displayName: r.display_name,
    jerseyName: r.jersey_name,
    avatarUrl: r.avatar_url,
    district: r.home_district_id ? { id: r.home_district_id, name: r.district_name } : null,
    preferredPosition: r.preferred_position,
    secondaryPositions: r.secondary_positions ?? [],
    preferredFoot: r.preferred_foot,
    isGoalkeeper: r.is_goalkeeper,
    status: r.status,
    joinedAt: r.joined_at,
    joinedVia: r.joined_via,
    rating: {
      mu: Number(r.rating_mu),
      sigma: Number(r.rating_sigma),
      system: r.rating_system,
      updatedAt: r.rating_updated_at,
      // A high sigma means the system does not yet understand this player. Surfacing it
      // stops a provisional number being read as a settled judgement.
      isProvisional: Number(r.rating_sigma) > 150,
    },
    career: {
      registrations: Number(r.registrations ?? 0),
      attended: Number(r.attended ?? 0),
      noShows: Number(r.no_shows ?? 0),
      lateCancellations: Number(r.late_cancellations ?? 0),
      // A FRACTION, not a percentage. The view computes 0-100; every other rate this API
      // returns -- a district's occupancy, the reliability board -- is 0-1, and the
      // client's percent() multiplies by 100. Sending 75 there renders "7500%".
      attendanceRate: r.attendance_rate == null ? null : Number(r.attendance_rate) / 100,
      motm: r.motm_count,
      goals: r.goals,
      assists: r.assists,
    },
    pointsBalance: r.points_balance,
  };
}

export async function getProfileByUserId(userId) {
  const { rows } = await query('SELECT id FROM players WHERE user_id = $1', [userId]);
  if (rows.length === 0) throw new NotFoundError('Player profile');
  return getProfile(rows[0].id);
}

export async function playerIdForUser(userId) {
  const { rows } = await query('SELECT id FROM players WHERE user_id = $1', [userId]);
  if (rows.length === 0) throw new NotFoundError('Player profile');
  return rows[0].id;
}

/**
 * The district a player answers to, for the authorisation guard.
 *
 * Their home district. Null when they have not set one, which requireDistrictAccess
 * treats as "no district admin may touch this" -- correct, because a player with no
 * district is nobody's local responsibility.
 */
export async function districtOfPlayer(playerId) {
  const { rows } = await query('SELECT home_district_id FROM players WHERE id = $1', [playerId]);
  return rows[0]?.home_district_id ?? null;
}

export async function updatePreferences({ playerId, patch }) {
  const allowed = {
    jersey_name: patch.jerseyName,
    preferred_position: patch.preferredPosition,
    secondary_positions: patch.secondaryPositions,
    preferred_foot: patch.preferredFoot,
    is_goalkeeper: patch.isGoalkeeper,
    home_district_id: patch.homeDistrictId,
    shirt_size: patch.shirtSize,
  };

  const sets = [];
  const params = [playerId];
  for (const [column, value] of Object.entries(allowed)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return getProfile(playerId);

  await query(`UPDATE players SET ${sets.join(', ')} WHERE id = $1`, params);
  return getProfile(playerId);
}

/**
 * Admin seeds or corrects a rating.
 *
 * Writes a ledger row; the trigger updates the cache. Never UPDATEs players.rating_mu
 * directly, because the ledger is what a future Glicko backfill replays.
 */
export async function setRating({ playerId, mu, sigma, reason, actorUserId, source }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT rating_mu, rating_sigma FROM players WHERE id = $1', [playerId]
    );
    if (rows.length === 0) throw new NotFoundError('Player');

    // The first rating an admin sets is a seed; every later one corrects a rating the
    // system already held. The Glicko backfill will treat those differently -- a seed is
    // a starting prior, an override is evidence that the model was wrong.
    const { rows: prior } = await client.query(
      'SELECT 1 FROM player_ratings WHERE player_id = $1 LIMIT 1', [playerId]
    );
    const effectiveSource = source ?? (prior.length === 0 ? 'admin_seed' : 'admin_override');

    await client.query(
      `INSERT INTO player_ratings
         (player_id, mu, sigma, previous_mu, previous_sigma, source, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [playerId, mu, sigma, rows[0].rating_mu, rows[0].rating_sigma, effectiveSource, reason ?? null, actorUserId]
    );

    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, before, after, reason)
       VALUES ($1, 'set_rating', 'player', $2, $3::jsonb, $4::jsonb, $5)`,
      [
        actorUserId, playerId,
        JSON.stringify({ mu: Number(rows[0].rating_mu), sigma: Number(rows[0].rating_sigma) }),
        JSON.stringify({ mu, sigma }),
        reason ?? null,
      ]
    );

    return getProfile(playerId, client);
  });
}

export async function getRatingHistory(playerId, limit = 50) {
  const { rows } = await query(
    `SELECT id, mu, sigma, previous_mu, previous_sigma, source, reason, game_id, effective_at
       FROM player_ratings WHERE player_id = $1
      ORDER BY effective_at DESC LIMIT $2`,
    [playerId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    mu: Number(r.mu),
    sigma: Number(r.sigma),
    previousMu: r.previous_mu == null ? null : Number(r.previous_mu),
    source: r.source,
    reason: r.reason,
    gameId: r.game_id,
    effectiveAt: r.effective_at,
  }));
}

export async function getGameHistory(playerId, limit = 25) {
  const { rows } = await query(
    `SELECT g.id, g.kickoff_at, g.status, g.capacity, g.confirmed_count,
            g.public_slug, g.title,
            d.name AS district_name,
            v.name AS venue_name,
            r.status AS registration_status, r.attendance,
            gt.color AS team_color,
            -- Did THIS player take the award in THIS game? The match timeline draws a
            -- badge for it and had no way of knowing.
            EXISTS (SELECT 1 FROM match_awards ma
                     WHERE ma.game_id = g.id AND ma.player_id = r.player_id
                       AND ma.award_type = 'motm') AS won_motm,
            ${RESULT_COLUMNS}
       FROM registrations r
       JOIN games g ON g.id = r.game_id
       JOIN districts d ON d.id = g.district_id
       LEFT JOIN venues v ON v.id = g.venue_id
       LEFT JOIN team_players tp ON tp.game_id = g.id AND tp.player_id = r.player_id
       LEFT JOIN game_teams gt ON gt.id = tp.team_id
       ${RESULT_JOINS}
      WHERE r.player_id = $1
      ORDER BY g.kickoff_at DESC
      LIMIT $2`,
    [playerId, limit]
  );
  return rows.map((r) => ({
    // `id` as well as `gameId`: the history renders with GameCard, which is the same
    // component the fixture list uses and which keys and links on `game.id`.
    id: r.id,
    gameId: r.id,
    kickoffAt: r.kickoff_at,
    status: r.status,
    title: r.title,
    slug: r.public_slug,
    capacity: r.capacity,
    confirmedCount: r.confirmed_count,
    districtName: r.district_name,
    venue: r.venue_name ? { name: r.venue_name } : null,
    registrationStatus: r.registration_status,
    attendance: r.attendance,
    teamColor: r.team_color,
    motm: r.won_motm,
    // The same `result` object every other screen reads, rather than `{ a, b }` --
    // which needed a lookup to mean anything and which nothing in the app understood.
    result: shapeResult(r),
  }));
}

/** Declare a preference to play with, or avoid, another player. */
export async function setRelationship({ playerId, otherPlayerId, kind, weight = 1 }) {
  if (playerId === otherPlayerId) {
    throw new ConflictError('You cannot set a preference about yourself', 'SELF_RELATIONSHIP');
  }
  const { rows } = await query('SELECT id FROM players WHERE id = $1', [otherPlayerId]);
  if (rows.length === 0) throw new NotFoundError('Player');

  await query(
    `INSERT INTO player_relationships (player_id, other_player_id, kind, weight, origin)
     VALUES ($1,$2,$3,$4,'declared')
     ON CONFLICT (player_id, other_player_id, kind)
     DO UPDATE SET weight = EXCLUDED.weight, origin = 'declared', updated_at = now()`,
    [playerId, otherPlayerId, kind, weight]
  );
  return { playerId, otherPlayerId, kind, weight };
}

export async function removeRelationship({ playerId, otherPlayerId, kind }) {
  await query(
    `DELETE FROM player_relationships
      WHERE player_id = $1 AND other_player_id = $2 AND kind = $3`,
    [playerId, otherPlayerId, kind]
  );
  return { removed: true };
}

/**
 * Create a player the admin knows about but who has never signed in.
 *
 * This is how a real community gets into the database. The admin has 4,000 people in
 * WhatsApp groups; asking each to register before the first game means there is no first
 * game. users.password_hash is nullable precisely for this -- the account exists, the
 * login does not yet, and the player claims it later with their phone number.
 *
 * Idempotent on phone: adding the same number twice returns the existing player rather
 * than failing, because an admin typing a roster from memory will repeat someone.
 */
export async function createPlayerAsAdmin({
  displayName, phone, email, districtId, preferredPosition, isGoalkeeper = false,
  joinedVia = 'admin_created', actorUserId,
}) {
  if (!phone && !email) {
    throw new ValidationError('A phone number or an email address is required');
  }

  return withTransaction(async (client) => {
    const { rows: found } = await client.query(
      `SELECT p.id
         FROM players p JOIN users u ON u.id = p.user_id
        WHERE ($1::text  IS NOT NULL AND u.phone_e164 = $1)
           OR ($2::citext IS NOT NULL AND u.email = $2)`,
      [phone ?? null, email ?? null]
    );
    if (found[0]) return { player: await getProfile(found[0].id, client), created: false };

    const { rows: [user] } = await client.query(
      `INSERT INTO users (display_name, phone_e164, email) VALUES ($1, $2, $3) RETURNING id`,
      [displayName, phone ?? null, email ?? null]
    );
    const { rows: [player] } = await client.query(
      `INSERT INTO players (user_id, home_district_id, jersey_name, preferred_position,
                            is_goalkeeper, joined_via)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [user.id, districtId ?? null, displayName, preferredPosition ?? null, isGoalkeeper, joinedVia]
    );
    await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'player')`, [user.id]);
    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, after)
       VALUES ($1, 'player.create', 'player', $2, $3)`,
      [actorUserId ?? null, player.id, JSON.stringify({ displayName, joinedVia })]
    );

    return { player: await getProfile(player.id, client), created: true };
  });
}

/**
 * Remove a player.
 *
 * Same rule as deleting a game: a player who has never played is a mistyped entry and
 * should vanish; a player whose results are in the rating ledger is part of everyone
 * else's history, because their rating fed into the balance of every team they were on.
 * Those are deactivated instead -- they stop appearing in team generation and rosters
 * while the record of what happened stays intact.
 */
export async function deletePlayer({ playerId, actorUserId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT p.id, p.user_id, u.display_name FROM players p
       JOIN users u ON u.id = p.user_id WHERE p.id = $1 FOR UPDATE`,
      [playerId]
    );
    if (rows.length === 0) throw new NotFoundError('Player');
    const player = rows[0];

    const { rows: [impact] } = await client.query(
      `SELECT (SELECT COUNT(*) FROM player_ratings WHERE player_id = $1)::int      AS ratings,
              (SELECT COUNT(*) FROM player_match_stats WHERE player_id = $1)::int  AS stats,
              (SELECT COUNT(*) FROM registrations
                WHERE player_id = $1 AND attendance = 'attended')::int             AS appearances`,
      [playerId]
    );
    const played = impact.ratings > 0 || impact.stats > 0 || impact.appearances > 0;

    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, before, reason)
       VALUES ($1, $2, 'player', $3, $4, $5)`,
      [actorUserId ?? null, played ? 'player.deactivate' : 'player.delete', playerId,
        JSON.stringify({ displayName: player.display_name, ...impact }),
        played ? 'has match history; deactivated instead of deleted' : 'never played']
    );

    if (played) {
      await client.query(`UPDATE players SET status = 'inactive' WHERE id = $1`, [playerId]);
      return { deleted: false, deactivated: true, id: playerId, reason: 'HAS_HISTORY' };
    }

    // Deleting the user cascades to the player row, the roles and the sessions. Leaving a
    // login behind whose player is gone is worse than either outcome.
    await client.query(`DELETE FROM users WHERE id = $1`, [player.user_id]);
    return { deleted: true, deactivated: false, id: playerId };
  });
}

/**
 * Everything the player profile page renders, in one request.
 *
 * WHY THIS IS ONE FUNCTION AND NOT FOUR
 *
 * The page destructured `{ player, history, ratingHistory, achievements }` from the
 * response and the endpoint answered with `{ player }` alone -- so the match timeline,
 * the rating chart and the achievements tab were all rendering `undefined`. And the
 * `player` it did send was nested (`rating.mu`, `career.goals`) while the page reads it
 * flat (`ratingMu`, `goals`), so the hero showed "?" for a name it had been given and a
 * dash for every number. The profile was, in effect, a blank template.
 *
 * The flat shape is the one the components take, and they are the reason it exists: a
 * PlayerCard on a leaderboard row and a PlayerHero on a profile take the same object.
 */
export async function getPlayerPage(playerId) {
  const [profile, history, ratingHistory, achievements, extras] = await Promise.all([
    getProfile(playerId),
    getGameHistory(playerId, 25),
    getRatingHistory(playerId, 60),
    listAchievements(playerId),
    playerExtras(playerId),
  ]);

  return {
    player: {
      id: profile.id,
      // `name` is what every component reads. The jersey name wins where there is one:
      // it is what goes on the team sheet and what people call each other.
      name: profile.jerseyName || profile.displayName,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      position: profile.preferredPosition,
      secondaryPositions: profile.secondaryPositions,
      preferredFoot: profile.preferredFoot,
      isGoalkeeper: profile.isGoalkeeper,
      districtId: profile.district?.id ?? null,
      districtName: profile.district?.name ?? null,
      status: profile.status,
      joinedAt: profile.joinedAt,

      ratingMu: profile.rating.mu,
      ratingSigma: profile.rating.sigma,
      isProvisional: profile.rating.isProvisional,
      rank: extras.rank,

      games: profile.career.registrations,
      attended: profile.career.attended,
      noShows: profile.career.noShows,
      lateCancellations: profile.career.lateCancellations,
      attendanceRate: profile.career.attendanceRate,
      goals: profile.career.goals,
      assists: profile.career.assists,
      motm: profile.career.motm,
      pointsBalance: profile.pointsBalance,

      form: extras.form,
      streak: extras.streak,

      // Kept so a caller that wants the grouped view still has it. The page reads flat.
      rating: profile.rating,
      career: profile.career,
    },
    history,
    // Oldest first. getRatingHistory answers newest-first, which is right for a list of
    // changes and backwards for a chart that reads left to right.
    ratingHistory: [...ratingHistory].reverse(),
    achievements,
  };
}

/** The achievement catalogue, annotated with what this player has earned. */
async function listAchievements(playerId) {
  const { rows } = await query(
    `SELECT a.slug, a.name, a.description, a.icon, a.category, a.points_award, pa.earned_at
       FROM achievements a
       LEFT JOIN player_achievements pa
         ON pa.achievement_id = a.id AND pa.player_id = $1
      WHERE a.is_active
      ORDER BY pa.earned_at DESC NULLS LAST, a.name`,
    [playerId]
  );
  return rows.map((a) => ({
    slug: a.slug,
    name: a.name,
    description: a.description,
    icon: a.icon,
    tier: a.category,
    pointsAward: a.points_award,
    earnedAt: a.earned_at,
  }));
}

/**
 * Rank, recent form, and the attendance streak.
 *
 * One query rather than three: they are three window functions over the same two tables
 * and the profile page is a single screen.
 */
async function playerExtras(playerId) {
  const { rows } = await query(
    `WITH ranked AS (
       -- The same ordering the overall leaderboard uses: conservative rating, and
       -- provisional players are not ranked at all rather than ranked badly.
       SELECT p.id,
              rank() OVER (ORDER BY (p.rating_mu - 2 * p.rating_sigma) DESC) AS rank
         FROM players p
        WHERE p.status = 'active' AND p.rating_sigma <= 150
     ),
     recent AS (
       SELECT pr.mu,
              row_number() OVER (ORDER BY pr.effective_at DESC) AS n
         FROM player_ratings pr
        WHERE pr.player_id = $1 AND pr.source = 'match_result'
     ),
     appearances AS (
       -- Newest first, so a run of 'attended' at the top is the current streak.
       SELECT r.attendance,
              row_number() OVER (ORDER BY g.kickoff_at DESC) AS n
         FROM registrations r
         JOIN games g ON g.id = r.game_id
        WHERE r.player_id = $1 AND g.status = 'completed' AND r.status <> 'cancelled'
     ),
     broke AS (
       SELECT COALESCE(min(n), 2147483647) AS at
         FROM appearances
        WHERE attendance IS DISTINCT FROM 'attended'
     )
     SELECT (SELECT rank FROM ranked WHERE id = $1)                       AS rank,
            (SELECT array_agg(mu ORDER BY n DESC) FROM recent WHERE n <= 5) AS form,
            (SELECT count(*)::int FROM appearances, broke
              WHERE appearances.n < broke.at)                             AS streak`,
    [playerId]
  );
  const r = rows[0] ?? {};

  return {
    rank: r.rank == null ? null : Number(r.rank),
    // The 0-10 scale the FormStrip draws, oldest to newest.
    form: (r.form ?? []).map((mu) => toPlayerScale(Number(mu))),
    streak: r.streak ?? 0,
  };
}

/**
 * Internal rating to the 0-10 number players understand.
 *
 * Mirrors the frontend's toPlayerRating and the awards module's copy of it: 1500 sits at
 * 6.5, and roughly one point per 150 rating.
 */
const toPlayerScale = (mu) =>
  Math.max(1, Math.min(10, Math.round((6.5 + (mu - 1500) / 150) * 10) / 10));
