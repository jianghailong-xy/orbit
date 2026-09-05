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
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionSubjectId } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import {
  CRITERION_READY_CONSUMER,
  CRITERION_READY_WAKE_COORDINATOR_DISABLED,
  CriterionReadyProducer,
} from '../projects/criterion-ready.producer';
import { criteriaFromDefinitions } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { readCriterionSatisfaction } from '../projects/project-criterion-satisfaction';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { ProjectsService } from '../projects/projects.service';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * `CRITERION_READY`: the fact cut per ACCEPTANCE CRITERION, and never per task.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-criterion-ready-delivery.pg.spec.js
 *
 * WHY EVERY PROJECT BELOW KEEPS ONE TASK OPEN
 * ===========================================
 * Deliberate, and it is the whole claim. A criterion becoming ready is not "this project settled"
 * — `PROJECT_TASKS_SETTLED` is that fact and its two siblings already cover it — so every fixture
 * here files one chore task that serves no criterion and never finishes. The project therefore
 * cannot settle, and anything that lands in the ledger landed because a CRITERION's own serving
 * work finished. Cutting the event per task would get both ends of this wrong: a project whose
 * tasks have all settled while some criterion has nobody serving it is a long way from done, and a
 * project whose criteria are all met while one forgotten task sits open is done and never asked.
 *
 * WHAT SETTLES THE WORK
 * =====================
 * Nothing here writes a task status. Every serving task carries a declared acceptance command, and
 * reaches DONE the way most tasks in production do: `turnComplete` queues the command, `dequeueTurn`
 * reserves it, bash runs it, and `turnComplete` compares the code it returned against the declared
 * one under the task's own row lock. What the cases assert is what that DERIVED status delivered.
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
}

