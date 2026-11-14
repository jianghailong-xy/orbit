import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Where Settings' and Admin's "Back to Orbit" (and Esc) goes: the last address outside both this tab was
 * on, or the home page when one of them was the first page loaded. Kept in memory only, so a reload of a
 * Settings page goes home rather than to a page from another visit.
 */
let lastOutside: string | null = null;

/** Settings, and Admin, which is drawn as Settings is: moving between their pages is not leaving them. */
export const isSettingsPath = (pathname: string): boolean =>
  pathname === '/settings' || pathname.startsWith('/settings/') || pathname === '/admin' || pathname.startsWith('/admin/');

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
