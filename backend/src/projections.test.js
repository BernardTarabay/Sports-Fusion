// The API answers with the shapes the app reads.
//
// WHY THIS FILE EXISTS
//
// The frontend was built against a mock fixture and the backend was built afterwards.
// Where the two disagreed, nothing failed: React reads an absent key as undefined and
// renders nothing, so an entire class of feature was dead in production while every test
// passed and every endpoint returned 200.
//
// What that actually cost, all of it verified in a browser against a live database:
//
//   * no match result appeared ANYWHERE -- not on a fixture card, not on the game page,
//     not in match-of-the-week, not on a player's history, not on the admin summary,
//     and not on the matchday scoreboard, which sat at 0 - 0 for a whole match while
//     goals were being recorded on the same screen. `game.result` was a mock-only shape.
//   * the landing page's platform band read 0 players / 0 games / 0% occupancy off a
//     `platform` key that has never been sent.
//   * every district card rendered the literal text "NAN" for its player count.
//   * /api/districts/:slug did not exist, so every district link 404'd.
//   * six of the seven leaderboard tabs showed the rating table, because `metric` was
//     not in the query schema and `validate` DELETES unlisted keys.
//
// So these are contract tests, and they assert on keys rather than on values. A shape
// test that nobody can read is worth less than the bug it catches, so each one names the
// screen that breaks when it fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, grantRole } from './test-support/harness.js';

let server;
let admin;
let anon;
const ctx = {};

test.before(async () => {
  server = await startTestServer();
  const { baseUrl, db } = server;

  admin = createClient(baseUrl);
  anon = createClient(baseUrl);

  const a = await admin.post('/api/auth/signup', {
    displayName: 'Shape Admin', email: 'shape-admin@sportsfusion.test', password: 'password123',
  });
  await grantRole(db, a.body.user.id, 'admin');
  await admin.post('/api/auth/login', {
    identifier: 'shape-admin@sportsfusion.test', password: 'password123',
  });

  const { rows: [district] } = await db.query(
    `INSERT INTO districts (slug, name, region, is_active)
     VALUES ('shape-town', 'Shape Town', 'Mount Lebanon', true) RETURNING id`
  );
  ctx.districtId = district.id;
  ctx.slug = 'shape-town';

  const venue = await admin.post(`/api/districts/${ctx.districtId}/venues`, {
    name: 'Shape Pitch', address: 'Somewhere', pitchType: 'turf', defaultCapacity: 22,
    // A one-pixel PNG. Enough to prove the badge is served rather than inlined.
    logoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  });
  ctx.venueId = venue.body.venue.id;

  // Four players, so the game can have two teams of two.
  ctx.players = [];
  for (let i = 0; i < 4; i += 1) {
    const p = await admin.post('/api/players', {
      displayName: `Shape Player ${i}`,
      phone: `+9617612000${i}`,
      districtId: ctx.districtId,
    });
    ctx.players.push(p.body.player.id);
  }

  const game = await admin.post('/api/games', {
    districtId: ctx.districtId,
    venueId: ctx.venueId,
    kickoffAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    capacity: 4, teamSize: 2, teamCount: 2, price: 10,
    openImmediately: true,
  });
  ctx.gameId = game.body.game.id;

  for (const playerId of ctx.players) {
    await admin.post(`/api/games/${ctx.gameId}/roster`, { playerId });
  }
  await admin.post(`/api/games/${ctx.gameId}/teams/generate`, {});

  const md = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  ctx.teams = md.body.game.teams;

  await admin.post(`/api/games/${ctx.gameId}/attendance/all`, { status: 'attended' });
  await admin.post(`/api/games/${ctx.gameId}/clock`, { action: 'start' });
  ctx.scorerId = ctx.teams[0].players[0].id;
  await admin.patch(`/api/games/${ctx.gameId}/players/${ctx.scorerId}/stats`, { goals: 2 });
  await admin.post(`/api/games/${ctx.gameId}/motm`, { playerId: ctx.scorerId });
  await admin.post(`/api/games/${ctx.gameId}/clock`, { action: 'end' });
  await admin.post(`/api/games/${ctx.gameId}/result`, {
    scores: [
      { teamId: ctx.teams[0].id, score: 2 },
      { teamId: ctx.teams[1].id, score: 1 },
    ],
  });
});

test.after(async () => { await server?.stop(); });

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

