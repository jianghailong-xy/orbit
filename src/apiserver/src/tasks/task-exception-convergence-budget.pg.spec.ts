import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { Client } from 'pg';

import { TaskStatus as DeclaredTaskStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import {
  DEFAULT_CONVERGENCE_THRESHOLDS,
  ZERO_COUNTERS,
} from '../projects/convergence-contract';
import { COORDINATOR_NO_PROGRESS_KIND } from '../projects/coordinator-convergence';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import {
  EXCEPTION_WAKE_COORDINATOR_DISABLED,
  TaskExceptionInputProducer,
} from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * The convergence ledger, written by the delivery the task write path actually makes — and no
 * longer a budget.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-exception-convergence-budget.pg.spec.js
 *
 * WHAT THIS FILE HOLDS NOW
 * ========================
 * It was written to prove that a task which keeps ending badly eventually stops waking anybody,
 * driven through the door those failures really take: N task writes, and the N+1th refused. That
 * was the breaker `coordinator-convergence.ts` §1 retired. It refused the FACTS, so once the count
 * ran out nobody was told that the project's tasks were failing. What bounds 「失败 → 立接替 → 再失败
 * → 再立」 now is the coordinator's fuse on the replacements themselves
 * (`projects/coordinator-spend-fuse.pg.spec.ts`).
 *
 * So the same drive holds the opposite: past the old limit every failed attempt is still one
 * recorded judgment, consumed, charging nothing and raising nothing — and the judgment still
 * measures progress, which the control case shows by closing a real defect partway through.
 *
 * Every case drives `TasksService.update` and reads what committed. Not destructive: every case
 * owns freshly generated ids and reads only its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** N: the limit the retired breaker counted to, read from the frozen table. */
const N = DEFAULT_CONVERGENCE_THRESHOLDS.maxDecisionsWithoutProgress as number;

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
  tasks: TasksService;
}

/**
 * The production wiring, over one client, with no seam at all: the question is what the REAL
 * ledger does with N facts, so there is nothing here to substitute.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = new CoordinatorConvergenceService(prisma);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      convergence,
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  return { db, tasks: new TasksService(prisma, sessions, realtime, undefined, router) };
}

interface Workspace {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function workspace(db: PrismaClient, label: string): Promise<Workspace> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@convergence-budget.invalid`,
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
  return { ownerId, runnerId, workspaceId };
}

/**
 * A project the coordinator is allowed to be woken about, with one stated criterion.
 *
 * The criterion is not decoration: an evidence snapshot with no items at all reads `UNMEASURED`
 * rather than `FRESH`, and a run whose every reading was unbelievable could not record progress
 * for a reason that is not the one under test.
 */
async function project(
  db: PrismaClient,
  space: Workspace,
  label: string,
  coordinatorEnabled = true,
): Promise<string> {
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId: space.ownerId,
      title: `${label} 收敛预算`,
      goal: '让「失败→立接替→再失败」有个尽头',
      acceptanceCriterionDefinitions: {
        create: [{
          ordinal: 1,
          text: '连续无进展的唤醒照样被记下、照样送达',
          verificationMethod: '整轮 full-api',
          // The normalize trigger recomputes it; Prisma needs a value for the required column.
          contentHash: '0'.repeat(64),
        }],
      },
      coordinatorEnabled,
      coordinatorWorkspaceId: space.workspaceId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return projectId;
}

/**
 * One more attempt that ends badly, through the door production uses.
 *
 * A NEW task and a NEW attempt every round, so each ending is a different fact with its own
 * idempotency key rather than one fact redelivered. Nothing here writes a wake, a decision or a
 * blocker — the only call is `TasksService.update`, and everything asserted below is what that
 * write left behind after it committed.
 */
async function anotherFailedAttempt(
  stack: Stack,
  space: Workspace,
  projectId: string,
  round: number,
): Promise<string> {
  const declared = await stack.tasks.create(space.ownerId, {
    title: `attempt ${round}`,
    assigneeId: space.workspaceId,
    projectId,
  });
  // The attempt ends first, as it does in production: FAILED is a run's conservative self-report
  // about work that has already stopped.
  await stack.db.session.create({
    data: {
      ownerId: space.ownerId,
      creatorId: space.ownerId,
      taskId: declared.id,
      workspaceId: space.workspaceId,
      assignedRunnerId: space.runnerId,
      title: `attempt ${round}`,
      prompt: 'do the work',
      provider: 'claude',
      status: RunStatus.FAILED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      finishedAt: new Date(),
    },
  });
  await stack.tasks.update(space.ownerId, declared.id, { status: DeclaredTaskStatus.FAILED });
  return declared.id;
}

