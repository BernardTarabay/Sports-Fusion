import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceTeams, DEFAULT_WEIGHTS } from './balancer.js';

// Deterministic fixture: 22 players, 2 keepers, spread of ratings and positions.
function makeSquad(count = 22) {
  const positions = ['LB', 'CB', 'CB', 'RB', 'CDM', 'CM', 'CM', 'CAM', 'LW', 'ST', 'RW'];
  return Array.from({ length: count }, (_, i) => ({
    // Padded ids so lexical sort is stable and predictable.
    id: `p${String(i).padStart(2, '0')}`,
    ratingMu: 1400 + ((i * 37) % 260),
    ratingSigma: 60 + ((i * 13) % 90),
    preferredPosition: i < 2 ? 'GK' : positions[i % positions.length],
    secondaryPositions: [],
    isGoalkeeper: i < 2,
  }));
}

const allIds = (result) =>
  result.teams.flatMap((t) => t.players.map((p) => p.id)).sort();

test('evaluates every distinct split exactly once', () => {
  const result = balanceTeams({ players: makeSquad(22), teamSize: 11, seed: 1 });
  // C(22,11) / 2 = 352,716
  assert.equal(result.candidatesEvaluated, 352_716);
});

test('produces two full teams using each player exactly once', () => {
  const squad = makeSquad(22);
  const result = balanceTeams({ players: squad, teamSize: 11, seed: 42 });

  assert.equal(result.teams.length, 2);
  assert.equal(result.teams[0].players.length, 11);
  assert.equal(result.teams[1].players.length, 11);
  assert.deepEqual(allIds(result), squad.map((p) => p.id).sort());
});

test('is reproducible: same inputs and seed give identical teams', () => {
  const squad = makeSquad(22);
  const a = balanceTeams({ players: squad, teamSize: 11, seed: 12345 });
  // Shuffle the input to prove ordering does not leak into the result.
  const shuffled = [...squad].reverse();
  const b = balanceTeams({ players: shuffled, teamSize: 11, seed: 12345 });

  assert.equal(a.score, b.score);
  assert.deepEqual(
    a.teams.map((t) => t.players.map((p) => p.id).sort()),
    b.teams.map((t) => t.players.map((p) => p.id).sort())
  );
});

test('gives each team a goalkeeper', () => {
  const result = balanceTeams({ players: makeSquad(22), teamSize: 11, seed: 7 });
  for (const team of result.teams) {
    assert.ok(
      team.players.some((p) => p.isGoalkeeper),
      'every team must contain a willing goalkeeper'
    );
    assert.ok(
      team.players.some((p) => p.assignedPosition === 'GK'),
      'every team sheet must have a GK slot filled'
    );
  }
});

test('balances strength to within a narrow margin', () => {
  const result = balanceTeams({ players: makeSquad(22), teamSize: 11, seed: 99 });
  const gap = Math.abs(result.teams[0].strength - result.teams[1].strength);
  // Ratings span ~260 points across 22 players; a good split lands in single digits.
  assert.ok(gap < 20, `strength gap ${gap} should be under 20`);
});

test('different seeds produce different teams that are still balanced', () => {
  const squad = makeSquad(22);
  const signatures = new Set();
  let worstGap = 0;

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = balanceTeams({ players: squad, teamSize: 11, seed });
    signatures.add(r.teams[0].players.map((p) => p.id).sort().join(','));
    worstGap = Math.max(worstGap, Math.abs(r.teams[0].strength - r.teams[1].strength));
  }

  // Variety: the shortlist must not collapse to a single answer, or the league becomes
  // two fixed teams.
  assert.ok(signatures.size > 1, 'seeds should yield more than one distinct split');
  // ...but every variant must still be a genuinely balanced game.
  assert.ok(worstGap < 30, `worst gap across seeds was ${worstGap}`);
});

test('honours a declared play_with pairing', () => {
  const squad = makeSquad(22);
  const result = balanceTeams({
    players: squad,
    teamSize: 11,
    seed: 3,
    relationships: [
      { playerId: 'p05', otherPlayerId: 'p18', kind: 'play_with', weight: 5, origin: 'declared' },
    ],
    weights: { ...DEFAULT_WEIGHTS, relationship: 40 },
  });

  const teamOf = (id) => result.teams.findIndex((t) => t.players.some((p) => p.id === id));
  assert.equal(teamOf('p05'), teamOf('p18'), 'declared friends should share a team');
});

test('separates a declared avoid pairing', () => {
  const squad = makeSquad(22);
  const result = balanceTeams({
    players: squad,
    teamSize: 11,
    seed: 3,
    relationships: [
      { playerId: 'p04', otherPlayerId: 'p09', kind: 'avoid', weight: 5, origin: 'declared' },
    ],
  });

  const teamOf = (id) => result.teams.findIndex((t) => t.players.some((p) => p.id === id));
  assert.notEqual(teamOf('p04'), teamOf('p09'), 'avoid pairs should be split');
});

test('anti-repetition pushes recently paired players apart', () => {
  const squad = makeSquad(22);
  const pairHistory = [
    { playerAId: 'p03', playerBId: 'p14', sameTeamCount: 6, gamesAgo: 0 },
  ];
  const result = balanceTeams({
    players: squad,
    teamSize: 11,
    seed: 11,
    pairHistory,
    weights: { ...DEFAULT_WEIGHTS, repetition: 60 },
  });

  const teamOf = (id) => result.teams.findIndex((t) => t.players.some((p) => p.id === id));
  assert.notEqual(teamOf('p03'), teamOf('p14'), 'heavily repeated pairs should be split');
});

test('rejects a squad that does not fill both teams', () => {
  assert.throws(
    () => balanceTeams({ players: makeSquad(21), teamSize: 11, seed: 1 }),
    /expected 22 players/
  );
});

test('rejects duplicate players', () => {
  const squad = makeSquad(22);
  squad[5] = { ...squad[4] };
  assert.throws(() => balanceTeams({ players: squad, teamSize: 11, seed: 1 }), /duplicate/);
});

test('completes fast enough to run inside a request', () => {
  const result = balanceTeams({ players: makeSquad(22), teamSize: 11, seed: 1 });
  assert.ok(
    result.durationMs < 3000,
    `exhaustive search took ${result.durationMs}ms, expected under 3000ms`
  );
});

test('handles smaller formats', () => {
  for (const teamSize of [5, 6, 7, 8]) {
    const result = balanceTeams({ players: makeSquad(teamSize * 2), teamSize, seed: 5 });
    assert.equal(result.teams[0].players.length, teamSize);
    assert.equal(result.teams[1].players.length, teamSize);
  }
});
