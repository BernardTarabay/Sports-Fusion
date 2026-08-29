// Player profiles, preferences, and admin rating seeding.

import { query, withTransaction } from '../../database/pool.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';

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
            (SELECT COALESCE(SUM(pms.goals), 0)::int FROM player_match_stats pms
              WHERE pms.player_id = p.id) AS goals,
            (SELECT COALESCE(SUM(pms.assists), 0)::int FROM player_match_stats pms
              WHERE pms.player_id = p.id) AS assists
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
      attendanceRate: r.attendance_rate == null ? null : Number(r.attendance_rate),
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
    `SELECT g.id, g.kickoff_at, g.status, d.name AS district_name,
            r.status AS registration_status, r.attendance,
            gt.color AS team_color,
            mr.team_a_score, mr.team_b_score
       FROM registrations r
       JOIN games g ON g.id = r.game_id
       JOIN districts d ON d.id = g.district_id
       LEFT JOIN team_players tp ON tp.game_id = g.id AND tp.player_id = r.player_id
       LEFT JOIN game_teams gt ON gt.id = tp.team_id
       LEFT JOIN match_results mr ON mr.game_id = g.id AND mr.is_current
      WHERE r.player_id = $1
      ORDER BY g.kickoff_at DESC
      LIMIT $2`,
    [playerId, limit]
  );
  return rows.map((r) => ({
    gameId: r.id,
    kickoffAt: r.kickoff_at,
    status: r.status,
    districtName: r.district_name,
    registrationStatus: r.registration_status,
    attendance: r.attendance,
    teamColor: r.team_color,
    score: r.team_a_score == null ? null : { a: r.team_a_score, b: r.team_b_score },
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
