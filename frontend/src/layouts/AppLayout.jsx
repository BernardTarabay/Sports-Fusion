// The PLAYER app's shell.
//
// Nothing about running a league appears here. Administration is a separate application
// at /admin with its own shell, so this one no longer has to carry a mode toggle or
// explain which half of the product you are looking at. The only trace of it is one line
// in the account menu, for the admins who also turn out on Saturday.
//
// Two navigations, one for each way this product is used:
//
//   PHONE  — a bottom bar. Thumb-reachable, five destinations maximum, always visible.
//            This is the primary experience: players open the app standing outside a
//            pitch, one-handed, in the dark.
//   DESKTOP— a top bar. More room, so it carries search and identity as well.
//
// The bottom bar is not a shrunken top bar; the two have different contents because the
// jobs are different.

import { useEffect, useRef, useState } from 'react';
import { NavLink, Link, useLocation, Outlet } from 'react-router';
import {
  Home, CalendarDays, Trophy, Gift, User, MapPin, Sun, Moon, Monitor, LogOut,
  Shield, Goal, X,
} from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useSession } from '../state/session.jsx';
import { useScrollLock } from '../hooks/index.js';
import { useTheme } from '../state/theme.jsx';
import { Avatar, Button } from '../components/ui/index.jsx';
import { Logo } from '../components/shared/Logo.jsx';
import { SocialRow, SocialList } from '../components/shared/Social.jsx';

// What a player is for: find a game, play in it, see where they stand.
//
// Everything to do with RUNNING the league lives under /admin and is refused by the
// server to anyone without the role -- see backend/src/authorization.test.js, which
// proves a plain player is turned away from all 38 administrative routes. This list is
// only about what is worth offering; it is not a security boundary and must never be
// treated as one.
//
// Districts and Rewards are built and routed, just not in the navigation. Add a line here
// to bring either back.
const PRIMARY_NAV = [
  { to: '/my-game', label: 'My game', icon: Goal, authOnly: true },
  { to: '/games', label: 'Games', icon: CalendarDays },
  { to: '/leaderboards', label: 'Rankings', icon: Trophy },
];

function ThemeToggle({ className }) {
  const { theme, cycle } = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <button
      onClick={cycle}
      className={cn(
        'grid place-items-center size-10 rounded-[var(--radius-md)] text-[var(--fg-secondary)]',
        'hover:bg-[var(--bg-sunken)] hover:text-[var(--fg-primary)] transition-colors',
        className
      )}
      aria-label={`Theme: ${theme}. Click to change.`}
    >
      <Icon className="size-4.5" />
    </button>
  );
}

