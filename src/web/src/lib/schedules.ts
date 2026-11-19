import { useMemo } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  scheduleNeedsYou,
  type ScheduleCard,
  type ScheduleChangeRecord,
  type ScheduleDetailResponse,
  type ScheduleDraftsResponse,
  type ScheduleListResponse,
  type ScheduleRunView,
  type SessionScheduleCardsResponse,
} from '@orbit/shared';
import { api } from '../api';
import { streamPoll } from './listBudget';
import { SCHEDULED_RUNS_FOLDER } from './sessionFolders';

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
    meta: { entities: ['session', 'workspace'] },
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
    meta: { entities: ['session', 'workspace'] },
    queryFn: () => api<ScheduleDetailResponse>(`/schedules/${encodeURIComponent(id)}`),
    refetchInterval: streamPoll(30_000),
  });

export const scheduleDraftsQuery = () =>
  queryOptions({
    queryKey: ['schedules', 'drafts'] as const,
    meta: { entities: ['session'] },
    queryFn: () => api<ScheduleDraftsResponse>('/schedules/drafts'),
    refetchInterval: streamPoll(15_000),
  });

export const scheduleRequestQuery = (id: string) =>
  queryOptions({
    queryKey: ['schedules', 'request', id] as const,
    meta: { entities: ['session'] },
    queryFn: () => api<ScheduleCard>(`/schedule-requests/${encodeURIComponent(id)}`),
  });

export const sessionScheduleCardsQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ['schedules', 'session', sessionId] as const,
    meta: { entities: ['session'] },
    queryFn: () => api<SessionScheduleCardsResponse>(`/sessions/${encodeURIComponent(sessionId)}/schedule-cards`),
    refetchInterval: streamPoll(20_000),
  });

/** The count beside Scheduled in the drawer: the held, and the failing with no run under way (§9.2). */
export function useScheduledNeedsCount(): number {
  const list = useQuery(schedulesQuery());
  return useMemo(() => {
    const runs = list.data?.runs ?? [];
    return (list.data?.schedules ?? []).filter((s) => scheduleNeedsYou(s, runs)).length;
  }, [list.data]);
}

/**
 * A run's session, reached from the schedule's history: the ordinary session page, with its workspace's list on the
 * Scheduled runs folder, the one list that holds it (owner 2026-11-19).
 */
export function scheduleRunSessionPath(run: Pick<ScheduleRunView, 'sessionId'>): string | null {
  if (!run.sessionId) return null;
  return `/sessions/${encodeURIComponent(run.sessionId)}?folder=${SCHEDULED_RUNS_FOLDER}`;
}

/** The Scheduled page with one schedule open in the inspector. */
export function schedulePath(scheduleId: string): string {
  return `/scheduled?id=${encodeURIComponent(scheduleId)}`;
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
