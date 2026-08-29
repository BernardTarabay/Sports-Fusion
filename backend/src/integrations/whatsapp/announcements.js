// Generated WhatsApp announcements, for an admin to copy and paste into the existing
// communities.
//
// WHY THIS IS A TEMPLATE FILE AND NOT AN API CALL:
//
// The WhatsApp Business Platform is a 1:1 business-to-customer channel. It cannot post
// into WhatsApp groups or communities. Anything that claims to do so is driving an
// unofficial client against a personal account, which risks the number that Sports
// Fusion's entire operation currently runs on.
//
// So the split is:
//   * group announcements  -> generated here, copied by an admin, pasted by an admin
//   * individual messages  -> sent through the official API (see client.js)
//
// The admin's job goes from composing and maintaining a message to tapping Copy.
//
// Formatting note: WhatsApp uses *bold*, _italic_, ~strike~. No markdown headings, no
// links with display text. Keep lines short; long lines wrap badly on phones.


function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone,
  }).format(date).toUpperCase().replace(/\s/g, ' ');
}

function formatDayDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'short', timeZone,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: get('weekday'), date: `${get('day')} ${get('month')}` };
}

function slotsBar(confirmed, capacity) {
  const filled = Math.round((confirmed / capacity) * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/**
 * @typedef {Object} GameForAnnouncement
 * @property {Date|string} kickoffAt
 * @property {string} districtName
 * @property {string} [venueName]
 * @property {string} [venueMapsUrl]
 * @property {number} capacity
 * @property {number} confirmedCount
 * @property {number} [waitlistCount]
 * @property {number} [arriveByMinutes]
 * @property {number|string} [price]
 * @property {string} [currency]
 * @property {string} publicUrl
 */

const templates = {
  registration_open(game, { timeZone }) {
    const at = new Date(game.kickoffAt);
    const { day, date } = formatDayDate(at, timeZone);
    const lines = [
      `⚽ *${day.toUpperCase()} GAME* — ${game.districtName.toUpperCase()}`,
      '',
      `📅 ${day} ${date}`,
      `🕘 ${formatTime(at, timeZone)}`,
    ];
    if (game.venueName) lines.push(`📍 ${game.venueName}`);
    lines.push(`👥 ${game.capacity} players`);
    if (game.price) lines.push(`💵 ${game.price}${game.currency ? ` ${game.currency}` : ''} per player`);
    lines.push(
      '',
      '*Registration is now open.*',
      'First come, first served — the list is live, so no need to message here.',
      '',
      `👉 ${game.publicUrl}`
    );
    return lines.join('\n');
  },

  filling_up(game, { timeZone }) {
    const at = new Date(game.kickoffAt);
    const { day } = formatDayDate(at, timeZone);
    const left = game.capacity - game.confirmedCount;
    return [
      `⏳ *${day.toUpperCase()} — ${left} SPOT${left === 1 ? '' : 'S'} LEFT*`,
      '',
      `${slotsBar(game.confirmedCount, game.capacity)}  ${game.confirmedCount}/${game.capacity}`,
      '',
      `🕘 ${formatTime(at, timeZone)}${game.venueName ? ` — ${game.venueName}` : ''}`,
      '',
      `👉 ${game.publicUrl}`,
    ].join('\n');
  },

  game_full(game, { timeZone }) {
    const at = new Date(game.kickoffAt);
    const { day } = formatDayDate(at, timeZone);
    const lines = [
      `🔥 *${day.toUpperCase()} IS FULL* — ${game.confirmedCount}/${game.capacity}`,
      '',
      `🕘 ${formatTime(at, timeZone)}${game.venueName ? ` — ${game.venueName}` : ''}`,
      '',
      'Teams will be posted before kickoff.',
    ];
    if ((game.waitlistCount ?? 0) > 0) {
      lines.push(
        '',
        `📋 *Waiting list: ${game.waitlistCount}*`,
        'If someone drops out, the next person on the list gets the spot automatically',
        'and is notified straight away. No need to ask here.'
      );
    }
    lines.push('', `👉 Join the waiting list: ${game.publicUrl}`);
    return lines.join('\n');
  },

  teams(game, { timeZone, teams }) {
    const at = new Date(game.kickoffAt);
    const { day } = formatDayDate(at, timeZone);
    const emoji = { black: '⚫', white: '⚪', red: '🔴', blue: '🔵', yellow: '🟡', green: '🟢' };

    const lines = [
      `⚽ *${day.toUpperCase()} — TEAMS*`,
      `🕘 ${formatTime(at, timeZone)}${game.venueName ? ` — ${game.venueName}` : ''}`,
      '',
    ];

    for (const team of teams) {
      lines.push(`${emoji[team.color] ?? '▪'} *${team.color.toUpperCase()}*`);
      for (const p of team.players) {
        const pos = p.assignedPosition ? `${p.assignedPosition.padEnd(3)} ` : '';
        lines.push(`${pos}${p.name}`);
      }
      lines.push('');
    }

    const arriveBy = new Date(at.getTime() - (game.arriveByMinutes ?? 15) * 60_000);
    lines.push(`⏱ Please arrive by ${formatTime(arriveBy, timeZone)}`);
    if (game.venueMapsUrl) lines.push(`📍 ${game.venueMapsUrl}`);

    return lines.join('\n');
  },

  reminder(game, { timeZone }) {
    const at = new Date(game.kickoffAt);
    const arriveBy = new Date(at.getTime() - (game.arriveByMinutes ?? 15) * 60_000);
    return [
      `⏰ *TONIGHT* — ${formatTime(at, timeZone)}`,
      game.venueName ? `📍 ${game.venueName}` : null,
      `⏱ Arrive by ${formatTime(arriveBy, timeZone)}`,
      '',
      'If you cannot make it, cancel on the app so the next person on the list can play.',
      '',
      `👉 ${game.publicUrl}`,
    ].filter(Boolean).join('\n');
  },

  result(game, { timeZone, result }) {
    const at = new Date(game.kickoffAt);
    const { day } = formatDayDate(at, timeZone);
    const lines = [
      `📊 *${day.toUpperCase()} RESULT*`,
      '',
      `*${result.teamAName.toUpperCase()} ${result.teamAScore} — ${result.teamBScore} ${result.teamBName.toUpperCase()}*`,
    ];
    if (result.motm) {
      lines.push('', `🏆 *Man of the Match*`, result.motm);
    }
    lines.push('', `Full stats: ${game.publicUrl}`);
    return lines.join('\n');
  },

  cancelled(game, { timeZone, reason }) {
    const at = new Date(game.kickoffAt);
    const { day } = formatDayDate(at, timeZone);
    return [
      `❌ *${day.toUpperCase()} GAME CANCELLED*`,
      `🕘 ${formatTime(at, timeZone)}${game.venueName ? ` — ${game.venueName}` : ''}`,
      '',
      reason ? reason : 'Sorry for the short notice.',
      '',
      'Everyone registered has been notified individually.',
    ].join('\n');
  },
};

export const ANNOUNCEMENT_KINDS = Object.keys(templates);

/**
 * @param {string} kind  one of ANNOUNCEMENT_KINDS
 * @param {GameForAnnouncement} game
 * @param {Object} [extra]  { timeZone, teams, result, reason }
 */
export function generateAnnouncement(kind, game, extra = {}) {
  const template = templates[kind];
  if (!template) {
    throw new Error(`Unknown announcement kind: ${kind}. Expected one of ${ANNOUNCEMENT_KINDS.join(', ')}`);
  }
  return template(game, { timeZone: 'Asia/Beirut', ...extra });
}

export default generateAnnouncement;
