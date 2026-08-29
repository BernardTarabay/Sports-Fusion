// The formation system.
//
// A formation is a named list of SLOTS. Each slot has a role (GK/DEF/MID/FWD), a label
// (CB, CDM, LW...) and a position expressed as a percentage of one half-pitch:
//
//   x: 0 = left touchline, 100 = right touchline
//   y: 0 = own goal line,  100 = halfway line
//
// Everything downstream — the pitch renderer, the team builder, the balancer's positional
// scoring — reads slots from here. Adding 3-4-2-1 is one entry in this file and no
// component changes.
//
// Formations are grouped by team size because 7-a-side is a different game, not
// 11-a-side with four people missing.

const slot = (label, x, y) => ({ label, x, y, role: ROLE_OF[label] ?? 'MID' });

export const ROLE_OF = {
  GK: 'GK',
  LB: 'DEF', LCB: 'DEF', CB: 'DEF', RCB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF', SW: 'DEF',
  CDM: 'MID', LCM: 'MID', CM: 'MID', RCM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  LW: 'FWD', RW: 'FWD', ST: 'FWD', LST: 'FWD', RST: 'FWD', CF: 'FWD',
};

export const ROLE_ORDER = ['GK', 'DEF', 'MID', 'FWD'];

/* ==========================================================================
   11-a-side
   ========================================================================== */

const ELEVEN = {
  '4-3-3': [
    slot('GK', 50, 7),
    slot('LB', 14, 28), slot('LCB', 38, 23), slot('RCB', 62, 23), slot('RB', 86, 28),
    slot('LCM', 28, 52), slot('CM', 50, 46), slot('RCM', 72, 52),
    slot('LW', 16, 82), slot('ST', 50, 88), slot('RW', 84, 82),
  ],
  '4-2-3-1': [
    slot('GK', 50, 7),
    slot('LB', 14, 28), slot('LCB', 38, 23), slot('RCB', 62, 23), slot('RB', 86, 28),
    slot('LCM', 36, 44), slot('RCM', 64, 44),
    slot('LW', 16, 68), slot('CAM', 50, 66), slot('RW', 84, 68),
    slot('ST', 50, 89),
  ],
  '4-4-2': [
    slot('GK', 50, 7),
    slot('LB', 14, 28), slot('LCB', 38, 23), slot('RCB', 62, 23), slot('RB', 86, 28),
    slot('LM', 14, 55), slot('LCM', 38, 50), slot('RCM', 62, 50), slot('RM', 86, 55),
    slot('LST', 38, 86), slot('RST', 62, 86),
  ],
  '4-1-4-1': [
    slot('GK', 50, 7),
    slot('LB', 14, 28), slot('LCB', 38, 23), slot('RCB', 62, 23), slot('RB', 86, 28),
    slot('CDM', 50, 40),
    slot('LM', 15, 62), slot('LCM', 38, 58), slot('RCM', 62, 58), slot('RM', 85, 62),
    slot('ST', 50, 88),
  ],
  '3-5-2': [
    slot('GK', 50, 7),
    slot('LCB', 28, 24), slot('CB', 50, 20), slot('RCB', 72, 24),
    slot('LWB', 10, 52), slot('LCM', 34, 48), slot('CM', 50, 42), slot('RCM', 66, 48), slot('RWB', 90, 52),
    slot('LST', 38, 86), slot('RST', 62, 86),
  ],
  '3-4-3': [
    slot('GK', 50, 7),
    slot('LCB', 28, 24), slot('CB', 50, 20), slot('RCB', 72, 24),
    slot('LM', 12, 52), slot('LCM', 38, 48), slot('RCM', 62, 48), slot('RM', 88, 52),
    slot('LW', 18, 84), slot('ST', 50, 88), slot('RW', 82, 84),
  ],
  '5-3-2': [
    slot('GK', 50, 7),
    slot('LWB', 10, 34), slot('LCB', 30, 22), slot('CB', 50, 19), slot('RCB', 70, 22), slot('RWB', 90, 34),
    slot('LCM', 30, 54), slot('CM', 50, 50), slot('RCM', 70, 54),
    slot('LST', 38, 86), slot('RST', 62, 86),
  ],
  '4-3-2-1': [
    slot('GK', 50, 7),
    slot('LB', 14, 28), slot('LCB', 38, 23), slot('RCB', 62, 23), slot('RB', 86, 28),
    slot('LCM', 28, 50), slot('CM', 50, 45), slot('RCM', 72, 50),
    slot('LW', 33, 72), slot('RW', 67, 72),
    slot('ST', 50, 90),
  ],
  '4-5-1': [
    slot('GK', 50, 7),
    slot('LB', 14, 28), slot('LCB', 38, 23), slot('RCB', 62, 23), slot('RB', 86, 28),
    slot('LM', 11, 58), slot('LCM', 32, 52), slot('CM', 50, 48), slot('RCM', 68, 52), slot('RM', 89, 58),
    slot('ST', 50, 88),
  ],
};

