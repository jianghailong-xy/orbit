import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getToken } from '../api';

// Coalesce a burst of control events (a turn end fires status + approval back-to-back) into a
// single snapshot refetch — mirrors the iOS/macOS 200ms window, a touch longer here since the web
// list payload is larger, so batching a few more events per refetch is worth the small latency.
const REFRESH_DEBOUNCE_MS = 500;
// `['task-lists']` gets a slower floor of its own. The debounce above is a *trailing* window, so a
// steady stream of task events never lets it close: a run writing tasks in bulk (a DAG being laid
// down, a sweep dispatching a large list) holds it open and pins every query in the group at 2 Hz.
// That is affordable for the task rows on screen and not for the list index, which is a per-list
// aggregate over every task the owner has — six figures of rows on a large account, counted afresh
// per request. What it feeds is a badge and a coloured dot, and TasksSidePanel's own refetchInterval
// already declares 5s of staleness acceptable there, so refetching it faster than that is strictly
// more work than the poll this stream replaced.
const LISTS_MIN_INTERVAL_MS = 5_000;
// The server pings ~every 20s (EventsController keepalive); 45s of total silence means the socket
// went half-dead without firing onerror. EventSource has no read timeout, so we watch for it.
const WATCHDOG_SILENCE_MS = 45_000;
const WATCHDOG_TICK_MS = 15_000;
const MAX_FAILS = 20;

const ControlPlaneLiveContext = createContext(false);

/** True while the user-scoped control-plane SSE (`GET /api/events`) is connected. The session-list
 *  queries gate their interval polling on it: push keeps the lists fresh while the stream is live,
 *  and the poll resumes automatically on any gap (so an old server without the stream still works). */
