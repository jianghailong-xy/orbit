import { queryOptions } from '@tanstack/react-query';
import type {
  EventSearchResponse,
  LinkPreviewRef,
  LinkPreviewsResponse,
  ProjectIntegrationView,
  ProjectPromotionView,
  SessionCreatedTasks,
  SessionSearchResponse,
  WatchView,
} from '@orbit/shared';
import {
  api,
  getSession,
  getSessionDiff,
  listShareLinks,
  type SessionListItem,
  type WorkspacePermissionRuleInfo,
} from '../api';
import {
  sessionLifecycleStateOf,
  type SessionLifecycleView,
} from './sessionState';
import type { SessionTagRef } from './sessionGrouping';
import type { ConfiguredProvider } from './workspaceDefaults';
import type { ProviderModelRow } from './providerAdmin';
import type { ProjectDependencyGraphResponse } from './projectDependencyGraph';
import type { CoordinatorStatus } from '../components/ProjectCoordinatorCard';
import type { PendingDecisionQueue } from '../components/DecisionRail';
import type { OwnerConfirmationView } from '../components/OwnerConfirmationCard';
import type { PendingCriteriaDecisionQueue } from '../components/CriteriaDecisionCard';
import type { ProjectOpenItemsView } from '../components/CoordinatorQuestionCard';
import type { ProjectCrossingRow, TaskAttribution } from './attribution';
import type { WikiSearchRow } from '@orbit/shared';
import type {
  WikiChangeset,
  WikiEntry,
  WikiEntryDetail,
  WikiSpaceRow,
  WikiSpaceWithUsage,
  WikiTimeline,
  WikiTopicView,
} from './wiki';
import { isWikiDisabled } from './wiki';
import {
  activeTasksPath,
  labelSummaryPath,
  taskCountsPath,
  type ActiveTasks,
  type LabelSummary,
  type TaskCounts,
} from './taskPages';
import { mergeWatches } from './watches';

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

export const workspacesQuery = () =>
  queryOptions({ queryKey: ['workspaces'], queryFn: () => api<any[]>('/workspaces') });

/** What a workspace's sessions no longer ask about: the "always allow" answers that outlived
 *  the session they were given in. Read where they can be reviewed and revoked. */
export const workspacePermissionRulesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['workspace-permission-rules', workspaceId] as const,
    queryFn: () =>
      api<WorkspacePermissionRuleInfo[]>(`/workspaces/${workspaceId}/permission-rules`),
  });

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

