// The pitch.
//
// This is the component that decides whether Sports Fusion feels like football or like a
// booking system, so it gets the most care in the codebase.
//
// LAYOUT MODEL
// Positions are expressed as percentages of a half-pitch (0-100 across, 0-100 up the
// field from your own goal line). One formation map drives every team size, and the two
// sides are mirrored around the halfway line. Nothing is hard-coded to 11-a-side.
//
// ORIENTATION
// Desktop shows both halves side by side, which is how a tactical board looks. Mobile
// stacks them vertically, which is how a phone is held -- and stacking is not a fallback,
// it is a better use of a tall screen. The whole thing is one SVG with a viewBox, so it
// scales without a single media query on the markers themselves.
//
// ACCESSIBILITY
// An SVG of dots is meaningless to a screen reader, so the pitch carries a real
// <figcaption>-style description and each marker is a labelled, focusable element. The
// team sheet is also rendered as an ordered list for assistive tech and for print.

import { memo } from 'react';
import { cn } from '../../lib/cn.js';
import { toPlayerRating } from '../../lib/format.js';

/* --------------------------------------------------------------------------
   Formation coordinates: [x, y] as a percentage of one half.
   x: 0 = left touchline, 100 = right touchline
   y: 0 = own goal line,  100 = halfway line
   -------------------------------------------------------------------------- */
const SHAPES = {
  GK: [50, 7],
  LB: [16, 30], CB: [38, 26], RB: [84, 30], LWB: [12, 44], RWB: [88, 44],
  CDM: [50, 46], CM: [36, 58], CAM: [50, 68],
  LW: [16, 80], ST: [50, 88], RW: [84, 80], CF: [50, 78],
  SUB: [50, 50],
};

/** Spread duplicate positions apart so two CBs do not stack on one dot. */
function layout(players) {
  const byPosition = new Map();
  players.forEach((p) => {
    const key = p.position ?? 'CM';
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(p);
  });

  const placed = [];
  for (const [position, group] of byPosition) {
    const [baseX, baseY] = SHAPES[position] ?? SHAPES.CM;
    group.forEach((player, i) => {
      // Fan out horizontally around the base point; centre-backs become a pair, a lone
      // striker stays central.
      const offset = group.length === 1 ? 0 : (i - (group.length - 1) / 2) * (position === 'CB' ? 24 : 20);
      placed.push({
        ...player,
        x: Math.max(8, Math.min(92, baseX + offset)),
        y: baseY,
      });
    });
  }
  return placed;
}

const TEAM_COLOURS = {
  black: { fill: '#15181c', stroke: '#3d444d', text: '#ffffff', accent: '#8b95a1' },
  white: { fill: '#f2f5f4', stroke: '#c9d2ce', text: '#0a0f0d', accent: '#5c6b64' },
  red: { fill: '#c0392b', stroke: '#e05a4b', text: '#ffffff', accent: '#ffb3aa' },
  blue: { fill: '#1e5aa8', stroke: '#3d7fd4', text: '#ffffff', accent: '#a8c8f0' },
  yellow: { fill: '#e0b020', stroke: '#f0c74a', text: '#231a02', accent: '#7a5c08' },
  green: { fill: '#1f7a4d', stroke: '#2f9e68', text: '#ffffff', accent: '#a5e0c2' },
};

/* --------------------------------------------------------------------------
   Pitch markings. Drawn once, mirrored for the far half.
   -------------------------------------------------------------------------- */
