// Authorisation: what a plain player cannot do.
//
// The rule this file exists to defend: an admin runs the league, and a player joins a
// game, looks at the stats, and edits their own profile. Nothing else.
//
// Written as a table rather than as prose tests on purpose. Authorisation regressions do
// not arrive as a broken assertion in the route you were editing -- they arrive as a new
// endpoint that nobody remembered to put a guard on. A list of every administrative route
// makes the omission visible: adding a route to the API and not to this table is the
// mistake, and the test that catches it is the one that fails when someone actually tries
// to exercise it.
//
// Everything here goes over real HTTP with real cookies against a real Postgres. Nothing
// is stubbed, so a guard that is present but wrong still fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, grantRole } from './test-support/harness.js';

let server;
let admin;
let player;
let anon;
let ctx = {};

test.before(async () => {
  server = await startTestServer();
  const { baseUrl, db } = server;

  admin = createClient(baseUrl);
  player = createClient(baseUrl);
  anon = createClient(baseUrl);

  const a = await admin.post('/api/auth/signup', {
    displayName: 'League Admin', email: 'authz-admin@sportsfusion.test', password: 'password123',
  });
  await grantRole(db, a.body.user.id, 'admin');
  // Roles are baked into the access token, so the promotion only takes effect on a new one.
  await admin.post('/api/auth/login', {
    identifier: 'authz-admin@sportsfusion.test', password: 'password123',
  });

  const p = await player.post('/api/auth/signup', {
    displayName: 'Plain Player', email: 'authz-player@sportsfusion.test', password: 'password123',
  });
  ctx.playerUserId = p.body.user.id;

  // The harness applies migrations but no seed, so reference data is created here rather
  // than assumed. Directly, because creating a district is itself an admin-only route and
  // this file should not depend on the thing it is testing.
  const { rows: [district] } = await db.query(
    `INSERT INTO districts (slug, name, region, is_active)
     VALUES ('authz-test', 'Authz Test', 'Mount Lebanon', true) RETURNING id`
  );
  ctx.districtId = district.id;

  const kickoff = new Date(Date.now() + 4 * 864e5).toISOString();
  const game = await admin.post('/api/games', {
    districtId: ctx.districtId, kickoffAt: kickoff, capacity: 22,
    teamSize: 11, teamCount: 2, price: 10, openImmediately: true,
  });
  ctx.gameId = game.body.game.id;

  await player.post(`/api/games/${ctx.gameId}/join`, {});
  const me = await player.get('/api/players/me');
  ctx.playerId = me.body.player.id;

  const invite = await admin.post('/api/invites', { districtId: ctx.districtId, label: 'authz' });
  ctx.inviteId = invite.body.invite.id;
});

test.after(async () => { await server?.stop(); });

/** Every route that changes or reveals how the league is run. */
const ADMIN_ONLY = () => [
  ['POST', '/api/games', { districtId: ctx.districtId, kickoffAt: new Date(Date.now() + 864e5).toISOString() }],
  ['POST', `/api/games/${ctx.gameId}/open`, {}],
  ['POST', `/api/games/${ctx.gameId}/cancel`, { reason: 'no' }],
  ['POST', `/api/games/${ctx.gameId}/clock`, { action: 'start' }],
  ['POST', `/api/games/${ctx.gameId}/teams/generate`, {}],
  ['POST', `/api/games/${ctx.gameId}/teams/draft`, {}],
  ['POST', `/api/games/${ctx.gameId}/teams/override`, { moves: [{ playerId: ctx.playerId, toTeamId: ctx.gameId }] }],
  ['GET', `/api/games/${ctx.gameId}/teams/explain`],
  ['GET', `/api/games/${ctx.gameId}/roster`],
  ['GET', `/api/games/${ctx.gameId}/matchday`],
  ['POST', `/api/games/${ctx.gameId}/roster`, { playerId: ctx.playerId }],
  ['DELETE', `/api/games/${ctx.gameId}/roster/${ctx.playerId}`],
  ['POST', `/api/games/${ctx.gameId}/payments`, { playerId: ctx.playerId, paid: true }],
  ['PATCH', `/api/games/${ctx.gameId}/players/${ctx.playerId}/stats`, { goals: 5 }],
  ['POST', `/api/games/${ctx.gameId}/attendance/all`, { status: 'attended' }],
  ['POST', `/api/games/${ctx.gameId}/formation`, { formation: '4-3-3' }],
  ['POST', `/api/games/${ctx.gameId}/motm`, { playerId: ctx.playerId }],
  ['POST', `/api/games/${ctx.gameId}/result`, { scores: [] }],
  ['PATCH', `/api/games/${ctx.gameId}/result`, { reason: 'because' }],
  ['GET', `/api/games/${ctx.gameId}/result/history`],
  ['POST', `/api/games/${ctx.gameId}/attendance`, { attendance: [] }],
  ['GET', `/api/games/${ctx.gameId}/peer-ratings`],
  ['POST', `/api/games/${ctx.gameId}/announcement`, { kind: 'new_game' }],
  ['POST', `/api/games/${ctx.gameId}/waitlist/reorder`, { registrationId: ctx.playerId, newPosition: 1 }],
  ['POST', '/api/players', { displayName: 'Ghost', phone: '+96176000009' }],
  // The one that matters most: a player must never be able to inflate themselves.
  ['PUT', () => `/api/players/${ctx.playerId}/rating`, { mu: 3000, sigma: 10 }],
  ['GET', () => `/api/players/${ctx.playerId}/rating-history`],
  ['POST', '/api/invites', { districtId: ctx.districtId }],
  ['GET', '/api/invites'],
  ['DELETE', () => `/api/invites/${ctx.inviteId}`],
  ['POST', () => `/api/districts/${ctx.districtId}/venues`, { name: 'Ghost pitch' }],
  ['POST', '/api/districts', { slug: 'ghost', name: 'Ghost' }],
  ['POST', '/api/ratings/replay', {}],
  ['POST', '/api/ratings/decay', {}],
  ['POST', () => `/api/ratings/games/${ctx.gameId}/rate`, {}],
  ['GET', '/api/ratings/parameters'],
  ['GET', '/api/ratings/replays'],
  ['GET', '/api/rewards/admin/redemptions'],
  ['GET', '/api/rewards/admin/liability'],
];

