// Authorisation across DISTRICT boundaries.
//
// authorization.test.js proves that a plain player cannot reach an administrative route.
// That is the obvious axis, and it was the only one covered -- so the routes that were
// wrong were wrong along the axis nobody was testing.
//
// A district_admin passes `requireAdmin`. Everything after that is what separates the
// admin who runs Metn from the admin who runs Keserwan, and several routes had nothing
// after it:
//
//   * PUT  /api/players/:id/rating          -- rewrite anyone's rating, league-wide.
//                                              Ratings drive the balancer and every
//                                              leaderboard, so this is not a local edit.
//   * DELETE /api/players/:id               -- deactivate any player anywhere.
//   * GET  /api/players/:id/rating-history  -- read it.
//   * GET  /api/admin/actions               -- read every administrative action in the
//                                              league, including other districts'.
//   * GET  /api/invites, DELETE /api/invites/:id
//                                           -- list and revoke another district's
//                                              onboarding links. Creating one was
//                                              already scoped; these were not.
//
// The mirror tests matter as much as the refusals: a guard that refuses everybody passes
// every "must be refused" assertion and quietly locks the district admin out of their
// own district.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, grantRole } from './test-support/harness.js';

let server;
let metnAdmin;   // district_admin for Metn only
let globalAdmin; // admin, everywhere
const ctx = {};

const refused = (res) => [401, 403, 404].includes(res.status);

test.before(async () => {
  server = await startTestServer();
  const { baseUrl, db } = server;

  const { rows: [metn] } = await db.query(
    `INSERT INTO districts (slug, name, region, is_active)
     VALUES ('dz-metn', 'DZ Metn', 'Mount Lebanon', true) RETURNING id`
  );
  const { rows: [keserwan] } = await db.query(
    `INSERT INTO districts (slug, name, region, is_active)
     VALUES ('dz-keserwan', 'DZ Keserwan', 'Mount Lebanon', true) RETURNING id`
  );
  ctx.metnId = metn.id;
  ctx.keserwanId = keserwan.id;

  globalAdmin = createClient(baseUrl);
  const ga = await globalAdmin.post('/api/auth/signup', {
    displayName: 'Global Admin', email: 'dz-global@sportsfusion.test', password: 'password123',
  });
  await grantRole(db, ga.body.user.id, 'admin');
  await globalAdmin.post('/api/auth/login', {
    identifier: 'dz-global@sportsfusion.test', password: 'password123',
  });

  metnAdmin = createClient(baseUrl);
  const ma = await metnAdmin.post('/api/auth/signup', {
    displayName: 'Metn Admin', email: 'dz-metn@sportsfusion.test', password: 'password123',
  });
  await grantRole(db, ma.body.user.id, 'district_admin', ctx.metnId);
  await metnAdmin.post('/api/auth/login', {
    identifier: 'dz-metn@sportsfusion.test', password: 'password123',
  });

  // A player who belongs to Keserwan, created by the global admin.
  const foreign = await globalAdmin.post('/api/players', {
    displayName: 'Keserwan Player', phone: '+96176555001', districtId: ctx.keserwanId,
  });
  ctx.foreignPlayerId = foreign.body.player.id;

  // And one in Metn, so the mirror test has something legitimate to touch.
  const local = await globalAdmin.post('/api/players', {
    displayName: 'Metn Player', phone: '+96176555002', districtId: ctx.metnId,
  });
  ctx.localPlayerId = local.body.player.id;

  // A game in each district.
  const kickoff = () => new Date(Date.now() + 5 * 864e5).toISOString();
  const foreignGame = await globalAdmin.post('/api/games', {
    districtId: ctx.keserwanId, kickoffAt: kickoff(), capacity: 22, teamSize: 11, teamCount: 2,
  });
  ctx.foreignGameId = foreignGame.body.game.id;

  const localGame = await globalAdmin.post('/api/games', {
    districtId: ctx.metnId, kickoffAt: kickoff(), capacity: 22, teamSize: 11, teamCount: 2,
  });
  ctx.localGameId = localGame.body.game.id;

  // An invite into each district.
  const foreignInvite = await globalAdmin.post('/api/invites', {
    districtId: ctx.keserwanId, label: 'keserwan onboarding',
  });
  ctx.foreignInviteId = foreignInvite.body.invite.id;

  const localInvite = await globalAdmin.post('/api/invites', {
    districtId: ctx.metnId, label: 'metn onboarding',
  });
  ctx.localInviteId = localInvite.body.invite.id;
});

test.after(async () => { await server?.stop(); });

test('a district admin cannot touch a player in another district', async () => {
  const attempts = [
    ['PUT', `/api/players/${ctx.foreignPlayerId}/rating`, { mu: 2900, sigma: 10 }],
    ['GET', `/api/players/${ctx.foreignPlayerId}/rating-history`],
    ['DELETE', `/api/players/${ctx.foreignPlayerId}`],
  ];

  const allowed = [];
  for (const [method, url, body] of attempts) {
    const res = await metnAdmin.request(method, url, body);
    if (!refused(res)) allowed.push(`${method} ${url} -> ${res.status}`);
  }
  assert.deepEqual(allowed, [],
    `a Metn admin reached a Keserwan player:\n  ${allowed.join('\n  ')}`);

  // And the rating really did not move.
  const check = await globalAdmin.get(`/api/players/${ctx.foreignPlayerId}/rating-history`);
  assert.equal(check.status, 200);
  assert.ok(
    !check.body.history.some((h) => Number(h.mu) === 2900),
    'the refused rating write must not have landed'
  );
});

