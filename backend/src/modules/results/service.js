// Match results, attendance, awards, and peer ratings.
//
// This module is the one the admin uses standing on the touchline with 21 people waiting
// to leave. The whole post-match flow is a score line and three taps:
//
//     Black 6 - 4 White
//     [ MOTM ]  [ Best ]  [ Worst ]
//
// Everything else is optional. Attendance defaults to "everyone who was confirmed turned
// up", because marking 22 people present is data entry that will not happen, whereas
// flagging the two who did not is a five-second job.
//
// The result is what unblocks everything downstream: it publishes GameCompleted, which
// awards points and records pair history, and it is the (rosters, outcome, date) tuple
// that Glicko-2 will replay when the rating engine lands.

import { withTransaction, query } from '../../database/pool.js';
import { publish, EventTypes } from '../../lib/events.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';

const ATTENDANCE_VALUES = ['attended', 'late', 'no_show'];
const AWARD_TYPES = ['motm', 'best_player', 'worst_player', 'best_goalkeeper', 'most_improved', 'best_goal'];

async function loadGameForResult(client, gameId) {
  const { rows } = await client.query(
    `SELECT id, district_id, status, kickoff_at, capacity, team_count
       FROM games WHERE id = $1 FOR UPDATE`,
    [gameId]
  );
  if (rows.length === 0) throw new NotFoundError('Game');
  return rows[0];
}

async function loadTeams(client, gameId) {
  const { rows } = await client.query(
    `SELECT id, color FROM game_teams WHERE game_id = $1 ORDER BY color`, [gameId]
  );
  return rows;
}

/**
 * Apply attendance.
 *
 * `entries` lists only the exceptions. Everyone else who was confirmed is marked
 * 'attended', because that is true for the overwhelming majority and the alternative is
 * an admin tapping through 22 names.
 */
async function applyAttendance(client, gameId, entries = []) {
  const byPlayer = new Map();
  for (const entry of entries) {
    if (!ATTENDANCE_VALUES.includes(entry.status)) {
      throw new ValidationError(`Unknown attendance value: ${entry.status}`);
    }
    byPlayer.set(entry.playerId, entry.status);
  }

  // Default first, then override the exceptions, so a re-submission cannot leave a
  // previously flagged no-show silently marked present.
  await client.query(
    `UPDATE registrations SET attendance = 'attended'
      WHERE game_id = $1 AND status = 'confirmed' AND attendance IS DISTINCT FROM 'attended'`,
    [gameId]
  );

  for (const [playerId, status] of byPlayer) {
    const { rowCount } = await client.query(
      `UPDATE registrations SET attendance = $3
        WHERE game_id = $1 AND player_id = $2 AND status = 'confirmed'`,
      [gameId, playerId, status]
    );
    if (rowCount === 0) {
      throw new ConflictError(
        'That player was not confirmed for this game', 'PLAYER_NOT_IN_GAME', { playerId }
      );
    }
  }

  const { rows } = await client.query(
    `SELECT attendance, count(*)::int AS n FROM registrations
      WHERE game_id = $1 AND status = 'confirmed' GROUP BY attendance`,
    [gameId]
  );
  return Object.fromEntries(rows.map((r) => [r.attendance ?? 'unknown', r.n]));
}

/**
 * Replace this game's awards.
 *
 * NOT MENTIONING AWARDS IS NOT THE SAME AS CLEARING THEM.
 *
 * `awards` used to default to `[]`, and the submit schema defaulted it to `[]` as well,
 * so filing a result with no awards field DELETED every award on the game. The man of the
 * match is normally set on the matchday screen, at the final whistle, from the pitch --
 * and filing the result is the very next thing an admin does. So the ordinary workflow
 * was: award it, file the result, watch it silently disappear. Nothing reported an error;
 * the award simply stopped existing, and the result announcement then had no MOTM in it.
 *
 * Undefined means "leave them alone". An explicit empty array still clears them, which is
 * how an admin removes an award they gave by mistake.
 */
