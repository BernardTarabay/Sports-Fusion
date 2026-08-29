#!/usr/bin/env node
// Seeds a usable, EMPTY Sports Fusion.
//
// Reference data only: the districts of Lebanon, which are real administrative geography
// and not something an admin should have to type in, plus one account to log in with.
//
// Deliberately no players and no games. Those are the admin's real data, and a database
// pre-filled with plausible-looking fakes is worse than an empty one -- you cannot tell
// what is yours, and the first real game is buried under invented ones.
//
// Venues are the exception, because they are not invented: these are the three pitches
// this community books, and an admin should not have to type an address to create a game.
//
// Idempotent: safe to run repeatedly. Districts upsert by slug; the admin is created only
// if the email is free.

import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const { hashPassword } = await import(
  pathToFileURL(path.join(root, 'backend', 'src', 'lib', 'password.js')).href
);

// Lebanon's 25 districts (cazas) plus Beirut, which is a governorate with no cazas
// under it and behaves as one district here. Grouped by governorate.
const DISTRICTS = [
  ['beirut', 'Beirut', 'بيروت', 'Beirut'],
  ['baabda', 'Baabda', 'بعبدا', 'Mount Lebanon'],
  ['aley', 'Aley', 'عاليه', 'Mount Lebanon'],
  ['metn', 'Metn', 'المتن', 'Mount Lebanon'],
  ['keserwan', 'Keserwan', 'كسروان', 'Mount Lebanon'],
  ['chouf', 'Chouf', 'الشوف', 'Mount Lebanon'],
  ['jbeil', 'Jbeil', 'جبيل', 'Mount Lebanon'],
  ['tripoli', 'Tripoli', 'طرابلس', 'North'],
  ['zgharta', 'Zgharta', 'زغرتا', 'North'],
  ['bcharre', 'Bcharre', 'بشري', 'North'],
  ['batroun', 'Batroun', 'البترون', 'North'],
  ['koura', 'Koura', 'الكورة', 'North'],
  ['miniyeh-danniyeh', 'Miniyeh-Danniyeh', 'المنية الضنية', 'North'],
  ['akkar', 'Akkar', 'عكار', 'Akkar'],
  ['zahle', 'Zahle', 'زحلة', 'Beqaa'],
  ['western-beqaa', 'Western Beqaa', 'البقاع الغربي', 'Beqaa'],
  ['rashaya', 'Rashaya', 'راشيا', 'Beqaa'],
  ['baalbek', 'Baalbek', 'بعلبك', 'Baalbek-Hermel'],
  ['hermel', 'Hermel', 'الهرمل', 'Baalbek-Hermel'],
  ['saida', 'Saida', 'صيدا', 'South'],
  ['sour', 'Sour', 'صور', 'South'],
  ['jezzine', 'Jezzine', 'جزين', 'South'],
  ['nabatieh', 'Nabatieh', 'النبطية', 'Nabatieh'],
  ['marjeyoun', 'Marjeyoun', 'مرجعيون', 'Nabatieh'],
  ['hasbaya', 'Hasbaya', 'حاصبيا', 'Nabatieh'],
  ['bint-jbeil', 'Bint Jbeil', 'بنت جبيل', 'Nabatieh'],
];

// The pitches this community actually books.
//
// Reference data, like the districts: real places with real names, not examples. An admin
// should be able to create their first game without typing an address in.
//
// [districtSlug, name, address, pitchType, defaultCapacity, notes]
//
// `defaultCapacity` only prefills the create-game form. It is the size the pitch usually
// gets booked at, not a limit -- change it on the venue or override it per game.
const VENUES = [
  [
    'keserwan', 'Eleven Football Pro Academy', 'Zouk Mosbeh, Keserwan',
    'turf', 22, 'Academy pitch. Full-size, floodlit.',
  ],
  [
    'metn', 'Sports Zone', 'Dbayeh, Metn',
    'turf', 12, 'Mini football pitches -- six-a-side by default; drop to 10 for fives.',
  ],
  [
    'keserwan', 'Fouad Chehab Stadium', 'Jounieh, Keserwan',
    'grass', 22, 'Municipal stadium, opened 1964.',
  ],
];

