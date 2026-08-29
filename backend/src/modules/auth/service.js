// Authentication: signup, login, refresh rotation, logout.

import { withTransaction, query } from '../../database/pool.js';
import { hashPassword, verifyPasswordConstantTime } from '../../lib/password.js';
import {
  signAccessToken, generateRefreshToken, hashToken, newFamilyId, refreshExpiry,
} from '../../lib/tokens.js';
import { UnauthorizedError, ConflictError, ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

// Exported for the phone sign-in module, which issues sessions the same way.
export async function loadRoles(client, userId) {
  const { rows } = await client.query(
    `SELECT role, district_id FROM user_roles WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return rows.map((r) => ({ role: r.role, districtId: r.district_id }));
}

export async function issueSession(client, user, { userAgent, ipAddress, familyId = newFamilyId() }) {
  const roles = await loadRoles(client, user.id);
  const accessToken = signAccessToken({ userId: user.id, roles });
  const { token: refreshToken, tokenHash } = generateRefreshToken();

  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.id, tokenHash, familyId, userAgent ?? null, ipAddress ?? null, refreshExpiry()]
  );

  return { accessToken, refreshToken, roles };
}

export function publicUser(user, roles) {
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.email ?? null,
    phone: user.phone_e164 ?? null,
    avatarUrl: user.avatar_url ?? null,
    roles,
  };
}

/**
 * Create a user, their player profile, and a first session, atomically.
 * A signup that creates a login but no player profile leaves an account that cannot
 * register for anything, so both happen in one transaction or neither does.
 */
export async function signup({
  displayName, email, phone, password, districtId, context = {},
}) {
  if (!email && !phone) {
    throw new ValidationError('An email address or a phone number is required');
  }

  const passwordHash = await hashPassword(password);

  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id FROM users
        WHERE ($1::citext IS NOT NULL AND email = $1)
           OR ($2::text  IS NOT NULL AND phone_e164 = $2)`,
      [email ?? null, phone ?? null]
    );
    if (existing.rows.length > 0) {
      throw new ConflictError('An account with those details already exists', 'ACCOUNT_EXISTS');
    }

    const { rows: userRows } = await client.query(
      `INSERT INTO users (display_name, email, phone_e164, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, display_name, email, phone_e164, avatar_url`,
      [displayName, email ?? null, phone ?? null, passwordHash]
    );
    const user = userRows[0];

    await client.query(
      `INSERT INTO players (user_id, home_district_id, jersey_name) VALUES ($1, $2, $3)`,
      [user.id, districtId ?? null, displayName]
    );

    await client.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, 'player')`,
      [user.id]
    );

    if (districtId) {
      await client.query(
        `INSERT INTO district_followers (district_id, user_id, is_primary)
         VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
        [districtId, user.id]
      );
    }

    const session = await issueSession(client, user, context);
    return { user: publicUser(user, session.roles), ...session };
  });
}

export async function login({ identifier, password, context = {} }) {
  const { rows } = await query(
    `SELECT id, display_name, email, phone_e164, avatar_url, password_hash, status
       FROM users
      WHERE email = $1::citext OR phone_e164 = $1`,
    [identifier]
  );

  const user = rows[0];
  // Always run the KDF, even when there is no such user, so the response time does not
  // reveal which accounts exist.
  const { valid, needsRehash } = await verifyPasswordConstantTime(password, user?.password_hash);

  if (!user || !valid) throw new UnauthorizedError('Incorrect login details', 'INVALID_CREDENTIALS');
  if (user.status !== 'active') throw new UnauthorizedError('This account is not active', 'ACCOUNT_INACTIVE');

  return withTransaction(async (client) => {
    if (needsRehash) {
      const upgraded = await hashPassword(password);
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, upgraded]);
    }
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    const session = await issueSession(client, user, context);
    return { user: publicUser(user, session.roles), ...session };
  });
}

