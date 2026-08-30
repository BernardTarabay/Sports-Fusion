// What an admin can actually do from the side of a pitch.
//
// Four controls that the matchday screen has always offered and the backend did not
// support, so each one failed in its own quiet way:
//
//   * Dragging a player onto a position    -- `applyOverride` began with
//     `if (rows[0].team_id === move.toTeamId) continue`, so a move within your own team
//     was a no-op. The board stored nothing about WHERE anyone stood; the pitch inferred
//     it from an array ordered by `assigned_position`, alphabetically. An arrangement
//     survived until the next refetch and then reverted.
//
//   * Dropping onto an EMPTY position      -- with a dense array, slot 7 only exists once
//     seven players do. A squad of five could not spread out across the pitch.
//
//   * The 1-10 match rating slider         -- `rating` was not in the schema, and
//     validate() strips unknown keys before the "nothing to change" refinement runs, so
//     every drag answered 422 and nothing was ever stored.
//
//   * Lock / unlock the team sheet         -- the button posted `{ locked }` to an
//     endpoint that ignores it, and `lockedTeams` was `status IN ('in_progress',
//     'completed')`. The board went read-only the instant a match kicked off, which is
//     exactly when somebody turns an ankle, and the unlock button could not bring it back.
//
// Plus the clock, which was a set of one-way doors: tapping "End" at half time finished
// the match, completed the game, and left no way back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, grantRole } from './test-support/harness.js';

let server;
let admin;
const ctx = {};

const slotsOf = (game, colour) => {
  const team = game.teams.find((t) => t.color === colour);
  return Object.fromEntries(team.players.map((p) => [p.slotIndex, p.id]));
};

test.before(async () => {
  server = await startTestServer();
  const { baseUrl, db } = server;

  admin = createClient(baseUrl);
  const a = await admin.post('/api/auth/signup', {
    displayName: 'Pitch Admin', email: 'pitch@sportsfusion.test', password: 'password123',
  });
  await grantRole(db, a.body.user.id, 'admin');
  await admin.post('/api/auth/login', { identifier: 'pitch@sportsfusion.test', password: 'password123' });

  const { rows: [district] } = await db.query(
    `INSERT INTO districts (slug, name, region, is_active)
     VALUES ('pitch-town', 'Pitch Town', 'Mount Lebanon', true) RETURNING id`
  );
  ctx.districtId = district.id;

  // Six players, two teams of three, so there are three slots a side and room for gaps.
  ctx.players = [];
  for (let i = 0; i < 6; i += 1) {
    const p = await admin.post('/api/players', {
      displayName: `Pitch Player ${i}`, phone: `+9617644000${i}`, districtId: ctx.districtId,
    });
    ctx.players.push(p.body.player.id);
  }

  const game = await admin.post('/api/games', {
    districtId: ctx.districtId,
    kickoffAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    capacity: 6, teamSize: 3, teamCount: 2, openImmediately: true,
  });
  ctx.gameId = game.body.game.id;
  for (const playerId of ctx.players) {
    await admin.post(`/api/games/${ctx.gameId}/roster`, { playerId });
  }
  await admin.post(`/api/games/${ctx.gameId}/teams/generate`, {});

  const md = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  ctx.teams = md.body.game.teams;
});

test.after(async () => { await server?.stop(); });

// ---------------------------------------------------------------------------
// A team sheet before the game is full
//
// The balancer needs exactly team_size * team_count confirmed players and refuses
// anything less, which is right for balancing. It was also the ONLY way for teams to
// exist -- so an admin arranging the board days ahead, with eight of twenty-two people
// signed up, could not place anybody: every drag came back "Only 8 of 22 players are
// confirmed", and picking a formation posted an empty move list and 422'd, silently
// undoing itself. Both are the same missing capability: having teams without claiming
// they are balanced.
// ---------------------------------------------------------------------------

