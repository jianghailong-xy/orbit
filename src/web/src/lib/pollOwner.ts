import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PROJECT_INTEGRATION_POLL, projectIntegrationQuery } from './queries';

/**
 * One interval per read, however many parts of a page draw it (project criterion 5H45pvgKd1UpxD5Lg4Oi4Y: one read
 * serves every part of a page that shows the same data).
 *
 * React Query keeps an interval per observer, and a page draws a project's integration line from a dozen components —
 * the line, the landings row, the merge strip, the start card, the run settings, the title bar. Each with its own poll,
 * their reads drifted apart and repeated one another. Here the parts that want a read polled take a lease on its key:
 * the first one mounted, and still enabled, holds the poll; the others read the same cache entry with none. When the
 * holder goes, the next one in line takes it over. A tab shows one page at a time, so this is the page's one owner.
 */
const leases = new Map<string, object[]>();
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether this part holds the poll of `key` (null: it wants none). */
export function usePollOwner(key: string | null): boolean {
  const [token] = useState(() => ({}));
  useEffect(() => {
    if (key === null) return undefined;
    leases.set(key, [...(leases.get(key) ?? []), token]);
    notify();
    return () => {
      const holders = (leases.get(key) ?? []).filter((holder) => holder !== token);
      if (holders.length > 0) leases.set(key, holders);
      else leases.delete(key);
      notify();
    };
  }, [key, token]);
  const holds = (): boolean => key !== null && leases.get(key)?.[0] === token;
  // The same answer when rendered to a string: nothing has mounted there, so no part holds a poll.
  return useSyncExternalStore(subscribe, holds, holds);
}

/**
 * A project's integration line (`projectIntegrationQuery`) as every part of a page reads it: one of them polls it
 * (PROJECT_INTEGRATION_POLL), the rest share its answer.
 */
export function useProjectIntegration(projectId: string, enabled = true) {
  const options = projectIntegrationQuery(projectId);
  const on = enabled && Boolean(projectId);
  const owner = usePollOwner(on ? JSON.stringify(options.queryKey) : null);
  return useQuery({ ...options, enabled: on, refetchInterval: owner ? PROJECT_INTEGRATION_POLL : false });
}
