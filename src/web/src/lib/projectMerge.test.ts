import { describe, expect, it } from 'vitest';
import type {
  IntegrationQueueJob,
  IntegrationQueueView,
  ProjectPromotionView,
} from '@orbit/shared';
import {
  NO_LONGER_ON_OFFER,
  isMergeJob,
  mergeCardShape,
  moreTasks,
  projectTimelineSections,
  promotionBlockedLine,
  promotionBlockedReason,
  promotionBranchLine,
  promotionChecksSummary,
  promotionMergingStatus,
  promotionChangesLine,
  promotionEventLine,
  promotionPageCounts,
  promotionPageTitle,
  promotionReceiptLine,
  promotionTaskTitles,
  promotionTimelineDetail,
  promotionTimelineTitle,
  queueJobSpan,
  queueJobStaleClause,
  queueJobStatus,
  queueJobTitle,
  queuePositionLine,
  queueSummaryLine,
  queueTitle,
  queueWaitLine,
} from './projectMerge';

function candidate(overrides: Partial<ProjectPromotionView> = {}): ProjectPromotionView {
  return {
    promotionId: 'pr-1',
    state: 'READY',
    sourceKind: 'PROJECT_BRANCH',
    sourceRef: 'refs/heads/project/34ZurCP3bv9yLXGVyUGnx',
    sourceSha: '5e5bfca23aa1',
    upstreamRef: 'refs/heads/main',
    commitsAhead: 5,
    filesChanged: 10,
    tasks: [
      { taskId: 't1', title: '修复 D1' },
      { taskId: 't2', title: '日志默认关闭' },
    ],
    taskIds: ['t1', 't2'],
    checks: [],
    conflicts: [],
    upstreamShaChecked: null,
    landsTreeSha: null,
    landsAs: 'MERGE_COMMIT',
    askedAt: '2026-10-06T03:31:00Z',
    upstream: { syncedAt: null, conflicts: false },
    recheckedAt: null,
    recheck: null,
    merged: null,
    decidedAt: null,
    ...overrides,
  } as ProjectPromotionView;
}

const merged = (id: string, at: string, automatic = false): ProjectPromotionView =>
  candidate({
    promotionId: id,
    state: 'MERGED',
    merged: { sha: '8d5a868e90df', byUserId: automatic ? null : 'u', at, automatic, revert: null },
  });

describe('the merge card on the project sessions view', () => {
  it('takes the candidate’s state, and the merge check’s line before there is one', () => {
    expect(mergeCardShape(candidate(), null)).toBe('asking');
    expect(mergeCardShape(candidate({ state: 'CONFIRMED' }), null)).toBe('merging');
    expect(mergeCardShape(candidate({ state: 'RECHECKING' }), null)).toBe('merging');
    expect(mergeCardShape(candidate({ state: 'BLOCKED', conflicts: ['a.go'] }), null)).toBe('blocked');
    expect(mergeCardShape(candidate({ state: 'CHECKING' }), { kind: 'CHECK_PROMOTION' })).toBe('checking');
    expect(mergeCardShape(null, { kind: 'CHECK_PROMOTION' })).toBe('checking');
    expect(mergeCardShape(null, { kind: 'LAND_TASK' })).toBeNull();
    expect(mergeCardShape(merged('m', '2026-10-06T03:42:00Z'), null)).toBeNull();
    expect(mergeCardShape(candidate({ state: 'DECLINED' }), null)).toBeNull();
    expect(isMergeJob({ kind: 'LAND_PROMOTION' })).toBe(true);
    expect(isMergeJob({})).toBe(false);
  });

  it('says what is asked of main, with the branch under it', () => {
    expect(promotionPageTitle(candidate())).toBe('Merge into main?');
    expect(promotionPageTitle(candidate({ state: 'CONFIRMED', execution: { state: 'QUEUED', phase: null, startedAt: 'x' } })))
      .toBe('Merge into main queued');
    expect(promotionPageTitle(candidate({ state: 'CONFIRMED' }))).toBe('Merge into main confirmed');
    expect(promotionPageTitle(candidate({ state: 'RECHECKING', execution: { state: 'RUNNING', phase: 'CHECK', startedAt: 'x' } })))
      .toBe('Re-checking before merging into main…');
    expect(promotionPageTitle(candidate({ state: 'CONFIRMED', execution: { state: 'RUNNING', phase: 'PUSH', startedAt: 'x' } })))
      .toBe('Merging into main…');
    expect(promotionPageTitle(candidate({ state: 'BLOCKED' }))).toBe('Can’t merge into main yet');
    expect(promotionPageCounts(candidate())).toBe('2 tasks · 10 files');
    expect(promotionPageCounts(candidate({ taskIds: ['t1'], filesChanged: 1 }))).toBe('1 task · 1 file');
    expect(promotionPageCounts(candidate({ filesChanged: null }))).toBe('2 tasks');
  });

  it('names the tasks it carries and counts the rest', () => {
    const five = candidate({
      taskIds: ['t1', 't2', 't3', 't4', 't5'],
      tasks: ['a', 'b', 'c', 'd', 'e'].map((title, index) => ({ taskId: `t${index + 1}`, title })),
    });
    expect(promotionTaskTitles(five)).toEqual({ shown: ['a', 'b', 'c'], more: 2 });
    expect(moreTasks(2)).toBe('+2 more');
    expect(moreTasks(0)).toBeNull();
  });
});

