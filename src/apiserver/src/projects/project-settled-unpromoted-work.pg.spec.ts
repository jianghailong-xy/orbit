import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  Prisma,
  PrismaClient,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { Client } from 'pg';

import { uuidToBase62 } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorDeliveryService,
} from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { criteriaFromDefinitions, standardSetVersion } from './project-acceptance';
import {
  projectBranchRef,
} from './project-integration-line';
import {
  readDerivedProjectDone,
  storeDerivedProjectStatus,
} from './project-done-derived';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import {
  PROJECT_SETTLED_UNMERGED_WAKE_COORDINATOR_DISABLED,
  ProjectSettledUnmergedProducer,
} from './project-settled-unmerged.producer';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskDispatchRefusalProducer } from './task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * `PROJECT_SETTLED_UNMERGED`: work a settled project left sitting on its integration line reaches
 * the project's coordinator, naming the commits.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-settled-unpromoted-work.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * Promotion candidates are made off landings, and a project that has settled has no more of them.
 * On 2026-09-23 project `34ODoUKJGEsfbgcJDGS4q` was DONE with commit
 * `d6b55d2d853f8b2410977674e3ec54c39f52a34e` — authored as `789a8fffc0bf0223efe8d8286ed5fcae2cb6c414`
 * and rebased onto `project/34ODoUKJGEsfbgcJDGS4q`, one commit ahead of main — sitting on that
 * branch, and nothing in the system said so. The landing job that would have carried it had already
 * gone terminal `ALREADY_LANDED` (15:39:18Z), two and a half minutes before that commit was written
 * onto the line (15:41:51Z); the promotion that would have followed never had a tip to be about;
 * and settlement closed the last edge that re-read the line. It reached main only when a person
 * replayed it by hand.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * Through the real edge a receipt lands on — `MergeReceiptService.record`, the door an agent
 * records its own merge through, which is how the incident's own receipt was written — over the
 * real router, the real producer, the real wake ledger and the real conversation table. Nothing
 * here calls the producer directly, and the `d6b55d2d8` fixture is the incident's own shape: a
 * settled project, and the receipt that put that commit on the line rather than on main.
 *
 * Every "nothing was delivered" is paired, in the same fixture, with the one change that makes it
 * delivered — the receipt landing on the upstream instead of the line, the project settled instead
 * of open, the coordinator switched off — so a producer nobody calls and a producer that wakes
 * everything both fail.
 *
 *   (1) a settled project whose line gains a commit nothing merged wakes its coordinator once,
 *       naming `d6b55d2d8`, and says the merge is the owner's or the coordinator's to make;
 *   (2) a receipt that lands the work on the UPSTREAM instead wakes nobody: the line and main are
 *       level, which is the negative half of the rule;
 *   (3) a project that has not settled wakes nobody either — work on the line is the ordinary state
 *       of a project being integrated, and the landing that put it there is what makes the next
 *       candidate;
 *   (4) under a switched-off coordinator the fact is still written down and nobody is woken;
 *   (5) the incident's own order: the receipt put `d6b55d2d8` on the line while the project was still
 *       open (15:44:50Z) and the project settled afterwards (17:00:12Z), so the edge that has to
 *       speak is the task completion that settles it — told once, naming the commit.
 *
 * The settled state is this spec's PREMISE rather than its subject, and the fixture proves its own
 * premise instead of asserting it: every criterion is satisfied and on main, the owner has confirmed
 * the version that stands, and `readDerivedProjectDone` is asked for the answer before the act.
 * Deriving DONE is `project-done-derived.pg.spec.ts`'s subject.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/**
 * The incident, as a fixture: the two commits of the pair of receipts that landing wrote. The
 * source is the commit the session made, the tip is what the line ended up carrying — one rebase
 * apart, which is why they are not the same sha and why the tip is the one a reader goes to look at.
 */
const LATE_SOURCE_SHA = '789a8fffc0bf0223efe8d8286ed5fcae2cb6c414';
const LATE_TIP_SHA = 'd6b55d2d853f8b2410977674e3ec54c39f52a34e';

