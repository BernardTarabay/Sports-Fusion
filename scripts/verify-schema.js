#!/usr/bin/env node
// Applies every migration to a throwaway in-process Postgres (PGlite) and asserts that
// the schema's core guarantees actually hold.
//
// This is not a substitute for running against the real Postgres in docker-compose --
// it exists so the schema can be proven on any machine, in seconds, with no daemon.
// CI should run both.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(root, 'database', 'migrations');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message.split('\n')[0]}`);
    failed += 1;
  }
}

async function expectRejection(db, sql, params, matcher) {
  try {
    await db.query(sql, params);
  } catch (err) {
    if (matcher && !matcher.test(err.message)) {
      throw new Error(`rejected, but for the wrong reason: ${err.message}`);
    }
    return err;
  }
  throw new Error('expected the database to reject this, but it was accepted');
}

async function main() {
  console.log('\n  applying migrations to in-process postgres\n');

  const db = new PGlite({ extensions: { citext } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS citext;');

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const started = Date.now();
    try {
      await db.exec(sql);
      console.log(`  ok    ${file}  (${Date.now() - started}ms)`);
    } catch (err) {
      console.log(`  FAIL  ${file}`);
      console.log(`\n  ${err.message}\n`);
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------
  await db.exec(`
    INSERT INTO districts (id, slug, name)
      VALUES ('11111111-1111-1111-1111-111111111111', 'beirut', 'Beirut');

    INSERT INTO users (id, display_name, phone_e164)
      SELECT ('22222222-2222-2222-2222-' || lpad(i::text, 12, '0'))::uuid,
             'Player ' || i,
             '+9613' || lpad(i::text, 6, '0')
        FROM generate_series(1, 30) AS i;

    INSERT INTO players (id, user_id, home_district_id, is_goalkeeper)
      SELECT ('33333333-3333-3333-3333-' || lpad(i::text, 12, '0'))::uuid,
             ('22222222-2222-2222-2222-' || lpad(i::text, 12, '0'))::uuid,
             '11111111-1111-1111-1111-111111111111',
             i <= 3
        FROM generate_series(1, 30) AS i;

    INSERT INTO games (id, district_id, kickoff_at, capacity, team_size, status, waitlist_capacity)
      VALUES ('44444444-4444-4444-4444-444444444444',
              '11111111-1111-1111-1111-111111111111',
              now() + interval '3 days', 22, 11, 'registration_open', 10);
  `);

  const playerId = (i) => `33333333-3333-3333-3333-${String(i).padStart(12, '0')}`;
  const GAME = '44444444-4444-4444-4444-444444444444';

  console.log('\n  schema guarantees\n');

  // ---------------------------------------------------------------------------
  await check('confirmed_count tracks registrations', async () => {
    for (let i = 1; i <= 22; i += 1) {
      await db.query(
        `INSERT INTO registrations (game_id, player_id, status) VALUES ($1, $2, 'confirmed')`,
        [GAME, playerId(i)]
      );
    }
    const { rows } = await db.query('SELECT confirmed_count FROM games WHERE id = $1', [GAME]);
    if (rows[0].confirmed_count !== 22) {
      throw new Error(`expected 22, got ${rows[0].confirmed_count}`);
    }
  });

  // THE headline guarantee.
  await check('a 23rd confirmed player is rejected by the database', async () => {
    await expectRejection(
      db,
      `INSERT INTO registrations (game_id, player_id, status) VALUES ($1, $2, 'confirmed')`,
      [GAME, playerId(23)],
      /games_not_overbooked/
    );
  });

  await check('the same player cannot hold two live registrations', async () => {
    await expectRejection(
      db,
      `INSERT INTO registrations (game_id, player_id, status, waitlist_position)
       VALUES ($1, $2, 'waitlisted', 1)`,
      [GAME, playerId(1)],
      /registrations_one_live_per_player/
    );
  });

  await check('two players cannot share a waitlist position', async () => {
    await db.query(
      `INSERT INTO registrations (game_id, player_id, status, waitlist_position)
       VALUES ($1, $2, 'waitlisted', 1)`,
      [GAME, playerId(23)]
    );
    await expectRejection(
      db,
      `INSERT INTO registrations (game_id, player_id, status, waitlist_position)
       VALUES ($1, $2, 'waitlisted', 1)`,
      [GAME, playerId(24)],
      /registrations_unique_waitlist_position/
    );
  });

  await check('a waitlisted row must carry a position', async () => {
    await expectRejection(
      db,
      `INSERT INTO registrations (game_id, player_id, status) VALUES ($1, $2, 'waitlisted')`,
      [GAME, playerId(25)],
      /waitlist_position_consistent/
    );
  });

  await check('cancelling frees a slot and lets someone else in', async () => {
    await db.query(
      `UPDATE registrations SET status = 'cancelled', waitlist_position = NULL, cancelled_at = now()
        WHERE game_id = $1 AND player_id = $2`,
      [GAME, playerId(1)]
    );
    const { rows } = await db.query('SELECT confirmed_count FROM games WHERE id = $1', [GAME]);
    if (rows[0].confirmed_count !== 21) throw new Error(`expected 21, got ${rows[0].confirmed_count}`);

    await db.query(
      `INSERT INTO registrations (game_id, player_id, status) VALUES ($1, $2, 'confirmed')`,
      [GAME, playerId(26)]
    );
    const after = await db.query('SELECT confirmed_count FROM games WHERE id = $1', [GAME]);
    if (after.rows[0].confirmed_count !== 22) throw new Error('slot was not reusable');
  });

  await check('a cancelled player can register again', async () => {
    // Player 1 cancelled above; the partial unique index must permit a fresh row.
    await db.query(
      `INSERT INTO registrations (game_id, player_id, status, waitlist_position)
       VALUES ($1, $2, 'waitlisted', 2)`,
      [GAME, playerId(1)]
    );
  });

  // ---------------------------------------------------------------------------
  await check('rating ledger updates the cached rating on players', async () => {
    await db.query(
      `INSERT INTO player_ratings (player_id, mu, sigma, source, reason)
       VALUES ($1, 1620.5, 120.0, 'admin_seed', 'initial seed')`,
      [playerId(2)]
    );
    const { rows } = await db.query('SELECT rating_mu, rating_sigma FROM players WHERE id = $1', [playerId(2)]);
    if (Number(rows[0].rating_mu) !== 1620.5) throw new Error(`cache not synced: ${rows[0].rating_mu}`);
  });

  await check('an out-of-order backfill row does not move the cache backwards', async () => {
    await db.query(
      `INSERT INTO player_ratings (player_id, mu, sigma, source, effective_at)
       VALUES ($1, 1000.0, 300.0, 'recalculation', now() - interval '30 days')`,
      [playerId(2)]
    );
    const { rows } = await db.query('SELECT rating_mu FROM players WHERE id = $1', [playerId(2)]);
    if (Number(rows[0].rating_mu) !== 1620.5) {
      throw new Error(`stale row overwrote the cache: ${rows[0].rating_mu}`);
    }
  });

  await check('rating history is retained for replay', async () => {
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM player_ratings WHERE player_id = $1', [playerId(2)]
    );
    if (rows[0].n !== 2) throw new Error(`expected 2 ledger rows, got ${rows[0].n}`);
  });

  // ---------------------------------------------------------------------------
  await check('points ledger drives the cached balance', async () => {
    await db.query(
      `INSERT INTO point_transactions (player_id, delta, reason, liability_value)
       VALUES ($1, 100, 'game_played', 0.10), ($1, 250, 'motm', 0.25), ($1, -300, 'redemption', -0.30)`,
      [playerId(3)]
    );
    const { rows } = await db.query('SELECT points_balance FROM players WHERE id = $1', [playerId(3)]);
    if (rows[0].points_balance !== 50) throw new Error(`expected 50, got ${rows[0].points_balance}`);
  });

  await check('reward liability is answerable in one query', async () => {
    const { rows } = await db.query('SELECT * FROM reward_liability');
    if (rows[0].outstanding_points !== 50) {
      throw new Error(`expected 50 outstanding points, got ${rows[0].outstanding_points}`);
    }
  });

  await check('a zero-delta point transaction is rejected', async () => {
    await expectRejection(
      db,
      `INSERT INTO point_transactions (player_id, delta, reason) VALUES ($1, 0, 'manual_grant')`,
      [playerId(3)],
      /nonzero/
    );
  });

  // ---------------------------------------------------------------------------
  await check('only one match result per game may be current', async () => {
    await db.query(
      `INSERT INTO match_results (game_id, scores, team_a_score, team_b_score, played_at)
       VALUES ($1, '{"black":6,"white":4}'::jsonb, 6, 4, now())`,
      [GAME]
    );
    await expectRejection(
      db,
      `INSERT INTO match_results (game_id, scores, team_a_score, team_b_score, played_at)
       VALUES ($1, '{"black":1,"white":0}'::jsonb, 1, 0, now())`,
      [GAME],
      /match_results_one_current/
    );
  });

  await check('a corrected result supersedes rather than overwrites', async () => {
    await db.query(`UPDATE match_results SET is_current = false WHERE game_id = $1`, [GAME]);
    await db.query(
      `INSERT INTO match_results (game_id, scores, team_a_score, team_b_score, played_at, version, correction_reason)
       VALUES ($1, '{"black":6,"white":5}'::jsonb, 6, 5, now(), 2, 'miscounted')`,
      [GAME]
    );
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM match_results WHERE game_id = $1', [GAME]
    );
    if (rows[0].n !== 2) throw new Error('the original result was lost');
  });

  // ---------------------------------------------------------------------------
  await check('domain events are queryable as a work queue', async () => {
    await db.query(
      `INSERT INTO domain_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('GameFilled', 'game', $1, '{"capacity":22}'::jsonb)`,
      [GAME]
    );
    const { rows } = await db.query(
      `SELECT id, event_type FROM domain_events
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND available_at <= now()
        ORDER BY available_at, id`
    );
    if (rows.length !== 1) throw new Error(`expected 1 pending event, got ${rows.length}`);
  });

  await check('an unknown event type is rejected', async () => {
    await expectRejection(
      db,
      `INSERT INTO domain_events (event_type, aggregate_type, aggregate_id)
       VALUES ('PlayerAscended', 'game', $1)`,
      [GAME],
      /domain_events_type_check/
    );
  });

  await check('the same notification cannot be queued twice for one cause', async () => {
    await db.query(
      `INSERT INTO notifications (user_id, channel, template_key, reference_type, reference_id)
       VALUES ($1, 'whatsapp', 'waitlist_promoted', 'game', $2)`,
      ['22222222-2222-2222-2222-000000000005', GAME]
    );
    await expectRejection(
      db,
      `INSERT INTO notifications (user_id, channel, template_key, reference_type, reference_id)
       VALUES ($1, 'whatsapp', 'waitlist_promoted', 'game', $2)`,
      ['22222222-2222-2222-2222-000000000005', GAME],
      /notifications_dedupe_idx/
    );
  });

  // ---------------------------------------------------------------------------
  await check('capacity must divide into whole teams', async () => {
    await expectRejection(
      db,
      `INSERT INTO games (district_id, kickoff_at, capacity, team_size, team_count)
       VALUES ($1, now() + interval '1 day', 21, 11, 2)`,
      ['11111111-1111-1111-1111-111111111111'],
      /games_capacity_divisible/
    );
  });

  await check('a player cannot be on two teams in one game', async () => {
    await db.query(
      `INSERT INTO game_teams (id, game_id, color)
       VALUES ('55555555-5555-5555-5555-555555555551', $1, 'black'),
              ('55555555-5555-5555-5555-555555555552', $1, 'white')`,
      [GAME]
    );
    await db.query(
      `INSERT INTO team_players (team_id, game_id, player_id)
       VALUES ('55555555-5555-5555-5555-555555555551', $1, $2)`,
      [GAME, playerId(4)]
    );
    await expectRejection(
      db,
      `INSERT INTO team_players (team_id, game_id, player_id)
       VALUES ('55555555-5555-5555-5555-555555555552', $1, $2)`,
      [GAME, playerId(4)],
      /team_players_one_team_per_game/
    );
  });

  await check('only one team generation run is active per game', async () => {
    await db.query(
      `INSERT INTO team_generation_runs (game_id, algorithm_version, seed, weights, rating_snapshot)
       VALUES ($1, 'exhaustive_v1', 42, '{}'::jsonb, '[]'::jsonb)`,
      [GAME]
    );
    await expectRejection(
      db,
      `INSERT INTO team_generation_runs (game_id, algorithm_version, seed, weights, rating_snapshot)
       VALUES ($1, 'exhaustive_v1', 43, '{}'::jsonb, '[]'::jsonb)`,
      [GAME],
      /team_generation_runs_one_active/
    );
  });

  await check('a player pair has exactly one canonical history row', async () => {
    await expectRejection(
      db,
      `INSERT INTO player_pair_history (player_a_id, player_b_id) VALUES ($1, $2)`,
      [playerId(9), playerId(8)],
      /player_pair_ordered/
    );
  });

  // ---------------------------------------------------------------------------
  await check('reconciliation finds no drift in the cached counters', async () => {
    const games = await db.query('SELECT * FROM reconcile_game_counts()');
    const points = await db.query('SELECT * FROM reconcile_player_points()');
    if (games.rows.length > 0 || points.rows.length > 0) {
      throw new Error(
        `drift detected: ${JSON.stringify(games.rows)} ${JSON.stringify(points.rows)}`
      );
    }
  });

  await check('reliability is computed, not stored', async () => {
    const { rows } = await db.query(
      'SELECT * FROM player_reliability WHERE player_id = $1', [playerId(1)]
    );
    if (rows.length !== 1) throw new Error('reliability view returned nothing');
    const cols = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'players' AND column_name LIKE '%reliability%'`
    );
    if (cols.rows[0].n !== 0) throw new Error('reliability must not be a stored column on players');
  });

  // ---------------------------------------------------------------------------
  // 021: awards and payments belong to somebody who was actually in the game.
  // ---------------------------------------------------------------------------

  await check('there is exactly one man of the match', async () => {
    // (game_id, award_type, player_id) permitted two players to share it, which is wrong
    // on its own terms AND makes any query joining a game to its award return that
    // fixture twice in a list.
    await db.query(
      `INSERT INTO match_awards (game_id, player_id, award_type)
       VALUES ($1, $2, 'motm')`,
      [GAME, playerId(1)]
    );
    await expectRejection(
      db,
      `INSERT INTO match_awards (game_id, player_id, award_type)
       VALUES ($1, $2, 'motm')`,
      [GAME, playerId(2)],
      /match_awards_one_motm_per_game|duplicate key/i
    );
  });

  await check('other awards may still be shared', async () => {
    // Two players can score the same best goal between them. Only motm is singular.
    await db.query(
      `INSERT INTO match_awards (game_id, player_id, award_type)
       VALUES ($1, $2, 'best_goal'), ($1, $3, 'best_goal')`,
      [GAME, playerId(3), playerId(4)]
    );
  });

  await check('an award cannot name somebody who is not on the roster', async () => {
    // The endpoints take a playerId from the request body. An admin with a stale tab or
    // a copied id could hand the award to somebody who never played.
    await expectRejection(
      db,
      `INSERT INTO match_awards (game_id, player_id, award_type)
       VALUES ($1, $2, 'best_player')`,
      [GAME, playerId(30)],
      /not on the roster/i
    );
  });

  await check('a payment cannot be recorded against somebody who is not on the roster', async () => {
    // Money attributed to the wrong person, with nothing to catch it.
    await expectRejection(
      db,
      `INSERT INTO game_payments (game_id, player_id, amount, currency)
       VALUES ($1, $2, 10, 'USD')`,
      [GAME, playerId(30)],
      /not on the roster/i
    );
  });

  await check('a payment for somebody who IS on the roster is accepted', async () => {
    // The mirror. A constraint that refuses everything passes the test above and breaks
    // the only thing an admin does on the touchline.
    await db.query(
      `INSERT INTO game_payments (game_id, player_id, amount, currency)
       VALUES ($1, $2, 10, 'USD')`,
      [GAME, playerId(1)]
    );
  });

  // ---------------------------------------------------------------------------
  // 022/023: the tactical board is stored, and the lock is a choice.
  // ---------------------------------------------------------------------------

  // Its own game and its own teams. The main fixture has already spent its team colours
  // and put every player on a side, and (game_id, player_id) is unique.
  const BOARD_GAME = '55555555-5555-5555-5555-555555555555';
  await db.query(
    `INSERT INTO games (id, district_id, kickoff_at, capacity, team_size, status)
     VALUES ($1, '11111111-1111-1111-1111-111111111111',
             now() + interval '5 days', 22, 11, 'registration_open')`,
    [BOARD_GAME]
  );
  const { rows: boardTeams } = await db.query(
    `INSERT INTO game_teams (game_id, color) VALUES ($1, 'black'), ($1, 'white')
     RETURNING id, color`,
    [BOARD_GAME]
  );
  const boardTeam = (colour) => boardTeams.find((t) => t.color === colour).id;

  await check('two players cannot stand in the same place', async () => {
    await db.query(
      `INSERT INTO team_players (team_id, game_id, player_id, slot_index)
       VALUES ($1, $2, $3, 4)`,
      [boardTeam('black'), BOARD_GAME, playerId(1)]
    );
    await expectRejection(
      db,
      `INSERT INTO team_players (team_id, game_id, player_id, slot_index)
       VALUES ($1, $2, $3, 4)`,
      [boardTeam('black'), BOARD_GAME, playerId(2)],
      /team_players_one_player_per_slot|duplicate key/i
    );
  });

  await check('any number of players may be waiting to be placed', async () => {
    // NULL means "on this team, not on the board yet" -- a displaced player, or one
    // added by a path that knows nothing about formations. The partial index has to
    // allow more than one of those.
    await db.query(
      `INSERT INTO team_players (team_id, game_id, player_id, slot_index)
       VALUES ($1, $2, $3, NULL), ($1, $2, $4, NULL)`,
      [boardTeam('white'), BOARD_GAME, playerId(3), playerId(4)]
    );
  });

  await check('a match rating has to be a rating', async () => {
    await expectRejection(
      db,
      `INSERT INTO player_match_stats (game_id, player_id, match_rating)
       VALUES ($1, $2, 44)`,
      [GAME, playerId(5)],
      /player_match_stats_rating_range/i
    );
  });

  await check('the team lock is stored, not derived from status', async () => {
    const { rows } = await db.query(
      `SELECT teams_locked FROM games WHERE id = $1`, [GAME]
    );
    if (rows[0].teams_locked !== false) {
      throw new Error('a game should not start out with its team sheet locked');
    }
  });

  // ---------------------------------------------------------------------------
  const tables = await db.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const indexes = await db.query(
    `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public'`
  );

  console.log(`\n  ${tables.rows[0].n} tables, ${indexes.rows[0].n} indexes`);
  console.log(`  ${passed} passed, ${failed} failed\n`);

  await db.close();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
