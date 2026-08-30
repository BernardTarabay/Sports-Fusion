// Sign in and join.
//
// Deliberately short. Someone standing outside a pitch wants to be in the game, not
// filling in a profile — position and district can be set later, and everything asked
// for here is something the product genuinely needs on day one.

import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { useSession } from '../state/session.jsx';
import { useDistricts } from '../hooks/index.js';
import { Button, Card, Field, Input, Select, Segmented } from '../components/ui/index.jsx';
import { PhoneSignIn } from '../components/auth/PhoneSignIn.jsx';
import { phoneAuthService } from '../api/services.js';
import { Logo } from '../components/shared/Logo.jsx';

const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or phone number'),
  password: z.string().min(1, 'Enter your password'),
});

const signupSchema = z.object({
  displayName: z.string().trim().min(2, 'What should we call you?').max(80),
  email: z.string().email('That email does not look right'),
  password: z.string().min(8, 'Use at least 8 characters'),
  districtId: z.string().optional(),
});

function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="floodlit grid min-h-svh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex justify-center">
          <Logo className="h-8" />
        </Link>

        <Card className="p-6">
          <h1 className="display text-3xl">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-[var(--fg-secondary)]">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </Card>

        {footer && <p className="mt-5 text-center text-sm text-[var(--fg-secondary)]">{footer}</p>}
      </div>
    </div>
  );
}

export function Login() {
  const { login, adoptSession } = useSession();
  // Phone first: it is how this community actually identifies itself, and it is the only
  // method a player onboarded through a QR code has. The password tab is for admins and
  // for anyone who signed up with an email before phone sign-in existed.
  const [method, setMethod] = useState('phone');
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);

  const { register, handleSubmit, formState: { errors }, setError } = useForm();

  const onSubmit = async (values) => {
    const parsed = loginSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        setError(issue.path[0], { message: issue.message });
      }
      return;
    }

    setSubmitting(true);
    try {
      const me = await login(parsed.data);
      // An admin goes straight to the pitch. Anywhere they were headed wins, but the
      // default is the game that matters right now -- never a dashboard.
      const isAdmin = (me?.roles ?? []).some((r) =>
        ['admin', 'owner', 'district_admin'].includes(r.role)
      );
      navigate(location.state?.from ?? (isAdmin ? '/admin' : '/my-game'), { replace: true });
    } catch (error) {
      // The message is already human -- the API client maps codes to copy.
      setError('password', { message: error.message });
    } finally {
      setSubmitting(false);
    }
  };

  // Where a session lands. Roles come from the server; this only decides a route.
  const landAfter = (me) => {
    const isAdmin = (me?.roles ?? []).some((r) =>
      ['admin', 'owner', 'district_admin'].includes(r.role)
    );
    navigate(location.state?.from ?? (isAdmin ? '/admin' : '/my-game'), { replace: true });
  };

  // A number with no account comes back as NAME_REQUIRED, which PhoneSignIn handles by
  // showing a name field and calling again with the same still-valid code. Signing in and
  // signing up are the same two taps -- which is the point, because half this community
  // will not know which one they are doing.
  const verifyPhone = async ({ phone, code, displayName }) => {
    const { user: me } = await phoneAuthService.verify({ phone, code, displayName });
    await adoptSession(me);
    landAfter(me);
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to join games and see your stats."
      footer={<>New here? <Link to="/signup" className="inline-flex min-h-11 items-center px-1 font-medium text-[var(--accent)] hover:underline">Create a profile</Link></>}
    >
      <Segmented
        className="mb-5 w-full"
        value={method}
        onChange={setMethod}
        options={[
          { value: 'phone', label: 'Phone' },
          { value: 'password', label: 'Password' },
        ]}
      />

      {method === 'phone' ? (
        <PhoneSignIn onVerify={verifyPhone} submitLabel="Sign in" />
      ) : (
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field label="Email or phone" htmlFor="identifier" error={errors.identifier?.message}>
          <Input
            id="identifier"
            autoComplete="username"
            inputMode="email"
            placeholder="you@example.com"
            invalid={!!errors.identifier}
            {...register('identifier')}
          />
        </Field>

        <Field label="Password" htmlFor="password" error={errors.password?.message}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            invalid={!!errors.password}
            {...register('password')}
          />
        </Field>

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          Sign in
        </Button>

      </form>
      )}
    </AuthShell>
  );
}

export function Signup() {
  const { signup } = useSession();
  const navigate = useNavigate();
  const { data: districtData } = useDistricts();
  const [submitting, setSubmitting] = useState(false);

  const { register, handleSubmit, formState: { errors }, setError } = useForm();

  const onSubmit = async (values) => {
    const parsed = signupSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        setError(issue.path[0], { message: issue.message });
      }
      return;
    }

    setSubmitting(true);
    try {
      await signup(parsed.data);
      toast.success('Welcome to Sports Fusion', { description: 'Find a game and get on the pitch.' });
      navigate('/games', { replace: true });
    } catch (error) {
      setError('email', { message: error.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Join Sports Fusion"
      subtitle="One profile. Every district. No group chat required."
      footer={<>Already playing? <Link to="/login" className="inline-flex min-h-11 items-center px-1 font-medium text-[var(--accent)] hover:underline">Sign in</Link></>}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field label="Your name" htmlFor="displayName" error={errors.displayName?.message}
          hint="This is what appears on the team sheet.">
          <Input
            id="displayName"
            autoComplete="name"
            invalid={!!errors.displayName}
            {...register('displayName')}
          />
        </Field>

        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            invalid={!!errors.email}
            {...register('email')}
          />
        </Field>

        <Field label="Password" htmlFor="password" error={errors.password?.message} hint="At least 8 characters.">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            invalid={!!errors.password}
            {...register('password')}
          />
        </Field>

        <Field label="Home district" htmlFor="districtId" hint="You can follow others later.">
          <Select id="districtId" {...register('districtId')}>
            <option value="">Choose later</option>
            {(districtData?.districts ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>
        </Field>

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          Create profile
        </Button>
      </form>
    </AuthShell>
  );
}