async function applyAwards(client, gameId, awards, actorUserId) {
  if (awards === undefined || awards === null) return;

  await client.query('DELETE FROM match_awards WHERE game_id = $1', [gameId]);

  for (const awardRow of awards) {
    if (!AWARD_TYPES.includes(awardRow.awardType)) {
      throw new ValidationError(`Unknown award type: ${awardRow.awardType}`);
    }
    const { rowCount } = await client.query(
      `INSERT INTO match_awards (game_id, player_id, award_type, note, awarded_by)
       SELECT $1, $2, $3, $4, $5
        WHERE EXISTS (
          SELECT 1 FROM registrations r
           WHERE r.game_id = $1 AND r.player_id = $2 AND r.status = 'confirmed'
        )`,
      [gameId, awardRow.playerId, awardRow.awardType, awardRow.note ?? null, actorUserId]
    );
    if (rowCount === 0) {
      throw new ConflictError(
        'Cannot award a player who was not confirmed for this game',
        'PLAYER_NOT_IN_GAME',
        { playerId: awardRow.playerId }
      );
    }
  }
}

async function applyStats(client, gameId, stats = [], actorUserId) {
  for (const stat of stats) {
    await client.query(
      `INSERT INTO player_match_stats
         (game_id, player_id, team_id, goals, assists, own_goals, saves, clean_sheet,
          minutes, position_played, recorded_by)
       SELECT $1, $2, tp.team_id, $3, $4, $5, $6, $7, $8, $9, $10
         FROM team_players tp
        WHERE tp.game_id = $1 AND tp.player_id = $2
       ON CONFLICT (game_id, player_id) DO UPDATE
         SET goals = EXCLUDED.goals, assists = EXCLUDED.assists,
             own_goals = EXCLUDED.own_goals, saves = EXCLUDED.saves,
             clean_sheet = EXCLUDED.clean_sheet, minutes = EXCLUDED.minutes,
             position_played = EXCLUDED.position_played`,
      [
        gameId, stat.playerId, stat.goals ?? 0, stat.assists ?? 0, stat.ownGoals ?? 0,
        stat.saves ?? 0, stat.cleanSheet ?? false, stat.minutes ?? null,
        stat.positionPlayed ?? null, actorUserId,
      ]
    );
  }
}

/** Validate that the submitted scores cover exactly the teams of this game. */
function normaliseScores(scores, teams) {
  if (!Array.isArray(scores) || scores.length !== teams.length) {
    throw new ValidationError(
      `Expected a score for each of the ${teams.length} teams, got ${scores?.length ?? 0}`
    );
  }

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const byTeam = {};

  for (const entry of scores) {
    const team = teamById.get(entry.teamId);
    if (!team) throw new ConflictError('That team is not part of this game', 'INVALID_TEAM');
    if (byTeam[team.color] !== undefined) {
      throw new ValidationError(`Two scores submitted for ${team.color}`);
    }
    byTeam[team.color] = entry.score;
  }

  return byTeam;
}

/**
 * Record the result of a game.
 *
 * Idempotent-ish by refusal: submitting twice is a conflict, not a silent overwrite,
 * because a second submission is almost always a double tap rather than an intent to
 * change the score. Use correctResult() to change one deliberately.
 */
export async function submitResult({
  // `awards` has no default on purpose -- see applyAwards. Undefined leaves whatever the
  // matchday screen already recorded in place; [] deliberately clears it.
  gameId, scores, awards, attendance = [], stats = [], actorUserId,
}) {
  return withTransaction(async (client) => {
    const game = await loadGameForResult(client, gameId);

    if (game.status === 'cancelled') throw new ConflictError('That game was cancelled', 'GAME_CANCELLED');
    if (game.status === 'draft' || game.status === 'registration_open') {
      throw new ConflictError('That game has not been played yet', 'GAME_NOT_PLAYED');
    }

    const { rows: existing } = await client.query(
      'SELECT id FROM match_results WHERE game_id = $1 AND is_current', [gameId]
    );
    if (existing.length > 0) {
      throw new ConflictError(
        'A result has already been recorded for this game', 'RESULT_EXISTS'
      );
    }

    const teams = await loadTeams(client, gameId);
    if (teams.length === 0) {
      throw new ConflictError('Teams were never generated for this game', 'NO_TEAMS');
    }

    const byColour = normaliseScores(scores, teams);
    const teamA = teams[0];
    const teamB = teams[1];

    const attendanceSummary = await applyAttendance(client, gameId, attendance);
    await applyAwards(client, gameId, awards, actorUserId);
    await applyStats(client, gameId, stats, actorUserId);

    const { rows: resultRows } = await client.query(
      `INSERT INTO match_results
         (game_id, scores, team_a_id, team_b_id, team_a_score, team_b_score,
          played_at, version, recorded_by)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, 1, $8)
       RETURNING id, version, recorded_at`,
      [
        gameId, JSON.stringify(byColour), teamA.id, teamB?.id ?? null,
        byColour[teamA.color], teamB ? byColour[teamB.color] : null,
        game.kickoff_at, actorUserId,
      ]
    );

    await client.query(`UPDATE games SET status = 'completed' WHERE id = $1`, [gameId]);

    await publish(client, {
      eventType: EventTypes.MatchResultSubmitted,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: {
        gameId,
        resultId: resultRows[0].id,
        scores: byColour,
        attendance: attendanceSummary,
      },
    });

    // The event that drives points, pair history, and eventually the rating replay.
    await publish(client, {
      eventType: EventTypes.GameCompleted,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: { gameId },
    });

    return getResult(gameId, client);
  });
}

