// The operational pitch.
//
// This is not the read-only pitch on the public game page — this is the workspace an
// admin runs a match from. It renders both sides in one formation-driven layout, shows
// payment state on every marker, and supports dragging players between slots and teams.
//
// DRAG: POINTER EVENTS, NOT A LIBRARY
//
// Re-checked the ecosystem: react-dnd last published 2022, @dnd-kit/core Dec 2024,
// @dnd-kit/react still 0.5.0, and Pragmatic Drag and Drop is built on the HTML5 DnD API
// which does not fire on touch. @neodrag/react is well maintained and tiny but does
// free positioning only — it has no concept of a drop target, which is the entire
// problem here.
//
// So: Pointer Events. One code path for mouse, touch and stylus, drop targets are the
// formation slots themselves, and it works on a phone at the side of a pitch — which is
// where this screen is actually used.

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useMediaQuery } from '../../hooks/index.js';
import { cn } from '../../lib/cn.js';
import { toPlayerRating } from '../../lib/format.js';
import { slotsFor } from '../../lib/formations.js';
import { TEAM_COLOURS } from './FootballPitch.jsx';

// Two orientations, because a phone is tall and a laptop is wide.
//
// On a 375px screen the landscape pitch renders 242px tall and each marker lands at
// about 19px -- unusable when tapping a player is the primary interaction. Turning the
// pitch upright gives the same twenty-two markers roughly 2.5x the area.
const LANDSCAPE = { w: 680, h: 440 };
const PORTRAIT = { w: 400, h: 660 };

/* --------------------------------------------------------------------------
   Pitch markings
   -------------------------------------------------------------------------- */
function Markings({ box, portrait }) {
  const { w, h } = box;
  const line = 'var(--pitch-line)';
  const edge = 'var(--pitch-edge)';

  if (portrait) {
    const boxW = w * 0.56;
    const boxH = h * 0.088;
    const sixW = w * 0.27;
    const sixH = h * 0.036;
    return (
      <g fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke">
        <rect x="1" y="1" width={w - 2} height={h - 2} stroke={edge} rx="3" />
        <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke={edge} />
        <circle cx={w / 2} cy={h / 2} r={w * 0.135} stroke={line} />
        <circle cx={w / 2} cy={h / 2} r="2.5" fill={line} stroke="none" />
        {[0, 1].map((side) => {
          const flip = side === 0 ? 1 : -1;
          const base = side === 0 ? 0 : h;
          return (
            <g key={side}>
              <rect x={(w - boxW) / 2} y={side === 0 ? 0 : h - boxH} width={boxW} height={boxH} stroke={line} />
              <rect x={(w - sixW) / 2} y={side === 0 ? 0 : h - sixH} width={sixW} height={sixH} stroke={line} />
              <circle cx={w / 2} cy={base + flip * h * 0.058} r="2" fill={line} stroke="none" />
              <path
                d={`M ${(w - boxW) / 2 + boxW * 0.22} ${base + flip * boxH} A ${w * 0.135} ${w * 0.135} 0 0 ${side === 0 ? 0 : 1} ${(w + boxW) / 2 - boxW * 0.22} ${base + flip * boxH}`}
                stroke={line}
              />
            </g>
          );
        })}
      </g>
    );
  }

  const boxW = w * 0.088;
  const boxH = h * 0.56;
  const sixW = w * 0.036;
  const sixH = h * 0.27;

  return (
    <g fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke">
      <rect x="1" y="1" width={w - 2} height={h - 2} stroke={edge} rx="3" />
      <line x1={w / 2} y1="0" x2={w / 2} y2={h} stroke={edge} />
      <circle cx={w / 2} cy={h / 2} r={h * 0.135} stroke={line} />
      <circle cx={w / 2} cy={h / 2} r="2.5" fill={line} stroke="none" />
      {[0, 1].map((side) => {
        const flip = side === 0 ? 1 : -1;
        const base = side === 0 ? 0 : w;
        return (
          <g key={side}>
            <rect x={side === 0 ? 0 : w - boxW} y={(h - boxH) / 2} width={boxW} height={boxH} stroke={line} />
            <rect x={side === 0 ? 0 : w - sixW} y={(h - sixH) / 2} width={sixW} height={sixH} stroke={line} />
            <circle cx={base + flip * w * 0.058} cy={h / 2} r="2" fill={line} stroke="none" />
            <path
              d={`M ${base + flip * boxW} ${h / 2 - boxH * 0.22} A ${h * 0.135} ${h * 0.135} 0 0 ${side === 0 ? 1 : 0} ${base + flip * boxW} ${h / 2 + boxH * 0.22}`}
              stroke={line}
            />
          </g>
        );
      })}
    </g>
  );
}

