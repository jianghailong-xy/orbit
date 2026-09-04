import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { TasksService } from './tasks.service';
import type { TaskCompletionCriterionValue } from './task-completion-criterion';

/**
 * N2's optimistic-status boundary.
 *
 * DONE authorises downstream work, so nobody submits it as an opinion — not a person, not the
 * one-shot project coordinator/judgment, and not any task execution Session. Each refusal carries
 * the task's declared criterion and the concrete fact that can actually make it DONE. FAILED stays
 * writable by the executor because it is the conservative outcome and releases nothing.
 */

const OWNER = '00000000-0000-7000-8000-0000000000b1';
const PROJECT = '00000000-0000-7000-8000-0000000000b2';
const TASK = '00000000-0000-7000-8000-0000000000b3';
const OTHER_TASK = '00000000-0000-7000-8000-0000000000b4';
const SESSION = '00000000-0000-7000-8000-0000000000b5';

type SessionRow = {
  id: string;
  taskId: string | null;
  task: { projectId: string | null } | null;
  coordinatorForProject: { id: string } | null;
  dispatchOrigin?: string;
};

const THE_RUN_ITSELF: SessionRow = {
  id: SESSION,
  taskId: TASK,
  task: { projectId: PROJECT },
  coordinatorForProject: null,
  dispatchOrigin: 'USER',
};

const THE_COORDINATOR: SessionRow = {
  id: SESSION,
  taskId: null,
  task: null,
  coordinatorForProject: { id: PROJECT },
  dispatchOrigin: 'PROJECT_COORDINATOR',
};

function fixture(
  session: SessionRow,
  criterion: TaskCompletionCriterionValue,
  storedStatus: TaskStatus = TaskStatus.IN_PROGRESS,
) {
  const writes: Array<Record<string, unknown>> = [];
  const task = {
    id: TASK,
    ownerId: OWNER,
    title: 'Ship it',
    description: null,
    status: storedStatus,
    projectId: PROJECT,
    parentTaskId: null,
    listId: null,
    completionCriterion: criterion,
    acceptanceCommand: criterion === 'EXECUTABLE' ? 'npm test' : null,
    acceptanceExpectedExitCode: criterion === 'EXECUTABLE' ? 0 : null,
    completionPolicy: criterion === 'VERIFICATION' ? 'VERIFICATION_PASSED' : 'MANUAL',
    isForeman: false,
    verifiesTaskId: null,
    verdict: null,
    verdictRevision: 0n,
    supersededByTaskId: null,
    supersededAt: null,
    terminalReason: null,
    creatorSessionId: null,
    assignee: null,
    comments: [],
    sessions: [],
    creatorSession: null,
    dependsOn: [],
    dependedOnBy: [],
    supersedes: [],
  };
  const prisma: Record<string, any> = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    project: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        ({ id: where.id, runtime: { coordinatorGeneration: 0n } }),
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({
          id,
          status: 'OPEN',
          maxConcurrentTasks: null,
          sessionBudgetPerDay: null,
          members: [],
        })),
    },
    taskList: { findMany: async () => [] },
    projectHandoffApproval: { findFirst: async () => null },
    session: { findFirst: async () => session },
    taskDependency: { findMany: async () => [] },
    task: {
      findFirst: async () => ({ ...task }),
      findMany: async () => [],
      count: async () => 0,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...task, ...data };
      },
    },
    taskListEvent: { upsert: async () => ({}) },
  };
  const service = new TasksService(prisma as never, {} as never, {
    publishForUser() {},
    publishTaskChanged() {},
  } as never);
  return {
    writes,
    write: (status: TaskStatus, actingSessionId?: string) =>
      service.update(OWNER, TASK, { status } as never, actingSessionId),
  };
}

async function refusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ForbiddenException, `expected a refusal, got ${error}`);
    return error.getResponse() as Record<string, unknown>;
  }
  throw new assert.AssertionError({ message: 'the write was not refused' });
}

