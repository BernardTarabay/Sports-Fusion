// Man of the Month.
//
// A trophy presentation, not a table row. This is the most prestigious thing the
// community hands out, so it gets the broadcast treatment: floodlit panel, the name at
// display size, the numbers that earned it, and the reward attached.

import { Trophy, Gift, Check, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn.js';
import { Avatar, Badge, Button, Card } from '../ui/index.jsx';
import { RatingBadge } from '../football/index.jsx';

export function ManOfTheMonthCard({ award, onClaim, claiming, canClaim, className }) {
  if (!award) return null;

  const { player, stats, reward, month, inProgress, minAppearances } = award;

  // Nobody has qualified yet -- a new league, or a quiet month. Say so, and say what it
  // takes. Rendering nothing leaves a hole where the trophy is supposed to be and no
  // explanation of why, which reads as broken rather than as empty.
  if (!player) {
    return (
      <Card className={cn('relative overflow-hidden', className)}>
        <div className="p-5 sm:p-7">
          <div className="flex items-center gap-2">
            <Trophy className="size-4 text-[var(--fg-muted)]" aria-hidden="true" />
            <p className="display text-xs tracking-[0.22em] text-[var(--fg-muted)]">
              MAN OF THE MONTH
            </p>
            <Badge tone="neutral" size="sm" className="ml-auto">
              {month}{inProgress ? ' · in progress' : ''}
            </Badge>
          </div>
          <p className="mt-4 text-lg">Nobody has claimed it yet.</p>
          <p className="mt-1 text-sm text-[var(--fg-secondary)]">
            {minAppearances
              ? `Play ${minAppearances} games this month to be in the running. Most man-of-the-match awards takes it.`
              : 'Play some games this month to be in the running.'}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      className={cn('relative overflow-hidden', className)}
      style={{
        background:
          'radial-gradient(ellipse 80% 60% at 50% 0%, rgb(245 196 81 / 0.16) 0%, transparent 62%)',
      }}
    >
      {/* Laurel geometry, very low contrast — suggestion of a trophy, not clip-art. */}
      <svg
        className="pointer-events-none absolute -right-10 -top-10 size-56 opacity-[0.07]"
        viewBox="0 0 100 100" aria-hidden="true"
      >
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="50" cy="50" r="22" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>

      <div className="relative p-5 sm:p-7">
        <div className="flex items-center gap-2">
          <Trophy className="size-4 text-[var(--trophy)]" aria-hidden="true" />
          <p className="display text-xs tracking-[0.22em] text-[var(--trophy)]">
            MAN OF THE MONTH
          </p>
          <Badge tone="neutral" size="sm" className="ml-auto">
            {month}{inProgress ? ' · in progress' : ''}
          </Badge>
        </div>

        <div className="mt-5 flex items-center gap-4">
          <Avatar name={player.name} size="xl" ring />
          <div className="min-w-0">
            <Link
              to={`/players/${player.id}`}
              className="display block truncate text-4xl leading-none hover:underline sm:text-5xl"
            >
              {player.name}
            </Link>
            <div className="mt-2 flex items-center gap-2">
              <RatingBadge mu={player.ratingMu} sigma={player.ratingSigma} size="md" />
              <span className="text-sm text-[var(--fg-secondary)]">
                {stats.rating} average this month
              </span>
            </div>
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-4 gap-3 text-center">
          {[
            ['Games', stats.games],
            ['MOTM', stats.motm],
            ['Goals', stats.goals],
            ['Assists', stats.assists],
          ].map(([term, value]) => (
            <div key={term}>
              <dd className="display text-3xl tnum">{value}</dd>
              <dt className="eyebrow text-[0.5625rem]">{term}</dt>
            </div>
          ))}
        </dl>

        {reward && (
          <div className="mt-6 rounded-[var(--radius-md)] border border-[var(--trophy)]/40 bg-[var(--trophy-soft)] p-4">
            <div className="flex items-start gap-3">
              <Gift className="mt-0.5 size-5 shrink-0 text-[var(--trophy)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-[var(--trophy-soft-fg)]">The reward</p>
                <p className="mt-0.5 text-sm text-[var(--trophy-soft-fg)]">{reward.name}</p>
              </div>
            </div>

            {reward.claimed ? (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--trophy-soft-fg)]">
                <Check className="size-3.5" aria-hidden="true" /> Claimed
              </p>
            ) : canClaim ? (
              <Button variant="trophy" className="mt-3 w-full" loading={claiming} onClick={onClaim}>
                Claim your reward
              </Button>
            ) : (
              <p className="mt-3 text-xs text-[var(--trophy-soft-fg)]">
                {inProgress ? 'Awarded at the end of the month.' : 'Not yet claimed.'}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Roll of honour. Small, so the current holder keeps the spotlight. */
export function PreviousWinners({ winners = [], className }) {
  if (winners.length === 0) return null;

  return (
    <Card className={cn('divide-y divide-[var(--border-subtle)]', className)}>
      <div className="px-4 py-3">
        <p className="eyebrow text-[0.625rem]">Previous winners</p>
      </div>
      {winners.map((award) => (
        <Link
          key={award.monthIso}
          to={`/players/${award.player.id}`}
          className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--bg-sunken)]"
        >
          <Trophy className="size-4 shrink-0 text-[var(--trophy)]" aria-hidden="true" />
          <Avatar name={award.player.name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{award.player.name}</p>
            <p className="text-xs text-[var(--fg-muted)]">{award.month}</p>
          </div>
          <span className="display text-lg tnum">{award.stats.rating}</span>
          <ChevronRight className="size-4 text-[var(--fg-muted)]" aria-hidden="true" />
        </Link>
      ))}
    </Card>
  );
}
