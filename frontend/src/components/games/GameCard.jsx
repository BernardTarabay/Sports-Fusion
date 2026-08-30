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
import { shortDay, dayNumber, monthName, time, relativeDay, placeOf } from '../../lib/format.js';
import { CapacityMeter, GameStatusChip, ScoreLine } from '../football/index.jsx';
import { VenueBadge } from '../football/VenueBadge.jsx';
import { Badge, Button, Card } from '../ui/index.jsx';
import { joinability } from '../../lib/joinability.js';

// Teams are named by shirt colour and the balancer can hand out six of them, so the
// scoreline reads the colours the result carries rather than assuming black and white.
const teamLabel = (color) => (color ? color[0].toUpperCase() + color.slice(1) : null);

export function GameCard({ game, className, compact = false, showAction = true }) {
  const kickoff = new Date(game.kickoffAt);
  const isPast = kickoff < new Date();
  const isCancelled = game.status === 'cancelled';
  const isCompleted = game.status === 'completed';
  const isFull = game.confirmedCount >= game.capacity;
  const tonight = relativeDay(kickoff) === 'Tonight' && !isPast;
  const join = joinability(game);

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
        aria-label={`${game.venue?.name ?? game.districtName} game, ${relativeDay(kickoff)} at ${time(kickoff)}`}
      />

      {tonight && (
        <div className="relative z-[1] bg-[var(--accent)] px-4 py-1">
          <p className="display text-xs tracking-[0.16em] text-[var(--accent-fg)]">TONIGHT</p>
        </div>
      )}

      <div className="relative z-[1] p-4 pointer-events-none">
        <div className="flex gap-3 sm:gap-4">
          {/* Date block */}
          <div className="shrink-0 text-center w-12">
            <p className="eyebrow text-[0.6875rem] leading-tight">{shortDay(kickoff)}</p>
            <p className="display text-3xl leading-none mt-0.5 tnum">{dayNumber(kickoff)}</p>
            <p className="eyebrow text-[0.625rem] leading-tight mt-0.5">{monthName(kickoff)}</p>
          </div>

          <div className="w-px bg-[var(--border-subtle)] shrink-0" />

          {/* The venue's own badge. Admins upload these and they only ever appeared on
              the game page -- the card is where a fixture is actually recognised, and a
              logo is quicker to recognise than a line of text in a scroll. */}
          <VenueBadge venue={game.venue} size={36} className="mt-0.5 sm:size-10" />

          <div className="min-w-0 flex-1">
            {/* The GROUND is the heading. It used to be the district, with the pitch
                in small grey text underneath -- which is backwards for the person
                deciding whether to come: nobody drives to a caza. The district stays as
                the locating line, because "Zouk Mosbeh, Keserwan" is how you place a
                ground you have not been to. */}
            <div className="flex items-start justify-between gap-2">
              <p className="display min-w-0 text-xl leading-tight line-clamp-2 sm:text-2xl">
                {game.venue?.name ?? game.districtName}
              </p>
              <GameStatusChip
                status={game.status}
                confirmed={game.confirmedCount}
                capacity={game.capacity}
              />
            </div>

            {/* Its own row, not tucked beside the status chip. Sharing that row left it
                132px wide on a phone, so "Zouk Mosbeh, Keserwan" clipped to
                "Zouk Mosbeh, Kes..." -- losing exactly the half that places it. */}
            <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--fg-secondary)]">
              <MapPin className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{placeOf(game)}</span>
            </p>

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
              home={teamLabel(game.result.home.color) ?? "Team A"}
              away={teamLabel(game.result.away.color) ?? "Team B"}
              homeScore={game.result.home.score}
              awayScore={game.result.away.score}
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

      {/* Only when it can actually be done. A card for a match that has kicked off used
          to show a green "Join waiting list", which took the player to the game page and
          then to a 409. Where the answer is no, the state is worth saying quietly rather
          than dressing up as an action. */}
      {showAction && !game.isRegistered && (join.canJoin || (!isPast && !isCancelled)) && (
        <div className="relative z-[2] px-4 pb-4">
          {join.canJoin ? (
            <Button
              to={`/games/${game.slug ?? game.id}`}
              variant={join.waitlistOnly ? 'secondary' : 'primary'}
              className="w-full"
              size="md"
            >
              {join.label}
            </Button>
          ) : (
            <p className="rounded-[var(--radius-md)] bg-[var(--bg-sunken)] py-2.5 text-center text-xs font-medium text-[var(--fg-secondary)]">
              {join.label}
            </p>
          )}
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