/* --------------------------------------------------------------------------
   Marker
   -------------------------------------------------------------------------- */
const Marker = memo(function Marker({
  player, colour, x, y, r, selected, dragging, onPointerDown, onSelect, index, showPayment,
}) {
  const rating = player.rating ?? toPlayerRating(player.ratingMu);
  const surname = (player.name ?? '').split(' ').slice(-1)[0];
  const unpaid = showPayment && player.paid === false;

  // Position and animation live on SEPARATE groups.
  //
  // For SVG, the `transform` presentation attribute and the CSS `transform` property are
  // the same property, and CSS wins. Putting a scale keyframe on the positioned element
  // therefore wipes out its translate for the length of the animation -- every marker
  // collapses to the pitch origin and flies out of the corner, and getBoundingClientRect
  // reports the wrong place while it does. Outer group positions, inner group animates.
  return (
    <g transform={`translate(${x} ${y})`}>
    <g
      className={cn('touch-none', dragging ? 'opacity-40' : 'cursor-grab active:cursor-grabbing')}
      style={{ animation: dragging ? 'none' : `markerIn 320ms var(--ease-spring) ${index * 32}ms both` }}
      onPointerDown={onPointerDown}
      onClick={() => onSelect?.(player)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(player); }
      }}
      tabIndex={0}
      role="button"
      aria-label={
        `${player.name}, ${player.position}` +
        (rating ? `, rating ${rating}` : '') +
        (showPayment ? (player.paid ? ', paid' : ', not paid') : '') +
        (player.goals ? `, ${player.goals} goals` : '')
      }
    >
      {/* Invisible hit area. The visible disc is sized for legibility; the tap target
          is sized for a thumb. Without this a marker is ~19px on a phone. */}
      <circle r={r * 1.75} fill="transparent" />

      {selected && (
        <circle r={r + 7} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      )}

      {/* Unpaid is a ring, not a tint — it survives both team colours and reads at a
          glance across twenty-two markers. */}
      {unpaid && (
        <circle r={r + 3.5} fill="none" stroke="var(--danger)" strokeWidth="2.5" strokeDasharray="3 3" />
      )}

      <circle r={r} fill={colour.fill} stroke={selected ? 'var(--accent)' : colour.stroke} strokeWidth="1.5" />

      <text
        textAnchor="middle" dominantBaseline="central"
        fontSize={r * 0.8} fontWeight="700" fill={colour.text}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {player.shirtNumber ?? index + 1}
      </text>

      {/* Goals ride on the marker: the number an admin is updating most during a match. */}
      {player.goals > 0 && (
        <g transform={`translate(${-r * 0.85} ${-r * 0.85})`}>
          <circle r={r * 0.44} fill="var(--accent)" stroke={colour.fill} strokeWidth="1.5" />
          <text
            textAnchor="middle" dominantBaseline="central"
            fontSize={r * 0.5} fontWeight="700" fill="#04160d"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {player.goals}
          </text>
        </g>
      )}

      {rating != null && (
        <g transform={`translate(${r * 0.85} ${-r * 0.85})`}>
          <circle r={r * 0.44} fill="var(--trophy)" stroke={colour.fill} strokeWidth="1.5" />
          <text
            textAnchor="middle" dominantBaseline="central"
            fontSize={r * 0.46} fontWeight="700" fill="#231a02"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {Number(rating).toFixed(1)}
          </text>
        </g>
      )}

      <g transform={`translate(0 ${r + 10})`}>
        <rect
          x={-Math.max(surname.length * 3.1, 15)} y={-6}
          width={Math.max(surname.length * 6.2, 30)} height={12} rx="3"
          fill="rgb(0 0 0 / 0.58)"
        />
        <text
          textAnchor="middle" dominantBaseline="central"
          fontSize="8" fontWeight="600" fill="#ffffff"
          style={{ fontFamily: 'var(--font-sans)' }}
        >
          {surname}
        </text>
      </g>
    </g>
    </g>
  );
});

/* --------------------------------------------------------------------------
   MatchPitch
   -------------------------------------------------------------------------- */

/**
 * A position with nobody in it.
 *
 * Drawn rather than left blank, because an empty half of a pitch is indistinguishable
 * from a broken one. The shape of the team is the useful information well before the
 * team is full: an admin looking at four defenders and two empty midfield slots knows
 * exactly what they are still short of.
 *
 * Also a drop target, so a player can be dragged into a gap rather than only swapped
 * with somebody who is already on.
 */
