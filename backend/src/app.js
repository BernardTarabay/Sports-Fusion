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

  app.use(express.json({ limit: '100kb' }));
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

  app.get('/health', async (_req, res) => {
    try {
      const dbOk = await healthcheck();
      res.status(dbOk ? 200 : 503).json({
        status: dbOk ? 'ok' : 'degraded',
        database: dbOk ? 'up' : 'down',
        uptime: Math.round(process.uptime()),
      });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
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
