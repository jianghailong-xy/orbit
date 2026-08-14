import { queryOptions } from '@tanstack/react-query';
import type { EventSearchResponse, SessionSearchResponse } from '@orbit/shared';
import { api, getSession, getSessionDiff } from '../api';
import {
  sessionLifecycleStateOf,
  type SessionLifecycleView,
} from './sessionState';
import type { SessionTagRef } from './sessionGrouping';
import type { ConfiguredProvider } from './agentDefaults';
import type { ProviderModelRow } from './providerAdmin';

export type { ConfiguredProvider };

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

/** Control-plane–configured providers (custom slugs borrowing a built-in runtime), de-sensitized
 *  for the pickers. Merged with the built-in claude/codex in the provider/model dropdowns; any
 *  signed-in user can read it. */
export const providersQuery = () =>
  queryOptions({
    queryKey: ['providers'] as const,
    queryFn: () => api<ConfiguredProvider[]>('/providers'),
  });

/** What each vendor preset offers as the server has it *now*, by slug: the shipped catalogue with
 *  the latest third-party refresh (models.dev) folded in, and the default those models resolve to.
 *  Only the connect form needs it — a saved provider's row already comes back resolved. Nested
 *  under ['providers'] so the control plane's provider events invalidate it along with everything
 *  else that catalogue feeds. */
export interface PresetCatalogEntry {
  models: ProviderModelRow[];
  defaultModel: string;
}

export const presetModelsQuery = () =>
  queryOptions({
    queryKey: ['providers', 'presets'] as const,
    queryFn: () => api<Record<string, PresetCatalogEntry>>('/providers/presets'),
    staleTime: 5 * 60_000,
  });

/** Per-account UI preferences (theme + new-agent defaults). Mirrors the apiserver's
 *  UpdatePreferencesDto; every key is optional and falls back to an app default. */
