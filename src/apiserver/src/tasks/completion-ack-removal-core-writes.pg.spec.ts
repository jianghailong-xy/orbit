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
import { TaskStatus as SharedTaskStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * The biggest risk in the 0220 removal, taken head-on.
 *
 * Nine of the triggers it drops sat on `task`, `session`, `conversation_turn` and `run_event` —
 * core tables whose every ordinary write fired them. Removing a guard cannot be assumed safe just
 * because the guard was inert: `run_event_completion_ack_ingestion_guard` was not a completion-ACK
 * guard at all, and dropping it outright would have silently handed `ingested_at` and the
 * ingestion provenance columns back to callers.
 *
 * So this file is positive rather than negative. It drives the ordinary write path of each of the
 * four tables through the real service and the real server, and asserts the result — including the
 * two run_event invariants that used to live under a completion-ACK name.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const RUN = randomUUID().slice(0, 8);

interface World {
  db: PrismaClient;
  tasks: TasksService;
  sessions: SessionsService;
}

function connect(): World {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return { db, tasks: new TasksService(prisma, sessions, publishes), sessions };
}

async function empty(sql: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`
    TRUNCATE "run_event", "conversation_turn", "task", "session", "workspace", "runner",
             "project_runtime", "project", "user" RESTART IDENTITY CASCADE
  `);
}

async function owner(db: PrismaClient, label: string) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
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
  return { ownerId, runnerId, workspaceId };
}

// (d) --------------------------------------------------------------------------------------------
suite('(d) ordinary task creation, update, subtasks, dependencies and supersede still work', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const { db, tasks } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, workspaceId } = await owner(db, 'task-writes');
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, ownerId, title: 'ordinary writes' } });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  // CREATE. All four `task` triggers 0220 dropped fired here: two on INSERT, two on UPDATE.
  const parent = await tasks.create(ownerId, { title: 'parent', projectId, assigneeId: workspaceId });
  assert.equal(parent.status, TaskStatus.OPEN);
  const prerequisite = await tasks.create(ownerId, { title: 'prerequisite', projectId });
  const child = await tasks.create(ownerId, {
    title: 'child', projectId, parentTaskId: parent.id, dependsOnTaskIds: [prerequisite.id],
  });
  assert.equal(child.parentTaskId, parent.id);

  // The subtask and the dependency edge are both real rows, not a response shape.
  const stored = await db.task.findUniqueOrThrow({
    where: { id: child.id },
    include: { dependsOn: true },
  });
  assert.equal(stored.parentTaskId, parent.id);
  assert.deepEqual(stored.dependsOn.map((edge) => edge.dependsOnTaskId), [prerequisite.id]);

  // UPDATE, including the completion criterion the dropped criterion guards used to police. A
  // EVIDENCE_JUDGMENT task opened by an ordinary caller was always allowed; it must still be.
  const renamed = await tasks.update(ownerId, child.id, {
    title: 'child renamed',
    description: 'still an ordinary task',
    completionCriterion: 'EVIDENCE_JUDGMENT',
  });
  assert.equal(renamed.title, 'child renamed');
  assert.equal(renamed.completionCriterion, 'EVIDENCE_JUDGMENT');

  // SUPERSEDE. `task_completion_ack_remediation_reactivation_guard` fired on every status UPDATE.
  await tasks.update(ownerId, prerequisite.id, { status: SharedTaskStatus.FAILED });
  const successor = await tasks.create(ownerId, { title: 'successor', projectId });
  const superseded = await tasks.update(ownerId, prerequisite.id, {
    supersededByTaskId: successor.id,
  });
  assert.equal(superseded.supersededByTaskId, successor.id);

  // Reopening a terminal task is the exact transition the reactivation guard used to intercept.
  const reopened = await tasks.update(ownerId, prerequisite.id, {
    supersededByTaskId: null, status: SharedTaskStatus.OPEN,
  });
  assert.equal(reopened.status, TaskStatus.OPEN);
  assert.equal(reopened.supersededByTaskId, null);

  assert.equal(await db.task.count({ where: { ownerId } }), 4);
});

