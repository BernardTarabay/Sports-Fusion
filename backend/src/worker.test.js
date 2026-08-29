// Worker tests.
//
// Lives under backend/src so it shares the PGlite harness, which already boots the API.
// Driving the worker through the real API means the events it consumes are the ones the
// application actually produces, rather than fixtures that agree with the handler by
// construction.

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
    displayName: 'Worker Admin',
    email: 'worker-admin@sportsfusion.test',
    password: 'correct-horse-battery',
  });
  await grantRole(ctx.db, signup.body.user.id, 'owner');
  await admin.post('/api/auth/login', {
    identifier: 'worker-admin@sportsfusion.test', password: 'correct-horse-battery',
  });

  const district = await admin.post('/api/districts', { slug: 'metn', name: 'Metn' });
  districtId = district.body.district.id;

  for (let i = 0; i < 25; i += 1) {
    const client = createClient(ctx.baseUrl);
    await client.post('/api/auth/signup', {
      displayName: `Worker Player ${i}`,
      email: `worker-player${i}@sportsfusion.test`,
      password: 'correct-horse-battery',
      districtId,
    });
    const me = await client.get('/api/players/me');
    await client.patch('/api/players/me', { isGoalkeeper: i < 3 });
    players.push({ client, playerId: me.body.player.id, userId: me.body.player.id });
  }

  // Imported after the harness has set DATABASE_URL, so the worker shares the pool.
  worker = await import('../../worker/src/index.js');
});

after(async () => { await ctx?.stop(); });

const drainEvents = async () => {
  let total = { processed: 0, failed: 0, deadLettered: 0 };
  for (let i = 0; i < 20; i += 1) {
    const r = await worker.dispatchEvents({ batchSize: 50 });
    total = {
      processed: total.processed + r.processed,
      failed: total.failed + r.failed,
      deadLettered: total.deadLettered + r.deadLettered,
    };
    if (r.processed === 0 && r.failed === 0) break;
  }
  return total;
};

// ---------------------------------------------------------------------------

let gameId;

test('the worker drains the outbox left by the API', async () => {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    capacity: 22, teamSize: 11, openImmediately: true,
  });
  gameId = created.body.game.id;

  const before = await ctx.db.query(
    `SELECT count(*)::int AS n FROM domain_events WHERE processed_at IS NULL`
  );
  assert.ok(before.rows[0].n > 0, 'the API should have queued events');

  const stats = await drainEvents();
  assert.ok(stats.processed > 0);
  assert.equal(stats.failed, 0);

  const after = await ctx.db.query(
    `SELECT count(*)::int AS n FROM domain_events WHERE processed_at IS NULL AND dead_lettered_at IS NULL`
  );
  assert.equal(after.rows[0].n, 0, 'the queue should be empty');
});

