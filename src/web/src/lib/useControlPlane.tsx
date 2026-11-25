import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type Query, type QueryFilters } from '@tanstack/react-query';
import { CONTROL_HINT_DRIVE_CHANGED, CONTROL_HINT_DRIVE_SYNCS, CONTROL_HINT_LIST_SCOPES, type WatchView } from '@orbit/shared';
import { getToken } from '../api';
import { streamReport } from './listBudget';
import { cloneEventOf, hearClone, sameWorkspace } from './workspaceClone';
import {
  heldIds,
  sessionReaches,
  taskReaches,
  type SessionReachDeclaration,
  type SessionSubject,
  type TaskChange,
  type TaskReachDeclaration,
} from './sessionReach';
import type { ProjectPlacement } from './queries';
import { refreshDriveSyncs } from './driveSyncs';

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
const ENTITIES = ['task', 'session', 'project', 'workspace', 'checkout', 'tag', 'folder', 'provider', 'watch', 'wiki', 'terminal', 'ownerRequest', 'scheduleCard'] as const;

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

/** The part of an event's `data` the stream reads. */
type EventData = {
  id?: unknown;
  taskId?: unknown;
  taskIds?: unknown;
  resync?: unknown;
  repoHealth?: unknown;
  projectId?: unknown;
  projectMembership?: { projectId?: unknown } | null;
} | null | undefined;

/** The ids of a string array an event carries, or null when it carries none (an older server's event). */
const idsOrNull = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : null;

/** What a `task.changed` says of its rows (lib/sessionReach TaskChange). An event that does not say it is bounded is a
 *  resync, as the server's normalizer reads it. */
const taskChangeOf = (data: { taskId?: unknown; taskIds?: unknown; resync?: unknown; creatorSessionIds?: unknown } | null | undefined): TaskChange => ({
  taskIds: taskIdsOf(data),
  creatorSessionIds: idsOrNull(data?.creatorSessionIds),
  resync: data?.resync !== false,
});

/** The task changes of a coalescing window, as refetchEntities reads them. */
type TaskScope = { changes: TaskChange[]; any: boolean };
/** The sessions whose schedule cards a window's events named. */
type CardScope = { sessions: Set<string>; all: boolean };

/** The ids a `task.changed` names: `taskIds`, and `taskId` from an older server. */
const taskIdsOf = (data: { taskId?: unknown; taskIds?: unknown } | null | undefined): string[] => [
  ...(Array.isArray(data?.taskIds) ? data.taskIds.filter((id): id is string => typeof id === 'string') : []),
  ...(typeof data?.taskId === 'string' ? [data.taskId] : []),
];

/**
 * What `GET /sessions/counts` counts a session in (SessionsService.workspaceSessionCounts), as far as a summary or a
 * list row says it. The server counts an Open conversation of a workspace: in `active` while it is RUNNING or
 * PENDING; in `running` for a dispatched turn (RUNNING); in `needsYou` while a person has to answer it, which takes it
 * out of `running` and `jobs`. The rest of `running` (the engine's own turn, a sub-agent) and of `jobs` (a bg_run job
 * or watch in flight) is held by columns no summary carries, and counts only while the session is held (PENDING,
 * RUNNING, AWAITING_INPUT, INTERRUPTED): a released one has them cleared. So those two can move only with that class,
 * or with a process starting or ending (`background.task`), and the rest waits for the safety read.
 */
type TallyFacts = { workspace: string; open: boolean; status: string; released: boolean | null; needsYou: boolean };
/** The fields of a summary, or of a session row this tab read, that `TallyFacts` is made from. */
type TallyRow = {
  id?: unknown;
  status?: unknown;
  runStatus?: unknown;
  lifecycleState?: unknown;
  sessionKind?: unknown;
  agentId?: unknown;
  agent?: { id?: unknown } | null;
  pendingApprovals?: unknown;
  waitingKind?: unknown;
  /** The release fact (contracts/session-state.contract.json); absent from an older control plane. */
  released?: unknown;
} | null | undefined;
/** The statuses whose session holds no process and whose turn is over: the reading of a row without `released`. */
const RELEASED_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
/** The `background.task` statuses that end a process (runner-api's bgEnded). */
const PROCESS_ENDED = new Set(['completed', 'failed', 'killed', 'stopped']);
/** Statuses that count alike: AWAITING_INPUT and INTERRUPTED are counted by the same rules, and so are the released. */
const tallyClass = (status: string, released: boolean | null): string =>
  released === true || (released === null && RELEASED_STATUSES.has(status))
    ? 'released'
    : status === 'AWAITING_INPUT' || status === 'INTERRUPTED' ? 'held' : status;
