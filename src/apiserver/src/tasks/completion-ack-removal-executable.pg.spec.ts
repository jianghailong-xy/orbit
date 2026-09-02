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
  const declared = await tasksService(db).create(ownerId, {
    title: label,
    assigneeId: workspaceId,
    projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The declared shell command exits with the expected code.',
    acceptanceCommand: acceptance.command,
    acceptanceExpectedExitCode: acceptance.expectedExitCode,
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
}

/** Lease the reserved acceptance shell turn the finished agent turn minted. */
async function dequeueAcceptance(api: RunnerApiController, f: Fixture): Promise<Delivered> {
  const next = await (api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ) => Promise<Delivered | null>;
  }).dequeueTurn(f.sessionId, f.runnerId, null, false, []);
  assert.ok(next, 'the acceptance turn must be delivered');
  return next;
}

suite('(g) dispatch and verdict still run end to end for a passing command', async (t) => {
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

  // DISPATCH. Finishing the agent turn minted exactly one reserved shell turn carrying the
  // declared command. 0227 removed the admission negotiation that used to sit in front of this;
  // the lease now hands the command straight to the runner.
  const acceptance = await dequeueAcceptance(api, f);
  assert.equal(acceptance.kind, 'shell');
  assert.equal(acceptance.taskAcceptance, true);
  assert.equal(acceptance.content, command);

  // VERDICT. The reported exit code equals the declared expectation, so the criterion derives
  // The callback still commits, and it still settles nothing: the evaluator that compared its
  // exit code to the declaration was removed on 2026-09-02 with the judgment machinery, so what
  // the walls above have to keep letting through is the ACK, not a derived status.
  const settled = await api.turnComplete({ id: f.runnerId } as never, f.sessionId, {
    turnId: acceptance.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell',
    shellExitCode: 0,
    shellOutput: 'package.json is here',
  } as never);
  assert.equal((settled as { ok: boolean }).ok, true);
  const declaredAfter = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(declaredAfter.status, TaskStatus.OPEN,
    'a matching exit code derives nothing: EXECUTABLE has no implementation');
  assert.equal(declaredAfter.completionCriterion, 'EXECUTABLE');
  assert.equal(declaredAfter.acceptanceExpectedExitCode, 0,
    'and the declaration it was run from is untouched');
  assert.equal(
    await db.projectBlocker.count({ where: { projectId: f.projectId, resolvedAt: null } }),
    0,
    'a mechanically settled task leaves no blocker behind',
  );
});

suite('(g) a nonzero exit still derives FAILED through the same lane', async (t) => {
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
  await api.turnComplete({ id: f.runnerId } as never, f.sessionId, {
    turnId: acceptance.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell',
    shellExitCode: 1,
    shellOutput: 'no such file',
  } as never);

  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'a mismatching exit code is not a conservative FAILED either: the comparison itself is gone',
  );
  // And the exit code and shell output are no longer stored anywhere. That is consequence 3 of
  // the 2026-09-02 decision, accepted explicitly by the account owner: diagnosis moves to the
  // session record. What the run gets instead is one human-facing comment saying so.
  const comments = await db.taskComment.findMany({ where: { taskId: f.taskId } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /需要人工介入：EXECUTABLE 验收未能判定/);
});
