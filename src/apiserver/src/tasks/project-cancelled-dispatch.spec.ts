import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import { manualRunnableTaskSql } from './manual-runnable-task-sql';
import { projectNotCancelledSql } from './project-cancelled-dispatch';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';

/**
 * A cancelled project's tasks do not start, by any door.
 *
 * 2026-09-26: a project its owner had cancelled kept its tasks OPEN and its Automatic switch on, and
 * nothing that starts a run read `project.status` — so the tasks of a goal nobody was pursuing any
 * more went on running. The automatic scans are held to it in SQL and proved against PostgreSQL
 * (`project-cancelled-dispatch.pg.spec.ts`); this is the run door itself, which every automatic scan
 * funnels through and which a person's Run and an agent's `task_start` reach directly, and the bulk
 * Run, which classifies its own rows instead.
 */

const uuid = (tag: string): string => `00000000-0000-4000-8000-${tag.padStart(12, '0')}`;
const OWNER = 'owner-1';
const TASK = uuid('1');
const PROJECT = uuid('2');

interface ProjectRow {
  id: string;
  ownerId: string;
  title: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  coordinatorEnabled: boolean;
}

const project = (status: ProjectRow['status']): ProjectRow => ({
  id: PROJECT,
  ownerId: OWNER,
  title: 'FineWeb corpus',
  status,
  coordinatorEnabled: true,
});

/** Every column a `where` names has to match, as it would in PostgreSQL. */
function matches(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(
    ([key, value]) => (row as Record<string, unknown>)[key] === value,
  );
}

