import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

import { RunStatus as SharedRunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { type WakeFact, criterionSubjectId, criterionUnlandedFact } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CRITERION_READY_CONSUMER, CriterionReadyProducer } from '../projects/criterion-ready.producer';
import {
  CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED,
  CriterionUnlandedProducer,
} from '../projects/criterion-unlanded.producer';
import { criteriaFromDefinitions } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { ProjectsService } from '../projects/projects.service';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * What an authorized wake is spent on, once "where is the work" is one of the things it is spent
 * over.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-landing-wake-disposition.pg.spec.js
 *
 * WHY THE THREE INPUTS ARE THREE PROJECTS
 * =======================================
 * Because two of the three answers are counted in SESSIONS, and a session is a row about an owner
 * rather than about a criterion. "This input opened none" written inside a project that opened one
 * for a different criterion is a subtraction, and a subtraction is exactly what a rule that opened
 * one session too many would still satisfy. Each input therefore gets its own owner, its own
 * project and its own criterion, and each is asked for a whole ledger and a whole session list.
 *
 * Every fixture files one chore task that serves no criterion and never finishes, so no project
 * here can settle: `PROJECT_TASKS_SETTLED` opens a judgment session of its own, and a case that
 * let one through could not tell that session from the one it is asserting.
 *
 * WHAT SETTLES THE WORK
 * =====================
 * Nothing here writes a task status. Every serving task carries a declared acceptance command and
 * reaches DONE or FAILED the way production does it: `turnComplete` queues the command,
 * `dequeueTurn` reserves it, bash runs it, and `turnComplete` compares the code it returned with
 * the declared one under the task's own row lock.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';
/** A declaration whose command agrees with it, so the comparison derives DONE. */
const FINISHES = { acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };
/** A declaration whose command disagrees with it, so the comparison derives FAILED. */
const FAILS = { acceptanceCommand: 'exit 7', acceptanceExpectedExitCode: 0 };

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
  /** The runner door, holding the one `TasksService` the production module gives it. */
  api: RunnerApiController;
  tasks: TasksService;
  projects: ProjectsService;
  /** The unit under test, so one case can hand it the same fact twice over two worlds. */
  disposition: WakeDispositionService;
}

/**
 * The production wiring, over one client.
 *
 * `silent` replaces the router with four doors that deliver nothing. It is taken by the one case
 * that has to deliver a fact by hand — the fact's idempotency key is a total function of the fact,
 * so a case that let the write path deliver first would find every later delivery answering
 * ALREADY_AWAKE and could not observe a decision at all.
 */
async function connect(options: { silent?: boolean } = {}): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const disposition = new WakeDispositionService(
    prisma,
    new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
    new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
  );
  const wired = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorConvergenceService(prisma),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    disposition,
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  const silent = {
    routeSettledProjects: async () => [],
    routeTaskExceptions: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
  } as unknown as CompletionInputRouter;
  const router = options.silent ? silent : wired;
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    // No attempt-budget meter: `ATTEMPT_BUDGET_SPENT` is a different fact with its own producer,
    // and a second event kind in these ledgers would make "which fact opened this session" a
    // question the assertions could not answer.
    undefined,
    undefined,
    tasks,
  );
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
  return { db, api, tasks, projects, disposition };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The task that serves no criterion and never finishes, so the project cannot settle. */
  choreTaskId: string;
  /** The standing conversation this project is coordinated from, parked between turns. */
  coordinatorSessionId: string;
}