export interface UserPreferences {
  theme?: 'system' | 'light' | 'dark';
  defaultModel?: string;
  defaultPermissionMode?: string;
  /** Account-wide default reasoning effort for a new session (last-picked-wins). '' = model
   *  default. Synced so the value carries to the iOS/macOS clients (replaces localStorage). */
  defaultEffort?: string;
  /** Whether a session settling — finished on its own, or failed for good — pushes an alert to
   *  this account's registered devices. Absent means on; only opting out is ever written. */
  notifySessionFinished?: boolean;
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
 * Session list, optionally scoped to a runner, an agent, a tag, a lifecycle view and a page
 * size. The key mirrors the query string one-to-one — `['sessions', runnerId, agentId, view,
 * tagId, limit]` — so every scope is its own cache entry while the broad `['sessions']` prefix
 * still invalidates them all.
 */
export type SessionListView = SessionLifecycleView;

/**
 * Rows in one page of the console's session column. The list asks for a single page on open
 * and widens the window as it's scrolled, so a machine with thousands of sessions doesn't pay
 * for all of them (nor re-pay on every list refresh) to paint the first screen. BootGate
 * pre-warms this same first page, so keep the two in step by importing the constant.
 */
export const SESSION_PAGE_SIZE = 40;

const LEGACY_SESSION_VIEW: Record<SessionLifecycleView, 'active' | 'archived' | 'deleted'> = {
  open: 'active',
  completed: 'archived',
  trash: 'deleted',
};

async function fetchSessions(
  runnerId: string | null,
  agentId: string | null,
  view: SessionListView | null,
  tagId: string | null,
  limit: number | null,
): Promise<any[]> {
  const path = (requestedView: string | null): string => {
    const qs = new URLSearchParams();
    if (runnerId) qs.set('runnerId', runnerId);
    if (agentId) qs.set('agentId', agentId);
    if (requestedView) qs.set('view', requestedView);
    if (tagId) qs.set('tagId', tagId);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString();
    return `/sessions${suffix ? `?${suffix}` : ''}`;
  };
  const rows = await api<any[]>(path(view));
  if (!view || view === 'open') return rows;
  const expected = view === 'completed' ? 'COMPLETED' : 'TRASH';
  // Older APIs silently interpret unknown view values as Open rather than returning 4xx.
  // A non-empty correctly scoped response proves canonical support; otherwise retry the
  // legacy alias. New APIs accept both aliases, so an actually empty list stays correct.
  if (rows.length > 0 && rows.every((row) => sessionLifecycleStateOf(row) === expected)) {
    return rows;
  }
  return api<any[]>(path(LEGACY_SESSION_VIEW[view]));
}

export const sessionsQuery = (
  opts: {
    runnerId?: string | null;
    agentId?: string | null;
    view?: SessionListView | null;
    tagId?: string | null;
    limit?: number | null;
  } = {},
) => {
  const runnerId = opts.runnerId ?? null;
  const agentId = opts.agentId ?? null;
  const view = opts.view ?? null;
  const tagId = opts.tagId ?? null;
  const limit = opts.limit ?? null;
  return queryOptions({
    queryKey: ['sessions', runnerId, agentId, view, tagId, limit] as const,
    queryFn: () => fetchSessions(runnerId, agentId, view, tagId, limit),
  });
};

/** One agent's Open-session tallies, as returned by `GET /sessions/counts`. */
export interface AgentSessionCounts {
  agentId: string;
  /** Sessions with a turn in flight (RUNNING or queued). */
  active: number;
  /** Sessions blocked on an approval — the nav sidebar's per-agent attention badge. */
  needsYou: number;
}

/**
 * Per-agent Open-session tallies for the nav sidebar's badges. Its own key (not a `['sessions']`
 * scope) so the list's optimistic row edits, which patch every `['sessions']` entry, can't reach
 * these rows; the control-plane stream invalidates it alongside them.
 */
export const agentSessionCountsQuery = () =>
  queryOptions({
    queryKey: ['session-counts'] as const,
    queryFn: () => api<AgentSessionCounts[]>('/sessions/counts'),
  });

/**
 * Cross-scope session search, backing the ⌘K palette. Keyed on the query itself so each distinct
 * search is its own cache entry — retyping a query the user just backspaced out of answers from
 * cache instead of re-hitting the server. An empty `q` is a real request, not a disabled one: the
 * server answers it with recents, which is what makes the palette a session switcher.
 */
export const sessionSearchQuery = (q: string) =>
  queryOptions({
    queryKey: ['session-search', q] as const,
    queryFn: () =>
      api<SessionSearchResponse>(`/sessions/search?q=${encodeURIComponent(q)}&limit=20`),
    // A search result is a snapshot of a moving list; a minute of staleness is invisible inside
    // one palette session and keeps arrow-keying through results from refetching.
    staleTime: 60_000,
  });

/**
 * Find within one session, backing ⌘F. Searches the session's whole history server-side — the
 * transcript only holds the tail it has lazily loaded, and folded tool bodies aren't in the DOM
 * even when they are loaded, so the client can't answer this for itself.
 *
 * Keyed on (session, query) so backspacing through a query re-answers from cache. The 200 cap is
 * the server's own maximum; `total` still reports every match, so a capped list can say so.
 */
export const sessionEventSearchQuery = (sessionId: string, q: string) =>
  queryOptions({
    queryKey: ['session-event-search', sessionId, q] as const,
    queryFn: () =>
      api<EventSearchResponse>(
        `/sessions/${sessionId}/events/search?q=${encodeURIComponent(q)}&limit=200`,
      ),
    staleTime: 60_000,
  });

/**
 * The signed-in user's session-tag library, ordered system-first by the server — the source for
 * the list's tag filter and its "Group by Tag" section headings. Rarely changes and cheap, so the
 * console holds it for filtering, grouping, and the session tag picker.
 */
export const sessionTagsQuery = () =>
  queryOptions({
    queryKey: ['session-tags'] as const,
    queryFn: () => api<SessionTagRef[]>('/session-tags'),
    staleTime: 5 * 60_000,
  });

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