/** A commit-shaped string from one nibble, for the receipts that are scenery. */
const sha = (nibble: string): string => nibble.repeat(40);

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  tasks: TasksService;
  receipts: MergeReceiptService;
}

/** The production wiring over one client, with the real completion-input router behind the write
 *  paths — and the seventh door's producer on it, which is the unit under test. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = new CoordinatorWakeService(prisma);
  const convergence = new CoordinatorConvergenceService(prisma);
  const delivery = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, wakes, sessions),
      convergence,
      delivery,
    ),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(
      prisma,
      new CoordinatorJudgmentService(prisma, wakes, sessions),
      delivery,
    ),
    new CriterionUnlandedProducer(prisma, convergence),
    new TaskDispatchRefusalProducer(prisma, convergence, delivery),
    undefined, // the seventh door (`DEPENDENT_READY`) is not exercised by this spec
    new ProjectSettledUnmergedProducer(prisma, convergence, delivery),
  );
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems);
  const receipts = new MergeReceiptService(prisma, router);
  return { db, prisma, tasks, receipts };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  /** The branch the project's tasks land on: the line, one commit-hosting branch beside `main`. */
  line: string;
  /**
   * The project's own work, finished before the criterion's receipt landed — what every case below
   * puts a commit on the line for. Null when the case did not ask for it.
   */
  work: { taskId: string; sessionId: string } | null;
}

/**
 * One settled project and the conversation it is coordinated from, in the incident's shape.
 *
 * The settled state is built rather than written: a criterion whose work is finished and on main,
 * and the owner's confirmation of the version that stands — which is the whole of what the
 * projection reads, and the reason the receipt this spec records cannot re-open the project. A
 * status written by hand here would be taken away by the projection's own compare-and-set on the
 * very edge under test, and every case below would then be a statement about an OPEN project.
 */
