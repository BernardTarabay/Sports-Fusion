-- 023_team_lock_is_a_choice.sql
-- Whether the team sheet can be edited is the admin's decision, not the clock's.

-- The matchday screen has a Lock/Unlock control, and it never did anything: the flag it
-- toggled was sent to an endpoint that ignores it, and `lockedTeams` was computed as
-- `status IN ('in_progress','completed')`. So the moment a match kicked off the tactical
-- board went read-only permanently, the unlock button could not bring it back, and an
-- admin who wanted to move somebody at half time had no way to.
--
-- Which is backwards. The person standing at the side of the pitch is the one who knows
-- a player has turned an ankle and someone has to drop back. The lock is worth having --
-- a phone in a pocket during a match is a hazard -- but as something an admin switches
-- on deliberately, defaulting to off.
ALTER TABLE games ADD COLUMN teams_locked BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN games.teams_locked IS
  'Admin-set guard on the team sheet. Not derived from status: an admin must be able to '
  'move a player during a match.';
