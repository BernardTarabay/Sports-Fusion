// Theme.
//
// Three states, not two: light, dark, and "follow the system". The default is system,
// because someone whose phone switches to dark at sunset expects this to as well --
// and this app is used at 9pm.
//
// The choice is written to the root element as data-theme, which is what the CSS reads.
// localStorage here holds a display preference, never anything sensitive.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);
const STORAGE_KEY = 'sf-theme';

function readStored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return ['light', 'dark', 'system'].includes(value) ? value : 'system';
  } catch {
    // Private browsing, or storage disabled. Not a problem worth surfacing.
    return 'system';
  }
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStored);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);

    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }

    // Keep the browser chrome in step with the page, so the status bar does not sit
    // white above a match-night interface.
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        : theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'dark' ? '#0A0F0D' : '#F7FAF8');
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      setTheme: setThemeState,
      cycle: () => setThemeState((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light')),
    }),
    [theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside a ThemeProvider');
  return context;
}
