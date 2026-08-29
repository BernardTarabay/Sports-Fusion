// Routes.
//
// THE GAME IS THE APPLICATION, so the matchday workspace is the destination, not a
// leaf. `/admin` IS the pitch — there is no dashboard in front of it — and `/matchday`
// with no id resolves the relevant fixture itself rather than asking anyone to pick a
// district first.
//
// Everything below the public shell is lazily loaded.

import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router';
import { Loader2 } from 'lucide-react';
import { AppLayout } from '../layouts/AppLayout.jsx';
import { AdminLayout } from '../layouts/AdminLayout.jsx';
import { useSession } from '../state/session.jsx';
import Landing from '../pages/Landing.jsx';
import Games from '../pages/Games.jsx';

const Matchday = lazy(() => import('../pages/Matchday.jsx'));
const GameDetail = lazy(() => import('../pages/GameDetail.jsx'));
const PlayerProfile = lazy(() => import('../pages/PlayerProfile.jsx'));
const Leaderboards = lazy(() => import('../pages/Leaderboards.jsx'));
const Rewards = lazy(() => import('../pages/Rewards.jsx'));
const NotFound = lazy(() => import('../pages/NotFound.jsx'));
const AdminGameManage = lazy(() => import('../pages/admin/GameManage.jsx'));
const AdminGames = lazy(() => import('../pages/admin/Games.jsx'));
const AdminSchedule = lazy(() => import('../pages/admin/Schedule.jsx'));
const Join = lazy(() => import('../pages/Join.jsx'));
const AdminInvites = lazy(() => import('../pages/admin/Invites.jsx'));
const AdminVenues = lazy(() => import('../pages/admin/Venues.jsx'));
const AdminDashboard = lazy(() => import('../pages/admin/Dashboard.jsx'));

const DistrictsIndex = lazy(() =>
  import('../pages/Districts.jsx').then((m) => ({ default: m.DistrictsIndex }))
);
const DistrictDetail = lazy(() =>
  import('../pages/Districts.jsx').then((m) => ({ default: m.DistrictDetail }))
);
const Login = lazy(() => import('../pages/Auth.jsx').then((m) => ({ default: m.Login })));
const Signup = lazy(() => import('../pages/Auth.jsx').then((m) => ({ default: m.Signup })));

function RouteFallback() {
  return (
    <div className="grid min-h-[50svh] place-items-center" role="status" aria-live="polite">
      <Loader2 className="size-6 animate-spin text-[var(--fg-muted)]" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function RequireAuth({ children }) {
  const { isAuthenticated, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) return <RouteFallback />;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />

        <Route element={<AppLayout />}>
          <Route index element={<Landing />} />

          {/* No id: the app works out which game matters. */}
          <Route path="matchday" element={<Matchday />} />
          <Route path="matchday/:id" element={<Matchday />} />

          <Route path="games" element={<Games />} />
          <Route path="games/:idOrSlug" element={<GameDetail />} />
          <Route path="g/:idOrSlug" element={<GameDetail />} />
          <Route path="districts" element={<DistrictsIndex />} />
          <Route path="districts/:slug" element={<DistrictDetail />} />
          <Route path="leaderboards" element={<Leaderboards />} />
          <Route path="players/:id" element={<PlayerProfile />} />
          <Route path="profile" element={<RequireAuth><PlayerProfile self /></RequireAuth>} />
          <Route path="rewards" element={<Rewards />} />
        </Route>

        {/* Public and outside every layout: whoever follows this has no account and no
            session, and the app chrome would only be noise. */}
        <Route path="/join/:token" element={<Join />} />

        <Route path="/admin" element={<AdminLayout />}>
          {/* The pitch, not a dashboard. */}
          <Route index element={<Matchday />} />
          <Route path="matchday/:id" element={<Matchday />} />
          <Route path="schedule" element={<AdminSchedule />} />
          <Route path="games" element={<AdminGames />} />
          {/* Games are created by scheduling them; there is no separate one-off form.
              The old path is kept as a redirect because it is in muscle memory and in
              older links. Static before dynamic, so "new" is not read as a game id. */}
          <Route path="games/new" element={<Navigate to="/admin/schedule" replace />} />
          <Route path="games/:id" element={<AdminGameManage />} />
          <Route path="players" element={<AdminGames listing="players" />} />
          <Route path="invites" element={<AdminInvites />} />
          <Route path="venues" element={<AdminVenues />} />
          <Route path="analytics" element={<AdminDashboard />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

export default AppRoutes;
