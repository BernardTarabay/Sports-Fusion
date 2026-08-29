-- 010_audit.sql
-- Admin action log, and the reconciliation helper for trigger-maintained caches.
--
-- Two people run this business. When a player says "someone took my spot", the answer
-- has to be a row, not a memory.

CREATE TABLE admin_actions (
  id           BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id),
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    UUID,
  district_id  UUID REFERENCES districts(id),

  -- Before/after snapshots of only the fields that changed.
  before       JSONB,
  after        JSONB,
  reason       TEXT,

  ip_address   INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX admin_actions_actor_idx  ON admin_actions (actor_user_id, created_at DESC);
CREATE INDEX admin_actions_entity_idx ON admin_actions (entity_type, entity_id, created_at DESC);
CREATE INDEX admin_actions_created_idx ON admin_actions (created_at DESC);

-- ---------------------------------------------------------------------------
-- Cache reconciliation. Every denormalised counter in this schema is derivable.
-- Run from scripts/reconcile.js on a schedule; it should never find anything, and
-- the day it does you want to know rather than to wonder.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reconcile_game_counts()
RETURNS TABLE (game_id UUID, field TEXT, cached INT, actual INT) AS $fn$
BEGIN
  RETURN QUERY
  WITH actual AS (
    SELECT g.id,
           g.confirmed_count,
           g.waitlist_count,
           COUNT(*) FILTER (WHERE r.status = 'confirmed')::INT  AS real_confirmed,
           COUNT(*) FILTER (WHERE r.status = 'waitlisted')::INT AS real_waitlist
      FROM games g
      LEFT JOIN registrations r ON r.game_id = g.id
     GROUP BY g.id, g.confirmed_count, g.waitlist_count
  )
  SELECT a.id, 'confirmed_count'::TEXT, a.confirmed_count, a.real_confirmed
    FROM actual a WHERE a.confirmed_count <> a.real_confirmed
  UNION ALL
  SELECT a.id, 'waitlist_count'::TEXT, a.waitlist_count, a.real_waitlist
    FROM actual a WHERE a.waitlist_count <> a.real_waitlist;
END;
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reconcile_player_points()
RETURNS TABLE (player_id UUID, cached INT, actual INT) AS $fn$
BEGIN
  RETURN QUERY
  SELECT p.id, p.points_balance, COALESCE(SUM(pt.delta), 0)::INT
    FROM players p
    LEFT JOIN point_transactions pt ON pt.player_id = p.id
   GROUP BY p.id, p.points_balance
  HAVING p.points_balance <> COALESCE(SUM(pt.delta), 0)::INT;
END;
$fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Reliability. Deliberately a VIEW, not a stored score.
--
-- Per the registration policy: reliability does NOT displace anyone from a full game
-- in V1. It informs waitlist promotion order, reminder aggressiveness, and admin
-- recommendations only. Keeping it a view means the definition can be retuned without
-- a migration, and no player ever has a stale judgement stored against their name.
-- ---------------------------------------------------------------------------
CREATE VIEW player_reliability AS
SELECT
  p.id AS player_id,
  COUNT(r.id) FILTER (WHERE r.status <> 'cancelled')                      AS registrations,
  COUNT(r.id) FILTER (WHERE r.attendance = 'attended')                    AS attended,
  COUNT(r.id) FILTER (WHERE r.attendance = 'late')                        AS arrived_late,
  COUNT(r.id) FILTER (WHERE r.attendance = 'no_show')                     AS no_shows,
  COUNT(r.id) FILTER (WHERE r.status = 'cancelled' AND r.cancel_lead_hours < 24) AS late_cancellations,
  CASE
    WHEN COUNT(r.id) FILTER (WHERE r.status <> 'cancelled') = 0 THEN NULL
    ELSE ROUND(
      100.0 * COUNT(r.id) FILTER (WHERE r.attendance IN ('attended','late'))
            / NULLIF(COUNT(r.id) FILTER (WHERE r.status <> 'cancelled'), 0), 1)
  END AS attendance_rate
FROM players p
LEFT JOIN registrations r ON r.player_id = p.id
GROUP BY p.id;
