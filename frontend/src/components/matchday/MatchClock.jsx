// The match clock.
//
// The server stores when each period began; this works out the rest. Nothing counts the
// seconds anywhere — a counter would drift on reload, double-count with two tabs open,
// and be wrong for anyone who joined late. Two phones watching the same match agree
// because they are reading the same three timestamps.
//
// The interval here only decides how often the screen is repainted. If the browser
// throttles it to once a minute in a background tab, the next repaint is still correct,
// because the value is computed from the clock rather than accumulated.

import { useState, useEffect, useMemo } from 'react';
import { Play, Pause, FastForward, Square, Timer } from 'lucide-react';
import { Button, Badge } from '../ui/index.jsx';
import { cn } from '../../lib/cn.js';

const RUNNING = ['first_half', 'second_half'];

/** mm:ss, monospaced-friendly and never negative. */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Play time in milliseconds, from the same three timestamps the server used.
 *
 * `skew` corrects for a phone whose own clock is wrong. Without it, a device five minutes
 * fast shows a match that kicked off in the future, and the clock reads 00:00 for five
 * minutes before it starts moving.
 */
export function elapsedFrom(clock, skew = 0) {
  if (!clock || clock.state === 'not_started') return 0;
  const banked = clock.elapsedMsAtPeriodStart ?? 0;
  if (!RUNNING.includes(clock.state)) return banked;

  const now = Date.now() + skew;
  const since = now - new Date(clock.periodStartedAt).getTime();
  const paused = (clock.pausedMs ?? 0)
    + (clock.pausedAt ? now - new Date(clock.pausedAt).getTime() : 0);
  return Math.max(banked, banked + since - paused);
}

/** How long is left of the interval, when the players are standing around. */
function halftimeRemaining(clock, skew = 0) {
  if (!clock?.periodStartedAt) return 0;
  const elapsed = (Date.now() + skew) - new Date(clock.periodStartedAt).getTime();
  return Math.max(0, (clock.halftimeMinutes ?? 15) * 60_000 - elapsed);
}

const LABEL = {
  not_started: 'Not started',
  first_half: 'First half',
  halftime: 'Half time',
  second_half: 'Second half',
  finished: 'Full time',
  abandoned: 'Abandoned',
};

/**
 * @param {object} clock  game.clock from the matchday projection
 * @param {(action: string) => Promise<void>} onAction
 * @param {boolean} canControl  admin, and the game is theirs to run
 */
export function MatchClock({ clock, onAction, canControl = false, busy = false, className }) {
  const [, setTick] = useState(0);

  // One measurement, at the moment the data arrived. Re-deriving it every render would
  // make the offset jitter with every repaint.
  const skew = useMemo(
    () => (clock?.serverNow ? new Date(clock.serverNow).getTime() - Date.now() : 0),
    [clock?.serverNow]
  );

  const state = clock?.state ?? 'not_started';
  const live = RUNNING.includes(state) && !clock?.pausedAt;
  const isHalftime = state === 'halftime';

  useEffect(() => {
    if (!live && !isHalftime) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live, isHalftime]);

  const elapsed = elapsedFrom(clock, skew);
  const minutes = Math.floor(elapsed / 60_000);
  const full = clock?.durationMinutes ?? 90;
  // Football counts past the scheduled end rather than stopping, so a match that runs
  // over reads 92:14 rather than freezing at 90:00.
  const overtime = minutes >= full && RUNNING.includes(state);

  const act = (action) => () => onAction?.(action);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[var(--radius-lg)] border p-4',
        live
          ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)]'
          : 'border-[var(--border-subtle)] bg-[var(--surface-2)]',
        className
      )}
      // Announced as a group rather than a live region: a screen reader reciting the
      // seconds is unusable. The period changes are what matter, and those are polite.
      role="group"
      aria-label="Match clock"
    >
      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            'display text-4xl tabular-nums leading-none sm:text-5xl',
            overtime && 'text-[var(--trophy)]',
            state === 'finished' && 'text-[var(--fg-secondary)]'
          )}
        >
          {formatClock(elapsed)}
        </span>

        <div className="flex flex-col gap-1">
          <Badge tone={live ? 'accent' : 'neutral'} size="sm" aria-live="polite">
            {LABEL[state]}
            {clock?.pausedAt ? ' · stopped' : ''}
          </Badge>
          {isHalftime && (
            <span className="text-xs tabular-nums text-[var(--fg-secondary)]">
              {formatClock(halftimeRemaining(clock, skew))} until kickoff
            </span>
          )}
          {overtime && (
            <span className="text-xs text-[var(--trophy)]">
              +{minutes - full} min over
            </span>
          )}
        </div>
      </div>

      {canControl && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {state === 'not_started' && (
            <Button onClick={act('start')} loading={busy} size="lg">
              <Play className="size-4" aria-hidden /> Start match
            </Button>
          )}

          {RUNNING.includes(state) && (
            <>
              <Button
                variant="secondary"
                onClick={act(clock.pausedAt ? 'unpause' : 'pause')}
                loading={busy}
                aria-label={clock.pausedAt ? 'Restart the clock' : 'Stop the clock'}
              >
                {clock.pausedAt
                  ? <><Play className="size-4" aria-hidden /> Restart</>
                  : <><Pause className="size-4" aria-hidden /> Stop</>}
              </Button>

              {state === 'first_half' ? (
                <Button onClick={act('halftime')} loading={busy}>
                  <Timer className="size-4" aria-hidden /> Half time
                </Button>
              ) : (
                <Button onClick={act('end')} loading={busy}>
                  <Square className="size-4" aria-hidden /> Full time
                </Button>
              )}
            </>
          )}

          {isHalftime && (
            <Button onClick={act('resume')} loading={busy} size="lg">
              <FastForward className="size-4" aria-hidden /> Second half
            </Button>
          )}

          {/* An abandoned match is not a finished one -- the result is void, and the
              distinction matters to everyone's rating. Only offered while in play. */}
          {RUNNING.includes(state) && (
            <Button variant="ghost" onClick={act('abandon')} loading={busy}>
              Abandon
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
