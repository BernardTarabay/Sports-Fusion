-- 006_teams.sql
-- Generated teams, and the record of how they were generated.
--
-- REPRODUCIBILITY IS A FIRST-CLASS REQUIREMENT.
--
-- team_generation_runs stores the seed, the algorithm version, the exact weights, the
-- rating snapshot, and the score breakdown of the chosen split. Given that row, the
-- balancer produces byte-identical teams. When an admin asks "why is George on Black",
-- the answer is a stored score breakdown, not a shrug.
--
-- Multiple runs per game are kept. Regenerating does not erase the previous attempt;
-- exactly one run is is_active at a time.

CREATE TABLE team_generation_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id            UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,

  algorithm_version  TEXT NOT NULL,
  seed               BIGINT NOT NULL,
  weights            JSONB NOT NULL,
  -- Ratings as they stood at generation time. Without this, a later rating change
  -- makes the run unreproducible.
  rating_snapshot    JSONB NOT NULL,

  candidates_evaluated INT,
  shortlist_size     INT,
  chosen_rank        INT,
  score              NUMERIC(10,4),
  score_breakdown    JSONB,
  duration_ms        INT,

  is_active          BOOLEAN NOT NULL DEFAULT true,
  superseded_by      UUID REFERENCES team_generation_runs(id),
  generated_by       UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX team_generation_runs_one_active
  ON team_generation_runs (game_id) WHERE is_active;
CREATE INDEX team_generation_runs_game_idx ON team_generation_runs (game_id, created_at DESC);

CREATE TABLE game_teams (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  run_id       UUID REFERENCES team_generation_runs(id) ON DELETE CASCADE,
  color        TEXT NOT NULL,
  name         TEXT,
  -- Sum of rating_mu at generation time, so the announcement can show the balance
  -- that was actually achieved rather than recomputing against drifted ratings.
  strength     NUMERIC(10,3),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT game_teams_color_check CHECK (color IN ('black','white','red','blue','yellow','green'))
);

CREATE UNIQUE INDEX game_teams_unique_color ON game_teams (game_id, color);
CREATE INDEX game_teams_run_idx ON game_teams (run_id);

CREATE TABLE team_players (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id            UUID NOT NULL REFERENCES game_teams(id) ON DELETE CASCADE,
  game_id            UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id          UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,

  assigned_position  TEXT,
  is_captain         BOOLEAN NOT NULL DEFAULT false,

  -- Admin overrides are the training signal for inferred preferences (004).
  -- When an admin repeatedly moves two players together, that is data.
  is_manual_override BOOLEAN NOT NULL DEFAULT false,
  moved_from_team_id UUID REFERENCES game_teams(id),
  moved_by           UUID REFERENCES users(id),
  moved_at           TIMESTAMPTZ,

  -- Rating snapshot at assignment. Lets the post-match view show what the system
  -- believed before the game, which is how you audit whether it was right.
  rating_mu_at_assignment    NUMERIC(8,3),
  rating_sigma_at_assignment NUMERIC(8,3),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A player appears on exactly one team per game.
CREATE UNIQUE INDEX team_players_one_team_per_game ON team_players (game_id, player_id);
CREATE INDEX team_players_team_idx   ON team_players (team_id);
CREATE INDEX team_players_player_idx ON team_players (player_id);

-- ---------------------------------------------------------------------------
-- Pair history. Drives the anti-repetition penalty: without it the balancer finds
-- the same optimum every week and the league becomes two fixed teams.
-- Derived from team_players; materialised because the balancer reads it 352,716 times.
-- ---------------------------------------------------------------------------
CREATE TABLE player_pair_history (
  player_a_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_b_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  same_team_count     INT NOT NULL DEFAULT 0,
  opposite_team_count INT NOT NULL DEFAULT 0,
  last_same_team_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (player_a_id, player_b_id),
  -- Canonical ordering so each pair has exactly one row.
  CONSTRAINT player_pair_ordered CHECK (player_a_id < player_b_id)
);

CREATE INDEX player_pair_history_b_idx ON player_pair_history (player_b_id);