describe('the page card’s lines', () => {
  it('says the branch, the proof and the block in the native card’s words', () => {
    expect(promotionBranchLine(candidate())).toBe('project/34ZurCP3bv9yLXGVyUGnx · 5 commits ahead of main');
    expect(promotionBranchLine(candidate({ commitsAhead: null }))).toBe('project/34ZurCP3bv9yLXGVyUGnx');
    expect(promotionChecksSummary(candidate())).toEqual({ text: 'No checks recorded · no conflicts', clean: false });
    const green = { name: 'MERGE_CHECK' as const, command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 1, outputTail: '' };
    expect(promotionChecksSummary(candidate({ checks: [green] }))).toEqual({ text: '✓ Checks passed · no conflicts', clean: true });
    expect(promotionChecksSummary(candidate({ checks: [{ ...green, exitCode: 1 }], conflicts: ['a.go'] })).text)
      .toBe('✕ Checks failed · 1 file conflict with main');
    expect(promotionBlockedLine(candidate({ state: 'BLOCKED', conflicts: ['a', 'b', 'c', 'd'] })))
      .toBe('4 files conflict with main: a, b, c and 1 more');
    expect(promotionBlockedLine(candidate({ state: 'BLOCKED' }))).toBe('the checks on the combined tree did not pass');
    expect(promotionMergingStatus(candidate({ state: 'RECHECKING', execution: { state: 'RUNNING', phase: 'CHECK', startedAt: 'x' } })))
      .toBe('main moved since the check — re-checking the combined tree');
    expect(promotionMergingStatus(candidate({ state: 'CONFIRMED', execution: { state: 'QUEUED', phase: null, startedAt: 'x' } })))
      .toBe('confirmed — queued to merge into main');
  });
});

describe('the coordinator conversation’s one line', () => {
  it('is orange only while it waits on the reader', () => {
    expect(promotionEventLine(candidate())).toEqual({ text: 'Merge into main is waiting for you', tone: 'needsYou' });
    expect(promotionEventLine(candidate({ state: 'CONFIRMED' }))).toEqual({ text: 'Merge into main confirmed', tone: 'working' });
    expect(promotionEventLine(candidate({ state: 'BLOCKED', conflicts: ['a.go', 'b.go'] })))
      .toEqual({ text: 'Can’t merge into main yet · 2 files conflict', tone: 'blocked' });
    expect(promotionBlockedReason(candidate({ state: 'BLOCKED' }))).toBe('checks failed');
    expect(promotionEventLine(null)).toEqual({ text: NO_LONGER_ON_OFFER, tone: 'quiet' });
    expect(promotionEventLine(candidate({ state: 'DECLINED' })).tone).toBe('quiet');
  });

  it('says what went onto main and who merged it', () => {
    const pressed = merged('m', '2026-10-06T03:42:00Z');
    expect(promotionReceiptLine(pressed)).toBe('✓ Merged into main · 8d5a868 · 2 tasks');
    expect(promotionTimelineTitle(pressed)).toBe('Merged into main');
    expect(promotionTimelineDetail(pressed)).toBe('8d5a868 · 2 tasks · by you');
    expect(promotionChangesLine(pressed)).toBe('5 commits · 10 files');
    expect(promotionChangesLine(candidate({ commitsAhead: null, filesChanged: null }))).toBeNull();
    const automatic = merged('m', '2026-10-06T03:42:00Z', true);
    expect(promotionReceiptLine(automatic)).toBe('✓ Merged into main · 8d5a868 · 2 tasks · automatically');
    expect(promotionTimelineDetail(automatic)).toBe('8d5a868 · 2 tasks · automatically');
  });
});

