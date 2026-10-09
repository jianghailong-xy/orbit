import { describe, expect, it } from 'vitest';
import type { ProjectLandTask, ProjectPromotionView } from '@orbit/shared';
import {
  NO_LONGER_ON_OFFER,
  isMergeJob,
  mergeCardShape,
  moreTasks,
  projectTimelineSections,
  promotionBlockedBy,
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
    blockedReason: null,
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
    expect(promotionBlockedLine(candidate({ state: 'BLOCKED', blockedReason: 'CONFLICT', conflicts: ['a', 'b', 'c', 'd'] })))
      .toBe('4 files conflict with main: a, b, c and 1 more');
    expect(promotionBlockedLine(candidate({ state: 'BLOCKED', blockedReason: 'CHECK_FAILED' })))
      .toBe('the checks on the combined tree did not pass');
    expect(promotionMergingStatus(candidate({ state: 'RECHECKING', execution: { state: 'RUNNING', phase: 'CHECK', startedAt: 'x' } })))
      .toBe('main moved since the check — re-checking the combined tree');
    expect(promotionMergingStatus(candidate({ state: 'CONFIRMED', execution: { state: 'QUEUED', phase: null, startedAt: 'x' } })))
      .toBe('confirmed — queued to merge into main');
  });
});

describe('why a blocked merge is blocked', () => {
  // 2026-10-09: the check found the project branch already on main and blocked the candidate with no
  // checks and no conflicts, and the card said a check had failed. No check had run.
  it('says there is nothing to merge when the branch is already on main, not that a check failed', () => {
    const nothing = candidate({ state: 'BLOCKED', blockedReason: 'ALREADY_LANDED', checks: [], conflicts: [] });
    expect(promotionBlockedLine(nothing)).toBe('nothing to merge — project/34ZurCP3bv9yLXGVyUGnx is already on main');
    expect(promotionBlockedReason(nothing)).toBe('nothing to merge');
    expect(promotionEventLine(nothing)).toEqual({ text: 'Can’t merge into main yet · nothing to merge', tone: 'blocked' });
  });

  it('says an error stopped it when the job never reached a verdict, not that a check failed', () => {
    const errored = candidate({ state: 'BLOCKED', blockedReason: 'ERROR', checks: [], conflicts: [] });
    expect(promotionBlockedLine(errored)).toBe('the merge stopped on an error — no check failed');
    expect(promotionBlockedReason(errored)).toBe('check errored');
    expect(promotionEventLine(errored)).toEqual({ text: 'Can’t merge into main yet · check errored', tone: 'blocked' });
  });

  it('reads a block recorded before its reason was, the way it always did', () => {
    const older = candidate({ state: 'BLOCKED', blockedReason: null });
    expect(promotionBlockedLine(older)).toBe('the checks on the combined tree did not pass');
    expect(promotionBlockedReason(older)).toBe('checks failed');
    const olderConflict = candidate({ state: 'BLOCKED', blockedReason: null, conflicts: ['a.go'] });
    expect(promotionBlockedLine(olderConflict)).toBe('1 file conflict with main: a.go');
    expect(promotionBlockedReason(olderConflict)).toBe('1 file conflict');
    // A server from before the field existed sends none at all.
    const unrecorded = candidate({ state: 'BLOCKED' });
    delete (unrecorded as Partial<ProjectPromotionView>).blockedReason;
    expect(promotionBlockedLine(unrecorded)).toBe('the checks on the combined tree did not pass');
    expect(promotionBlockedReason(unrecorded)).toBe('checks failed');
  });
});