test('a district admin CAN administer a player in their own district', async () => {
  const res = await metnAdmin.put(`/api/players/${ctx.localPlayerId}/rating`, {
    mu: 1700, sigma: 80, reason: 'seen them play',
  });
  assert.equal(res.status, 200, `blocked from their own district: ${res.status} ${res.text}`);

  const history = await metnAdmin.get(`/api/players/${ctx.localPlayerId}/rating-history`);
  assert.equal(history.status, 200);
});

test('a district admin cannot run another district\'s game', async () => {
  const attempts = [
    ['GET', `/api/games/${ctx.foreignGameId}/matchday`],
    ['POST', `/api/games/${ctx.foreignGameId}/clock`, { action: 'start' }],
    ['POST', `/api/games/${ctx.foreignGameId}/cancel`, { reason: 'no' }],
    ['DELETE', `/api/games/${ctx.foreignGameId}`],
  ];
  const allowed = [];
  for (const [method, url, body] of attempts) {
    const res = await metnAdmin.request(method, url, body);
    if (!refused(res)) allowed.push(`${method} ${url} -> ${res.status}`);
  }
  assert.deepEqual(allowed, [], `reached another district's game:\n  ${allowed.join('\n  ')}`);
});

test('the audit trail is scoped to the districts an admin actually runs', async () => {
  // The global admin has just created two games, deleted nothing, and rated two players.
  // The Metn admin must see the Metn game's actions and not the Keserwan game's.
  await globalAdmin.post(`/api/games/${ctx.foreignGameId}/open`, {});
  await globalAdmin.post(`/api/games/${ctx.localGameId}/open`, {});
  await globalAdmin.post(`/api/games/${ctx.foreignGameId}/formation`, { formation: '4-3-3' });
  await globalAdmin.post(`/api/games/${ctx.localGameId}/formation`, { formation: '4-4-2' });

  const mine = await metnAdmin.get('/api/admin/actions?limit=200');
  assert.equal(mine.status, 200);

  const entities = mine.body.actions.map((a) => a.entityId);
  assert.ok(
    !entities.includes(ctx.foreignGameId),
    'a Metn admin must not see actions taken on a Keserwan game'
  );

  const all = await globalAdmin.get('/api/admin/actions?limit=200');
  assert.ok(
    all.body.actions.some((a) => a.entityId === ctx.foreignGameId),
    'a global admin must still see everything'
  );
});

test('invites are listed and revoked only within an admin\'s districts', async () => {
  const list = await metnAdmin.get('/api/invites');
  assert.equal(list.status, 200);

  const ids = list.body.invites.map((i) => i.id);
  assert.ok(ids.includes(ctx.localInviteId), 'a district admin must see their own invites');
  assert.ok(
    !ids.includes(ctx.foreignInviteId),
    'a district admin must not see another district\'s invite links'
  );

  const revoke = await metnAdmin.del(`/api/invites/${ctx.foreignInviteId}`);
  assert.ok(refused(revoke), `revoked another district's invite: ${revoke.status}`);

  // Still live, for the district that owns it.
  const stillThere = await globalAdmin.get('/api/invites');
  const foreign = stillThere.body.invites.find((i) => i.id === ctx.foreignInviteId);
  assert.ok(foreign && !foreign.revokedAt, 'the refused revoke must not have landed');

  const ownRevoke = await metnAdmin.del(`/api/invites/${ctx.localInviteId}`);
  assert.equal(ownRevoke.status, 200, 'a district admin must be able to revoke their own');
});

test('a district admin can see their own drafts, and only their own', async () => {
  // Drafts are hidden from the public list. They were hidden from district admins too,
  // who are the people who create them -- so a district admin could open registration on
  // a fixture they had no way to find.
  const draft = await metnAdmin.post('/api/games', {
    districtId: ctx.metnId,
    kickoffAt: new Date(Date.now() + 9 * 864e5).toISOString(),
    capacity: 22, teamSize: 11, teamCount: 2,
  });
  assert.equal(draft.status, 201);
  const draftId = draft.body.game.id;

  const mine = await metnAdmin.get('/api/games?when=all&limit=100');
  assert.equal(mine.status, 200, mine.text);
  assert.ok(
    mine.body.games.some((g) => g.id === draftId),
    'a district admin must see the draft they just created'
  );

  const anon = createClient(server.baseUrl);
  const publicList = await anon.get('/api/games?when=all&limit=100');
  assert.ok(
    !publicList.body.games.some((g) => g.id === draftId),
    'a draft must stay invisible to everyone else'
  );
});
