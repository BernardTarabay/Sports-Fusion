// Admin shell.
//
// Deliberately a different product from the player app: denser, quieter, no floodlights.
// Two people run this league every week and they are doing a job, not enjoying a
// matchday. The visual identity stays (same type, same green) but the volume drops.

import { NavLink, Outlet, Link, Navigate, useLocation } from 'react-router';
import { Goal, CalendarClock, Users, BarChart3, ArrowLeft, Loader2, CalendarDays, QrCode, MapPin } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useSession } from '../state/session.jsx';
import { Logo } from '../components/shared/Logo.jsx';

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
  const { isAdmin, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="grid min-h-svh place-items-center">
        <Loader2 className="size-6 animate-spin text-[var(--fg-muted)]" aria-label="Loading" />
      </div>
    );
  }

  // UX guard only. Every admin endpoint re-checks on the server; this just avoids
  // showing someone a dashboard that will 403 on every request.
  if (!isAdmin) return <Navigate to="/login" state={{ from: location.pathname }} replace />;

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

          <Link
            to="/"
            className="flex min-h-11 items-center gap-1.5 px-1 text-sm text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
          >
            <ArrowLeft className="size-4" /> Player view
          </Link>
        </div>
      </header>

      <main className="pb-24 md:pb-10">
        <Outlet />
      </main>

      {/* Mobile admin nav. Admins do use phones at the pitch. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] pb-safe md:hidden"
        aria-label="Admin"
      >
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex h-14 flex-col items-center justify-center gap-0.5 text-[0.625rem] font-medium',
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
