// Player-facing components: the football card, the stat grid, the career timeline, and
// the shareable graphics.

import { Link } from 'react-router';
import { Trophy, TrendingUp, TrendingDown, Minus, Share2 } from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { toPlayerRating, isProvisional, relativeDay, compact, percent } from '../../lib/format.js';
import { Avatar, Badge, Button, Card } from '../ui/index.jsx';
import { RatingBadge, FormStrip, PositionChip, TeamCrest } from '../football/index.jsx';
import { Sparkline } from '../charts/index.jsx';

/* ==========================================================================
   PlayerCard — the row/tile used in rosters, leaderboards and search
   ========================================================================== */

export function PlayerCard({ player, rank, metric, className, showForm = true, href }) {
  const Wrapper = href ? Link : 'div';

  return (
    <Wrapper
      to={href}
      className={cn(
        'flex items-center gap-3 p-3 rounded-[var(--radius-md)] transition-colors',
        href && 'hover:bg-[var(--bg-sunken)]',
        className
      )}
    >
      {rank != null && (
        <span
          className={cn(
            'display w-7 shrink-0 text-center text-lg tnum',
            rank === 1 ? 'text-[var(--trophy)]' : rank <= 3 ? 'text-[var(--fg-primary)]' : 'text-[var(--fg-muted)]'
          )}
        >
          {rank}
        </span>
      )}

      <Avatar name={player.name} size="md" />

      <div className="min-w-0 flex-1">
        <p className="font-semibold truncate leading-tight">{player.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--fg-secondary)]">
          <PositionChip position={player.position} size="sm" />
          {player.districtName && <span className="truncate">{player.districtName}</span>}
        </p>
      </div>

      {showForm && player.form?.length > 0 && (
        <FormStrip form={player.form} className="hidden sm:flex" />
      )}

      <div className="shrink-0 text-right">
        {metric && metric !== 'rating' ? (
          <span className="display text-2xl tnum">
            {metric === 'reliability'
              ? percent(player.value ?? 0)
              : typeof player.value === 'number'
                ? Math.round(player.value * 10) / 10
                : '—'}
          </span>
        ) : (
          <RatingBadge mu={player.ratingMu} sigma={player.ratingSigma} />
        )}
      </div>
    </Wrapper>
  );
}

/* ==========================================================================
   PlayerHero — the top of a profile.

   Modelled on a broadcast player bug: identity, one big number, and the supporting
   stats underneath. Not a form with an avatar.
   ========================================================================== */

