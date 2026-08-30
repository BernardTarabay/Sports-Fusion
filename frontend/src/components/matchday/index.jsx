// Matchday operational controls.
//
// Everything here is designed for one situation: an admin holding a phone, standing on
// grass, at night, with twenty-two people wanting to start. That means big targets, no
// nested menus, and every action one tap from the pitch.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, X, Minus, Plus, Trophy, Wallet, UserMinus, ChevronLeft, ChevronRight,
  CircleDot, AlertTriangle, Users, Clock, Lock,
} from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { toPlayerRating, time, shortDay, dayNumber, monthName } from '../../lib/format.js';
import { Avatar, Badge, Button, Card, Input, Modal, Select } from '../ui/index.jsx';
import { PositionChip, TeamCrest } from '../football/index.jsx';
import { formationsFor, describeFormation } from '../../lib/formations.js';

/* ==========================================================================
   Stepper — the control an admin taps most during a match.

   56px targets. A goal is recorded with a thumb, at night, without looking closely.
   ========================================================================== */

function Stepper({ label, value, onChange, min = 0, max = 20, tone = 'accent' }) {
  return (
    <div>
      <p className="eyebrow mb-1.5 text-[0.625rem]">{label}</p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="grid size-14 shrink-0 place-items-center rounded-[var(--radius-md)] border border-[var(--border-default)] text-[var(--fg-secondary)] transition-colors hover:bg-[var(--bg-sunken)] active:scale-95 disabled:opacity-35"
          aria-label={`Decrease ${label}`}
        >
          <Minus className="size-5" />
        </button>

        <span
          className={cn(
            'display grid h-14 flex-1 place-items-center rounded-[var(--radius-md)] bg-[var(--bg-sunken)] text-3xl tnum',
            value > 0 && tone === 'accent' && 'text-[var(--accent)]'
          )}
          aria-live="polite"
        >
          {value}
        </span>

        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="grid size-14 shrink-0 place-items-center rounded-[var(--radius-md)] border border-[var(--border-default)] text-[var(--fg-secondary)] transition-colors hover:bg-[var(--bg-sunken)] active:scale-95 disabled:opacity-35"
          aria-label={`Increase ${label}`}
        >
          <Plus className="size-5" />
        </button>
      </div>
    </div>
  );
}

/* ==========================================================================
   Attendance

   Three states, and the default matters: everyone who registered is assumed to have
   turned up. Marking 22 people present is data entry that will not happen past week
   three; flagging the two who did not is a five-second job. So the bulk action is
   "everyone was here" and the per-player control exists for the exceptions.

   Attendance is not cosmetic -- it gates points and it feeds the reliability figure a
   player is judged on, so it needs to be quick enough to actually get recorded.
   ========================================================================== */

const ATTENDANCE_STATES = [
  { key: 'attended', label: 'Here', tone: 'var(--accent)', Icon: Check },
  { key: 'late', label: 'Late', tone: 'var(--trophy)', Icon: Clock },
  { key: 'no_show', label: 'No show', tone: 'var(--danger)', Icon: X },
];

