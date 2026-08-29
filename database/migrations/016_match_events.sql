-- 016_match_events.sql
-- What happened during the match, as it happens.
--
-- The live score is NOT a column. It is a fold over this table.
--
-- A stored score and a list of scorers are two representations of one fact, and two
-- representations of one fact drift. The admin taps +1 for the black team, then taps a
-- scorer, then undoes one of them, and now the header says 3-2 while four goals are
-- listed. Deriving the score means that cannot happen: there is one place a goal exists,
-- and everything else reads it.
--
-- It also gives a timeline for free -- "who scored in the 70th minute" is a SELECT, not
-- a feature -- and it makes correction honest, because an event is voided rather than
-- decremented and the record still shows what the admin originally saw.
--
-- player_match_stats (007) stays. It is the settled, post-match aggregate that ratings
-- and leaderboards read; this table is the live log it is computed from at full time.

CREATE TABLE match_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_id       UUID REFERENCES game_teams(id) ON DELETE SET NULL,
  player_id     UUID REFERENCES players(id) ON DELETE SET NULL,
  assist_id     UUID REFERENCES players(id) ON DELETE SET NULL,

  type          TEXT NOT NULL,
  -- Minute of PLAY, derived from the clock at the moment it was recorded, not wall time.
  -- A match that kicked off 20 minutes late still has a goal in the 12th minute.
  minute        INT,
  period        TEXT,
  note          TEXT,

  -- Corrections void, they do not delete: the same reasoning as game_payments.
  voided_at     TIMESTAMPTZ,
  voided_by     UUID REFERENCES users(id),

  recorded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT match_events_type_check CHECK (type IN
    ('goal','own_goal','yellow_card','red_card','substitution','penalty_missed','save')),
  CONSTRAINT match_events_period_check CHECK (period IS NULL OR period IN
    ('first_half','second_half')),
  CONSTRAINT match_events_minute_sane CHECK (minute IS NULL OR (minute >= 0 AND minute <= 200)),
  -- A goal has to be credited to a team, or it cannot be counted.
  CONSTRAINT match_events_goal_has_team CHECK (
    type NOT IN ('goal','own_goal') OR team_id IS NOT NULL
  )
);

CREATE INDEX match_events_game_idx ON match_events (game_id, created_at)
  WHERE voided_at IS NULL;
CREATE INDEX match_events_player_idx ON match_events (player_id) WHERE voided_at IS NULL;

COMMENT ON COLUMN match_events.team_id IS
  'The team the goal COUNTS FOR. An own goal is stored against the team that benefits, so
   summing by team_id is always the score and never needs a special case.';

-- The live score, folded. One row per team per game.
CREATE OR REPLACE VIEW game_live_score AS
  SELECT t.game_id,
         t.id AS team_id,
         t.color,
         t.name,
         COUNT(e.id) FILTER (WHERE e.type IN ('goal','own_goal'))::INT AS score,
         COUNT(e.id) FILTER (WHERE e.type = 'goal')::INT               AS goals,
         COUNT(e.id) FILTER (WHERE e.type = 'own_goal')::INT           AS own_goals
    FROM game_teams t
    LEFT JOIN match_events e
      ON e.team_id = t.id AND e.voided_at IS NULL
   GROUP BY t.game_id, t.id, t.color, t.name;
