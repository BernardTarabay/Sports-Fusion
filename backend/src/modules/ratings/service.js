// Rating engine: apply Glicko-2 to completed games, replay history, decay the inactive.
//
// THE REPLAY IS THE POINT OF THIS FILE.
//
// Every rating in the system is DERIVED. The irreplaceable inputs are:
//
//   * admin seeds and overrides  -- human judgement, in player_ratings
//   * match rosters              -- immutable, in team_players
//   * match results              -- append-only, in match_results
//   * attendance                 -- in registrations
//
// Given those, every rating can be recomputed from nothing. That is what made deferring
// this engine free: V1 recorded the inputs from the first game, so the first replay
// backfills the entire history of the league rather than starting from today.
//
// It also means the parameters can be retuned. If tau turns out to be too twitchy for
// weekly football, change it and replay -- the league's whole rating history is
// recomputed under the new setting, rather than having a discontinuity in the middle.

import { withTransaction, query } from '../../database/pool.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  rateMatch, decayPlayer, conservativeRating, isProvisional,
  DEFAULTS, ALGORITHM_VERSION, RATING_SYSTEM,
} from './glicko2.js';

/** Rows the replay is allowed to discard: everything this engine produced itself. */
const DERIVED_SOURCES = ['match_result', 'decay', 'recalculation'];
/** Rows the replay must never touch: human judgement. */
const ANCHOR_SOURCES = ['admin_seed', 'admin_override'];

function stateOf(row) {
  return {
    rating: Number(row.rating_mu ?? row.mu),
    deviation: Number(row.rating_sigma ?? row.sigma),
    volatility: Number(row.rating_volatility ?? row.volatility ?? DEFAULTS.volatility),
  };
}

/**
 * Load the two sides of a completed game, restricted to players who actually turned up.
 *
 * Someone on the team sheet who never arrived did not play, and rating them would be
 * inventing evidence. It also means the side they were on is correctly treated as having
 * played a player short.
 */
async function loadMatch(client, gameId) {
  const { rows: result } = await client.query(
    `SELECT mr.team_a_id, mr.team_b_id, mr.team_a_score, mr.team_b_score, mr.played_at
       FROM match_results mr
      WHERE mr.game_id = $1 AND mr.is_current`,
    [gameId]
  );
  if (result.length === 0) return null;
  const r = result[0];
  if (r.team_a_score == null || r.team_b_score == null) return null;

  const { rows: participants } = await client.query(
    `SELECT tp.player_id, tp.team_id
       FROM team_players tp
       JOIN registrations reg
         ON reg.game_id = tp.game_id AND reg.player_id = tp.player_id
      WHERE tp.game_id = $1
        AND reg.status = 'confirmed'
        AND reg.attendance IN ('attended', 'late')
      ORDER BY tp.player_id`,
    [gameId]
  );

  return {
    playedAt: r.played_at,
    teamAId: r.team_a_id,
    teamBId: r.team_b_id,
    scoreA: r.team_a_score,
    scoreB: r.team_b_score,
    participants,
  };
}