test('a partial roster can still be given two teams', async () => {
  const game = await admin.post('/api/games', {
    districtId: ctx.districtId,
    kickoffAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
    capacity: 6, teamSize: 3, teamCount: 2, openImmediately: true,
  });
  const gameId = game.body.game.id;

  // Three of six. The balancer will not touch this.
  for (const playerId of ctx.players.slice(0, 3)) {
    await admin.post(`/api/games/${gameId}/roster`, { playerId });
  }

  const refused = await admin.post(`/api/games/${gameId}/teams/generate`, {});
  assert.equal(refused.status, 409, 'the balancer still refuses a partial roster');

  const drafted = await admin.post(`/api/games/${gameId}/teams/draft`, {});
  assert.equal(drafted.status, 201);
  assert.equal(drafted.body.teams.length, 2);
  assert.equal(
    drafted.body.teams.flatMap((t) => t.players).length, 3,
    'everybody who joined is on the sheet, and nobody who has not is'
  );
  for (const player of drafted.body.teams.flatMap((t) => t.players)) {
    assert.notEqual(player.slotIndex, null, 'a drafted player stands somewhere');
  }

  ctx.partialGameId = gameId;
});

test('a drafted sheet does not claim to have been balanced', async () => {
  const { rows } = await server.db.query(
    'SELECT run_id FROM game_teams WHERE game_id = $1', [ctx.partialGameId]
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.run_id, null, 'no generation run, because none happened');
  }

  const { rows: runs } = await server.db.query(
    'SELECT id FROM team_generation_runs WHERE game_id = $1', [ctx.partialGameId]
  );
  assert.deepEqual(runs, [], 'and no fabricated score for anyone to read later');
});

test('drafting twice does not produce two team sheets', async () => {
  const again = await admin.post(`/api/games/${ctx.partialGameId}/teams/draft`, {});
  assert.equal(again.status, 200, 'the second call is a no-op, not a conflict');
  assert.equal(again.body.created, false);

  const { rows } = await server.db.query(
    'SELECT id FROM game_teams WHERE game_id = $1', [ctx.partialGameId]
  );
  assert.equal(rows.length, 2, 'still exactly two teams');
});

test('a player can be dropped onto an empty slot on a partial sheet', async () => {
  const before = await admin.get(`/api/games/${ctx.partialGameId}/matchday`);
  const team = before.body.game.teams.find((t) => t.players.length > 0);
  const player = team.players[0];
  const taken = new Set(team.players.map((p) => p.slotIndex));
  const emptySlot = [0, 1, 2].find((i) => !taken.has(i));
  assert.notEqual(emptySlot, undefined, 'a short squad has a gap to aim at');

  const moved = await admin.post(`/api/games/${ctx.partialGameId}/teams/override`, {
    moves: [{ playerId: player.id, toTeamId: team.id, slotIndex: emptySlot }],
  });
  assert.equal(moved.status, 200);

  const after = await admin.get(`/api/games/${ctx.partialGameId}/matchday`);
  const moot = after.body.game.teams
    .flatMap((t) => t.players)
    .find((p) => p.id === player.id);
  assert.equal(moot.slotIndex, emptySlot, 'and they stayed where they were put');
});

test('the formation can be set before the teams are full', async () => {
  const res = await admin.post(`/api/games/${ctx.partialGameId}/formation`, { formation: '3-5-2' });
  assert.equal(res.status, 200);
  assert.equal(res.body.game.formation, '3-5-2');

  const reread = await admin.get(`/api/games/${ctx.partialGameId}/matchday`);
  assert.equal(reread.body.game.formation, '3-5-2', 'and it survives a refetch');
});

