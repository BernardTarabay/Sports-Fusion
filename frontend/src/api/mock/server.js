// Mock backend.
//
// This mirrors the real API's SHAPES and its ERROR CODES, not just its happy path. When
// the backend is plugged in, only src/api/services.js changes -- no component knows
// which one it is talking to.
//
// It deliberately simulates latency and can be made to fail, because a UI only tested
// against instant, always-successful responses has no loading states worth having and
// no error states at all.

import {
  districts, venues, players, playersById, games, gamesById, currentPlayer,
  myRegistrations, rewards, achievements, pointHistory, myRedemptions,
  myRatingHistory, districtStats, platformStats,
  schedules, upcomingOccurrences, weekdayName, manOfTheMonth, aiActions,
} from './data.js';
import { ApiError } from '../client.js';
import { LEADERBOARD_METRICS } from '../../lib/catalogue.js';

const LATENCY = [140, 380];
const delay = () =>
  new Promise((r) => setTimeout(r, LATENCY[0] + Math.random() * (LATENCY[1] - LATENCY[0])));

function fail(code, status = 409, details) {
  throw new ApiError(code, { status, code, details });
}

// Session lives in memory. A refresh signs you out, which is honest for a mock and
// avoids pretending we have a cookie we do not.
let session = null;

const sortByKickoff = (a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt);
const isUpcoming = (g) => new Date(g.kickoffAt) > new Date();

/**
 * Strip anything the API would not return to an unauthenticated caller.
 *
 * "Am I registered" is meaningless without a session, and reporting it anyway produced
 * a page showing "You're in" above a "Sign in to join" button.
 */
function publicGame(g) {
  const signedIn = !!session;
  return {
    ...g,

    // Nested collections are CLONED, not shared.
    //
    // The mock mutates roster entries in place (entry.paid = true), and a shallow
    // {...g} hands back the same array with the same objects inside it. React re-renders
    // but every useMemo keyed on `roster` sees an unchanged reference and skips, so the
    // pitch and the attendance counts silently stay stale. A real HTTP response is fresh
    // JSON every time; the mock has to behave the same way or it hides bugs that only
    // appear against the mock, and hides correct behaviour that only appears against the
    // real API.
    roster: g.roster.map((r) => ({ ...r })),
    waitlist: g.waitlist.map((w) => ({ ...w })),
    teams: g.teams.map((t) => ({ ...t, players: t.players.map((p) => ({ ...p })) })),
    result: g.result ? { ...g.result } : null,

    spotsLeft: Math.max(0, g.capacity - g.confirmedCount),
    isRegistered: signedIn && myRegistrations.has(g.id),
    myWaitlistPosition: signedIn
      ? g.waitlist.find((w) => w.playerId === currentPlayer.id)?.waitlistPosition ?? null
      : null,
  };
}

