// Service boundary.
//
// Every component talks to these functions and nothing else. This is the ONLY file that
// knows whether the app is running against the mock or the real backend, so switching is
// one environment variable and zero component changes.
//
// Route paths match the real Express API exactly (see backend/src/app.js), so the live
// branch is not guesswork.
//
// WHY THE MOCK IS A DYNAMIC IMPORT
//
// It used to be a static one. `import { mockServer } from './mock/server.js'` pulls in
// mock/data.js, which builds 140 players and 39 games at module scope -- side effects a
// bundler cannot prove are unused, so the whole fixture shipped to production even with
// VITE_USE_MOCK=false. Verified by grepping the built bundle for "Byblos Sporting".
//
// Loading it lazily puts the fixture in its own chunk that production never fetches.

import { api } from './client.js';

// Live by default; the mock is opt-in.
//
// It used to be the other way round, which was right while the backend was half-built and
// wrong the moment it was not. `.env` is gitignored, so a fresh clone has no value set at
// all -- and defaulting to the mock meant someone cloning this repo, running it, and
// concluding the app was a pile of fake data.
const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

/**
 * Which domains talk to the real backend.
 *
 * The backend was built module by module, so for a while some of this app is live and
 * some is not. A single global flag would force an all-or-nothing switch and leave the
 * app broken until the last endpoint landed; a silent per-call fallback would hide which
 * half is still invented. This map is the honest middle: one place that answers "is this
 * screen showing real data?", and a `false` here is a to-do with a name.
 *
 * Everything is live. The mock survives behind VITE_USE_MOCK=true for offline demos and
 * for working on the UI with a full fixture, but nothing reaches it by default.
 */
const LIVE = {
  auth: true,
  districts: true,
  games: true,
  matchday: true,
  players: true,
  phoneAuth: true,
  invites: true,
  schedules: true,
  awards: true,
  adminStats: true,
  ai: true,
  leaderboard: true,
  rewards: true,
};

/** True when this domain should hit the network. */
const live = (domain) => !USE_MOCK && LIVE[domain];

let mockPromise = null;

/** Resolve the mock backend once, on first use. Never reached in production. */
async function callMock(method, ...args) {
  mockPromise ??= import('./mock/server.js').then((module) => module.mockServer);
  const server = await mockPromise;
  return server[method](...args);
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
};

export const authService = {
  login: (body) => (!live('auth') ? callMock('login', body) : api.post('/auth/login', body)),
  signup: (body) => (!live('auth') ? callMock('signup', body) : api.post('/auth/signup', body)),
  logout: () => (!live('auth') ? callMock('logout') : api.post('/auth/logout')),
  me: () => (!live('auth') ? callMock('me') : api.get('/auth/me')),
};

/**
 * Phone sign-in.
 *
 * Two steps, and the second one can come back asking for a name -- that is a new number,
 * not an error. `devCode` is only ever present when the WhatsApp integration is switched
 * off, which is how local development works without a WhatsApp account.
 */
export const phoneAuthService = {
  start: (phone) =>
    !live('phoneAuth') ? callMock('phoneStart', phone) : api.post('/auth/phone/start', { phone }),

  verify: (body) =>
    !live('phoneAuth') ? callMock('phoneVerify', body) : api.post('/auth/phone/verify', body),

  linkStart: (phone) =>
    !live('phoneAuth') ? callMock('phoneStart', phone) : api.post('/auth/phone/link/start', { phone }),

  linkVerify: (body) =>
    !live('phoneAuth') ? callMock('phoneVerify', body) : api.post('/auth/phone/link/verify', body),
};

/**
 * QR invites. The admin half needs a session; the join half explicitly does not, because
 * the person following the link has no account yet.
 */
export const inviteService = {
  create: (body) =>
    !live('invites') ? callMock('createInvite', body) : api.post('/invites', body),

  list: (params) =>
    !live('invites') ? callMock('listInvites') : api.get(`/invites${qs(params)}`),

  revoke: (id) =>
    !live('invites') ? callMock('revokeInvite', id) : api.del(`/invites/${id}`),

  // Public.
  get: (token) =>
    !live('invites') ? callMock('getInvite', token) : api.get(`/join/${token}`),

  sendCode: (token, phone) =>
    !live('invites') ? callMock('phoneStart', phone) : api.post(`/join/${token}/code`, { phone }),

  claim: (token, body) =>
    !live('invites') ? callMock('claimInvite', token, body) : api.post(`/join/${token}/claim`, body),
};