/** The ledger, oldest first — the audit, read the way a person would. */
function decisions(db: PrismaClient, projectId: string) {
  return db.projectConvergenceDecision.findMany({
    where: { projectId },
    orderBy: { seq: 'asc' },
  });
}

function noProgressBlockers(db: PrismaClient, projectId: string) {
  return db.projectBlocker.findMany({
    where: { projectId, kind: COORDINATOR_NO_PROGRESS_KIND },
    orderBy: { lifecycleGeneration: 'asc' },
  });
}

function exceptionWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'ATTEMPT_ENDED_UNSETTLED' },
    select: { status: true, refusalCode: true, sessionId: true, consumerType: true },
    orderBy: { createdAt: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** A defect that is genuinely open, so there is something the work can be measured as closing. */
async function openWorkBlocker(db: PrismaClient, projectId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.projectBlocker.create({
    data: {
      id,
      projectId,
      kind: 'MERGE_CONFLICT',
      subjectType: 'PROJECT',
      subjectId: projectId,
      owner: 'USER',
      recovery: 'HUMAN',
      severity: 'CRITICAL',
      requiredAction: 'resolve the conflict',
      nextCheckAt: now,
      dedupeKey: `convergence-budget-work:${id}`,
      lifecycleGeneration: 1n,
      conditionVersion: 'f'.repeat(64),
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
  return id;
}

/** The one thing in this file that is real progress: an open defect closed. */
function closeWorkBlocker(db: PrismaClient, blockerId: string) {
  return db.projectBlocker.update({
    where: { id: blockerId },
    // `project_blocker_resolution_chk`: a resolution names who made it, or is not one.
    data: { resolvedAt: new Date(), resolvedBy: 'USER' },
  });
}

/** A fact is recorded and charges nothing (`coordinator-convergence.ts` §1), so every row reads zero. */
function assertNothingCharged(rows: Array<{ counters: unknown }>, where: string): void {
  assert.deepEqual(
    rows.map((row) => row.counters),
    rows.map(() => ZERO_COUNTERS),
    `${where}: a fact charged the convergence budget`,
  );
}

/**
 * Past the old limit, driven by task writes.
 *
 * One project, N + 3 attempts that all end badly and improve nothing. Every number below is read
 * back out of committed rows after each write.
 */
test('N + 3 task writes that end badly are each recorded, and none is charged, refused or raised',
  { skip, timeout: 600_000 }, async () => {
    const stack = await connect();
    try {
      const space = await workspace(stack.db, 'budget-stalled');
      const projectId = await project(stack.db, space, 'stalled');

      const ledgerRows: number[] = [];
      const openRows: number[] = [];
      for (let round = 1; round <= N + 3; round += 1) {
        await anotherFailedAttempt(stack, space, projectId, round);
        ledgerRows.push((await decisions(stack.db, projectId)).length);
        openRows.push((await noProgressBlockers(stack.db, projectId)).length);
      }

      // 1. Each committed exception is one more recorded judgment, about the exception fact.
      assert.deepEqual(
        ledgerRows,
        Array.from({ length: N + 3 }, (_, index) => index + 1),
        'each task write that ended badly must leave exactly one more convergence decision',
      );
      const ledger = await decisions(stack.db, projectId);
      assert.deepEqual(
        [...new Set(ledger.map((row) => row.event))],
        ['ATTEMPT_ENDED_UNSETTLED'],
        'every decision in this run was recorded for the exception fact, not for a sibling door',
      );
      assert.deepEqual(ledger.map((row) => row.progressed), Array.from({ length: N + 3 }, () => false));

      // 2. Nothing charged, nothing stopped, nothing raised — including from the (N + 1)th, where
      //    the retired breaker stopped.
      assertNothingCharged(ledger, 'stalled');
      assert.deepEqual([...new Set(ledger.map((row) => row.outcome))], ['PROCEED']);
      assert.deepEqual(
        ledger.map((row) => [row.nonConvergenceReason, row.raisedBlockerId]),
        Array.from({ length: N + 3 }, () => [null, null]),
      );
      assert.deepEqual(openRows, Array.from({ length: N + 3 }, () => 0));

      // 3. And every one of them reached its consumer.
      const wakes = await exceptionWakes(stack.db, projectId);
      assert.equal(wakes.length, N + 3);
      assert.deepEqual(wakes.filter((wake) => wake.status !== 'CONSUMED'), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * The control: the same run, with one thing that actually got better in the middle of it.
 *
 * Both projects are driven identically — same number of task writes, same open defect from the
 * start — and differ in one committed row: whether that defect was closed before the fourth write.
 * The ledger still measures, so exactly that write is recorded as progress; and neither project is
 * charged or stopped, whichever way its work went.
 */
test('one real improvement partway through is the one judgment recorded as progress',
  { skip, timeout: 600_000 }, async () => {
    const stack = await connect();
    try {
      const space = await workspace(stack.db, 'budget-control');
      const stalledId = await project(stack.db, space, 'stalled-control');
      const recoveringId = await project(stack.db, space, 'recovering');
      await openWorkBlocker(stack.db, stalledId);
      const closeable = await openWorkBlocker(stack.db, recoveringId);

      const IMPROVES_BEFORE_ROUND = 4;
      for (let round = 1; round <= N + 1; round += 1) {
        if (round === IMPROVES_BEFORE_ROUND) await closeWorkBlocker(stack.db, closeable);
        await anotherFailedAttempt(stack, space, stalledId, round);
        await anotherFailedAttempt(stack, space, recoveringId, round);
      }

      const stalled = await decisions(stack.db, stalledId);
      const recovering = await decisions(stack.db, recoveringId);
      assert.equal(stalled.length, N + 1);
      assert.equal(recovering.length, N + 1, 'a fact is judged whether or not the work improved');

      assert.deepEqual(stalled.map((row) => row.progressed), Array.from({ length: N + 1 }, () => false));
      assert.deepEqual(
        recovering.map((row) => row.progressed),
        Array.from({ length: N + 1 }, (_, index) => index + 1 === IMPROVES_BEFORE_ROUND),
        'exactly the write that followed the closed defect is the one that measured progress',
      );

      for (const [label, ledger, projectId] of [
        ['stalled', stalled, stalledId],
        ['recovering', recovering, recoveringId],
      ] as const) {
        assertNothingCharged(ledger, label);
        assert.deepEqual([...new Set(ledger.map((row) => row.outcome))], ['PROCEED'], `${label} was stopped`);
        assert.deepEqual(await noProgressBlockers(stack.db, projectId), [], `${label} had a blocker raised`);
      }
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * The negative, and the positive that keeps it honest.
 *
 * "No decision rows" is true of a project nobody ever delivered anything to, so asserted alone it
 * would survive the delivery being deleted outright. Both halves are therefore the SAME project
 * and the SAME kind of task write, and the only thing that changes between them is the switch:
 * off, the fact goes all the way to the wake ledger and stops there as one REFUSED row with this
 * producer's own code, recording no judgment; on, the very next one is judged and the ledger has a
 * row.
 */
test('with the coordinator switched off the fact is refused before the ledger, and never recorded',
  { skip, timeout: 600_000 }, async () => {
    const stack = await connect();
    try {
      const space = await workspace(stack.db, 'budget-disabled');
      const projectId = await project(stack.db, space, 'switched-off', false);

      await anotherFailedAttempt(stack, space, projectId, 1);

      const refused = await exceptionWakes(stack.db, projectId);
      assert.equal(refused.length, 1, 'the failed task never reached the wake ledger at all');
      assert.equal(refused[0]!.status, 'REFUSED');
      assert.equal(refused[0]!.refusalCode, EXCEPTION_WAKE_COORDINATOR_DISABLED);
      assert.equal(refused[0]!.sessionId, null);
      assert.equal(refused[0]!.consumerType, null);
      assert.deepEqual(
        await decisions(stack.db, projectId), [],
        'a refusal cheaper than convergence must not have been recorded as a judgment',
      );
      assert.deepEqual(await noProgressBlockers(stack.db, projectId), []);
      assert.deepEqual(await judgmentSessions(stack.db, space.ownerId), []);

      // One variable, flipped. Everything else about the next write is what the one above was.
      await stack.db.project.update({
        where: { id: projectId },
        data: { coordinatorEnabled: true },
      });
      await anotherFailedAttempt(stack, space, projectId, 2);

      const judged = await decisions(stack.db, projectId);
      assert.equal(judged.length, 1, 'with the switch on, the same kind of write is judged');
      assert.equal(judged[0]!.event, 'ATTEMPT_ENDED_UNSETTLED');
      assertNothingCharged(judged, 'switched-on');
      const both = await exceptionWakes(stack.db, projectId);
      assert.equal(both.length, 2);
      assert.deepEqual(
        [...both].map((wake) => wake.status).sort(),
        ['CONSUMED', 'REFUSED'],
        'the switched-off write kept its refusal, and the switched-on one was consumed',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the convergence-budget PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
