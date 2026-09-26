import { describe, expect, it } from 'vitest';
import type { CoordinatorLeadKind, OwnerItemKind } from '@orbit/shared';
import {
  QUIET_MS,
  attentionChipOf,
  attentionReasonOf,
  attentionSectionOf,
  failedTaskCount,
  integrationChipOf,
  orderWithinSection,
  projectAttentionSections,
  projectIsWorking,
  projectNeedsYouCount,
  sidebarProjects,
  type AttentionProject,
  type AttentionSectionKey,
  type ProjectAttentionSummary,
  type SidebarProject,
} from './projectAttention';

const NOW = Date.parse('2026-08-23T18:55:05.000Z');
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();

/** One of the four items a project can be waiting on its OWNER for, as the list payload states it
 *  (§7.1 V1). */
const ownerItem = (kind: OwnerItemKind, count: number, waitedMs: number) => ({
  kind,
  count,
  oldestWaitingSince: at(waitedMs),
});

/** The exception the project's coordinator is handling, as the list payload states it (§7.1 V1). */
const coordinatorItems = (leadKind: CoordinatorLeadKind, waitedMs: number, count = 1) => ({
  leadKind,
  count,
  oldestWaitingSince: at(waitedMs),
  nextEscalationAt: at(-90 * MINUTE),
});

