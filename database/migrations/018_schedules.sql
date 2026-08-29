-- 018_schedules.sql
-- Recurring games. "Every Tuesday at ten in Metn."
--
-- This is how the community actually works: a standing fixture that most of the same
-- people turn up to, week after week. Creating it by hand every Wednesday is the admin
-- chore the product exists to remove.
--
-- A SCHEDULE IS A RULE, NOT A LIST OF GAMES
--
-- It stores the local weekday and clock time, and real games are MATERIALISED from it a
-- few weeks ahead. Storing a rule rather than a hundred rows means moving the fixture to
-- 9pm changes one field, and the games that have already been played keep the time they
-- were actually played at.

CREATE TABLE game_schedules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id       UUID NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  venue_id          UUID REFERENCES venues(id) ON DELETE SET NULL,

  -- 0 = Sunday, matching EXTRACT(DOW) and JavaScript's getDay().
  weekday           SMALLINT NOT NULL,
  -- LOCAL wall-clock time, with the zone it is local to.
  --
  -- Not a UTC instant. Lebanon observes daylight saving, so a fixture stored as 19:00Z
  -- silently becomes a 10pm game for half the year and a 9pm game for the other half.
  -- What the players agreed to is "ten o'clock on Tuesday" -- the clock time is the fact,
  -- and the UTC instant is derived per occurrence.
  kickoff_time      TIME NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'Asia/Beirut',

  duration_minutes  INT NOT NULL DEFAULT 90,
  halftime_minutes  INT NOT NULL DEFAULT 15,
  arrive_by_minutes INT NOT NULL DEFAULT 15,
  capacity          INT NOT NULL DEFAULT 22,
  team_size         INT NOT NULL DEFAULT 11,
  team_count        INT NOT NULL DEFAULT 2,
  waitlist_capacity INT NOT NULL DEFAULT 10,
  price             NUMERIC(10,2),
  currency          TEXT NOT NULL DEFAULT 'USD',
  title             TEXT,
  notes             TEXT,

  -- How far ahead to keep fixtures created. Far enough that people can plan, short enough
  -- that the games list is not a wall of identical rows.
  horizon_days      INT NOT NULL DEFAULT 28,
  -- Whether new fixtures open for registration the moment they are created.
  open_immediately  BOOLEAN NOT NULL DEFAULT true,

  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT game_schedules_weekday_check CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT game_schedules_capacity_divisible CHECK (capacity = team_size * team_count),
  CONSTRAINT game_schedules_horizon_sane CHECK (horizon_days BETWEEN 7 AND 120)
);

CREATE INDEX game_schedules_active_idx ON game_schedules (district_id) WHERE is_active;

CREATE TRIGGER game_schedules_set_updated_at BEFORE UPDATE ON game_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which schedule produced a game, if any. NULL for a one-off.
ALTER TABLE games ADD COLUMN schedule_id UUID REFERENCES game_schedules(id) ON DELETE SET NULL;

-- Generation runs repeatedly -- on a timer, and whenever an admin opens the page -- so it
-- has to be safe to run twice. This is what makes it idempotent: a schedule produces at
-- most one game per kickoff instant, and a second run inserts nothing.
CREATE UNIQUE INDEX games_one_per_schedule_slot
  ON games (schedule_id, kickoff_at) WHERE schedule_id IS NOT NULL;

CREATE INDEX games_schedule_idx ON games (schedule_id) WHERE schedule_id IS NOT NULL;

COMMENT ON COLUMN game_schedules.kickoff_time IS
  'Local wall-clock time in `timezone`. The UTC instant is computed per occurrence so the
   fixture stays at the same clock time across daylight saving changes.';
