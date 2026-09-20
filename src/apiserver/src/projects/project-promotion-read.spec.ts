import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import { ProjectPromotionService } from './project-promotion.service';
import type { ProjectPromotionView } from './project-promotion';

/**
 * The read model the confirmation card is drawn from (§3.6), computed from the rows it is made of.
 *
 * What is worth a spec here is everything a reader of the card cannot check by looking at it: the
 * titles the Tasks row lists and the order it lists them in, which landing counts as "main was last
 * absorbed into the branch", and the typical a re-check in flight is measured against. The card
 * that draws these facts is `src/web/src/components/ProjectPromotionCard.test.tsx`; the two meet in
 * `ProjectPromotionView`, which is why the same facts are asserted on both sides of the wire.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A promotion row as `PROMOTION_COLUMNS` selects one, with everything this spec does not vary. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '3fFMHLbE7JTsr3vHFOzIDM',
    projectId: 'project-1',
    ownerId: 'owner-1',
    codebaseId: 'codebase-1',
    sourceKind: 'PROJECT_BRANCH',
    taskId: null,
    sessionId: null,
    sourceRef: 'refs/heads/project/bg-jobs',
    sourceSha: 'a'.repeat(40),
    upstreamRef: 'refs/heads/main',
    upstreamShaChecked: 'b'.repeat(40),
    mergeTreeSha: 'c'.repeat(40),
    includedTaskIds: ['task-1', 'task-2'],
    commitsAhead: 7,
    filesChanged: 18,
    checks: [],
    conflicts: [],
    state: 'READY',
    checkJobId: null,
    landJobId: null,
    confirmedByUserId: null,
    confirmedAt: null,
    recheckedAt: null,
    upstreamMovedBy: null,
    decidedAt: null,
    mergedSha: null,
    mergedAt: null,
    openItemId: null,
    receiptIds: [],
    createdAt: new Date('2026-09-13T10:00:00.000Z'),
    updatedAt: new Date('2026-09-13T10:00:00.000Z'),
    ...over,
  };
}

/** Records what each read asked for, so a query that answers the wrong question can be seen. */
interface Reads {
  sync?: Record<string, unknown>;
  runs?: Record<string, unknown>;
  tasks?: Record<string, unknown>;
}

/**
 * A promotion row, the tasks it carries, and the jobs that say when the branch last absorbed main
 * and how long its checks take. The rows are handed back in whatever order the stub holds them,
 * which is what makes "in `includedTaskIds` order" and "the newest first" things this spec can see.
 */