export const mockServer = {
  // --- auth -------------------------------------------------------------
  async login({ identifier, password }) {
    await delay();
    if (!password || password.length < 6) fail('INVALID_CREDENTIALS', 401);
    const isAdmin = identifier.includes('admin');
    session = {
      id: 'u-me',
      displayName: isAdmin ? 'Admin' : currentPlayer.name,
      email: identifier,
      roles: isAdmin ? [{ role: 'owner', districtId: null }] : [{ role: 'player', districtId: null }],
      playerId: currentPlayer.id,
    };
    return { user: session };
  },

  async signup({ displayName, email, districtId }) {
    await delay();
    if (email === 'taken@sportsfusion.app') fail('ACCOUNT_EXISTS');
    session = {
      id: 'u-me',
      displayName,
      email,
      roles: [{ role: 'player', districtId: null }],
      playerId: currentPlayer.id,
      districtId,
    };
    return { user: session };
  },

  async me() {
    await delay();
    if (!session) fail('UNAUTHORIZED', 401);
    return { user: session, player: currentPlayer };
  },

  async logout() {
    await delay();
    session = null;
    return null;
  },

  // --- districts --------------------------------------------------------
  async listDistricts() {
    await delay();
    return {
      districts: districts.map((d) => ({ ...d, ...districtStats(d.id) })),
      platform: platformStats,
    };
  },

  async getDistrict(slug) {
    await delay();
    const district = districts.find((d) => d.slug === slug);
    if (!district) fail('NOT_FOUND', 404);

    const dGames = games.filter((g) => g.districtId === district.id);
    return {
      district: { ...district, ...districtStats(district.id) },
      venues: venues.filter((v) => v.districtId === district.id),
      upcoming: dGames.filter(isUpcoming).sort(sortByKickoff).map(publicGame),
      recent: dGames
        .filter((g) => g.status === 'completed')
        .sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt))
        .slice(0, 5)
        .map(publicGame),
      leaderboard: rankPlayers({ districtId: district.id, metric: 'rating' }).slice(0, 10),
    };
  },

  // --- games ------------------------------------------------------------
  async listGames({ districtId, status, when = 'upcoming' } = {}) {
    await delay();
    let list = games.filter((g) => g.status !== 'draft');

    if (districtId) list = list.filter((g) => g.districtId === districtId);
    if (status?.length) list = list.filter((g) => status.includes(g.status));

    if (when === 'upcoming') list = list.filter(isUpcoming).sort(sortByKickoff);
    if (when === 'past') {
      list = list
        .filter((g) => !isUpcoming(g))
        .sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt));
    }

    return { games: list.map(publicGame) };
  },

  async getGame(idOrSlug) {
    await delay();
    const game = gamesById[idOrSlug] ?? games.find((g) => g.slug === idOrSlug);
    if (!game) fail('NOT_FOUND', 404);
    return { game: publicGame(game) };
  },

  async joinGame(gameId, { allowWaitlist = true } = {}) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    if (game.status === 'cancelled') fail('GAME_CANCELLED');
    if (!isUpcoming(game)) fail('GAME_STARTED');
    if (myRegistrations.has(gameId)) fail('ALREADY_REGISTERED');

    if (game.confirmedCount >= game.capacity) {
      if (!allowWaitlist) fail('GAME_FULL', 409, { waitlistPosition: game.waitlistCount + 1 });
      const position = game.waitlistCount + 1;
      game.waitlist.push({
        playerId: currentPlayer.id, name: currentPlayer.name,
        position: currentPlayer.position, waitlistPosition: position,
      });
      game.waitlistCount = game.waitlist.length;
      myRegistrations.add(gameId);
      return { status: 'waitlisted', waitlistPosition: position, game: publicGame(game) };
    }

    game.roster.push({
      playerId: currentPlayer.id, name: currentPlayer.name, position: currentPlayer.position,
      ratingMu: currentPlayer.ratingMu, ratingSigma: currentPlayer.ratingSigma,
      isGoalkeeper: false, registeredAt: new Date().toISOString(), attendance: null,
    });
    game.confirmedCount = game.roster.length;
    if (game.confirmedCount >= game.capacity) game.status = 'full';
    myRegistrations.add(gameId);

    return { status: 'confirmed', waitlistPosition: null, game: publicGame(game) };
  },

  async leaveGame(gameId) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    if (!myRegistrations.has(gameId)) fail('NOT_REGISTERED');

    game.roster = game.roster.filter((r) => r.playerId !== currentPlayer.id);
    game.waitlist = game.waitlist
      .filter((w) => w.playerId !== currentPlayer.id)
      .map((w, i) => ({ ...w, waitlistPosition: i + 1 }));

    // Promote the top of the waiting list, exactly as the backend does in the same
    // transaction as the cancellation.
    let promoted = null;
    if (game.roster.length < game.capacity && game.waitlist.length > 0) {
      const next = game.waitlist.shift();
      game.roster.push({
        playerId: next.playerId, name: next.name, position: next.position,
        ratingMu: playersById[next.playerId]?.ratingMu ?? 1500,
        ratingSigma: playersById[next.playerId]?.ratingSigma ?? 350,
        isGoalkeeper: playersById[next.playerId]?.isGoalkeeper ?? false,
        registeredAt: new Date().toISOString(), attendance: null,
      });
      game.waitlist = game.waitlist.map((w, i) => ({ ...w, waitlistPosition: i + 1 }));
      promoted = next;
    }

    game.confirmedCount = game.roster.length;
    game.waitlistCount = game.waitlist.length;
    if (game.confirmedCount < game.capacity && game.status === 'full') {
      game.status = 'registration_open';
    }
    myRegistrations.delete(gameId);

    return { cancelled: true, promoted, game: publicGame(game) };
  },

  // --- players ----------------------------------------------------------
  async getPlayer(playerId) {
    await delay();
    const player = playerId === 'me' ? currentPlayer : playersById[playerId];
    if (!player) fail('NOT_FOUND', 404);

    const history = games
      .filter((g) => g.status === 'completed' && g.roster.some((r) => r.playerId === player.id))
      .sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt))
      .slice(0, 12)
      .map((g) => {
        const team = g.teams.find((t) => t.players.some((p) => p.id === player.id));
        return {
          gameId: g.id,
          kickoffAt: g.kickoffAt,
          districtName: g.districtName,
          teamColor: team?.color ?? null,
          score: g.result?.score ?? null,
          rating: Math.round((6.5 + (player.ratingMu - 1500) / 150 + (Math.random() - 0.5)) * 10) / 10,
          motm: g.result?.motm?.playerId === player.id,
        };
      });

    return {
      player: {
        ...player,
        districtName: districts.find((d) => d.id === player.districtId)?.name,
        rank: rankPlayers({ metric: 'rating' }).findIndex((p) => p.id === player.id) + 1,
        percentile: percentileOf(player),
      },
      history,
      ratingHistory: player.id === currentPlayer.id ? myRatingHistory : synthRatingHistory(player),
      achievements: player.id === currentPlayer.id ? achievements : achievements.slice(0, 4),
    };
  },

  async updateProfile(patch) {
    await delay();
    Object.assign(currentPlayer, patch);
    return { player: currentPlayer };
  },

  async myGames() {
    await delay();
    const mine = games
      .filter((g) => myRegistrations.has(g.id))
      .sort(sortByKickoff)
      .map(publicGame);
    return {
      upcoming: mine.filter(isUpcoming),
      past: mine.filter((g) => !isUpcoming(g)).reverse(),
    };
  },

  // --- leaderboards -----------------------------------------------------
  async leaderboard({ metric = 'rating', districtId, limit = 25 } = {}) {
    await delay();
    return { leaderboard: rankPlayers({ metric, districtId }).slice(0, limit) };
  },

  // --- rewards ----------------------------------------------------------
  async listRewards() {
    await delay();
    return {
      balance: currentPlayer.pointsBalance,
      rewards: rewards.map((r) => {
        const blockedBy = [];
        if (currentPlayer.pointsBalance < r.pointCost) {
          blockedBy.push({ code: 'INSUFFICIENT_POINTS', short: r.pointCost - currentPlayer.pointsBalance });
        }
        if (r.stockRemaining === 0) blockedBy.push({ code: 'OUT_OF_STOCK' });
        if (currentPlayer.attended < r.minGamesPlayed) {
          blockedBy.push({ code: 'NOT_ENOUGH_GAMES', needs: r.minGamesPlayed - currentPlayer.attended });
        }
        return { ...r, canRedeem: blockedBy.length === 0, blockedBy };
      }),
      history: pointHistory,
      redemptions: myRedemptions,
      achievements,
    };
  },

  async redeem(slug) {
    await delay();
    const reward = rewards.find((r) => r.slug === slug);
    if (!reward) fail('NOT_FOUND', 404);
    if (!reward.isActive) fail('REWARD_INACTIVE');
    if (reward.stockRemaining === 0) fail('OUT_OF_STOCK');
    if (currentPlayer.attended < reward.minGamesPlayed) {
      fail('NOT_ENOUGH_GAMES', 409, { needs: reward.minGamesPlayed - currentPlayer.attended });
    }
    if (currentPlayer.pointsBalance < reward.pointCost) {
      fail('INSUFFICIENT_POINTS', 409, {
        required: reward.pointCost, balance: currentPlayer.pointsBalance,
      });
    }

    currentPlayer.pointsBalance -= reward.pointCost;
    if (reward.stockRemaining != null) reward.stockRemaining -= 1;
    const redemption = {
      id: `rr-${Date.now()}`, rewardName: reward.name, status: 'pending',
      pointsSpent: reward.pointCost, discountCode: null,
      createdAt: new Date().toISOString(), expiresAt: null,
    };
    myRedemptions.unshift(redemption);
    pointHistory.unshift({
      id: Date.now(), delta: -reward.pointCost, reason: 'redemption',
      at: new Date().toISOString(), note: reward.name,
    });

    return { redemption, balance: currentPlayer.pointsBalance };
  },

  // --- admin ------------------------------------------------------------
  async adminOverview() {
    await delay();
    const today = games.filter((g) => {
      const k = new Date(g.kickoffAt);
      const now = new Date();
      return k.toDateString() === now.toDateString() && g.status !== 'cancelled';
    });
    const upcoming = games.filter(isUpcoming).filter((g) => g.status !== 'cancelled').sort(sortByKickoff);

    return {
      today: {
        games: today.length,
        registered: today.reduce((s, g) => s + g.confirmedCount, 0),
        waitlisted: today.reduce((s, g) => s + g.waitlistCount, 0),
        attendance: 0.91,
      },
      openActions: [
        ...upcoming.filter((g) => g.status === 'full').map((g) => ({
          type: 'generate_teams', gameId: g.id, label: 'Teams not generated',
          game: publicGame(g), severity: 'high',
        })),
        ...games
          .filter((g) => g.status === 'completed' && !g.result)
          .slice(0, 3)
          .map((g) => ({
            type: 'enter_result', gameId: g.id, label: 'Result not recorded',
            game: publicGame(g), severity: 'medium',
          })),
        ...upcoming.filter((g) => g.confirmedCount / g.capacity < 0.5).slice(0, 2).map((g) => ({
          type: 'low_signups', gameId: g.id, label: 'Filling slowly',
          game: publicGame(g), severity: 'low',
        })),
      ],
      upcoming: upcoming.slice(0, 8).map(publicGame),
      occupancyTrend: Array.from({ length: 12 }, (_, i) => ({
        label: `W${i + 1}`,
        value: Math.round((0.72 + Math.sin(i / 2) * 0.08 + i * 0.012) * 100) / 100,
      })),
      districtPerformance: districts.map((d) => ({
        name: d.name, ...districtStats(d.id),
      })),
    };
  },

  async generateTeams(gameId, { seed } = {}) {
    // Deliberately slower: the real thing evaluates 352,716 splits, and the
    // generation sequence in the UI is a feature rather than a stall.
    await new Promise((r) => setTimeout(r, 900));
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    if (game.confirmedCount !== game.capacity) {
      fail('GAME_NOT_FULL', 409, { confirmed: game.confirmedCount, capacity: game.capacity });
    }

    const squad = game.roster.map((r) => playersById[r.playerId] ?? {
      id: r.playerId, name: r.name, ratingMu: r.ratingMu, ratingSigma: r.ratingSigma,
      isGoalkeeper: r.isGoalkeeper, position: r.position,
    });

    // Shuffle deterministically by seed so "regenerate" visibly produces a different
    // but still balanced split, like the real shortlist sampling.
    const s = seed ?? Math.floor(Math.random() * 100000);
    const shuffled = [...squad].sort(
      (a, b) => ((a.id.charCodeAt(2) * s) % 97) - ((b.id.charCodeAt(2) * s) % 97)
    );

    const { buildTeamsFor } = await import('./teamBuilder.js');
    game.teams = buildTeamsFor(shuffled, game.teamSize);
    game.status = 'teams_generated';

    return {
      teams: game.teams,
      seed: s,
      candidatesEvaluated: 352716,
      score: Math.round(Math.random() * 40 + 8),
      durationMs: 113,
    };
  },

  async overrideTeams(gameId, moves) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);

    for (const move of moves) {
      const from = game.teams.find((t) => t.players.some((p) => p.id === move.playerId));
      const to = game.teams.find((t) => t.id === move.toTeamId);
      if (!from || !to || from.id === to.id) continue;
      const player = from.players.find((p) => p.id === move.playerId);
      from.players = from.players.filter((p) => p.id !== move.playerId);
      to.players.push({ ...player, isManualOverride: true });
    }

    for (const team of game.teams) {
      team.strength = Math.round(team.players.reduce((s, p) => s + p.ratingMu, 0) * 10) / 10;
    }

    return { teams: game.teams };
  },

  async submitResult(gameId, { score, motmPlayerId }) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    const motm = game.teams.flatMap((t) => t.players).find((p) => p.id === motmPlayerId);
    game.result = {
      score,
      motm: motm ? { playerId: motm.id, name: motm.name, rating: 9.1 } : null,
      scorers: [],
    };
    game.status = 'completed';
    return { result: game.result };
  },

  // --- matchday operations ----------------------------------------------
  //
  // These are what an admin uses standing at the side of a pitch. Every one is a
  // single small mutation returning the updated game, because the workspace renders
  // from one object and nothing should require leaving the pitch.

  async setPayment(gameId, playerId, paid) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    const entry = game.roster.find((r) => r.playerId === playerId);
    if (!entry) fail('PLAYER_NOT_IN_GAME');
    entry.paid = paid;
    entry.paidAt = paid ? new Date().toISOString() : null;
    return { game: publicGame(game) };
  },

  async setPlayerStat(gameId, playerId, patch) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    const entry = game.roster.find((r) => r.playerId === playerId);
    if (!entry) fail('PLAYER_NOT_IN_GAME');

    if (patch.goals != null) entry.goals = Math.max(0, patch.goals);
    if (patch.assists != null) entry.assists = Math.max(0, patch.assists);
    if (patch.rating !== undefined) entry.rating = patch.rating;
    if (patch.attendance !== undefined) entry.attendance = patch.attendance;

    return { game: publicGame(game) };
  },

  async markAllAttendance(gameId, status) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    game.roster.forEach((entry) => { entry.attendance = status; });
    return { game: publicGame(game) };
  },

  async setMotm(gameId, playerId) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    const entry = game.roster.find((r) => r.playerId === playerId);
    game.result = game.result ?? { score: { black: 0, white: 0 }, scorers: [] };
    // Tapping the current holder clears it, so this is a toggle rather than a trap.
    game.result.motm = game.result.motm?.playerId === playerId
      ? null
      : { playerId, name: entry?.name ?? '', rating: entry?.rating ?? null };
    return { game: publicGame(game) };
  },

  async setScore(gameId, score) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    game.result = { ...(game.result ?? { scorers: [] }), score };
    return { game: publicGame(game) };
  },

  async setFormation(gameId, formation) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    game.formation = formation;
    return { game: publicGame(game) };
  },

  async setTeams(gameId, teams) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    game.teams = teams;
    return { game: publicGame(game) };
  },

  async setGameStatus(gameId, status, meta = {}) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    game.status = status;
    if (status === 'cancelled') game.cancelledReason = meta.reason ?? null;
    if (meta.locked !== undefined) game.lockedTeams = !!meta.locked;
    return { game: publicGame(game) };
  },

  async promoteFromWaitlist(gameId, playerId) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);

    const index = playerId ? game.waitlist.findIndex((w) => w.playerId === playerId) : 0;
    if (index === -1 || game.waitlist.length === 0) fail('NOT_FOUND', 404);

    const [next] = game.waitlist.splice(index, 1);
    game.roster.push({
      playerId: next.playerId, name: next.name, position: next.position,
      ratingMu: playersById[next.playerId]?.ratingMu ?? 1500,
      ratingSigma: playersById[next.playerId]?.ratingSigma ?? 350,
      isGoalkeeper: playersById[next.playerId]?.isGoalkeeper ?? false,
      registeredAt: new Date().toISOString(), attendance: null,
      paid: false, paidAt: null, goals: 0, assists: 0, rating: null,
    });
    game.waitlist = game.waitlist.map((w, i) => ({ ...w, waitlistPosition: i + 1 }));
    game.confirmedCount = game.roster.length;
    game.waitlistCount = game.waitlist.length;

    return { promoted: next, game: publicGame(game) };
  },

  async removePlayer(gameId, playerId) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    game.roster = game.roster.filter((r) => r.playerId !== playerId);
    game.teams = game.teams.map((t) => ({
      ...t, players: t.players.filter((p) => p.id !== playerId),
    }));
    game.confirmedCount = game.roster.length;
    if (game.confirmedCount < game.capacity && game.status === 'full') {
      game.status = 'registration_open';
    }
    return { game: publicGame(game) };
  },

  async addPlayerToGame(gameId, playerId) {
    await delay();
    const game = gamesById[gameId];
    if (!game) fail('NOT_FOUND', 404);
    const player = playersById[playerId];
    if (!player) fail('NOT_FOUND', 404);
    if (game.roster.some((r) => r.playerId === playerId)) fail('ALREADY_REGISTERED');

    if (game.confirmedCount >= game.capacity) {
      game.waitlist.push({
        playerId: player.id, name: player.name, position: player.position,
        waitlistPosition: game.waitlist.length + 1,
      });
      game.waitlistCount = game.waitlist.length;
      return { status: 'waitlisted', game: publicGame(game) };
    }

    game.roster.push({
      playerId: player.id, name: player.name, position: player.position,
      ratingMu: player.ratingMu, ratingSigma: player.ratingSigma,
      isGoalkeeper: player.isGoalkeeper, registeredAt: new Date().toISOString(),
      attendance: null, paid: false, paidAt: null, goals: 0, assists: 0, rating: null,
    });
    game.confirmedCount = game.roster.length;
    if (game.confirmedCount >= game.capacity) game.status = 'full';
    return { status: 'confirmed', game: publicGame(game) };
  },

  /**
   * How often two players have shared a side, and how recently.
   *
   * Surfaced in the team builder so an admin can see WHY the balancer separated a
   * pair, instead of assuming it got it wrong.
   */
  async pairHistory(playerAId, playerBId) {
    await delay();
    const played = games
      .filter((g) => g.status === 'completed' && g.teams.length === 2)
      .sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt));

    let together = 0;
    let lastTogetherGamesAgo = null;

    played.forEach((g, i) => {
      const teamOf = (id) => g.teams.findIndex((t) => t.players.some((p) => p.id === id));
      const a = teamOf(playerAId);
      const b = teamOf(playerBId);
      if (a !== -1 && a === b) {
        together += 1;
        if (lastTogetherGamesAgo == null) lastTogetherGamesAgo = i;
      }
    });

    return { together, lastTogetherGamesAgo, sampled: played.length };
  },

  // --- venues -------------------------------------------------------------
  //
  // Returned for every district at once so a create form can filter client-side as
  // the district changes, rather than refetching on each keystroke of a dropdown.
  async listVenues() {
    await delay();
    return {
      venues: venues.map((venue) => ({
        ...venue,
        districtName: districts.find((d) => d.id === venue.districtId)?.name,
      })),
    };
  },

  // --- schedules ---------------------------------------------------------
  async listSchedules() {
    await delay();
    return {
      schedules: schedules.map((sched) => ({
        ...sched,
        weekdayName: weekdayName(sched.weekday),
        districtName: districts.find((d) => d.id === sched.districtId)?.name,
        venueName: venues.find((v) => v.id === sched.venueId)?.name,
        upcoming: upcomingOccurrences(sched, 5).map((d) => d.toISOString()),
      })),
    };
  },

  async createSchedule(payload) {
    await delay();
    const schedule = {
      id: `s-${Date.now()}`, isActive: true, horizonDays: 21,
      createdAt: new Date().toISOString(), ...payload,
    };
    schedules.push(schedule);
    return {
      schedule: {
        ...schedule,
        weekdayName: weekdayName(schedule.weekday),
        districtName: districts.find((d) => d.id === schedule.districtId)?.name,
        venueName: venues.find((v) => v.id === schedule.venueId)?.name,
        upcoming: upcomingOccurrences(schedule, 5).map((d) => d.toISOString()),
      },
    };
  },

  async setScheduleActive(scheduleId, isActive) {
    await delay();
    const schedule = schedules.find((sched) => sched.id === scheduleId);
    if (!schedule) fail('NOT_FOUND', 404);
    schedule.isActive = isActive;
    return { schedule };
  },

  // --- man of the month --------------------------------------------------
  async getManOfTheMonth() {
    await delay();
    return manOfTheMonth;
  },

  // --- ai audit ----------------------------------------------------------
  async recordAiAction(entry) {
    aiActions.unshift({ id: `ai-${Date.now()}`, at: new Date().toISOString(), ...entry });
    return { recorded: true };
  },

  async listAiActions() {
    await delay();
    return { actions: aiActions.slice(0, 50) };
  },

  async createGame(payload) {
    await delay();
    const district = districts.find((d) => d.id === payload.districtId);
    const venue = venues.find((v) => v.id === payload.venueId);
    const id = `g-new-${Date.now()}`;
    const game = {
      id,
      slug: `new-${district?.slug ?? 'game'}-${id.slice(-4)}`,
      districtId: payload.districtId,
      districtName: district?.name ?? '',
      venue: venue ? { id: venue.id, name: venue.name, address: venue.address, pitchType: venue.pitchType } : null,
      kickoffAt: payload.kickoffAt,
      durationMinutes: 90,
      arriveByMinutes: 15,
      capacity: payload.capacity,
      teamSize: payload.capacity / 2,
      status: payload.openImmediately ? 'registration_open' : 'draft',
      price: payload.price ?? 10,
      currency: 'USD',
      confirmedCount: 0,
      waitlistCount: 0,
      roster: [],
      waitlist: [],
      teams: [],
      result: null,
    };
    games.push(game);
    gamesById[id] = game;
    return { game: publicGame(game) };
  },
};

