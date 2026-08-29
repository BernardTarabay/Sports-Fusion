// Stand-in for the backend balancer.
//
// The real one enumerates all 352,716 splits in ~113ms. This is a snake draft, which is
// enough to produce the near-even, position-sane teams the UI has to render -- the point
// here is realistic OUTPUT, not a second implementation of the algorithm.

const FORMATIONS = {
  5: ['GK', 'CB', 'CM', 'CM', 'ST'],
  6: ['GK', 'CB', 'CB', 'CM', 'CM', 'ST'],
  7: ['GK', 'LB', 'CB', 'RB', 'CM', 'CM', 'ST'],
  8: ['GK', 'LB', 'CB', 'RB', 'CM', 'CM', 'LW', 'ST'],
  9: ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'ST', 'ST'],
  10: ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CM', 'CAM', 'ST', 'ST'],
  11: ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CM', 'CM', 'LW', 'ST', 'RW'],
};

export const formationFor = (teamSize) =>
  FORMATIONS[teamSize] ?? ['GK', ...Array(Math.max(0, teamSize - 1)).fill('CM')];

const GROUP = {
  GK: 'GK',
  LB: 'DEF', CB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID',
  LW: 'FWD', RW: 'FWD', ST: 'FWD', CF: 'FWD',
};

/** Slot players into a formation, honouring preferred position where it is free. */
export function assignPositions(squad, formation) {
  const slots = [...formation];
  const remaining = [...squad];
  const assigned = [];

  const take = (matches, slotIndex) => {
    const playerIndex = remaining.findIndex(matches);
    if (playerIndex === -1) return false;
    const [player] = remaining.splice(playerIndex, 1);
    const [slot] = slots.splice(slotIndex, 1);
    assigned.push({ ...player, position: slot });
    return true;
  };

  const gkSlot = slots.indexOf('GK');
  if (gkSlot !== -1) take((p) => p.isGoalkeeper, gkSlot);

  for (let i = slots.length - 1; i >= 0; i -= 1) {
    take((p) => p.position === slots[i] && !p.isGoalkeeper, i);
  }
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    take((p) => GROUP[p.position] === GROUP[slots[i]] && !p.isGoalkeeper, i);
  }
  while (remaining.length > 0 && slots.length > 0) {
    assigned.push({ ...remaining.shift(), position: slots.shift() });
  }

  return assigned;
}

export function buildTeamsFor(squad, teamSize) {
  const formation = formationFor(teamSize);
  const keepers = squad.filter((p) => p.isGoalkeeper);
  const outfield = squad.filter((p) => !p.isGoalkeeper).sort((a, b) => b.ratingMu - a.ratingMu);

  const sides = [[], []];
  keepers.slice(0, 2).forEach((p, i) => sides[i].push(p));

  // Snake: 0,1,1,0,0,1,1,0 keeps the running totals close without any search.
  outfield.forEach((p, i) => {
    const pass = Math.floor(i / 2);
    const preferred = pass % 2 === 0 ? i % 2 : 1 - (i % 2);
    const target = sides[preferred].length < teamSize ? preferred : 1 - preferred;
    if (sides[target].length < teamSize) sides[target].push(p);
  });

  return ['black', 'white'].map((color, i) => {
    const placed = assignPositions(sides[i], formation);
    return {
      id: `t-${color}`,
      color,
      strength: Math.round(placed.reduce((s, p) => s + (p.ratingMu ?? 1500), 0) * 10) / 10,
      players: placed.map((p, idx) => ({
        id: p.id,
        name: p.name,
        position: p.position,
        ratingMu: p.ratingMu ?? 1500,
        ratingSigma: p.ratingSigma ?? 350,
        isGoalkeeper: !!p.isGoalkeeper,
        shirtNumber: idx + 1,
      })),
    };
  });
}
