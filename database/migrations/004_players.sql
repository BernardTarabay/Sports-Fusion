-- 004_players.sql
-- Player identity, positions, preferences, and the append-only rating ledger.
--
-- THE RATING LEDGER IS THE POINT OF THIS FILE.
--
-- V1 seeds ratings by hand (source='admin_seed') and the balancer reads the cached
-- mu/sigma on `players`. V2 introduces Glicko-2 and does NOT need new tables: it
-- replays 006/007 (team rosters + match results, both append-only) and writes a new
-- ledger row per player per match with source='match_result'. Because every historical
-- match is stored with its exact rosters, date, and score, the entire rating history
-- can be BACKFILLED over games that were played long before the rating system existed.
--
-- That is the whole reason results are immutable. Do not "fix" this by updating rows.

CREATE TABLE players (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  home_district_id      UUID REFERENCES districts(id),
  jersey_name           TEXT,                  -- what appears on the team sheet
  date_of_birth         DATE,
  preferred_position    TEXT,
  secondary_positions   TEXT[] NOT NULL DEFAULT '{}',
  preferred_foot        TEXT,
  is_goalkeeper         BOOLEAN NOT NULL DEFAULT false,  -- willing to keep, not just able
  shirt_size            TEXT,

  -- Cached from player_ratings. Ledger is truth; this exists so the balancer can read
  -- 22 players in one query instead of 22 correlated subqueries.
  rating_mu             NUMERIC(8,3) NOT NULL DEFAULT 1500.000,
  rating_sigma          NUMERIC(8,3) NOT NULL DEFAULT 350.000,
  rating_system         TEXT NOT NULL DEFAULT 'admin_seed_v1',
  rating_updated_at     TIMESTAMPTZ,

  -- Cached from point_transactions (008). Same reasoning.
  points_balance        INT NOT NULL DEFAULT 0,

  -- Cached from registrations/attendance (005). Recomputable at any time.
  games_registered      INT NOT NULL DEFAULT 0,
  games_attended        INT NOT NULL DEFAULT 0,
  games_no_show         INT NOT NULL DEFAULT 0,
  late_cancellations    INT NOT NULL DEFAULT 0,

  status                TEXT NOT NULL DEFAULT 'active',
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT players_status_check CHECK (status IN ('active','inactive','banned')),
  CONSTRAINT players_foot_check
    CHECK (preferred_foot IS NULL OR preferred_foot IN ('left','right','both')),
  CONSTRAINT players_position_check
    CHECK (preferred_position IS NULL OR preferred_position IN
      ('GK','LB','CB','RB','LWB','RWB','CDM','CM','CAM','LW','RW','ST','CF')),
  CONSTRAINT players_sigma_positive CHECK (rating_sigma > 0)
);

CREATE TRIGGER players_set_updated_at BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX players_district_idx ON players (home_district_id) WHERE status = 'active';
CREATE INDEX players_gk_idx       ON players (is_goalkeeper) WHERE is_goalkeeper AND status = 'active';

-- Maps a specific position to its broad group, for positional balance scoring.
CREATE OR REPLACE FUNCTION position_group(pos TEXT)
RETURNS TEXT AS $$
  SELECT CASE
    WHEN pos = 'GK' THEN 'GK'
    WHEN pos IN ('LB','CB','RB','LWB','RWB') THEN 'DEF'
    WHEN pos IN ('CDM','CM','CAM') THEN 'MID'
    WHEN pos IN ('LW','RW','ST','CF') THEN 'FWD'
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- Append-only rating ledger. One row per rating change, forever.
-- ---------------------------------------------------------------------------
CREATE TABLE player_ratings (
  id             BIGSERIAL PRIMARY KEY,
  player_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mu             NUMERIC(8,3) NOT NULL,
  sigma          NUMERIC(8,3) NOT NULL,
  previous_mu    NUMERIC(8,3),
  previous_sigma NUMERIC(8,3),
  rating_system  TEXT NOT NULL DEFAULT 'admin_seed_v1',
  source         TEXT NOT NULL,
  game_id        UUID,                    -- FK added in 005; set when source='match_result'
  reason         TEXT,
  created_by     UUID REFERENCES users(id),
  effective_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT player_ratings_source_check
    CHECK (source IN ('admin_seed','match_result','admin_override','recalculation','decay')),
  CONSTRAINT player_ratings_sigma_positive CHECK (sigma > 0)
);

CREATE INDEX player_ratings_player_idx ON player_ratings (player_id, effective_at DESC);
CREATE INDEX player_ratings_game_idx   ON player_ratings (game_id) WHERE game_id IS NOT NULL;
-- Supports "recompute everything from scratch in chronological order".
CREATE INDEX player_ratings_replay_idx ON player_ratings (rating_system, effective_at);

-- Refresh the cache on `players` whenever a ledger row lands.
CREATE OR REPLACE FUNCTION sync_player_rating_cache()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE players p
     SET rating_mu         = NEW.mu,
         rating_sigma      = NEW.sigma,
         rating_system     = NEW.rating_system,
         rating_updated_at = NEW.effective_at
   WHERE p.id = NEW.player_id
     -- Ignore out-of-order backfill rows; only advance the cache.
     AND (p.rating_updated_at IS NULL OR NEW.effective_at >= p.rating_updated_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER player_ratings_sync_cache AFTER INSERT ON player_ratings
  FOR EACH ROW EXECUTE FUNCTION sync_player_rating_cache();

-- ---------------------------------------------------------------------------
-- Social graph. Feeds the balancer's friendship/separation penalties.
-- ---------------------------------------------------------------------------
CREATE TABLE player_relationships (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  other_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  -- 'declared' = the player asked for it. 'inferred' = the admin kept overriding the
  -- balancer until we noticed. Inferred preferences carry less weight (see teams module).
  origin         TEXT NOT NULL DEFAULT 'declared',
  weight         NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT player_relationships_kind_check CHECK (kind IN ('play_with','play_against','avoid')),
  CONSTRAINT player_relationships_origin_check CHECK (origin IN ('declared','inferred')),
  CONSTRAINT player_relationships_not_self CHECK (player_id <> other_player_id)
);

CREATE UNIQUE INDEX player_relationships_unique
  ON player_relationships (player_id, other_player_id, kind);
CREATE INDEX player_relationships_other_idx ON player_relationships (other_player_id);

CREATE TRIGGER player_relationships_set_updated_at BEFORE UPDATE ON player_relationships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