function Markings({ width, height, vertical }) {
  const line = 'var(--pitch-line)';
  const edge = 'var(--pitch-edge)';

  // A half-pitch in "up the field" space; the parent flips it for the other side.
  const half = vertical ? height / 2 : width;
  const across = vertical ? width : height;

  const boxW = across * 0.58;
  const boxH = half * 0.18;
  const sixW = across * 0.28;
  const sixH = half * 0.075;

  return (
    <g fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke">
      <rect x="1" y="1" width={width - 2} height={height - 2} stroke={edge} rx="2" />

      {vertical ? (
        <>
          <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke={edge} />
          <circle cx={width / 2} cy={height / 2} r={across * 0.13} stroke={line} />
          <circle cx={width / 2} cy={height / 2} r="2.5" fill={line} stroke="none" />
          {[0, 1].map((side) => {
            const flip = side === 0 ? 1 : -1;
            const baseY = side === 0 ? 0 : height;
            return (
              <g key={side}>
                <rect x={(width - boxW) / 2} y={side === 0 ? 0 : height - boxH} width={boxW} height={boxH} stroke={line} />
                <rect x={(width - sixW) / 2} y={side === 0 ? 0 : height - sixH} width={sixW} height={sixH} stroke={line} />
                <circle cx={width / 2} cy={baseY + flip * half * 0.115} r="2" fill={line} stroke="none" />
                <path
                  d={`M ${(width - boxW) / 2 + boxW * 0.2} ${baseY + flip * boxH} A ${across * 0.13} ${across * 0.13} 0 0 ${side === 0 ? 0 : 1} ${(width + boxW) / 2 - boxW * 0.2} ${baseY + flip * boxH}`}
                  stroke={line}
                />
              </g>
            );
          })}
        </>
      ) : (
        <>
          <line x1={width / 2} y1="0" x2={width / 2} y2={height} stroke={edge} />
          <circle cx={width / 2} cy={height / 2} r={height * 0.13} stroke={line} />
          <circle cx={width / 2} cy={height / 2} r="2.5" fill={line} stroke="none" />
          {[0, 1].map((side) => {
            const flip = side === 0 ? 1 : -1;
            const baseX = side === 0 ? 0 : width;
            const bW = width * 0.09;
            const bH = height * 0.58;
            const sW = width * 0.037;
            const sH = height * 0.28;
            return (
              <g key={side}>
                <rect x={side === 0 ? 0 : width - bW} y={(height - bH) / 2} width={bW} height={bH} stroke={line} />
                <rect x={side === 0 ? 0 : width - sW} y={(height - sH) / 2} width={sW} height={sH} stroke={line} />
                <circle cx={baseX + flip * width * 0.058} cy={height / 2} r="2" fill={line} stroke="none" />
                <path
                  d={`M ${baseX + flip * bW} ${height / 2 - bH * 0.2} A ${height * 0.13} ${height * 0.13} 0 0 ${side === 0 ? 1 : 0} ${baseX + flip * bW} ${height / 2 + bH * 0.2}`}
                  stroke={line}
                />
              </g>
            );
          })}
        </>
      )}
    </g>
  );
}

/* --------------------------------------------------------------------------
   Player marker
   -------------------------------------------------------------------------- */
const PlayerMarker = memo(function PlayerMarker({
  player, colour, cx, cy, r, showRating, onSelect, selected, dimmed, interactive, index,
}) {
  const rating = toPlayerRating(player.ratingMu);
  const surname = (player.name ?? '').split(' ').slice(-1)[0];
  const Wrapper = interactive ? 'g' : 'g';

  return (
    // Outer group positions, inner group animates -- see the note in MatchPitch.jsx:
    // a CSS transform keyframe overrides the SVG transform attribute.
    <g transform={`translate(${cx} ${cy})`}>
    <Wrapper
      className={cn(
        'transition-opacity duration-200',
        dimmed && 'opacity-35',
        interactive && 'cursor-pointer'
      )}
      style={{
        // Stagger the entrance so the team appears position by position, the way a
        // broadcast graphic builds a formation.
        animation: `markerIn 380ms var(--ease-spring) ${index * 45}ms both`,
      }}
      onClick={interactive ? () => onSelect?.(player) : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect?.(player);
              }
            }
          : undefined
      }
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : 'img'}
      aria-label={`${player.name}, ${player.position}${rating ? `, rating ${rating}` : ''}${
        selected ? ', selected' : ''
      }`}
    >
      {selected && (
        <circle r={r + 6} fill="none" stroke="var(--accent)" strokeWidth="2.5" className="animate-pulse" />
      )}

      <circle r={r} fill={colour.fill} stroke={selected ? 'var(--accent)' : colour.stroke} strokeWidth="1.5" />

      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={r * 0.82}
        fontWeight="700"
        fill={colour.text}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {player.shirtNumber ?? index + 1}
      </text>

      {showRating && rating != null && (
        <g transform={`translate(${r * 0.75} ${-r * 0.75})`}>
          <circle r={r * 0.46} fill="var(--trophy)" stroke={colour.fill} strokeWidth="1.5" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={r * 0.5}
            fontWeight="700"
            fill="#231a02"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {rating.toFixed(1)}
          </text>
        </g>
      )}

      {/* Name plate. Solid backing so it stays legible over turf stripes. */}
      <g transform={`translate(0 ${r + 11})`}>
        <rect
          x={-Math.max(surname.length * 3.1, 16)}
          y={-6.5}
          width={Math.max(surname.length * 6.2, 32)}
          height={13}
          rx="3"
          fill="rgb(0 0 0 / 0.55)"
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="8.5"
          fontWeight="600"
          fill="#ffffff"
          style={{ fontFamily: 'var(--font-sans)' }}
        >
          {surname}
        </text>
      </g>
    </Wrapper>
    </g>
  );
});