/** A start request lights no tally (owner-decision-signal.ts START_REQUEST), as the Session list's bar leaves it out. */
const needsYouOf = (pendingApprovals: unknown, waitingKind: unknown): boolean =>
  Number(pendingApprovals ?? 0) > 0 && waitingKind !== 'START_REQUEST';
const tallyFactsOf = (row: TallyRow, workspaceId: string): TallyFacts => {
  // The summary's own workspace before the envelope's, which the server resolves through a cache of its own.
  const workspace = row?.agentId || row?.agent?.id || workspaceId;
  return {
    workspace: typeof workspace === 'string' ? workspace : '',
    // A landing is in no tally, and neither is a session outside the Open list.
    open: (row?.lifecycleState ?? 'OPEN') === 'OPEN' && row?.sessionKind !== 'LANDING',
    status: String(row?.runStatus ?? row?.status ?? ''),
    released: typeof row?.released === 'boolean' ? row.released : null,
    needsYou: needsYouOf(row?.pendingApprovals, row?.waitingKind),
  };
};
/** A session's share of its workspace's tallies, '' when it is in none. Two facts with the same share move no tally. */
const tallyShare = (facts: TallyFacts): string => {
  if (!facts.open || !facts.workspace) return '';
  const counted = tallyClass(facts.status, facts.released);
  if (counted === 'released' && !facts.needsYou) return '';
  return `${facts.workspace} ${counted}${facts.needsYou ? ' needs-you' : ''}`;
};

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
    // The projects the due task changes' rows are in (`task.changed` `rowProjectIds`), which are the integration lines
    // they can move; null once one of them did not say.
    let integrationsDue: Set<string> | null = new Set();
    // Whether this connection has delivered a `sessions.list_changed`. The server sends the first
    // within a second of a connection that declared the hint (docs/realtime-control-plane-stream.md
    // §4.8); from then on that hint is what reads the Open lists, and no other event reads them. Until
    // then (a server that predates the hint), every session event reads them as it always did.
    let hinted = false;
    const projectSessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // The workspace lists' project placement (queries.ts projectPlacementQuery): the projects an event
    // named since its last read, and the window that read waits out.
    const placementDue = new Set<string>();
    let placementTimer: ReturnType<typeof setTimeout> | undefined;
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
    // When the tab came back into view, if that is what asked for the stream now connecting.
    let returnedAt = -Infinity;
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
    // The owner requests in the open list, as its last read had them. A request that arrived in it or left it (filed,
    // answered, expired) is one the other states' reads (done, declined, all) now show differently, and those are
    // read for nothing else on the stream's word: they are the whole history, and a session event says nothing of
    // requests (queries.ts ownerRequestsQuery). The first read only sets what is known.
    let openRequests: string | null = null;
    const followOpenRequests = (data: unknown): void => {
      const ids = ((data as { requests?: { id?: unknown }[] } | undefined)?.requests ?? [])
        .map((request) => String(request?.id))
        .sort()
        .join(' ');
      const before = openRequests;
      openRequests = ids;
      if (before === null || before === ids) return;
      refresh({ predicate: ({ queryKey }) => queryKey[0] === 'owner-requests' && queryKey[1] !== 'open' });
    };
    const unsubscribeCache = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const { query, action } = event;
      if (action.type === 'success' && query.queryKey[0] === 'owner-requests' && query.queryKey[1] === 'open') {
        followOpenRequests(query.state.data);
      }
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
    //
    // `scopes`: the workspaces the window's hints named (`hints=list_scopes`), or null when one of them named none, or
    // when this tab's own write asked: a list filtered to one workspace is read only when its workspace is among them,
    // and a list with no workspace filter on every hint (docs/realtime-control-plane-stream.md §4.8).
    const refetchOpenList = (scopes: ReadonlySet<string> | null): void => {
      if (!hinted) return;
      refresh({
        predicate: ({ queryKey }) => isOpenList(queryKey) && (
          scopes === null || typeof queryKey[2] !== 'string' || !queryKey[2]
          || [...scopes].some((scope) => sameWorkspace(scope, queryKey[2] as string))
        ),
      });
    };
    // The sidebar's tallies (queries.ts workspaceSessionCountsQuery), read at the end of a window in which some
    // session's share of them moved (`tallyShare`), a session's process may have started or ended, or this tab wrote.
    // Anything else leaves them to the safety read.
    const refetchCounts = (): void => {
      refresh({ queryKey: ['session-counts'] });
    };
    // What each session counts in, as the stream last described it, and the processes each was last reported
    // running by: a runner-hosted job re-reports itself `running` once a minute.
    const tallies = new Map<string, TallyFacts>();
    const processes = new Map<string, Set<string>>();
    // This window's sessions, each with its share as the window found it (null: unknown), and whether a process
    // started or ended in it.
    const sharesBefore = new Map<string, string | null>();
    let processMoved = false;
    // What a session counts in when the stream has not described it yet: what this tab last read of it.
    const readFacts = (sessionId: string): TallyFacts | undefined => {
      for (const [key, cached] of qc.getQueriesData<unknown>({ predicate: ({ queryKey }) => queryKey[0] === 'sessions' || (queryKey[0] === 'session' && queryKey.length === 2) })) {
        const rows = (Array.isArray(cached) ? cached : key[0] === 'session' && cached ? [cached] : []) as TallyRow[];
        const row = rows.find((candidate) => candidate?.id === sessionId);
        if (row) return tallyFactsOf(row, '');
      }
      return undefined;
    };
    const noteTallies = (type: string, sessionId: string, data: EventData, workspaceId: string): void => {
      if (!sessionId) return;
      if (type === 'background.task') {
        const task = data as { status?: unknown; name?: unknown; toolUseId?: unknown; kind?: unknown } | null | undefined;
        const status = String(task?.status ?? '');
        // A `service` is never in `jobs`; an older server sends no kind, nor an id, so a name stands in for one.
        const process = typeof task?.toolUseId === 'string' && task.toolUseId ? task.toolUseId : `name:${String(task?.name ?? '')}`;
        const running = processes.get(sessionId) ?? new Set<string>();
        if (status === 'running' && task?.kind !== 'service') {
          if (!running.has(process)) processMoved = true;
          running.add(process);
          processes.set(sessionId, running);
        } else if (PROCESS_ENDED.has(status)) {
          // Not only a job: an Agent call the engine ran in the background ends the same way, and leaves `running`.
          running.delete(process);
          processMoved = true;
        }
        return;
      }
      const summary = type === 'session.created' || type === 'session.updated';
      if (!summary && type !== 'session.ended' && !type.startsWith('approval.')) return;
      // A created session was in no Open list a moment ago, so it was in no tally.
      const created = type === 'session.created';
      const before = created ? undefined : tallies.get(sessionId) ?? readFacts(sessionId);
      if (!sharesBefore.has(sessionId)) sharesBefore.set(sessionId, created ? '' : before ? tallyShare(before) : null);
      const approval = data as { pendingApprovals?: unknown; waitingKind?: unknown } | null | undefined;
      // An approval's event that says no count (an older server) says nothing of what the session needs.
      if (!summary && type !== 'session.ended' && typeof approval?.pendingApprovals !== 'number') {
        sharesBefore.set(sessionId, null);
        return;
      }
      const next: TallyFacts | undefined = summary
        ? tallyFactsOf(data as TallyRow, workspaceId)
        : type === 'session.ended'
          ? { workspace: before?.workspace ?? workspaceId, open: false, status: before?.status ?? '', released: before?.released ?? null, needsYou: false }
          : before && { ...before, needsYou: needsYouOf(approval?.pendingApprovals, approval?.waitingKind) };
      if (!next) return;
      tallies.set(sessionId, next);
      // A session that ended or left the Open list had its processes taken off it (sessions/running-work.ts).
      if (!next.open || tallyClass(next.status, next.released) === 'released') processes.delete(sessionId);
    };
    // Whether this window moved a tally; it starts the next window afresh.
    const talliesMoved = (): boolean => {
      let moved = processMoved;
      for (const [sessionId, before] of sharesBefore) {
        const now = tallies.get(sessionId);
        if (before === null || !now || tallyShare(now) !== before) moved = true;
      }
      sharesBefore.clear();
      processMoved = false;
      return moved;
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
    const refetchProjectPages = (projectId: string, entities: readonly string[], rowProjects?: readonly string[] | null): void => {
      let due = projectPagesDue.get(projectId);
      if (!due) projectPagesDue.set(projectId, (due = new Set()));
      for (const entity of entities) due.add(entity);
      if (!projectId) {
        if (!rowProjects) integrationsDue = null;
        else for (const id of rowProjects) integrationsDue?.add(id);
      }
      if (projectPagesTimer) return;
      const wait = Math.max(REFRESH_DEBOUNCE_MS, PROJECT_PAGE_MIN_INTERVAL_MS - (Date.now() - projectPagesReadAt));
      projectPagesTimer = setTimeout(() => {
        projectPagesTimer = undefined;
        projectPagesReadAt = Date.now();
        const due = [...projectPagesDue].map(([id, entities]) => [id, [...entities]] as const);
        const integrations = integrationsDue;
        projectPagesDue.clear();
        integrationsDue = new Set();
        // An event naming no project (a task change) reaches a project's integration line only when its rows are in
        // that project, or it does not say where they are.
        const integrationReached = (id: string, query: Query): boolean =>
          Boolean(id) || query.queryKey[2] !== 'integration' || integrations === null ||
          integrations.has(String(query.queryKey[1]));
        refresh({
          predicate: (query) =>
            query.queryKey[0] === 'project' &&
            // A held proposal's queue has its own event and its own narrowed path
            // (refetchCriteriaDecisions); a task event says nothing about a proposal.
            query.queryKey[2] !== 'pending-criteria-decisions' &&
            due.some(([id, entities]) =>
              (!id || query.queryKey[1] === id) && derivedFrom(query, entities) && integrationReached(id, query)),
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
      // The workspace lists' project placement: only for its own projects, schedulePlacement.
      if (root === 'project-placement') return true;
      // The rail's summaries and the Projects page's entries: refetchProjects, or the page's own poll.
      if (root === 'projects') return true;
      // The watch cards: they follow their own targets (watchFollows), not the entities they draw.
      if (root === 'watches') return true;
      // The lists index: its own longer floor, refetchTaskLists.
      if (root === 'task-lists') return true;
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
      // The guest view of a session shared with this reader (GuestSessionPage): it follows that session over the guest
      // door's own stream and keeps what the stream adds below the page this read returned, so the page read again
      // would bring those events back a second time. The events here are the reader's own sessions', never that one's.
      if (root === 'guest-session') return true;
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
     *
     * A session's own events (`session.*`, `approval.*`, `background.task`) are narrower: they say which
     * session moved, so they reach a read that declares `session` only when that session can be in it
     * (`meta.sessionReach`, lib/sessionReach). On 2026-11-20 every such event read every one of some twenty
     * reads (owner requests, schedules, another session's cards, a Scheduled runs folder built whole), a burst
     * almost every second under load. Whatever else names `session` (a write this tab made, a held criteria
     * proposal) names no one session, and reaches every such read.
     */
    const refetchEntities = (
      entities: ReadonlySet<string>,
      subjects: readonly SessionSubject[],
      anySession: boolean,
      tasks: TaskScope,
      cards: CardScope,
    ): void => {
      if (entities.size === 0) return;
      const named = [...entities].filter((entity) => entity !== 'session' || anySession);
      // A read that says which task changes reach it (`meta.taskReach`, a session's created tasks) is read for the
      // window's task events only when one of them can move it; every other task-derived read, for any of them.
      const taskReached = (query: Query): boolean => {
        const declared = query.meta?.taskReach as TaskReachDeclaration | undefined;
        if (!declared || tasks.any) return true;
        const reach = typeof declared === 'function' ? declared(query.state.data) : declared;
        return tasks.changes.some((change) => taskReaches(reach, change));
      };
      // A session's schedule cards (`meta.scheduleCardsOf`) are read when `schedule_cards.changed` names the session.
      const cardsReached = (query: Query): boolean => {
        const of = query.meta?.scheduleCardsOf;
        return cards.all || typeof of !== 'string' || cards.sessions.has(of);
      };
      const declares = (query: Query): boolean =>
        ((query.meta?.entities as string[] | undefined) ?? []).some((entity) =>
          named.includes(entity) &&
          (entity !== 'task' || taskReached(query)) &&
          (entity !== 'scheduleCard' || cardsReached(query)));
      const bySession = entities.has('session') && !anySession;
      // Whether a list other than a Scheduled runs folder holds the session (sessionReach's `scheduledRuns`).
      const listed = (id: string): boolean =>
        qc.getQueryCache().findAll().some(({ queryKey, state }) =>
          ((queryKey[0] === 'sessions' && queryKey.length === 6) || queryKey[0] === 'project-sessions') &&
          heldIds(state.data).includes(id));
      const reached = (query: Query): boolean => {
        const declared = query.meta?.sessionReach as SessionReachDeclaration | undefined;
        const reach = typeof declared === 'function' ? declared(query.state.data) : declared;
        const held = heldIds(query.state.data);
        return subjects.some((subject) => sessionReaches(reach, subject, held, listed));
      };
      refresh({
        predicate: (query) =>
          !hasOwnBudget(query) &&
          (declares(query) || (bySession && derivedFrom(query, ['session']) && reached(query))),
      });
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
    // A workspace list's project placement, read once a coalescing window when an event names one of its
    // projects (W4): the first such event opens the window, and the ones inside it join that read rather
    // than putting it off, so a busy project reads it at most once a window and never waits forever.
    const schedulePlacement = (projectId: string): void => {
      placementDue.add(projectId);
      if (placementTimer) return;
      placementTimer = setTimeout(() => {
        placementTimer = undefined;
        const due = new Set(placementDue);
        placementDue.clear();
        refresh({
          predicate: ({ queryKey }) => queryKey[0] === 'project-placement' &&
            String(queryKey[2] ?? '').split(',').some((id) => due.has(id)),
        });
      }, REFRESH_DEBOUNCE_MS);
    };
    const scheduleProjectSessions = (projectId: string): void => {
      schedulePlacement(projectId);
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
    // A scheduled run's session draws its run from its schedule cards (`run`: its state, its report), and the run moves
    // with that session's own run, which no schedule write announces: while the run is open, the session's `session.*`
    // events read its cards. An ended run is settled, and an ordinary session's cards follow `schedule_cards.changed`.
    const refetchScheduleRun = (id: string): void => {
      refresh({
        predicate: (query) => {
          if (query.meta?.scheduleCardsOf !== id) return false;
          const run = (query.state.data as { run?: { endedAt?: unknown } | null } | undefined)?.run;
          return run != null && run.endedAt == null;
        },
      });
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
    const entitiesFor = (type: string, data: { repoHealth?: unknown } | null | undefined): string[] => {
      if (type === 'task.changed') return ['task'];
      if (type.startsWith('task.')) return ['task']; // incl. task.list.changed
      // A runner's heartbeat saw a workspace's checkout change (counts, branch, state): only the workspace list draws
      // that — the Main checkout bar — so only it and the Main checkout drawer declare `checkout`, and the session
      // lists, which declare `workspace` for the workspace's name, are not read again for it.
      if (type === 'agent.changed' && data?.repoHealth === true) return ['checkout'];
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
      // The owner's terminals: one asked to be approved, a request was decided or collected, or one was revoked
      // (`terminals.changed`). The approve cards and each machine's Terminals both declare `terminal`.
      if (type === 'terminals.changed') return ['terminal'];
      // The owner's drive: a write committed (`drive.changed`, asked for with `hints=drive_changed`). The Files page's
      // reads declare `drive`; the feed's seq it carries is not needed to re-read what is on screen.
      if (type === 'drive.changed') return ['drive'];
      // A request was filed, answered, expired or withdrawn: the open list's nudge (`hints=owner_requests`).
      if (type === 'owner_requests.changed') return ['ownerRequest'];
      // Some sessions' schedule cards moved (`hints=schedule_cards`); which sessions is `pendingCards`.
      if (type === 'schedule_cards.changed') return ['scheduleCard'];
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
    // The sessions the window's session events were about, and whether something named `session` with no one
    // session behind it (refetchEntities).
    const pendingSubjects = new Map<string, SessionSubject>();
    let pendingAnySession = false;
    const pendingFlags = new Set<'openList' | 'watches' | 'counts'>();
    // The workspaces this window's `sessions.list_changed` named, unioned; null once something asked for every Open list.
    let pendingOpenScopes: Set<string> | null = new Set();
    // The window's task changes, and whether a task event said nothing of its rows (refetchEntities' `tasks`); the
    // sessions whose schedule cards the window's events named, and whether one named every session's.
    const pendingTasks: TaskScope = { changes: [], any: false };
    const pendingCards: CardScope = { sessions: new Set(), all: false };
    const pendingSessions = new Set<string>();
    const pendingProjects = new Set<string>();
    const openWindow = (): void => {
      if (refreshTimer) return; // coalesce a burst into one refetch
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        // One scan for the whole burst: a query several of the window's events reach (a session
        // list, on a rename and the event that announces it) is marked once, not once per path.
        refetchEntities(pending, [...pendingSubjects.values()], pendingAnySession, pendingTasks, pendingCards);
        if (pending.has('task')) refetchTaskLists();
        if (pending.has('project')) refetchProjects();
        if (pending.has('watch') || pendingFlags.has('watches')) refetchWatches();
        if (pendingFlags.has('openList')) refetchOpenList(pendingOpenScopes);
        // Decided once the window's events are all in: an approval asked and answered inside it moved nothing.
        if (talliesMoved() || pendingFlags.has('counts')) refetchCounts();
        for (const id of pendingSessions) {
          refetchSessionDetail(id);
          refetchScheduleRun(id);
        }
        for (const id of pendingProjects) refetchCriteriaDecisions(id);
        pending.clear();
        pendingSubjects.clear();
        pendingAnySession = false;
        pendingFlags.clear();
        pendingOpenScopes = new Set();
        pendingTasks.changes = [];
        pendingTasks.any = false;
        pendingCards.sessions.clear();
        pendingCards.all = false;
        pendingSessions.clear();
        pendingProjects.clear();
      }, REFRESH_DEBOUNCE_MS);
    };
    // The task each session runs and its project, as the summaries this connection carried said (a summary always
    // names both; an approval or a background job's event names neither).
    const runs = new Map<string, { taskId: string; projectId: string }>();
    const runOf = (sessionId: string, data: EventData): { taskId: string; projectId: string } => {
      if (data && 'taskId' in data) {
        const projectId = data.projectMembership?.projectId ?? data.projectId;
        const run = {
          taskId: typeof data.taskId === 'string' ? data.taskId : '',
          projectId: typeof projectId === 'string' ? projectId : '',
        };
        runs.set(sessionId, run);
        return run;
      }
      const heard = runs.get(sessionId);
      if (heard) return heard;
      // Never heard of here: what this tab has read of it, in a list or its detail.
      for (const [key, cached] of qc.getQueriesData<unknown>({ predicate: ({ queryKey }) => queryKey[0] === 'sessions' || queryKey[0] === 'project-sessions' || (queryKey[0] === 'session' && queryKey.length === 2) })) {
        const rows = (Array.isArray(cached) ? cached : key[0] === 'session' && cached ? [cached] : []) as {
          id?: unknown; taskId?: unknown; projectId?: unknown; projectMembership?: { projectId?: unknown } | null;
        }[];
        const row = rows.find((candidate) => candidate?.id === sessionId);
        if (!row) continue;
        const projectId = row.projectMembership?.projectId ?? row.projectId;
        return {
          taskId: typeof row.taskId === 'string' ? row.taskId : '',
          projectId: typeof projectId === 'string' ? projectId : '',
        };
      }
      return { taskId: '', projectId: '' };
    };
    const scheduleRefresh = (
      type: string,
      sessionId: string,
      data: EventData,
      workspaceId = '',
    ): void => {
      // The Open list's hint is the one event whose path is not an entity: it says the list may read
      // differently, and is read through its own delta read rather than through the session events
      // that would read every session list for it (sessions.list_changed names no session).
      if (type === 'sessions.list_changed') {
        pendingFlags.add('openList');
        // A hint naming no workspace (an older server's, or one where any list may have moved) reads every list.
        const scopes = (data as { scopes?: unknown } | null | undefined)?.scopes;
        if (Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')) {
          for (const scope of scopes) pendingOpenScopes?.add(scope);
        } else pendingOpenScopes = null;
      }
      if (type === 'task.changed') pendingTasks.changes.push(taskChangeOf(data));
      else if (type.startsWith('task.')) pendingTasks.any = true;
      if (type === 'schedule_cards.changed') {
        const named = idsOrNull((data as { cardSessionIds?: unknown } | null | undefined)?.cardSessionIds);
        if (!named || named.length === 0 || (data as { resync?: unknown } | null | undefined)?.resync === true) pendingCards.all = true;
        else for (const id of named) pendingCards.sessions.add(id);
      }
      for (const entity of entitiesFor(type, data)) {
        pending.add(entity);
        if (entity !== 'session') continue;
        // A session's own event names the session, and the envelope its workspace (`agentId`); the task it runs and
        // its project are the summary's, or what this tab last heard or read of it.
        if (sessionId && (type.startsWith('session.') || type.startsWith('approval.') || type === 'background.task')) {
          const known = pendingSubjects.get(sessionId);
          const run = runOf(sessionId, data);
          const lifecycle = type === 'session.created' || type === 'session.ended';
          pendingSubjects.set(sessionId, {
            id: sessionId,
            workspaceId: workspaceId || known?.workspaceId || '',
            taskId: run.taskId,
            projectId: run.projectId,
            createdOnly: (known?.createdOnly ?? true) && type === 'session.created',
            created: (known?.created ?? false) || type === 'session.created',
            lifecycle: (known?.lifecycle ?? false) || lifecycle,
          });
        } else {
          pendingAnySession = true;
        }
      }
      noteTallies(type, sessionId, data, workspaceId);
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
      pendingAnySession = true;
      // The server's hint for the write joins this read in the window.
      pendingFlags.add('openList');
      pendingOpenScopes = null;
      pendingFlags.add('counts');
      openWindow();
    };
    // What a stream that opened after a gap reads again (W6): every cached read that declares a
    // control-plane entity, a few at a time through `pump`. The per-event paths hold the Open lists
    // to the hint and leave the project page to its floor; a reconnect is not an event and reads
    // once what is on screen, so those cost exclusions do not apply. Four reads stay out — not as a
    // cost exclusion but because another owner reads them: a session's diff and worktree file are
    // the console's own, fetched on a turn end and the costliest reads it makes (see
    // refetchSessionDetail), an answered evidence revision never changes, the lists index keeps
    // its longer floor (refetchTaskLists), and the guest view follows its session over the guest
    // door's own stream (see hasOwnBudget).
    //
    // A browser back online during the gap has already sent this round for the polls it held while
    // offline (React Query resumes them on `online`), so those are not read a second time.
    //
    // Likewise a tab back in view: it has just read what came due while it was hidden (`catchUp`), and the stream
    // that return asked for does not read those a second time. Asked for later, by the backoff, it reads them again.
    const reconcile = (): void => {
      const resumedFrom = Math.min(
        onlineAt > droppedAt ? onlineAt : Infinity,
        Number.isFinite(returnedAt) && returnedAt >= droppedAt ? returnedAt : Infinity,
      );
      answered = (query) => (readStartedAt.get(query.queryHash) ?? -Infinity) >= resumedFrom;
      try {
        refresh({
          predicate: (query) =>
            derivedFrom(query, ENTITIES) &&
            !(query.queryKey[0] === 'session' &&
              (query.queryKey[2] === 'diff' || query.queryKey[2] === 'worktree-file')) &&
            query.queryKey[0] !== 'task-evidence' &&
            query.queryKey[0] !== 'task-lists' &&
            query.queryKey[0] !== 'guest-session',
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
      // What the stream said of each session stops being what the tallies count once events go missing; the
      // reconnect reads them again, and each session is judged against what this tab reads of it from then on.
      tallies.clear();
      processes.clear();
      es?.close();
      setLive(false); // the gated interval polls take back over meanwhile
      streamReport.dropped();
      if (stopped) return;
      const backoff = ++fails > QUICK_RETRIES ? SLOW_RETRY_MS : Math.min(1000 * fails, 15000);
      reconnectTimer = setTimeout(() => connect(), backoff + Math.random() * 500);
    };
    function connect(onReturn = -Infinity): void {
      dropped = false;
      returnedAt = onReturn;
      hinted = false;
      lastMsgAt = Date.now();
      // `list_changed` opts into Open-list hints (§4.8), and `list_scopes` adds their workspace scopes.
      // The other opt-ins enable notifications for owner requests, schedule cards and committed drive writes.
      es = new EventSource(
        `/api/events?access_token=${encodeURIComponent(getToken() ?? '')}&hints=list_changed,owner_requests,schedule_cards,${CONTROL_HINT_LIST_SCOPES},${CONTROL_HINT_DRIVE_CHANGED},${CONTROL_HINT_DRIVE_SYNCS}`,
      );
      es.onopen = () => {
        lastMsgAt = Date.now();
        setLive(true);
        streamReport.opened();
        // No sinceSeq replay — after a gap, read again what is on screen, so changes missed during
        // it surface too. A tab that is hidden reads it when it is back in view (`pump`).
        if (missedEvents) {
          missedEvents = false;
          if (!hidden()) void refreshDriveSyncs();
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
          agentId?: string | null;
          data?: {
            id?: unknown;
            projectMembership?: { projectId?: unknown } | null;
            taskId?: unknown;
            taskIds?: unknown;
            resync?: unknown;
            repoHealth?: unknown;
            agentId?: unknown;
            clone?: unknown;
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
        // An agent's directory sync moved (`hints=drive_syncs`): the Drive tray reads its list again.
        if (ev.type === 'drive.sync' && !hidden()) void refreshDriveSyncs();
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
            // A coordinator, or a waiting member, the placement holds: its project's row is placed by it.
            for (const [, placed] of qc.getQueriesData<readonly ProjectPlacement[]>({ queryKey: ['project-placement'] })) {
              for (const answer of placed ?? []) {
                if (answer.coordinator?.id === sessionId || answer.waiting.some((row) => row.id === sessionId)) {
                  schedulePlacement(answer.projectId);
                }
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
        if (ev.type === 'task.changed') {
          const change = taskChangeOf(ev.data);
          refetchProjectPages('', ['task'], change.resync ? null : idsOrNull((ev.data as { rowProjectIds?: unknown } | null | undefined)?.rowProjectIds));
        }
        // The translator was skipped or is in use again (MeTranslation.translationUnavailableUntil): the composer's
        // tag reads /users/me.
        if (ev.type === 'translation.status_changed') void qc.invalidateQueries({ queryKey: ['user', 'me'], exact: true });
        // The session an event is about: the envelope's, or a session event's own id from a peer
        // that leaves the envelope's empty. An approval's id is the approval's.
        const subject = ev.sessionId || (ev.type.startsWith('session.') && typeof id === 'string' ? id : '');
        // A GitHub workspace's clone (docs/github-workspace-design.md §5.4): git's percentage is drawn from what is
        // heard here and read from nothing else, so a percentage alone reads nothing again. A state that moved is what
        // the server stored: the lists (a session's queued reason) and the open details of that workspace's sessions.
        const cloned = cloneEventOf(ev.type, ev.data);
        if (cloned) {
          if (!hearClone(cloned.workspaceId, cloned.clone)) return;
          void qc.invalidateQueries({
            predicate: ({ queryKey, state }) =>
              queryKey[0] === 'session' &&
              queryKey.length === 2 &&
              sameWorkspace((state.data as { workspace?: { id?: string } | null } | undefined)?.workspace?.id, cloned.workspaceId),
          });
        }
        // The session's workspace: the envelope's `agentId`, or the summary's own from a peer that leaves it empty.
        const workspaceOf = typeof ev.agentId === 'string' && ev.agentId
          ? ev.agentId
          : typeof ev.data?.agentId === 'string' ? ev.data.agentId : '';
        scheduleRefresh(ev.type, subject, ev.data, workspaceOf);
      };
      es.onerror = () => drop();
    }
    connect();
    // A tab coming back into view, or a browser back online, need not wait out the backoff: ask for
    // the stream at once. Nothing to do while one is open or opening.
    const retryNow = (onReturn?: number): void => {
      if (stopped || !dropped || document.visibilityState === 'hidden') return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      connect(onReturn);
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
    //
    // A tab the browser froze in the background runs no timer, the watchdog's included: a stream that died meanwhile
    // may have said nothing, and would pass for live until the watchdog's next tick. One silent past the watchdog's
    // limit is dropped here, before anything reads, so the reads go by the outage's budget and the stream is asked
    // for at once. With the stream down, the return's read is the outage's quick first look, and the polls keep its
    // slowest pace from here (listBudget `returned`).
    const onVisibility = (): void => {
      if (stopped || hidden()) return;
      const now = Date.now();
      if (!dropped && now - lastMsgAt > WATCHDOG_SILENCE_MS) drop();
      if (dropped) streamReport.returned(now);
      catchUp();
      retryNow(now);
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
      if (placementTimer) clearTimeout(placementTimer);
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
