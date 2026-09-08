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
import { PROJECT_NOT_CONVERGING } from '../projects/coordinator-convergence';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionSubjectId } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import {
  CRITERION_UNLANDED_CONSUMER,
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
 * `CRITERION_UNLANDED`: the criterion whose work is finished and is on nobody's default branch.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-criterion-unlanded-delivery.pg.spec.js
 *
 * WHY THE CONTROL IS A SIBLING CRITERION AND NOT A SECOND DELIVERY
 * ===============================================================
 * "Add the receipt and deliver again, expect nothing" cannot on its own tell a working landing
 * clause from a deleted producer, and it cannot even tell one from an untouched world: the wake
 * key is a function of the fact, so re-delivering the SAME finished task set answers ALREADY_AWAKE
 * whatever the receipts say. The pairing therefore has to be two worlds that differ by the receipt
 * and by nothing else, each reaching the ledger for the first time — so the first case below
 * states two criteria in one project, serves each with one EXECUTABLE task, settles both through
 * the product's own write path, and records a merge receipt for exactly one of them.
 *
 * It then does the literal second delivery as well, in a shape where idempotency cannot be what
 * suppresses the row: more work is filed against the criterion that DID wake, so its serving set —
 * and therefore its fact version — moves, and this time every serving task carries a receipt. That
 * the version really moved is not asserted by inspection: `CRITERION_READY` is derived from the
 * same serving set at the same moment by a predicate identical to this one except for the landing
 * clause, and it writes its second row while this event writes none.
 *
 * WHAT SETTLES THE WORK
 * =====================
 * Nothing here writes a task status. Every serving task carries a declared acceptance command, and
 * reaches DONE the way most tasks in production do: `turnComplete` queues the command, `dequeueTurn`
 * reserves it, bash runs it, and `turnComplete` compares the code it returned against the declared
 * one under the task's own row lock. What the cases assert is what that DERIVED status delivered.
 *
 * Every fixture files one chore task that serves no criterion and never finishes, so no project
 * here can settle and nothing that lands in the ledger landed because a project ended.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';
/** The declaration every serving task carries, so its DONE is a comparison that happened. */
const ACCEPTANCE = { acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };

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

/** A convergence service that refuses every wake, with the real unit's own refusal code. */
function refusingConvergence(): CoordinatorConvergenceService {
  return {
    authorizeWake: async () => ({ allowed: false as const, refusalCode: PROJECT_NOT_CONVERGING }),
  } as unknown as CoordinatorConvergenceService;
}

interface Stack {
  db: PrismaClient;
  /** The runner door, holding the one `TasksService` the production module gives it. */
  api: RunnerApiController;
  tasks: TasksService;
  projects: ProjectsService;
  /** The same service over a router of the caller's choosing, for the post-commit probe. */
  tasksWith: (router: CompletionInputRouter) => TasksService;
}

/**
 * The production wiring, over one client.
 *
 * `convergence` is the only seam, and it is handed to THIS producer alone: passing a refusing
 * double is how a case asks "was this fact authorized THERE", because a delivery that ate the
 * router's always-allow default would never consult it and would land CONSUMED instead of REFUSED.
 */
async function connect(options: {
  convergence?: CoordinatorConvergenceService;
} = {}): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = options.convergence ?? new CoordinatorConvergenceService(prisma);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorConvergenceService(prisma),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new WakeDispositionService(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
  );
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
  return {
    db,
    api,
    tasks,
    projects,
    tasksWith: (wired) => new TasksService(prisma, sessions, realtime, undefined, wired),
  };
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
      email: `${label}-${ownerId}@criterion-unlanded.invalid`,
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
  // The conversation a person opened to drive this project, parked between turns at
  // AWAITING_INPUT — one of `SessionsService.LIVE`, so a delivery to it appends a turn rather than
  // reviving anything. `dispatch_origin` USER is what `ProjectsService.coordinator` writes, and is
  // what tells it apart from a judgment session in every count below.
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
      title: `${label} 落地项目`,
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
    // This fixture settles its own tasks, one at a time, by hand. Left opted in, the release pass
    // on the completion edge would start whichever of them is still OPEN when the previous one
    // finishes — legitimately, it is a coordinated project of tasks that depend on nothing — and
    // the run this fixture then creates for that task collides with the one already claiming it.
    autoRunWhenReady: false,
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
    select: { clientTurnId: true },
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
async function serve(stack: Stack, f: Fixture, criterionKey: string, title: string) {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    criterionKey,
    ...ACCEPTANCE,
    // Settled by hand below, like the chore above: this fixture is about which FACT a completion
    // produces, not about what the completion starts next.
    autoRunWhenReady: false,
  } as never);
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
}