describe('who is in front of a blocked merge', () => {
  const branch = 'refs/heads/project/34ZurCP3bv9yLXGVyUGnx';
  /** One of the project's current landings, as `ProjectIntegrationView.landTasks` serves it. */
  const landing = (over: {
    taskId?: string;
    taskTitle?: string;
    state?: string;
    phase?: string | null;
    targetRef?: string;
    reason?: { code: string; summary: string; jobId?: string } | null;
  } = {}): ProjectLandTask => ({
    taskId: over.taskId ?? 't9',
    taskTitle: over.taskTitle ?? '同步项目线与 main：解开迁移台账冲突',
    integration: {
      state: 'QUEUED' as const,
      since: null, handler: null, openItemId: null, jobId: 'j9', checksRunningForMs: null,
      landTask: {
        jobId: 'j9',
        state: (over.state ?? 'QUEUED') as 'QUEUED' | 'RUNNING' | 'CONFLICT',
        phase: over.phase ?? null,
        generation: '2',
        queuedAt: '2026-10-08T04:04:01.133Z',
        startedAt: '2026-10-08T04:06:24.770Z',
        heartbeatAt: '2026-10-08T04:06:24.770Z',
        finishedAt: null,
        targetRef: over.targetRef ?? branch,
        waitMs: 143_637,
        blockingReason: over.reason === undefined
          ? { code: 'WAITING_SERIAL_SLOT', jobId: 'j8',
            summary: 'Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” is running on this branch first' }
          : over.reason,
      },
    },
  });

  it('names the landing holding the branch, and what the server says holds THAT landing', () => {
    expect(promotionBlockedBy(candidate({ state: 'BLOCKED', conflicts: ['a.go'] }), [landing()]))
      .toBe('“同步项目线与 main：解开迁移台账冲突” is landing on the project line · queued · '
        + 'Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” is running on this branch first');
    // Running says which step it is at, from the phase the runner reported.
    expect(promotionBlockedBy(candidate({ state: 'BLOCKED' }),
      [landing({ state: 'RUNNING', phase: 'MAIN_SYNC' })]))
      .toBe('“同步项目线与 main：解开迁移台账冲突” is landing on the project line · syncing main · '
        + 'Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” is running on this branch first');
  });

  it('says nothing when the line is doing nothing on the branches this merge goes through', () => {
    expect(promotionBlockedBy(candidate({ state: 'BLOCKED' }), [])).toBeNull();
    expect(promotionBlockedBy(candidate({ state: 'BLOCKED' }), null)).toBeNull();
    // Another task's landing, on a branch this candidate neither merges from nor into.
    expect(promotionBlockedBy(candidate({ state: 'BLOCKED' }),
      [landing({ targetRef: 'refs/heads/orbit/somewhere-else' })])).toBeNull();
    // A landing that has stopped holds nothing: the line is idle, and this row is not where its
    // failure is reported (its own landing row and the exception item say that).
    expect(promotionBlockedBy(candidate({ state: 'BLOCKED' }), [landing({ state: 'CONFLICT' })])).toBeNull();
    // And with no reason from the server, the sentence stops at what it does know.
    expect(promotionBlockedBy(candidate({ state: 'BLOCKED', sourceKind: 'TASK_BRANCH', sourceRef: 'refs/heads/task' }),
      [landing({ targetRef: 'refs/heads/main', reason: null })]))
      .toBe('“同步项目线与 main：解开迁移台账冲突” is landing on the project line · queued');
  });
});

describe('the coordinator conversation’s one line', () => {
  it('is orange only while it waits on the reader', () => {
    expect(promotionEventLine(candidate())).toEqual({ text: 'Merge into main is waiting for you', tone: 'needsYou' });
    expect(promotionEventLine(candidate({ state: 'CONFIRMED' }))).toEqual({ text: 'Merge into main confirmed', tone: 'working' });
    expect(promotionEventLine(candidate({ state: 'BLOCKED', blockedReason: 'CONFLICT', conflicts: ['a.go', 'b.go'] })))
      .toEqual({ text: 'Can’t merge into main yet · 2 files conflict', tone: 'blocked' });
    expect(promotionBlockedReason(candidate({ state: 'BLOCKED', blockedReason: 'CHECK_FAILED' }))).toBe('checks failed');
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
