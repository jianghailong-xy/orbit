import { describe, expect, it } from 'vitest';
import {
  QUIET_MS,
  attentionChipOf,
  attentionReasonOf,
  attentionSectionOf,
  failedTaskCount,
  orderWithinSection,
  projectAttentionSections,
  type AttentionProject,
  type AttentionSectionKey,
} from './projectAttention';

const NOW = Date.parse('2026-08-23T18:55:05.000Z');
const HOUR = 60 * 60 * 1000;
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();

let nextId = 0;

function project(
  over: Partial<AttentionProject> & { buckets?: Partial<AttentionProject['buckets']> } = {},
): AttentionProject {
  nextId += 1;
  const buckets = {
    running: 0,
    ready: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    ...(over.buckets ?? {}),
  };
  const bucketed = Object.values(buckets).reduce((sum, count) => sum + count, 0);
  return {
    id: `0195c0de-0000-7000-8000-${String(nextId).padStart(12, '0')}`,
    title: `Project ${nextId}`,
    status: 'OPEN',
    createdAt: '2026-01-01T00:00:00.000Z',
    _count: { tasks: bucketed },
    lastActivityAt: bucketed > 0 ? at(HOUR) : null,
    ...over,
    buckets,
  };
}

describe('attention classification', () => {
  it('puts a durable USER-owned blocker ahead of lifecycle-derived guesses', () => {
    const row = project({
      buckets: { running: 1 },
      attention: {
        userBlockers: 1,
        coordinatorBlockers: 0,
        systemBlockers: 0,
        maxSeverity: 'WARNING',
        attentionSinceAt: at(2 * QUIET_MS),
        nextCheckAt: at(-HOUR),
      },
    });
    expect(attentionReasonOf(row, NOW)).toBe('needs-user');
    expect(attentionSectionOf(row, NOW)).toBe('attention');
  });

  it('puts closed projects in Completed before considering inconsistent live buckets', () => {
    for (const status of ['DONE', 'CANCELLED'] as const) {
      const row = project({ status, _count: { tasks: 8 }, buckets: { running: 2, ready: 4 } });
      expect(attentionSectionOf(row, NOW)).toBe('completed');
      expect(attentionReasonOf(row, NOW)).toBeNull();
    }
  });

  it('derives FAILED from the task-count remainder and surfaces it first', () => {
    const row = project({ _count: { tasks: 5 }, buckets: { running: 1, done: 2 } });
    expect(failedTaskCount(row)).toBe(2);
    expect(attentionReasonOf(row, NOW)).toBe('failed');
    expect(attentionSectionOf(row, NOW)).toBe('attention');

    const inconsistent = project({ _count: { tasks: 1 }, buckets: { done: 2 } });
    expect(failedTaskCount(inconsistent)).toBe(0);
  });

  it('separates healthy running work from a quiet run', () => {
    const healthy = project({ buckets: { running: 1, ready: 3 }, lastActivityAt: at(HOUR) });
    const quiet = project({ buckets: { running: 1, ready: 3 }, lastActivityAt: at(2 * QUIET_MS) });

    // Running wins over ready while the run is healthy.
    expect(attentionSectionOf(healthy, NOW)).toBe('running');
    expect(attentionReasonOf(healthy, NOW)).toBeNull();
    expect(attentionSectionOf(quiet, NOW)).toBe('attention');
    expect(attentionReasonOf(quiet, NOW)).toBe('no-activity-running');
  });

  it('gives fresh ready work a grace period before asking for attention', () => {
    const fresh = project({ buckets: { ready: 9, blocked: 1 }, lastActivityAt: at(HOUR) });
    const quiet = project({ buckets: { ready: 9, blocked: 1 }, lastActivityAt: at(2 * QUIET_MS) });

    expect(attentionSectionOf(fresh, NOW)).toBe('ready');
    expect(attentionSectionOf(quiet, NOW)).toBe('attention');
    expect(attentionReasonOf(quiet, NOW)).toBe('no-activity-ready');
  });

  it('calls dependency-only work Waiting however old it is', () => {
    const waiting = project({ buckets: { blocked: 4 }, lastActivityAt: at(30 * QUIET_MS) });
    expect(attentionSectionOf(waiting, NOW)).toBe('waiting');
    expect(attentionReasonOf(waiting, NOW)).toBeNull();
  });

  it('puts settled-but-open work in Needs attention, and empty projects in Needs definition', () => {
    const settled = project({ buckets: { done: 5, cancelled: 7 } });
    const empty = project({ title: 'Unplanned project' });

    expect(attentionSectionOf(settled, NOW)).toBe('attention');
    expect(attentionReasonOf(settled, NOW)).toBe('ready-to-close');
    expect(attentionSectionOf(empty, NOW)).toBe('definition');
  });

  it('lands every bucket/status combination in exactly one of the six lanes', () => {
    const counts = [0, 1, 2];
    const seen = new Set<AttentionSectionKey>();
    for (const status of ['OPEN', 'DONE', 'CANCELLED'] as const)
      for (const running of counts)
        for (const ready of counts)
          for (const blocked of counts)
            for (const done of counts)
              for (const cancelled of counts) {
                const row = project({
                  status,
                  buckets: { running, ready, blocked, done, cancelled },
                  lastActivityAt: running + ready + blocked + done + cancelled > 0 ? at(HOUR) : null,
                });
                const key = attentionSectionOf(row, NOW);
                expect(['attention', 'running', 'ready', 'waiting', 'definition', 'completed']).toContain(key);
                seen.add(key);
              }

    expect([...seen].sort()).toEqual([
      'attention',
      'completed',
      'definition',
      'ready',
      'running',
      'waiting',
    ]);
  });
});