describe('the sessions view’s timeline', () => {
  const now = new Date(2026, 9, 6, 12, 1);
  const local = (day: number, hour: number, minute = 0): string => new Date(2026, 9, day, hour, minute).toISOString();
  const session = (id: string, at: string) => ({ id, lastTurnAt: at, createdAt: at });

  it('draws each merge among the sessions at its own instant', () => {
    const sessions = [session('s-now', local(6, 11, 58)), session('s-p6', local(6, 11, 45)),
      session('s-log', local(6, 11, 12)), session('s-old', local(3, 16))];
    const sections = projectTimelineSections(sessions,
      [merged('m-old', local(4, 18)), merged('m-today', local(6, 11, 42))], now);
    expect(sections.map((section) => section.title)).toEqual(['Today', '2–7 days ago']);
    expect(sections[0].items.map((item) => item.id)).toEqual(['s-now', 's-p6', 'merge-m-today', 's-log']);
    expect(sections[1].items.map((item) => item.id)).toEqual(['merge-m-old', 's-old']);
  });

  it('keeps a merge older than every session, and ignores a candidate that never merged', () => {
    const sections = projectTimelineSections([session('a', local(6, 11))],
      [merged('m', local(1, 1) /* five days back */), candidate()], now);
    expect(sections.map((section) => section.title)).toEqual(['Today', '2–7 days ago']);
    expect(sections.flatMap((section) => section.items.map((item) => item.kind))).toEqual(['session', 'merge']);
  });
});

// ── the queue a waiting merge is in (§2.2 J1) ────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-10-07T01:42:00.000Z');
const minutesAgo = (n: number): string => new Date(NOW_MS - n * 60_000).toISOString();

function queueJob(over: Partial<IntegrationQueueJob> = {}): IntegrationQueueJob {
  return {
    jobId: 'job-1',
    kind: 'LAND_PROMOTION',
    state: 'QUEUED',
    phase: null,
    title: null,
    mine: false,
    automatic: false,
    projectId: null,
    taskId: null,
    enqueuedAt: minutesAgo(70),
    startedAt: null,
    lastReportAt: null,
    stale: false,
    ...over,
  };
}

function queue(jobs: IntegrationQueueJob[]): IntegrationQueueView {
  return {
    targetRef: 'refs/heads/main',
    running: jobs.filter((job) => job.state === 'RUNNING').length,
    waiting: jobs.filter((job) => job.state === 'QUEUED').length,
    jobs,
  };
}

