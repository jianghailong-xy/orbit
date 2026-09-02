import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';
import { taskFenceConflictMessage } from './task-supersession';

/**
 * Real UUIDs, because the refusals name the task in Base62 and `uuidToBase62` rejects anything
 * else — a fixture with a readable id would fail inside the error message rather than in the gate.
 */
const uuid = (tag: string): string => `00000000-0000-4000-8000-${tag.padStart(12, '0')}`;
const PARENT = uuid('1');
const CHILD = uuid('2');
const LEAF = uuid('3');
const CHILDLESS = uuid('4');
const TASK = uuid('5');

/**
 * §13.1 AG6 at the manual and bulk doors.
 *
 * `TasksService.execute` is the choke point for Run Now, `task_start`, `orbit task start`, the
 * dependency-unlock trigger, the auto-run sweep, the scheduled sweep, the foreman sweep and the
 * verification filer. `batchExecute` is NOT one of its callers — it classifies and calls
 * `runWorkspaceOnTask` itself — so the rule has to be in both, and both are asserted here against
 * the real service rather than against the predicate they share.
 *
 * The database guards behind them (0132/0207) have their own coverage against real PostgreSQL;
 * what this file is about is that the two service
 * doors refuse BEFORE reaching it, so a person gets a sentence instead of a constraint violation.
 */

type Row = {
  id: string;
  title: string;
  completionPolicy: 'MANUAL' | 'ALL_CHILDREN_DONE' | 'VERIFICATION_PASSED';
  completionCriterion: 'EXECUTABLE' | 'VERIFICATION' | 'HUMAN_SIGNOFF';
  verifiesTaskId: string | null;
  children: Array<{ id: string }>;
  isForeman?: boolean;
};

function row(overrides: Partial<Row> & Pick<Row, 'id'>): Record<string, unknown> {
  return {
    title: `Task ${overrides.id}`,
    description: null,
    projectId: null,
    provider: null,
    model: null,
    status: 'OPEN',
    listId: null,
    isForeman: false,
    verifiesTaskId: null,
    dispatchHold: false,
    dispatchAuthority: 'LEGACY',
    runAt: null,
    supersededByTaskId: null,
    terminalReason: null,
    completionPolicy: 'MANUAL',
    completionCriterion: 'HUMAN_SIGNOFF',
    children: [],
    verifies: null,
    list: null,
    assignee: { id: 'workspace-1', runnerId: 'runner-1' },
    ...overrides,
  };
}

test('Run Now refuses a childless independent-verification subject', async () => {
  const { service, started } = serviceFor([
    row({
      id: TASK,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
      children: [],
    }),
  ]);
  await assert.rejects(
    () => service.execute('owner-1', TASK),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException, 'a readable 409, not a dispatched Session');
      assert.match(String((error as Error).message), /independent verifier/);
      return true;
    },
  );
  assert.deepEqual(started, []);
});

type Select = Record<string, unknown>;

/**
 * Project a fixture row through the caller's `select`, exactly as Prisma would.
 *
 * A double that ignores `select` and hands back the whole row is the reason a gate can look tested
 * and not be: drop `completionPolicy` from the production query and every assertion here still
 * passes, because the field was never actually being selected — it was being handed over anyway.
 * Projecting makes the fixture answer the question the production code actually asked.
 */
function project(row: Record<string, unknown>, select: Select | undefined): Record<string, unknown> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const [key, want] of Object.entries(select)) {
    if (!want) continue;
    out[key] = row[key];
  }
  return out;
}

