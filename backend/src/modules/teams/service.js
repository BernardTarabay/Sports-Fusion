// Team generation, persistence, and admin override.
//
// The balancer is pure; this module is everything around it -- loading the inputs,
// storing the run so it can be reproduced, and recording what the admin changed
// afterwards so the system can learn from it.

import { randomInt } from 'node:crypto';
import { query, withTransaction } from '../../database/pool.js';
import { publish, EventTypes } from '../../lib/events.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { balanceTeams, scoreSplit, ALGORITHM_VERSION, DEFAULT_WEIGHTS } from './balancer.js';
import config from '../../config/index.js';

const TEAM_COLORS = ['black', 'white', 'red', 'blue', 'yellow', 'green'];

async function loadConfirmedPlayers(client, gameId) {
  const { rows } = await client.query(
    `SELECT p.id, p.rating_mu, p.rating_sigma, p.preferred_position,
            p.secondary_positions, p.is_goalkeeper,
            u.display_name, p.jersey_name
       FROM registrations r
       JOIN players p ON p.id = r.player_id
       JOIN users u   ON u.id = p.user_id
      WHERE r.game_id = $1 AND r.status = 'confirmed'
      ORDER BY p.id`,
    [gameId]
  );

  return rows.map((r) => ({
    id: r.id,
    ratingMu: Number(r.rating_mu),
    ratingSigma: Number(r.rating_sigma),
    preferredPosition: r.preferred_position,
    secondaryPositions: r.secondary_positions ?? [],
    isGoalkeeper: r.is_goalkeeper,
    name: r.jersey_name || r.display_name,
  }));
}

/**
 * Pair history for the anti-repetition term.
 *
 * `games_ago` is the number of completed games in this district since the pair last
 * shared a team, which is a better recency measure than elapsed days -- a fortnight's
 * break because the pitch flooded should not reset who has been playing together.
 */
async function loadPairHistory(client, gameId, districtId, playerIds) {
  if (playerIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT pph.player_a_id, pph.player_b_id, pph.same_team_count,
            (SELECT count(*) FROM games g2
              WHERE g2.district_id = $2
                AND g2.status = 'completed'
                AND g2.kickoff_at > pph.last_same_team_at)::int AS games_ago
       FROM player_pair_history pph
      WHERE pph.player_a_id = ANY($1) AND pph.player_b_id = ANY($1)`,
    [playerIds, districtId]
  );

  return rows.map((r) => ({
    playerAId: r.player_a_id,
    playerBId: r.player_b_id,
    sameTeamCount: r.same_team_count,
    gamesAgo: r.games_ago,
  }));
}

async function loadRelationships(client, playerIds) {
  if (playerIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT player_id, other_player_id, kind, weight, origin
       FROM player_relationships
      WHERE player_id = ANY($1) AND other_player_id = ANY($1)`,
    [playerIds]
  );
  return rows.map((r) => ({
    playerId: r.player_id,
    otherPlayerId: r.other_player_id,
    kind: r.kind,
    weight: Number(r.weight),
    origin: r.origin,
  }));
}

/**
 * Generate teams for a game.
 *
 * Regenerating does not erase the previous attempt: the old run is marked inactive and
 * kept, so "what did it suggest before I moved everyone" is answerable.
 */
