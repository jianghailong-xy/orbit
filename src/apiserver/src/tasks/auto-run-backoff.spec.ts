import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanUsageSnapshot } from '@orbit/shared';
import {
  AUTO_RUN_RETRY_BACKOFF_MS,
  MAX_AUTO_RUN_FAILURES,
  QUOTA_BLIND_RETRY_BACKOFF_MS,
  TasksService,
} from './tasks.service';
import { QueueService } from '../queue/queue.service';
import { TASK_OCCUPYING } from './reclaim-stalled-task';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { recordingQueryRaw } from './query-raw-test-helper';

interface FailureHistory {
  taskId: string;
  /** Failure count, when the failures' text doesn't matter. */
  failed?: number;
  /** `session.error` of each failed run, when it does (usage-limit filtering); null records none. */
  errors?: Array<string | null>;
  lastFailedAt: Date;
}

interface Options {
  /** The provider every task's assignee derives — its last interactive session's. */
  provider?: string;
  /** `planUsage` the assignees' runner reports. */
  planUsage?: unknown;
  /** The owner's account pool on POOL, one member per entry: the quota its cache reports, null for none. */
  pool?: Array<PlanUsageSnapshot | null>;
  /** Free bytes the assignee workspace's filesystem last reported; null = never measured. */
  freeBytes?: bigint | null;
  /** The runner's free-space floor in MB; null = no disk gate. */
  minFreeDiskMb?: number | null;
  /** `engines` the assignees' runner reports: which Codex accounts it has. */
  engines?: unknown;
  /** The assignee workspace's env; null = none, so its Codex runs are Default's. */
  workspaceEnv?: Record<string, string> | null;
  /** The Codex account the assignee workspace picked; null = none. */
  codexAccount?: string | null;
}

/** Every task in these fixtures is assigned to the same workspace. */
const AGENT_ID = 'workspace-1';

const POOL = 'work-pool';

/**
 * The claim service over `owner-1`'s account pool on POOL, one member per snapshot (null: that member
 * reports none). Only the pool's rows and the quota cache are stood in for.
 */
function poolQueue(members: Array<PlanUsageSnapshot | null>): QueueService {
  const rows = members.map((usage, i) => ({ id: `member-${i}`, slug: `anthropic-${i}`, enabled: true, usage }));
  const prisma = {
    providerPool: {
      findFirst: async ({ where }: { where: { slug: string; ownerId: string } }) =>
        where.slug === POOL && where.ownerId === 'owner-1'
          ? { members: rows.map((provider) => ({ provider })) }
          : null,
    },
  };
  const planUsage = { snapshot: (row: (typeof rows)[number]) => row.usage, refused: () => false };
  return new QueueService(prisma as never, {} as never, planUsage as never);
}

