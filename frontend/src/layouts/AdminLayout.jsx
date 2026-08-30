// The ADMIN app's shell.
//
// A different product from the player app, not a mode of it: denser, quieter, no
// floodlights. Two people run this league every week and they are doing a job, not
// enjoying a matchday. The visual identity stays -- same type, same green -- and the
// volume drops.
//
// SELF-SUFFICIENT ON PURPOSE.
//
// There is no "player view" button in the header any more. There used to be one, facing
// an "Admin" button in the player header, and the pair of them implied the two were
// modes of a single thing you switched between to get work done. They are not: running a
// match and playing in one are different jobs with different screens, and everything an
// admin needs -- the clock, the roster, goals, ratings, payments, man of the match -- is
// in here. The player app is one line in the account menu, for the admins who also turn
// out on Saturday.

import { useState } from 'react';
import { NavLink, Outlet, Link, Navigate, useLocation } from 'react-router';
import {
  Goal, CalendarClock, Users, BarChart3, Loader2, CalendarDays, QrCode, MapPin,
  ChevronDown, User, LogOut, ExternalLink,
} from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useSession } from '../state/session.jsx';
import { Logo } from '../components/shared/Logo.jsx';
import { STORE_URL } from '../lib/links.js';

// Operations first: the pitch is where the work happens, so it is the home tab.
const NAV = [
  { to: '/admin', label: 'Operations', icon: Goal, end: true },
  { to: '/admin/schedule', label: 'Schedule', icon: CalendarClock },
  { to: '/admin/games', label: 'Games', icon: CalendarDays },
  { to: '/admin/players', label: 'Players', icon: Users },
  { to: '/admin/invites', label: 'Invites', icon: QrCode },
  { to: '/admin/venues', label: 'Venues', icon: MapPin },
  { to: '/admin/analytics', label: 'Analytics', icon: BarChart3 },
];

export function AdminLayout() {
  const { isAdmin, isLoading, user, logout } = useSession();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="grid min-h-svh place-items-center">
        <Loader2 className="size-6 animate-spin text-[var(--fg-muted)]" aria-label="Loading" />
      </div>
    );
  }

  // UX guard only. Every admin endpoint re-checks on the server; this just avoids
  // showing someone a console that will 403 on every request.
  //
  // Where they go depends on why they cannot be here. Somebody signed out needs to sign
  // in — this may be an admin who followed a bookmark. Somebody signed in who is simply
  // not an admin has nothing to sign in as; sending them to the login page asks them to
  // solve a problem they do not have, so they go to the app that is theirs.
  if (!isAdmin) {
    return user
      ? <Navigate to="/" replace />
      : <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return (
    <div className="min-h-svh bg-[var(--bg-canvas)]">
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
          <Link to="/admin" className="flex min-h-11 items-center gap-2">
            <Logo className="h-6" compact />
            <span className="display text-lg">Operations</span>
          </Link>

          <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Admin">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex h-9 items-center gap-2 rounded-[var(--radius-md)] px-3 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-[var(--bg-sunken)] text-[var(--fg-primary)]'
                      : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
                  )
                }
              >
                <item.icon className="size-4" aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex-1" />

          {/* The account menu. Everything that is not running a match lives behind it,
              including the way back to the player app -- which is a destination, not a
              mode toggle. */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
              className="flex min-h-11 items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-sm text-[var(--fg-secondary)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg-primary)]"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="hidden max-w-32 truncate sm:inline">{user?.displayName ?? 'Account'}</span>
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] py-1 shadow-[var(--shadow-lg)]"
              >
                <Link
                  to="/"
                  role="menuitem"
                  className="flex items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-[var(--bg-sunken)]"
                >
                  <User className="size-4 text-[var(--fg-secondary)]" aria-hidden="true" />
                  Player app
                </Link>
                <a
                  href={STORE_URL}
                  target="_blank"
                  rel="noreferrer"
                  role="menuitem"
                  className="flex items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-[var(--bg-sunken)]"
                >
                  <ExternalLink className="size-4 text-[var(--fg-secondary)]" aria-hidden="true" />
                  Store
                </a>
                <button
                  onClick={logout}
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-[var(--bg-sunken)]"
                >
                  <LogOut className="size-4 text-[var(--fg-secondary)]" aria-hidden="true" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="pb-24 md:pb-10">
        <Outlet />
      </main>

      {/* Mobile admin nav. Admins do use phones at the pitch.

          A SCROLLING RAIL, NOT A GRID.

          This was `grid-cols-5` with seven items in it, so the last two wrapped onto a
          second row: a nav twice as tall as the 96px of bottom padding the page reserves
          for it, sitting on top of the content. Seven destinations do not fit across a
          phone at a legible size and dropping two of them would hide Venues and Invites
          from the only device an admin has at a pitch. So it scrolls, with the first
          five reachable without moving and the rest a thumb-flick away. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex snap-x snap-mandatory overflow-x-auto border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] pb-safe md:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="Admin"
      >
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                // Exactly a fifth of the viewport, so five sit flush and the sixth peeks
                // in far enough to say there is more.
                'flex h-14 w-[20vw] shrink-0 snap-start flex-col items-center justify-center gap-0.5 text-[0.625rem] font-medium',
                isActive ? 'text-[var(--accent)]' : 'text-[var(--fg-muted)]'
              )
            }
          >
            <item.icon className="size-5" aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export default AdminLayout;