/* ==========================================================================
   Small-sided. Common across Lebanese pitches -- 5, 6 and 7 a side are the norm
   on turf, not the exception.
   ========================================================================== */

const SMALL = {
  5: {
    '1-2-1': [
      slot('GK', 50, 8),
      slot('CB', 50, 30),
      slot('LCM', 26, 58), slot('RCM', 74, 58),
      slot('ST', 50, 88),
    ],
    '2-2': [
      slot('GK', 50, 8),
      slot('LCB', 32, 30), slot('RCB', 68, 30),
      slot('LST', 32, 78), slot('RST', 68, 78),
    ],
  },
  6: {
    '2-1-2': [
      slot('GK', 50, 8),
      slot('LCB', 30, 28), slot('RCB', 70, 28),
      slot('CM', 50, 55),
      slot('LST', 30, 84), slot('RST', 70, 84),
    ],
    '2-2-1': [
      slot('GK', 50, 8),
      slot('LCB', 30, 28), slot('RCB', 70, 28),
      slot('LCM', 30, 58), slot('RCM', 70, 58),
      slot('ST', 50, 88),
    ],
  },
  7: {
    '3-2-1': [
      slot('GK', 50, 8),
      slot('LB', 20, 30), slot('CB', 50, 25), slot('RB', 80, 30),
      slot('LCM', 32, 60), slot('RCM', 68, 60),
      slot('ST', 50, 89),
    ],
    '2-3-1': [
      slot('GK', 50, 8),
      slot('LCB', 32, 27), slot('RCB', 68, 27),
      slot('LM', 18, 58), slot('CM', 50, 54), slot('RM', 82, 58),
      slot('ST', 50, 89),
    ],
    '3-1-2': [
      slot('GK', 50, 8),
      slot('LB', 20, 30), slot('CB', 50, 25), slot('RB', 80, 30),
      slot('CM', 50, 56),
      slot('LST', 33, 85), slot('RST', 67, 85),
    ],
  },
  8: {
    '3-3-1': [
      slot('GK', 50, 8),
      slot('LB', 18, 30), slot('CB', 50, 25), slot('RB', 82, 30),
      slot('LM', 22, 58), slot('CM', 50, 54), slot('RM', 78, 58),
      slot('ST', 50, 88),
    ],
    '3-2-2': [
      slot('GK', 50, 8),
      slot('LB', 18, 30), slot('CB', 50, 25), slot('RB', 82, 30),
      slot('LCM', 32, 56), slot('RCM', 68, 56),
      slot('LST', 33, 86), slot('RST', 67, 86),
    ],
  },
  9: {
    '3-4-1': [
      slot('GK', 50, 8),
      slot('LB', 18, 30), slot('CB', 50, 25), slot('RB', 82, 30),
      slot('LM', 14, 58), slot('LCM', 38, 53), slot('RCM', 62, 53), slot('RM', 86, 58),
      slot('ST', 50, 88),
    ],
    '4-3-1': [
      slot('GK', 50, 8),
      slot('LB', 14, 30), slot('LCB', 38, 25), slot('RCB', 62, 25), slot('RB', 86, 30),
      slot('LCM', 28, 56), slot('CM', 50, 52), slot('RCM', 72, 56),
      slot('ST', 50, 88),
    ],
  },
  10: {
    '4-3-2': [
      slot('GK', 50, 8),
      slot('LB', 14, 28), slot('LCB', 38, 23), slot('RCB', 62, 23), slot('RB', 86, 28),
      slot('LCM', 28, 54), slot('CM', 50, 48), slot('RCM', 72, 54),
      slot('LST', 36, 86), slot('RST', 64, 86),
    ],
    '3-4-2': [
      slot('GK', 50, 8),
      slot('LCB', 28, 24), slot('CB', 50, 20), slot('RCB', 72, 24),
      slot('LM', 12, 54), slot('LCM', 38, 50), slot('RCM', 62, 50), slot('RM', 88, 54),
      slot('LST', 36, 86), slot('RST', 64, 86),
    ],
  },
};

