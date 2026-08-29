// The matchday workspace.
//
// THE GAME IS THE APPLICATION.
//
// An admin logging in lands here, on the fixture that is happening next, with the pitch
// as the centre of gravity. Everything else — payments, waitlist, score, teams, the
// assistant — orbits it. There is no dashboard to pass through and no district to pick
// first: the app works out which game matters and opens it.
//
// Players get the same screen without the controls, because seeing your team on a pitch
// is the good part.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  MapPin, Clock, Users, Sparkles, Ban, Lock, LockOpen, Share2, RotateCcw, Trash2, Image,
} from 'lucide-react';
import { toast } from 'sonner';
import { useGames, useMatchday, useCountdown, keys } from '../hooks/index.js';
import { useSession } from '../state/session.jsx';
import { matchdayService, adminService, gameService } from '../api/services.js';
import { fitSquadToFormation, defaultFormation } from '../lib/formations.js';
import { time, dayAndDate, relativeDay, pad } from '../lib/format.js';
import {
  Button, Card, Badge, Skeleton, ErrorState, EmptyState, Modal, Avatar,
} from '../components/ui/index.jsx';
import { MatchPitch } from '../components/football/MatchPitch.jsx';
import { VenueBadge } from '../components/football/VenueBadge.jsx';
import { MatchClock } from '../components/matchday/MatchClock.jsx';
import { svgToPngBlob, sharePng, exportFilename } from '../lib/exportImage.js';
import { CapacityMeter, GameStatusChip, TeamCrest, teamStrength } from '../components/football/index.jsx';
import {
  PlayerControlPanel, ScoreControl, GameTimeline, FormationPicker, PaymentSummary,
  WaitlistPanel, GameStatusRail, CancelGameDialog,
} from '../components/matchday/index.jsx';
import { AssistantDock } from '../components/ai/Assistant.jsx';

/* --------------------------------------------------------------------------
   Which game should we open?

   In progress > next upcoming > most recent. An admin at 8:15pm wants tonight's
   9pm fixture without searching for it.
   -------------------------------------------------------------------------- */
export function pickRelevantGame(games = []) {
  if (games.length === 0) return null;
  const now = Date.now();

  const live = games.find(
    (g) =>
      g.status !== 'cancelled' &&
      new Date(g.kickoffAt).getTime() <= now &&
      new Date(g.kickoffAt).getTime() + (g.durationMinutes ?? 90) * 60_000 > now
  );
  if (live) return live;

  const upcoming = games
    .filter((g) => g.status !== 'cancelled' && new Date(g.kickoffAt).getTime() > now)
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt))[0];
  if (upcoming) return upcoming;

  return [...games].sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt))[0];
}

function Countdown({ target }) {
  const { days, hours, minutes, seconds, expired } = useCountdown(target);
  if (expired) return <span className="display text-xl text-[var(--accent)]">Under way</span>;

  const blocks = days > 0
    ? [[days, 'd'], [hours, 'h'], [minutes, 'm']]
    : [[hours, 'h'], [minutes, 'm'], [seconds, 's']];

  return (
    <span className="display flex items-baseline gap-1.5 text-2xl tnum" role="timer">
      {blocks.map(([value, unit]) => (
        <span key={unit}>
          {pad(value)}<span className="text-sm text-[var(--fg-muted)]">{unit}</span>
        </span>
      ))}
    </span>
  );
}

/* ==========================================================================
   Matchday
   ========================================================================== */