test('registering queues a confirmation notification', async () => {
  await players[0].client.post(`/api/games/${gameId}/join`);
  await drainEvents();

  const { rows } = await ctx.db.query(
    `SELECT n.template_key, n.channel, n.status
       FROM notifications n
      WHERE n.reference_id = $1 AND n.template_key = 'registration_confirmed'`,
    [gameId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'in_app');
  assert.equal(rows[0].status, 'pending');
});

test('WhatsApp is not used for a player who never opted in', async () => {
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE channel = 'whatsapp'`
  );
  assert.equal(rows[0].n, 0, 'business messages require an explicit opt-in');
});

test('an opted-in player does get a WhatsApp notification', async () => {
  const { rows: userRows } = await ctx.db.query(
    `SELECT user_id FROM players WHERE id = $1`, [players[1].playerId]
  );
  // A WhatsApp opt-in is useless without a number to send to -- the channel refuses
  // permanently rather than retrying, which is what the sender test below relies on.
  await ctx.db.query(
    `UPDATE users SET phone_e164 = '+9613555001' WHERE id = $1`, [userRows[0].user_id]
  );
  await ctx.db.query(
    `INSERT INTO notification_preferences (user_id, channel, category, is_enabled, opted_in_at)
     VALUES ($1, 'whatsapp', 'registration', true, now())`,
    [userRows[0].user_id]
  );

  await players[1].client.post(`/api/games/${gameId}/join`);
  await drainEvents();

  const { rows } = await ctx.db.query(
    `SELECT channel FROM notifications
      WHERE user_id = $1 AND template_key = 'registration_confirmed' ORDER BY channel`,
    [userRows[0].user_id]
  );
  assert.deepEqual(rows.map((r) => r.channel), ['in_app', 'whatsapp']);
});

test('re-processing an event does not duplicate its notification', async () => {
  const before = await ctx.db.query(`SELECT count(*)::int AS n FROM notifications`);

  // Force every processed event back into the queue, as a crashed worker would.
  await ctx.db.query(`UPDATE domain_events SET processed_at = NULL, available_at = now()`);
  await drainEvents();

  const after = await ctx.db.query(`SELECT count(*)::int AS n FROM notifications`);
  assert.equal(after.rows[0].n, before.rows[0].n, 'handlers must be idempotent');
});

test('the notification sender delivers and records the outcome', async () => {
  const stats = await worker.dispatchNotifications({ batchSize: 100 });
  assert.ok(stats.sent > 0, 'expected some notifications to send');

  const { rows } = await ctx.db.query(
    `SELECT status, sent_at, provider_message_id, channel FROM notifications
      WHERE channel = 'whatsapp' AND status = 'sent' LIMIT 1`
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0].sent_at, 'sent_at should be recorded');
  // WhatsApp is disabled in test, so the adapter reports a dry run rather than sending.
  assert.match(rows[0].provider_message_id, /^dry-run-/);
});

test('an unimplemented channel fails permanently instead of retrying forever', async () => {
  const { rows: userRows } = await ctx.db.query(
    `SELECT user_id FROM players WHERE id = $1`, [players[2].playerId]
  );
  await ctx.db.query(
    `INSERT INTO notifications (user_id, channel, template_key, payload, reference_type, reference_id)
     VALUES ($1, 'email', 'registration_confirmed', $2::jsonb, 'game', $3)`,
    [userRows[0].user_id, JSON.stringify({ gameId, kickoffAt: new Date().toISOString() }), gameId]
  );

  const stats = await worker.dispatchNotifications({ batchSize: 10 });
  assert.equal(stats.failed, 1);

  const { rows } = await ctx.db.query(
    `SELECT status, attempts, error FROM notifications WHERE channel = 'email'`
  );
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].attempts, 1, 'a permanent failure must not burn retries');
  assert.match(rows[0].error, /not implemented/);
});

test('a failing handler retries with backoff and then dead-letters', async () => {
  // An event whose aggregate does not exist, pointed at a handler that will throw.
  await ctx.db.query(
    `INSERT INTO domain_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('GameCompleted', 'game', $1, $2::jsonb)`,
    ['00000000-0000-0000-0000-0000000000ff', JSON.stringify({ gameId: '00000000-0000-0000-0000-0000000000ff' })]
  );

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // Clear the backoff so the test does not have to wait out the real interval.
    await ctx.db.query(
      `UPDATE domain_events SET available_at = now()
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL`
    );
    await worker.dispatchEvents({ batchSize: 5 });
  }

  const { rows } = await ctx.db.query(
    `SELECT attempts, dead_lettered_at, last_error FROM domain_events
      WHERE aggregate_id = '00000000-0000-0000-0000-0000000000ff'`
  );
  assert.equal(rows[0].attempts, 5);
  assert.ok(rows[0].dead_lettered_at, 'should be dead-lettered after MAX_ATTEMPTS');
  assert.ok(rows[0].last_error, 'the failure reason must be recorded');
});

test('a dead-lettered event is not retried again', async () => {
  await ctx.db.query(`UPDATE domain_events SET available_at = now() WHERE dead_lettered_at IS NOT NULL`);
  const stats = await worker.dispatchEvents({ batchSize: 10 });
  assert.equal(stats.failed, 0);
  assert.equal(stats.deadLettered, 0);
});

test('waitlist promotion queues the message that matters', async () => {
  for (let i = 2; i < 22; i += 1) await players[i].client.post(`/api/games/${gameId}/join`);
  const waiter = players[22];
  const waited = await waiter.client.post(`/api/games/${gameId}/join`);
  assert.equal(waited.body.status, 'waitlisted');

  await drainEvents();
  await players[3].client.post(`/api/games/${gameId}/leave`);
  await drainEvents();

  const { rows: userRows } = await ctx.db.query(
    `SELECT user_id FROM players WHERE id = $1`, [waiter.playerId]
  );
  const { rows } = await ctx.db.query(
    `SELECT template_key, payload FROM notifications
      WHERE user_id = $1 AND template_key = 'waitlist_promoted'`,
    [userRows[0].user_id]
  );
  assert.equal(rows.length, 1, 'the promoted player must be told');
  assert.equal(rows[0].payload.fromPosition, 1);
});

test('the rendered promotion message reads correctly', async () => {
  const { render } = await import('../../worker/src/notifications/templates.js');
  const rendered = render('waitlist_promoted', {
    kickoffAt: '2026-09-04T18:00:00.000Z',
    venueName: 'Hoops Arena',
    districtName: 'Metn',
    arriveByMinutes: 15,
  });

  assert.match(rendered.body, /A spot opened up/);
  assert.match(rendered.body, /9:00 PM/);
  assert.match(rendered.body, /Hoops Arena/);
  assert.match(rendered.body, /arrive by 8:45 PM/);
  assert.equal(rendered.whatsappTemplate.name, 'waitlist_promoted');
  assert.equal(rendered.whatsappTemplate.variables.length, 3);
});

test('cancelling a game notifies everyone who held a place', async () => {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    openImmediately: true,
  });
  const id = created.body.game.id;
  for (let i = 0; i < 4; i += 1) await players[i].client.post(`/api/games/${id}/join`);
  await drainEvents();

  await admin.post(`/api/games/${id}/cancel`, { reason: 'Pitch flooded' });
  await drainEvents();

  // Four players held a place, so four people must be told. One of them opted into
  // WhatsApp for this category and therefore gets two channels, not two messages.
  const { rows } = await ctx.db.query(
    `SELECT count(DISTINCT user_id)::int AS people, count(*)::int AS messages
       FROM notifications
      WHERE reference_id = $1 AND template_key = 'game_cancelled'`,
    [id]
  );
  assert.equal(rows[0].people, 4, 'everyone who held a place must be told');
  assert.ok(rows[0].messages >= 4);
});

test('the reminder sweep is idempotent', async () => {
  const soon = await admin.post('/api/games', {
    districtId,
    // Inside the 24-hour window, outside the 3-hour one.
    kickoffAt: new Date(Date.now() + 10 * 3_600_000).toISOString(),
    openImmediately: true,
  });
  for (let i = 0; i < 5; i += 1) await players[i].client.post(`/api/games/${soon.body.game.id}/join`);
  await drainEvents();

  const { queueReminders } = await import('../../worker/src/jobs/index.js');
  const first = await queueReminders();
  assert.equal(first, 5, 'one reminder per confirmed player');

  const second = await queueReminders();
  assert.equal(second, 0, 'running the sweep again must queue nothing');

  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE template_key = 'game_reminder_24h'`
  );
  assert.equal(rows[0].n, 5);
});

