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
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * (g) An EXECUTABLE task still goes admission → attempt → verdict with the protocol gone.
 *
 * This is the load-bearing wall the removal was told not to touch, and it is not enough to check
 * that `task_executable_*` still exists: 0201 put a guard on `session` and two on
 * `conversation_turn` that fired on exactly the writes this lane makes, 0202 put four on `task`,
 * and `run_event_completion_ack_ingestion_guard` stamped the terminal shell event the verdict is
 * derived from. The whole lane is driven here, through the real controller, on a real server.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const RUN = randomUUID().slice(0, 8);

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  messageTurnId: string;
}

function publishes(): RealtimeService {
  return new Proxy({}, {
    get: (_target, name) => (name === 'waitForInbox'
      ? async () => undefined
      : () => undefined),
  }) as unknown as RealtimeService;
}

function controller(db: PrismaClient): RunnerApiController {
  const prisma = db as unknown as PrismaService;
  return new RunnerApiController(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes(),
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
  );
}

function tasksService(db: PrismaClient): TasksService {
  const prisma = db as unknown as PrismaService;
  return new TasksService(
    prisma,
    new SessionsService(
      prisma,
      { notifySessionQueued: () => undefined } as unknown as QueueService,
      publishes(),
    ),
    publishes(),
  );
}

async function empty(sql: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`
    TRUNCATE "run_event", "conversation_turn", "task", "session", "workspace", "runner",
             "project_runtime", "project", "user" RESTART IDENTITY CASCADE
  `);
}

async function fixture(
  db: PrismaClient,
  label: string,
  acceptance: { command: string; expectedExitCode: number },
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${RUN}-${ownerId}@removal.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: `${label}-project` } });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  // A v2 declaration: the negotiated timeout is what makes the lease admit a typed plan rather
  // than fall through to the rolling-v1 lane.
  const declared = await tasksService(db).create(ownerId, {
    title: label,
    assigneeId: workspaceId,
    projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The declared shell command exits with the expected code.',
    acceptanceCommand: acceptance.command,
    acceptanceExpectedExitCode: acceptance.expectedExitCode,
    acceptanceTimeoutSeconds: 1_200,
    acceptanceOwnerTimeoutCeilingSeconds: 1_200,
  });
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
  assert.equal(declared.status, TaskStatus.OPEN);
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, taskId: declared.id, workspaceId,
      assignedRunnerId: runnerId, title: label, prompt: label, provider: 'claude',
      status: RunStatus.RUNNING, engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      id: messageTurnId, sessionId, seq: 1, clientTurnId: `message:${messageTurnId}`,
      kind: 'message', content: 'do the work', status: 'IN_FLIGHT',
    },
  });
  return {
    ownerId, runnerId, workspaceId, projectId, taskId: declared.id, sessionId, messageTurnId,
  };
}

interface Delivered {
  turnId: string;
  kind: string;
  content?: string;
  taskAcceptance?: boolean;
  acceptancePlan?: { admissionId: string; effectiveTimeoutSeconds: number };
}

/**
 * A typed v2 poller. `executableCapability` is what makes the lease negotiate and admit a plan
 * rather than fall back to the rolling-v1 lane, so it is what puts an admission and an attempt row
 * on the table.
 */
async function dequeueAcceptance(api: RunnerApiController, f: Fixture): Promise<Delivered> {
  const next = await (api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
      executableCapability: {
        schemaRevision: number;
        capabilityRevision: number;
        hardMaxSeconds: number;
        runnerSha: string;
      } | null,
    ) => Promise<Delivered | null>;
  }).dequeueTurn(f.sessionId, f.runnerId, null, false, [], {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 1_200, runnerSha: 'a'.repeat(40),
  });
  assert.ok(next, 'the acceptance turn must be delivered');
  return next;
}