test('an empty roster has nothing to draft', async () => {
  const game = await admin.post('/api/games', {
    districtId: ctx.districtId,
    kickoffAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
    capacity: 6, teamSize: 3, teamCount: 2, openImmediately: true,
  });
  const res = await admin.post(`/api/games/${game.body.game.id}/teams/draft`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'EMPTY_ROSTER');
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

test('every player on the sheet has a position on the board', async () => {
  const res = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  for (const team of res.body.game.teams) {
    for (const player of team.players) {
      assert.equal(typeof player.slotIndex, 'number',
        `${player.name} has no slotIndex — the pitch would have to invent one`);
    }
    const slots = team.players.map((p) => p.slotIndex);
    assert.equal(new Set(slots).size, slots.length, 'two players in the same place');
  }
});

test('a move within one team changes where the player stands', async () => {
  const black = ctx.teams.find((t) => t.color === 'black');
  const mover = black.players.find((p) => p.slotIndex === 0);
  const other = black.players.find((p) => p.slotIndex === 2);

  const res = await admin.post(`/api/games/${ctx.gameId}/teams/override`, {
    moves: [
      { playerId: mover.id, toTeamId: black.id, slotIndex: 2 },
      { playerId: other.id, toTeamId: black.id, slotIndex: 0 },
    ],
  });
  assert.equal(res.status, 200);

  const after = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  const placed = slotsOf(after.body.game, 'black');
  assert.equal(placed[2], mover.id, 'the same-team move was discarded by the server');
  assert.equal(placed[0], other.id);
});

test('an empty position is a real destination', async () => {
  // Take somebody off black so a gap exists, then drop a team-mate into it.
  const before = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  const black = before.body.game.teams.find((t) => t.color === 'black');
  const white = before.body.game.teams.find((t) => t.color === 'white');

  const leaving = black.players[0];
  await admin.post(`/api/games/${ctx.gameId}/teams/override`, {
    moves: [{ playerId: leaving.id, toTeamId: white.id }],
  });

  const gapped = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  const nowBlack = gapped.body.game.teams.find((t) => t.color === 'black');
  assert.equal(nowBlack.players.length, 2, 'black should be a player short');

  const taken = new Set(nowBlack.players.map((p) => p.slotIndex));
  const gap = [0, 1, 2].find((i) => !taken.has(i));
  assert.notEqual(gap, undefined, 'a three-slot formation with two players has a gap');

  const stayer = nowBlack.players[0];
  const res = await admin.post(`/api/games/${ctx.gameId}/teams/override`, {
    moves: [{ playerId: stayer.id, toTeamId: nowBlack.id, slotIndex: gap }],
  });
  assert.equal(res.status, 200);

  const after = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  const landed = after.body.game.teams
    .find((t) => t.color === 'black').players.find((p) => p.id === stayer.id);
  assert.equal(landed.slotIndex, gap,
    'dropping onto an empty position did nothing — the old dense-array bug');
});

test('a displaced player is given a place rather than left in limbo', async () => {
  const before = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  const white = before.body.game.teams.find((t) => t.color === 'white');
  const black = before.body.game.teams.find((t) => t.color === 'black');

  const occupied = white.players[0];
  const intruder = black.players[0];

  await admin.post(`/api/games/${ctx.gameId}/teams/override`, {
    moves: [{ playerId: intruder.id, toTeamId: white.id, slotIndex: occupied.slotIndex }],
  });

  const after = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  for (const team of after.body.game.teams) {
    for (const p of team.players) {
      assert.equal(typeof p.slotIndex, 'number', `${p.name} was left unplaced`);
    }
  }
});

test('moving within a team is not recorded as an override', async () => {
  // The override flag is the training signal for inferred relationships. The client
  // sends the whole sheet on every arrangement, so flagging same-team moves would mark
  // all of them as hand-placed and drown the signal.
  const before = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  const team = before.body.game.teams[0];
  const { rows: [wasFlagged] } = await server.db.query(
    `SELECT count(*)::int AS n FROM team_players
      WHERE team_id = $1 AND is_manual_override`, [team.id]
  );

  await admin.post(`/api/games/${ctx.gameId}/teams/override`, {
    moves: team.players.map((p) => ({ playerId: p.id, toTeamId: team.id, slotIndex: p.slotIndex })),
  });

  const { rows: [nowFlagged] } = await server.db.query(
    `SELECT count(*)::int AS n FROM team_players
      WHERE team_id = $1 AND is_manual_override`, [team.id]
  );
  assert.equal(nowFlagged.n, wasFlagged.n, 're-sending the same sheet flagged players as moved');
});

// ---------------------------------------------------------------------------
// The match rating
// ---------------------------------------------------------------------------

test('the match rating slider stores a rating', async () => {
  const playerId = ctx.players[0];
  const res = await admin.patch(`/api/games/${ctx.gameId}/players/${playerId}/stats`, { rating: 8.5 });
  assert.equal(res.status, 200, `the slider still 422s: ${res.text?.slice(0, 200)}`);

  const rated = res.body.game.roster.find((p) => p.playerId === playerId);
  assert.equal(rated.rating, 8.5);

  // And it survives a refetch, which is what "stored" means.
  const again = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  assert.equal(again.body.game.roster.find((p) => p.playerId === playerId).rating, 8.5);
});

test('a match rating is not the Glicko rating', async () => {
  // The engine replays from the ledger, so a human number written into mu would be
  // erased on the next replay. These are different facts and live in different places.
  const playerId = ctx.players[0];
  const profile = await admin.get(`/api/players/${playerId}`);
  assert.notEqual(profile.body.player.ratingMu, 8.5);

  const { rows } = await server.db.query(
    'SELECT match_rating FROM player_match_stats WHERE game_id = $1 AND player_id = $2',
    [ctx.gameId, playerId]
  );
  assert.equal(Number(rows[0].match_rating), 8.5);
});

test('a rating outside 1-10 is refused', async () => {
  const res = await admin.patch(`/api/games/${ctx.gameId}/players/${ctx.players[0]}/stats`, { rating: 44 });
  assert.equal(res.status, 422);
});

// ---------------------------------------------------------------------------
// The clock, and the lock
// ---------------------------------------------------------------------------

test('the team sheet is editable during a match unless the admin locks it', async () => {
  await admin.post(`/api/games/${ctx.gameId}/clock`, { action: 'start' });

  const playing = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  assert.equal(playing.body.game.status, 'in_progress');
  assert.equal(playing.body.game.lockedTeams, false,
    'kicking off must not lock the team sheet — that is when somebody gets injured');

  const locked = await admin.post(`/api/games/${ctx.gameId}/teams/lock`, { locked: true });
  assert.equal(locked.body.game.lockedTeams, true);

  const unlocked = await admin.post(`/api/games/${ctx.gameId}/teams/lock`, { locked: false });
  assert.equal(unlocked.body.game.lockedTeams, false, 'the unlock button must actually unlock');
});

test('a match that was ended by mistake can be restarted', async () => {
  await admin.post(`/api/games/${ctx.gameId}/clock`, { action: 'end' });
  const ended = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  assert.equal(ended.body.game.clock.state, 'finished');
  assert.equal(ended.body.game.status, 'completed');

  const reset = await admin.post(`/api/games/${ctx.gameId}/clock`, { action: 'reset' });
  assert.equal(reset.status, 200, 'there was no way back from a mis-tapped End');
  assert.equal(reset.body.game.clock.state, 'not_started');
  assert.notEqual(reset.body.game.status, 'completed');

  const restarted = await admin.post(`/api/games/${ctx.gameId}/clock`, { action: 'start' });
  assert.equal(restarted.body.game.clock.state, 'first_half');
});

test('a reset rewinds the clock, not the match', async () => {
  // The goals, the roster and the payments are the evening. Only the clock goes back.
  const playerId = ctx.players[0];
  await admin.patch(`/api/games/${ctx.gameId}/players/${playerId}/stats`, { goals: 2 });

  const before = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  const beforeGoals = before.body.game.roster.find((p) => p.playerId === playerId).goals;
  assert.equal(beforeGoals, 2);

  await admin.post(`/api/games/${ctx.gameId}/clock`, { action: 'reset' });

  const after = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  assert.equal(after.body.game.roster.find((p) => p.playerId === playerId).goals, 2,
    'resetting the clock must not erase the goals');
  assert.equal(after.body.game.roster.length, before.body.game.roster.length);
});

test('resetting the clock does not un-cancel a game', async () => {
  const other = await admin.post('/api/games', {
    districtId: ctx.districtId,
    kickoffAt: new Date(Date.now() + 6 * 864e5).toISOString(),
    capacity: 6, teamSize: 3, teamCount: 2, openImmediately: true,
  });
  const id = other.body.game.id;
  for (const playerId of ctx.players) await admin.post(`/api/games/${id}/roster`, { playerId });
  await admin.post(`/api/games/${id}/teams/generate`, {});
  await admin.post(`/api/games/${id}/clock`, { action: 'start' });
  await admin.post(`/api/games/${id}/clock`, { action: 'abandon' });

  const abandoned = await admin.get(`/api/games/${id}/matchday`);
  assert.equal(abandoned.body.game.status, 'cancelled');

  await admin.post(`/api/games/${id}/clock`, { action: 'reset' });
  const after = await admin.get(`/api/games/${id}/matchday`);
  assert.equal(after.body.game.clock.state, 'not_started');
  assert.equal(after.body.game.status, 'cancelled',
    'a deliberately cancelled game must stay cancelled');
});