/**
 * Record that this task's branch was merged into `main`.
 *
 * The receipt is the whole input this event is defined over, and it is written the way the three
 * production writers of it write one: a session of the task, a `MERGED` result, a target branch the
 * runner would have auto-detected, and a target the merge moved to. Written directly rather than
 * through a merge, because what is under test is what the DERIVATION does with a receipt — not how
 * git produces one.
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
 * Settle one task the way production settles most of them: an acceptance command that ran.
 *
 * The whole route is the product's own — an attempt session, the model turn that ends, the shell
 * turn the same transaction queues, a real bash exit code, and the comparison `turnComplete` makes
 * under the task's row lock. This function never writes `task.status`.
 */
async function settleByAcceptance(stack: Stack, f: Fixture, taskId: string, label: string) {
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
  assert.equal(next.content, ACCEPTANCE.acceptanceCommand, 'the queued command is the declared one');

  const shell = spawnSync('bash', ['-lc', next.content!], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  assert.equal(shell.status, ACCEPTANCE.acceptanceExpectedExitCode);
  await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: next.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: `${shell.stdout}${shell.stderr}`,
  });

  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    TaskStatus.DONE,
    'the comparison between the declared code and the one bash returned is what wrote this status',
  );
}

function wakesOf(db: PrismaClient, projectId: string, event: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event },
    select: {
      projectId: true,
      subjectType: true,
      subjectId: true,
      status: true,
      refusalCode: true,
      consumerType: true,
      sessionId: true,
      detail: true,
    },
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

