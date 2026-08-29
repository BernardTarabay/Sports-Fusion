// The assistant's tool registry.
//
// THE ARCHITECTURAL POINT
//
// The AI never touches data. It picks a tool and supplies arguments; the tool calls the
// same service layer every button in the app calls, which calls the same API, which the
// backend authorises. There is no privileged path — an assistant asked to cancel a game
// it has no rights to gets the same 403 a button would.
//
//     admin message -> intent -> tool + args -> services.js -> API -> database
//
// RISK GATES
//
// Each tool declares a risk level. `low` executes immediately; `high` returns a
// confirmation payload the UI renders as a card and executes only on explicit approval.
// "Cancel Friday's game" affecting 22 people must never happen because a phrase was
// parsed loosely.
//
// This registry is also the tool schema an LLM would be given. In production the model
// runs server-side and receives exactly these names, descriptions and parameters — this
// file is the contract, not a client-side reimplementation of one.

import {
  gameService, matchdayService, adminService, scheduleService, leaderboardService,
  playerService,
} from '../api/services.js';

export const RISK = { LOW: 'low', HIGH: 'high' };

const LABEL = { attended: 'here', late: 'late', no_show: 'a no-show' };

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {string} description   what an LLM is told the tool does
 * @property {object} parameters    JSON-schema-ish, for the model
 * @property {'low'|'high'} risk
 * @property {(args, ctx) => Promise<object>} run
 * @property {(args, ctx) => object} [confirm]  card shown before a high-risk run
 */

