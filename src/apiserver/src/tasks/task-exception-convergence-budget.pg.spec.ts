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
  ConvergenceCounters,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  ZERO_COUNTERS,
} from '../projects/convergence-contract';
import {
  COORDINATOR_NO_PROGRESS_KIND,
  COORDINATOR_NO_PROGRESS_OWNER,
  COORDINATOR_NO_PROGRESS_RECOVERY,
  PROJECT_NOT_CONVERGING,
  noProgressDedupeKey,
} from '../projects/coordinator-convergence';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import {
  EXCEPTION_WAKE_COORDINATOR_DISABLED,
  TaskExceptionInputProducer,
} from '../projects/task-exception-input.producer';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * The convergence budget, spent by the delivery the task write path actually makes.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-exception-convergence-budget.pg.spec.js
 *
 * WHY THIS IS NOT COVERED BY ITS TWO NEIGHBOURS
 * ============================================
 * `task-exception-delivery.pg.spec.ts` asks whether an exception fact is authorized HERE rather
 * than by `CompletionInputRouter`'s always-allow default, and answers it with a convergence double
 * that refuses everything — which proves the seam and says nothing about the budget behind it.
 * `projects/coordinator-convergence.pg.spec.ts` asks what the budget does, and answers it by
 * handing `convergence.authorizeWake` to `CoordinatorWakeService.claim` itself, with no producer
 * and no task write in sight. Between the two, "a task that keeps ending badly eventually stops
 * waking anybody" was asserted by nobody: the whole of the loop this bounds — 「失败 → 立接替 →
 * 再失败 → 再立」— is a sequence of TASK WRITES, and a budget wired to everything except the door
 * those writes go through is a budget that reads 0 for ever. Every case below therefore drives
 * `TasksService.update`, N times, and reads what committed.
 *
 * WHAT MAKES THE THREE WRONG ANSWERS DISTINGUISHABLE
 * ==================================================
 * The blocker is raised on the TRANSITION into a stop, so "never raised" and "raised on every
 * further fact" are both defects, and neither is visible in a count of open blocker ROWS: the
 * partial unique index over open rows would absorb a re-raise and leave the count at one. So the
 * assertions below are over `project_convergence_decision.blocker_id` — the column that says
 * which DECISION raised it — and the sequence of those across the whole run is what tells the
 * three apart.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** N: the documented default, read from the frozen table rather than restated as a literal. */
const N = DEFAULT_CONVERGENCE_THRESHOLDS.maxDecisionsWithoutProgress as number;

/** Every counter name, from the contract's own zero, so a new one cannot skip the monotonicity. */
const COUNTER_NAMES = Object.keys(ZERO_COUNTERS) as Array<keyof ConvergenceCounters>;

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
 * The production wiring, over one client, with no seam at all.
 *
 * Its sibling spec passes a refusing convergence double because its question is which authorizer
 * the producer composed. This one's question is what the REAL ledger does with N facts, so there
 * is nothing here to substitute: a double would answer it with its own arithmetic.
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
    ),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
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
 * rather than `FRESH`, and a run whose every reading was unbelievable would charge the same
 * counters for a reason that is not the one under test.
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
          text: '连续无进展的唤醒会用完预算',
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
 * A NEW task and a NEW attempt every round, which is what makes this the loop the budget exists
 * for rather than one fact redelivered: the successor of a task that failed is a different task,
 * and its ending is a different fact with its own idempotency key. Nothing here writes a wake, a
 * decision or a blocker — the only call is `TasksService.update`, and everything asserted below is
 * what that write left behind after it committed.
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

function decisionsWithoutProgress(rows: Array<{ counters: unknown }>): number[] {
  return rows.map((row) => (row.counters as ConvergenceCounters).decisionsWithoutProgress);
}

/**
 * Nothing the ledger counts ever walks backwards while nothing improves.
 *
 * Asserted over EVERY counter rather than the one this scenario moves: a counter that went down
 * without progress is the shape every escape from this breaker has — a restart re-initialising
 * from zero, a redelivery processed as a fresh charge, a second writer starting its own count —
 * and which counter it happened to be is not the interesting part.
 */
