// Admin games list, player list, and analytics.
//
// Three views sharing one route component because they share the same data and the same
// dense table treatment. Splitting them into three files would triple the imports to say
// the same thing.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CalendarPlus, Search, Users } from 'lucide-react';
import { useGames, useAdminOverview, useDistricts, useLeaderboard } from '../../hooks/index.js';
import {
  Card, Button, Input, Select, Segmented, Skeleton, EmptyState, SectionHeading, StatCard, Badge,
} from '../../components/ui/index.jsx';
import { CapacityMeter, GameStatusChip, RatingBadge, PositionChip } from '../../components/football/index.jsx';
import { Avatar } from '../../components/ui/index.jsx';
import { BarSeries, Donut } from '../../components/charts/index.jsx';
import { relativeDay, time, percent, compact } from '../../lib/format.js';

function GamesTable() {
  const [when, setWhen] = useState('upcoming');
  const { data, isLoading } = useGames({ when });

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 px-4 pt-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Fixtures</p>
          <h1 className="display text-4xl">Games</h1>
        </div>
        <Button to="/admin/schedule"><CalendarPlus className="size-4" /> Schedule a game</Button>
      </header>

      <Segmented
        options={[{ key: 'upcoming', label: 'Upcoming' }, { key: 'past', label: 'Played' }]}
        value={when}
        onChange={setWhen}
      />

      {isLoading ? (
        <Skeleton className="h-96 rounded-[var(--radius-lg)]" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <caption className="sr-only">Games, {when}</caption>
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-left">
                {['When', 'District', 'Venue', 'Capacity', 'Status', ''].map((heading) => (
                  <th key={heading} scope="col" className="px-4 py-2.5 text-xs font-semibold text-[var(--fg-muted)] uppercase tracking-wide">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {(data?.games ?? []).map((game) => (
                <tr key={game.id} className="hover:bg-[var(--bg-sunken)]">
                  <td className="px-4 py-3">
                    <p className="font-medium">{relativeDay(game.kickoffAt)}</p>
                    <p className="text-xs text-[var(--fg-muted)] tnum">{time(game.kickoffAt)}</p>
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {game.venue?.name ?? game.districtName}
                    <span className="ml-1.5 text-xs font-normal text-[var(--fg-muted)]">
                      {game.districtName}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--fg-secondary)]">{game.venue?.name ?? '—'}</td>
                  <td className="w-40 px-4 py-3">
                    <CapacityMeter
                      confirmed={game.confirmedCount}
                      capacity={game.capacity}
                      waitlist={game.waitlistCount}
                      size="sm"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <GameStatusChip status={game.status} confirmed={game.confirmedCount} capacity={game.capacity} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button to={`/admin/games/${game.id}`} size="sm" variant="secondary">Manage</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

/** Attendance rate, or null when there is not enough to judge on. */
function reliabilityOf(player) {
  if ((player.games ?? 0) < 3) return -1;
  return (player.attended ?? 0) / Math.max(1, player.games);
}

function ReliabilityBar({ player }) {
  const rate = reliabilityOf(player);
  if (rate < 0) {
    return <span className="text-[0.6875rem] text-[var(--fg-muted)]">Too few games</span>;
  }

  const tone =
    rate >= 0.9 ? 'var(--accent)' : rate >= 0.75 ? 'var(--trophy)' : 'var(--danger)';

  return (
    <span className="block" title={`${player.attended} of ${player.games} games attended`}>
      <span className="flex items-baseline justify-between text-[0.6875rem] tnum">
        <span className="text-[var(--fg-secondary)]">{percent(rate)}</span>
        {player.noShows > 0 && (
          <span className="text-[var(--danger)]">{player.noShows} missed</span>
        )}
      </span>
      <span className="mt-1 block h-1.5 rounded-full bg-[var(--bg-sunken)]">
        <span
          className="block h-full rounded-full"
          style={{ width: `${rate * 100}%`, background: tone }}
        />
      </span>
    </span>
  );
}

function PlayersTable() {
  const [query, setQuery] = useState('');
  const [districtId, setDistrictId] = useState('');
  const { data: districtData } = useDistricts();
  const { data, isLoading } = useLeaderboard({ metric: 'rating', limit: 100, districtId: districtId || undefined });

  const [sort, setSort] = useState('rating');

  const filtered = useMemo(() => {
    let list = data?.leaderboard ?? [];
    if (query.trim()) {
      const needle = query.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(needle));
    }
    if (sort === 'reliability') {
      // Anyone with fewer than three games has no meaningful rate, so they sort last
      // rather than topping the list on a perfect 1-for-1.
      list = [...list].sort((a, b) => reliabilityOf(b) - reliabilityOf(a));
    }
    if (sort === 'noshows') list = [...list].sort((a, b) => (b.noShows ?? 0) - (a.noShows ?? 0));
    return list;
  }, [data, query, sort]);

  return (
    <div className="space-y-5">
      <header>
        <p className="eyebrow">Community</p>
        <h1 className="display text-4xl">Players</h1>
      </header>

      <div className="flex flex-wrap gap-2">
        <Segmented
          options={[
            { key: 'rating', label: 'Rating' },
            { key: 'reliability', label: 'Reliability' },
            { key: 'noshows', label: 'No-shows' },
          ]}
          value={sort}
          onChange={setSort}
          size="sm"
        />
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fg-muted)]" aria-hidden="true" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players"
            className="pl-9"
            aria-label="Search players"
          />
        </div>
        <div className="w-full sm:w-48">
          <Select value={districtId} onChange={(e) => setDistrictId(e.target.value)} aria-label="Filter by district">
            <option value="">All districts</option>
            {(districtData?.districts ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 rounded-[var(--radius-lg)]" />
      ) : filtered.length === 0 ? (
        <Card><EmptyState icon={Users} title="No players match" description="Try a different name or district." /></Card>
      ) : (
        <Card className="divide-y divide-[var(--border-subtle)]">
          {filtered.map((player) => (
            <Link
              key={player.id}
              to={`/players/${player.id}`}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-sunken)]"
            >
              <span className="w-8 text-center text-xs text-[var(--fg-muted)] tnum">{player.rank}</span>
              <Avatar name={player.name} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{player.name}</span>
              <PositionChip position={player.position} size="sm" />
              <span className="hidden w-24 truncate text-xs text-[var(--fg-muted)] sm:block">{player.districtName}</span>

              {/* Reliability: the aggregate of every attendance mark. Marking happens
                  per game; this is where it adds up to a judgement. */}
              <span className="hidden w-32 sm:block">
                <ReliabilityBar player={player} />
              </span>

              <span className="w-12 text-right text-xs text-[var(--fg-secondary)] tnum">
                {player.games}g
              </span>
              <RatingBadge mu={player.ratingMu} sigma={player.ratingSigma} size="sm" />
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function Analytics() {
  const { data, isLoading } = useAdminOverview();
  const { data: districtData } = useDistricts();

  if (isLoading) return <Skeleton className="h-96 rounded-[var(--radius-lg)]" />;

  const platform = districtData?.platform;
  const palette = ['#00c06a', '#3d8bff', '#f5c451', '#f4523f', '#7fd8c2', '#9aa5b1'];

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Business</p>
        <h1 className="display text-4xl">Analytics</h1>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Players" value={compact(platform?.players ?? 0)} />
        <StatCard label="Games this month" value={platform?.gamesThisMonth ?? 0} tone="accent" />
        <StatCard label="Avg. occupancy" value={percent(platform?.avgOccupancy ?? 0)} />
        <StatCard label="Player hours" value={compact(platform?.playerHours ?? 0)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <SectionHeading eyebrow="Trend" title="Occupancy by week" className="mb-4" />
          <BarSeries
            data={data.occupancyTrend.map((d, i) => ({ ...d, highlight: i === data.occupancyTrend.length - 1 }))}
            height={160}
            formatValue={(v) => `${Math.round(v * 100)}%`}
            label="Average occupancy by week"
          />
          <p className="mt-4 text-xs text-[var(--fg-secondary)]">
            Sustained occupancy above 90% in a district usually means there is demand for
            another weekly fixture there.
          </p>
        </Card>

        <Card className="p-5">
          <SectionHeading eyebrow="Split" title="Games by district" className="mb-4" />
          <div className="flex items-center gap-6">
            <Donut
              segments={data.districtPerformance.map((d, i) => ({
                label: d.name,
                value: Math.max(d.gamesPlayed, 1),
                color: palette[i % palette.length],
              }))}
              centre={
                <div>
                  <p className="display text-2xl tnum">
                    {data.districtPerformance.reduce((s, d) => s + d.gamesPlayed, 0)}
                  </p>
                  <p className="eyebrow text-[0.5625rem]">games</p>
                </div>
              }
            />
            <ul className="min-w-0 flex-1 space-y-1.5">
              {data.districtPerformance.map((district, i) => (
                <li key={district.name} className="flex items-center gap-2 text-sm">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: palette[i % palette.length] }} />
                  <span className="min-w-0 flex-1 truncate">{district.name}</span>
                  <span className="text-[var(--fg-muted)] tnum">{district.gamesPlayed}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function AdminGames({ listing = 'games' }) {
  if (listing === 'players') return <PlayersTable />;
  if (listing === 'analytics') return <Analytics />;
  return <GamesTable />;
}
