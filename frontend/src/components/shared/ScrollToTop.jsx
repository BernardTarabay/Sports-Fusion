// Restore scroll position on navigation.
//
// A single-page app keeps the scroll offset across routes by default, which means
// tapping a game from halfway down the list drops you halfway down the game page.

import { useEffect } from 'react';
import { useLocation } from 'react-router';

export function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    // 'instant' rather than smooth: a page change should feel like a page change, not
    // like a scroll animation the user did not ask for.
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [pathname]);

  return null;
}
