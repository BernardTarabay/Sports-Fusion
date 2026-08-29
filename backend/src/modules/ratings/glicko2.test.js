import test from 'node:test';
import assert from 'node:assert/strict';
import {
  updatePlayer, decayPlayer, rateMatch, compositeOpponent, outcomeFor,
  conservativeRating, isProvisional, toGlicko2, fromGlicko2, g, E, DEFAULTS,
} from './glicko2.js';

// ---------------------------------------------------------------------------
// The canonical test. Glickman's own worked example, from the Glicko-2 paper.
//
// An implementation that is merely "Elo with extra steps" passes every property test
// below and fails this one, which is exactly why it is here.
// ---------------------------------------------------------------------------

test('reproduces Glickman worked example from the specification', () => {
  const player = { rating: 1500, deviation: 200, volatility: 0.06 };
  const results = [
    { rating: 1400, deviation: 30, score: 1 },
    { rating: 1550, deviation: 100, score: 0 },
    { rating: 1700, deviation: 300, score: 0 },
  ];

  const updated = updatePlayer(player, results, { tau: 0.5 });

  // Published values: r' = 1464.06, RD' = 151.52, sigma' = 0.05999
  assert.ok(Math.abs(updated.rating - 1464.06) < 0.01, `rating was ${updated.rating}`);
  assert.ok(Math.abs(updated.deviation - 151.52) < 0.01, `deviation was ${updated.deviation}`);
  assert.ok(Math.abs(updated.volatility - 0.05999) < 0.00001, `volatility was ${updated.volatility}`);
});

test('scale conversion round-trips', () => {
  const original = { rating: 1673.4, deviation: 88.2 };
  const back = fromGlicko2(toGlicko2(original));
  assert.ok(Math.abs(back.rating - original.rating) < 1e-9);
  assert.ok(Math.abs(back.deviation - original.deviation) < 1e-9);
});

test('a 1500-rated player is expected to score 0.5 against an identical opponent', () => {
  const { mu, phi } = toGlicko2({ rating: 1500, deviation: 50 });
  assert.ok(Math.abs(E(mu, mu, phi) - 0.5) < 1e-12);
});

test('g() shrinks the weight of a poorly-known opponent', () => {
  assert.ok(g(0) === 1);
  assert.ok(g(toGlicko2({ rating: 0, deviation: 350 }).phi) < g(toGlicko2({ rating: 0, deviation: 30 }).phi));
});

// ---------------------------------------------------------------------------
// Properties that have to hold for the ratings to mean anything
// ---------------------------------------------------------------------------

test('winning raises the rating and losing lowers it', () => {
  const player = { rating: 1500, deviation: 200, volatility: 0.06 };
  const opponent = { rating: 1500, deviation: 200 };

  const won = updatePlayer(player, [{ ...opponent, score: 1 }]);
  const lost = updatePlayer(player, [{ ...opponent, score: 0 }]);
  const drew = updatePlayer(player, [{ ...opponent, score: 0.5 }]);

  assert.ok(won.rating > 1500);
  assert.ok(lost.rating < 1500);
  assert.ok(Math.abs(drew.rating - 1500) < 1e-9, 'an even draw should not move the rating');
});

test('playing anyone reduces uncertainty', () => {
  const player = { rating: 1500, deviation: 350, volatility: 0.06 };
  const updated = updatePlayer(player, [{ rating: 1500, deviation: 50, score: 1 }]);
  assert.ok(updated.deviation < 350, 'evidence must narrow the estimate');
});

test('beating a stronger opponent gains more than beating a weaker one', () => {
  const player = { rating: 1500, deviation: 100, volatility: 0.06 };
  const beatStrong = updatePlayer(player, [{ rating: 1800, deviation: 50, score: 1 }]);
  const beatWeak = updatePlayer(player, [{ rating: 1200, deviation: 50, score: 1 }]);
  assert.ok(beatStrong.rating > beatWeak.rating);
});