/**
 * Rotate a refresh token.
 *
 * Presenting a token that has already been revoked means it was replayed -- almost
 * always a stolen token. The whole family is revoked, which logs out every device in
 * that lineage. A legitimate user is inconvenienced; an attacker is evicted.
 */
export async function refresh({ refreshToken, context = {} }) {
  if (!refreshToken) throw new UnauthorizedError('No refresh token', 'NO_REFRESH_TOKEN');
  const tokenHash = hashToken(refreshToken);

  // The lookup happens OUTSIDE the rotation transaction on purpose.
  //
  // Reuse detection has to revoke the whole token family and then reject the request. If
  // both happened inside one transaction, the rejection would roll the revocation back --
  // the attacker would be told "no" while their stolen family stayed alive, which is
  // precisely the situation this mechanism exists to prevent. The revocation must commit
  // on its own before the error is thrown.
  const { rows: found } = await query(
    `SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.revoked_at,
            u.display_name, u.email, u.phone_e164, u.avatar_url, u.status
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`,
    [tokenHash]
  );

  const stored = found[0];
  if (!stored) throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');

  if (stored.revoked_at) {
    await query(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = 'reuse_detected'
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [stored.family_id]
    );
    logger.warn(
      { userId: stored.user_id, familyId: stored.family_id },
      'refresh token reuse detected; family revoked'
    );
    throw new UnauthorizedError('Session expired, please sign in again', 'TOKEN_REUSE_DETECTED');
  }

  if (new Date(stored.expires_at) < new Date()) {
    throw new UnauthorizedError('Session expired, please sign in again', 'REFRESH_TOKEN_EXPIRED');
  }
  if (stored.status !== 'active') {
    throw new UnauthorizedError('This account is not active', 'ACCOUNT_INACTIVE');
  }

  return withTransaction(async (client) => {
    // Re-read under a row lock. Two tabs refreshing at once must not both succeed and
    // issue two live tokens from one parent.
    const { rows: locked } = await client.query(
      `SELECT id, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    if (!locked[0] || locked[0].revoked_at) {
      throw new UnauthorizedError('Session expired, please sign in again', 'TOKEN_REUSE_DETECTED');
    }

    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`,
      [stored.id]
    );

    const user = {
      id: stored.user_id,
      display_name: stored.display_name,
      email: stored.email,
      phone_e164: stored.phone_e164,
      avatar_url: stored.avatar_url,
    };
    const session = await issueSession(client, user, { ...context, familyId: stored.family_id });
    return { user: publicUser(user, session.roles), ...session };
  });
}

/** Log out. `allDevices` revokes every live session, not just this one. */
export async function logout({ refreshToken, userId, allDevices = false }) {
  if (allDevices && userId) {
    await query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout_all'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    return { revoked: 'all' };
  }

  if (!refreshToken) return { revoked: 'none' };

  await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(refreshToken)]
  );
  return { revoked: 'session' };
}

export async function getCurrentUser(userId) {
  const { rows } = await query(
    `SELECT u.id, u.display_name, u.email, u.phone_e164, u.avatar_url,
            p.id AS player_id, p.rating_mu, p.rating_sigma, p.points_balance,
            p.games_attended, p.preferred_position, p.is_goalkeeper, p.home_district_id
       FROM users u
       LEFT JOIN players p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  if (rows.length === 0) throw new UnauthorizedError('Account no longer exists', 'USER_NOT_FOUND');

  const row = rows[0];
  const { rows: roleRows } = await query(
    `SELECT role, district_id FROM user_roles WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );

  return {
    ...publicUser(row, roleRows.map((r) => ({ role: r.role, districtId: r.district_id }))),
    player: row.player_id
      ? {
          id: row.player_id,
          ratingMu: Number(row.rating_mu),
          ratingSigma: Number(row.rating_sigma),
          pointsBalance: row.points_balance,
          gamesAttended: row.games_attended,
          preferredPosition: row.preferred_position,
          isGoalkeeper: row.is_goalkeeper,
          homeDistrictId: row.home_district_id,
        }
      : null,
  };
}
