// Concurrency tests for the last slot in a game.
//
// These require a REAL multi-connection Postgres. The in-process PGlite harness used by
// api.test.js serves one connection at a time and therefore cannot demonstrate that
// simultaneous callers are correctly serialised -- it would pass by accident.
//
// Run them with:
//   npm run db:up
//   SF_TEST_DATABASE_URL=postgresql://sportsfusion:sportsfusion_dev@localhost:5432/sportsfusion_test npm run test:concurrency
//
// Without SF_TEST_DATABASE_URL they skip loudly rather than silently passing, because a
// concurrency guarantee that is never exercised is not a guarantee.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const CONNECTION = process.env.SF_TEST_DATABASE_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS_DIR = path.join(root, 'database', 'migrations');

describe('registration concurrency', { skip: CONNECTION ? false : 'SF_TEST_DATABASE_URL is not set' }, () => {
  let pool;
  let registerPlayer;
  let cancelRegistration;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = CONNECTION;
    process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_that_is_long_enough';
    process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_that_is_long_enough';

    const admin = new pg.Client({ connectionString: CONNECTION });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()) {
      await admin.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
    await admin.end();

    ({ pool } = await import('../../database/pool.js'));
    ({ registerPlayer, cancelRegistration } = await import('./service.js'));
  });

  after(async () => { await pool?.end(); });

  /** Fresh district, game, and a pool of players, returning their ids. */
  async function seedGame({ capacity = 22, playerCount = 30, confirmed = 0 }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: d } = await client.query(
        `INSERT INTO districts (slug, name) VALUES ($1, 'Test District') RETURNING id`,
        [`test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
      );
      const districtId = d[0].id;

      const playerIds = [];
      for (let i = 0; i < playerCount; i += 1) {
        const { rows: u } = await client.query(
          `INSERT INTO users (display_name, email) VALUES ($1, $2) RETURNING id`,
          [`Player ${i}`, `conc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}@test.local`]
        );
        const { rows: p } = await client.query(
          `INSERT INTO players (user_id, home_district_id) VALUES ($1, $2) RETURNING id`,
          [u[0].id, districtId]
        );
        playerIds.push(p[0].id);
      }

      const { rows: g } = await client.query(
        `INSERT INTO games (district_id, kickoff_at, capacity, team_size, status, waitlist_capacity)
         VALUES ($1, now() + interval '3 days', $2, $3, 'registration_open', 50) RETURNING id`,
        [districtId, capacity, capacity / 2]
      );
      const gameId = g[0].id;

      for (let i = 0; i < confirmed; i += 1) {
        await client.query(
          `INSERT INTO registrations (game_id, player_id, status) VALUES ($1, $2, 'confirmed')`,
          [gameId, playerIds[i]]
        );
      }

      await client.query('COMMIT');
      return { gameId, districtId, playerIds, usedPlayers: confirmed };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  test('20 simultaneous joins for one remaining slot produce exactly one confirmation', async () => {
    const { gameId, playerIds, usedPlayers } = await seedGame({
      capacity: 22, playerCount: 45, confirmed: 21,
    });
    const contenders = playerIds.slice(usedPlayers, usedPlayers + 20);

    // Fire them all at once. Promise.all does not guarantee true simultaneity, but with
    // 20 independent pool connections hitting the same game row it reliably produces
    // real lock contention.
    const results = await Promise.allSettled(
      contenders.map((playerId) => registerPlayer({ gameId, playerId }))
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(rejected.length, 0, `no caller should error: ${rejected.map((r) => r.reason?.message)}`);

    const confirmed = fulfilled.filter((r) => r.status === 'confirmed');
    const waitlisted = fulfilled.filter((r) => r.status === 'waitlisted');

    assert.equal(confirmed.length, 1, 'exactly one player takes the last slot');
    assert.equal(waitlisted.length, 19, 'everyone else goes to the waiting list');

    // The database must agree with what the callers were told.
    const { rows } = await pool.query(
      'SELECT confirmed_count, waitlist_count, capacity FROM games WHERE id = $1', [gameId]
    );
    assert.equal(rows[0].confirmed_count, 22);
    assert.equal(rows[0].confirmed_count, rows[0].capacity);
    assert.equal(rows[0].waitlist_count, 19);
  });

  test('waitlist positions issued under contention are unique and contiguous', async () => {
    const { gameId, playerIds, usedPlayers } = await seedGame({
      capacity: 22, playerCount: 50, confirmed: 22,
    });
    const contenders = playerIds.slice(usedPlayers, usedPlayers + 25);

    const results = await Promise.all(
      contenders.map((playerId) => registerPlayer({ gameId, playerId }))
    );

    const positions = results.map((r) => r.waitlistPosition).sort((a, b) => a - b);
    assert.deepEqual(
      positions,
      Array.from({ length: 25 }, (_, i) => i + 1),
      'positions must be 1..25 with no duplicates and no gaps'
    );
  });

  test('simultaneous cancellations never promote the same player twice', async () => {
    const { gameId, playerIds, usedPlayers } = await seedGame({
      capacity: 22, playerCount: 40, confirmed: 22,
    });

    // Five on the waiting list.
    const waiters = playerIds.slice(usedPlayers, usedPlayers + 5);
    for (const playerId of waiters) await registerPlayer({ gameId, playerId });

    // Three confirmed players drop out at the same moment.
    const leavers = playerIds.slice(0, 3);
    const results = await Promise.all(
      leavers.map((playerId) => cancelRegistration({ gameId, playerId, reason: 'test' }))
    );

    const promoted = results.map((r) => r.promoted).filter(Boolean);
    assert.equal(promoted.length, 3, 'each freed slot promotes exactly one player');

    const promotedIds = promoted.map((p) => p.playerId);
    assert.equal(new Set(promotedIds).size, 3, 'no player may be promoted twice');

    const { rows } = await pool.query(
      'SELECT confirmed_count, waitlist_count FROM games WHERE id = $1', [gameId]
    );
    assert.equal(rows[0].confirmed_count, 22, 'the game refills to capacity');
    assert.equal(rows[0].waitlist_count, 2);

    const { rows: dupes } = await pool.query(
      `SELECT player_id, count(*) FROM registrations
        WHERE game_id = $1 AND status = 'confirmed'
        GROUP BY player_id HAVING count(*) > 1`,
      [gameId]
    );
    assert.equal(dupes.length, 0, 'no duplicate confirmed registrations');
  });

  test('the database refuses to overbook even if the application asks it to', async () => {
    const { gameId, playerIds } = await seedGame({ capacity: 22, playerCount: 25, confirmed: 22 });

    // Bypass the service entirely and insert a 23rd confirmed row directly. The CHECK
    // constraint is the last line of defence and must hold on its own.
    await assert.rejects(
      pool.query(
        `INSERT INTO registrations (game_id, player_id, status) VALUES ($1, $2, 'confirmed')`,
        [gameId, playerIds[22]]
      ),
      /games_not_overbooked/
    );
  });

  test('cached counters match the ledger after all the contention', async () => {
    const games = await pool.query('SELECT * FROM reconcile_game_counts()');
    assert.equal(games.rows.length, 0, JSON.stringify(games.rows));
  });
});