// ---------------------------------------------------------------------------

function percentileOf(player) {
  const better = players.filter((p) => p.ratingMu > player.ratingMu).length;
  return Math.max(1, Math.round((better / players.length) * 100));
}

function synthRatingHistory(player) {
  return Array.from({ length: 12 }, (_, i) => ({
    at: new Date(Date.now() - (12 - i) * 7 * 86_400_000).toISOString(),
    mu: Math.round(player.ratingMu - (12 - i) * 4 + Math.sin(i) * 18),
    sigma: Math.round(Math.max(player.ratingSigma, 300 - i * 18)),
    change: i === 0 ? null : Math.round(Math.sin(i) * 12),
  }));
}

const METRICS = {
  // Ranked on the rating itself, NOT on a confidence-adjusted value. The pool is
  // already filtered to players the system knows well (see rankPlayers), so the
  // "don't rank the unknown" job is done by the filter. Ordering by one number and
  // displaying another makes a leaderboard read as broken: 8.1, 7.7, 8.3.
  rating: { label: 'Overall', value: (p) => p.ratingMu, display: (p) => p.ratingMu },
  form: { label: 'Form', value: (p) => p.form.reduce((s, f) => s + f, 0) / p.form.length, display: (p) => p.form.at(-1) },
  goals: { label: 'Goals', value: (p) => p.goals, display: (p) => p.goals },
  assists: { label: 'Assists', value: (p) => p.assists, display: (p) => p.assists },
  motm: { label: 'MOTM', value: (p) => p.motm, display: (p) => p.motm },
  reliability: {
    label: 'Reliability',
    value: (p) => (p.games < 3 ? -1 : p.attended / Math.max(1, p.games)),
    display: (p) => (p.games < 3 ? null : p.attended / Math.max(1, p.games)),
  },
  improved: { label: 'Most improved', value: (p) => p.form.at(-1) - p.form[0], display: (p) => p.form.at(-1) - p.form[0] },
};

export function rankPlayers({ metric = 'rating', districtId } = {}) {
  const spec = METRICS[metric] ?? METRICS.rating;
  let pool = players;
  if (districtId) pool = pool.filter((p) => p.districtId === districtId);
  // A leaderboard full of people the system has seen twice is not a ranking.
  if (metric === 'rating') pool = pool.filter((p) => p.games >= 5 && p.ratingSigma <= 150);

  return [...pool]
    .sort((a, b) => spec.value(b) - spec.value(a))
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      position: p.position,
      districtName: districts.find((d) => d.id === p.districtId)?.name,
      ratingMu: p.ratingMu,
      ratingSigma: p.ratingSigma,
      games: p.games,
      attended: p.attended,
      noShows: p.noShows,
      value: spec.display(p),
      metric,
      form: p.form,
    }));
}

// The board list lives in lib/catalogue.js so pages can import it without pulling
// this entire mock backend into the production bundle.
export { LEADERBOARD_METRICS };
