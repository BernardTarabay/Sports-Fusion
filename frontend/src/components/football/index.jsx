// Football-specific display primitives. These carry the identity of the product: if a
// screenshot of any one of them could belong to a generic SaaS app, it is wrong.

import { cn } from '../../lib/cn.js';
import { toPlayerRating, isProvisional } from '../../lib/format.js';
import { Tooltip } from '../ui/index.jsx';

/* ==========================================================================
   RatingBadge

   Shows the 0-10 rating players understand, never the raw Glicko number. When the
   system does not yet know a player, it says so instead of stating a guess as fact --
   a confident 7.4 that is really 1500 +/- 350 is a lie told with a number.
   ========================================================================== */

export function RatingBadge({ mu, sigma, size = 'md', className, showProvisional = true }) {
  const rating = toPlayerRating(mu);
  const provisional = isProvisional(sigma);

  const sizes = {
    sm: 'h-6 min-w-9 text-xs px-1.5 rounded-[var(--radius-xs)]',
    md: 'h-8 min-w-11 text-sm px-2 rounded-[var(--radius-sm)]',
    lg: 'h-12 min-w-16 text-xl px-2.5 rounded-[var(--radius-md)]',
    xl: 'h-20 min-w-24 text-4xl px-3 rounded-[var(--radius-lg)]',
  };

  const tone =
    rating == null || provisional
      ? 'bg-[var(--bg-sunken)] text-[var(--fg-muted)]'
      : rating >= 8.5
        ? 'bg-[var(--trophy)] text-[#231a02]'
        : rating >= 7.5
          ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
          : rating >= 6
            ? 'bg-[var(--accent-soft)] text-[var(--accent-soft-fg)]'
            : 'bg-[var(--bg-sunken)] text-[var(--fg-secondary)]';

  return (
    <Tooltip
      label={
        provisional && showProvisional
          ? 'Provisional — a few more games and this settles down'
          : undefined
      }
    >
      <span
        className={cn(
          'inline-grid place-items-center font-bold tnum display leading-none',
          sizes[size],
          tone,
          className
        )}
      >
        {rating == null ? '—' : rating.toFixed(1)}
        {provisional && showProvisional && <span className="sr-only"> (provisional)</span>}
      </span>
    </Tooltip>
  );
}

/* ==========================================================================
   teamStrength

   The sum of a side's PLAYER-FACING ratings, not the sum of raw Glicko numbers.
   An admin comparing "16993.9 v 17028.2" is being shown the model's internals; the
   same comparison as "82.4 v 82.6" is the same information in a unit they already
   understand from the player cards.
   ========================================================================== */

export function teamStrength(players = []) {
  const total = players.reduce((sum, p) => sum + (toPlayerRating(p.ratingMu) ?? 0), 0);
  return Math.round(total * 10) / 10;
}

/* ==========================================================================
   FormStrip

   Five recent performances, most recent last. The shape of the line matters more than
   the numbers -- a player can see at a glance whether they are climbing.
   ========================================================================== */