export function PlayerHero({ player, ratingHistory = [], onShare, className }) {
  const rating = toPlayerRating(player.ratingMu);
  const provisional = isProvisional(player.ratingSigma);
  const trend = ratingHistory.length >= 2
    ? ratingHistory.at(-1).mu - ratingHistory.at(-2).mu
    : 0;

  return (
    <Card className={cn('relative overflow-hidden floodlit', className)}>
      {/* A faint pitch arc behind the identity block, the way a broadcast lower-third
          carries a hint of the stadium. */}
      <svg
        className="pointer-events-none absolute -right-16 -top-20 size-72 opacity-[0.06]"
        viewBox="0 0 100 100" aria-hidden="true"
      >
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="50" cy="50" r="30" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M50 4 v92" stroke="currentColor" strokeWidth="1" />
      </svg>

      <div className="relative p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <Avatar name={player.name} size="xl" ring />

          <div className="min-w-0 flex-1">
            <h1 className="display text-3xl sm:text-4xl leading-none truncate">{player.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PositionChip position={player.position} />
              {player.districtName && (
                <Badge tone="outline">{player.districtName}</Badge>
              )}
              {player.rank > 0 && !provisional && (
                <Badge tone="trophy">
                  <Trophy className="size-3" aria-hidden="true" />
                  #{player.rank}
                </Badge>
              )}
            </div>
          </div>

          {onShare && (
            <Button variant="ghost" size="icon" onClick={onShare} aria-label="Share player card">
              <Share2 className="size-4" />
            </Button>
          )}
        </div>

        {/* The number. Deliberately the largest thing on the page. */}
        <div className="mt-6 flex items-end gap-5">
          <div>
            <p className="eyebrow">Player rating</p>
            <div className="flex items-baseline gap-2">
              <span className="display text-6xl sm:text-7xl leading-none tnum">
                {rating?.toFixed(1) ?? '—'}
              </span>
              {trend !== 0 && (
                <span
                  className={cn(
                    'flex items-center gap-0.5 text-sm font-semibold',
                    trend > 0 ? 'text-[var(--accent)]' : 'text-[var(--danger)]'
                  )}
                >
                  {trend > 0 ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
                  {Math.abs(Math.round(trend))}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-[var(--fg-secondary)]">
              {provisional
                ? 'Still settling — play a few more games'
                : player.percentile != null
                  ? `Top ${player.percentile}% ${player.districtName ? `in ${player.districtName}` : ''}`
                  : ''}
            </p>
          </div>

          {ratingHistory.length > 2 && (
            <div className="hidden sm:block flex-1 max-w-56">
              <Sparkline
                data={ratingHistory.map((h) => h.mu)}
                height={56}
                label={`Rating trend over ${ratingHistory.length} updates`}
              />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ==========================================================================
   StatGrid — career numbers.

   A swipe rail on mobile rather than a 2x4 grid of tiny boxes: it keeps each number
   at a readable size and matches how people flick through stats on a phone.
   ========================================================================== */

export function StatGrid({ stats, className }) {
  return (
    <div className={cn('snap-rail sm:grid sm:grid-cols-4 sm:gap-3 -mx-4 px-4 sm:mx-0 sm:px-0', className)}>
      {stats.map((stat) => (
        <Card key={stat.label} className="min-w-28 p-4 sm:min-w-0">
          <p className="eyebrow text-[0.625rem]">{stat.label}</p>
          <p
            className={cn(
              'display text-3xl mt-1.5 tnum',
              stat.tone === 'trophy' && 'text-[var(--trophy)]',
              stat.tone === 'accent' && 'text-[var(--accent)]'
            )}
          >
            {stat.value}
          </p>
          {stat.sub && <p className="mt-0.5 text-[0.6875rem] text-[var(--fg-secondary)]">{stat.sub}</p>}
        </Card>
      ))}
    </div>
  );
}

/* ==========================================================================
   MatchTimeline — a player's career, most recent first.

   Built to be browsable rather than merely complete: the result, the side they were
   on, their rating that night, and any award, all in one scannable row.
   ========================================================================== */

export function MatchTimeline({ matches = [], className }) {
  return (
    <ol className={cn('relative space-y-2', className)}>
      {matches.map((match, i) => {
        const won =
          match.score &&
          ((match.teamColor === 'black' && match.score.black > match.score.white) ||
            (match.teamColor === 'white' && match.score.white > match.score.black));
        const drew = match.score && match.score.black === match.score.white;

        return (
          <li key={match.gameId ?? i}>
            <Link
              to={`/games/${match.gameId}`}
              className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 transition-colors hover:border-[var(--border-default)]"
            >
              {/* Result stripe: green won, red lost, grey drew. Readable at a glance
                  down a long list. */}
              <span
                className="w-1 self-stretch rounded-full shrink-0"
                style={{
                  background: drew
                    ? 'var(--border-strong)'
                    : won
                      ? 'var(--accent)'
                      : 'var(--danger)',
                }}
                aria-hidden="true"
              />

              <div className="w-16 shrink-0">
                <p className="text-xs font-medium">{relativeDay(match.kickoffAt)}</p>
                <p className="text-[0.6875rem] text-[var(--fg-muted)] truncate">{match.districtName}</p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <TeamCrest color={match.teamColor ?? 'black'} size={20} />
                <span className="display text-lg tnum">
                  {match.score ? `${match.score.black}–${match.score.white}` : '—'}
                </span>
              </div>

              <div className="flex-1" />

              {match.motm && (
                <Badge tone="trophy" size="sm">
                  <Trophy className="size-3" aria-hidden="true" /> MOTM
                </Badge>
              )}

              {match.rating != null && (
                <RatingBadge mu={1500 + (match.rating - 6.5) * 150} sigma={60} size="sm" />
              )}
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

/* ==========================================================================
   ShareablePlayerCard

   Designed to be screenshotted and dropped into a WhatsApp group, which is how this
   community already communicates. Fixed aspect, high contrast, legible when it is
   400px wide in a chat thread.
   ========================================================================== */

export function ShareablePlayerCard({ player, match, className }) {
  const rating = match?.rating ?? toPlayerRating(player.ratingMu);

  return (
    <div
      className={cn(
        'relative aspect-[4/5] w-full max-w-xs overflow-hidden rounded-[var(--radius-xl)] p-6 text-white',
        className
      )}
      style={{
        background:
          'radial-gradient(ellipse 90% 60% at 50% 0%, #0f5f3d 0%, #0a3322 45%, #050c09 100%)',
      }}
    >
      <div className="absolute inset-0 opacity-[0.07]" aria-hidden="true">
        <svg viewBox="0 0 100 125" className="size-full" preserveAspectRatio="none">
          <circle cx="50" cy="62" r="26" fill="none" stroke="white" strokeWidth="0.6" />
          <path d="M0 62 h100" stroke="white" strokeWidth="0.6" />
          <rect x="28" y="0" width="44" height="16" fill="none" stroke="white" strokeWidth="0.6" />
          <rect x="28" y="109" width="44" height="16" fill="none" stroke="white" strokeWidth="0.6" />
        </svg>
      </div>

      <div className="relative flex h-full flex-col">
        <p className="display text-[0.6875rem] tracking-[0.3em] text-white/60">SPORTS FUSION</p>

        <div className="mt-auto">
          {match?.motm && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--trophy)] px-2.5 py-1 text-[0.625rem] font-bold uppercase tracking-wide text-[#231a02]">
              <Trophy className="size-3" aria-hidden="true" /> Man of the Match
            </span>
          )}

          <p className="display mt-3 text-4xl leading-none">{player.name}</p>

          <div className="mt-4 flex items-end gap-4">
            <div>
              <p className="display text-7xl leading-none tnum text-[var(--color-pitch-300)]">
                {rating?.toFixed(1) ?? '—'}
              </p>
            </div>
            {match && (
              <div className="mb-2 space-y-0.5 text-sm">
                {match.goals > 0 && <p>{match.goals} {match.goals === 1 ? 'goal' : 'goals'}</p>}
                {match.assists > 0 && <p>{match.assists} {match.assists === 1 ? 'assist' : 'assists'}</p>}
              </div>
            )}
          </div>

          {match?.score && (
            <p className="mt-4 border-t border-white/15 pt-3 text-sm text-white/70">
              Black {match.score.black} — {match.score.white} White
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   ShareableMatchCard
   ========================================================================== */

export function ShareableMatchCard({ game, className }) {
  if (!game.result) return null;

  return (
    <div
      className={cn('relative aspect-square w-full max-w-sm overflow-hidden rounded-[var(--radius-xl)] p-6 text-white', className)}
      style={{ background: 'radial-gradient(ellipse 90% 60% at 50% 0%, #0f5f3d 0%, #0a3322 45%, #050c09 100%)' }}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between">
          <p className="display text-[0.6875rem] tracking-[0.3em] text-white/60">SPORTS FUSION</p>
          <p className="text-[0.6875rem] text-white/50">{game.districtName}</p>
        </div>

        <div className="my-auto text-center">
          <div className="flex items-center justify-center gap-5">
            <div className="flex flex-col items-center gap-2">
              <TeamCrest color="black" size={34} />
              <span className="display text-6xl tnum">{game.result.score.black}</span>
            </div>
            <span className="display text-3xl text-white/30">—</span>
            <div className="flex flex-col items-center gap-2">
              <TeamCrest color="white" size={34} />
              <span className="display text-6xl tnum">{game.result.score.white}</span>
            </div>
          </div>

          {game.result.motm && (
            <div className="mt-8">
              <p className="display text-[0.6875rem] tracking-[0.22em] text-[var(--trophy)]">
                MAN OF THE MATCH
              </p>
              <p className="display mt-1 text-3xl">{game.result.motm.name}</p>
              <p className="display mt-1 text-2xl tnum text-[var(--color-pitch-300)]">
                {game.result.motm.rating?.toFixed(1)}
              </p>
            </div>
          )}
        </div>

        <p className="text-center text-[0.6875rem] text-white/40">
          {compact(game.confirmedCount)} players · sportsfusion.app
        </p>
      </div>
    </div>
  );
}
