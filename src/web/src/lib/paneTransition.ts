import { flushSync } from 'react-dom';
import { MOBILE_QUERY } from './useMediaQuery';

// Slides the phone layout's session list <-> conversation swap instead of hard-cutting it.
//
// Below MOBILE_QUERY the two panes are one `display:none` flip apart (index.css, the 960px
// block), so there is nothing in the DOM to tween. The View Transition API is the way in:
// it snapshots the whole viewport before and after the route changes and animates those two
// images, which the stylesheet aims with the `data-pane-nav` direction set here.
//
// Snapshotting the whole viewport is also what keeps the vanishing top bar honest. Opening a
// conversation deletes the global 48px bar (`:has(.workspace-split.show-conversation)`), so a
// pane that animated on its own would slide to one place and then settle 48px higher. Each
// snapshot is already laid out in its own geometry, so every screen travels intact.
//
// Anything that can't or shouldn't animate — desktop, reduced motion, a browser without the
// API — just navigates, which is exactly today's behaviour.
export function navigateWithPaneSlide(dir: 'push' | 'pop', navigate: () => void): void {
  const onPhone = window.matchMedia?.(MOBILE_QUERY).matches ?? false;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (!onPhone || reducedMotion || typeof document.startViewTransition !== 'function') {
    navigate();
    return;
  }
  const root = document.documentElement;
  root.dataset.paneNav = dir;
  const transition = document.startViewTransition(() => {
    // Which pane is on screen is decided by one class, and both panes are always mounted — so
    // put that class where the navigation is going before the browser snapshots the "after"
    // state. React sets the same value from the new route a moment later.
    //
    // Doing it by hand is not belt-and-braces, it is load-bearing: driving the real app showed
    // the router's commit landing AFTER the snapshot, so back animated the conversation sliding
    // off a second copy of itself instead of revealing the list. Rendering is suspended inside
    // this callback, so neither flushSync nor waiting for the mutation gets the commit in first.
    document.querySelector('.workspace-split')?.classList.toggle('show-conversation', dir === 'push');
    flushSync(navigate);
  });
  void transition.finished.finally(() => {
    delete root.dataset.paneNav;
  });
}

/** The two routes that put a conversation on the phone's one screen. WorkspaceView draws the
 *  session list for every other route — `show-conversation` is exactly these two. */
export const showsConversation = (path: string): boolean =>
  /^\/sessions\/[^/]+$/.test(path) || /^\/(?:workspaces|agents)\/[^/]+\/new$/.test(path);

/**
 * The same slide for the backs the app never issues itself: the browser's Back button, Android's
 * system back, the edge swipe. Those change the URL on their own, so nothing routes them through
 * navigateWithPaneSlide — popstate is the last moment that still runs before React Router commits
 * the new route, which is what keeps the "before" snapshot on the screen being left.
 *
 * Which way it went is read off the DOM rather than a remembered path: that class *is* the pane
 * swap, and until React commits it still names the screen we're on. A pop that swaps no pane
 * (conversation to conversation) or lands on a page without the split animates nothing.
 */
export function installPaneSlideOnPopState(): void {
  window.addEventListener('popstate', () => {
    const split = document.querySelector('.workspace-split');
    if (!split) return;
    const leaving = split.classList.contains('show-conversation');
    const entering = showsConversation(window.location.pathname);
    if (leaving === entering) return;
    // The browser has already navigated; this only has to redraw around it.
    navigateWithPaneSlide(entering ? 'push' : 'pop', () => {});
  });
}
