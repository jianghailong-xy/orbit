import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { uuidToBase62 } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import {
  DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
  DELIVERY_NO_COORDINATOR_SESSION,
  CoordinatorDeliveryService,
  coordinatorDeliveryTurnId,
} from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  COORDINATOR_WAKE_EVENTS,
  RETIRED_COORDINATOR_WAKE_EVENTS,
  wakeIdempotencyKey,
} from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import {
  DEPENDENT_READY_WAKE_COORDINATOR_DISABLED,
  DependentReadyProducer,
} from '../projects/dependent-ready.producer';
import { readProjectReadyToRun } from '../projects/project-ready-to-run';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { TaskDispatchRefusalProducer } from '../projects/task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * `DEPENDENT_READY`: a landing that releases a task which will not start by itself reaches the
 * project's coordinator conversation, naming that task.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-dependent-ready-delivery.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * 2026-09-23, project 34Tcl0kralZrY8opuLJU4: seven tasks DONE, one OPEN, no open items. The OPEN
 * one depended on a prerequisite that had been DONE and landed since 12:19; it carried
 * `autoRunWhenReady = false` — on purpose, the project's instructions say downstream work is
 * started by the coordinator after its prerequisite lands — and it had never been started. The
 * coordinator was woken at 12:19 and 12:31, both times about the landing, and then sat idle. None
 * of the wake events there were is "a dependent can now start and nothing will start it", so the one
 * decision left in the project reached nobody, and the project stood still until a person looked.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * Through the two production edges that release a dependent — `MergeReceiptService.record` (how
 * an agent records its own merge; the runner's integration result reaches the same
 * `deliverProjectFactsAfterCommit`) and `TasksService.dispatchDependentsAfterCompletion` (what the
 * runner door calls when a task settles DONE) — over the real router, the real producer, the real
 * ledger and the real conversation table. Nothing here calls the producer directly.
 *
 * Every "nothing was delivered" is paired, in the same fixture, with the one change that makes it
 * delivered — a landing on the line, a sibling one flag away, a live conversation to tell — so a
 * producer nobody calls and a producer that delivers everything both fail.
 *
 *   (a) the landing that releases an `autoRunWhenReady = false` dependent puts exactly one message
 *       on the standing conversation, under the fact's own key, naming that dependent — and starts
 *       nothing;
 *   (b) a dependent that starts by itself is not delivered; the landing starts it instead;
 *   (c) DONE is not the trigger: a prerequisite that is DONE and not landed on the integration line
 *       tells nobody, and a receipt into some other branch does not either;
 *   (d) one generation is one message however often it is re-derived, and the next generation
 *       (the prerequisite reopened and finished again) is a second one;
 *   (e) the database accepts exactly the live events and the retired ones — every event that was
 *       live before this fact is unchanged, and the events added since (DEPENDENT_READY, then
 *       PROJECT_SETTLED_UNMERGED) are new.
 *
 * And the delivery guarantee (contract §4.4): a coordinator busy with a message it has not read
 * gets this one queued behind it rather than refused; one that has ended is never written to or
 * revived, the key goes back, and the dependent waits on the owner's Ready-to-run list; a
 * switched-off coordinator is refused once and told nothing.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The declaration every task here carries; never the thing under test. */
const CHECK = {
  completionCriterion: 'EXECUTABLE' as const,
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

/**
 * The events that were live before this one, by name and in their order: the nine this fact's task
 * was filed against, and `TASK_DISPATCH_REFUSED`, which a sibling landed first (migration 0298).
 */
const LIVE_BEFORE = [
  'ATTEMPT_ENDED_UNSETTLED',
  'ATTEMPT_BUDGET_SPENT',
  'PROJECT_TASKS_SETTLED',
  'PROJECT_ACCEPTANCE_LANDED',
  'CRITERION_READY',
  'CRITERION_UNLANDED',
  'COMPLETION_EVIDENCE_REVISED',
  'COMPLETION_ACK_STALE',
  'CRITERIA_DECISION_PENDING',
  'TASK_DISPATCH_REFUSED',
];

const sha = (nibble: string) => nibble.repeat(40);

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

/** The production wiring, over one client: the router with every door, and J10's dispatch. */
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
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, delivery),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, delivery),
    new CriterionUnlandedProducer(prisma, convergence),
    new TaskDispatchRefusalProducer(prisma, convergence, delivery),
    new DependentReadyProducer(prisma, convergence, delivery),
  );
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router);
  const receipts = new MergeReceiptService(prisma, router, tasks);
  return { db, prisma, tasks, receipts };
}

