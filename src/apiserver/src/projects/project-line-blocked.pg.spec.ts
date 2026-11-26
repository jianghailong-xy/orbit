/**
 * A BLOCKED PROJECT LINE reaches the coordinator, and then the account owner
 * (project 34xLkkpjrrFbUzGhsgy7f, criterion 7Jlfoe3v4RVDHgXHsT2aqy).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-line-blocked.pg.spec.ts
 *
 * The first case is the state of "Session translation" on 2026-11-12/13: an open MAIN_SYNC conflict item
 * of the reopened task A3, the queued landings of W2 and D2 held behind it (M2), and A3's run parked with
 * no evidence and no progress. The clock is moved past the 60-minute threshold and the coordinator is
 * told once; the coordinator then takes the item up, and the project's `exceptionEscalationSeconds`
 * after that notice the account owner is told, once. The second case pairs each "told nothing" with the
 * state that is: a stall still inside the threshold, an item that holds nobody else's landing, and a
 * run that reported progress.
 *
 * Over the real producer, delivery, wake ledger and conversation table; only the push sender is a double.
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  type Prisma,
  type PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { SessionsService } from '../sessions/sessions.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { LINE_BLOCKED_THRESHOLD_MS, blockedLineFactFor, lineBlockedOwnerKey } from './project-line-blocked';
import { ProjectLineBlockedService } from './project-line-blocked.service';
import { TaskRunStoppedProducer } from './task-run-stopped.producer';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const MIN = 60_000;

const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

interface Pushed { ownerId: string; projectId: string; noticeId: string; title: string; body: string }

async function connect() {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!) as PrismaClient;
  const prisma = db as unknown as PrismaService;
  const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as never, silent() as never);
  const convergence = new CoordinatorConvergenceService(prisma);
  const delivery = new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions);
  const pushed: Pushed[] = [];
  const push = { notifyProjectOrphan: async (input: Pushed) => { pushed.push(input); } } as unknown as PushService;
  const service = new ProjectLineBlockedService(prisma, new TaskRunStoppedProducer(prisma, convergence, delivery), delivery, push);
  return { db, prisma, service, pushed };
}

type Stack = Awaited<ReturnType<typeof connect>>;

async function withStack(body: (stack: Stack) => Promise<void>): Promise<void> {
  const stack = await connect();
  try {
    await body(stack);
  } finally {
    await stack.db.$disconnect();
  }
}

/** One account, one machine, an Automatic project with a parked coordinator and one repository line. */
async function world(stack: Stack, label: string) {
  const { db } = stack;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@line-blocked.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: sha256(`token-${runnerId}`),
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true } });

  async function conversation(title: string, data: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
        title, prompt: title, provider: 'claude', turnState: null,
        numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${id}`,
        dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
        ...data,
      },
    });
    return id;
  }

  const coordinator = await conversation(`coordinator: ${label}`, { titleManagedByProject: true });
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, startedAt: new Date(),
      coordinatorEnabled: true, coordinatorSessionId: coordinator, coordinatorWorkspaceId: workspaceId,
    },
  });
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: `https://github.com/example/line-blocked-${projectId}`,
      upstreamRef: 'refs/heads/main', integrationRef: `refs/heads/project/${projectId}`, refAuthority: 'REMOTE',
    },
    select: { id: true },
  });
  const serialKey = `line-blocked:${projectId}`;

  async function task(title: string, data: Partial<Prisma.TaskUncheckedCreateInput> = {}): Promise<string> {
    const row = await db.task.create({
      data: {
        ownerId, projectId, title, creatorType: 'USER', creatorId: ownerId, assigneeId: workspaceId,
        completionCriterion: 'EVIDENCE_JUDGMENT', ...data,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** The task's run, parked since `lastTurnAt` with nothing that would wake it. */
  function run(taskId: string, lastTurnAt: Date): Promise<string> {
    return conversation(`Task run ${taskId}`, { taskId, startsTaskWork: true, lastTurnAt });
  }

  async function job(taskId: string, data: Partial<Prisma.ProjectIntegrationJobUncheckedCreateInput>): Promise<string> {
    const row = await db.projectIntegrationJob.create({
      data: {
        projectId, ownerId, codebaseId: codebase.id, kind: 'LAND_TASK', taskId,
        serialKey, targetRef: `refs/heads/project/${projectId}`, upstreamRef: 'refs/heads/main',
        sourceRef: `refs/heads/orbit/${taskId}`, idempotencyKey: `line-blocked:${randomUUID()}`,
        ...data,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** The OPEN item a failed absorb of main into the line opened, as the coordinator's. */
  async function syncConflict(taskId: string, since: Date): Promise<string> {
    const failed = await job(taskId, { state: 'CONFLICT', phase: 'MAIN_SYNC', createdAt: since });
    const item = await db.projectOpenItem.create({
      data: {
        projectId, ownerId, kind: 'INTEGRATION_CONFLICT', state: 'OPEN',
        assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', taskId, integrationJobId: failed,
        dedupeKey: `line-blocked:${randomUUID()}`, title: 'Main conflicts with the project line',
        payload: {}, waitingSince: since, assignedAt: since,
      },
      select: { id: true },
    });
    return item.id;
  }

  /** What the coordinator was told, oldest first. */
  function told() {
    return db.conversationTurn.findMany({
      where: { sessionId: coordinator, kind: 'message' },
      select: { content: true },
      orderBy: { seq: 'asc' },
    });
  }

  function wakes() {
    return db.projectCoordinatorWake.findMany({
      where: { projectId, event: 'TASK_RUN_STOPPED' },
      select: { subjectId: true, subjectVersion: true, status: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * One tick of the sweep at `now`, and what it told about THIS project: coordinator notices written
   * and owner pushes sent. Other cases' projects share the database, so the sweep's own totals are not.
   */
  let seen = { coordinator: 0, owner: 0 };
  async function tick(now: Date): Promise<{ coordinator: number; owner: number }> {
    await stack.service.tick(now);
    const total = {
      coordinator: (await wakes()).length,
      owner: stack.pushed.filter((push) => push.projectId === projectId).length,
    };
    const step = { coordinator: total.coordinator - seen.coordinator, owner: total.owner - seen.owner };
    seen = total;
    return step;
  }

  return { ownerId, projectId, coordinator, task, run, job, syncConflict, told, wakes, tick };
}

test('an open MAIN_SYNC item holding two landings, its run idle past 60 minutes: the coordinator is told once, then the owner exceptionEscalationSeconds later, though the coordinator took the item up',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'session-translation');
    const project = await stack.db.project.findUniqueOrThrow({
      where: { id: w.projectId }, select: { exceptionEscalationSeconds: true },
    });
    assert.equal(project.exceptionEscalationSeconds, 7200, 'the default escalation window is 7200 s');
    assert.equal(LINE_BLOCKED_THRESHOLD_MS, 60 * MIN, 'the blocked-line threshold is the agreed 60 minutes');

    // The state at T0: A3 reopened for its merge-only round, its run parked, the item open, and the
    // landings of W2 and D2 queued behind it.
    const t0 = new Date();
    const a3 = await w.task('A3', { status: TaskStatus.OPEN });
    const a3Run = await w.run(a3, t0);
    const item = await w.syncConflict(a3, t0);
    const w2 = await w.task('W2', { status: TaskStatus.DONE });
    const d2 = await w.task('D2', { status: TaskStatus.DONE });
    await w.job(w2, { createdAt: t0 });
    await w.job(d2, { createdAt: t0 });
    // A3's own next landing is exempt from M2 (M3): it is not one of the landings held.
    const rerun = await w.job(a3, { generation: 2, createdAt: t0 });

    const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);
    assert.deepEqual(await w.tick(at(30)), { coordinator: 0, owner: 0 }, 'told at 30 minutes');
    assert.deepEqual(await w.tick(at(60)), { coordinator: 0, owner: 0 }, 'told at exactly the threshold');
    assert.deepEqual(await w.told(), []);

    // Time advanced past the threshold: the coordinator is told, once.
    assert.deepEqual(await w.tick(at(61)), { coordinator: 1, owner: 0 });
    assert.deepEqual(await w.tick(at(62)), { coordinator: 0, owner: 0 }, 'told twice about one idle period');
    const [wake, ...more] = await w.wakes();
    assert.equal(more.length, 0);
    assert.equal(wake!.status, 'DELIVERED');
    assert.equal(wake!.subjectId, a3);
    assert.equal(wake!.subjectVersion, `${a3Run}:line:${item}:${t0.getTime()}`);
    const messages = await w.told();
    assert.equal(messages.length, 1, 'the coordinator was not told exactly once');
    const content = messages[0]!.content!;
    assert.match(content, /Main conflicts with the project line/);
    assert.match(content, /held the queued landings of 2 other tasks/);
    assert.match(content, /“W2”/);
    assert.match(content, /“D2”/);
    assert.ok(content.includes(uuidToBase62(item)), 'the notice does not name the item');
    assert.ok(content.includes(uuidToBase62(a3)), 'the notice does not name the task that must act');
    assert.ok(content.includes(uuidToBase62(a3Run)), 'the notice does not name the session to nudge');
    assert.match(content, /2 hours after this notice, the account owner is told/);
    // The fact queue re-derives the same notice while it is owed.
    assert.equal((await blockedLineFactFor(stack.prisma, wake!.subjectVersion, at(62)))?.subjectVersion, wake!.subjectVersion);
    assert.deepEqual(stack.pushed.filter((p) => p.projectId === w.projectId), [], 'the owner was told before the window');

    // The coordinator takes the item up, as integration_retry records it: A3's queued landing is its
    // rerun, and the item stays OPEN and the coordinator's while that runs.
    await stack.db.projectOpenItem.update({
      where: { id: item },
      data: {
        handlingJobId: rerun, handlingSessionId: w.coordinator,
        handlingReason: 'merging main into A3', handlingStartedAt: at(63),
      },
    });

    const notice = wake!.createdAt.getTime();
    const window = project.exceptionEscalationSeconds * 1_000;
    assert.deepEqual(await w.tick(new Date(notice + window - 1_000)), { coordinator: 0, owner: 0 },
      'the owner was told before exceptionEscalationSeconds passed');

    // exceptionEscalationSeconds after the notice, the line is still held: the owner is told, once.
    assert.deepEqual(await w.tick(new Date(notice + window)), { coordinator: 0, owner: 1 });
    assert.deepEqual(await w.tick(new Date(notice + window + 5 * MIN)), { coordinator: 0, owner: 0 },
      'the owner was told twice');
    const mine = stack.pushed.filter((p) => p.projectId === w.projectId);
    assert.equal(mine.length, 1);
    const [push] = mine;
    assert.equal(push!.ownerId, w.ownerId);
    assert.equal(push!.projectId, w.projectId);
    assert.equal(push!.title, 'session-translation project: a landing line is still blocked');
    assert.match(push!.body, /“Main conflicts with the project line” has held the landings of 2 other tasks/);
    assert.match(push!.body, /The coordinator was told 2 hours ago\./);
    const ledger = await stack.db.projectOrphanNotice.findMany({
      where: { projectId: w.projectId }, select: { orphanKey: true, recipient: true, kind: true, taskId: true },
    });
    assert.deepEqual(ledger, [{ orphanKey: lineBlockedOwnerKey(item), recipient: 'OWNER', kind: 'EXCEPTION_ITEM', taskId: a3 }]);
    assert.equal((await w.told()).length, 1, 'the coordinator was told again');
  }));

test('nobody is told inside the threshold, about an item that holds no other landing, or while the run reports progress; the same state past them is told',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'controls');
    const t0 = new Date();
    const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);

    // An item that holds only its own task's next landing: nothing else on the line waits.
    const alone = await w.task('alone', { status: TaskStatus.OPEN });
    await w.run(alone, t0);
    const aloneItem = await w.syncConflict(alone, t0);
    await w.job(alone, { generation: 2, createdAt: t0 });
    assert.deepEqual(await w.tick(at(120)), { coordinator: 0, owner: 0 }, 'an item holding no other landing was told');

    // Another task's landing queues behind it 30 minutes in: the line has been held since then.
    const other = await w.task('other', { status: TaskStatus.DONE });
    await w.job(other, { createdAt: at(30) });
    assert.deepEqual(await w.tick(at(90)), { coordinator: 0, owner: 0 }, 'a line held for 60 minutes was told');

    // The run reported progress 40 minutes in: it has not been idle past the threshold.
    await stack.db.taskProgress.create({
      data: { taskId: alone, phase: 'merge', message: 'merging main', lastProgressAt: at(40), updatedAt: at(40) },
    });
    assert.deepEqual(await w.tick(at(95)), { coordinator: 0, owner: 0 }, 'a run that reported progress was told');

    // Past all three: told, once.
    assert.deepEqual(await w.tick(at(101)), { coordinator: 1, owner: 0 });
    const [wake] = await w.wakes();
    assert.ok(wake!.subjectVersion.includes(`:line:${aloneItem}:${at(40).getTime()}`), 'the idle period is not keyed from the progress');
    assert.deepEqual(await w.tick(at(102)), { coordinator: 0, owner: 0 });

    // The item closes before the window: the owner is never told.
    await stack.db.projectOpenItem.update({ where: { id: aloneItem }, data: { state: 'RESOLVED', resolution: 'HANDLED', resolvedAt: at(110), resolvedBy: 'COORDINATOR' } });
    assert.deepEqual(await w.tick(new Date(wake!.createdAt.getTime() + 7_300_000)), { coordinator: 0, owner: 0 },
      'the owner was told about a line that is no longer held');
  }));
