// Intent interpretation.
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// In production this file does not exist. The admin's message goes to the backend, which
// calls Gemini with `toolSchema` and the current game context, and the model returns a
// tool call. The frontend's job is to render the conversation, ask for confirmation on
// high-risk tools, and execute — none of which needs a model.
//
// This is a deterministic stand-in so the whole loop is demonstrable without an API key.
// It resolves the same tool names with the same argument shapes, so swapping in the real
// model changes one function and nothing else.
//
// It is deliberately narrow: it matches phrasings an admin actually uses at a pitch and
// says "I did not understand" otherwise. A fuzzy parser that guesses wrong on
// "cancel the game" is far worse than one that admits it is stuck.

import { tools } from './tools.js';

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10,
};

const toNumber = (token) => {
  if (token == null) return null;
  const n = Number(token);
  if (!Number.isNaN(n)) return n;
  return NUMBER_WORDS[String(token).toLowerCase()] ?? null;
};

/**
 * Find players named in free text.
 *
 * Specificity matters more than recall here. "Nabil Douaihy" must not also select
 * Antoine Douaihy — over-matching on a payment or a removal is a real mistake, and the
 * admin has no way to see which interpretation was used. So: if any full name matches,
 * only full-name matches count. Loose first/surname matching is the fallback for when
 * nobody wrote a full name.
 */