async function settledProject(
  stack: Stack,
  label: string,
  options: {
    coordinatorEnabled?: boolean;
    settle?: boolean;
    /**
     * Work of this project's own, settled inside the fixture.
     *
     * It is created HERE rather than by the case so that the fixture's own story is told in one
     * order: this project's finished work exists, the criterion's work lands on main, and the
     * platform says so to the conversation that coordinates it — all of it before the case's act.
     * That matters because of a property of the carrier on this branch rather than of the fact
     * under test: `CoordinatorDeliveryService.deliver` → `sessions.resume` appends a message only
     * to a conversation with nothing unread, and refuses (giving the fact's key back) otherwise.
     * A case that filed this task after the receipt would meet its own project's settled message
     * racing for that one slot.
     */
    work?: { title: string } | null;
  } = {},
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@settled-unmerged.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: `https://example.invalid/${label}.git`,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `coordinator: ${label}`,
      prompt: `coordinator: ${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      numTurns: 1,
      startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `coordinator: ${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'nothing this project made is left behind on a branch',
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  // The line, decided explicitly and started: the incident's project had been integrating into its
  // own branch for hours when the commit below arrived.
  const line = projectBranchRef(projectId);
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: { projectBranchName: line },
  }));
  await db.projectCodebase.update({
    where: { projectId_slot: { projectId, slot: 'primary' } },
    data: { integrationStartedAt: new Date() },
  });

  // One criterion, its work finished and on main, and the owner's confirmation of this version —
  // the three inputs `DONE` is projected from.
  const text = 'the work this project was asked for is on the default branch';
  const definition = await db.projectAcceptanceCriterionDefinition.create({
    data: {
      projectId,
      ordinal: 1,
      text,
      verificationMethod: 'a merge receipt naming main for every task serving this criterion',
      revision: 1,
      contentHash: createHash('sha256').update(text).digest('hex'),
    },
  });
  const serving = await tasksWithWork(stack, { ownerId, workspaceId, projectId }, {
    title: `${label} the work the criterion names`,
    criterionKey: uuidToBase62(definition.id),
  });
  await settleExecutable(db, serving.taskId);
  const work = options.work
    ? await tasksWithWork(stack, { ownerId, workspaceId, projectId }, { title: options.work.title })
    : null;
  if (work) await settleExecutable(db, work.taskId);

  // The criterion's work reaches main, which is the edge the platform tells this conversation on:
  // every criterion satisfied and landed is `PROJECT_ACCEPTANCE_LANDED`, and its message is what a
  // coordinator gets at the moment its project settles.
  await recordMerge(stack, ownerId, serving.sessionId, {
    result: 'MERGED',
    sourceSha: sha('1'),
    targetBranch: 'main',
    targetShaBefore: sha('0'),
    targetShaAfter: sha('2'),
  });
  await coordinatorReads(db, coordinatorSessionId);

  // The confirmation is the one input that says WHETHER the work was asked for, so it is also the
  // one an unsettled fixture must not have: without it the projection withholds DONE
  // (`STANDARD_SET_UNCONFIRMED`) however satisfied and landed the work is, and the receipt under
  // (3) cannot settle the project on its way past. A status written by hand would not survive that
  // edge — the projection's own compare-and-set would take it away — which is why the fixture
  // builds the settled state instead of writing it.
  const standing = standardSetVersion(criteriaFromDefinitions([definition]));
  if (options.settle ?? true) {
    await db.projectStandardSetConfirmation.create({
      data: {
        projectId,
        ownerId,
        criteriaDigest: standing.digest,
        criteriaMaterial: standing.material as unknown as Prisma.InputJsonValue,
        confirmedById: ownerId,
      },
    });

    // The production projection, asked the way the post-commit edges ask it — and then held to its
    // own answer, so a fixture that could not settle says so here rather than three cases later.
    await storeDerivedProjectStatus(stack.prisma, ownerId, projectId);
    const derived = await readDerivedProjectDone(stack.prisma, ownerId, projectId);
    assert.equal(derived.done, true,
      'the fixture must settle: every criterion satisfied and on main, and the version the owner '
      + 'confirmed still the one that stands');
    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: projectId } })).status,
      ProjectStatus.DONE,
    );
  }

  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, line, work };
}

/** A code task declared through the product, with one worktree session on a branch of its own. */
async function tasksWithWork(
  stack: Stack,
  where: { ownerId: string; workspaceId: string; projectId: string },
  options: { title: string; criterionKey?: string },
): Promise<{ taskId: string; sessionId: string }> {
  const declared = await stack.tasks.create(where.ownerId, {
    title: options.title,
    assigneeId: where.workspaceId,
    projectId: where.projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
    ...(options.criterionKey ? { criterionKey: options.criterionKey } : {}),
  } as never);
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: where.ownerId,
      creatorId: where.ownerId,
      taskId: declared.id,
      workspaceId: where.workspaceId,
      title: options.title,
      prompt: options.title,
      provider: 'claude',
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      branch: `orbit/${uuidToBase62(sessionId)}`,
      isolationStatus: 'worktree',
      baseSha: sha('b'),
      startedAt: new Date(),
    },
  });
  return { taskId: declared.id, sessionId };
}

/**
 * Settle an EXECUTABLE task through the fence that admits it, and nowhere else.
 *
 * The update carries exactly the declaration 0230's fence requires (`completion_criterion`,
 * `acceptance_command`, `acceptance_expected_exit_code`), so a task the product would not have
 * settled cannot be settled by this fixture either.
 */