/**
 * What `project.coordinator_session_id` points at when the landing arrives:
 *
 *   * `PARKED` — a live conversation between turns (`AWAITING_INPUT`);
 *   * `BUSY`   — one that has been told something and has not read it yet: `PENDING`, with that
 *     message still queued. The state a coordinator is in right after the platform told it about
 *     the very landing that released the dependent;
 *   * `ENDED`  — a conversation that finished (`SUCCEEDED`, completed);
 *   * `FILED`  — one filed as Completed while between turns: live by status, over by lifecycle.
 *     `createTurn` would queue onto it; the delivery must not;
 *   * `NONE`   — a project nobody has opened a coordinator for.
 */
type Coordinator = 'PARKED' | 'BUSY' | 'ENDED' | 'FILED' | 'NONE';

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string | null;
  /** The unread message a BUSY coordinator is holding. */
  unreadTurnClientId: string | null;
  /** The project's integration line, as a merge receipt spells its target. */
  branch: string;
}

/** One live coordinator conversation of the given shape, with its opening prompt as a turn. */
async function coordinatorSession(
  db: PrismaClient,
  ids: { ownerId: string; runnerId: string; workspaceId: string },
  label: string,
  shape: Exclude<Coordinator, 'NONE'>,
): Promise<{ sessionId: string; unreadTurnClientId: string | null }> {
  const sessionId = randomUUID();
  const status = shape === 'ENDED'
    ? RunStatus.SUCCEEDED
    : shape === 'BUSY' ? RunStatus.PENDING : RunStatus.AWAITING_INPUT;
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: ids.ownerId,
      creatorId: ids.ownerId,
      workspaceId: ids.workspaceId,
      assignedRunnerId: ids.runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      status,
      // What `ProjectsService.coordinator` writes: a person's conversation, not a judgment session.
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      ...(shape === 'ENDED' || shape === 'FILED' ? { completedAt: new Date() } : {}),
    },
  });
  // A conversation somebody has been talking to has its opening prompt on the row as a turn, so
  // the delivery below is not the thing that seeds it.
  await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(sessionId),
      kind: 'message',
      content: `协调：${label}`,
      status: 'ANSWERED',
    },
  });
  if (shape !== 'BUSY') return { sessionId, unreadTurnClientId: null };
  const unreadTurnClientId = `message:${randomUUID()}`;
  await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 2,
      clientTurnId: unreadTurnClientId,
      kind: 'message',
      content: '【项目有干完但还没落 main 的成果】（还没读）',
      status: 'PENDING',
    },
  });
  return { sessionId, unreadTurnClientId };
}

