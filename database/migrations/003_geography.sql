-- 003_geography.sql
-- Districts and venues.
--
-- Districts are the unit that replaces the 1,600-member WhatsApp community cap.
-- A player follows districts; they do not "belong" to exactly one.

CREATE TABLE districts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,      -- 'beirut', 'metn', 'keserwan'
  name         TEXT NOT NULL,
  name_ar      TEXT,
  region       TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  launched_at  DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER districts_set_updated_at BEFORE UPDATE ON districts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_district_fk
  FOREIGN KEY (district_id) REFERENCES districts(id) ON DELETE CASCADE;

CREATE TABLE venues (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id      UUID NOT NULL REFERENCES districts(id),
  name             TEXT NOT NULL,
  address          TEXT,
  google_maps_url  TEXT,
  latitude         NUMERIC(9,6),
  longitude        NUMERIC(9,6),
  pitch_type       TEXT,                  -- 'grass','turf','indoor'
  default_capacity INT,                   -- players the pitch comfortably holds
  hourly_cost      NUMERIC(10,2),         -- what Sports Fusion pays; margin lives here
  currency         TEXT NOT NULL DEFAULT 'USD',
  contact_name     TEXT,
  contact_phone    TEXT,
  notes            TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT venues_pitch_type_check
    CHECK (pitch_type IS NULL OR pitch_type IN ('grass','turf','indoor','sand'))
);

CREATE TRIGGER venues_set_updated_at BEFORE UPDATE ON venues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX venues_district_idx ON venues (district_id) WHERE is_active;

-- Players follow districts. Drives "which games do I see" and notification targeting.
CREATE TABLE district_followers (
  district_id  UUID NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  followed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (district_id, user_id)
);

CREATE INDEX district_followers_user_idx ON district_followers (user_id);