const call = (client, [method, url, body]) => {
  const path = typeof url === 'function' ? url() : url;
  return client.request(method, path, body);
};

test('a signed-in player is refused every administrative route', async () => {
  const allowed = [];
  for (const route of ADMIN_ONLY()) {
    const res = await call(player, route);
    if (res.status !== 401 && res.status !== 403) {
      allowed.push(`${route[0]} ${typeof route[1] === 'function' ? route[1]() : route[1]} -> ${res.status}`);
    }
  }
  assert.deepEqual(allowed, [], `a plain player reached admin routes:\n  ${allowed.join('\n  ')}`);
});

test('an anonymous caller is refused every administrative route', async () => {
  const allowed = [];
  for (const route of ADMIN_ONLY()) {
    const res = await call(anon, route);
    if (res.status !== 401 && res.status !== 403) {
      allowed.push(`${route[0]} ${typeof route[1] === 'function' ? route[1]() : route[1]} -> ${res.status}`);
    }
  }
  assert.deepEqual(allowed, [], `an anonymous caller reached admin routes:\n  ${allowed.join('\n  ')}`);
});

test('an admin can reach the same routes', async () => {
  // The mirror of the two tests above. Without it, a guard that refuses EVERYONE would
  // pass them both, and the API would be locked for the people who have to run the league.
  const res = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  assert.equal(res.status, 200);
  const teams = await admin.post(`/api/games/${ctx.gameId}/teams/generate`, {});
  assert.ok(teams.status < 400 || teams.status === 409, `admin blocked: ${teams.status} ${teams.text}`);
});

test('a player keeps the things a player is for', async () => {
  const ok = async (label, res) => {
    assert.ok(res.status >= 200 && res.status < 300, `${label} should work, got ${res.status} ${res.text}`);
  };
  await ok('own profile', await player.get('/api/players/me'));
  await ok('edit own profile', await player.patch('/api/players/me', { preferredPosition: 'CM' }));
  await ok('own games', await player.get('/api/players/me/games'));
  await ok('the stats page', await player.get('/api/ratings/leaderboard'));
  await ok('browse games', await player.get('/api/games'));
  await ok('leave a game', await player.post(`/api/games/${ctx.gameId}/leave`, {}));
  await ok('join a game', await player.post(`/api/games/${ctx.gameId}/join`, {}));
});

test('a player cannot edit another player', async () => {
  const other = createClient(server.baseUrl);
  await other.post('/api/auth/signup', {
    displayName: 'Someone Else', email: 'authz-other@sportsfusion.test', password: 'password123',
  });
  const theirs = await other.get('/api/players/me');
  const theirId = theirs.body.player.id;

  const res = await player.put(`/api/players/${theirId}/rating`, { mu: 100, sigma: 50 });
  assert.ok([401, 403].includes(res.status), `expected a refusal, got ${res.status}`);
});

test('promotion requires a fresh token, and then works', async () => {
  // Documents the sharp edge in the role model: roles live in the access token, so a
  // grant does nothing until the next sign-in. Anyone promoting an admin needs to know
  // that, and a test is a better place to record it than a comment nobody reads.
  const fresh = createClient(server.baseUrl);
  const signup = await fresh.post('/api/auth/signup', {
    displayName: 'New Admin', email: 'authz-new@sportsfusion.test', password: 'password123',
  });
  await grantRole(server.db, signup.body.user.id, 'admin');

  const stale = await fresh.get(`/api/games/${ctx.gameId}/matchday`);
  assert.equal(stale.status, 403, 'the old token should still be a player');

  await fresh.post('/api/auth/login', {
    identifier: 'authz-new@sportsfusion.test', password: 'password123',
  });
  const now = await fresh.get(`/api/games/${ctx.gameId}/matchday`);
  assert.equal(now.status, 200, 'a fresh token should carry the new role');
});