/** Per-account UI preferences (theme + new-workspace defaults). Mirrors the apiserver's
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
  /** Whether an agent may push a line of its own (the `notify` tool / `orbit notify`) to this
   *  account's devices. Absent means on; only opting out is ever written. */
  notifyAgentMessage?: boolean;
  /** Whether a newly created agent starts with session orchestration granted. Seeds the new
   *  agent's own switch — the grant that gets enforced stays on the agent. Absent means off. */
  defaultEnableOrchestration?: boolean;
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
 * Session list, optionally scoped to a runner, a workspace, a tag, a lifecycle view and a page
 * size. The key mirrors the query string one-to-one — `['sessions', runnerId, workspaceId, view,
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
  workspaceId: string | null,
  view: SessionListView | null,
  tagId: string | null,
  limit: number | null,
): Promise<SessionListItem[]> {
  const path = (requestedView: string | null): string => {
    const qs = new URLSearchParams();
    if (runnerId) qs.set('runnerId', runnerId);
    if (workspaceId) qs.set('workspaceId', workspaceId);
    if (requestedView) qs.set('view', requestedView);
    if (tagId) qs.set('tagId', tagId);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString();
    return `/sessions${suffix ? `?${suffix}` : ''}`;
  };
  const rows = await api<SessionListItem[]>(path(view));
  if (!view || view === 'open') return rows;
  const expected = view === 'completed' ? 'COMPLETED' : 'TRASH';
  // Older APIs silently interpret unknown view values as Open rather than returning 4xx.
  // A non-empty correctly scoped response proves canonical support; otherwise retry the
  // legacy alias. New APIs accept both aliases, so an actually empty list stays correct.
  if (rows.length > 0 && rows.every((row) => sessionLifecycleStateOf(row) === expected)) {
    return rows;
  }
  return api<SessionListItem[]>(path(LEGACY_SESSION_VIEW[view]));
}

export const sessionsQuery = (
  opts: {
    runnerId?: string | null;
    workspaceId?: string | null;
    view?: SessionListView | null;
    tagId?: string | null;
    limit?: number | null;
  } = {},
) => {
  const runnerId = opts.runnerId ?? null;
  const workspaceId = opts.workspaceId ?? null;
  const view = opts.view ?? null;
  const tagId = opts.tagId ?? null;
  const limit = opts.limit ?? null;
  return queryOptions({
    queryKey: ['sessions', runnerId, workspaceId, view, tagId, limit] as const,
    queryFn: () => fetchSessions(runnerId, workspaceId, view, tagId, limit),
  });
};

/** One workspace's Open-session tallies, as returned by `GET /sessions/counts`. */
export interface WorkspaceSessionCounts {
  workspaceId: string;
  /** Sessions with work admitted or queued (RUNNING or PENDING); used for the fast poll cadence. */
  active: number;
  /** Sessions that use the Session list's blue spinner (queued sessions deliberately excluded).
   *  Optional only for rolling compatibility with a control plane from before this field existed. */
  running?: number;
  /** Sessions with a background job in flight (a `bg_run` that will end; a `service` never counts).
   *  The rail's quieter activity mark — work a workspace can be doing with nobody generating in it.
   *  Optional for the same rolling-compatibility reason as `running`. */
  jobs?: number;
  /** Sessions blocked on an approval — the nav sidebar's per-workspace attention badge. A session
   *  counted here is in neither `running` nor `jobs`. */
  needsYou: number;
}

/**
 * Per-workspace Open-session tallies for the nav sidebar's badges. Its own key (not a `['sessions']`
 * scope) so the list's optimistic row edits, which patch every `['sessions']` entry, can't reach
 * these rows; the control-plane stream invalidates it alongside them.
 */
export const workspaceSessionCountsQuery = () =>
  queryOptions({
    queryKey: ['session-counts'] as const,
    queryFn: () => api<WorkspaceSessionCounts[]>('/sessions/counts'),
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
 * One session's detail — resolves the runner/workspace behind a `/sessions/:id` deep link.
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

/**
 * Per-label task progress for the Batches view, scoped to a list when one is open.
 *
 * One request answers for every label — the alternative is a task query per label, which is the
 * loop this endpoint exists to remove. Polled on the same cadence as an idle task list; the
 * numbers move when runs settle, not continuously.
 */
export const labelSummaryQuery = (listId?: string) =>
  queryOptions({
    queryKey: ['task-labels', listId ?? null] as const,
    queryFn: () => api<LabelSummary>(labelSummaryPath(listId)),
    staleTime: 10_000,
  });

/**
 * The active strip for the task page, scoped to a list when one is open.
 *
 * Polled faster than the list it sits above: this is the part of the page that is supposed to be
 * moving, and it is bounded, so the refresh costs a small query rather than a page of rows.
 */
export const activeTasksQuery = (listId?: string) =>
  queryOptions({
    queryKey: ['tasks', 'active', listId ?? null] as const,
    queryFn: () => api<ActiveTasks>(activeTasksPath(listId)),
    refetchInterval: 5_000,
  });

/**
 * The progress bar and the tab badges, keyed by the scope they describe.
 *
 * Not by the tab: the server computes these from a where-clause with no status filter and no
 * search term, so every tab sees the same numbers. Keyed this way, switching tab is a cache hit
 * and the four aggregates behind them run once per scope instead of once per tab.
 */
export const taskCountsQuery = (listId?: string, labels: string[] = [], creatorSessionId?: string) =>
  queryOptions({
    // The session scope enters the key only when there is one, so every other scope keeps the key
    // it had before that scope existed.
    queryKey: [
      'tasks',
      'counts',
      listId ?? null,
      labels,
      ...(creatorSessionId ? [{ creatorSessionId }] : []),
    ] as const,
    queryFn: () => api<TaskCounts>(taskCountsPath(listId, labels, creatorSessionId)),
    staleTime: 10_000,
  });

/**
 * The tasks a session's agent created, as the "Tasks created here" row above its composer draws
 * them. Under `['tasks']`, so the refresh `useControlPlane` runs on every `task.*` event reaches it
 * with no entry of its own. Polled while a row is running or queued besides: a queued task starting
 * is a session event, not a `task.changed`, and nothing else would redraw its pill.
 */
export const sessionCreatedTasksQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ['tasks', 'created-by-session', sessionId] as const,
    queryFn: () => api<SessionCreatedTasks>(`/sessions/${sessionId}/created-tasks`),
    refetchInterval: (q) =>
      q.state.data?.items.some((row) => row.running || row.queued) ? 15_000 : false,
  });

/**
 * `GET /projects/:id/coordinator/status` — what this project's coordination IS, and what pressing
 * the button would do if it were pressed right now.
 *
 * The response type is the CARD's, imported rather than restated: the payload is frozen in
 * `docs/project-coordinator-status-contract.md` and mirrored once, in the component that reads
 * every field of it. A second declaration here would be a copy free to drift from the thing that
 * renders it, which is the drift this module exists to prevent.
 *
 * Keyed under `['project', projectId]` like the panorama below, so the invalidation a project
 * write already fires refreshes it too. Polled, because everything on it moves without this tab
 * doing anything — the coordinator answers, a turn ends, a workspace is disabled — and faster than
 * the panorama's 30s: this one carries a live conversation's state, and a stale reading of it is
 * what puts a reader in front of a button that no longer does what it says.
 */
export const projectCoordinatorStatusQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'coordinator', 'status'] as const,
    queryFn: () =>
      api<CoordinatorStatus>(`/projects/${encodeURIComponent(projectId)}/coordinator/status`),
    refetchInterval: 15_000,
  });

/** One entry of the blocking-root leaderboard: an unfinished task and how much unfinished work
 *  sits behind it. `downstreamBlocked` is the TRANSITIVE closure — every task that waits on this
 *  one however indirectly — not the count of its direct edges, which carries no decision value. */
export interface ProjectBlockingItem {
  taskId: string;
  title: string;
  status: string;
  downstreamBlocked: number;
}

/**
 * `GET /projects/:id/panorama/blocking` — the ranking that answers "unblock which task to release
 * the most work".
 *
 * `remainingCount` is every unfinished task in the project, not the size of `items`: the card uses
 * it as the bar TRACK so a bar length means "this holds up 88% of what is left" rather than "this
 * is the biggest of the five shown". `truncated` is always present and normally null; the server
 * sets it instead of silently returning a short ranking when a project is too large to close over.
 */
export interface ProjectBlockingLeaderboard {
  remainingCount: number;
  items: ProjectBlockingItem[];
  truncated: { reason: string; maxTasks: number } | null;
}

/** Keyed UNDER `['project', projectId]`, like `projectCoordinatorStatusQuery` above, so the
 *  invalidation a project write already fires refreshes the ranking too. `limit` is in the key
 *  because it is in the URL: two cards asking for different depths are two different answers. */
export const projectPanoramaBlockingQuery = (projectId: string, limit = 5) =>
  queryOptions({
    queryKey: ['project', projectId, 'panorama', 'blocking', limit] as const,
    queryFn: () =>
      api<ProjectBlockingLeaderboard>(
        `/projects/${encodeURIComponent(projectId)}/panorama/blocking?limit=${limit}`,
      ),
  });

export type ProjectReadyToRunState = 'READY' | 'QUEUED' | 'RUNNING' | 'PAUSED';

export interface ProjectReadyToRunPausedList {
  id: string;
  title: string;
  readyCount: number;
  autoRunReadyCount: number;
}

/** One project task that can start now or has an active work Session. */
export interface ProjectReadyToRunItem {
  taskId: string;
  title: string;
  status: string;
  runState: ProjectReadyToRunState;
  /** Active Session for QUEUED/RUNNING rows; null for READY/PAUSED rows. */
  sessionId: string | null;
  /** The list-level action needed before a PAUSED row can expose Run. */
  pausedList: ProjectReadyToRunPausedList | null;
  /** Null only when the project is too large to compute transitive impact safely. */
  downstreamBlocked: number | null;
}

export interface ProjectReadyToRun {
  /** All runnable tasks in the project, not just the limited rows returned in `items`. */
  readyCount: number;
  queuedCount: number;
  runningCount: number;
  pausedCount: number;
  items: ProjectReadyToRunItem[];
  impactTruncated: { reason: string; maxTasks: number } | null;
}

/**
 * The actionable project queue. Polled because a run can start in another tab or through a
 * coordinator, neither of which invalidates this tab's `['project', id]` cache locally. Active
 * work is sampled faster so QUEUED/RUNNING rows settle promptly when their Session ends.
 */
export const projectReadyToRunQuery = (projectId: string, limit = 5) =>
  queryOptions({
    queryKey: ['project', projectId, 'panorama', 'ready', limit] as const,
    queryFn: () =>
      api<ProjectReadyToRun>(
        `/projects/${encodeURIComponent(projectId)}/panorama/ready?limit=${limit}`,
      ),
    refetchInterval: (query) => {
      const data = query.state.data;
      return (data?.queuedCount ?? 0) + (data?.runningCount ?? 0) > 0 ? 5_000 : 15_000;
    },
  });

/**
 * Keyed under `['project', projectId]` like the rest, so a project write invalidates it too.
 *
 * Polled on the same cadence as the panorama header and the chain progress above it, because the
 * marks now carry live run state (`running` / `queued`) and nothing else would ever bring it in:
 * the control-plane stream refreshes `['tasks']`, `['sessions']` and `['workspaces']`, never
 * `['project', id]`, and a run started by a coordinator or another tab is not a write this tab
 * makes. Left unpolled, a reader watching the picture would see the task start only if they
 * happened to reload the page.
 */
export const projectDependencyGraphQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'dependency-graph'] as const,
    queryFn: () =>
      api<ProjectDependencyGraphResponse>(
        `/projects/${encodeURIComponent(projectId)}/dependency-graph`,
      ),
    refetchInterval: 30_000,
  });

// ── Unit L7: the attribution boundary, and the two writes that cross it ───────────────────────

/**
 * `GET /tasks/:id/attribution` — where this work counts, who noticed it, which crossing reads
 * it, what is being asked about it and what is stopping it.
 *
 * Keyed under `['task', taskId]` so the invalidation a task write already fires refreshes it, and
 * separate from the task document because the two are fetched for different reasons: the document
 * is read on every navigation, and this joins the project, the crossings
 * table and the open blockers.
 */
export const taskAttributionQuery = (taskId: string) =>
  queryOptions({
    queryKey: ['task', taskId, 'attribution'] as const,
    queryFn: () => api<TaskAttribution>(`/tasks/${encodeURIComponent(taskId)}/attribution`),
  });

/**
 * `GET /projects/:id/handoffs` — what has been asked and answered about work crossing into or out
 * of this project, both directions.
 *
 * Both, because the people on the target are the ones being asked to take work and the people on
 * the source are the ones waiting on the answer; a queue showing one direction leaves one of them
 * looking at a list that never mentions what they are blocked on.
 */
export const projectCrossingsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'crossings'] as const,
    queryFn: () =>
      api<ProjectCrossingRow[]>(`/projects/${encodeURIComponent(projectId)}/handoffs`),
  });

/**
 * What one session is being asked to decide, re-derived by the server on every read.
 *
 * Keyed by the session because that is what the answer is about: the rows are this account's
 * facts, and which of them THIS session may settle is part of the payload. Nothing is cached
 * across sessions for the same reason — the same three questions read from two sessions are two
 * different answers about who may press the button.
 */
export const pendingDecisionsQuery = (decidingSessionId: string) =>
  queryOptions({
    queryKey: ['session', decidingSessionId, 'pending-decisions'] as const,
    queryFn: () =>
      api<PendingDecisionQueue>(
        `/tasks/evidence-decisions/pending?decidingSessionId=${encodeURIComponent(decidingSessionId)}`,
      ),
  });

/** One stored revision of a task's completion evidence, as `GET /tasks/:taskId/evidence` returns it. */
export interface TaskEvidenceRevision {
  revision: string;
  /** The envelope as it was submitted: `claim`, `gaps` and the rest. */
  evidence?: Record<string, unknown>;
}

/**
 * Every evidence revision a task has, oldest first — read when a decision receipt is opened, which
 * is where the web needs the evidence a decision answered after its card has gone. Its own key root,
 * not under `['task']`: a revision that was answered never changes, and every `task.*` event
 * refetches that prefix.
 */
export const taskEvidenceQuery = (taskId: string) =>
  queryOptions({
    queryKey: ['task-evidence', taskId] as const,
    queryFn: () => api<TaskEvidenceRevision[]>(`/tasks/${encodeURIComponent(taskId)}/evidence`),
  });

/**
 * What an OWNER_CONFIRMED task is waiting on, and what its owner has decided — re-derived by the
 * server on every read. Under `['task', taskId]` on purpose: every `task.*` event re-reads that
 * prefix, so a decision made in another window reaches the card, the pinned line and the task panel
 * through the one key the three of them share.
 */
export const ownerConfirmationQuery = (taskId: string) =>
  queryOptions({
    queryKey: ['task', taskId, 'owner-confirmation'] as const,
    queryFn: () =>
      api<OwnerConfirmationView>(`/tasks/${encodeURIComponent(taskId)}/owner-confirmation`),
  });

/**
 * Which loosening proposals this project's owner is being asked to decide, re-derived on every read.
 *
 * Keyed by the PROJECT and not by a session, because that is what the question is about: the ruler
 * belongs to the project, and which session happens to be reading it changes nothing about the
 * answer. The card and the pinned strip both read it through this one factory, so the transcript
 * and the floor under it can never be looking at two different moments.
 *
 * The row carries the proposal's one-time `commitToken`, which is the owner's key and is on this
 * read only — the session that filed the proposal is never handed one.
 */
export const pendingCriteriaDecisionsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'pending-criteria-decisions'] as const,
    queryFn: () =>
      api<PendingCriteriaDecisionQueue>(
        `/projects/${encodeURIComponent(projectId)}/acceptance/criteria-decisions/pending`,
      ),
  });

/**
 * What this project owes somebody a decision about, re-derived on every read: the exceptions its
 * coordinator is handling, and what waits for the owner in person — including the questions the
 * coordinator has asked them (`CoordinatorQuestionCard`, contract §4.8, §5.2).
 *
 * Keyed by the PROJECT, like the criteria proposals above and for the same reason: an item belongs
 * to the project, and which session is reading it changes nothing about the answer. So the project
 * page and the coordinator's conversation, which draw the same card, share one cache entry and can
 * never be looking at two different moments.
 */
export const projectOpenItemsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'open-items'] as const,
    queryFn: () =>
      api<ProjectOpenItemsView>(`/projects/${encodeURIComponent(projectId)}/open-items`),
  });

/**
 * The candidate this project is currently asking its owner to merge into main, or nothing
 * (contract §3.6). One row at a time by construction: the server serves the newest, and only one
 * candidate per source is ever live.
 *
 * Polled beside the open items on both hosts: the states it passes through — checked, confirmed,
 * re-checking after main moved, merged — are written by a runner reporting in, and the card is how
 * the reader watches them happen.
 */
export const projectPromotionQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'promotion'] as const,
    queryFn: () =>
      api<ProjectPromotionView | null>(
        `/projects/${encodeURIComponent(projectId)}/promotions/current`,
      ),
  });

/**
 * The merges this project has already made, newest first (contract §3.6) — the record each one
 * leaves in the conversation it was made in, drawn at the moment it happened.
 *
 * ITS OWN DOOR, not the one above. `current` is the candidate on offer: it moves on to the next one
 * the branch produces, so a receipt drawn from it says a different merge every time that happens —
 * and until it does, the card sits at the bottom of the pane describing something that already
 * happened. A MERGED promotion is terminal and immutable, carrying its own `mergedSha`/`mergedAt`,
 * so what a reader draws from here is the merge it was, at the moment it was, for as long as the
 * record exists.
 *
 * Polled beside it on the same cadence: a merge is written by a runner reporting in, and this is how
 * a conversation that is open watches its own merge land.
 */
export const projectMergedPromotionsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'promotions', 'merged'] as const,
    queryFn: () =>
      api<ProjectPromotionView[]>(
        `/projects/${encodeURIComponent(projectId)}/promotions/merged`,
      ),
  });

/**
 * Where this project's finished tasks land, and what the queue that lands them is doing right now
 * (contract §1.6, §7.2 V3).
 *
 * Its own endpoint rather than a widening of the project document, because the four job-derived
 * numbers cost queries the document does not otherwise make: `project-get-query-count.pg.spec.ts`
 * holds that document to a statement budget, and a page that reads the line every 30 seconds has
 * no business making the read that answers "what is this project called" more expensive.
 *
 * Keyed under `['project', projectId]`, so the invalidation a coordinator or settings write already
 * fires for the project refreshes this with it. Polled on the panorama's cadence for the same
 * reason: every number on the row moves without this tab doing anything — a job is claimed, a check
 * finishes, main is absorbed.
 */
export const projectIntegrationQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId, 'integration'] as const,
    queryFn: () =>
      api<ProjectIntegrationView>(`/projects/${encodeURIComponent(projectId)}/integration`),
    refetchInterval: 30_000,
  });

/**
 * The owner's watches, newest first, as one list. `GET /watches` answers with the 100 newest of any
 * state, so a long history would push a live watch out of it, and a failure nobody has seen yet with
 * it: the two live states are read on their own beside it, and so are the watches that need attention
 * (`?needsAttention=true`, contract `attention`) — at most 100 each, as the Mac app reads them — and
 * each watch is kept once. The Following page, every watch card and the Following / Followed by
 * relations on sessions and tasks are all drawn from this one read, so a watch reads the same
 * wherever it is shown. The control-plane
 * stream nudges it on the session, approval and task events that can move a watch, and on the
 * server's own `watch.changed` for the four changes none of those accompany — a delivery, a
 * deadline, a dead letter, an agent making or releasing one (useControlPlane, docs/watch-contract.md
 * §8.1). The slow poll stays: that event is an accelerant, dropped without a word when a replica
 * restarts or a socket goes quiet, and a watch may not be read a minute late because one was lost.
 */
export const watchesQuery = () =>
  queryOptions({
    queryKey: ['watches'] as const,
    queryFn: async () =>
      mergeWatches(
        await Promise.all([
          api<WatchView[]>('/watches'),
          api<WatchView[]>('/watches?state=ACTIVE'),
          api<WatchView[]>('/watches?state=PAUSED'),
          api<WatchView[]>('/watches?needsAttention=true'),
        ]),
      ),
    refetchInterval: 60_000,
  });

/**
 * Every public link this account has made, ended ones included (Settings → Shared links). Under
 * `['share-links']`, the prefix the Share dialog refreshes after every change it makes.
 */
export const shareLinksQuery = () =>
  queryOptions({
    queryKey: ['share-links'] as const,
    queryFn: listShareLinks,
  });

/**
 * One watch by id, for a link to one no list above holds — a wake card names the watch that queued
 * it, however old. Under the `['watches']` prefix, so whatever re-reads the list re-reads it too.
 */
export const watchQuery = (watchId: string) =>
  queryOptions({
    queryKey: ['watches', 'one', watchId] as const,
    queryFn: () => api<WatchView>(`/watches/${encodeURIComponent(watchId)}`),
  });

/**
 * A task as its list row reads it — the light read that names a watch's target. Its own key root,
 * not under `['task']`: every `task.*` event refetches that prefix, and a watch only needs the name.
 */
export const taskRowQuery = (taskId: string) =>
  queryOptions({
    queryKey: ['task-row', taskId] as const,
    queryFn: () =>
      api<{ id: string; title?: string; status?: string; terminalReason?: string | null }>(
        `/tasks/${encodeURIComponent(taskId)}/row`,
      ),
    staleTime: 5 * 60_000,
  });

/**
 * `POST /api/link-previews` — the cards for a conversation's links, one request per batch of refs.
 *
 * Keyed by the links it carries and nothing else, so two conversations showing the same task, or the
 * same conversation re-read, cost no second request. It has no clock of its own: the view that mounts
 * it re-reads it when its own data refreshes (`OrbitLinkCardsProvider`'s `refreshKey`), which is what
 * keeps a page nobody is looking at from asking the server anything. A POST because the refs are a
 * body, not because anything is written — it answers 200, so nothing here invalidates.
 */
// ── The Wiki ────────────────────────────────────────────────────────────────────────────────────

/**
 * Orbit Wiki's reads, every one of them under the `['wiki']` key root.
 *
 * ONE PREFIX FOR THE WHOLE FEATURE, because `wiki.changed` is the only thing that announces a wiki
 * write and it names nothing but the space that moved (`contracts/wiki.contract.json`
 * `realtime.redaction`): the control plane invalidates `['wiki']` and this page re-reads whatever it
 * is showing, which is what decides what it may see. A key outside the prefix is a view the event
 * cannot reach, and one under a foreign root is a re-read of something the event said nothing about
 * — the default `groupsFor` branch is `['sessions']`, so an unmapped wiki key would refresh the
 * session list on every wiki write.
 *
 * The space is addressed by its SLUG in the URL and by its id on the wire, so the two helpers below
 * are the only places that spelling changes.
 */

/**
 * Every space this owner has, each with the count of proposals waiting — the sidebar's number.
 *
 * `null` is the server saying the wiki is not switched on for this account (404 WIKI_DISABLED, the
 * apiserver's ORBIT_WIKI). It is an answer rather than a failure, so it is kept as data — nothing
 * retries it — and it is what every entry point the wiki has reads to draw nothing (`wikiShown`).
 */
export const wikiSpacesQuery = () =>
  queryOptions({
    queryKey: ['wiki', 'spaces'] as const,
    queryFn: async (): Promise<WikiSpaceRow[] | null> => {
      try {
        return await api<WikiSpaceRow[]>('/wiki/spaces');
      } catch (error) {
        if (isWikiDisabled(error)) return null;
        throw error;
      }
    },
    staleTime: 30_000,
  });

/**
 * One space, with the rolling usage window the home page's right rail reads.
 *
 * `include=usage` costs four aggregates over `wiki_exposure` that no other reader of the space
 * document pays for, which is why it is asked for here and nowhere else.
 */
export const wikiSpaceQuery = (spaceId: string | null) =>
  queryOptions({
    queryKey: ['wiki', 'space', spaceId] as const,
    queryFn: () => api<WikiSpaceWithUsage>(`/wiki/spaces/${encodeURIComponent(spaceId!)}?include=usage`),
    enabled: spaceId !== null,
  });

/** A space's entries, newest record first. The home page and the topic grid are both drawn from it. */
export const wikiEntriesQuery = (spaceId: string | null) =>
  queryOptions({
    queryKey: ['wiki', 'space', spaceId, 'entries'] as const,
    queryFn: () => api<WikiEntry[]>(`/wiki/spaces/${encodeURIComponent(spaceId!)}/entries?limit=200`),
    enabled: spaceId !== null,
  });

/** One topic's page: the entries carrying its slug, and the name the space has for it. */
export const wikiTopicQuery = (spaceId: string | null, slug: string | null) =>
  queryOptions({
    queryKey: ['wiki', 'space', spaceId, 'topic', slug] as const,
    queryFn: () =>
      api<WikiTopicView>(
        `/wiki/spaces/${encodeURIComponent(spaceId!)}/topics/${encodeURIComponent(slug!)}`,
      ),
    enabled: spaceId !== null && slug !== null,
  });

/** What changed in this space lately — the home page's timeline. */
export const wikiTimelineQuery = (spaceId: string | null) =>
  queryOptions({
    queryKey: ['wiki', 'space', spaceId, 'timeline'] as const,
    queryFn: () => api<WikiTimeline>(`/wiki/spaces/${encodeURIComponent(spaceId!)}/timeline`),
    enabled: spaceId !== null,
  });

/** One entry with everything the drawer draws: its sources, its history and who was shown it. */
export const wikiEntryQuery = (entryId: string | null) =>
  queryOptions({
    queryKey: ['wiki', 'entry', entryId] as const,
    queryFn: () =>
      api<WikiEntryDetail>(`/wiki/entries/${encodeURIComponent(entryId!)}?include=sources,history,exposure`),
    enabled: entryId !== null,
  });

/**
 * The wiki's own search, for the ⌘K palette's Wiki group: entries only, each saying which legs found
 * it (design §6).
 *
 * A SEPARATE KEY AND A SEPARATE ENDPOINT from the session search, and that is the whole reason the
 * route exists: a wiki hit is not a session and must not be decoded as one (an old client reading a
 * `SessionSearchHit` would fail on the whole answer), and every session hit's click goes to
 * `/sessions/:id`, which is not where an entry lives.
 *
 * `include=space,topics,anchor` because this caller OPENS what it finds: an entry's page is
 * `/wiki/<space>/e/<id>`, a space AND an id (`WikiSearchRowAdditions`).
 */
export const wikiSearchQuery = (q: string) =>
  queryOptions({
    queryKey: ['wiki', 'search', q] as const,
    queryFn: () =>
      api<{ q: string; semantic: boolean; hits: WikiSearchRow[] }>(
        `/wiki/search?q=${encodeURIComponent(q)}&include=space,topics,anchor`,
      ),
    // The same minute the session search keeps: a result set is a snapshot of a corpus that moves
    // when somebody writes, and one palette session is not a reason to re-read it per keystroke.
    staleTime: 60_000,
  });

/**
 * The space a session's workspace is bound to: the codebase Add to Wiki files a note into, and whose
 * topics its form offers.
 *
 * A read of its own rather than a lookup in the owner's space list, because which space a session
 * belongs to is the server's rule (`resolveSpaceForCall`) and not a guess the client is entitled to
 * make: an owner with two codebases would otherwise file a note into whichever the list happened to
 * put first. Under the `['wiki']` prefix like every other wiki read, so a `wiki.changed` re-reads it.
 */
export const wikiSpaceForSessionQuery = (sessionId: string | null) =>
  queryOptions({
    queryKey: ['wiki', 'session-space', sessionId] as const,
    queryFn: () => api<WikiSpaceRow>(`/wiki/spaces/for-session/${encodeURIComponent(sessionId!)}`),
    enabled: sessionId !== null,
    staleTime: 30_000,
  });

/**
 * What waits for the owner, newest first, across every space or one of them.
 *
 * The key carries the space so switching spaces is a cache hit rather than a refetch, and `null`
 * stays a key of its own — Review's own page asks across every space, which is not the same question
 * as asking about the one whose page happens to be open.
 */
export const wikiReviewQuery = (spaceId?: string | null) =>
  queryOptions({
    queryKey: ['wiki', 'review', spaceId ?? null] as const,
    queryFn: () =>
      api<WikiChangeset[]>(
        spaceId ? `/wiki/review?space=${encodeURIComponent(spaceId)}` : '/wiki/review',
      ),
  });

export const linkPreviewsQuery = (refs: readonly LinkPreviewRef[]) =>
  queryOptions({
    queryKey: [
      'link-previews',
      refs.map((ref) => `${ref.kind}:${ref.id}`).sort(),
    ] as const,
    queryFn: () =>
      api<LinkPreviewsResponse>('/link-previews', { method: 'POST', body: { refs: [...refs] } }),
    enabled: refs.length > 0,
  });
