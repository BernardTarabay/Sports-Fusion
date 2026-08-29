// Deterministic team balancer.
//
// For 22 players into two 11s there are C(22,11)/2 = 352,716 distinct splits. That is
// small enough to evaluate exhaustively, which buys three things a heuristic or an LLM
// cannot give you:
//
//   1. Provable optimality. The chosen split is the best under the stated objective,
//      not the best one a search happened to find.
//   2. Explainability. Every candidate has a score breakdown, so "why is George on
//      Black" has an answer with numbers in it.
//   3. Variety. Having ranked ALL splits, we can deliberately pick from the near-optimal
//      shortlist instead of the single optimum, which is what stops the league
//      collapsing into the same two fixed teams every week.
//
// Determinism: players are sorted by id, enumeration order is fixed, and the shortlist
// choice is driven by a seeded PRNG. Same inputs plus same seed produce identical teams,
// forever. The seed and the rating snapshot are persisted in team_generation_runs.

import { POSITION_GROUPS, formationFor } from './formation.js';

export const ALGORITHM_VERSION = 'exhaustive_v1';

// Lower total score is better. Every term is a penalty.
export const DEFAULT_WEIGHTS = Object.freeze({
  // Raw strength gap between the teams. The headline objective.
  skill: 1.0,
  // Gap in aggregate rating uncertainty. Without this the optimiser happily puts every
  // unknown player on one team, producing a split that looks balanced on paper and is
  // a coin flip in reality.
  uncertainty: 0.15,
  // Each team needs a keeper. This is effectively a hard constraint.
  goalkeeper: 500.0,
  // Even distribution of defenders / midfielders / forwards.
  position: 12.0,
  // Penalty for pairing players who have been on the same team recently.
  repetition: 6.0,
  // Declared "play with" pairs split up, or "avoid" pairs put together.
  relationship: 25.0,
});

export const DEFAULT_OPTIONS = Object.freeze({
  shortlistSize: 50,
  // Candidates scoring within this much of the optimum are considered equally good and
  // become eligible for random selection. In rating points.
  varietyTolerance: 15.0,
  // How many past games count toward the repetition penalty.
  repetitionWindow: 6,
});

// mulberry32: small, fast, seedable. Reproducibility matters more than crypto quality.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {Object} BalancerPlayer
 * @property {string} id
 * @property {number} ratingMu
 * @property {number} ratingSigma
 * @property {string|null} preferredPosition
 * @property {string[]} [secondaryPositions]
 * @property {boolean} isGoalkeeper
 */

/**
 * Build the flat, index-addressed arrays the hot loop reads. Doing this once keeps the
 * inner loop free of property lookups and string comparisons.
 */
