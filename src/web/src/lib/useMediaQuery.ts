import { useEffect, useState } from 'react';

// Tracks a CSS media query from JS so the few layout decisions that can't live in the
// stylesheet (e.g. skipping the desktop "auto-open the latest session" redirect) stay in
// lockstep with index.css. Keep MOBILE_QUERY identical to the @media breakpoint there.
// 960px ≈ where the 3-column desktop layout (nav 340 + list 264 + a usable conversation)
// stops fitting, so portrait tablets and narrow windows get the stacked layout too.
export const MOBILE_QUERY = '(max-width: 960px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const useIsMobile = (): boolean => useMediaQuery(MOBILE_QUERY);
