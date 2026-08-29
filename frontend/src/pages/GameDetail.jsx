// The game page.
//
// One page, three lives:
//   BEFORE  — matchday. Countdown, capacity, join/leave. The registration state is the
//             single most important thing on screen and is repeated in a sticky bar on
//             mobile so it is never scrolled away from.
//   TEAMS   — the pitch. Once teams are out, this becomes the reason to open the app.
//   AFTER   — the report. Score, MOTM, a shareable card.

import { useState } from 'react';
import { useParams, Link } from 'react-router';
import {
  MapPin, Clock, Users, Share2, Calendar, ChevronLeft, Trophy, AlertCircle, Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { useGame, useJoinGame, useLeaveGame, useCountdown } from '../hooks/index.js';
import { useSession } from '../state/session.jsx';
import {
  Button, Card, Badge, Tabs, TabsList, TabsTrigger, TabsContent, Modal, Skeleton,
  ErrorState, EmptyState, SectionHeading,
} from '../components/ui/index.jsx';
import {
  CapacityMeter, GameStatusChip, ScoreLine, FootballPitch, PositionChip, TeamCrest, RatingBadge,
} from '../components/football/index.jsx';
import { Avatar } from '../components/ui/index.jsx';
import { ShareableMatchCard } from '../components/players/index.jsx';
import { time, dayAndDate, relativeDay, pad } from '../lib/format.js';

function KickoffClock({ target }) {
  const { days, hours, minutes, seconds, expired } = useCountdown(target);
  if (expired) return null;

  const blocks = days > 0
    ? [[days, 'days'], [hours, 'hrs'], [minutes, 'min']]
    : [[hours, 'hrs'], [minutes, 'min'], [seconds, 'sec']];

  return (
    <div className="flex gap-4" role="timer">
      {blocks.map(([value, label]) => (
        <div key={label}>
          <span className="display block text-3xl leading-none tnum">{pad(value)}</span>
          <span className="eyebrow text-[0.625rem]">{label}</span>
        </div>
      ))}
    </div>
  );
}

function RosterList({ roster = [], waitlist = [], currentPlayerId }) {
  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="display text-xl">Registered</h3>
          <span className="text-sm text-[var(--fg-muted)] tnum">{roster.length}</span>
        </div>
        <ol className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          {roster.map((player, i) => (
            <li
              key={player.playerId}
              className={cnRow(player.playerId === currentPlayerId)}
            >
              <span className="w-6 shrink-0 text-center text-xs text-[var(--fg-muted)] tnum">{i + 1}</span>
              <Avatar name={player.name} size="sm" />
              <Link to={`/players/${player.playerId}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">
                {player.name}
                {player.playerId === currentPlayerId && (
                  <span className="ml-2 text-xs font-normal text-[var(--accent)]">you</span>
                )}
              </Link>
              <PositionChip position={player.position} size="sm" />
            </li>
          ))}
        </ol>
      </div>

      {waitlist.length > 0 && (
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="display text-xl">Waiting list</h3>
            <span className="text-sm text-[var(--fg-muted)] tnum">{waitlist.length}</span>
          </div>
          {/* The rule stated plainly. This is the thing that stops people asking in the
              group chat, so it is worth the sentence. */}
          <p className="mb-3 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3 py-2 text-xs text-[var(--fg-secondary)]">
            If someone drops out, the next person on this list gets the spot automatically
            and is notified straight away.
          </p>
          <ol className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            {waitlist.map((player) => (
              <li key={player.playerId} className={cnRow(player.playerId === currentPlayerId)}>
                <span className="display w-6 shrink-0 text-center text-[var(--trophy)]">
                  {player.waitlistPosition}
                </span>
                <Avatar name={player.name} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {player.name}
                  {player.playerId === currentPlayerId && (
                    <span className="ml-2 text-xs font-normal text-[var(--accent)]">you</span>
                  )}
                </span>
                <PositionChip position={player.position} size="sm" />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

const cnRow = (isMe) =>
  `flex items-center gap-3 px-3 py-2.5 ${isMe ? 'bg-[var(--accent-soft)]' : ''}`;

function TeamPanel({ team, selectedId, onSelect }) {
  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
        <TeamCrest color={team.color} size={26} />
        <span className="display text-xl">{team.color}</span>
        <span className="ml-auto text-xs text-[var(--fg-muted)]">
          {team.players.length} players
        </span>
      </div>
      <ol className="divide-y divide-[var(--border-subtle)]">
        {team.players.map((player) => (
          <li key={player.id}>
            <button
              onClick={() => onSelect(player.id === selectedId ? null : player.id)}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                selectedId === player.id ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-sunken)]'
              }`}
            >
              <span className="display w-6 text-center text-sm text-[var(--fg-muted)] tnum">
                {player.shirtNumber}
              </span>
              <PositionChip position={player.position} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{player.name}</span>
              <RatingBadge mu={player.ratingMu} sigma={player.ratingSigma} size="sm" />
            </button>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function GameDetail() {
  const { idOrSlug } = useParams();
  const { data, isLoading, isError, refetch } = useGame(idOrSlug);
  const { isAuthenticated, player } = useSession();
  const join = useJoinGame();
  const leave = useLeaveGame();

  const [selectedPlayerId, setSelectedPlayerId] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  if (isLoading) return <GameDetailSkeleton />;
  if (isError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <ErrorState title="Game not found" description="This game may have been removed." onRetry={refetch} />
      </div>
    );
  }

  const game = data.game;
  const kickoff = new Date(game.kickoffAt);
  const isPast = kickoff < new Date();
  const isFull = game.confirmedCount >= game.capacity;
  const hasTeams = game.teams?.length === 2;
  const cancelled = game.status === 'cancelled';

  const share = async () => {
    const url = `${window.location.origin}/games/${game.slug ?? game.id}`;
    const text = `${game.districtName} · ${dayAndDate(kickoff)} ${time(kickoff)} — ${
      game.confirmedCount
    }/${game.capacity} players`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Sports Fusion', text, url }); return; } catch { /* cancelled */ }
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast.success('Link copied — paste it into your group');
  };

  const primaryAction = () => {
    if (!isAuthenticated) return <Button to="/login" size="lg" className="w-full">Sign in to join</Button>;
    if (cancelled || isPast) return null;

    if (game.isRegistered) {
      return (
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={() => setConfirmLeave(true)}
          loading={leave.isPending}
        >
          {game.myWaitlistPosition ? 'Leave waiting list' : 'Cancel my spot'}
        </Button>
      );
    }

    return (
      <Button
        size="lg"
        className="w-full"
        loading={join.isPending}
        onClick={() => join.mutate({ gameId: game.id })}
      >
        {isFull ? 'Join waiting list' : 'Join this game'}
      </Button>
    );
  };

  return (
    <div className="pb-24 lg:pb-0">
      {/* Header */}
      <div className="floodlit border-b border-[var(--border-subtle)]">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
          <Link
            to="/games"
            className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
          >
            <ChevronLeft className="size-4" /> All games
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2">
                <GameStatusChip status={game.status} confirmed={game.confirmedCount} capacity={game.capacity} />
                <span className="text-sm text-[var(--fg-secondary)]">{relativeDay(kickoff)}</span>
              </div>

              <h1 className="display text-4xl leading-none sm:text-6xl">{game.districtName}</h1>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-[var(--fg-secondary)]">
                <span className="flex items-center gap-1.5">
                  <Calendar className="size-4" aria-hidden="true" /> {dayAndDate(kickoff)}
                </span>
                <span className="flex items-center gap-1.5 font-semibold text-[var(--fg-primary)]">
                  <Clock className="size-4" aria-hidden="true" /> {time(kickoff)}
                </span>
                {game.venue && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="size-4" aria-hidden="true" /> {game.venue.name}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <Users className="size-4" aria-hidden="true" /> {game.teamSize}-a-side
                </span>
              </div>
            </div>

            <Button variant="secondary" size="sm" onClick={share}>
              <Share2 className="size-4" /> Share
            </Button>
          </div>

          {cancelled && (
            <div className="mt-5 flex items-start gap-3 rounded-[var(--radius-md)] bg-[var(--danger-soft)] p-4">
              <AlertCircle className="mt-0.5 size-5 shrink-0 text-[var(--danger)]" aria-hidden="true" />
              <div>
                <p className="font-semibold text-[var(--danger-soft-fg)]">This game was cancelled</p>
                <p className="mt-0.5 text-sm text-[var(--danger-soft-fg)]">{game.cancelledReason}</p>
              </div>
            </div>
          )}

          {!isPast && !cancelled && (
            <div className="mt-6 grid gap-5 sm:grid-cols-[auto_1fr] sm:items-end">
              <KickoffClock target={game.kickoffAt} />
              <div className="sm:max-w-sm sm:justify-self-end sm:w-full">
                <CapacityMeter
                  confirmed={game.confirmedCount}
                  capacity={game.capacity}
                  waitlist={game.waitlistCount}
                />
              </div>
            </div>
          )}

          {game.isRegistered && !isPast && (
            <div className="mt-5">
              <Badge tone={game.myWaitlistPosition ? 'trophy' : 'accent'} className="px-3 py-1.5 text-sm">
                {game.myWaitlistPosition ? (
                  <>Waiting list · position {game.myWaitlistPosition}</>
                ) : (
                  <><Check className="size-3.5" aria-hidden="true" /> You&rsquo;re in</>
                )}
              </Badge>
            </div>
          )}

          {/* Desktop action sits inline; mobile gets the sticky bar below. */}
          <div className="mt-6 hidden max-w-xs lg:block">{primaryAction()}</div>
        </div>
      </div>

      {/* Result */}
      {game.result && (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
            <p className="eyebrow mb-6 text-center">Full time</p>
            <ScoreLine
              home="Black"
              away="White"
              homeScore={game.result.score.black}
              awayScore={game.result.score.white}
              size="lg"
            />
            {game.result.motm && (
              <div className="mt-10 text-center">
                <p className="display text-xs tracking-[0.22em] text-[var(--trophy)]">MAN OF THE MATCH</p>
                <div className="mt-3 flex items-center justify-center gap-3">
                  <Avatar name={game.result.motm.name} size="md" />
                  <Link to={`/players/${game.result.motm.playerId}`} className="display text-3xl hover:underline">
                    {game.result.motm.name}
                  </Link>
                  <RatingBadge mu={1500 + (game.result.motm.rating - 6.5) * 150} sigma={50} size="lg" />
                </div>
              </div>
            )}
            <div className="mt-8 flex justify-center">
              <Button variant="secondary" onClick={() => setShareOpen(true)}>
                <Share2 className="size-4" /> Share result
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Teams / roster */}
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <Tabs defaultValue={hasTeams ? 'teams' : 'roster'}>
          <TabsList className="mb-6">
            {hasTeams && <TabsTrigger value="teams">Teams</TabsTrigger>}
            <TabsTrigger value="roster">
              Players {game.confirmedCount > 0 && `(${game.confirmedCount})`}
            </TabsTrigger>
            {game.venue && <TabsTrigger value="venue">Venue</TabsTrigger>}
          </TabsList>

          {hasTeams && (
            <TabsContent value="teams" className="space-y-6 focus:outline-none">
              <FootballPitch
                teams={game.teams}
                selectedPlayerId={selectedPlayerId}
                onSelectPlayer={(p) => setSelectedPlayerId(p.id === selectedPlayerId ? null : p.id)}
              />

              <div className="grid gap-4 lg:grid-cols-2">
                {game.teams.map((team) => (
                  <TeamPanel
                    key={team.id}
                    team={team}
                    selectedId={selectedPlayerId}
                    onSelect={setSelectedPlayerId}
                  />
                ))}
              </div>
            </TabsContent>
          )}

          <TabsContent value="roster" className="focus:outline-none">
            {game.roster.length === 0 ? (
              <EmptyState
                icon={Users}
                title="Nobody has joined yet"
                description="Be the first on the sheet."
              />
            ) : (
              <RosterList
                roster={game.roster}
                waitlist={game.waitlist}
                currentPlayerId={player?.id}
              />
            )}
          </TabsContent>

          {game.venue && (
            <TabsContent value="venue" className="focus:outline-none">
              <Card className="p-5">
                <h3 className="display text-2xl">{game.venue.name}</h3>
                <p className="mt-1 text-sm text-[var(--fg-secondary)]">{game.venue.address}</p>
                <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="eyebrow text-[0.625rem]">Surface</dt>
                    <dd className="mt-1 capitalize">{game.venue.pitchType}</dd>
                  </div>
                  <div>
                    <dt className="eyebrow text-[0.625rem]">Arrive by</dt>
                    <dd className="mt-1 tnum">
                      {time(new Date(kickoff.getTime() - game.arriveByMinutes * 60000))}
                    </dd>
                  </div>
                </dl>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Mobile sticky action. The registration decision is never more than a thumb away. */}
      {!isPast && !cancelled && (
        <div className="fixed inset-x-0 bottom-14 z-30 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]/95 p-3 pb-safe backdrop-blur-lg lg:hidden">
          {primaryAction()}
        </div>
      )}

      <Modal
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Give up your spot?"
        description={
          game.waitlistCount > 0
            ? `${game.waitlist[0]?.name ?? 'The next player'} on the waiting list will take it straight away.`
            : 'You can rejoin later if there is still room.'
        }
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setConfirmLeave(false)}>
              Stay in
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              loading={leave.isPending}
              onClick={() => {
                leave.mutate({ gameId: game.id });
                setConfirmLeave(false);
              }}
            >
              Give up spot
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--fg-secondary)]">
          Cancelling early helps everyone — the spot goes to someone who wants to play.
        </p>
      </Modal>

      <Modal open={shareOpen} onOpenChange={setShareOpen} title="Share this result" size="sm">
        <div className="flex justify-center">
          <ShareableMatchCard game={game} />
        </div>
        <p className="mt-4 text-center text-xs text-[var(--fg-secondary)]">
          Screenshot this and drop it in your group.
        </p>
      </Modal>
    </div>
  );
}

function GameDetailSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-14 w-64" />
      <Skeleton className="mt-3 h-4 w-80" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="mt-8 h-72 rounded-[var(--radius-lg)]" />
    </div>
  );
}