/** A service whose only real behaviour is the run door; the dispatch itself is stubbed. */
function serviceFor(row: ProjectRow | null) {
  const started: string[] = [];
  const task: Record<string, unknown> = {
    id: TASK,
    title: 'shard 000',
    description: null,
    projectId: row ? PROJECT : null,
    provider: null,
    model: null,
    status: 'OPEN',
    listId: null,
    isForeman: false,
    verifiesTaskId: null,
    dispatchHold: false,
    runAt: null,
    supersededByTaskId: null,
    terminalReason: null,
    completionPolicy: 'MANUAL',
    completionCriterion: 'EVIDENCE_JUDGMENT',
    children: [],
    verifies: null,
    list: null,
    assignee: { id: 'workspace-1', runnerId: 'runner-1' },
  };
  const prisma = {
    ...fakeReceiptStore(),
    task: {
      findFirst: async ({ where, select }: {
        where: { id: string };
        select?: Record<string, unknown>;
      }) => {
        if (where.id !== TASK) return null;
        if (!select) return task;
        return Object.fromEntries(Object.keys(select).map((key) => [key, task[key]]));
      },
      findMany: async () => [],
      count: async () => 0,
    },
    taskDependency: { findMany: async () => [] },
    conversationTurn: { findUnique: async () => null },
    session: { findUnique: async () => null, findMany: async () => [] },
    project: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        row && matches(row, where) ? { title: row.title } : null,
    },
    // The start check `task_start` also asks (`projectAwaitingStart`): nothing to confirm here.
    projectAcceptanceCriterionDefinition: { findFirst: async () => null },
    projectStandardSetConfirmation: { findFirst: async () => null },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  const stub = service as unknown as Record<string, unknown>;
  stub.planWorkspaceRun = async (_o: string, t: { id: string }) =>
    ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${t.id}` });
  stub.applyWorkspaceRun = async (...args: unknown[]) => {
    const taskId = (args[1] as { id: string }).id;
    started.push(taskId);
    return `session-${taskId}`;
  };
  stub.buildExecutePrompt = () => 'prompt';
  return { service, started };
}

function isCancelledRefusal(error: unknown): true {
  assert.ok(error instanceof ConflictException, 'a readable 409, not a dispatched Session');
  const body = error.getResponse() as { code: string; message: string };
  assert.equal(body.code, 'PROJECT_CANCELLED');
  assert.match(body.message, /was cancelled, so its tasks do not start/);
  assert.match(body.message, /Reopen the project/);
  assert.match(body.message, new RegExp(uuidToBase62(TASK)));
  assert.match(body.message, new RegExp(uuidToBase62(PROJECT)));
  return true;
}

test("the owner's Run on a task in a cancelled project is refused with the reason", async () => {
  const { service, started } = serviceFor(project('CANCELLED'));
  await assert.rejects(() => service.execute(OWNER, TASK, undefined, 'press-1'), isCancelledRefusal);
  assert.deepEqual(started, [], 'and no Session is started');
});

test("an agent's task_start is refused the same way", async () => {
  const { service, started } = serviceFor(project('CANCELLED'));
  await assert.rejects(
    () => service.execute(OWNER, TASK, undefined, 'press-1', 'session-1', true),
    isCancelledRefusal,
  );
  assert.deepEqual(started, []);
});

test('an automatic door stands down quietly rather than throwing', async () => {
  const { service, started } = serviceFor(project('CANCELLED'));
  const answer = await service.execute(OWNER, TASK, { observedEpoch: 0n }, `dep:${TASK}:0`);
  assert.deepEqual(answer, { ok: false, skipped: 'project-cancelled' });
  assert.deepEqual(started, []);
});

// NEGATIVE CONTROL: the gate is on CANCELLED, not on "anything but OPEN" — a finished project's
// tasks may still be run (a follow-up on work that was accepted), and a task in no project is not
// asked about projects at all.
test('a task in an open or finished project, or in none, still starts', async () => {
  for (const [name, row] of [
    ['OPEN', project('OPEN')],
    ['DONE', project('DONE')],
    ['no project', null],
  ] as const) {
    const { service, started } = serviceFor(row);
    await service.execute(OWNER, TASK, undefined, 'press-1');
    assert.deepEqual(started, [TASK], `${name}: the Run must start it`);
  }
});

test('the refusal is not frozen: the same press starts the task once the project is reopened', async () => {
  const row = project('CANCELLED');
  const { service, started } = serviceFor(row);
  await assert.rejects(() => service.execute(OWNER, TASK, undefined, 'press-1'), ConflictException);
  row.status = 'OPEN';
  await service.execute(OWNER, TASK, undefined, 'press-1');
  assert.deepEqual(started, [TASK]);
});

// The Ready tab, the project's "Ready to run" and its lanes read this predicate, so they offer
// exactly what the door accepts — a list's pause lifted or not.
test('the manual-runnable predicate carries the same clause, paused list or not', () => {
  const clause = projectNotCancelledSql('t');
  assert.ok(manualRunnableTaskSql('t').includes(clause));
  assert.ok(manualRunnableTaskSql('t', { requireUnheld: false }).includes(clause));
  assert.match(clause, /t\.project_id IS NULL OR EXISTS/);
  assert.match(clause, /status <> 'CANCELLED'::project_status/);
});

test('bulk Run skips a task in a cancelled project and names why, and runs the rest', async () => {
  const rows = [
    { id: 'task-cancelled', project: { status: 'CANCELLED' } },
    { id: 'task-open', project: { status: 'OPEN' } },
    { id: 'task-loose', project: null },
  ].map((row) => ({
    ...row,
    title: row.id,
    description: null,
    completionPolicy: 'MANUAL' as const,
    children: [] as Array<{ id: string }>,
    assignee: { id: 'workspace-1', runnerId: 'runner-1' },
  }));
  const prisma = {
    ...fakeReceiptStore(),
    task: {
      findMany: async () => rows,
      findFirst: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
    },
    taskDependency: { findMany: async () => [] },
    conversationTurn: { findUnique: async () => null },
    session: { findUnique: async () => null, findMany: async () => [] },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  const started: string[] = [];
  const stub = service as unknown as Record<string, unknown>;
  stub.planWorkspaceRun = async (_o: string, t: { id: string }) =>
    ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${t.id}` });
  stub.applyWorkspaceRun = async (...args: unknown[]) => {
    const taskId = (args[1] as { id: string }).id;
    started.push(taskId);
    return `session-${taskId}`;
  };

  const result = await service.batchExecute(OWNER, rows.map((row) => row.id), 3);

  assert.deepEqual(result.skipped, [
    { id: 'task-cancelled', title: 'task-cancelled', reason: 'Project cancelled' },
  ]);
  assert.deepEqual(started.sort(), ['task-loose', 'task-open']);
  assert.equal(result.dispatched, 2);
});
