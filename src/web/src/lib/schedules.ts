import { useMemo } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  scheduleNeedsCount,
  type ScheduleCard,
  type ScheduleChangeConversationResponse,
  type ScheduleChangeRecord,
  type ScheduleDetailResponse,
  type ScheduleDraftsResponse,
  type ScheduleListResponse,
  type ScheduleRunView,
  type SessionScheduleCardsResponse,
} from '@orbit/shared';
import { api } from '../api';
import { streamPoll } from './listBudget';
import type { SessionReach, SessionReachDeclaration } from './sessionReach';

/** The sessions a sentence on the Scheduled page opened, whose agent's card the drafts list waits for. */
const draftsAwaited = new Set<string>();
/** The Scheduled page sent a sentence: the session it opened is one the drafts list follows. */
export const awaitDraftFrom = (sessionId: string): void => {
  draftsAwaited.add(sessionId);
};

/**
 * Scheduled tasks on the web (docs/scheduled-tasks-design.md §9.2): the REST reads the Scheduled page, the inspector,
 * a conversation's cards and Waiting on you draw from. Every word and display rule is W0's (`@orbit/shared`
 * schedule.ts); this file only fetches.
 */

/** The viewer's IANA zone: the timeline is drawn in it, and Create on a card that names none sends it. */
export function viewerTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** "09:00" in a zone, 24-hour: a row's time column. */
export function scheduleClock(at: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .formatToParts(typeof at === 'string' ? new Date(at) : at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`;
}

/** `GET /api/schedules`: the schedules that have not ended, or with `state: 'all'` every one. */
export const schedulesQuery = (workspaceId?: string | null, state?: 'all') =>
  queryOptions({
    queryKey: ['schedules', 'list', workspaceId ?? 'any', state ?? 'open'] as const,
    // Owner-wide: no one session's event moves it (lib/sessionReach). Its own poll is its safety read.
    meta: { entities: ['session', 'workspace'], sessionReach: 'none' satisfies SessionReach },
    queryFn: () => {
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspaceId', workspaceId);
      if (state) params.set('state', state);
      const query = params.toString();
      return api<ScheduleListResponse>(`/schedules${query ? `?${query}` : ''}`);
    },
    refetchInterval: streamPoll(30_000),
  });

export const scheduleDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ['schedules', 'detail', id] as const,
    // Its runs are scheduled runs of its workspace (lib/sessionReach), and its cards the asking sessions'.
    meta: {
      entities: ['session', 'workspace'],
      sessionReach: ((data: unknown) => {
        const detail = data as ScheduleDetailResponse | undefined;
        if (!detail) return { sessions: [] };
        return {
          scheduledRuns: detail.schedule.workspaceId,
          holds: [detail.lastRun, ...detail.recentRuns].map((run) => run?.sessionId ?? '')
            .concat(detail.pendingCards.map((card) => card.askedBySessionId ?? ''))
            .filter(Boolean),
        };
      }) satisfies SessionReachDeclaration,
    },
    queryFn: () => api<ScheduleDetailResponse>(`/schedules/${encodeURIComponent(id)}`),
    refetchInterval: streamPoll(30_000),
  });

export const scheduleDraftsQuery = () =>
  queryOptions({
    queryKey: ['schedules', 'drafts'] as const,
    // A draft comes from a session's agent: the sessions its cards were asked by, and the ones this tab is waiting on
    // for a card (awaitDraftFrom), are the ones whose events can move it (lib/sessionReach).
    meta: {
      entities: ['session'],
      sessionReach: ((data: unknown) => ({
        sessions: [
          ...((data as ScheduleDraftsResponse | undefined)?.drafts ?? []).map((card) => card.askedBySessionId ?? ''),
          ...draftsAwaited,
        ].filter(Boolean),
      })) satisfies SessionReachDeclaration,
    },
    queryFn: () => api<ScheduleDraftsResponse>('/schedules/drafts'),
    refetchInterval: streamPoll(15_000),
  });

export const scheduleRequestQuery = (id: string) =>
  queryOptions({
    queryKey: ['schedules', 'request', id] as const,
    // The asking session's events are the ones that can move it (lib/sessionReach).
    meta: {
      entities: ['session'],
      sessionReach: ((data: unknown) => {
        const asker = (data as ScheduleCard | undefined)?.askedBySessionId;
        return asker ? { session: asker } : 'none';
      }) satisfies SessionReachDeclaration,
    },
    queryFn: () => api<ScheduleCard>(`/schedule-requests/${encodeURIComponent(id)}`),
  });

/**
 * What one session put up (§9.2): its cards, its change records, and the run it serves. Read on the events that can
 * move it and otherwise only on the safety read: `schedule_cards.changed` naming the session (a card put up or
 * decided, a change recorded or undone, a schedule its cards name edited), and, for a scheduled run's session while its
 * run is open, that session's own `session.*` events, which move the run (useControlPlane). Its approvals, background
 * jobs and every other session event say nothing of its cards. The session page reads it once
 * (ScheduleCards `useSessionScheduleCards`) for everything it draws.
 */
export const sessionScheduleCardsQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ['schedules', 'session', sessionId] as const,
    meta: { entities: ['scheduleCard'], scheduleCardsOf: sessionId },
    queryFn: () => api<SessionScheduleCardsResponse>(`/sessions/${encodeURIComponent(sessionId)}/schedule-cards`),
    refetchInterval: streamPoll(20_000),
  });

/** The count beside Scheduled in the drawer, as on Apple and Android: scheduleNeedsCount. */
export function useScheduledNeedsCount(): number {
  const list = useQuery(schedulesQuery());
  return useMemo(() => scheduleNeedsCount(list.data), [list.data]);
}

/**
 * A run's session, reached from the schedule's history: the ordinary session page. Its workspace's list goes to
 * the Scheduled runs folder, the one list that holds it (owner 2026-11-19), from the run's own session, not the
 * address (owner 2026-11-25).
 */
export function scheduleRunSessionPath(run: Pick<ScheduleRunView, 'sessionId'>): string | null {
  if (!run.sessionId) return null;
  return `/sessions/${encodeURIComponent(run.sessionId)}`;
}

/** The Scheduled page with one schedule open in the inspector. */
export function schedulePath(scheduleId: string): string {
  return `/scheduled?id=${encodeURIComponent(scheduleId)}`;
}

/** A schedule's change conversation (§8.2): the draft page, which goes on to the open one when there is one. */
export function scheduleChangePath(scheduleId: string): string {
  return `/scheduled/${encodeURIComponent(scheduleId)}/change`;
}

export const scheduleChangeQuery = (id: string) =>
  queryOptions({
    queryKey: ['schedules', 'change', id] as const,
    meta: { entities: ['session'] },
    queryFn: () => api<ScheduleChangeConversationResponse>(`/schedules/${encodeURIComponent(id)}/change`),
  });

/** Opens the change conversation with the person's first words (or says them in the one already open). */
export function openScheduleChange(id: string, text: string) {
  return api<{ sessionId: string; created: boolean }>(`/schedules/${encodeURIComponent(id)}/change`, {
    method: 'POST',
    body: { text },
  });
}

/** Undo a recorded change through the door the record names. */
export function undoScheduleRecord(record: Pick<ScheduleChangeRecord, 'undo' | 'scheduleId' | 'revision'>) {
  const door = record.undo;
  return api(door?.path ?? `/schedules/${encodeURIComponent(record.scheduleId)}/undo`, {
    method: 'POST',
    body: door?.body ?? { revision: record.revision },
  });
}

/** Whether a record can still be undone: it has a door, and nothing undid it yet. */
export function scheduleRecordUndoable(record: Pick<ScheduleChangeRecord, 'undo' | 'undoneByRevision' | 'undoOfRevision'>): boolean {
  return record.undo !== null && record.undoneByRevision === null && record.undoOfRevision === null;
}
