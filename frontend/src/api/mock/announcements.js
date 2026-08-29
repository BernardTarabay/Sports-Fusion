// WhatsApp announcement composer (mock).
//
// Mirrors the backend's integrations/whatsapp/announcements.js. It exists on the
// frontend too because the admin needs to SEE the message before copying it, and the
// copy button is the entire bridge to the existing communities -- the Business Platform
// cannot post into a group, so a human pastes it.

import { gamesById } from './data.js';
import { time, dayAndDate, dayName } from '../../lib/format.js';

const EMOJI = { black: '⚫', white: '⚪', red: '🔴', blue: '🔵' };

function slotsBar(confirmed, capacity) {
  const filled = Math.round((confirmed / capacity) * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

const publicUrl = (game) => `${window.location.origin}/g/${game.slug}`;

const builders = {
  registration_open(game) {
    const lines = [
      `⚽ *${dayName(game.kickoffAt).toUpperCase()} GAME* — ${game.districtName.toUpperCase()}`,
      '',
      `📅 ${dayAndDate(game.kickoffAt)}`,
      `🕘 ${time(game.kickoffAt)}`,
    ];
    if (game.venue) lines.push(`📍 ${game.venue.name}`);
    lines.push(`👥 ${game.capacity} players`);
    if (game.price) lines.push(`💵 ${game.price} ${game.currency} per player`);
    lines.push(
      '',
      '*Registration is now open.*',
      'First come, first served — the list is live, so no need to message here.',
      '',
      `👉 ${publicUrl(game)}`
    );
    return lines.join('\n');
  },

  filling_up(game) {
    const left = game.capacity - game.confirmedCount;
    return [
      `⏳ *${dayName(game.kickoffAt).toUpperCase()} — ${left} SPOT${left === 1 ? '' : 'S'} LEFT*`,
      '',
      `${slotsBar(game.confirmedCount, game.capacity)}  ${game.confirmedCount}/${game.capacity}`,
      '',
      `🕘 ${time(game.kickoffAt)}${game.venue ? ` — ${game.venue.name}` : ''}`,
      '',
      `👉 ${publicUrl(game)}`,
    ].join('\n');
  },

  game_full(game) {
    const lines = [
      `🔥 *${dayName(game.kickoffAt).toUpperCase()} IS FULL* — ${game.confirmedCount}/${game.capacity}`,
      '',
      `🕘 ${time(game.kickoffAt)}${game.venue ? ` — ${game.venue.name}` : ''}`,
      '',
      'Teams will be posted before kickoff.',
    ];
    if (game.waitlistCount > 0) {
      lines.push(
        '',
        `📋 *Waiting list: ${game.waitlistCount}*`,
        'If someone drops out, the next person on the list gets the spot automatically',
        'and is notified straight away. No need to ask here.'
      );
    }
    lines.push('', `👉 Join the waiting list: ${publicUrl(game)}`);
    return lines.join('\n');
  },

  teams(game) {
    const lines = [
      `⚽ *${dayName(game.kickoffAt).toUpperCase()} — TEAMS*`,
      `🕘 ${time(game.kickoffAt)}${game.venue ? ` — ${game.venue.name}` : ''}`,
      '',
    ];
    for (const team of game.teams) {
      lines.push(`${EMOJI[team.color] ?? '▪'} *${team.color.toUpperCase()}*`);
      for (const p of team.players) {
        lines.push(`${(p.position ?? '').padEnd(3)} ${p.name}`);
      }
      lines.push('');
    }
    const arriveBy = new Date(new Date(game.kickoffAt).getTime() - (game.arriveByMinutes ?? 15) * 60000);
    lines.push(`⏱ Please arrive by ${time(arriveBy)}`);
    return lines.join('\n');
  },

  reminder(game) {
    const arriveBy = new Date(new Date(game.kickoffAt).getTime() - (game.arriveByMinutes ?? 15) * 60000);
    return [
      `⏰ *TONIGHT* — ${time(game.kickoffAt)}`,
      game.venue ? `📍 ${game.venue.name}` : null,
      `⏱ Arrive by ${time(arriveBy)}`,
      '',
      'If you cannot make it, cancel on the app so the next person on the list can play.',
      '',
      `👉 ${publicUrl(game)}`,
    ].filter(Boolean).join('\n');
  },

  result(game) {
    if (!game.result) return 'No result recorded yet.';
    const lines = [
      `📊 *${dayName(game.kickoffAt).toUpperCase()} RESULT*`,
      '',
      `*BLACK ${game.result.score.black} — ${game.result.score.white} WHITE*`,
    ];
    if (game.result.motm) lines.push('', '🏆 *Man of the Match*', game.result.motm.name);
    lines.push('', `Full stats: ${publicUrl(game)}`);
    return lines.join('\n');
  },
};

export function buildAnnouncement(gameId, kind) {
  const game = gamesById[gameId];
  if (!game) return { kind, body: '' };
  const builder = builders[kind] ?? builders.registration_open;
  return { kind, body: builder(game) };
}
