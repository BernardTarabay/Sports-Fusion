// QR invites: how a community adds itself to the database.
//
// THE BOOTSTRAPPING PROBLEM
//
// An admin has four thousand players spread across WhatsApp groups and an empty players
// table. Typing them in is not going to happen, and asking each of them to find a website
// and register before the first game means there is no first game.
//
// So the admin generates one link, drops it in the group as a QR code, and each player
// fills in their own name and position once. The people who know the data enter the data.
//
// THE TOKEN IS A BEARER CREDENTIAL
//
// Anyone holding the link can add themselves, so it is stored hashed: a leaked database
// dump must not hand over working invites. It is shown exactly once, at creation, which
// is the same reasoning as the seeded admin password.
//
// Reusable by design -- one code serves a whole group. `max_uses` and `expires_at` are
// what stop it circulating in a screenshot forever after it has done its job, and
// `player_invite_claims` records who came in through which code, so a link that ends up
// somewhere it should not can be revoked with its damage visible.

import { randomBytes, createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { withTransaction, query } from '../../database/pool.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { issueSession, publicUser } from '../auth/service.js';
import { registerPlayer } from '../registrations/service.js';
import { logger } from '../../lib/logger.js';
import config from '../../config/index.js';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/**
 * 18 bytes -> 24 base64url characters.
 *
 * Long enough that guessing is hopeless, short enough that the QR code stays coarse. A
 * dense QR is unreadable off a phone screen held up across a car park at night, which is
 * exactly how this will be scanned.
 */
const newToken = () => randomBytes(18).toString('base64url');

const inviteUrl = (token) => `${config.publicWebUrl}/join/${token}`;

function shape(row, token) {
  return {
    id: row.id,
    label: row.label,
    districtId: row.district_id,
    districtName: row.district_name ?? null,
    gameId: row.game_id,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    // Only ever non-null on the response that created it.
    token: token ?? null,
    url: token ? inviteUrl(token) : null,
  };
}

/**
 * The QR code, rendered server-side as SVG.
 *
 * Server-side because the raw token exists in exactly one response -- the one that
 * created the invite -- and generating the image here means the frontend never needs a
 * QR library at all. It is an inline SVG string, so it scales to whatever size the admin
 * holds up and stays crisp on a projector or a phone screen.
 *
 * Error correction level M, not H. H survives more damage but packs the modules tighter,
 * and the failure mode here is not a torn poster -- it is twenty people photographing a
 * phone screen across a dark car park, where a coarser grid scans better.
 */
async function renderQr(url) {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    // Colours are left to CSS: the SVG inherits currentColor so the code flips with the
    // light and dark themes instead of being a white box on a black page.
    color: { dark: '#000000', light: '#0000' },
  });
}

export async function createInvite({
  districtId, gameId, label, maxUses, expiresAt, actorUserId,
}) {
  const token = newToken();

  return withTransaction(async (client) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO player_invites (token_hash, label, district_id, game_id, max_uses, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [hashToken(token), label ?? null, districtId ?? null, gameId ?? null,
        maxUses ?? null, expiresAt ?? null, actorUserId]
    );
    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, after)
       VALUES ($1, 'invite.create', 'invite', $2, $3)`,
      [actorUserId, row.id, JSON.stringify({ label, districtId, gameId, maxUses })]
    );
    const invite = shape(row, token);
    invite.qrSvg = await renderQr(invite.url);
    return invite;
  });
}

/**
 * Invites, optionally narrowed to one district and always narrowed to what the caller
 * administers.
 *
 * `scope` is null for a global admin and the caller's district list otherwise. A global
 * invite -- one with no district -- is only ever visible to a global admin, because only
 * a global admin can mint one.
 */
export async function listInvites({ districtId, scope = null }) {
  const { rows } = await query(
    `SELECT i.*, d.name AS district_name
       FROM player_invites i
       LEFT JOIN districts d ON d.id = i.district_id
      WHERE ($1::uuid IS NULL OR i.district_id = $1)
        AND ($2::uuid[] IS NULL OR i.district_id = ANY($2))
      ORDER BY i.created_at DESC
      LIMIT 100`,
    // `scope` of [] means "administers nothing" and must match nothing. Only null --
    // a global admin -- lifts the restriction.
    [districtId ?? null, scope]
  );
  return rows.map((r) => shape(r));
}

/** The district an invite belongs to, for the authorisation guard. */
export async function districtOfInvite(inviteId) {
  const { rows } = await query('SELECT district_id FROM player_invites WHERE id = $1', [inviteId]);
  return rows[0]?.district_id ?? null;
}

export async function revokeInvite({ inviteId, actorUserId }) {
  const { rows } = await query(
    `UPDATE player_invites SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
    [inviteId, actorUserId]
  );
  if (!rows[0]) throw new NotFoundError('Invite not found, or already revoked');
  return shape(rows[0]);
}

/** Why an invite is not usable, or null if it is. Shared by the public read and the claim. */
function invalidReason(row) {
  if (!row) return 'This invite link is not valid.';
  if (row.revoked_at) return 'This invite link has been turned off.';
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'This invite link has expired.';
  if (row.max_uses != null && row.uses >= row.max_uses) return 'This invite link has been used up.';
  return null;
}