function prismaStub(
  over: {
    promotion?: Record<string, unknown>;
    tasks?: Array<{ id: string; title: string }>;
    syncAt?: Date | null;
    /** The finished checks of this project, newest first, as how long each one took in ms. */
    runs?: number[];
    reads?: Reads;
  } = {},
): PrismaService {
  const reads: Reads = over.reads ?? {};
  const tx = {
    projectPromotion: {
      findFirst: async () => row(over.promotion),
      updateMany: async () => ({ count: 1 }),
      update: async () => row(over.promotion),
    },
    projectCodebase: { findUnique: async () => ({ canonicalRepoUrl: 'git@example.com:repo.git' }) },
    projectIntegrationJob: {
      aggregate: async () => ({ _max: { generation: 0 } }),
      createManyAndReturn: async () => [{ id: 'job-1' }],
    },
    projectOpenItem: { updateMany: async () => ({ count: 0 }) },
  };
  return {
    projectPromotion: { findFirst: async () => row(over.promotion) },
    task: {
      findMany: async (args: Record<string, unknown>) => {
        reads.tasks = args;
        return over.tasks ?? [];
      },
    },
    projectIntegrationJob: {
      findFirst: async (args: Record<string, unknown>) => {
        reads.sync = args;
        return over.syncAt === undefined || over.syncAt === null
          ? null
          : { finishedAt: over.syncAt };
      },
      findMany: async (args: Record<string, unknown>) => {
        reads.runs = args;
        const base = Date.parse('2026-09-13T09:00:00.000Z');
        return (over.runs ?? []).map((durationMs, index) => ({
          startedAt: new Date(base + index * 10 * MINUTE),
          finishedAt: new Date(base + index * 10 * MINUTE + durationMs),
        }));
      },
    },
    project: { findFirst: async () => ({ ownerId: 'owner-1' }) },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;
}

async function current(
  over: Parameters<typeof prismaStub>[0] = {},
): Promise<ProjectPromotionView | null> {
  return new ProjectPromotionService(prismaStub(over)).readCurrent('owner-1', 'project-1');
}

test('the Tasks row carries the titles of what this merge would bring, in the row’s own order', async () => {
  const view = await current({
    // The database is free to hand these back in any order; the row's own order is what the card
    // lists, because that is the order the merge will carry them in.
    promotion: { includedTaskIds: ['task-2', 'task-1'] },
    tasks: [
      { id: 'task-1', title: 'warmEngineTTL 改回 4 小时' },
      { id: 'task-2', title: 'runner 托管作业在 session 结束路径上被杀仍无终态事件' },
    ],
  });

  assert.deepEqual(view?.tasks, [
    { taskId: 'task-2', title: 'runner 托管作业在 session 结束路径上被杀仍无终态事件' },
    { taskId: 'task-1', title: 'warmEngineTTL 改回 4 小时' },
  ]);
  // The ids alone are still served: the native mirror counts the tasks it would merge from them.
  assert.deepEqual(view?.taskIds, ['task-2', 'task-1']);
});

test('a task the candidate names but the table no longer holds is not given a title', async () => {
  const view = await current({
    promotion: { includedTaskIds: ['task-1', 'gone'] },
    tasks: [{ id: 'task-1', title: 'warmEngineTTL 改回 4 小时' }],
  });

  assert.deepEqual(view?.tasks, [{ taskId: 'task-1', title: 'warmEngineTTL 改回 4 小时' }]);
});

test('main was last synced when the branch last absorbed it, not when a check ran', async () => {
  const reads: Reads = {};
  const syncedAt = new Date('2026-09-13T11:48:00.000Z');
  const view = await current({ syncAt: syncedAt, reads });

  assert.deepEqual(view?.upstream.syncedAt, syncedAt);
  // The row the card reads is a LANDING that had to absorb the upstream (M1); a check job that ran
  // without syncing anything says nothing about when main was last taken in.
  assert.equal(reads.sync?.where && (reads.sync.where as Record<string, unknown>).state, 'LANDED');
  assert.deepEqual(
    (reads.sync?.where as Record<string, unknown>).mainSyncSha,
    { not: null },
  );
});

test('a branch that has never absorbed main says so rather than inventing an instant', async () => {
  const view = await current({ syncAt: null });
  assert.equal(view?.upstream.syncedAt, null);
});

test('a candidate whose merge conflicted says so, and still names the paths', async () => {
  const view = await current({
    promotion: { state: 'BLOCKED', conflicts: ['src/runner-go/session_pool.go'] },
  });

  assert.equal(view?.upstream.conflicts, true);
  assert.deepEqual(view?.conflicts, ['src/runner-go/session_pool.go']);
});

test('a re-check carries how far main moved and how long one usually takes', async () => {
  const startedAt = new Date('2026-09-13T11:58:00.000Z');
  const view = await current({
    promotion: { state: 'RECHECKING', recheckedAt: startedAt, upstreamMovedBy: 1 },
    // The checks this project has finished, newest first.
    runs: [6 * MINUTE + 12_000, 5 * MINUTE, 2 * HOUR],
  });

  assert.deepEqual(view?.recheck, {
    upstreamMovedBy: 1,
    startedAt,
    // The middle of the three, so the card says `~6m` rather than the last run's hour.
    typicalMs: 6 * MINUTE + 12_000,
  });
});

test('the typical comes from this project’s own finished checks, newest first', async () => {
  const reads: Reads = {};
  await current({ promotion: { state: 'RECHECKING', recheckedAt: new Date() }, runs: [MINUTE], reads });

  assert.equal(reads.runs?.where && (reads.runs.where as Record<string, unknown>).kind, 'CHECK_PROMOTION');
  assert.equal(
    reads.runs?.where && (reads.runs.where as Record<string, unknown>).projectId,
    'project-1',
  );
  assert.deepEqual(reads.runs?.orderBy, { finishedAt: 'desc' });
});

test('a re-check nothing has been measured for yet says less, not zero', async () => {
  const startedAt = new Date('2026-09-13T11:58:00.000Z');
  const view = await current({
    promotion: { state: 'RECHECKING', recheckedAt: startedAt, upstreamMovedBy: null },
    runs: [],
  });

  assert.deepEqual(view?.recheck, { upstreamMovedBy: null, startedAt, typicalMs: null });
});

test('a candidate that is not being re-checked carries no re-check at all', async () => {
  const view = await current({
    promotion: { state: 'CONFIRMED', recheckedAt: new Date('2026-09-13T11:58:00.000Z') },
    runs: [6 * MINUTE],
  });

  assert.equal(view?.recheck, null);
});

test('the answer to a confirmation is the same rows the card was drawn from', async () => {
  const tasks = [
    { id: 'task-1', title: '后台作业不再阻塞 merge/commit，merge/commit 前也不驱逐 engine' },
    { id: 'task-2', title: 'runner 发版重启杀掉 runner 托管作业：有的记成 drain_cap' },
  ];
  const service = new ProjectPromotionService(
    prismaStub({ promotion: { includedTaskIds: ['task-1', 'task-2'] }, tasks, syncAt: null }),
  );

  const card = await service.readCurrent('owner-1', 'project-1');
  const answer = await service.confirm({ userId: 'owner-1' }, 'project-1', '3fFMHLbE7JTsr3vHFOzIDM');

  // Two doors onto one candidate (§3.4 M-F3): a card drawn after the press must not describe the
  // merge differently from the card that was pressed, so both answer with the same read model.
  assert.deepEqual(answer.tasks, card?.tasks);
  assert.deepEqual(answer.upstream, card?.upstream);
  assert.deepEqual(answer.tasks, [
    { taskId: 'task-1', title: '后台作业不再阻塞 merge/commit，merge/commit 前也不驱逐 engine' },
    { taskId: 'task-2', title: 'runner 发版重启杀掉 runner 托管作业：有的记成 drain_cap' },
  ]);
});
