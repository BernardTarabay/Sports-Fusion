// Password hashing with scrypt from node:crypto.
//
// Deliberately not bcrypt: its native build chain pulls in a critical `tar` advisory and
// needs a compiler on Windows. scrypt is memory-hard, ships with Node, and is a
// recommended password KDF.
//
// Stored format is self-describing: scrypt$N$r$p$salt$hash
// Parameters live in the hash, so they can be raised later and old hashes keep verifying
// (and get upgraded transparently on the user's next successful login).

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// ~16 MiB of memory per hash (128 * N * r). Node's default maxmem is 32 MiB.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

export async function hashPassword(plain, params = PARAMS) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plain.normalize('NFKC'), salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024,
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification. Returns { valid, needsRehash }.
 * `needsRehash` is true when the stored hash used weaker parameters than we now want.
 */
export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) {
    return { valid: false, needsRehash: false };
  }

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = stored.split('$');
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!N || !r || !p || !saltB64 || !hashB64) return { valid: false, needsRehash: false };

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  let derived;
  try {
    derived = await scryptAsync(plain.normalize('NFKC'), salt, expected.length, {
      N, r, p, maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return { valid: false, needsRehash: false };
  }

  const valid = derived.length === expected.length && timingSafeEqual(derived, expected);
  return { valid, needsRehash: valid && (N < PARAMS.N || r < PARAMS.r || p < PARAMS.p) };
}

/**
 * Verify against a user row whose password_hash may be NULL (admin-created accounts that
 * have never set a password). Burns a comparable amount of time either way so that the
 * response does not reveal whether an account exists or has a password set.
 */
export async function verifyPasswordConstantTime(plain, storedOrNull) {
  if (!storedOrNull) {
    await hashPassword(plain);
    return { valid: false, needsRehash: false };
  }
  return verifyPassword(plain, storedOrNull);
}
