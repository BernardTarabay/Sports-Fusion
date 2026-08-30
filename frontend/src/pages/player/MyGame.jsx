// Your game.
//
// WHY THIS IS NOT THE MATCHDAY SCREEN
//
// Players used to be sent to the admin's matchday workspace with the controls hidden.
// That is a thousand-line operations console with the operations taken out: a fixture
// timeline rail, a payment summary, a formation picker, a waitlist manager, an undo
// stack, an export button and a tactical board — and after hiding everything a player
// may not touch, what is left is a page organised around jobs that are not theirs.
//
// A player has four questions and they are always the same four:
//
//   When and where is it?   Am I in?   Who am I playing with?   What was the score?
//
// So this page answers those, in that order, and stops. One screen, no tabs, no rail,
// nothing to configure. Everything an admin needs is still in the admin app, which is
// now a separate application rather than the same one with the buttons greyed out.

import { Link } from 'react-router';
import { MapPin, Clock, Users, CalendarDays, Share2, Navigation } from 'lucide-react';
import { toast } from 'sonner';
import { useMatchday, useGames, useCountdown, useJoinGame, useLeaveGame } from '../../hooks/index.js';
import { useSession } from '../../state/session.jsx';
import { cn } from '../../lib/cn.js';
import { time, dayAndDate, relativeDay, pad } from '../../lib/format.js';
import { joinability } from '../../lib/joinability.js';
import {
  Button, Card, Badge, Skeleton, EmptyState, ErrorState, Avatar,
} from '../../components/ui/index.jsx';
import { CapacityMeter, TeamCrest, ScoreLine } from '../../components/football/index.jsx';
import { FootballPitch } from '../../components/football/FootballPitch.jsx';
import { VenueBadge } from '../../components/football/VenueBadge.jsx';
import { pickRelevantGame } from '../Matchday.jsx';

const teamLabel = (c) => (c ? c[0].toUpperCase() + c.slice(1) : null);

/* --------------------------------------------------------------------------
   The countdown. Big, because it is the single most-asked question.
   -------------------------------------------------------------------------- */
