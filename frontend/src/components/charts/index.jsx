// Charts.
//
// Hand-rolled SVG rather than a charting library. Recharts is 7.2MB unpacked and every
// visualisation this product needs is a line, a set of bars, or a ring. Writing them
// directly costs about 200 lines, ships nothing extra to a phone on a Beirut mobile
// connection, and lets each chart carry the broadcast look rather than a library's.
//
// Every chart here is also readable without sight: each renders an accessible summary,
// and the underlying numbers are always available as text nearby.

import { useId, useMemo } from 'react';
import { cn } from '../../lib/cn.js';

const nice = (n) => Math.round(n * 100) / 100;

/* ==========================================================================
   Sparkline / area — rating history, occupancy trend
   ========================================================================== */

export function Sparkline({
  data = [],
  height = 64,
  className,
  tone = 'var(--accent)',
  fill = true,
  showLast = true,
  label,
}) {
  const id = useId();
  const values = data.map((d) => (typeof d === 'number' ? d : d.value));

  const geometry = useMemo(() => {
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    // Breathing room top and bottom so the line never touches the edge.
    const pad = span * 0.15;
    const lo = min - pad;
    const hi = max + pad;

    const points = values.map((v, i) => ({
      x: (i / (values.length - 1)) * 100,
      y: 100 - ((v - lo) / (hi - lo)) * 100,
    }));

    // Catmull-Rom style smoothing keeps the line organic without overshooting.
    const path = points.reduce((d, p, i, arr) => {
      if (i === 0) return `M ${p.x} ${p.y}`;
      const prev = arr[i - 1];
      const cx = (prev.x + p.x) / 2;
      return `${d} C ${cx} ${prev.y}, ${cx} ${p.y}, ${p.x} ${p.y}`;
    }, '');

    return { points, path, min, max };
  }, [values]);

  if (!geometry) {
    return <div className={cn('h-16 grid place-items-center text-xs text-[var(--fg-muted)]', className)}>Not enough data yet</div>;
  }

  const last = geometry.points.at(-1);

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ height }}
        className="w-full overflow-visible"
        role="img"
        aria-label={label ?? `Trend from ${nice(values[0])} to ${nice(values.at(-1))}`}
      >
        <defs>
          <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity="0.28" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </linearGradient>
        </defs>

        {fill && (
          <path d={`${geometry.path} L 100 100 L 0 100 Z`} fill={`url(#spark-${id})`} stroke="none" />
        )}
        <path
          d={geometry.path}
          fill="none"
          stroke={tone}
          strokeWidth="2"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {showLast && (
          <circle cx={last.x} cy={last.y} r="3" fill={tone} stroke="var(--bg-surface)" strokeWidth="2"
            vectorEffect="non-scaling-stroke" />
        )}
      </svg>
    </div>
  );
}

/* ==========================================================================
   BarSeries — occupancy by week, points by month
   ========================================================================== */