function matchPlayers(text, roster = []) {
  const lower = text.toLowerCase();

  const byFullName = roster.filter((entry) => lower.includes(entry.name.toLowerCase()));
  if (byFullName.length > 0) return byFullName;

  return roster.filter((entry) => {
    const full = entry.name.toLowerCase();
    const [first, ...rest] = full.split(' ');
    const surname = rest.at(-1) ?? '';
    return (
      new RegExp(`\\b${escapeRegex(first)}\\b`).test(lower) ||
      (surname.length > 3 && new RegExp(`\\b${escapeRegex(surname)}\\b`).test(lower))
    );
  });
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn a message into a tool call.
 *
 * @returns {{tool: string, args: object, rationale: string} | {error: string}}
 */
export function interpret(message, context = {}) {
  const text = message.trim();
  // Phones insert typographic punctuation by default, so "hasn’t" arrives with U+2019
  // and never matches a pattern written with a straight apostrophe. Normalising here
  // rather than in every pattern is the difference between the assistant understanding
  // an admin and confidently doing the wrong thing.
  const lower = text
    .toLowerCase()
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[–—]/g, '-');
  const roster = context.game?.roster ?? [];

  /* --- questions ------------------------------------------------------ */

  if (/\b(who|which|how many)\b.*\b(not paid|unpaid|hasn'?t paid|haven'?t paid|owes?)\b/.test(lower)
      || /\bunpaid\b/.test(lower)) {
    return { tool: 'get_unpaid', args: {}, rationale: 'Listing unpaid players for this game.' };
  }

  if (/\b(best|top|leading)\b.*\b(player|scorer|rating)\b/.test(lower)
      || /\bleaderboard\b|\brankings?\b/.test(lower)) {
    const metric = /\bscorer|goals?\b/.test(lower) ? 'goals'
      : /\bassists?\b/.test(lower) ? 'assists'
        : /\bform\b/.test(lower) ? 'form' : 'rating';
    const district = (context.districts ?? []).find((d) => lower.includes(d.name.toLowerCase()));
    return {
      tool: 'get_leaderboard',
      args: { metric, districtId: district?.id },
      rationale: `Top players by ${metric}${district ? ` in ${district.name}` : ''}.`,
    };
  }

  if (/\b(summary|summarise|summarize|how did|what happened|report)\b/.test(lower)) {
    return { tool: 'get_game', args: {}, rationale: 'Summarising this game.' };
  }

  /* --- score ---------------------------------------------------------- */

  const scoreMatch = lower.match(/\b(black|white)\s*(?:won|win)?\s*(\d+)\s*[-–—to]+\s*(\d+)/);
  if (scoreMatch) {
    const [, side, a, b] = scoreMatch;
    const high = Number(a);
    const low = Number(b);
    return {
      tool: 'set_score',
      args: side === 'black' ? { black: high, white: low } : { black: low, white: high },
      rationale: `Setting the score to ${side === 'black' ? `${high}—${low}` : `${low}—${high}`}.`,
    };
  }

  const plainScore = lower.match(/\b(?:score|final)\b[^0-9]*(\d+)\s*[-–—to]+\s*(\d+)/);
  if (plainScore) {
    return {
      tool: 'set_score',
      args: { black: Number(plainScore[1]), white: Number(plainScore[2]) },
      rationale: 'Setting the score (black first).',
    };
  }

  /* --- payments ------------------------------------------------------- */

  if (/\b(paid|pay|payment)\b/.test(lower) && !/\bnot paid|unpaid|hasn'?t\b/.test(lower)) {
    // "mark everyone as paid except Karim and Tony"
    if (/\b(everyone|all|everybody)\b/.test(lower)) {
      const exceptPart = lower.split(/\bexcept\b|\bapart from\b|\bbut\b/)[1];
      const excluded = exceptPart ? matchPlayers(exceptPart, roster) : [];
      const excludedIds = new Set(excluded.map((e) => e.playerId));
      const targets = roster.filter((r) => !excludedIds.has(r.playerId));
      if (targets.length === 0) return { error: 'Nobody in this game to mark.' };
      return {
        tool: 'mark_paid',
        args: { playerIds: targets.map((t) => t.playerId) },
        rationale: excluded.length
          ? `Marking everyone paid except ${excluded.map((e) => e.name).join(' and ')}.`
          : 'Marking everyone in this game as paid.',
      };
    }

    const named = matchPlayers(lower, roster);
    if (named.length > 0) {
      return {
        tool: 'mark_paid',
        args: { playerIds: named.map((n) => n.playerId) },
        rationale: `Marking ${named.map((n) => n.name).join(', ')} as paid.`,
      };
    }
    return { error: 'I could not tell who to mark as paid. Try naming the player.' };
  }

  /* --- attendance ------------------------------------------------------ */

  // Checked before goals, because "Karim didn't turn up" contains no goal words but
  // "showed up" would otherwise fall through to the roster branch.
  if (/\b(turn(ed)? up|show(ed)? up|no.?show|didn't come|did not come|absent|missed it|was late|turned up late)\b/.test(lower)) {
    const negated = /\b(didn'?t|did not|no.?show|absent|missed)\b/.test(lower);
    const late = /\blate\b/.test(lower);
    const status = late ? 'late' : negated ? 'no_show' : 'attended';

    if (/\b(everyone|all|everybody|the whole team)\b/.test(lower)) {
      return {
        tool: 'mark_attendance',
        args: { status },
        rationale: `Marking everyone as ${status === 'no_show' ? 'a no-show' : status}.`,
      };
    }

    const named = matchPlayers(lower, roster);
    if (named.length === 0) {
      return { error: 'Who should I mark? Name the player and I will record it.' };
    }
    return {
      tool: 'mark_attendance',
      args: { playerIds: named.map((n) => n.playerId), status },
      rationale: `Marking ${named.map((n) => n.name).join(', ')} as ${
        status === 'no_show' ? 'a no-show' : status
      }.`,
    };
  }

  /* --- goals and assists ---------------------------------------------- */

  const statMatch = lower.match(/\b(?:scored|got|had|add)\b\s*(\w+)?\s*(goals?|assists?)/);
  if (statMatch) {
    const named = matchPlayers(lower, roster);
    if (named.length === 0) {
      return { error: 'Which player? Name them and I will record it.' };
    }
    const count = toNumber(statMatch[1]) ?? 1;
    const isGoal = statMatch[2].startsWith('goal');

    // "George scored two goals and had one assist" is two tools; the UI runs a chain.
    const assistPart = lower.match(/(\w+)\s+assists?/);
    const chain = [{
      tool: isGoal ? 'add_goal' : 'add_assist',
      args: { playerId: named[0].playerId, count },
    }];
    if (isGoal && assistPart) {
      const assistCount = toNumber(assistPart[1]);
      if (assistCount) {
        chain.push({ tool: 'add_assist', args: { playerId: named[0].playerId, count: assistCount } });
      }
    }

    return {
      chain,
      tool: chain[0].tool,
      args: chain[0].args,
      rationale: `Recording for ${named[0].name}.`,
    };
  }

  /* --- man of the match ----------------------------------------------- */

  if (/\b(motm|man of the match|player of the match)\b/.test(lower)) {
    const named = matchPlayers(lower, roster);
    if (named.length === 0) return { error: 'Who should get Man of the Match?' };
    return {
      tool: 'set_motm',
      args: { playerId: named[0].playerId },
      rationale: `Awarding Man of the Match to ${named[0].name}.`,
    };
  }

  /* --- rating --------------------------------------------------------- */

  const ratingMatch = lower.match(/\brat(?:e|ing)\b[^0-9]*(\d+(?:\.\d+)?)/);
  if (ratingMatch) {
    const named = matchPlayers(lower, roster);
    if (named.length === 0) return { error: 'Which player should I rate?' };
    return {
      tool: 'set_rating',
      args: { playerId: named[0].playerId, rating: Number(ratingMatch[1]) },
      rationale: `Rating ${named[0].name} ${ratingMatch[1]}.`,
    };
  }

  /* --- roster --------------------------------------------------------- */

  if (/\b(add|register|put)\b/.test(lower) && !/\bschedule|recurring|every\b/.test(lower)) {
    const named = matchPlayers(lower, context.allPlayers ?? []);
    if (named.length === 0) return { error: 'Which player should I add?' };
    return {
      tool: 'register_player',
      args: { playerId: named[0].id ?? named[0].playerId },
      rationale: `Adding ${named[0].name} to this game.`,
    };
  }

  if (/\b(remove|drop|take out|kick)\b/.test(lower)) {
    const named = matchPlayers(lower, roster);
    if (named.length === 0) return { error: 'Which player should I remove?' };
    return {
      tool: 'remove_player',
      args: { playerId: named[0].playerId },
      context: { playerName: named[0].name },
      rationale: `Removing ${named[0].name}.`,
    };
  }

  if (/\bpromote\b|\bnext (?:person|player) (?:off|from) the (?:waiting )?list\b/.test(lower)) {
    return { tool: 'promote_waitlist', args: {}, rationale: 'Promoting from the waiting list.' };
  }

  /* --- teams ---------------------------------------------------------- */

  if (/\b(generate|build|make|create)\b.*\bteams?\b/.test(lower)
      || /\bbalance(d)? teams?\b/.test(lower)) {
    return { tool: 'generate_teams', args: {}, rationale: 'Building balanced teams.' };
  }

  /* --- cancellation --------------------------------------------------- */

  if (/\bcancel\b/.test(lower) && /\bgame|match|fixture\b/.test(lower)) {
    const reason =
      /\bweather|rain|storm|flood/.test(lower) ? 'Weather'
        : /\bvenue|pitch|ground/.test(lower) ? 'Venue unavailable'
          : /\bnot enough|short|insufficient|numbers/.test(lower) ? 'Not enough players'
            : null;
    return {
      tool: 'cancel_game',
      args: { reason: reason ?? 'Administrative cancellation' },
      rationale: 'This affects everyone registered, so it needs confirming.',
    };
  }

  /* --- recurring schedule --------------------------------------------- */

  if (/\bevery\b/.test(lower) && /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.test(lower)) {
    const weekdayWord = Object.keys(WEEKDAYS).find((d) => lower.includes(d));
    const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    let hour = timeMatch ? Number(timeMatch[1]) : 21;
    const minute = timeMatch?.[2] ?? '00';
    if (timeMatch?.[3] === 'pm' && hour < 12) hour += 12;
    if (timeMatch?.[3] === 'am' && hour === 12) hour = 0;

    const district = (context.districts ?? []).find((d) => lower.includes(d.name.toLowerCase()));
    const venue = (context.venues ?? []).find((v) => lower.includes(v.name.toLowerCase()));
    const capacity = toNumber(lower.match(/(\d+)\s*players?/)?.[1]) ?? 22;

    if (!district) {
      return { error: 'Which district? I need that to create a recurring game.' };
    }

    return {
      tool: 'create_schedule',
      args: {
        weekday: WEEKDAYS[weekdayWord],
        time: `${String(hour).padStart(2, '0')}:${minute}`,
        districtId: district.id,
        venueId: venue?.id ?? (context.venues ?? []).find((v) => v.districtId === district.id)?.id,
        capacity,
      },
      context: {
        weekdayName: weekdayWord?.replace(/^./, (c) => c.toUpperCase()),
        districtName: district.name,
        venueName: venue?.name,
      },
      rationale: 'Setting up a recurring fixture.',
    };
  }

  return {
    error:
      "I did not follow that. Try things like: \"mark everyone paid except Karim\", " +
      '"George scored two goals", "Black won 6-4", "generate teams", or ' +
      '"who hasn\'t paid?".',
  };
}

/** Look up a tool by the name an interpretation returned. */
export const resolveTool = (name) => tools[name] ?? null;