test('a well-known player moves less than a newcomer on the same result', () => {
  const known = { rating: 1500, deviation: 40, volatility: 0.06 };
  const newcomer = { rating: 1500, deviation: 350, volatility: 0.06 };
  const opponent = { rating: 1600, deviation: 50, score: 1 };

  const knownGain = updatePlayer(known, [opponent]).rating - 1500;
  const newcomerGain = updatePlayer(newcomer, [opponent]).rating - 1500;

  assert.ok(newcomerGain > knownGain * 2, 'uncertainty should make ratings move faster');
});

test('not playing widens the deviation but leaves the rating alone', () => {
  const player = { rating: 1620, deviation: 60, volatility: 0.06 };
  const decayed = decayPlayer(player);
  assert.equal(decayed.rating, 1620);
  assert.ok(decayed.deviation > 60);
});

test('deviation is capped so a long absence cannot make a rating meaningless', () => {
  let player = { rating: 1500, deviation: 340, volatility: 0.06 };
  for (let i = 0; i < 200; i += 1) player = decayPlayer(player);
  assert.ok(player.deviation <= DEFAULTS.maxDeviation);
});

test('deviation has a floor so a regular never becomes immovable', () => {
  let player = { rating: 1500, deviation: 350, volatility: 0.06 };
  for (let i = 0; i < 300; i += 1) {
    player = updatePlayer(player, [{ rating: 1500, deviation: 30, score: i % 2 }]);
  }
  assert.ok(player.deviation >= DEFAULTS.minDeviation);
});

test('a lower tau makes the volatility less reactive', () => {
  const player = { rating: 1500, deviation: 200, volatility: 0.06 };
  const shock = [{ rating: 2200, deviation: 30, score: 1 }];

  const twitchy = updatePlayer(player, shock, { tau: 1.2 });
  const steady = updatePlayer(player, shock, { tau: 0.2 });

  assert.ok(twitchy.volatility > steady.volatility);
});

test('the volatility solver terminates on an extreme upset', () => {
  const player = { rating: 1000, deviation: 30, volatility: 0.06 };
  const updated = updatePlayer(player, [{ rating: 2500, deviation: 30, score: 1 }]);
  assert.ok(Number.isFinite(updated.rating));
  assert.ok(Number.isFinite(updated.deviation));
  assert.ok(Number.isFinite(updated.volatility));
  assert.ok(updated.volatility > 0);
});

// ---------------------------------------------------------------------------
// Team adaptation
// ---------------------------------------------------------------------------

test('a composite opponent averages rating and root-mean-squares deviation', () => {
  const composite = compositeOpponent([
    { rating: 1400, deviation: 100 },
    { rating: 1600, deviation: 100 },
  ]);
  assert.equal(composite.rating, 1500);
  assert.ok(Math.abs(composite.deviation - 100) < 1e-9);
});

test('one unknown player makes the whole side less certain than the mean suggests', () => {
  const members = [
    { rating: 1500, deviation: 30 },
    { rating: 1500, deviation: 30 },
    { rating: 1500, deviation: 350 },
  ];
  const meanDeviation = (30 + 30 + 350) / 3;
  assert.ok(compositeOpponent(members).deviation > meanDeviation);
});

test('outcomeFor maps a score line to win, draw or loss', () => {
  assert.equal(outcomeFor(6, 4), 1);
  assert.equal(outcomeFor(4, 6), 0);
  assert.equal(outcomeFor(3, 3), 0.5);
});

const squad = (prefix, rating, deviation = 100) =>
  Array.from({ length: 11 }, (_, i) => ({
    id: `${prefix}${i}`, rating, deviation, volatility: 0.06,
  }));

test('rating a match moves the winning side up and the losing side down', () => {
  const updates = rateMatch({
    teamA: { players: squad('a', 1500) },
    teamB: { players: squad('b', 1500) },
    scoreA: 6,
    scoreB: 4,
  });

  assert.equal(updates.size, 22);
  assert.ok(updates.get('a0').rating > 1500);
  assert.ok(updates.get('b0').rating < 1500);
  assert.equal(updates.get('a0').outcome, 1);
  assert.equal(updates.get('b0').outcome, 0);
});

