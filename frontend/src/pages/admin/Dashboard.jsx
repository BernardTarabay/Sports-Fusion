// Admin dashboard.
//
// Opens on the answer to "what needs me today", not on a chart. The open-actions list is
// the most important thing on the page: a game that is full but has no teams, or played
// but has no result, is work sitting undone, and it should be one tap from here.

import { Link } from 'react-router';
import {
  AlertTriangle, Users, Clock, TrendingUp, ArrowRight, CalendarPlus, CheckCircle2,
} from 'lucide-react';
import { useAdminOverview } from '../../hooks/index.js';
import {
  Card, StatCard, Button, Badge, Skeleton, EmptyState, ErrorState, SectionHeading,
} from '../../components/ui/index.jsx';
import { BarSeries } from '../../components/charts/index.jsx';
import { CapacityMeter, GameStatusChip } from '../../components/football/index.jsx';
import { relativeDay, time, percent, compact } from '../../lib/format.js';

const ACTION_COPY = {
  generate_teams: { label: 'Teams needed', cta: 'Build teams', tone: 'danger' },
  enter_result: { label: 'Result needed', cta: 'Enter result', tone: 'trophy' },
  low_signups: { label: 'Filling slowly', cta: 'Open game', tone: 'info' },
};

function ActionRow({ action }) {
  const copy = ACTION_COPY[action.type] ?? { label: action.label, cta: 'Open', tone: 'neutral' };

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span
        className="w-1 self-stretch rounded-full"
        style={{
          background:
            copy.tone === 'danger' ? 'var(--danger)'
              : copy.tone === 'trophy' ? 'var(--trophy)'
                : 'var(--info)',
        }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {action.game.districtName}
          <span className="ml-2 font-normal text-[var(--fg-muted)]">
            {relativeDay(action.game.kickoffAt)} · {time(action.game.kickoffAt)}
          </span>
        </p>
        <p className="text-xs text-[var(--fg-secondary)]">
          {copy.label}
          {action.type === 'low_signups' &&
            ` · ${action.game.confirmedCount}/${action.game.capacity}`}
        </p>
      </div>
      <Button to={`/admin/games/${action.game.id}`} size="sm" variant="secondary">
        {copy.cta}
      </Button>
    </li>
  );
}

export default function AdminDashboard() {
  const { data, isLoading, isError, refetch } = useAdminOverview();

  if (isError) return <ErrorState title="Could not load the dashboard" onRetry={refetch} />;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 rounded-[var(--radius-lg)]" />)}
        </div>
        <Skeleton className="h-64 rounded-[var(--radius-lg)]" />
      </div>
    );
  }

  const { today, openActions, upcoming, occupancyTrend, districtPerformance } = data;

  return (
    <div className="mx-auto max-w-[1600px] space-y-8 px-4 pt-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Today</p>
          <h1 className="display text-4xl">Command centre</h1>
        </div>
        <Button to="/admin/schedule">
          <CalendarPlus className="size-4" /> Schedule a game
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Games today" value={today.games} icon={Clock} />
        <StatCard label="Registered" value={today.registered} icon={Users} tone="accent" />
        <StatCard label="Waitlisted" value={today.waitlisted} />
        <StatCard label="Attendance" value={percent(today.attendance)} icon={TrendingUp} />
      </div>

      <section>
        <SectionHeading
          eyebrow={openActions.length > 0 ? `${openActions.length} waiting` : 'All clear'}
          title="Needs you"
        />
        {openActions.length === 0 ? (
          <Card>
            <EmptyState
              icon={CheckCircle2}
              title="Nothing outstanding"
              description="Every game has teams and every result is in. Enjoy it while it lasts."
            />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-[var(--border-subtle)]">
              {openActions.map((action) => (
                <ActionRow key={`${action.type}-${action.gameId}`} action={action} />
              ))}
            </ul>
          </Card>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <section>
          <SectionHeading
            eyebrow="Next up"
            title="Upcoming games"
            action={<Button to="/admin/games" variant="ghost" size="sm">All <ArrowRight className="size-4" /></Button>}
          />
          <Card>
            <ul className="divide-y divide-[var(--border-subtle)]">
              {upcoming.map((game) => (
                <li key={game.id}>
                  <Link
                    to={`/admin/games/${game.id}`}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-[var(--bg-sunken)]"
                  >
                    <div className="w-24 shrink-0">
                      <p className="text-sm font-medium">{relativeDay(game.kickoffAt)}</p>
                      <p className="text-xs text-[var(--fg-muted)] tnum">{time(game.kickoffAt)}</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{game.districtName}</p>
                      <p className="truncate text-xs text-[var(--fg-muted)]">{game.venue?.name}</p>
                    </div>
                    <div className="hidden w-32 sm:block">
                      <CapacityMeter
                        confirmed={game.confirmedCount}
                        capacity={game.capacity}
                        waitlist={game.waitlistCount}
                        size="sm"
                        showLabel={false}
                      />
                    </div>
                    <span className="w-14 text-right text-sm tnum">
                      {game.confirmedCount}/{game.capacity}
                    </span>
                    <GameStatusChip status={game.status} confirmed={game.confirmedCount} capacity={game.capacity} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        <div className="space-y-6">
          <section>
            <SectionHeading eyebrow="Last 12 weeks" title="Occupancy" />
            <Card className="p-5">
              <BarSeries
                data={occupancyTrend.map((d, i) => ({
                  ...d,
                  highlight: i === occupancyTrend.length - 1,
                }))}
                formatValue={(v) => `${Math.round(v * 100)}%`}
                label="Average game occupancy by week"
              />
            </Card>
          </section>

          <section>
            <SectionHeading eyebrow="By district" title="Performance" />
            <Card className="divide-y divide-[var(--border-subtle)]">
              {districtPerformance.map((district) => (
                <div key={district.name} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{district.name}</span>
                  <span className="text-xs text-[var(--fg-muted)] tnum">{district.activeGames} games</span>
                  <span
                    className={`display w-14 text-right text-lg tnum ${
                      district.occupancy >= 0.9
                        ? 'text-[var(--accent)]'
                        : district.occupancy >= 0.75
                          ? 'text-[var(--trophy)]'
                          : 'text-[var(--danger)]'
                    }`}
                  >
                    {percent(district.occupancy)}
                  </span>
                </div>
              ))}
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
