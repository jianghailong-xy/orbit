import { describe, expect, it } from 'vitest';
import type { ProjectPromotionView } from '@orbit/shared';
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
