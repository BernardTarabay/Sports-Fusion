-- 022_pitch_slots_and_match_ratings.sql
-- Two things the matchday screen has always let an admin do, and the database had
-- nowhere to remember.

-- ---------------------------------------------------------------------------
-- Where a player is standing.
-- ---------------------------------------------------------------------------
--
-- The tactical board lets an admin drag a player onto a position, and the position was
-- never stored. `team_players` recorded WHICH TEAM somebody was on and nothing about
-- where; the pitch inferred a slot from the player's index in an array that came back
-- ordered by `assigned_position` -- alphabetically. So the arrangement an admin built
-- survived exactly until the next refetch, and `applyOverride` skipped same-team moves
-- outright (`if (rows[0].team_id === move.toTeamId) continue`), which meant moving
-- somebody from left back to right wing was a no-op on the server.
--
-- It also made an empty slot un-droppable. With a dense array, "slot 7" only exists once
-- seven players do, so a squad of five could not have anybody standing at the far post.
-- A nullable slot_index is what makes a gap a real place.
ALTER TABLE team_players ADD COLUMN slot_index INT;

ALTER TABLE team_players ADD CONSTRAINT team_players_slot_nonneg
  CHECK (slot_index IS NULL OR slot_index >= 0);

-- Two players cannot stand in the same place. Partial, because NULL means "not placed
-- yet" and any number of players may be waiting to be placed.
CREATE UNIQUE INDEX team_players_one_player_per_slot
  ON team_players (team_id, slot_index) WHERE slot_index IS NOT NULL;

-- Backfill from the ordering the application was already using, so existing team sheets
-- keep the arrangement they appear to have rather than being reshuffled by the upgrade.
WITH ordered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY team_id
           ORDER BY assigned_position NULLS LAST, created_at, id
         ) - 1 AS idx
    FROM team_players
)
UPDATE team_players tp
   SET slot_index = ordered.idx
  FROM ordered
 WHERE ordered.id = tp.id;

CREATE INDEX team_players_slot_idx ON team_players (team_id, slot_index);

-- ---------------------------------------------------------------------------
-- What an admin thought of the performance.
-- ---------------------------------------------------------------------------
--
-- The player panel on the matchday screen has always had a 1-10 match rating slider.
-- Dragging it sent `{ rating }` to an endpoint whose schema does not mention rating, and
-- `validate` strips unknown keys before the "nothing to change" refinement runs -- so the
-- slider answered 422 every single time and the number was never stored anywhere.
--
-- Deliberately NOT the Glicko rating. That one is derived from results and replayed from
-- the ledger; a human number written into it would be erased by the next replay. This is
-- an opinion about one performance, it lives beside the goals and assists for that game,
-- and the rating engine does not read it.
ALTER TABLE player_match_stats ADD COLUMN match_rating NUMERIC(3,1);

ALTER TABLE player_match_stats ADD CONSTRAINT player_match_stats_rating_range
  CHECK (match_rating IS NULL OR (match_rating >= 1 AND match_rating <= 10));

ALTER TABLE player_match_stats ADD COLUMN rated_by UUID REFERENCES users(id);

COMMENT ON COLUMN player_match_stats.match_rating IS
  'Admin''s 1-10 opinion of this performance. Not the Glicko rating, which is derived.';