/** An owner, one online runner, one workspace, a coordinated project and its integration line. */
async function world(
  stack: Stack,
  label: string,
  options: { coordinator?: Coordinator; coordinatorEnabled?: boolean } = {},
): Promise<World> {
  const db = stack.db;
  const ids = {
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
  };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${ids.ownerId}@dependent-ready.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // Room for every run a fixture here means to start, so a dependent that did not start is
      // never one the RUNNER held back.
      maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`,
      enabled: true, repoUrl: 'https://github.com/example/dependent-ready',
    },
  });

  const shape = options.coordinator ?? 'PARKED';
  const coordinator = shape === 'NONE'
    ? { sessionId: null, unreadTurnClientId: null }
    : await coordinatorSession(db, ids, label, shape);
  await db.project.create({
    data: {
      id: ids.projectId,
      ownerId: ids.ownerId,
      title: `${label} 下游开工`,
      goal: '前置落地之后，下游由协调会话手工开工',
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: ids.workspaceId,
      ...(coordinator.sessionId ? { coordinatorSessionId: coordinator.sessionId } : {}),
    },
  });
  await db.projectRuntime.upsert({
    where: { projectId: ids.projectId }, create: { projectId: ids.projectId }, update: {},
  });

  // The integration line, as `startOnFirstIntegration` leaves it: a project branch that work has
  // started landing on, so a prerequisite's DONE is not its landing (§2.5 J9).
  const branch = `project/${ids.projectId.slice(0, 8)}`;
  await db.projectCodebase.create({
    data: {
      ownerId: ids.ownerId,
      projectId: ids.projectId,
      canonicalRepoUrl: 'https://github.com/example/dependent-ready',
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${branch}`,
      refAuthority: 'REMOTE',
      remoteName: 'origin',
      integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: new Date(),
    },
  });
  return {
    ...ids,
    coordinatorSessionId: coordinator.sessionId,
    unreadTurnClientId: coordinator.unreadTurnClientId,
    branch,
  };
}

/** A task filed under the project through the door a person and an agent both use. */
async function task(stack: Stack, w: World, title: string): Promise<string> {
  const created = await stack.tasks.create(w.ownerId, {
    title,
    projectId: w.projectId,
    assigneeId: w.workspaceId,
    // Never on creation: a task that opts in with no edge yet is started by the create path.
    autoRunWhenReady: false,
    ...CHECK,
  } as never);
  return created.id;
}

/** A finished piece of code work: DONE, with the worktree session whose branch it is. */
async function donePrerequisite(
  stack: Stack,
  w: World,
  label: string,
): Promise<{ taskId: string; sessionId: string }> {
  const taskId = await task(stack, w, label);
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      // Over: a live session would hold the prerequisite in a way that has nothing to do with this.
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      // §1.1 `isCodeTask`'s whole evidence: it ran in a worktree, on a branch.
      isolationStatus: 'worktree',
      branch: `orbit/${label}-${taskId.slice(0, 8)}`,
      completedAt: new Date(),
    },
  });
  await stack.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  return { taskId, sessionId };
}

/**
 * A task that waits on these prerequisites, with its edges in place before anything else.
 *
 * `autoRun` is written straight to the row after the edges exist: `create` with the flag set and
 * no prerequisite yet is itself a dispatch, and this fixture is about what the PREREQUISITE's
 * landing releases.
 */
async function dependentOf(
  stack: Stack,
  w: World,
  title: string,
  prerequisiteIds: string[],
  options: { autoRun?: boolean } = {},
): Promise<string> {
  const taskId = await task(stack, w, title);
  for (const dependsOnTaskId of prerequisiteIds) {
    await stack.db.taskDependency.create({ data: { taskId, dependsOnTaskId } });
  }
  if (options.autoRun) {
    await stack.db.task.update({ where: { id: taskId }, data: { autoRunWhenReady: true } });
  }
  return taskId;
}

/** The completion edge, called exactly as the runner door calls it when a task settles DONE. */
const completionEdge = (stack: Stack, w: World, doneTaskId: string) =>
  stack.tasks.dispatchDependentsAfterCompletion(w.ownerId, doneTaskId);

/** Record one merge exactly as an agent merging in its own worktree records it. */
function land(
  stack: Stack,
  w: World,
  sessionId: string,
  targetBranch: string,
  nibble = 'a',
) {
  return stack.receipts.record(w.ownerId, sessionId, {
    result: 'MERGED',
    sourceSha: sha(nibble),
    targetBranch,
    targetShaBefore: sha('b'),
    targetShaAfter: sha('c'),
  } as never, 'AGENT');
}

function dependentWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'DEPENDENT_READY' },
    select: {
      subjectType: true,
      subjectId: true,
      subjectVersion: true,
      status: true,
      refusalCode: true,
      sessionId: true,
      delivery: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Every message the platform or anybody else put on this project's coordinator conversation, oldest
 * first — except its own opening prompt, and except the unread message a BUSY fixture seeded.
 */
function coordinatorMessages(db: PrismaClient, w: World) {
  const sessionId = w.coordinatorSessionId ?? '00000000-0000-0000-0000-000000000000';
  return db.conversationTurn.findMany({
    where: {
      sessionId,
      kind: 'message',
      clientTurnId: {
        notIn: [
          SessionsService.initialTurnClientId(sessionId),
          ...(w.unreadTurnClientId ? [w.unreadTurnClientId] : []),
        ],
      },
    },
    select: { clientTurnId: true, content: true, status: true, sendIntent: true },
    orderBy: { seq: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** How many work runs exist for a task — the only honest evidence that it started. */
const runCount = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId, startsTaskWork: true } });

/** The owner's own surface: what the project page offers to start. */
const readyToRun = (stack: Stack, w: World) =>
  readProjectReadyToRun(stack.prisma, w.ownerId, w.projectId, 20);

// -------------------------------------------------------------------------------------------------
// (a) The landing that releases a dependent which will not start by itself reaches the coordinator.
// -------------------------------------------------------------------------------------------------

test('(a) a landing that releases a dependent which will not start by itself tells the coordinator, naming it',
  { skip, timeout: 120_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'released');
      const prerequisite = await donePrerequisite(stack, w, 'prerequisite');
      const dependent = await dependentOf(stack, w, '下游：前置落地后由协调会话开工', [prerequisite.taskId]);

      // The premise, read off the database rather than assumed: finished, landed nowhere, and so
      // not something anybody can start yet — the run queue does not offer it.
      await completionEdge(stack, w, prerequisite.taskId);
      const before = await readyToRun(stack, w);
      assert.equal(before.items.some((item) => item.taskId === dependent), false,
        'the dependent was startable before its prerequisite landed');
      assert.deepEqual(await coordinatorMessages(stack.db, w), []);

      await land(stack, w, prerequisite.sessionId, w.branch);

      const wakes = await dependentWakes(stack.db, w.projectId);
      assert.equal(wakes.length, 1, 'the landing released the dependent and told nobody');
      const [row] = wakes;
      assert.equal(row!.status, 'DELIVERED', `refused with ${row!.refusalCode}`);
      assert.equal(row!.subjectType, 'TASK');
      assert.equal(row!.subjectId, dependent,
        'the fact is about some task other than the dependent');
      assert.equal(row!.sessionId, w.coordinatorSessionId,
        'the fact reached something other than the conversation the project is coordinated from');

      const said = await coordinatorMessages(stack.db, w);
      assert.equal(said.length, 1);
      const [message] = said;
      assert.equal(
        message!.clientTurnId,
        coordinatorDeliveryTurnId(wakeIdempotencyKey({
          event: 'DEPENDENT_READY',
          subjectType: 'TASK',
          subjectId: row!.subjectId,
          subjectVersion: row!.subjectVersion,
        })),
        'the turn was written under a key that is not the fact\'s own identity',
      );
      assert.deepEqual(row!.delivery, { clientTurnId: message!.clientTurnId });
      // G6's carrier: a queued next turn, never a steer into whatever the conversation is doing.
      assert.equal(message!.sendIntent, 'NEXT_TURN');
      // Named, in the spelling every tool the coordinator can call takes back, and by its title.
      assert.match(message!.content ?? '', new RegExp(uuidToBase62(dependent)));
      assert.match(message!.content ?? '', /下游：前置落地后由协调会话开工/);
      assert.match(message!.content ?? '', /task_start/);

      // Told, and nothing more: starting is the decision the flag reserves for the coordinator.
      assert.equal(await runCount(stack.db, dependent), 0, 'the fact started the dependent itself');
      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);
      const after = await readyToRun(stack, w);
      assert.equal(
        after.items.some((item) => item.taskId === dependent && item.runState === 'READY'), true,
        'the delivered dependent is not what the run queue offers to start',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (b) A dependent that starts by itself is not a decision, and is not delivered as one.
// -------------------------------------------------------------------------------------------------

test('(b) a released dependent that starts by itself is not delivered — the landing starts it instead',
  { skip, timeout: 120_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'self-starting');
      const prerequisite = await donePrerequisite(stack, w, 'prerequisite');
      const selfStarting = await dependentOf(
        stack, w, 'starts by itself', [prerequisite.taskId], { autoRun: true },
      );
      // The paired positive, one flag away on the same prerequisite: without it, "nothing about
      // the self-starting one was delivered" is also what a producer nobody calls would say.
      const heldForDecision = await dependentOf(
        stack, w, 'waits for a decision', [prerequisite.taskId],
      );

      await completionEdge(stack, w, prerequisite.taskId);
      await land(stack, w, prerequisite.sessionId, w.branch);

      const wakes = await dependentWakes(stack.db, w.projectId);
      assert.equal(wakes.some((row) => row.subjectId === selfStarting), false,
        'a dependent that starts by itself was put to the coordinator as a decision');
      assert.deepEqual(wakes.map((row) => row.subjectId), [heldForDecision],
        'the sibling one flag away was not delivered either, so the absence above proves nothing');
      assert.equal(wakes[0]!.status, 'DELIVERED');
      // And it really does start by itself: the same landing started it. Were it still waiting,
      // the absence above would say nothing about the flag.
      assert.equal(await runCount(stack.db, selfStarting), 1,
        'the landing did not start the dependent that opted in');
      assert.equal(await runCount(stack.db, heldForDecision), 0);

      const said = await coordinatorMessages(stack.db, w);
      assert.equal(said.length, 1);
      assert.match(said[0]!.content ?? '', new RegExp(uuidToBase62(heldForDecision)));
      assert.doesNotMatch(said[0]!.content ?? '', new RegExp(uuidToBase62(selfStarting)));
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (c) DONE is not the trigger: the landing is.
// -------------------------------------------------------------------------------------------------

test('(c) a prerequisite that is DONE but has not landed tells nobody, and its landing does',
  { skip, timeout: 120_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'done-not-landed');
      const prerequisite = await donePrerequisite(stack, w, 'prerequisite');
      const dependent = await dependentOf(stack, w, 'dependent', [prerequisite.taskId]);

      assert.equal(
        await stack.db.sessionMergeReceipt.count({ where: { taskId: prerequisite.taskId } }), 0,
        'the fixture recorded a landing before the case began',
      );
      // The completion edge, exactly as the runner door calls it when the task settles.
      await completionEdge(stack, w, prerequisite.taskId);
      assert.deepEqual(await dependentWakes(stack.db, w.projectId), [],
        'a prerequisite that was only DONE was delivered as a release');
      assert.deepEqual(await coordinatorMessages(stack.db, w), []);

      // A receipt, but into a branch that is not this project's line: not a landing either.
      const elsewhere = await land(stack, w, prerequisite.sessionId, 'somebody-elses-branch', 'd');
      assert.equal(elsewhere.created, true);
      assert.deepEqual(await dependentWakes(stack.db, w.projectId), [],
        'a receipt into an unrelated branch was read as a landing on the integration line');
      assert.deepEqual(await coordinatorMessages(stack.db, w), []);

      // The one column that changes, through the door that writes it.
      await land(stack, w, prerequisite.sessionId, w.branch);
      const wakes = await dependentWakes(stack.db, w.projectId);
      assert.equal(wakes.length, 1, 'the landing on the line did not release the dependent either');
      assert.equal(wakes[0]!.status, 'DELIVERED');
      assert.equal(wakes[0]!.subjectId, dependent);
      assert.equal((await coordinatorMessages(stack.db, w)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (d) One generation, one message.
// -------------------------------------------------------------------------------------------------

test('(d) one generation is delivered once however often it is re-derived, and the next one again',
  { skip, timeout: 120_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'once-per-generation');
      const prerequisite = await donePrerequisite(stack, w, 'prerequisite');
      const dependent = await dependentOf(stack, w, 'dependent', [prerequisite.taskId]);
      await completionEdge(stack, w, prerequisite.taskId);

      const first = await land(stack, w, prerequisite.sessionId, w.branch);
      assert.equal(first.created, true);
      assert.equal((await coordinatorMessages(stack.db, w)).length, 1,
        'the landing told the coordinator nothing, so every count below would be vacuous');

      // Every way the same readiness is derived again, each one a real knock on a real edge: the
      // same receipt reported a second time (`record` answers the first row and delivers again),
      const replay = await land(stack, w, prerequisite.sessionId, w.branch);
      assert.equal(replay.created, false, 'the replay wrote a second receipt');
      // the same work landing a second time, on the upstream (a promotion into main),
      const promoted = await land(stack, w, prerequisite.sessionId, 'main', 'e');
      assert.equal(promoted.created, true);
      // and the completion edge once more.
      await completionEdge(stack, w, prerequisite.taskId);

      const once = await dependentWakes(stack.db, w.projectId);
      assert.equal(once.length, 1, 'one readiness became two facts');
      assert.equal(once[0]!.status, 'DELIVERED');
      assert.equal((await coordinatorMessages(stack.db, w)).length, 1,
        'the same generation was said to the coordinator twice');

      // The paired positive: the NEXT generation. The prerequisite is reopened and finished again,
      // so the work the dependent would start on is not the work the coordinator was told about.
      // Without this half, "one message" is also the answer of a key that can never move.
      await stack.db.task.update({
        where: { id: prerequisite.taskId }, data: { status: TaskStatus.OPEN },
      });
      await stack.db.task.update({
        where: { id: prerequisite.taskId }, data: { status: TaskStatus.DONE },
      });
      await completionEdge(stack, w, prerequisite.taskId);

      const twice = await dependentWakes(stack.db, w.projectId);
      assert.equal(twice.length, 2, 'a new generation of the readiness was never delivered');
      assert.equal(twice[1]!.status, 'DELIVERED');
      assert.equal(twice[1]!.subjectId, dependent);
      assert.notEqual(twice[1]!.subjectVersion, twice[0]!.subjectVersion);
      assert.equal((await coordinatorMessages(stack.db, w)).length, 2);
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (e) The closed set, as the database holds it: the earlier events unchanged, the new ones added.
// -------------------------------------------------------------------------------------------------

test('(e) the database accepts exactly the live and retired events: those that were live are unchanged, and the events added since are new',
  { skip, timeout: 120_000 }, async () => {
    const stack = await connect();
    try {
      // The closed set this unit states, against the one it replaced.
      // Written for 0299; 0300 added a second spelling, and it is listed here rather than
      // loosened: every event that was live before DEPENDENT_READY is still unchanged.
      assert.deepEqual(
        [...COORDINATOR_WAKE_EVENTS], [...LIVE_BEFORE, 'DEPENDENT_READY', 'PROJECT_SETTLED_UNMERGED'],
        'the live set is not the one it was plus the events added since');

      // The CHECK as the migrated database holds it — not the migration's text, which is what
      // `coordinator-wake.spec.ts` reads: this is the constraint every INSERT actually meets.
      const [constraint] = await stack.db.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(c.oid) AS "definition"
          FROM pg_constraint c
         WHERE c.conname = 'project_coordinator_wake_event_chk'`;
      assert.ok(constraint, 'project_coordinator_wake no longer constrains its event column');
      const accepted = [...constraint.definition.matchAll(/'([A-Z_]+)'/g)]
        .map((hit) => hit[1]!).sort();
      assert.deepEqual(
        accepted, [...COORDINATOR_WAKE_EVENTS, ...RETIRED_COORDINATOR_WAKE_EVENTS].sort(),
      );

      // And the rows: every live event can be written, the earlier ones exactly as before, and a
      // spelling in neither list cannot — so the set is closed, not merely widened. Every row is
      // about a TASK, the one subject every event accepts (0201 holds COMPLETION_ACK_STALE to it),
      // so the event is the only thing that differs between the rows that land and the one that
      // cannot.
      const w = await world(stack, 'closed-set');
      const subjectId = randomUUID();
      for (const event of COORDINATOR_WAKE_EVENTS) {
        await stack.db.projectCoordinatorWake.create({
          data: {
            id: randomUUID(),
            projectId: w.projectId,
            event,
            subjectType: 'TASK',
            subjectId,
            subjectVersion: 'closed-set',
            idempotencyKey: `closed-set:${w.projectId}:${event}`,
            status: 'REFUSED',
            refusalCode: 'CLOSED_SET_CENSUS',
          },
        });
      }
      await assert.rejects(
        stack.db.projectCoordinatorWake.create({
          data: {
            id: randomUUID(),
            projectId: w.projectId,
            event: 'NOT_A_WAKE_EVENT',
            subjectType: 'TASK',
            subjectId,
            subjectVersion: 'closed-set',
            idempotencyKey: `closed-set:${w.projectId}:NOT_A_WAKE_EVENT`,
            status: 'REFUSED',
            refusalCode: 'CLOSED_SET_CENSUS',
          },
        }),
        (error: unknown) => /project_coordinator_wake_event_chk/.test(String(
          (error as { message?: string })?.message ?? error,
        )),
        'the event column accepted a spelling in neither the live nor the retired list',
      );
      assert.equal(
        await stack.db.projectCoordinatorWake.count({ where: { projectId: w.projectId } }),
        COORDINATOR_WAKE_EVENTS.length,
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// The delivery guarantee (contract §4.4): busy is a queue, ended is never written to.
// -------------------------------------------------------------------------------------------------

test('a coordinator still holding an unread message gets this one queued behind it, not refused',
  { skip, timeout: 120_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'busy', { coordinator: 'BUSY' });
      const prerequisite = await donePrerequisite(stack, w, 'prerequisite');
      const dependent = await dependentOf(stack, w, 'dependent', [prerequisite.taskId]);
      await completionEdge(stack, w, prerequisite.taskId);
      await land(stack, w, prerequisite.sessionId, w.branch);

      const [row] = await dependentWakes(stack.db, w.projectId);
      assert.ok(row, 'the landing never reached the ledger');
      assert.equal(row.status, 'DELIVERED',
        `a coordinator that had not read its last message refused this one (${row.refusalCode})`);
      assert.equal(row.subjectId, dependent);

      // Queued behind the message it has not read, which is where it is read: when the turn in
      // front of it is over.
      const queued = await stack.db.conversationTurn.findMany({
        where: { sessionId: w.coordinatorSessionId!, kind: 'message', status: 'PENDING' },
        select: { clientTurnId: true },
        orderBy: { seq: 'asc' },
      });
      assert.deepEqual(
        queued.map((turn) => turn.clientTurnId),
        [w.unreadTurnClientId, (row.delivery as { clientTurnId: string }).clientTurnId],
      );
      const conversation = await stack.db.session.findUniqueOrThrow({
        where: { id: w.coordinatorSessionId! }, select: { status: true },
      });
      assert.equal(conversation.status, RunStatus.PENDING);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a coordinator conversation that has ended is not written to: the key goes back and the dependent waits on the owner\'s Ready list',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      for (const shape of ['ENDED', 'FILED', 'NONE'] as const) {
        const w = await world(stack, `gone-${shape.toLowerCase()}`, { coordinator: shape });
        const prerequisite = await donePrerequisite(stack, w, 'prerequisite');
        const dependent = await dependentOf(stack, w, 'dependent', [prerequisite.taskId]);
        const before = w.coordinatorSessionId
          ? await stack.db.session.findUniqueOrThrow({
            where: { id: w.coordinatorSessionId }, select: { status: true },
          })
          : null;
        await completionEdge(stack, w, prerequisite.taskId);
        await land(stack, w, prerequisite.sessionId, w.branch);

        const wakes = await dependentWakes(stack.db, w.projectId);
        assert.equal(wakes.length, 1, `${shape}: the landing never reached the ledger`);
        assert.equal(wakes[0]!.status, 'REFUSED', `${shape}: delivered to nobody's conversation`);
        assert.equal(
          wakes[0]!.refusalCode,
          shape === 'NONE'
            ? DELIVERY_NO_COORDINATOR_SESSION
            : DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
        );
        assert.equal(wakes[0]!.sessionId, null);
        assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);
        if (w.coordinatorSessionId) {
          assert.deepEqual(await coordinatorMessages(stack.db, w), [],
            `${shape}: a conversation that is over was written to`);
          const after = await stack.db.session.findUniqueOrThrow({
            where: { id: w.coordinatorSessionId }, select: { status: true },
          });
          assert.equal(after.status, before!.status,
            `${shape}: the delivery revived the conversation`);
        }
        // The owner's surface: the dependent is what the project page offers to start.
        const ready = await readyToRun(stack, w);
        assert.equal(
          ready.items.some((item) => item.taskId === dependent && item.runState === 'READY'), true,
          `${shape}: the undeliverable dependent is not on the owner's Ready-to-run list`,
        );

        // And the refusal gave the key back: once the project has a conversation to tell, the same
        // readiness — same dependent, same generation — reaches it at the next knock.
        const next = await coordinatorSession(stack.db, w, `next-${shape.toLowerCase()}`, 'PARKED');
        await stack.db.project.update({
          where: { id: w.projectId }, data: { coordinatorSessionId: next.sessionId },
        });
        await completionEdge(stack, w, prerequisite.taskId);
        const again = await dependentWakes(stack.db, w.projectId);
        assert.equal(again.length, 2, `${shape}: the refused fact could not be delivered later`);
        assert.equal(again[1]!.status, 'DELIVERED');
        assert.equal(again[1]!.subjectVersion, again[0]!.subjectVersion);
        assert.equal(again[1]!.sessionId, next.sessionId);
      }
    } finally {
      await stack.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// The switch: registered in `coordinator-disabled-negatives.spec.ts`, whose census reads this body.
// -------------------------------------------------------------------------------------------------

test('a released dependent under a switched-off coordinator is refused once, told nothing, and opens nothing',
  { skip, timeout: 120_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'switched-off', { coordinatorEnabled: false });
      const prerequisite = await donePrerequisite(stack, w, 'prerequisite');
      const dependent = await dependentOf(stack, w, 'dependent', [prerequisite.taskId]);
      await completionEdge(stack, w, prerequisite.taskId);
      await land(stack, w, prerequisite.sessionId, w.branch);

      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);
      // Exactly one row, and not zero: the ledger claims before it authorizes, so a fact refused
      // on the switch travelled the whole way — zero would also be a producer nobody calls.
      const wakes = await dependentWakes(stack.db, w.projectId);
      assert.equal(wakes.length, 1, 'the released dependent never reached the ledger');
      const [row] = wakes;
      assert.equal(row!.status, 'REFUSED');
      assert.equal(row!.refusalCode, DEPENDENT_READY_WAKE_COORDINATOR_DISABLED);
      assert.equal(row!.sessionId, null);
      assert.equal(row!.subjectId, dependent);
      assert.deepEqual(await coordinatorMessages(stack.db, w), [],
        'the switched-off coordinator was told anyway');
      // Refused before the convergence ledger: the switch is the cheapest refusal, asked first.
      assert.equal(
        await stack.db.projectConvergenceDecision.count({ where: { projectId: w.projectId } }), 0,
      );
      assert.equal(await runCount(stack.db, dependent), 0);
    } finally {
      await stack.db.$disconnect();
    }
  });