export function AttendanceToggle({ value, onChange, size = 'md', className }) {
  return (
    <div
      role="radiogroup"
      aria-label="Attendance"
      className={cn('inline-flex gap-1 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] p-1', className)}
    >
      {ATTENDANCE_STATES.map(({ key, label, tone, Icon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            role="radio"
            aria-checked={active}
            // Tapping the active state clears it, so "not recorded yet" stays reachable.
            onClick={() => onChange(active ? null : key)}
            title={label}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] font-semibold transition-colors active:scale-95',
              size === 'sm' ? 'h-9 min-w-9 px-2 text-xs' : 'h-11 flex-1 px-3 text-sm',
              !active && 'text-[var(--fg-muted)] hover:text-[var(--fg-primary)]'
            )}
            style={active ? { background: tone, color: key === 'late' ? '#231a02' : '#fff' } : undefined}
          >
            <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden="true" />
            <span className={size === 'sm' ? 'sr-only sm:not-sr-only' : ''}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AttendancePanel({
  roster = [], onSet, onMarkAll, kickoffAt, className, busy,
}) {
  const [query, setQuery] = useState('');

  const counts = useMemo(
    () =>
      roster.reduce(
        (acc, r) => ({ ...acc, [r.attendance ?? 'unrecorded']: (acc[r.attendance ?? 'unrecorded'] ?? 0) + 1 }),
        {}
      ),
    [roster]
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return roster;
    const needle = query.trim().toLowerCase();
    return roster.filter((r) => r.name.toLowerCase().includes(needle));
  }, [roster, query]);

  const unrecorded = counts.unrecorded ?? 0;
  const beforeKickoff = kickoffAt && new Date(kickoffAt) > new Date();

  if (roster.length === 0) {
    return (
      <Card className={className}>
        <EmptyStateInline
          title="Nobody registered yet"
          description="Attendance appears once players have joined."
        />
      </Card>
    );
  }

  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="min-w-0">
          <p className="eyebrow text-[0.625rem]">Attendance</p>
          <p className="mt-0.5 text-sm tnum">
            {counts.attended ?? 0} here
            {counts.late ? <span className="text-[var(--trophy)]"> · {counts.late} late</span> : null}
            {counts.no_show ? <span className="text-[var(--danger)]"> · {counts.no_show} no-show</span> : null}
            {unrecorded > 0 && (
              <span className="text-[var(--fg-muted)]"> · {unrecorded} not recorded</span>
            )}
          </p>
        </div>

        <Button
          size="sm"
          variant={unrecorded > 0 ? 'primary' : 'secondary'}
          className="ml-auto"
          loading={busy}
          onClick={() => onMarkAll('attended')}
        >
          <Check className="size-4" /> Everyone was here
        </Button>
      </div>

      {beforeKickoff && (
        <p className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-4 py-2 text-xs text-[var(--fg-secondary)]">
          This game has not kicked off yet. You can mark people in as they arrive.
        </p>
      )}

      {roster.length > 10 && (
        <div className="border-b border-[var(--border-subtle)] px-4 py-2.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a player"
            className="h-9 text-sm"
            aria-label="Find a player"
          />
        </div>
      )}

      <ul className="divide-y divide-[var(--border-subtle)]">
        {filtered.map((entry) => (
          <li key={entry.playerId} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar name={entry.name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{entry.name}</p>
              <p className="flex items-center gap-1.5 text-[0.6875rem] text-[var(--fg-muted)]">
                <PositionChip position={entry.position} size="sm" />
                {entry.paid === false && <span className="text-[var(--danger)]">unpaid</span>}
              </p>
            </div>
            <AttendanceToggle
              size="sm"
              value={entry.attendance}
              onChange={(status) => onSet(entry.playerId, status)}
            />
          </li>
        ))}
      </ul>

      {filtered.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-[var(--fg-muted)]">
          Nobody matches &ldquo;{query}&rdquo;.
        </p>
      )}
    </Card>
  );
}

/** Small inline empty state, so this module does not depend on the page-level one. */
function EmptyStateInline({ title, description }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="display text-lg">{title}</p>
      <p className="mt-1 text-sm text-[var(--fg-secondary)]">{description}</p>
    </div>
  );
}

/* ==========================================================================
   PlayerControlPanel

   Opens from a marker on the pitch. Everything about one player in one sheet:
   payment, attendance, goals, assists, rating, MOTM, removal. No navigation.
   ========================================================================== */