// (e) --------------------------------------------------------------------------------------------
suite('(e) ordinary session creation and task dispatch still work', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const { db, tasks } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, runnerId, workspaceId } = await owner(db, 'session-writes');
  const task = await tasks.create(ownerId, { title: 'dispatch me', assigneeId: workspaceId });

  // A plain session INSERT with `startsTaskWork` — the exact shape
  // `session_completion_ack_dispatch_insert_guard` fired on.
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, taskId: task.id, workspaceId,
      assignedRunnerId: runnerId, title: 'work', prompt: 'work', provider: 'claude',
      status: RunStatus.PENDING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
  // ...and the status transitions the revive guard fired on.
  const running = await db.session.update({
    where: { id: sessionId }, data: { status: RunStatus.RUNNING },
  });
  assert.equal(running.status, RunStatus.RUNNING);
  await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
  await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING } });

  // The real dispatch door, which is what a person pressing Execute reaches.
  await db.session.update({ where: { id: sessionId }, data: { deletedAt: new Date() } });
  const answer = await tasks.execute(ownerId, task.id) as {
    ok: boolean; sessionId?: string; skipped?: string;
  };
  assert.equal(answer.ok, true, `execute refused: ${JSON.stringify(answer)}`);
  assert.ok(answer.sessionId);
  const dispatched = await db.session.findUniqueOrThrow({ where: { id: answer.sessionId! } });
  assert.equal(dispatched.taskId, task.id);
  assert.equal(dispatched.startsTaskWork, true);
});

// (f) --------------------------------------------------------------------------------------------
suite('(f) run_event writes still work, and the database still owns their ingestion', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const { db } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, runnerId, workspaceId } = await owner(db, 'run-event-writes');
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: 'events', prompt: 'events', provider: 'claude', status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });

  // An ordinary append. The renamed guard is what fills `ingested_at`.
  const eventId = randomUUID();
  await db.runEvent.create({
    data: { id: eventId, sessionId, seq: 1, type: 'assistant', payload: { text: 'hello' } },
  });
  const stored = await db.runEvent.findUniqueOrThrow({ where: { id: eventId } });
  assert.ok(stored.ingestedAt, 'the database still stamps ingested_at on INSERT');

  // A caller-supplied value is overwritten, exactly as before: the column is the database's.
  const forgedId = randomUUID();
  const longAgo = new Date('2020-01-01T00:00:00.000Z');
  await db.runEvent.create({
    data: {
      id: forgedId, sessionId, seq: 2, type: 'assistant', payload: { text: 'forged' },
      ingestedAt: longAgo,
    },
  });
  const forged = await db.runEvent.findUniqueOrThrow({ where: { id: forgedId } });
  assert.notDeepEqual(forged.ingestedAt, longAgo, 'the database owns ingested_at, not the caller');

  // And it stays the database's afterwards.
  await assert.rejects(
    db.runEvent.update({ where: { id: eventId }, data: { ingestedAt: longAgo } }),
    /RUN_EVENT_INGESTED_AT_DB_OWNED/,
  );
  await assert.rejects(
    db.runEvent.update({ where: { id: eventId }, data: { ingestedByRunnerId: runnerId } }),
    /RUN_EVENT_INGESTION_PROVENANCE_IMMUTABLE/,
  );

  // Ordinary non-provenance updates and bulk appends are untouched.
  const edited = await db.runEvent.update({
    where: { id: eventId }, data: { payload: { text: 'edited' } },
  });
  assert.deepEqual(edited.payload, { text: 'edited' });
  await db.runEvent.createMany({
    data: [3, 4, 5].map((seq) => ({ sessionId, seq, type: 'assistant', payload: { seq } })),
  });
  assert.equal(await db.runEvent.count({ where: { sessionId } }), 5);
  const stamped = await db.runEvent.findMany({ where: { sessionId }, select: { ingestedAt: true } });
  assert.equal(stamped.every((row) => row.ingestedAt !== null), true,
    'every appended event is stamped, including a createMany batch');
});

// (d)(e)(f) --------------------------------------------------------------------------------------
suite('(d)(e)(f) conversation turns still write, with no guard left on that table at all', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const { db, tasks } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, runnerId, workspaceId } = await owner(db, 'turn-writes');
  const task = await tasks.create(ownerId, { title: 'turns', assigneeId: workspaceId });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, taskId: task.id, workspaceId,
      assignedRunnerId: runnerId, title: 'turns', prompt: 'turns', provider: 'claude',
      status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });

  // Both dropped `conversation_turn` guards fired on this exact shape: a task-work session's
  // non-interrupt INSERT, and its IN_FLIGHT/delivered_at/lease_generation UPDATE.
  const turnId = randomUUID();
  await db.conversationTurn.create({
    data: {
      id: turnId, sessionId, seq: 1, clientTurnId: `message:${turnId}`, kind: 'message',
      content: 'do the work', status: 'PENDING',
    },
  });
  const leased = await db.conversationTurn.update({
    where: { id: turnId },
    data: { status: 'IN_FLIGHT', deliveredAt: new Date(), leaseGeneration: randomUUID() },
  });
  assert.equal(leased.status, 'IN_FLIGHT');
  const answered = await db.conversationTurn.update({
    where: { id: turnId }, data: { status: 'ANSWERED', answeredAt: new Date() },
  });
  assert.equal(answered.status, 'ANSWERED');
});