async function insertRatingRow(client, {
  playerId, gameId, next, previous, source, reason, effectiveAt, createdBy = null,
}) {
  await client.query(
    `INSERT INTO player_ratings
       (player_id, mu, sigma, volatility, previous_mu, previous_sigma,
        rating_system, source, game_id, reason, created_by, effective_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      playerId,
      next.rating.toFixed(3),
      next.deviation.toFixed(3),
      next.volatility.toFixed(6),
      previous?.rating?.toFixed(3) ?? null,
      previous?.deviation?.toFixed(3) ?? null,
      RATING_SYSTEM,
      source,
      gameId,
      reason ?? null,
      createdBy,
      effectiveAt,
    ]
  );
}

/**
 * Rate one completed game.
 *
 * Guarded: if this game already produced match_result rows, it is a no-op. The worker is
 * at-least-once, and rating the same match twice would double every movement.
 *
 * Note that this rates the game against ratings AS THEY ARE NOW, which is correct only
 * when games are rated in the order they were played. If history is corrected after the
 * fact -- an attendance fix, a score correction -- run a replay rather than trying to
 * patch one game in the middle, because every later game depended on the old numbers.
 */
export async function applyGameRatings(client, gameId, { options = {} } = {}) {
  const { rows: already } = await client.query(
    `SELECT 1 FROM player_ratings
      WHERE game_id = $1 AND source = 'match_result' LIMIT 1`,
    [gameId]
  );
  if (already.length > 0) return { skipped: 'already_rated' };

  const match = await loadMatch(client, gameId);
  if (!match) return { skipped: 'no_result' };

  const teamA = match.participants.filter((p) => p.team_id === match.teamAId);
  const teamB = match.participants.filter((p) => p.team_id === match.teamBId);

  if (teamA.length === 0 || teamB.length === 0) {
    return { skipped: 'a_side_had_nobody_present' };
  }

  const playerIds = match.participants.map((p) => p.player_id);
  const { rows: current } = await client.query(
    `SELECT id, rating_mu, rating_sigma, rating_volatility FROM players WHERE id = ANY($1)`,
    [playerIds]
  );
  const states = new Map(current.map((row) => [row.id, stateOf(row)]));

  const withState = (side) => side.map((p) => ({ id: p.player_id, ...states.get(p.player_id) }));

  const updates = rateMatch({
    teamA: { players: withState(teamA) },
    teamB: { players: withState(teamB) },
    scoreA: match.scoreA,
    scoreB: match.scoreB,
    options,
  });

  for (const [playerId, next] of updates) {
    await insertRatingRow(client, {
      playerId,
      gameId,
      next,
      previous: next.previous,
      source: 'match_result',
      reason: null,
      // Stamped with when the game was played, not when it was processed, so the ledger
      // stays in chronological order even if a result is entered days late.
      effectiveAt: match.playedAt,
    });
  }

  return { rated: updates.size, gameId };
}

/**
 * Recompute every derived rating from the immutable record.
 *
 * Deletes only what this engine produced. Admin seeds and overrides survive untouched and
 * are re-applied as anchors at their original point in the timeline, because a human
 * saying "George is an 8" is evidence the model cannot reconstruct.
 */
export async function replayRatings({ triggeredBy = null, options = {}, dryRun = false } = {}) {
  const started = Date.now();
  const parameters = { ...DEFAULTS, ...options };

  return withTransaction(async (client) => {
    const { rows: replayRows } = await client.query(
      `INSERT INTO rating_replays (rating_system, algorithm_version, parameters, triggered_by)
       VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
      [RATING_SYSTEM, ALGORITHM_VERSION, JSON.stringify(parameters), triggeredBy]
    );
    const replayId = replayRows[0].id;

    // Anchors: human judgement, in the order it was given.
    const { rows: anchors } = await client.query(
      `SELECT player_id, mu, sigma, volatility, source, effective_at
         FROM player_ratings
        WHERE source = ANY($1)
        ORDER BY effective_at, id`,
      [ANCHOR_SOURCES]
    );

    // Evidence: every current result, in the order the games were played.
    const { rows: games } = await client.query(
      `SELECT mr.game_id, mr.team_a_id, mr.team_b_id,
              mr.team_a_score, mr.team_b_score, mr.played_at
         FROM match_results mr
         JOIN games g ON g.id = mr.game_id
        WHERE mr.is_current
          AND mr.team_a_score IS NOT NULL
          AND mr.team_b_score IS NOT NULL
          AND g.status = 'completed'
        ORDER BY mr.played_at, mr.game_id`
    );

    const { rows: rosters } = await client.query(
      `SELECT tp.game_id, tp.player_id, tp.team_id
         FROM team_players tp
         JOIN registrations reg
           ON reg.game_id = tp.game_id AND reg.player_id = tp.player_id
        WHERE reg.status = 'confirmed'
          AND reg.attendance IN ('attended', 'late')
        ORDER BY tp.game_id, tp.player_id`
    );

    const rosterByGame = new Map();
    for (const row of rosters) {
      if (!rosterByGame.has(row.game_id)) rosterByGame.set(row.game_id, []);
      rosterByGame.get(row.game_id).push(row);
    }

    // Merge anchors and games into one chronological timeline. Anchors sort first at an
    // equal timestamp: a seed recorded the same moment as a game should apply before it.
    const timeline = [
      ...anchors.map((a) => ({ at: new Date(a.effective_at), kind: 'anchor', row: a })),
      ...games.map((g) => ({ at: new Date(g.played_at), kind: 'game', row: g })),
    ].sort((a, b) => (a.at - b.at) || (a.kind === 'anchor' ? -1 : 1));

    const states = new Map();
    const pending = [];
    let gamesReplayed = 0;

    const stateFor = (playerId) => states.get(playerId) ?? {
      rating: DEFAULTS.rating,
      deviation: DEFAULTS.deviation,
      volatility: DEFAULTS.volatility,
    };

    for (const entry of timeline) {
      if (entry.kind === 'anchor') {
        states.set(entry.row.player_id, {
          rating: Number(entry.row.mu),
          deviation: Number(entry.row.sigma),
          volatility: Number(entry.row.volatility ?? DEFAULTS.volatility),
        });
        continue;
      }

      const roster = rosterByGame.get(entry.row.game_id) ?? [];
      const teamA = roster.filter((p) => p.team_id === entry.row.team_a_id);
      const teamB = roster.filter((p) => p.team_id === entry.row.team_b_id);
      if (teamA.length === 0 || teamB.length === 0) continue;

      const withState = (side) => side.map((p) => ({ id: p.player_id, ...stateFor(p.player_id) }));

      const updates = rateMatch({
        teamA: { players: withState(teamA) },
        teamB: { players: withState(teamB) },
        scoreA: entry.row.team_a_score,
        scoreB: entry.row.team_b_score,
        options: parameters,
      });

      for (const [playerId, next] of updates) {
        states.set(playerId, {
          rating: next.rating, deviation: next.deviation, volatility: next.volatility,
        });
        pending.push({
          playerId, gameId: entry.row.game_id, next, previous: next.previous,
          effectiveAt: entry.row.played_at,
        });
      }
      gamesReplayed += 1;
    }

    if (dryRun) {
      await client.query(
        `UPDATE rating_replays
            SET finished_at = now(), games_replayed = $2, players_affected = $3,
                ratings_written = 0, anchors_used = $4, duration_ms = $5,
                error = 'dry run; nothing written'
          WHERE id = $1`,
        [replayId, gamesReplayed, states.size, anchors.length, Date.now() - started]
      );
      return {
        replayId, dryRun: true, gamesReplayed, playersAffected: states.size,
        anchorsUsed: anchors.length, ratingsWritten: 0,
        preview: [...states.entries()].slice(0, 20).map(([id, s]) => ({ playerId: id, ...s })),
      };
    }

    // Discard only what this engine produced. Human input is never deleted.
    const { rowCount: discarded } = await client.query(
      `DELETE FROM player_ratings WHERE source = ANY($1)`, [DERIVED_SOURCES]
    );

    for (const row of pending) {
      await insertRatingRow(client, { ...row, source: 'match_result', reason: null });
    }

    // The cache trigger only ever advances, so after rewriting history it has to be
    // reset explicitly from the recomputed state.
    for (const [playerId, state] of states) {
      await client.query(
        `UPDATE players
            SET rating_mu = $2, rating_sigma = $3, rating_volatility = $4,
                rating_system = $5, rating_updated_at = now()
          WHERE id = $1`,
        [
          playerId, state.rating.toFixed(3), state.deviation.toFixed(3),
          state.volatility.toFixed(6), RATING_SYSTEM,
        ]
      );
    }

    await client.query(
      `UPDATE rating_replays
          SET finished_at = now(), games_replayed = $2, players_affected = $3,
              ratings_written = $4, anchors_used = $5, duration_ms = $6
        WHERE id = $1`,
      [replayId, gamesReplayed, states.size, pending.length, anchors.length, Date.now() - started]
    );

    logger.info(
      { replayId, gamesReplayed, playersAffected: states.size, discarded, written: pending.length },
      'rating replay complete'
    );

    return {
      replayId,
      dryRun: false,
      gamesReplayed,
      playersAffected: states.size,
      ratingsWritten: pending.length,
      anchorsUsed: anchors.length,
      discarded,
      durationMs: Date.now() - started,
    };
  });
}