export function PlayerControlPanel({
  open, onOpenChange, player, teamColor, isMotm, onPatch, onTogglePaid, onToggleMotm, onRemove,
  pairInsight,
}) {
  if (!player) return null;

  const rating = player.rating ?? toPlayerRating(player.ratingMu);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={player.name}
      description={`${player.position}${teamColor ? ` · ${teamColor}` : ''}`}
      size="sm"
    >
      <div className="space-y-5">
        {/* Payment first. It is the reason this panel exists. */}
        <button
          onClick={() => onTogglePaid(!player.paid)}
          className={cn(
            'flex w-full items-center gap-3 rounded-[var(--radius-md)] border-2 p-4 text-left transition-colors active:scale-[0.98]',
            player.paid
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-dashed border-[var(--danger)] bg-[var(--danger-soft)]'
          )}
          aria-pressed={!!player.paid}
        >
          <span
            className={cn(
              'grid size-11 shrink-0 place-items-center rounded-full',
              player.paid ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'bg-[var(--danger)] text-white'
            )}
          >
            {player.paid ? <Check className="size-6" /> : <Wallet className="size-5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="display block text-2xl">
              {player.paid ? 'Paid' : 'Not paid'}
            </span>
            <span className="text-xs text-[var(--fg-secondary)]">
              {player.paid ? 'Tap to undo' : 'Tap to mark as paid'}
            </span>
          </span>
        </button>

        <div>
          <p className="eyebrow mb-1.5 text-[0.625rem]">Attendance</p>
          <AttendanceToggle
            value={player.attendance}
            onChange={(attendance) => onPatch({ attendance })}
            className="w-full"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Stepper
            label="Goals"
            value={player.goals ?? 0}
            onChange={(goals) => onPatch({ goals })}
          />
          <Stepper
            label="Assists"
            value={player.assists ?? 0}
            onChange={(assists) => onPatch({ assists })}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <p className="eyebrow text-[0.625rem]">Match rating</p>
            <span className="display text-xl tnum">
              {rating != null ? Number(rating).toFixed(1) : '—'}
            </span>
          </div>
          <input
            type="range"
            min="1" max="10" step="0.1"
            value={rating ?? 6.5}
            onChange={(e) => onPatch({ rating: Number(e.target.value) })}
            className="h-11 w-full accent-[var(--accent)]"
            aria-label="Match rating"
          />
          <div className="flex justify-between text-[0.625rem] text-[var(--fg-muted)]">
            <span>1</span><span>5</span><span>10</span>
          </div>
        </div>

        <button
          onClick={onToggleMotm}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] border-2 py-3.5 font-semibold transition-colors active:scale-[0.98]',
            isMotm
              ? 'border-[var(--trophy)] bg-[var(--trophy)] text-[#231a02]'
              : 'border-[var(--border-default)] text-[var(--fg-secondary)] hover:border-[var(--trophy)]'
          )}
          aria-pressed={isMotm}
        >
          <Trophy className="size-5" />
          {isMotm ? 'Man of the Match' : 'Award Man of the Match'}
        </button>

        {/* Why the balancer put this player here. Only shown when there is something
            worth saying. */}
        {pairInsight && (
          <div className="rounded-[var(--radius-md)] bg-[var(--bg-sunken)] p-3">
            <p className="eyebrow mb-1 text-[0.5625rem]">Team history</p>
            <p className="text-sm">
              <span className="font-medium">{pairInsight.withName}</span>
              {' — played together '}
              <span className="font-semibold tnum">{pairInsight.together}</span>
              {pairInsight.together === 1 ? ' time' : ' times'}
              {pairInsight.lastTogetherGamesAgo != null && (
                <>, last {pairInsight.lastTogetherGamesAgo === 0 ? 'game' : `${pairInsight.lastTogetherGamesAgo} games ago`}</>
              )}
              .
            </p>
          </div>
        )}

        {onRemove && (
          <Button variant="ghost" className="w-full text-[var(--danger)]" onClick={onRemove}>
            <UserMinus className="size-4" /> Remove from this game
          </Button>
        )}
      </div>
    </Modal>
  );
}

