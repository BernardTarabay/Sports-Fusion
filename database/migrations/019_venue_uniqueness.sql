-- 019_venue_uniqueness.sql
-- One pitch of a given name per district.
--
-- Venues had no natural key, so nothing stopped the same place being added twice. The
-- seed's `ON CONFLICT DO NOTHING` was quietly a no-op -- ON CONFLICT needs a constraint to
-- conflict against, and without one it never fires. Running the seed twice produced two
-- Sports Zones, and an admin picking from a list with the same name in it twice has no way
-- to tell which one their old games are attached to.

-- Fold duplicates into the ORIGINAL row -- oldest wins, since that is the one anything
-- already points at. (No MIN() here: it has no uuid overload. Ordering by created_at is
-- also the honest rule rather than an accident of id ordering.)
CREATE TEMP TABLE venue_dedupe AS
  SELECT id,
         first_value(id) OVER (
           PARTITION BY district_id, lower(trim(name))
           ORDER BY created_at, id
         ) AS keeper
    FROM venues;

-- Repoint everything before deleting. A game whose venue vanished is worse than a
-- duplicate, and both of these columns are ON DELETE SET NULL, so the loss would be silent.
UPDATE games g SET venue_id = d.keeper
  FROM venue_dedupe d WHERE g.venue_id = d.id AND d.id <> d.keeper;

UPDATE game_schedules s SET venue_id = d.keeper
  FROM venue_dedupe d WHERE s.venue_id = d.id AND d.id <> d.keeper;

DELETE FROM venues v USING venue_dedupe d
 WHERE v.id = d.id AND d.id <> d.keeper;

DROP TABLE venue_dedupe;

-- Case- and whitespace-insensitive, because "Sports Zone" and "sports zone " are the same
-- pitch typed by two different people.
CREATE UNIQUE INDEX venues_one_per_district_name
  ON venues (district_id, lower(trim(name)));