/** A service whose only real behaviour is the gate under test; the dispatch itself is stubbed. */
function serviceFor(
  rows: Array<Record<string, unknown>>,
  options: { dispatch?: (id: string) => Promise<string> } = {},
) {
  const started: string[] = [];
  const selects: Select[] = [];
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findFirst: async ({ where, select }: { where: { id: string }; select?: Select }) => {
        selects.push(select ?? {});
        const row = rows.find((r) => r.id === where.id);
        return row ? project(row, select) : null;
      },
      findMany: async ({ select }: { select?: Select } = {}) => {
        selects.push(select ?? {});
        return rows.map((row) => project(row, select));
      },
      count: async () => 0,
    },
    taskDependency: { findMany: async () => [] },
    // A paused run's delivery is read by its own turn key before it is written (H2F).
    conversationTurn: { findUnique: async () => null },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null, findMany: async () => [] },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  (service as unknown as Record<string, unknown>).planWorkspaceRun =
    async (_o: string, task: { id: string }) =>
      ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${task.id}` });
  (service as unknown as Record<string, unknown>).applyWorkspaceRun =
    async (...args: unknown[]) => {
      const taskId = (args[1] as { id: string }).id;
      started.push(taskId);
      return options.dispatch ? options.dispatch(taskId) : `session-${taskId}`;
    };
  (service as unknown as Record<string, unknown>).buildExecutePrompt = () => 'prompt';
  (service as unknown as Record<string, unknown>).dependencyStatesFor =
    async (ids: string[]) => new Map(ids.map((taskId) => [taskId, 'NONE']));
  return { service, started, selects };
}

for (const policy of ['ALL_CHILDREN_DONE', 'VERIFICATION_PASSED'] as const) {
  test(`Run Now refuses an aggregate parent (${policy})`, async () => {
    const { service, started } = serviceFor([
      row({ id: PARENT, completionPolicy: policy, children: [{ id: CHILD }] }),
    ]);
    await assert.rejects(
      () => service.execute('owner-1', PARENT),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, 'a 409, not a 500 from a constraint');
        assert.match(String((error as Error).message), /aggregating its subtasks/);
        return true;
      },
    );
    assert.deepEqual(started, [], 'and no Session is started');
  });
}

test('an automatic caller STANDS DOWN on an aggregate parent rather than throwing', async () => {
  // Every automatic stand-down in `execute` is a skip, not an exception: a sweep that has nothing
  // to do must not look like a failure. The dispatch epoch is what the sweeps pass as `auto` — the
  // moment they selected this row under — and an unmoved row is at the epoch its seed gave it.
  const { service, started } = serviceFor([
    row({ id: PARENT, completionPolicy: 'ALL_CHILDREN_DONE', children: [{ id: CHILD }] }),
  ]);
  const result = await service.execute('owner-1', PARENT, { observedEpoch: 0n });
  assert.deepEqual(result, { ok: false, skipped: 'aggregate-parent' });
  assert.deepEqual(started, []);
});

test('Run Now still starts the three compatibility boundaries', async () => {
  const boundaries: Array<[string, Partial<Row>]> = [
    ['childless non-MANUAL', { completionPolicy: 'ALL_CHILDREN_DONE', children: [] }],
    ['MANUAL parent with children', { completionPolicy: 'MANUAL', children: [{ id: 'c' }] }],
    ['MANUAL foreman with children',
      { completionPolicy: 'MANUAL', children: [{ id: 'c' }], isForeman: true }],
  ];
  for (const [name, overrides] of boundaries) {
    const { service, started } = serviceFor([row({ id: TASK, ...overrides })]);
    await service.execute('owner-1', TASK);
    assert.deepEqual(started, [TASK], `${name} must still run`);
  }
});

test('bulk Run classifies an aggregate parent as skipped and still runs its siblings', async () => {
  const subject = uuid('6');
  const { service, started } = serviceFor([
    row({ id: PARENT, completionPolicy: 'ALL_CHILDREN_DONE', children: [{ id: LEAF }] }),
    row({
      id: subject,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
    }),
    row({ id: LEAF }),
    row({ id: CHILDLESS, completionPolicy: 'ALL_CHILDREN_DONE' }),
  ]);
  const result = await service.batchExecute('owner-1', [PARENT, subject, LEAF, CHILDLESS]);
  assert.deepEqual(started.sort(), [LEAF, CHILDLESS].sort(),
    'the work runs; only the roll-up node is held back');
  const skipped = result.skipped.find((s: { id: string }) => s.id === PARENT);
  assert.ok(skipped, 'and the parent is REPORTED, not silently dropped');
  assert.match(skipped!.reason, /aggregating its subtasks/);
  assert.match(
    result.skipped.find((item: { id: string }) => item.id === subject)?.reason ?? '',
    /Awaiting independent verification/,
  );
});

test("the database guard's refusals are translated into readable 409s, not 500s", () => {
  // The last line catches what every service pre-check missed: a genuinely concurrent write, or a
  // replica that predates the gates. Untranslated it surfaces as a raw `check_violation`.
  const cases: Array<[string, RegExp]> = [
    ['TASK_AGGREGATE_PARENT: task x is completed by aggregating', /aggregating its subtasks/],
    ['TASK_AGGREGATE_PARENT_ACTIVATION: task x is running work session y', /running work right now/],
    ['task_foreman_manual_policy', /coordinating \(foreman\) task/],
    ['TASK_AGGREGATE_PROJECT_BUSY: project x is being reconciled', /being reconciled right now/],
    ['TASK_AGGREGATE_PARENT_BUSY: this task\'s parent is being written', /parent is being written/],
    ['TASK_AGGREGATE_SCOPE_MOVED: a task involved in this write', /changed project/],
  ];
  for (const [message, expected] of cases) {
    const translated = taskFenceConflictMessage(new Error(message));
    assert.ok(translated, `${message} must be recognised`);
    assert.match(translated!, expected);
  }
  assert.equal(taskFenceConflictMessage(new Error('something else entirely')), null,
    'and anything unrecognised is rethrown untouched rather than relabelled');
});


for (const door of ['execute', 'batchExecute'] as const) {
  test(`${door} actually SELECTs every completion-owner fact the gate reads`, async () => {
    // The projection above only bites if the query asks for them, and this is the assertion that it
    // does. Without it, deleting `completionPolicy` from the production select would leave the gate
    // reading `undefined` — permanently permissive — with every behavioural test still green.
    const { service, selects } = serviceFor([row({ id: TASK })]);
    if (door === 'execute') await service.execute('owner-1', TASK);
    else await service.batchExecute('owner-1', [TASK]);
    const asked = selects.find((select) => 'completionPolicy' in select);
    assert.ok(asked, `${door} must select completionPolicy`);
    assert.equal(asked!.completionPolicy, true);
    assert.equal(asked!.completionCriterion, true);
    assert.equal(asked!.verifiesTaskId, true);
    assert.ok(asked!.children, `${door} must select children`);
  });
}

const DB_REFUSAL =
  'TASK_AGGREGATE_PARENT: task x is completed by aggregating its subtasks (ALL_CHILDREN_DONE)';

test('a DB refusal that beat the pre-check reaches the caller as a 409 through the service', async () => {
  // The pre-check passes — this row is a legal childless leaf — and the refusal comes from
  // migration 0132 inside the Session insert, which is the genuinely concurrent case. What is
  // asserted here is the SERVICE path (`runTaskWorkTranslatingFences`), not the helper it calls.
  const { service } = serviceFor(
    [row({ id: TASK, completionPolicy: 'ALL_CHILDREN_DONE', children: [] })],
    { dispatch: () => Promise.reject(new Error(DB_REFUSAL)) },
  );
  await assert.rejects(
    () => service.execute('owner-1', TASK),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException, 'a 409, not the raw check_violation');
      assert.match(String((error as Error).message), /aggregating its subtasks/);
      return true;
    },
  );
});

test('the same refusal in a bulk Run leaves the press retryable rather than falsely settled', async () => {
  // A refusal that BEAT the pre-check arrives with no artifact behind it, and a bulk Run's answer
  // is frozen for ever — so it cannot be written into one on the strength of an exception's text.
  // The press says so instead: nothing decided, nothing frozen, ask again. If this refusal is
  // genuinely permanent the next delivery meets it at the CLASSIFICATION, which is where a fact
  // about the row lives, rather than at the dispatch.
  const { service } = serviceFor(
    [row({ id: TASK, completionPolicy: 'ALL_CHILDREN_DONE', children: [] })],
    { dispatch: () => Promise.reject(new Error(DB_REFUSAL)) },
  );

  await assert.rejects(
    () => service.batchExecute('owner-1', [TASK]),
    (error: Error) => {
      const body = (error as unknown as { getResponse?: () => Record<string, unknown> })
        .getResponse?.() ?? {};
      assert.equal(body.code, 'TASK_RUN_REQUEST_UNSETTLED', `got: ${error.message}`);
      assert.equal(body.retryable, true);
      return true;
    },
  );
});

test('deleting a parent that loses the lock race is a 409, not a 500', async () => {
  // The FK's `ON DELETE SET NULL` rewrites every child's `parent_task_id`, which is a column the
  // shape guard is declared on — so an ordinary delete can be refused while a reconcile holds the
  // project. It is retryable and correct; untranslated it reads as a PostgreSQL error code.
  const busy = new Error(
    'TASK_AGGREGATE_PROJECT_BUSY: project x is being reconciled right now — nothing was written; retry',
  );
  // `remove` reads the task first (a real 404 path), then deletes.
  const service = new TasksService(
    {
      task: { findFirst: async () => ({ id: TASK, ownerId: 'owner-1' }) },
      $transaction: async () => { throw busy; },
    } as never,
    {} as never,
    {} as never,
  );
  (service as unknown as Record<string, unknown>).loadDetail = async () => ({ id: TASK });
  await assert.rejects(
    () => service.remove('owner-1', TASK),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException, 'a retryable 409, not a raw 500');
      assert.match(String((error as Error).message), /being reconciled right now/);
      return true;
    },
  );
});

test('the SQLSTATE extractor knows all three shapes this stack produces', async () => {
  const { postgresSqlState, isLockNotAvailable } = await import('./task-supersession.js');
  // The third one is the one that was missing, and it is the one production actually raises:
  // Prisma 7 with `@prisma/adapter-pg` sets `code = 'P2010'` and leaves `meta.code` UNSET, putting
  // the driver's SQLSTATE under `meta.driverAdapterError.cause`. A real-PostgreSQL test caught it —
  // every `FOR UPDATE NOWAIT` this process loses was escaping as an unhandled P2010.
  const shapes: Array<[string, unknown]> = [
    ['bare pg', { code: '55P03' }],
    ['prisma, pre-adapter', { code: 'P2010', meta: { code: '55P03' } }],
    ['prisma 7 adapter', {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '55P03', code: '55P03' } } },
    }],
  ];
  for (const [name, error] of shapes) {
    assert.equal(postgresSqlState(error), '55P03', name);
    assert.equal(isLockNotAvailable(error), true, name);
  }
  // `P2010` is Prisma's own wrapper code and must never be mistaken for a SQLSTATE.
  assert.equal(postgresSqlState({ code: 'P2010' }), null);
  assert.equal(postgresSqlState(new Error('nothing structured')), null);
  assert.equal(isLockNotAvailable({ code: '40001' }), false, 'a different state is a different answer');
});
