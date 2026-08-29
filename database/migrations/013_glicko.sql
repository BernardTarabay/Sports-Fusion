-- 013_glicko.sql
-- Volatility, and the bookkeeping for rating replays.
--
-- NAMING, because it is genuinely confusing: Glicko-2 tracks THREE numbers per player.
--
--   rating (mu)   the skill estimate itself
--   deviation     how uncertain that estimate is  -- stored in the existing `sigma`
--                 column, which is named for the statistical convention, not for
--                 Glicko's sigma
--   volatility    how erratic the player's results are, i.e. how fast the deviation
--                 should grow between games -- Glicko-2 calls THIS sigma
--
-- The existing `sigma` column keeps its meaning (deviation / RD). Volatility gets its own
-- column. Renaming `sigma` to `deviation` would be clearer but would rewrite a column the
-- balancer, the API and three test suites already depend on, for no behavioural gain.

ALTER TABLE player_ratings
  ADD COLUMN volatility NUMERIC(8,6);

ALTER TABLE players
  ADD COLUMN rating_volatility NUMERIC(8,6) NOT NULL DEFAULT 0.06;

ALTER TABLE player_ratings
  ADD CONSTRAINT player_ratings_volatility_positive
  CHECK (volatility IS NULL OR volatility > 0);

-- Carry volatility through the cache, alongside mu and sigma.
CREATE OR REPLACE FUNCTION sync_player_rating_cache()
RETURNS TRIGGER AS $fn$
BEGIN
  UPDATE players p
     SET rating_mu         = NEW.mu,
         rating_sigma      = NEW.sigma,
         rating_volatility = COALESCE(NEW.volatility, p.rating_volatility),
         rating_system     = NEW.rating_system,
         rating_updated_at = NEW.effective_at
   WHERE p.id = NEW.player_id
     AND (p.rating_updated_at IS NULL OR NEW.effective_at >= p.rating_updated_at);
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Replay bookkeeping.
--
-- A replay recomputes every derived rating from the immutable record: admin seeds and
-- overrides as anchors, match results in chronological order as evidence. It is the
-- reason deferring the rating engine cost nothing -- the inputs were being recorded from
-- the first game.
-- ---------------------------------------------------------------------------
CREATE TABLE rating_replays (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_system     TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  -- tau, default rating, default deviation, default volatility: everything needed to
  -- reproduce this run exactly.
  parameters        JSONB NOT NULL,
  games_replayed    INT,
  players_affected  INT,
  ratings_written   INT,
  anchors_used      INT,
  duration_ms       INT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  triggered_by      UUID REFERENCES users(id),
  error             TEXT
);

CREATE INDEX rating_replays_recent_idx ON rating_replays (started_at DESC);

-- The replay walks results in chronological order and needs each game's rosters.
CREATE INDEX team_players_game_idx ON team_players (game_id);

-- Leaderboards rank by the conservative estimate (mu - 2 x deviation), so a player the
-- system barely knows cannot appear at the top on one good night.
CREATE INDEX players_conservative_rating_idx
  ON players ((rating_mu - 2 * rating_sigma) DESC)
  WHERE status = 'active';