test('finished work off main wakes the coordinator, and the same work on main does not',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'off-main-and-on-main');
      const [landed, stranded] = await state(stack, f, [
        '这条标准的活已经合进 main', '这条标准的活干完了但还在分支上',
      ]);

      // Two criteria, one EXECUTABLE task each, settled by the same route. The ONLY asymmetry is
      // that one of the two tasks has a merge receipt into the default branch.
      const onMain = await serve(stack, f, landed!.key, '已经合进 main 的那件活');
      const onBranch = await serve(stack, f, stranded!.key, '还在分支上的那件活');
      await recordLanding(stack, f, onMain, 'on-main');

      await settleByAcceptance(stack, f, onMain, 'first-of-two');
      await settleByAcceptance(stack, f, onBranch, 'second-of-two');

      const wakes = await unlandedWakes(stack.db, f.projectId);
      assert.equal(
        wakes.length, 1,
        'exactly one of the two finished criteria is off the default branch',
      );
      const row = wakes[0]!;
      assert.equal(row.projectId, f.projectId);
      assert.equal(row.subjectType, 'CRITERION');
      assert.equal(
        row.subjectId, criterionSubjectId(f.projectId, stranded!.key),
        'the fact is about the criterion whose work is on a branch',
      );
      assert.notEqual(
        row.subjectId, criterionSubjectId(f.projectId, landed!.key),
        'a criterion whose every serving task has a MERGED receipt into main is not unlanded',
      );
      assert.equal((row.detail as Record<string, unknown>).criterionKey, stranded!.key);
      assert.equal((row.detail as Record<string, unknown>).landing, 'UNKNOWN');
      for (const taskId of [onMain, onBranch, f.choreTaskId]) {
        assert.notEqual(row.subjectId, taskId, 'the subject is a criterion, not a task');
      }
      // The terminal a finished-but-unlanded criterion gets: `wake-disposition.ts` §2.1 sends this
      // one event to a coordinator, and §2.2 sends it to the one the project already has — so the
      // row names that standing conversation instead of a consumer, and no session was created.
      assert.equal(row.status, 'DELIVERED');
      assert.equal(row.consumerType, null);
      assert.notEqual(row.consumerType, CRITERION_UNLANDED_CONSUMER);
      assert.equal(row.sessionId, f.coordinatorSessionId);
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      assert.equal((await coordinatorMessages(stack.db, f)).length, 1);

      // Both criteria are READY — the work is finished on both — which is what makes the row above
      // a statement about landing rather than about completion.
      assert.equal((await wakesOf(stack.db, f.projectId, 'CRITERION_READY')).length, 2);

      // ── the literal second delivery: the receipt arrives, and the fact stops ─────────────────
      // The serving set of the criterion that DID wake is moved by filing more work against it, so
      // its fact version moves too and the already-claimed key cannot be what suppresses the row.
      // Both members now carry a receipt.
      await recordLanding(stack, f, onBranch, 'caught-up');
      const alsoServing = await serve(stack, f, stranded!.key, '同一条标准的第二件活，也合进了 main');
      await recordLanding(stack, f, alsoServing, 'second-serving');
      await settleByAcceptance(stack, f, alsoServing, 'after-the-receipt');

      assert.equal(
        (await unlandedWakes(stack.db, f.projectId)).length, 1,
        'a criterion every serving task of which now has a receipt woke the coordinator again',
      );
      assert.equal(
        (await coordinatorMessages(stack.db, f)).length, 1,
        'the standing conversation was told a second time about a merge that had happened',
      );
      // And the delivery that produced nothing DID run over a moved serving set: readiness is
      // derived from the same rows at the same moment by the same predicate minus the landing
      // clause, and it wrote its third row. The receipt is the only difference between them.
      assert.equal(
        (await wakesOf(stack.db, f.projectId, 'CRITERION_READY')).length, 3,
        'the serving set did not move, so the previous assertion proved only idempotency',
      );

      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.choreTaskId } })).status,
        TaskStatus.OPEN,
      );
      assert.deepEqual(
        await wakesOf(stack.db, f.projectId, 'PROJECT_TASKS_SETTLED'), [],
        'the project has not settled, and a criterion was answered about anyway',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an unlanded criterion is refused by convergence, not waved through by a default',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect({ convergence: refusingConvergence() });
    try {
      const f = await fixture(stack, 'convergence-refuses');
      const [criterion] = await state(stack, f, ['收敛账本说这个项目不再收敛']);
      const only = await serve(stack, f, criterion!.key, '服务这条标准的唯一一件活');
      await settleByAcceptance(stack, f, only, 'refused-by-convergence');

      // The delivery reached the producer's authorizer and the authorizer reached convergence. A
      // door that let `route()`'s always-allow default stand in would never consult it, and this
      // row would say CONSUMED. Merging is the one coordinator action that cannot be undone, so
      // this is the fact whose retries most need a budget rather than a default.
      const wakes = await unlandedWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the unlanded criterion never reached the wake ledger');
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, PROJECT_NOT_CONVERGING);
      assert.equal(wakes[0]!.consumerType, null);
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      assert.deepEqual(await coordinatorMessages(stack.db, f), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an unlanded criterion under a switched-off coordinator produces nothing and wakes nobody',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'switched-off', { coordinatorEnabled: false });
      const [criterion] = await state(stack, f, ['这个项目的自动化开关是关的']);
      const only = await serve(stack, f, criterion!.key, '服务这条标准的唯一一件活');
      await settleByAcceptance(stack, f, only, 'switched-off');

      // Not "zero rows": the ledger claims before it authorizes, so a fact that travelled the
      // whole way and was refused leaves EXACTLY ONE row saying so. Asserting an empty table here
      // would be green over a producer nobody calls — which is the state this wiring replaced —
      // and green over a caller that decided for itself whether the switch was on.
      const wakes = await unlandedWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the unlanded criterion never reached the wake ledger');
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED);
      assert.equal(wakes[0]!.sessionId, null);
      assert.equal(wakes[0]!.consumerType, null);
      assert.notEqual(wakes[0]!.status, 'SESSION_OPENED');
      assert.notEqual(wakes[0]!.status, 'DELIVERED');
      assert.deepEqual(
        await judgmentSessions(stack.db, f.ownerId), [],
        'a switched-off coordinator was woken',
      );
      assert.deepEqual(
        await coordinatorMessages(stack.db, f), [],
        'a switched-off project\'s standing conversation was written to anyway',
      );

      // The switch is not read by the door that delivers: the work settled exactly as it would
      // have with the switch on, and only the wake was refused.
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: only } })).status,
        TaskStatus.DONE,
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the landing delivery happens after the write it is about has committed',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    const outside = prismaClientFor(URL!);
    try {
      const f = await fixture(stack, 'landing-after-commit');
      const [criterion] = await state(stack, f, ['提交之后才投递']);
      const served = await serve(stack, f, criterion!.key, '这条标准的活');

      const observed: Array<{ projectIds: string[]; titles: string[] }> = [];
      // A stub in the router's place: it does not deliver anything, it reports what a SECOND
      // connection could see at the moment the write path called it. Nothing is asserted inside it
      // — a throw here would be swallowed by the caller's own logging and the case would pass.
      const probe = {
        routeSettledProjects: async () => [],
        routeTaskExceptions: async () => [],
        routeReadyCriteria: async () => [],
        routeUnlandedCriteria: async (projectIds: ReadonlyArray<string | null | undefined>) => {
          const named = projectIds.filter((id): id is string => !!id);
          const rows = await outside.task.findMany({
            where: { id: served },
            select: { title: true },
          });
          observed.push({ projectIds: named, titles: rows.map((row) => row.title) });
          return [];
        },
      } as unknown as CompletionInputRouter;

      // `dependsOnTaskIds` puts this write on `update`'s interactive-transaction branch, which is
      // the branch where "inside or outside the transaction" is a real difference rather than an
      // autocommit statement that has already ended.
      await stack.tasksWith(probe).update(
        f.ownerId,
        served,
        { title: '提交之后才看得见的标题', dependsOnTaskIds: [] } as never,
      );

      assert.ok(observed.length > 0, 'the committed write delivered nothing to the landing door');
      assert.ok(
        observed.some((call) => call.projectIds.includes(f.projectId)),
        'the delivery did not name the project the write touched',
      );
      for (const call of observed) {
        assert.deepEqual(
          call.titles, ['提交之后才看得见的标题'],
          'the delivery ran before its own write was visible outside the transaction',
        );
      }
    } finally {
      await outside.$disconnect();
      await stack.db.$disconnect();
    }
  });

test('the criterion-landing PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
