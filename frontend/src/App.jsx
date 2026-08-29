// Application root: providers, then routes.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { Toaster } from 'sonner';
import { TooltipProvider } from './components/ui/index.jsx';
import { SessionProvider } from './state/session.jsx';
import { ThemeProvider } from './state/theme.jsx';
import { AppRoutes } from './app/router.jsx';
import { ScrollToTop } from './components/shared/ScrollToTop.jsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A roster changes minute to minute; a district's venue list does not. 30s is a
      // reasonable middle, and anything that must be fresh invalidates explicitly.
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Never retry a deliberate refusal. A 409 GAME_FULL is an answer, not a blip.
        if (error?.status >= 400 && error?.status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SessionProvider>
          {/* No animation library. Every transition in this app -- card entrances, the
              pitch markers building position by position, capacity meters filling, the
              team-generation sequence -- is CSS keyframes and transitions, which the
              compositor runs off the main thread and which cost nothing to ship. */}
          <TooltipProvider delayDuration={250}>
            <BrowserRouter>
              <ScrollToTop />
              <AppRoutes />
            </BrowserRouter>
            <Toaster
              position="top-center"
              offset={16}
              toastOptions={{
                classNames: {
                  toast: 'font-sans',
                },
              }}
              theme="system"
              richColors
              closeButton
            />
          </TooltipProvider>
        </SessionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
