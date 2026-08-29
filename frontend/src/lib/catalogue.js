// Shared vocabulary: the fixed option lists the UI renders.
//
// These live here, NOT in the mock, because a component importing a constant from
// src/api/mock/* drags the entire 140-player fixture into the production bundle. A
// single `import { LEADERBOARD_METRICS } from '../api/mock/server.js'` was costing ~11KB
// gzipped of seed data on every real deployment.
//
// The mock imports these too, so there is still one definition.

/** Leaderboard boards. Order is the order of the tabs. */
export const LEADERBOARD_METRICS = [
  { key: 'rating', label: 'Overall' },
  { key: 'form', label: 'Form' },
  { key: 'goals', label: 'Goals' },
  { key: 'assists', label: 'Assists' },
  { key: 'motm', label: 'MOTM' },
  { key: 'reliability', label: 'Reliability' },
  { key: 'improved', label: 'Most improved' },
];

/** WhatsApp announcement kinds. Mirrors the backend's ANNOUNCEMENT_KINDS. */
export const ANNOUNCEMENT_KINDS = [
  { key: 'registration_open', label: 'Registration open' },
  { key: 'filling_up', label: 'Filling up' },
  { key: 'game_full', label: 'Game full' },
  { key: 'teams', label: 'Teams' },
  { key: 'reminder', label: 'Reminder' },
  { key: 'result', label: 'Result' },
];

/**
 * Playing positions, in the order they appear on a team sheet: back to front.
 *
 * Mirrors players_position_check in the database. Kept here rather than imported from a
 * mock module, so nothing in the production bundle depends on the fixture.
 */
export const POSITIONS = [
  { code: 'GK', label: 'Goalkeeper' },
  { code: 'RB', label: 'Right back' },
  { code: 'CB', label: 'Centre back' },
  { code: 'LB', label: 'Left back' },
  { code: 'RWB', label: 'Right wing back' },
  { code: 'LWB', label: 'Left wing back' },
  { code: 'CDM', label: 'Defensive midfield' },
  { code: 'CM', label: 'Centre midfield' },
  { code: 'CAM', label: 'Attacking midfield' },
  { code: 'RW', label: 'Right wing' },
  { code: 'LW', label: 'Left wing' },
  { code: 'CF', label: 'Centre forward' },
  { code: 'ST', label: 'Striker' },
];
