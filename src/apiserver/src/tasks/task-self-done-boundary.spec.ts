import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { TasksService } from './tasks.service';

/**
 * The executor does not write its own DONE.
 *
 * `task.status = DONE` is not the run's account of itself. It is an AUTHORISATION: the DAG
 * releases the next task on it (`computeDependencyState` treats DONE, and only DONE, as a
 * satisfied prerequisite) and a project's acceptance counts it. Written by the run being judged
 * it is the graded party writing its own grade, and the grade takes effect the moment it lands.
 *
 * The incident this comes from: a task ran, wrote its own DONE, and reported the work landed. The
 * code was on an unmerged branch and the deployed dispatcher was untouched — but the DONE had
 * already released everything downstream of it, and nothing anywhere re-read the claim.
 *
 * The asymmetry below is the design and not an omission: the same session may write FAILED
 * through the same path. Nobody misreports their own failure to release downstream work, and
 * FAILED releases nothing — it reads as BLOCKED_FAILED, which stops the successors and asks for a
 * person. The conservative self-report is allowed; the optimistic one is not.
 *
 * The other half of this change is the dispatch prompt that tells runs what to do instead
 * (`task-list-instructions.spec.ts`). The two ship together: this refusal alone is a wall every
 * in-flight run hits with no idea what to do about it.
 */

const OWNER = '00000000-0000-7000-8000-0000000000b1';
const PROJECT = '00000000-0000-7000-8000-0000000000b2';
const TASK = '00000000-0000-7000-8000-0000000000b3';
const OTHER_TASK = '00000000-0000-7000-8000-0000000000b4';
const SESSION = '00000000-0000-7000-8000-0000000000b5';

/**
 * Not covered here, deliberately: a session id that names no row. The guard fails open on that
 * lookup (`actingSession?.taskId === id`), but the request never reaches it — the scope layer
 * derives its scope from the same read, so an unreadable session is already refused upstream as
 * R5_NO_SCOPE (task in a project) or R4_NO_TARGET_PROJECT (task in none). A test for it would be
 * asserting about a path the caller cannot get to.
 */

type SessionRow = {
  id: string;
  taskId: string | null;
  task: { projectId: string | null } | null;
  coordinatorForProject: { id: string } | null;
};

/** The run executing TASK — the one being judged, and the only writer this boundary refuses. */
const THE_RUN_ITSELF: SessionRow = {
  id: SESSION,
  taskId: TASK,
  task: { projectId: PROJECT },
  coordinatorForProject: null,
};

/** Another run in the same project: it is not the party being graded, so it is not refused. */
const ANOTHER_RUN: SessionRow = {
  id: SESSION,
  taskId: OTHER_TASK,
  task: { projectId: PROJECT },
  coordinatorForProject: null,
};

/** The project's coordinator: whoever accepts the work is exactly who should write DONE. */
const THE_COORDINATOR: SessionRow = {
  id: SESSION,
  taskId: null,
  task: null,
  coordinatorForProject: { id: PROJECT },
};

function fixture(session: SessionRow, row: { isForeman?: boolean; verifiesTaskId?: string | null;
  verdict?: string | null } = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const task = {
    id: TASK,
    ownerId: OWNER,
    title: 'Ship it',
    status: TaskStatus.IN_PROGRESS,
    projectId: PROJECT,
    listId: null,
    completionPolicy: 'MANUAL',
    isForeman: row.isForeman ?? false,
    verifiesTaskId: row.verifiesTaskId ?? null,
    verdict: row.verdict ?? null,
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
  };
  const prisma: Record<string, unknown> = {
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
          acceptanceEpoch: 0n,
          maxConcurrentTasks: null,
          sessionBudgetPerDay: null,
          members: [],
        })),
    },
    taskList: { findMany: async () => [] },
    projectHandoffApproval: { findFirst: async () => null },
    session: { findFirst: async () => session },
    // Read by the dependent-release pass that runs after a status write. Answered so the fixture
    // is a world the write can finish in, rather than one that logs a warning per test.
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
    patch: (dto: Record<string, unknown>, actingSessionId?: string) =>
      service.update(OWNER, TASK, dto as never, actingSessionId),
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

