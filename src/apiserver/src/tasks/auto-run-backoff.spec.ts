import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_RUN_RETRY_BACKOFF_MS,
  MAX_AUTO_RUN_FAILURES,
  QUOTA_BLIND_RETRY_BACKOFF_MS,
  TasksService,
} from './tasks.service';
import { TASK_OCCUPYING } from './reclaim-stalled-task';
import { recordingQueryRaw } from './query-raw-test-helper';

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
  /** Free bytes the assignee workspace's filesystem last reported; null = never measured. */
  freeBytes?: bigint | null;
  /** The runner's free-space floor in MB; null = no disk gate. */
  minFreeDiskMb?: number | null;
}

/** Every task in these fixtures is assigned to the same workspace. */
const AGENT_ID = 'workspace-1';

type ErrorClause = Array<{ error: { contains: string } }>;
type GroupByArgs = {
  where: {
    taskId: { in: string[] };
    /** Present on the usage-limit query: count only failures matching a marker. */
    OR?: ErrorClause;
    /** Present on the budget query: count only failures matching no marker. */
    NOT?: { OR?: ErrorClause };
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
            freeBytes: options.freeBytes ?? null,
            minFreeDiskMb: options.minFreeDiskMb ?? null,
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
        const included = (where.OR ?? []).map((c) => c.error.contains.toLowerCase());
        const excluded = (where.NOT?.OR ?? []).map((c) => c.error.contains.toLowerCase());
        // A `failed: n` fixture means n ordinary failures with no usage-limit wording, so it
        // stands in as n empty error strings — counted by the exclusion query, ignored by the
        // inclusion one. Modelling both directions is what lets a test assert that a quota
        // failure and a real failure are held back by different rules.
        const counted = (h: FailureHistory): number => {
          const errors = h.errors ?? Array.from({ length: h.failed ?? 0 }, () => '');
          return errors.filter((e) => {
            const lower = e.toLowerCase();
            return included.length
              ? included.some((m) => lower.includes(m))
              : !excluded.some((m) => lower.includes(m));
          }).length;
        };
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

// The hole these four close: planUsageBlockedUntil declines to block without a reported
// `resetsAt` on the grounds that "the caller's normal failure backoff" will handle it, while
// that backoff exempts usage-limit failures on the grounds that the gate will. Between the two,
// a quota the runner could not date re-dispatched a session every single sweep.
test('a usage-limit failure is held when the runner reports no quota to judge by', async () => {
  const { service, executed } = makeService(
    [],
    [{ taskId: 'task-blind-quota', errors: [QUOTA_ERROR], lastFailedAt: agoMs(30_000) }],
    // No planUsage at all: nothing says whether the window is still shut.
    { provider: 'codex' },
  );
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('the blind hold is flat, so the task returns on its own once it elapses', async () => {
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-blind-cooled',
        errors: [QUOTA_ERROR],
        lastFailedAt: agoMs(QUOTA_BLIND_RETRY_BACKOFF_MS + 1_000),
      },
    ],
    { provider: 'codex' },
  );
  await sweep(service);
  assert.deepEqual(executed, ['task-blind-cooled']);
});

test('a blind quota outage never retires a task, however many runs it killed', async () => {
  // The whole point of exempting quota failures from the budget: far past MAX_AUTO_RUN_FAILURES
  // and it still comes back, because none of those runs said anything about the task itself.
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-blind-many',
        errors: Array.from({ length: MAX_AUTO_RUN_FAILURES + 5 }, () => QUOTA_ERROR),
        lastFailedAt: agoMs(QUOTA_BLIND_RETRY_BACKOFF_MS + 1_000),
      },
    ],
    { provider: 'codex' },
  );
  await sweep(service);
  assert.deepEqual(executed, ['task-blind-many']);
});

test('a reported healthy quota dispatches at once — a snapshot is positive evidence', async () => {
  // Same fresh usage-limit failure as the blind case above, but here the runner does report the
  // provider's quota and nothing is exhausted. That report is what distinguishes "the window
  // reopened" from "we have no idea", and only the latter earns a hold.
  const { service, executed } = makeService(
    [],
    [{ taskId: 'task-quota-recovered', errors: [QUOTA_ERROR], lastFailedAt: agoMs(30_000) }],
    {
      provider: 'codex',
      planUsage: {
        provider: 'codex',
        primary: { label: 'Weekly limit', utilization: 4, resetsAt: inHours(72) },
      },
    },
  );
  await sweep(service);
  assert.deepEqual(executed, ['task-quota-recovered']);
});

