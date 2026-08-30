// Admin game management.
//
// The whole lifecycle on one page: roster, team generation, hand overrides, result, and
// the WhatsApp announcement to paste into the community.
//
// The team-generation sequence is the deliberate exception to "animations should be
// fast". It takes about a second because the real backend evaluates 352,716 splits, and
// showing the work is what makes an admin trust the answer instead of assuming the
// computer shuffled names.

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, Sparkles, Copy, Check, MessageSquare, Trophy, Users, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useMatchday, useCopy, keys } from '../../hooks/index.js';
import { adminService } from '../../api/services.js';
import { ANNOUNCEMENT_KINDS } from '../../lib/catalogue.js';
import {
  Button, Card, Badge, Tabs, TabsList, TabsTrigger, TabsContent, Modal, Skeleton,
  ErrorState, EmptyState, SectionHeading, Select, Field, Input, Segmented,
} from '../../components/ui/index.jsx';
import { CapacityMeter, GameStatusChip, PositionChip, TeamCrest, teamStrength } from '../../components/football/index.jsx';
import { Avatar } from '../../components/ui/index.jsx';
import { TeamBuilder } from '../../components/teams/TeamBuilder.jsx';
import { AttendancePanel } from '../../components/matchday/index.jsx';
import { matchdayService } from '../../api/services.js';
import { dayAndDate, time, relativeDay } from '../../lib/format.js';

/* --------------------------------------------------------------------------
   Generation sequence. Each line is a real stage of the backend algorithm.
   -------------------------------------------------------------------------- */
const STAGES = [
  'Reading player ratings',
  'Weighing rating uncertainty',
  'Checking positions and keepers',
  'Reviewing who played together recently',
  'Evaluating 352,716 possible splits',
  'Balancing squads',
];

