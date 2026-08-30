// Routes.
//
// TWO APPLICATIONS, NOT TWO VIEWS OF ONE.
//
// This used to be a single app with an admin/player toggle in the header, and the same
// matchday screen served both — an operations console with the controls hidden when a
// player was looking at it. That is a bad deal for everybody. The player gets a page
// organised around jobs that are not theirs, and the admin gets a workspace that has to
// keep apologising for the audience it might have.
//
// So:
//
//   /        THE PLAYER APP.  Find a game, join it, see your team, see where you stand.
//            Five destinations. Nothing about running a league appears anywhere in it.
//
//   /admin   THE ADMIN APP.   The pitch is the home screen, and everything needed to run
//            a match is on it: the clock, the roster, goals, ratings, payments, the man
//            of the match. An admin never needs to leave for the player app to do their
//            job.
//
// They share components, a session and an API. They do not share a shell, a navigation,
// or a screen, and there are no doors between them: an admin lands in the admin app and
// stays there. On a phone the mode links were the most confusing thing in the product —
// one tap moved you to a different navigation with different destinations and no obvious
// way back.

import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router';
import { Loader2 } from 'lucide-react';
import { AppLayout } from '../layouts/AppLayout.jsx';
import { AdminLayout } from '../layouts/AdminLayout.jsx';
import { useSession } from '../state/session.jsx';
import Landing from '../pages/Landing.jsx';
import Games from '../pages/Games.jsx';

/* The player app */
const MyGame = lazy(() => import('../pages/player/MyGame.jsx'));
const GameDetail = lazy(() => import('../pages/GameDetail.jsx'));
const PlayerProfile = lazy(() => import('../pages/PlayerProfile.jsx'));
const Leaderboards = lazy(() => import('../pages/Leaderboards.jsx'));
const Rewards = lazy(() => import('../pages/Rewards.jsx'));
const NotFound = lazy(() => import('../pages/NotFound.jsx'));
const Join = lazy(() => import('../pages/Join.jsx'));

/* The admin app */
const Matchday = lazy(() => import('../pages/Matchday.jsx'));
const AdminGameManage = lazy(() => import('../pages/admin/GameManage.jsx'));
const AdminGames = lazy(() => import('../pages/admin/Games.jsx'));
const AdminSchedule = lazy(() => import('../pages/admin/Schedule.jsx'));
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

/**
 * The front door, which is a different door depending on who you are.
 *
 * An admin signing in has come to run a match, not to browse fixtures, and with the mode
 * links gone the player app is a dead end for them. Only the index redirects: a direct
 * link to a game or a profile still resolves, so a shared link works for everybody and
 * an admin who does want the player app can still get there.
 */
function Home() {
  const { isAdmin, isLoading } = useSession();
  if (isLoading) return <RouteFallback />;
  return isAdmin ? <Navigate to="/admin" replace /> : <Landing />;
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

        {/* Public and outside every layout: whoever follows this has no account and no
            session, and the app chrome would only be noise. */}
        <Route path="/join/:token" element={<Join />} />

        {/* ---------------------------------------------------------------
            THE PLAYER APP
            --------------------------------------------------------------- */}
        <Route element={<AppLayout />}>
          <Route index element={<Home />} />

          {/* One tap from anywhere to the thing a player came for. */}
          <Route path="my-game" element={<RequireAuth><MyGame /></RequireAuth>} />
          {/* The old path, kept because it is in muscle memory and in shared links. */}
          <Route path="matchday" element={<Navigate to="/my-game" replace />} />
          <Route path="matchday/:id" element={<Navigate to="/my-game" replace />} />

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

        {/* ---------------------------------------------------------------
            THE ADMIN APP

            AdminLayout refuses anyone without a role, and every endpoint behind
            these screens re-checks on the server. The pitch is the index: an admin
            signing in lands on the fixture that is happening next, not on a menu.
            --------------------------------------------------------------- */}
        <Route path="/admin" element={<AdminLayout />}>
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
