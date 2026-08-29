-- 007_results.sql
-- Match results, player stats, and awards.
--
-- THIS IS THE TRAINING SET.
--
-- Glicko-2 needs only (roster, roster, outcome, date). 006 stores the rosters,
-- this file stores the outcome and the date. Together they are sufficient to
-- reconstruct every player rating in Sports Fusion history from scratch, which is
-- what makes deferring the rating engine to V2 free instead of expensive.
--
-- Results are therefore append-only. A correction inserts a new row and demotes the
-- old one; it never overwrites. If a score is edited six months from now, the rating
-- replay must be able to see both what was recorded and what it was corrected to.

CREATE TABLE match_results (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id        UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,

  -- Scores keyed by team id rather than home/away, since colours vary by game.
  scores         JSONB NOT NULL,
  -- Denormalised for the common two-team case, for cheap querying.
  team_a_id      UUID REFERENCES game_teams(id),
  team_b_id      UUID REFERENCES game_teams(id),
  team_a_score   INT,
  team_b_score   INT,

  played_at      TIMESTAMPTZ NOT NULL,
  is_current     BOOLEAN NOT NULL DEFAULT true,
  version        INT NOT NULL DEFAULT 1,
  supersedes     UUID REFERENCES match_results(id),
  correction_reason TEXT,

  recorded_by    UUID REFERENCES users(id),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT match_results_scores_nonneg
    CHECK ((team_a_score IS NULL OR team_a_score >= 0)
       AND (team_b_score IS NULL OR team_b_score >= 0))
);

-- Exactly one live result per game; superseded versions stay forever.
CREATE UNIQUE INDEX match_results_one_current ON match_results (game_id) WHERE is_current;
CREATE INDEX match_results_game_idx ON match_results (game_id, version DESC);
-- The rating replay reads this: every current result in chronological order.
CREATE INDEX match_results_replay_idx ON match_results (played_at) WHERE is_current;

-- ---------------------------------------------------------------------------
-- Per-player match contribution. Optional in V1 -- entered when someone bothers.
-- ---------------------------------------------------------------------------
CREATE TABLE player_match_stats (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id       UUID REFERENCES game_teams(id),

  goals         INT NOT NULL DEFAULT 0,
  assists       INT NOT NULL DEFAULT 0,
  own_goals     INT NOT NULL DEFAULT 0,
  saves         INT NOT NULL DEFAULT 0,
  clean_sheet   BOOLEAN NOT NULL DEFAULT false,
  minutes       INT,
  position_played TEXT,

  recorded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT player_match_stats_nonneg
    CHECK (goals >= 0 AND assists >= 0 AND own_goals >= 0 AND saves >= 0)
);

CREATE UNIQUE INDEX player_match_stats_unique ON player_match_stats (game_id, player_id);
CREATE INDEX player_match_stats_player_idx ON player_match_stats (player_id);

CREATE TRIGGER player_match_stats_set_updated_at BEFORE UPDATE ON player_match_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Awards. This is the entire post-match admin workflow: score line plus three taps.
-- ---------------------------------------------------------------------------
CREATE TABLE match_awards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  award_type   TEXT NOT NULL,
  note         TEXT,
  awarded_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT match_awards_type_check CHECK (award_type IN
    ('motm','best_player','worst_player','best_goalkeeper','most_improved','best_goal'))
);

CREATE UNIQUE INDEX match_awards_unique ON match_awards (game_id, award_type, player_id);
CREATE INDEX match_awards_player_idx ON match_awards (player_id, award_type);

-- ---------------------------------------------------------------------------
-- Optional peer ratings. Deliberately structured, never free text -- the product
-- brief for this is "rate your teammates", not "tell us who was rubbish".
-- ---------------------------------------------------------------------------
CREATE TABLE peer_ratings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  rater_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  rated_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  dimension     TEXT NOT NULL,
  score         INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT peer_ratings_dimension_check
    CHECK (dimension IN ('overall','passing','defending','effort','attitude')),
  CONSTRAINT peer_ratings_score_range CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT peer_ratings_not_self CHECK (rater_id <> rated_id)
);

CREATE UNIQUE INDEX peer_ratings_unique ON peer_ratings (game_id, rater_id, rated_id, dimension);
CREATE INDEX peer_ratings_rated_idx ON peer_ratings (rated_id);