async function fixture(
  stack: Stack,
  label: string,
  options: { coordinatorEnabled?: boolean } = {},
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@landing-disposition.invalid`,
      name: label,
      passwordHash: 'x',
    },
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
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  // The conversation a person opened to drive this project, in the state a standing coordinator is
  // in between turns: AWAITING_INPUT, which is one of `SessionsService.LIVE`, so a delivery to it
  // APPENDS a turn instead of reviving anything. `dispatch_origin` is USER because that is what
  // `ProjectsService.coordinator` writes — it is the column that tells this conversation apart
  // from a judgment session, and every count of judgment sessions below depends on the difference.
  const coordinatorSessionId = randomUUID();
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
    },
  });
  // A conversation that has been running has its opening prompt on the row as a turn: the first
  // thing `createTurn` does for a session with none is seed one (`ensurePromptSeeded`). Written
  // here so that the state under test is a coordinator somebody has actually been talking to,
  // and so that the delivery below is not the thing that seeds it.
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `协调：${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 落地唤醒项目`,
      goal: '干完了但没落 main，也值得唤醒',
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const chore = await stack.tasks.create(ownerId, {
    title: `${label} 与任何标准无关的杂活`,
    assigneeId: workspaceId,
    projectId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
  } as never);
  return {
    ownerId, runnerId, workspaceId, projectId, choreTaskId: chore.id, coordinatorSessionId,
  };
}

/**
 * Every message this project's standing conversation has been SENT, oldest first.
 *
 * The seeded opening turn is excluded, exactly as `SessionsService`'s own queued-turn reader
 * excludes it: it is the conversation's own prompt rather than something anybody told it, and
 * counting it would make "was this coordinator told about the merge" answer yes for a conversation
 * nobody has said a word to.
 */
function coordinatorMessages(db: PrismaClient, f: Fixture) {
  return db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    select: { clientTurnId: true, content: true },
    orderBy: { seq: 'asc' },
  });
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]) {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems);
}

/** File one piece of EXECUTABLE work against a criterion, through the door that resolves the key. */
async function serve(
  stack: Stack,
  f: Fixture,
  criterionKey: string,
  title: string,
  declaration: typeof FINISHES | typeof FAILS,
) {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    criterionKey,
    ...declaration,
  } as never);
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
}

/**
 * Record that this task's branch was merged into `main`.
 *
 * Written the way the three production writers of a receipt write one — a session of the task, a
 * `MERGED` result, and the branch the runner would have auto-detected — because what is under test
 * is what the DERIVATION does with a receipt, not how git produces one.
 */
async function recordLanding(stack: Stack, f: Fixture, taskId: string, label: string) {
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: `${label}-merge`,
      prompt: `${label}-merge`,
      provider: 'claude',
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await stack.db.sessionMergeReceipt.create({
    data: {
      ownerId: f.ownerId,
      sessionId,
      taskId,
      projectId: f.projectId,
      result: 'MERGED',
      sourceBranch: `orbit/${label}`,
      sourceSha: 'a'.repeat(40),
      targetBranch: 'main',
      targetShaBefore: 'b'.repeat(40),
      targetShaAfter: 'c'.repeat(40),
      recordedBy: 'AGENT',
      idempotencyKey: `landed:${taskId}`,
    },
  });
}

/**
 * Run one task's declared acceptance command the way production runs it, and return the status the
 * comparison derived. This function never writes `task.status`.
 */
async function runAcceptance(
  stack: Stack,
  f: Fixture,
  taskId: string,
  label: string,
  declaration: typeof FINISHES | typeof FAILS,
): Promise<TaskStatus> {
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await stack.db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'execute the task',
      status: 'IN_FLIGHT',
    },
  });
  const opened = await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: messageTurnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  assert.deepEqual(opened, { ok: true, status: RunStatus.RUNNING });

  const next = await (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, f.runnerId, null);
  assert.ok(next);
  assert.equal(next.kind, 'shell');
  assert.equal(next.taskAcceptance, true);
  assert.equal(next.content, declaration.acceptanceCommand, 'the queued command is the declared one');

  const shell = spawnSync('bash', ['-lc', next.content!], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: next.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: `${shell.stdout}${shell.stderr}`,
  });
  return (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status;
}

/** Drive one serving task to DONE and assert that is what the comparison derived. */
async function finish(stack: Stack, f: Fixture, taskId: string, label: string) {
  assert.equal(
    await runAcceptance(stack, f, taskId, label, FINISHES), TaskStatus.DONE,
    'the comparison between the declared code and the one bash returned is what wrote this status',
  );
}

/** Drive one serving task to FAILED the same way, which is what strands its criterion. */
async function fail(stack: Stack, f: Fixture, taskId: string, label: string) {
  assert.equal(await runAcceptance(stack, f, taskId, label, FAILS), TaskStatus.FAILED);
}

const WAKE_COLUMNS = {
  event: true,
  subjectType: true,
  subjectId: true,
  status: true,
  refusalCode: true,
  consumerType: true,
  sessionId: true,
} as const;

function wakesOf(db: PrismaClient, projectId: string, event: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event },
    select: WAKE_COLUMNS,
    orderBy: { id: 'asc' },
  });
}

const unlandedWakes = (db: PrismaClient, projectId: string) =>
  wakesOf(db, projectId, 'CRITERION_UNLANDED');

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** Nothing below may reach the door that opened judgment sessions before this rule existed. */
async function assertProjectNeverSettled(stack: Stack, f: Fixture) {
  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: f.choreTaskId } })).status,
    TaskStatus.OPEN,
  );
  assert.deepEqual(
    await wakesOf(stack.db, f.projectId, 'PROJECT_TASKS_SETTLED'), [],
    'a settled-project wake could have opened the session this case attributes to a criterion',
  );
}

/**
 * Where one input ended: the whole ledger row it produced, and how many sessions its owner got.
 *
 * The session count is part of the endpoint rather than a separate assertion because it is the
 * half a ledger row cannot state. `SESSION_OPENED` on a row says a session was bound to THAT fact;
 * only counting the owner's sessions says no OTHER fact opened one beside it.
 */
interface Endpoint {
  event: string;
  subjectType: string;
  status: string;
  consumerType: string | null;
  namesItsSession: boolean;
  judgmentSessions: number;
}

async function endpointOf(
  stack: Stack,
  f: Fixture,
  event: string,
  subjectId: string,
): Promise<Endpoint> {
  const rows = (await wakesOf(stack.db, f.projectId, event))
    .filter((row) => row.subjectId === subjectId);
  assert.equal(rows.length, 1, `${event} about ${subjectId} left ${rows.length} ledger rows`);
  const row = rows[0]!;
  const opened = await judgmentSessions(stack.db, f.ownerId);
  if (row.sessionId !== null) {
    // Which session a row may name depends on how it reached one, and the two are not
    // interchangeable: a judged fact names the conversation opened FOR it, a delivered one names
    // the conversation that was already there. A row naming the other one would satisfy every
    // count below while meaning the opposite thing.
    assert.equal(
      row.status === 'DELIVERED' ? row.sessionId : null,
      row.status === 'DELIVERED' ? f.coordinatorSessionId : null,
      'a delivered fact names a session that is not this project\'s standing coordinator',
    );
    if (row.status !== 'DELIVERED') {
      assert.ok(
        opened.some((session) => session.id === row.sessionId),
        'the ledger row names a session that is not one of this owner\'s judgment sessions',
      );
    }
  }
  return {
    event: row.event,
    subjectType: row.subjectType,
    status: row.status,
    consumerType: row.consumerType,
    namesItsSession: row.sessionId !== null,
    judgmentSessions: opened.length,
  };
}

test('finished work off main, finished work on main and stranded work end in three different places',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      // ── input 1: BACKED, and no receipt puts the result anywhere anybody can merge from ───────
      const off = await fixture(stack, 'backed-off-main');
      const [offMain] = await state(stack, off, ['这条标准的活干完了，但还在分支上']);
      const offWork = await serve(stack, off, offMain!.key, '干完了但没合的那件活', FINISHES);
      await finish(stack, off, offWork, 'off-main');

      const offEnd = await endpointOf(
        stack, off, 'CRITERION_UNLANDED', criterionSubjectId(off.projectId, offMain!.key),
      );
      assert.deepEqual(offEnd, {
        event: 'CRITERION_UNLANDED',
        subjectType: 'CRITERION',
        status: 'DELIVERED',
        consumerType: null,
        namesItsSession: true,
        judgmentSessions: 0,
      });
      // §2.2: the session it names is the one that was already there, and NO session was created.
      // Both halves matter — a row naming the standing conversation while a judgment session was
      // opened beside it would be two coordinators told about one merge.
      assert.equal(
        (await coordinatorMessages(stack.db, off)).length, 1,
        'the standing coordinator was told about the merge exactly once',
      );

      // TWO facts about this one criterion reached the ledger, and exactly one message came of
      // them. That is §2.1 in the live path: readiness is recorded as it always was, the landing
      // fact is what reaches a coordinator, and a merge that is owed once is not asked for twice.
      const offReady = await endpointOf(
        stack, off, 'CRITERION_READY', criterionSubjectId(off.projectId, offMain!.key),
      );
      assert.equal(offReady.status, 'CONSUMED');
      assert.equal(offReady.consumerType, CRITERION_READY_CONSUMER);
      assert.equal(offReady.judgmentSessions, 0, 'the readiness fact opened a session');
      assert.equal(
        (await coordinatorMessages(stack.db, off)).length, 1,
        'the readiness fact sent the standing coordinator a second message',
      );
      await assertProjectNeverSettled(stack, off);

      // ── input 2: the same shape, and a receipt ────────────────────────────────────────────────
      // Everything about this fixture is what the one above is, down to the command that settled
      // it. The single difference is the merge receipt, which is the pairing that makes the row
      // count below mean something other than "nothing ran".
      const on = await fixture(stack, 'backed-on-main');
      const [onMain] = await state(stack, on, ['这条标准的活干完了，而且已经合进 main']);
      const onWork = await serve(stack, on, onMain!.key, '干完了并且合了的那件活', FINISHES);
      await recordLanding(stack, on, onWork, 'on-main');
      await finish(stack, on, onWork, 'on-main');

      assert.deepEqual(
        await unlandedWakes(stack.db, on.projectId), [],
        'a criterion whose every serving task has a MERGED receipt into main is not unlanded',
      );
      const onEnd = await endpointOf(
        stack, on, 'CRITERION_READY', criterionSubjectId(on.projectId, onMain!.key),
      );
      assert.deepEqual(onEnd, {
        event: 'CRITERION_READY',
        subjectType: 'CRITERION',
        status: 'CONSUMED',
        consumerType: CRITERION_READY_CONSUMER,
        namesItsSession: false,
        judgmentSessions: 0,
      });
      assert.deepEqual(
        await coordinatorMessages(stack.db, on), [],
        'a criterion already on main spent a turn of the standing coordinator\'s context',
      );
      await assertProjectNeverSettled(stack, on);

      // ── input 3: nothing is going to deliver this criterion ───────────────────────────────────
      const lost = await fixture(stack, 'stranded');
      const [stranded] = await state(stack, lost, ['服务这条标准的唯一一件活失败了']);
      const lostWork = await serve(stack, lost, stranded!.key, '失败的那件活', FAILS);
      await fail(stack, lost, lostWork, 'stranded');

      const strandedEnd = await endpointOf(stack, lost, 'ATTEMPT_ENDED_UNSETTLED', lostWork);
      assert.deepEqual(strandedEnd, {
        event: 'ATTEMPT_ENDED_UNSETTLED',
        subjectType: 'TASK',
        status: 'SESSION_OPENED',
        consumerType: null,
        namesItsSession: true,
        judgmentSessions: 1,
      });
      assert.deepEqual(
        await unlandedWakes(stack.db, lost.projectId), [],
        'a criterion whose work FAILED is not a criterion whose finished work is off main',
      );
      // §2.2 is about the ONE fact that reports a landing. Work nothing will deliver still opens
      // the judgment session it always did, in a project that has a standing conversation sitting
      // right there — which is what makes the delivery a property of the fact and not of the
      // project's wiring.
      assert.deepEqual(
        await coordinatorMessages(stack.db, lost), [],
        'a stranded criterion was sent to the standing coordinator instead of judged',
      );
      await assertProjectNeverSettled(stack, lost);

      // ── and no two of the three ended in the same place ───────────────────────────────────────
      // Two of the three share a DISPOSITION and are still not the same endpoint, which is the
      // whole point of comparing rows rather than comparing the rule's two return values. Finished
      // work off the branch and work nothing will ever deliver both end in a session, and the
      // coordinator is woken about different things: one names the criterion whose result is
      // nowhere anybody can merge from, the other the task whose attempt ended. The third ends in
      // no session at all.
      const endpoints = [offEnd, onEnd, strandedEnd];
      for (const [index, one] of endpoints.entries()) {
        for (const other of endpoints.slice(index + 1)) {
          assert.notDeepEqual(one, other, 'two of the three inputs ended identically');
        }
      }
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the only thing that moves between waking somebody and recording it is where the work is',
  { skip, timeout: 240_000 }, async () => {
    // The router is silent here so that the fact below is delivered by hand, three times, with a
    // single receipt row as the only thing that changes between the second delivery and the third.
    const stack = await connect({ silent: true });
    try {
      const f = await fixture(stack, 'landing-is-the-variable');
      const [criterion] = await state(stack, f, ['落地是唯一的变量']);
      const only = await serve(stack, f, criterion!.key, '服务这条标准的唯一一件活', FINISHES);
      await finish(stack, f, only, 'landing-variable');
      assert.deepEqual(
        await unlandedWakes(stack.db, f.projectId), [],
        'the silent router delivered something, so the deliveries below are not the only ones',
      );

      // One fact, built once and never rebuilt. It says `UNKNOWN` in all three deliveries — the
      // rule is not permitted to believe it, and the point of holding it fixed is that whatever
      // makes the third delivery answer differently cannot be something the fact told it.
      const fact = criterionUnlandedFact(
        f.projectId,
        criterion!.key,
        [{ taskId: only, status: TaskStatus.DONE }],
        'UNKNOWN',
      );
      assert.ok(fact !== null);
      const allowed = async () => ({ allowed: true as const });

      const first = await stack.disposition.openIfDecisive(fact as WakeFact, allowed);
      assert.deepEqual(first, { outcome: 'DELIVERED' }, 'finished work off main woke nobody');
      const said = await coordinatorMessages(stack.db, f);
      assert.equal(said.length, 1);
      assert.deepEqual(
        await judgmentSessions(stack.db, f.ownerId), [],
        'the delivery opened a judgment session as well as writing to the standing one',
      );

      // The second delivery is what makes the third one readable. It is the SAME fact over the
      // SAME world, and the ledger's answer to that is ALREADY_AWAKE — so `null` is not what a
      // repeat delivery looks like, and the third answer below cannot be the idempotency key.
      const second = await stack.disposition.openIfDecisive(fact as WakeFact, allowed);
      assert.deepEqual(second, { outcome: 'ALREADY_AWAKE' });

      // ── one row: the work is now on main ──────────────────────────────────────────────────────
      await recordLanding(stack, f, only, 'caught-up');

      const third = await stack.disposition.openIfDecisive(fact as WakeFact, allowed);
      assert.equal(
        third, null,
        'the same fact over a world whose only change is a merge receipt still opened a session',
      );

      assert.deepEqual(
        await coordinatorMessages(stack.db, f), said,
        'the recorded answer said it again anyway',
      );
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      const rows = await unlandedWakes(stack.db, f.projectId);
      assert.equal(rows.length, 1, 'three deliveries of one fact are one ledger row');
      assert.equal(rows[0]!.status, 'DELIVERED');
      assert.equal(rows[0]!.sessionId, f.coordinatorSessionId);
      await assertProjectNeverSettled(stack, f);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('finished work off main under a switched-off coordinator is refused once and wakes nobody',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      // ── the control, and it is what makes the negative mean anything ──────────────────────────
      // "Nobody was woken" is true of a switched-off project, of a rule that never reads landing,
      // and of a delivery that never happened. So the same shape runs first with the switch ON.
      const on = await fixture(stack, 'switch-on');
      const [live] = await state(stack, on, ['开关开着，活干完了但还在分支上']);
      const liveWork = await serve(stack, on, live!.key, '开关开着时干完的那件活', FINISHES);
      await finish(stack, on, liveWork, 'switched-on');

      const control = await unlandedWakes(stack.db, on.projectId);
      assert.equal(control.length, 1, 'the control never reached the wake ledger');
      assert.equal(control[0]!.status, 'DELIVERED');
      assert.equal(
        (await coordinatorMessages(stack.db, on)).length, 1,
        'the control never reached a coordinator, so the negative below proves nothing',
      );
      await assertProjectNeverSettled(stack, on);

      // ── and now the same shape with the switch off ────────────────────────────────────────────
      const off = await fixture(stack, 'switch-off', { coordinatorEnabled: false });
      const [dark] = await state(stack, off, ['开关关着，活干完了但还在分支上']);
      const darkWork = await serve(stack, off, dark!.key, '开关关着时干完的那件活', FINISHES);
      await finish(stack, off, darkWork, 'switched-off');

      // Not "zero rows": the ledger claims before it authorizes, so a fact that travelled the whole
      // way and was refused leaves EXACTLY ONE row saying so. Asserting an empty table here would
      // be green over a producer nobody calls, and green over a rule that decided for itself
      // whether the switch was on.
      const refused = await unlandedWakes(stack.db, off.projectId);
      assert.equal(refused.length, 1, 'the unlanded criterion never reached the wake ledger');
      assert.equal(refused[0]!.status, 'REFUSED');
      assert.equal(refused[0]!.refusalCode, CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED);
      assert.equal(refused[0]!.sessionId, null);
      assert.equal(refused[0]!.consumerType, null);
      assert.notEqual(refused[0]!.status, 'SESSION_OPENED');
      assert.notEqual(refused[0]!.status, 'DELIVERED');
      assert.deepEqual(
        await judgmentSessions(stack.db, off.ownerId), [],
        'a switched-off coordinator was woken about a merge',
      );
      assert.deepEqual(
        await coordinatorMessages(stack.db, off), [],
        'a switched-off project\'s standing conversation was written to anyway',
      );

      // The switch is not read by the door that delivers: the work finished exactly as it would
      // have with the switch on, and only the wake was refused.
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: darkWork } })).status,
        TaskStatus.DONE,
      );
      await assertProjectNeverSettled(stack, off);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the landing-disposition PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
