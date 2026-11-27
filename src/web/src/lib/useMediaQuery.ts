import { useEffect, useState } from 'react';

// Tracks a CSS media query from JS so the few layout decisions that can't live in the
// stylesheet (e.g. skipping the desktop "auto-open the latest session" redirect) stay in
// lockstep with index.css. Keep MOBILE_QUERY identical to the @media breakpoint there.
// 960px ≈ where the 3-column desktop layout (nav 340 + list 264 + a usable conversation)
// stops fitting, so portrait tablets and narrow windows get the stacked layout too.
export const MOBILE_QUERY = '(max-width: 960px)';
// A phone, narrower than that: the width index.css already treats as one (its
// `@media (max-width: 600px)` rules, where a card's actions stack full-width). Keep them identical.
export const PHONE_QUERY = '(max-width: 600px)';
// Wide enough for a task to sit beside its conversation as a column (docs/mocks/session-task-column):
// nav 280 + session list 320 + a 560px conversation + the 420px column and the gaps between them.
// Narrower, the task lies over the page as before. TaskOverPagePanel reads it and sets .is-docked.
export const TASK_COLUMN_QUERY = '(min-width: 1640px)';

export function useMediaQuery(query: string): boolean {
  // Guarded rather than read straight: this also runs under `renderToStaticMarkup`, where there
  // is no window at all, and in a test document that has no `matchMedia` (the toast viewport is
  // mounted in trees that never stubbed it). Either answers false — the desktop reading — and the
  // effect below corrects it on the first commit in a browser.
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const useIsMobile = (): boolean => useMediaQuery(MOBILE_QUERY);
