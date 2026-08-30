// Which game matters right now.
//
// In progress > next upcoming > most recent. An admin at 8:15pm wants tonight's 9pm
// fixture without searching for it, and a player opening "My game" wants the same one.
//
// ITS OWN FILE BECAUSE BOTH APPS NEED IT.
//
// The player's game screen used to import this from pages/Matchday.jsx -- the admin
// workspace -- which put the entire operations console, its assistant, its tactical
// board and its export pipeline into the player's bundle for the sake of one twelve-line
// function. On the phone connections this product is built for, that is the difference
// that matters.

export function pickRelevantGame(games = []) {
  if (games.length === 0) return null;
  const now = Date.now();

  const live = games.find(
    (g) =>
      g.status !== 'cancelled' &&
      new Date(g.kickoffAt).getTime() <= now &&
      new Date(g.kickoffAt).getTime() + (g.durationMinutes ?? 90) * 60_000 > now
  );
  if (live) return live;

  const upcoming = games
    .filter((g) => g.status !== 'cancelled' && new Date(g.kickoffAt).getTime() > now)
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt))[0];
  if (upcoming) return upcoming;

  return [...games].sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt))[0];
}

export default pickRelevantGame;