// Where the community actually plays today. Everything else is seeded but dormant, so
// the map can show the whole country without implying games exist all over it.
const ACTIVE = new Set(['beirut', 'metn', 'keserwan', 'baabda', 'jbeil', 'batroun']);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    for (const [slug, name, nameAr, region] of DISTRICTS) {
      await client.query(
        `INSERT INTO districts (slug, name, name_ar, region, is_active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, region = EXCLUDED.region`,
        [slug, name, nameAr, region, ACTIVE.has(slug)]
      );
    }
    console.log(`  districts     ${DISTRICTS.length} present (${ACTIVE.size} active)`);

    for (const [slug, name, address, pitchType, capacity, notes] of VENUES) {
      // Keyed on district + name rather than a slug: venues have no natural key, and
      // re-running the seed must not produce a second Sports Zone.
      await client.query(
        `INSERT INTO venues (district_id, name, address, pitch_type, default_capacity, notes)
         SELECT d.id, $2, $3, $4, $5, $6 FROM districts d WHERE d.slug = $1
         ON CONFLICT DO NOTHING`,
        [slug, name, address, pitchType, capacity, notes]
      );
    }
    const { rows: [vc] } = await client.query('SELECT COUNT(*)::int AS n FROM venues');
    console.log(`  venues        ${vc.n} present`);

    const email = process.env.SEED_ADMIN_EMAIL || 'admin@sportsfusion.app';
    const name = process.env.SEED_ADMIN_NAME || 'Sports Fusion Admin';
    // Optional, and worth setting: with a number on the account the admin signs in with a
    // WhatsApp code like everyone else, and never types the generated password again.
    // Marked verified because whoever is running the seed already owns the deployment --
    // sending a code to yourself to prove a number you just typed proves nothing.
    const adminPhone = process.env.SEED_ADMIN_PHONE || null;
    if (adminPhone && !/^\+[1-9]\d{7,14}$/.test(adminPhone)) {
      throw new Error(`SEED_ADMIN_PHONE must be international format, e.g. +9613123456 (got ${adminPhone})`);
    }
    const { rows: existing } = await client.query('SELECT id FROM users WHERE email = $1', [email]);

    if (existing.length > 0) {
      console.log(`  admin         ${email} already exists, left alone`);
    } else {
      // A generated password beats a memorable default: seeds get run on servers, and
      // "admin/admin" on something reachable from the internet is how a community loses
      // its data. Printed once, here, and never stored in plaintext.
      const password = process.env.SEED_ADMIN_PASSWORD || randomBytes(9).toString('base64url');
      const passwordHash = await hashPassword(password);

      const { rows: [user] } = await client.query(
        `INSERT INTO users (display_name, email, password_hash, email_verified_at,
                            phone_e164, phone_verified_at)
         VALUES ($1, $2, $3, now(), $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [name, email, passwordHash, adminPhone]
      );
      // 'owner' is the top role: every district, every action.
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'owner')`, [user.id]);
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')`, [user.id]);
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'player')`, [user.id]);

      // And a football profile. An admin need not be a player in principle -- but the one
      // running a community league invariably is, and an account with no player row hits
      // a 404 on its own profile page the first time it is clicked.
      await client.query(
        `INSERT INTO players (user_id, jersey_name, joined_via) VALUES ($1, $2, 'admin_created')`,
        [user.id, name]
      );

      console.log('');
      console.log('  ADMIN ACCOUNT CREATED -- this password is shown once');
      console.log('  ---------------------------------------------------');
      console.log(`  email     ${email}`);
      console.log(`  password  ${password}`);
      if (adminPhone) {
        console.log(`  phone     ${adminPhone}  (sign in with a WhatsApp code instead)`);
      } else {
        console.log('  tip       set SEED_ADMIN_PHONE=+9613123456 to sign in by phone');
      }
      console.log('');
    }

    await client.query('COMMIT');

    const { rows: [c] } = await client.query(`
      SELECT (SELECT COUNT(*) FROM districts)::int AS districts,
             (SELECT COUNT(*) FROM players)::int   AS players,
             (SELECT COUNT(*) FROM games)::int     AS games,
             (SELECT COUNT(*) FROM venues)::int    AS venues`);
    console.log(`  database      ${c.districts} districts, ${c.venues} venues, ${c.players} players, ${c.games} games`);
    console.log('');
    console.log('  No players and no games by design. Create your first fixture from the admin app.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
