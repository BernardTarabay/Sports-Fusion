// Sports Fusion worker.
//
// Drains the domain event outbox, sends queued notifications, and runs periodic sweeps.
//
// Polling, not LISTEN/NOTIFY. At this volume -- a few hundred events on a busy evening --
// a one-second poll is indistinguishable from push, and it survives a dropped connection
// without needing reconnect-and-resubscribe logic. If the queue ever gets deep enough for
// that to matter, the tick interval is one constant.
//
//   npm start          run continuously
//   npm run tick       run one pass and exit (useful in cron, and in tests)

import config from '@sports-fusion/backend/config';
import { logger } from '@sports-fusion/backend/lib/logger';
import { pool, shutdown as closePool } from '@sports-fusion/backend/database/pool';
import { dispatchEvents, queueDepth } from './events/dispatcher.js';
import { dispatchNotifications, notificationDepth } from './notifications/dispatcher.js';
import { runDueJobs } from './jobs/index.js';

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 1000);
const IDLE_TICK_MS = Number(process.env.WORKER_IDLE_TICK_MS ?? 5000);
const HEARTBEAT_MS = 60_000;

let running = true;
let ticking = false;

/** One full pass: events, then notifications, then any due sweeps. */
export async function tick() {
  // Order matters. Both the event handlers and the periodic sweeps QUEUE notifications,
  // so the sender has to run last -- otherwise everything they queue sits until the next
  // tick, and a reminder that should go out at 9:00 goes out at 9:00:05.
  const events = await dispatchEvents();
  const jobs = await runDueJobs();
  const notifications = await dispatchNotifications();

  return { events, jobs, notifications };
}

async function loop() {
  let lastHeartbeat = 0;

  while (running) {
    ticking = true;
    let didWork = false;

    try {
      const result = await tick();
      didWork =
        result.events.processed > 0 ||
        result.events.failed > 0 ||
        result.notifications.sent > 0 ||
        result.notifications.retrying > 0;

      if (didWork) {
        logger.info(
          { events: result.events, notifications: result.notifications },
          'worker tick'
        );
      }
    } catch (err) {
      // A tick failing is usually the database being briefly unavailable. Log it and
      // keep going; crashing the worker turns a blip into an outage.
      logger.error({ err }, 'worker tick failed');
      await sleep(IDLE_TICK_MS);
    } finally {
      ticking = false;
    }

    if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
      lastHeartbeat = Date.now();
      try {
        const [events, notifications] = await Promise.all([queueDepth(), notificationDepth()]);
        logger.info({ events, notifications }, 'worker heartbeat');

        if (events.dead_lettered > 0) {
          logger.error(
            { deadLettered: events.dead_lettered },
            'events are dead-lettered and need attention'
          );
        }
      } catch (err) {
        logger.warn({ err }, 'heartbeat failed');
      }
    }

    // Back off when idle so an empty queue is not a busy loop.
    await sleep(didWork ? TICK_MS : IDLE_TICK_MS);
  }
}

// Not unref'd: the sleep between ticks is what keeps the worker process alive.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function shutdown(signal) {
  if (!running) return;
  running = false;
  logger.info({ signal }, 'worker shutting down');

  // Let the current tick finish so an event is not left claimed-but-unprocessed.
  const deadline = Date.now() + 15_000;
  while (ticking && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (ticking) logger.warn('tick did not finish in time; exiting anyway');

  await closePool().catch((err) => logger.error({ err }, 'error closing pool'));
  logger.info('worker stopped');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));

// ---------------------------------------------------------------------------

const isEntryPoint = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isEntryPoint) {
  if (process.argv.includes('--once')) {
    tick()
      .then(async (result) => {
        logger.info(result, 'single tick complete');
        await closePool();
        process.exit(0);
      })
      .catch(async (err) => {
        logger.error({ err }, 'tick failed');
        await closePool().catch(() => {});
        process.exit(1);
      });
  } else {
    logger.info(
      { env: config.env, tickMs: TICK_MS, whatsapp: config.whatsapp.enabled },
      'sports fusion worker starting'
    );
    // Fail fast if the database is unreachable, rather than logging errors every tick.
    pool
      .query('SELECT 1')
      .then(loop)
      .catch((err) => {
        logger.fatal({ err }, 'cannot reach the database');
        process.exit(1);
      });
  }
}

export { dispatchEvents, dispatchNotifications, runDueJobs };
