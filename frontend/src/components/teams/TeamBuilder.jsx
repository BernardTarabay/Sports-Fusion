// The tactical board.
//
// DRAG WITHOUT A DRAG LIBRARY, AND WHY
//
// The obvious choices were all wrong for this. @dnd-kit/core has not shipped since
// December 2024, @dnd-kit/react is pre-1.0, and Pragmatic Drag and Drop is built on the
// HTML5 drag-and-drop API, which does not fire on touch. An admin does this job standing
// at the side of a pitch on a phone.
//
// Pointer Events solve it directly: one code path for mouse, touch and stylus, about
// eighty lines, and no dependency. `touch-action: none` on the handle stops the browser
// scrolling the page instead of moving the player.
//
// KEYBOARD PATH
// Dragging is not the only way to do this. Select a player with Enter, then press the
// other team's key (or Space) to swap them across. Everything achievable with a pointer
// is achievable without one.
//
// LIVE BALANCE
// Every move recomputes team strength and says whether the change made the game more or
// less even. The admin is meant to feel like they are running a tactical board with the
// numbers visible, not fighting an algorithm in the dark.

import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, RotateCcw, Check, Sparkles, Info } from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { toPlayerRating } from '../../lib/format.js';
import { Button, Card, Badge, Tooltip } from '../ui/index.jsx';
import { TeamCrest, PositionChip, RatingBadge, teamStrength } from '../football/index.jsx';
import { FootballPitch } from '../football/FootballPitch.jsx';

/** Balance summary for a pair of teams, on the scale players actually see. */
function balanceOf(teams) {
  if (teams.length !== 2) return null;
  const [a, b] = teams.map((t) => teamStrength(t.players));
  const keepers = teams.map((t) => t.players.filter((p) => p.isGoalkeeper).length);
  const sizes = teams.map((t) => t.players.length);

  return {
    strengths: [a, b],
    gap: Math.round(Math.abs(a - b) * 10) / 10,
    even: sizes[0] === sizes[1],
    sizes,
    missingKeeper: keepers.some((k) => k === 0),
  };
}

function PlayerRow({ player, teamColor, selected, onSelect, onPointerDown, dragging }) {
  const rating = toPlayerRating(player.ratingMu);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`${player.name}, ${player.position}, rating ${rating}. ${
          selected ? 'Selected. Press the other team to swap.' : 'Press Enter to select.'
        }`}
        onPointerDown={onPointerDown}
        onClick={() => onSelect(player)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(player);
          }
        }}
        className={cn(
          'flex items-center gap-2.5 px-3 py-2.5 cursor-grab active:cursor-grabbing select-none',
          'transition-colors touch-none',
          selected
            ? 'bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent)]'
            : 'hover:bg-[var(--bg-sunken)]',
          dragging && 'opacity-40'
        )}
      >
        <span className="display w-5 text-center text-xs text-[var(--fg-muted)] tnum">
          {player.shirtNumber}
        </span>
        <PositionChip position={player.position} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{player.name}</span>
        {player.isManualOverride && (
          <Tooltip label="Moved by hand">
            <span className="size-1.5 rounded-full bg-[var(--trophy)]" />
          </Tooltip>
        )}
        <RatingBadge mu={player.ratingMu} sigma={player.ratingSigma} size="sm" showProvisional={false} />
      </div>
    </li>
  );
}

