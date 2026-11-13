import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type Query, type QueryFilters } from '@tanstack/react-query';
import type { WatchView } from '@orbit/shared';
import { getToken } from '../api';
import { streamReport } from './listBudget';

// Coalesce a burst of control events (a turn end fires status + approval back-to-back) into a
// single refetch per list. A second, as the list budget asks (docs/list-freshness-design.md R1): a
// write this tab makes waits in the same window (useRefreshSessionLists), so it and the event the
// server publishes for it a moment later are read once between them.
const REFRESH_DEBOUNCE_MS = 1_000;
// Project progress is read separately from the member sessions, and can settle after their update.
const PROJECTS_REFRESH_DEBOUNCE_MS = 2_000;
// `['task-lists']` gets a slower floor of its own. The debounce above is a *trailing* window, so a
// steady stream of task events never lets it close: a run writing tasks in bulk (a DAG being laid
// down, a sweep dispatching a large list) holds it open and pins every query in the group at 2 Hz.
// That is affordable for the task rows on screen and not for the list index, which is a per-list
// aggregate over every task the owner has — six figures of rows on a large account, counted afresh
// per request. What it feeds is a count and a coloured dot per list in the Tasks page's title menu,
// where 5s of staleness costs nothing, so refetching it faster than that is strictly more work than
// the poll this stream replaced.
const LISTS_MIN_INTERVAL_MS = 5_000;
// The project page's panorama reads (the header, the chain strip, ready-to-run, the dependency
// graph, the coordinator's status) are read on the events that can move them at most this often:
// `task.changed` names no project, so while a run writes tasks every one of them may have moved, and
// read on each window they would be read far more often than the polls they replace.
const PROJECT_PAGE_MIN_INTERVAL_MS = 5_000;
// The server pings ~every 20s (EventsController keepalive); 45s of total silence means the socket
// went half-dead without firing onerror. EventSource has no read timeout, so we watch for it.
const WATCHDOG_SILENCE_MS = 45_000;
const WATCHDOG_TICK_MS = 15_000;
// Twenty quick retries (about three minutes of backoff) ride out a restart; past them the stream is
// asked for once a minute rather than given up on. A tab that gave up stayed on the gated polls
// until it was reloaded — one such tab, polling 42 projects every 4 s, was most of production's
// database time on 2026-10-20 — and a request a minute costs nothing beside them.
const QUICK_RETRIES = 20;
const SLOW_RETRY_MS = 60_000;
// How many of the stream's refetches are out at once (see `refresh`). A stream that opens asks for
// every list again, and on a large account that is one read per project the workspace list shows
// besides the lists themselves: about fifty requests, which all left in the same instant. Each time
// a tab was reloaded or its stream reopened on 2026-10-24/25, 60 to 130 requests took 0.5 s or more
// within a few seconds, nearly all of them that tab's. A few at a time, the server answers them as
// fast as it would one by one, and the whole reconcile still lands within a second or two.
const FETCH_CONCURRENCY = 4;

const ControlPlaneLiveContext = createContext(false);
const RefreshSessionListsContext = createContext<(() => void) | null>(null);

/** True while the user-scoped control-plane SSE (`GET /api/events`) is connected. The session-list
 *  queries gate their interval polling on it: push keeps the lists fresh while the stream is live,
 *  and the poll resumes automatically on any gap (so an old server without the stream still works). */
export const useControlPlaneLive = (): boolean => useContext(ControlPlaneLiveContext);

/**
 * How a write this tab made re-reads the session lists. The server publishes its own event for the
 * write a moment later, and the stream re-reads the lists for that too: read at once here as well, one
 * click cost two or three list reads. So the write's read waits in the stream's coalescing window, and
 * the event joins it (docs/list-freshness-design.md W5). With no stream here (a test, no token), it
 * reads at once as before.
 */
export function useRefreshSessionLists(): () => void {
  const qc = useQueryClient();
  const viaStream = useContext(RefreshSessionListsContext);
  return useCallback(() => {
    if (!viaStream?.()) void qc.invalidateQueries({ queryKey: ['sessions'] });
  }, [qc, viaStream]);
}

/** An Open list query (`sessionsQuery`, view Open or the server's default, which is Open). */
const isOpenList = (queryKey: readonly unknown[]): boolean =>
  queryKey[0] === 'sessions' && queryKey.length === 6 && (queryKey[3] === 'open' || queryKey[3] === null);

