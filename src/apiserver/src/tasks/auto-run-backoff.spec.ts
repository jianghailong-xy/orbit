import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import {
  AUTO_RUN_RETRY_BACKOFF_MS,
  MAX_AUTO_RUN_FAILURES,
  TasksService,
} from './tasks.service';
import { TASK_OCCUPYING } from './reclaim-stalled-task';

interface FailureHistory {
  taskId: string;
  /** Failure count, when the failures' text doesn't matter. */
  failed?: number;
  /** `session.error` of each failed run, when it does (usage-limit filtering). */
  errors?: string[];
  lastFailedAt: Date;
}

interface Options {
  /** The provider every task's assignee derives — its last interactive session's. */
  provider?: string;
  /** `planUsage` the assignees' runner reports. */
  planUsage?: unknown;
}

/** Every task in these fixtures is assigned to the same workspace. */
const AGENT_ID = 'workspace-1';

type GroupByArgs = {
  where: {
    taskId: { in: string[] };
    NOT?: { OR?: Array<{ error: { contains: string } }> };
  };
};

/**
 * One OPEN, auto-run, runner-bound task per entry in `history` plus `readyTaskIds` with no
 * failures at all. READY is resolved in SQL now, so the candidate stub simply returns the rows
 * AUTO_RUN_READY_SQL would have selected — flat, the shape `$queryRaw` hands back; what these
 * tests exercise is everything the sweep decides *after* that. execute() records what it
 * dispatched.
 *
 * The session.groupBy stub honours the caller's exclusion filter rather than ignoring the
 * `where`, so a test can assert which failures are counted — that filter is the contract.
 */
function makeService(readyTaskIds: string[], history: FailureHistory[], options: Options = {}) {
  const taskIds = [...readyTaskIds, ...history.map((h) => h.taskId)];
  const executed: string[] = [];
  const prisma = {
    // Two raw queries reach this stub. The READY-task scan arrives as a tagged template (an
    // array of string parts); lastProviderByWorkspace — which the sweep now derives each task's
    // provider through, the column being gone — passes a Prisma.sql object. Telling them apart
    // by shape is what lets a test still say "these tasks run on codex" in one place.
    $queryRaw: async (q: unknown) =>
      Array.isArray(q)
        ? taskIds.map((id) => ({
            id,
            ownerId: 'owner-1',
            workspaceId: AGENT_ID,
            runnerId: 'runner-1',
          }))
        : [
            {
              workspace_id: AGENT_ID,
              provider: options.provider ?? 'codex',
              provider_builtin: true,
            },
          ],
    runner: {
      findMany: async () => [{ id: 'runner-1', planUsage: options.planUsage ?? null }],
    },
    session: {
      groupBy: async ({ where }: GroupByArgs) => {
        const excluded = (where.NOT?.OR ?? []).map((c) => c.error.contains.toLowerCase());
        const counted = (h: FailureHistory): number =>
          h.errors
            ? h.errors.filter((e) => !excluded.some((m) => e.toLowerCase().includes(m))).length
            : (h.failed ?? 0);
        return history
          .filter((h) => where.taskId.in.includes(h.taskId) && counted(h) > 0)
          .map((h) => ({
            taskId: h.taskId,
            _count: { _all: counted(h) },
            _max: { createdAt: h.lastFailedAt },
          }));
      },
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  (service as unknown as { execute: unknown }).execute = async (
    _ownerId: string,
    id: string,
  ) => {
    executed.push(id);
  };
  return { service, executed };
}

const sweep = (service: TasksService): Promise<void> =>
  (service as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

const agoMs = (ms: number): Date => new Date(Date.now() - ms);

// Verbatim from a FAILED session's `error` when the account's weekly quota was spent.
const QUOTA_ERROR =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to " +
  'purchase more credits or try again at Aug 9th, 2026 1:26 PM.';

// The runner's own snapshot with that same weekly limit spent.
const quotaExhausted = (provider: string, resetsAt: string) => ({
  provider,
  rateLimitReachedType: 'rate_limit_reached',
  primary: { label: 'Weekly limit', utilization: 100, resetsAt, windowDurationMins: 10080 },
});

const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

test('a ready task with no failed run is dispatched immediately', async () => {
  const { service, executed } = makeService(['task-fresh'], []);
  await sweep(service);
  assert.deepEqual(executed, ['task-fresh']);
});

test('a task is held off while inside the backoff window for its failure count', async () => {
  // One failed run 30s ago; the first backoff step is minutes, so this sweep must skip it.
  const { service, executed } = makeService(
    [],
    [{ taskId: 'task-just-failed', failed: 1, lastFailedAt: agoMs(30_000) }],
  );
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('a task is retried once its backoff window has elapsed', async () => {
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-cooled-down',
        failed: 1,
        lastFailedAt: agoMs(AUTO_RUN_RETRY_BACKOFF_MS[0] + 1_000),
      },
    ],
  );
  await sweep(service);
  assert.deepEqual(executed, ['task-cooled-down']);
});

test('backoff lengthens with each successive failure', async () => {
  // Three failures: still inside step [2], which the one-failure window would already clear.
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-failing',
        failed: 3,
        lastFailedAt: agoMs(AUTO_RUN_RETRY_BACKOFF_MS[0] + 1_000),
      },
    ],
  );
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('a task that burned through MAX_AUTO_RUN_FAILURES is never auto-run again', async () => {
  // Long past every backoff step — the cap, not the window, is what keeps it held.
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-exhausted',
        failed: MAX_AUTO_RUN_FAILURES,
        lastFailedAt: agoMs(24 * 60 * 60_000),
      },
    ],
  );
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('one failing task does not hold back its healthy neighbours', async () => {
  const { service, executed } = makeService(
    ['task-ok'],
    [{ taskId: 'task-blocked', failed: MAX_AUTO_RUN_FAILURES, lastFailedAt: agoMs(60_000) }],
  );
  await sweep(service);
  assert.deepEqual(executed, ['task-ok']);
});