function assertCriterionRefusal(
  body: Record<string, unknown>,
  criterion: TaskCompletionCriterionValue,
  requiredAction: string,
  message: RegExp,
) {
  assert.equal(body.code, 'DIRECT_TASK_DONE_REFUSED');
  assert.equal(body.criterion, criterion);
  assert.equal(body.requiredAction, requiredAction);
  assert.match(String(body.message), message);
  assert.match(String(body.message), /cannot be written directly by a person, coordinator or execution session/);
}

// The refusal is unchanged; what it POINTS AT has moved twice. Both criteria that lost their
// implementations on 2026-09-02 have them back — EXECUTABLE on 2026-09-03, EVIDENCE_JUDGMENT on
// 2026-09-04 — so the remedy names the act that settles the task instead of a rebuild to wait for.
// That is the whole point of this boundary: every refusal has to tell the caller what could
// actually complete this task.
test('nobody can write DONE and every caller is directed to the EVIDENCE_JUDGMENT criterion',
  async () => {
    const f = fixture(THE_RUN_ITSELF, 'EVIDENCE_JUDGMENT');

    const body = await refusalOf(() => f.write(TaskStatus.DONE));

    assertCriterionRefusal(
      body,
      'EVIDENCE_JUDGMENT',
      'SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION',
      /submit[\s\S]*did not do the work[\s\S]*CONFIRM/,
    );
    assert.deepEqual(f.writes, []);
  });

test('a coordinator judgment cannot write DONE and is directed to VERIFICATION', async () => {
  const f = fixture(THE_COORDINATOR, 'VERIFICATION');

  const body = await refusalOf(() => f.write(TaskStatus.DONE, SESSION));

  assertCriterionRefusal(
    body,
    'VERIFICATION',
    'OBTAIN_INDEPENDENT_VERIFICATION_PASS',
    /independent verification task with verdict PASS/,
  );
  assert.deepEqual(f.writes, []);
});

test('a task execution session cannot write DONE and is directed to EXECUTABLE', async () => {
  const f = fixture(THE_RUN_ITSELF, 'EXECUTABLE');

  const body = await refusalOf(() => f.write(TaskStatus.DONE, SESSION));

  // The run that did the work is exactly the actor this boundary exists for, and the criterion
  // having an implementation again is what makes the refusal actionable rather than a dead end:
  // it is told to let the declared command finish, not to wait for a rebuild.
  assertCriterionRefusal(
    body,
    'EXECUTABLE',
    'RUN_ACCEPTANCE_COMMAND',
    /acceptanceCommand run to completion[\s\S]*acceptanceExpectedExitCode/,
  );
  assert.deepEqual(f.writes, []);
});

test('foreman, verifier and unrelated sessions have no direct-DONE exemption', async () => {
  for (const session of [THE_RUN_ITSELF, { ...THE_RUN_ITSELF, taskId: OTHER_TASK }]) {
    const f = fixture(session, 'EVIDENCE_JUDGMENT');
    const body = await refusalOf(() => f.write(TaskStatus.DONE, SESSION));
    assert.equal(body.code, 'DIRECT_TASK_DONE_REFUSED');
    assert.deepEqual(f.writes, []);
  }
});

test('reasserting an existing DONE is still a forbidden direct write', async () => {
  const f = fixture(THE_RUN_ITSELF, 'EVIDENCE_JUDGMENT', TaskStatus.DONE);
  const body = await refusalOf(() => f.write(TaskStatus.DONE));
  assert.equal(body.code, 'DIRECT_TASK_DONE_REFUSED');
  assert.deepEqual(f.writes, []);
});

test('the task execution session may still write FAILED as a conservative self-report', async () => {
  const f = fixture(THE_RUN_ITSELF, 'EVIDENCE_JUDGMENT');

  await f.write(TaskStatus.FAILED, SESSION);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, TaskStatus.FAILED);
});