/* ==========================================================================
   Lookup
   ========================================================================== */

/** Every formation available for a given team size, in display order. */
export function formationsFor(teamSize) {
  if (teamSize === 11) return Object.keys(ELEVEN);
  return Object.keys(SMALL[teamSize] ?? {});
}

export function defaultFormation(teamSize) {
  return formationsFor(teamSize)[0] ?? null;
}

/**
 * Slots for a formation. Falls back to an evenly-spread shape rather than throwing,
 * because a game with an unusual squad size should still render a pitch.
 */
export function slotsFor(teamSize, formation) {
  const table = teamSize === 11 ? ELEVEN : (SMALL[teamSize] ?? {});
  const found = table[formation] ?? table[defaultFormation(teamSize)];
  if (found) return found.map((s) => ({ ...s }));

  const outfield = Math.max(0, teamSize - 1);
  const perRow = Math.ceil(outfield / 3);
  return [
    slot('GK', 50, 8),
    ...Array.from({ length: outfield }, (_, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const label = row === 0 ? 'CB' : row === 1 ? 'CM' : 'ST';
      return slot(label, ((col + 1) / (perRow + 1)) * 100, 28 + row * 28);
    }),
  ];
}

/** Human summary: "4-3-3" -> "4 defenders, 3 midfielders, 3 forwards". */
export function describeFormation(teamSize, formation) {
  const slots = slotsFor(teamSize, formation);
  const counts = slots.reduce((acc, s) => ({ ...acc, [s.role]: (acc[s.role] ?? 0) + 1 }), {});
  return [
    counts.DEF ? `${counts.DEF} at the back` : null,
    counts.MID ? `${counts.MID} in midfield` : null,
    counts.FWD ? `${counts.FWD} up top` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Fit a squad into a formation's slots.
 *
 * Keeps anyone already sitting in a slot that still exists, so switching from 4-3-3 to
 * 4-2-3-1 does not reshuffle the whole team -- the back four stays put and only the
 * players whose slot disappeared get moved. An admin who has hand-placed nine players
 * should not lose that work by trying a different shape.
 */
export function fitSquadToFormation(players, teamSize, formation) {
  const slots = slotsFor(teamSize, formation);
  const remaining = [...players];
  const assigned = new Array(slots.length).fill(null);

  const claim = (predicate, slotIndex) => {
    const i = remaining.findIndex(predicate);
    if (i === -1) return false;
    assigned[slotIndex] = { ...remaining.splice(i, 1)[0], position: slots[slotIndex].label };
    return true;
  };

  // 1. Keeper, only from someone willing to keep.
  const gkIndex = slots.findIndex((s) => s.role === 'GK');
  if (gkIndex !== -1) {
    claim((p) => p.isGoalkeeper, gkIndex) || claim((p) => p.position === 'GK', gkIndex);
  }

  // 2. Exact same slot label they already held.
  slots.forEach((s, i) => { if (!assigned[i]) claim((p) => p.position === s.label, i); });

  // 3. Same role (a CB can fill LCB).
  slots.forEach((s, i) => {
    if (!assigned[i]) claim((p) => ROLE_OF[p.position] === s.role && !p.isGoalkeeper, i);
  });

  // 4. Whoever is left.
  slots.forEach((s, i) => { if (!assigned[i]) claim(() => true, i); });

  return assigned
    .map((player, i) => (player ? { ...player, slot: slots[i] } : null))
    .filter(Boolean);
}
