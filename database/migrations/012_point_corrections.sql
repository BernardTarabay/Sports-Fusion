-- 012_point_corrections.sql
-- Makes point adjustments auditable when a result or an attendance record is corrected.
--
-- Points depend on attendance, and attendance gets corrected: someone marked present who
-- never showed, someone marked absent who did play. Rather than editing the original
-- award (which would destroy the record) or blocking corrections (which would leave the
-- balance wrong), a correction inserts a COMPENSATING row.
--
-- `corrects_reason` says which award the compensating row adjusts, so the net position
-- for a player is groupable:
--
--   SELECT player_id, COALESCE(corrects_reason, reason) AS award, SUM(delta)
--     FROM point_transactions
--    WHERE reference_type = 'game' AND reference_id = $1
--    GROUP BY 1, 2;
--
-- The existing point_transactions_once_per_reference index still guarantees one ORIGINAL
-- award per player per game; corrections carry reason = 'correction' and are exempt,
-- which is what allows an attendance record to be revised more than once.

ALTER TABLE point_transactions
  ADD COLUMN corrects_reason TEXT;

ALTER TABLE point_transactions
  ADD CONSTRAINT point_transactions_corrects_reason_check
  CHECK (
    corrects_reason IS NULL
    OR (reason = 'correction' AND corrects_reason IN
        ('game_played', 'on_time_bonus', 'motm', 'streak', 'referral', 'challenge_win'))
  );

CREATE INDEX point_transactions_award_net_idx
  ON point_transactions (reference_type, reference_id, player_id, COALESCE(corrects_reason, reason));

-- Results and awards are read together on every post-match page.
CREATE INDEX match_awards_game_idx ON match_awards (game_id);

-- Peer ratings are summarised per game for the anomaly check.
CREATE INDEX peer_ratings_game_idx ON peer_ratings (game_id, rated_id);
