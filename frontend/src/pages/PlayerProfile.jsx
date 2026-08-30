// Player profile.
//
// Built to be browsed, not merely read. The hero is a broadcast player bug, the stats
// are a swipe rail on mobile, and the match history is the part people actually come
// back for -- their own football story inside Sports Fusion.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Trophy, CalendarCheck, Flame } from 'lucide-react';
import { usePlayer } from '../hooks/index.js';
import { useSession } from '../state/session.jsx';
import {
  Card, Tabs, TabsList, TabsTrigger, TabsContent, Skeleton, ErrorState, EmptyState,
  SectionHeading, Modal, Badge, Progress, Button,
} from '../components/ui/index.jsx';
import {
  PlayerHero, StatGrid, MatchTimeline, ShareablePlayerCard,
} from '../components/players/index.jsx';
import { RatingChart } from '../components/charts/index.jsx';
import { FormStrip } from '../components/football/index.jsx';
import { AchievementCard } from '../components/rewards/index.jsx';
import { percent } from '../lib/format.js';
import { toast } from 'sonner';
import { playerService } from '../api/services.js';
import { PositionPicker } from '../components/players/PositionPicker.jsx';

export default function PlayerProfile({ self = false }) {
  const { id } = useParams();
  const { player: sessionPlayer } = useSession();
  const targetId = self ? (sessionPlayer?.id ?? 'me') : id;

  const { data, isLoading, isError, refetch } = usePlayer(targetId);
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) return <ProfileSkeleton />;
  if (isError || !data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <ErrorState title="Player not found" onRetry={refetch} />
      </div>
    );
  }

  const { player, history, ratingHistory, achievements } = data;
  // The server's figure, which counts a game cancelled with a day's notice as kept
  // rather than missed. Recomputing it here as attended/registered punishes a player for
  // pulling out early, which is the behaviour the league wants to encourage.
  const attendanceRate = player.attendanceRate
    ?? (player.games > 0 ? player.attended / player.games : null);

  const stats = [
    { label: 'Games', value: player.games },
    { label: 'Goals', value: player.goals, tone: 'accent' },
    { label: 'Assists', value: player.assists },
    { label: 'MOTM', value: player.motm, tone: 'trophy' },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <PlayerHero
        player={player}
        ratingHistory={ratingHistory}
        onShare={() => setShareOpen(true)}
        onEdit={self ? () => setEditOpen(true) : undefined}
      />

      <div className="mt-6">
        <StatGrid stats={stats} />
      </div>

      <div className="mt-8">
        <Tabs defaultValue="form">
          <TabsList className="mb-6">
            <TabsTrigger value="form">Form</TabsTrigger>
            <TabsTrigger value="history">Matches</TabsTrigger>
            <TabsTrigger value="achievements">Achievements</TabsTrigger>
          </TabsList>

          <TabsContent value="form" className="space-y-6 focus:outline-none">
            <Card className="p-5">
              <SectionHeading eyebrow="Last five" title="Recent form" className="mb-4" />
              <div className="flex items-end gap-6">
                <FormStrip form={player.form ?? []} showValues className="scale-125 origin-left" />
                <div className="ml-auto text-right">
                  <p className="eyebrow text-[0.625rem]">Average</p>
                  <p className="display text-3xl tnum">
                    {player.form?.length
                      ? (player.form.reduce((s, f) => s + f, 0) / player.form.length).toFixed(1)
                      : '—'}
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-5">
              <SectionHeading eyebrow="Over time" title="Rating history" className="mb-4" />
              <RatingChart history={ratingHistory} />
            </Card>

            <div className="grid gap-4 sm:grid-cols-2">
              <Card className="p-5">
                <p className="eyebrow text-[0.625rem]">Reliability</p>
                <p className="display mt-1.5 text-4xl tnum">
                  {attendanceRate == null ? '—' : percent(attendanceRate)}
                </p>
                <Progress
                  value={(attendanceRate ?? 0) * 100}
                  className="mt-3"
                  label="Attendance rate"
                  tone={attendanceRate >= 0.9 ? 'accent' : attendanceRate >= 0.75 ? 'trophy' : 'danger'}
                />
                <p className="mt-2 text-xs text-[var(--fg-secondary)]">
                  {player.attended} of {player.games} games attended
                  {player.noShows > 0 && ` · ${player.noShows} no-show${player.noShows === 1 ? '' : 's'}`}
                </p>
              </Card>

              <Card className="p-5">
                <p className="eyebrow text-[0.625rem]">Current streak</p>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <p className="display text-4xl tnum">{player.streak ?? 0}</p>
                  {player.streak >= 5 && <Flame className="size-6 text-[var(--trophy)]" aria-hidden="true" />}
                </div>
                <p className="mt-2 text-xs text-[var(--fg-secondary)]">
                  {player.streak >= 5
                    ? 'Consecutive games attended. Keep it going.'
                    : 'Consecutive games attended.'}
                </p>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="history" className="focus:outline-none">
            {history?.length ? (
              <MatchTimeline matches={history} />
            ) : (
              <EmptyState
                icon={CalendarCheck}
                title="Your Sports Fusion story starts here"
                description="Play your first game and it will appear on this timeline."
              />
            )}
          </TabsContent>

          <TabsContent value="achievements" className="focus:outline-none">
            {achievements?.length ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {achievements.map((achievement) => (
                  <AchievementCard key={achievement.slug} achievement={achievement} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={Trophy}
                title="No achievements yet"
                description="Your first one is waiting for you."
              />
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* There was no way to change your positions after signing up -- the endpoint
          existed and nothing in the app called it, so whatever you tapped once at a
          pitch was permanent. */}
      <EditPositions
        open={editOpen}
        onOpenChange={setEditOpen}
        player={player}
        onSaved={refetch}
      />

      <Modal open={shareOpen} onOpenChange={setShareOpen} title="Your player card" size="sm">
        <div className="flex justify-center">
          <ShareablePlayerCard player={player} />
        </div>
        <p className="mt-4 text-center text-xs text-[var(--fg-secondary)]">
          Screenshot and share it wherever your football happens.
        </p>
      </Modal>
    </div>
  );
}

/**
 * Change where you play.
 *
 * Positions are the one thing on a profile a player owns outright: their rating is
 * earned, their record is history, but this is a statement of preference that ought to
 * change when they start dropping into midfield.
 */
function EditPositions({ open, onOpenChange, player, onSaved }) {
  const [primary, setPrimary] = useState(player.position ?? null);
  const [secondary, setSecondary] = useState(player.secondaryPositions ?? []);
  const [busy, setBusy] = useState(false);

  // Reset to what the server holds each time it opens, so an abandoned edit does not
  // reappear as if it had been saved.
  useEffect(() => {
    if (!open) return;
    setPrimary(player.position ?? null);
    setSecondary(player.secondaryPositions ?? []);
  }, [open, player.position, player.secondaryPositions]);

  const save = async () => {
    setBusy(true);
    try {
      await playerService.update({
        preferredPosition: primary ?? undefined,
        secondaryPositions: secondary,
        isGoalkeeper: primary === 'GK' || secondary.includes('GK'),
      });
      toast.success('Positions saved');
      onOpenChange(false);
      onSaved?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Where you play"
      description="Your main position, and up to two more you are happy to fill in at."
      footer={
        <Button className="w-full" size="lg" loading={busy} onClick={save} disabled={!primary}>
          Save
        </Button>
      }
    >
      <PositionPicker
        primary={primary}
        secondary={secondary}
        onChange={({ primary: p, secondary: s }) => { setPrimary(p); setSecondary(s); }}
      />
    </Modal>
  );
}

function ProfileSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="h-56 rounded-[var(--radius-lg)]" />
      <div className="mt-6 grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 rounded-[var(--radius-lg)]" />)}
      </div>
      <Skeleton className="mt-8 h-10 w-64 rounded-[var(--radius-md)]" />
      <Skeleton className="mt-6 h-52 rounded-[var(--radius-lg)]" />
    </div>
  );
}
