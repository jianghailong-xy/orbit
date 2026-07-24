import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getToken } from '../api';

// Coalesce a burst of control events (a turn end fires status + approval back-to-back) into a
// single snapshot refetch — mirrors the iOS/macOS 200ms window, a touch longer here since the web
// list payload is larger, so batching a few more events per refetch is worth the small latency.
const REFRESH_DEBOUNCE_MS = 500;
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
    let stopped = false;
    let dropped = false;
    let fails = 0;
    let lastMsgAt = Date.now();

    const refetchSessions = (): void => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    };
    // The task list/board queries: main list & sidebar count (['tasks']), the single-list view
    // (['task-list', id]), the sidebar lists (['task-lists']), and an open detail (['task', id]).
    // Refetched only on a `task.*` event (or on reconnect), so an unrelated session event doesn't
    // needlessly refetch them. This is what makes MCP-created/updated tasks appear without a
    // manual page refresh; before, tasks had no push path and rode a 5–15s poll only.
    const refetchTasks = (): void => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['task-list'] });
      void qc.invalidateQueries({ queryKey: ['task-lists'] });
      void qc.invalidateQueries({ queryKey: ['task'] });
    };
    let pendingSessions = false;
    let pendingTasks = false;
    const scheduleRefresh = (type: string): void => {
      if (type.startsWith('task.')) pendingTasks = true;
      else pendingSessions = true;
      if (refreshTimer) return; // coalesce a burst into one refetch
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (pendingSessions) {
          pendingSessions = false;
          refetchSessions();
        }
        if (pendingTasks) {
          pendingTasks = false;
          refetchTasks();
        }
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
        // No sinceSeq replay — reconcile both lists with a fresh snapshot on (re)connect so
        // task changes missed during the gap surface too.
        refetchSessions();
        refetchTasks();
      };
      es.onmessage = (e) => {
        lastMsgAt = Date.now();
        let ev: { type?: string; sessionId?: string };
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        // Drop the keepalive ping and any frame without a sessionId (matches the native decode).
        if (!ev || ev.type === 'ping' || !ev.sessionId) return;
        scheduleRefresh(ev.type ?? '');
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
      es?.close();
    };
  }, [qc]);
  return <ControlPlaneLiveContext.Provider value={live}>{children}</ControlPlaneLiveContext.Provider>;
}