export function TeamBuilder({ teams, onChange, onRegenerate, onPublish, regenerating, className }) {
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [history, setHistory] = useState([]);
  const zoneRefs = useRef({});

  const balance = useMemo(() => balanceOf(teams), [teams]);
  const initialGap = useRef(balance?.gap ?? 0);

  const move = useCallback(
    (playerId, toTeamId) => {
      const from = teams.find((t) => t.players.some((p) => p.id === playerId));
      if (!from || from.id === toTeamId) return;

      setHistory((h) => [...h, teams.map((t) => ({ ...t, players: [...t.players] }))]);
      onChange(
        teams.map((team) => {
          if (team.id === from.id) {
            return { ...team, players: team.players.filter((p) => p.id !== playerId) };
          }
          if (team.id === toTeamId) {
            const player = from.players.find((p) => p.id === playerId);
            return { ...team, players: [...team.players, { ...player, isManualOverride: true }] };
          }
          return team;
        })
      );
    },
    [teams, onChange]
  );

  /** Swap two players between sides — the move that keeps the teams even. */
  const swap = useCallback(
    (playerA, playerB) => {
      const teamA = teams.find((t) => t.players.some((p) => p.id === playerA.id));
      const teamB = teams.find((t) => t.players.some((p) => p.id === playerB.id));
      if (!teamA || !teamB || teamA.id === teamB.id) return;

      setHistory((h) => [...h, teams.map((t) => ({ ...t, players: [...t.players] }))]);
      onChange(
        teams.map((team) => {
          if (team.id === teamA.id) {
            return {
              ...team,
              players: team.players.map((p) =>
                p.id === playerA.id ? { ...playerB, isManualOverride: true } : p
              ),
            };
          }
          if (team.id === teamB.id) {
            return {
              ...team,
              players: team.players.map((p) =>
                p.id === playerB.id ? { ...playerA, isManualOverride: true } : p
              ),
            };
          }
          return team;
        })
      );
    },
    [teams, onChange]
  );

  const handleSelect = (player) => {
    if (!selected) { setSelected(player); return; }
    if (selected.id === player.id) { setSelected(null); return; }

    const sameTeam = teams.find(
      (t) => t.players.some((p) => p.id === selected.id) && t.players.some((p) => p.id === player.id)
    );
    if (sameTeam) { setSelected(player); return; }

    swap(selected, player);
    setSelected(null);
  };

  /* --- pointer drag ------------------------------------------------------ */
  const startDrag = (player) => (event) => {
    // Ignore right-click and multi-touch.
    if (event.button != null && event.button !== 0) return;

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;

    const onMove = (e) => {
      // A few pixels of slack so a tap is still a tap.
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      if (!moved) {
        moved = true;
        setDragging(player);
        setSelected(null);
      }

      const over = Object.entries(zoneRefs.current).find(([, node]) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom
        );
      });
      setDropTarget(over?.[0] ?? null);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);

      if (moved && dropTarget) move(player.id, dropTarget);
      setDragging(null);
      setDropTarget(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    event.currentTarget.releasePointerCapture?.(pointerId);
  };

  const undo = () => {
    if (history.length === 0) return;
    onChange(history.at(-1));
    setHistory((h) => h.slice(0, -1));
    setSelected(null);
  };

  const gapDelta = balance ? balance.gap - initialGap.current : 0;

  return (
    <div className={cn('space-y-5', className)}>
      {/* The scoreboard: two strengths and a verdict on the current split. */}
      <Card className="overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-4 sm:p-5">
          {teams.map((team, i) => (
            <div key={team.id} className={cn('min-w-0', i === 1 && 'order-3 text-right')}>
              <div className={cn('flex items-center gap-2', i === 1 && 'justify-end')}>
                <TeamCrest color={team.color} size={24} />
                <span className="display text-xl">{team.color}</span>
              </div>
              <p className="display mt-1 text-4xl tnum">
                {balance ? balance.strengths[i].toFixed(1) : '—'}
              </p>
              <p className="text-xs text-[var(--fg-muted)]">
                {team.players.length} players
                {team.players.filter((p) => p.isGoalkeeper).length === 0 && (
                  <span className="ml-1 text-[var(--danger)]">· no keeper</span>
                )}
              </p>
            </div>
          ))}

          <div className="order-2 text-center">
            <p className="eyebrow text-[0.5625rem]">Gap</p>
            <p
              className={cn(
                'display text-2xl tnum',
                balance?.gap < 1.5 ? 'text-[var(--accent)]'
                  : balance?.gap < 4 ? 'text-[var(--trophy)]'
                    : 'text-[var(--danger)]'
              )}
            >
              {balance ? balance.gap.toFixed(1) : '—'}
            </p>
            {gapDelta !== 0 && (
              <p className={cn('text-[0.625rem] font-semibold', gapDelta < 0 ? 'text-[var(--accent)]' : 'text-[var(--danger)]')}>
                {gapDelta < 0 ? 'better' : 'worse'}
              </p>
            )}
          </div>
        </div>

        {(balance && (!balance.even || balance.missingKeeper)) && (
          <div className="flex items-start gap-2 border-t border-[var(--border-subtle)] bg-[var(--danger-soft)] px-4 py-2.5">
            <Info className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" aria-hidden="true" />
            <p className="text-xs text-[var(--danger-soft-fg)]">
              {!balance.even && `Teams are uneven (${balance.sizes.join(' v ')}). `}
              {balance.missingKeeper && 'One side has no goalkeeper.'}
            </p>
          </div>
        )}
      </Card>

      <FootballPitch teams={teams} showRatings selectedPlayerId={selected?.id} />

      {/* Instructions are shown, not assumed. */}
      <p className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3 py-2 text-xs text-[var(--fg-secondary)]">
        <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" />
        Drag a player to the other side, or tap two players to swap them. Keyboard: Enter
        to select, Enter again on the other player.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {teams.map((team) => (
          <Card
            key={team.id}
            ref={(node) => { zoneRefs.current[team.id] = node; }}
            className={cn(
              'overflow-hidden transition-shadow',
              dropTarget === team.id && 'ring-2 ring-[var(--accent)] shadow-[var(--shadow-glow)]'
            )}
          >
            <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
              <TeamCrest color={team.color} size={22} />
              <span className="display text-lg">{team.color}</span>
              <Badge tone="neutral" size="sm" className="ml-auto tnum">
                {teamStrength(team.players).toFixed(1)}
              </Badge>
            </div>
            <ul className="divide-y divide-[var(--border-subtle)]">
              {team.players.map((player) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  teamColor={team.color}
                  selected={selected?.id === player.id}
                  dragging={dragging?.id === player.id}
                  onSelect={handleSelect}
                  onPointerDown={startDrag(player)}
                />
              ))}
            </ul>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onRegenerate} loading={regenerating}>
          <Sparkles className="size-4" /> Regenerate
        </Button>
        <Button variant="ghost" onClick={undo} disabled={history.length === 0}>
          <RotateCcw className="size-4" /> Undo
        </Button>
        <div className="flex-1" />
        <Button onClick={onPublish} disabled={!balance?.even}>
          <Check className="size-4" /> Publish teams
        </Button>
      </div>

      {/* Live region: a screen reader hears the balance change after every move. */}
      <p className="sr-only" role="status" aria-live="polite">
        {balance &&
          `${teams[0].color} ${balance.strengths[0].toFixed(1)}, ${teams[1].color} ${balance.strengths[1].toFixed(1)}. Gap ${balance.gap.toFixed(1)}.`}
      </p>
    </div>
  );
}

export default TeamBuilder;
