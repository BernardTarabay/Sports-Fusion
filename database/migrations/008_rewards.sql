-- 008_rewards.sql
-- Seasons, the points ledger, the reward catalogue, and redemptions.
--
-- Points are a LIABILITY, not a score. Every unredeemed point is a promise Sports
-- Fusion has made against Shopify margin. The ledger is append-only double-entry-ish:
-- earning inserts a positive row, redeeming inserts a negative row, expiry inserts a
-- negative row. The balance is never edited directly, so outstanding liability is
-- always answerable with one SUM and always defensible to the owners.
--
-- Earn rates and sink prices deliberately live in the reward_catalogue table rather
-- than in code, because they will need retuning once real margin data exists and that
-- must not require a deploy.

CREATE TABLE seasons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  starts_on    DATE NOT NULL,
  ends_on      DATE NOT NULL,
  is_current   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT seasons_date_order CHECK (ends_on > starts_on)
);

CREATE UNIQUE INDEX seasons_one_current ON seasons (is_current) WHERE is_current;

-- ---------------------------------------------------------------------------
-- Append-only points ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE point_transactions (
  id              BIGSERIAL PRIMARY KEY,
  player_id       UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_id       UUID REFERENCES seasons(id),

  delta           INT NOT NULL,
  reason          TEXT NOT NULL,

  -- What caused this, so a player can be shown "why do I have these points".
  reference_type  TEXT,
  reference_id    UUID,

  -- Cash value of the points at issue time, in the currency the owners actually
  -- account in. This is what turns "1,250 points" into a number on a balance sheet.
  liability_value NUMERIC(10,4),
  currency        TEXT NOT NULL DEFAULT 'USD',

  expires_at      TIMESTAMPTZ,
  expired_at      TIMESTAMPTZ,

  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT point_transactions_reason_check CHECK (reason IN
    ('game_played','on_time_bonus','motm','referral','streak','purchase',
     'challenge_win','manual_grant','redemption','expiry','correction')),
  CONSTRAINT point_transactions_nonzero CHECK (delta <> 0)
);

CREATE INDEX point_transactions_player_idx ON point_transactions (player_id, created_at DESC);
CREATE INDEX point_transactions_season_idx ON point_transactions (season_id);
CREATE INDEX point_transactions_expiry_idx ON point_transactions (expires_at)
  WHERE expired_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX point_transactions_reference_idx ON point_transactions (reference_type, reference_id);

-- Cache the balance on players. Ledger stays truth.
CREATE OR REPLACE FUNCTION sync_player_points_cache()
RETURNS TRIGGER AS $fn$
BEGIN
  UPDATE players SET points_balance = points_balance + NEW.delta WHERE id = NEW.player_id;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER point_transactions_sync_cache AFTER INSERT ON point_transactions
  FOR EACH ROW EXECUTE FUNCTION sync_player_points_cache();

-- Outstanding liability, in one query, at any moment.
CREATE VIEW reward_liability AS
SELECT
  COALESCE(SUM(delta), 0)                          AS outstanding_points,
  -- liability_value is signed: positive when points are issued, negative when they are
  -- redeemed or expire. So the running total IS the outstanding liability.
  COALESCE(SUM(liability_value), 0)                AS outstanding_value,
  COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0) AS lifetime_points_issued,
  COUNT(DISTINCT player_id)                        AS players_holding
FROM point_transactions
WHERE expired_at IS NULL;

-- ---------------------------------------------------------------------------
-- What points can be spent on. Priced against margin, editable without a deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE reward_catalogue (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT,
  point_cost         INT NOT NULL,
  -- What this actually costs Sports Fusion when redeemed. The number that decides
  -- whether the economy works.
  unit_cost          NUMERIC(10,2),
  currency           TEXT NOT NULL DEFAULT 'USD',

  fulfilment_type    TEXT NOT NULL,
  shopify_variant_id TEXT,
  discount_percent   NUMERIC(5,2),

  stock_remaining    INT,
  max_per_player     INT,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reward_catalogue_cost_positive CHECK (point_cost > 0),
  CONSTRAINT reward_catalogue_fulfilment_check
    CHECK (fulfilment_type IN ('shopify_discount','shopify_product','free_game','manual'))
);

CREATE TRIGGER reward_catalogue_set_updated_at BEFORE UPDATE ON reward_catalogue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reward_redemptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reward_id      UUID NOT NULL REFERENCES reward_catalogue(id),
  transaction_id BIGINT REFERENCES point_transactions(id),

  points_spent   INT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  discount_code  TEXT,
  shopify_order_id TEXT,
  fulfilled_at   TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reward_redemptions_status_check
    CHECK (status IN ('pending','fulfilled','cancelled','refunded'))
);

CREATE TRIGGER reward_redemptions_set_updated_at BEFORE UPDATE ON reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX reward_redemptions_player_idx ON reward_redemptions (player_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Achievements. Lifetime, so they survive seasonal resets.
-- ---------------------------------------------------------------------------
CREATE TABLE achievements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,
  category     TEXT,
  points_award INT NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE player_achievements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  game_id        UUID REFERENCES games(id),
  earned_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX player_achievements_unique ON player_achievements (player_id, achievement_id);
CREATE INDEX player_achievements_player_idx ON player_achievements (player_id);