/** The blocker summary with the two item fields, so a fixture states only what it is about. */
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
  it.each([
    ['coordinator', 1, 0],
    ['system', 0, 1],
  ] as const)(
    'routes a fresh Running project with a %s blocker into coordinator-owned auto-remediation',
    (_owner, coordinatorBlockers, systemBlockers) => {
      const row = project({
        buckets: { running: 1, ready: 2 },
        lastActivityAt: at(HOUR),
        attention: {
          userBlockers: 0,
          coordinatorBlockers,
          systemBlockers,
          maxSeverity: 'CRITICAL',
          attentionSinceAt: at(HOUR),
          nextCheckAt: null,
        },
      });

      expect(attentionReasonOf(row, NOW)).toBe('auto-remediation');
      expect(attentionSectionOf(row, NOW)).toBe('attention');
      expect(attentionChipOf(row, NOW)).toEqual({
        tone: 'warning',
        text: 'Auto-remediation · Coordinator-owned · Critical · <1d · 1 blocker',
      });
    },
  );

  it('keeps a fresh run in Running while preserving its durable USER-owned blocker signal', () => {
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
    expect(attentionChipOf(row, NOW)).toEqual({
      tone: 'warning',
      text: 'Needs you · Warning · 2d · 1 blocker',
    });
    expect(attentionSectionOf(row, NOW)).toBe('running');
  });

  it('puts closed projects in Completed before considering inconsistent live buckets', () => {
    for (const status of ['DONE', 'CANCELLED'] as const) {
      const row = project({ status, _count: { tasks: 8 }, buckets: { running: 2, ready: 4 } });
      expect(attentionSectionOf(row, NOW)).toBe('completed');
      expect(attentionReasonOf(row, NOW)).toBeNull();
    }
  });

  it('keeps an ordinary FAILED remainder in Running without manufacturing Needs you', () => {
    const row = project({ _count: { tasks: 5 }, buckets: { running: 1, done: 2 } });
    expect(failedTaskCount(row)).toBe(2);
    expect(attentionReasonOf(row, NOW)).toBeNull();
    expect(attentionChipOf(row, NOW)).toBeNull();
    expect(attentionSectionOf(row, NOW)).toBe('running');

    const inconsistent = project({ _count: { tasks: 1 }, buckets: { done: 2 } });
    expect(failedTaskCount(inconsistent)).toBe(0);
  });

  it('keeps quiet running work in Needs attention even when blocker or failure signals remain', () => {
    const needsUser = project({
      buckets: { running: 1 },
      lastActivityAt: at(2 * QUIET_MS),
      attention: {
        userBlockers: 1,
        coordinatorBlockers: 0,
        systemBlockers: 0,
        maxSeverity: 'CRITICAL',
        attentionSinceAt: at(3 * QUIET_MS),
        nextCheckAt: null,
      },
    });
    const failed = project({
      _count: { tasks: 3 },
      buckets: { running: 1, done: 1 },
      lastActivityAt: at(2 * QUIET_MS),
    });

    expect(attentionReasonOf(needsUser, NOW)).toBe('needs-user');
    expect(attentionSectionOf(needsUser, NOW)).toBe('attention');
    expect(attentionReasonOf(failed, NOW)).toBe('no-activity-running');
    expect(attentionSectionOf(failed, NOW)).toBe('attention');
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

    expect(orderWithinSection('attention', [closing, readyNewer, needsUser, zombie, readyOlder], NOW)).toEqual([
      needsUser,
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
  it('keeps automatic remediation explicit when a project also needs a human', () => {
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
      text: 'Auto-remediation · Coordinator-owned · Critical · 2d · 1 blocker · 2 need you',
    });
  });

  it('names an outstanding human-owned blocker when no automatic repair is active', () => {
    const row = project({
      attention: {
        userBlockers: 2,
        coordinatorBlockers: 0,
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

/**
 * The five reasons §7.1 V2 adds, each one an item the project is actually waiting on rather than a
 * tally of blockers: what the row says is what the reader has to go and do, and how long it has
 * been waiting for them.
 */
describe('attention by reason', () => {
  it('names the merge waiting on the owner, and takes a busy project out of Running', () => {
    // Mock 1's first row: four tasks in flight AND a branch waiting to be merged. Fresh activity
    // does not keep the row in Running — an item sitting on a person outranks ordinary work.
    const row = project({
      buckets: { running: 4, ready: 2, done: 27 },
      lastActivityAt: at(12 * MINUTE),
      attention: attention({ ownerItems: [ownerItem('PROMOTION_APPROVAL', 1, 2 * HOUR)] }),
    });
    expect(attentionReasonOf(row, NOW)).toBe('approve-merge-to-main');
    expect(attentionSectionOf(row, NOW)).toBe('attention');
    expect(attentionChipOf(row, NOW)).toEqual({
      tone: 'warning',
      text: 'Needs you · Approve merge to main · 2h',
    });
  });

  it('counts the questions the coordinator is waiting on an answer to', () => {
    const one = project({
      buckets: { running: 2, blocked: 3 },
      attention: attention({ ownerItems: [ownerItem('COORDINATOR_QUESTION', 1, 35 * MINUTE)] }),
    });
    const two = project({
      buckets: { running: 2 },
      attention: attention({ ownerItems: [ownerItem('COORDINATOR_QUESTION', 2, 35 * MINUTE)] }),
    });
    for (const row of [one, two]) {
      expect(attentionReasonOf(row, NOW)).toBe('coordinator-question');
      expect(attentionSectionOf(row, NOW)).toBe('attention');
    }
    expect(attentionChipOf(one, NOW)?.text).toBe('Needs you · 1 question from coordinator · 35m');
    expect(attentionChipOf(two, NOW)?.text).toBe('Needs you · 2 questions from coordinator · 35m');
  });

  it('counts the exceptions that escalated to the owner', () => {
    const row = project({
      buckets: { blocked: 4 },
      attention: attention({ ownerItems: [ownerItem('ESCALATED', 3, 4 * HOUR)] }),
    });
    expect(attentionReasonOf(row, NOW)).toBe('escalated-to-you');
    expect(attentionSectionOf(row, NOW)).toBe('attention');
    expect(attentionChipOf(row, NOW)).toEqual({
      tone: 'warning',
      text: 'Needs you · 3 escalated to you · 4h',
    });
  });

  it('states a pause as a pause, not as one more thing the owner must approve', () => {
    const row = project({
      buckets: { running: 1, done: 9 },
      lastActivityAt: at(MINUTE),
      attention: attention({ ownerItems: [ownerItem('FUSE_PAUSED', 1, 20 * MINUTE)] }),
    });
    expect(attentionReasonOf(row, NOW)).toBe('fuse-paused');
    expect(attentionSectionOf(row, NOW)).toBe('attention');
    expect(attentionChipOf(row, NOW)).toEqual({
      tone: 'warning',
      text: 'Paused · coordinator stopped itself · 20m',
    });
  });

  it('leads with the item that has waited longest, whatever else is also waiting', () => {
    const row = project({
      attention: attention({
        ownerItems: [
          ownerItem('COORDINATOR_QUESTION', 2, 35 * MINUTE),
          ownerItem('PROMOTION_APPROVAL', 1, 2 * HOUR),
          ownerItem('FUSE_PAUSED', 1, 20 * MINUTE),
        ],
      }),
    });
    expect(attentionReasonOf(row, NOW)).toBe('approve-merge-to-main');
    expect(attentionChipOf(row, NOW)?.text).toBe('Needs you · Approve merge to main · 2h');
  });

  it('settles two items that have waited equally long on one kind, so the chip does not flicker', () => {
    const row = project({
      attention: attention({
        ownerItems: [
          ownerItem('FUSE_PAUSED', 1, HOUR),
          ownerItem('COORDINATOR_QUESTION', 1, HOUR),
        ],
      }),
    });
    expect(attentionReasonOf(row, NOW)).toBe('coordinator-question');
  });

  it('makes no age claim from a wait it cannot read', () => {
    const row = project({
      attention: attention({
        ownerItems: [
          {
            kind: 'PROMOTION_APPROVAL',
            count: 1,
            oldestWaitingSince: new Date(NOW + HOUR).toISOString(),
          },
        ],
      }),
    });
    expect(attentionChipOf(row, NOW)).toEqual({
      tone: 'warning',
      text: 'Needs you · Approve merge to main',
    });
  });

  it('names the coordinator’s own exception in brand, in the lane the project earned', () => {
    // Mock 1's fourth row: work is running, the coordinator is resolving the conflict itself, and
    // the row stays in Running.
    const row = project({
      buckets: { running: 3, ready: 2, done: 5 },
      lastActivityAt: at(MINUTE),
      attention: attention({ coordinatorItems: coordinatorItems('INTEGRATION_CONFLICT', 18 * MINUTE) }),
    });
    expect(attentionReasonOf(row, NOW)).toBe('coordinator-handling');
    expect(attentionSectionOf(row, NOW)).toBe('running');
    expect(attentionChipOf(row, NOW)).toEqual({
      tone: 'brand',
      text: 'Coordinator · resolving a merge conflict · 18m',
    });
  });

  it.each([
    ['INTEGRATION_CHECK_FAILED', 'Coordinator · checks failed · 3h'],
    ['INTEGRATION_ERROR', 'Coordinator · handling an integration error · 3h'],
    ['TASK_FAILED', 'Coordinator · handling a failed task · 3h'],
  ] as const)('names what the coordinator is doing with a %s', (leadKind, text) => {
    const row = project({
      buckets: { running: 1 },
      lastActivityAt: at(MINUTE),
      attention: attention({ coordinatorItems: coordinatorItems(leadKind, 3 * HOUR) }),
    });
    expect(attentionChipOf(row, NOW)).toEqual({ tone: 'brand', text });
  });

  it('never lands a coordinator-handled exception in Needs attention', () => {
    for (const buckets of [
      { running: 1 },
      { ready: 2 },
      { blocked: 3 },
      { running: 1, ready: 1, blocked: 1 },
    ]) {
      const row = project({
        buckets,
        lastActivityAt: at(HOUR),
        attention: attention({ coordinatorItems: coordinatorItems('INTEGRATION_CONFLICT', 9 * HOUR) }),
      });
      expect(attentionSectionOf(row, NOW)).not.toBe('attention');
    }
    // …and the same row is findable from the lane its activity earned.
    const running = project({
      buckets: { running: 1 },
      lastActivityAt: at(HOUR),
      attention: attention({ coordinatorItems: coordinatorItems('INTEGRATION_CONFLICT', 9 * HOUR) }),
    });
    expect(projectAttentionSections([running], NOW).find((s) => s.key === 'running')?.projects)
      .toEqual([running]);
  });

  it('draws exactly what it drew before when a server reports neither field', () => {
    // The negative control: this row is green on both sides of the change, which is what says the
    // new chips are the change and not the harness.
    const fresh = project({ buckets: { running: 1 }, lastActivityAt: at(HOUR) });
    const quiet = project({ buckets: { ready: 1 }, lastActivityAt: at(2 * QUIET_MS) });
    expect(attentionReasonOf(fresh, NOW)).toBeNull();
    expect(attentionChipOf(fresh, NOW)).toBeNull();
    expect(attentionSectionOf(fresh, NOW)).toBe('running');
    expect(attentionChipOf(quiet, NOW)).toEqual({ tone: 'warning', text: 'Ready · no activity 2d' });
  });
});

describe('owner reasons inside Needs attention', () => {
  it('puts all four above a user blocker, oldest wait first', () => {
    const blocker = project({
      title: 'Blocker',
      attention: attention({
        userBlockers: 1,
        maxSeverity: 'CRITICAL',
        attentionSinceAt: at(9 * QUIET_MS),
      }),
    });
    const merge = project({
      title: 'Merge',
      attention: attention({ ownerItems: [ownerItem('PROMOTION_APPROVAL', 1, 2 * HOUR)] }),
    });
    const question = project({
      title: 'Question',
      attention: attention({ ownerItems: [ownerItem('COORDINATOR_QUESTION', 1, 35 * MINUTE)] }),
    });
    const paused = project({
      title: 'Paused',
      attention: attention({ ownerItems: [ownerItem('FUSE_PAUSED', 1, 20 * MINUTE)] }),
    });
    const escalated = project({
      title: 'Escalated',
      attention: attention({ ownerItems: [ownerItem('ESCALATED', 2, 5 * HOUR)] }),
    });

    expect(
      orderWithinSection('attention', [blocker, question, merge, paused, escalated], NOW)
        .map((row) => row.title),
    ).toEqual(['Escalated', 'Merge', 'Question', 'Paused', 'Blocker']);
  });
});

describe('integrationChipOf', () => {
  it('marks a project branch, and states the line a project lands on directly', () => {
    const branch = project({ integration: { line: 'PROJECT_BRANCH', ref: 'project/bg-jobs' } });
    const main = project({ integration: { line: 'MAIN', ref: 'main' } });
    expect(integrationChipOf(branch)).toEqual({ branch: true, text: 'project/bg-jobs' });
    // Not printed as the word "main": a project whose upstream is called something else would be
    // told a branch name it does not merge into.
    expect(integrationChipOf(main)).toEqual({ branch: false, text: 'main' });
  });

  it('draws no line for a project that has not decided one, or a server that sends none', () => {
    expect(integrationChipOf(project())).toBeNull();
    expect(integrationChipOf(project({ integration: null }))).toBeNull();
  });
});

// The iPhone drawer's rows, spelled for the web sidebar: the same cases OrbitKit's
// ProjectAttentionTests holds `drawerProjects` / `drawerMark` to, so the two rails agree.
describe('the sidebar’s Projects group', () => {
  const DAY = 24 * HOUR;
  let n = 0;
  const row = (over: Partial<SidebarProject> = {}): SidebarProject => {
    n += 1;
    return {
      id: `0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`,
      title: `Project ${n}`,
      status: 'OPEN',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: at(HOUR),
      buckets: { running: 0 },
      attention: { ownerItems: [] },
      ...over,
    };
  };

  it('lists open projects waiting on you first, longest wait first, then by activity', () => {
    const question = row({
      title: 'Question',
      lastActivityAt: at(9 * DAY),
      attention: { ownerItems: [ownerItem('COORDINATOR_QUESTION', 1, HOUR)] },
    });
    const merge = row({ title: 'Merge', attention: { ownerItems: [ownerItem('PROMOTION_APPROVAL', 1, 3 * HOUR)] } });
    const recent = row({ title: 'Recent', buckets: { running: 1 }, lastActivityAt: at(MINUTE) });
    const stale = row({ title: 'Stale', lastActivityAt: at(5 * DAY) });
    const closed = row({ title: 'Closed', status: 'DONE', lastActivityAt: at(MINUTE) });

    expect(sidebarProjects([stale, closed, recent, question, merge]).map((p) => p.title)).toEqual([
      'Merge',
      'Question',
      'Recent',
      'Stale',
    ]);
    expect(projectNeedsYouCount(merge)).toBe(1);
    expect(projectIsWorking(recent)).toBe(true);
    expect(projectIsWorking(stale)).toBe(false);
  });

  it('counts the items waiting on you across kinds, not the kinds', () => {
    const busy = row({
      buckets: { running: 2 },
      attention: {
        ownerItems: [
          ownerItem('PROMOTION_APPROVAL', 1, HOUR),
          ownerItem('COORDINATOR_QUESTION', 2, MINUTE),
          // A kind a newer server names and this build cannot draw.
          ownerItem('SOMETHING_NEW' as OwnerItemKind, 4, HOUR),
        ],
      },
    });
    expect(projectNeedsYouCount(busy)).toBe(3);
    // The two marks answer different questions, so a project can carry both.
    expect(projectIsWorking(busy)).toBe(true);
  });

  it('counts nothing for a project that merely went quiet, or one that is closed', () => {
    expect(projectNeedsYouCount(row({ lastActivityAt: at(5 * DAY) }))).toBe(0);
    expect(
      projectNeedsYouCount(
        row({ status: 'DONE', attention: { ownerItems: [ownerItem('ESCALATED', 1, HOUR)] } }),
      ),
    ).toBe(0);
    expect(projectNeedsYouCount(row({ attention: null }))).toBe(0);
  });

  it('marks a project whose coordinator is working, and sorts it by the coordinator’s turn', () => {
    const busyTasks = row({ title: 'FineWeb', buckets: { running: 2 }, lastActivityAt: at(20 * MINUTE) });
    const coordinated = row({
      title: 'Claude 账号池',
      lastActivityAt: at(10 * DAY),
      coordinatorActivity: { working: true, lastTurnAt: at(MINUTE) },
    });
    const quiet = row({
      title: 'Quiet',
      lastActivityAt: at(HOUR),
      coordinatorActivity: { working: false, lastTurnAt: at(30 * DAY) },
    });

    expect(sidebarProjects([busyTasks, coordinated, quiet]).map((p) => p.title)).toEqual([
      'Claude 账号池',
      'FineWeb',
      'Quiet',
    ]);
    expect(projectIsWorking(coordinated)).toBe(true);
    // A coordinator waiting for a reply is not working.
    expect(projectIsWorking(quiet)).toBe(false);

    // A server that predates the field: task activity alone, as before.
    const older = [busyTasks, coordinated, quiet].map(({ coordinatorActivity: _, ...rest }) => rest);
    expect(sidebarProjects(older).map((p) => p.title)).toEqual(['FineWeb', 'Quiet', 'Claude 账号池']);
    expect(projectIsWorking(older[1])).toBe(false);
  });

  it('settles equal activity by the newer project, then by id, so the order never flickers', () => {
    const older = row({ title: 'Older', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = row({ title: 'Newer', createdAt: '2026-02-01T00:00:00.000Z' });
    expect(sidebarProjects([older, newer]).map((p) => p.title)).toEqual(['Newer', 'Older']);
    expect(sidebarProjects([newer, older]).map((p) => p.title)).toEqual(['Newer', 'Older']);
  });
});