function prepare(players, { pairHistory = [], relationships = [], repetitionWindow }) {
  // Sort by id: enumeration order must not depend on the order rows came back from
  // Postgres, or the same inputs would produce different teams.
  const sorted = [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = sorted.length;

  const mu = new Float64Array(n);
  const sigma = new Float64Array(n);
  const isGk = new Uint8Array(n);
  const group = new Uint8Array(n); // 0 GK, 1 DEF, 2 MID, 3 FWD
  const index = new Map();

  for (let i = 0; i < n; i += 1) {
    const p = sorted[i];
    index.set(p.id, i);
    mu[i] = Number(p.ratingMu);
    sigma[i] = Number(p.ratingSigma);
    isGk[i] = p.isGoalkeeper ? 1 : 0;
    group[i] = POSITION_GROUPS[p.preferredPosition] ?? 2; // unknown players count as MID
  }

  // Pair penalty matrix, flattened. pairCost[a * n + b] is the cost of a and b sharing
  // a team. Repetition and relationships collapse into one lookup.
  const pairCost = new Float64Array(n * n);

  for (const row of pairHistory) {
    const a = index.get(row.playerAId);
    const b = index.get(row.playerBId);
    if (a === undefined || b === undefined) continue;
    // Recent pairings hurt more than old ones. Linear decay over the window.
    const recency = row.gamesAgo == null
      ? 1
      : Math.max(0, (repetitionWindow - row.gamesAgo) / repetitionWindow);
    const cost = Number(row.sameTeamCount ?? 0) * recency;
    pairCost[a * n + b] += cost;
    pairCost[b * n + a] += cost;
  }

  for (const rel of relationships) {
    const a = index.get(rel.playerId);
    const b = index.get(rel.otherPlayerId);
    if (a === undefined || b === undefined) continue;
    // Inferred preferences (learned from admin overrides) are held more loosely than
    // ones the player actually asked for.
    const w = Number(rel.weight ?? 1) * (rel.origin === 'inferred' ? 0.5 : 1);
    // 'play_with' is encoded as a negative same-team cost: keeping them together
    // reduces the score. 'avoid' and 'play_against' are positive.
    const delta = rel.kind === 'play_with' ? -w : w;
    pairCost[a * n + b] += delta;
    pairCost[b * n + a] += delta;
  }

  return { sorted, n, mu, sigma, isGk, group, pairCost, index };
}

/**
 * Score one split. `maskA` is a bitmask over the prepared player indices.
 * Exported so the admin override path can re-score an edited split with the exact
 * same objective the generator used.
 */
export function scoreSplit(ctx, maskA, weights) {
  const { n, mu, sigma, isGk, group, pairCost } = ctx;

  let muA = 0, muB = 0;
  let sigA = 0, sigB = 0;
  let gkA = 0, gkB = 0;
  const groupA = [0, 0, 0, 0];
  const groupB = [0, 0, 0, 0];

  // Index buffers, reused by the caller's loop via ctx to avoid per-candidate allocation.
  const idxA = ctx._idxA;
  const idxB = ctx._idxB;
  let ca = 0, cb = 0;

  for (let i = 0; i < n; i += 1) {
    if (maskA & (1 << i)) {
      muA += mu[i]; sigA += sigma[i]; gkA += isGk[i]; groupA[group[i]] += 1;
      idxA[ca++] = i;
    } else {
      muB += mu[i]; sigB += sigma[i]; gkB += isGk[i]; groupB[group[i]] += 1;
      idxB[cb++] = i;
    }
  }

  // Same-team pair costs, within each team.
  let pairs = 0;
  for (let x = 0; x < ca; x += 1) {
    const base = idxA[x] * n;
    for (let y = x + 1; y < ca; y += 1) pairs += pairCost[base + idxA[y]];
  }
  for (let x = 0; x < cb; x += 1) {
    const base = idxB[x] * n;
    for (let y = x + 1; y < cb; y += 1) pairs += pairCost[base + idxB[y]];
  }

  const skill = Math.abs(muA - muB);
  const uncertainty = Math.abs(sigA - sigB);

  // A team with no keeper is a broken team, not a slightly worse one.
  let goalkeeper = Math.abs(gkA - gkB);
  if (gkA === 0) goalkeeper += 10;
  if (gkB === 0) goalkeeper += 10;

  const position =
    Math.abs(groupA[1] - groupB[1]) +
    Math.abs(groupA[2] - groupB[2]) +
    Math.abs(groupA[3] - groupB[3]);

  const total =
    weights.skill * skill +
    weights.uncertainty * uncertainty +
    weights.goalkeeper * goalkeeper +
    weights.position * position +
    weights.repetition * Math.max(0, pairs) +
    weights.relationship * 0; // relationship cost is folded into `pairs`

  return {
    total,
    breakdown: { skill, uncertainty, goalkeeper, position, pairs },
    strengthA: muA,
    strengthB: muB,
  };
}

/**
 * Generate balanced teams.
 *
 * @param {Object} input
 * @param {BalancerPlayer[]} input.players     exactly teamSize * 2 players
 * @param {number}  [input.teamSize]
 * @param {number}  [input.seed]               omit and one is derived; persist it
 * @param {Object}  [input.weights]
 * @param {Array}   [input.pairHistory]        {playerAId, playerBId, sameTeamCount, gamesAgo}
 * @param {Array}   [input.relationships]      {playerId, otherPlayerId, kind, weight, origin}
 * @param {Object}  [input.options]
 */
export function balanceTeams(input) {
  const started = Date.now();
  const {
    players,
    teamSize = Math.floor(players.length / 2),
    seed = Math.floor(Math.random() * 2 ** 31),
    weights: weightOverrides,
    pairHistory = [],
    relationships = [],
    options: optionOverrides,
  } = input;

  const weights = { ...DEFAULT_WEIGHTS, ...weightOverrides };
  const options = { ...DEFAULT_OPTIONS, ...optionOverrides };

  if (players.length !== teamSize * 2) {
    throw new Error(
      `balanceTeams: expected ${teamSize * 2} players for teamSize ${teamSize}, got ${players.length}`
    );
  }
  if (players.length > 30) {
    // 2^30 masks is where exhaustive enumeration stops being instant. Well beyond
    // 11-a-side; if this ever throws, the algorithm needs replacing, not tuning.
    throw new Error(`balanceTeams: ${players.length} players exceeds exhaustive limit of 30`);
  }
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) throw new Error('balanceTeams: duplicate player ids');

  const ctx = prepare(players, {
    pairHistory,
    relationships,
    repetitionWindow: options.repetitionWindow,
  });
  ctx._idxA = new Int32Array(ctx.n);
  ctx._idxB = new Int32Array(ctx.n);

  const { n } = ctx;

  // Bounded shortlist, kept sorted ascending by score. Insertion into a 50-element
  // array beats sorting 352,716 results and allocating for each.
  const shortlist = [];
  const limit = options.shortlistSize;

  let evaluated = 0;

  // Gosper's hack enumerates every teamSize-subset of n bits in a fixed order.
  // Requiring bit 0 to be set picks exactly one of each {A,B} / {B,A} pair, halving
  // the work and removing duplicate mirrored splits.
  let v = (1 << teamSize) - 1;
  const last = 1 << n;

  while (v < last) {
    if (v & 1) {
      const result = scoreSplit(ctx, v, weights);
      evaluated += 1;

      if (shortlist.length < limit || result.total < shortlist[shortlist.length - 1].total) {
        const entry = { mask: v, ...result };
        let lo = 0;
        let hi = shortlist.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (shortlist[mid].total <= entry.total) lo = mid + 1;
          else hi = mid;
        }
        shortlist.splice(lo, 0, entry);
        if (shortlist.length > limit) shortlist.pop();
      }
    }

    // Next subset of the same size.
    const c = v & -v;
    const r = v + c;
    v = (((r ^ v) >>> 2) / c) | r;
  }

  if (shortlist.length === 0) throw new Error('balanceTeams: no valid split found');

  // Variety: treat everything within tolerance of the optimum as equally acceptable and
  // pick among them with a seeded PRNG, biased toward the better scores. The result is
  // still reproducible from (seed, inputs).
  const best = shortlist[0].total;
  const eligible = shortlist.filter((c) => c.total <= best + options.varietyTolerance);

  const rng = mulberry32(seed);
  // Rank weight decays so the optimum stays the most likely outcome.
  const rankWeights = eligible.map((_, i) => 1 / (i + 1));
  const totalWeight = rankWeights.reduce((a, b) => a + b, 0);
  let roll = rng() * totalWeight;
  let chosenRank = 0;
  for (let i = 0; i < eligible.length; i += 1) {
    roll -= rankWeights[i];
    if (roll <= 0) { chosenRank = i; break; }
  }

  const chosen = eligible[chosenRank];

  const teamAPlayers = [];
  const teamBPlayers = [];
  for (let i = 0; i < n; i += 1) {
    (chosen.mask & (1 << i) ? teamAPlayers : teamBPlayers).push(ctx.sorted[i]);
  }

  const formation = formationFor(teamSize);

  return {
    algorithmVersion: ALGORITHM_VERSION,
    seed,
    weights,
    options,
    candidatesEvaluated: evaluated,
    shortlistSize: shortlist.length,
    eligibleCount: eligible.length,
    chosenRank,
    score: chosen.total,
    scoreBreakdown: chosen.breakdown,
    durationMs: Date.now() - started,
    teams: [
      {
        key: 'A',
        strength: chosen.strengthA,
        players: assignPositions(teamAPlayers, formation),
      },
      {
        key: 'B',
        strength: chosen.strengthB,
        players: assignPositions(teamBPlayers, formation),
      },
    ],
    // Everything needed to reproduce this exact result.
    ratingSnapshot: ctx.sorted.map((p) => ({
      id: p.id,
      mu: Number(p.ratingMu),
      sigma: Number(p.ratingSigma),
    })),
  };
}