test('every player is rated against the side as it stood before the match', () => {
  // Two identical players on the same team must receive identical updates, whatever order
  // the roster arrived in. Sequential updating would break this.
  const teamA = { players: squad('a', 1500) };
  const teamB = { players: squad('b', 1700) };

  const updates = rateMatch({ teamA, teamB, scoreA: 3, scoreB: 2 });
  const first = updates.get('a0');
  for (let i = 1; i < 11; i += 1) {
    const other = updates.get(`a${i}`);
    assert.ok(Math.abs(other.rating - first.rating) < 1e-12, 'order must not matter');
  }
});

test('beating a stronger side gains more than beating a weaker one', () => {
  const upset = rateMatch({
    teamA: { players: squad('a', 1500) },
    teamB: { players: squad('b', 1900) },
    scoreA: 1, scoreB: 0,
  });
  const expected = rateMatch({
    teamA: { players: squad('a', 1500) },
    teamB: { players: squad('b', 1100) },
    scoreA: 1, scoreB: 0,
  });

  assert.ok(upset.get('a0').rating > expected.get('a0').rating);
});

test('a draw between unequal sides moves both toward each other', () => {
  const updates = rateMatch({
    teamA: { players: squad('a', 1800) },
    teamB: { players: squad('b', 1400) },
    scoreA: 2, scoreB: 2,
  });
  assert.ok(updates.get('a0').rating < 1800, 'the favourite drops');
  assert.ok(updates.get('b0').rating > 1400, 'the underdog gains');
});

test('the margin of victory is deliberately ignored', () => {
  const narrow = rateMatch({
    teamA: { players: squad('a', 1500) }, teamB: { players: squad('b', 1500) },
    scoreA: 1, scoreB: 0,
  });
  const thrashing = rateMatch({
    teamA: { players: squad('a', 1500) }, teamB: { players: squad('b', 1500) },
    scoreA: 10, scoreB: 0,
  });

  // Standard Glicko-2 takes only the result. In casual football a 10-0 usually means
  // someone left early or went in goal, not that the gap is five times larger.
  assert.equal(narrow.get('a0').rating, thrashing.get('a0').rating);
});

test('uneven teams are still rateable', () => {
  const updates = rateMatch({
    teamA: { players: squad('a', 1500).slice(0, 10) },
    teamB: { players: squad('b', 1500) },
    scoreA: 2, scoreB: 1,
  });
  assert.equal(updates.size, 21);
});

test('an empty side is rejected rather than silently rated', () => {
  assert.throws(
    () => rateMatch({
      teamA: { players: [] }, teamB: { players: squad('b', 1500) }, scoreA: 0, scoreB: 3,
    }),
    /at least one player/
  );
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test('a proven regular outranks an unproven newcomer on a higher raw rating', () => {
  const newcomer = { rating: 1600, deviation: 320 };
  const regular = { rating: 1500, deviation: 40 };

  assert.ok(conservativeRating(regular) > conservativeRating(newcomer));
});

test('provisional is a property of uncertainty, not of games played', () => {
  assert.equal(isProvisional({ deviation: 200 }), true);
  assert.equal(isProvisional({ deviation: 80 }), false);
});

test('ratings converge on the truth over a season', () => {
  // A genuinely strong player, starting from scratch, playing average opposition.
  let player = { rating: 1500, deviation: 350, volatility: 0.06 };

  for (let week = 0; week < 40; week += 1) {
    // Wins four out of five against a 1500 side.
    const score = week % 5 === 0 ? 0 : 1;
    player = updatePlayer(player, [{ rating: 1500, deviation: 60, score }]);
  }

  assert.ok(player.rating > 1650, `expected the rating to rise, got ${player.rating}`);
  assert.ok(player.deviation < 100, `expected confidence to grow, got ${player.deviation}`);
});