/** Every entity a control-plane event can move, as the query declarations name them. Used by the
 *  reconnect's sweep, which has to reach all of them at once. */
const ENTITIES = ['task', 'session', 'project', 'workspace', 'tag', 'folder', 'provider', 'watch', 'wiki'] as const;

/**
 * Whether a cached query says, in `meta.entities`, that it derives from one of `entities`. Every
 * query definition in the tree makes this declaration (src/queryEntityMeta.test.ts), and it is the
 * only thing the stream selects on: a view is refreshed by the events naming the entities it
 * depends on, without anyone having to add it to a list here.
 *
 * The predicate is a linear scan of the query cache, where the key prefixes it replaces were
 * indexed lookups. The cache holds what a tab has mounted — tens of queries, one page's worth — so
 * the scan costs less than the hand-kept whitelist it removes. That trade is deliberate.
 */
const derivedFrom = (query: Query, entities: readonly string[]): boolean => {
  const declared = (query.meta?.entities as string[] | undefined) ?? [];
  return declared.some((entity) => entities.includes(entity));
};

/** The ids a `task.changed` names: `taskIds`, and `taskId` from an older server. */
const taskIdsOf = (data: { taskId?: unknown; taskIds?: unknown } | null | undefined): string[] => [
  ...(Array.isArray(data?.taskIds) ? data.taskIds.filter((id): id is string => typeof id === 'string') : []),
  ...(typeof data?.taskId === 'string' ? [data.taskId] : []),
];

/**
 * Opens one per-tab control-plane stream and turns it into liveness for the session-list queries,
 * mirroring the "snapshot + follow" model the iOS/macOS clients use. The control plane carries no
 * `sinceSeq` replay, so a fresh `GET /sessions` snapshot on (re)connect plus a coalesced refetch on
 * each event is the source of truth — not per-event deltas (the event's type/data are only a nudge
 * to refetch). While connected, the lists stop polling (see useControlPlaneLive); on any gap the
 * gated interval poll takes back over. Mounted once by AppShell, so there's one stream per tab.
 */