export const districtService = {
  /** Pitches in one district. Venues belong to a district; there is no global list. */
  venues: (districtId) =>
    !live('districts')
      ? callMock('listVenues')
      : api.get(`/districts/${districtId}/venues`),

  createVenue: (districtId, body) =>
    !live('districts')
      ? callMock('listVenues')
      : api.post(`/districts/${districtId}/venues`, body),

  /**
   * Edit a venue. `logoUrl: null` removes the badge; omitting it leaves it alone. The
   * server distinguishes the two, so this must not helpfully strip nulls.
   */
  updateVenue: (districtId, venueId, patch) =>
    !live('districts')
      ? callMock('listVenues')
      : api.patch(`/districts/${districtId}/venues/${venueId}`, patch),

  removeVenue: (districtId, venueId) =>
    !live('districts')
      ? callMock('listVenues')
      : api.del(`/districts/${districtId}/venues/${venueId}`),

  list: () => (!live('districts') ? callMock('listDistricts') : api.get('/districts')),
  get: (slug) => (!live('districts') ? callMock('getDistrict', slug) : api.get(`/districts/${slug}`)),
};

export const gameService = {
  list: (params) => (!live('games') ? callMock('listGames', params) : api.get(`/games${qs(params)}`)),
  /**
   * A game as a PLAYER sees it.
   *
   * The public endpoint answers with { game, roster, teams } side by side, and the
   * matchday screen -- which players and admins share -- renders one nested object. So
   * the fold happens here rather than in the page: the same component then works against
   * either this or the admin projection, and neither has to know which it got.
   *
   * No payment, no attendance, no clock controls. Those are the admin's, and they are
   * absent because the server did not send them, not because the UI hid them.
   */
  get: async (idOrSlug) => {
    if (!live('games')) return callMock('getGame', idOrSlug);
    const { game, roster, teams, clock } = await api.get(`/games/${idOrSlug}`);
    const person = (r) => ({
      playerId: r.player_id,
      name: r.jersey_name || r.display_name,
      avatarUrl: r.avatar_url ?? null,
      position: r.preferred_position,
      isGoalkeeper: r.is_goalkeeper,
      ratingMu: r.rating_mu == null ? null : Number(r.rating_mu),
      ratingSigma: r.rating_sigma == null ? null : Number(r.rating_sigma),
      registeredAt: r.registered_at,
      attendance: r.attendance,
      goals: 0,
      assists: 0,
    });
    return {
      game: {
        ...game,
        roster: (roster?.confirmed ?? []).map(person),
        waitlist: (roster?.waitlist ?? []).map((r) => ({
          ...person(r), waitlistPosition: r.waitlist_position,
        })),
        teams: teams ?? [],
        score: [],
        events: [],
        // Read-only: the page renders the clock without controls when the viewer is not
        // an admin, and the server would refuse the transitions anyway.
        clock: clock ?? null,
        payments: null,
      },
    };
  },
  join: (id, body) => (!live('games') ? callMock('joinGame', id, body) : api.post(`/games/${id}/join`, body)),
  leave: (id, body) => (!live('games') ? callMock('leaveGame', id) : api.post(`/games/${id}/leave`, body)),
  mine: () => (!live('games') ? callMock('myGames') : api.get('/players/me/games')),
};

export const playerService = {
  get: (id) => (!live('players') ? callMock('getPlayer', id) : api.get(`/players/${id}`)),
  me: () => (!live('players') ? callMock('getPlayer', 'me') : api.get('/players/me')),
  update: (patch) => (!live('players') ? callMock('updateProfile', patch) : api.patch('/players/me', patch)),
};

export const leaderboardService = {
  get: (params) =>
    !live('leaderboard') ? callMock('leaderboard', params) : api.get(`/ratings/leaderboard${qs(params)}`),
};

export const rewardService = {
  /**
   * The rewards screen in one call: balance, history, redemptions, achievements and the
   * catalogue. The mock returned all of it from one function and the page destructures
   * all five, so the live path has to answer the same shape or the page crashes on an
   * undefined `achievements`.
   */
  list: () => (!live('rewards') ? callMock('listRewards') : api.get('/rewards/me')),
  redeem: (slug, body) =>
    USE_MOCK ? callMock('redeem', slug) : api.post(`/rewards/${slug}/redeem`, body),
};

