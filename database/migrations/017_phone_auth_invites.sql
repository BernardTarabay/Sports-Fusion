-- 017_phone_auth_invites.sql
-- Sign in with a phone number, and QR codes that let a community add itself.

-- ---------------------------------------------------------------------------
-- PHONE CHALLENGES
--
-- Separate from verification_codes (002), which hangs off user_id and is right for
-- "confirm the number on your existing account".
--
-- Login cannot use it. When an unknown number asks for a code there is no user yet, and
-- creating one on request would mean any stranger could fill the users table by typing
-- numbers -- and would leak, through whether signup or login appeared, exactly which
-- numbers are registered. So a challenge is keyed by the phone number alone, and a user
-- row is created only after a code comes back correct.
-- ---------------------------------------------------------------------------

CREATE TABLE auth_challenges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164   TEXT NOT NULL,
  code_hash    TEXT NOT NULL,            -- sha256; the code itself is never stored
  purpose      TEXT NOT NULL DEFAULT 'login',

  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,

  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  ip_address   INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT auth_challenges_purpose_check CHECK (purpose IN ('login','link_phone')),
  CONSTRAINT auth_challenges_phone_format CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT auth_challenges_attempts_sane CHECK (attempts >= 0 AND attempts <= max_attempts)
);

-- Rate limiting reads this: how many codes has this number asked for recently.
CREATE INDEX auth_challenges_phone_idx ON auth_challenges (phone_e164, created_at DESC);
-- Only one code is live per number at a time; asking again supersedes the last.
CREATE UNIQUE INDEX auth_challenges_one_live ON auth_challenges (phone_e164)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- QR INVITES
--
-- The bootstrapping problem: an admin has 4,000 players in WhatsApp groups and no
-- database. Typing them in is not going to happen. So the admin generates a link, drops
-- it in the group as a QR code or a plain URL, and each player fills in their own name
-- and position once.
--
-- The token is stored hashed. An invite link is a bearer credential -- anyone holding it
-- can add themselves -- so a leaked database dump must not hand over working links.
--
-- Reusable by design: one code serves a whole group. max_uses and expires_at are what
-- stop it circulating forever after it has done its job.
-- ---------------------------------------------------------------------------

CREATE TABLE player_invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT,                     -- "Metn Tuesday group", for the admin's own sake
  district_id  UUID REFERENCES districts(id) ON DELETE CASCADE,
  -- Optionally drops the player straight into one game's roster after they sign up.
  game_id      UUID REFERENCES games(id) ON DELETE CASCADE,

  max_uses     INT,                      -- NULL = unlimited
  uses         INT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ,

  created_by   UUID REFERENCES users(id),
  revoked_at   TIMESTAMPTZ,
  revoked_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT player_invites_uses_sane CHECK (uses >= 0 AND (max_uses IS NULL OR max_uses > 0))
);

CREATE INDEX player_invites_district_idx ON player_invites (district_id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER player_invites_set_updated_at BEFORE UPDATE ON player_invites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who came in through which code. Answers "where did these 60 players come from" and
-- makes a leaked link revocable with its damage visible.
CREATE TABLE player_invite_claims (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id   UUID NOT NULL REFERENCES player_invites(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address  INET,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One person cannot burn a group's invite twice.
CREATE UNIQUE INDEX player_invite_claims_once ON player_invite_claims (invite_id, user_id);

-- uses is a cache, like games.confirmed_count. Maintained by trigger, reconcilable from
-- player_invite_claims at any time.
CREATE OR REPLACE FUNCTION bump_invite_uses() RETURNS TRIGGER AS $$
BEGIN
  UPDATE player_invites SET uses = uses + 1 WHERE id = NEW.invite_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER player_invite_claims_bump AFTER INSERT ON player_invite_claims
  FOR EACH ROW EXECUTE FUNCTION bump_invite_uses();

-- How a player arrived. 'invite_link' is new; the rest already existed on registrations.
ALTER TABLE players ADD COLUMN joined_via TEXT NOT NULL DEFAULT 'self_signup';
ALTER TABLE players ADD CONSTRAINT players_joined_via_check
  CHECK (joined_via IN ('self_signup','invite_link','admin_created','import'));