test('games past kickoff move to in_progress but are never auto-completed', async () => {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 3_600_000).toISOString(),
    openImmediately: true,
  });
  const id = created.body.game.id;
  // Push kickoff into the past, which the API refuses to do directly and rightly so.
  await ctx.db.query(`UPDATE games SET kickoff_at = now() - interval '10 minutes' WHERE id = $1`, [id]);

  const { advanceGameLifecycle } = await import('../../worker/src/jobs/index.js');
  const started = await advanceGameLifecycle();
  assert.ok(started >= 1);

  const { rows } = await ctx.db.query('SELECT status FROM games WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'in_progress');
  assert.notEqual(rows[0].status, 'completed', 'only a human can record a result');
});

test('completing a game awards points exactly once', async () => {
  const created = await admin.post('/api/games', {
    districtId,
    kickoffAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    openImmediately: true,
  });
  const id = created.body.game.id;
  for (let i = 0; i < 6; i += 1) await players[i].client.post(`/api/games/${id}/join`);
  await drainEvents();

  await ctx.db.query(
    `UPDATE registrations SET attendance = 'attended' WHERE game_id = $1 AND status = 'confirmed'`,
    [id]
  );
  await ctx.db.query(
    `INSERT INTO domain_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('GameCompleted', 'game', $1, $2::jsonb)`,
    [id, JSON.stringify({ gameId: id })]
  );
  await drainEvents();

  const first = await ctx.db.query(
    `SELECT count(*)::int AS n, COALESCE(SUM(delta), 0)::int AS total
       FROM point_transactions WHERE reference_id = $1`,
    [id]
  );
  // 6 players x (100 played + 25 on time) = 750
  assert.equal(first.rows[0].total, 750);

  // Replay the event, as an at-least-once queue eventually will.
  await ctx.db.query(
    `UPDATE domain_events SET processed_at = NULL, available_at = now()
      WHERE event_type = 'GameCompleted' AND aggregate_id = $1`,
    [id]
  );
  await drainEvents();

  const second = await ctx.db.query(
    `SELECT count(*)::int AS n, COALESCE(SUM(delta), 0)::int AS total
       FROM point_transactions WHERE reference_id = $1`,
    [id]
  );
  assert.equal(second.rows[0].total, 750, 'a replay must not award points twice');
  assert.equal(second.rows[0].n, first.rows[0].n);
});