test('a ready task is held when its workspace filesystem is under the runner floor', async () => {
  const { service, executed } = makeService(['task-on-full-disk'], [], {
    freeBytes: 200n * 1024n * 1024n,
    minFreeDiskMb: 1024,
  });
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('the disk gate lifts as soon as the reported headroom is back', async () => {
  // No reset time to wait out, unlike quota: space returns when somebody frees it, so the very
  // next sweep after a heartbeat reports headroom dispatches again.
  const { service, executed } = makeService(['task-disk-freed'], [], {
    freeBytes: 40n * 1024n * 1024n * 1024n,
    minFreeDiskMb: 1024,
  });
  await sweep(service);
  assert.deepEqual(executed, ['task-disk-freed']);
});

test('a runner that reports no disk figure is not gated on disk', async () => {
  // The fleet must not stop because a runner is too old to measure. Same fail-open rule the
  // quota gate follows for an unreported provider.
  const { service, executed } = makeService(['task-unmeasured'], [], {
    freeBytes: null,
    minFreeDiskMb: 1024,
  });
  await sweep(service);
  assert.deepEqual(executed, ['task-unmeasured']);
});

test('a held task is filtered out of the candidate scan, without reading its list', async () => {
  const raw = recordingQueryRaw();
  const prisma = {
    $queryRaw: raw.$queryRaw,
  } as never;
  await sweep(new TasksService(prisma, {} as never, {} as never));
  const sql = raw.statements[0].text;
  // In the scan, not only in execute(): a paused 500-task list would otherwise throw once per
  // task per minute for as long as the pause lasted.
  assert.match(sql, /t\.dispatch_hold = false/);
  // The point of the column. A stop spelled as a join to task_list is a stop that stops existing
  // when the list is deleted, and an unexpressible veto reads as permission — that is how 55,513
  // tasks kept running for a fortnight after their lists were deleted. Nothing in the permission
  // path may consult a row that can be deleted out from under it. Asserted on the executable SQL
  // rather than the raw string, which still names the old spelling in a comment explaining it.
  const executable = sql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(executable, /task_list/);
});

test('the sweep selects candidates on all five READY conditions, anchored on HAVING prerequisites', async () => {
  const raw = recordingQueryRaw();
  const prisma = {
    $queryRaw: raw.$queryRaw,
  } as never;
  await sweep(new TasksService(prisma, {} as never, {} as never));
  const sql = raw.statements[0].text;

  assert.match(sql, /t\.status = 'OPEN'::task_status/);
  assert.match(sql, /t\.auto_run_when_ready = true/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM workspace a[\s\S]*a\.runner_id IS NOT NULL\)/);
  // §13.6 SU9 now resolves the END of the supersession chain through the database function shared
  // with Run Now and the commit trigger. The double anti-join is load-bearing: NULL from a missing,
  // cross-owner, cyclic or over-depth chain finds no DONE row, so the edge remains unsatisfied.
  assert.match(
    sql,
    /NOT EXISTS \(\s*SELECT 1 FROM task_dependency dep[\s\S]*AND NOT EXISTS \(\s*SELECT 1\s*FROM task chain_task[\s\S]*chain_task\.id = task_dependency_tail_id\(dep\.depends_on_task_id\)[\s\S]*chain_task\.status = 'DONE'/,
  );
  // DONE is not enough while a verification epoch is open. Scope equality prevents another
  // tenant/project's check from inventing an epoch. The third clause here read an OPEN
  // `task_judgment_request` — the post-commit window in which a request existed but its verifier
  // task did not — and went with that table on 2026-09-02; a check is now the only thing that can
  // open an epoch, so there is no such window left.
  assert.match(sql, /epoch_any\."owner_id" = epoch_any_subject\."owner_id"/);
  assert.match(sql, /epoch_any\."project_id" IS NOT DISTINCT FROM epoch_any_subject\."project_id"/);
  assert.doesNotMatch(sql, /task_judgment_request/);
  assert.match(
    sql,
    /passed_request\."status" = 'DECIDED'[\s\S]*passed_request\."decision" = 'PASS'/,
  );
  // The legacy PASS route is fail-closed too: no occupying run, one successful task_done run, and
  // (inside a project) an applied verdict action are all required before it releases the edge.
  assert.match(
    sql,
    /NOT EXISTS \(\s*SELECT 1 FROM "session" passed_live[\s\S]*passed_live\."status"::text IN \('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'\)/,
  );
  assert.match(
    sql,
    /AND EXISTS \(\s*SELECT 1 FROM "session" passed_run[\s\S]*passed_run\."status"::text = 'SUCCEEDED'[\s\S]*passed_run\."end_reason" = 'task_done'/,
  );
  assert.match(
    sql,
    /epoch_check\."project_id" IS NULL OR EXISTS \(\s*SELECT 1 FROM "project_action" passed_action[\s\S]*passed_action\."status"::text = 'APPLIED'/,
  );
  // Load-bearing despite being logically implied by the two clauses around it: it is the only
  // selective entry point the planner has. Drop it and this once-a-minute sweep goes back to
  // hash-joining every dependency edge in the deployment (32ms -> 264ms on a 55k-edge database).
  // §13.6 SU9: the anchor is "this task HAS prerequisites", not "one of them is DONE". The second
  // was the same claim only while a DONE row was the only way to satisfy an edge; a chain tail
  // satisfies one now, and a task whose single prerequisite was replaced would pass the
  // satisfaction clause and fail the anchor — never selected, with nothing saying why.
  assert.match(sql, /EXISTS \(SELECT 1 FROM task_dependency d WHERE d\.task_id = t\.id\)/);
  // The occupied-session set is the wider TASK_OCCUPYING (incl. idle-but-live AWAITING_INPUT /
  // INTERRUPTED), not the two states the Ready tab's own predicate uses.
  assert.equal((sql.match(/::run_status/g) ?? []).length, TASK_OCCUPYING.length);
});