export const useControlPlaneLive = (): boolean => useContext(ControlPlaneLiveContext);

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
  useEffect(() => {
    if (!getToken()) return;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let listsTimer: ReturnType<typeof setTimeout> | undefined;
    let listsRefetchedAt = 0;
    let stopped = false;
    let dropped = false;
    let fails = 0;
    let lastMsgAt = Date.now();

    const refetchSessions = (): void => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      // The sidebar's per-workspace tallies are derived from the same rows, but keyed apart so the
      // list's optimistic edits can't touch them — so they need their own invalidation here.
      void qc.invalidateQueries({ queryKey: ['session-counts'] });
    };
    // The sidebar's list index, rate-limited to one refetch per LISTS_MIN_INTERVAL_MS. Leading —
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
        void qc.invalidateQueries({ queryKey: ['task-lists'] });
      }, wait);
    };
    // The task list/board queries: every paged view — all tasks, one list, the unlisted bucket —
    // plus the sidebar count (['tasks']), the sidebar lists (['task-lists']), and an open detail
    // (['task', id]). Refetched only on a `task.*` event (or on reconnect), so an unrelated
    // session event doesn't needlessly refetch them. This is what makes MCP-created/updated tasks
    // appear without a manual page refresh; before, tasks had no push path and rode a 5–15s poll only.
    const refetchTasks = (): void => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      refetchTaskLists();
      void qc.invalidateQueries({ queryKey: ['task'] });
    };
    // The workspace list (sidebar, pickers, workspace page). Like the task queries it only refetches on an
    // `workspace.*` event or on reconnect — it has no interval poll at all, so before this a workspace
    // created/updated through MCP (workspace_create/workspace_update) only appeared after a page reload.
    const refetchWorkspaces = (): void => {
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    };
    // The owner's tag library and the deployment's provider catalog: both are edited elsewhere
    // (tags on the native clients, providers in the admin area) and neither polls, so push is the
    // only way another client's edit reaches this tab.
    const refetchTags = (): void => {
      void qc.invalidateQueries({ queryKey: ['session-tags'] });
    };
    const refetchProviders = (): void => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
    };
    // The two reads a decision card is drawn from, which none of the list refetches above reach.
    // Evidence being submitted or decided arrives as `task.changed`, and its read is keyed by the
    // session DECIDING rather than by the task, so every session's copy is dirty. A held criteria
    // proposal being filed or decided arrives as its own event naming the project; an event that
    // names none dirties every project's copy.
    const refetchPendingDecisions = (): void => {
      void qc.invalidateQueries({
        predicate: ({ queryKey }) => queryKey[0] === 'session' && queryKey[2] === 'pending-decisions',
      });
    };
    const refetchCriteriaDecisions = (projectId: string): void => {
      void qc.invalidateQueries({
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
      void qc.invalidateQueries({ queryKey: ['session', id], exact: true });
    };
    const REFETCH: Record<string, () => void> = {
      sessions: refetchSessions,
      tasks: refetchTasks,
      workspaces: refetchWorkspaces,
      tags: refetchTags,
      providers: refetchProviders,
      decisions: refetchPendingDecisions,
    };
    // Which cache groups an event dirties. An event is only ever a nudge to refetch (never a
    // delta), so this is a plain type-prefix → group map. Note the pairs: a workspace rename and a
    // tag recolor both change what the SESSION list rows render, so they refresh that too — and a
    // held criteria proposal keeps the default for the same reason, since its coordinator's row
    // counts it in pendingApprovals.
    const groupsFor = (type: string): string[] => {
      if (type === 'task.changed') return ['tasks', 'decisions'];
      if (type.startsWith('task.')) return ['tasks']; // incl. task.list.changed
      if (type.startsWith('workspace.')) return ['workspaces', 'sessions'];
      if (type.startsWith('tag.')) return ['tags', 'sessions'];
      if (type.startsWith('provider.')) return ['providers'];
      return ['sessions'];
    };
    const pending = new Set<string>();
    const pendingSessions = new Set<string>();
    const pendingProjects = new Set<string>();
    const scheduleRefresh = (type: string, sessionId?: string, id?: string): void => {
      for (const g of groupsFor(type)) pending.add(g);
      // Only the `session.*` family: those are the events that can move a session's run state,
      // and so the ones a frozen detail has to be corrected by. An approval or a background task
      // reaches the open console through its own transcript stream, and a task/tag/provider edit
      // says nothing about any session's state.
      if (sessionId && type.startsWith('session.')) pendingSessions.add(sessionId);
      // '' when the event names no project, which refetchCriteriaDecisions reads as every project.
      if (type === 'project.criteria_decisions.changed') pendingProjects.add(id ?? '');
      if (refreshTimer) return; // coalesce a burst into one refetch
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        for (const g of pending) REFETCH[g]?.();
        for (const id of pendingSessions) refetchSessionDetail(id);
        for (const id of pendingProjects) refetchCriteriaDecisions(id);
        pending.clear();
        pendingSessions.clear();
        pendingProjects.clear();
      }, REFRESH_DEBOUNCE_MS);
    };
    // Close the stream and schedule a backoff reconnect. Guarded by `dropped` so it fires once per
    // connection — onerror can fire repeatedly, and the watchdog can race it.
    const drop = (): void => {
      if (dropped) return;
      dropped = true;
      es?.close();
      setLive(false); // the gated interval polls take back over meanwhile
      if (stopped || ++fails > MAX_FAILS) return;
      reconnectTimer = setTimeout(connect, Math.min(1000 * fails, 15000) + Math.random() * 500);
    };
    function connect(): void {
      dropped = false;
      lastMsgAt = Date.now();
      es = new EventSource(`/api/events?access_token=${encodeURIComponent(getToken() ?? '')}`);
      es.onopen = () => {
        fails = 0;
        lastMsgAt = Date.now();
        setLive(true);
        // No sinceSeq replay — reconcile every list with a fresh snapshot on (re)connect so
        // changes missed during the gap surface too. Any open session detail with it: the gap
        // could have swallowed exactly the revive this tab needs to stop drawing a session as
        // ended (see refetchSessionDetail). Prefix key, so a session id isn't needed here.
        for (const refetch of Object.values(REFETCH)) refetch();
        void qc.invalidateQueries({ queryKey: ['session'] });
        // Keyed under ['project'], so the prefix above misses it: a proposal filed or decided
        // during the gap would otherwise wait out its poll.
        refetchCriteriaDecisions('');
      };
      es.onmessage = (e) => {
        lastMsgAt = Date.now();
        let ev: { type?: string; sessionId?: string; data?: { id?: unknown } | null };
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        // Dispatch on `type`: the keepalive ping is the only frame to drop. `sessionId` rides
        // along as an optional extra rather than a requirement, because the user-scoped library
        // events (tag/provider/task-list) legitimately carry none.
        if (!ev?.type || ev.type === 'ping') return;
        const id = ev.data?.id;
        scheduleRefresh(ev.type, ev.sessionId, typeof id === 'string' ? id : undefined);
      };
      es.onerror = () => drop();
    }
    connect();
    const watchdog = setInterval(() => {
      if (!stopped && Date.now() - lastMsgAt > WATCHDOG_SILENCE_MS) drop();
    }, WATCHDOG_TICK_MS);
    return () => {
      stopped = true;
      clearInterval(watchdog);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (listsTimer) clearTimeout(listsTimer);
      es?.close();
    };
  }, [qc]);
  return <ControlPlaneLiveContext.Provider value={live}>{children}</ControlPlaneLiveContext.Provider>;
}