/**
 * Widen the deviation of players who have not played recently.
 *
 * Run as a periodic sweep. Someone last seen in March is not still known to within 40
 * points in September, and pretending otherwise makes the balancer overconfident about a
 * player whose form nobody has observed in six months.
 */
export async function decayInactiveRatings({ inactiveDays = 30, limit = 500 } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT p.id, p.rating_mu, p.rating_sigma, p.rating_volatility
         FROM players p
        WHERE p.status = 'active'
          AND p.rating_sigma < $2
          AND NOT EXISTS (
            SELECT 1 FROM registrations r
             JOIN games g ON g.id = r.game_id
            WHERE r.player_id = p.id
              AND r.attendance IN ('attended', 'late')
              AND g.kickoff_at > now() - ($1 || ' days')::interval
          )
          AND (
            p.rating_updated_at IS NULL
            OR p.rating_updated_at < now() - ($1 || ' days')::interval
          )
        ORDER BY p.rating_updated_at NULLS FIRST
        LIMIT $3`,
      [inactiveDays, DEFAULTS.maxDeviation, limit]
    );

    let decayed = 0;
    for (const row of rows) {
      const previous = stateOf(row);
      const next = decayPlayer(previous);
      if (next.deviation - previous.deviation < 0.01) continue;

      await insertRatingRow(client, {
        playerId: row.id,
        gameId: null,
        next,
        previous,
        source: 'decay',
        reason: `no games in ${inactiveDays} days`,
        effectiveAt: new Date(),
      });
      decayed += 1;
    }

    if (decayed > 0) logger.info({ decayed, inactiveDays }, 'inactive ratings decayed');
    return decayed;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Ranked players.
 *
 * Ordered by the conservative estimate, not the raw rating. A newcomer on 1600 +/- 350
 * has not proved anything; a regular on 1500 +/- 40 has. Ranking on the raw number would
 * put whoever played best last Friday at the top of the league, which is a scoreboard,
 * not a ranking.
 */
export async function getLeaderboard({
  districtId, limit = 50, offset = 0, minGames = 5, includeProvisional = false,
} = {}) {
  const params = [minGames, limit, offset];
  const conditions = [`p.status = 'active'`];

  if (districtId) {
    params.push(districtId);
    conditions.push(`p.home_district_id = $${params.length}`);
  }
  if (!includeProvisional) conditions.push(`p.rating_sigma <= 150`);

  const { rows } = await query(
    `WITH played AS (
       SELECT r.player_id, count(*)::int AS games
         FROM registrations r
        WHERE r.attendance IN ('attended', 'late')
        GROUP BY r.player_id
     )
     SELECT p.id, p.rating_mu, p.rating_sigma, p.rating_volatility,
            COALESCE(played.games, 0) AS games,
            u.display_name, p.jersey_name, d.name AS district_name,
            (SELECT count(*)::int FROM match_awards ma
              WHERE ma.player_id = p.id AND ma.award_type = 'motm') AS motm
       FROM players p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN districts d ON d.id = p.home_district_id
       LEFT JOIN played ON played.player_id = p.id
      WHERE ${conditions.join(' AND ')}
        AND COALESCE(played.games, 0) >= $1
      ORDER BY (p.rating_mu - 2 * p.rating_sigma) DESC
      LIMIT $2 OFFSET $3`,
    params
  );

  return rows.map((row, i) => {
    const state = stateOf(row);
    return {
      rank: offset + i + 1,
      playerId: row.id,
      name: row.jersey_name || row.display_name,
      districtName: row.district_name,
      rating: Math.round(state.rating),
      deviation: Math.round(state.deviation),
      conservative: Math.round(conservativeRating(state)),
      isProvisional: isProvisional(state),
      games: row.games,
      motm: row.motm,
    };
  });
}

/** A player's rating over time, for the profile chart and for explaining a movement. */
export async function getPlayerRatingTimeline(playerId, { limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT pr.mu, pr.sigma, pr.volatility, pr.previous_mu, pr.source, pr.reason,
            pr.effective_at, pr.game_id,
            g.kickoff_at, d.name AS district_name,
            mr.team_a_score, mr.team_b_score
       FROM player_ratings pr
       LEFT JOIN games g ON g.id = pr.game_id
       LEFT JOIN districts d ON d.id = g.district_id
       LEFT JOIN match_results mr ON mr.game_id = pr.game_id AND mr.is_current
      WHERE pr.player_id = $1
      ORDER BY pr.effective_at DESC, pr.id DESC
      LIMIT $2`,
    [playerId, limit]
  );

  return rows.map((r) => ({
    rating: Math.round(Number(r.mu)),
    deviation: Math.round(Number(r.sigma)),
    volatility: r.volatility == null ? null : Number(r.volatility),
    change: r.previous_mu == null ? null : Math.round(Number(r.mu) - Number(r.previous_mu)),
    source: r.source,
    reason: r.reason,
    gameId: r.game_id,
    at: r.effective_at,
    districtName: r.district_name,
    score: r.team_a_score == null ? null : { a: r.team_a_score, b: r.team_b_score },
  }));
}

export async function getReplayHistory({ limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT rr.id, rr.rating_system, rr.algorithm_version, rr.parameters,
            rr.games_replayed, rr.players_affected, rr.ratings_written, rr.anchors_used,
            rr.duration_ms, rr.started_at, rr.finished_at, rr.error,
            u.display_name AS triggered_by
       FROM rating_replays rr
       LEFT JOIN users u ON u.id = rr.triggered_by
      ORDER BY rr.started_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Rate a single game outside the worker, for admin repair after a manual fix. */
export async function rateGame({ gameId, options = {} }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT status FROM games WHERE id = $1', [gameId]);
    if (rows.length === 0) throw new NotFoundError('Game');
    if (rows[0].status !== 'completed') {
      throw new ConflictError('That game has no recorded result', 'GAME_NOT_COMPLETED');
    }
    return applyGameRatings(client, gameId, { options });
  });
}
