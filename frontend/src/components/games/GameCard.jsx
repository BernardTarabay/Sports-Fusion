// The fixture card.
//
// This is the single most repeated object in the product, so it carries a lot: it must
// answer "when, where, can I get in" in under a second, at 320px, in a scroll.
//
// The date block on the left is borrowed from a printed fixture list -- day above,
// number below -- because it is scannable in a vertical column in a way that
// "Fri 29 Aug, 9:00 PM" on one line is not.

import { Link } from 'react-router';
import { MapPin, Users, Clock } from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { shortDay, dayNumber, monthName, time, relativeDay } from '../../lib/format.js';
import { CapacityMeter, GameStatusChip, ScoreLine } from '../football/index.jsx';
import { Badge, Button, Card } from '../ui/index.jsx';

export function GameCard({ game, className, compact = false, showAction = true }) {
  const kickoff = new Date(game.kickoffAt);
  const isPast = kickoff < new Date();
  const isCancelled = game.status === 'cancelled';
  const isCompleted = game.status === 'completed';
  const isFull = game.confirmedCount >= game.capacity;
  const tonight = relativeDay(kickoff) === 'Tonight' && !isPast;

  return (
    <Card
      interactive
      className={cn(
        'group relative overflow-hidden',
        isCancelled && 'opacity-70',
        tonight && 'ring-1 ring-[var(--accent)]',
        className
      )}
    >
      {/* Whole-card link, with the visible controls layered above it. Keeps the tap
          target the size of the card on mobile without nesting interactive elements. */}
      <Link
        to={`/games/${game.slug ?? game.id}`}
        className="absolute inset-0 z-0"
        aria-label={`${game.districtName} game, ${relativeDay(kickoff)} at ${time(kickoff)}`}
      />

      {tonight && (
        <div className="relative z-[1] bg-[var(--accent)] px-4 py-1">
          <p className="display text-xs tracking-[0.16em] text-[var(--accent-fg)]">TONIGHT</p>
        </div>
      )}

      <div className="relative z-[1] p-4 pointer-events-none">
        <div className="flex gap-4">
          {/* Date block */}
          <div className="shrink-0 text-center w-12">
            <p className="eyebrow text-[0.6875rem] leading-tight">{shortDay(kickoff)}</p>
            <p className="display text-3xl leading-none mt-0.5 tnum">{dayNumber(kickoff)}</p>
            <p className="eyebrow text-[0.625rem] leading-tight mt-0.5">{monthName(kickoff)}</p>
          </div>

          <div className="w-px bg-[var(--border-subtle)] shrink-0" />

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="display text-xl sm:text-2xl leading-tight truncate">
                  {game.districtName}
                </p>
                {game.venue && (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--fg-secondary)] truncate">
                    <MapPin className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{game.venue.name}</span>
                  </p>
                )}
              </div>
              <GameStatusChip
                status={game.status}
                confirmed={game.confirmedCount}
                capacity={game.capacity}
              />
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="flex items-center gap-1.5 font-semibold tnum">
                <Clock className="size-3.5 text-[var(--fg-muted)]" aria-hidden="true" />
                {time(kickoff)}
              </span>
              <span className="flex items-center gap-1.5 text-[var(--fg-secondary)] text-xs">
                <Users className="size-3.5" aria-hidden="true" />
                {game.teamSize}-a-side
              </span>
              {game.price != null && !isPast && (
                <span className="text-xs text-[var(--fg-secondary)]">${game.price}</span>
              )}
            </div>
          </div>
        </div>

        {/* Result replaces capacity once the game has been played. */}
        {isCompleted && game.result ? (
          <div className="mt-4 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] py-3">
            <ScoreLine
              home="Black"
              away="White"
              homeScore={game.result.score.black}
              awayScore={game.result.score.white}
              size="sm"
            />
            {game.result.motm && (
              <p className="mt-1.5 text-center text-xs text-[var(--fg-secondary)]">
                <span className="text-[var(--trophy)]">★</span> {game.result.motm.name}
              </p>
            )}
          </div>
        ) : isCancelled ? (
          <p className="mt-4 rounded-[var(--radius-md)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger-soft-fg)]">
            {game.cancelledReason ?? 'This game was cancelled.'}
          </p>
        ) : (
          !compact && (
            <div className="mt-4">
              <CapacityMeter
                confirmed={game.confirmedCount}
                capacity={game.capacity}
                waitlist={game.waitlistCount}
              />
            </div>
          )
        )}

        {/* Registration state is the one thing a returning player scans for. */}
        {game.isRegistered && !isPast && (
          <div className="mt-3 flex items-center gap-2">
            <Badge tone={game.myWaitlistPosition ? 'trophy' : 'accent'}>
              {game.myWaitlistPosition
                ? `Waiting list · #${game.myWaitlistPosition}`
                : "You're in"}
            </Badge>
          </div>
        )}
      </div>

      {showAction && !isPast && !isCancelled && !game.isRegistered && (
        <div className="relative z-[2] px-4 pb-4">
          <Button
            to={`/games/${game.slug ?? game.id}`}
            variant={isFull ? 'secondary' : 'primary'}
            className="w-full"
            size="md"
          >
            {isFull ? 'Join waiting list' : 'Join game'}
          </Button>
        </div>
      )}
    </Card>
  );
}

export function GameCardSkeleton({ className }) {
  return (
    <Card className={cn('p-4', className)}>
      <div className="flex gap-4">
        <div className="w-12 space-y-1.5">
          <div className="skeleton h-3 w-full" />
          <div className="skeleton h-7 w-full" />
          <div className="skeleton h-2.5 w-full" />
        </div>
        <div className="w-px bg-[var(--border-subtle)]" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-6 w-2/3" />
          <div className="skeleton h-3 w-1/2" />
          <div className="skeleton h-4 w-1/3" />
        </div>
      </div>
      <div className="skeleton mt-4 h-2 w-full" />
      <div className="skeleton mt-4 h-11 w-full" />
    </Card>
  );
}

export default GameCard;