describe('the queue a waiting merge is in', () => {
  it('spells the position rather than counting it', () => {
    const mine = queueJob({ jobId: 'mine', mine: true, projectId: 'p1', title: 'DeepSeek' });
    const view = queue([
      queueJob({ jobId: 'head', state: 'RUNNING', startedAt: minutesAgo(4) }),
      mine,
      queueJob({ jobId: 'j3' }),
      queueJob({ jobId: 'j4' }),
    ]);

    expect(queuePositionLine(view, 'mine')).toBe('2nd of 4 for main');
    expect(queueSummaryLine(view)).toBe('1 running · 3 waiting');
    expect(queueTitle('refs/heads/main')).toBe('Queue for main');
  });

  it('has no position for a job the queue does not hold', () => {
    expect(queuePositionLine(queue([queueJob()]), 'absent')).toBeNull();
    expect(queuePositionLine({ ...queue([]), targetRef: null }, 'absent')).toBeNull();
  });

  it('says who is ahead: a task landing, a project’s merge, or another account’s work', () => {
    const mine = queueJob({ jobId: 'mine', mine: true, projectId: 'p1' });
    const running = (over: Partial<IntegrationQueueJob>) =>
      queueJob({ state: 'RUNNING', startedAt: minutesAgo(4), lastReportAt: minutesAgo(1), ...over });

    expect(queueWaitLine(queue([running({ kind: 'LAND_TASK', title: '修复 D3', mine: true }),
                                mine]), 'mine', NOW_MS))
      .toBe('Waiting to merge: the landing of “修复 D3” is running on main first');
    expect(queueWaitLine(queue([running({ title: 'Orbit Web 组件迁移', mine: true }), mine]),
                         'mine', NOW_MS))
      .toBe('Waiting to merge: “Orbit Web 组件迁移” is running on main first');
    expect(queueWaitLine(queue([running({ kind: 'LAND_TASK' }), mine]), 'mine', NOW_MS))
      .toBe('Waiting to merge: another account’s landing is running on main first');
    expect(queueWaitLine(queue([running({}), mine]), 'mine', NOW_MS))
      .toBe('Waiting to merge: another account’s merge to main is running on main first');
  });

  it('says a head that has gone quiet is not “running first”', () => {
    const mine = queueJob({ jobId: 'mine', mine: true, projectId: 'p1' });
    const stuck = queueJob({ state: 'RUNNING', mine: true, title: 'Orbit Web 组件迁移',
                             startedAt: minutesAgo(123), lastReportAt: minutesAgo(123), stale: true });

    expect(queueWaitLine(queue([stuck, mine]), 'mine', NOW_MS))
      .toBe('Waiting to merge: “Orbit Web 组件迁移” has no report for 2h 3m — it may be stuck');
    expect(queueJobStaleClause(stuck, NOW_MS)).toBe('no report for 2h 3m — it may be stuck');
    expect(queueJobStaleClause(mine, NOW_MS)).toBeNull();
  });

  it('has nothing to wait on when the merge is the head or is not in the queue', () => {
    const head = queueJob({ jobId: 'mine', mine: true, projectId: 'p1' });
    // A QUEUED head is still ahead of nobody: this merge goes first.
    expect(queueWaitLine(queue([head, queueJob({ jobId: 'other' })]), 'mine', NOW_MS)).toBeNull();
    expect(queueWaitLine(queue([queueJob({ state: 'RUNNING' })]), 'absent', NOW_MS)).toBeNull();
  });

  it('names a row: its title, or what an unnamed row is', () => {
    expect(queueJobTitle(queueJob({ title: 'DeepSeek Harness', mine: true })))
      .toBe('“DeepSeek Harness”');
    expect(queueJobTitle(queueJob({ kind: 'LAND_TASK', mine: true }))).toBe('Your landing');
    expect(queueJobTitle(queueJob({ kind: 'LAND_TASK' })))
      .toBe('Another account’s landing');
    expect(queueJobTitle(queueJob({}))).toBe('Another account’s merge to main');
  });

  it('states each row: what it is doing, and for how long or how quiet', () => {
    expect(queueJobStatus(queueJob({ state: 'RUNNING', phase: 'FETCH', kind: 'LAND_PROMOTION' })))
      .toBe('Merge to main · fetching');
    expect(queueJobStatus(queueJob({ state: 'RUNNING', phase: null }))).toBe('Merge to main · running');
    expect(queueJobStatus(queueJob({ state: 'QUEUED', kind: 'LAND_TASK' }))).toBe('Landing · queued');
    expect(queueJobSpan(queueJob({ enqueuedAt: minutesAgo(70) }), NOW_MS)).toBe('1h 10m');
    expect(queueJobSpan(queueJob({ state: 'RUNNING', startedAt: minutesAgo(4) }), NOW_MS)).toBe('4m');
  });
});