/**
 * Correct a result that was already recorded.
 *
 * Supersedes rather than overwrites: the previous version stays, flagged is_current =
 * false, with the new row pointing at it. Six months from now the rating replay must be
 * able to see both what was recorded and what it was corrected to.
 */
export async function correctResult({
  gameId, scores, awards, attendance, stats, reason, actorUserId,
}) {
  if (!reason) throw new ValidationError('A correction needs a reason');

  return withTransaction(async (client) => {
    await loadGameForResult(client, gameId);

    const { rows: current } = await client.query(
      `SELECT id, version, scores, team_a_score, team_b_score
         FROM match_results WHERE game_id = $1 AND is_current`,
      [gameId]
    );
    if (current.length === 0) {
      throw new ConflictError('There is no result to correct', 'NO_RESULT');
    }
    const previous = current[0];

    const teams = await loadTeams(client, gameId);
    const byColour = scores ? normaliseScores(scores, teams) : previous.scores;
    const teamA = teams[0];
    const teamB = teams[1];

    let attendanceSummary = null;
    if (attendance) attendanceSummary = await applyAttendance(client, gameId, attendance);
    if (awards) await applyAwards(client, gameId, awards, actorUserId);
    if (stats) await applyStats(client, gameId, stats, actorUserId);

    await client.query(
      'UPDATE match_results SET is_current = false WHERE id = $1', [previous.id]
    );

    const { rows: inserted } = await client.query(
      `INSERT INTO match_results
         (game_id, scores, team_a_id, team_b_id, team_a_score, team_b_score,
          played_at, version, supersedes, correction_reason, recorded_by)
       SELECT $1, $2::jsonb, $3, $4, $5, $6, g.kickoff_at, $7, $8, $9, $10
         FROM games g WHERE g.id = $1
       RETURNING id, version`,
      [
        gameId, JSON.stringify(byColour), teamA.id, teamB?.id ?? null,
        byColour[teamA.color], teamB ? byColour[teamB.color] : null,
        previous.version + 1, previous.id, reason, actorUserId,
      ]
    );

    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, before, after, reason)
       VALUES ($1, 'correct_result', 'game', $2, $3::jsonb, $4::jsonb, $5)`,
      [
        actorUserId, gameId,
        JSON.stringify({ version: previous.version, scores: previous.scores }),
        JSON.stringify({ version: previous.version + 1, scores: byColour }),
        reason,
      ]
    );

    await publish(client, {
      eventType: EventTypes.MatchResultCorrected,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: {
        gameId,
        resultId: inserted[0].id,
        supersedes: previous.id,
        version: inserted[0].version,
        scores: byColour,
        attendance: attendanceSummary,
        reason,
      },
    });

    return getResult(gameId, client);
  });
}

/** Record attendance on its own, without touching the result. */
export async function recordAttendance({ gameId, entries, actorUserId }) {
  return withTransaction(async (client) => {
    const game = await loadGameForResult(client, gameId);
    if (game.status === 'cancelled') throw new ConflictError('That game was cancelled', 'GAME_CANCELLED');

    const summary = await applyAttendance(client, gameId, entries);

    await publish(client, {
      eventType: EventTypes.AttendanceRecorded,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: { gameId, attendance: summary },
    });

    // If the game is already complete, points were awarded from the old attendance and
    // now need reconciling. Republishing GameCompleted is safe: the handler computes the
    // net position rather than blindly adding.
    if (game.status === 'completed') {
      await publish(client, {
        eventType: EventTypes.GameCompleted,
        aggregateType: 'game',
        aggregateId: gameId,
        actorUserId,
        payload: { gameId, reason: 'attendance_corrected' },
      });
    }

    return { gameId, attendance: summary };
  });
}

export async function getResult(gameId, client) {
  const run = client ?? { query };

  const { rows } = await run.query(
    `SELECT mr.id, mr.scores, mr.team_a_score, mr.team_b_score, mr.version,
            mr.played_at, mr.recorded_at, mr.correction_reason,
            ta.color AS team_a_color, tb.color AS team_b_color,
            g.kickoff_at, g.status AS game_status, d.name AS district_name
       FROM match_results mr
       JOIN games g ON g.id = mr.game_id
       JOIN districts d ON d.id = g.district_id
       LEFT JOIN game_teams ta ON ta.id = mr.team_a_id
       LEFT JOIN game_teams tb ON tb.id = mr.team_b_id
      WHERE mr.game_id = $1 AND mr.is_current`,
    [gameId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  const { rows: awards } = await run.query(
    `SELECT ma.award_type, ma.player_id, ma.note, u.display_name, p.jersey_name
       FROM match_awards ma
       JOIN players p ON p.id = ma.player_id
       JOIN users u ON u.id = p.user_id
      WHERE ma.game_id = $1
      ORDER BY ma.award_type`,
    [gameId]
  );

  const { rows: stats } = await run.query(
    `SELECT pms.player_id, pms.goals, pms.assists, pms.own_goals, pms.saves,
            pms.clean_sheet, gt.color AS team_color, u.display_name, p.jersey_name
       FROM player_match_stats pms
       JOIN players p ON p.id = pms.player_id
       JOIN users u ON u.id = p.user_id
       LEFT JOIN game_teams gt ON gt.id = pms.team_id
      WHERE pms.game_id = $1
      ORDER BY pms.goals DESC, pms.assists DESC`,
    [gameId]
  );

  const { rows: attendance } = await run.query(
    `SELECT attendance, count(*)::int AS n FROM registrations
      WHERE game_id = $1 AND status = 'confirmed' GROUP BY attendance`,
    [gameId]
  );

  return {
    id: r.id,
    gameId,
    version: r.version,
    isCorrection: r.version > 1,
    correctionReason: r.correction_reason,
    playedAt: r.played_at,
    recordedAt: r.recorded_at,
    districtName: r.district_name,
    score: {
      [r.team_a_color]: r.team_a_score,
      ...(r.team_b_color ? { [r.team_b_color]: r.team_b_score } : {}),
    },
    scores: r.scores,
    awards: awards.map((a) => ({
      type: a.award_type,
      playerId: a.player_id,
      name: a.jersey_name || a.display_name,
      note: a.note,
    })),
    stats: stats.map((s) => ({
      playerId: s.player_id,
      name: s.jersey_name || s.display_name,
      teamColor: s.team_color,
      goals: s.goals,
      assists: s.assists,
      ownGoals: s.own_goals,
      saves: s.saves,
      cleanSheet: s.clean_sheet,
    })),
    attendance: Object.fromEntries(attendance.map((a) => [a.attendance ?? 'unrecorded', a.n])),
  };
}

/** Every version of a result, newest first. The audit trail for a disputed score. */
export async function getResultHistory(gameId) {
  const { rows } = await query(
    `SELECT mr.id, mr.version, mr.is_current, mr.scores, mr.correction_reason,
            mr.recorded_at, u.display_name AS recorded_by
       FROM match_results mr
       LEFT JOIN users u ON u.id = mr.recorded_by
      WHERE mr.game_id = $1
      ORDER BY mr.version DESC`,
    [gameId]
  );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    isCurrent: r.is_current,
    scores: r.scores,
    correctionReason: r.correction_reason,
    recordedAt: r.recorded_at,
    recordedBy: r.recorded_by,
  }));
}

// ---------------------------------------------------------------------------
// Peer ratings
// ---------------------------------------------------------------------------

/**
 * A player rates others who were in the same game.
 *
 * Structured dimensions only, never free text. The product brief is "rate your
 * teammates", not "tell us who was rubbish", and a comment box would become the latter
 * within a fortnight.
 */
export async function submitPeerRatings({ gameId, raterPlayerId, ratings, }) {
  return withTransaction(async (client) => {
    const { rows: played } = await client.query(
      `SELECT 1 FROM team_players WHERE game_id = $1 AND player_id = $2`,
      [gameId, raterPlayerId]
    );
    if (played.length === 0) {
      throw new ConflictError('You can only rate a game you played in', 'DID_NOT_PLAY');
    }

    const { rows: participants } = await client.query(
      `SELECT player_id FROM team_players WHERE game_id = $1`, [gameId]
    );
    const valid = new Set(participants.map((p) => p.player_id));

    let stored = 0;
    for (const rating of ratings) {
      if (rating.playerId === raterPlayerId) {
        throw new ConflictError('You cannot rate yourself', 'SELF_RATING');
      }
      if (!valid.has(rating.playerId)) {
        throw new ConflictError('That player was not in this game', 'PLAYER_NOT_IN_GAME');
      }

      for (const [dimension, score] of Object.entries(rating.scores)) {
        await client.query(
          `INSERT INTO peer_ratings (game_id, rater_id, rated_id, dimension, score)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (game_id, rater_id, rated_id, dimension)
           DO UPDATE SET score = EXCLUDED.score`,
          [gameId, raterPlayerId, rating.playerId, dimension, score]
        );
        stored += 1;
      }
    }

    return { gameId, stored };
  });
}

/**
 * Peer consensus for a game, with a flag where it diverges sharply from the admin's call.
 *
 * This is a prompt to look, not an accusation. An admin who gives MOTM to someone the
 * players rated near the bottom may have seen something the scoreboard did not -- or may
 * be rating a friend. Either way it is worth surfacing rather than burying, and the
 * numbers say which without the system editorialising.
 */
export async function getPeerRatingSummary(gameId) {
  const { rows } = await query(
    `SELECT pr.rated_id AS player_id,
            u.display_name, p.jersey_name,
            ROUND(AVG(pr.score) FILTER (WHERE pr.dimension = 'overall'), 2) AS overall,
            COUNT(DISTINCT pr.rater_id)::int AS raters,
            jsonb_object_agg(pr.dimension, pr.avg_score) AS dimensions
       FROM (
         SELECT game_id, rater_id, rated_id, dimension, score,
                AVG(score) OVER (PARTITION BY rated_id, dimension) AS avg_score
           FROM peer_ratings WHERE game_id = $1
       ) pr
       JOIN players p ON p.id = pr.rated_id
       JOIN users u ON u.id = p.user_id
      WHERE pr.game_id = $1
      GROUP BY pr.rated_id, u.display_name, p.jersey_name
      ORDER BY overall DESC NULLS LAST`,
    [gameId]
  );

  const { rows: awards } = await query(
    `SELECT award_type, player_id FROM match_awards WHERE game_id = $1`, [gameId]
  );

  const players = rows.map((r) => ({
    playerId: r.player_id,
    name: r.jersey_name || r.display_name,
    overall: r.overall == null ? null : Number(r.overall),
    raters: r.raters,
    dimensions: r.dimensions,
  }));

  const anomalies = [];
  const rated = players.filter((p) => p.overall != null);

  // Only worth comparing once enough people have rated to have a consensus at all.
  if (rated.length >= 4) {
    const sorted = [...rated].sort((a, b) => b.overall - a.overall);
    const bottomThird = new Set(
      sorted.slice(Math.ceil(sorted.length * (2 / 3))).map((p) => p.playerId)
    );
    const topThird = new Set(
      sorted.slice(0, Math.floor(sorted.length / 3)).map((p) => p.playerId)
    );

    for (const award of awards) {
      if (['motm', 'best_player'].includes(award.award_type) && bottomThird.has(award.player_id)) {
        const player = rated.find((p) => p.playerId === award.player_id);
        anomalies.push({
          type: 'award_below_consensus',
          awardType: award.award_type,
          playerId: award.player_id,
          name: player?.name,
          peerAverage: player?.overall,
          raters: player?.raters,
        });
      }
      if (award.award_type === 'worst_player' && topThird.has(award.player_id)) {
        const player = rated.find((p) => p.playerId === award.player_id);
        anomalies.push({
          type: 'award_above_consensus',
          awardType: award.award_type,
          playerId: award.player_id,
          name: player?.name,
          peerAverage: player?.overall,
          raters: player?.raters,
        });
      }
    }
  }

  return { gameId, players, anomalies, consensusAvailable: rated.length >= 4 };
}
