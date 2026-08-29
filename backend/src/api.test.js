// End-to-end API tests: real Express app, real pg driver, real Postgres engine.
//
// Walks the whole Friday-night lifecycle: sign up, open a game, fill it, overflow to the
// waitlist, cancel, auto-promote, generate teams, override them, and generate the
// WhatsApp announcement.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, grantRole } from './test-support/harness.js';

let ctx;
let admin;
let districtId;

const players = [];

before(async () => {
  ctx = await startTestServer();

  // Admin account, promoted directly in the database.
  admin = createClient(ctx.baseUrl);
  const signup = await admin.post('/api/auth/signup', {
    displayName: 'Admin One',
    email: 'admin@sportsfusion.test',
    password: 'correct-horse-battery',
  });
  assert.equal(signup.status, 201, signup.text);
  await grantRole(ctx.db, signup.body.user.id, 'owner');
  // Re-login so the new role is inside the access token.
  await admin.post('/api/auth/login', {
    identifier: 'admin@sportsfusion.test',
    password: 'correct-horse-battery',
  });

  const district = await admin.post('/api/districts', { slug: 'beirut', name: 'Beirut' });
  assert.equal(district.status, 201, district.text);
  districtId = district.body.district.id;

  // 25 players: 22 to fill the game, 3 to overflow onto the waitlist.
  for (let i = 0; i < 25; i += 1) {
    const client = createClient(ctx.baseUrl);
    const res = await client.post('/api/auth/signup', {
      displayName: `Player ${i}`,
      email: `player${i}@sportsfusion.test`,
      password: 'correct-horse-battery',
      districtId,
    });
    assert.equal(res.status, 201, res.text);

    const me = await client.get('/api/players/me');
    // First three are keepers so both teams can have one.
    await client.patch('/api/players/me', {
      isGoalkeeper: i < 3,
      preferredPosition: i < 3 ? 'GK' : ['CB', 'CM', 'ST', 'LB', 'RW'][i % 5],
    });
    // Seed a spread of ratings so balancing has something to work with.
    await admin.put(`/api/players/${me.body.player.id}/rating`, {
      mu: 1400 + (i * 37) % 260,
      sigma: 120,
      reason: 'initial seed',
    });

    players.push({ client, playerId: me.body.player.id, email: `player${i}@sportsfusion.test` });
  }
});

after(async () => { await ctx?.stop(); });

// ---------------------------------------------------------------------------

test('health endpoint reports the database is up', async () => {
  const res = await createClient(ctx.baseUrl).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.database, 'up');
});

