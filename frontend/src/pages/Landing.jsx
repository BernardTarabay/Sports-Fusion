// Landing.
//
// The job of this page is to prove, in one screen, that Sports Fusion is a living
// network rather than a company website. So the hero does not say "welcome to our
// community" -- it puts tonight's actual fixture on screen with a live countdown, and
// the first thing below the fold is real games you can join right now.
//
// Everything here is real data from the service layer. Nothing is decorative filler.

import { Link } from 'react-router';
import { ArrowRight, MapPin, Users, Trophy, Zap } from 'lucide-react';
import { useGames, useDistricts, useLeaderboard, useCountdown, useCountUp } from '../hooks/index.js';
import { Button, Card, SectionHeading, Badge } from '../components/ui/index.jsx';
import { GameCard, GameCardSkeleton } from '../components/games/GameCard.jsx';
import { CapacityMeter, ScoreLine, RatingBadge } from '../components/football/index.jsx';
import { PlayerCard } from '../components/players/index.jsx';
import { LogoMark } from '../components/shared/Logo.jsx';
import { useSession } from '../state/session.jsx';
import { time, dayName, compact, pad, relativeDay } from '../lib/format.js';

function Countdown({ target }) {
  const { days, hours, minutes, seconds, expired } = useCountdown(target);
  if (expired) return <span className="display text-2xl text-[var(--accent)]">KICK OFF</span>;

  const blocks = days > 0
    ? [[days, 'days'], [hours, 'hrs'], [minutes, 'min']]
    : [[hours, 'hrs'], [minutes, 'min'], [seconds, 'sec']];

  return (
    <div className="flex gap-3" role="timer" aria-label={`Kick off in ${days} days ${hours} hours ${minutes} minutes`}>
      {blocks.map(([value, label]) => (
        <div key={label} className="text-center">
          <span className="display block text-3xl sm:text-4xl leading-none tnum">{pad(value)}</span>
          <span className="eyebrow text-[0.625rem]">{label}</span>
        </div>
      ))}
    </div>
  );
}