export const tools = {
  /* --- reading -------------------------------------------------------- */

  get_game: {
    name: 'get_game',
    description: 'Get the full detail of a game, including roster, waitlist and teams.',
    parameters: { gameId: 'string — defaults to the game currently on screen' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const { game } = await gameService.get(args.gameId ?? ctx.gameId);
      return {
        summary: `${game.districtName}, ${game.confirmedCount}/${game.capacity} registered${
          game.waitlistCount ? `, ${game.waitlistCount} waiting` : ''
        }.`,
        game,
      };
    },
  },

  get_unpaid: {
    name: 'get_unpaid',
    description: 'List everyone in a game who has not paid yet.',
    parameters: { gameId: 'string — defaults to the current game' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const { game } = await gameService.get(args.gameId ?? ctx.gameId);
      const unpaid = game.roster.filter((r) => !r.paid);
      return {
        summary: unpaid.length === 0
          ? 'Everyone has paid.'
          : `${unpaid.length} of ${game.roster.length} have not paid: ${unpaid.map((r) => r.name).join(', ')}.`,
        players: unpaid,
      };
    },
  },

  get_leaderboard: {
    name: 'get_leaderboard',
    description: 'Top players overall or in a district.',
    parameters: { districtId: 'string, optional', metric: 'rating | form | goals | assists | motm' },
    risk: RISK.LOW,
    run: async (args) => {
      const { leaderboard } = await leaderboardService.get({
        metric: args.metric ?? 'rating', districtId: args.districtId, limit: 5,
      });
      return {
        summary: leaderboard.length
          ? `Top: ${leaderboard.slice(0, 3).map((p, i) => `${i + 1}. ${p.name}`).join(', ')}.`
          : 'Not enough games played to rank anyone yet.',
        leaderboard,
      };
    },
  },

  get_player: {
    name: 'get_player',
    description: "A player's profile, form and career stats.",
    parameters: { playerId: 'string' },
    risk: RISK.LOW,
    run: async (args) => {
      const data = await playerService.get(args.playerId);
      return { summary: `${data.player.name} — ${data.player.games} games.`, ...data };
    },
  },

  /* --- matchday, low risk --------------------------------------------- */

  mark_paid: {
    name: 'mark_paid',
    description: 'Mark one or more players as having paid for a game.',
    parameters: { playerIds: 'string[]', gameId: 'string — defaults to the current game' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const gameId = args.gameId ?? ctx.gameId;
      let game = null;
      for (const playerId of args.playerIds) {
        ({ game } = await matchdayService.setPayment(gameId, playerId, true));
      }
      return { summary: `Marked ${args.playerIds.length} player(s) as paid.`, game };
    },
  },

  mark_unpaid: {
    name: 'mark_unpaid',
    description: 'Reverse a payment mark.',
    parameters: { playerIds: 'string[]', gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const gameId = args.gameId ?? ctx.gameId;
      let game = null;
      for (const playerId of args.playerIds) {
        ({ game } = await matchdayService.setPayment(gameId, playerId, false));
      }
      return { summary: `Marked ${args.playerIds.length} player(s) as unpaid.`, game };
    },
  },

  add_goal: {
    name: 'add_goal',
    description: 'Record goals for a player in a game.',
    parameters: { playerId: 'string', count: 'number, default 1', gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const gameId = args.gameId ?? ctx.gameId;
      const { game: before } = await gameService.get(gameId);
      const entry = before.roster.find((r) => r.playerId === args.playerId);
      const next = (entry?.goals ?? 0) + (args.count ?? 1);
      const { game } = await matchdayService.setPlayerStat(gameId, args.playerId, { goals: next });
      return { summary: `${entry?.name ?? 'Player'} now has ${next} goal(s).`, game };
    },
  },

  add_assist: {
    name: 'add_assist',
    description: 'Record assists for a player in a game.',
    parameters: { playerId: 'string', count: 'number, default 1', gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const gameId = args.gameId ?? ctx.gameId;
      const { game: before } = await gameService.get(gameId);
      const entry = before.roster.find((r) => r.playerId === args.playerId);
      const next = (entry?.assists ?? 0) + (args.count ?? 1);
      const { game } = await matchdayService.setPlayerStat(gameId, args.playerId, { assists: next });
      return { summary: `${entry?.name ?? 'Player'} now has ${next} assist(s).`, game };
    },
  },

  mark_attendance: {
    name: 'mark_attendance',
    description:
      'Record whether players turned up: attended, late, or no_show. Omit playerIds to '
      + 'apply the status to everyone in the game.',
    parameters: {
      playerIds: 'string[] — omit for everyone',
      status: 'attended | late | no_show',
      gameId: 'string',
    },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const gameId = args.gameId ?? ctx.gameId;

      if (!args.playerIds || args.playerIds.length === 0) {
        const { game } = await matchdayService.markAllAttendance(gameId, args.status);
        return { summary: `Everyone marked as ${LABEL[args.status] ?? args.status}.`, game };
      }

      let game = null;
      for (const playerId of args.playerIds) {
        ({ game } = await matchdayService.setPlayerStat(gameId, playerId, {
          attendance: args.status,
        }));
      }
      return {
        summary: `${args.playerIds.length} player(s) marked as ${LABEL[args.status] ?? args.status}.`,
        game,
      };
    },
  },

  set_rating: {
    name: 'set_rating',
    description: "Set a player's rating for this match, on the 0-10 scale.",
    parameters: { playerId: 'string', rating: 'number 0-10', gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const { game } = await matchdayService.setPlayerStat(
        args.gameId ?? ctx.gameId, args.playerId, { rating: args.rating }
      );
      return { summary: `Rating set to ${args.rating}.`, game };
    },
  },

  set_motm: {
    name: 'set_motm',
    description: 'Award Man of the Match.',
    parameters: { playerId: 'string', gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const { game } = await matchdayService.setMotm(args.gameId ?? ctx.gameId, args.playerId);
      return { summary: game.result?.motm ? `${game.result.motm.name} is Man of the Match.` : 'MOTM cleared.', game };
    },
  },

  set_score: {
    name: 'set_score',
    description: 'Set the final score.',
    parameters: { black: 'number', white: 'number', gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const { game } = await matchdayService.setScore(args.gameId ?? ctx.gameId, {
        black: args.black, white: args.white,
      });
      return { summary: `Score set: Black ${args.black} — ${args.white} White.`, game };
    },
  },

  register_player: {
    name: 'register_player',
    description: 'Add a player to a game, or to its waiting list if it is full.',
    parameters: { playerId: 'string', gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const result = await matchdayService.addPlayer(args.gameId ?? ctx.gameId, args.playerId);
      return {
        summary: result.status === 'waitlisted'
          ? 'Game was full — added to the waiting list.'
          : 'Added to the game.',
        game: result.game,
      };
    },
  },

  promote_waitlist: {
    name: 'promote_waitlist',
    description: 'Move the next person off the waiting list into the game.',
    parameters: { playerId: 'string, optional — defaults to the top of the list', gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const { promoted, game } = await matchdayService.promote(
        args.gameId ?? ctx.gameId, args.playerId
      );
      return { summary: `${promoted.name} has been promoted into the game.`, game };
    },
  },

  generate_teams: {
    name: 'generate_teams',
    description: 'Build balanced teams for a full game.',
    parameters: { gameId: 'string' },
    risk: RISK.LOW,
    run: async (args, ctx) => {
      const result = await adminService.generateTeams(args.gameId ?? ctx.gameId, {});
      return {
        summary: `Teams generated from ${result.candidatesEvaluated.toLocaleString('en-GB')} possible splits.`,
        teams: result.teams,
        reload: true,
      };
    },
  },

  /* --- high risk: confirmation required -------------------------------- */

  remove_player: {
    name: 'remove_player',
    description: 'Remove a player from a game.',
    parameters: { playerId: 'string', gameId: 'string' },
    risk: RISK.HIGH,
    confirm: (args, ctx) => ({
      title: 'Remove player?',
      lines: [ctx.playerName ?? args.playerId, ctx.gameLabel].filter(Boolean),
      note: 'Their spot goes to the next person on the waiting list.',
      confirmLabel: 'Remove player',
    }),
    run: async (args, ctx) => {
      const { game } = await matchdayService.removePlayer(args.gameId ?? ctx.gameId, args.playerId);
      return { summary: 'Player removed.', game };
    },
  },

  cancel_game: {
    name: 'cancel_game',
    description: 'Cancel a game. Everyone registered is notified.',
    parameters: { gameId: 'string', reason: 'string — required' },
    risk: RISK.HIGH,
    confirm: (args, ctx) => ({
      title: 'Cancel this game?',
      lines: [ctx.gameLabel, `${ctx.confirmedCount ?? 0} registered players`].filter(Boolean),
      note: args.reason ? `Reason: ${args.reason}` : 'A reason is required.',
      confirmLabel: 'Cancel the game',
      destructive: true,
    }),
    run: async (args, ctx) => {
      const { game } = await matchdayService.setStatus(args.gameId ?? ctx.gameId, 'cancelled', {
        reason: args.reason,
      });
      return { summary: 'Game cancelled. Everyone registered will be notified.', game };
    },
  },

  create_schedule: {
    name: 'create_schedule',
    description: 'Create a recurring weekly fixture.',
    parameters: {
      weekday: 'number 0-6 (0 = Sunday)', time: 'HH:MM', districtId: 'string',
      venueId: 'string', capacity: 'number', price: 'number',
    },
    risk: RISK.HIGH,
    confirm: (args, ctx) => ({
      title: 'Create recurring game?',
      lines: [
        `Every ${ctx.weekdayName ?? 'week'} at ${args.time}`,
        ctx.districtName ?? '',
        ctx.venueName ?? '',
        `${args.capacity ?? 22} players`,
      ].filter(Boolean),
      note: 'Fixtures are generated automatically from this rule.',
      confirmLabel: 'Create schedule',
    }),
    run: async (args) => {
      const { schedule } = await scheduleService.create({
        weekday: args.weekday, time: args.time, districtId: args.districtId,
        venueId: args.venueId, capacity: args.capacity ?? 22,
        teamSize: (args.capacity ?? 22) / 2, price: args.price ?? 10,
      });
      return {
        summary: `Recurring game created: every ${schedule.weekdayName} at ${schedule.time}.`,
        schedule,
      };
    },
  },
};

export const toolList = Object.values(tools);

/**
 * The schema an LLM would receive. Exported so the backend and the mock interpreter
 * cannot drift from what the UI actually implements.
 */
export const toolSchema = toolList.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  risk: tool.risk,
}));
