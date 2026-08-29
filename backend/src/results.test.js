// Match results: the post-match flow, corrections, attendance, and peer ratings.
//
// The point of this suite is that the whole chain works end to end -- an admin records a
// score, and points, pair history and notifications all follow from it -- and that
// correcting a mistake later reaches the right final state rather than compounding.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, grantRole } from './test-support/harness.js';

let ctx;
let admin;
let districtId;
let worker;
const players = [];

before(async () => {
  ctx = await startTestServer();

  admin = createClient(ctx.baseUrl);
  const signup = await admin.post('/api/auth/signup', {
    displayName: 'Results Admin',
    email: 'results-admin@sportsfusion.test',
    password: 'correct-horse-battery',
  });
  await grantRole(ctx.db, signup.body.user.id, 'owner');
  await admin.post('/api/auth/login', {
    identifier: 'results-admin@sportsfusion.test', password: 'correct-horse-battery',
  });

  const district = await admin.post('/api/districts', { slug: 'keserwan', name: 'Keserwan' });
  districtId = district.body.district.id;

  for (let i = 0; i < 24; i += 1) {
    const client = createClient(ctx.baseUrl);
    await client.post('/api/auth/signup', {
      displayName: `Result Player ${i}`,
      email: `result-player${i}@sportsfusion.test`,
      password: 'correct-horse-battery',
      districtId,
    });
    const me = await client.get('/api/players/me');
    await client.patch('/api/players/me', { isGoalkeeper: i < 3 });
    await admin.put(`/api/players/${me.body.player.id}/rating`, {
      mu: 1450 + (i * 23) % 200, sigma: 110,
    });
    players.push({ client, playerId: me.body.player.id });
  }

  worker = await import('../../worker/src/index.js');
});

after(async () => { await ctx?.stop(); });

const drain = async () => {
  for (let i = 0; i < 20; i += 1) {
    const r = await worker.dispatchEvents({ batchSize: 50 });
    if (r.processed === 0 && r.failed === 0) break;
  }
};

/** A game that has been filled, had teams generated, and kicked off. */
async function playedGame({ capacity = 22 } = {}) {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    capacity, teamSize: capacity / 2, openImmediately: true,
  });
  const gameId = created.body.game.id;

  for (let i = 0; i < capacity; i += 1) {
    await players[i].client.post(`/api/games/${gameId}/join`);
  }
  const teams = await admin.post(`/api/games/${gameId}/teams/generate`, { seed: 4242 });
  await ctx.db.query(`UPDATE games SET kickoff_at = now() - interval '2 hours' WHERE id = $1`, [gameId]);
  await ctx.db.query(`UPDATE games SET status = 'in_progress' WHERE id = $1`, [gameId]);
  await drain();

  return { gameId, teams: teams.body.teams };
}

const pointsFor = async (gameId) => {
  const { rows } = await ctx.db.query(
    `SELECT COALESCE(SUM(delta), 0)::int AS total FROM point_transactions
      WHERE reference_type = 'game' AND reference_id = $1`,
    [gameId]
  );
  return rows[0].total;
};

// ---------------------------------------------------------------------------

let game;

test('an admin records a result with a score line and three taps', async () => {
  game = await playedGame();

  const res = await admin.post(`/api/games/${game.gameId}/result`, {
    scores: [
      { teamId: game.teams[0].id, score: 6 },
      { teamId: game.teams[1].id, score: 4 },
    ],
    awards: [
      { playerId: game.teams[0].players[3].id, awardType: 'motm' },
      { playerId: game.teams[1].players[2].id, awardType: 'best_player' },
      { playerId: game.teams[1].players[5].id, awardType: 'worst_player' },
    ],
  });

  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.result.score.black, 6);
  assert.equal(res.body.result.score.white, 4);
  assert.equal(res.body.result.version, 1);
  assert.equal(res.body.result.awards.length, 3);

  // Attendance defaults to everyone confirmed having turned up.
  assert.equal(res.body.result.attendance.attended, 22);
});

test('recording the result completes the game', async () => {
  const { rows } = await ctx.db.query('SELECT status FROM games WHERE id = $1', [game.gameId]);
  assert.equal(rows[0].status, 'completed');
});

