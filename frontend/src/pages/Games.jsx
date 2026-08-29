// Game discovery.
//
// Grouped by day rather than presented as a flat list, because "what is on Friday" is
// the actual question. A 40-row list sorted by date makes you do the grouping in your
// head.

import { useMemo, useState } from 'react';
import { CalendarDays, SlidersHorizontal } from 'lucide-react';
import { useGames, useDistricts } from '../hooks/index.js';
import { GameCard, GameCardSkeleton } from '../components/games/GameCard.jsx';
import { Button, EmptyState, ErrorState, Segmented, Select } from '../components/ui/index.jsx';
import { relativeDay, dayAndDate } from '../lib/format.js';

const WHEN_OPTIONS = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Results' },
];

export default function Games() {
  const [when, setWhen] = useState('upcoming');
  const [districtId, setDistrictId] = useState('');
  const [availability, setAvailability] = useState('all');

  const { data: districtData } = useDistricts();
  const { data, isLoading, isError, refetch } = useGames({ when, districtId: districtId || undefined });

  const filtered = useMemo(() => {
    let list = data?.games ?? [];
    if (availability === 'open') {
      list = list.filter((g) => g.confirmedCount < g.capacity && g.status !== 'cancelled');
    }
    if (availability === 'mine') list = list.filter((g) => g.isRegistered);
    return list;
  }, [data, availability]);

  // Group by calendar day so the page reads like a fixture list.
  const grouped = useMemo(() => {
    const map = new Map();
    for (const game of filtered) {
      const key = new Date(game.kickoffAt).toDateString();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(game);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6">
        <p className="eyebrow">Fixtures</p>
        <h1 className="display text-4xl sm:text-5xl">Games</h1>
      </header>

      {/* Filters. Sticky on mobile so they survive a long scroll. */}
      <div className="sticky top-14 z-30 -mx-4 mb-6 border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)]/95 px-4 py-3 backdrop-blur-lg sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none lg:top-16">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented options={WHEN_OPTIONS} value={when} onChange={setWhen} />

          <Segmented
            options={[
              { key: 'all', label: 'All' },
              { key: 'open', label: 'Has space' },
              { key: 'mine', label: 'Mine' },
            ]}
            value={availability}
            onChange={setAvailability}
            size="sm"
          />

          <div className="ml-auto w-full sm:w-48">
            <Select
              value={districtId}
              onChange={(e) => setDistrictId(e.target.value)}
              aria-label="Filter by district"
              className="h-9 text-sm"
            >
              <option value="">All districts</option>
              {(districtData?.districts ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {isError ? (
        <ErrorState
          title="Could not load games"
          description="Check your connection and try again."
          onRetry={refetch}
        />
      ) : isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <GameCardSkeleton key={i} />)}
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title={when === 'past' ? 'No results yet' : 'Nothing scheduled yet'}
          description={
            availability === 'mine'
              ? "You haven't joined a game yet. The pitch is waiting."
              : when === 'past'
                ? 'Once games are played, the results appear here.'
                : 'The pitch is waiting. Check back shortly, or pick another district.'
          }
          action={
            availability !== 'all' ? (
              <Button variant="secondary" onClick={() => { setAvailability('all'); setDistrictId(''); }}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="space-y-10">
          {grouped.map(([day, dayGames]) => (
            <section key={day}>
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="display text-2xl">{relativeDay(dayGames[0].kickoffAt)}</h2>
                <span className="text-sm text-[var(--fg-muted)]">{dayAndDate(dayGames[0].kickoffAt)}</span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {dayGames.map((game) => <GameCard key={game.id} game={game} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
