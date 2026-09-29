import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';

/**
 * `task_start` waits for the owner to start the task's project (`projectAwaitingStart`).
 *
 * 2026-09-25: a coordinator filed nine tasks and started two of them itself sixteen seconds later,
 * while its owner was still being asked "Start the project". The runner's door — the MCP tool and
 * `orbit task start` — is refused until the owner has started it; the owner's own Run is not.
 *
 * Started is `project.started_at` (migration 0331), which only a start writes. Until then it was read
 * off `coordinator_enabled` and whether a confirmation existed, so the Automatic switch started a
 * project too; it says how a project runs now, not whether it has started.
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
  startedAt: Date | null;
  criteria: number;
}

/** A project exactly as `project_create` leaves it: OPEN, criteria stated, nobody has pressed. */
function unstarted(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: PROJECT,
    ownerId: OWNER,
    title: '分享能力',
    status: 'OPEN',
    coordinatorEnabled: false,
    startedAt: null,
    criteria: 9,
    ...overrides,
  };
}

const STARTED_AT = new Date('2026-09-29T08:00:00.000Z');

/** Every column a `where` names has to match, as it would in PostgreSQL: a double that ignored the
 *  filter would let the gate read "not started" off a project that is running. */
function matches(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(
    ([key, value]) => (row as Record<string, unknown>)[key] === value,
  );
}

/** A service whose only real behaviour is the door under test; the dispatch itself is stubbed. */
function serviceFor(project: ProjectRow | null, taskProjectId: string | null = PROJECT) {
  const started: string[] = [];
  const task: Record<string, unknown> = {
    id: TASK,
    title: 'T1 公开接口加固',
    description: null,
    projectId: taskProjectId,
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
        project && matches(project, where) ? { title: project.title } : null,
    },
    projectAcceptanceCriterionDefinition: {
      findFirst: async ({ where }: { where: { projectId: string } }) =>
        project?.id === where.projectId && project.criteria > 0 ? { id: uuid('c') } : null,
    },
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

/** `task_start`, as `RunnerTasksController.executeTask` calls it. */
const taskStart = (service: TasksService, trigger: string) =>
  service.execute(OWNER, TASK, undefined, trigger, 'session-1', true);

test('task_start is refused for a task whose project its owner has not started', async () => {
  const { service, started } = serviceFor(unstarted());
  await assert.rejects(
    () => taskStart(service, 'trigger-1'),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException, 'a readable 409, not a dispatched Session');
      assert.equal((error.getResponse() as { code: string }).code, 'PROJECT_NOT_STARTED');
      assert.match(error.message, /Start the project/);
      assert.match(error.message, new RegExp(uuidToBase62(TASK)));
      assert.match(error.message, new RegExp(uuidToBase62(PROJECT)));
      return true;
    },
  );
  assert.deepEqual(started, [], 'and no Session is started');
});

test("the owner's own Run still starts it", async () => {
  const { service, started } = serviceFor(unstarted());
  await service.execute(OWNER, TASK, undefined, 'trigger-1');
  assert.deepEqual(started, [TASK]);
});

test('the Automatic switch alone does not start it: task_start is still refused', async () => {
  const { service, started } = serviceFor(unstarted({ coordinatorEnabled: true }));
  await assert.rejects(
    () => taskStart(service, 'trigger-1'),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as { code: string }).code, 'PROJECT_NOT_STARTED');
      return true;
    },
  );
  assert.deepEqual(started, []);
});

test('task_start starts it once the project has been started, however it runs', async () => {
  const cases: Array<[string, ProjectRow | null, string | null]> = [
    ['started, Automatic on', unstarted({ startedAt: STARTED_AT, coordinatorEnabled: true }), PROJECT],
    ['started, Automatic off', unstarted({ startedAt: STARTED_AT }), PROJECT],
    ['no criteria, so no card to press', unstarted({ criteria: 0 }), PROJECT],
    // Finished, so no card either. (A CANCELLED one is refused outright, by every door:
    // `project-cancelled-dispatch.spec.ts`.)
    ['not OPEN, so no card either', unstarted({ status: 'DONE' }), PROJECT],
    ['in no project at all', null, null],
  ];
  for (const [name, project, taskProjectId] of cases) {
    const { service, started } = serviceFor(project, taskProjectId);
    await taskStart(service, 'trigger-1');
    assert.deepEqual(started, [TASK], `${name}: task_start must start it`);
  }
});

test('a refusal is not frozen: the same call starts the task after the owner presses Start', async () => {
  const project = unstarted();
  const { service, started } = serviceFor(project);
  await assert.rejects(() => taskStart(service, 'trigger-1'), ConflictException);
  project.startedAt = STARTED_AT;
  await taskStart(service, 'trigger-1');
  assert.deepEqual(started, [TASK]);
});