suite('(g) admission and attempt still run end to end, and no longer settle the task', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const command = 'test -f package.json';
  const f = await fixture(db, 'exec-pass', { command, expectedExitCode: 0 });
  const api = controller(db);

  // ADMISSION. Finishing the agent's own turn is what admits the declared command. Both dropped
  // conversation_turn guards fired on this write, and the session guard on the status it moves to.
  const finished = await api.turnComplete({ id: f.runnerId } as never, f.sessionId, {
    turnId: f.messageTurnId, status: SharedRunStatus.SUCCEEDED,
  } as never);
  assert.deepEqual(finished, { ok: true, status: RunStatus.RUNNING });
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'a finished agent turn does not settle the task by itself',
  );

  // ADMISSION. The lease is where the declared plan is negotiated against the runner's own limit
  // and admitted; the negotiated deadline is bound into the admission, not chosen by the caller.
  const acceptance = await dequeueAcceptance(api, f);
  assert.equal(acceptance.kind, 'shell');
  assert.equal(acceptance.taskAcceptance, true);
  assert.equal(acceptance.content, command);
  assert.ok(acceptance.acceptancePlan, 'the typed poller must be admitted, not fall back to v1');
  const admission = await db.taskExecutableAdmission.findFirstOrThrow({
    where: { taskId: f.taskId },
  });
  assert.equal(admission.expectedExitCode, 0);
  assert.equal(admission.decision, 'ADMITTED');
  assert.equal(admission.sessionId, f.sessionId);
  assert.equal(acceptance.acceptancePlan.admissionId, admission.id);

  // ATTEMPT. The runner reports that it started the admitted plan; that receipt is the attempt.
  const started = await api.startExecutableAcceptanceAttempt(
    { id: f.runnerId } as never, f.sessionId, admission.id,
  ) as { attemptId: string };
  assert.ok(started.attemptId);
  const attempt = await db.taskExecutableAttempt.findFirstOrThrow({ where: { taskId: f.taskId } });
  assert.equal(attempt.id, started.attemptId);
  assert.equal(attempt.admissionId, admission.id);
  assert.ok(attempt.deadlineAt, 'the attempt owns the negotiated deadline');
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'an admitted, started attempt still does not settle the task',
  );

  // TERMINATION. A typed EXITED termination matching the declared code is still recorded on the
  // attempt. What it no longer does is settle the task: the evaluator that compared that exit
  // code against the declaration was removed on 2026-09-02 with the judgment machinery, and
  // EXECUTABLE is now declared-but-unimplemented. The declaration itself is untouched — the
  // command and expected exit code below are still exactly what the task was created with.
  const settled = await api.turnComplete({ id: f.runnerId } as never, f.sessionId, {
    turnId: acceptance.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell',
    shellOutput: 'package.json is here',
    acceptanceAdmissionId: admission.id,
    acceptanceAttemptId: started.attemptId,
    acceptanceTerminationKind: 'EXITED',
    acceptanceActualExitCode: 0,
  } as never);
  assert.equal((settled as { ok: boolean }).ok, true);
  const declaredAfter = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(
    declaredAfter.status,
    TaskStatus.OPEN,
    'a matching exit code no longer derives DONE: EXECUTABLE has no implementation',
  );
  assert.equal(declaredAfter.completionCriterion, 'EXECUTABLE',
    'the declaration is preserved, not rewritten to a criterion that still works');
  assert.equal(declaredAfter.acceptanceCommand, command);
  assert.equal(declaredAfter.acceptanceExpectedExitCode, 0);
  const closed = await db.taskExecutableAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  assert.equal(closed.terminationKind, 'EXITED');
  assert.equal(closed.actualExitCode, 0);
  assert.ok(closed.terminatedAt, 'the attempt is terminated by its own typed result');
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: f.taskId } }), 1);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: f.taskId } }), 1);
  assert.equal(
    await db.projectBlocker.count({ where: { projectId: f.projectId, resolvedAt: null } }),
    0,
    'an unsettled task raises no blocker either: nothing is filed in its place',
  );
});

suite('(g) a nonzero exit no longer derives FAILED either', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const command = 'test -f this-file-does-not-exist';
  const f = await fixture(db, 'exec-fail', { command, expectedExitCode: 0 });
  const api = controller(db);
  await api.turnComplete({ id: f.runnerId } as never, f.sessionId, {
    turnId: f.messageTurnId, status: SharedRunStatus.SUCCEEDED,
  } as never);
  const acceptance = await dequeueAcceptance(api, f);
  assert.ok(acceptance.acceptancePlan);
  const started = await api.startExecutableAcceptanceAttempt(
    { id: f.runnerId } as never, f.sessionId, acceptance.acceptancePlan.admissionId,
  ) as { attemptId: string };
  await api.turnComplete({ id: f.runnerId } as never, f.sessionId, {
    turnId: acceptance.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell',
    shellOutput: 'no such file',
    acceptanceAdmissionId: acceptance.acceptancePlan.admissionId,
    acceptanceAttemptId: started.attemptId,
    acceptanceTerminationKind: 'EXITED',
    acceptanceActualExitCode: 1,
  } as never);

  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'a mismatching exit code derives nothing: the task stays where it was, awaiting a rebuilt '
    + 'EXECUTABLE implementation rather than being conservatively failed by a removed evaluator',
  );
  const attempt = await db.taskExecutableAttempt.findUniqueOrThrow({
    where: { id: started.attemptId },
  });
  assert.equal(attempt.actualExitCode, 1);
  assert.equal(attempt.terminationKind, 'EXITED');
});
