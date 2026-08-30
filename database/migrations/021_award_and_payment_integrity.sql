-- 021_award_and_payment_integrity.sql
-- Two things the schema permitted that the game does not.

-- ---------------------------------------------------------------------------
-- One man of the match per game.
-- ---------------------------------------------------------------------------
--
-- `match_awards_unique` is on (game_id, award_type, player_id), which stops the same
-- player being given the same award twice and stops nothing else. Two DIFFERENT players
-- could both hold 'motm' for one match.
--
-- That is wrong on its own terms -- there is one man of the match -- and it had a second,
-- quieter cost: any query that joins a game to its award to show "3-1, MOTM Fares"
-- returns the game once per award row, so a single fixture appeared twice in the list.
-- The application now reads the award through a LATERAL that takes one row, but the
-- constraint is the actual fix; the LATERAL is the belt.
--
-- The other award types are deliberately left alone. Two players can share best goal.
DELETE FROM match_awards a
 USING match_awards b
 WHERE a.game_id = b.game_id
   AND a.award_type = 'motm' AND b.award_type = 'motm'
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX match_awards_one_motm_per_game
  ON match_awards (game_id) WHERE award_type = 'motm';

-- ---------------------------------------------------------------------------
-- An award, a payment and a live match event belong to somebody who is in the game.
-- ---------------------------------------------------------------------------
--
-- Every one of these is written from an admin screen that only offers players on the
-- roster, so in practice the ids are always right. In practice is not a guarantee: the
-- endpoints take a playerId from the request body, and an admin with a stale tab, a
-- copied id, or a scripted client could record a payment against somebody who is not in
-- the game -- money attributed to the wrong person, with nothing to catch it.
--
-- Enforced as a trigger rather than a composite foreign key because the roster lives in
-- `registrations`, whose key is (id), and the relation we need is "there exists a live
-- registration for this game and this player". A FK cannot express that.
CREATE OR REPLACE FUNCTION assert_player_in_game()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM registrations r
     WHERE r.game_id = NEW.game_id
       AND r.player_id = NEW.player_id
       AND r.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'player % is not on the roster for game %', NEW.player_id, NEW.game_id
      USING ERRCODE = '23514', CONSTRAINT = 'player_must_be_on_the_roster';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER match_awards_player_on_roster
  BEFORE INSERT OR UPDATE OF player_id, game_id ON match_awards
  FOR EACH ROW EXECUTE FUNCTION assert_player_in_game();

CREATE TRIGGER game_payments_player_on_roster
  BEFORE INSERT OR UPDATE OF player_id, game_id ON game_payments
  FOR EACH ROW EXECUTE FUNCTION assert_player_in_game();

-- ---------------------------------------------------------------------------
-- Indexes for the reads the product actually performs.
-- ---------------------------------------------------------------------------

-- Every game list now folds in the current result. Without this, that is a sequential
-- scan of match_results per page of fixtures.
CREATE INDEX IF NOT EXISTS match_results_current_idx
  ON match_results (game_id) WHERE is_current;

-- "Which games has this player been in", which is the player profile, the district
-- player count, and the reliability figures.
CREATE INDEX IF NOT EXISTS registrations_player_live_idx
  ON registrations (player_id, game_id) WHERE status <> 'cancelled';

-- The leaderboard's goal and assist boards fold match_events per player.
CREATE INDEX IF NOT EXISTS match_events_player_live_idx
  ON match_events (player_id, type) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS match_events_assist_live_idx
  ON match_events (assist_id) WHERE assist_id IS NOT NULL AND voided_at IS NULL;
