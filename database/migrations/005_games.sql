-- 005_games.sql
-- Games, registrations, and the waitlist.
--
-- CAPACITY IS ENFORCED BY THE DATABASE, NOT BY THE APPLICATION.
--
-- games.confirmed_count is maintained by trigger and guarded by a CHECK constraint.
-- Two players tapping JOIN on the last slot at the same millisecond both cause an
-- UPDATE on the same games row; the second blocks on the row lock, re-reads the
-- committed count, and fails the CHECK. The application layer takes the same row lock
-- deliberately (SELECT ... FOR UPDATE) so it can route the loser to the waitlist
-- gracefully instead of showing them an error. The CHECK is the seatbelt: even a
-- buggy future code path cannot produce 23 confirmed players in a 22-player game.

CREATE TABLE games (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id            UUID NOT NULL REFERENCES districts(id),
  venue_id               UUID REFERENCES venues(id),

  kickoff_at             TIMESTAMPTZ NOT NULL,
  duration_minutes       INT NOT NULL DEFAULT 90,
  arrive_by_minutes      INT NOT NULL DEFAULT 15,

  capacity               INT NOT NULL DEFAULT 22,
  team_size              INT NOT NULL DEFAULT 11,
  team_count             INT NOT NULL DEFAULT 2,
  waitlist_capacity      INT NOT NULL DEFAULT 10,

  status                 TEXT NOT NULL DEFAULT 'draft',
  registration_opens_at  TIMESTAMPTZ,
  registration_closes_at TIMESTAMPTZ,

  price                  NUMERIC(10,2),
  currency               TEXT NOT NULL DEFAULT 'USD',
  title                  TEXT,
  notes                  TEXT,
  public_slug            TEXT UNIQUE,
  is_public              BOOLEAN NOT NULL DEFAULT true,

  -- Trigger-maintained caches. Reconcilable at any time from registrations.
  confirmed_count        INT NOT NULL DEFAULT 0,
  waitlist_count         INT NOT NULL DEFAULT 0,

  created_by             UUID REFERENCES users(id),
  cancelled_at           TIMESTAMPTZ,
  cancelled_reason       TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT games_status_check CHECK (status IN
    ('draft','registration_open','full','teams_generated','in_progress','completed','cancelled')),
  CONSTRAINT games_capacity_positive CHECK (capacity > 0),
  CONSTRAINT games_capacity_divisible CHECK (capacity = team_size * team_count),
  -- The seatbelt.
  CONSTRAINT games_not_overbooked CHECK (confirmed_count >= 0 AND confirmed_count <= capacity),
  CONSTRAINT games_waitlist_sane   CHECK (waitlist_count >= 0),
  CONSTRAINT games_registration_window
    CHECK (registration_closes_at IS NULL OR registration_opens_at IS NULL
           OR registration_closes_at > registration_opens_at)
);

CREATE TRIGGER games_set_updated_at BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX games_district_kickoff_idx ON games (district_id, kickoff_at DESC);
CREATE INDEX games_upcoming_idx ON games (kickoff_at)
  WHERE status IN ('registration_open','full','teams_generated');
CREATE INDEX games_status_idx ON games (status);

ALTER TABLE player_ratings
  ADD CONSTRAINT player_ratings_game_fk FOREIGN KEY (game_id) REFERENCES games(id);

-- ---------------------------------------------------------------------------
-- Registrations. One row per player per game. Status transitions in place, but a
-- cancellation is never deleted -- the cancellation IS the behavioural data.
-- ---------------------------------------------------------------------------
CREATE TABLE registrations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id            UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id          UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,

  status             TEXT NOT NULL DEFAULT 'confirmed',
  waitlist_position  INT,

  -- Recorded after the fact. The input to reliability.
  attendance         TEXT,

  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at        TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,
  cancelled_by       UUID REFERENCES users(id),
  cancel_reason      TEXT,
  -- Hours between cancellation and kickoff, frozen at cancel time so the definition
  -- of "late cancellation" can change later without rewriting history.
  cancel_lead_hours  NUMERIC(8,2),

  registered_via     TEXT NOT NULL DEFAULT 'web',
  invited_by         UUID REFERENCES players(id),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT registrations_status_check
    CHECK (status IN ('confirmed','waitlisted','cancelled')),
  CONSTRAINT registrations_attendance_check
    CHECK (attendance IS NULL OR attendance IN ('attended','late','no_show')),
  CONSTRAINT registrations_via_check
    CHECK (registered_via IN ('web','mobile','admin','whatsapp_link','import')),
  CONSTRAINT registrations_waitlist_position_consistent CHECK (
    (status = 'waitlisted' AND waitlist_position IS NOT NULL) OR
    (status <> 'waitlisted' AND waitlist_position IS NULL)
  )
);

CREATE TRIGGER registrations_set_updated_at BEFORE UPDATE ON registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A player holds at most one live registration per game. Cancelled rows are exempt, so
-- a player who cancels can register again and both facts survive.
CREATE UNIQUE INDEX registrations_one_live_per_player
  ON registrations (game_id, player_id)
  WHERE status <> 'cancelled';

-- No two players share a waitlist position.
CREATE UNIQUE INDEX registrations_unique_waitlist_position
  ON registrations (game_id, waitlist_position)
  WHERE status = 'waitlisted';

CREATE INDEX registrations_game_status_idx ON registrations (game_id, status);
CREATE INDEX registrations_player_idx      ON registrations (player_id, registered_at DESC);
CREATE INDEX registrations_waitlist_idx    ON registrations (game_id, waitlist_position)
  WHERE status = 'waitlisted';

-- ---------------------------------------------------------------------------
-- Counter maintenance. Applies the row delta rather than COUNT(*), so the trigger
-- stays O(1) regardless of game size.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_game_counts()
RETURNS TRIGGER AS $fn$
DECLARE
  old_confirmed INT := 0;
  new_confirmed INT := 0;
  old_waitlist  INT := 0;
  new_waitlist  INT := 0;
  target_game   UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_confirmed := CASE WHEN OLD.status = 'confirmed'  THEN 1 ELSE 0 END;
    old_waitlist  := CASE WHEN OLD.status = 'waitlisted' THEN 1 ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_confirmed := CASE WHEN NEW.status = 'confirmed'  THEN 1 ELSE 0 END;
    new_waitlist  := CASE WHEN NEW.status = 'waitlisted' THEN 1 ELSE 0 END;
  END IF;

  target_game := CASE WHEN TG_OP = 'DELETE' THEN OLD.game_id ELSE NEW.game_id END;

  IF (new_confirmed - old_confirmed) <> 0 OR (new_waitlist - old_waitlist) <> 0 THEN
    UPDATE games
       SET confirmed_count = confirmed_count + (new_confirmed - old_confirmed),
           waitlist_count  = waitlist_count  + (new_waitlist  - old_waitlist)
     WHERE id = target_game;
  END IF;

  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER registrations_sync_counts
  AFTER INSERT OR UPDATE OF status OR DELETE ON registrations
  FOR EACH ROW EXECUTE FUNCTION sync_game_counts();
