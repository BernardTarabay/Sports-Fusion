import pino from 'pino';
import config from '../config/index.js';

// Pretty output is a development nicety. Production logs JSON for the log shipper, and
// tests stay silent so a failing assertion is not buried under request logs.
const level = config.isTest ? 'silent' : config.isProduction ? 'info' : 'debug';
const isDev = config.env === 'development';

export const logger = pino({
  level,
  // Never log a token, a password hash, or a player's phone number in full.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'password_hash',
      '*.password_hash',
      'token',
      '*.token',
      'refreshToken',
      'accessToken',
      'WHATSAPP_ACCESS_TOKEN',
      'GEMINI_API_KEY',
    ],
    censor: '[redacted]',
  },
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
});

export default logger;
