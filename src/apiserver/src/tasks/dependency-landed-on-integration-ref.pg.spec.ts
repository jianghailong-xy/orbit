import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { readProjectReadyToRun } from '../projects/project-ready-to-run';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * A dependency waits for its prerequisite to LAND on the project's integration line, and the
 * receipt that records the landing is what starts the work downstream of it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/dependency-landed-on-integration-ref.pg.spec.ts
 *
 * Project acceptance criterion 5's apiserver half, `docs/project-integration-line-contract.md`
 * §2.5 J9 (the predicate) and J10 (the dispatch edge).
 *
 * WHAT WAS WRONG
 * ==============
 * `dependenciesSatisfiedSql` and `computeDependencyState` asked one question — is the prerequisite
 * DONE — and DONE means the acceptance command agreed with its exit code inside the task's own
 * worktree. It says nothing about where that work IS. So a dependent started on a baseline that
 * did not contain its prerequisite, and the two spellings of "start what this completion released"
 * both fired at the moment the prerequisite finished rather than at the moment its work arrived.
 * Measured on this account on 2026-09-13: 5 of 12 dependents started before their prerequisite had
 * landed anywhere.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * By COUNTING THE RUNS that exist afterwards, never by observing a call: "did the platform start
 * the dependent" is the question, and the only honest evidence is the Session. Every "nothing
 * happened" assertion is paired, in the SAME fixture, with the one column that must make it happen
 * — the merge receipt — so a predicate that holds everything for ever and a predicate that holds
 * nothing both fail.
 *
 * Both production edges are driven, and neither is reached past: the DONE edge
 * (`dispatchDependentsAfterCompletion`, what the runner door and the verification path call) and
 * the landing edge (`MergeReceiptService.record`, which is how an agent's own merge is recorded).
 *
 * WHY THE STACK IS BUILT WITH A CAST
 * ==================================
 * J10 gives `MergeReceiptService` a third constructor parameter. Naming it positionally would make
 * this whole file a compile error on the tree BEFORE the change, and then no case could fail on
 * the assertion that names what is missing — which is the only red worth having. The cast is the
 * same device the sibling spec uses `require` for.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/** The declaration every task here carries; never the thing under test. */
const CHECK = {
  completionCriterion: 'EXECUTABLE' as const,
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

const sha = (nibble: string) => nibble.repeat(40);

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  tasks: TasksService;
  receipts: MergeReceiptService;
}

/**
 * The read model as this spec needs to read it: `waitingForLanding` does not exist on the tree
 * before the change, and asking for it through the real type would be a compile error rather than
 * a failing assertion (see the header).
 */
interface RunQueueView {
  readyCount: number;
  waitingForLanding?: number;
  items: Array<{ taskId: string; runState: string }>;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  const tasks = new TasksService(prisma, sessions, publishes);
  // No completion-input router: nothing here is about the facts a receipt delivers to a
  // coordinator. The third argument is J10's dispatch edge.
  const receipts = new (MergeReceiptService as unknown as new (...args: unknown[]) =>
  MergeReceiptService)(prisma, undefined, tasks);
  return { db, prisma, tasks, receipts };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/** An owner with one online runner, one workspace bound to it, and one project. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = {
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
  };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@landing.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // Room for every run a fixture here means to start, so a control group is never a task the
      // RUNNER held back rather than the predicate under test.
      maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`,
      enabled: true, repoUrl: 'https://github.com/example/landing',
    },
  });
  await db.project.create({
    data: {
      id: ids.projectId, ownerId: ids.ownerId, title: `${label} project`,
      coordinatorWorkspaceId: ids.workspaceId,
    },
  });
  return ids;
}

/**
 * The project's integration line, as `startOnFirstIntegration` leaves it.
 *
 * Written here rather than reached through the queueing transaction because the queue is a
 * different unit (§2, T8) and this one is about the predicate that reads the line.
 */
async function integrationLine(
  db: PrismaClient,
  ids: World,
  opts: { started?: boolean; line?: 'MAIN' | 'PROJECT_BRANCH' } = {},
): Promise<string> {
  const branch = `project/${ids.projectId.slice(0, 8)}`;
  const integrationRef = (opts.line ?? 'PROJECT_BRANCH') === 'MAIN'
    ? 'refs/heads/main'
    : `refs/heads/${branch}`;
  await db.projectCodebase.create({
    data: {
      ownerId: ids.ownerId,
      projectId: ids.projectId,
      canonicalRepoUrl: 'https://github.com/example/landing',
      upstreamRef: 'refs/heads/main',
      integrationRef,
      refAuthority: 'REMOTE',
      remoteName: 'origin',
      integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: (opts.started ?? true) ? new Date() : null,
    },
  });
  return integrationRef === 'refs/heads/main' ? 'main' : branch;
}

/** A task filed under the project, created through the door a person and an agent both use. */
async function task(
  stack: Stack,
  ids: World,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await stack.tasks.create(ids.ownerId, {
    title,
    projectId: ids.projectId,
    assigneeId: ids.workspaceId,
    // Never on creation: a task that opts in while it still has no edge is started by the create
    // path itself, which would be a run this fixture did not mean to be about. `dependsOn` below
    // flips it once the edge exists, by a write that dispatches nothing.
    autoRunWhenReady: false,
    ...CHECK,
    ...extra,
  } as never);
  return created.id;
}

/** The work session a code task's branch belongs to — §1.1 `isCodeTask`'s whole evidence. */
async function workSession(stack: Stack, ids: World, taskId: string, label: string): Promise<string> {
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: ids.ownerId,
      creatorId: ids.ownerId,
      taskId,
      workspaceId: ids.workspaceId,
      assignedRunnerId: ids.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      // SUCCEEDED, so the run is over: a live session would hold the dependent back through a
      // clause that has nothing to do with landing.
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      isolationStatus: 'worktree',
      branch: `orbit/${label}`,
      completedAt: new Date(),
    },
  });
  return sessionId;
}