function Countdown({ target }) {
  const { days, hours, minutes, seconds, expired } = useCountdown(target);
  if (expired) return null;

  const blocks = days > 0
    ? [[days, 'days'], [hours, 'hrs'], [minutes, 'min']]
    : [[hours, 'hrs'], [minutes, 'min'], [seconds, 'sec']];

  return (
    <div className="flex gap-4" role="timer">
      {blocks.map(([value, label]) => (
        <div key={label} className="text-center">
          <span className="display block text-4xl leading-none tnum sm:text-5xl">{pad(value)}</span>
          <span className="eyebrow text-[0.625rem]">{label}</span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
   A team sheet, as a list. The pitch is below it for people who want the shape;
   the list is first because "who am I playing with" is a reading question.
   -------------------------------------------------------------------------- */
function TeamSheet({ team, meId }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <TeamCrest color={team.color} size={22} />
        <span className="display text-lg capitalize">{team.color}</span>
        <span className="ml-auto text-xs text-[var(--fg-secondary)]">
          {team.players.length} player{team.players.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="divide-y divide-[var(--border-subtle)]">
        {team.players.map((p) => (
          <li
            key={p.id}
            className={cn(
              'flex items-center gap-3 px-4 py-2.5',
              p.id === meId && 'bg-[var(--accent-soft)]'
            )}
          >
            <Avatar name={p.name} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {p.name}
              {p.id === meId && <span className="ml-1.5 text-xs text-[var(--accent)]">you</span>}
            </span>
            {p.position && (
              <span className="text-[0.625rem] font-semibold text-[var(--fg-muted)]">{p.position}</span>
            )}
            {p.goals > 0 && <Badge tone="accent" size="sm">{p.goals}</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function MyGame() {
  const { isAuthenticated, player } = useSession();

  // Whichever game matters right now: one in play, else the next one, else the last.
  // A player should not have to pick a district and then a fixture to find out whether
  // they are playing tonight.
  const { data: gamesData, isLoading: listLoading } = useGames({ when: 'all', limit: 50 });
  const mine = (gamesData?.games ?? []).filter((g) => g.isRegistered);
  const relevant = pickRelevantGame(mine.length > 0 ? mine : (gamesData?.games ?? []));

  const { data, isLoading, isError, refetch } = useMatchday(relevant?.id);
  const join = useJoinGame();
  const leave = useLeaveGame();

  if (listLoading || (relevant && isLoading)) return <MyGameSkeleton />;

  if (!relevant) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <EmptyState
          icon={CalendarDays}
          title="No game yet"
          description="Nothing is on the calendar you can join right now."
          action={<Button to="/games">Browse fixtures</Button>}
        />
      </div>
    );
  }

  if (isError || !data?.game) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <ErrorState title="Could not load your game" onRetry={refetch} />
      </div>
    );
  }

  const game = data.game;
  const kickoff = new Date(game.kickoffAt);
  const can = joinability(game);
  const teams = game.teams ?? [];
  const live = game.clock?.state && !['not_started', 'finished'].includes(game.clock.state);
  const meId = player?.id;
  const myTeam = teams.find((t) => t.players.some((p) => p.id === meId));

  const share = async () => {
    const url = `${window.location.origin}/games/${game.slug ?? game.id}`;
    const text = `${game.venue?.name ?? game.districtName} · ${dayAndDate(kickoff)} ${time(kickoff)}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Sports Fusion', text, url }); return; } catch { /* dismissed */ }
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast.success('Link copied — paste it into your group');
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6 sm:py-8">
      {/* 1. WHEN AND WHERE ---------------------------------------------- */}
      <Card glow className="overflow-hidden">
        <div className="flex items-center gap-2 bg-[var(--accent)] px-5 py-2">
          <p className="display text-xs tracking-[0.2em] text-[var(--accent-fg)]">
            {live ? 'PLAYING NOW' : relativeDay(kickoff).toUpperCase()}
          </p>
          {game.isRegistered && (
            <span className="ml-auto text-xs font-semibold text-[var(--accent-fg)]">
              {game.myWaitlistPosition ? `Waiting list · #${game.myWaitlistPosition}` : "You're in"}
            </span>
          )}
        </div>

        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            {game.venue && <VenueBadge venue={game.venue} size={44} />}
            <div className="min-w-0 flex-1">
              {/* The PITCH is the headline. Somebody deciding whether to come needs to
                  know which ground, not which administrative district. */}
              <h1 className="display text-3xl leading-none sm:text-4xl">
                {game.venue?.name ?? game.districtName}
              </h1>
              {game.venue?.address && (
                <p className="mt-1.5 flex items-center gap-1.5 text-sm text-[var(--fg-secondary)]">
                  <MapPin className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{game.venue.address}</span>
                </p>
              )}
            </div>
          </div>

          <p className="display mt-5 text-2xl">{dayAndDate(kickoff)} · {time(kickoff)}</p>
          {game.arriveByMinutes > 0 && !live && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--fg-secondary)]">
              <Clock className="size-4" aria-hidden="true" />
              Be there {game.arriveByMinutes} minutes early
            </p>
          )}

          {!live && game.clock?.state !== 'finished' && (
            <div className="mt-5"><Countdown target={game.kickoffAt} /></div>
          )}

          {live && (
            <p className="display mt-4 text-5xl tabular-nums text-[var(--accent)]">
              {String(Math.floor((game.clock.elapsedMs ?? 0) / 60000)).padStart(2, '0')}′
            </p>
          )}

          <div className="mt-5">
            <CapacityMeter
              confirmed={game.confirmedCount}
              capacity={game.capacity}
              waitlist={game.waitlistCount}
            />
          </div>

          {/* 2. AM I IN? ------------------------------------------------- */}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            {!isAuthenticated ? (
              <Button to="/login" size="lg" className="flex-1">Sign in to join</Button>
            ) : game.isRegistered ? (
              <Button
                variant="secondary"
                size="lg"
                className="flex-1"
                loading={leave.isPending}
                onClick={() => leave.mutate({ gameId: game.id })}
                disabled={!can.canJoin && !can.reason?.includes('full')}
              >
                {game.myWaitlistPosition ? 'Leave the waiting list' : "Can't make it"}
              </Button>
            ) : can.canJoin ? (
              <Button
                size="lg"
                className="flex-1"
                loading={join.isPending}
                onClick={() => join.mutate({ gameId: game.id })}
              >
                {can.label}
              </Button>
            ) : (
              <p className="flex-1 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-4 py-3 text-center text-sm text-[var(--fg-secondary)]">
                {can.label}
              </p>
            )}

            {game.venue?.mapsUrl && (
              <Button
                as="a"
                href={game.venue.mapsUrl}
                target="_blank"
                rel="noreferrer"
                variant="secondary"
                size="lg"
              >
                <Navigation className="size-4" /> Directions
              </Button>
            )}
            <Button variant="ghost" size="lg" onClick={share} aria-label="Share this game">
              <Share2 className="size-4" />
            </Button>
          </div>
        </div>
      </Card>

      {/* 4. THE SCORE, when there is one. Above the teams once it exists. */}
      {game.result && (
        <Card className="mt-4 py-5">
          <ScoreLine
            home={teamLabel(game.result.home.color) ?? 'Team A'}
            away={teamLabel(game.result.away.color) ?? 'Team B'}
            homeScore={game.result.home.score}
            awayScore={game.result.away.score}
            size="lg"
          />
          {game.result.motm && (
            <p className="mt-3 text-center text-sm">
              <span className="text-[var(--trophy)]">★</span> Man of the match:{' '}
              <span className="font-semibold">{game.result.motm.name}</span>
            </p>
          )}
        </Card>
      )}

      {live && teams.length >= 2 && !game.result && (
        <Card className="mt-4 py-5">
          <ScoreLine
            home={teamLabel(teams[0].color)}
            away={teamLabel(teams[1].color)}
            homeScore={teams[0].score ?? 0}
            awayScore={teams[1].score ?? 0}
            size="lg"
          />
        </Card>
      )}

      {/* 3. WHO AM I PLAYING WITH? ------------------------------------- */}
      {teams.length > 0 ? (
        <div className="mt-6">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="display text-2xl">Teams</h2>
            {myTeam && (
              <span className="text-sm text-[var(--fg-secondary)]">
                You are in <span className="font-semibold capitalize">{myTeam.color}</span>
              </span>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {teams.map((team) => <TeamSheet key={team.id} team={team} meId={meId} />)}
          </div>

          {/* The shape, for anyone who wants it. Read-only: no drag, no controls. */}
          <Card className="mt-3 overflow-hidden p-2">
            <FootballPitch teams={teams} showRatings={false} />
          </Card>
        </div>
      ) : (
        <Card className="mt-6 p-6">
          <div className="flex items-center gap-3">
            <Users className="size-5 shrink-0 text-[var(--fg-muted)]" aria-hidden="true" />
            <div>
              <p className="font-medium">Teams are not out yet</p>
              <p className="text-sm text-[var(--fg-secondary)]">
                They are picked once the game fills up. You will see yours here.
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="mt-6 text-center">
        <Link to="/games" className="text-sm text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]">
          All fixtures →
        </Link>
      </div>
    </div>
  );
}

function MyGameSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Skeleton className="h-80 rounded-[var(--radius-lg)]" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-64 rounded-[var(--radius-lg)]" />
        <Skeleton className="h-64 rounded-[var(--radius-lg)]" />
      </div>
    </div>
  );
}
