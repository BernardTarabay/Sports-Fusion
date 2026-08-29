// Error handling: a 404 for unmatched routes, and the terminal error handler.

import { AppError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import config from '../config/index.js';

export function notFoundHandler(req, _res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
}

// Postgres error codes that map cleanly onto an HTTP response. Anything not listed is a
// bug and becomes a 500, because guessing at the meaning of an unfamiliar constraint
// violation produces confidently wrong error messages.
const PG_ERRORS = {
  '23505': { status: 409, code: 'DUPLICATE', message: 'That already exists' },
  '23503': { status: 409, code: 'REFERENCE_MISSING', message: 'A referenced record does not exist' },
  '23514': { status: 409, code: 'CONSTRAINT_VIOLATION', message: 'That would break a rule of the system' },
  '22P02': { status: 422, code: 'INVALID_INPUT', message: 'One of those values is malformed' },
  '40001': { status: 503, code: 'CONFLICT_RETRY', message: 'Busy right now, please try again' },
};

// Body-parser failures. These happen before any route runs, so nothing downstream can
// give them a sensible message -- and left unmapped they become a 500, which says the
// server is broken when the truth is the request was too big or the JSON was malformed.
const PARSER_ERRORS = {
  'entity.too.large': {
    status: 413, code: 'PAYLOAD_TOO_LARGE',
    message: 'That request is too large. If it is an image, it needs downscaling first.',
  },
  'entity.parse.failed': {
    status: 400, code: 'MALFORMED_JSON', message: 'That request body is not valid JSON',
  },
};

// The one constraint whose violation has a genuinely useful public meaning.
const CONSTRAINT_MESSAGES = {
  games_not_overbooked: { status: 409, code: 'GAME_FULL', message: 'This game is full' },
  registrations_one_live_per_player: {
    status: 409, code: 'ALREADY_REGISTERED', message: 'You are already registered for this game',
  },
};

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, _next) {
  const parser = PARSER_ERRORS[err.type];
  if (parser) {
    return res.status(parser.status).json({ error: { code: parser.code, message: parser.message } });
  }

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our end';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err.code && CONSTRAINT_MESSAGES[err.constraint]) {
    ({ status, code, message } = CONSTRAINT_MESSAGES[err.constraint]);
  } else if (err.code && PG_ERRORS[err.code]) {
    ({ status, code, message } = PG_ERRORS[err.code]);
  } else if (err.type === 'entity.parse.failed') {
    status = 400; code = 'MALFORMED_JSON'; message = 'Request body is not valid JSON';
  }

  const log = { err, requestId: req.id, userId: req.user?.id, path: req.path, code };
  if (status >= 500) logger.error(log, 'request failed');
  else logger.warn(log, 'request rejected');

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      // The stack is for developers on their own machine, never for users.
      ...(config.isProduction ? {} : { stack: err.stack?.split('\n').slice(0, 4) }),
    },
  });
}
