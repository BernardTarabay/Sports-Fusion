// Session.
//
// Auth lives in an httpOnly cookie the browser sends automatically. This context holds
// only what the UI needs to RENDER: who is signed in and roughly what they can see.
//
// It is not authorization. Every admin route on the server checks the session again --
// hiding a button is a courtesy, not a control. Anyone can edit `roles` in devtools and
// all they will get is a nav link that 403s.

import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { authService } from '../api/services.js';
import { setUnauthorizedHandler } from '../api/client.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null);
  const [player, setPlayer] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | authenticated | anonymous

  const restore = useCallback(async () => {
    try {
      const { user: me, player: profile } = await authService.me();
      setUser(me);
      setPlayer(profile ?? null);
      setStatus('authenticated');
    } catch {
      setUser(null);
      setPlayer(null);
      setStatus('anonymous');
    }
  }, []);

  // Restore on boot. The cookie may already be valid from a previous visit, so the app
  // must not assume "no state in memory" means "signed out".
  useEffect(() => { restore(); }, [restore]);

  // A 401 anywhere in the app means the session is gone. Clear it once, centrally,
  // instead of every caller handling it.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setPlayer(null);
      setStatus('anonymous');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (credentials) => {
    const { user: me } = await authService.login(credentials);
    setUser(me);
    setStatus('authenticated');
    await restore();
    return me;
  }, [restore]);

  const signup = useCallback(async (details) => {
    const { user: me } = await authService.signup(details);
    setUser(me);
    setStatus('authenticated');
    await restore();
    return me;
  }, [restore]);

  /**
   * Adopt a session that some other flow already established.
   *
   * Phone sign-in and the QR join page both end with the server having set the auth
   * cookies and returned a user. They do not go through login(), so without this the
   * cookies would be valid while the app still thought nobody was signed in.
   */
  const adoptSession = useCallback(async (me) => {
    setUser(me);
    setStatus('authenticated');
    await restore();
    return me;
  }, [restore]);

  const logout = useCallback(async () => {
    await authService.logout().catch(() => {});
    setUser(null);
    setPlayer(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(() => {
    const roles = user?.roles?.map((r) => r.role) ?? [];
    return {
      user,
      player,
      status,
      isAuthenticated: status === 'authenticated',
      isLoading: status === 'loading',
      // UX only. The server decides.
      isAdmin: roles.some((r) => ['admin', 'owner', 'district_admin'].includes(r)),
      isOwner: roles.includes('owner'),
      login,
      signup,
      adoptSession,
      logout,
      refresh: restore,
    };
  }, [user, player, status, login, signup, adoptSession, logout, restore]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}