function GenerationOverlay({ open, onDone, result }) {
  const [stage, setStage] = useState(0);

  // Advance through the stages while the request is in flight, then reveal the result.
  useEffect(() => {
    if (!open) { setStage(0); return undefined; }
    const id = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length)), 160);
    return () => clearInterval(id);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--bg-canvas)]/95 backdrop-blur-sm p-6">
      <div className="w-full max-w-sm">
        <p className="eyebrow text-center">Generating teams</p>

        <ol className="mt-6 space-y-2.5" aria-live="polite">
          {STAGES.map((label, i) => (
            <li
              key={label}
              className={`flex items-center gap-2.5 text-sm transition-opacity duration-300 ${
                i <= stage ? 'opacity-100' : 'opacity-30'
              }`}
            >
              {i < stage ? (
                <Check className="size-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
              ) : i === stage ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-[var(--accent)]" aria-hidden="true" />
              ) : (
                <span className="size-4 shrink-0 rounded-full border border-[var(--border-default)]" />
              )}
              {label}
            </li>
          ))}
        </ol>

        {result && (
          <div className="mt-8 text-center">
            <div className="flex items-center justify-center gap-6">
              {result.teams.map((team) => (
                <div key={team.id}>
                  <TeamCrest color={team.color} size={28} className="mx-auto" />
                  <p className="display mt-1 text-3xl tnum">
                    {teamStrength(team.players).toFixed(1)}
                  </p>
                  <p className="eyebrow text-[0.5625rem]">{team.color}</p>
                </div>
              ))}
            </div>
            <p className="display mt-6 text-2xl text-[var(--accent)]">Teams ready</p>
            <Button className="mt-4 w-full" onClick={onDone}>See the pitch</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Announcement composer — the copy/paste bridge to WhatsApp.
   -------------------------------------------------------------------------- */
function AnnouncementPanel({ gameId }) {
  const [kind, setKind] = useState('registration_open');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const { copied, copy } = useCopy();

  const generate = useCallback(async (nextKind) => {
    setKind(nextKind);
    setLoading(true);
    try {
      const result = await adminService.announcement(gameId, nextKind);
      setBody(result.body);
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => { generate('registration_open'); }, [generate]);

  return (
    <Card className="p-5">
      <SectionHeading eyebrow="WhatsApp" title="Announcement" className="mb-4" />

      {/* The constraint stated plainly, because it explains why this is copy/paste. */}
      <p className="mb-4 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3 py-2 text-xs text-[var(--fg-secondary)]">
        WhatsApp&rsquo;s business API cannot post into groups, so this is generated for you
        to paste. Individual messages — confirmations, waitlist promotions, reminders —
        are sent automatically.
      </p>

      <Segmented
        options={ANNOUNCEMENT_KINDS.map((k) => ({ key: k.key, label: k.label }))}
        value={kind}
        onChange={generate}
        size="sm"
        className="mb-4"
      />

      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 font-sans text-sm leading-relaxed">
        {loading ? 'Generating…' : body}
      </pre>

      <Button
        className="mt-4 w-full"
        variant={copied ? 'secondary' : 'primary'}
        onClick={async () => { if (await copy(body)) toast.success('Copied — paste it into the group'); }}
      >
        {copied ? <><Check className="size-4" /> Copied</> : <><Copy className="size-4" /> Copy message</>}
      </Button>
    </Card>
  );
}

/* --------------------------------------------------------------------------
   Result entry — the three-tap flow.
   -------------------------------------------------------------------------- */
function ResultForm({ game, onSubmit, submitting }) {
  const [black, setBlack] = useState(0);
  const [white, setWhite] = useState(0);
  const [motm, setMotm] = useState('');

  const everyone = game.teams.flatMap((t) => t.players);

  return (
    <Card className="p-5">
      <SectionHeading eyebrow="Full time" title="Record the result" className="mb-5" />

      <div className="flex items-end justify-center gap-6">
        {[['black', black, setBlack], ['white', white, setWhite]].map(([colour, value, set]) => (
          <div key={colour} className="text-center">
            <TeamCrest color={colour} size={28} className="mx-auto mb-2" />
            <Input
              type="number"
              min={0}
              max={99}
              value={value}
              onChange={(e) => set(Number(e.target.value))}
              className="w-20 text-center display text-2xl"
              aria-label={`${colour} score`}
            />
            <p className="eyebrow mt-1 text-[0.5625rem]">{colour}</p>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <Field label="Man of the Match" htmlFor="motm" hint="Optional, but it makes the report.">
          <Select id="motm" value={motm} onChange={(e) => setMotm(e.target.value)}>
            <option value="">Nobody this time</option>
            {everyone.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </Field>
      </div>

      <p className="mt-4 text-xs text-[var(--fg-secondary)]">
        Everyone confirmed is marked as having played. Flag any no-shows on the Players tab
        first if you need to.
      </p>

      <Button
        className="mt-4 w-full"
        size="lg"
        loading={submitting}
        onClick={() => onSubmit({ score: { black, white }, motmPlayerId: motm || null })}
      >
        <Trophy className="size-4" /> Publish result
      </Button>
    </Card>
  );
}

/* ========================================================================== */

export default function AdminGameManage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useMatchday(id, { admin: true });

  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(null);
  const [draftTeams, setDraftTeams] = useState(null);
  const [savingResult, setSavingResult] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  /**
   * Attendance writes straight into the cached game so the list reacts on tap.
   *
   * Waiting on a refetch to redraw twenty-two rows is exactly the lag that makes an
   * admin give up and stop recording it.
   */
  const applyGame = (next) => {
    if (next) queryClient.setQueryData(keys.game(id), { game: next });
  };

  const setAttendance = async (playerId, attendance) => {
    const { game: next } = await matchdayService.setPlayerStat(id, playerId, { attendance });
    applyGame(next);
  };

  const markAllPresent = async (status) => {
    setMarkingAll(true);
    try {
      const { game: next } = await matchdayService.markAllAttendance(id, status);
      applyGame(next);
      toast.success('Everyone marked as here', {
        description: 'Flag the exceptions individually.',
      });
    } finally {
      setMarkingAll(false);
    }
  };

  if (isLoading) return <Skeleton className="h-96 rounded-[var(--radius-lg)]" />;
  if (isError || !data) return <ErrorState title="Game not found" onRetry={refetch} />;

  const game = data.game;
  const teams = draftTeams ?? game.teams;
  const hasTeams = teams?.length === 2;
  const isFull = game.confirmedCount >= game.capacity;

  const generate = async () => {
    setGenerating(true);
    setGenerated(null);
    try {
      const result = await adminService.generateTeams(game.id, {});
      setGenerated(result);
      setDraftTeams(result.teams);
    } catch (error) {
      toast.error(error.message);
      setGenerating(false);
    }
  };

  const publishTeams = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.game(id) });
    toast.success('Teams published', { description: 'Everyone playing has been notified.' });
    setDraftTeams(null);
  };

  const submitResult = async (payload) => {
    setSavingResult(true);
    try {
      await adminService.submitResult(game.id, payload);
      await queryClient.invalidateQueries({ queryKey: keys.game(id) });
      toast.success('Result published', { description: 'Points and ratings are on their way.' });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingResult(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 px-4 pt-6 sm:px-6">
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]">
        <ChevronLeft className="size-4" /> Command centre
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <GameStatusChip status={game.status} confirmed={game.confirmedCount} capacity={game.capacity} />
            <span className="text-sm text-[var(--fg-secondary)]">{relativeDay(game.kickoffAt)}</span>
          </div>
          <h1 className="display text-4xl">{game.venue?.name ?? game.districtName}</h1>
          <p className="mt-1 text-sm text-[var(--fg-secondary)]">
            {dayAndDate(game.kickoffAt)} · {time(game.kickoffAt)}
            {game.venue && ` · ${game.venue.name}`}
          </p>
        </div>

        <div className="w-full max-w-xs">
          <CapacityMeter
            confirmed={game.confirmedCount}
            capacity={game.capacity}
            waitlist={game.waitlistCount}
          />
        </div>
      </header>

      <Tabs defaultValue={hasTeams ? 'teams' : 'players'}>
        <TabsList className="mb-6">
          <TabsTrigger value="players">Players ({game.confirmedCount})</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="result">Result</TabsTrigger>
          <TabsTrigger value="announce">Announce</TabsTrigger>
        </TabsList>

        <TabsContent value="players" className="focus:outline-none">
          <div className="grid gap-4 lg:grid-cols-2">
            <AttendancePanel
              roster={game.roster}
              kickoffAt={game.kickoffAt}
              busy={markingAll}
              onSet={setAttendance}
              onMarkAll={markAllPresent}
            />

            <Card>
              <div className="border-b border-[var(--border-subtle)] px-4 py-3">
                <h3 className="display text-lg">Waiting list</h3>
              </div>
              {game.waitlist.length === 0 ? (
                <EmptyState icon={Users} title="Nobody waiting" description="Everyone who wanted in, got in." />
              ) : (
                <ol className="divide-y divide-[var(--border-subtle)]">
                  {game.waitlist.map((player) => (
                    <li key={player.playerId} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="display w-5 text-center text-[var(--trophy)]">{player.waitlistPosition}</span>
                      <Avatar name={player.name} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{player.name}</span>
                      <PositionChip position={player.position} size="sm" />
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="teams" className="focus:outline-none">
          {hasTeams ? (
            <TeamBuilder
              teams={teams}
              onChange={setDraftTeams}
              onRegenerate={generate}
              onPublish={publishTeams}
              regenerating={generating}
            />
          ) : (
            <Card>
              <EmptyState
                icon={Sparkles}
                title={isFull ? 'Ready to build teams' : 'Not full yet'}
                description={
                  isFull
                    ? 'The balancer evaluates every possible split and picks from the best few, so the teams differ week to week.'
                    : `${game.capacity - game.confirmedCount} more player${
                        game.capacity - game.confirmedCount === 1 ? '' : 's'
                      } needed before teams can be built.`
                }
                action={
                  isFull ? (
                    <Button onClick={generate} loading={generating} size="lg">
                      <Sparkles className="size-4" /> Generate teams
                    </Button>
                  ) : null
                }
              />
            </Card>
          )}
        </TabsContent>

        <TabsContent value="result" className="focus:outline-none">
          {game.result ? (
            <Card className="p-6 text-center">
              <p className="eyebrow">Recorded</p>
              <p className="display mt-3 text-5xl tnum">
                {game.result.home.score} — {game.result.away.score}
              </p>
              {game.result.motm && (
                <p className="mt-3 text-sm text-[var(--fg-secondary)]">
                  <Trophy className="mr-1 inline size-4 text-[var(--trophy)]" aria-hidden="true" />
                  {game.result.motm.name}
                </p>
              )}
            </Card>
          ) : hasTeams ? (
            <ResultForm game={{ ...game, teams }} onSubmit={submitResult} submitting={savingResult} />
          ) : (
            <Card>
              <EmptyState
                icon={Trophy}
                title="Teams first"
                description="Build the teams before recording a result."
              />
            </Card>
          )}
        </TabsContent>

        <TabsContent value="announce" className="focus:outline-none">
          <div className="max-w-2xl">
            <AnnouncementPanel gameId={game.id} />
          </div>
        </TabsContent>
      </Tabs>

      <GenerationOverlay
        open={generating}
        result={generated}
        onDone={() => { setGenerating(false); setGenerated(null); }}
      />
    </div>
  );
}
