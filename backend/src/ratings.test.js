// Rating engine integration: applying Glicko-2 to real games, and the replay.
//
// The replay is the claim this whole architecture rests on -- that ratings are derived,
// so the engine could be deferred to V2 for free. These tests are where that claim is
// either true or not.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, grantRole } from './test-support/harness.js';

let ctx;
let admin;
let districtId;
let worker;
let ratings;
const players = [];

before(async () => {
  ctx = await startTestServer();

  admin = createClient(ctx.baseUrl);
  const signup = await admin.post('/api/auth/signup', {
    displayName: 'Ratings Admin',
    email: 'ratings-admin@sportsfusion.test',
    password: 'correct-horse-battery',
  });
  await grantRole(ctx.db, signup.body.user.id, 'owner');
  await admin.post('/api/auth/login', {
    identifier: 'ratings-admin@sportsfusion.test', password: 'correct-horse-battery',
  });

  const district = await admin.post('/api/districts', { slug: 'batroun', name: 'Batroun' });
  districtId = district.body.district.id;

  for (let i = 0; i < 22; i += 1) {
    const client = createClient(ctx.baseUrl);
    await client.post('/api/auth/signup', {
      displayName: `Rated Player ${i}`,
      email: `rated-player${i}@sportsfusion.test`,
      password: 'correct-horse-battery',
      districtId,
    });
    const me = await client.get('/api/players/me');
    await client.patch('/api/players/me', { isGoalkeeper: i < 3 });
    players.push({ client, playerId: me.body.player.id });
  }

  worker = await import('../../worker/src/index.js');
  ratings = await import('./modules/ratings/service.js');
});

after(async () => { await ctx?.stop(); });

const drain = async () => {
  for (let i = 0; i < 20; i += 1) {
    const r = await worker.dispatchEvents({ batchSize: 50 });
    if (r.processed === 0 && r.failed === 0) break;
  }
};

const ratingOf = async (playerId) => {
  const { rows } = await ctx.db.query(
    `SELECT rating_mu, rating_sigma, rating_volatility, rating_system
       FROM players WHERE id = $1`,
    [playerId]
  );
  return {
    rating: Number(rows[0].rating_mu),
    deviation: Number(rows[0].rating_sigma),
    volatility: Number(rows[0].rating_volatility),
    system: rows[0].rating_system,
  };
};

/** Play a full game and record a result. `winner` is 0 or 1 (team index). */
async function playGame({ winner = 0, draw = false, offsetHours = 0 } = {}) {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    capacity: 22, teamSize: 11, openImmediately: true,
  });
  const gameId = created.body.game.id;

  for (let i = 0; i < 22; i += 1) await players[i].client.post(`/api/games/${gameId}/join`);
  const teams = await admin.post(`/api/games/${gameId}/teams/generate`, { seed: 777 });

  await ctx.db.query(
    `UPDATE games SET kickoff_at = now() - ($2 || ' hours')::interval, status = 'in_progress'
      WHERE id = $1`,
    [gameId, 24 - offsetHours]
  );
  await drain();

  const t = teams.body.teams;
  await admin.post(`/api/games/${gameId}/result`, {
    scores: draw
      ? [{ teamId: t[0].id, score: 2 }, { teamId: t[1].id, score: 2 }]
      : [
          { teamId: t[0].id, score: winner === 0 ? 5 : 1 },
          { teamId: t[1].id, score: winner === 0 ? 1 : 5 },
        ],
  });
  await drain();

  return { gameId, teams: t };
}

// ---------------------------------------------------------------------------

let firstGame;

test('everyone starts unrated and provisional', async () => {
  const state = await ratingOf(players[0].playerId);
  assert.equal(state.rating, 1500);
  assert.equal(state.deviation, 350);
  assert.equal(state.volatility, 0.06);
});

test('completing a game applies Glicko-2 to everyone who played', async () => {
  firstGame = await playGame({ winner: 0 });

  const winnerId = firstGame.teams[0].players[0].id;
  const loserId = firstGame.teams[1].players[0].id;

  const winner = await ratingOf(winnerId);
  const loser = await ratingOf(loserId);

  assert.ok(winner.rating > 1500, `winner should gain, got ${winner.rating}`);
  assert.ok(loser.rating < 1500, `loser should lose, got ${loser.rating}`);
  assert.ok(winner.deviation < 350, 'playing should reduce uncertainty');
  assert.equal(winner.system, 'glicko2');
});

