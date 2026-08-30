// Where games come from. The only place.
//
// Sports Fusion runs on weekly rhythm: same pitch, same night, same people. A schedule is
// the RULE; games are instances generated from it. An admin defines "every Sunday 9pm at
// Jounieh" once and never recreates it.
//
// There used to be a second screen for creating a single game, and having both was the
// mistake -- two forms, different fields, and the one an admin reached for first was
// missing the venue. Everything now lives here.
//
// A one-off is still a GAME, not a schedule that fires once. A rule that produces one
// fixture and then sits there forever is a rule you have to remember to delete, and it
// would show up in this list pretending to be a weekly commitment. So "just once" swaps
// the weekday for a date and writes a game directly.
//
// The next five occurrences are always visible, because the useful question is not "what
// rules exist" but "what is coming".

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Plus, Check, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { scheduleService, adminService } from '../../api/services.js';
import { useDistricts, useVenues } from '../../hooks/index.js';
import {
  Button, Card, Badge, Field, Input, Select, Modal, Skeleton, EmptyState, SectionHeading,
  Segmented,
} from '../../components/ui/index.jsx';
import { time, dayNumber, monthName, shortDay } from '../../lib/format.js';

const WEEKDAYS = [
  { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' }, { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

/** The next date that falls on `weekday`, as YYYY-MM-DD. Today counts as next week. */
function nextDateFor(weekday) {
  const d = new Date();
  d.setDate(d.getDate() + ((Number(weekday) - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function ScheduleCard({ schedule, onToggle, onDelete }) {
  return (
    <Card className={schedule.isActive ? '' : 'opacity-60'}>
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="display text-2xl leading-none">
              Every {schedule.weekdayName}
            </p>
            <Badge tone={schedule.isActive ? 'accent' : 'neutral'} size="sm">
              {schedule.isActive ? 'Active' : 'Paused'}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-[var(--fg-secondary)]">
            {schedule.time} · {schedule.districtName}
            {schedule.venueName && ` · ${schedule.venueName}`}
          </p>
          <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
            {schedule.capacity} players · {schedule.teamSize}-a-side
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={schedule.isActive ? 'ghost' : 'secondary'}
            size="sm"
            onClick={() => onToggle(schedule)}
          >
            {schedule.isActive ? 'Pause' : 'Resume'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Delete this schedule"
            onClick={() => onDelete(schedule)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* The point of the page: what this rule produces next. */}
      <div className="border-t border-[var(--border-subtle)] px-4 py-3">
        <p className="eyebrow mb-2 text-[0.5625rem]">Next fixtures</p>
        <div className="flex min-w-0 max-w-full gap-2 overflow-x-auto scrollbar-none">
          {(schedule.upcoming ?? []).map((iso, i) => (
            <div
              key={iso}
              className={`shrink-0 rounded-[var(--radius-md)] border px-2.5 py-1.5 text-center ${
                i === 0 ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-subtle)]'
              }`}
            >
              <p className="eyebrow text-[0.5rem] leading-none">{shortDay(iso)}</p>
              <p className="display text-lg leading-none tnum">{dayNumber(iso)}</p>
              <p className="eyebrow text-[0.4375rem] leading-none">{monthName(iso)}</p>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export default function AdminSchedule() {
  const queryClient = useQueryClient();
  const { data: districtData } = useDistricts();
  const { data, isLoading } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => scheduleService.list(),
  });

  const navigate = useNavigate();
  // 'weekly' makes a rule; 'once' makes a single game. Same fields either way, bar the
  // two that only mean something for a repeating fixture.
  const [mode, setMode] = useState('weekly');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    districtId: '',
    venueId: '',
    weekday: 0,
    time: '21:00',
    capacity: 22,
    price: 10,
    waitlistCapacity: 10,
    durationMinutes: 90,
    horizonDays: 28,
    openImmediately: true,
    // Only used by 'once'. Defaults to the next occurrence of the chosen weekday, so
    // switching modes keeps the day you already picked.
    date: nextDateFor(0),
  });

  // Venues follow the chosen district. Empty until one is picked, which is why the field
  // is disabled rather than showing an empty list that looks broken.
  const { data: venueData } = useVenues(form.districtId);
  const venues = venueData?.venues ?? [];
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!form.districtId) { toast.error('Pick a district first'); return; }
    setSaving(true);
    try {
      const shared = {
        districtId: form.districtId,
        // '' means "decide later"; the API treats absent and empty the same way.
        venueId: form.venueId || undefined,
        capacity: Number(form.capacity),
        teamSize: Number(form.capacity) / 2,
        price: Number(form.price),
        waitlistCapacity: Number(form.waitlistCapacity),
        durationMinutes: Number(form.durationMinutes),
        openImmediately: form.openImmediately,
      };

      if (mode === 'once') {
        // Local wall-clock, handed to the API as an instant. `new Date('YYYY-MM-DDTHH:MM')`
        // is parsed in the browser's own zone, which is the admin's zone, which is the
        // zone they typed the time in.
        const kickoffAt = new Date(`${form.date}T${form.time}`);
        if (Number.isNaN(kickoffAt.getTime())) { toast.error('That date does not look right'); return; }
        if (kickoffAt <= new Date()) { toast.error('That kickoff is in the past'); return; }

        const { game } = await adminService.createGame({ ...shared, kickoffAt: kickoffAt.toISOString() });
        toast.success('Game created');
        await queryClient.invalidateQueries({ queryKey: ['games'] });
        setOpen(false);
        // Straight to the pitch. A one-off has no list to return to -- it is not a
        // schedule, so it will not appear on this page.
        navigate(`/admin/matchday/${game.id}`);
        return;
      }

      await scheduleService.create({
        ...shared,
        weekday: Number(form.weekday),
        time: form.time,
        horizonDays: Number(form.horizonDays),
      });
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
      setOpen(false);
      toast.success('Schedule created', { description: 'Fixtures will be generated automatically.' });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (schedule) => {
    await scheduleService.setActive(schedule.id, !schedule.isActive);
    queryClient.invalidateQueries({ queryKey: ['schedules'] });
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const [alsoRemoveFixtures, setAlsoRemoveFixtures] = useState(false);

  const confirmDelete = async () => {
    setSaving(true);
    try {
      const result = await scheduleService.remove(pendingDelete.id, {
        withFuture: alsoRemoveFixtures,
      });
      toast.success('Schedule deleted', {
        description: result.removedGames
          ? `${result.removedGames} unplayed fixture(s) removed with it.`
          : 'Fixtures already created were kept as one-off games.',
      });
      setPendingDelete(null);
      setAlsoRemoveFixtures(false);
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
      await queryClient.invalidateQueries({ queryKey: ['games'] });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const schedules = data?.schedules ?? [];

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 px-4 pt-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Fixtures</p>
          <h1 className="display text-4xl">Schedule</h1>
          <p className="mt-1 max-w-md text-sm text-[var(--fg-secondary)]">
            Set the weekly rhythm once and fixtures appear on their own — or add a single
            game for a friendly or a replacement night.
          </p>
        </div>
        {/* One button, because there is one form. It opens on weekly, which is what this
            league runs on; "just once" is a tab inside it rather than a second entry. */}
        <Button onClick={() => { setMode('weekly'); setOpen(true); }}>
          <Plus className="size-4" aria-hidden /> New game
        </Button>
      </header>

      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-[var(--radius-lg)]" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarClock}
            title="No recurring games yet"
            description="Set the weekly rhythm once and stop recreating the same fixture every week."
            action={<Button onClick={() => { setMode('weekly'); setOpen(true); }}>Add a game</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {schedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              onToggle={toggle}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      <Modal
        open={!!pendingDelete}
        onOpenChange={(o) => { if (!o) { setPendingDelete(null); setAlsoRemoveFixtures(false); } }}
        title="Delete this schedule?"
        size="sm"
        description={
          pendingDelete
            ? `No more fixtures will be created for every ${pendingDelete.weekdayName}.`
            : ''
        }
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setPendingDelete(null)}>
              Keep it
            </Button>
            <Button variant="danger" className="flex-1" loading={saving} onClick={confirmDelete}>
              <Trash2 className="size-4" /> Delete
            </Button>
          </>
        }
      >
        {/* Deleting the rule and deleting the games it already made are different things,
            and getting them confused loses fixtures people have signed up for. So the
            default keeps them and the other option is an explicit tick. */}
        <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] bg-[var(--surface-2)] p-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--danger)]"
            checked={alsoRemoveFixtures}
            onChange={(e) => setAlsoRemoveFixtures(e.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium">Also delete the fixtures it created</span>
            <span className="mt-0.5 block text-[var(--fg-tertiary)]">
              {pendingDelete?.upcomingCount
                ? `${pendingDelete.upcomingCount} upcoming game${pendingDelete.upcomingCount === 1 ? '' : 's'}. Anything already played is kept either way.`
                : 'Anything already played is kept either way.'}
            </span>
          </span>
        </label>
      </Modal>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title={mode === 'once' ? 'New game' : 'New recurring game'}
        description={
          mode === 'once'
            ? 'A single fixture — a friendly, or a replacement for a cancelled night.'
            : 'Fixtures are created automatically, four weeks ahead.'
        }
        size="lg"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="flex-1" loading={saving} onClick={create}>
              <Check className="size-4" aria-hidden />
              {mode === 'once' ? 'Create game' : 'Create schedule'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <Segmented
            className="w-full"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'weekly', label: 'Repeats weekly' },
              { value: 'once', label: 'Just once' },
            ]}
          />

          {/* Where, first. The venue list depends on the district, so asking in the other
              order means picking a pitch before the app knows which ones exist. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="District" htmlFor="district">
              <Select
                id="district"
                value={form.districtId}
                onChange={(e) => setForm({ ...form, districtId: e.target.value, venueId: '' })}
              >
                <option value="">Choose a district</option>
                {(districtData?.districts ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            </Field>

            <Field
              label="Venue"
              htmlFor="venue"
              hint={
                !form.districtId
                  ? 'Pick a district first.'
                  : venues.length === 0
                    ? 'No pitches recorded here yet — add one under Venues.'
                    : undefined
              }
            >
              <Select
                id="venue"
                value={form.venueId}
                disabled={!form.districtId || venues.length === 0}
                onChange={(e) => {
                  const venueId = e.target.value;
                  const venue = venues.find((v) => v.id === venueId);
                  // A pitch knows how many it holds. Adopting it saves the most common
                  // edit, and it is still a default -- the size field stays editable.
                  setForm((f) => ({
                    ...f,
                    venueId,
                    capacity: venue?.capacity ?? f.capacity,
                  }));
                }}
              >
                <option value="">Decide later</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}{v.address ? ` — ${v.address}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* When. */}
          <div className="grid gap-4 sm:grid-cols-2">
            {mode === 'once' ? (
              <Field label="Date" htmlFor="date">
                <Input
                  id="date" type="date" value={form.date}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                />
              </Field>
            ) : (
              <Field label="Day" htmlFor="weekday">
                <Select
                  id="weekday"
                  value={form.weekday}
                  onChange={(e) => setForm({
                    ...form,
                    weekday: Number(e.target.value),
                    // Keep the date in step, so switching to "just once" offers the day
                    // already chosen rather than resetting to Sunday.
                    date: nextDateFor(e.target.value),
                  })}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>Every {d.label}</option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="Kickoff" hint={mode === 'once' ? undefined : 'Local time, every week.'} htmlFor="time">
              <Input
                id="time" type="time" value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
              />
            </Field>
          </div>

          {/* The game itself. */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Size" htmlFor="capacity">
              <Select
                id="capacity"
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              >
                {[10, 12, 14, 16, 18, 20, 22].map((n) => (
                  <option key={n} value={n}>{n} players ({n / 2}-a-side)</option>
                ))}
              </Select>
            </Field>

            <Field label="Length" hint="Minutes." htmlFor="duration">
              <Input
                id="duration" type="number" min="20" max="240" step="5"
                value={form.durationMinutes}
                onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
              />
            </Field>

            <Field label="Price per player" htmlFor="price">
              <Input
                id="price" type="number" min="0" value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Waiting list"
              hint="How many can queue once it is full."
              htmlFor="waitlist"
            >
              <Input
                id="waitlist" type="number" min="0" max="50"
                value={form.waitlistCapacity}
                onChange={(e) => setForm({ ...form, waitlistCapacity: e.target.value })}
              />
            </Field>

            {/* Meaningless for a single fixture: there is nothing ahead to create. */}
            {mode === 'weekly' && (
              <Field
                label="Create ahead"
                hint="Days of fixtures to keep created."
                htmlFor="horizon"
              >
                <Input
                  id="horizon" type="number" min="7" max="120" step="7"
                  value={form.horizonDays}
                  onChange={(e) => setForm({ ...form, horizonDays: e.target.value })}
                />
              </Field>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] bg-[var(--surface-2)] p-3">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={form.openImmediately}
              onChange={(e) => setForm({ ...form, openImmediately: e.target.checked })}
            />
            <span className="text-sm">
              <span className="font-medium">Open for registration straight away</span>
              <span className="mt-0.5 block text-[var(--fg-tertiary)]">
                {mode === 'once'
                  ? 'Off creates it as a draft, and you open it by hand.'
                  : 'Off means each fixture is created as a draft, and you open it by hand.'}
              </span>
            </span>
          </label>

          {/* What the rule actually produces, before committing to it. */}
          {form.districtId && (
            <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] p-3 text-sm">
              <p className="eyebrow mb-1 text-[0.5625rem]">What gets created</p>
              <p>
                {mode === 'once' ? (
                  <strong>
                    {form.date
                      ? new Date(`${form.date}T${form.time}`).toLocaleDateString('en-GB', {
                          weekday: 'long', day: 'numeric', month: 'long',
                        })
                      : 'Pick a date'}
                  </strong>
                ) : (
                  <>Every <strong>{WEEKDAYS[form.weekday]?.label}</strong></>
                )}
                {' at '}<strong>{form.time}</strong>
                {form.venueId
                  ? <> at <strong>{venues.find((v) => v.id === form.venueId)?.name}</strong></>
                  : null}
                {' · '}{form.capacity} players{' · '}
                {Number(form.price) > 0 ? `$${form.price} each` : 'free'}
              </p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
