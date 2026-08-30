// The QR landing page.
//
// Someone tapped a link in a WhatsApp group, or pointed a camera at a phone screen
// somebody was holding up at the side of a pitch. They have no account, they have not
// heard of Sports Fusion, and they are standing outside. Everything here is bent towards
// getting them into the database in under a minute.
//
// Three steps, and the order matters: show them what they are joining BEFORE asking for
// anything, verify the number, then collect the smallest useful profile. Asking for a
// name and a position before explaining what this is loses people at the first field.

import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, MapPin, ShieldCheck, Check } from 'lucide-react';
import { inviteService } from '../api/services.js';
import { useSession } from '../state/session.jsx';
import { PhoneSignIn, toE164 } from '../components/auth/PhoneSignIn.jsx';
import {
  Button, Card, Field, Input, Skeleton, ErrorState,
} from '../components/ui/index.jsx';
import { Logo } from '../components/shared/Logo.jsx';
import { PositionPicker } from '../components/players/PositionPicker.jsx';

function Shell({ children }) {
  return (
    <div className="floodlit grid min-h-svh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex justify-center">
          <Logo className="h-8" />
        </Link>
        <Card className="p-6">{children}</Card>
      </div>
    </div>
  );
}

export default function Join() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { adoptSession } = useSession();

  const [step, setStep] = useState('intro');
  const [verified, setVerified] = useState(null);   // { phone, code }
  const [profile, setProfile] = useState({
    displayName: '', preferredPosition: '', secondaryPositions: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const { data: invite, isLoading, isError, error: loadError } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => inviteService.get(token),
    retry: false,
  });

  if (isLoading) {
    return (
      <Shell>
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-6 h-11 w-full" />
      </Shell>
    );
  }

  // A dead link is the common case here, not an edge case: codes get screenshotted and
  // forwarded for months. Say plainly what happened and offer the way back in.
  if (isError) {
    return (
      <Shell>
        <ErrorState
          title="This link is not working"
          description={loadError?.message ?? 'Ask whoever sent it for a new one.'}
        />
        <Button to="/login" variant="secondary" className="mt-4 w-full">
          I already have an account
        </Button>
      </Shell>
    );
  }

  const where = invite.district?.name ?? 'Sports Fusion';

  /** The code is sent through the invite endpoint, which checks the link is still alive. */
  const verify = async ({ phone, code }) => {
    setVerified({ phone, code });
    setStep('profile');
  };

  const claim = async (e) => {
    e.preventDefault();
    if (!profile.displayName.trim()) {
      setError('We need a name for the team sheet');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await inviteService.claim(token, {
        phone: verified.phone,
        code: verified.code,
        displayName: profile.displayName.trim(),
        preferredPosition: profile.preferredPosition || undefined,
        secondaryPositions: profile.secondaryPositions,
        // Willing to go in goal, not merely able. Someone who lists GK anywhere in their
        // three is telling us they will take a turn, and the balancer needs one per side.
        isGoalkeeper:
          profile.preferredPosition === 'GK' || profile.secondaryPositions.includes('GK'),
      });
      await adoptSession(result.user);
      navigate(result.joinedGame ? '/my-game' : '/games', { replace: true });
    } catch (err) {
      setError(err.message ?? 'Could not finish signing you up');
      // The code is spent whatever happened, so there is no way back but a new one.
      if (/code/i.test(err.message ?? '')) setStep('verify');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'intro') {
    return (
      <Shell>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
          You have been invited
        </p>
        <h1 className="display mt-1.5 text-3xl">Play in {where}</h1>

        {invite.game ? (
          <div className="mt-5 space-y-2 rounded-[var(--radius-md)] bg-[var(--surface-2)] p-4">
            <p className="font-semibold">{invite.game.title ?? 'Next game'}</p>
            <p className="flex items-center gap-2 text-sm text-[var(--fg-secondary)]">
              <CalendarDays className="size-4 shrink-0" aria-hidden />
              {new Date(invite.game.kickoffAt).toLocaleString('en-GB', {
                weekday: 'long', day: 'numeric', month: 'short',
                hour: 'numeric', minute: '2-digit', hour12: true,
              })}
            </p>
            {invite.game.venueName && (
              <p className="flex items-center gap-2 text-sm text-[var(--fg-secondary)]">
                <MapPin className="size-4 shrink-0" aria-hidden />
                {invite.game.venueName}
              </p>
            )}
            <p className="pt-1 text-sm text-[var(--fg-tertiary)]">
              Signing up puts you straight on the team sheet.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-[var(--fg-secondary)]">
            Add yourself once and you can join any game in {where}. Teams get balanced on
            how you actually play, so the games stay close.
          </p>
        )}

        <Button size="lg" className="mt-6 w-full" onClick={() => setStep('verify')}>
          Add me
        </Button>
        <p className="mt-3 text-center text-xs text-[var(--fg-muted)]">
          Takes about a minute. No password.
        </p>
      </Shell>
    );
  }

  if (step === 'verify') {
    return (
      <Shell>
        <h1 className="display text-2xl">What is your number?</h1>
        <p className="mt-1.5 text-sm text-[var(--fg-secondary)]">
          It is how the group reaches you about games. We confirm it with a code.
        </p>
        <div className="mt-6">
          <PhoneSignIn
            onVerify={verify}
            submitLabel="Confirm"
            // The invite-scoped endpoint, so a revoked link cannot be used to send
            // messages, and the number is verified before any account exists.
            sendCode={(phone) => inviteService.sendCode(token, toE164(phone))}
          />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--accent)]">
        <ShieldCheck className="size-4" aria-hidden />
        Number confirmed
      </p>
      <h1 className="display mt-1.5 text-2xl">Last bit</h1>

      <form onSubmit={claim} className="mt-6 space-y-4">
        <Field
          label="Name"
          hint="What the team sheet should say."
          htmlFor="displayName"
          error={error}
        >
          <Input
            id="displayName"
            value={profile.displayName}
            onChange={(e) => { setProfile((p) => ({ ...p, displayName: e.target.value })); setError(null); }}
            placeholder="Karim Haddad"
            autoComplete="name"
            autoFocus
            invalid={!!error}
          />
        </Field>

        <Field
          label="Where do you play?"
          hint="Optional, and you can change it later. It only shapes the first few teams — after that your results speak."
        >
          <PositionPicker
            primary={profile.preferredPosition || null}
            secondary={profile.secondaryPositions}
            onChange={({ primary, secondary }) =>
              setProfile((p) => ({
                ...p,
                preferredPosition: primary ?? '',
                secondaryPositions: secondary,
              }))}
          />
        </Field>

        <Button type="submit" size="lg" className="w-full" loading={busy}>
          <Check className="size-4" aria-hidden />
          Done
        </Button>
      </form>
    </Shell>
  );
}