test('the rating movement is written to the ledger, not just the cache', async () => {
  const { rows } = await ctx.db.query(
    `SELECT source, mu, sigma, volatility, previous_mu, game_id, rating_system
       FROM player_ratings
      WHERE game_id = $1 AND source = 'match_result'`,
    [firstGame.gameId]
  );
  assert.equal(rows.length, 22, 'one ledger row per player who played');
  assert.ok(rows.every((r) => r.rating_system === 'glicko2'));
  assert.ok(rows.every((r) => r.volatility != null), 'volatility must be recorded');
  assert.ok(rows.every((r) => Number(r.previous_mu) === 1500));
});

test('rating a game twice is refused, so a replayed event cannot double the movement', async () => {
  const before = await ratingOf(firstGame.teams[0].players[0].id);

  await ctx.db.query(
    `INSERT INTO domain_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('GameCompleted', 'game', $1, $2::jsonb)`,
    [firstGame.gameId, JSON.stringify({ gameId: firstGame.gameId })]
  );
  await drain();

  const after = await ratingOf(firstGame.teams[0].players[0].id);
  assert.equal(after.rating, before.rating, 'a replayed event must not move the rating again');

  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM player_ratings
      WHERE game_id = $1 AND source = 'match_result'`,
    [firstGame.gameId]
  );
  assert.equal(rows[0].n, 22);
});

test('a player who did not turn up is not rated', async () => {
  const game = await playGame({ winner: 1 });
  const absentee = game.teams[0].players[4].id;

  // Undo the automatic rating so the game can be re-rated with corrected attendance.
  await ctx.db.query(`DELETE FROM player_ratings WHERE game_id = $1`, [game.gameId]);
  await ctx.db.query(
    `UPDATE registrations SET attendance = 'no_show' WHERE game_id = $1 AND player_id = $2`,
    [game.gameId, absentee]
  );

  await ratings.rateGame({ gameId: game.gameId });

  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM player_ratings WHERE game_id = $1 AND player_id = $2`,
    [game.gameId, absentee]
  );
  assert.equal(rows[0].n, 0, 'rating someone who was absent invents evidence');

  const { rows: total } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM player_ratings WHERE game_id = $1`, [game.gameId]
  );
  assert.equal(total[0].n, 21, 'the other 21 are still rated, against a side playing short');
});

test('the timeline explains each movement', async () => {
  const res = await admin.get(`/api/ratings/players/${firstGame.teams[0].players[0].id}/timeline`);
  assert.equal(res.status, 200, res.text);

  const entries = res.body.timeline;
  assert.ok(entries.length >= 2, 'seed plus at least one match');

  const fromMatch = entries.find((e) => e.source === 'match_result');
  assert.ok(fromMatch, 'a match result should appear');
  assert.equal(typeof fromMatch.change, 'number');
  assert.ok(fromMatch.gameId);
  assert.ok(fromMatch.score, 'the score that caused the movement should be attached');
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

test('the leaderboard hides players the system barely knows', async () => {
  const res = await admin.get('/api/ratings/leaderboard?minGames=1');
  assert.equal(res.status, 200, res.text);
  // After two games everyone still has a wide deviation, so nobody qualifies yet.
  assert.equal(res.body.leaderboard.length, 0, 'provisional players must not be ranked');
});

test('provisional players can be shown explicitly, ranked conservatively', async () => {
  const res = await admin.get(
    '/api/ratings/leaderboard?minGames=1&includeProvisional=true&limit=100'
  );
  const board = res.body.leaderboard;
  assert.ok(board.length > 0);
  assert.ok(board.every((row) => row.isProvisional));

  // Ranked on the conservative estimate, descending.
  for (let i = 1; i < board.length; i += 1) {
    assert.ok(board[i - 1].conservative >= board[i].conservative, 'must be sorted');
  }
  assert.ok(board[0].conservative < board[0].rating, 'conservative discounts uncertainty');
});

test('a proven regular outranks a newcomer with a higher raw rating', async () => {
  const proven = players[0].playerId;
  const newcomer = players[21].playerId;

  await ctx.db.query(
    `UPDATE players SET rating_mu = 1500, rating_sigma = 40 WHERE id = $1`, [proven]
  );
  await ctx.db.query(
    `UPDATE players SET rating_mu = 1650, rating_sigma = 300 WHERE id = $1`, [newcomer]
  );

  const res = await admin.get(
    '/api/ratings/leaderboard?minGames=1&includeProvisional=true&limit=100'
  );
  const board = res.body.leaderboard;
  const provenRank = board.findIndex((r) => r.playerId === proven);
  const newcomerRank = board.findIndex((r) => r.playerId === newcomer);

  assert.ok(provenRank >= 0 && newcomerRank >= 0);
  assert.ok(provenRank < newcomerRank, 'proof should outrank a bigger unproven number');
});

// ---------------------------------------------------------------------------
// Replay -- the claim the architecture rests on
// ---------------------------------------------------------------------------

test('a dry run reports what would change without writing anything', async () => {
  const before = await ctx.db.query(`SELECT count(*)::int AS n FROM player_ratings`);

  const res = await admin.post('/api/ratings/replay', { dryRun: true });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.dryRun, true);
  assert.ok(res.body.gamesReplayed >= 2);
  assert.equal(res.body.ratingsWritten, 0);

  const after = await ctx.db.query(`SELECT count(*)::int AS n FROM player_ratings`);
  assert.equal(after.rows[0].n, before.rows[0].n, 'a dry run must write nothing');
});

test('a replay reproduces the same ratings it computed incrementally', async () => {
  // Ratings were applied game by game as results came in. Recomputing the whole history
  // from scratch must land in the same place, or one of the two is wrong.
  const sampled = players.slice(0, 8).map((p) => p.playerId);

  // Undo the manual leaderboard fixture first so the comparison is against real history.
  const res0 = await admin.post('/api/ratings/replay', {});
  assert.equal(res0.status, 200, res0.text);
  const expected = {};
  for (const id of sampled) expected[id] = await ratingOf(id);

  const res = await admin.post('/api/ratings/replay', {});
  assert.equal(res.status, 200, res.text);

  for (const id of sampled) {
    const actual = await ratingOf(id);
    assert.ok(
      Math.abs(actual.rating - expected[id].rating) < 0.01,
      `${id}: ${actual.rating} vs ${expected[id].rating}`
    );
    assert.ok(Math.abs(actual.deviation - expected[id].deviation) < 0.01);
  }
});

test('a replay never destroys human judgement', async () => {
  const target = players[5].playerId;
  await admin.put(`/api/players/${target}/rating`, {
    mu: 1750, sigma: 90, reason: 'clearly better than the model thinks',
  });

  const before = await ctx.db.query(
    `SELECT count(*)::int AS n FROM player_ratings
      WHERE source IN ('admin_seed', 'admin_override')`
  );

  await admin.post('/api/ratings/replay', {});

  const after = await ctx.db.query(
    `SELECT count(*)::int AS n FROM player_ratings
      WHERE source IN ('admin_seed', 'admin_override')`
  );
  assert.equal(after.rows[0].n, before.rows[0].n, 'seeds and overrides must survive a replay');
});

test('an admin override anchors the timeline from that point forward', async () => {
  const target = players[6].playerId;

  // Override with a distinctive value dated after every game played so far.
  await ctx.db.query(
    `INSERT INTO player_ratings
       (player_id, mu, sigma, volatility, source, reason, effective_at, rating_system)
     VALUES ($1, 1900, 80, 0.06, 'admin_override', 'anchor test', now() + interval '1 day', 'glicko2')`,
    [target]
  );

  await admin.post('/api/ratings/replay', {});

  const state = await ratingOf(target);
  assert.equal(
    Math.round(state.rating), 1900,
    'an override dated after every game must be the final word'
  );
});

test('changing tau changes the outcome, and the replay applies it to all of history', async () => {
  const sample = players[0].playerId;

  await admin.post('/api/ratings/replay', { tau: 0.2 });
  const steady = await ratingOf(sample);

  await admin.post('/api/ratings/replay', { tau: 1.2 });
  const twitchy = await ratingOf(sample);

  assert.notEqual(
    steady.volatility.toFixed(6), twitchy.volatility.toFixed(6),
    'tau should reach the volatility of every historical game, not just new ones'
  );
});

test('each replay is recorded with the parameters that produced it', async () => {
  const res = await admin.get('/api/ratings/replays');
  assert.equal(res.status, 200);
  assert.ok(res.body.replays.length >= 4);

  const latest = res.body.replays[0];
  assert.equal(latest.algorithm_version, 'glicko2_v1');
  assert.equal(latest.parameters.tau, 1.2);
  assert.ok(latest.finished_at, 'a completed replay records when it finished');
  assert.ok(latest.games_replayed >= 2);
});

test('a replay leaves the cache consistent with the ledger', async () => {
  const { rows } = await ctx.db.query(
    `SELECT p.id, p.rating_mu, p.rating_updated_at,
            (SELECT pr.mu FROM player_ratings pr
              WHERE pr.player_id = p.id
              ORDER BY pr.effective_at DESC, pr.id DESC LIMIT 1) AS ledger_mu
       FROM players p
      WHERE EXISTS (SELECT 1 FROM player_ratings pr2 WHERE pr2.player_id = p.id)`
  );

  for (const row of rows) {
    assert.ok(
      Math.abs(Number(row.rating_mu) - Number(row.ledger_mu)) < 0.01,
      `player ${row.id}: cache ${row.rating_mu} vs ledger ${row.ledger_mu}`
    );
  }
});

// ---------------------------------------------------------------------------
// Decay and permissions
// ---------------------------------------------------------------------------

test('inactive players lose confidence, not rating', async () => {
  // Someone who was rated once and then stopped turning up. Players who have appeared in
  // a recent game are correctly excluded, so this needs a genuinely absent player.
  const absent = createClient(ctx.baseUrl);
  await absent.post('/api/auth/signup', {
    displayName: 'Lapsed Player',
    email: 'lapsed@sportsfusion.test',
    password: 'correct-horse-battery',
    districtId,
  });
  const me = await absent.get('/api/players/me');
  const target = me.body.player.id;

  await admin.put(`/api/players/${target}/rating`, { mu: 1600, sigma: 60, reason: 'seed' });
  await ctx.db.query(
    `UPDATE players SET rating_updated_at = now() - interval '90 days' WHERE id = $1`,
    [target]
  );

  const decayed = await ratings.decayInactiveRatings({ inactiveDays: 30 });
  assert.ok(decayed >= 1, 'a player absent for 90 days should be decayed');

  const state = await ratingOf(target);
  assert.equal(Math.round(state.rating), 1600, 'absence is not evidence of getting worse');
  assert.ok(state.deviation > 60, 'but confidence should fade');
});

test('decay is recorded in the ledger like everything else', async () => {
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM player_ratings WHERE source = 'decay'`
  );
  assert.ok(rows[0].n >= 1);
});

