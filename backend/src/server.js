// HTTP server entry point, with graceful shutdown.

import { createApp } from './app.js';
import config from './config/index.js';
import { logger } from './lib/logger.js';
import { shutdown as closePool } from './database/pool.js';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, env: config.env, web: config.publicWebUrl },
    'sports fusion api listening'
  );
});

// Stop accepting new connections, let in-flight requests finish, then close the pool.
// Killing the process mid-transaction is how a player ends up half-registered.
//
// THE POOL IS CLOSED ON EVERY PATH, INCLUDING THE FORCED ONE.
//
// It used to be closed only inside server.close()'s callback, which does not fire until
// the last keep-alive socket goes away. A browser holding one open meant the ten-second
// timer won, and the timer called process.exit() without touching the pool -- so the
// server's database connections were dropped rather than closed.
//
// Against production Postgres those get reaped eventually. Against the Docker-free dev
// database they do not: PGlite serves a fixed number of connections and a socket that
// dies without a terminate message keeps its slot until the server restarts. So
// `node --watch` -- which SIGTERMs and restarts on every save -- leaked a slot per edit
// and locked the developer out of their own database after about ten of them, with
// "Connection terminated unexpectedly" and nothing to say why.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  let closed = false;
  const releasePool = async () => {
    if (closed) return;
    closed = true;
    try {
      await closePool();
    } catch (poolErr) {
      logger.error({ err: poolErr }, 'error closing database pool');
    }
  };

  const forced = setTimeout(async () => {
    logger.error('graceful shutdown timed out; forcing exit');
    await releasePool();
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(async (err) => {
    if (err) logger.error({ err }, 'error closing server');
    await releasePool();
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });

  // Idle keep-alive sockets are not in-flight work and there is no reason to wait out
  // their timeout for them. Node 18.2+; guarded because the worker shares this shape.
  server.closeIdleConnections?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  shutdown('uncaughtException');
});

export default server;
