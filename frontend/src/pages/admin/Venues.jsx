// Venues: the pitches this league books, and their badges.
//
// Small screen, on purpose. A venue is set up once and then edited about twice a year, so
// this is a list with an upload on it rather than a management console.

import { useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MapPin, Upload, Trash2, Plus, Check } from 'lucide-react';
import { districtService } from '../../api/services.js';
import { useDistricts } from '../../hooks/index.js';
import {
  Button, Card, Field, Input, Select, Modal, Badge, Skeleton, EmptyState,
} from '../../components/ui/index.jsx';
import { fileToLogoDataUrl } from '../../lib/imageUpload.js';
import { VenueBadge } from '../../components/football/VenueBadge.jsx';

const PITCH_TYPES = [
  { value: 'turf', label: 'Turf' },
  { value: 'grass', label: 'Grass' },
  { value: 'indoor', label: 'Indoor' },
  { value: 'sand', label: 'Sand' },
];

function VenueRow({ districtId, venue, onChanged }) {
  const [busy, setBusy] = useState(false);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const { dataUrl, bytes } = await fileToLogoDataUrl(file);
      await districtService.updateVenue(districtId, venue.id, { logoUrl: dataUrl });
      toast.success(`${venue.name} badge added`, {
        description: `${Math.round(bytes / 1024)} KB, stored with the venue.`,
      });
      onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await districtService.updateVenue(districtId, venue.id, { logoUrl: null });
      toast.success('Badge removed');
      onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-wrap items-center gap-4 p-4">
      <VenueBadge venue={venue} size={56} />

      <div className="min-w-0 flex-1">
        <p className="font-medium">{venue.name}</p>
        <p className="truncate text-sm text-[var(--fg-secondary)]">
          {venue.address ?? 'No address'}
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-xs text-[var(--fg-muted)]">
          {venue.pitch_type && <Badge tone="neutral" size="sm">{venue.pitch_type}</Badge>}
          {venue.default_capacity ? `${venue.default_capacity} players` : null}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* A label wrapping a hidden input, not a button that clicks one: the native
            control is what opens the file picker, and faking it breaks keyboard access. */}
        <label
          className={[
            'inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)]',
            'border border-[var(--border)] px-3 text-sm hover:bg-[var(--surface-2)]',
            busy && 'pointer-events-none opacity-50',
          ].filter(Boolean).join(' ')}
        >
          <Upload className="size-4" aria-hidden />
          {venue.logo_url ? 'Replace' : 'Add badge'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="sr-only"
            onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }}
          />
        </label>

        {venue.logo_url && (
          <Button variant="ghost" size="sm" onClick={clear} loading={busy} aria-label={`Remove ${venue.name} badge`}>
            <Trash2 className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </Card>
  );
}

export default function AdminVenues() {
  const queryClient = useQueryClient();
  const { data: districtData } = useDistricts();
  const districts = districtData?.districts ?? [];

  // Every active district at once, grouped, rather than a picker.
  //
  // A picker has to default to something, and defaulting to the first district
  // alphabetically opened this page on an empty list while three venues sat one dropdown
  // away -- which reads as "there are no venues" rather than "you are looking at Baabda".
  // At this many pitches the whole set fits on one screen.
  const results = useQueries({
    queries: districts.map((d) => ({
      queryKey: ['venues', d.id],
      queryFn: () => districtService.venues(d.id),
      enabled: !!d.id,
    })),
  });
  const isLoading = results.some((r) => r.isLoading);
  const groups = districts
    .map((d, i) => ({ district: d, venues: results[i]?.data?.venues ?? [] }))
    .filter((g) => g.venues.length > 0);
  const total = groups.reduce((n, g) => n + g.venues.length, 0);

  // Only for the "add" dialog, which does need one district.
  const [districtId, setDistrictId] = useState('');
  const active = districtId || districts[0]?.id;

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', address: '', pitchType: 'turf', defaultCapacity: 22 });

  const create = async () => {
    if (!form.name.trim()) { toast.error('The venue needs a name'); return; }
    setSaving(true);
    try {
      await districtService.createVenue(active, {
        name: form.name.trim(),
        address: form.address.trim() || undefined,
        pitchType: form.pitchType,
        defaultCapacity: Number(form.defaultCapacity),
      });
      toast.success('Venue added');
      setOpen(false);
      setForm({ name: '', address: '', pitchType: 'turf', defaultCapacity: 22 });
      await queryClient.invalidateQueries({ queryKey: ['venues'] });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const changed = () => queryClient.invalidateQueries({ queryKey: ['venues'] });

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Where you play</p>
          <h1 className="display text-3xl">Venues</h1>
          <p className="mt-1 max-w-md text-sm text-[var(--fg-secondary)]">
            A badge here appears on the game and on the team sheet you send to WhatsApp.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!active}>
          <Plus className="size-4" aria-hidden /> Add venue
        </Button>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-24 rounded-[var(--radius-lg)]" />)}
        </div>
      ) : total === 0 ? (
        <Card>
          <EmptyState
            icon={MapPin}
            title="No venues yet"
            description="Add the pitch you book and it becomes selectable when you create a game."
            action={<Button onClick={() => setOpen(true)}>Add a venue</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map(({ district, venues }) => (
            <section key={district.id}>
              <h2 className="eyebrow mb-2 text-[0.625rem]">{district.name}</h2>
              <ul className="space-y-3">
                {venues.map((v) => (
                  <li key={v.id}>
                    <VenueRow districtId={district.id} venue={v} onChanged={changed} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add a venue"
        description="A badge can be added once it exists."
        size="sm"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="flex-1" loading={saving} onClick={create}>
              <Check className="size-4" aria-hidden /> Add
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="District" htmlFor="v-district">
            <Select
              id="v-district"
              value={active ?? ''}
              onChange={(e) => setDistrictId(e.target.value)}
            >
              {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="Name" htmlFor="v-name">
            <Input
              id="v-name" value={form.name} autoFocus
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Sports Zone"
            />
          </Field>
          <Field label="Address" htmlFor="v-address">
            <Input
              id="v-address" value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              placeholder="Dbayeh, Metn"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Surface" htmlFor="v-type">
              <Select
                id="v-type" value={form.pitchType}
                onChange={(e) => setForm((f) => ({ ...f, pitchType: e.target.value }))}
              >
                {PITCH_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </Field>
            <Field label="Usual size" hint="Players." htmlFor="v-cap">
              <Input
                id="v-cap" type="number" min="2" max="40" value={form.defaultCapacity}
                onChange={(e) => setForm((f) => ({ ...f, defaultCapacity: e.target.value }))}
              />
            </Field>
          </div>
        </div>
      </Modal>
    </div>
  );
}