type ErrorClause = Array<{ error: { contains: string } }>;
type GroupByArgs = {
  where: {
    taskId: { in: string[] };
    /**
     * The usage-limit query: count only failures matching a marker. The budget query: count a
     * failure that recorded no error text, or one matching no marker.
     */
    OR?: Array<{ error: { contains: string } | null } | { NOT: { OR: ErrorClause } }>;
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
    // Three raw queries reach this stub. The two candidate scans arrive as tagged templates;
    // lastProviderByWorkspace — which the sweep now derives each task's provider through, the
    // column being gone — passes a composed Prisma.sql. Told apart through the shared renderer, so
    // that a double answers by what was ASKED rather than by which calling convention carried it.
    //
    // The independent scan — a coordinated project's tasks that depend on nothing — selects
    // nothing here, and that is this world rather than a convenience: these fixtures have no
    // projects at all, so no row of theirs could pass a predicate that joins one. Answering it
    // with the READY rows would hand the sweep every task twice.
    $queryRaw: async (...args: unknown[]) => {
      const query = renderRawQuery(args);
      if (query.shape !== 'tagged-template') {
        return [
          {
            workspace_id: AGENT_ID,
            provider: options.provider ?? 'codex',
            provider_builtin: true,
          },
        ];
      }
      if (query.text.includes('coordinator_enabled')) return [];
      return taskIds.map((id) => ({
        id,
        ownerId: 'owner-1',
        workspaceId: AGENT_ID,
        runnerId: 'runner-1',
        freeBytes: options.freeBytes ?? null,
        minFreeDiskMb: options.minFreeDiskMb ?? null,
      }));
    },
    runner: {
      findMany: async () => [
        { id: 'runner-1', planUsage: options.planUsage ?? null, engines: options.engines ?? null },
      ],
    },
    // Read for the Codex account a task's run spends, which is its workspace's to say.
    workspace: {
      findMany: async () => [
        { id: AGENT_ID, env: options.workspaceEnv ?? null, codexAccount: options.codexAccount ?? null },
      ],
    },
    session: {
      groupBy: async ({ where }: GroupByArgs) => {
        const clauses = where.OR ?? [];
        const included = clauses.flatMap((c) =>
          'error' in c && c.error ? [c.error.contains.toLowerCase()] : []);
        const excluded = clauses.flatMap((c) =>
          'NOT' in c ? c.NOT.OR.map((m) => m.error.contains.toLowerCase()) : []);
        // A NULL `error` matches no marker, and a negated match is not true of it either — so a
        // query counts one only when it says so.
        const countsNoText = clauses.some((c) => 'error' in c && c.error === null);
        // A `failed: n` fixture means n ordinary failures with no usage-limit wording, so it
        // stands in as n empty error strings — counted by the exclusion query, ignored by the
        // inclusion one. Modelling both directions is what lets a test assert that a quota
        // failure and a real failure are held back by different rules.
        const counted = (h: FailureHistory): number => {
          const errors = h.errors ?? Array.from({ length: h.failed ?? 0 }, () => '');
          return errors.filter((e) => {
            if (e === null) return countsNoText;
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
  const service = new TasksService(
    prisma,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.pool ? poolQueue(options.pool) : undefined,
  );
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

/**
 * The dependency scan's SQL among what a sweep sent, found by what it selects rather than by its
 * position: the pass opens with the retry policy's read of ended runs (rearmEndedAutoRuns), which
 * reads a different shape and starts nothing itself.
 */
const candidateScan = (statements: Array<{ text: string }>): string => {
  const scan = statements.find((statement) => statement.text.includes('work_dir_free_bytes'));
  assert.ok(scan, `no candidate scan among the sweep's ${statements.length} statements`);
  return scan.text;
};

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

test('a failed run that recorded no error text still counts toward the backoff', async () => {
  // The runner's /finalize omits `error` when its engine died without a message. A NULL matches no
  // usage-limit marker, so it is an ordinary failure — and a budget query that only negated the
  // markers would not count it, leaving exactly these runs retried every minute.
  const { service, executed } = makeService(
    [],
    [{ taskId: 'task-silent-failure', errors: [null], lastFailedAt: agoMs(30_000) }],
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

test('the quota gate judges the Codex account the workspace runs on, never Default for all of them', async () => {
  // One runner, two Codex accounts: Default, and Work in a slot of its own.
  const workHome = '/root/.orbit/codex-accounts/3fa91c2e';
  const engines = [
    {
      engine: 'codex',
      installed: true,
      auth: 'yes',
      accounts: [
        { id: 'default', codexHome: '/root/.codex', auth: 'yes' },
        { id: '3fa91c2e', name: 'Work', codexHome: workHome, auth: 'yes' },
      ],
    },
  ];
  const room = { provider: 'codex', primary: { utilization: 8, resetsAt: inHours(3), windowDurationMins: 300 } };
  const run = async (planUsage: unknown, workspaceEnv: Record<string, string> | null, codexAccount: string | null = null) => {
    const { service, executed } = makeService(['task'], [], { provider: 'codex', planUsage, engines, workspaceEnv, codexAccount });
    await sweep(service);
    return executed;
  };

  const defaultSpent = { ...quotaExhausted('codex', inHours(140)), accounts: { '3fa91c2e': room } };
  assert.deepEqual(await run(defaultSpent, null), [], 'a task on Default waits for Default');
  assert.deepEqual(await run(defaultSpent, { CODEX_HOME: workHome }), ['task'], "Default's spent quota does not hold back Work");
  // A workspace that picked Work runs there, as dispatch runs it; a pick this runner does not
  // report runs on Default.
  assert.deepEqual(await run(defaultSpent, null, '3fa91c2e'), ['task'], 'nor a workspace that picked Work');
  assert.deepEqual(await run(defaultSpent, null, 'c0ffee42'), [], 'a pick the runner does not report waits for Default');

  const workSpent = { ...room, accounts: { '3fa91c2e': quotaExhausted('codex', inHours(140)) } };
  assert.deepEqual(await run(workSpent, { CODEX_HOME: workHome }), [], 'a task on Work waits for Work');
  assert.deepEqual(await run(workSpent, null), ['task'], "Work's spent quota does not hold back Default");
  assert.deepEqual(await run(workSpent, null, '3fa91c2e'), [], 'a workspace that picked Work waits for Work');
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

// An account pool's slug is in no runner's snapshot. Read as one, it was blind: held a flat
// QUOTA_BLIND_RETRY_BACKOFF_MS after any member ran out, and never blocked once all of them had.
const quotaGate = (service: TasksService, id: string) =>
  (service as unknown as {
    quotaGate(tasks: unknown[]): Promise<{ blocked: Map<string, Date>; blind: Set<string> }>;
  }).quotaGate([
    { id, ownerId: 'owner-1', assignee: { provider: POOL, runnerId: 'runner-1', workspaceId: AGENT_ID } },
  ]);

test('an account pool with room on a member is neither blocked nor backed off after another ran out', async () => {
  const { service, executed } = makeService(
    [],
    [{ taskId: 'task-pool-room', errors: [QUOTA_ERROR], lastFailedAt: agoMs(30_000) }],
    {
      provider: POOL,
      pool: [
        { fiveHour: { utilization: 100, resetsAt: inHours(3) } },
        { fiveHour: { utilization: 20, resetsAt: inHours(4) } },
      ],
    },
  );
  const { blocked, blind } = await quotaGate(service, 'task-pool-room');
  assert.deepEqual([...blocked], [], 'one spent member is not a spent pool');
  assert.deepEqual([...blind], [], 'a member reporting room is something to go by');
  await sweep(service);
  assert.deepEqual(executed, ['task-pool-room'], 'dispatched at once; the claim takes it to the member with room');
});

test('an account pool with every member spent stays held, until the EARLIEST member reset', async () => {
  const sooner = inHours(1);
  const { service, executed } = makeService(['task-pool-spent'], [], {
    provider: POOL,
    pool: [
      { fiveHour: { utilization: 100, resetsAt: inHours(3) } },
      { fiveHour: { utilization: 100, resetsAt: sooner } },
    ],
  });
  const { blocked } = await quotaGate(service, 'task-pool-spent');
  assert.deepEqual(
    [...blocked],
    [['task-pool-spent', new Date(sooner)]],
    'one account freeing up is enough to go on, unlike one account waiting for all its windows',
  );
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('an account pool no member reports on keeps the quota-blind backoff', async () => {
  const { service, executed } = makeService(
    [],
    [{ taskId: 'task-pool-blind', errors: [QUOTA_ERROR], lastFailedAt: agoMs(30_000) }],
    { provider: POOL, pool: [null, null] },
  );
  const { blocked, blind } = await quotaGate(service, 'task-pool-blind');
  assert.deepEqual([...blocked], []);
  assert.deepEqual([...blind], ['task-pool-blind'], 'no member reporting is not room');
  await sweep(service);
  assert.deepEqual(executed, [], 'held for QUOTA_BLIND_RETRY_BACKOFF_MS, as any quota nobody reports');
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
  const sql = candidateScan(raw.statements);
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

test('the sweep selects candidates on all five READY conditions, anchored on a prerequisite that can satisfy the edge', async () => {
  const raw = recordingQueryRaw();
  const prisma = {
    $queryRaw: raw.$queryRaw,
  } as never;
  await sweep(new TasksService(prisma, {} as never, {} as never));
  const sql = candidateScan(raw.statements);

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
  assert.match(sql, /epoch_check\."verdict" = 'PASS'/);
  // The PASS route — the only one left — is fail-closed: no occupying run and one successful
  // task_done run before it releases the edge. It no longer waits for an applied verdict action:
  // the control loop that wrote those is gone, so inside a project that clause never released.
  assert.match(
    sql,
    /NOT EXISTS \(\s*SELECT 1 FROM "session" passed_live[\s\S]*passed_live\."status"::text IN \('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'\)/,
  );
  assert.match(
    sql,
    /AND EXISTS \(\s*SELECT 1 FROM "session" passed_run[\s\S]*passed_run\."status"::text = 'SUCCEEDED'[\s\S]*passed_run\."end_reason" = 'task_done'/,
  );
  // Load-bearing, and the SHAPE is the whole of why: this is where the plan enters the
  // deployment's dependency graph, or nowhere. "HAS an edge" is 110,872 edges over 110,502 tasks
  // on the deployment this was measured against, and it made the planner evaluate the SU9 chain
  // walk once per edge — 109,732 correlated task_dependency_tail_id calls, 8.2s of a 10.4s sweep,
  // with the hash it built to drive them spilling 11 MB per sweep. Anchored on the prerequisites a
  // satisfied edge can actually NAME it enters through ~1.5k tasks instead: 117ms, no spill.
  // §13.6 SU9: the anchor is not "one of them is DONE" either. That was the same claim only while
  // a DONE row was the only way to satisfy an edge; a task whose single prerequisite was replaced
  // would pass the satisfaction clause and fail a DONE-only anchor — never selected, with nothing
  // saying why. A retired prerequisite is in the anchor for exactly that case, and it is not a
  // narrowing of the clause below: the tail is the named row precisely when that row is DONE and
  // still holds its own work, and the successor's when it does not.
  assert.match(
    sql,
    /AND EXISTS \(\s*SELECT 1 FROM task_dependency d\s+JOIN task x ON x\.id = d\.depends_on_task_id\s+WHERE d\.task_id = t\.id\s+AND \(x\.status = 'DONE'::task_status OR NOT \(x\."terminal_reason" IS NULL AND x\."superseded_by_task_id" IS NULL\)\)/,
  );
  // The occupied-session set is the wider TASK_OCCUPYING (incl. idle-but-live AWAITING_INPUT /
  // INTERRUPTED), not the two states the Ready tab's own predicate uses.
  assert.equal((sql.match(/::run_status/g) ?? []).length, TASK_OCCUPYING.length);
});