function Hero({ featured }) {
  // The hero is shown to strangers and to regulars alike; only the second button differs.
  const { isAuthenticated } = useSession();

  return (
    <section className="floodlit relative overflow-hidden border-b border-[var(--border-subtle)]">
      {/* Pitch geometry, very low contrast. Suggests a stadium without a stock photo. */}
      <svg
        className="pointer-events-none absolute inset-0 size-full opacity-[0.055]"
        viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true"
      >
        <circle cx="600" cy="300" r="150" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M600 0v600" stroke="currentColor" strokeWidth="2" />
        <rect x="0" y="140" width="180" height="320" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="1020" y="140" width="180" height="320" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>

      <div className="relative mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
              <span className="text-xs font-medium">Football across Lebanon, every week</span>
            </div>

            <h1 className="display text-[clamp(2.75rem,9vw,5.5rem)] leading-[0.88]">
              Your game.
              <br />
              Your city.
              <br />
              <span className="text-[var(--accent)]">Your community.</span>
            </h1>

            <p className="mt-6 max-w-md text-lg text-[var(--fg-secondary)]">
              Find a game. Join your district. Meet your team. Play.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button to="/games" size="lg" className="sm:w-auto">
                Find a game <ArrowRight className="size-4" />
              </Button>
              {isAuthenticated ? (
                <Button to="/matchday" variant="secondary" size="lg">
                  Your matchday
                </Button>
              ) : (
                <Button to="/districts" variant="secondary" size="lg">
                  Explore Sports Fusion
                </Button>
              )}
            </div>
          </div>

          {/* Tonight's fixture, live. This is the proof the network is running. */}
          {featured && (
            <Card glow className="relative overflow-hidden">
              <div className="bg-[var(--accent)] px-5 py-2">
                <p className="display text-xs tracking-[0.2em] text-[var(--accent-fg)]">
                  {relativeDay(featured.kickoffAt).toUpperCase()} · NEXT KICK OFF
                </p>
              </div>

              <div className="p-5 sm:p-6">
                <p className="display text-4xl sm:text-5xl leading-none">{featured.districtName}</p>
                {featured.venue && (
                  <p className="mt-2 flex items-center gap-1.5 text-sm text-[var(--fg-secondary)]">
                    <MapPin className="size-4" aria-hidden="true" />
                    {featured.venue.name}
                  </p>
                )}

                <p className="display mt-5 text-2xl">{dayName(featured.kickoffAt)} · {time(featured.kickoffAt)}</p>

                <div className="mt-5">
                  <Countdown target={featured.kickoffAt} />
                </div>

                <div className="mt-6">
                  <CapacityMeter
                    confirmed={featured.confirmedCount}
                    capacity={featured.capacity}
                    waitlist={featured.waitlistCount}
                  />
                </div>

                <Button to={`/games/${featured.slug ?? featured.id}`} className="mt-5 w-full" size="lg">
                  {featured.confirmedCount >= featured.capacity ? 'Join waiting list' : 'Join this game'}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}

function LiveStats({ platform }) {
  const players = useCountUp(platform?.players ?? 0);
  const games = useCountUp(platform?.gamesThisMonth ?? 0);

  const stats = [
    { label: 'Players', value: compact(Math.round(players)), icon: Users },
    { label: 'Districts', value: platform?.districts ?? '—', icon: MapPin },
    { label: 'Games this month', value: Math.round(games), icon: Zap },
    { label: 'Average occupancy', value: `${Math.round((platform?.avgOccupancy ?? 0) * 100)}%`, icon: Trophy },
  ];

  return (
    <section className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-y divide-[var(--border-subtle)] sm:grid-cols-4 sm:divide-y-0">
        {stats.map((stat) => (
          <div key={stat.label} className="px-4 py-6 text-center sm:px-6 sm:py-8">
            <p className="display text-4xl sm:text-5xl tnum">{stat.value}</p>
            <p className="eyebrow mt-1.5 text-[0.625rem]">{stat.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Landing() {
  // This page is the front door AND the home tab, so half of it is written for someone who
  // has never heard of Sports Fusion and half is being read by a player who signed up
  // months ago. Anything that says "join us" has to know the difference -- telling a
  // signed-in player to create a profile is the app admitting it does not know who they
  // are.
  const { isAuthenticated } = useSession();

  const { data: gamesData, isLoading: gamesLoading } = useGames({ when: 'upcoming' });
  const { data: pastData } = useGames({ when: 'past' });
  const { data: districtData } = useDistricts();
  const { data: leaderboardData } = useLeaderboard({ metric: 'rating', limit: 5 });

  const upcoming = gamesData?.games ?? [];
  const featured = upcoming.find((g) => g.status !== 'cancelled');
  const recent = (pastData?.games ?? []).filter((g) => g.result).slice(0, 3);
  const matchOfWeek = recent.find(
    (g) => Math.abs(g.result.score.black - g.result.score.white) <= 1 && g.result.motm
  ) ?? recent[0];

  return (
    <>
      <Hero featured={featured} />
      <LiveStats platform={districtData?.platform} />

      {/* Games first. Someone who lands here wants to play, not to read about us. */}
      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
        <SectionHeading
          eyebrow="This week"
          title="Games you can join"
          action={<Button to="/games" variant="ghost" size="sm">All games <ArrowRight className="size-4" /></Button>}
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {gamesLoading
            ? Array.from({ length: 3 }, (_, i) => <GameCardSkeleton key={i} />)
            : upcoming.slice(0, 6).map((game) => <GameCard key={game.id} game={game} />)}
        </div>
      </section>

      {/* Districts */}
      <section className="border-y border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
          <SectionHeading
            eyebrow="Across Lebanon"
            title="Find your district"
            action={<Button to="/districts" variant="ghost" size="sm">See all <ArrowRight className="size-4" /></Button>}
          />

          <div className="snap-rail sm:grid sm:grid-cols-3 sm:gap-4 lg:grid-cols-6 -mx-4 px-4 sm:mx-0 sm:px-0">
            {(districtData?.districts ?? []).map((district) => (
              <Link
                key={district.id}
                to={`/districts/${district.slug}`}
                className="card card-interactive min-w-40 p-4 sm:min-w-0"
              >
                <p className="display text-2xl">{district.name}</p>
                <p className="mt-0.5 text-xs text-[var(--fg-muted)]">{district.region}</p>
                <div className="mt-4 space-y-1.5">
                  <p className="flex items-baseline justify-between text-xs">
                    <span className="text-[var(--fg-secondary)]">Games</span>
                    <span className="display text-lg tnum">{district.activeGames}</span>
                  </p>
                  <p className="flex items-baseline justify-between text-xs">
                    <span className="text-[var(--fg-secondary)]">Players</span>
                    <span className="display text-lg tnum">{compact(district.players * 32)}</span>
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Match of the week + rankings */}
      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <SectionHeading eyebrow="Last week" title="Match of the week" />
            {matchOfWeek ? (
              <Card className="overflow-hidden">
                <div className="bg-[var(--bg-sunken)] px-5 py-2.5">
                  <p className="eyebrow text-[0.625rem]">
                    {matchOfWeek.districtName} · {relativeDay(matchOfWeek.kickoffAt)}
                  </p>
                </div>
                <div className="p-6 sm:p-8">
                  <ScoreLine
                    home="Black"
                    away="White"
                    homeScore={matchOfWeek.result.score.black}
                    awayScore={matchOfWeek.result.score.white}
                    size="lg"
                  />
                  {matchOfWeek.result.motm && (
                    <div className="mt-8 flex items-center justify-center gap-3 border-t border-[var(--border-subtle)] pt-6">
                      <Badge tone="trophy">
                        <Trophy className="size-3" aria-hidden="true" /> Man of the Match
                      </Badge>
                      <span className="display text-2xl">{matchOfWeek.result.motm.name}</span>
                      <RatingBadge mu={1500 + (matchOfWeek.result.motm.rating - 6.5) * 150} sigma={50} />
                    </div>
                  )}
                  <Button
                    to={`/games/${matchOfWeek.slug ?? matchOfWeek.id}`}
                    variant="secondary"
                    className="mt-6 w-full"
                  >
                    Full match report
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="p-8 text-center text-sm text-[var(--fg-secondary)]">
                No results yet this week.
              </Card>
            )}
          </div>

          <div>
            <SectionHeading
              eyebrow="Rankings"
              title="Top players"
              action={<Button to="/leaderboards" variant="ghost" size="sm">Full table</Button>}
            />
            <Card className="divide-y divide-[var(--border-subtle)] p-1">
              {(leaderboardData?.leaderboard ?? []).map((player) => (
                <PlayerCard
                  key={player.id}
                  player={player}
                  rank={player.rank}
                  href={`/players/${player.id}`}
                />
              ))}
            </Card>
          </div>
        </div>
      </section>

      {/* Closing call to action */}
      <section className="border-t border-[var(--border-subtle)]">
        <div className="floodlit mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <LogoMark className="mx-auto mb-6 h-14" />
          <h2 className="display text-[clamp(2rem,6vw,3.5rem)] leading-none">
            This is where football happens.
          </h2>
          <p className="mx-auto mt-4 max-w-md text-[var(--fg-secondary)]">
            No more scrolling a group chat to find out if you got a spot. Join a game, see
            your team, track your form.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            {isAuthenticated ? (
              <>
                <Button to="/games" size="lg">Find a game</Button>
                <Button to="/profile" variant="secondary" size="lg">Your profile</Button>
              </>
            ) : (
              <>
                <Button to="/signup" size="lg">Create your profile</Button>
                <Button to="/games" variant="secondary" size="lg">Browse games</Button>
              </>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