/**
 * What the join page shows before anyone types anything. Unauthenticated by definition --
 * the whole point is that the person does not have an account yet.
 *
 * Returns only what is needed to make the page make sense: which district, which game if
 * any. Never the creator, the claim list, or how many uses are left.
 */
export async function getInviteForJoin(token) {
  const { rows } = await query(
    `SELECT i.*, d.name AS district_name, d.slug AS district_slug,
            g.kickoff_at, g.title AS game_title, v.name AS venue_name
       FROM player_invites i
       LEFT JOIN districts d ON d.id = i.district_id
       LEFT JOIN games g ON g.id = i.game_id
       LEFT JOIN venues v ON v.id = g.venue_id
      WHERE i.token_hash = $1`,
    [hashToken(token)]
  );
  const row = rows[0];
  const reason = invalidReason(row);
  if (reason) throw new NotFoundError(reason);

  return {
    valid: true,
    label: row.label,
    district: row.district_id
      ? { id: row.district_id, name: row.district_name, slug: row.district_slug }
      : null,
    game: row.game_id
      ? { id: row.game_id, title: row.game_title, kickoffAt: row.kickoff_at, venueName: row.venue_name }
      : null,
  };
}

/**
 * Claim an invite: verified number in, player row out, signed in.
 *
 * The phone must already have been verified by a code in this same flow -- the caller
 * passes the challenge through, so an invite link alone cannot manufacture accounts with
 * numbers the holder does not control. Without that, one leaked link plus a script is a
 * few thousand junk players with plausible Lebanese numbers.
 */
export async function claimInvite({
  token, phone, displayName, preferredPosition, isGoalkeeper = false, districtId, context = {},
}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM player_invites WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(token)]
    );
    const invite = rows[0];
    const reason = invalidReason(invite);
    if (reason) throw new NotFoundError(reason);

    const { rows: existing } = await client.query(
      `SELECT id, display_name, email, phone_e164, avatar_url FROM users WHERE phone_e164 = $1`,
      [phone]
    );

    let user = existing[0];
    let created = false;

    if (user) {
      // Somebody already in the system following the link -- an existing player joining a
      // new district, or a second scan. Not an error: sign them in and move on.
      const { rows: hasPlayer } = await client.query(
        `SELECT id FROM players WHERE user_id = $1`, [user.id]
      );
      if (hasPlayer.length === 0) {
        await client.query(
          `INSERT INTO players (user_id, home_district_id, jersey_name, preferred_position,
                                is_goalkeeper, joined_via)
           VALUES ($1, $2, $3, $4, $5, 'invite_link')`,
          [user.id, districtId ?? invite.district_id, user.display_name,
            preferredPosition ?? null, isGoalkeeper]
        );
      }
    } else {
      if (!displayName) throw new ValidationError('A name is required');
      const { rows: [fresh] } = await client.query(
        `INSERT INTO users (display_name, phone_e164, phone_verified_at)
         VALUES ($1, $2, now())
         RETURNING id, display_name, email, phone_e164, avatar_url`,
        [displayName.trim(), phone]
      );
      user = fresh;
      created = true;

      await client.query(
        `INSERT INTO players (user_id, home_district_id, jersey_name, preferred_position,
                              is_goalkeeper, joined_via)
         VALUES ($1, $2, $3, $4, $5, 'invite_link')`,
        [user.id, districtId ?? invite.district_id, displayName.trim(),
          preferredPosition ?? null, isGoalkeeper]
      );
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'player')`, [user.id]);
    }

    // ON CONFLICT DO NOTHING, so a second scan by the same person does not burn a use.
    // The trigger on this table maintains player_invites.uses.
    await client.query(
      `INSERT INTO player_invite_claims (invite_id, user_id, ip_address)
       VALUES ($1, $2, $3) ON CONFLICT (invite_id, user_id) DO NOTHING`,
      [invite.id, user.id, context.ipAddress ?? null]
    );

    const session = await issueSession(client, user, context);
    const { rows: [player] } = await client.query(
      `SELECT id FROM players WHERE user_id = $1`, [user.id]
    );
    return {
      ...session,
      user: publicUser(user, session.roles),
      created,
      playerId: player.id,
      gameId: invite.game_id,
    };
  });
}
/**
 * Claim, then put them on the game if the invite was pinned to one.
 *
 * The join is a second transaction on purpose. registerPlayer owns the capacity race --
 * it locks the game row, works out whether this is a confirmed place or a waitlist
 * position, and keeps registrations_waitlist_position_consistent satisfied. Inlining a
 * bare INSERT here would skip all of that and violate the constraint the moment a game
 * filled up; nesting its transaction inside this one deadlocks on a single connection.
 *
 * Best effort by design. Somebody who typed their name in and got an account should not
 * see an error page because the game turned out to be full -- they are a player now
 * either way, and the roster is a separate question.
 */
export async function claimInviteAndJoin(args) {
  const result = await claimInvite(args);
  if (!result.gameId) return { ...result, joinedGame: null };

  try {
    const reg = await registerPlayer({
      gameId: result.gameId,
      playerId: result.playerId,
      via: 'whatsapp_link',
      allowWaitlist: true,
    });
    return {
      ...result,
      joinedGame: { gameId: result.gameId, status: reg.status, waitlistPosition: reg.waitlistPosition },
    };
  } catch (err) {
    logger.warn({ err, gameId: result.gameId }, 'invite claimed but game join failed');
    return { ...result, joinedGame: null };
  }
}
