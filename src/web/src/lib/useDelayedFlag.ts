import { useEffect, useState } from 'react';

/**
 * Reveals a transient state only after it has remained active for the whole delay.
 *
 * `scope` prevents a revealed flag from carrying across views that happen to share the same
 * active value, such as switching directly between two sessions whose workspaces are starting.
 * Turning the flag off always hides it immediately and cancels a pending reveal.
 */
export function useDelayedFlag(active: boolean, delayMs: number, scope: string | null): boolean {
  const [visibleScope, setVisibleScope] = useState<string | null>(null);

  useEffect(() => {
    setVisibleScope(null);
    if (!active || scope === null) return;

    const timer = window.setTimeout(() => setVisibleScope(scope), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs, scope]);

  return active && scope !== null && visibleScope === scope;
}
