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
import { decideSessionSource } from './session-source';

/**
 * The two spellings of "landed" that `84a5cb89c` deliberately left alone, both driven against a
 * real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-in-p5-and-graph-counts.pg.spec.ts
 *
 * `docs/project-integration-line-contract.md` §1.5 L10 first row (P5's baseline) and §2.5 J9 (the
 * dependency predicate), whose SQL-tally spelling the project graph reads.
 *
 * WHAT WAS WRONG
 * ==============
 * **P5.** `resolveSource` handed every ordinary code task `upstreamRef`, whatever its project had
 * already put on its own line. On a `PROJECT_BRANCH` project that is a baseline missing every task
 * the project has finished: the work is on the project branch, the new run starts from main, and
 * the first thing it does is re-solve problems its siblings already solved — or conflict with them
 * at integration time. L10 says the line once something is on it, and main until then, because a
 * project branch that nothing has landed on does not exist yet and the two are the same tree.
 *
 * **The graph.** `dependencyStateFromCounts` counted prerequisites, terminal ones and DONE ones,
 * and nothing else. So the same task read READY on the project page and BLOCKED at every gate that
 * starts it — one screen telling a person to wonder why nothing is starting, while the dispatcher
 * was right. Two spellings of one rule are two rules unless something holds them together.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * Through production doors only: `decideSessionSource` (what a session create freezes),
 * `TasksService.listRow` (the TypeScript rule and the Run-Now SQL), `ProjectsService.taskPage`
 * (the tally rule) and `readProjectReadyToRun` (the queue). Every "it is held back" assertion is
 * paired, in the SAME fixture, with the one row that must release it — the merge receipt — so a
 * predicate that holds everything for ever fails here just as loudly as one that holds nothing.
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
  // receipt that also starts the dependent would remove the row they are being asked about.
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
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@p5-landing.invalid`, name: label,
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

/** A second project for the same owner — the scope a landing must not leak across. */
async function siblingProject(db: PrismaClient, ids: World, label: string): Promise<World> {
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, ownerId: ids.ownerId, title: `${label} sibling`,
      coordinatorWorkspaceId: ids.workspaceId,
    },
  });
  return { ...ids, projectId };
}

/** The project's integration line, as `startOnFirstIntegration` leaves it. */
async function integrationLine(
  db: PrismaClient,
  ids: World,
  opts: { started?: boolean } = {},
): Promise<{ ref: string; branch: string }> {
  const branch = `project/${ids.projectId.slice(0, 8)}`;
  const ref = `refs/heads/${branch}`;
  await db.projectCodebase.create({
    data: {
      ownerId: ids.ownerId,
      projectId: ids.projectId,
      canonicalRepoUrl: 'https://github.com/example/landing',
      upstreamRef: 'refs/heads/main',
      integrationRef: ref,
      refAuthority: 'REMOTE',
      remoteName: 'origin',
      integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: (opts.started ?? true) ? new Date() : null,
    },
  });
  return { ref, branch };
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
      // SUCCEEDED, so the run is over: a live session holds a task back through clauses that have
      // nothing to do with landing.
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

/** The SOURCE a session create would freeze for this task, through the production door. */
async function resolvedSource(stack: Stack, taskId: string) {
  const row = await stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      id: true, projectId: true, verifiesTaskId: true, pinnedRevision: true, codeless: true,
      attemptGeneration: true, knownGoodSha: true,
    },
  });
  return await decideSessionSource(stack.prisma, row);
}

/** What each of the three readers says about one task, in one place. */
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
// (a) §1.5 L10: P5 starts from the integration line once the project has put something on it.
// -------------------------------------------------------------------------------------------------

