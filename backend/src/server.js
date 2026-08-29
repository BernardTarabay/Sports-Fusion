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
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forced = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(async (err) => {
    if (err) logger.error({ err }, 'error closing server');
    try {
      await closePool();
    } catch (poolErr) {
      logger.error({ err: poolErr }, 'error closing database pool');
    }
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });
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