test('pair history is recorded once per completed game', async () => {
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM game_pair_history_applied`
  );
  assert.ok(rows[0].n >= 1);

  const { rows: pairs } = await ctx.db.query(
    `SELECT MAX(same_team_count)::int AS worst FROM player_pair_history`
  );
  // Only one game has completed, so no pair can have shared a team more than once.
  assert.ok((pairs[0].worst ?? 0) <= 1, 'a replay must not inflate pair counts');
});

test('a stale sending notification is reclaimed rather than lost', async () => {
  const { rows: userRows } = await ctx.db.query(
    `SELECT user_id FROM players WHERE id = $1`, [players[4].playerId]
  );
  await ctx.db.query(
    `INSERT INTO notifications (user_id, channel, template_key, payload, status, updated_at)
     VALUES ($1, 'in_app', 'registration_confirmed', '{}'::jsonb, 'sending', now() - interval '30 minutes')`,
    [userRows[0].user_id]
  );

  const { reclaimStale } = await import('../../worker/src/notifications/dispatcher.js');
  const reclaimed = await reclaimStale();
  assert.equal(reclaimed, 1);

  const { rows } = await ctx.db.query(
    `SELECT status FROM notifications WHERE error = 'reclaimed after worker restart'`
  );
  assert.equal(rows[0].status, 'pending');
});

test('periodic jobs are not re-run before their interval elapses', async () => {
  const { runDueJobs } = await import('../../worker/src/jobs/index.js');
  await runDueJobs({ force: true });
  const second = await runDueJobs();
  assert.equal(Object.keys(second).length, 0, 'nothing should be due immediately after a run');

  const { rows } = await ctx.db.query(
    `SELECT job_name, run_count, last_success_at FROM job_runs ORDER BY job_name`
  );
  assert.ok(rows.length >= 5, 'every job should have a run record');
  for (const row of rows) assert.ok(row.last_success_at, `${row.job_name} never succeeded`);
});

test('repeated ticks drain both queues to empty', async () => {
  // One tick deliberately processes a bounded batch, so draining is a property of the
  // loop rather than of a single pass. What matters is that it converges.
  let ticks = 0;
  for (; ticks < 20; ticks += 1) {
    const result = await worker.tick();
    const done =
      result.events.processed === 0 &&
      result.events.failed === 0 &&
      result.notifications.sent === 0 &&
      result.notifications.retrying === 0;
    if (done) break;
  }

  assert.ok(ticks < 20, 'the worker should reach a quiet state');

  const events = await ctx.db.query(
    `SELECT count(*)::int AS n FROM domain_events
      WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND available_at <= now()`
  );
  const notifications = await ctx.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE status = 'pending' AND scheduled_for <= now()`
  );
  assert.equal(events.rows[0].n, 0, 'no events left due');
  assert.equal(notifications.rows[0].n, 0, 'no notifications left due');
});

test('an idle tick does no work and reports nothing', async () => {
  const result = await worker.tick();
  assert.equal(result.events.processed, 0);
  assert.equal(result.notifications.sent, 0);
});

test('nothing was dead-lettered except the deliberately broken event', async () => {
  const { rows } = await ctx.db.query(
    `SELECT event_type, count(*)::int AS n FROM domain_events
      WHERE dead_lettered_at IS NOT NULL GROUP BY event_type`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'GameCompleted');
  assert.equal(rows[0].n, 1);
});

test('cached counters survived everything the worker did', async () => {
  const games = await ctx.db.query('SELECT * FROM reconcile_game_counts()');
  const points = await ctx.db.query('SELECT * FROM reconcile_player_points()');
  assert.equal(games.rows.length, 0, JSON.stringify(games.rows));
  assert.equal(points.rows.length, 0, JSON.stringify(points.rows));
});