describe('orderWithinSection', () => {
  it('orders Needs attention by reason, then puts the longest-quiet peer first', () => {
    const closing = project({ title: 'Close', buckets: { done: 2 } });
    const readyNewer = project({ title: 'Ready newer', buckets: { ready: 1 }, lastActivityAt: at(2 * QUIET_MS) });
    const readyOlder = project({ title: 'Ready older', buckets: { ready: 1 }, lastActivityAt: at(4 * QUIET_MS) });
    const zombie = project({ title: 'Zombie', buckets: { running: 1 }, lastActivityAt: at(3 * QUIET_MS) });
    const failed = project({ title: 'Failed', _count: { tasks: 2 }, buckets: { done: 1 } });
    const needsUser = project({
      title: 'Needs user',
      attention: {
        userBlockers: 1,
        coordinatorBlockers: 0,
        systemBlockers: 0,
        maxSeverity: 'WARNING',
        attentionSinceAt: at(QUIET_MS),
        nextCheckAt: null,
      },
    });

    expect(orderWithinSection('attention', [closing, readyNewer, failed, needsUser, zombie, readyOlder], NOW)).toEqual([
      needsUser,
      failed,
      zombie,
      readyOlder,
      readyNewer,
      closing,
    ]);
  });

  it('does not let raw Ready count determine priority', () => {
    const oneOlder = project({ buckets: { ready: 1 }, lastActivityAt: at(10 * HOUR) });
    const tenThousandNewer = project({ buckets: { ready: 10_000 }, lastActivityAt: at(HOUR) });

    expect(orderWithinSection('ready', [tenThousandNewer, oneOlder], NOW)).toEqual([
      oneOlder,
      tenThousandNewer,
    ]);
  });

  it('orders human blockers by visible severity, then by how long the user has owned them', () => {
    const warningNew = project({
      attention: {
        userBlockers: 1, coordinatorBlockers: 0, systemBlockers: 0,
        maxSeverity: 'WARNING', attentionSinceAt: at(QUIET_MS), nextCheckAt: null,
      },
    });
    const warningOld = project({
      attention: {
        userBlockers: 2, coordinatorBlockers: 0, systemBlockers: 0,
        maxSeverity: 'WARNING', attentionSinceAt: at(4 * QUIET_MS), nextCheckAt: null,
      },
    });
    const criticalNew = project({
      attention: {
        userBlockers: 1, coordinatorBlockers: 0, systemBlockers: 0,
        maxSeverity: 'CRITICAL', attentionSinceAt: at(HOUR), nextCheckAt: null,
      },
    });

    expect(orderWithinSection('attention', [warningNew, warningOld, criticalNew], NOW)).toEqual([
      criticalNew,
      warningOld,
      warningNew,
    ]);
  });

  it('uses newest activity for healthy Running and Completed', () => {
    const older = project({ buckets: { running: 1 }, lastActivityAt: at(3 * HOUR) });
    const newer = project({ buckets: { running: 1 }, lastActivityAt: at(HOUR) });
    expect(orderWithinSection('running', [older, newer], NOW)).toEqual([newer, older]);

    const closedOlder = project({ status: 'DONE', buckets: { done: 1 }, lastActivityAt: at(3 * HOUR) });
    const closedNewer = project({ status: 'DONE', buckets: { done: 1 }, lastActivityAt: at(HOUR) });
    expect(orderWithinSection('completed', [closedOlder, closedNewer], NOW)).toEqual([
      closedNewer,
      closedOlder,
    ]);
  });

  it('uses oldest activity for Ready and Waiting to prevent starvation', () => {
    const olderReady = project({ buckets: { ready: 1 }, lastActivityAt: at(10 * HOUR) });
    const newerReady = project({ buckets: { ready: 1 }, lastActivityAt: at(HOUR) });
    expect(orderWithinSection('ready', [newerReady, olderReady], NOW)).toEqual([olderReady, newerReady]);

    const olderWait = project({ buckets: { blocked: 1 }, lastActivityAt: at(5 * QUIET_MS) });
    const newerWait = project({ buckets: { blocked: 1 }, lastActivityAt: at(QUIET_MS) });
    expect(orderWithinSection('waiting', [newerWait, olderWait], NOW)).toEqual([olderWait, newerWait]);
  });

  it('orders Needs definition by its visible title, then uses id as a deterministic tie-break', () => {
    const zulu = project({ title: 'Zulu' });
    const alphaLaterId = project({ title: 'Alpha', id: 'b' });
    const alphaEarlierId = project({ title: 'Alpha', id: 'a' });
    expect(orderWithinSection('definition', [zulu, alphaLaterId, alphaEarlierId], NOW)).toEqual([
      alphaEarlierId,
      alphaLaterId,
      zulu,
    ]);
  });

  it('does not mutate the query-cache array', () => {
    const input = [
      project({ buckets: { ready: 1 }, lastActivityAt: at(HOUR) }),
      project({ buckets: { ready: 1 }, lastActivityAt: at(2 * HOUR) }),
    ];
    const before = [...input];
    orderWithinSection('ready', input, NOW);
    expect(input).toEqual(before);
  });
});

