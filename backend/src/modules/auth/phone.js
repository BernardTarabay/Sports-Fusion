// Phone sign-in.
//
// The real identity in this community is a phone number. Everyone is already in a
// WhatsApp group, nobody remembers a password for a football app, and half the players
// will be signing in on a borrowed phone at the side of a pitch.
//
// A challenge is keyed by the NUMBER, not by a user. When an unknown number asks for a
// code there is no account yet, and creating one on request would let anyone fill the
// users table by typing numbers -- and would leak, through whether the response said
// "signing in" or "signing up", exactly which numbers are already registered. The
// account is created only after a correct code comes back.

import { randomInt, createHash } from 'node:crypto';
import { withTransaction } from '../../database/pool.js';
import {
  UnauthorizedError, ConflictError, ValidationError, RateLimitError, ServiceUnavailableError,
} from '../../lib/errors.js';
import { sendLoginCode } from '../../integrations/otp/index.js';
import config from '../../config/index.js';
import { issueSession, publicUser, loadRoles } from './service.js';

const CODE_TTL_MINUTES = 10;
const MAX_CODES_PER_WINDOW = 3;
const CODE_WINDOW_MINUTES = 15;

const hashCode = (code) => createHash('sha256').update(code).digest('hex');

/** Six digits, uniformly distributed. randomInt is CSPRNG-backed; Math.random is not. */
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * Send a login code.
 *
 * Returns the same shape whether or not the number has an account. The caller cannot
 * learn who is registered, which is the whole point.
 */