/**
 * The production wiring, over one client.
 *
 * `convergence` is the only seam: passing a refusing double is how a case asks "was this fact
 * authorized THERE", because a delivery that ate the router's always-allow default would never
 * consult it and would land CONSUMED instead of REFUSED.
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
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, convergence),
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
  return { db, api, tasks, projects };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The task that serves no criterion and never finishes, so the project cannot settle. */
  choreTaskId: string;
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
      email: `${label}-${ownerId}@criterion-ready.invalid`,
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
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 唤醒项目`,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const chore = await stack.tasks.create(ownerId, {
    title: `${label} 与任何标准无关的杂活`,
    assigneeId: workspaceId,
    projectId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
  } as never);
  return { ownerId, runnerId, workspaceId, projectId, choreTaskId: chore.id };
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
  } as never);
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
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

function readyWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'CRITERION_READY' },
    select: {
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

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

test('the criterion wakes on its LAST serving task, and not on the one before it',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'last-serving-task');
      const [criterion] = await state(stack, f, ['两条活一起服务这条标准']);
      const first = await serve(stack, f, criterion!.key, '服务这条标准的第一件活');
      const second = await serve(stack, f, criterion!.key, '服务这条标准的第二件活');

      // ── the criterion still has work outstanding ─────────────────────────────────────────────
      await settleByAcceptance(stack, f, first, 'first-of-two');
      assert.deepEqual(
        await readyWakes(stack.db, f.projectId), [],
        'a criterion one of whose two serving tasks is still OPEN is not ready',
      );

      // ── and now it does not ──────────────────────────────────────────────────────────────────
      await settleByAcceptance(stack, f, second, 'second-of-two');
      const wakes = await readyWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the last serving task reaching DONE delivered exactly one row');

      // The identity is the CRITERION's. A row keyed on the task that happened to finish last
      // would carry a different subject for the same event depending on which of the two ran
      // second, and would say nothing about the condition the coordinator reasons in.
      const row = wakes[0]!;
      assert.equal(row.subjectType, 'CRITERION');
      assert.equal(row.subjectId, criterionSubjectId(f.projectId, criterion!.key));
      assert.equal(
        (row.detail as Record<string, unknown>).criterionKey, criterion!.key,
        'the fact must name the criterion whose coverage changed',
      );
      assert.equal((row.detail as Record<string, unknown>).taskCount, 2);
      for (const taskId of [first, second, f.choreTaskId]) {
        assert.notEqual(row.subjectId, taskId, 'the subject is a criterion, not a task');
      }
      assert.equal(row.status, 'CONSUMED');
      assert.equal(row.consumerType, CRITERION_READY_CONSUMER);

      // And the project itself is nowhere near settled, which is the point of cutting it this way.
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.choreTaskId } })).status,
        TaskStatus.OPEN,
      );
      assert.deepEqual(
        await stack.db.projectCoordinatorWake.findMany({
          where: { projectId: f.projectId, event: 'PROJECT_TASKS_SETTLED' },
        }),
        [],
        'the project has not settled, and the criterion became ready anyway',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a criterion nobody serves is not ready, and the derivation says why',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'nobody-serves-it');
      const [served, unserved] = await state(stack, f, [
        '这条标准有活服务它', '这条标准没有任何活服务它',
      ]);
      const only = await serve(stack, f, served!.key, '服务第一条标准的唯一一件活');
      await settleByAcceptance(stack, f, only, 'the-only-one');

      // The sibling criterion is what makes this case non-vacuous: the producer ran over BOTH, and
      // came back with one fact. Zero rows on their own would also be what a deleted producer
      // returns.
      const wakes = await readyWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'exactly one of the two criteria may be ready');
      assert.equal(wakes[0]!.subjectId, criterionSubjectId(f.projectId, served!.key));
      assert.notEqual(
        wakes[0]!.subjectId, criterionSubjectId(f.projectId, unserved!.key),
        'a criterion with an empty serving set has not been met — it has not been attempted',
      );

      // Cross-checked against the product's own answer about that criterion, so the emptiness this
      // producer declines to wake on is the same emptiness the satisfaction derivation reports as
      // `NO_WORK_SERVES_IT` rather than a second opinion about what "unserved" means.
      const derived = await readCriterionSatisfaction(
        stack.db as unknown as PrismaService, f.ownerId, f.projectId,
      );
      const forUnserved = derived.find((row) => row.definitionId === unserved!.definitionId);
      assert.ok(forUnserved);
      assert.equal(forUnserved.satisfied, false);
      assert.deepEqual(forUnserved.unmet.map((reason) => reason.clause), ['NO_WORK_SERVES_IT']);
      const forServed = derived.find((row) => row.definitionId === served!.definitionId);
      assert.equal(forServed?.satisfied, true, 'and the one that DID wake is the one that is met');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a ready criterion is refused by convergence, not waved through by a default',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect({ convergence: refusingConvergence() });
    try {
      const f = await fixture(stack, 'convergence-refuses');
      const [criterion] = await state(stack, f, ['收敛账本说这个项目不再收敛']);
      const only = await serve(stack, f, criterion!.key, '服务这条标准的唯一一件活');
      await settleByAcceptance(stack, f, only, 'refused-by-convergence');

      // The delivery reached the producer's authorizer and the authorizer reached convergence. A
      // door that let `route()`'s always-allow default stand in would never consult it, and this
      // row would say CONSUMED.
      const wakes = await readyWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the ready criterion never reached the wake ledger');
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, PROJECT_NOT_CONVERGING);
      assert.equal(wakes[0]!.consumerType, null);
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a ready criterion under a switched-off coordinator produces nothing and wakes nobody',
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
      const wakes = await readyWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the ready criterion never reached the wake ledger');
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, CRITERION_READY_WAKE_COORDINATOR_DISABLED);
      assert.equal(wakes[0]!.sessionId, null);
      assert.equal(wakes[0]!.consumerType, null);
      assert.notEqual(wakes[0]!.status, 'SESSION_OPENED');
      assert.deepEqual(
        await judgmentSessions(stack.db, f.ownerId), [],
        'a switched-off coordinator was woken',
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

test('the criterion-ready PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
