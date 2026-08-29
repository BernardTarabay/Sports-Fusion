// Authentication middleware.
//
// Reads the access token from the httpOnly cookie, falling back to an Authorization
// header so that mobile clients and scripts are not forced into cookie handling.

import { verifyAccessToken, ACCESS_COOKIE } from '../lib/tokens.js';
import { UnauthorizedError } from '../lib/errors.js';

function extractToken(req) {
  const cookieToken = req.cookies?.[ACCESS_COOKIE];
  if (cookieToken) return cookieToken;

  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  return null;
}

function decode(token) {
  const payload = verifyAccessToken(token);
  return {
    id: payload.sub,
    roles: (payload.roles ?? []).map((r) => ({ role: r.r, districtId: r.d })),
  };
}

/** Requires a valid access token. */
export function authenticate(req, _res, next) {
  const token = extractToken(req);
  if (!token) return next(new UnauthorizedError('Sign in to continue', 'NO_TOKEN'));

  try {
    req.user = decode(token);
    return next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    // TOKEN_EXPIRED is distinct so the client knows to refresh rather than to sign in.
    return next(new UnauthorizedError('Session expired', code));
  }
}

/**
 * Attaches req.user when a valid token is present, but never rejects.
 * Used by public game pages, which render for anyone but say "you are registered" for
 * a signed-in player.
 */
export function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (!token) return next();
  try {
    req.user = decode(token);
  } catch {
    // A bad token on a public route is simply an anonymous visitor.
  }
  return next();
}
