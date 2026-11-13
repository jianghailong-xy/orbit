import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Where Settings' "Back to Orbit" (and Esc) goes: the last address outside /settings this tab was on,
 * or the home page when Settings was the first page loaded. Kept in memory only, so a reload of a
 * Settings page goes home rather than to a page from another visit.
 */
let lastOutside: string | null = null;

export const isSettingsPath = (pathname: string): boolean =>
  pathname === '/settings' || pathname.startsWith('/settings/');

export function settingsReturnPath(): string {
  return lastOutside ?? '/';
}

/** Records every address outside Settings as it is visited. Mounted once, at the app's routes. */
export function useRememberOutsideSettings(): void {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    if (!isSettingsPath(pathname)) lastOutside = pathname + search + hash;
  }, [pathname, search, hash]);
}

/** For specs: forget what was recorded. */
export function resetSettingsReturn(): void {
  lastOutside = null;
}