test('P5 starts an ordinary code task from the integration line once work has landed on it, and from upstream until then',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'p5-baseline');
      const line = await integrationLine(stack.db, ids);
      // The task under test: no prerequisites, no pin, not a check — P5 by construction.
      const ordinary = await task(stack, ids, 'ordinary code task');

      const beforeAnythingLanded = await resolvedSource(stack, ordinary);
      assert.equal(beforeAnythingLanded.reason.rank, 'P5', 'the task under test is not resolving on P5');
      assert.equal(beforeAnythingLanded.columns.sourceKind, 'PROJECT_UPSTREAM');
      assert.equal(
        beforeAnythingLanded.columns.sourceRef, 'refs/heads/main',
        'P5 started from a project branch that nothing has created yet',
      );

      // The one row that changes: a finished sibling of this project, landed on the line.
      const sibling = await donePrerequisite(stack, ids, 'earlier task');
      await land(stack, ids, sibling.sessionId, line.branch);

      const afterLanding = await resolvedSource(stack, ordinary);
      assert.equal(afterLanding.reason.rank, 'P5', 'the landing moved the task off P5');
      assert.equal(afterLanding.columns.sourceKind, 'PROJECT_UPSTREAM');
      assert.equal(
        afterLanding.columns.sourceRef, line.ref,
        'P5 still starts from upstream although this project has work on its integration line',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a landing on ANOTHER project\'s line leaves this project\'s P5 baseline on upstream',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'p5-scope');
      await integrationLine(stack.db, ids);
      const ordinary = await task(stack, ids, 'ordinary code task');

      // Same owner, same repository, its own line — and something landed on it.
      const neighbour = await siblingProject(stack.db, ids, 'p5-scope');
      const neighbourLine = await integrationLine(stack.db, neighbour);
      const theirs = await donePrerequisite(stack, neighbour, 'their task');
      await land(stack, neighbour, theirs.sessionId, neighbourLine.branch);

      const resolved = await resolvedSource(stack, ordinary);
      assert.equal(resolved.reason.rank, 'P5');
      assert.equal(
        resolved.columns.sourceRef, 'refs/heads/main',
        'another project\'s landing moved this project\'s baseline onto a branch of its own that does not exist',
      );

      // The paired positive, so "it stayed on upstream" cannot pass by the read being blind: this
      // project's OWN landing does move it.
      const mine = await donePrerequisite(stack, ids, 'my task');
      const myLine = `project/${ids.projectId.slice(0, 8)}`;
      await land(stack, ids, mine.sessionId, myLine);
      assert.equal(
        (await resolvedSource(stack, ordinary)).columns.sourceRef, `refs/heads/${myLine}`,
        'this project\'s own landing did not move its baseline either — the read sees no landing at all',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (b) §2.5 J9: the graph's tally spelling answers what the gates answer.
// -------------------------------------------------------------------------------------------------

test('a DONE but unlanded prerequisite reads the same on the project graph as at the gate, and the landing releases both',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'graph-counts');
      const line = await integrationLine(stack.db, ids);
      const prerequisite = await donePrerequisite(stack, ids, 'prerequisite');
      const dependent = await task(stack, ids, 'dependent');
      await stack.db.taskDependency.create({
        data: { taskId: dependent, dependsOnTaskId: prerequisite.taskId },
      });

      // The premise, read off the database rather than assumed: finished, and nowhere.
      assert.equal(
        await stack.db.sessionMergeReceipt.count({ where: { taskId: prerequisite.taskId } }), 0,
        'the fixture recorded a landing before the case began',
      );

      const held = await readiness(stack, ids, dependent);
      assert.equal(held.gate, 'BLOCKED', 'the gate released a dependent whose prerequisite is nowhere');
      assert.equal(held.runnable, false, 'Run Now offered a task the gate says is blocked');
      assert.equal(held.queued, false, 'the run queue offered a task the gate says is blocked');
      assert.equal(
        held.graph, held.gate,
        'the project graph and the gate disagree about the same task: the graph says '
          + `${held.graph} while every door that starts it says ${held.gate}`,
      );

      // The one row that changes.
      await land(stack, ids, prerequisite.sessionId, line.branch);

      const released = await readiness(stack, ids, dependent);
      assert.equal(released.gate, 'READY', 'the recorded landing did not satisfy the gate');
      assert.equal(released.runnable, true, 'the landed dependent is still refused by Run Now');
      assert.equal(released.queued, true, 'the landed dependent is missing from the run queue');
      assert.equal(
        released.graph, released.gate,
        'the project graph still holds a task every gate now releases',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a prerequisite that is merely OPEN reads BLOCKED on the graph too — the tally rule still answers the old questions',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const ids = await world(stack.db, 'graph-counts-unchanged');
      await integrationLine(stack.db, ids);

      // Three shapes the tally rule already answered, each with its own dependent, so a landing
      // clause that swallowed the old answers shows up here rather than in production.
      const open = await task(stack, ids, 'open prerequisite');
      const cancelled = await task(stack, ids, 'cancelled prerequisite');
      await stack.db.task.update({
        where: { id: cancelled }, data: { status: TaskStatus.CANCELLED },
      });
      // Codeless: DONE is the whole of what it can ever offer, so it must read READY.
      const codeless = await task(stack, ids, 'codeless prerequisite');
      await stack.db.task.update({
        where: { id: codeless }, data: { status: TaskStatus.DONE, codeless: true },
      });

      const waiting: Record<string, string> = {};
      for (const [label, prerequisiteId] of Object.entries({ open, cancelled, codeless })) {
        const dependent = await task(stack, ids, `after the ${label} one`);
        await stack.db.taskDependency.create({ data: { taskId: dependent, dependsOnTaskId: prerequisiteId } });
        waiting[label] = dependent;
      }

      for (const [label, dependent] of Object.entries(waiting)) {
        const state = await readiness(stack, ids, dependent);
        assert.equal(state.graph, state.gate, `the graph and the gate disagree after a ${label} prerequisite`);
      }
      assert.equal((await readiness(stack, ids, waiting.open)).gate, 'BLOCKED');
      assert.equal((await readiness(stack, ids, waiting.cancelled)).gate, 'BLOCKED_FAILED');
      assert.equal(
        (await readiness(stack, ids, waiting.codeless)).gate, 'READY',
        'a codeless prerequisite was made to wait for a landing it can never have',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });
