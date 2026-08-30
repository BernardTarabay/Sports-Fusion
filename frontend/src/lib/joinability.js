// Can this game still be joined, and if not, what should the button say instead?
//
// WHY THIS IS ONE FUNCTION
//
// Three places offer a JOIN button -- the fixture card, the game page, the hero on the
// landing page -- and each decided for itself. They agreed on "is it full" and on
// nothing else, so a match that had already kicked off still showed "Join waiting list"
// in the list and on the front page. Tapping it took the player to the game page and,
// eventually, to a 409 GAME_STARTED: an action offered in a bold green button that could
// only ever fail.
//
// The server's rule lives in registrations/service.js#assertRegistrationOpen. This is the
// same rule, in the same order, expressed for the UI. It is NOT a security control --
// the server refuses regardless -- it is the difference between an app that tells you
// where you stand and one that lets you find out by being rejected.

/**
 * @returns {{ canJoin: boolean, label: string, reason: string|null, waitlistOnly: boolean }}
 */
export function joinability(game) {
  const no = (reason, label) => ({ canJoin: false, label, reason, waitlistOnly: false });
  if (!game) return no('unknown', 'Unavailable');

  const now = Date.now();
  const kickoff = new Date(game.kickoffAt).getTime();

  if (game.status === 'cancelled') return no('cancelled', 'Cancelled');
  if (game.status === 'completed') return no('completed', 'Played');
  if (game.status === 'in_progress') return no('in_progress', 'Kicked off');
  // A draft has not been announced. Its admin can see it in the list; nobody can join it.
  if (game.status === 'draft') return no('not_open', 'Not open yet');

  if (game.registrationOpensAt && now < new Date(game.registrationOpensAt).getTime()) {
    return no('not_open', 'Not open yet');
  }
  if (game.registrationClosesAt && now > new Date(game.registrationClosesAt).getTime()) {
    return no('closed', 'Registration closed');
  }
  // Kickoff last, because a game can be closed for other reasons first and the more
  // specific message is the more useful one.
  if (kickoff < now) return no('started', 'Kicked off');

  const full = (game.confirmedCount ?? 0) >= game.capacity;
  if (!full) return { canJoin: true, label: 'Join game', reason: null, waitlistOnly: false };

  const waitlistCapacity = game.waitlistCapacity ?? 0;
  // waitlistCapacity is not in every projection. When it is absent, offering the waiting
  // list is the right guess: the server will say if it is full, and the alternative is
  // refusing a player a place they could have had.
  if (waitlistCapacity > 0 && (game.waitlistCount ?? 0) >= waitlistCapacity) {
    return no('waitlist_full', 'Waiting list full');
  }
  return { canJoin: true, label: 'Join waiting list', reason: null, waitlistOnly: true };
}

export default joinability;
