// Express application assembly.
//
// Kept separate from server.js so tests can mount the app without binding a port.

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';

import config from './config/index.js';
import { logger } from './lib/logger.js';
import { healthcheck } from './database/pool.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

import authRoutes from './modules/auth/routes.js';
import gameRoutes from './modules/games/routes.js';
import playerRoutes from './modules/players/routes.js';
import districtRoutes from './modules/districts/routes.js';
import matchdayRoutes from './modules/matchday/routes.js';
import scheduleRoutes from './modules/schedules/routes.js';
import awardRoutes from './modules/awards/routes.js';
import adminRoutes from './modules/admin/routes.js';
import { adminRouter as inviteRoutes, publicRouter as joinRoutes } from './modules/invites/routes.js';
import resultRoutes from './modules/results/routes.js';
import ratingRoutes from './modules/ratings/routes.js';
import rewardRoutes from './modules/rewards/routes.js';

export function createApp() {
  const app = express();

  // Behind a reverse proxy in production, so req.ip must come from X-Forwarded-For or
  // every client shares one rate-limit bucket.
  if (config.isProduction) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, _res, next) => {
    req.id = req.get('x-request-id') ?? randomUUID();
    next();
  });

  app.use(helmet({
    // The API serves JSON, not documents; CSP belongs on whatever serves the frontend.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  }));

  app.use(cors({
    origin: config.publicWebUrl,
    // Required for the httpOnly auth cookies to travel.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }));

  // 512kb, not 100kb. Venue badges are stored inline as data URIs, and the schema
  // permits 400kb of them -- so a 100kb body limit meant any logo between the two was
  // rejected by the body parser BEFORE validation ran, surfacing as a 500 with no
  // explanation instead of the size message the schema was written to give. The two
  // numbers have to agree, and the parser has to be the looser of them.
  app.use(express.json({ limit: '512kb' }));
  app.use(cookieParser());

  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.id,
    autoLogging: { ignore: (req) => req.url === '/health' },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }));

  // Broad ceiling. Per-route limits (auth) are much tighter.
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => config.isTest,
  }));

  // LIVENESS. Is this process running and able to answer?
  //
  // Deliberately touches nothing. This is what a platform should gate a deploy on: a
  // health check that also asks the database means a momentary database problem kills a
  // perfectly healthy service, and -- worse -- a deploy that hangs waiting for one
  // produces no error at all, just silence and a timeout.
  app.get(['/healthz', '/'], (_req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // READINESS. Can it actually serve requests?
  //
  // This one does ask the database, because that is the useful question once the service
  // is up. Bounded, so a database that accepts a connection and then never answers
  // produces a 503 with a reason rather than a request that hangs until the proxy in
  // front gives up -- which is indistinguishable from the process being dead.
  app.get('/health', async (_req, res) => {
    const started = Date.now();
    try {
      const dbOk = await Promise.race([
        healthcheck(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('database did not answer within 8s')), 8_000)
        ),
      ]);
      res.status(dbOk ? 200 : 503).json({
        status: dbOk ? 'ok' : 'degraded',
        database: dbOk ? 'up' : 'down',
        latencyMs: Date.now() - started,
        uptime: Math.round(process.uptime()),
      });
    } catch (err) {
      // The reason, not just the verdict. "database down" with no detail is how an
      // afternoon disappears; the message distinguishes a wrong password from a
      // firewall from a TLS failure.
      logger.error({ err, latencyMs: Date.now() - started }, 'health check: database unreachable');
      res.status(503).json({
        status: 'degraded',
        database: 'down',
        reason: err.message,
        latencyMs: Date.now() - started,
        uptime: Math.round(process.uptime()),
      });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/games', gameRoutes);
  // Also mounted at /api/games: results live under a game but are a separate module.
  // No path collides -- gameRoutes has no /:id/result.
  app.use('/api/games', resultRoutes);
  app.use('/api/games', matchdayRoutes);
  app.use('/api/players', playerRoutes);
  app.use('/api/districts', districtRoutes);
  app.use('/api/ratings', ratingRoutes);
  app.use('/api/rewards', rewardRoutes);
  app.use('/api/schedules', scheduleRoutes);
  app.use('/api/awards', awardRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/invites', inviteRoutes);
  // Public by design: somebody with no account, following a link out of a WhatsApp group.
  app.use('/api/join', joinRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
