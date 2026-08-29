// Glicko-2, per Mark Glickman's specification.
//
// Pure functions, no database, no clock. Everything here is testable against the worked
// example in the published paper, which glicko2.test.js does -- an implementation that
// merely looks like Glicko-2 will pass property tests and fail that one.
//
// WHY GLICKO-2 AND NOT AN ELO VARIANT
//
// Because it models UNCERTAINTY explicitly, and uncertainty is the thing this platform
// actually needs. Two players on 1548 are not equivalent if one has a deviation of 42 and
// the other 180: the first is a known quantity, the second is a guess. The balancer
// already reads that deviation to avoid stacking every unknown player on one team, and
// the leaderboard ranks on a conservative estimate so nobody tops the table on one good
// night. Elo gives a single number and no way to say "we don't know yet".
//
// TEAM ADAPTATION
//
// Glicko-2 is a one-on-one system. For 11-a-side, each player is rated against a single
// composite opponent: the mean rating of the opposing side, with an aggregated deviation.
//
// This is the standard adaptation and it has a real limitation worth stating plainly: it
// gives every player on a winning team the same credit regardless of how they played. A
// passenger on a strong side gains rating they did not earn.
//
// What rescues it is teammate variety. Over many games with different teammates the
// individual signal separates from the team signal, and the balancer's anti-repetition
// penalty actively drives that variety -- it exists to stop the league becoming two fixed
// teams, and a side effect is that it keeps the rating data informative. If the same
// eleven played together every week, no rating system could tell them apart.

export const ALGORITHM_VERSION = 'glicko2_v1';
export const RATING_SYSTEM = 'glicko2';

// The conversion constant between the Glicko (1500-centred) and Glicko-2 (0-centred)
// scales. 173.7178 = 400 / ln(10).
const SCALE = 173.7178;

export const DEFAULTS = Object.freeze({
  rating: 1500,
  deviation: 350,
  volatility: 0.06,
  // System constant. Constrains how much volatility can move between periods. Glickman
  // suggests 0.3-1.2; smaller values stop a single freak result rewriting a player.
  // 0.5 is the paper's own choice and a reasonable default for weekly amateur football.
  tau: 0.5,
  // Convergence tolerance for the volatility solver.
  epsilon: 0.000001,
  // A deviation ceiling. Without one, a player who disappears for two years returns with
  // an effectively meaningless rating that destabilises everyone they play against.
  maxDeviation: 350,
  // A floor stops a heavily-rated regular becoming immovable.
  minDeviation: 30,
});

export const OUTCOME = Object.freeze({ WIN: 1, DRAW: 0.5, LOSS: 0 });

// --- scale conversion -------------------------------------------------------

export const toGlicko2 = ({ rating, deviation }) => ({
  mu: (rating - DEFAULTS.rating) / SCALE,
  phi: deviation / SCALE,
});

export const fromGlicko2 = ({ mu, phi }) => ({
  rating: SCALE * mu + DEFAULTS.rating,
  deviation: SCALE * phi,
});

// --- the paper's helper functions -------------------------------------------

/** g(phi): how much weight an opponent's result carries, given how well we know them. */
export const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

/** E(mu, mu_j, phi_j): expected score against one opponent. */
export const E = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * Step 5 of the specification: solve for the new volatility.
 *
 * The equation has no closed form, so it is solved numerically. Glickman specifies the
 * Illinois variant of regula falsi, which converges reliably where plain bisection is
 * slow and Newton's method can diverge on the flat regions of this function.
 */
export function solveVolatility({ sigma, phi, v, delta, tau, epsilon }) {
  const a = Math.log(sigma * sigma);
  const phiSq = phi * phi;
  const deltaSq = delta * delta;

  const f = (x) => {
    const ex = Math.exp(x);
    const denom = phiSq + v + ex;
    return (ex * (deltaSq - phiSq - v - ex)) / (2 * denom * denom) - (x - a) / (tau * tau);
  };

  let A = a;
  let B;

  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    // Walk down until f turns negative, per the specification.
    let k = 1;
    while (f(a - k * tau) < 0) {
      k += 1;
      if (k > 100) break; // pathological input; stop rather than loop forever
    }
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  let iterations = 0;

  while (Math.abs(B - A) > epsilon && iterations < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);

    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      // The Illinois modification: halve the retained endpoint's value so the interval
      // actually shrinks from both sides.
      fA /= 2;
    }

    B = C;
    fB = fC;
    iterations += 1;
  }

  return Math.exp(A / 2);
}

/**
 * Update one player against a set of opponents observed in a single rating period.
 *
 * @param {{rating:number, deviation:number, volatility:number}} player
 * @param {Array<{rating:number, deviation:number, score:number}>} results
 * @param {object} [options]
 * @returns {{rating:number, deviation:number, volatility:number, expected:number}}
 */
