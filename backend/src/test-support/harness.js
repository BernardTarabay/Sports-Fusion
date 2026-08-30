// Integration test harness.
//
// Boots a real Postgres (PGlite) speaking the wire protocol over a local socket, applies
// every migration, then starts the actual Express app against it with the real `pg`
// driver. Nothing is mocked -- the tests exercise the same code path production does.
//
// PGlite serves one connection at a time, so the pool is pinned to a single client. That
// is enough for behavioural tests but NOT for concurrency tests: proving that two callers
// racing for the last slot are correctly serialised needs a real multi-connection
// Postgres. That test belongs in CI against the docker-compose database.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATIONS_DIR = path.join(root, 'database', 'migrations');

let started;

/**
 * Bind the database socket to a port nobody else has.
 *
 * `node --test` runs suites in PARALLEL processes, one per core, and each boots its own
 * harness. This used to be `5000 + random(2000)` with no check, which is a birthday
 * problem: with a handful of suites a collision was unlikely enough to look like it
 * worked, and adding three more made the whole run fail roughly one time in four --
 * every test in the losing suite, with an error nowhere near the cause.
 *
 * A flaky suite is worse than a missing one. People learn to re-run it, and then they
 * re-run it over a real failure too.
 *
 * PGLiteSocketServer keeps its port private, so port 0 is no help: there would be no way
 * to read back what the OS chose. Instead: pick, try, and on EADDRINUSE pick again.
 */
async function listenOnAFreePort(db, attempts = 40) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    // A wide range, and one that avoids the ports the dev database and the API use.
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const socketServer = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
    try {
      await socketServer.start();
      return { port, socketServer };
    } catch (err) {
      lastError = err;
      if (err?.code !== 'EADDRINUSE' && err?.cause?.code !== 'EADDRINUSE') throw err;
      await socketServer.stop().catch(() => {});
    }
  }
  throw new Error(
    `could not find a free port for the test database after ${attempts} attempts`,
    { cause: lastError }
  );
}

/** Boot the database and the app exactly once per test process. */
export async function startTestServer() {
  if (started) return started;

  const db = new PGlite({ extensions: { citext } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS citext;');

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await db.exec(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }

  const { port, socketServer } = await listenOnAFreePort(db);

  // Set config BEFORE importing anything that reads it. dotenv does not override
  // variables that are already present, so these win over .env.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_that_is_long_enough';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_that_is_long_enough';
  process.env.PUBLIC_WEB_URL ||= 'http://localhost:5173';

  const { pool } = await import('../database/pool.js');
  // PGlite handles a single connection; more than one would queue and time out.
  pool.options.max = 1;

  const { createApp } = await import('../app.js');
  const app = createApp();

  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  started = {
    db,
    baseUrl,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
      await socketServer.stop();
      await db.close();
    },
  };

  return started;
}

/**
 * Minimal cookie-aware fetch client, so tests exercise the real httpOnly cookie flow
 * rather than passing bearer tokens the browser would never send.
 */
export function createClient(baseUrl) {
  const jar = new Map();

  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function absorb(res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
  }

  return {
    jar,
    async request(method, url, body) {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(jar.size > 0 ? { cookie: cookieHeader() } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      absorb(res);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
      return { status: res.status, body: json, text };
    },
    get(url) { return this.request('GET', url); },
    post(url, body) { return this.request('POST', url, body ?? {}); },
    put(url, body) { return this.request('PUT', url, body ?? {}); },
    patch(url, body) { return this.request('PATCH', url, body ?? {}); },
    del(url, body) { return this.request('DELETE', url, body ?? {}); },
  };
}

/** Promote a user to a global admin role, bypassing the API. */
export async function grantRole(db, userId, role, districtId = null) {
  await db.query(
    `INSERT INTO user_roles (user_id, role, district_id) VALUES ($1, $2, $3)`,
    [userId, role, districtId]
  );
}
