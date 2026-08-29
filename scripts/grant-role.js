#!/usr/bin/env node
// Grant or revoke a role, from the machine that owns the database.
//
// There is deliberately no API for making somebody an owner. The first admin has to come
// from outside the application -- otherwise either the app ships with a way to escalate
// yourself, or the very first person is stuck with nobody able to promote them.
//
//   node scripts/grant-role.js bernard@example.com admin
//   node scripts/grant-role.js +9613123456 district_admin metn
//   node scripts/grant-role.js bernard@example.com player --revoke
//   node scripts/grant-role.js --list
//
// Roles:
//   player          the default. Join games, see stats, edit own profile.
//   district_admin  everything below, but only for one district.
//   admin           run games, teams, results, payments, invites, players.
//   owner           admin, plus the things that affect the whole system.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const ROLES = ['player', 'district_admin', 'admin', 'owner'];
const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const listOnly = args.includes('--list');
const [identifier, role, districtSlug] = args.filter((a) => !a.startsWith('--'));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    if (listOnly) {
      const { rows } = await client.query(`
        SELECT u.display_name, u.email, u.phone_e164,
               COALESCE(ARRAY_AGG(r.role || COALESCE(':' || d.slug, '') ORDER BY r.role)
                        FILTER (WHERE r.revoked_at IS NULL), '{}') AS roles
          FROM users u
          LEFT JOIN user_roles r ON r.user_id = u.id
          LEFT JOIN districts d ON d.id = r.district_id
         GROUP BY u.id ORDER BY u.created_at`);
      console.log(`\n  ${rows.length} user(s)\n`);
      for (const r of rows) {
        console.log(`  ${(r.display_name ?? '').padEnd(26)}`
          + `${(r.email ?? r.phone_e164 ?? '').padEnd(30)}`
          + `${r.roles.join(', ') || '(no roles)'}`);
      }
      console.log('');
      return;
    }

    if (!identifier || !role) {
      console.error('Usage: node scripts/grant-role.js <email|phone> <role> [districtSlug] [--revoke]');
      console.error(`Roles: ${ROLES.join(', ')}`);
      process.exit(1);
    }
    if (!ROLES.includes(role)) {
      console.error(`Unknown role "${role}". One of: ${ROLES.join(', ')}`);
      process.exit(1);
    }

    const { rows: users } = await client.query(
      `SELECT id, display_name, email, phone_e164 FROM users
        WHERE email = $1 OR phone_e164 = $1`,
      [identifier]
    );
    if (users.length === 0) {
      console.error(`No user with email or phone "${identifier}".`);
      console.error('Run with --list to see who exists.');
      process.exit(1);
    }
    const user = users[0];

    let districtId = null;
    if (districtSlug) {
      const { rows } = await client.query('SELECT id FROM districts WHERE slug = $1', [districtSlug]);
      if (rows.length === 0) {
        console.error(`No district with slug "${districtSlug}".`);
        process.exit(1);
      }
      districtId = rows[0].id;
    }
    if (role === 'district_admin' && !districtId) {
      console.error('district_admin needs a district slug: node scripts/grant-role.js <who> district_admin metn');
      process.exit(1);
    }

    const who = user.display_name ?? user.email ?? user.phone_e164;

    if (revoke) {
      const { rowCount } = await client.query(
        `UPDATE user_roles SET revoked_at = now()
          WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL
            AND COALESCE(district_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [user.id, role, districtId]
      );
      console.log(rowCount
        ? `  revoked ${role} from ${who}`
        : `  ${who} did not have ${role}; nothing changed`);
    } else {
      // Revoked rows are kept, so the unique index is partial and a re-grant needs the
      // conflict target to match it. History of who held what, and when, is the point.
      await client.query(
        `INSERT INTO user_roles (user_id, role, district_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, role, COALESCE(district_id, '00000000-0000-0000-0000-000000000000'::uuid))
         WHERE revoked_at IS NULL DO NOTHING`,
        [user.id, role, districtId]
      );
      console.log(`  ${who} is now ${role}${districtSlug ? ` for ${districtSlug}` : ''}`);
    }

    const { rows: now } = await client.query(
      `SELECT r.role, d.slug FROM user_roles r
       LEFT JOIN districts d ON d.id = r.district_id
       WHERE r.user_id = $1 AND r.revoked_at IS NULL ORDER BY r.role`,
      [user.id]
    );
    console.log(`  roles: ${now.map((r) => r.role + (r.slug ? `:${r.slug}` : '')).join(', ') || '(none)'}`);
    console.log('\n  They need to sign out and back in — roles are baked into the access token.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