test('rejects signup with neither email nor phone', async () => {
  const res = await createClient(ctx.baseUrl).post('/api/auth/signup', {
    displayName: 'Nobody', password: 'correct-horse-battery',
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('rejects a duplicate account', async () => {
  const res = await createClient(ctx.baseUrl).post('/api/auth/signup', {
    displayName: 'Player Zero Again',
    email: 'player0@sportsfusion.test',
    password: 'correct-horse-battery',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ACCOUNT_EXISTS');
});

test('rejects a wrong password without revealing whether the account exists', async () => {
  const client = createClient(ctx.baseUrl);
  const wrongPassword = await client.post('/api/auth/login', {
    identifier: 'player0@sportsfusion.test', password: 'not-the-password',
  });
  const noSuchUser = await client.post('/api/auth/login', {
    identifier: 'ghost@sportsfusion.test', password: 'not-the-password',
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.equal(wrongPassword.body.error.code, noSuchUser.body.error.code);
  assert.equal(wrongPassword.body.error.message, noSuchUser.body.error.message);
});

test('protected routes reject anonymous callers', async () => {
  const res = await createClient(ctx.baseUrl).get('/api/players/me');
  assert.equal(res.status, 401);
});

test('a plain player cannot create a game', async () => {
  const res = await players[0].client.post('/api/games', {
    districtId, kickoffAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
});

test('refresh rotates the session, and replaying the old token kills the family', async () => {
  const client = createClient(ctx.baseUrl);
  await client.post('/api/auth/login', {
    identifier: 'player1@sportsfusion.test', password: 'correct-horse-battery',
  });
  const original = client.jar.get('sf_refresh');
  assert.ok(original, 'expected a refresh cookie');

  const rotated = await client.post('/api/auth/refresh');
  assert.equal(rotated.status, 200);
  assert.notEqual(client.jar.get('sf_refresh'), original, 'refresh token should rotate');

  // Replay the superseded token, as a thief would.
  const replay = await fetch(`${ctx.baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: original }),
  });
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error.code, 'TOKEN_REUSE_DETECTED');

  // The whole family is now revoked, so the rotated token is dead too.
  const afterBreach = await client.post('/api/auth/refresh');
  assert.equal(afterBreach.status, 401);
});

// ---------------------------------------------------------------------------

let gameId;

test('an admin creates and opens a game', async () => {
  const res = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    capacity: 22,
    teamSize: 11,
    price: 10,
    openImmediately: true,
  });
  assert.equal(res.status, 201, res.text);
  gameId = res.body.game.id;

  assert.equal(res.body.game.status, 'registration_open');
  assert.equal(res.body.game.spotsLeft, 22);
  assert.match(res.body.game.url, /\/g\/[a-z]{3}-beirut-[0-9a-f]{6}$/);
});

test('capacity must divide into whole teams', async () => {
  const res = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    capacity: 21, teamSize: 11, teamCount: 2,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INVALID_CAPACITY');
});

test('22 players fill the game and it flips to full', async () => {
  for (let i = 0; i < 22; i += 1) {
    const res = await players[i].client.post(`/api/games/${gameId}/join`);
    assert.equal(res.status, 201, `player ${i}: ${res.text}`);
    assert.equal(res.body.status, 'confirmed');
  }

  const game = await admin.get(`/api/games/${gameId}`);
  assert.equal(game.body.game.confirmedCount, 22);
  assert.equal(game.body.game.spotsLeft, 0);
  assert.equal(game.body.game.status, 'full');
});

test('joining twice is idempotent rather than an error', async () => {
  const res = await players[0].client.post(`/api/games/${gameId}/join`);
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyRegistered, true);
  assert.equal(res.body.status, 'confirmed');
});

test('players 23-25 land on the waiting list in order', async () => {
  for (let i = 22; i < 25; i += 1) {
    const res = await players[i].client.post(`/api/games/${gameId}/join`);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.status, 'waitlisted');
    assert.equal(res.body.waitlistPosition, i - 21);
  }

  const game = await admin.get(`/api/games/${gameId}`);
  assert.equal(game.body.game.waitlistCount, 3);
});

test('a player can decline the waitlist and be told the game is full', async () => {
  const latecomer = createClient(ctx.baseUrl);
  await latecomer.post('/api/auth/signup', {
    displayName: 'Latecomer', email: 'late@sportsfusion.test',
    password: 'correct-horse-battery', districtId,
  });
  const res = await latecomer.post(`/api/games/${gameId}/join`, { allowWaitlist: false });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'GAME_FULL');
});

test('a cancellation promotes the top of the waitlist in the same request', async () => {
  const res = await players[5].client.post(`/api/games/${gameId}/leave`, { reason: 'work' });
  assert.equal(res.status, 200, res.text);

  assert.ok(res.body.promoted, 'expected someone to be promoted');
  assert.equal(res.body.promoted.playerId, players[22].playerId, 'player 23 should get the spot');
  assert.equal(res.body.promoted.fromPosition, 1);

  const game = await admin.get(`/api/games/${gameId}`);
  assert.equal(game.body.game.confirmedCount, 22, 'game should still be full');
  assert.equal(game.body.game.waitlistCount, 2);
});

test('the waitlist closes ranks with no gaps', async () => {
  const roster = await admin.get(`/api/games/${gameId}/roster`);
  const positions = roster.body.waitlist.map((r) => r.waitlist_position).sort((a, b) => a - b);
  assert.deepEqual(positions, [1, 2], 'positions should renumber contiguously');
});

test('cancelling when not registered is rejected', async () => {
  const res = await players[5].client.post(`/api/games/${gameId}/leave`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'NOT_REGISTERED');
});

// ---------------------------------------------------------------------------

let teamIds;

test('teams are generated, balanced, and each has a keeper', async () => {
  const res = await admin.post(`/api/games/${gameId}/teams/generate`, { seed: 20260828 });
  assert.equal(res.status, 201, res.text);

  assert.equal(res.body.candidatesEvaluated, 352_716);
  assert.equal(res.body.teams.length, 2);
  assert.equal(res.body.teams[0].players.length, 11);
  assert.equal(res.body.teams[1].players.length, 11);

  const gap = Math.abs(res.body.teams[0].strength - res.body.teams[1].strength);
  assert.ok(gap < 30, `strength gap was ${gap}`);

  for (const team of res.body.teams) {
    assert.ok(team.players.some((p) => p.position === 'GK'), `${team.color} has no keeper`);
  }

  teamIds = res.body.teams.map((t) => t.id);
});

test('regenerating with the same seed reproduces the same teams', async () => {
  const first = await admin.get(`/api/games/${gameId}/teams`);
  const firstBlack = first.body.teams
    .find((t) => t.color === 'black').players.map((p) => p.id).sort();

  const again = await admin.post(`/api/games/${gameId}/teams/generate`, { seed: 20260828 });
  assert.equal(again.status, 201, again.text);

  const secondBlack = again.body.teams
    .find((t) => t.color === 'black').players.map((p) => p.id).sort();

  assert.deepEqual(secondBlack, firstBlack, 'same seed must give the same split');
});

test('a different seed gives a different but still balanced split', async () => {
  const res = await admin.post(`/api/games/${gameId}/teams/generate`, { seed: 999 });
  assert.equal(res.status, 201);
  const gap = Math.abs(res.body.teams[0].strength - res.body.teams[1].strength);
  assert.ok(gap < 30, `strength gap was ${gap}`);
  teamIds = res.body.teams.map((t) => t.id);
});

test('an admin swap is applied and flagged as a manual override', async () => {
  const before = await admin.get(`/api/games/${gameId}/teams`);
  const black = before.body.teams.find((t) => t.color === 'black');
  const white = before.body.teams.find((t) => t.color === 'white');

  // Swap an outfield player from each side so the teams stay even.
  const fromBlack = black.players.find((p) => p.position !== 'GK');
  const fromWhite = white.players.find((p) => p.position !== 'GK');

  const res = await admin.post(`/api/games/${gameId}/teams/override`, {
    moves: [
      { playerId: fromBlack.id, toTeamId: white.id },
      { playerId: fromWhite.id, toTeamId: black.id },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.moved, 2);
  assert.equal(res.body.uneven, false, 'a swap should leave teams even');

  const movedPlayer = res.body.teams
    .find((t) => t.color === 'white').players.find((p) => p.id === fromBlack.id);
  assert.ok(movedPlayer, 'player should have moved to white');
  assert.equal(movedPlayer.isManualOverride, true);
});

test('a one-way move is allowed but reported as uneven', async () => {
  const before = await admin.get(`/api/games/${gameId}/teams`);
  const black = before.body.teams.find((t) => t.color === 'black');
  const white = before.body.teams.find((t) => t.color === 'white');
  const mover = black.players.find((p) => p.position !== 'GK');

  const res = await admin.post(`/api/games/${gameId}/teams/override`, {
    moves: [{ playerId: mover.id, toTeamId: white.id }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.uneven, true, 'teams should be reported as uneven');
});

test('the override cost is explained with the generator’s own objective', async () => {
  const res = await admin.get(`/api/games/${gameId}/teams/explain`);
  assert.equal(res.status, 200, res.text);
  const e = res.body.explanation;
  assert.ok(e, 'expected an explanation');
  assert.equal(typeof e.generatedScore, 'number');
  assert.equal(typeof e.currentScore, 'number');
  assert.equal(typeof e.delta, 'number');
  assert.ok(e.currentBreakdown.skill >= 0);
});

// ---------------------------------------------------------------------------

test('the WhatsApp team announcement is generated for copy and paste', async () => {
  const res = await admin.post(`/api/games/${gameId}/announcement`, { kind: 'teams' });
  assert.equal(res.status, 200, res.text);

  assert.match(res.body.body, /TEAMS/);
  assert.match(res.body.body, /⚫ \*BLACK\*/);
  assert.match(res.body.body, /⚪ \*WHITE\*/);
  assert.match(res.body.body, /Please arrive by/);

  // 22 player lines plus headers -- the whole sheet, not a summary.
  const playerLines = res.body.body.split('\n').filter((l) => /^(GK|LB|CB|RB|CDM|CM|LW|ST|RW)\s/.test(l));
  assert.equal(playerLines.length, 22);
});

test('the full announcement names the shareable link, not a WhatsApp group', async () => {
  const res = await admin.post(`/api/games/${gameId}/announcement`, { kind: 'game_full' });
  assert.equal(res.status, 200);
  assert.match(res.body.body, /IS FULL/);
  assert.match(res.body.body, /\/g\//);
});

test('an unknown announcement kind is rejected', async () => {
  const res = await admin.post(`/api/games/${gameId}/announcement`, { kind: 'poem' });
  assert.equal(res.status, 422);
});

// ---------------------------------------------------------------------------

test('the public share link works for an anonymous visitor', async () => {
  const game = await admin.get(`/api/games/${gameId}`);
  const anon = createClient(ctx.baseUrl);
  const res = await anon.get(`/api/games/slug/${game.body.game.slug}`);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.game.id, gameId);
  assert.equal(res.body.roster.confirmed, 22);
});

test('a player profile exposes rating uncertainty as provisional', async () => {
  const res = await players[0].client.get('/api/players/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.player.rating.isProvisional, false, 'sigma 120 is not provisional');
  assert.equal(res.body.player.career.registrations, 1);
});

test('the rating ledger records history rather than overwriting', async () => {
  const target = players[10].playerId;
  await admin.put(`/api/players/${target}/rating`, { mu: 1700, sigma: 90, reason: 'strong run' });

  const res = await admin.get(`/api/players/${target}/rating-history`);
  assert.equal(res.status, 200);
  assert.ok(res.body.history.length >= 2, 'expected the seed and the correction');
  assert.equal(res.body.history[0].mu, 1700);
  assert.equal(res.body.history[0].source, 'admin_override');
});

test('cancelling a game cancels every registration but keeps the record', async () => {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    openImmediately: true,
  });
  const id = created.body.game.id;
  await players[0].client.post(`/api/games/${id}/join`);

  const res = await admin.post(`/api/games/${id}/cancel`, { reason: 'Pitch flooded' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.game.status, 'cancelled');
  assert.equal(res.body.game.confirmedCount, 0);

  const { rows } = await ctx.db.query(
    `SELECT status, cancel_reason FROM registrations WHERE game_id = $1`, [id]
  );
  assert.equal(rows.length, 1, 'the registration row must survive');
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].cancel_reason, 'game_cancelled');
});

test('joining a cancelled game is refused', async () => {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    openImmediately: true,
  });
  await admin.post(`/api/games/${created.body.game.id}/cancel`, { reason: 'no pitch' });

  const res = await players[1].client.post(`/api/games/${created.body.game.id}/join`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'GAME_CANCELLED');
});

test('generating teams for a game that is not full is refused', async () => {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    openImmediately: true,
  });
  await players[2].client.post(`/api/games/${created.body.game.id}/join`);

  const res = await admin.post(`/api/games/${created.body.game.id}/teams/generate`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'GAME_NOT_FULL');
  assert.equal(res.body.error.details.confirmed, 1);
});

test('every domain event that mattered was recorded in the outbox', async () => {
  const { rows } = await ctx.db.query(
    `SELECT event_type, count(*)::int AS n FROM domain_events GROUP BY event_type ORDER BY event_type`
  );
  const byType = Object.fromEntries(rows.map((r) => [r.event_type, r.n]));

  assert.ok(byType.PlayerRegistered >= 22, 'registrations should be recorded');
  assert.ok(byType.PlayerWaitlisted >= 3, 'waitlisting should be recorded');
  assert.equal(byType.PlayerPromotedFromWaitlist, 1);
  assert.ok(byType.GameFilled >= 1);
  assert.ok(byType.TeamsGenerated >= 3);
  assert.ok(byType.TeamsOverridden >= 2);
  assert.ok(byType.GameCancelled >= 2);

  const unprocessed = await ctx.db.query(
    `SELECT count(*)::int AS n FROM domain_events WHERE processed_at IS NULL`
  );
  assert.ok(unprocessed.rows[0].n > 0, 'events should be waiting for the worker');
});

test('cached counters have not drifted from the ledgers', async () => {
  const games = await ctx.db.query('SELECT * FROM reconcile_game_counts()');
  const points = await ctx.db.query('SELECT * FROM reconcile_player_points()');
  assert.equal(games.rows.length, 0, JSON.stringify(games.rows));
  assert.equal(points.rows.length, 0, JSON.stringify(points.rows));
});
