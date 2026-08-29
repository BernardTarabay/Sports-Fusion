// Access and refresh tokens.
//
// Access token: a short-lived JWT. Stateless, so every request does not hit the database
// just to find out who is calling.
//
// Refresh token: an opaque random string, stored HASHED in `refresh_tokens`. It is not a
// JWT on purpose -- a refresh token must be revocable, and a stateless token cannot be
// revoked. Storing the hash means a database leak does not hand over usable sessions.
//
// Rotation with reuse detection: each refresh issues a new token and revokes the old one,
// within a `family`. If a token that has already been used is presented again, that means
// someone is replaying a stolen token, so the entire family is revoked and every device
// in that lineage is logged out.

import { randomBytes, createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';

const REFRESH_BYTES = 48;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function signAccessToken({ userId, roles }) {
  return jwt.sign(
    {
      sub: userId,
      // Roles are embedded so authorisation does not need a query per request. The
      // 15-minute TTL bounds how long a revoked role stays effective.
      roles: roles.map((r) => ({ r: r.role, d: r.districtId ?? null })),
    },
    config.auth.accessSecret,
    { expiresIn: config.auth.accessTtl, issuer: 'sports-fusion', audience: 'sf-api' }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.auth.accessSecret, {
    issuer: 'sports-fusion',
    audience: 'sf-api',
  });
}

export function generateRefreshToken() {
  const token = randomBytes(REFRESH_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function newFamilyId() {
  return randomUUID();
}

export function refreshExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + config.auth.refreshTtlDays);
  return d;
}

// Cookie options. `secure` is off in development because localhost is served over http;
// everywhere else it is mandatory.
const baseCookie = {
  httpOnly: true,
  secure: config.isProduction,
  sameSite: config.isProduction ? 'strict' : 'lax',
  domain: config.auth.cookieDomain === 'localhost' ? undefined : config.auth.cookieDomain,
  path: '/',
};

export const ACCESS_COOKIE = 'sf_access';
export const REFRESH_COOKIE = 'sf_refresh';

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie, maxAge: 15 * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie,
    // Scoped to the refresh endpoint so the long-lived token is not sent on every request.
    path: '/api/auth',
    maxAge: config.auth.refreshTtlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie, path: '/api/auth' });
}
