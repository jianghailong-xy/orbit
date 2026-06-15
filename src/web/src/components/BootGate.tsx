import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, getToken } from '../api';

// Routes that render their own loaders and have no first-screen data to wait on.
const BYPASS = ['/login', '/enroll'];

type BootWindow = Window & {
  __bootProgress?: (pct: number) => void;
  __bootDone?: () => void;
};

// Drive / dismiss the first-paint splash defined in index.html.
const setBootProgress = (pct: number) => (window as BootWindow).__bootProgress?.(pct);
const finishBoot = () => (window as BootWindow).__bootDone?.();

/**
 * Holds the app behind the index.html boot splash until the first-screen data
 * (tasks + runners) has resolved, so the UI appears in one shot instead of
 * filling in piecemeal. The bar is determinate: three real milestones — the app
 * mounting, then each critical query settling — each fill a third (33 → 67 →
 * 100%). The queries share their keys with the page/sidebar, so those read
 * straight from cache and never refetch. Only the authenticated app waits —
 * login/enroll pass straight through. The decision is made once on mount and
 * latched, so the 15s/3s background refetches never bring the splash back.
 */
export function BootGate({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const [gated] = useState(() => !!getToken() && !BYPASS.includes(loc.pathname));
  const [booted, setBooted] = useState(() => !gated);

  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api<unknown[]>('/tasks'),
    enabled: gated,
  });
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<unknown[]>('/runners'),
    enabled: gated,
  });

  // Three milestones: the mounted app, then each settled critical query.
  const settled = (tasks.isFetched ? 1 : 0) + (runners.isFetched ? 1 : 0);
  const ready = settled === 2;

  // Push real progress to the splash as each milestone completes (33 → 67 → 100%).
  useEffect(() => {
    if (booted || !gated) return;
    setBootProgress(Math.round(((1 + settled) / 3) * 100));
  }, [settled, booted, gated]);

  // Reveal once both critical queries settle (success OR error — never trap the
  // user behind the splash), with a hard timeout as a final backstop.
  useEffect(() => {
    if (booted) return;
    if (ready) {
      setBooted(true);
      return;
    }
    const t = setTimeout(() => setBooted(true), 8000);
    return () => clearTimeout(t);
  }, [ready, booted]);

  useEffect(() => {
    if (booted) finishBoot();
  }, [booted]);

  return booted ? <>{children}</> : null;
}
