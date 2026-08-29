// Recurrence maths.
//
// Lives here rather than in the mock because the create form needs to preview fixtures
// before anything is saved, and a page must never import from src/api/mock — that is
// what dragged the whole 140-player fixture into the production bundle once already.

/**
 * The next `count` occurrences of a weekly slot.
 *
 * @param {number} weekday 0 = Sunday
 * @param {string} timeOfDay "HH:MM"
 * @param {number} count
 * @param {Date} [from]
 * @returns {Date[]}
 */
export function upcomingFrom(weekday, timeOfDay, count = 5, from = new Date()) {
  const [hour, minute] = String(timeOfDay ?? '21:00').split(':').map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return [];

  const dates = [];
  const cursor = new Date(from);
  cursor.setHours(hour, minute, 0, 0);
  // If today's slot has already passed, start looking from tomorrow.
  if (cursor <= from) cursor.setDate(cursor.getDate() + 1);

  // Bounded: a bad weekday must not spin forever.
  for (let guard = 0; guard < 400 && dates.length < count; guard += 1) {
    if (cursor.getDay() === Number(weekday)) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

export const weekdayName = (n) => WEEKDAY_NAMES[n] ?? '';