/**
 * Matchday operations.
 *
 * Every call is one small mutation returning the whole updated game. That shape is
 * deliberate: the pitch workspace renders from a single object, so an admin marking a
 * payment sees the pitch update without a refetch cascade or a page change.
 */
export const matchdayService = {
  /**
   * The pitch's single source of truth: game, clock, roster with payment and attendance,
   * teams, live score, events. Admin-only -- the backend enforces that, not this call.
   */
  get: (gameId) =>
    !live('matchday') ? callMock('getGame', gameId) : api.get(`/games/${gameId}/matchday`),

  setPayment: (gameId, playerId, paid) =>
    !live('matchday')
      ? callMock('setPayment', gameId, playerId, paid)
      : api.post(`/games/${gameId}/payments`, { playerId, paid }),

  setPlayerStat: (gameId, playerId, patch) =>
    !live('matchday')
      ? callMock('setPlayerStat', gameId, playerId, patch)
      : api.patch(`/games/${gameId}/players/${playerId}/stats`, patch),

  markAllAttendance: (gameId, status, playerIds) =>
    !live('matchday')
      ? callMock('markAllAttendance', gameId, status)
      : api.post(`/games/${gameId}/attendance/all`, { status, playerIds }),

  setMotm: (gameId, playerId) =>
    !live('matchday')
      ? callMock('setMotm', gameId, playerId)
      : api.post(`/games/${gameId}/motm`, { playerId }),

  /**
   * The match clock: start | halftime | resume | end | pause | unpause | abandon.
   *
   * The server returns the transition timestamps and the client runs the clock from
   * them, so a reload, a second device, or a backgrounded tab all agree.
   */
  clock: (gameId, action) =>
    !live('matchday')
      ? callMock('setGameStatus', gameId, action)
      : api.post(`/games/${gameId}/clock`, { action }),

  /**
   * Guard the team sheet, or release it.
   *
   * A real endpoint now. This used to be a `{ locked }` flag posted to /open, which
   * ignores it -- so the Lock button on the matchday screen changed nothing, and the
   * board was read-only for the whole match regardless.
   */
  setTeamsLocked: (gameId, locked) =>
    !live('matchday')
      ? callMock('setGameStatus', gameId, 'teams_generated', { locked })
      : api.post(`/games/${gameId}/teams/lock`, { locked }),

  setFormation: (gameId, formation) =>
    !live('matchday')
      ? callMock('setFormation', gameId, formation)
      : api.post(`/games/${gameId}/formation`, { formation }),

  /**
   * Move players between teams.
   *
   * The backend takes moves, not a whole team sheet, because it records WHICH players an
   * admin overrode and what that cost against the balancer's objective. Passing the full
   * sheet would mark all twenty-two as hand-placed and destroy that signal, so the caller
   * sends only what actually changed.
   */
  movePlayers: (gameId, moves) =>
    !live('matchday')
      ? callMock('setTeams', gameId, moves)
      : api.post(`/games/${gameId}/teams/override`, { moves }),

  /**
   * The whole team sheet, positions included.
   *
   * `slotIndex` travels with each player, so the arrangement on the tactical board is
   * what gets saved. Without it the server knew only which team somebody was on and
   * discarded same-team moves entirely, which is why a carefully arranged pitch reverted
   * on the next refetch.
   *
   * The server only flags a player as hand-placed when their TEAM changed, so sending
   * all twenty-two here no longer destroys the override signal the balancer learns from.
   */
  setTeams: (gameId, teams) =>
    !live('matchday')
      ? callMock('setTeams', gameId, teams)
      : api.post(`/games/${gameId}/teams/override`, {
          moves: teams.flatMap((t) =>
            t.players.map((p) => ({
              playerId: p.id,
              toTeamId: t.id,
              ...(p.slotIndex == null ? {} : { slotIndex: p.slotIndex }),
            }))
          ),
        }),

  // Lifecycle that is not the clock: opening registration, calling the game off.
  setStatus: (gameId, status, meta) =>
    !live('matchday')
      ? callMock('setGameStatus', gameId, status, meta)
      : status === 'cancelled'
        ? api.post(`/games/${gameId}/cancel`, meta ?? {})
        : api.post(`/games/${gameId}/open`, {}),

  promote: (gameId, playerId) =>
    !live('matchday')
      ? callMock('promoteFromWaitlist', gameId, playerId)
      : api.post(`/games/${gameId}/roster`, { playerId, allowWaitlist: false }),

  removePlayer: (gameId, playerId) =>
    !live('matchday')
      ? callMock('removePlayer', gameId, playerId)
      : api.del(`/games/${gameId}/roster/${playerId}`),

  addPlayer: (gameId, playerId) =>
    !live('matchday')
      ? callMock('addPlayerToGame', gameId, playerId)
      : api.post(`/games/${gameId}/roster`, { playerId }),

  /** Create a player who has never signed in, then put them straight on the roster. */
  createPlayer: (body) =>
    !live('players') ? callMock('createPlayer', body) : api.post('/players', body),

  pairHistory: (playerAId, playerBId) =>
    !live('matchday')
      ? callMock('pairHistory', playerAId, playerBId)
      : api.get(`/players/${playerAId}/pairs/${playerBId}`),
};