/**
 * Slot players into a formation. Preference order: a willing keeper takes GK, then each
 * player claims their preferred position if the slot is free, then secondary positions,
 * then whatever is left. Cosmetic -- it does not affect balance -- but it is what makes
 * the team sheet readable when it gets pasted into WhatsApp.
 */
export function assignPositions(teamPlayers, formation) {
  const slots = [...formation];
  const remaining = [...teamPlayers];
  const assigned = [];

  const take = (predicate, slotFilter) => {
    const slotIdx = slots.findIndex(slotFilter);
    if (slotIdx === -1) return false;
    const playerIdx = remaining.findIndex(predicate);
    if (playerIdx === -1) return false;
    const [player] = remaining.splice(playerIdx, 1);
    const [slot] = slots.splice(slotIdx, 1);
    assigned.push({ ...player, assignedPosition: slot });
    return true;
  };

  // Keeper first, and only from players who said they will keep.
  take((p) => p.isGoalkeeper, (s) => s === 'GK');

  // Exact preferred-position matches.
  for (const slot of [...slots]) {
    take((p) => p.preferredPosition === slot, (s) => s === slot);
  }

  // Secondary positions.
  for (const slot of [...slots]) {
    take((p) => (p.secondaryPositions ?? []).includes(slot), (s) => s === slot);
  }

  // Same positional group.
  for (const slot of [...slots]) {
    take(
      (p) => POSITION_GROUPS[p.preferredPosition] === POSITION_GROUPS[slot],
      (s) => s === slot
    );
  }

  // Whoever is left, wherever is left.
  while (remaining.length > 0) {
    const player = remaining.shift();
    const slot = slots.shift() ?? player.preferredPosition ?? 'SUB';
    assigned.push({ ...player, assignedPosition: slot });
  }

  return assigned;
}
