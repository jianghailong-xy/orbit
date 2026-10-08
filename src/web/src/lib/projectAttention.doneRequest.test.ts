import { describe, expect, it } from 'vitest';
import type { OwnerItemKind } from '@orbit/shared';
import {
  READY_TO_CLOSE_SAYS,
  attentionChipOf,
  attentionReasonOf,
  attentionSectionOf,
  orderWithinSection,
  projectNeedsYouCount,
  sidebarProjects,
  type AttentionProject,
  type ProjectAttentionSummary,
  type SidebarProject,
} from './projectAttention';

/**
 * A coordinator asking its owner to record the project done (`attention.doneRequest`, served by
 * `GET /projects` and `/projects/sidebar`): its own owner reason, `done-request` — not the
 * task-tally heuristic `ready-to-close` — counted, ordered and timed the way the start request is.
 */

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();

const ownerItem = (kind: OwnerItemKind, count: number, waitedMs: number) => ({
  kind,
  count,
  oldestWaitingSince: at(waitedMs),
});

function attention(over: Partial<ProjectAttentionSummary> = {}): ProjectAttentionSummary {
  return {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
    ownerItems: [],
    coordinatorItems: null,
    ...over,
  };
}

let nextId = 0;
function project(over: Partial<AttentionProject> & { buckets?: Partial<AttentionProject['buckets']> } = {}): AttentionProject {
  nextId += 1;
  const buckets = { running: 0, ready: 0, blocked: 0, done: 0, cancelled: 0, ...(over.buckets ?? {}) };
  const tasks = Object.values(buckets).reduce((sum, n) => sum + n, 0);
  return {
    id: `0195c0de-0000-7000-8000-${String(nextId).padStart(12, '0')}`,
    title: `Project ${nextId}`,
    status: 'OPEN',
    createdAt: '2026-01-01T00:00:00.000Z',
    _count: { tasks },
    lastActivityAt: tasks > 0 ? at(HOUR) : null,
    ...over,
    buckets,
  };
}

const asking = (waitedMs: number, over: Partial<ProjectAttentionSummary> = {}) =>
  attention({ doneRequest: { waitingSince: at(waitedMs) }, ...over });

describe('a coordinator asking to record the project done', () => {
  it('is its own owner reason, Needs you · Ready to close with how long it has waited', () => {
    const asked = project({ buckets: { done: 4 }, attention: asking(25 * MINUTE) });

    expect(READY_TO_CLOSE_SAYS).toBe('Needs you · Ready to close');
    expect(attentionReasonOf(asked, NOW)).toBe('done-request');
    expect(attentionSectionOf(asked, NOW)).toBe('attention');
    expect(attentionChipOf(asked, NOW)).toEqual({ tone: 'warning', text: 'Needs you · Ready to close · 25m' });
  });

  it('outranks running work, as the other owner reasons do', () => {
    const busy = project({ buckets: { running: 2 }, lastActivityAt: at(MINUTE), attention: asking(5 * MINUTE) });
    expect(attentionReasonOf(busy, NOW)).toBe('done-request');
    expect(attentionSectionOf(busy, NOW)).toBe('attention');
  });

  it('leaves the all-settled heuristic as it was when nobody asked', () => {
    const settled = project({ buckets: { done: 3 }, attention: attention({ doneRequest: null }) });
    expect(attentionReasonOf(settled, NOW)).toBe('ready-to-close');
    expect(attentionChipOf(settled, NOW)?.text).toBe('3/3 tasks settled · project still open');
  });

  it('asks nothing of a closed project', () => {
    const closed = project({ status: 'DONE', buckets: { done: 3 }, attention: asking(HOUR) });
    expect(attentionReasonOf(closed, NOW)).toBeNull();
    expect(attentionSectionOf(closed, NOW)).toBe('completed');
  });

  it('is named over another owner reason only when it has waited longer', () => {
    const olderDone = project({
      attention: asking(3 * HOUR, { ownerItems: [ownerItem('COORDINATOR_QUESTION', 1, 35 * MINUTE)] }),
    });
    const olderQuestion = project({
      attention: asking(10 * MINUTE, { ownerItems: [ownerItem('COORDINATOR_QUESTION', 1, 35 * MINUTE)] }),
    });
    const olderStart = project({
      attention: asking(10 * MINUTE, { startRequest: { waitingSince: at(HOUR) } }),
    });

    expect(attentionChipOf(olderDone, NOW)?.text).toBe('Needs you · Ready to close · 3h');
    expect(attentionChipOf(olderQuestion, NOW)?.text).toBe('Needs you · 1 question from coordinator · 35m');
    expect(attentionChipOf(olderStart, NOW)?.text).toBe('Needs you · Ready to start · 1h');
  });

  it('sits in the owner tier by its wait, above a user blocker and the settled heuristic', () => {
    const blocker = project({
      title: 'Blocker',
      attention: attention({ userBlockers: 1, maxSeverity: 'CRITICAL', attentionSinceAt: at(9 * 24 * HOUR) }),
    });
    const merge = project({ title: 'Merge', attention: attention({ ownerItems: [ownerItem('PROMOTION_APPROVAL', 1, 2 * HOUR)] }) });
    const close = project({ title: 'Close', buckets: { done: 2 }, attention: asking(35 * MINUTE) });
    const paused = project({ title: 'Paused', attention: attention({ ownerItems: [ownerItem('FUSE_PAUSED', 1, 20 * MINUTE)] }) });
    const settled = project({ title: 'Settled', buckets: { done: 1 } });

    expect(
      orderWithinSection('attention', [settled, blocker, paused, close, merge], NOW).map((row) => row.title),
    ).toEqual(['Merge', 'Close', 'Paused', 'Blocker', 'Settled']);
  });
});

describe('the sidebar counts a done request', () => {
  let n = 0;
  const row = (over: Partial<SidebarProject> = {}): SidebarProject => {
    n += 1;
    return {
      id: `0195c0de-0000-7000-8000-9${String(n).padStart(11, '0')}`,
      title: `Project ${n}`,
      status: 'OPEN',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: at(HOUR),
      buckets: { running: 0 },
      attention: { ownerItems: [] },
      ...over,
    };
  };

  it('as one more thing waiting on you, ordered by its wait', () => {
    const close = row({ title: 'Close', attention: { ownerItems: [], doneRequest: { waitingSince: at(2 * HOUR) } } });
    const merge = row({ title: 'Merge', attention: { ownerItems: [ownerItem('PROMOTION_APPROVAL', 1, HOUR)] } });
    const both = row({
      title: 'Both',
      attention: {
        ownerItems: [ownerItem('COORDINATOR_QUESTION', 1, MINUTE)],
        doneRequest: { waitingSince: at(3 * HOUR) },
      },
    });
    const recent = row({ title: 'Recent', buckets: { running: 1 }, lastActivityAt: at(MINUTE) });

    expect(projectNeedsYouCount(close)).toBe(1);
    expect(projectNeedsYouCount(both)).toBe(2);
    // The oldest wait is the done request's own, not the question's.
    expect(sidebarProjects([recent, merge, close, both]).map((p) => p.title)).toEqual([
      'Both',
      'Close',
      'Merge',
      'Recent',
    ]);
    expect(projectNeedsYouCount(row({ status: 'DONE', attention: { ownerItems: [], doneRequest: { waitingSince: at(HOUR) } } }))).toBe(0);
  });
});
