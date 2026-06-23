import { queryOptions } from '@tanstack/react-query';
import { api, getSession, getSessionDiff } from '../api';

/**
 * Single source of truth for the app's shared React Query *reads*: every query's key
 * and its fetch are defined together, here, so two call sites can never drift into
 * different keys (or URLs) for the same data. That drift is exactly what produces a
 * silent cache miss — and a deep-link reload that the BootGate splash pre-warmed flash
 * a loader anyway, because the page asked for a key the splash never filled.
 *
 * Rule of thumb: a query whose key carries parameters (a runner id, a view), or that
 * the splash must pre-warm to match a page, lives here and is referenced from BOTH
 * sides. Call sites layer their own behaviour on top by spreading the options:
 *
 *   useQuery({ ...sessionsQuery({ runnerId, view }), refetchInterval: 4000 })
 *   useQuery({ ...sessionsQuery({ runnerId, view }), enabled: gated })
 *
 * Mutations that touch a cached list should reference `.queryKey` from the same factory
 * (e.g. `sessionsQuery({ runnerId, view }).queryKey`) rather than re-typing the array,
 * so an optimistic update can't drift from the query it's patching.
 */

export const runnersQuery = () =>
  queryOptions({ queryKey: ['runners'], queryFn: () => api<any[]>('/runners') });

/** Whether the deployment has zero users — gates the signed-out boot toward /setup. */
export const setupStatusQuery = () =>
  queryOptions({
    queryKey: ['setup-status'] as const,
    queryFn: () => api<{ needsSetup: boolean }>('/auth/setup-status'),
  });

export const agentsQuery = () =>
  queryOptions({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });

/** Per-account UI preferences (theme + new-agent defaults). Mirrors the apiserver's
 *  UpdatePreferencesDto; every key is optional and falls back to an app default. */
export interface UserPreferences {
  theme?: 'system' | 'light' | 'dark';
  defaultModel?: string;
  defaultPermissionMode?: string;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  preferences?: UserPreferences;
  role?: 'MEMBER' | 'ADMIN';
}

/** The signed-in user — backs the account page and the nav footer's avatar + name. */
export const meQuery = () =>
  queryOptions({
    queryKey: ['user', 'me'] as const,
    queryFn: () => api<Me>('/users/me'),
  });

/**
 * Session list, optionally scoped to a runner and/or a lifecycle view. The key mirrors
 * the query string one-to-one — `['sessions', runnerId, view]` — so every scope is its
 * own cache entry while the broad `['sessions']` prefix still invalidates them all.
 */
export const sessionsQuery = (opts: { runnerId?: string | null; view?: string | null } = {}) => {
  const runnerId = opts.runnerId ?? null;
  const view = opts.view ?? null;
  const qs = new URLSearchParams();
  if (runnerId) qs.set('runnerId', runnerId);
  if (view) qs.set('view', view);
  const suffix = qs.toString();
  return queryOptions({
    queryKey: ['sessions', runnerId, view] as const,
    queryFn: () => api<any[]>(`/sessions${suffix ? `?${suffix}` : ''}`),
  });
};

/**
 * One session's detail — resolves the runner/agent behind a `/sessions/:id` deep link.
 * Shares its key with the row in the list query so the two dedupe. Disabled when there
 * is no id; call sites tighten `enabled` further as needed.
 */
export const sessionQuery = (id: string | null | undefined) =>
  queryOptions({
    queryKey: ['session', id ?? null] as const,
    queryFn: () => getSession(id!),
    enabled: id != null,
  });

/**
 * One session's per-file diffs, for the worktree status bar's file viewer. The key nests
 * under the session's (`['session', id, 'diff']`) so invalidating `['session', id]` on a
 * turn end refreshes an open diff too. Lazy: call sites set `enabled` (e.g. only while the
 * diff drawer is open) so the patch payload is never fetched until a file is actually opened.
 */
export const sessionDiffQuery = (id: string | null | undefined) =>
  queryOptions({
    queryKey: ['session', id ?? null, 'diff'] as const,
    queryFn: () => getSessionDiff(id!),
    enabled: id != null,
  });
