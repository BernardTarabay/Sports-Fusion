-- 002_identity.sql
-- Accounts, credentials, sessions, RBAC.
--
-- A `user` is a login. A `player` (004) is a football identity. They are separate
-- because an admin is not necessarily a player, a player may eventually be created
-- by an admin before they ever log in, and one day a venue owner will need an
-- account with no football profile at all.

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             CITEXT UNIQUE,
  phone_e164        TEXT UNIQUE,          -- +9613xxxxxx. The real identity in Lebanon.
  password_hash     TEXT,                 -- NULL until the user sets one (admin-created accounts)
  display_name      TEXT NOT NULL,
  avatar_url        TEXT,
  locale            TEXT NOT NULL DEFAULT 'en',
  status            TEXT NOT NULL DEFAULT 'active',
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_status_check CHECK (status IN ('active','suspended','deleted')),
  CONSTRAINT users_phone_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Must be reachable by something, or the account cannot be recovered or notified.
  CONSTRAINT users_has_identifier CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL)
);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Roles are global or district-scoped. A district admin runs Beirut and should not be
-- able to delete a game in Keserwan.
CREATE TABLE user_roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  district_id  UUID,                      -- FK added in 003 once districts exists
  granted_by   UUID REFERENCES users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,

  CONSTRAINT user_roles_role_check CHECK (role IN ('player','district_admin','admin','owner'))
);

CREATE UNIQUE INDEX user_roles_unique_active
  ON user_roles (user_id, role, COALESCE(district_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX user_roles_user_idx ON user_roles (user_id) WHERE revoked_at IS NULL;

-- Refresh tokens are stored hashed, one row per issued token, so that a single
-- session can be revoked without nuking every device the player owns.
CREATE TABLE refresh_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,    -- sha256 of the opaque token; never the token itself
  family_id      UUID NOT NULL,           -- rotation lineage: reuse of an old token kills the family
  user_agent     TEXT,
  ip_address     INET,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT
);

CREATE INDEX refresh_tokens_user_idx   ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- Short-lived codes for phone/email verification and password reset.
CREATE TABLE verification_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INT  NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT verification_codes_purpose_check
    CHECK (purpose IN ('phone_verify','email_verify','password_reset','login_otp'))
);

CREATE INDEX verification_codes_lookup_idx
  ON verification_codes (user_id, purpose) WHERE consumed_at IS NULL;
