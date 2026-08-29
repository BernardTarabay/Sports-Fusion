-- 015_matchday.sql
-- The match clock, per-game payments, and the pitch formation.
--
-- These three are what an admin actually touches while standing at the side of a pitch,
-- and none of them existed: the frontend was calling endpoints with nothing behind them.

-- ---------------------------------------------------------------------------
-- THE MATCH CLOCK
--
-- Stored as transition timestamps, never as a ticking counter.
--
-- A counter in a column has to be written by something, and whatever writes it becomes
-- a liability: it drifts when the process restarts, it double-counts when two tabs are
-- open, and it is wrong for every client that reloads. Timestamps have none of those
-- problems. The server records WHEN each period began; every client derives the elapsed
-- time itself. Two phones watching the same match agree because they are both reading
-- the same three timestamps, not because anything is being synchronised.
--
-- elapsed = elapsed_ms_at_period_start + (now - period_started_at) - paused_ms
--
-- Stoppages (injury, a lost ball, an argument) pause the clock, which is why paused_ms
-- is accumulated per period rather than inferred.
-- ---------------------------------------------------------------------------

ALTER TABLE games
  ADD COLUMN halftime_minutes INT NOT NULL DEFAULT 15,
  -- The formation the pitch is drawn with. One per game: both teams share the view,
  -- mirrored, exactly as the pitch renders it.
  ADD COLUMN formation TEXT,

  ADD COLUMN clock_state TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN started_at TIMESTAMPTZ,              -- real kickoff, set once, never moved
  ADD COLUMN ended_at TIMESTAMPTZ,
  ADD COLUMN period_started_at TIMESTAMPTZ,       -- when the CURRENT period began
  ADD COLUMN elapsed_ms_at_period_start BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN paused_at TIMESTAMPTZ,               -- non-null while stopped
  ADD COLUMN paused_ms BIGINT NOT NULL DEFAULT 0, -- accumulated stoppage, current period

  ADD CONSTRAINT games_clock_state_check CHECK (clock_state IN
    ('not_started','first_half','halftime','second_half','finished','abandoned')),
  ADD CONSTRAINT games_halftime_sane CHECK (halftime_minutes >= 0 AND halftime_minutes <= 60),
  ADD CONSTRAINT games_paused_ms_sane CHECK (paused_ms >= 0 AND elapsed_ms_at_period_start >= 0),
  -- A clock that has left 'not_started' must know when it started. Prevents a half-written
  -- transition leaving a match that is somehow running but has no kickoff time.
  ADD CONSTRAINT games_clock_started CHECK (
    clock_state = 'not_started' OR started_at IS NOT NULL
  ),
  ADD CONSTRAINT games_clock_finished CHECK (
    clock_state NOT IN ('finished','abandoned') OR ended_at IS NOT NULL
  );

CREATE INDEX games_live_idx ON games (clock_state)
  WHERE clock_state IN ('first_half','halftime','second_half');

COMMENT ON COLUMN games.elapsed_ms_at_period_start IS
  'Play time already banked when the current period began. Clients add the live delta.';

-- ---------------------------------------------------------------------------
-- PAYMENTS
--
-- One row per player per game. Absence of a row means unpaid -- an admin should never
-- have to create 22 rows to record that nobody has paid yet.
--
-- Money gets a real audit trail: who recorded it, when, how much, and in what currency,
-- frozen at the time of recording rather than read back from the game (which an admin
-- may edit later).
-- ---------------------------------------------------------------------------

CREATE TABLE game_payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,

  amount       NUMERIC(10,2),
  currency     TEXT NOT NULL DEFAULT 'USD',
  method       TEXT NOT NULL DEFAULT 'cash',

  paid_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by  UUID REFERENCES users(id),
  -- True when recorded during the settlement window after the final whistle, so
  -- "paid late" stays distinguishable from "paid on the night".
  settled_late BOOLEAN NOT NULL DEFAULT false,
  note         TEXT,

  -- Unmarking VOIDS, it does not delete.
  --
  -- An admin who taps the wrong face and corrects it has produced two facts, not zero,
  -- and the second one does not erase the first. Cash was said to have changed hands and
  -- then it was said not to have; when someone disputes it three weeks later the only
  -- useful answer is the sequence. Hard deletes destroy exactly the evidence you need,
  -- and this is the one table in the system that is about money.
  voided_at    TIMESTAMPTZ,
  voided_by    UUID REFERENCES users(id),
  void_reason  TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT game_payments_method_check
    CHECK (method IN ('cash','card','transfer','credit','waived')),
  CONSTRAINT game_payments_amount_sane CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT game_payments_void_complete
    CHECK ((voided_at IS NULL) = (voided_by IS NULL) OR voided_at IS NOT NULL)
);

-- A player has at most one LIVE payment per game. Partial, so a voided payment does not
-- block re-marking them paid -- which is the whole point of correcting a mistake.
-- It is also what makes "mark paid" idempotent: a double-tap on a bad connection cannot
-- create two payments.
CREATE UNIQUE INDEX game_payments_one_live
  ON game_payments (game_id, player_id) WHERE voided_at IS NULL;
CREATE INDEX game_payments_game_idx ON game_payments (game_id);

CREATE TRIGGER game_payments_set_updated_at BEFORE UPDATE ON game_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- THE PAYMENT FREEZE
--
-- Once the whistle goes, payment is frozen until the match finishes. The admin is
-- watching a game, not running a till, and a payment recorded at minute 60 is almost
-- always a misremembered tap.
--
-- This lives in the database rather than the API because it is a rule about money.
-- The frontend hides the buttons, the service layer checks the state -- and this is the
-- seatbelt underneath both, in the same spirit as games_not_overbooked. Any future
-- caller, script or admin console inherits it for free.
--
-- After 'finished' the table unlocks: that is the settlement window, where whoever
-- promised to pay after the game finally does.
--
-- INSERT and UPDATE only, deliberately. Voiding goes through UPDATE, so unmarking is
-- covered; and leaving DELETE alone means ON DELETE CASCADE still works when a game or
-- a player is removed. A trigger that guards DELETE would make a live game undeletable,
-- which is a data-integrity rule accidentally impersonating a business rule.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_payment_window() RETURNS TRIGGER AS $$
DECLARE
  state TEXT;
BEGIN
  SELECT clock_state INTO state FROM games WHERE id = NEW.game_id;

  IF state IN ('first_half','halftime','second_half') THEN
    RAISE EXCEPTION 'payments are locked while the match is in play (clock: %)', state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER game_payments_window
  BEFORE INSERT OR UPDATE ON game_payments
  FOR EACH ROW EXECUTE FUNCTION enforce_payment_window();

-- Reconciliation: what the game is owed versus what has been collected.
CREATE OR REPLACE VIEW game_payment_summary AS
  SELECT g.id AS game_id,
         g.price,
         g.currency,
         g.confirmed_count,
         COUNT(p.id)::INT AS paid_count,
         (g.confirmed_count - COUNT(p.id))::INT AS unpaid_count,
         COALESCE(SUM(p.amount), 0)::NUMERIC(12,2) AS collected,
         COUNT(p.id) FILTER (WHERE p.settled_late)::INT AS settled_late_count
    FROM games g
    LEFT JOIN game_payments p ON p.game_id = g.id AND p.voided_at IS NULL
   GROUP BY g.id, g.price, g.currency, g.confirmed_count;