export async function generateTeams({ gameId, seed, weights, actorUserId, force = false }) {
  return withTransaction(async (client) => {
    const { rows: gameRows } = await client.query(
      `SELECT id, district_id, status, capacity, team_size, team_count, confirmed_count
         FROM games WHERE id = $1 FOR UPDATE`,
      [gameId]
    );
    if (gameRows.length === 0) throw new NotFoundError('Game');
    const game = gameRows[0];

    if (game.status === 'cancelled') throw new ConflictError('That game is cancelled', 'GAME_CANCELLED');
    if (game.status === 'completed') throw new ConflictError('That game has been played', 'GAME_COMPLETED');
    if (game.confirmed_count !== game.capacity && !force) {
      throw new ConflictError(
        `Only ${game.confirmed_count} of ${game.capacity} players are confirmed`,
        'GAME_NOT_FULL',
        { confirmed: game.confirmed_count, capacity: game.capacity }
      );
    }

    const players = await loadConfirmedPlayers(client, gameId);
    const playerIds = players.map((p) => p.id);

    if (players.length !== game.team_size * game.team_count) {
      throw new ConflictError(
        `Need ${game.team_size * game.team_count} confirmed players, have ${players.length}`,
        'WRONG_PLAYER_COUNT'
      );
    }
    if (game.team_count !== 2) {
      // The exhaustive enumeration is a two-team algorithm. Three-way splits need a
      // different method, and pretending otherwise would silently produce nonsense.
      throw new ConflictError('Only two-team games can be balanced automatically', 'UNSUPPORTED_TEAM_COUNT');
    }

    const [pairHistory, relationships] = await Promise.all([
      loadPairHistory(client, gameId, game.district_id, playerIds),
      loadRelationships(client, playerIds),
    ]);

    const effectiveSeed = seed ?? randomInt(0, 2 ** 31 - 1);

    const result = balanceTeams({
      players,
      teamSize: game.team_size,
      seed: effectiveSeed,
      weights: { ...DEFAULT_WEIGHTS, ...weights },
      pairHistory,
      relationships,
      options: { shortlistSize: config.balancer.shortlistSize },
    });

    // Retire any previous run rather than deleting it.
    const { rows: previous } = await client.query(
      `UPDATE team_generation_runs SET is_active = false
        WHERE game_id = $1 AND is_active RETURNING id`,
      [gameId]
    );
    await client.query(`DELETE FROM game_teams WHERE game_id = $1`, [gameId]);

    const { rows: runRows } = await client.query(
      `INSERT INTO team_generation_runs (
         game_id, algorithm_version, seed, weights, rating_snapshot,
         candidates_evaluated, shortlist_size, chosen_rank, score, score_breakdown,
         duration_ms, generated_by, superseded_by)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,NULL)
       RETURNING id`,
      [
        gameId, result.algorithmVersion, result.seed,
        JSON.stringify(result.weights), JSON.stringify(result.ratingSnapshot),
        result.candidatesEvaluated, result.shortlistSize, result.chosenRank,
        result.score, JSON.stringify(result.scoreBreakdown), result.durationMs,
        actorUserId ?? null,
      ]
    );
    const runId = runRows[0].id;

    if (previous.length > 0) {
      await client.query(
        `UPDATE team_generation_runs SET superseded_by = $2 WHERE id = ANY($1)`,
        [previous.map((p) => p.id), runId]
      );
    }

    const teams = [];
    for (const [i, team] of result.teams.entries()) {
      const color = TEAM_COLORS[i];
      const { rows: teamRows } = await client.query(
        `INSERT INTO game_teams (game_id, run_id, color, strength)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [gameId, runId, color, team.strength]
      );
      const teamId = teamRows[0].id;

      for (const [slotIndex, player] of team.players.entries()) {
        await client.query(
          `INSERT INTO team_players (
             team_id, game_id, player_id, assigned_position, slot_index,
             rating_mu_at_assignment, rating_sigma_at_assignment)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [teamId, gameId, player.id, player.assignedPosition, slotIndex,
           player.ratingMu, player.ratingSigma]
        );
      }

      teams.push({
        id: teamId,
        color,
        strength: team.strength,
        players: team.players.map((p) => ({
          id: p.id, name: p.name, position: p.assignedPosition,
          ratingMu: p.ratingMu, isGoalkeeper: p.isGoalkeeper,
        })),
      });
    }

    await client.query(
      `UPDATE games SET status = 'teams_generated' WHERE id = $1 AND status IN ('full','registration_open')`,
      [gameId]
    );

    await publish(client, {
      eventType: EventTypes.TeamsGenerated,
      aggregateType: 'game',
      aggregateId: gameId,
      actorUserId,
      payload: {
        gameId, runId, seed: result.seed, score: result.score,
        candidatesEvaluated: result.candidatesEvaluated,
      },
    });

    return {
      runId,
      seed: result.seed,
      algorithmVersion: result.algorithmVersion,
      score: result.score,
      scoreBreakdown: result.scoreBreakdown,
      candidatesEvaluated: result.candidatesEvaluated,
      chosenRank: result.chosenRank,
      durationMs: result.durationMs,
      teams,
    };
  });
}