export const scheduleService = {
  list: (params) =>
    !live('schedules') ? callMock('listSchedules') : api.get(`/schedules${qs(params)}`),

  create: (body) =>
    !live('schedules') ? callMock('createSchedule', body) : api.post('/schedules', body),

  setActive: (id, isActive) =>
    !live('schedules')
      ? callMock('setScheduleActive', id, isActive)
      : api.patch(`/schedules/${id}`, { isActive }),

  /** The fixtures this rule has produced. */
  games: (id) =>
    !live('schedules') ? callMock('listSchedules') : api.get(`/schedules/${id}/games`),

  /**
   * Remove the rule. By default the fixtures it already created survive as ordinary
   * one-off games -- people have signed up for them, and deleting the rule is not a
   * reason to cancel next Tuesday. `withFuture` removes the unplayed ones too.
   */
  remove: (id, { withFuture = false } = {}) =>
    !live('schedules')
      ? callMock('deleteSchedule', id)
      : api.del(`/schedules/${id}?withFuture=${withFuture}`),
};

export const awardService = {
  manOfTheMonth: (params) =>
    !live('awards')
      ? callMock('getManOfTheMonth')
      : api.get(`/awards/man-of-the-month${qs(params)}`),
};

export const aiService = {
  /**
   * Record what the assistant did.
   *
   * In production this is written server-side as part of executing the tool -- the
   * frontend cannot be the audit trail for its own actions. This client call exists so
   * the mock has a history to display.
   */
  record: (entry) => (!live('ai') ? callMock('recordAiAction', entry) : Promise.resolve(null)),

  /**
   * The audit trail, read from the server.
   *
   * Every tool the assistant runs goes through a normal admin endpoint, and those already
   * write an admin_actions row. So the history is the real audit log rather than a list
   * the browser kept -- which vanished on reload and could be edited by whoever was
   * being audited.
   */
  history: () => (!live('ai') ? callMock('listAiActions') : api.get('/admin/actions')),
};

export const adminService = {
  overview: () => (!live('adminStats') ? callMock('adminOverview') : api.get('/admin/overview')),
  createGame: (body) => (USE_MOCK ? callMock('createGame', body) : api.post('/games', body)),

  /**
   * Delete a game outright, as distinct from cancelling it.
   *
   * Cancel records that a game was called off, which the reliability numbers depend on.
   * Delete is for a game that should never have existed. The server refuses once ratings
   * or points have settled, because by then the game is the reason everyone's numbers
   * are what they are.
   */
  deleteGame: (id) => (USE_MOCK ? callMock('deleteGame', id) : api.del(`/games/${id}`)),

  /** Deletes if they never played; deactivates if they did. The response says which. */
  deletePlayer: (id) => (USE_MOCK ? callMock('deletePlayer', id) : api.del(`/players/${id}`)),
  generateTeams: (id, body) =>
    USE_MOCK ? callMock('generateTeams', id, body) : api.post(`/games/${id}/teams/generate`, body),
  overrideTeams: (id, moves) =>
    USE_MOCK ? callMock('overrideTeams', id, moves) : api.post(`/games/${id}/teams/override`, { moves }),
  submitResult: (id, body) =>
    USE_MOCK ? callMock('submitResult', id, body) : api.post(`/games/${id}/result`, body),

  announcement: async (id, kind) => {
    if (!USE_MOCK) return api.post(`/games/${id}/announcement`, { kind });
    const { buildAnnouncement } = await import('./mock/announcements.js');
    return buildAnnouncement(id, kind);
  },
};

export { USE_MOCK };
