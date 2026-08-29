// Lebanon.
//
// The outline is traced from the real coastline and borders rather than invented: the
// Mediterranean edge running north-west to south-west, the Anti-Lebanon border with
// Syria on the east, Naqoura in the south and the Nahr el-Kabir in the north. It is
// simplified for legibility at 400px, but the country is recognisable — which an
// abstract blob is not, and Lebanese players would spot the difference immediately.
//
// District shapes are approximate administrative areas, drawn to tile the country
// without gaps. They are hit targets and identity, not a survey.

import { useState } from 'react';
import { cn } from '../../lib/cn.js';
import { compact, percent } from '../../lib/format.js';

/** Simplified national outline in a 0-400 x 0-680 space (north at the top). */
const LEBANON_OUTLINE =
  'M126 14 L168 22 L196 40 L214 66 L232 84 L250 118 L268 140 L286 176 L300 214 ' +
  'L312 252 L322 292 L330 330 L338 372 L344 410 L350 448 L352 486 L344 520 ' +
  'L330 548 L312 576 L292 604 L272 630 L250 652 L228 666 L206 672 L188 664 ' +
  'L176 646 L170 620 L162 592 L150 566 L136 542 L120 518 L106 492 L94 464 ' +
  'L84 434 L76 402 L70 368 L64 332 L60 296 L58 258 L60 220 L66 182 L76 146 ' +
  'L88 110 L102 74 L112 42 Z';

/**
 * District polygons. Roughly north-to-south, west-to-east, tiling the outline.
 * Keyed by slug so the data drives which are shown.
 */
const DISTRICT_SHAPES = {
  batroun: {
    d: 'M76 146 L88 110 L102 74 L112 42 L126 14 L168 22 L196 40 L214 66 L200 104 L176 132 L146 150 L110 158 Z',
    label: [140, 92],
  },
  jbeil: {
    d: 'M110 158 L146 150 L176 132 L200 104 L214 66 L232 84 L250 118 L236 156 L212 188 L180 208 L142 214 L108 206 L88 182 Z',
    label: [168, 152],
  },
  keserwan: {
    d: 'M88 182 L108 206 L142 214 L180 208 L212 188 L236 156 L250 118 L268 140 L286 176 L272 216 L246 248 L212 268 L172 274 L134 266 L106 246 L86 216 Z',
    label: [180, 218],
  },
  metn: {
    d: 'M86 216 L106 246 L134 266 L172 274 L212 268 L246 248 L272 216 L286 176 L300 214 L312 252 L296 292 L268 324 L232 344 L192 350 L154 342 L124 322 L100 292 L82 256 Z',
    label: [196, 288],
  },
  beirut: {
    d: 'M82 256 L100 292 L124 322 L154 342 L142 372 L116 388 L88 382 L70 358 L64 322 L68 286 Z',
    label: [104, 330],
  },
  baabda: {
    d: 'M116 388 L142 372 L154 342 L192 350 L232 344 L268 324 L296 292 L312 252 L322 292 L330 330 L314 368 L288 400 L252 422 L212 432 L172 428 L140 414 Z',
    label: [230, 378],
  },
};

/** Where a district has no shape yet, it still gets a node on the map. */
const FALLBACK_NODES = {
  chouf: [216, 476],
  saida: [188, 528],
  nabatieh: [232, 560],
  tyre: [186, 600],
  bekaa: [300, 400],
  zahle: [312, 340],
  tripoli: [128, 60],
  akkar: [150, 26],
};

export function LebanonMap({ districts = [], activeSlug, onSelect, className }) {
  const [hovered, setHovered] = useState(null);
  const bySlug = Object.fromEntries(districts.map((d) => [d.slug, d]));
  const maxGames = Math.max(...districts.map((d) => d.activeGames ?? 0), 1);

  const active = hovered ? bySlug[hovered] : null;

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox="0 0 400 690"
        className="h-auto w-full max-w-sm"
        role="img"
        aria-label={`Sports Fusion across ${districts.length} Lebanese districts`}
      >
        <defs>
          <linearGradient id="sea" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--bg-sunken)" />
            <stop offset="100%" stopColor="var(--bg-canvas)" />
          </linearGradient>
          <filter id="mapGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* The country */}
        <path
          d={LEBANON_OUTLINE}
          fill="url(#sea)"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />

        {/* Districts we operate in */}
        {Object.entries(DISTRICT_SHAPES).map(([slug, shape]) => {
          const district = bySlug[slug];
          if (!district) return null;

          const intensity = (district.activeGames ?? 0) / maxGames;
          const isActive = activeSlug === slug || hovered === slug;

          return (
            <g
              key={slug}
              onMouseEnter={() => setHovered(slug)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(slug)}
              onBlur={() => setHovered(null)}
              onClick={() => onSelect?.(district)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(district); }
              }}
              tabIndex={0}
              role="button"
              aria-label={`${district.name}: ${district.activeGames} games, ${compact((district.players ?? 0) * 32)} players`}
              className="cursor-pointer outline-none"
            >
              <path
                d={shape.d}
                fill="var(--accent)"
                fillOpacity={isActive ? 0.42 : 0.1 + intensity * 0.24}
                stroke="var(--accent)"
                strokeOpacity={isActive ? 1 : 0.45}
                strokeWidth={isActive ? 2.5 : 1.2}
                className="transition-all duration-200"
                filter={isActive ? 'url(#mapGlow)' : undefined}
              />
              <text
                x={shape.label[0]}
                y={shape.label[1]}
                textAnchor="middle"
                fontSize="15"
                fontWeight="700"
                fill="var(--fg-primary)"
                style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', pointerEvents: 'none' }}
              >
                {district.name}
              </text>
              <text
                x={shape.label[0]}
                y={shape.label[1] + 15}
                textAnchor="middle"
                fontSize="10"
                fill="var(--fg-secondary)"
                style={{ fontFamily: 'var(--font-sans)', pointerEvents: 'none' }}
              >
                {district.activeGames} {district.activeGames === 1 ? 'game' : 'games'}
              </text>
            </g>
          );
        })}

        {/* Districts on the roadmap. Shown dimmed so the map reads as a country,
            not only as the six places we have reached. */}
        {Object.entries(FALLBACK_NODES).map(([slug, [x, y]]) => {
          const district = bySlug[slug];
          return (
            <g key={slug} opacity={district ? 1 : 0.3}>
              <circle cx={x} cy={y} r="3.5" fill={district ? 'var(--accent)' : 'var(--border-strong)'} />
              {district && (
                <text
                  x={x} y={y - 8} textAnchor="middle" fontSize="11" fontWeight="700"
                  fill="var(--fg-primary)"
                  style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase' }}
                >
                  {district.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Hover card. On touch this appears on tap before navigation. */}
      {active && (
        <div className="pointer-events-none absolute left-1/2 top-3 w-48 -translate-x-1/2 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 shadow-[var(--shadow-lg)]">
          <p className="display text-xl leading-none">{active.name}</p>
          <dl className="mt-2 space-y-1 text-xs">
            {[
              ['Players', compact((active.players ?? 0) * 32)],
              ['Venues', active.venues],
              ['Occupancy', percent(active.occupancy ?? 0)],
              ['Active games', active.activeGames],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between">
                <dt className="text-[var(--fg-secondary)]">{label}</dt>
                <dd className="font-semibold tnum">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

export default LebanonMap;
