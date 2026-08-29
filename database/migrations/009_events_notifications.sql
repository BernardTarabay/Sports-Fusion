-- 009_events_notifications.sql
-- Domain events (transactional outbox) and the notification pipeline.
--
-- The outbox pattern is what makes in-process domain events reliable without
-- microservices. An event row is INSERTed in the SAME transaction as the state change
-- that produced it. Either both commit or neither does, so it is impossible to promote
-- a player from the waitlist and fail to tell them, or to tell them and fail to promote
-- them. The worker polls unprocessed rows and dispatches to listeners.
--
-- This is the boring, correct version of the thing people buy Kafka for.

CREATE TABLE domain_events (
  id              BIGSERIAL PRIMARY KEY,
  event_type      TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    UUID NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  -- Set when attempts exhaust. Poison messages leave the queue but not the record.
  dead_lettered_at TIMESTAMPTZ,

  actor_user_id   UUID REFERENCES users(id),
  correlation_id  UUID,

  CONSTRAINT domain_events_type_check CHECK (event_type IN (
    'PlayerRegistered',
    'PlayerCancelled',
    'PlayerWaitlisted',
    'PlayerPromotedFromWaitlist',
    'GameCreated',
    'GameRegistrationOpened',
    'GameFilled',
    'GameCancelled',
    'TeamsGenerated',
    'TeamsOverridden',
    'GameStarted',
    'GameCompleted',
    'MatchResultSubmitted',
    'MatchResultCorrected',
    'AttendanceRecorded',
    'RatingsUpdated',
    'RewardIssued',
    'RewardRedeemed',
    'AchievementEarned'
  ))
);

-- The worker's hot query: unprocessed, due, oldest first.
CREATE INDEX domain_events_pending_idx ON domain_events (available_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX domain_events_aggregate_idx ON domain_events (aggregate_type, aggregate_id, occurred_at);
CREATE INDEX domain_events_type_idx ON domain_events (event_type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Notifications. One row per intended message per channel.
--
-- WhatsApp specifics live here because the Business Platform has rules that a generic
-- "message" table cannot express: messages outside the 24-hour customer service window
-- must use a pre-approved template, and each conversation costs money.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id       UUID REFERENCES players(id) ON DELETE CASCADE,

  channel         TEXT NOT NULL,
  template_key    TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  rendered_body   TEXT,

  -- What this notification is about, for dedupe and for "mute this game".
  reference_type  TEXT,
  reference_id    UUID,
  event_id        BIGINT REFERENCES domain_events(id),

  status          TEXT NOT NULL DEFAULT 'pending',
  scheduled_for   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  error           TEXT,

  provider              TEXT,
  provider_message_id   TEXT,
  provider_conversation_id TEXT,
  provider_cost         NUMERIC(10,5),
  provider_currency     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notifications_channel_check
    CHECK (channel IN ('whatsapp','push','email','sms','in_app')),
  CONSTRAINT notifications_status_check
    CHECK (status IN ('pending','sending','sent','delivered','read','failed','cancelled','suppressed'))
);

CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX notifications_due_idx ON notifications (scheduled_for)
  WHERE status = 'pending';
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_reference_idx ON notifications (reference_type, reference_id);
-- Never send the same thing twice for the same cause.
CREATE UNIQUE INDEX notifications_dedupe_idx
  ON notifications (user_id, channel, template_key, reference_type, reference_id)
  WHERE status <> 'failed' AND reference_id IS NOT NULL;

-- Per-player channel consent and quiet hours. WhatsApp opt-in is a legal requirement,
-- not a preference toggle.
CREATE TABLE notification_preferences (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL,
  category          TEXT NOT NULL,
  is_enabled        BOOLEAN NOT NULL DEFAULT true,
  opted_in_at       TIMESTAMPTZ,
  opted_out_at      TIMESTAMPTZ,
  quiet_hours_start TIME,
  quiet_hours_end   TIME,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_preferences_channel_check
    CHECK (channel IN ('whatsapp','push','email','sms','in_app')),
  CONSTRAINT notification_preferences_category_check
    CHECK (category IN ('registration','waitlist','teams','reminder','result','rewards','marketing'))
);

CREATE UNIQUE INDEX notification_preferences_unique
  ON notification_preferences (user_id, channel, category);

-- ---------------------------------------------------------------------------
-- Admin-facing generated announcements: the copy/paste bridge to the WhatsApp
-- communities that the Business Platform cannot post into.
-- ---------------------------------------------------------------------------
CREATE TABLE announcements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID REFERENCES games(id) ON DELETE CASCADE,
  district_id   UUID REFERENCES districts(id),
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  generated_by  TEXT NOT NULL DEFAULT 'template',
  copied_at     TIMESTAMPTZ,
  copied_by     UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT announcements_kind_check
    CHECK (kind IN ('registration_open','filling_up','game_full','teams','reminder','result','cancelled')),
  CONSTRAINT announcements_generated_by_check
    CHECK (generated_by IN ('template','gemini','manual'))
);

CREATE INDEX announcements_game_idx ON announcements (game_id, created_at DESC);