test('a task is not dispatched while its provider quota is spent', async () => {
  const { service, executed } = makeService(['task-quota'], [], {
    provider: 'codex',
    planUsage: quotaExhausted('codex', inHours(140)),
  });
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('the quota gate applies only to the provider that is actually spent', async () => {
  // A claude-provider workspace on the same runner keeps running while codex is exhausted.
  const { service, executed } = makeService(['task-claude'], [], {
    provider: 'claude',
    planUsage: quotaExhausted('codex', inHours(140)),
  });
  await sweep(service);
  assert.deepEqual(executed, ['task-claude']);
});

test('the quota gate releases once the reported reset has passed', async () => {
  const { service, executed } = makeService(['task-quota'], [], {
    provider: 'codex',
    planUsage: quotaExhausted('codex', inHours(-1)),
  });
  await sweep(service);
  assert.deepEqual(executed, ['task-quota']);
});

test('quota-killed runs do not spend a task’s failure budget', async () => {
  // Far more quota failures than the cap, yet the task resumes the moment the window
  // resets: those runs say nothing about the task, so they are filtered out of the count.
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-only-quota-failures',
        errors: Array.from({ length: MAX_AUTO_RUN_FAILURES + 3 }, () => QUOTA_ERROR),
        lastFailedAt: agoMs(30_000),
      },
    ],
    { provider: 'codex', planUsage: quotaExhausted('codex', inHours(-1)) },
  );
  await sweep(service);
  assert.deepEqual(executed, ['task-only-quota-failures']);
});

test('a genuine failure still counts when quota failures are mixed in', async () => {
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-mixed',
        errors: [QUOTA_ERROR, QUOTA_ERROR, 'API Error: 500'],
        lastFailedAt: agoMs(30_000),
      },
    ],
    { provider: 'codex', planUsage: quotaExhausted('codex', inHours(-1)) },
  );
  await sweep(service);
  // One real failure 30s ago -> still inside the first backoff window.
  assert.deepEqual(executed, []);
});

test('the sweep selects candidates on all five READY conditions, anchored on a DONE prerequisite', async () => {
  let sql = '';
  const prisma = {
    $queryRaw: async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      sql = Prisma.sql(strings, ...(bound as never[])).text;
      return [];
    },
  } as never;
  await sweep(new TasksService(prisma, {} as never, {} as never));

  assert.match(sql, /t\.status = 'OPEN'::task_status/);
  assert.match(sql, /t\.auto_run_when_ready = true/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM workspace a[\s\S]*a\.runner_id IS NOT NULL\)/);
  assert.match(sql, /NOT EXISTS \([\s\S]*p\.status <> 'DONE'::task_status[\s\S]*\)/);
  // Load-bearing despite being logically implied by the two clauses around it: it is the only
  // selective entry point the planner has. Drop it and this once-a-minute sweep goes back to
  // hash-joining every dependency edge in the deployment (32ms -> 264ms on a 55k-edge database).
  assert.match(sql, /EXISTS \([\s\S]*p\.status = 'DONE'::task_status[\s\S]*\)/);
  // The occupied-session set is the wider TASK_OCCUPYING (incl. idle-but-live AWAITING_INPUT /
  // INTERRUPTED), not the two states the Ready tab's own predicate uses.
  assert.equal((sql.match(/::run_status/g) ?? []).length, TASK_OCCUPYING.length);
});
