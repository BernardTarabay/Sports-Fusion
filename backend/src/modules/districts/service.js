// Districts: the reference geography, and the numbers that describe each one.
//
// WHY THE COUNTS LIVE HERE AND NOT IN THE ROUTE
//
// Every surface that shows a district shows the same four numbers -- active games,
// players, venues, occupancy -- and they were previously invented by the client, which
// multiplied a follower count by 32 to make the figure look plausible. A district page
// and a district card have to agree, and they can only agree if there is one query.
//
// All four are derived, none are stored. At 26 districts the aggregate is a single scan
// and caching it would only create a second thing that can be wrong.

import { query } from '../../database/pool.js';
import { NotFoundError } from '../../lib/errors.js';
import { venueLogoPath } from '../../lib/venueLogo.js';
import { listGames } from '../games/service.js';
import { getLeaderboard } from '../ratings/service.js';

// A game that is "active" is one somebody can still turn up to. Draft games are the
// admin's private working state and are deliberately not counted -- a district reading
// "3 games" that shows none when you tap it is worse than reading zero.
const ACTIVE_GAME_STATUSES = `('registration_open','full','teams_generated','in_progress')`;

const DISTRICT_STATS = `
  SELECT d.id, d.slug, d.name, d.name_ar, d.region,
         (SELECT count(*)::int FROM district_followers f WHERE f.district_id = d.id)
           AS followers,
         (SELECT count(*)::int FROM games g
           WHERE g.district_id = d.id
             AND g.status IN ${ACTIVE_GAME_STATUSES}
             AND g.kickoff_at > now())                         AS active_games,
         (SELECT count(*)::int FROM venues v
           WHERE v.district_id = d.id AND v.is_active)          AS venues,
         -- Players who call this district home, plus anyone who has actually turned out
         -- for a game here. Someone from Metn who plays every week in Keserwan counts in
         -- both, which is the honest answer to "how big is football here".
         (SELECT count(DISTINCT p.id)::int
            FROM players p
           WHERE p.status = 'active'
             AND (p.home_district_id = d.id
                  OR EXISTS (SELECT 1
                               FROM registrations r
                               JOIN games g2 ON g2.id = r.game_id
                              WHERE r.player_id = p.id
                                AND g2.district_id = d.id
                                AND r.status <> 'cancelled')))  AS players,
         -- How full the games here actually get, over the last twelve weeks. NULL when
         -- nothing has been played, which the client renders as a dash rather than 0%.
         (SELECT round(avg(LEAST(1.0, g.confirmed_count::numeric
                                      / NULLIF(g.capacity, 0))), 3)
            FROM games g
           WHERE g.district_id = d.id
             AND g.status <> 'cancelled'
             AND g.kickoff_at > now() - interval '84 days'
             AND g.kickoff_at < now())                          AS occupancy
    FROM districts d
`;

function shape(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameAr: row.name_ar,
    region: row.region,
    followers: row.followers,
    activeGames: row.active_games,
    venues: row.venues,
    players: row.players,
    occupancy: row.occupancy == null ? null : Number(row.occupancy),
  };
}

/** Every active district, with its numbers. */
export async function listDistricts() {
  const { rows } = await query(`${DISTRICT_STATS} WHERE d.is_active ORDER BY d.name`);
  return rows.map(shape);
}

/**
 * The whole platform in four numbers, for the front door.
 *
 * These were previously read off a `platform` key the API has never sent, so the landing
 * page showed 0 players, 0 games and 0% occupancy to every visitor -- on a database with
 * thirty players in it. One query, because it is rendered above the fold.
 */
export async function getPlatformStats() {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM players WHERE status = 'active')      AS players,
            (SELECT count(*)::int FROM districts WHERE is_active)            AS districts,
            (SELECT count(*)::int FROM venues WHERE is_active)               AS venues,
            (SELECT count(*)::int FROM games
              WHERE status <> 'cancelled'
                AND kickoff_at >= date_trunc('month', now()))                AS games_this_month,
            (SELECT round(avg(LEAST(1.0, confirmed_count::numeric
                                        / NULLIF(capacity, 0))), 3)
               FROM games
              WHERE status <> 'cancelled'
                AND kickoff_at > now() - interval '84 days'
                AND kickoff_at < now())                                      AS avg_occupancy`
  );
  const r = rows[0];
  return {
    players: r.players,
    districts: r.districts,
    venues: r.venues,
    gamesThisMonth: r.games_this_month,
    avgOccupancy: r.avg_occupancy == null ? null : Number(r.avg_occupancy),
  };
}

/**
 * One district, by slug or by id, with everything its page renders.
 *
 * Accepts either because the links into it are slugs (`/districts/keserwan`) while the
 * things that hold a reference to a district hold its id. There was no route here at
 * all until now: every district card on the site led to "District not found".
 */
export async function getDistrict(idOrSlug) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

  const { rows } = await query(
    `${DISTRICT_STATS} WHERE d.is_active AND ${isUuid ? 'd.id = $1::uuid' : 'd.slug = $1'}`,
    [idOrSlug]
  );
  if (rows.length === 0) throw new NotFoundError('District');
  const district = shape(rows[0]);

  // Fanned out rather than sequential: four independent reads behind one page load.
  const [upcoming, recent, venues, leaderboard] = await Promise.all([
    listGames({ districtId: district.id, when: 'upcoming', limit: 12 }),
    listGames({ districtId: district.id, when: 'past', limit: 6 }),
    listVenues(district.id),
    // Provisional players included: a district that has run four games has nobody with
    // a settled rating yet, and an empty table there says "nothing happens here".
    getLeaderboard({ districtId: district.id, limit: 8, minGames: 1, includeProvisional: true }),
  ]);

  return { district, upcoming, recent, venues, leaderboard };
}

/** Pitches in one district. */
export async function listVenues(districtId, { includeInactive = false } = {}) {
  const { rows } = await query(
    `SELECT id, name, address, google_maps_url, pitch_type, default_capacity,
            latitude, longitude,
            -- NOT the logo itself. A badge is 50-60kb of base64 and there is one on
            -- every game in every list; see venueLogoPath below.
            (logo_url IS NOT NULL) AS has_logo,
            updated_at
       FROM venues
      WHERE district_id = $1 ${includeInactive ? '' : 'AND is_active'}
      ORDER BY name`,
    [districtId]
  );
  return rows.map((v) => ({
    id: v.id,
    name: v.name,
    address: v.address,
    mapsUrl: v.google_maps_url,
    pitchType: v.pitch_type,
    capacity: v.default_capacity,
    latitude: v.latitude == null ? null : Number(v.latitude),
    longitude: v.longitude == null ? null : Number(v.longitude),
    hasLogo: v.has_logo,
    logoUrl: v.has_logo ? venueLogoPath(v.id, v.updated_at) : null,
  }));
}

export { venueLogoPath };
