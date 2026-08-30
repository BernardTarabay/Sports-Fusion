// Districts.
//
// The map is a real, if simplified, Lebanon: the outline follows the actual coastline
// and eastern border, and the district shapes tile it. Not a tile layer -- that would
// cost ~40KB of library plus network requests to show six labelled regions -- and not
// an abstract blob either, because Lebanese players would spot the difference at once.

import { Link, useParams } from 'react-router';
import { MapPin, ChevronLeft } from 'lucide-react';
import { useDistricts, useDistrict } from '../hooks/index.js';
import {
  Card, Skeleton, EmptyState, ErrorState, SectionHeading, Button, StatCard, Badge,
} from '../components/ui/index.jsx';
import { GameCard, GameCardSkeleton } from '../components/games/GameCard.jsx';
import { PlayerCard } from '../components/players/index.jsx';
import { compact, percent } from '../lib/format.js';

import { LebanonMap } from '../components/districts/LebanonMap.jsx';

export function DistrictsIndex() {
  const { data, isLoading, isError, refetch } = useDistricts();

  if (isError) {
    return <div className="mx-auto max-w-4xl px-4 py-16"><ErrorState onRetry={refetch} /></div>;
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8">
        <p className="eyebrow">Across Lebanon</p>
        <h1 className="display text-4xl sm:text-5xl">Districts</h1>
        <p className="mt-2 max-w-lg text-[var(--fg-secondary)]">
          Follow as many as you like. You are part of Sports Fusion, not stuck in one group.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
        <Card className="flex justify-center p-6">
          {isLoading ? (
            <Skeleton className="aspect-square w-full max-w-md" />
          ) : (
            <LebanonMap districts={data.districts} />
          )}
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          {isLoading
            ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-40 rounded-[var(--radius-lg)]" />)
            : data.districts.map((district) => (
                <Link key={district.id} to={`/districts/${district.slug}`} className="card card-interactive p-5">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="display text-2xl">{district.name}</p>
                      <p className="text-xs text-[var(--fg-muted)]">{district.region}</p>
                    </div>
                    {district.activeGames > 0 && (
                      <Badge tone="accent">{district.activeGames} live</Badge>
                    )}
                  </div>

                  <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <dd className="display text-xl tnum">{compact(district.players)}</dd>
                      <dt className="eyebrow text-[0.5625rem]">Players</dt>
                    </div>
                    <div>
                      <dd className="display text-xl tnum">{district.venues}</dd>
                      <dt className="eyebrow text-[0.5625rem]">Venues</dt>
                    </div>
                    <div>
                      <dd className="display text-xl tnum">{percent(district.occupancy)}</dd>
                      <dt className="eyebrow text-[0.5625rem]">Full</dt>
                    </div>
                  </dl>
                </Link>
              ))}
        </div>
      </div>
    </div>
  );
}

export function DistrictDetail() {
  const { slug } = useParams();
  const { data, isLoading, isError, refetch } = useDistrict(slug);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Skeleton className="h-12 w-48" />
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 rounded-[var(--radius-lg)]" />)}
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => <GameCardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return <div className="mx-auto max-w-4xl px-4 py-16"><ErrorState title="District not found" onRetry={refetch} /></div>;
  }

  // Defaulted, because a district with no fixtures and no venues is an ordinary state
    // and `upcoming.map` on undefined is a blank page with a console error.
  const {
    district, upcoming = [], recent = [], venues = [], leaderboard = [],
  } = data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <Link to="/districts" className="mb-2 -ml-2 inline-flex min-h-11 items-center gap-1 px-2 text-sm text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]">
        <ChevronLeft className="size-4" /> All districts
      </Link>

      <header className="floodlit mb-8">
        <p className="eyebrow">{district.region}</p>
        <h1 className="display text-5xl sm:text-7xl leading-none">{district.name}</h1>
      </header>

      <div className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Active games" value={district.activeGames ?? 0} tone="accent" />
        <StatCard label="Players" value={compact(district.players)} />
        <StatCard label="Avg. occupancy" value={percent(district.occupancy)} />
        <StatCard label="Venues" value={district.venues ?? 0} />
      </div>

      <section className="mb-12">
        <SectionHeading eyebrow="Coming up" title="Upcoming games" />
        {upcoming.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="Nothing scheduled here yet"
            description="The pitch is waiting. Try a neighbouring district in the meantime."
            action={<Button to="/games" variant="secondary">Browse all games</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((game) => <GameCard key={game.id} game={game} />)}
          </div>
        )}
      </section>

      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <SectionHeading eyebrow="Rankings" title={`Top in ${district.name}`} />
          <Card className="divide-y divide-[var(--border-subtle)] p-1">
            {leaderboard.length === 0 ? (
              <p className="p-4 text-sm text-[var(--fg-secondary)]">
                Nobody is ranked here yet. Ratings appear once games have been played.
              </p>
            ) : (
              leaderboard.slice(0, 8).map((player) => (
                <PlayerCard key={player.id} player={player} rank={player.rank} href={`/players/${player.id}`} />
              ))
            )}
          </Card>
        </section>

        <section>
          <SectionHeading eyebrow="Where you play" title="Venues" />
          <div className="space-y-3">
            {venues.length === 0 && (
              <p className="text-sm text-[var(--fg-secondary)]">No pitches listed here yet.</p>
            )}
            {venues.map((venue) => (
              <Card key={venue.id} className="p-4">
                <p className="display text-lg">{venue.name}</p>
                <p className="mt-0.5 text-xs text-[var(--fg-secondary)]">{venue.address}</p>
                <div className="mt-2 flex gap-2">
                  <Badge tone="outline" size="sm" className="capitalize">{venue.pitchType}</Badge>
                  <Badge tone="outline" size="sm">{venue.capacity} players</Badge>
                </div>
              </Card>
            ))}
          </div>
        </section>
      </div>

      {recent.length > 0 && (
        <section className="mt-12">
          <SectionHeading eyebrow="Last few weeks" title="Recent results" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((game) => <GameCard key={game.id} game={game} showAction={false} />)}
          </div>
        </section>
      )}
    </div>
  );
}