/** A finished piece of code work: DONE, with the worktree session that did it. */
async function donePrerequisite(
  stack: Stack,
  ids: World,
  label: string,
  extra: Record<string, unknown> = {},
): Promise<{ taskId: string; sessionId: string }> {
  const taskId = await task(stack, ids, label, extra);
  const sessionId = await workSession(stack, ids, taskId, label);
  await stack.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  return { taskId, sessionId };
}

/**
 * A dependent that has opted into auto-run, with its edge in place first.
 *
 * The opt-in is written straight to the row: `create` with `autoRunWhenReady` true and no
 * prerequisite yet is itself a dispatch, and this fixture is about what the PREREQUISITE releases.
 */
async function dependentOf(
  stack: Stack,
  ids: World,
  label: string,
  prerequisiteIds: string[],
): Promise<string> {
  const taskId = await task(stack, ids, label);
  for (const dependsOnTaskId of prerequisiteIds) {
    await stack.db.taskDependency.create({ data: { taskId, dependsOnTaskId } });
  }
  await stack.db.task.update({ where: { id: taskId }, data: { autoRunWhenReady: true } });
  return taskId;
}

/** Record one merge exactly as an agent merging in its own worktree records it. */
async function land(
  stack: Stack,
  ids: World,
  sessionId: string,
  targetBranch: string,
): Promise<void> {
  const recorded = await stack.receipts.record(ids.ownerId, sessionId, {
    result: 'MERGED',
    sourceSha: sha('a'),
    targetBranch,
    targetShaBefore: sha('b'),
    targetShaAfter: sha('c'),
  } as never, 'AGENT');
  assert.equal(recorded.created, true, `the receipt into ${targetBranch} was not recorded`);
}

/** The production completion edge, called exactly as the runner door calls it. */
const completionEdge = (stack: Stack, ids: World, doneTaskId: string) =>
  stack.tasks.dispatchDependentsAfterCompletion(ids.ownerId, doneTaskId);

/** How many work runs exist for a task — the only honest evidence that it started. */
const runCount = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId, startsTaskWork: true } });

const runQueue = async (stack: Stack, ids: World): Promise<RunQueueView> =>
  await readProjectReadyToRun(stack.prisma, ids.ownerId, ids.projectId, 10) as unknown as RunQueueView;

// -------------------------------------------------------------------------------------------------
// (1) The rule itself: DONE is not enough, and the receipt is what releases.
// -------------------------------------------------------------------------------------------------

test('a DONE prerequisite that has not landed on the integration line holds its dependent, and its landing receipt releases it',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'holds-until-landed');
      const branch = await integrationLine(stack.db, ids);
      const prerequisite = await donePrerequisite(stack, ids, 'prerequisite');
      const dependent = await dependentOf(stack, ids, 'dependent', [prerequisite.taskId]);

      // The premise, read off the database rather than assumed: the work is finished and nowhere.
      assert.equal(
        await stack.db.sessionMergeReceipt.count({ where: { taskId: prerequisite.taskId } }), 0,
        'the fixture recorded a landing before the case began',
      );

      await completionEdge(stack, ids, prerequisite.taskId);

      assert.equal(await runCount(stack.db, dependent), 0,
        'the dependent started while its prerequisite was DONE but had landed nowhere');

      // The one column that changes, through the door that writes it.
      await land(stack, ids, prerequisite.sessionId, branch);

      assert.equal(await runCount(stack.db, dependent), 1,
        'the landing receipt did not start the dependent — J10 delivered nothing');
      const [run] = await stack.db.session.findMany({
        where: { taskId: dependent }, select: { dispatchOrigin: true, startsTaskWork: true },
      });
      assert.equal(run.dispatchOrigin, SessionDispatchOrigin.LEGACY_SWEEP,
        'the run was not opened by an automatic door');
      assert.equal(run.startsTaskWork, true);
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (2) WHICH branch: a receipt naming any other branch is not evidence of a landing.
// -------------------------------------------------------------------------------------------------