describe('projectAttentionSections', () => {
  it('returns the six lanes in next-actor order and folds only Completed', () => {
    const sections = projectAttentionSections([], NOW);
    expect(sections.map((section) => section.key)).toEqual([
      'attention',
      'running',
      'ready',
      'waiting',
      'definition',
      'completed',
    ]);
    expect(sections.map((section) => section.title)).toEqual([
      'Needs attention',
      'Running',
      'Ready',
      'Waiting',
      'Needs definition',
      'Completed',
    ]);
    expect(sections.filter((section) => section.defaultCollapsed).map((section) => section.key)).toEqual([
      'completed',
    ]);
    for (const section of sections) expect(section.note).not.toBe('');
  });

  it('keeps empty lanes for ProjectSections to drop', () => {
    const sections = projectAttentionSections([project({ buckets: { running: 1 } })], NOW);
    expect(sections).toHaveLength(6);
    expect(sections.find((section) => section.key === 'waiting')?.projects).toEqual([]);
  });
});

describe('attentionChipOf', () => {
  it('shows the highest-priority failure reason with correct plurality', () => {
    const one = project({ _count: { tasks: 2 }, buckets: { done: 1 } });
    const many = project({ _count: { tasks: 4 }, buckets: { done: 1 } });
    expect(attentionChipOf(one, NOW)).toEqual({ tone: 'warning', text: '1 failed task' });
    expect(attentionChipOf(many, NOW)).toEqual({ tone: 'warning', text: '3 failed tasks' });
  });

  it('names an outstanding human-owned blocker', () => {
    const row = project({
      attention: {
        userBlockers: 2,
        coordinatorBlockers: 1,
        systemBlockers: 0,
        maxSeverity: 'CRITICAL',
        attentionSinceAt: at(2 * QUIET_MS),
        nextCheckAt: null,
      },
    });
    expect(attentionChipOf(row, NOW)).toEqual({
      tone: 'warning',
      text: 'Needs you · Critical · 2d · 2 blockers',
    });
  });

  it('distinguishes a quiet run from an idle ready queue', () => {
    const run = project({ buckets: { running: 1 }, lastActivityAt: at(3 * QUIET_MS) });
    const ready = project({ buckets: { ready: 1 }, lastActivityAt: at(2 * QUIET_MS) });
    expect(attentionChipOf(run, NOW)).toEqual({ tone: 'warning', text: 'Running · no activity 3d' });
    expect(attentionChipOf(ready, NOW)).toEqual({ tone: 'warning', text: 'Ready · no activity 2d' });
  });

  it('shows settled work that still needs the project closed', () => {
    const row = project({ buckets: { done: 5, cancelled: 7 } });
    expect(attentionChipOf(row, NOW)).toEqual({
      tone: 'brand',
      text: '12/12 settled · still open',
    });
  });

  it('holds the quiet threshold exactly', () => {
    const justFresh = project({ buckets: { ready: 1 }, lastActivityAt: at(QUIET_MS - 1) });
    const justQuiet = project({ buckets: { ready: 1 }, lastActivityAt: at(QUIET_MS) });
    expect(attentionChipOf(justFresh, NOW)).toBeNull();
    expect(attentionChipOf(justQuiet, NOW)?.text).toBe('Ready · no activity 1d');
  });

  it('does not infer silence from missing, invalid, or future timestamps', () => {
    for (const lastActivityAt of [null, 'not a date', new Date(NOW + HOUR).toISOString()]) {
      const row = project({ buckets: { ready: 1 }, lastActivityAt });
      expect(attentionChipOf(row, NOW)).toBeNull();
    }
  });

  it('does not badge healthy, expected-waiting, empty, or closed projects', () => {
    const rows = [
      project({ buckets: { running: 1 }, lastActivityAt: at(HOUR) }),
      project({ buckets: { ready: 1 }, lastActivityAt: at(HOUR) }),
      project({ buckets: { blocked: 1 }, lastActivityAt: at(20 * QUIET_MS) }),
      project(),
      project({ status: 'DONE', buckets: { done: 1 }, lastActivityAt: at(20 * QUIET_MS) }),
    ];
    for (const row of rows) expect(attentionChipOf(row, NOW)).toBeNull();
  });
});
