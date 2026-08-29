// Phone sign-in: number, then the six digits that came back on WhatsApp.
//
// Used by the login page and by the QR join page, which need the same two steps with a
// different ending — one signs you in, the other hands the verified number to the invite
// claim. Hence `onVerify`: this component owns the interaction, the caller owns what
// happens after.
//
// Everything here is shaped by where it gets used: standing outside a pitch, one hand on
// the phone, in the dark, on a bad connection.

import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import { phoneAuthService } from '../../api/services.js';
import { Button, Field, Input } from '../ui/index.jsx';

/**
 * Lebanese numbers, typed the way people actually type them.
 *
 * "03 123 456", "3123456", "+961 3 123 456" and "00961 3123456" are all the same number
 * and all four get typed. The leading 0 is a domestic trunk prefix that is dropped in
 * international format — keeping it produces +9610…, which is not a real number and
 * which the API rejects with a message about E.164 that means nothing to anyone.
 */
export function toE164(input, defaultCountry = '961') {
  const raw = String(input ?? '').replace(/[^\d+]/g, '');
  if (!raw) return '';

  let digits = raw.startsWith('+') ? raw.slice(1) : raw;
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (!raw.startsWith('+') && !digits.startsWith(defaultCountry)) {
    digits = defaultCountry + digits.replace(/^0+/, '');
  } else if (digits.startsWith(defaultCountry)) {
    // +961 0 3 … — the trunk zero survived into international format.
    const rest = digits.slice(defaultCountry.length).replace(/^0+/, '');
    digits = defaultCountry + rest;
  }
  return `+${digits}`;
}

const LOOKS_VALID = /^\+[1-9]\d{7,14}$/;

/** mm:ss, so the countdown reads as time rather than as a number going down. */
function useCountdown(seconds) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    if (!seconds) return undefined;
    const id = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  return left;
}

function CodeInput({ value, onChange, onComplete, invalid }) {
  const ref = useRef(null);

  // One input, not six boxes. Six inputs break paste, fight the OS autofill that offers
  // the code from the notification, and lose focus unpredictably on Android keyboards.
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
        onChange(digits);
        if (digits.length === 6) onComplete?.(digits);
      }}
      inputMode="numeric"
      autoComplete="one-time-code"
      // iOS and Android surface the code from the WhatsApp notification for this pattern.
      pattern="\d{6}"
      maxLength={6}
      autoFocus
      aria-label="Six digit code"
      aria-invalid={invalid || undefined}
      className={[
        'w-full rounded-[var(--radius-md)] border bg-[var(--surface)] px-4 py-3',
        'text-center font-mono text-3xl tracking-[0.4em] tabular-nums',
        invalid ? 'border-[var(--danger)]' : 'border-[var(--border)]',
        'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
      ].join(' ')}
    />
  );
}

/**
 * @param {(result: {phone: string, code: string}) => Promise<void>} onVerify
 *   Called with the verified number and the code. Throwing shows the message inline.
 * @param {string} [submitLabel]
 * @param {boolean} [autoSubmit]  Submit as soon as six digits are entered.
 * @param {boolean} [askName]
 *   Show a name field alongside the code. Set by the caller when the server has said the
 *   number is new, so a first-time player finishes in the same step instead of being sent
 *   to a separate signup page with a code that has already been used.
 * @param {(phone: string) => Promise<object>} [sendCode]
 *   Overrides how the code is requested. The QR join flow routes it through the
 *   invite-scoped endpoint, so a revoked link cannot be used to send messages.
 */