test('the run executing a task cannot write that task DONE', async () => {
  const f = fixture(THE_RUN_ITSELF);

  const body = await refusalOf(() => f.write(TaskStatus.DONE, SESSION));

  // The code names THIS boundary rather than a generic scope refusal: a run reading it has to be
  // able to tell "you may not finish yourself" from "you may not write here at all", because the
  // two have opposite remedies.
  assert.equal(body.code, 'SELF_REPORTED_DONE_REFUSED');
  assert.equal(body.requiredAction, 'REPORT_EVIDENCE_AND_LET_ACCEPTANCE_DECIDE');
  // And the message says what to do instead, in the terms of the tools the reader has.
  assert.match(String(body.message), /task_evidence_submit/);
  assert.doesNotMatch(String(body.message), /task_comment/);
  assert.match(String(body.message), /exit codes/);
  assert.match(String(body.message), /acceptance criterion/);
  assert.match(String(body.message), /FAILED/);
  // Nothing was written: a refusal that leaves the row moved has not prevented anything.
  assert.deepEqual(f.writes, []);
});

test('that same run may write FAILED — the conservative self-report is allowed', async () => {
  // The asymmetry, as a test rather than as a paragraph. FAILED unlocks nothing: downstream reads
  // it as BLOCKED_FAILED and asks for a person, so a run that misreported it would only stop work
  // it has no reason to stop.
  const f = fixture(THE_RUN_ITSELF);

  await f.write(TaskStatus.FAILED, SESSION);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, TaskStatus.FAILED);
});

test('a person writes DONE exactly as before', async () => {
  // The user path passes no session at all, so it never reaches the lookup — the boundary is
  // about a run grading itself, not about who is allowed to finish work.
  const f = fixture(THE_RUN_ITSELF);

  await f.write(TaskStatus.DONE);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, TaskStatus.DONE);
});

test('the coordinator writes DONE for a task it did not run', async () => {
  const f = fixture(THE_COORDINATOR);

  await f.write(TaskStatus.DONE, SESSION);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, TaskStatus.DONE);
});

test('another session writes DONE for a task that is not its own', async () => {
  // A verification run, a repair run, an operator's own session — none of them is the party being
  // graded, and scoping the refusal any wider would make the boundary a general ban on agents
  // finishing work.
  const f = fixture(ANOTHER_RUN);

  await f.write(TaskStatus.DONE, SESSION);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, TaskStatus.DONE);
});

// ── the two exemptions: the runs whose own session IS the deliverable ────────────────────────

test('a foreman task is finished by its own run, as §13.1 AG6 says it is', async () => {
  // `is_foreman` means "this task's SESSION is the work", and nothing else in the system completes
  // one. Refusing this would not move the decision to somebody else — it would wedge the row.
  const f = fixture(THE_RUN_ITSELF, { isForeman: true });

  await f.write(TaskStatus.DONE, SESSION);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, TaskStatus.DONE);
});

test('a verification task is finished by its own run', async () => {
  // `task-aggregation.ts` counts a check only as `status DONE && verdict PASS`, so refusing this
  // makes VERIFICATION_PASSED unreachable for every subject. And a check is not the graded party:
  // its finding is the verdict, that verdict may already not be reached by the run that produced
  // the work, and a DONE without one is already refused.
  const f = fixture(THE_RUN_ITSELF, { verifiesTaskId: OTHER_TASK, verdict: 'PASS' });

  await f.write(TaskStatus.DONE, SESSION);

  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].status, TaskStatus.DONE);
});

test('a run cannot mint itself the verification exemption in the call it uses it in', async () => {
  // The exemption is read off the STORED row. `verifiesTaskId` is on the update DTO, so judging it
  // on the value the request ASKS for would let any run declare its own task a check of something
  // and finish itself in the same statement.
  const f = fixture(THE_RUN_ITSELF);

  const body = await refusalOf(() => f.patch(
    { status: TaskStatus.DONE, verifiesTaskId: OTHER_TASK, verdict: 'PASS' },
    SESSION,
  ));

  assert.equal(body.code, 'SELF_REPORTED_DONE_REFUSED');
  assert.deepEqual(f.writes, []);
});
