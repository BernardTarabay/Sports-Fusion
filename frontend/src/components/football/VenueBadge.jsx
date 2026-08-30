// A venue's badge, or its initials when it has none.
//
// Always renders something. A row that shows a logo for two venues and a gap for the
// third reads as a loading failure, and the fallback costs nothing.

import { cn } from '../../lib/cn.js';

/** "Eleven Football Pro Academy" -> "EF". Skips the words nobody uses to identify it. */
export function venueInitials(name = '') {
  const SKIP = new Set(['the', 'of', 'and', 'academy', 'stadium', 'club', 'sports', 'football', 'pitch']);
  const words = name.split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !SKIP.has(w.toLowerCase()));
  // Only drop the generic words if enough is left to make a pair. "Sports Zone" filters
  // down to "Zone", and a single Z is not a badge -- better to keep SZ.
  const source = meaningful.length >= 2 ? meaningful : words;
  return source.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

export function VenueBadge({ venue, size = 40, className }) {
  if (!venue) return null;
  const dimension = { width: size, height: size };

  if (venue.logoUrl) {
    return (
      <img
        src={venue.logoUrl}
        // Decorative next to the venue name, which is always present alongside it.
        // Announcing "Sports Zone logo" after "Sports Zone" is noise.
        alt=""
        style={dimension}
        className={cn('shrink-0 rounded-[var(--radius-md)] object-contain', className)}
      />
    );
  }

  return (
    <div
      style={dimension}
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-[var(--radius-md)]',
        'bg-[var(--surface-2)] text-[var(--fg-tertiary)]',
        className
      )}
    >
      <span className="display leading-none" style={{ fontSize: size * 0.36 }}>
        {venueInitials(venue.name)}
      </span>
    </div>
  );
}
