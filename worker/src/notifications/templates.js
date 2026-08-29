// 1:1 notification templates.
//
// Distinct from integrations/whatsapp/announcements.js, which generates the GROUP message
// an admin copies and pastes. These are messages sent to one player through the official
// API, and they are constrained by it:
//
//   * Outside the 24-hour customer service window, WhatsApp only permits a PRE-APPROVED
//     template, identified by name, with positional variables. You cannot invent copy at
//     send time. `whatsappTemplate` below records the approved name and the variable
//     order for each message.
//   * `body` is the human-readable rendering, used for in-app and push, and for the
//     development logger so the copy can be reviewed before it is submitted to Meta.
//
// If a template name here does not exist in the WhatsApp Business Manager, the send will
// be rejected by the API. Keep the two in step.

const TZ = 'Asia/Beirut';

const time = (d) => new Intl.DateTimeFormat('en-GB', {
  hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ,
}).format(new Date(d)).toUpperCase();

const dayDate = (d) => new Intl.DateTimeFormat('en-GB', {
  weekday: 'long', day: 'numeric', month: 'short', timeZone: TZ,
}).format(new Date(d));

const where = (p) => (p.venueName ? ` at ${p.venueName}` : '');

const templates = {
  registration_confirmed: (p) => ({
    title: "You're in",
    body:
      `You're registered for ${dayDate(p.kickoffAt)} at ${time(p.kickoffAt)}${where(p)}.\n` +
      `${p.confirmedCount}/${p.capacity} players so far.\n\n` +
      `Can't make it? Cancel in the app so someone on the waiting list can play.`,
    whatsappTemplate: {
      name: 'registration_confirmed',
      variables: [dayDate(p.kickoffAt), time(p.kickoffAt), p.venueName ?? p.districtName],
    },
  }),

  waitlist_joined: (p) => ({
    title: `Waiting list — number ${p.waitlistPosition}`,
    body:
      `The ${dayDate(p.kickoffAt)} game is full, so you're number ${p.waitlistPosition} ` +
      `on the waiting list.\n\n` +
      `If someone drops out you'll get the spot automatically and we'll message you. ` +
      `You don't need to ask.`,
    whatsappTemplate: {
      name: 'waitlist_joined',
      variables: [dayDate(p.kickoffAt), String(p.waitlistPosition)],
    },
  }),

  // The message that justifies the whole system.
  waitlist_promoted: (p) => ({
    title: "You're in",
    body:
      `A spot opened up — you're playing ${dayDate(p.kickoffAt)} at ${time(p.kickoffAt)}${where(p)}.\n\n` +
      `Please arrive by ${time(new Date(new Date(p.kickoffAt).getTime() - (p.arriveByMinutes ?? 15) * 60000))}.`,
    whatsappTemplate: {
      name: 'waitlist_promoted',
      variables: [dayDate(p.kickoffAt), time(p.kickoffAt), p.venueName ?? p.districtName],
    },
  }),

  teams_announced: (p) => ({
    title: `You're on ${String(p.teamColor ?? '').toUpperCase()}`,
    body:
      `Teams are out for ${dayDate(p.kickoffAt)}.\n\n` +
      `You're on ${String(p.teamColor ?? '').toUpperCase()}` +
      `${p.position ? ` at ${p.position}` : ''}.\n` +
      `Kickoff ${time(p.kickoffAt)}${where(p)}.`,
    whatsappTemplate: {
      name: 'teams_announced',
      variables: [dayDate(p.kickoffAt), String(p.teamColor ?? '').toUpperCase(), time(p.kickoffAt)],
    },
  }),

  game_reminder_24h: (p) => ({
    title: 'Game tomorrow',
    body:
      `You're playing tomorrow, ${dayDate(p.kickoffAt)} at ${time(p.kickoffAt)}${where(p)}.\n\n` +
      `If you can't make it, cancel now so someone on the waiting list gets your spot.`,
    whatsappTemplate: {
      name: 'game_reminder_24h',
      variables: [dayDate(p.kickoffAt), time(p.kickoffAt), p.venueName ?? p.districtName],
    },
  }),

  game_reminder_3h: (p) => ({
    title: `Kickoff at ${time(p.kickoffAt)}`,
    body:
      `Your game is at ${time(p.kickoffAt)} today${where(p)}.\n` +
      `Please arrive by ${time(new Date(new Date(p.kickoffAt).getTime() - (p.arriveByMinutes ?? 15) * 60000))}.` +
      (p.venueMapsUrl ? `\n\n${p.venueMapsUrl}` : ''),
    whatsappTemplate: {
      name: 'game_reminder_3h',
      variables: [time(p.kickoffAt), p.venueName ?? p.districtName],
    },
  }),

  game_cancelled: (p) => ({
    title: 'Game cancelled',
    body:
      `The ${dayDate(p.kickoffAt)} game at ${time(p.kickoffAt)}${where(p)} has been cancelled.\n\n` +
      `${p.reason ? p.reason : 'Sorry for the short notice.'}`,
    whatsappTemplate: {
      name: 'game_cancelled',
      variables: [dayDate(p.kickoffAt), time(p.kickoffAt), p.reason ?? 'No reason given'],
    },
  }),

  // Fires once per game. A second correction does not re-notify, because
  // notifications_dedupe_idx keys on (user, channel, template, game) -- telling everyone
  // three times that the score moved is worse than telling them once.
  result_corrected: (p) => ({
    title: 'Result updated',
    body:
      `The result for ${dayDate(p.kickoffAt)} has been corrected.\n\n` +
      `${p.reason ? p.reason : 'See your profile for the updated stats.'}`,
    whatsappTemplate: {
      name: 'result_corrected',
      variables: [dayDate(p.kickoffAt), p.reason ?? 'Corrected'],
    },
  }),

  reward_redeemed: (p) => ({
    title: 'Reward on the way',
    body:
      `You redeemed ${p.rewardName} for ${p.pointsSpent} points.\n\n` +
      `Your code will appear in the app as soon as it is ready.`,
    whatsappTemplate: {
      name: 'reward_redeemed',
      variables: [p.rewardName ?? 'your reward', String(p.pointsSpent ?? '')],
    },
  }),

  result_published: (p) => ({
    title: 'Result is up',
    body: `The result and stats for ${dayDate(p.kickoffAt)} are now on your profile.`,
    whatsappTemplate: {
      name: 'result_published',
      variables: [dayDate(p.kickoffAt)],
    },
  }),
};

export const TEMPLATE_KEYS = Object.keys(templates);

export function render(templateKey, payload) {
  const template = templates[templateKey];
  if (!template) throw new Error(`Unknown notification template: ${templateKey}`);
  return template(payload ?? {});
}

export default render;
