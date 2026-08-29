#!/usr/bin/env node
// Applies database/migrations/*.sql in filename order, once each, inside a transaction.
//
// Deliberately not a migration framework. Plain .sql files are readable by anyone who
// knows Postgres, diff cleanly in review, and do not tie the schema to a library that
// needs upgrading. The only state is the schema_migrations table.

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
dotenv.config({ path: path.join(root, '.env') });

const MIGRATIONS_DIR = path.join(root, 'database', 'migrations');
const statusOnly = process.argv.includes('--status');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum   TEXT
      );
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    if (statusOnly) {
      console.log('\n  version                          state      checksum');
      console.log('  ' + '-'.repeat(62));
      for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        const checksum = sha256(sql);
        const prior = applied.get(version);
        const state = prior === undefined ? 'pending'
          : prior === checksum ? 'applied'
          : 'CHANGED';
        console.log(`  ${version.padEnd(32)} ${state.padEnd(10)} ${checksum}`);
      }
      console.log('');
      return;
    }

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha256(sql);

      if (applied.has(version)) {
        if (applied.get(version) !== checksum) {
          // An applied migration was edited. Silently ignoring this is how staging and
          // production quietly stop matching.
          console.error(
            `\n  ${version} has been modified since it was applied.\n` +
            `  Applied checksum ${applied.get(version)}, file checksum ${checksum}.\n` +
            `  Write a new migration instead of editing an applied one.\n`
          );
          process.exitCode = 1;
          return;
        }
        continue;
      }

      process.stdout.write(`  applying ${version} ... `);
      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [version, checksum]
        );
        await client.query('COMMIT');
        console.log(`ok (${Date.now() - started}ms)`);
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        console.error(`\n  ${err.message}\n`);
        if (err.position) {
          const line = sql.slice(0, Number(err.position)).split('\n').length;
          console.error(`  near ${version}.sql:${line}\n`);
        }
        process.exitCode = 1;
        return;
      }
    }

    console.log(count === 0 ? '  database is up to date' : `\n  ${count} migration(s) applied`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
