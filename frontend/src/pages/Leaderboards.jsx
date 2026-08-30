// Leaderboards.
//
// Seven boards, not one. A single "best players" table makes 90% of the community feel
// like spectators; separate boards for reliability, most improved, assists and MOTM mean
// most regulars are near the top of something. That is the difference between a ranking
// that builds a community and one that quietly tells people not to bother.

import { useState } from 'react';
import { Trophy } from 'lucide-react';
import { useLeaderboard, useDistricts, useManOfTheMonth } from '../hooks/index.js';
import { LEADERBOARD_METRICS } from '../lib/catalogue.js';
import {
  Card, Segmented, Select, Skeleton, EmptyState, ErrorState, Badge,
} from '../components/ui/index.jsx';
import { PlayerCard } from '../components/players/index.jsx';
import { RatingBadge } from '../components/football/index.jsx';
import { Avatar } from '../components/ui/index.jsx';
import { percent } from '../lib/format.js';
import { ManOfTheMonthCard, PreviousWinners } from '../components/rankings/ManOfTheMonth.jsx';

const DESCRIPTIONS = {
  rating: 'Only players we have seen enough of are ranked — a couple of good nights is not a season. Among them, ordered by rating.',
  form: 'Average across the last five games.',
  goals: 'Career goals in Sports Fusion games.',
  assists: 'Career assists.',
  motm: 'Man of the Match awards.',
  reliability: 'Turning up when you said you would. Needs at least three games.',
  improved: 'Biggest rise across recent form.',
};

/** The top three get a podium; positions four and below get a list. */
function Podium({ players, metric }) {
  if (players.length < 3) return null;
  const order = [players[1], players[0], players[2]];
  const heights = ['h-20', 'h-28', 'h-16'];
  const medals = ['#9aa5b1', '#f5c451', '#b87333'];

  return (
    <div className="mb-8 grid grid-cols-3 items-end gap-2 sm:gap-4">
      {order.map((player, i) => {
        const actualRank = i === 1 ? 1 : i === 0 ? 2 : 3;
        return (
          <div key={player.id} className="text-center">
            <Avatar name={player.name} size={i === 1 ? 'lg' : 'md'} className="mx-auto" ring={i === 1} />
            <p className="mt-2 truncate text-xs font-semibold sm:text-sm">{player.name}</p>
            {metric === 'rating' ? (
              <div className="mt-1 flex justify-center">
                <RatingBadge mu={player.ratingMu} sigma={player.ratingSigma} size="sm" />
              </div>
            ) : (
              <p className="display mt-1 text-xl tnum">
                {metric === 'reliability' ? percent(player.value ?? 0) : Math.round((player.value ?? 0) * 10) / 10}
              </p>
            )}
            <div
              className={`mt-2 grid place-items-center rounded-t-[var(--radius-md)] ${heights[i]}`}
              style={{ background: `linear-gradient(to top, ${medals[actualRank - 1]}22, ${medals[actualRank - 1]}08)` }}
            >
              <span className="display text-3xl" style={{ color: medals[actualRank - 1] }}>
                {actualRank}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Leaderboards() {
  const [metric, setMetric] = useState('rating');
  const [districtId, setDistrictId] = useState('');

  const { data: districtData } = useDistricts();
  const { data: motm } = useManOfTheMonth();
  const { data, isLoading, isError, refetch } = useLeaderboard({
    metric,
    districtId: districtId || undefined,
    limit: 50,
  });

  const players = data?.leaderboard ?? [];
  // Under three names there is no podium to stand on, so everybody goes in the list.
  const podium = players.length >= 3 ? players.slice(0, 3) : [];
  const rest = players.length >= 3 ? players.slice(3) : players;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6">
        <p className="eyebrow">Rankings</p>
        <h1 className="display text-4xl sm:text-5xl">Leaderboards</h1>
      </header>

      {/* The month's honour leads the page. It is the single most prestigious thing
          the community awards, so it outranks the table. */}
      {motm?.current && (
        <div className="mb-8 grid gap-4 lg:grid-cols-[1.4fr_1fr] lg:items-start">
          <ManOfTheMonthCard award={motm.current} />
          <PreviousWinners winners={motm.previous} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          options={LEADERBOARD_METRICS.map((m) => ({ key: m.key, label: m.label }))}
          value={metric}
          onChange={setMetric}
        />
        <div className="ml-auto w-full sm:w-44">
          <Select
            value={districtId}
            onChange={(e) => setDistrictId(e.target.value)}
            aria-label="Filter by district"
            className="h-9 text-sm"
          >
            <option value="">All Lebanon</option>
            {(districtData?.districts ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>
        </div>
      </div>

      <p className="mb-6 text-sm text-[var(--fg-secondary)]">{DESCRIPTIONS[metric]}</p>

      {isError ? (
        <ErrorState title="Could not load rankings" onRetry={refetch} />
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-16 rounded-[var(--radius-md)]" />
          ))}
        </div>
      ) : players.length === 0 ? (
        <EmptyState
          icon={Trophy}
          title="No ranking yet"
          description="Once enough games have been played here, the table fills up."
        />
      ) : (
        <>
          {/* The podium takes the top three; the list takes the rest.

              WHICH MEANS A BOARD OF ONE OR TWO USED TO RENDER NOTHING AT ALL. The podium
              returns null under three players and the list started at index three, so
              anything with 1-3 entries fell between them: the page drew a heading, a
              description, and blank space. Not the empty state either, because the board
              was not empty. The Man of the Match board, which has exactly one name on it
              for most of a season, was invisible for that entire time. */}
          {podium.length === 3 && <Podium players={podium} metric={metric} />}
          {rest.length > 0 && (
            <Card className="divide-y divide-[var(--border-subtle)] p-1">
              {rest.map((player) => (
                <PlayerCard
                  key={player.playerId}
                  player={player}
                  rank={player.rank}
                  metric={metric}
                  href={`/players/${player.playerId}`}
                />
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