function DesktopNav() {
  const { isAuthenticated, isAdmin, user, logout } = useSession();

  return (
    <header className="sticky top-0 z-40 hidden border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/85 backdrop-blur-lg lg:block">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-6">
        <Link to="/" className="flex min-h-11 shrink-0 items-center" aria-label="Sports Fusion home">
          <Logo className="h-7" />
        </Link>

        <nav className="flex items-center gap-1" aria-label="Main">
          {PRIMARY_NAV.filter((item) => !item.authOnly || isAuthenticated).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'px-3.5 h-9 grid place-items-center rounded-[var(--radius-md)] text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--bg-sunken)] text-[var(--fg-primary)]'
                    : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex-1" />

        <SocialRow className="mr-1" size="sm" />

        <ThemeToggle />

        {isAuthenticated ? (
          <div className="flex items-center gap-2">
            {/* An admin who also plays. Quiet, because switching applications is not
                something a player does, and this shell belongs to the player. */}
            {isAdmin && (
              <Link
                to="/admin"
                className="flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-sm text-[var(--fg-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg-primary)]"
              >
                <Shield className="size-4" /> Operations
              </Link>
            )}
            <Link to="/profile" className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 hover:bg-[var(--bg-sunken)]">
              <Avatar name={user?.displayName} size="sm" />
              <span className="max-w-32 truncate text-sm font-medium">{user?.displayName}</span>
            </Link>
            <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button to="/login" variant="ghost" size="sm">Sign in</Button>
            <Button to="/signup" size="sm">Join</Button>
          </div>
        )}
      </div>
    </header>
  );
}

function MobileHeader() {
  const [open, setOpen] = useState(false);
  const { isAuthenticated, isAdmin, user, logout } = useSession();
  const location = useLocation();
  const sheetRef = useRef(null);
  const openerRef = useRef(null);

  // Close on navigation. Tapping a link inside the sheet already calls setOpen(false),
  // but the browser back button does not, and the sheet would still be there over the
  // page it navigated to.
  useEffect(() => { setOpen(false); }, [location.pathname]);

  useScrollLock(open);

  // Move focus into the sheet when it opens, and put it back on the button that opened
  // it when it closes -- otherwise a keyboard user's focus is left on an element that
  // is now behind a modal.
  useEffect(() => {
    if (!open) return undefined;
    const first = sheetRef.current?.querySelector('a, button');
    first?.focus();
    return () => openerRef.current?.focus();
  }, [open]);

  /** Escape closes; Tab cycles inside. */
  const onSheetKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = sheetRef.current?.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/90 backdrop-blur-lg lg:hidden">
        <div className="flex h-14 items-center gap-3 px-4">
          <Link to="/" className="flex min-h-11 items-center" aria-label="Sports Fusion home">
            <Logo className="h-6" compact />
          </Link>
          <div className="flex-1" />
          <ThemeToggle className="size-9 pointer-coarse:size-11" />
          {isAuthenticated ? (
            <button
              ref={openerRef}
              onClick={() => setOpen(true)}
              className="grid min-h-11 min-w-11 place-items-center rounded-full"
              aria-label="Open menu"
              aria-haspopup="dialog"
              aria-expanded={open}
            >
              <Avatar name={user?.displayName} size="sm" />
            </button>
          ) : (
            <Button to="/login" size="sm" variant="secondary">Sign in</Button>
          )}
        </div>
      </header>

      {/* Account sheet. Everything that does not deserve a slot in the bottom bar.

          It was a bare div with aria-modal on it: Escape did nothing, focus stayed
          behind it on the avatar button, and the page underneath scrolled while the
          sheet sat still. aria-modal="true" is a promise to a screen reader that the
          rest of the page is inert, and it was not true. */}
      {open && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Account menu"
          ref={sheetRef}
          onKeyDown={onSheetKeyDown}
        >
          <button
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-[var(--radius-2xl)] bg-[var(--bg-surface)] p-5 pb-safe">
            <div className="mb-4 flex justify-center">
              <div className="h-1 w-10 rounded-full bg-[var(--border-strong)]" />
            </div>

            <div className="mb-5 flex items-center gap-3">
              <Avatar name={user?.displayName} size="lg" />
              <div className="min-w-0">
                <p className="display text-xl truncate">{user?.displayName}</p>
                <p className="truncate text-xs text-[var(--fg-secondary)]">{user?.email}</p>
              </div>
            </div>

            <nav className="space-y-1">
              <SheetLink to="/profile" icon={User} label="My profile" onNavigate={() => setOpen(false)} />
              <SheetLink to="/rewards" icon={Gift} label="Rewards" onNavigate={() => setOpen(false)} />
              <SheetLink to="/districts" icon={MapPin} label="Districts" onNavigate={() => setOpen(false)} />
              {isAdmin && (
                <SheetLink to="/admin" icon={Shield} label="Operations" onNavigate={() => setOpen(false)} />
              )}
            </nav>

            {/* The footer is desktop-only, so without this a phone never sees the store
                or the community group at all -- and the phone is the primary device. */}
            <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
              <p className="eyebrow mb-1 px-3 text-[0.625rem]">Sports Fusion elsewhere</p>
              <SocialList onNavigate={() => setOpen(false)} />
            </div>

            <Button
              variant="secondary"
              className="mt-4 w-full"
              onClick={() => { setOpen(false); logout(); }}
            >
              <LogOut className="size-4" /> Sign out
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function SheetLink({ to, icon: Icon, label, onNavigate }) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className="flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-3 text-sm font-medium hover:bg-[var(--bg-sunken)]"
    >
      <Icon className="size-4.5 text-[var(--fg-secondary)]" aria-hidden="true" />
      {label}
    </Link>
  );
}

function BottomNav() {
  const { isAuthenticated } = useSession();

  // Your game sits second: after home, the next thing a player wants is the fixture they
  // are in. It is dropped when signed out, because there is no "your game" without a you.
  const items = [
    { to: '/', label: 'Home', icon: Home, end: true },
    ...(isAuthenticated ? [{ to: '/my-game', label: 'My game', icon: Goal }] : []),
    { to: '/games', label: 'Games', icon: CalendarDays },
    { to: '/leaderboards', label: 'Rankings', icon: Trophy },
    isAuthenticated
      ? { to: '/profile', label: 'Me', icon: User }
      : { to: '/login', label: 'Sign in', icon: User },
  ];

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]/95 backdrop-blur-lg pb-safe lg:hidden"
      aria-label="Main"
    >
      {/* Tailwind's JIT only emits classes it can find literally in the source, so a
          template literal here produces a class that was never generated. Both arms are
          written out. */}
      <div className={items.length === 5 ? 'grid grid-cols-5' : 'grid grid-cols-4'}>
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                // 56px tall: comfortably above the 44px minimum, with room for a label.
                'relative flex h-14 flex-col items-center justify-center gap-0.5 text-[0.625rem] font-medium transition-colors',
                isActive ? 'text-[var(--accent)]' : 'text-[var(--fg-muted)]'
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute top-0 h-0.5 w-8 rounded-full bg-[var(--accent)]" />
                )}
                <item.icon className="size-5" aria-hidden="true" />
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function AppLayout() {
  return (
    <div className="min-h-svh bg-[var(--bg-canvas)]">
      {/* Keyboard users should not have to tab through the whole nav on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-md)] focus:bg-[var(--accent)] focus:px-4 focus:py-2 focus:text-[var(--accent-fg)]"
      >
        Skip to content
      </a>

      <DesktopNav />
      <MobileHeader />

      <main id="main" className="pb-20 lg:pb-0">
        <Outlet />
      </main>

      <BottomNav />
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-16 hidden border-t border-[var(--border-subtle)] py-10 lg:block">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 text-sm text-[var(--fg-secondary)]">
        <Logo className="h-5 opacity-60" />
        <span>Community football, organised.</span>
        <div className="flex-1" />
        <Link to="/districts" className="hover:text-[var(--fg-primary)]">Districts</Link>
        <Link to="/games" className="hover:text-[var(--fg-primary)]">Games</Link>
        <Link to="/leaderboards" className="hover:text-[var(--fg-primary)]">Rankings</Link>
        <SocialRow className="-my-1" size="sm" />
      </div>
    </footer>
  );
}

export default AppLayout;
