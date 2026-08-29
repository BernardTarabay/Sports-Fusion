-- 001_foundation.sql
-- Extensions, shared helpers, and the conventions every other migration relies on.
--
-- Conventions used throughout this schema:
--   * Enumerated values are TEXT + CHECK, not native ENUM types. Adding a value to a
--     native enum is a migration; adding one here is a one-line constraint swap, and
--     removing one is possible at all. This schema is young; it will change.
--   * Anything that represents history (ratings, points, results) is append-only.
--     Nothing that a future model will want to learn from is ever UPDATEd in place.
--   * Counters that are expensive to derive (confirmed players, point balances) are
--     cached on the parent row by trigger. The ledger remains the source of truth;
--     the cache exists so the hot path does not COUNT(*) on every read.

-- gen_random_uuid() is core in Postgres 13+; pgcrypto is deliberately NOT required.
-- Password hashing happens in the application (scrypt), never in the database, so the
-- database never receives a plaintext password to hash.
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email lookups

-- Keeps updated_at honest without the application having to remember.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Applied-migration bookkeeping for scripts/migrate.js
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum    TEXT
);
