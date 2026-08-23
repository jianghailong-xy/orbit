import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';

const OWNER = '00000000-0000-7000-8000-000000000801';
const PROJECT_A = '00000000-0000-7000-8000-000000000802';
const PROJECT_B = '00000000-0000-7000-8000-000000000803';

function runnableTask(id: string, projectId: string) {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    projectId,
    provider: null,
    model: null,
    status: 'OPEN',
    listId: null,
    list: null,
    isForeman: false,
    verifiesTaskId: null,
    dispatchHold: false,
    runAt: null,
    // §13.1 AG6's two facts. Every task in this fixture is an ordinary leaf; the
    // aggregate-parent gate has its own coverage in `task-aggregate-parent-execute.spec.ts`.
    completionPolicy: 'MANUAL',
    children: [],
    assignee: { id: `workspace-${id}`, runnerId: 'runner-1' },
  };
}

function eventFixture(tasks: ReturnType<typeof runnableTask>[]) {
  /** Every statement the trigger transaction issues, in order — the pre-locks included. */
  const statements: Prisma.Sql[] = [];
  let transactions = 0;
  const tx = {
    $executeRaw: async (query: Prisma.Sql) => {
      statements.push(query);
      return 1;
    },
  };
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findFirst: async () => tasks[0] ?? null,
      findMany: async () => tasks,
    },
    taskDependency: { findMany: async () => [] },
    // A paused run's delivery is read by its own turn key before it is written (H2F).
    conversationTurn: { findUnique: async () => null },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
    },
    $transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      return run(tx);
    },
  } as never;
  const sessions = { create: async () => ({ id: 'session-1' }) } as never;
  const service = new TasksService(prisma, sessions, {} as never);
  return {
    service,
    statements,
    /**
     * Just the enqueues. The transaction now opens with the canonical pre-locks — `user` (10),
     * every distinct `project` (40) in one id-ordered statement, then the audited `task` (50) —
     * and writes the press's effect marker before each enqueue, because 0117's dedupe key is
     * unique only while an event is unconsumed. `lockOrder` below asserts that sequence; this
     * keeps the "one request per distinct Project" assertions about the requests themselves.
     */
    eventWrites: () => statements.filter((q) => q.strings.join('').includes('project_event_manual_trigger')),
    lockOrder: () => statements.map((q) => {
      const sql = q.strings.join('');
      if (/FROM "user"/.test(sql)) return 'user';
      if (/FROM "project"/.test(sql)) return 'project';
      if (/FROM "task"/.test(sql)) return 'task';
      if (/INSERT INTO "task_run_manual_trigger"/.test(sql)) return 'marker';
      if (/project_event_manual_trigger/.test(sql)) return 'enqueue';
      return 'other';
    }),
    transactions: () => transactions,
  };
}

test('manual Project task starts persist a request before dispatch; automatic starts do not', async () => {
  const manual = eventFixture([runnableTask('task-1', PROJECT_A)]);
  await manual.service.execute(OWNER, 'task-1');

  assert.equal(manual.transactions(), 1);
  assert.equal(manual.eventWrites().length, 1);
  assert.deepEqual(manual.eventWrites()[0].values.slice(0, 2), [PROJECT_A, OWNER]);
  // The canonical order, taken explicitly before anything implicit: 0137's marker insert has three
  // foreign keys and PostgreSQL checks them in its own order, which is not user (10) -> project
  // (40) -> task (50). Taking them up front leaves each FK re-using a lock already held.
  assert.deepEqual(manual.lockOrder(), ['user', 'project', 'task', 'marker', 'enqueue']);

  const automatic = eventFixture([runnableTask('task-1', PROJECT_A)]);
  await automatic.service.execute(OWNER, 'task-1', { observedEpoch: 0n });

  assert.equal(automatic.transactions(), 0);
  assert.equal(automatic.eventWrites().length, 0);
});

test('one bulk Run writes one manual request per distinct affected Project in one transaction', async () => {
  const fixture = eventFixture([
    runnableTask('task-1', PROJECT_A),
    runnableTask('task-2', PROJECT_A),
    runnableTask('task-3', PROJECT_B),
  ]);
  // The door PLANS and then APPLIES (H2F): planning reads the mutable world, applying carries out
  // the plan the receipt froze. Both seams are stubbed so what was dispatched stays observable.
  const seams = fixture.service as unknown as Record<string, unknown>;
  seams.planWorkspaceRun = async (_o: string, task: { id: string }) =>
    ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${task.id}` });
  seams.applyWorkspaceRun = async () => 'session-1';

  const result = await fixture.service.batchExecute(OWNER, ['task-1', 'task-2', 'task-3']);

  assert.equal(result.dispatched, 3);
  assert.equal(fixture.transactions(), 1);
  assert.deepEqual(
    fixture.eventWrites().map((query) => query.values.slice(0, 2)),
    [
      [PROJECT_A, OWNER],
      [PROJECT_B, OWNER],
    ],
  );
  // One press, one marker and one enqueue per Project, and the projects are locked in ONE ordered
  // statement rather than interleaved project/task/project with another press going the other way.
  assert.deepEqual(
    fixture.lockOrder(),
    ['user', 'project', 'marker', 'enqueue', 'marker', 'enqueue'],
  );
});