async function settleExecutable(db: PrismaClient, taskId: string): Promise<void> {
  const written = await db.$executeRaw(Prisma.sql`
    UPDATE "task" SET "status" = 'DONE'
     WHERE "id" = ${taskId}::uuid
       AND "status" IN ('OPEN', 'IN_PROGRESS')
       AND "completion_criterion" = 'EXECUTABLE'
       AND "acceptance_command" = 'true'
       AND "acceptance_expected_exit_code" = 0`);
  assert.equal(written, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
}

/** One merge, through the door an agent records its own with — the one the incident's own receipt
 *  came through, and the edge this whole spec is about. */
function recordMerge(
  stack: Stack,
  ownerId: string,
  sessionId: string,
  input: Parameters<MergeReceiptService['record']>[2],
) {
  return stack.receipts.record(ownerId, sessionId, input, 'AGENT');
}

/** This project's wakes of the event under test, oldest first. */
function settledUnmergedWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'PROJECT_SETTLED_UNMERGED' },
    select: {
      id: true,
      subjectType: true,
      subjectId: true,
      subjectVersion: true,
      status: true,
      refusalCode: true,
      sessionId: true,
      detail: true,
    },
    orderBy: { id: 'asc' },
  });
}

/**
 * The coordinator has read what it has been told — the state every real one is in most of the time,
 * and the state the carrier on this branch accepts a new message in (see `settledProject`'s
 * `work`).
 *
 * Parked between turns, nothing unread: `CoordinatorDeliveryService.message` reads the standing
 * session's own status, and `sessions.resume` reaches `createTurn` for a conversation that is LIVE
 * rather than reviving it.
 */
async function coordinatorReads(db: PrismaClient, coordinatorSessionId: string): Promise<void> {
  await db.conversationTurn.updateMany({
    where: { sessionId: coordinatorSessionId, status: { not: 'ANSWERED' } },
    data: { status: 'ANSWERED' },
  });
  await db.session.update({
    where: { id: coordinatorSessionId },
    data: { status: RunStatus.AWAITING_INPUT },
  });
}