test('submitting a second result is refused rather than overwriting', async () => {
  const res = await admin.post(`/api/games/${game.gameId}/result`, {
    scores: [
      { teamId: game.teams[0].id, score: 1 },
      { teamId: game.teams[1].id, score: 0 },
    ],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'RESULT_EXISTS');
});

test('the result publishes GameCompleted, which awards points', async () => {
  await drain();
  // 22 players x (100 played + 25 on time) + 250 MOTM = 3000
  assert.equal(await pointsFor(game.gameId), 3000);
});

test('pair history is recorded so the balancer stops repeating teams', async () => {
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM player_pair_history WHERE same_team_count > 0`
  );
  // Two teams of 11: 2 x C(11,2) = 110 same-team pairs.
  assert.equal(rows[0].n, 110);
});

test('players are notified that the result is up', async () => {
  await worker.dispatchNotifications({ batchSize: 200 });
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM notifications
      WHERE reference_id = $1 AND template_key = 'result_published'`,
    [game.gameId]
  );
  assert.equal(rows[0].n, 22);
});

test('an award for someone who did not play is refused', async () => {
  const other = await playedGame({ capacity: 22 });
  const res = await admin.post(`/api/games/${other.gameId}/result`, {
    scores: [
      { teamId: other.teams[0].id, score: 2 },
      { teamId: other.teams[1].id, score: 2 },
    ],
    awards: [{ playerId: players[23].playerId, awardType: 'motm' }],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'PLAYER_NOT_IN_GAME');

  // The whole submission rolled back -- no half-recorded result.
  const check = await admin.get(`/api/games/${other.gameId}/result`);
  assert.equal(check.body.result, null);
  const { rows } = await ctx.db.query('SELECT status FROM games WHERE id = $1', [other.gameId]);
  assert.equal(rows[0].status, 'in_progress');
});

test('a score for a team from another game is refused', async () => {
  const other = await playedGame({ capacity: 22 });
  const res = await admin.post(`/api/games/${other.gameId}/result`, {
    scores: [
      { teamId: game.teams[0].id, score: 1 },
      { teamId: other.teams[1].id, score: 0 },
    ],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INVALID_TEAM');
});

test('a game with no teams cannot have a result', async () => {
  const created = await admin.post('/api/games', {
    districtId, kickoffAt: new Date(Date.now() + 3_600_000).toISOString(), openImmediately: true,
  });
  await ctx.db.query(`UPDATE games SET status = 'in_progress' WHERE id = $1`, [created.body.game.id]);

  const res = await admin.post(`/api/games/${created.body.game.id}/result`, {
    scores: [{ teamId: game.teams[0].id, score: 1 }, { teamId: game.teams[1].id, score: 0 }],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'NO_TEAMS');
});

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

test('correcting a score supersedes rather than overwrites', async () => {
  const res = await admin.patch(`/api/games/${game.gameId}/result`, {
    scores: [
      { teamId: game.teams[0].id, score: 6 },
      { teamId: game.teams[1].id, score: 5 },
    ],
    reason: 'Miscounted the last goal',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.result.version, 2);
  assert.equal(res.body.result.score.white, 5);
  assert.equal(res.body.result.isCorrection, true);

  const history = await admin.get(`/api/games/${game.gameId}/result/history`);
  assert.equal(history.body.history.length, 2, 'both versions must survive');
  assert.equal(history.body.history[0].version, 2);
  assert.equal(history.body.history[0].isCurrent, true);
  assert.equal(history.body.history[1].version, 1);
  assert.equal(history.body.history[1].isCurrent, false);
  assert.equal(history.body.history[1].scores.white, 4, 'the original score is still readable');
});

test('a correction requires a reason', async () => {
  const res = await admin.patch(`/api/games/${game.gameId}/result`, {
    scores: [
      { teamId: game.teams[0].id, score: 9 },
      { teamId: game.teams[1].id, score: 0 },
    ],
  });
  assert.equal(res.status, 422);
});

test('correcting the score alone does not change anyone points', async () => {
  await drain();
  assert.equal(await pointsFor(game.gameId), 3000, 'the score does not decide who played');
});

test('marking someone a no-show afterwards takes their points back', async () => {
  const noShow = game.teams[0].players[7].id;

  const res = await admin.post(`/api/games/${game.gameId}/attendance`, {
    entries: [{ playerId: noShow, status: 'no_show' }],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.attendance.no_show, 1);
  assert.equal(res.body.attendance.attended, 21);

  await drain();

  // 21 x 125 + 250 MOTM = 2875
  assert.equal(await pointsFor(game.gameId), 2875);

  const { rows } = await ctx.db.query(
    `SELECT COALESCE(SUM(delta), 0)::int AS net FROM point_transactions
      WHERE reference_id = $1 AND player_id = $2`,
    [game.gameId, noShow]
  );
  assert.equal(rows[0].net, 0, 'their points must net to zero');
});

test('the reversal is recorded, not applied by deleting the original', async () => {
  const noShow = game.teams[0].players[7].id;
  const { rows } = await ctx.db.query(
    `SELECT reason, corrects_reason, delta FROM point_transactions
      WHERE reference_id = $1 AND player_id = $2 ORDER BY id`,
    [game.gameId, noShow]
  );
  assert.equal(rows.length, 4, 'two awards and two reversals');
  assert.ok(rows.some((r) => r.reason === 'game_played' && r.delta === 100));
  assert.ok(rows.some((r) => r.reason === 'correction' && r.corrects_reason === 'game_played' && r.delta === -100));
});

test('reinstating attendance restores the points exactly once', async () => {
  const restored = game.teams[0].players[7].id;

  await admin.post(`/api/games/${game.gameId}/attendance`, { entries: [] });
  await drain();
  assert.equal(await pointsFor(game.gameId), 3000, 'back to the full total');

  const { rows } = await ctx.db.query(
    `SELECT COALESCE(SUM(delta), 0)::int AS net FROM point_transactions
      WHERE reference_id = $1 AND player_id = $2`,
    [game.gameId, restored]
  );
  assert.equal(rows[0].net, 125, 'played plus on-time, once');
});

test('reconciliation is stable when nothing has changed', async () => {
  const before = await ctx.db.query(
    `SELECT count(*)::int AS n FROM point_transactions WHERE reference_id = $1`, [game.gameId]
  );

  await ctx.db.query(
    `INSERT INTO domain_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('GameCompleted', 'game', $1, $2::jsonb)`,
    [game.gameId, JSON.stringify({ gameId: game.gameId })]
  );
  await drain();

  const after = await ctx.db.query(
    `SELECT count(*)::int AS n FROM point_transactions WHERE reference_id = $1`, [game.gameId]
  );
  assert.equal(after.rows[0].n, before.rows[0].n, 'a no-op reconcile must write nothing');
  assert.equal(await pointsFor(game.gameId), 3000);
});

test('changing MOTM moves the award points to the right player', async () => {
  const oldMotm = game.teams[0].players[3].id;
  const newMotm = game.teams[1].players[1].id;

  await admin.patch(`/api/games/${game.gameId}/result`, {
    awards: [{ playerId: newMotm, awardType: 'motm' }],
    reason: 'Wrong player credited',
  });
  await ctx.db.query(
    `INSERT INTO domain_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('GameCompleted', 'game', $1, $2::jsonb)`,
    [game.gameId, JSON.stringify({ gameId: game.gameId })]
  );
  await drain();

  const netFor = async (playerId) => {
    const { rows } = await ctx.db.query(
      `SELECT COALESCE(SUM(delta), 0)::int AS net FROM point_transactions
        WHERE reference_id = $1 AND player_id = $2
          AND COALESCE(corrects_reason, reason) = 'motm'`,
      [game.gameId, playerId]
    );
    return rows[0].net;
  };

  assert.equal(await netFor(oldMotm), 0, 'the award is taken back');
  assert.equal(await netFor(newMotm), 250, 'and given to the right player');
  assert.equal(await pointsFor(game.gameId), 3000, 'the total is unchanged');
});

test('the player balance cache matches the ledger after all the corrections', async () => {
  const drift = await ctx.db.query('SELECT * FROM reconcile_player_points()');
  assert.equal(drift.rows.length, 0, JSON.stringify(drift.rows));
});

// ---------------------------------------------------------------------------
// Peer ratings
// ---------------------------------------------------------------------------

test('a player who was in the game can rate the others', async () => {
  const rater = players.find((p) => game.teams[0].players.some((tp) => tp.id === p.playerId));
  const targets = game.teams[0].players.filter((p) => p.id !== rater.playerId).slice(0, 3);

  const res = await rater.client.post(`/api/games/${game.gameId}/peer-ratings`, {
    ratings: targets.map((t) => ({
      playerId: t.id,
      scores: { overall: 4, passing: 5, effort: 4 },
    })),
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.stored, 9);
});

test('a player who did not play cannot rate', async () => {
  const res = await players[23].client.post(`/api/games/${game.gameId}/peer-ratings`, {
    ratings: [{ playerId: game.teams[0].players[0].id, scores: { overall: 1 } }],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DID_NOT_PLAY');
});

test('a player cannot rate themselves', async () => {
  const rater = players.find((p) => game.teams[0].players.some((tp) => tp.id === p.playerId));
  const res = await rater.client.post(`/api/games/${game.gameId}/peer-ratings`, {
    ratings: [{ playerId: rater.playerId, scores: { overall: 5 } }],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'SELF_RATING');
});

test('re-rating updates rather than duplicating', async () => {
  const rater = players.find((p) => game.teams[0].players.some((tp) => tp.id === p.playerId));
  const target = game.teams[0].players.find((p) => p.id !== rater.playerId);

  await rater.client.post(`/api/games/${game.gameId}/peer-ratings`, {
    ratings: [{ playerId: target.id, scores: { overall: 2 } }],
  });

  const { rows } = await ctx.db.query(
    `SELECT score FROM peer_ratings
      WHERE game_id = $1 AND rater_id = $2 AND rated_id = $3 AND dimension = 'overall'`,
    [game.gameId, rater.playerId, target.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 2);
});

test('peer ratings are not public', async () => {
  const rater = players.find((p) => game.teams[0].players.some((tp) => tp.id === p.playerId));
  const res = await rater.client.get(`/api/games/${game.gameId}/peer-ratings`);
  assert.equal(res.status, 403, 'only admins may read the consensus');
});

test('the summary flags an award that contradicts the peer consensus', async () => {
  const target = await playedGame({ capacity: 22 });
  const squad = target.teams.flatMap((t) => t.players);
  const unpopular = squad[0].id;

  // Five teammates rate the same player poorly, everyone else well.
  const raters = players.filter((p) => squad.some((s) => s.id === p.playerId)).slice(1, 6);
  for (const rater of raters) {
    await rater.client.post(`/api/games/${target.gameId}/peer-ratings`, {
      ratings: squad
        .filter((s) => s.id !== rater.playerId)
        .slice(0, 8)
        .map((s) => ({ playerId: s.id, scores: { overall: s.id === unpopular ? 1 : 5 } })),
    });
  }

  // The admin nonetheless gives them man of the match.
  await admin.post(`/api/games/${target.gameId}/result`, {
    scores: [
      { teamId: target.teams[0].id, score: 3 },
      { teamId: target.teams[1].id, score: 3 },
    ],
    awards: [{ playerId: unpopular, awardType: 'motm' }],
  });

  const res = await admin.get(`/api/games/${target.gameId}/peer-ratings`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.consensusAvailable, true);

  const flagged = res.body.anomalies.find((a) => a.playerId === unpopular);
  assert.ok(flagged, 'an award far below consensus should be flagged for a look');
  assert.equal(flagged.type, 'award_below_consensus');
  assert.equal(flagged.awardType, 'motm');
  assert.ok(flagged.peerAverage < 2);
});

test('no anomaly is claimed when too few people rated', async () => {
  const quiet = await playedGame({ capacity: 22 });
  await admin.post(`/api/games/${quiet.gameId}/result`, {
    scores: [
      { teamId: quiet.teams[0].id, score: 1 },
      { teamId: quiet.teams[1].id, score: 0 },
    ],
    awards: [{ playerId: quiet.teams[0].players[0].id, awardType: 'motm' }],
  });

  const res = await admin.get(`/api/games/${quiet.gameId}/peer-ratings`);
  assert.equal(res.body.consensusAvailable, false);
  assert.equal(res.body.anomalies.length, 0, 'silence is not evidence');
});

// ---------------------------------------------------------------------------

test('the result announcement is ready to paste into WhatsApp', async () => {
  const res = await admin.post(`/api/games/${game.gameId}/announcement`, { kind: 'result' });
  assert.equal(res.status, 200, res.text);
  assert.match(res.body.body, /RESULT/);
  assert.match(res.body.body, /BLACK 6 — 5 WHITE/);
  assert.match(res.body.body, /Man of the Match/);
});

test('a completed game shows the result on its public page', async () => {
  const anon = createClient(ctx.baseUrl);
  const res = await anon.get(`/api/games/${game.gameId}/result`);
  assert.equal(res.status, 200);
  assert.equal(res.body.result.score.black, 6);
  assert.equal(res.body.result.awards.length, 1);
});

test('everything the worker queued was consumed cleanly', async () => {
  for (let i = 0; i < 20; i += 1) {
    const r = await worker.tick();
    if (r.events.processed === 0 && r.notifications.sent === 0) break;
  }
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM domain_events WHERE dead_lettered_at IS NOT NULL`
  );
  assert.equal(rows[0].n, 0, 'no event should have failed');
});
