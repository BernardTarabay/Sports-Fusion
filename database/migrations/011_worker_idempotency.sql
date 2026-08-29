-- 011_worker_idempotency.sql
-- Constraints that let the worker retry safely.
--
-- The event dispatcher is at-least-once: a crash between doing the work and marking the
-- event processed means the event runs again. Rather than trying to make delivery
-- exactly-once (which is not achievable), every automatic side effect is made idempotent
-- so that running it twice is indistinguishable from running it once.

-- A player earns each automatic award at most once per game. Manual grants and
-- corrections are excluded, because an admin may legitimately grant twice.
CREATE UNIQUE INDEX point_transactions_once_per_reference
  ON point_transactions (player_id, reason, reference_type, reference_id)
  WHERE reference_id IS NOT NULL
    AND reason IN ('game_played', 'on_time_bonus', 'motm', 'streak', 'referral', 'challenge_win');

-- Pair history must only count a completed game once, however many times the
-- GameCompleted handler runs.
ALTER TABLE player_pair_history
  ADD COLUMN last_game_id UUID REFERENCES games(id);

CREATE TABLE game_pair_history_applied (
  game_id     UUID PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lets the notification dispatcher find rows abandoned by a worker that died mid-send.
CREATE INDEX notifications_stale_sending_idx ON notifications (updated_at)
  WHERE status = 'sending';

-- The reminder sweep looks for games about to kick off that still have confirmed players.
CREATE INDEX games_kickoff_pending_idx ON games (kickoff_at)
  WHERE status IN ('registration_open', 'full', 'teams_generated');

-- Worker bookkeeping: when each periodic job last ran, so a restarted worker does not
-- re-run everything immediately and a stalled job is visible.
CREATE TABLE job_runs (
  job_name      TEXT PRIMARY KEY,
  last_run_at   TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error    TEXT,
  run_count     INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER job_runs_set_updated_at BEFORE UPDATE ON job_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