export function FormStrip({ form = [], className, showValues = false }) {
  if (form.length === 0) return null;
  const trend = form.at(-1) - form[0];

  return (
    <div className={cn('flex items-end gap-1', className)} role="img"
      aria-label={`Recent form: ${form.join(', ')}. ${
        trend > 0.3 ? 'Improving' : trend < -0.3 ? 'Declining' : 'Steady'
      }.`}
    >
      {form.map((value, i) => {
        const height = Math.max(20, ((value - 4) / 6) * 100);
        const isLast = i === form.length - 1;
        return (
          <div key={i} className="flex flex-col items-center gap-1">
            <div
              className={cn(
                'w-2 rounded-full transition-all',
                isLast ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]'
              )}
              style={{ height: `${(height / 100) * 28 + 4}px` }}
            />
            {showValues && (
              <span className={cn('text-[0.625rem] tnum', isLast ? 'text-[var(--fg-primary)] font-semibold' : 'text-[var(--fg-muted)]')}>
                {value.toFixed(1)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   ScoreLine

   The broadcast moment. Big condensed numerals, team names either side.
   ========================================================================== */

export function ScoreLine({ home, away, homeScore, awayScore, size = 'md', className, motm }) {
  const sizes = {
    sm: { score: 'text-3xl', name: 'text-xs', gap: 'gap-3' },
    md: { score: 'text-5xl sm:text-6xl', name: 'text-sm', gap: 'gap-4 sm:gap-6' },
    lg: { score: 'text-6xl sm:text-8xl', name: 'text-base sm:text-lg', gap: 'gap-6 sm:gap-10' },
  };
  const s = sizes[size];
  const homeWon = homeScore > awayScore;
  const awayWon = awayScore > homeScore;

  return (
    <div className={cn('flex items-center justify-center', s.gap, className)}>
      <div className="flex-1 text-right min-w-0">
        <p className={cn('display truncate', s.name, homeWon ? 'text-[var(--fg-primary)]' : 'text-[var(--fg-secondary)]')}>
          {home}
        </p>
      </div>

      <div className="flex items-baseline gap-2 sm:gap-3 shrink-0">
        <span className={cn('display tnum', s.score, homeWon ? 'text-[var(--fg-primary)]' : 'text-[var(--fg-secondary)]')}>
          {homeScore}
        </span>
        <span className={cn('display text-[var(--fg-muted)]', size === 'sm' ? 'text-xl' : 'text-3xl')}>—</span>
        <span className={cn('display tnum', s.score, awayWon ? 'text-[var(--fg-primary)]' : 'text-[var(--fg-secondary)]')}>
          {awayScore}
        </span>
      </div>

      <div className="flex-1 text-left min-w-0">
        <p className={cn('display truncate', s.name, awayWon ? 'text-[var(--fg-primary)]' : 'text-[var(--fg-secondary)]')}>
          {away}
        </p>
      </div>
    </div>
  );
}

/* ==========================================================================
   TeamCrest

   A jersey rather than a logo: this is a pickup league, not a club. Two-tone so black
   and white read clearly at 20px.
   ========================================================================== */

export function TeamCrest({ color = 'black', size = 24, className }) {
  const fills = {
    black: { body: '#15181c', trim: '#3d444d' },
    white: { body: '#f2f5f4', trim: '#c9d2ce' },
    red: { body: '#c0392b', trim: '#e05a4b' },
    blue: { body: '#1e5aa8', trim: '#3d7fd4' },
    yellow: { body: '#e0b020', trim: '#f0c74a' },
    green: { body: '#1f7a4d', trim: '#2f9e68' },
  };
  const fill = fills[color] ?? fills.black;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M8.5 3 5 4.8 3 8l2.6 1.7L6.5 8v12h11V8l.9 1.7L21 8l-2-3.2L15.5 3a3.6 3.6 0 0 1-7 0Z"
        fill={fill.body}
        stroke={fill.trim}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ==========================================================================
   CapacityMeter

   How full is this game. Colour is meaning, not decoration: green while there is room,
   amber when it is nearly gone, red when it is full.
   ========================================================================== */

export function CapacityMeter({ confirmed, capacity, waitlist = 0, size = 'md', className, showLabel = true }) {
  const ratio = capacity === 0 ? 0 : confirmed / capacity;
  const full = confirmed >= capacity;
  const almost = !full && ratio >= 0.8;

  const tone = full
    ? 'var(--danger)'
    : almost
      ? 'var(--trophy)'
      : 'var(--accent)';

  const segments = Math.min(capacity, 22);
  const filledSegments = Math.round(ratio * segments);

  return (
    <div className={cn('space-y-1.5', className)}>
      {showLabel && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="display text-lg tnum" style={{ color: tone }}>
            {confirmed}<span className="text-[var(--fg-muted)]">/{capacity}</span>
          </span>
          <span className="text-xs text-[var(--fg-secondary)]">
            {full
              ? waitlist > 0 ? `${waitlist} waiting` : 'Full'
              : `${capacity - confirmed} spot${capacity - confirmed === 1 ? '' : 's'} left`}
          </span>
        </div>
      )}

      {/* Segmented rather than a smooth bar: 17/22 is countable at a glance, and each
          segment reads as a player rather than as a percentage. */}
      <div
        className={cn('flex gap-[2px]', size === 'sm' ? 'h-1.5' : 'h-2')}
        role="progressbar"
        aria-valuenow={confirmed}
        aria-valuemin={0}
        aria-valuemax={capacity}
        aria-label={`${confirmed} of ${capacity} players registered`}
      >
        {Array.from({ length: segments }, (_, i) => (
          <div
            key={i}
            className="flex-1 rounded-[1px] transition-colors duration-300"
            style={{
              background: i < filledSegments ? tone : 'var(--bg-sunken)',
              transitionDelay: `${i * 12}ms`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ==========================================================================
   GameStatusChip
   ========================================================================== */

const STATUS = {
  registration_open: { label: 'Open', tone: 'accent' },
  full: { label: 'Full', tone: 'danger' },
  teams_generated: { label: 'Teams out', tone: 'info' },
  in_progress: { label: 'Live', tone: 'danger', pulse: true },
  completed: { label: 'Result in', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  draft: { label: 'Draft', tone: 'neutral' },
};

export function GameStatusChip({ status, confirmed, capacity, className }) {
  let spec = STATUS[status] ?? STATUS.registration_open;

  // "Almost full" is a state the backend does not have but players care about most.
  if (status === 'registration_open' && capacity && confirmed / capacity >= 0.8) {
    spec = { label: 'Almost full', tone: 'trophy' };
  }

  const tones = {
    accent: 'bg-[var(--accent-soft)] text-[var(--accent-soft-fg)]',
    danger: 'bg-[var(--danger-soft)] text-[var(--danger-soft-fg)]',
    trophy: 'bg-[var(--trophy-soft)] text-[var(--trophy-soft-fg)]',
    info: 'bg-[var(--info-soft)] text-[var(--info-soft-fg)]',
    neutral: 'bg-[var(--bg-sunken)] text-[var(--fg-secondary)]',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold uppercase tracking-wide',
        tones[spec.tone],
        className
      )}
    >
      {spec.pulse && <span className="size-1.5 rounded-full bg-current animate-pulse" />}
      {spec.label}
    </span>
  );
}

/* ==========================================================================
   PositionChip
   ========================================================================== */

const POSITION_GROUP = {
  GK: 'GK', LB: 'DEF', CB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LW: 'FWD', RW: 'FWD', ST: 'FWD', CF: 'FWD',
};

const GROUP_TONE = {
  GK: 'bg-[var(--trophy-soft)] text-[var(--trophy-soft-fg)]',
  DEF: 'bg-[var(--info-soft)] text-[var(--info-soft-fg)]',
  MID: 'bg-[var(--accent-soft)] text-[var(--accent-soft-fg)]',
  FWD: 'bg-[var(--danger-soft)] text-[var(--danger-soft-fg)]',
};

/**
 * @param {boolean} muted  A position they will fill in at, rather than their own. Drawn
 *   as an outline so a row of "RW CM CAM" reads as one main and two alternates at a
 *   glance, instead of three equal claims.
 */
export function PositionChip({ position, className, size = 'md', muted = false }) {
  if (!position) return null;
  const group = POSITION_GROUP[position] ?? 'MID';
  return (
    <span
      className={cn(
        'inline-grid place-items-center font-bold rounded-[var(--radius-xs)] uppercase',
        size === 'sm' ? 'h-5 min-w-8 text-[0.625rem] px-1' : 'h-6 min-w-10 text-[0.6875rem] px-1.5',
        muted
          ? 'border border-[var(--border-default)] text-[var(--fg-muted)]'
          : GROUP_TONE[group],
        className
      )}
    >
      {position}
    </span>
  );
}

export { FootballPitch, TEAM_COLOURS } from './FootballPitch.jsx';