export async function startChallenge({ phone, purpose = 'login', context = {} }) {
  // Say so before spending anything.
  //
  // With no provider there is nowhere for the code to go, and the honest answer is "this
  // is switched off" rather than a challenge row, a rate-limit slot and a cheerful
  // "check your phone" for a message that will never arrive. Outside production the
  // code comes back in the response, so this is only ever reached on a real deploy that
  // was never given WhatsApp or Twilio credentials.
  if (!config.otp.canDeliver && !config.otp.exposeCode) {
    throw new ServiceUnavailableError(
      'Signing in by phone is unavailable at the moment. Try again shortly.',
      'OTP_UNAVAILABLE'
    );
  }

  return withTransaction(async (client) => {
    // Per-number throttle, separate from the per-IP limiter on the route. One stops a
    // single attacker spraying many numbers; this stops many attackers, or one behind a
    // rotating proxy, hammering one person's phone with messages at 3am.
    const { rows: [recent] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM auth_challenges
        WHERE phone_e164 = $1 AND created_at > now() - make_interval(mins => $2)`,
      [phone, CODE_WINDOW_MINUTES]
    );
    if (recent.n >= MAX_CODES_PER_WINDOW) {
      throw new RateLimitError('Too many codes requested for that number. Try again in a few minutes.');
    }

    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

    // One live challenge per number: asking again supersedes the last, so an older code
    // still sitting in the chat cannot be used. auth_challenges_one_live enforces it.
    await client.query(
      `UPDATE auth_challenges SET consumed_at = now()
        WHERE phone_e164 = $1 AND consumed_at IS NULL`,
      [phone]
    );
    await client.query(
      `INSERT INTO auth_challenges (phone_e164, code_hash, purpose, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [phone, hashCode(code), purpose, expiresAt,
        context.ipAddress ?? null, context.userAgent?.slice(0, 500) ?? null]
    );

    const sent = await sendLoginCode({ phone, code, ttlMinutes: CODE_TTL_MINUTES });

    return {
      expiresAt,
      expiresInSeconds: CODE_TTL_MINUTES * 60,
      delivered: sent.delivered,
      // Belt and braces. sendLoginCode already withholds this outside development; the
      // second gate is here because this is the object that goes on the wire, and a
      // future provider returning a devCode by accident must not be able to leak one.
      ...(config.otp.exposeCode && sent.devCode ? { devCode: sent.devCode } : {}),
    };
  });
}

/**
 * Consume a challenge, or throw.
 *
 * WHY THIS COMMITS BEFORE IT THROWS
 *
 * The obvious shape -- increment `attempts`, then throw -- does not work, and fails
 * silently in the worst direction. The throw rolls the transaction back, and the rollback
 * undoes the increment along with it. The counter never moves, the cap never bites, and a
 * six-digit code can be guessed forever. It looks completely correct in review and the
 * only way to notice is to actually make five wrong guesses and then a right one.
 *
 * (The refresh-token family revocation had exactly this bug, for exactly this reason.)
 *
 * So the transaction records the outcome and returns it; the throw happens outside, after
 * the commit. Every failure raises the same sentence -- no challenge, expired, wrong
 * code, out of attempts -- because the differences are only useful to somebody guessing.
 */
async function consume(phone, code, purpose, { spend = true } = {}) {
  const outcome = await withTransaction(async (client) => {
    const { rows: [challenge] } = await client.query(
      `SELECT * FROM auth_challenges
        WHERE phone_e164 = $1 AND purpose = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`,
      [phone, purpose]
    );

    if (!challenge) return { ok: false };

    if (new Date(challenge.expires_at) < new Date()) {
      await client.query(`UPDATE auth_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);
      return { ok: false };
    }

    if (hashCode(code) !== challenge.code_hash) {
      // Burn the challenge on the final allowed attempt, so a wrong last guess cannot be
      // followed by a lucky right one.
      const spent = challenge.attempts + 1 >= challenge.max_attempts;
      await client.query(
        `UPDATE auth_challenges
            SET attempts = attempts + 1,
                consumed_at = CASE WHEN $2 THEN now() ELSE consumed_at END
          WHERE id = $1`,
        [challenge.id, spent]
      );
      return { ok: false };
    }

    // `spend: false` leaves a CORRECT code live. verifyChallenge needs that: it cannot
    // know whether the number is new until after the code checks out, and burning it
    // there would mean a first-time player has to request a second code purely to type
    // their name. The code stays single-use -- it is spent in the same transaction that
    // creates the account, so if that fails it is still usable, which is the behaviour
    // you want anyway.
    if (spend) {
      await client.query(`UPDATE auth_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);
    }
    return { ok: true, challenge };
  });

  if (!outcome.ok) throw new UnauthorizedError('That code is not right, or it has expired');
  return outcome.challenge;
}

/**
 * Prove the number, without signing anyone in.
 *
 * The invite flow needs the verification and the account creation to be separable: the
 * code proves the phone, then claimInvite decides what to do with it. Exported so that
 * step cannot be skipped -- an invite link alone must never be able to create an account
 * against a number its holder does not control.
 */
export async function consumeForSignup({ phone, code }) {
  await consume(phone, code, 'login');
  return { phone, verified: true };
}

/**
 * Check a code and sign the person in, creating the account if this is their first time.
 *
 * `displayName` is used only when the account does not exist. An existing player cannot
 * be renamed by whoever is holding the phone this minute.
 */
export async function verifyChallenge({ phone, code, displayName, districtId, context = {} }) {
  // Checked outside the account transaction, because a wrong code has to increment the
  // attempt counter in a transaction that COMMITS -- see consume(). Not spent yet though:
  // whether this is a sign-in or a sign-up is not known until the number is looked up.
  const challenge = await consume(phone, code, 'login', { spend: false });

  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id, display_name, email, phone_e164, avatar_url FROM users WHERE phone_e164 = $1`,
      [phone]
    );

    let user = existing[0];
    let created = false;

    if (!user) {
      if (!displayName) {
        // The code was right, so the number is proven -- but there is nobody to sign in
        // as yet. The client collects a name and calls back. Its own code, because this
        // is the one branch the UI has to react to rather than display, and by this point
        // the caller has already demonstrated they hold the number, so it leaks nothing.
        throw new ValidationError(
          'Tell us your name to finish setting up your account', undefined, 'NAME_REQUIRED'
        );
      }
      const { rows: [fresh] } = await client.query(
        `INSERT INTO users (display_name, phone_e164, phone_verified_at)
         VALUES ($1, $2, now())
         RETURNING id, display_name, email, phone_e164, avatar_url`,
        [displayName.trim(), phone]
      );
      user = fresh;
      created = true;

      await client.query(
        `INSERT INTO players (user_id, home_district_id, jersey_name, joined_via)
         VALUES ($1, $2, $3, 'self_signup')`,
        [user.id, districtId ?? null, displayName.trim()]
      );
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'player')`, [user.id]);
    } else {
      // An admin-created player signing in for the first time: the number is now proven.
      await client.query(
        `UPDATE users
            SET phone_verified_at = COALESCE(phone_verified_at, now()), last_login_at = now()
          WHERE id = $1`,
        [user.id]
      );
    }

    // Spent here, inside the transaction that creates the account and the session. If
    // anything below fails and rolls back, the code stays usable -- the player retries
    // rather than waiting for another message.
    await client.query(`UPDATE auth_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);

    const session = await issueSession(client, user, context);
    return { ...session, user: publicUser(user, session.roles), created };
  });
}

/**
 * Attach a phone number to the account that is already signed in.
 *
 * How the seeded email/password admin becomes reachable on WhatsApp, and how anyone who
 * started with an email adds the number their team-mates actually know them by. Also the
 * upgrade path off a password: once the number is verified, phone sign-in works and the
 * password becomes optional.
 */
export async function linkPhone({ userId, phone, code }) {
  await consume(phone, code, 'link_phone');

  return withTransaction(async (client) => {
    const { rows: taken } = await client.query(
      `SELECT id FROM users WHERE phone_e164 = $1 AND id <> $2`, [phone, userId]
    );
    if (taken.length > 0) {
      throw new ConflictError('That number is already on another account', 'PHONE_TAKEN');
    }

    const { rows: [user] } = await client.query(
      `UPDATE users SET phone_e164 = $2, phone_verified_at = now()
        WHERE id = $1
        RETURNING id, display_name, email, phone_e164, avatar_url`,
      [userId, phone]
    );
    return { user: publicUser(user, await loadRoles(client, userId)) };
  });
}
