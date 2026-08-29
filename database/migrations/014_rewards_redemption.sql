-- 014_rewards_redemption.sql
-- Constraints and columns for spending points.
--
-- Points are a liability against real Shopify margin, so redemption is the one place in
-- this system where a bug costs actual money. Everything here exists to make the
-- expensive failure modes impossible rather than merely unlikely:
--
--   * spending points you do not have
--   * spending the same points twice from two tabs
--   * a double-tapped Redeem button charging twice
--   * two players being issued the same discount code
--   * points deducted but no reward ever delivered

-- The seatbelt. Like games_not_overbooked, this makes the worst outcome impossible at the
-- storage layer rather than trusting every future code path to check first.
ALTER TABLE players
  ADD CONSTRAINT players_points_non_negative CHECK (points_balance >= 0);

-- 'fulfilling' is the claimed state, mirroring notifications: committed before the
-- external call so a crash leaves a visible orphan rather than a silent double-issue.
-- 'failed' is terminal after a refund.
ALTER TABLE reward_redemptions DROP CONSTRAINT reward_redemptions_status_check;
ALTER TABLE reward_redemptions
  ADD CONSTRAINT reward_redemptions_status_check
  CHECK (status IN ('pending', 'fulfilling', 'fulfilled', 'cancelled', 'refunded', 'failed'));

ALTER TABLE point_transactions DROP CONSTRAINT point_transactions_reason_check;
ALTER TABLE point_transactions
  ADD CONSTRAINT point_transactions_reason_check CHECK (reason IN (
    'game_played', 'on_time_bonus', 'motm', 'referral', 'streak', 'purchase',
    'challenge_win', 'manual_grant', 'redemption', 'refund', 'expiry', 'correction'));

ALTER TABLE reward_redemptions
  ADD COLUMN idempotency_key         TEXT,
  ADD COLUMN attempts                INT NOT NULL DEFAULT 0,
  ADD COLUMN error                   TEXT,
  ADD COLUMN code_expires_at         TIMESTAMPTZ,
  ADD COLUMN refund_transaction_id   BIGINT REFERENCES point_transactions(id),
  ADD COLUMN unit_cost_at_redemption NUMERIC(10,2),
  ADD COLUMN currency                TEXT NOT NULL DEFAULT 'USD';

-- A double-tapped Redeem button sends the same key twice and charges once.
CREATE UNIQUE INDEX reward_redemptions_idempotency
  ON reward_redemptions (player_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Two players must never be handed the same code.
CREATE UNIQUE INDEX reward_redemptions_discount_code
  ON reward_redemptions (discount_code)
  WHERE discount_code IS NOT NULL;

CREATE INDEX reward_redemptions_pending_idx
  ON reward_redemptions (created_at)
  WHERE status = 'pending';

CREATE INDEX reward_redemptions_stale_fulfilling_idx
  ON reward_redemptions (updated_at)
  WHERE status = 'fulfilling';

CREATE INDEX reward_redemptions_reward_idx ON reward_redemptions (reward_id);

-- Stock cannot go negative. A limited run of 50 shirts means 50.
ALTER TABLE reward_catalogue
  ADD CONSTRAINT reward_catalogue_stock_non_negative
  CHECK (stock_remaining IS NULL OR stock_remaining >= 0);

ALTER TABLE reward_catalogue
  ADD COLUMN value_amount     NUMERIC(10,2),
  ADD COLUMN min_games_played INT NOT NULL DEFAULT 0,
  ADD COLUMN sort_order       INT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Liability reporting.
--
-- The owners need one number: what do we owe. This view answers it per player so
-- concentration is visible -- 400,000 outstanding points spread over 2,000 players is a
-- marketing cost, the same total held by nine people is an ambush.
-- ---------------------------------------------------------------------------
CREATE VIEW player_point_balances AS
SELECT
  p.id AS player_id,
  u.display_name,
  p.points_balance,
  COALESCE(SUM(pt.delta) FILTER (WHERE pt.delta > 0), 0)::int      AS lifetime_earned,
  COALESCE(ABS(SUM(pt.delta) FILTER (WHERE pt.delta < 0)), 0)::int AS lifetime_spent,
  COALESCE(SUM(pt.liability_value), 0)                             AS outstanding_value,
  MAX(pt.created_at)                                               AS last_activity_at
FROM players p
JOIN users u ON u.id = p.user_id
LEFT JOIN point_transactions pt ON pt.player_id = p.id AND pt.expired_at IS NULL
GROUP BY p.id, u.display_name, p.points_balance;