/* ==========================================================================
   ScoreControl

   Above the pitch, always visible.

   THE SCORE IS NOT A NUMBER YOU SET
   ---------------------------------
   This used to be two steppers wired to a setScore() that the live backend rejects
   outright -- tapping + produced an uncaught promise rejection in the console and no
   visible response at all -- reading a `game.result.score.black` the server has never
   sent, so the scoreboard on the main operational screen was frozen at 0 - 0 while
   goals were being recorded underneath it.

   Both halves of that were the same mistake. On the server the score is a fold over
   goal events, deliberately, so that the header and the scorer list cannot disagree.
   A setter could only ever contradict the scorers. So + does what it always meant:
   it asks who scored, and records the goal against them. The score follows.

   - reads the live per-team score the projection actually returns
   - works for however many teams the balancer made, not just black and white
   - the minus removes that team's most recent goal, which is what an admin
     correcting their own last tap wants
   ========================================================================== */

export function ScoreControl({ teams = [], onScored, onUnscored, editable = true, className }) {
  const [picking, setPicking] = useState(null);

  const sides = teams.length > 0
    ? teams
    // Before the balancer has run there are no teams, but the header still has to draw
    // something. Two placeholders, not editable, rather than an empty bar.
    : [{ id: 'a', color: 'black', score: 0, players: [] },
       { id: 'b', color: 'white', score: 0, players: [] }];

  const scorers = (team) =>
    [...(team.players ?? [])].sort((a, b) => (b.goals ?? 0) - (a.goals ?? 0));

  return (
    <>
      <div className={cn('flex items-center justify-center gap-4 sm:gap-8', className)}>
        {sides.map((team, i) => (
          <Fragment key={team.id}>
            {i > 0 && <span className="display pb-6 text-2xl text-[var(--fg-muted)]">—</span>}
            <div className="flex flex-col items-center gap-1.5">
              <div className="flex items-center gap-1.5">
                <TeamCrest color={team.color} size={20} />
                <span className="display text-sm capitalize tracking-wide">{team.color}</span>
              </div>

              <div className="flex items-center gap-1">
                {editable && team.players?.length > 0 && (
                  <button
                    onClick={() => setPicking({ team, mode: 'remove' })}
                    disabled={(team.score ?? 0) === 0}
                    className="grid size-9 pointer-coarse:size-11 place-items-center rounded-[var(--radius-sm)] text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-sunken)] active:scale-90 disabled:opacity-30"
                    aria-label={`Remove a ${team.color} goal`}
                  >
                    <Minus className="size-4" />
                  </button>
                )}

                <span
                  className="display w-14 text-center text-5xl tnum sm:text-6xl"
                  aria-live="polite"
                  aria-label={`${team.color} ${team.score ?? 0}`}
                >
                  {team.score ?? 0}
                </span>

                {editable && team.players?.length > 0 && (
                  <button
                    onClick={() => setPicking({ team, mode: 'add' })}
                    className="grid size-9 pointer-coarse:size-11 place-items-center rounded-[var(--radius-sm)] text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-sunken)] active:scale-90"
                    aria-label={`Add a ${team.color} goal`}
                  >
                    <Plus className="size-4" />
                  </button>
                )}
              </div>
            </div>
          </Fragment>
        ))}
      </div>

      <Modal
        open={!!picking}
        onOpenChange={(open) => !open && setPicking(null)}
        title={picking?.mode === 'add' ? 'Who scored?' : 'Whose goal comes off?'}
        description={
          picking?.mode === 'add'
            ? 'The score is the list of scorers, so a goal always belongs to somebody.'
            : 'Removes their most recent goal.'
        }
      >
        <div className="max-h-[55svh] space-y-1 overflow-y-auto">
          {(picking ? scorers(picking.team) : [])
            .filter((p) => picking?.mode === 'add' || (p.goals ?? 0) > 0)
            .map((player) => (
              <button
                key={player.id}
                onClick={() => {
                  const goals = player.goals ?? 0;
                  const next = picking.mode === 'add' ? goals + 1 : Math.max(0, goals - 1);
                  const handler = picking.mode === 'add' ? onScored : onUnscored;
                  setPicking(null);
                  handler?.(player.id, next);
                }}
                className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-md)] px-3 text-left transition-colors hover:bg-[var(--bg-sunken)]"
              >
                <Avatar name={player.name} size="sm" />
                <span className="min-w-0 flex-1 truncate font-medium">{player.name}</span>
                <PositionChip position={player.position} size="sm" />
                {(player.goals ?? 0) > 0 && (
                  <Badge tone="accent" size="sm">{player.goals}</Badge>
                )}
              </button>
            ))}

          {picking?.mode === 'remove' && scorers(picking.team).every((p) => !p.goals) && (
            <p className="px-3 py-6 text-center text-sm text-[var(--fg-secondary)]">
              Nobody on this team has scored yet.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

/* ==========================================================================
   GameTimeline

   Temporal navigation. The admin thinks in fixtures, so moving between games is
   left/right along a date rail rather than a dropdown of database records.

   Keyboard: left/right arrows. Touch: the rail scrolls and snaps.
   ========================================================================== */

export function GameTimeline({ games = [], currentId, onSelect, className }) {
  const railRef = useRef(null);
  const currentIndex = games.findIndex((g) => g.id === currentId);

  // Keep the selected fixture in view when it changes from arrows or the AI.
  useEffect(() => {
    const node = railRef.current?.querySelector('[data-current="true"]');
    node?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [currentId]);

  useEffect(() => {
    const onKey = (e) => {
      // Ignore while typing into the assistant or a score box.
      if (e.target.matches?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft' && currentIndex > 0) onSelect(games[currentIndex - 1].id);
      if (e.key === 'ArrowRight' && currentIndex < games.length - 1) onSelect(games[currentIndex + 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [games, currentIndex, onSelect]);

  const step = (delta) => {
    const next = games[currentIndex + delta];
    if (next) onSelect(next.id);
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <button
        onClick={() => step(-1)}
        disabled={currentIndex <= 0}
        className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fg-secondary)] hover:bg-[var(--bg-sunken)] disabled:opacity-30"
        aria-label="Previous game"
      >
        <ChevronLeft className="size-5" />
      </button>

      <div
        ref={railRef}
        // min-w-0 is what makes the overflow actually scroll. A flex item defaults to
        // `min-width: auto`, so `flex-1` will not shrink it below the intrinsic width of
        // its contents -- the rail grew as wide as all the fixtures put together, its
        // own `overflow-x: auto` never engaged, and the whole PAGE scrolled sideways
        // instead. On a phone that clipped the game's heading off the left edge.
        className="snap-rail min-w-0 flex-1 scrollbar-none py-1"
        role="tablist"
        aria-label="Match timeline"
      >
        {games.map((game) => {
          const isCurrent = game.id === currentId;
          const isPast = new Date(game.kickoffAt) < new Date();
          return (
            <button
              key={game.id}
              data-current={isCurrent}
              role="tab"
              aria-selected={isCurrent}
              onClick={() => onSelect(game.id)}
              className={cn(
                'flex min-w-[4.5rem] flex-col items-center rounded-[var(--radius-md)] border px-2.5 py-2 transition-colors',
                isCurrent
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-transparent hover:bg-[var(--bg-sunken)]',
                isPast && !isCurrent && 'opacity-55'
              )}
            >
              <span className="eyebrow text-[0.5625rem] leading-none">{shortDay(game.kickoffAt)}</span>
              <span className={cn('display text-xl leading-none tnum', isCurrent && 'text-[var(--accent)]')}>
                {dayNumber(game.kickoffAt)}
              </span>
              <span className="eyebrow text-[0.5rem] leading-none">{monthName(game.kickoffAt)}</span>
              <span className="mt-1 max-w-[4rem] truncate text-[0.5625rem] text-[var(--fg-muted)]">
                {game.venue?.name ?? game.districtName}
              </span>
            </button>
          );
        })}
      </div>

      <button
        onClick={() => step(1)}
        disabled={currentIndex >= games.length - 1}
        className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fg-secondary)] hover:bg-[var(--bg-sunken)] disabled:opacity-30"
        aria-label="Next game"
      >
        <ChevronRight className="size-5" />
      </button>
    </div>
  );
}

/* ==========================================================================
   FormationPicker
   ========================================================================== */

export function FormationPicker({ teamSize, value, onChange, disabled, className }) {
  const options = formationsFor(teamSize ?? 11);
  if (options.length === 0) return null;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <label htmlFor="formation" className="eyebrow shrink-0 text-[0.625rem]">Formation</label>
      <Select
        id="formation"
        value={value ?? options[0]}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-28 text-sm"
      >
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </Select>
      <span className="hidden truncate text-xs text-[var(--fg-muted)] sm:block">
        {describeFormation(teamSize ?? 11, value ?? options[0])}
      </span>
    </div>
  );
}

/* ==========================================================================
   PaymentSummary — the number an admin checks before kickoff
   ========================================================================== */

export function PaymentSummary({
  roster = [], price, currency = 'USD', onSelectPlayer, locked = false, className,
}) {
  const paid = roster.filter((r) => r.paid);
  const unpaid = roster.filter((r) => !r.paid);
  const collected = paid.length * (price ?? 0);
  const outstanding = unpaid.length * (price ?? 0);

  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-baseline justify-between">
        <p className="eyebrow text-[0.625rem]">Payments</p>
        {locked && (
          <span className="flex items-center gap-1 text-[0.625rem] uppercase tracking-wider text-[var(--fg-muted)]">
            <Lock className="size-3" aria-hidden /> Frozen
          </span>
        )}
        <p className="text-xs text-[var(--fg-secondary)] tnum">
          {paid.length}/{roster.length}
        </p>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="display text-3xl tnum text-[var(--accent)]">
          {collected}
        </span>
        <span className="text-sm text-[var(--fg-secondary)]">{currency} in</span>
        {outstanding > 0 && (
          <span className="ml-auto text-sm text-[var(--danger)] tnum">
            {outstanding} out
          </span>
        )}
      </div>

      <div className="mt-3 flex gap-[2px]" aria-hidden="true">
        {roster.map((entry) => (
          <div
            key={entry.playerId}
            className="h-1.5 flex-1 rounded-[1px]"
            style={{ background: entry.paid ? 'var(--accent)' : 'var(--danger)' }}
          />
        ))}
      </div>

      {unpaid.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs text-[var(--fg-secondary)]">
            {locked ? 'Still to pay - settle at full time' : 'Still to pay'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unpaid.map((entry) => (
              <button
                key={entry.playerId}
                onClick={() => onSelectPlayer?.(entry)}
                disabled={locked}
                className={cn(
                  'flex min-h-9 pointer-coarse:min-h-11 items-center gap-1.5 rounded-full border border-dashed border-[var(--danger)] px-3 py-1.5 text-xs font-medium text-[var(--danger-soft-fg)]',
                  locked ? 'opacity-50' : 'hover:bg-[var(--danger-soft)] active:scale-95'
                )}
              >
                {entry.name.split(' ')[0]}
                {/* The position, because chasing someone in a car park is easier when you
                    know you are looking for the goalkeeper. */}
                {entry.position && (
                  <span className="text-[0.625rem] text-[var(--fg-tertiary)]">
                    {entry.position}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/* ==========================================================================
   WaitlistPanel
   ========================================================================== */

export function WaitlistPanel({ waitlist = [], onPromote, canPromote, className }) {
  if (waitlist.length === 0) {
    return (
      <Card className={cn('p-4', className)}>
        <p className="eyebrow text-[0.625rem]">Waiting list</p>
        <p className="mt-2 text-sm text-[var(--fg-secondary)]">
          Nobody waiting. Everyone who wanted in, got in.
        </p>
      </Card>
    );
  }

  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex items-baseline justify-between px-4 pt-4">
        <p className="eyebrow text-[0.625rem]">Waiting list</p>
        <span className="text-xs text-[var(--fg-muted)] tnum">{waitlist.length}</span>
      </div>
      <ol className="mt-2 divide-y divide-[var(--border-subtle)]">
        {waitlist.map((entry) => (
          <li key={entry.playerId} className="flex items-center gap-3 px-4 py-2.5">
            <span className="display w-5 text-center text-[var(--trophy)]">
              {entry.waitlistPosition}
            </span>
            <Avatar name={entry.name} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.name}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!canPromote}
              onClick={() => onPromote(entry.playerId)}
            >
              Promote
            </Button>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/* ==========================================================================
   GameStatusRail — the lifecycle, made visible
   ========================================================================== */

const LIFECYCLE = [
  { key: 'draft', label: 'Scheduled' },
  { key: 'registration_open', label: 'Registration' },
  { key: 'full', label: 'Full' },
  { key: 'teams_generated', label: 'Teams ready' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
];

export function GameStatusRail({ status, className }) {
  if (status === 'cancelled') {
    return (
      <div className={cn('flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--danger-soft)] px-3 py-2', className)}>
        <AlertTriangle className="size-4 text-[var(--danger)]" aria-hidden="true" />
        <span className="text-sm font-semibold text-[var(--danger-soft-fg)]">Cancelled</span>
      </div>
    );
  }

  const currentIndex = LIFECYCLE.findIndex((s) => s.key === status);

  // Seven stages do not fit across a phone, so the rail scrolls -- and a rail that
  // scrolls always starts at "Scheduled", which is the one stage nobody needs to see.
  // An admin standing at the pitch during the second half opened this and read
  // "Scheduled -- Registration -- Full" with the stage they are actually in off the
  // right-hand edge. Put the live stage on screen instead.
  const railRef = useRef(null);
  useEffect(() => {
    const active = railRef.current?.querySelector('[aria-current="step"]');
    // `nearest` so it does not scroll the PAGE to reach a rail that is already in view.
    active?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [currentIndex]);

  return (
    // min-w-0 is what makes overflow-x-auto actually work here. A flex item defaults
    // to min-width:auto, which means it refuses to shrink below its content -- so the
    // rail widened the whole page by 100px on a phone instead of scrolling inside
    // itself, and every screen using it scrolled sideways.
    <ol ref={railRef} className={cn('flex min-w-0 max-w-full items-center gap-1 overflow-x-auto scrollbar-none', className)}>
      {LIFECYCLE.map((stage, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <li key={stage.key} className="flex shrink-0 items-center gap-1">
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold whitespace-nowrap',
                active && 'bg-[var(--accent)] text-[var(--accent-fg)]',
                done && 'text-[var(--accent)]',
                !active && !done && 'text-[var(--fg-muted)]'
              )}
              aria-current={active ? 'step' : undefined}
            >
              {done ? <Check className="size-3" /> : active ? <CircleDot className="size-3" /> : null}
              {stage.label}
            </span>
            {i < LIFECYCLE.length - 1 && (
              <span className={cn('h-px w-3', done ? 'bg-[var(--accent)]' : 'bg-[var(--border-default)]')} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ==========================================================================
   CancelGameDialog
   ========================================================================== */

const CANCEL_REASONS = [
  'Bad weather',
  'Venue unavailable',
  'Not enough players',
  'Administrative cancellation',
  'Other',
];

export function CancelGameDialog({ open, onOpenChange, game, onConfirm, pending }) {
  const [reason, setReason] = useState(CANCEL_REASONS[0]);
  const [detail, setDetail] = useState('');

  const finalReason = reason === 'Other' ? detail.trim() : reason;
  const affected = (game?.confirmedCount ?? 0) + (game?.waitlistCount ?? 0);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel this game?"
      description={`${affected} people are expecting to play. They will all be notified.`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
            Keep it on
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            loading={pending}
            disabled={!finalReason}
            onClick={() => onConfirm(finalReason)}
          >
            Cancel game
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label htmlFor="cancel-reason" className="mb-1.5 block text-sm font-medium">
            Reason
          </label>
          <Select id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {CANCEL_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </div>

        {reason === 'Other' && (
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="What should we tell everyone?"
            className="h-11 w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3.5 text-sm"
            aria-label="Cancellation reason"
          />
        )}

        <p className="text-xs text-[var(--fg-secondary)]">
          The reason goes out with the notification, so write it as you would say it.
        </p>
      </div>
    </Modal>
  );
}