// `client` lets this run on an open transaction; see the note in games/service.js.
export async function getTeams(gameId, client) {
  const run = client ?? { query };
  const { rows } = await run.query(
    `SELECT gt.id AS team_id, gt.color, gt.strength, gt.run_id,
            tp.player_id, tp.assigned_position, tp.is_manual_override, tp.slot_index,
            tp.rating_mu_at_assignment,
            p.is_goalkeeper, p.jersey_name, u.display_name
       FROM game_teams gt
       LEFT JOIN team_players tp ON tp.team_id = gt.id
       LEFT JOIN players p ON p.id = tp.player_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE gt.game_id = $1
      -- By the position on the pitch, not by the name of the position. Ordering on
      -- assigned_position sorted the team sheet alphabetically -- CAM, CB, CB, CDM --
      -- which is what the tactical board was reading as its slot order.
      ORDER BY gt.color, tp.slot_index NULLS LAST, tp.assigned_position`,
    [gameId]
  );

  const byTeam = new Map();
  for (const r of rows) {
    if (!byTeam.has(r.team_id)) {
      byTeam.set(r.team_id, {
        id: r.team_id, color: r.color, runId: r.run_id,
        strength: r.strength == null ? null : Number(r.strength),
        players: [],
      });
    }
    if (r.player_id) {
      byTeam.get(r.team_id).players.push({
        id: r.player_id,
        name: r.jersey_name || r.display_name,
        position: r.assigned_position,
        slotIndex: r.slot_index,
        ratingMu: r.rating_mu_at_assignment == null ? null : Number(r.rating_mu_at_assignment),
        isGoalkeeper: r.is_goalkeeper,
        isManualOverride: r.is_manual_override,
      });
    }
  }

  return [...byTeam.values()];
}

/**
 * Apply admin overrides: a list of {playerId, toTeamId, slotIndex?} moves.
 *
 * Two players swapping is the normal case; a one-way move is allowed but leaves uneven
 * teams, so the response reports the resulting sizes rather than silently permitting it.
 *
 * A MOVE IS A TEAM *AND* A PLACE.
 *
 * This used to be a team-only operation, and it began with
 * `if (rows[0].team_id === move.toTeamId) continue` -- so dragging somebody from left
 * back to right wing did nothing at all on the server. The arrangement an admin built on
 * the tactical board survived until the next refetch and then reverted, because the
 * pitch was inferring positions from an array ordered by `assigned_position`.
 *
 * `slotIndex` is where on the board they were dropped, and it is stored. It may point at
 * a place nobody is standing in: an empty slot is a real destination, which is what lets
 * a squad of five arrange itself across the pitch instead of bunching at the front.
 *
 * OVERRIDE IS FLAGGED ONLY WHEN THE TEAM CHANGES.
 *
 * That flag is the training signal for inferred relationships -- when an admin
 * repeatedly puts the same two players together, the system can learn a `play_with`
 * preference instead of fighting the admin every week. Moving somebody five yards
 * within their own side says nothing about who they want to play with, so it must not
 * mark them as hand-placed; the whole sheet is sent on every arrangement, and flagging
 * all of it would drown the signal.
 */
/**
 * Give every unplaced player on these teams the lowest free slot.
 *
 * "Unplaced" happens for two ordinary reasons: somebody was displaced by a move into
 * their slot, or they were added to the sheet by a path that does not know about the
 * tactical board at all. Either way the pitch needs a place to draw them, and deciding
 * that on the client means two admins looking at the same game can see different
 * arrangements.
 *
 * Lowest free slot, in a stable order, so the result does not depend on row order.
 */
