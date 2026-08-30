#!/usr/bin/env node
// A real Postgres for local development, without Docker.
//
// WHY THIS EXISTS
//
// docker-compose is still the right answer in CI and production. It cannot run on this
// machine: WSL2 reports "virtualization is not enabled", which is a BIOS/UEFI setting
// (Intel VT-x / AMD-V) plus the Virtual Machine Platform Windows feature. Neither is
// something a script can turn on.
//
// PGlite is genuine PostgreSQL 17 compiled to WebAssembly -- not an emulation, not a
// SQL-compatible substitute. PGLiteSocketServer puts it behind a TCP socket speaking the
// real wire protocol, so the backend connects with the ordinary `pg` driver and has no
// idea it is talking to anything unusual. Every constraint, trigger, partial index and
// FOR UPDATE SKIP LOCKED in the 15 migrations behaves exactly as it does in production.
// The integration tests have run against this for months.
//
// THE ONE REAL LIMITATION
//
// PGlite serves ONE connection at a time. That is fine for a single developer and it is
// fine for behavioural tests, but it cannot prove that two callers racing for the last
// slot in a game are correctly serialised -- that needs a genuinely concurrent server.
// So DATABASE_POOL_MAX must be 1 here, and concurrency.test.js skips loudly rather than
// passing for the wrong reason. Run that suite against real Postgres before shipping.
//
// Data persists in database/.pgdata (gitignored), so the database survives restarts the
// way a real one does. `npm run db:dev:reset` wipes it.

import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(root, 'database', '.pgdata');
// 5432 is unusable on this machine: Windows reserves ranges around it for Hyper-V/WinNAT
// and binding returns EACCES. A high port avoids the reserved ranges entirely.
const PORT = Number(process.env.PGLITE_PORT ?? 54329);

async function main() {
  if (process.argv.includes('--reset')) {
    await rm(DATA_DIR, { recursive: true, force: true });
    console.log('  wiped ' + path.relative(root, DATA_DIR));
  }

  let db;
  try {
    db = new PGlite(DATA_DIR, { extensions: { citext } });
    await db.waitReady;
  } catch (err) {
    // PGlite aborts on a data directory it cannot recover, and the only thing it says is
    // "Aborted(). Build with -sASSERTIONS for more info." -- which names neither the
    // cause nor the fix. The cause is almost always the process being killed rather than
    // stopped: a real Postgres replays its WAL after that, this does not.
    //
    // The message matters more than it looks. Without it the next step is half an hour
    // of reading WASM stack traces about a database whose entire contents are, by design,
    // reproducible in ten seconds.
    console.error(`\n  The development database at ${path.relative(root, DATA_DIR)} will not open.`);
    console.error('  This happens when the process was killed instead of stopped (Ctrl+C).');
    console.error('\n  It holds nothing that cannot be rebuilt:');
    console.error('    npm run db:dev:reset');
    console.error('    npm run migrate && npm run seed\n');
    console.error(`  (${err.message.split('\n')[0]})\n`);
    process.exit(1);
  }

  await db.exec('CREATE EXTENSION IF NOT EXISTS citext;');

  // maxConnections defaults to 1, which is a trap: a client that dies without closing
  // its socket keeps the only slot, and every later connection is reset until the
  // server restarts. Headroom means a crashed script cannot lock you out of your own
  // database. Queries are queued and executed one at a time regardless -- the extra
  // connections buy availability, not parallelism.
  //
  // 10 was not enough headroom either. `node --watch` restarts the API on every save,
  // and a restart that does not close the pool cleanly leaks a slot -- so roughly ten
  // edits in, every request failed with "Connection terminated unexpectedly" and nothing
  // pointed at the cause. server.js now releases the pool on the forced shutdown path as
  // well, and this is the belt: 64 slots is more edits than one sitting.
  const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1', maxConnections: 64 });
  await server.start();

  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  console.log('');
  console.log('  Postgres (PGlite) listening on 127.0.0.1:' + PORT);
  console.log('  DATABASE_URL=' + url);
  console.log('  data: ' + path.relative(root, DATA_DIR));
  console.log('');
  console.log('  Queries run one at a time. Keep DATABASE_POOL_MAX=1 -- it also keeps');
  console.log('  catching pool-reads-inside-a-transaction bugs, which deadlock for real.');
  console.log('  Ctrl+C to stop.');
  console.log('');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\n  stopping...');
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