export function ControlPlaneProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  // The stream's own way to re-read the session lists, while it runs; null otherwise.
  const refreshSessionListsRef = useRef<(() => void) | null>(null);
  const refreshSessionLists = useCallback((): boolean => {
    const refresh = refreshSessionListsRef.current;
    refresh?.();
    return refresh !== null;
  }, []);
  useEffect(() => {
    if (!getToken()) return;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let listsTimer: ReturnType<typeof setTimeout> | undefined;
    let projectsTimer: ReturnType<typeof setTimeout> | undefined;
    let projectPagesTimer: ReturnType<typeof setTimeout> | undefined;
    let projectPagesReadAt = -Infinity;
    // The project pages whose reads are due ('' for every project), with the entities the events
    // that queued them said moved.
    const projectPagesDue = new Map<string, Set<string>>();
    // Whether this connection has delivered a `sessions.list_changed`. The server sends the first
    // within a second of a connection that declared the hint (docs/realtime-control-plane-stream.md
    // §4.8); from then on that hint is what reads the Open lists, and no other event reads them. Until
    // then (a server that predates the hint), every session event reads them as it always did.
    let hinted = false;
    const projectSessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let listsRefetchedAt = 0;
    let stopped = false;
    let dropped = false;
    // Whether a stream that opens has to read what is on screen again: once one has dropped, events
    // were missed. The page's first stream does not: what the page has just read is the snapshot it
    // follows, and reading it again was a second read of every list on every page load.
    let missedEvents = false;
    // When the gap began, and when the browser last came back online.
    let droppedAt = -Infinity;
    let onlineAt = -Infinity;
    let fails = 0;
    let lastMsgAt = Date.now();
    // A hidden tab reads nothing on the stream's word (docs/list-freshness-design.md R3).
    // React Query's interval polls already wait while the tab is hidden; `refetchQueries` does not,
    // so what the stream asks for waits in `queued` and is read once the tab is back in view.
    const hidden = (): boolean => document.visibilityState === 'hidden';

    // How every refetch below reaches the server. The matching queries are marked stale at once,
    // so one mounted later reads afresh, and the ones on screen are fetched through `pump`, at most
    // FETCH_CONCURRENCY at a time.
    //
    // A query nudged while its own fetch is still out is not asked for a second time. React Query's
    // invalidateQueries would ask (cancelRefetch), and no queryFn here reads the abort signal, so
    // the first request is not even aborted: the server builds both. On a slow server that
    // compounds, because a list nudged twice a second while each read takes two seconds is four
    // reads deep. Such a query is fetched once more when its fetch lands instead, since that fetch
    // may have started too early to see what the nudge announced. A first read is the exception, and
    // left alone as React Query itself leaves it: it was asked for a moment ago, when the page or the
    // list opened, and on a page load that is every list at once. A fetch that starts after a nudge
    // answers it, whoever started it (an interval poll, a mount), so a queued query is dropped then.
    const queued = new Map<string, Query>();
    const refetchWhenLanded = new Set<string>();
    let inFlight = 0;
    // When each query's latest read went out (a fetch started, or one held while offline resumed),
    // and what `refresh` leaves alone because a read already answers it (see `reconcile`).
    const readStartedAt = new Map<string, number>();
    let answered: ((query: Query) => boolean) | null = null;
    const pump = (): void => {
      if (hidden()) return;
      for (const [hash, query] of queued) {
        if (inFlight >= FETCH_CONCURRENCY) return;
        queued.delete(hash);
        if (!query.isActive()) continue;
        inFlight += 1;
        void qc.refetchQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }).finally(() => {
          inFlight -= 1;
          if (!stopped) pump();
        });
      }
    };
    const refresh = (filters: QueryFilters): void => {
      void qc.invalidateQueries({ ...filters, refetchType: 'none' });
      for (const query of qc.getQueryCache().findAll({ ...filters, type: 'active' })) {
        if (answered?.(query)) continue;
        if (query.state.fetchStatus === 'idle') queued.set(query.queryHash, query);
        else if (query.state.data !== undefined) refetchWhenLanded.add(query.queryHash);
      }
      pump();
    };
    const unsubscribeCache = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const { query, action } = event;
      if (action.type === 'fetch' || action.type === 'continue') readStartedAt.set(query.queryHash, Date.now());
      if (action.type === 'fetch') queued.delete(query.queryHash);
      else if (query.state.fetchStatus === 'idle' && refetchWhenLanded.delete(query.queryHash)) {
        queued.set(query.queryHash, query);
        pump();
      }
    });

    // `sessions.list_changed`: the Open list may read differently now. Each Open list on screen is
    // read once, as a delta against its own copy (lib/openListDelta), which the server answers empty
    // without building anything when nothing it shows moved. Before this connection's first hint
    // the session events read the Open lists, so this reads nothing then: a write's read, or a
    // reconnect's, would otherwise read each of them twice.
    const refetchOpenList = (): void => {
      if (!hinted) return;
      refresh({ predicate: ({ queryKey }) => isOpenList(queryKey) });
      refresh({ queryKey: ['session-counts'] });
    };
    // The project pages on screen: the events below name the project, or ('') every project, and
    // the entities they say moved. Which of a page's reads that dirties is their own declaration —
    // the task tree and its children say `task`, the rows whose work lane is a session also say
    // `session`, the project document says `project` — so a page read added under
    // `['project', id, …]` is reached without an entry here. A hand-kept list of key segments was
    // what missed the task tree until 2026-11-13.
    //
    // One read per PROJECT_PAGE_MIN_INTERVAL_MS at most, and never sooner than the coalescing
    // window: these are the expensive reads, and the floor is the list budget's
    // (docs/list-freshness-design.md §4).
    const refetchProjectPages = (projectId: string, entities: readonly string[]): void => {
      let due = projectPagesDue.get(projectId);
      if (!due) projectPagesDue.set(projectId, (due = new Set()));
      for (const entity of entities) due.add(entity);
      if (projectPagesTimer) return;
      const wait = Math.max(REFRESH_DEBOUNCE_MS, PROJECT_PAGE_MIN_INTERVAL_MS - (Date.now() - projectPagesReadAt));
      projectPagesTimer = setTimeout(() => {
        projectPagesTimer = undefined;
        projectPagesReadAt = Date.now();
        const due = [...projectPagesDue].map(([id, entities]) => [id, [...entities]] as const);
        projectPagesDue.clear();
        refresh({
          predicate: (query) =>
            query.queryKey[0] === 'project' &&
            // A held proposal's queue has its own event and its own narrowed path
            // (refetchCriteriaDecisions); a task event says nothing about a proposal.
            query.queryKey[2] !== 'pending-criteria-decisions' &&
            due.some(([id, entities]) => (!id || query.queryKey[1] === id) && derivedFrom(query, entities)),
        });
      }, wait);
    };
    // The lists index, rate-limited to one refetch per LISTS_MIN_INTERVAL_MS. Leading —
    // an idle tab still reflects a single task change immediately — then at most one trailing
    // refetch per window while events keep arriving, so a bulk write costs one request per window
    // instead of one per debounce tick. See LISTS_MIN_INTERVAL_MS for why this query, alone in the
    // task group, is worth holding back.
    const refetchTaskLists = (): void => {
      if (listsTimer) return; // a refetch is already queued for this window
      const wait = Math.max(0, LISTS_MIN_INTERVAL_MS - (Date.now() - listsRefetchedAt));
      listsTimer = setTimeout(() => {
        listsTimer = undefined;
        listsRefetchedAt = Date.now();
        refresh({ queryKey: ['task-lists'] });
      }, wait);
    };
    /**
     * A read the stream leaves to a budget of its own. These are the list budget's cost exclusions
     * (docs/list-freshness-design.md §4), not a whitelist of what an event may refresh: a read not
     * named here is selected by its `meta.entities` declaration alone.
     */
    const hasOwnBudget = (query: Query): boolean => {
      const root = query.queryKey[0];
      // The project page's reads: refetchProjectPages, floored at PROJECT_PAGE_MIN_INTERVAL_MS.
      if (root === 'project') return true;
      // One project's member list: one project at a time, scheduleProjectSessions.
      if (root === 'project-sessions') return true;
      // The rail's summaries and the Projects page's entries: refetchProjects, or the page's own poll.
      if (root === 'projects') return true;
      // The watch cards: they follow their own targets (watchFollows), not the entities they draw.
      if (root === 'watches') return true;
      // The lists index: its own longer floor, refetchTaskLists.
      if (root === 'task-lists') return true;
      // The sidebar's tallies: once the hint drives the Open lists, it reads them too
      // (refetchOpenList), so an event's path must not ask for them a second time.
      if (root === 'session-counts' && hinted) return true;
      // An evidence revision: an answered revision never changes.
      if (root === 'task-evidence') return true;
      // A search is a snapshot of a moving list, asked when its query changes and held for a
      // minute (sessionSearchQuery / sessionEventSearchQuery in queries.ts); re-running a
      // whole-history search on every session event is not what the event is for.
      if (root === 'session-search' || root === 'session-event-search') return true;
      // One session's own reads: the detail is refreshed by id (refetchSessionDetail); the diff and
      // the worktree file are the console's, on a turn end. A queue keyed by a session is the
      // exception when it derives from tasks — the evidence-decision read.
      if (root === 'session' && !derivedFrom(query, ['task'])) return true;
      // The Open lists once the hint drives them (refetchOpenList).
      if (hinted && isOpenList(query.queryKey)) return true;
      return false;
    };
    /**
     * Marks stale every cached read that declares one of the entities an event named. A query's own
     * `meta.entities` is the whole map from events to views: a view added anywhere in the tree is
     * reached by the first event naming an entity it declares, with no entry to keep here. A pair
     * is not repeated either — a workspace rename or a tag recolor moves the rows of every session
     * list, and those lists declare `workspace` / `tag` themselves.
     */
    const refetchEntities = (entities: ReadonlySet<string>): void => {
      if (entities.size === 0) return;
      const named = [...entities];
      refresh({ predicate: (query) => derivedFrom(query, named) && !hasOwnBudget(query) });
    };
    // The rail's project summaries. The session lists draw each row's project membership and
    // declare `project`, so a project change reaches them through refetchEntities; the Projects
    // page's filter entries are left out — they classify every task of every project and keep
    // their own poll.
    const refetchProjects = (): void => {
      refresh({ queryKey: ['projects', 'sidebar'] });
    };
    const scheduleProjectRefresh = (): void => {
      if (projectsTimer) clearTimeout(projectsTimer);
      projectsTimer = setTimeout(() => {
        projectsTimer = undefined;
        refetchProjects();
      }, PROJECTS_REFRESH_DEBOUNCE_MS);
    };
    const scheduleProjectSessions = (projectId: string): void => {
      const previous = projectSessionTimers.get(projectId);
      if (previous) clearTimeout(previous);
      projectSessionTimers.set(projectId, setTimeout(() => {
        projectSessionTimers.delete(projectId);
        refresh({ queryKey: ['project-sessions', projectId] });
      }, REFRESH_DEBOUNCE_MS));
    };
    // A held criteria proposal being filed or decided arrives as its own event naming the project;
    // an event that names none dirties every project's copy. The evidence-decision queue needs no
    // path of its own: it declares `task`, so a `task.changed` reaches it in refetchEntities, even
    // though it is keyed by the session DECIDING rather than by the task.
    const refetchCriteriaDecisions = (projectId: string): void => {
      refresh({
        predicate: ({ queryKey }) =>
          queryKey[0] === 'project' &&
          queryKey[2] === 'pending-criteria-decisions' &&
          (!projectId || queryKey[1] === projectId),
      });
    };
    // One session's own detail (`['session', id]`), which every refetch above is blind to: they
    // are lists. The console merges detail over its list row — detail is fresher and carries
    // capabilities compact rows omit — so a stale detail masks a fresh row, and detail goes stale
    // for exactly one reason: its query stops polling once the session is terminal. A terminal
    // session can still come back without this tab doing anything (AutoRetryService re-sending a
    // quota-killed message, another client resuming it), and until this refetch lands the console
    // keeps drawing the failure it froze on — and never re-opens the transcript stream it paused
    // there. Only ACTIVE queries refetch, so this costs one request for the session on screen and
    // nothing at all for the others.
    const refetchSessionDetail = (id: string): void => {
      // Exact: the diff under `['session', id, 'diff']` is refreshed on turn_end by the console
      // itself, and is far too expensive to re-run on every status change.
      refresh({ queryKey: ['session', id], exact: true });
    };
    // The owner's watches, once per window. Every cached watch declares `watch` — the four list
    // reads and any single watch under `['watches', 'one', id]` (queries.ts) — so one invalidation
    // reaches every card on screen. Which events ask for it is `watchFollows` below.
    const refetchWatches = (): void => {
      refresh({ predicate: (query) => derivedFrom(query, ['watch']) });
    };
    // Whether an event is about something a watch on hand follows. A watch's targets are read with
    // it, their standing drawn on its card (`targetStatus`, `targetTask`), so a session's, an
    // approval's or a task's event moves a watch card only when it is about one of those targets
    // (R5). What moves a watch itself — matched, expired, a delivery — is `watch.changed`, which the
    // server sends once the evaluator has written it (docs/watch-contract.md §8.1), so nothing here
    // reads early in the hope of catching it.
    const watchFollows = (
      type: string,
      sessionId: string,
      data: { taskId?: unknown; taskIds?: unknown; resync?: unknown } | null | undefined,
    ): boolean => {
      const sessionEvent = type.startsWith('session.') || type.startsWith('approval.');
      if (!(sessionEvent && sessionId) && type !== 'task.changed') return false;
      const tasks = type === 'task.changed' ? taskIdsOf(data) : [];
      for (const [, cached] of qc.getQueriesData<WatchView[] | WatchView>({ queryKey: ['watches'] })) {
        for (const watch of Array.isArray(cached) ? cached : cached ? [cached] : []) {
          for (const target of watch.targets ?? []) {
            if (sessionEvent) {
              if (target.targetKind === 'SESSION' && target.targetResourceId === sessionId) return true;
              continue;
            }
            const task = target.targetKind === 'TASK' ? target.targetResourceId : target.targetTask?.id;
            // A resync names no task: any watch on a task may have moved.
            if (task && (data?.resync === true || tasks.includes(task))) return true;
          }
        }
      }
      return false;
    };
    // The owner's wiki reads need no path of their own: every cached one — the space list, a
    // space's entries, one entry, the Review queue — declares `wiki`, so refetchEntities reaches
    // them. Every write path (a recorded changeset, a decided one) says only "this space moved", so
    // the whole group is what gets re-read; the event names no entry, op or count (contract
    // `realtime.redaction`). It is an accelerant and nothing more (contract `realtime.correctness`),
    // which is why no wiki read is made to depend on it.
    // The entities a control-plane event says moved. This is the whole of the event-type knowledge
    // the stream needs: which cached reads that dirties is their own declaration, so a view added
    // anywhere in the tree is reached by the first event naming an entity it declares, with no
    // entry here. A pair is not repeated here: a workspace rename and a tag recolor move the rows of
    // every session list, and those lists declare `workspace` / `tag`; the session tallies declare
    // both. An event this does not name reads nothing (R5): `notification`, `runner.*`,
    // `sessions.list_changed` (the Open list's hint is read through its own path), or whatever a
    // newer server sends that this client predates.
    const entitiesFor = (type: string): string[] => {
      if (type === 'task.changed') return ['task'];
      if (type.startsWith('task.')) return ['task']; // incl. task.list.changed
      // A workspace made or edited (an agent's workspace_create/workspace_update) arrives as
      // `agent.changed`, the server's older name for one (W7); `workspace.*` for a server that says so.
      if (type === 'agent.changed' || type.startsWith('workspace.')) return ['workspace'];
      if (type.startsWith('tag.')) return ['tag'];
      // A deleted folder's sessions are back in their workspace's list, so the rows move too.
      if (type.startsWith('folder.')) return ['folder'];
      if (type.startsWith('provider.')) return ['provider'];
      if (type === 'project.changed') return ['project'];
      // A held criteria proposal filed or decided: what moved is the coordinator's row, which counts
      // it in `pendingApprovals`, so the session lists are the reads it dirties.
      if (type === 'project.criteria_decisions.changed') return ['session'];
      // The server naming a watch itself: it was made, edited, paused, resumed or stopped; it
      // matched, expired or ended unmatched; or one of its deliveries delivered or dead-lettered
      // (docs/watch-contract.md §8.1). These are the changes NO other event accompanies — a
      // NOTIFY_USER delivery writes no task or session row, and a deadline passing writes none
      // either — so before this event the list only found them on its 60s poll, which still runs
      // and is still what makes a dropped event a latency bug and nothing more.
      if (type.startsWith('watch.')) return ['watch'];
      // The owner's wiki: one of its spaces moved — a changeset recorded something, the owner
      // decided ops in Review, or the space's own settings or bindings moved (contract
      // `realtime.publishedWhen`).
      if (type.startsWith('wiki.')) return ['wiki'];
      // A session's state, its approvals, and a background job of its ending, which moves its row's
      // job mark and its workspace's tally.
      if (type.startsWith('session.') || type.startsWith('approval.') || type === 'background.task') {
        return ['session'];
      }
      return [];
    };
    // What the stream has queued for this coalescing window: the entities the events named, and
    // the reads that are reached by a path of their own rather than through an entity.
    const pending = new Set<string>();
    const pendingFlags = new Set<'openList' | 'watches'>();
    const pendingSessions = new Set<string>();
    const pendingProjects = new Set<string>();
    const openWindow = (): void => {
      if (refreshTimer) return; // coalesce a burst into one refetch
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        // One scan for the whole burst: a query several of the window's events reach (a session
        // list, on a rename and the event that announces it) is marked once, not once per path.
        refetchEntities(pending);
        if (pending.has('task')) refetchTaskLists();
        if (pending.has('project')) refetchProjects();
        if (pending.has('watch') || pendingFlags.has('watches')) refetchWatches();
        if (pendingFlags.has('openList')) refetchOpenList();
        for (const id of pendingSessions) refetchSessionDetail(id);
        for (const id of pendingProjects) refetchCriteriaDecisions(id);
        pending.clear();
        pendingFlags.clear();
        pendingSessions.clear();
        pendingProjects.clear();
      }, REFRESH_DEBOUNCE_MS);
    };
    const scheduleRefresh = (
      type: string,
      sessionId: string,
      data: { id?: unknown; taskId?: unknown; taskIds?: unknown; resync?: unknown } | null | undefined,
    ): void => {
      // The Open list's hint is the one event whose path is not an entity: it says the list may read
      // differently, and is read through its own delta read rather than through the session events
      // that would read every session list for it (sessions.list_changed names no session).
      if (type === 'sessions.list_changed') pendingFlags.add('openList');
      for (const entity of entitiesFor(type)) pending.add(entity);
      if (watchFollows(type, sessionId, data)) pendingFlags.add('watches');
      // Only the `session.*` family: those are the events that can move a session's run state,
      // and so the ones a frozen detail has to be corrected by. An approval or a background task
      // reaches the open console through its own transcript stream, and a task/tag/provider edit
      // says nothing about any session's state.
      if (sessionId && type.startsWith('session.')) pendingSessions.add(sessionId);
      // '' when the event names no project, which refetchCriteriaDecisions reads as every project.
      if (type === 'project.criteria_decisions.changed') {
        pendingProjects.add(typeof data?.id === 'string' ? data.id : '');
      }
      if (pending.size > 0 || pendingFlags.size > 0 || pendingSessions.size > 0 || pendingProjects.size > 0) {
        openWindow();
      }
    };
    refreshSessionListsRef.current = () => {
      pending.add('session');
      // The server's hint for the write joins this read in the window.
      pendingFlags.add('openList');
      openWindow();
    };
    // What a stream that opened after a gap reads again (W6): every cached read that declares a
    // control-plane entity, a few at a time through `pump`. The per-event paths hold the Open lists
    // to the hint and leave the project page to its floor; a reconnect is not an event and reads
    // once what is on screen, so those cost exclusions do not apply. Three reads stay out — not as a
    // cost exclusion but because another owner reads them: a session's diff and worktree file are
    // the console's own, fetched on a turn end and the costliest reads it makes (see
    // refetchSessionDetail), an answered evidence revision never changes, and the lists index keeps
    // its longer floor (refetchTaskLists).
    //
    // A browser back online during the gap has already sent this round for the polls it held while
    // offline (React Query resumes them on `online`), so those are not read a second time.
    const reconcile = (): void => {
      const resumedFrom = onlineAt > droppedAt ? onlineAt : Infinity;
      answered = (query) => (readStartedAt.get(query.queryHash) ?? -Infinity) >= resumedFrom;
      try {
        refresh({
          predicate: (query) =>
            derivedFrom(query, ENTITIES) &&
            !(query.queryKey[0] === 'session' &&
              (query.queryKey[2] === 'diff' || query.queryKey[2] === 'worktree-file')) &&
            query.queryKey[0] !== 'task-evidence' &&
            query.queryKey[0] !== 'task-lists',
        });
        refetchTaskLists();
      } finally {
        answered = null;
      }
    };
    // Close the stream and schedule a backoff reconnect. Guarded by `dropped` so it fires once per
    // connection — onerror can fire repeatedly, and the watchdog can race it.
    const drop = (): void => {
      if (dropped) return;
      dropped = true;
      if (!missedEvents) droppedAt = Date.now();
      missedEvents = true;
      es?.close();
      setLive(false); // the gated interval polls take back over meanwhile
      streamReport.dropped();
      if (stopped) return;
      const backoff = ++fails > QUICK_RETRIES ? SLOW_RETRY_MS : Math.min(1000 * fails, 15000);
      reconnectTimer = setTimeout(connect, backoff + Math.random() * 500);
    };
    function connect(): void {
      dropped = false;
      hinted = false;
      lastMsgAt = Date.now();
      // `hints=list_changed` asks for the Open list's hint (docs/realtime-control-plane-stream.md §4.8).
      es = new EventSource(`/api/events?access_token=${encodeURIComponent(getToken() ?? '')}&hints=list_changed`);
      es.onopen = () => {
        lastMsgAt = Date.now();
        setLive(true);
        streamReport.opened();
        // No sinceSeq replay — after a gap, read again what is on screen, so changes missed during
        // it surface too. A tab that is hidden reads it when it is back in view (`pump`).
        if (missedEvents) {
          missedEvents = false;
          reconcile();
        }
      };
      es.onmessage = (e) => {
        lastMsgAt = Date.now();
        // The backoff starts over once something came down the stream, not when it opened. A
        // stream that opens and dies before its first message is a failure like any other: on
        // 2026-10-24 at 22:45Z one tab's opened and died every three seconds for a minute and a half,
        // and with the count reset at every open it was asked for again a second later each time,
        // and each time every list was read again (some 2,000 requests). The same holds for the
        // polls' backoff while the stream is down (listBudget).
        fails = 0;
        streamReport.message();
        let ev: {
          type?: string;
          sessionId?: string;
          data?: {
            id?: unknown;
            projectMembership?: { projectId?: unknown } | null;
            taskId?: unknown;
            taskIds?: unknown;
            resync?: unknown;
          } | null;
        };
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        // Dispatch on `type`: the keepalive ping is the only frame to drop. `sessionId` rides
        // along as an optional extra rather than a requirement, because the user-scoped library
        // events (tag/provider/task-list) legitimately carry none.
        if (!ev?.type || ev.type === 'ping') return;
        if (ev.type === 'sessions.list_changed') hinted = true;
        const projectId = ev.data?.projectMembership?.projectId;
        const id = ev.data?.id;
        if (ev.type === 'session.updated' || ev.type === 'session.created' || ev.type === 'session.ended') {
          if (typeof projectId === 'string' && projectId) {
            if (ev.type === 'session.updated') scheduleProjectRefresh();
            scheduleProjectSessions(projectId);
          }
          // A membership can be cleared (or changed), and older peers can omit it. Refresh a
          // loaded project's former member too, without touching any unrelated project.
          const sessionId = ev.sessionId || (typeof id === 'string' ? id : '');
          if (sessionId) {
            for (const [key, rows] of qc.getQueriesData<readonly { id: string }[]>({ queryKey: ['project-sessions'] })) {
              if (typeof key[1] === 'string' && rows?.some((row) => row.id === sessionId)) {
                scheduleProjectSessions(key[1]);
              }
            }
            // Lifecycle-ended frames carry no membership. A member entering Completed may
            // only be known in an earlier workspace Open list or its own session detail.
            if (ev.type === 'session.ended') {
              const known = qc.getQueriesData<readonly { id: string; projectMembership?: { projectId?: string } | null }[]>(
                { queryKey: ['sessions'] },
              ).flatMap(([, rows]) => rows?.filter((row) => row.id === sessionId) ?? []);
              const detail = qc.getQueryData<{ projectMembership?: { projectId?: string } | null }>(['session', sessionId]);
              for (const row of [...known, detail]) {
                if (row?.projectMembership?.projectId) scheduleProjectSessions(row.projectMembership.projectId);
              }
            }
          }
        }
        if (ev.type === 'project.changed' && typeof id === 'string' && id) {
          scheduleProjectSessions(id);
          refetchProjectPages(id, ['project']);
        }
        // What moves a project page: its own change, a member session's, and any task's
        // (`task.changed` names tasks, not their project). The entities say which of the page's
        // reads that event can have moved; the floor above keeps them on the list budget.
        if (ev.type.startsWith('session.') && typeof projectId === 'string' && projectId) {
          refetchProjectPages(projectId, ['session']);
        }
        if (ev.type === 'task.changed') refetchProjectPages('', ['task']);
        // The session an event is about: the envelope's, or a session event's own id from a peer
        // that leaves the envelope's empty. An approval's id is the approval's.
        const subject = ev.sessionId || (ev.type.startsWith('session.') && typeof id === 'string' ? id : '');
        scheduleRefresh(ev.type, subject, ev.data);
      };
      es.onerror = () => drop();
    }
    connect();
    // A tab coming back into view, or a browser back online, need not wait out the backoff: ask for
    // the stream at once. Nothing to do while one is open or opening.
    const retryNow = (): void => {
      if (stopped || !dropped || document.visibilityState === 'hidden') return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      connect();
    };
    // A poll that came due while the tab was hidden: React Query skipped its tick, and would
    // otherwise wait out a whole interval more before reading it.
    const pollDue = (query: Query, now: number): boolean => {
      for (const observer of query.observers) {
        const { enabled, refetchInterval } = observer.options;
        if (enabled === false) continue;
        const ms = typeof refetchInterval === 'function' ? refetchInterval(query) : refetchInterval;
        if (typeof ms === 'number' && ms > 0 && now - query.state.dataUpdatedAt >= ms) return true;
      }
      return false;
    };
    const catchUp = (): void => {
      const now = Date.now();
      for (const query of qc.getQueryCache().findAll({ type: 'active' })) {
        if (query.state.fetchStatus === 'idle' && pollDue(query, now)) queued.set(query.queryHash, query);
      }
      pump();
    };
    // Back in view, the tab reads once what it was asked to while hidden, and every poll that came
    // due meanwhile (R3).
    const onVisibility = (): void => {
      if (stopped || hidden()) return;
      catchUp();
      retryNow();
    };
    const onOnline = (): void => {
      onlineAt = Date.now();
      retryNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    const watchdog = setInterval(() => {
      if (!stopped && Date.now() - lastMsgAt > WATCHDOG_SILENCE_MS) drop();
    }, WATCHDOG_TICK_MS);
    return () => {
      stopped = true;
      refreshSessionListsRef.current = null;
      streamReport.stopped();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      clearInterval(watchdog);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (listsTimer) clearTimeout(listsTimer);
      if (projectsTimer) clearTimeout(projectsTimer);
      if (projectPagesTimer) clearTimeout(projectPagesTimer);
      for (const timer of projectSessionTimers.values()) clearTimeout(timer);
      unsubscribeCache();
      queued.clear();
      refetchWhenLanded.clear();
      readStartedAt.clear();
      es?.close();
    };
  }, [qc]);
  return (
    <ControlPlaneLiveContext.Provider value={live}>
      <RefreshSessionListsContext.Provider value={refreshSessionLists}>{children}</RefreshSessionListsContext.Provider>
    </ControlPlaneLiveContext.Provider>
  );
}