export function PhoneSignIn({
  onVerify, submitLabel = 'Sign in', autoSubmit = true, sendCode, askName: askNameProp = false,
}) {
  const [step, setStep] = useState('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [askName, setAskName] = useState(askNameProp);
  const [name, setName] = useState('');
  const left = useCountdown(challenge?.expiresInSeconds ?? 0);

  const e164 = toE164(phone);
  const canSend = LOOKS_VALID.test(e164);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await (sendCode ? sendCode(e164) : phoneAuthService.start(e164));
      setChallenge(result);
      setStep('code');
      setCode('');
    } catch (err) {
      setError(err.message ?? 'Could not send a code just now');
    } finally {
      setBusy(false);
    }
  };

  const submit = useCallback(async (value) => {
    const entered = value ?? code;
    if (entered.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onVerify({ phone: e164, code: entered, displayName: name.trim() || undefined });
    } catch (err) {
      if (err.code === 'NAME_REQUIRED') {
        // First time on this number. The code is still live -- the server only spends it
        // once an account is actually created -- so they finish right here.
        setAskName(true);
        setError(null);
        return;
      }
      setError(err.message ?? 'That did not work');
      setCode('');
    } finally {
      setBusy(false);
    }
  }, [code, busy, onVerify, e164, name]);

  if (step === 'phone') {
    return (
      <form
        onSubmit={(e) => { e.preventDefault(); if (canSend) send(); }}
        className="space-y-4"
      >
        <Field
          label="Phone number"
          hint="We send a code on WhatsApp. No password to remember."
          error={error}
          htmlFor="phone"
        >
          <Input
            id="phone"
            value={phone}
            onChange={(e) => { setPhone(e.target.value); setError(null); }}
            placeholder="03 123 456"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            invalid={!!error}
          />
        </Field>

        {/* Shows what will actually be sent, so a mistyped country code is visible
            before a code goes to a stranger's phone. */}
        {phone.length > 3 && (
          <p className="text-xs text-[var(--fg-tertiary)]">
            Sending to <span className="font-mono text-[var(--fg-secondary)]">{e164}</span>
          </p>
        )}

        <Button type="submit" className="w-full" disabled={!canSend || busy}>
          {busy ? 'Sending…' : 'Send me a code'}
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => { setStep('phone'); setError(null); }}
        className="-ml-1 flex items-center gap-1 text-sm text-[var(--fg-secondary)] hover:text-[var(--fg)]"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {e164}
      </button>

      <div className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--surface-2)] px-3 py-2.5">
        <MessageCircle className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" aria-hidden />
        <p className="text-sm text-[var(--fg-secondary)]">
          {challenge?.delivered === false
            ? 'WhatsApp is switched off in this environment — the code is in the server log.'
            : 'Check WhatsApp for a six digit code.'}
        </p>
      </div>

      {/* Development only: the API returns the code when WhatsApp is disabled, so local
          work does not need a WhatsApp Business account. Never present in production. */}
      {challenge?.devCode && (
        <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] px-3 py-2 text-center text-sm">
          <span className="text-[var(--fg-tertiary)]">Dev code: </span>
          <span className="font-mono text-lg tracking-widest">{challenge.devCode}</span>
        </p>
      )}

      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-4">
        <Field error={error} htmlFor="code">
          <CodeInput
            value={code}
            onChange={(v) => { setCode(v); setError(null); }}
            // Never auto-submit while a name is still being typed, or the form fires on
            // the sixth digit and throws away what they were halfway through writing.
            onComplete={autoSubmit && !askName ? submit : undefined}
            invalid={!!error}
          />
        </Field>

        {askName && (
          <Field
            label="Your name"
            hint="First time on this number. This is what the team sheet will say."
            htmlFor="displayName"
          >
            <Input
              id="displayName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Karim Haddad"
              autoComplete="name"
              autoFocus
            />
          </Field>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={code.length !== 6 || busy || (askName && name.trim().length < 2)}
        >
          {busy ? 'Checking…' : askName ? 'Create my profile' : submitLabel}
        </Button>
      </form>

      <div className="text-center text-sm">
        {left > 0 ? (
          <span className="text-[var(--fg-tertiary)] tabular-nums">
            Code expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </span>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="text-[var(--accent)] hover:underline"
          >
            Send another code
          </button>
        )}
      </div>
    </div>
  );
}