/* --------------------------------------------------------------------------
   FootballPitch
   -------------------------------------------------------------------------- */

export function FootballPitch({
  teams = [],
  orientation = 'auto',
  showRatings = true,
  onSelectPlayer,
  selectedPlayerId,
  highlightTeamId,
  className,
  compact = false,
}) {
  // 'auto' resolves via CSS: the vertical pitch is rendered on small screens and the
  // horizontal one from `sm` up. Both are in the DOM but only one is displayed, which
  // avoids a resize listener and a hydration flash.
  const renderPitch = (vertical) => {
    const W = vertical ? 300 : 640;
    const H = vertical ? 620 : 400;
    const r = compact ? 12 : vertical ? 15 : 16;

    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto rounded-[var(--radius-lg)] overflow-visible"
        role="img"
        aria-label={
          teams.length === 2
            ? `Tactical view. ${teams[0].color} versus ${teams[1].color}.`
            : 'Tactical view'
        }
      >
        <defs>
          <clipPath id={`pitch-clip-${vertical ? 'v' : 'h'}`}>
            <rect x="0" y="0" width={W} height={H} rx="4" />
          </clipPath>
          <linearGradient id={`turf-${vertical ? 'v' : 'h'}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--pitch-turf-a)" />
            <stop offset="100%" stopColor="var(--pitch-turf-b)" />
          </linearGradient>
        </defs>

        <g clipPath={`url(#pitch-clip-${vertical ? 'v' : 'h'})`}>
          <rect width={W} height={H} fill={`url(#turf-${vertical ? 'v' : 'h'})`} />
          {/* Mown stripes: eight bands, very low contrast. */}
          {Array.from({ length: 8 }, (_, i) => (
            <rect
              key={i}
              x={vertical ? 0 : (W / 8) * i}
              y={vertical ? (H / 8) * i : 0}
              width={vertical ? W : W / 8}
              height={vertical ? H / 8 : H}
              fill="#ffffff"
              opacity={i % 2 === 0 ? 0.035 : 0}
            />
          ))}
          <Markings width={W} height={H} vertical={vertical} />
        </g>

        {teams.map((team, teamIndex) => {
          const colour = TEAM_COLOURS[team.color] ?? TEAM_COLOURS.black;
          const placed = layout(team.players ?? []);
          const dimmed = highlightTeamId && highlightTeamId !== team.id;

          return (
            <g key={team.id ?? team.color}>
              {placed.map((player, i) => {
                // Map half-pitch coordinates into the full pitch, mirroring team two.
                let cx;
                let cy;
                if (vertical) {
                  cx = teamIndex === 0 ? (player.x / 100) * W : W - (player.x / 100) * W;
                  cy = teamIndex === 0 ? (player.y / 100) * (H / 2) : H - (player.y / 100) * (H / 2);
                } else {
                  cx = teamIndex === 0 ? (player.y / 100) * (W / 2) : W - (player.y / 100) * (W / 2);
                  cy = teamIndex === 0 ? (player.x / 100) * H : H - (player.x / 100) * H;
                }

                return (
                  <PlayerMarker
                    key={player.id}
                    player={player}
                    colour={colour}
                    cx={cx}
                    cy={cy}
                    r={r}
                    index={i}
                    showRating={showRatings && !compact}
                    selected={selectedPlayerId === player.id}
                    dimmed={dimmed}
                    interactive={!!onSelectPlayer}
                    onSelect={onSelectPlayer}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
    );
  };

  return (
    <div className={cn('relative', className)}>
      <style>{`
        @keyframes markerIn {
          from { opacity: 0; transform: translate(var(--tx, 0), var(--ty, 0)) scale(0.4); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes markerIn { from { opacity: 1; } }
        }
      `}</style>

      {orientation !== 'horizontal' && (
        <div className={orientation === 'auto' ? 'sm:hidden' : ''}>{renderPitch(true)}</div>
      )}
      {orientation !== 'vertical' && (
        <div className={orientation === 'auto' ? 'hidden sm:block' : ''}>{renderPitch(false)}</div>
      )}

      {/* The same information as a list. Screen readers get a team sheet rather than a
          bag of coordinates, and this is what prints for the touchline. */}
      <div className="sr-only print:not-sr-only">
        {teams.map((team) => (
          <div key={team.id ?? team.color}>
            <h3>{team.color} team</h3>
            <ol>
              {(team.players ?? []).map((p) => (
                <li key={p.id}>
                  {p.position} — {p.name}
                  {p.ratingMu ? ` (rating ${toPlayerRating(p.ratingMu)})` : ''}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

export { TEAM_COLOURS };
export default FootballPitch;