test('a receipt into a branch that is not the project\'s line is not a landing',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'wrong-branch');
      const branch = await integrationLine(stack.db, ids);
      const prerequisite = await donePrerequisite(stack, ids, 'prerequisite');
      const dependent = await dependentOf(stack, ids, 'dependent', [prerequisite.taskId]);

      await land(stack, ids, prerequisite.sessionId, 'somebody-elses-branch');
      await completionEdge(stack, ids, prerequisite.taskId);

      assert.equal(await runCount(stack.db, dependent), 0,
        'a receipt into an unrelated branch was read as a landing on the integration line');

      await land(stack, ids, prerequisite.sessionId, branch);

      assert.equal(await runCount(stack.db, dependent), 1,
        'the receipt into the integration line did not release the dependent');
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (3) A prerequisite with no code is still satisfied by DONE alone (§1.1 `isCodeTask`).
// -------------------------------------------------------------------------------------------------

test('a prerequisite that is not code work is released by DONE alone, beside a code sibling that is not',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'codeless-prerequisite');
      await integrationLine(stack.db, ids);

      // Declared codeless: it resolves no SOURCE, so there is no branch for it to land on. Written
      // to the row rather than passed to `create`, which takes no such field.
      const codelessId = await task(stack, ids, 'codeless prerequisite');
      await stack.db.task.update({
        where: { id: codelessId }, data: { status: TaskStatus.DONE, codeless: true },
      });
      const afterCodeless = await dependentOf(stack, ids, 'after the codeless one', [codelessId]);

      // The control, one fact away in the same project: code work, DONE, landed nowhere.
      const code = await donePrerequisite(stack, ids, 'code prerequisite');
      const afterCode = await dependentOf(stack, ids, 'after the code one', [code.taskId]);

      await completionEdge(stack, ids, codelessId);
      await completionEdge(stack, ids, code.taskId);

      assert.equal(await runCount(stack.db, afterCodeless), 1,
        'a codeless prerequisite was made to wait for a landing it can never have');
      assert.equal(await runCount(stack.db, afterCode), 0,
        'the code prerequisite released its dependent without landing');
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (4) C2: a project that has not started integrating keeps today's DONE-only rule.
// -------------------------------------------------------------------------------------------------

test('a project that has not started integrating releases on DONE, exactly as it does today',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'line-not-started');
      // A binding whose line never started: the platform has landed nothing on it, so there is no
      // landing for a prerequisite to be waiting for.
      await integrationLine(stack.db, ids, { started: false });
      const prerequisite = await donePrerequisite(stack, ids, 'prerequisite');
      const dependent = await dependentOf(stack, ids, 'dependent', [prerequisite.taskId]);

      await completionEdge(stack, ids, prerequisite.taskId);

      assert.equal(await runCount(stack.db, dependent), 1,
        'a project that never started integrating held its dependent for a landing that is not coming');
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (5) The read models say so: the run queue refuses the dependent and says what it waits for.
// -------------------------------------------------------------------------------------------------

test('the run queue withholds a dependent whose prerequisite has not landed, and counts it as waiting for one',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'run-queue');
      const branch = await integrationLine(stack.db, ids);
      const prerequisite = await donePrerequisite(stack, ids, 'prerequisite');
      // Opted out of auto-run: this case is about what the queue SAYS, and a dependent that starts
      // by itself leaves the queue for a reason that is not the one under test.
      const dependent = await task(stack, ids, 'dependent');
      await stack.db.taskDependency.create({
        data: { taskId: dependent, dependsOnTaskId: prerequisite.taskId },
      });

      const waiting = await runQueue(stack, ids);
      assert.equal(waiting.items.some((item) => item.taskId === dependent), false,
        'the run queue offered a task whose prerequisite has not landed');
      assert.equal(waiting.readyCount, 0, 'the unlanded dependent was counted as ready to run');
      assert.equal(waiting.waitingForLanding, 1,
        'the run queue does not say that a task is waiting for a prerequisite to land');

      await land(stack, ids, prerequisite.sessionId, branch);

      const released = await runQueue(stack, ids);
      assert.equal(released.waitingForLanding, 0,
        'the task still reads as waiting for a landing that has been recorded');
      assert.equal(released.readyCount, 1, 'the landed dependent is not offered by the run queue');
      assert.equal(released.items.some((item) => item.taskId === dependent), true,
        'the landed dependent is missing from the run queue');
    } finally {
      await stack.db.$disconnect();
    }
  });