async function settleSlots(client, gameId, teamIds) {
  if (teamIds.length === 0) return;

  const { rows } = await client.query(
    `SELECT id, team_id, slot_index
       FROM team_players
      WHERE game_id = $1 AND team_id = ANY($2::uuid[])
      ORDER BY team_id, slot_index NULLS LAST, assigned_position NULLS LAST, created_at, id`,
    [gameId, teamIds]
  );

  const takenByTeam = new Map();
  for (const row of rows) {
    if (!takenByTeam.has(row.team_id)) takenByTeam.set(row.team_id, new Set());
    if (row.slot_index != null) takenByTeam.get(row.team_id).add(row.slot_index);
  }

  for (const row of rows) {
    if (row.slot_index != null) continue;
    const taken = takenByTeam.get(row.team_id);
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    taken.add(slot);
    await client.query('UPDATE team_players SET slot_index = $2 WHERE id = $1', [row.id, slot]);
  }
}

export async function applyOverride({ gameId, moves, actorUserId }) {
  return withTransaction(async (client) => {
    const { rows: teamRows } = await client.query(
      `SELECT id, color FROM game_teams WHERE game_id = $1`, [gameId]
    );
    if (teamRows.length === 0) throw new ConflictError('Teams have not been generated', 'NO_TEAMS');
    const validTeamIds = new Set(teamRows.map((t) => t.id));

    // Clear first, then place.
    //
    // (team_id, slot_index) is unique, so applying a swap one row at a time trips the
    // index the moment the first player lands on a square the second has not left yet.
    // Vacating every slot named in this batch removes the ordering dependency entirely.
    const slotted = moves.filter((m) => m.slotIndex != null);
    if (slotted.length > 0) {
      await client.query(
        `UPDATE team_players SET slot_index = NULL
          WHERE game_id = $1 AND player_id = ANY($2::uuid[])`,
        [gameId, slotted.map((m) => m.playerId)]
      );
      for (const move of slotted) {
        await client.query(
          `UPDATE team_players SET slot_index = NULL
            WHERE game_id = $1 AND team_id = $2 AND slot_index = $3`,
          [gameId, move.toTeamId, move.slotIndex]
        );
      }
    }

    const before = [];
    for (const move of moves) {
      if (!validTeamIds.has(move.toTeamId)) {
        throw new ConflictError('That team is not part of this game', 'INVALID_TEAM');
      }

      const { rows } = await client.query(
        `SELECT id, team_id, slot_index FROM team_players
          WHERE game_id = $1 AND player_id = $2`,
        [gameId, move.playerId]
      );
      if (rows.length === 0) throw new NotFoundError('Player on this game sheet');

      const current = rows[0];
      const changedTeam = current.team_id !== move.toTeamId;

      if (changedTeam) {
        before.push({ playerId: move.playerId, fromTeamId: current.team_id, toTeamId: move.toTeamId });
        await client.query(
          `UPDATE team_players
              SET team_id = $2, slot_index = $3,
                  is_manual_override = true, moved_from_team_id = team_id,
                  moved_by = $4, moved_at = now()
            WHERE id = $1`,
          [current.id, move.toTeamId, move.slotIndex ?? null, actorUserId ?? null]
        );
      } else if (move.slotIndex != null) {
        // Same side, new place. Not an override -- see the note above.
        await client.query(
          `UPDATE team_players SET slot_index = $2 WHERE id = $1`,
          [current.id, move.slotIndex]
        );
      }
    }

    // Everybody on a team is standing somewhere.
    //
    // A move into an occupied slot displaces whoever was there, and a cross-team move
    // leaves them with nowhere to go -- so without this a player ends up on the sheet
    // with a null slot and the pitch has to invent a position for them, differently on
    // every client. Settling it here means the arrangement is a fact of the game rather
    // than a rendering decision.
    await settleSlots(client, gameId, [...validTeamIds]);

    // Recompute each team's strength from the rating snapshot taken at assignment, so
    // the number shown is comparable with the one the generator produced.
    const { rows: strengths } = await client.query(
      `SELECT team_id, COALESCE(SUM(rating_mu_at_assignment), 0) AS strength, count(*)::int AS size
         FROM team_players WHERE game_id = $1 GROUP BY team_id`,
      [gameId]
    );
    for (const s of strengths) {
      await client.query('UPDATE game_teams SET strength = $2 WHERE id = $1', [s.team_id, s.strength]);
    }

    if (before.length > 0) {
      await client.query(
        `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, before, after)
         VALUES ($1, 'override_teams', 'game', $2, $3::jsonb, $4::jsonb)`,
        [actorUserId ?? null, gameId, JSON.stringify(before), JSON.stringify(moves)]
      );

      await publish(client, {
        eventType: EventTypes.TeamsOverridden,
        aggregateType: 'game',
        aggregateId: gameId,
        actorUserId,
        payload: { gameId, moves: before },
      });
    }

    const sizes = strengths.map((s) => s.size);
    return {
      moved: before.length,
      teams: await getTeams(gameId, client),
      uneven: new Set(sizes).size > 1,
    };
  });
}