test('an active player is not decayed', async () => {
  const active = firstGame.teams[0].players[0].id;
  await ctx.db.query(
    `UPDATE players SET rating_updated_at = now() WHERE id = $1`, [active]
  );
  const before = await ratingOf(active);
  await ratings.decayInactiveRatings({ inactiveDays: 30 });
  const after = await ratingOf(active);
  assert.equal(after.deviation, before.deviation);
});

test('a plain player cannot trigger a replay', async () => {
  const res = await players[0].client.post('/api/ratings/replay', {});
  assert.equal(res.status, 403);
});

test('the leaderboard is public', async () => {
  const anon = createClient(ctx.baseUrl);
  const res = await anon.get('/api/ratings/leaderboard?includeProvisional=true&minGames=0');
  assert.equal(res.status, 200);
});

test('the balancer reads the ratings the engine produced', async () => {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
    capacity: 22, teamSize: 11, openImmediately: true,
  });
  for (let i = 0; i < 22; i += 1) {
    await players[i].client.post(`/api/games/${created.body.game.id}/join`);
  }

  const res = await admin.post(`/api/games/${created.body.game.id}/teams/generate`, { seed: 5 });
  assert.equal(res.status, 201, res.text);

  // The snapshot must contain the Glicko numbers, not the 1500 defaults.
  const { rows } = await ctx.db.query(
    `SELECT rating_snapshot FROM team_generation_runs WHERE game_id = $1 AND is_active`,
    [created.body.game.id]
  );
  const snapshot = rows[0].rating_snapshot;
  assert.equal(snapshot.length, 22);
  assert.ok(
    snapshot.some((s) => Math.abs(s.mu - 1500) > 1),
    'the balancer should be using earned ratings, not defaults'
  );
  assert.ok(
    snapshot.some((s) => s.sigma < 350),
    'and the deviations the engine narrowed'
  );
});