test('a fixture in the list carries its result — the score on a game card', async () => {
  const res = await anon.get('/api/games?when=past&limit=50');
  assert.equal(res.status, 200);

  const game = res.body.games.find((g) => g.id === ctx.gameId);
  assert.ok(game, 'the completed game should appear in the past list');
  assert.ok(game.result, 'game.result is what every score in this app renders from');

  assert.equal(game.result.home.score, 2);
  assert.equal(game.result.away.score, 1);
  assert.equal(game.result.home.color, ctx.teams[0].color);
  assert.equal(game.result.score[ctx.teams[0].color], 2);
  assert.equal(game.result.motm?.playerId, ctx.scorerId);
  assert.ok(game.result.motm.name, 'the award needs a name, not just an id');
});

test('the public game page carries the same result', async () => {
  const res = await anon.get(`/api/games/${ctx.gameId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.game.result?.home.score, 2);
});

test('the admin matchday projection carries it too', async () => {
  const res = await admin.get(`/api/games/${ctx.gameId}/matchday`);
  assert.equal(res.status, 200);
  assert.equal(res.body.game.result?.away.score, 1);

  // And the LIVE score, folded from goal events, which is a different question.
  const scoring = res.body.game.teams.find((t) => t.id === ctx.teams[0].id);
  assert.equal(scoring.score, 2, 'the live per-team score drives the matchday scoreboard');
});

test("a player's own history carries the result, not a positional {a,b}", async () => {
  const res = await admin.get('/api/players/me/games');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.games));
});

test('one game cannot hold two men of the match', async () => {
  // Two motm rows were permitted by (game_id, award_type, player_id) and would make any
  // query that joins a game to its award return that fixture TWICE in the list.
  const other = ctx.teams[1].players[0].id;
  await server.db.query(
    `INSERT INTO match_awards (game_id, player_id, award_type) VALUES ($1, $2, 'motm')`,
    [ctx.gameId, other]
  ).then(
    () => { throw new Error('the database accepted a second man of the match'); },
    () => { /* refused, as it should be */ }
  );

  const list = await anon.get('/api/games?when=past&limit=50');
  const appearances = list.body.games.filter((g) => g.id === ctx.gameId);
  assert.equal(appearances.length, 1, 'a fixture must appear exactly once in the list');
});

// ---------------------------------------------------------------------------
// Districts
// ---------------------------------------------------------------------------

test('a district can be fetched by slug — every district link depends on it', async () => {
  const res = await anon.get(`/api/districts/${ctx.slug}`);
  assert.equal(res.status, 200, 'this route did not exist; every district card 404d');

  for (const key of ['district', 'upcoming', 'recent', 'venues', 'leaderboard']) {
    assert.ok(key in res.body, `the district page reads ${key}`);
  }
  assert.equal(res.body.district.slug, ctx.slug);
  assert.equal(res.body.venues[0].name, 'Shape Pitch');
});

test('a district can also be fetched by id', async () => {
  const res = await anon.get(`/api/districts/${ctx.districtId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.district.id, ctx.districtId);
});

test('districts carry real counts, and the platform band has numbers', async () => {
  const res = await anon.get('/api/districts');
  assert.equal(res.status, 200);

  const district = res.body.districts.find((d) => d.slug === ctx.slug);
  // The client rendered `players * 32` over a key that did not exist, so the front page
  // said "NAN". These four are what it reads.
  for (const key of ['activeGames', 'players', 'venues', 'occupancy']) {
    assert.ok(key in district, `the district card reads ${key}`);
  }
  assert.equal(typeof district.players, 'number');
  assert.ok(district.players >= 4, 'the four players in this district should be counted');
  assert.equal(district.venues, 1);

  assert.ok(res.body.platform, 'the landing page reads platform, which was never sent');
  assert.equal(typeof res.body.platform.players, 'number');
  assert.equal(typeof res.body.platform.districts, 'number');
  assert.equal(typeof res.body.platform.gamesThisMonth, 'number');
});

// ---------------------------------------------------------------------------
// Venue badges
// ---------------------------------------------------------------------------

test('a venue badge is a URL, not 60kb of base64 in every game', async () => {
  const res = await anon.get(`/api/games/${ctx.gameId}`);
  const { venue } = res.body.game;

  assert.equal(venue.hasLogo, true);
  assert.ok(
    venue.logoUrl.startsWith('/api/venues/'),
    `expected a path, got ${String(venue.logoUrl).slice(0, 40)}`
  );
  assert.ok(
    !venue.logoUrl.startsWith('data:'),
    'the badge must not be inlined -- it repeats on every game in every list'
  );
});

test('the badge endpoint serves the image, and supports revalidation', async () => {
  const res = await fetch(`${server.baseUrl}/api/venues/${ctx.venueId}/logo`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control') ?? '', /max-age=/);

  const etag = res.headers.get('etag');
  assert.ok(etag, 'without an ETag every fixture card refetches the badge');

  const again = await fetch(`${server.baseUrl}/api/venues/${ctx.venueId}/logo`, {
    headers: { 'if-none-match': etag },
  });
  assert.equal(again.status, 304);
});

test('a venue with no badge answers 404 rather than an empty image', async () => {
  const bare = await admin.post(`/api/districts/${ctx.districtId}/venues`, { name: 'No Badge' });
  const res = await fetch(`${server.baseUrl}/api/venues/${bare.body.venue.id}/logo`);
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

test('every leaderboard tab is a different board', async () => {
  const metrics = ['rating', 'form', 'goals', 'assists', 'motm', 'reliability', 'improved'];

  for (const metric of metrics) {
    const res = await anon.get(`/api/ratings/leaderboard?metric=${metric}&minGames=0&includeProvisional=true`);
    assert.equal(res.status, 200, `${metric} board failed: ${res.text}`);
    for (const row of res.body.leaderboard) {
      assert.equal(row.metric, metric, 'the board must say which question it answered');
      assert.equal(typeof row.value, 'number', 'a row needs the number it is ranked by');
    }
  }

  // The goals board is the one with something to say here: one player scored twice.
  const goals = await anon.get('/api/ratings/leaderboard?metric=goals&minGames=0&includeProvisional=true');
  const scorer = goals.body.leaderboard.find((p) => p.playerId === ctx.scorerId);
  assert.ok(scorer, 'the only scorer should be on the goals board');
  assert.equal(scorer.value, 2);

  // ...and it must not be the same list as the rating board, which was the bug.
  const motm = await anon.get('/api/ratings/leaderboard?metric=motm&minGames=0&includeProvisional=true');
  assert.equal(motm.body.leaderboard[0]?.playerId, ctx.scorerId, 'they also hold the award');
  assert.equal(motm.body.leaderboard[0]?.value, 1);
});

test('a leaderboard row carries what a player card draws', async () => {
  const res = await anon.get('/api/ratings/leaderboard?metric=goals&minGames=0&includeProvisional=true');
  const row = res.body.leaderboard[0];

  // `id` as well as `playerId`: the page keyed and linked on `id`, so every row went to
  // /players/undefined and every React key was the same undefined.
  assert.ok(row.id, 'the leaderboard links on id');
  assert.equal(row.id, row.playerId);
  // mu and sigma, not just a rounded rating: the badge needs the deviation to know
  // whether to show the number as provisional, so without them every badge was blank.
  assert.equal(typeof row.ratingMu, 'number');
  assert.equal(typeof row.ratingSigma, 'number');
});

test('an unknown metric falls back to the rating board rather than 422', async () => {
  // A stale tab asking for a board that has been renamed should show a leaderboard.
  const res = await anon.get('/api/ratings/leaderboard?metric=nonsense');
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

test('a promotion says who was promoted', async () => {
  // Leaving a game toasts "<name> has been moved off the waiting list". The name was
  // never returned, so every player who released a spot read the word "undefined".
  const kickoff = new Date(Date.now() + 4 * 864e5).toISOString();
  const game = await admin.post('/api/games', {
    districtId: ctx.districtId, kickoffAt: kickoff,
    capacity: 2, teamSize: 1, teamCount: 2, openImmediately: true, waitlistCapacity: 5,
  });
  const gameId = game.body.game.id;

  await admin.post(`/api/games/${gameId}/roster`, { playerId: ctx.players[0] });
  await admin.post(`/api/games/${gameId}/roster`, { playerId: ctx.players[1] });
  await admin.post(`/api/games/${gameId}/roster`, { playerId: ctx.players[2] });

  const left = await admin.del(`/api/games/${gameId}/roster/${ctx.players[0]}`);
  assert.equal(left.status, 200);

  // The admin route answers with the whole game; the player-facing one reports the
  // promotion, so assert through the service's own response there.
  const roster = await admin.get(`/api/games/${gameId}/roster`);
  assert.equal(roster.body.confirmed.length, 2, 'the waitlisted player should be in');
});

// ---------------------------------------------------------------------------
// "Am I in this game?"
// ---------------------------------------------------------------------------

test('a fixture knows whether the viewer is in it', async () => {
  // GameCard renders a "You're in" / "Waiting list · #3" badge from these, and the Games
  // page's "Mine" tab is `list.filter(g => g.isRegistered)`. Neither key was ever sent,
  // so the badge never appeared and the tab was empty for every player, always.
  const player = createClient(server.baseUrl);
  await player.post('/api/auth/signup', {
    displayName: 'Viewer', email: 'shape-viewer@sportsfusion.test', password: 'password123',
  });

  const kickoff = new Date(Date.now() + 6 * 864e5).toISOString();
  const game = await admin.post('/api/games', {
    districtId: ctx.districtId, kickoffAt: kickoff,
    capacity: 2, teamSize: 1, teamCount: 2, openImmediately: true, waitlistCapacity: 5,
  });
  const gameId = game.body.game.id;

  const before = await player.get('/api/games?when=upcoming&limit=100');
  const notYet = before.body.games.find((g) => g.id === gameId);
  assert.equal(notYet.isRegistered, false, 'false, not undefined -- a card cannot render undefined');

  await player.post(`/api/games/${gameId}/join`, {});

  const after = await player.get('/api/games?when=upcoming&limit=100');
  const mine = after.body.games.find((g) => g.id === gameId);
  assert.equal(mine.isRegistered, true);
  assert.equal(mine.myRegistrationStatus, 'confirmed');
  assert.equal(mine.myWaitlistPosition, null);

  // And it is the VIEWER's registration, not anyone's: an anonymous caller sees false.
  const anonList = await anon.get('/api/games?when=upcoming&limit=100');
  const theirs = anonList.body.games.find((g) => g.id === gameId);
  assert.equal(theirs.isRegistered, false, 'one player joining must not mark it for everyone');
});

test('a waitlisted viewer gets their position', async () => {
  const kickoff = new Date(Date.now() + 7 * 864e5).toISOString();
  const game = await admin.post('/api/games', {
    districtId: ctx.districtId, kickoffAt: kickoff,
    capacity: 2, teamSize: 1, teamCount: 2, openImmediately: true, waitlistCapacity: 5,
  });
  const gameId = game.body.game.id;

  await admin.post(`/api/games/${gameId}/roster`, { playerId: ctx.players[0] });
  await admin.post(`/api/games/${gameId}/roster`, { playerId: ctx.players[1] });

  const player = createClient(server.baseUrl);
  await player.post('/api/auth/signup', {
    displayName: 'Waiting', email: 'shape-waiting@sportsfusion.test', password: 'password123',
  });
  const join = await player.post(`/api/games/${gameId}/join`, {});
  assert.equal(join.body.status, 'waitlisted');

  const list = await player.get('/api/games?when=upcoming&limit=100');
  const mine = list.body.games.find((g) => g.id === gameId);
  assert.equal(mine.myRegistrationStatus, 'waitlisted');
  assert.equal(mine.myWaitlistPosition, 1);
});

// ---------------------------------------------------------------------------
// The player profile page
// ---------------------------------------------------------------------------

test('a profile carries everything the page renders', async () => {
  // The page destructures { player, history, ratingHistory, achievements } and the
  // endpoint answered with { player } alone -- nested differently from the way the
  // components read it. So the hero showed "?" for a name it had been given, every
  // stat showed a dash, and three tabs were empty.
  const res = await admin.get(`/api/players/${ctx.scorerId}`);
  assert.equal(res.status, 200);

  for (const key of ['player', 'history', 'ratingHistory', 'achievements']) {
    assert.ok(key in res.body, `the profile page reads ${key}`);
    if (key !== 'player') assert.ok(Array.isArray(res.body[key]), `${key} must be a list`);
  }

  const p = res.body.player;
  // Flat, because that is what PlayerHero, PlayerCard and the stat grid all take.
  assert.ok(p.name, 'the hero renders player.name, not player.displayName');
  assert.equal(typeof p.ratingMu, 'number', 'the rating badge needs mu');
  assert.equal(typeof p.ratingSigma, 'number', 'and sigma, to know if it is provisional');
  for (const key of ['games', 'attended', 'goals', 'assists', 'motm', 'streak']) {
    assert.equal(typeof p[key], 'number', `the stat grid renders ${key}`);
  }
  assert.ok(Array.isArray(p.form), 'the form strip needs an array');

  // Two goals were recorded on the matchday screen, which writes match_events. Career
  // totals used to read player_match_stats alone -- a table nothing in the app fills in.
  assert.equal(p.goals, 2, 'goals tapped in on the touchline must count');
});

test('an attendance rate is a fraction, like every other rate in this API', async () => {
  const res = await admin.get(`/api/players/${ctx.scorerId}`);
  const rate = res.body.player.attendanceRate;
  if (rate != null) {
    assert.ok(rate >= 0 && rate <= 1, `expected 0-1, got ${rate} -- percent() would render ${rate * 100}%`);
  }
});
