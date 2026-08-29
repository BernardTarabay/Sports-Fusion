// Formatting helpers.
//
// Built on native Intl rather than a date library. Everything this app needs is a
// handful of formats in one timezone; date-fns would be ~15KB gzipped to save about
// forty lines, and Intl handles Arabic and French correctly for free when the app is
// localised later.

export const TZ = 'Asia/Beirut';

const fmt = (options) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...options });

const timeFmt = fmt({ hour: 'numeric', minute: '2-digit', hour12: true });
const dayFmt = fmt({ weekday: 'long' });
const shortDayFmt = fmt({ weekday: 'short' });
const dayNumFmt = fmt({ day: 'numeric' });
const monthFmt = fmt({ month: 'short' });
const fullDateFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long' });

export const time = (d) => timeFmt.format(new Date(d)).toUpperCase();
export const dayName = (d) => dayFmt.format(new Date(d));
export const shortDay = (d) => shortDayFmt.format(new Date(d)).toUpperCase();
export const dayNumber = (d) => dayNumFmt.format(new Date(d));
export const monthName = (d) => monthFmt.format(new Date(d)).toUpperCase();
export const fullDate = (d) => fullDateFmt.format(new Date(d));

/** "Friday 29 Aug" */
export const dayAndDate = (d) => `${dayName(d)} ${dayNumber(d)} ${monthName(d)}`;

/** Calendar-day difference, so "tomorrow" means tomorrow rather than 24 hours. */
function dayDelta(date, from = new Date()) {
  const a = new Date(date);
  const b = new Date(from);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((a - b) / 86_400_000);
}

/** "Tonight", "Tomorrow", "Friday", "29 Aug" */
export function relativeDay(d, from = new Date()) {
  const delta = dayDelta(d, from);
  if (delta === 0) return 'Tonight';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';
  if (delta > 1 && delta < 7) return dayName(d);
  if (delta < -1 && delta > -7) return `Last ${dayName(d)}`;
  return `${dayNumber(d)} ${monthName(d)}`;
}

/** "in 3 days", "2 hours ago" -- for timestamps rather than fixtures. */
const relFmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function relativeTime(d, from = new Date()) {
  const diff = new Date(d) - new Date(from);
  const abs = Math.abs(diff);
  const units = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return relFmt.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

/** Countdown parts for a matchday clock. */
export function countdownParts(target, now = Date.now()) {
  const diff = Math.max(0, new Date(target).getTime() - now);
  return {
    total: diff,
    days: Math.floor(diff / 86_400_000),
    hours: Math.floor((diff % 86_400_000) / 3_600_000),
    minutes: Math.floor((diff % 3_600_000) / 60_000),
    seconds: Math.floor((diff % 60_000) / 1000),
    expired: diff === 0,
  };
}

export const pad = (n) => String(n).padStart(2, '0');

/**
 * Compact numbers: 1,248 stays readable, 12,400 becomes 12.4k.
 * Used on stat tiles where a long number would break the layout on a 320px phone.
 */
export function compact(n) {
  if (n == null) return '—';
  if (Math.abs(n) < 10_000) return n.toLocaleString('en-GB');
  return new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export const percent = (n, digits = 0) =>
  n == null ? '—' : `${(n * 100).toFixed(digits)}%`;

export const money = (amount, currency = 'USD') =>
  amount == null
    ? '—'
    : new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);

/**
 * Convert an internal Glicko rating to the 0-10 scale players actually understand.
 *
 * Nobody wants to be told they are 1,547 with a deviation of 62. The mapping centres
 * 1500 on 6.5 and gives roughly one point per 150 rating, which keeps the interesting
 * range of a community league inside 5.0-9.5.
 */
export function toPlayerRating(mu) {
  if (mu == null) return null;
  const scaled = 6.5 + (mu - 1500) / 150;
  return Math.max(1, Math.min(10, Math.round(scaled * 10) / 10));
}

/** Whether the system knows a player well enough to state their rating as fact. */
export const isProvisional = (sigma) => (sigma ?? 350) > 150;

/** Initials for an avatar fallback, handling "Jean-Pierre" and "Abou Khalil". */
export function initials(name = '') {
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
