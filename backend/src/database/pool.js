// Postgres connection pool and transaction helper.

import pg from 'pg';
import config from '../config/index.js';
import { logger } from '../lib/logger.js';

// Return DATE and NUMERIC as their natural JS shapes rather than strings where it is
// safe to do so. NUMERIC stays a string by default because it can exceed float64;
// we parse only the columns we know are small, at the call site.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.database.url,
  max: config.database.poolMax ?? (config.isProduction ? 20 : 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // A query that runs longer than this is a bug, not a slow query. The exhaustive
  // balancer runs in the application, not the database.
  statement_timeout: 15_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error');
});

// Say so, loudly, once, at boot.
//
// A pool that cannot reach the database fails lazily: nothing happens until the first
// query, and if that query is inside a health check the whole thing hangs and reports
// nothing. One eager connection at startup turns a silent hang into a line in the log
// that names the host and the reason.
pool.connect()
  .then((client) => {
    const { host, port, database, user } = client.connectionParameters ?? {};
    logger.info({ host, port, database, user }, 'postgres connected');
    client.release();
  })
  .catch((err) => {
    logger.error(
      { err, url: config.database.url?.replace(/:[^:@/]*@/, ':***@') },
      'POSTGRES UNREACHABLE at startup -- the API is up but every request will fail'
    );
  });

export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a transaction, passing it a dedicated client.
 *
 * Retries on serialization failure (40001) and deadlock (40P01). It deliberately does
 * NOT retry on unique-violation or check-violation: those mean the caller lost a race
 * for something genuinely scarce (the last slot in a game), and the caller needs to
 * decide what to do about it, not silently try again.
 */
export async function withTransaction(fn, { retries = 2, isolation } = {}) {
  let attempt = 0;

  for (;;) {
    const client = await pool.connect();
    try {
      await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ err: rollbackErr }, 'rollback failed');
      }

      const retryable = err.code === '40001' || err.code === '40P01';
      if (retryable && attempt < retries) {
        attempt += 1;
        logger.warn({ code: err.code, attempt }, 'retrying transaction');
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function shutdown() {
  await pool.end();
}