function assertCountersNeverRetreat(rows: Array<{ counters: unknown }>): void {
  for (let i = 1; i < rows.length; i += 1) {
    const before = rows[i - 1]!.counters as ConvergenceCounters;
    const after = rows[i]!.counters as ConvergenceCounters;
    for (const name of COUNTER_NAMES) {
      assert.ok(
        after[name] >= before[name],
        `counter ${name} fell from ${before[name]} to ${after[name]} between decisions `
        + `${i} and ${i + 1}, and nothing in this run improved`,
      );
    }
  }
}

/**
 * The whole of the stop-loss, driven by task writes.
 *
 * One project, N + 3 attempts that all end badly and improve nothing. Every number below is read
 * back out of committed rows after each write, so "the counters moved" is a statement about the
 * database rather than about a return value nobody stored.
 */
test('N task writes that end badly spend the budget, and the N+1th is the only one that raises',
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

      // 1. Each committed exception is one more judgment. A door that stopped charging after the
      //    stop — or one that never charged at all — reads flat here.
      assert.deepEqual(
        ledgerRows,
        Array.from({ length: N + 3 }, (_, index) => index + 1),
        'each task write that ended badly must leave exactly one more convergence decision',
      );

      const ledger = await decisions(stack.db, projectId);
      assert.deepEqual(
        [...new Set(ledger.map((row) => row.event))],
        ['ATTEMPT_ENDED_UNSETTLED'],
        'every decision in this run was charged to the exception fact, not to a sibling door',
      );

      // 2. The counters, monotone. The exact sequence is asserted as well as the property,
      //    because a budget that charged the same fact twice would also be monotone.
      assert.deepEqual(
        decisionsWithoutProgress(ledger),
        Array.from({ length: N + 3 }, (_, index) => index + 1),
        'no attempt improved anything, so every one of them is a decision without progress',
      );
      assertCountersNeverRetreat(ledger);

      // 3. The transition, and only the transition. `blocker_id` is the column that says which
      //    DECISION raised the row: a stop re-derived on every later fact would show a second id
      //    here while the open-row count below stayed at one.
      assert.deepEqual(
        ledger.map((row) => row.raisedBlockerId !== null),
        [
          ...Array.from({ length: N }, () => false),
          true,
          false,
          false,
        ],
        'the blocker belongs to the decision that CROSSED the limit and to no other',
      );
      assert.deepEqual(
        openRows,
        [...Array.from({ length: N }, () => 0), 1, 1, 1],
        'before the crossing there is no row to act on, and after it there is exactly one',
      );
      assert.deepEqual(
        ledger.map((row) => row.outcome),
        [...Array.from({ length: N }, () => 'PROCEED'), 'STOP', 'STOP', 'STOP'],
        'the limit is crossed once and stays crossed',
      );
      assert.equal(ledger[N]!.nonConvergenceReason, 'NO_PROGRESS');
      assert.equal(ledger[N]!.crossedLimit, N);
      assert.equal(ledger[N]!.observed, N + 1);

      const raised = await noProgressBlockers(stack.db, projectId);
      assert.equal(raised.length, 1);
      assert.equal(raised[0]!.id, ledger[N]!.raisedBlockerId);
      assert.equal(raised[0]!.owner, COORDINATOR_NO_PROGRESS_OWNER);
      assert.equal(raised[0]!.recovery, COORDINATOR_NO_PROGRESS_RECOVERY);
      assert.equal(raised[0]!.subjectType, 'PROJECT');
      assert.equal(raised[0]!.subjectId, projectId);
      assert.equal(raised[0]!.dedupeKey, noProgressDedupeKey(projectId));
      assert.equal(
        raised[0]!.lifecycleGeneration, 1n,
        'one episode, not one per fact — a second generation is a project that stalled twice',
      );
      assert.equal(raised[0]!.resolvedAt, null);

      // What the budget is FOR: once it is spent the facts stop waking anybody, and the refusal is
      // this unit's own rather than a delivery that quietly failed. Which fact went which way is
      // read off the LEDGER above, whose `seq` is allocated under the project's row lock; the
      // wake rows are counted rather than ordered, because their `created_at` is not that.
      const wakes = await exceptionWakes(stack.db, projectId);
      assert.equal(wakes.length, N + 3);
      assert.equal(wakes.filter((wake) => wake.status === 'CONSUMED').length, N);
      const stopped = wakes.filter((wake) => wake.status === 'REFUSED');
      assert.equal(stopped.length, 3);
      assert.deepEqual([...new Set(stopped.map((wake) => wake.refusalCode))], [PROJECT_NOT_CONVERGING]);
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * The control: the same run, with one thing that actually got better in the middle of it.
 *
 * Both projects are driven identically — same number of task writes, same open defect from the
 * start — and differ in one committed row: whether that defect was closed before the fourth
 * write. Asserting the stalled half alone would prove nothing about what the counters are
 * measuring, because a ledger that charged every fact unconditionally would produce it too.
 */
test('one real improvement partway through spends the budget differently, and raises nothing',
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

      // The stalled half is the same shape as the case above, restated here because it is this
      // case's baseline: without it "the counters behaved differently" has nothing to differ from.
      assert.deepEqual(
        decisionsWithoutProgress(stalled),
        Array.from({ length: N + 1 }, (_, index) => index + 1),
      );
      assert.deepEqual(stalled.map((row) => row.progressed), Array.from({ length: N + 1 }, () => false));
      assertCountersNeverRetreat(stalled);

      // The recovering half: one decision measured strict improvement, and the four "since last
      // progress" counters started again from it. That reset is the ONE thing the two runs do not
      // share, and it is licensed by a committed row rather than by anybody's claim.
      assert.deepEqual(
        recovering.map((row) => row.progressed),
        Array.from({ length: N + 1 }, (_, index) => index + 1 === IMPROVES_BEFORE_ROUND),
        'exactly the write that followed the closed defect is the one that measured progress',
      );
      assert.deepEqual(
        decisionsWithoutProgress(recovering),
        [1, 2, 3, 0, 1, 2, 3],
        'the budget restarts at the improvement and is charged again from there',
      );
      assert.notDeepEqual(
        decisionsWithoutProgress(recovering),
        decisionsWithoutProgress(stalled),
        'a run with a real improvement in it must not spend its budget like one without',
      );

      // And the consequence a person sees: the same N + 1 writes stop one project and not the
      // other. Nothing was raised on the recovering project at all — not raised and cleared.
      assert.equal((await noProgressBlockers(stack.db, stalledId)).length, 1);
      assert.deepEqual(
        recovering.map((row) => row.raisedBlockerId),
        Array.from({ length: N + 1 }, () => null),
      );
      assert.deepEqual(await noProgressBlockers(stack.db, recoveringId), []);
      assert.deepEqual(
        [...new Set(recovering.map((row) => row.outcome))], ['PROCEED'],
        'a project that is still moving goes on being woken',
      );
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
 * producer's own code, charging nothing; on, the very next one is judged and the ledger has a row.
 */
test('with the coordinator switched off the fact is refused before the budget, and never charged',
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
        'a refusal cheaper than convergence must not have charged a convergence pass',
      );
      assert.deepEqual(await noProgressBlockers(stack.db, projectId), []);
      assert.deepEqual(await judgmentSessions(stack.db, space.ownerId), []);

      // One variable, flipped. Everything else about the next write is what the one above was.
      await stack.db.project.update({
        where: { id: projectId },
        data: { coordinatorEnabled: true },
      });
      await anotherFailedAttempt(stack, space, projectId, 2);

      const charged = await decisions(stack.db, projectId);
      assert.equal(charged.length, 1, 'with the switch on, the same kind of write is judged');
      assert.equal(charged[0]!.event, 'ATTEMPT_ENDED_UNSETTLED');
      assert.deepEqual(decisionsWithoutProgress(charged), [1]);
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