export function updatePlayer(player, results, options = {}) {
  const { tau, epsilon, maxDeviation, minDeviation } = { ...DEFAULTS, ...options };

  // A player with no games this period does not gain information, only uncertainty.
  if (results.length === 0) {
    return decayPlayer(player, { maxDeviation });
  }

  const { mu, phi } = toGlicko2(player);
  const sigma = player.volatility ?? DEFAULTS.volatility;

  let vInverse = 0;
  let deltaSum = 0;
  let expectedSum = 0;

  for (const result of results) {
    const opponent = toGlicko2(result);
    const gPhi = g(opponent.phi);
    const expected = E(mu, opponent.mu, opponent.phi);

    vInverse += gPhi * gPhi * expected * (1 - expected);
    deltaSum += gPhi * (result.score - expected);
    expectedSum += expected;
  }

  const v = 1 / vInverse;
  const delta = v * deltaSum;

  const newSigma = solveVolatility({ sigma, phi, v, delta, tau, epsilon });

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;

  const converted = fromGlicko2({ mu: newMu, phi: newPhi });

  return {
    rating: converted.rating,
    deviation: Math.min(maxDeviation, Math.max(minDeviation, converted.deviation)),
    volatility: newSigma,
    expected: expectedSum / results.length,
  };
}

/**
 * Widen a player's deviation for a period in which they did not play.
 *
 * Someone who has not been seen for three months is not still known to within 40 points.
 * Their rating is unchanged -- there is no evidence either way -- but confidence in it
 * decays.
 */
export function decayPlayer(player, options = {}) {
  const { maxDeviation } = { ...DEFAULTS, ...options };
  const { phi } = toGlicko2(player);
  const sigma = player.volatility ?? DEFAULTS.volatility;

  const newPhi = Math.sqrt(phi * phi + sigma * sigma);
  const { deviation } = fromGlicko2({ mu: 0, phi: newPhi });

  return {
    rating: player.rating,
    deviation: Math.min(maxDeviation, deviation),
    volatility: sigma,
  };
}

// --- team helpers -----------------------------------------------------------

/**
 * Collapse a team into a single composite opponent.
 *
 * The rating is the mean. The deviation is the root-mean-square rather than the mean,
 * because deviations are standard deviations: a side containing one complete unknown is
 * more uncertain overall than the plain average suggests.
 */
export function compositeOpponent(members) {
  if (members.length === 0) throw new Error('compositeOpponent: no members');

  const rating = members.reduce((sum, m) => sum + m.rating, 0) / members.length;
  const meanSquare = members.reduce((sum, m) => sum + m.deviation * m.deviation, 0) / members.length;

  return { rating, deviation: Math.sqrt(meanSquare) };
}

export function outcomeFor(ownScore, opponentScore) {
  if (ownScore > opponentScore) return OUTCOME.WIN;
  if (ownScore < opponentScore) return OUTCOME.LOSS;
  return OUTCOME.DRAW;
}

/**
 * Rate one completed two-sided match.
 *
 * Every player is updated simultaneously against the opposing side AS IT STOOD BEFORE the
 * match. Updating sequentially would make the result depend on the order the roster
 * happened to come back from the database.
 *
 * @param {{players: Array}} teamA  each player {id, rating, deviation, volatility}
 * @param {{players: Array}} teamB
 * @param {number} scoreA
 * @param {number} scoreB
 * @returns {Map<string, object>} playerId -> new rating state
 */
export function rateMatch({ teamA, teamB, scoreA, scoreB, options = {} }) {
  if (teamA.players.length === 0 || teamB.players.length === 0) {
    throw new Error('rateMatch: both teams need at least one player');
  }

  const opponentOfA = compositeOpponent(teamB.players);
  const opponentOfB = compositeOpponent(teamA.players);

  const outcomeA = outcomeFor(scoreA, scoreB);
  const outcomeB = outcomeFor(scoreB, scoreA);

  const updates = new Map();

  for (const player of teamA.players) {
    updates.set(player.id, {
      ...updatePlayer(player, [{ ...opponentOfA, score: outcomeA }], options),
      previous: { rating: player.rating, deviation: player.deviation, volatility: player.volatility },
      outcome: outcomeA,
    });
  }

  for (const player of teamB.players) {
    updates.set(player.id, {
      ...updatePlayer(player, [{ ...opponentOfB, score: outcomeB }], options),
      previous: { rating: player.rating, deviation: player.deviation, volatility: player.volatility },
      outcome: outcomeB,
    });
  }

  return updates;
}

/**
 * The number to rank on, and the number to show.
 *
 * mu - 2 x deviation is the bottom of the ~95% confidence interval: "we are fairly sure
 * they are at least this good". A newcomer on 1500 +/- 350 sits below a regular on
 * 1450 +/- 40, which is correct -- one of them has proved it.
 */
export const conservativeRating = ({ rating, deviation }) => rating - 2 * deviation;

/** Whether the system knows a player well enough to state their rating as fact. */
export const isProvisional = ({ deviation }) => deviation > 150;