/** Every turn on one conversation, oldest first: what the coordinator was actually told. */
function turns(db: PrismaClient, sessionId: string | null) {
  if (!sessionId) return Promise.resolve([]);
  return db.conversationTurn.findMany({
    where: { sessionId },
    select: { seq: true, kind: true, content: true, status: true },
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The turns that name one commit.
 *
 * A settled project's conversation is told other things too — the fixture's own edge announces that
 * every criterion is satisfied and landed, and that message is not this fact — so "was the
 * coordinator told about THIS commit" is asked of the commit rather than of a turn count.
 */
function turnsAbout(db: PrismaClient, sessionId: string | null, sha: string) {
  return turns(db, sessionId).then((rows) => rows.filter((row) => (row.content ?? '').includes(sha)));
}

/** The commits a wake's `detail` names — the sha list this fact exists to carry. */
function commitsOf(detail: Prisma.JsonValue): string[] {
  const named = (detail as { commits?: unknown }).commits;
  return Array.isArray(named) ? named.map((entry) => String(entry)) : [];
}

/** Judgment sessions opened for one owner: this fact must open none, whatever it delivers. */
function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

// (1) — the incident, as a fixture: a settled project whose line gains a commit nothing merged ────
test('(1) a settled project whose line carries d6b55d2d8 tells its coordinator, naming that commit',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await settledProject(stack, 'd6b55d2d8', {
        work: { title: 'the work whose last commit arrived after its landing' },
      });

      // THE ACT: the receipt that put the rebased commit on the project's branch — the merge the
      // session made in its own worktree, recorded through the agent's door. It is also what tells
      // the platform whether the project settled with anything left behind.
      await recordMerge(stack, w.ownerId, w.work!.sessionId, {
        result: 'MERGED',
        sourceSha: LATE_SOURCE_SHA,
        targetBranch: w.line.replace('refs/heads/', ''),
        targetShaBefore: sha('3'),
        targetShaAfter: LATE_TIP_SHA,
        rebaseBaseSha: sha('3'),
      });

      const wakes = await settledUnmergedWakes(stack.db, w.projectId);
      assert.equal(wakes.length, 1, 'the settled project left a commit behind and nobody was told');
      assert.equal(wakes[0]!.status, 'DELIVERED',
        `the fact reached the project's coordinator; it answered `
        + `${wakes[0]!.status} ${wakes[0]!.refusalCode ?? ''}`);
      assert.equal(wakes[0]!.subjectType, 'PROJECT');
      assert.equal(wakes[0]!.subjectId, w.projectId);
      assert.deepEqual(
        commitsOf(wakes[0]!.detail), [LATE_TIP_SHA],
        'the fact names the commit that is sitting on the line — d6b55d2d8 — and not the source it '
        + 'was rebased from',
      );
      assert.equal(
        (wakes[0]!.detail as { tasks?: Array<{ taskId?: string }> }).tasks?.[0]?.taskId,
        w.work!.taskId,
        'and the task whose work it is',
      );

      // The delivery, read off the conversation rather than off the ledger: one message, naming the
      // commit, on the conversation the project is already coordinated from.
      const told = await turns(stack.db, w.coordinatorSessionId);
      const naming = told.filter((turn) => (turn.content ?? '').includes(LATE_TIP_SHA));
      assert.equal(naming.length, 1,
        `exactly one message names the commit a reader goes to look at: `
        + JSON.stringify(told.map((turn) => turn.content?.slice(0, 160))));
      assert.match(naming[0]!.content ?? '', /结算/,
        'and it says what the situation is, not only which commit it is about');
    } finally {
      await stack.db.$disconnect();
    }
  });

// (2) — the negative half: the work reached main, so the line and main are level ──────────────────
test('(2) a receipt that lands the same work on main wakes nobody', { skip, timeout: 240_000 },
  async () => {
    const stack = await connect();
    try {
      const w = await settledProject(stack, 'level-with-main', {
        work: { title: 'the same work, landed on main' },
      });

      // The one change from (1): the receipt names the upstream. Nothing is left over — every
      // commit this project made is on main — which is the whole of the negative reading.
      await recordMerge(stack, w.ownerId, w.work!.sessionId, {
        result: 'MERGED',
        sourceSha: LATE_SOURCE_SHA,
        targetBranch: 'main',
        targetShaBefore: sha('3'),
        targetShaAfter: sha('4'),
      });

      assert.deepEqual(await settledUnmergedWakes(stack.db, w.projectId), [],
        'a project whose line is level with main has nothing to tell anybody about');
      assert.deepEqual(
        await turnsAbout(stack.db, w.coordinatorSessionId, LATE_TIP_SHA), [],
        'and the commit nobody has to be told about reached no conversation either',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

// (3) — the other negative: work on the line is ordinary while the project is still open ──────────
test('(3) the same commit on the line of a project that has not settled wakes nobody',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await settledProject(stack, 'not-settled', {
        settle: false, work: { title: 'work in flight' },
      });
      assert.equal(
        (await stack.db.project.findUniqueOrThrow({ where: { id: w.projectId } })).status,
        ProjectStatus.OPEN,
      );

      await recordMerge(stack, w.ownerId, w.work!.sessionId, {
        result: 'MERGED',
        sourceSha: LATE_SOURCE_SHA,
        targetBranch: w.line.replace('refs/heads/', ''),
        targetShaBefore: sha('3'),
        targetShaAfter: LATE_TIP_SHA,
        rebaseBaseSha: sha('3'),
      });

      assert.deepEqual(await settledUnmergedWakes(stack.db, w.projectId), [],
        'an open project\'s line carrying work is the state every landing is followed by, and the '
        + 'candidate it makes is the promotion queue\'s business rather than a wake');
      assert.deepEqual(
        await turnsAbout(stack.db, w.coordinatorSessionId, LATE_TIP_SHA), [],
        'and this commit reached no conversation either',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

// (4) — the switched-off control: the fact is written down, and the coordinator is not woken ──────
test('(4) a settled project whose coordinator is switched off produces the fact and wakes nobody',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await settledProject(stack, 'switched-off', {
        coordinatorEnabled: false,
        work: { title: 'work left behind under a switched-off coordinator' },
      });

      await recordMerge(stack, w.ownerId, w.work!.sessionId, {
        result: 'MERGED',
        sourceSha: LATE_SOURCE_SHA,
        targetBranch: w.line.replace('refs/heads/', ''),
        targetShaBefore: sha('3'),
        targetShaAfter: LATE_TIP_SHA,
        rebaseBaseSha: sha('3'),
      });

      // Not "zero rows": the ledger claims before it authorizes, so a fact that travelled the whole
      // way and was refused leaves EXACTLY ONE row saying so. Asserting an empty table here would be
      // green over a producer nobody calls — which is the state this wiring replaced.
      const wakes = await settledUnmergedWakes(stack.db, w.projectId);
      assert.equal(wakes.length, 1, 'the leftover never reached the wake ledger');
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, PROJECT_SETTLED_UNMERGED_WAKE_COORDINATOR_DISABLED);
      assert.equal(wakes[0]!.sessionId, null);
      assert.deepEqual(commitsOf(wakes[0]!.detail), [LATE_TIP_SHA],
        'the record still names the commit: the switch stops the waking, not the trace');
      assert.deepEqual(
        await judgmentSessions(stack.db, w.ownerId), [],
        'a switched-off coordinator was woken',
      );
      assert.equal((await turns(stack.db, w.coordinatorSessionId)).length, 1,
        'and nothing was written on its conversation');
    } finally {
      await stack.db.$disconnect();
    }
  });

// (5) — the incident's own order: the commit reached the line while the project was open, and the
//       write that settled the project came after it ───────────────────────────────────────────────
test('(5) the completion that settles a project whose line already carries d6b55d2d8 tells its coordinator',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await settledProject(stack, 'settled-after-the-line', {
        settle: false,
        work: { title: 'the work whose commit reached the line before the project settled' },
      });

      // 15:44:50Z in the incident: the receipt that put d6b55d2d8 on the line, while the project was
      // still open — on its own the ordinary state of a project being integrated, as (3) says.
      await recordMerge(stack, w.ownerId, w.work!.sessionId, {
        result: 'MERGED',
        sourceSha: LATE_SOURCE_SHA,
        targetBranch: w.line.replace('refs/heads/', ''),
        targetShaBefore: sha('3'),
        targetShaAfter: LATE_TIP_SHA,
        rebaseBaseSha: sha('3'),
      });
      assert.deepEqual(await settledUnmergedWakes(stack.db, w.projectId), [],
        'the project had not settled when the commit reached its line');

      // 17:00:12Z in the incident: the last task's DONE settled the project. Here the input the
      // projection is still waiting for is the owner's confirmation, which goes in with no edge of its
      // own; what re-reads the project is the completion edge a DONE comes back through.
      const definitions = await stack.db.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: w.projectId },
      });
      const standing = standardSetVersion(criteriaFromDefinitions(definitions));
      await stack.db.projectStandardSetConfirmation.create({
        data: {
          projectId: w.projectId,
          ownerId: w.ownerId,
          criteriaDigest: standing.digest,
          criteriaMaterial: standing.material as unknown as Prisma.InputJsonValue,
          confirmedById: w.ownerId,
        },
      });
      await stack.tasks.dispatchDependentsAfterCompletion(w.ownerId, w.work!.taskId);
      assert.equal(
        (await stack.db.project.findUniqueOrThrow({ where: { id: w.projectId } })).status,
        ProjectStatus.DONE,
        'the completion edge settled the project',
      );

      const wakes = await settledUnmergedWakes(stack.db, w.projectId);
      assert.equal(wakes.length, 1,
        'the project settled with a commit on its line that main does not have, and nobody was told');
      assert.equal(wakes[0]!.status, 'DELIVERED',
        `the fact reached the project's coordinator; it answered `
        + `${wakes[0]!.status} ${wakes[0]!.refusalCode ?? ''}`);
      assert.deepEqual(commitsOf(wakes[0]!.detail), [LATE_TIP_SHA],
        'the fact names the commit that is sitting on the line — d6b55d2d8');
      assert.equal(
        (await turnsAbout(stack.db, w.coordinatorSessionId, LATE_TIP_SHA)).length, 1,
        'and exactly one message on the coordinator\'s conversation names it',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the settled-unmerged PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
