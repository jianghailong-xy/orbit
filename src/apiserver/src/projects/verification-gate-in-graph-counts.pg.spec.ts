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
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';
import { readProjectReadyToRun } from './project-ready-to-run';

/**
 * The other half of `6198ca4ac`: §13.3 DEP's epoch, as the graph's tally spelling reads it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/verification-gate-in-graph-counts.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * The run gate has judged a prerequisite by the SUBJECT's PASS epoch since the H0V incident: a
 * check reaches `DONE` when its run ends, whatever it concluded, so `status = 'DONE'` alone
 * released work a FAIL was supposed to hold. `dependencyStateFromCounts` — the spelling the project
 * page draws from, because counting in SQL is what keeps a 118-node graph to one query — counted
 * four things and none of them was the epoch: how many prerequisites there are, how many are
 * terminal, how many are DONE, and, since `6198ca4ac`, how many still owe a landing (§2.5 J9).
 *
 * So a prerequisite whose check concluded FAIL, or whose check has not concluded at all, read READY
 * on the project graph while `tasks.get`, Run Now, the run queue and the sweeps all said
 * BLOCKED_FAILED or BLOCKED about the same row: one screen telling a person to wonder why nothing
 * is starting. It is the identical shape the landing dimension had, one clause further along.
 *
 * THE TWO TIERS ARE NOT THE SAME ANSWER
 * =====================================
 * A check that concluded NO, and a subject whose every check was cancelled or replaced, need
 * somebody to act — BLOCKED_FAILED, the word a CANCELLED or FAILED prerequisite already gets. A
 * check that has not concluded yet, or a subject that was reopened, is a WAIT that ends by itself —
 * BLOCKED. Both are shut epochs, so a spelling that only knew "shut" would have to report one of
 * them wrong; §13.2's `verificationLiveness` is what separates them, and this file witnesses the
 * separation on the graph and not only in TypeScript.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * Through production doors only: `TasksService.create` and `.update` (where a check's verdict is
 * recorded and its carrier status derived), `TasksService.listRow` (the TypeScript rule and the
 * Run-Now SQL), `ProjectsService.taskPage` (the tally rule the graph draws from) and
 * `readProjectReadyToRun` (the queue). Every "it is held back" case is paired, in the SAME fixture,
 * with the write that must release it, so a predicate that holds everything for ever fails here as
 * loudly as one that holds nothing.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/** The declaration the fixture's ordinary rows carry; never the thing under test. */
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
  projects: ProjectsService;
  receipts: MergeReceiptService;
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
  // No router and no landing dispatcher: these cases are about what the READ MODELS say, and a
  // receipt that also started the dependent would remove the row they are being asked about.
  const receipts = new MergeReceiptService(prisma);
  return { db, prisma, tasks, projects: new ProjectsService(prisma), receipts };
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
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@dep-epoch.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`,
      enabled: true, repoUrl: 'https://github.com/example/dep-epoch',
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

/** The project's integration line, as `startOnFirstIntegration` leaves it — §2.5 J9's precondition. */
async function integrationLine(db: PrismaClient, ids: World): Promise<{ branch: string }> {
  const branch = `project/${ids.projectId.slice(0, 8)}`;
  await db.projectCodebase.create({
    data: {
      ownerId: ids.ownerId,
      projectId: ids.projectId,
      canonicalRepoUrl: 'https://github.com/example/dep-epoch',
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${branch}`,
      refAuthority: 'REMOTE',
      remoteName: 'origin',
      integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: new Date(),
    },
  });
  return { branch };
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
): Promise<{ taskId: string; sessionId: string }> {
  const taskId = await task(stack, ids, label);
  const sessionId = await workSession(stack, ids, taskId, label);
  await stack.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  return { taskId, sessionId };
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

/**
 * A check of `subjectId`, filed through the door that refuses a cross-project one.
 *
 * Its own create payload rather than `task()`'s, because the two declarations are mutually
 * exclusive by construction: `assertCompletionDeclaration` refuses `EXECUTABLE` on a task that
 * verifies something ("A verification task cannot use EXECUTABLE completion") and refuses any
 * command beside `VERIFICATION`. So a check is filed with the one criterion a check can carry, and
 * concludes through §13.2's verdict door rather than an acceptance command.
 */
async function check(stack: Stack, ids: World, subjectId: string, label: string): Promise<string> {
  const created = await stack.tasks.create(ids.ownerId, {
    title: label,
    projectId: ids.projectId,
    assigneeId: ids.workspaceId,
    autoRunWhenReady: false,
    verifiesTaskId: subjectId,
    completionCriterion: 'VERIFICATION',
  } as never);
  return created.id;
}

/** The check's run, in whatever state its conclusion needs it to be. */
async function checkRun(
  stack: Stack,
  ids: World,
  checkId: string,
  label: string,
  shape: { settled: boolean },
): Promise<void> {
  await stack.db.session.create({
    data: {
      ownerId: ids.ownerId,
      creatorId: ids.ownerId,
      taskId: checkId,
      workspaceId: ids.workspaceId,
      assignedRunnerId: ids.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: shape.settled ? RunStatus.SUCCEEDED : RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      // §4.2: only a natural `task_done` run that reached COMPLETED is evidence a check concluded.
      endReason: shape.settled ? 'task_done' : null,
      completedAt: shape.settled ? new Date() : null,
    } as never,
  });
}

/** The run's own end: the `task_done` write a worker's turn makes when it finishes the task. */
async function settleRun(stack: Stack, checkId: string): Promise<void> {
  const ended = await stack.db.session.updateMany({
    where: { taskId: checkId, deletedAt: null },
    data: { status: RunStatus.SUCCEEDED, endReason: 'task_done', completedAt: new Date() },
  });
  assert.equal(ended.count, 1, 'the check had no live run to settle');
}

/** §13.2's verdict door: the write that records a conclusion and derives the check's status. */
async function conclude(
  stack: Stack,
  ids: World,
  checkId: string,
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE',
): Promise<void> {
  await stack.tasks.update(ids.ownerId, checkId, { verdict } as never);
}

async function depend(stack: Stack, dependentId: string, prerequisiteId: string): Promise<void> {
  await stack.db.taskDependency.create({
    data: { taskId: dependentId, dependsOnTaskId: prerequisiteId },
  });
}

/** What each of the readers says about one task, in one place. */
async function readiness(stack: Stack, ids: World, taskId: string) {
  const row = await stack.tasks.listRow(ids.ownerId, taskId);
  const page = await stack.projects.taskPage(ids.ownerId, ids.projectId, { limit: '100' });
  const queue = await readProjectReadyToRun(stack.prisma, ids.ownerId, ids.projectId, 10);
  return {
    /** The rule read from one entry per prerequisite — the gate `execute` consults. */
    gate: row.dependencyState,
    /** The same rule read from SQL tallies — what the project page draws. */
    graph: page.items.find((item) => item.id === taskId)?.dependencyState,
    /** The Run-Now predicate, in SQL. */
    runnable: row.runnable,
    /** Does the queue offer it? */
    queued: queue.items.some((item) => item.taskId === taskId),
  };
}

// -------------------------------------------------------------------------------------------------
// (a) a check that concluded NO, or that nobody can conclude, is BLOCKED_FAILED on both spellings.
// -------------------------------------------------------------------------------------------------

test('a prerequisite whose check concluded FAIL reads BLOCKED_FAILED on the graph, not READY',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'dep-epoch-fail');
      const subject = await task(stack, ids, 'subject');
      await stack.db.task.update({ where: { id: subject }, data: { status: TaskStatus.DONE } });
      const failed = await check(stack, ids, subject, 'check');
      await checkRun(stack, ids, failed, 'check run', { settled: true });
      await conclude(stack, ids, failed, 'FAIL');
      const dependent = await task(stack, ids, 'dependent');
      await depend(stack, dependent, subject);

      // The premise, read off the database rather than assumed: the check DID finish — which is
      // the whole incident, since `status = 'DONE'` used to be the entire question.
      const row = await stack.db.task.findUniqueOrThrow({ where: { id: failed } });
      assert.equal(row.status, TaskStatus.DONE, 'the check that concluded FAIL did not reach DONE');
      assert.equal(row.verdict, 'FAIL');

      const held = await readiness(stack, ids, dependent);
      assert.equal(held.gate, 'BLOCKED_FAILED', 'the gate released a dependent of a failed check');
      assert.equal(held.graph, 'BLOCKED_FAILED', 'the project graph drew a task nothing will start');
      assert.equal(held.runnable, false, 'Run Now offered a task the gate says is blocked');
      assert.equal(held.queued, false, 'the run queue offered a task the gate says is blocked');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a prerequisite whose every check was cancelled reads BLOCKED_FAILED on the graph too',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'dep-epoch-cancelled');
      const subject = await task(stack, ids, 'subject');
      await stack.db.task.update({ where: { id: subject }, data: { status: TaskStatus.DONE } });
      const cancelled = await check(stack, ids, subject, 'check');
      await stack.tasks.update(ids.ownerId, cancelled, { status: TaskStatus.CANCELLED } as never);
      const dependent = await task(stack, ids, 'dependent');
      await depend(stack, dependent, subject);

      const held = await readiness(stack, ids, dependent);
      assert.equal(held.gate, 'BLOCKED_FAILED', 'nothing is going to conclude for this subject');
      assert.equal(held.graph, 'BLOCKED_FAILED', 'the project graph drew this subject as finished');
      assert.equal(held.runnable, false);
      assert.equal(held.queued, false);
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (b)(c) a check that has not concluded is a WAIT, and the PASS that ends it releases both.
// -------------------------------------------------------------------------------------------------

test('a prerequisite whose check has not concluded reads BLOCKED on the graph, and PASS releases both',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'dep-epoch-in-flight');
      const subject = await task(stack, ids, 'subject');
      await stack.db.task.update({ where: { id: subject }, data: { status: TaskStatus.DONE } });
      const pending = await check(stack, ids, subject, 'check');
      // A live run: "not yet" rather than "nobody will", which is the difference between this case
      // and a stall, and the reason the graph must not simply escalate every shut epoch.
      await checkRun(stack, ids, pending, 'check run', { settled: false });
      const dependent = await task(stack, ids, 'dependent');
      await depend(stack, dependent, subject);

      const waiting = await readiness(stack, ids, dependent);
      assert.equal(waiting.gate, 'BLOCKED', 'the gate released a dependent of an unconcluded check');
      assert.equal(waiting.graph, 'BLOCKED', 'the project graph drew a waiting task as READY');
      assert.equal(waiting.runnable, false, 'Run Now offered a task whose check is still running');
      assert.equal(waiting.queued, false, 'the run queue offered a task whose check is still running');

      // The two writes that change the answer, in the order the check's own turn makes them: the
      // run settles, and then the conclusion is recorded. Neither alone is a PASS — a verdict with
      // the run still live is a conclusion the turn can revise, and a settled run with no verdict
      // concluded nothing — which is why this is the pair and not just the verdict.
      await settleRun(stack, pending);
      await conclude(stack, ids, pending, 'PASS');

      const released = await readiness(stack, ids, dependent);
      assert.equal(released.gate, 'READY', 'the recorded PASS did not satisfy the gate');
      assert.equal(released.graph, 'READY', 'the project graph still holds a task the gate releases');
      assert.equal(released.runnable, true, 'the released dependent is still refused by Run Now');
      assert.equal(released.queued, true, 'the released dependent is missing from the run queue');
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (e) §13.3's self-exemption, which is the one clause of the epoch the graph has to pass an alias
// for: a check that names the subject it checks is not waiting for its own conclusion.
// -------------------------------------------------------------------------------------------------

test('a check that depends on its own subject is not held on the graph by that subject\'s epoch',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'dep-epoch-self');
      const subject = await task(stack, ids, 'subject');
      await stack.db.task.update({ where: { id: subject }, data: { status: TaskStatus.DONE } });
      const own = await check(stack, ids, subject, 'check');
      // In flight, so the epoch is shut and every OTHER dependent of this subject is held by it —
      // which is what makes this case discriminating rather than an inert fragment.
      await checkRun(stack, ids, own, 'check run', { settled: false });
      await depend(stack, own, subject);

      const self = await readiness(stack, ids, own);
      assert.equal(self.gate, 'READY', 'a check was made to wait for its own conclusion');
      assert.equal(self.graph, 'READY', 'the graph held a check that every gate releases');

      // The other end, in the same fixture: the same shut epoch still holds a dependent that is
      // not the check itself, so "READY" above cannot be the fragment having gone inert.
      const other = await task(stack, ids, 'dependent');
      await depend(stack, other, subject);
      const held = await readiness(stack, ids, other);
      assert.equal(held.gate, 'BLOCKED', 'the gate released a dependent of an unconcluded check');
      assert.equal(held.graph, 'BLOCKED', 'the graph released a dependent of an unconcluded check');
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (d) the answers this rule already gave are unchanged: no check at all, and the landing dimension.
// -------------------------------------------------------------------------------------------------

test('a check-free prerequisite, and the landing dimension, still read what they read before',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'dep-epoch-unchanged');
      const line = await integrationLine(stack.db, ids);

      // Three shapes with no check anywhere near them, each with its own dependent. A verification
      // clause that swallowed the old answers shows up here rather than in production.
      const plain = await task(stack, ids, 'plain prerequisite');
      await stack.db.task.update({ where: { id: plain }, data: { status: TaskStatus.DONE } });
      const open = await task(stack, ids, 'open prerequisite');
      // Finished CODE work, not on the line: §2.5 J9's answer, which `6198ca4ac` added and this
      // change must leave exactly where it was.
      const unlanded = await donePrerequisite(stack, ids, 'unlanded prerequisite');

      const waiting: Record<string, string> = {};
      for (const [label, prerequisiteId] of Object.entries({
        plain, open, unlanded: unlanded.taskId,
      })) {
        const dependent = await task(stack, ids, `after the ${label} one`);
        await depend(stack, dependent, prerequisiteId);
        waiting[label] = dependent;
      }

      for (const [label, dependent] of Object.entries(waiting)) {
        const state = await readiness(stack, ids, dependent);
        assert.equal(state.graph, state.gate, `the graph and the gate disagree after a ${label} prerequisite`);
      }
      assert.equal(
        (await readiness(stack, ids, waiting.plain)).gate, 'READY',
        'a prerequisite nothing checks was made to wait for a verification it does not have',
      );
      assert.equal((await readiness(stack, ids, waiting.open)).gate, 'BLOCKED');
      assert.equal(
        (await readiness(stack, ids, waiting.unlanded)).gate, 'BLOCKED',
        'the landing dimension stopped holding finished-but-unlanded work',
      );

      // The other side of the landing dimension, so "it is still BLOCKED" cannot pass by the
      // receipt having been ignored altogether: this project's own line releases the same row.
      await land(stack, ids, unlanded.sessionId, line.branch);
      const landed = await readiness(stack, ids, waiting.unlanded);
      assert.equal(landed.gate, 'READY', 'the recorded landing did not release the dependent');
      assert.equal(landed.graph, landed.gate, 'the graph still holds a task the landing released');
    } finally {
      await stack.db.$disconnect();
    }
  });
