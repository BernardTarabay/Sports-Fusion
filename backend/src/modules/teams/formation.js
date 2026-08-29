// Positions, groups, and formations.
//
// Kept separate from the balancer because these are football opinions, not algorithm,
// and the admins will want to argue with them.

export const POSITIONS = ['GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LW', 'RW', 'ST', 'CF'];

// Numeric groups for the hot loop: 0 GK, 1 DEF, 2 MID, 3 FWD.
export const POSITION_GROUPS = Object.freeze({
  GK: 0,
  LB: 1, CB: 1, RB: 1, LWB: 1, RWB: 1,
  CDM: 2, CM: 2, CAM: 2,
  LW: 3, RW: 3, ST: 3, CF: 3,
});

export const GROUP_NAMES = ['GK', 'DEF', 'MID', 'FWD'];

// Formations by team size. Community football is played at a lot of sizes.
const FORMATIONS = {
  5:  ['GK', 'CB', 'CM', 'CM', 'ST'],
  6:  ['GK', 'CB', 'CB', 'CM', 'CM', 'ST'],
  7:  ['GK', 'LB', 'CB', 'RB', 'CM', 'CM', 'ST'],
  8:  ['GK', 'LB', 'CB', 'RB', 'CM', 'CM', 'LW', 'ST'],
  9:  ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'ST', 'ST'],
  10: ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CM', 'CAM', 'ST', 'ST'],
  11: ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CM', 'CM', 'LW', 'ST', 'RW'],
};

export function formationFor(teamSize) {
  const known = FORMATIONS[teamSize];
  if (known) return [...known];

  // Fall back to a proportional shape rather than refusing to play.
  const outfield = teamSize - 1;
  const def = Math.round(outfield * 0.4);
  const fwd = Math.round(outfield * 0.25);
  const mid = outfield - def - fwd;
  return [
    'GK',
    ...Array(Math.max(0, def)).fill('CB'),
    ...Array(Math.max(0, mid)).fill('CM'),
    ...Array(Math.max(0, fwd)).fill('ST'),
  ];
}