function EmptySlot({ slot, x, y, r, isHovered }) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      className="pointer-events-none"
      aria-hidden="true"
    >
      <circle
        r={r}
        fill="var(--pitch-empty-fill, rgb(255 255 255 / 0.05))"
        stroke={isHovered ? 'var(--accent)' : 'rgb(255 255 255 / 0.35)'}
        strokeWidth={isHovered ? 2.5 : 1.5}
        strokeDasharray={isHovered ? 'none' : '4 3'}
      />
      <text
        y={r * 0.32}
        textAnchor="middle"
        className="pointer-events-none select-none"
        fill="rgb(255 255 255 / 0.55)"
        style={{ fontSize: r * 0.62, fontWeight: 700, letterSpacing: '0.02em' }}
      >
        {slot.label}
      </text>
    </g>
  );
}

export function MatchPitch({
  teams = [],
  formation,
  teamSize,
  selectedPlayerId,
  onSelectPlayer,
  onMovePlayer,       // (playerId, { teamId, slotIndex }) => void
  interactive = false,
  showPayment = true,
  className,
}) {
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);        // { player, fromTeamId }
  const [hoverSlot, setHoverSlot] = useState(null); // { teamId, slotIndex }
  // Mirrors hoverSlot. State drives the render; the ref is what pointerup reads, so
  // the drop never depends on a batched update having landed.
  const hoverSlotRef = useRef(null);

  // One orientation is rendered, not both. Duplicating twenty-two markers in the DOM
  // would double the drag hit-testing work and the accessibility tree for no gain.
  const portrait = useMediaQuery('(max-width: 767px)');
  const box = portrait ? PORTRAIT : LANDSCAPE;

  const slots = useMemo(
    () => slotsFor(teamSize ?? 11, formation),
    [teamSize, formation]
  );

  /**
   * Map a half-pitch slot to full-pitch coordinates, mirroring the away side.
   *
   * Slot space is always "up the field from your own goal", so the same formation data
   * drives both orientations -- only the axis mapping changes.
   */
  const place = useCallback((slot, teamIndex) => {
    const { w, h } = box;
    if (portrait) {
      return teamIndex === 0
        ? { x: (slot.x / 100) * w, y: (slot.y / 100) * (h / 2) }
        : { x: w - (slot.x / 100) * w, y: h - (slot.y / 100) * (h / 2) };
    }
    return teamIndex === 0
      ? { x: (slot.y / 100) * (w / 2), y: (slot.x / 100) * h }
      : { x: w - (slot.y / 100) * (w / 2), y: h - (slot.x / 100) * h };
  }, [box, portrait]);

  /** Every drop target on the pitch, in screen-independent viewBox space. */
  const dropTargets = useMemo(
    () =>
      teams.flatMap((team, teamIndex) =>
        slots.map((slot, slotIndex) => ({
          teamId: team.id,
          teamIndex,
          slotIndex,
          slot,
          ...place(slot, teamIndex),
        }))
      ),
    [teams, slots, place]
  );

  /** Convert a client point into viewBox coordinates, so hit testing survives scaling. */
  const toViewBox = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * box.w,
      y: ((clientY - rect.top) / rect.height) * box.h,
    };
  }, [box]);

  const startDrag = (player, fromTeamId) => (event) => {
    if (!interactive) return;
    if (event.button != null && event.button !== 0) return;
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;

    const onMove = (e) => {
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 7) return;
      if (!moved) { moved = true; setDrag({ player, fromTeamId }); }

      const point = toViewBox(e.clientX, e.clientY);
      // Nearest slot within a sensible radius, so a slightly-off drop still lands.
      let best = null;
      let bestDistance = Infinity;
      for (const target of dropTargets) {
        const d = Math.hypot(target.x - point.x, target.y - point.y);
        if (d < bestDistance) { bestDistance = d; best = target; }
      }
      const next = bestDistance < hitRadius ? best : null;
      hoverSlotRef.current = next;
      setHoverSlot(next);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);

      // Read the drop target from a ref, not from a state updater.
      //
      // This used to nest setHoverSlot inside a setDrag updater to get at the latest
      // values. Updaters must be pure -- React is free to run them twice (it does, in
      // StrictMode), which meant the move could fire twice or, if the outer updater was
      // batched away, not at all. The ref is the current value by definition.
      const slot = hoverSlotRef.current;
      if (moved && slot) {
        onMovePlayer?.(player.id, { teamId: slot.teamId, slotIndex: slot.slotIndex });
      }

      hoverSlotRef.current = null;
      setDrag(null);
      setHoverSlot(null);
      // A drag that never moved is a tap, and the click handler covers that.
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // Portrait has a narrower viewBox, so the same on-screen size needs a bigger radius
  // in viewBox units.
  const markerRadius = portrait ? 21 : 17;
  const hitRadius = portrait ? 60 : 46;

  return (
    <div className={cn('relative', className)}>
      <style>{`
        @keyframes markerIn { from { opacity: 0; transform: scale(0.5); } }
        @media (prefers-reduced-motion: reduce) { @keyframes markerIn { from { opacity: 1; } } }
      `}</style>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${box.w} ${box.h}`}
        className="w-full h-auto touch-none select-none rounded-[var(--radius-lg)]"
        role="application"
        aria-label={`Tactical board. ${formation ?? ''}. ${
          interactive ? 'Drag a player to a position to move them.' : ''
        }`}
      >
        <defs>
          <clipPath id="match-pitch-clip">
            <rect x="0" y="0" width={box.w} height={box.h} rx="4" />
          </clipPath>
          <linearGradient id="match-turf" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--pitch-turf-a)" />
            <stop offset="100%" stopColor="var(--pitch-turf-b)" />
          </linearGradient>
        </defs>

        <g clipPath="url(#match-pitch-clip)">
          <rect width={box.w} height={box.h} fill="url(#match-turf)" />
          {Array.from({ length: 10 }, (_, i) => (
            <rect
              key={i}
              x={portrait ? 0 : (box.w / 10) * i}
              y={portrait ? (box.h / 10) * i : 0}
              width={portrait ? box.w : box.w / 10}
              height={portrait ? box.h / 10 : box.h}
              fill="#ffffff" opacity={i % 2 === 0 ? 0.035 : 0}
            />
          ))}
          <Markings box={box} portrait={portrait} />
        </g>

        {/* Empty slots show only while dragging: the pitch stays clean the rest of the
            time, and during a drag every legal destination is visible. */}
        {drag &&
          dropTargets.map((target) => {
            const occupied = teams[target.teamIndex]?.players?.[target.slotIndex];
            const isHover =
              hoverSlot?.teamId === target.teamId && hoverSlot?.slotIndex === target.slotIndex;
            return (
              <g key={`${target.teamId}-${target.slotIndex}`} transform={`translate(${target.x} ${target.y})`}>
                <circle
                  r={isHover ? markerRadius + 8 : markerRadius}
                  fill={isHover ? 'rgb(0 192 106 / 0.28)' : 'rgb(255 255 255 / 0.10)'}
                  stroke={isHover ? 'var(--accent)' : 'rgb(255 255 255 / 0.35)'}
                  strokeWidth={isHover ? 2.5 : 1.5}
                  strokeDasharray={occupied ? '4 3' : undefined}
                  className="transition-all duration-100"
                />
                <text
                  textAnchor="middle" dominantBaseline="central"
                  fontSize="8" fontWeight="700" fill="rgb(255 255 255 / 0.75)"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {target.slot.label}
                </text>
              </g>
            );
          })}

        {teams.map((team, teamIndex) => {
          const colour = TEAM_COLOURS[team.color] ?? TEAM_COLOURS.black;
          return (
            <g key={team.id ?? team.color}>
              {/* The positions nobody is standing in yet. Rendered first so a real
                  player always paints over an empty disc, never under it. */}
              {Array.from(
                { length: Math.max(0, slots.length - (team.players?.length ?? 0)) },
                (_, k) => {
                  const i = (team.players?.length ?? 0) + k;
                  const slot = slots[i];
                  if (!slot) return null;
                  const { x, y } = place(slot, teamIndex);
                  const hovered = hoverSlot?.teamId === team.id && hoverSlot?.slotIndex === i;
                  return (
                    <EmptySlot
                      key={`empty-${team.id ?? team.color}-${i}`}
                      slot={slot} x={x} y={y} r={markerRadius} isHovered={hovered}
                    />
                  );
                }
              )}

              {(team.players ?? []).map((player, i) => {
                const slot = slots[i] ?? slots[slots.length - 1];
                const { x, y } = place(slot, teamIndex);
                return (
                  <Marker
                    key={player.id}
                    player={player}
                    colour={colour}
                    x={x}
                    y={y}
                    r={markerRadius}
                    index={i}
                    selected={selectedPlayerId === player.id}
                    dragging={drag?.player?.id === player.id}
                    showPayment={showPayment}
                    onSelect={onSelectPlayer}
                    onPointerDown={startDrag(player, team.id)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* The same team sheet as text, for screen readers and for print. */}
      <div className="sr-only print:not-sr-only">
        {teams.map((team) => (
          <div key={team.id ?? team.color}>
            <h3>{team.color} team, {formation}</h3>
            <ol>
              {(team.players ?? []).map((p) => (
                <li key={p.id}>
                  {p.position} — {p.name}
                  {showPayment ? (p.paid ? ' (paid)' : ' (not paid)') : ''}
                  {p.goals ? `, ${p.goals} goals` : ''}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

export default MatchPitch;