/**
 * Re-score the current (possibly hand-edited) split using the same objective the
 * generator used, so an admin can see what their change cost.
 */
export async function explainCurrentTeams(gameId) {
  const teams = await getTeams(gameId);
  if (teams.length !== 2) return null;

  const { rows: runRows } = await query(
    `SELECT weights, rating_snapshot, score, score_breakdown, seed, algorithm_version
       FROM team_generation_runs WHERE game_id = $1 AND is_active`,
    [gameId]
  );
  if (runRows.length === 0) return null;
  const run = runRows[0];

  const snapshot = new Map(run.rating_snapshot.map((s) => [s.id, s]));
  const players = teams
    .flatMap((t) => t.players)
    .map((p) => ({
      id: p.id,
      ratingMu: snapshot.get(p.id)?.mu ?? p.ratingMu ?? 1500,
      ratingSigma: snapshot.get(p.id)?.sigma ?? 350,
      preferredPosition: p.position,
      isGoalkeeper: p.isGoalkeeper,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const teamAIds = new Set(teams[0].players.map((p) => p.id));
  let mask = 0;
  players.forEach((p, i) => { if (teamAIds.has(p.id)) mask |= (1 << i); });

  // Rebuild the same flat context the balancer uses, without its pair penalties -- this
  // reports the structural cost of the edit, not the social one.
  const n = players.length;
  const ctx = {
    n,
    mu: Float64Array.from(players.map((p) => p.ratingMu)),
    sigma: Float64Array.from(players.map((p) => p.ratingSigma)),
    isGk: Uint8Array.from(players.map((p) => (p.isGoalkeeper ? 1 : 0))),
    group: Uint8Array.from(players.map(() => 2)),
    pairCost: new Float64Array(n * n),
    _idxA: new Int32Array(n),
    _idxB: new Int32Array(n),
  };

  const current = scoreSplit(ctx, mask, run.weights);

  return {
    algorithmVersion: run.algorithm_version ?? ALGORITHM_VERSION,
    seed: run.seed,
    generatedScore: Number(run.score),
    generatedBreakdown: run.score_breakdown,
    currentScore: current.total,
    currentBreakdown: current.breakdown,
    delta: current.total - Number(run.score),
  };
}

/**
 * Record who played with whom, for the anti-repetition term. Called when a game
 * completes -- not at generation, because teams that never took the field should not
 * count as having played together.
 */
export async function recordPairHistory(client, gameId) {
  await client.query(
    `INSERT INTO player_pair_history (player_a_id, player_b_id, same_team_count, last_same_team_at)
     SELECT LEAST(a.player_id, b.player_id), GREATEST(a.player_id, b.player_id), 1, now()
       FROM team_players a
       JOIN team_players b
         ON a.team_id = b.team_id AND a.player_id < b.player_id
      WHERE a.game_id = $1
     ON CONFLICT (player_a_id, player_b_id) DO UPDATE
       SET same_team_count = player_pair_history.same_team_count + 1,
           last_same_team_at = now(),
           updated_at = now()`,
    [gameId]
  );

  await client.query(
    `INSERT INTO player_pair_history (player_a_id, player_b_id, opposite_team_count)
     SELECT LEAST(a.player_id, b.player_id), GREATEST(a.player_id, b.player_id), 1
       FROM team_players a
       JOIN team_players b
         ON a.game_id = b.game_id AND a.team_id <> b.team_id AND a.player_id < b.player_id
      WHERE a.game_id = $1
     ON CONFLICT (player_a_id, player_b_id) DO UPDATE
       SET opposite_team_count = player_pair_history.opposite_team_count + 1,
           updated_at = now()`,
    [gameId]
  );
}
