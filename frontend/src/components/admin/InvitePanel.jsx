// Invite links, and the QR code that goes in the WhatsApp group.
//
// The admin's job here is: make a link, get it in front of people, watch the roster fill.
// So the QR is large by default rather than hidden behind a "view" button — it exists to
// be held up on a phone screen or shown on a laptop at a venue, and a thumbnail is
// useless for both.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, QrCode, Link2, Ban, Check, Users } from 'lucide-react';
import { inviteService } from '../../api/services.js';
import { useDistricts } from '../../hooks/index.js';
import {
  Button, Card, Field, Input, Select, Modal, Badge, EmptyState, Skeleton,
} from '../ui/index.jsx';

const keys = { invites: () => ['invites'] };

/**
 * The generated code, sized to be scanned off a screen.
 *
 * The SVG comes from the server with `currentColor` unset and a transparent background,
 * so the white quiet zone is drawn here rather than baked in -- a QR on a dark page needs
 * a light surround to scan at all, and the code itself must stay dark. This is the one
 * place in the app that ignores the theme on purpose.
 */
function QrPanel({ svg, url }) {
  return (
    <div className="space-y-3">
      <div
        className="mx-auto w-full max-w-[16rem] rounded-[var(--radius-md)] bg-white p-4 [&_svg]:h-auto [&_svg]:w-full"
        // eslint-disable-next-line react/no-danger -- server-generated SVG from our own API,
        // built by the qrcode library from a URL we created. No user input reaches it.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="break-all text-center font-mono text-xs text-[var(--fg-tertiary)]">{url}</p>
    </div>
  );
}

function CopyButton({ value, label = 'Copy link', className }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          toast.error('Could not copy — select the link and copy it manually');
        }
      }}
    >
      {done ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Ready to paste. WhatsApp uses *bold*, and long lines wrap badly on phones. */
function whatsappText(invite, districtName) {
  return [
    `*Sports Fusion — ${districtName ?? 'football'}*`,
    '',
    'Add yourself once and you can join any game.',
    'Takes a minute, no password:',
    '',
    invite.url,
  ].join('\n');
}

export function InvitePanel({ districtId, gameId }) {
  const queryClient = useQueryClient();
  const { data: districtData } = useDistricts();
  const districts = districtData?.districts ?? [];

  const [form, setForm] = useState({ districtId: districtId ?? '', label: '', maxUses: '' });
  const [fresh, setFresh] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: keys.invites(),
    queryFn: () => inviteService.list(),
  });
  const invites = data?.invites ?? [];

  const create = useMutation({
    mutationFn: () => inviteService.create({
      districtId: form.districtId || undefined,
      gameId: gameId || undefined,
      label: form.label.trim() || undefined,
      maxUses: form.maxUses ? Number(form.maxUses) : undefined,
    }),
    onSuccess: ({ invite }) => {
      // Shown once, and only here: the server stores a hash, so this is the only moment
      // the actual link exists anywhere outside the admin's clipboard.
      setFresh(invite);
      setForm((f) => ({ ...f, label: '', maxUses: '' }));
      queryClient.invalidateQueries({ queryKey: keys.invites() });
    },
    onError: (err) => toast.error(err.message ?? 'Could not create that link'),
  });

  const revoke = useMutation({
    mutationFn: (id) => inviteService.revoke(id),
    onSuccess: () => {
      toast.success('Link turned off');
      queryClient.invalidateQueries({ queryKey: keys.invites() });
    },
    onError: (err) => toast.error(err.message ?? 'Could not turn that link off'),
  });

  const districtName = districts.find((d) => d.id === form.districtId)?.name;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex items-center gap-2">
          <QrCode className="size-4 text-[var(--accent)]" aria-hidden />
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--fg-secondary)]">
            Invite players
          </h2>
        </div>
        <p className="mt-2 text-sm text-[var(--fg-secondary)]">
          Make a link, drop it in the WhatsApp group. Everyone who scans it adds their own
          name and position — you never type a roster again.
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <Field label="District" htmlFor="inv-district">
            <Select
              id="inv-district"
              value={form.districtId}
              onChange={(e) => setForm((f) => ({ ...f, districtId: e.target.value }))}
            >
              <option value="">All districts</option>
              {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>

          <Field label="Label" hint="For you, not them." htmlFor="inv-label">
            <Input
              id="inv-label"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Metn Tuesday group"
            />
          </Field>

          <Field label="Max uses" hint="Blank for unlimited." htmlFor="inv-max">
            <Input
              id="inv-max"
              type="number"
              min="1"
              value={form.maxUses}
              onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value }))}
              placeholder="50"
            />
          </Field>
        </div>

        <Button
          className="mt-4"
          onClick={() => create.mutate()}
          loading={create.isPending}
        >
          <Link2 className="size-4" aria-hidden />
          Create invite link
        </Button>
      </Card>

      <Modal
        open={!!fresh}
        onOpenChange={(open) => !open && setFresh(null)}
        title="Your invite link"
        description="Shown once. Copy it now — we only keep a hash, so it cannot be shown again."
      >
        {fresh && (
          <div className="space-y-4">
            <QrPanel svg={fresh.qrSvg} url={fresh.url} />
            <div className="flex flex-wrap gap-2">
              <CopyButton value={fresh.url} className="flex-1" />
              <CopyButton
                value={whatsappText(fresh, districtName)}
                label="Copy WhatsApp message"
                className="flex-1"
              />
            </div>
          </div>
        )}
      </Modal>

      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--fg-secondary)]">
          Active links
        </h3>

        {isLoading ? (
          <Skeleton className="h-24 rounded-[var(--radius-lg)]" />
        ) : invites.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No invite links yet"
            description="Create one above and paste it into your WhatsApp group."
          />
        ) : (
          <ul className="space-y-2">
            {invites.map((inv) => (
              <li key={inv.id}>
                <Card className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {inv.label ?? inv.districtName ?? 'Invite link'}
                    </p>
                    <p className="text-sm text-[var(--fg-tertiary)]">
                      {inv.districtName ?? 'All districts'}
                      {' · '}
                      {inv.uses} {inv.uses === 1 ? 'player' : 'players'} joined
                      {inv.maxUses ? ` of ${inv.maxUses}` : ''}
                    </p>
                  </div>

                  {inv.revokedAt ? (
                    <Badge tone="neutral">Off</Badge>
                  ) : (
                    <>
                      <Badge tone="success">Live</Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => revoke.mutate(inv.id)}
                        loading={revoke.isPending && revoke.variables === inv.id}
                      >
                        <Ban className="size-4" aria-hidden />
                        Turn off
                      </Button>
                    </>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