export default function Matchday() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin, player: sessionPlayer, user } = useSession();

  // The whole fixture list drives the timeline. Past and future in one sequence,
  // because the admin thinks in fixtures, not in queries.
  const { data: upcomingData } = useGames({ when: 'upcoming' });
  const { data: pastData } = useGames({ when: 'past' });

  const timeline = useMemo(() => {
    const past = (pastData?.games ?? []).slice(0, 8).reverse();
    const upcoming = upcomingData?.games ?? [];
    return [...past, ...upcoming].sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));
  }, [pastData, upcomingData]);

  // No id in the URL means "work it out" — the core of the no-gateway rule.
  const resolvedId = id ?? pickRelevantGame(timeline)?.id;

  const { data, isLoading, isError, refetch } = useMatchday(resolvedId, { admin: isAdmin });
  const game = data?.game;

  const [selectedPlayerId, setSelectedPlayerId] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const pitchRef = useRef(null);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * Undo stack for team changes.
   *
   * Snapshots the RAW `game.teams`, not the enriched view, so restoring cannot smuggle
   * a stale payment or goal count back onto the pitch — those live on the roster and
   * are merged at render.
   *
   * Every path that reshapes the teams pushes here: a drag, a formation change, a
   * regenerate. Dragging the wrong player at the side of a pitch in the dark is a
   * certainty, not an edge case.
   */
  const [history, setHistory] = useState([]);
  const historyLabel = history.at(-1)?.label ?? null;

  // Cleared when the fixture changes, so undo can never apply one game's teams to
  // another.
  useEffect(() => { setHistory([]); }, [resolvedId]);

  const reload = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: keys.game(resolvedId) });
    queryClient.invalidateQueries({ queryKey: ['games'] });
  }, [queryClient, resolvedId]);

  /** Optimistically patch the cached game so the pitch reacts instantly. */
  const applyGame = useCallback(
    (next) => {
      if (!next) return;
      queryClient.setQueryData(keys.game(resolvedId), { game: next });
    },
    [queryClient, resolvedId]
  );

  /**
   * Teams carry identity; the roster carries matchday state.
   *
   * They are separate projections on the server, so the pitch has to marry them —
   * otherwise a marker knows a player's name and rating but not whether they have paid,
   * which is the single thing this screen exists to show.
   */
  const teams = useMemo(() => {
    if (!game?.teams?.length) return [];
    const byPlayer = new Map(game.roster.map((r) => [r.playerId, r]));
    return game.teams.map((team) => ({
      ...team,
      players: team.players.map((player) => {
        const entry = byPlayer.get(player.id);
        return entry
          ? {
              ...player,
              paid: entry.paid,
              goals: entry.goals ?? 0,
              assists: entry.assists ?? 0,
              rating: entry.rating,
              attendance: entry.attendance,
            }
          : player;
      }),
    }));
  }, [game]);

  const formation = game?.formation ?? defaultFormation(game?.teamSize ?? 11);

  /**
   * A lineup to look at before the teams are real.
   *
   * The pitch used to appear only once the balancer had run, which needs a full roster --
   * so for the entire period when an admin is actually watching people sign up, the main
   * screen of the app showed a message instead of a pitch. That is backwards: the shape
   * of the team is most useful while it is still forming.
   *
   * Split by snake draft on rating (1,2,2,1) rather than alternating, which keeps the two
   * sides close without pretending to be the balancer. This is a PREVIEW: it never posts
   * anywhere, and the real teams still come from the server, which enumerates every split
   * rather than guessing. The UI has to say so, or an admin will think the teams are set.
   */
  const provisionalTeams = useMemo(() => {
    const roster = game?.roster ?? [];
    if (game?.teams?.length || roster.length === 0) return [];

    const size = game?.teamSize ?? 11;
    const ranked = [...roster].sort((a, b) => (b.ratingMu ?? 1500) - (a.ratingMu ?? 1500));
    const sides = [[], []];
    ranked.forEach((p, i) => {
      // 0,1,1,0,0,1,1,0 -- the strongest two are split, then the next two swap back.
      const side = Math.floor(i / 2) % 2 === 0 ? i % 2 : 1 - (i % 2);
      if (sides[side].length < size) sides[side].push(p);
      else sides[1 - side].push(p);
    });

    return ['black', 'white'].map((colour, i) => ({
      id: `provisional-${colour}`,
      color: colour,
      provisional: true,
      players: fitSquadToFormation(
        sides[i].map((r) => ({
          id: r.playerId,
          name: r.name,
          position: r.position,
          isGoalkeeper: r.isGoalkeeper,
          ratingMu: r.ratingMu,
          paid: r.paid,
          goals: r.goals ?? 0,
          assists: r.assists ?? 0,
          attendance: r.attendance,
        })),
        size,
        formation
      ),
    }));
  }, [game, formation]);

  // What the pitch draws: the real teams once they exist, the preview until then.
  const pitchTeams = teams.length === 2 ? teams : provisionalTeams;
  const locked = !!game?.lockedTeams;
  const canEdit = isAdmin && game && game.status !== 'cancelled';

  const selected = useMemo(() => {
    if (!game || !selectedPlayerId) return null;
    const onTeam = teams.flatMap((t) => t.players).find((p) => p.id === selectedPlayerId);
    const rosterEntry = game.roster.find((r) => r.playerId === selectedPlayerId);
    if (!rosterEntry) return null;
    return {
      ...rosterEntry,
      id: rosterEntry.playerId,
      position: onTeam?.position ?? rosterEntry.position,
      teamColor: teams.find((t) => t.players.some((p) => p.id === selectedPlayerId))?.color,
    };
  }, [game, selectedPlayerId, teams]);

  /* --- operations ----------------------------------------------------- */

  const togglePaid = async (playerId, paid) => {
    try {
      const { game: next } = await matchdayService.setPayment(game.id, playerId, paid);
      applyGame(next);
    } catch (error) {
      // The database freezes payments between kickoff and the final whistle. The UI hides
      // the controls then, but a stale tab or a second device can still get here, and the
      // reason is worth saying out loud rather than swallowing.
      toast.error(error.message);
      throw error;
    }
  };

  const patchPlayer = async (playerId, patch) => {
    const { game: next } = await matchdayService.setPlayerStat(game.id, playerId, patch);
    applyGame(next);
  };

  const toggleMotm = async (playerId) => {
    const { game: next } = await matchdayService.setMotm(game.id, playerId);
    applyGame(next);
  };

  const setScore = async (score) => {
    const { game: next } = await matchdayService.setScore(game.id, score);
    applyGame(next);
  };

  /** Remember the current teams before changing them. */
  const pushHistory = useCallback(
    (label) => {
      if (!game?.teams?.length) return;
      setHistory((h) => [
        // Ten steps is plenty for a touchline and keeps the snapshots small.
        ...h.slice(-9),
        { label, teams: game.teams.map((t) => ({ ...t, players: [...t.players] })) },
      ]);
    },
    [game]
  );

  const undo = useCallback(async () => {
    const last = history.at(-1);
    if (!last) return;

    setHistory((h) => h.slice(0, -1));
    applyGame({ ...game, teams: last.teams });
    const { game: saved } = await matchdayService.setTeams(game.id, last.teams);
    applyGame(saved);
    toast.success('Undone', { description: last.label });
  }, [history, game, applyGame]);

  // Ctrl/Cmd+Z, ignored while typing into the assistant or a score box.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.key === 'z' && (e.metaKey || e.ctrlKey)) || e.shiftKey) return;
      if (e.target.matches?.('input, textarea, select, [contenteditable]')) return;
      if (history.length === 0) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, undo]);

  const setFormation = async (value) => {
    pushHistory(`Formation back to ${formation}`);
    // Refit both sides so changing shape repositions players rather than just
    // relabelling them. Anyone already in a slot that survives stays put.
    const refitted = teams.map((team) => ({
      ...team,
      players: fitSquadToFormation(team.players, game.teamSize, value).map((p) => ({
        ...p, position: p.slot?.label ?? p.position,
      })),
    }));
    const { game: withFormation } = await matchdayService.setFormation(game.id, value);
    const { game: next } = await matchdayService.setTeams(game.id, refitted);
    applyGame({ ...withFormation, ...next, formation: value });
  };

  const movePlayer = async (playerId, { teamId, slotIndex }) => {
    if (locked) { toast.error('Teams are locked. Unlock them to make changes.'); return; }

    const fromTeam = teams.find((t) => t.players.some((p) => p.id === playerId));
    const toTeam = teams.find((t) => t.id === teamId);
    if (!fromTeam || !toTeam) return;

    const player = fromTeam.players.find((p) => p.id === playerId);
    const occupant = toTeam.players[slotIndex];

    pushHistory(
      occupant && occupant.id !== playerId
        ? `${player.name} and ${occupant.name} swapped back`
        : `${player.name} moved back`
    );

    const next = teams.map((team) => {
      const players = [...team.players];

      if (team.id === fromTeam.id && team.id === toTeam.id) {
        // Same side: swap the two slots.
        const fromIndex = players.findIndex((p) => p.id === playerId);
        if (occupant && fromIndex !== -1) {
          players[fromIndex] = occupant;
          players[slotIndex] = player;
        }
        return { ...team, players };
      }

      if (team.id === fromTeam.id) {
        const filtered = players.filter((p) => p.id !== playerId);
        // A straight swap keeps both sides the same size.
        if (occupant) filtered.push({ ...occupant, isManualOverride: true });
        return { ...team, players: filtered };
      }

      if (team.id === toTeam.id) {
        const updated = [...players];
        if (occupant) updated[slotIndex] = { ...player, isManualOverride: true };
        else updated.push({ ...player, isManualOverride: true });
        return { ...team, players: updated };
      }

      return team;
    });

    applyGame({ ...game, teams: next });
    const { game: saved } = await matchdayService.setTeams(game.id, next);
    applyGame(saved);

    // Inline undo on the confirmation itself: the fastest correction is the one you do
    // not have to go looking for.
    toast.success(
      occupant && occupant.id !== playerId
        ? `${player.name} ↔ ${occupant.name}`
        : `${player.name} moved`,
      { action: { label: 'Undo', onClick: () => undo() } }
    );
  };

  const generateTeams = async () => {
    pushHistory('Previous teams restored');
    setGenerating(true);
    try {
      const result = await adminService.generateTeams(game.id, {});
      const { game: next } = await matchdayService.setTeams(game.id, result.teams);
      applyGame({ ...next, status: 'teams_generated' });
      toast.success('Teams ready', {
        description: `Picked from ${result.candidatesEvaluated.toLocaleString('en-GB')} possible splits.`,
      });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setGenerating(false);
    }
  };

  const promote = async (playerId) => {
    const { promoted, game: next } = await matchdayService.promote(game.id, playerId);
    applyGame(next);
    toast.success(`${promoted.name} is in`, { description: 'They have been notified.' });
  };

  const toggleLock = async () => {
    const { game: next } = await matchdayService.setStatus(
      game.id, game.status === 'teams_generated' ? 'teams_generated' : game.status,
      { locked: !locked }
    );
    applyGame(next);
    toast.success(locked ? 'Teams unlocked' : 'Teams locked');
  };

  const cancelGame = async (reason) => {
    setBusy(true);
    try {
      const { game: next } = await matchdayService.setStatus(game.id, 'cancelled', { reason });
      applyGame(next);
      setCancelOpen(false);
      toast.success('Game cancelled', { description: 'Everyone registered will be notified.' });
    } finally {
      setBusy(false);
    }
  };

  /* --- the clock --------------------------------------------------------- */

  const runClock = async (action) => {
    setBusy(true);
    try {
      const { game: next } = await matchdayService.clock(game.id, action);
      applyGame(next);
      // The final whistle is the moment to chase whoever said they would pay after.
      // Payments are frozen while the match is on, so this is the first chance since
      // kickoff -- and the last time everyone is still standing in the same car park.
      if (action === 'end' && next.payments?.unpaidCount > 0) setSettleOpen(true);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  /* --- send the pitch to WhatsApp ---------------------------------------- */

  const exportPitch = async () => {
    const svg = pitchRef.current?.querySelector('svg');
    if (!svg) { toast.error('The pitch is not on screen'); return; }

    setExporting(true);
    try {
      const blob = await svgToPngBlob(svg, {
        // Read from the page rather than hardcoded, so the export matches the theme the
        // admin is looking at instead of always coming out dark.
        background: getComputedStyle(document.body).backgroundColor || '#0A0F0D',
        badge: game.venue?.logo_url ?? null,
        caption: [
          game.venue?.name ?? game.districtName,
          dayAndDate(game.kickoffAt),
          time(game.kickoffAt),
          // Said on the image itself, because the image is what gets forwarded and
          // whoever receives it has none of the context the admin had.
          teams.length === 2 ? null : 'PROVISIONAL',
        ].filter(Boolean).join('  ·  '),
      });
      const result = await sharePng(blob, {
        filename: exportFilename(game),
        title: 'Sports Fusion',
        text: `${game.districtName} · ${dayAndDate(game.kickoffAt)} ${time(game.kickoffAt)}`,
      });
      if (result === 'downloaded') {
        toast.success('Image saved', { description: 'Drag it into WhatsApp Web.' });
      } else if (result === 'shared') {
        toast.success('Sent');
      }
    } catch (error) {
      toast.error(error.message ?? 'Could not build the image');
    } finally {
      setExporting(false);
    }
  };

  const share = async () => {
    const url = `${window.location.origin}/g/${game.slug ?? game.id}`;
    const text = `⚽ ${game.districtName} · ${dayAndDate(game.kickoffAt)} ${time(game.kickoffAt)}\n${game.confirmedCount}/${game.capacity} players`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Sports Fusion', text, url }); return; } catch { /* cancelled */ }
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast.success('Copied — paste it into the group');
  };

  /* --- assistant context ---------------------------------------------- */

  const aiContext = useMemo(
    () => ({
      gameId: game?.id,
      gameLabel: game ? `${game.districtName} · ${relativeDay(game.kickoffAt)} ${time(game.kickoffAt)}` : null,
      confirmedCount: game?.confirmedCount,
      game,
      actorName: user?.displayName,
      districts: (upcomingData?.games ?? []).map((g) => ({ id: g.districtId, name: g.districtName })),
      venues: [],
      allPlayers: game?.roster ?? [],
    }),
    [game, user, upcomingData]
  );

  /* --- render ---------------------------------------------------------- */

  // Nothing to show, and nothing loading either.
  //
  // This has to be checked BEFORE the loading branch. With no fixtures there is no id to
  // resolve, so the query is disabled and never resolves -- `game` stays undefined and
  // `isLoading` stays false, which the skeleton branch reads as "still loading" forever.
  // A fresh install landed on a screen of grey boxes that never became anything.
  if (!resolvedId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <EmptyState
          icon={Users}
          title="No games yet"
          description="Create your first fixture and this becomes your matchday workspace — teams, payments, the clock and the result all live on the pitch."
          action={<Button to="/admin/schedule">Schedule a game</Button>}
        />
      </div>
    );
  }

  if (isLoading || (!game && !isError)) {
    return (
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
        <Skeleton className="h-16 rounded-[var(--radius-lg)]" />
        <Skeleton className="h-[26rem] rounded-[var(--radius-lg)]" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <ErrorState title="Could not open that game" onRetry={refetch} />
      </div>
    );
  }


  const kickoff = new Date(game.kickoffAt);
  const isFull = game.confirmedCount >= game.capacity;
  const hasTeams = teams.length === 2;

  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        {/* Timeline: move between fixtures without leaving the workspace. */}
        <div className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/95 backdrop-blur-lg">
          <div className="mx-auto max-w-6xl px-3 py-2">
            <GameTimeline
              games={timeline}
              currentId={game.id}
              onSelect={(nextId) => {
                setSelectedPlayerId(null);
                navigate(isAdmin ? `/matchday/${nextId}` : `/matchday/${nextId}`);
              }}
            />
          </div>
        </div>

        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
          {/* Identity: which game, when, where. */}
          <header className="mb-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <GameStatusChip
                    status={game.status}
                    confirmed={game.confirmedCount}
                    capacity={game.capacity}
                  />
                  <span className="text-sm text-[var(--fg-secondary)]">
                    {relativeDay(kickoff)}
                  </span>
                  {game.status !== 'completed' && game.status !== 'cancelled' && (
                    <Countdown target={game.kickoffAt} />
                  )}
                </div>

                <h1 className="display text-4xl leading-none sm:text-6xl">{game.districtName}</h1>

                <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--fg-secondary)]">
                  <span className="flex items-center gap-1.5 font-semibold text-[var(--fg-primary)]">
                    <Clock className="size-4" aria-hidden="true" /> {time(kickoff)}
                  </span>
                  {game.venue && (
                    <span className="flex items-center gap-1.5">
                      {/* The badge replaces the pin when there is one -- two marks for
                          one venue is clutter. */}
                      {game.venue.logo_url
                        ? <VenueBadge venue={game.venue} size={20} />
                        : <MapPin className="size-4" aria-hidden="true" />}
                      {game.venue.name}
                    </span>
                  )}
                  <span>{dayAndDate(kickoff)}</span>
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {/* Full-size on the matchday screen. These are pressed with a thumb,
                    outdoors, in the dark -- a 32px button is the wrong control here. */}
                <Button variant="secondary" onClick={share}>
                  <Share2 className="size-4" /> Share
                </Button>
                {/* The picture, not the link. Screenshotting the screen and cropping it
                    by hand was the actual workflow this replaces. */}
                {/* Whenever there is a pitch worth sending, not only once the teams are
                    final. A provisional lineup is exactly what an admin wants to drop in
                    the group to show who is in so far. */}
                {pitchTeams.length > 0 && (
                  <Button variant="secondary" onClick={exportPitch} loading={exporting}>
                    <Image className="size-4" aria-hidden /> Send teams
                  </Button>
                )}
                {canEdit && (
                  <>
                    <Button variant="ghost" onClick={() => setCancelOpen(true)}>
                      <Ban className="size-4" /> Cancel
                    </Button>
                    {/* Cancel and delete are different acts. Cancel says the game was
                        called off, which the reliability numbers depend on. Delete is for
                        a fixture that should never have existed. */}
                    <Button variant="ghost" onClick={() => setDeleteOpen(true)}>
                      <Trash2 className="size-4" /> Delete
                    </Button>
                  </>
                )}
              </div>
            </div>

            <GameStatusRail status={game.status} className="mt-4" />
          </header>

          {/* The clock, above everything. Once the whistle goes this is the only thing on
              the screen the admin is looking at. */}
          {(hasTeams || game.clock?.state !== 'not_started') && game.clock && (
            <MatchClock
              clock={game.clock}
              onAction={runClock}
              canControl={canEdit}
              busy={busy}
              className="mb-4"
            />
          )}

          {/* Score sits above the pitch — the broadcast position. */}
          {(hasTeams || game.result) && (
            <Card className="mb-4 py-4">
              <ScoreControl
                score={game.result?.score ?? { black: 0, white: 0 }}
                onChange={setScore}
                editable={canEdit}
              />
              {hasTeams && (
                <div className="mt-3 flex items-center justify-center gap-6 text-xs text-[var(--fg-secondary)]">
                  {teams.map((team) => (
                    <span key={team.id} className="tnum">
                      {team.color} strength{' '}
                      <span className="display text-base text-[var(--fg-primary)]">
                        {teamStrength(team.players).toFixed(1)}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* THE PITCH -- always, even with nobody on it.
              It used to appear only once the balancer had run, which needs a full roster.
              So during the entire stretch when an admin is watching people sign up, the
              main screen showed a message where the pitch should be. */}
          <>
              {/* What the preview is, said plainly. Without this an admin sees a laid-out
                  team and reasonably assumes it is decided. */}
              {!hasTeams && pitchTeams.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] px-3 py-2 text-sm">
                  <span className="font-medium">Provisional lineup</span>
                  <span className="text-[var(--fg-secondary)]">
                    {isFull
                      ? 'Generate teams to balance them properly.'
                      : `${game.capacity - game.confirmedCount} more to go. Positions fill as people join.`}
                  </span>
                  {canEdit && isFull && (
                    <Button size="sm" className="ml-auto" loading={generating} onClick={generateTeams}>
                      <Sparkles className="size-4" aria-hidden /> Generate teams
                    </Button>
                  )}
                </div>
              )}

              <div className="mb-3 flex flex-wrap items-center gap-3">
                {canEdit && (
                  <FormationPicker
                    teamSize={game.teamSize}
                    value={formation}
                    onChange={setFormation}
                    disabled={locked}
                  />
                )}
                <div className="ml-auto flex items-center gap-2">
                  {canEdit && (
                    <>
                      <Button
                        variant="ghost"
                        onClick={undo}
                        disabled={history.length === 0 || locked}
                        title={historyLabel ?? 'Nothing to undo'}
                      >
                        <RotateCcw className="size-4" /> Undo
                      </Button>
                      <Button variant="ghost" onClick={toggleLock}>
                        {locked ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
                        {locked ? 'Locked' : 'Lock teams'}
                      </Button>
                      <Button
                        variant="secondary"
                        loading={generating}
                        disabled={locked}
                        onClick={generateTeams}
                      >
                        <Sparkles className="size-4" /> Regenerate
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Wrapped so the export can reach the <svg>. MatchPitch does not forward a
                  ref, and adding one would put an export concern inside a drawing. */}
              <div ref={pitchRef}>
              <MatchPitch
                teams={pitchTeams}
                formation={formation}
                teamSize={game.teamSize}
                selectedPlayerId={selectedPlayerId}
                onSelectPlayer={(p) => setSelectedPlayerId(p.id)}
                onMovePlayer={canEdit && !locked ? movePlayer : undefined}
                interactive={canEdit && !locked}
                showPayment={isAdmin}
              />
              </div>

              {canEdit && !locked && pitchTeams.length > 0 && (
                <p className="mt-2 text-center text-xs text-[var(--fg-muted)]">
                  Drag a player onto a position to move them. Tap for payments and stats.
                  {history.length > 0 && ' Ctrl+Z undoes the last change.'}
                </p>
              )}

              {/* Nobody at all: the pitch is drawn empty above, so this only has to say
                  what happens next. */}
              {pitchTeams.length === 0 && (
                <p className="mt-3 text-center text-sm text-[var(--fg-secondary)]">
                  Nobody has signed up yet. Players appear in their preferred positions as
                  they join.
                </p>
              )}
          </>

          {/* Operations below the pitch */}
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <Card className="p-4">
              <p className="eyebrow text-[0.625rem]">Squad</p>
              <div className="mt-2">
                <CapacityMeter
                  confirmed={game.confirmedCount}
                  capacity={game.capacity}
                  waitlist={game.waitlistCount}
                />
              </div>
            </Card>

            {isAdmin ? (
              <PaymentSummary
                roster={game.roster}
                price={game.price}
                currency={game.currency}
                onSelectPlayer={(entry) => setSelectedPlayerId(entry.playerId)}
                locked={game.payments?.locked}
              />
            ) : (
              <Card className="p-4">
                <p className="eyebrow text-[0.625rem]">Your team</p>
                <div className="mt-2 flex items-center gap-2">
                  {(() => {
                    const myTeam = teams.find((t) =>
                      t.players.some((p) => p.id === sessionPlayer?.id)
                    );
                    return myTeam ? (
                      <>
                        <TeamCrest color={myTeam.color} size={24} />
                        <span className="display text-2xl">{myTeam.color}</span>
                      </>
                    ) : (
                      <span className="text-sm text-[var(--fg-secondary)]">
                        Teams not out yet
                      </span>
                    );
                  })()}
                </div>
              </Card>
            )}

            <WaitlistPanel
              waitlist={game.waitlist}
              onPromote={promote}
              canPromote={isAdmin && game.confirmedCount < game.capacity}
            />
          </div>
        </div>
      </div>

      {isAdmin && <AssistantDock context={aiContext} onResult={(r) => { if (r?.game) applyGame(r.game); else reload(); }} />}

      <PlayerControlPanel
        open={!!selected && isAdmin}
        onOpenChange={(open) => !open && setSelectedPlayerId(null)}
        player={selected}
        teamColor={selected?.teamColor}
        isMotm={game.result?.motm?.playerId === selected?.id}
        onPatch={(patch) => patchPlayer(selected.id, patch)}
        onTogglePaid={(paid) => togglePaid(selected.id, paid)}
        onToggleMotm={() => toggleMotm(selected.id)}
        onRemove={async () => {
          const { game: next } = await matchdayService.removePlayer(game.id, selected.id);
          applyGame(next);
          setSelectedPlayerId(null);
          toast.success('Removed from the game');
        }}
      />

      {/* Players tapping a marker get information, not controls. */}
      <Modal
        open={!!selected && !isAdmin}
        onOpenChange={(open) => !open && setSelectedPlayerId(null)}
        title={selected?.name ?? ''}
        description={selected ? `${selected.position} · ${selected.teamColor ?? ''}` : ''}
        size="sm"
      >
        {selected && (
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              ['Goals', selected.goals ?? 0],
              ['Assists', selected.assists ?? 0],
              ['Rating', selected.rating ? Number(selected.rating).toFixed(1) : '—'],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="eyebrow text-[0.5625rem]">{label}</p>
                <p className="display mt-1 text-3xl tnum">{value}</p>
              </div>
            ))}
          </div>
        )}
        <Link
          to={`/players/${selected?.id}`}
          className="mt-4 block text-center text-sm text-[var(--accent)] hover:underline"
        >
          Full profile
        </Link>
      </Modal>

      {/* The settlement window. Payments are frozen from kickoff to the final whistle,
          so this is the first chance since the match started -- and the last moment
          everyone is still standing in the same car park. */}
      <Modal
        open={settleOpen}
        onOpenChange={setSettleOpen}
        title="Who still owes?"
        description={`${game.payments?.unpaidCount ?? 0} of ${game.confirmedCount} have not paid. Tap anyone who settles up now.`}
        size="sm"
        footer={<Button className="w-full" onClick={() => setSettleOpen(false)}>Done</Button>}
      >
        <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
          {(game.roster ?? []).filter((p) => !p.paid).map((p) => (
            <li key={p.playerId}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2 text-left hover:bg-[var(--surface-2)]"
                onClick={() => togglePaid(p.playerId, true)}
              >
                <Avatar name={p.name} size="sm" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.position && (
                  <span className="text-xs text-[var(--fg-tertiary)]">{p.position}</span>
                )}
                <span className="text-sm tabular-nums text-[var(--danger)]">
                  {game.price ?? 0} {game.currency ?? ''}
                </span>
              </button>
            </li>
          ))}
          {(game.roster ?? []).every((p) => p.paid) && (
            <li className="px-2 py-6 text-center text-sm text-[var(--fg-secondary)]">
              Everyone has paid.
            </li>
          )}
        </ul>
      </Modal>

      <Modal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this game?"
        description={
          game.confirmedCount > 0
            ? `${game.confirmedCount} ${game.confirmedCount === 1 ? 'player has' : 'players have'} signed up. They will not be told, and the game will simply be gone — if it was called off rather than created by mistake, cancel it instead so their record stays right.`
            : 'It will be gone for good, along with anything attached to it.'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>Keep it</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await adminService.deleteGame(game.id);
                  toast.success('Game deleted');
                  setDeleteOpen(false);
                  // The cache still holds a game that no longer exists, and the pitch is
                  // rendering it. Drop it and go back to whatever is next.
                  queryClient.removeQueries({ queryKey: keys.game(game.id) });
                  await queryClient.invalidateQueries({ queryKey: ['games'] });
                  navigate('/admin', { replace: true });
                } catch (error) {
                  toast.error(error.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Trash2 className="size-4" /> Delete for good
            </Button>
          </>
        }
      />

      <CancelGameDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        game={game}
        onConfirm={cancelGame}
        pending={busy}
      />
    </div>
  );
}