export function BarSeries({ data = [], height = 120, className, tone = 'var(--accent)', formatValue, label }) {
  const max = Math.max(...data.map((d) => d.value), 0.0001);

  return (
    <div className={cn('space-y-2', className)}>
      <div
        className="flex items-end gap-1.5"
        style={{ height }}
        role="img"
        aria-label={label ?? `Bar chart, ${data.length} points, peak ${nice(max)}`}
      >
        {data.map((d, i) => (
          <div key={d.label ?? i} className="group relative flex-1 flex flex-col justify-end h-full">
            <div
              className="w-full rounded-t-[3px] transition-[height] duration-500 ease-[var(--ease-out-quint)]"
              style={{
                height: `${(d.value / max) * 100}%`,
                background: d.highlight ? 'var(--trophy)' : tone,
                opacity: d.highlight ? 1 : 0.85,
                transitionDelay: `${i * 25}ms`,
              }}
            />
            {/* Value on hover, so the chart stays clean but the number is reachable. */}
            <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 rounded bg-[var(--fg-primary)] px-1.5 py-0.5 text-[0.625rem] font-semibold text-[var(--bg-surface)] opacity-0 transition-opacity group-hover:opacity-100 tnum whitespace-nowrap">
              {formatValue ? formatValue(d.value) : nice(d.value)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">
        {data.map((d, i) => (
          <span key={d.label ?? i} className="flex-1 text-center text-[0.625rem] text-[var(--fg-muted)] truncate">
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ==========================================================================
   RadialProgress — reward progress, attendance rate
   ========================================================================== */

export function RadialProgress({
  value, max = 100, size = 120, thickness = 10, tone = 'var(--accent)', className, children, label,
}) {
  const pct = Math.max(0, Math.min(1, value / max));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className={cn('relative inline-grid place-items-center', className)} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        className="-rotate-90"
        role="img"
        aria-label={label ?? `${Math.round(pct * 100)} percent`}
      >
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="var(--bg-sunken)" strokeWidth={thickness}
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={tone} strokeWidth={thickness} strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 800ms var(--ease-out-quint)' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/* ==========================================================================
   RatingChart — rating history with the uncertainty band

   The band is the honest part. A rating of 1642 means something different when the
   system has watched 47 games than when it has watched three, and the shape of the
   band narrowing over a season is the clearest way to show that without saying
   "standard deviation" to someone who came here to play football.
   ========================================================================== */

export function RatingChart({ history = [], height = 200, className }) {
  const id = useId();

  const geometry = useMemo(() => {
    if (history.length < 2) return null;
    const los = history.map((h) => h.mu - h.sigma);
    const his = history.map((h) => h.mu + h.sigma);
    const min = Math.min(...los);
    const max = Math.max(...his);
    const span = max - min || 1;

    const x = (i) => (i / (history.length - 1)) * 100;
    const y = (v) => 100 - ((v - min) / span) * 100;

    const line = history.map((h, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(h.mu)}`).join(' ');
    const band = [
      ...history.map((h, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(h.mu + h.sigma)}`),
      ...[...history].reverse().map((h, i) => `L ${x(history.length - 1 - i)} ${y(h.mu - h.sigma)}`),
      'Z',
    ].join(' ');

    return { line, band, min, max, x, y };
  }, [history]);

  if (!geometry) {
    return (
      <div className={cn('grid place-items-center py-10 text-sm text-[var(--fg-muted)]', className)}>
        Play a few games and your rating history appears here.
      </div>
    );
  }

  const first = history[0];
  const last = history.at(-1);
  const change = last.mu - first.mu;

  return (
    <div className={className}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ height }}
        className="w-full overflow-visible"
        role="img"
        aria-label={`Rating history over ${history.length} points. ${
          change > 0 ? 'Up' : change < 0 ? 'Down' : 'Level'
        } ${Math.abs(Math.round(change))} points overall. Confidence ${
          last.sigma < first.sigma ? 'improving' : 'unchanged'
        }.`}
      >
        <defs>
          <linearGradient id={`band-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.06" />
          </linearGradient>
        </defs>

        <path d={geometry.band} fill={`url(#band-${id})`} stroke="none" />
        <path
          d={geometry.line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={geometry.x(history.length - 1)}
          cy={geometry.y(last.mu)}
          r="4"
          fill="var(--accent)"
          stroke="var(--bg-surface)"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="mt-3 flex items-center justify-between text-xs text-[var(--fg-secondary)]">
        <span>The shaded band is how sure we are. It narrows as you play.</span>
        <span className={cn('font-semibold tnum', change > 0 ? 'text-[var(--accent)]' : change < 0 ? 'text-[var(--danger)]' : '')}>
          {change > 0 ? '+' : ''}{Math.round(change)}
        </span>
      </div>
    </div>
  );
}

/* ==========================================================================
   Donut — district split, position breakdown
   ========================================================================== */

export function Donut({ segments = [], size = 140, thickness = 18, className, centre }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className={cn('relative inline-grid place-items-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" role="img"
        aria-label={segments.map((s) => `${s.label}: ${Math.round((s.value / total) * 100)}%`).join(', ')}
      >
        {segments.map((seg) => {
          const length = (seg.value / total) * circumference;
          const circle = (
            <circle
              key={seg.label}
              cx={size / 2} cy={size / 2} r={radius}
              fill="none" stroke={seg.color} strokeWidth={thickness}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return circle;
        })}
      </svg>
      {centre && <div className="absolute inset-0 grid place-items-center text-center">{centre}</div>}
    </div>
  );
}
