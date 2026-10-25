import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskProgressService } from '../tasks/task-progress.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService, coordinatorDeliveryTurnId } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  type TaskSettlement,
  type WakeFact,
  criterionSubjectId,
  settlementVersion,
  wakeIdempotencyKey,
} from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import {
  CriterionUnlandedProducer,
  type CriterionUnlandedDelivery,
} from './criterion-unlanded.producer';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { OPEN_ITEM_TURN_PREFIX } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * A delivery sent back with `task_reopen` and delivered again is a new `CRITERION_UNLANDED` fact,
 * even when nothing else under its criterion moved; a criterion nobody ever sent back derives the
 * very version it derived before this was fixed.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criterion-unlanded-redelivery.pg.spec.ts
 *
 * THE INCIDENT THIS PINS
 * ======================
 * The fact's version was `settlementVersion`: a digest of the serving tasks' `(taskId, status)` and
 * of nothing else. A task sent back and delivered again is DONE again, so when nothing else under
 * its criterion had moved — always, for a criterion one task serves — the digest was the one its
 * first delivery had already spent. The claim answered ALREADY_AWAKE and `spend` stopped there:
 * nothing read what the new delivery changed (`WakeDispositionService.raiseBlockerIfNeeded` runs
 * only for a won claim), and the coordinator was told nothing. In production, 4 of the 8 tasks that
 * were reviewed, sent back and delivered again had no CRITERION_UNLANDED wake after the send-back
 * at all, and all 4 were the only task serving their criterion: task 01a10cd8-cdf3 was reviewed on
 * 2026-10-06 at 08:57, sent back at 08:58, and reached `main` afterwards by the integration line with
 * nobody asked about the new delivery.
 *
 * WHAT EACH CASE SHOWS
 * ====================
 *   (a) one task's delivery strays, is reviewed and sent back, and strays again: the new delivery is
 *       a new fact, it is reviewed again, and the coordinator is handed the new review;
 *   (b) one task's clean delivery is handed to the coordinator, sent back, and delivered clean
 *       again: a new fact, and a second message telling the coordinator to merge;
 *   (c) one task's clean delivery is sent back and delivered with a file it was never asked to
 *       change: the reading is taken again and finds it;
 *   (d) two tasks, one sent back and delivered again while its sibling stays DONE: the pairs are the
 *       ones the criterion was first told about, and it is still a new fact;
 *   (e) a criterion nobody ever sent back — one task that reported progress, and two siblings —
 *       derives exactly the version the old digest gave it, so a fact the code before this change
 *       already spent is ALREADY_AWAKE after it, and the coordinator is told nothing twice.
 *
 * (a)–(d) are red on the old version and green on the new one; (e) is green on both, which is its
 * point. Every delivery goes through the production path, as in `delivery-review-repeat.pg.spec.ts`:
 * DONE through the database's DONE fence, the attempt's reported file set, and the router's own
 * unlanded-criterion door — the edge every task write and every merge receipt runs. The send-back is
 * the status write `task_reopen` sends. Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'VERIFICATION';
const CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

const DECLARED_DIR = 'src/apiserver/src/projects';
const IN_SCOPE = `${DECLARED_DIR}/criterion-unlanded-redelivery.ts`;
/** A file no declaration here ever names. */
const STRAY = 'src/runner-go/worktree.go';
const DECLARATION = `Only change files under ${DECLARED_DIR}/ and leave every other directory alone.`;

interface Stack {
  db: PrismaClient;
  sql: Client;
  router: CompletionInputRouter;
  unlanded: CriterionUnlandedProducer;
  disposition: WakeDispositionService;
  tasks: TasksService;
  projects: ProjectsService;
  progress: TaskProgressService;
}

/** The production wiring over one client, with the item service the disposition hands reviews to. */
async function connect(): Promise<Stack> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const convergence = new CoordinatorConvergenceService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions);
  const deliveries = new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions);
  const unlanded = new CriterionUnlandedProducer(prisma, convergence);
  const disposition = new WakeDispositionService(prisma, judgments, deliveries, openItems);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    disposition,
    unlanded,
  );
  return {
    db,
    sql,
    router,
    unlanded,
    disposition,
    tasks: new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems),
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
    progress: new TaskProgressService(prisma),
  };
}

async function disconnect(stack: Stack): Promise<void> {
  await stack.db.$disconnect().catch(() => undefined);
  await stack.sql.end().catch(() => undefined);
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/** One owner, one runner, one Automatic project with a standing coordinator conversation. */
async function fixture(stack: Stack, label: string): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@criterion-unlanded-redelivery.invalid`,
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
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `Coordinate: ${label}`,
      prompt: `Coordinate: ${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `Coordinate: ${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
      exceptionEscalationSeconds: 600,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

/** State one criterion through the owner's own path, and read its stable key back. */
async function state(stack: Stack, f: Fixture, text: string): Promise<string> {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: [{ text, verificationMethod: METHOD }],
  } as never);
  const [criterion] = criteriaFromDefinitions(written.acceptanceCriteriaItems);
  assert.ok(criterion, 'the criterion was not stated');
  return criterion.key;
}

/** File one piece of work against the criterion. Every declaration here names the same directory. */
async function fileWork(stack: Stack, f: Fixture, criterionKey: string, title: string): Promise<string> {
  const created = await stack.tasks.create(f.ownerId, {
    title,
    description: DECLARATION,
    projectId: f.projectId,
    criterionKey,
    ...CHECK,
  } as never);
  return created.id;
}

/** The attempt that produced the work: its branch and the file set it reported. */
async function attempt(
  stack: Stack,
  f: Fixture,
  taskId: string,
  label: string,
  paths: readonly string[],
): Promise<string> {
  const sessionId = randomUUID();
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
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      branch: `orbit/${label}`,
      isolationStatus: 'worktree',
      finishedAt: new Date(),
      changedFiles: paths.map((path) => ({ path, additions: 1, deletions: 0, status: 'A' })),
    },
  });
  return sessionId;
}

/** DONE, through the database's DONE fence: the WHERE clause repeats the declaration. */
async function settle(stack: Stack, taskId: string): Promise<void> {
  const written = await stack.sql.query(
    `UPDATE "task" SET "status" = 'DONE'
      WHERE "id" = $1::uuid
        AND "status" IN ('OPEN', 'IN_PROGRESS')
        AND "completion_criterion" = 'EXECUTABLE'
        AND "acceptance_command" = 'true'
        AND "acceptance_expected_exit_code" = 0`,
    [taskId],
  );
  assert.equal(written.rowCount, 1, 'the task did not reach DONE through the DONE fence');
}

/**
 * One delivery: the attempt that made it, its DONE, and what the router's unlanded-criterion door
 * answered about the criterion it serves — `undefined` when the criterion derived no fact, which is
 * what a criterion with work still open answers.
 */
async function deliver(
  stack: Stack,
  f: Fixture,
  taskId: string,
  criterionKey: string,
  label: string,
  paths: readonly string[],
): Promise<{ sessionId: string; spent: CriterionUnlandedDelivery | undefined }> {
  const sessionId = await attempt(stack, f, taskId, label, paths);
  await settle(stack, taskId);
  const delivered = await stack.router.routeUnlandedCriteria([f.projectId]);
  const spent = delivered.find(
    (one) => one.criterionSubjectId === criterionSubjectId(f.projectId, criterionKey),
  );
  return { sessionId, spent };
}

/**
 * What `task_reopen` sends: the status write with any retirement cleared in the same request. The
 * lifecycle epoch it starts (0271's trigger) is asserted, because it is the one thing the new
 * delivery can be told apart by.
 */
async function sendBack(stack: Stack, f: Fixture, taskId: string): Promise<void> {
  await stack.tasks.update(f.ownerId, taskId, {
    status: 'OPEN', supersededByTaskId: null, terminalReason: null,
  } as never);
  const row = await stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { status: true, progress: { select: { lifecycleEpoch: true } } },
  });
  assert.equal(row.status, 'OPEN', 'the task was not sent back');
  assert.equal(row.progress?.lifecycleEpoch, 1, 'the send-back did not start a new lifecycle epoch');
}

/**
 * The coordinator conversation reads what it was handed and goes idle again, which is what a runner
 * does with a queued turn. Without it the next message would be refused as "not read the last one
 * yet" (`coordinator-delivery.service.ts` §2.1) — true, and not this file's subject.
 */
async function coordinatorReads(stack: Stack, f: Fixture): Promise<void> {
  const now = new Date();
  await stack.db.conversationTurn.updateMany({
    where: { sessionId: f.coordinatorSessionId, status: 'PENDING' },
    data: { status: 'ANSWERED', deliveredAt: now, answeredAt: now },
  });
  await stack.db.session.update({
    where: { id: f.coordinatorSessionId },
    data: { status: RunStatus.AWAITING_INPUT },
  });
}

/** Every `CRITERION_UNLANDED` wake of the project, oldest first. */
const unlandedWakes = (stack: Stack, f: Fixture) =>
  stack.db.projectCoordinatorWake.findMany({
    where: { projectId: f.projectId, event: 'CRITERION_UNLANDED' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { subjectId: true, subjectVersion: true, idempotencyKey: true, status: true },
  });

/** Every delivery review ever filed about one task, oldest first. */
async function reviewsOf(stack: Stack, taskId: string) {
  const rows = await stack.db.projectOpenItem.findMany({
    where: { taskId, kind: 'DELIVERY_REVIEW' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, state: true, resolution: true, sessionId: true, payload: true },
  });
  return rows.map((row) => ({
    ...row,
    reason: (row.payload as { reason?: string }).reason,
    paths: (row.payload as { paths?: string[] }).paths,
  }));
}

/** The turns the coordinator conversation was handed, past the prompt it opened with. */
async function turnsTo(stack: Stack, f: Fixture) {
  const turns = await stack.db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    orderBy: { seq: 'asc' },
    select: { clientTurnId: true, content: true },
  });
  return turns.map((turn) => ({ clientTurnId: turn.clientTurnId ?? '', content: turn.content ?? '' }));
}

/** The message one review was handed to the coordinator as (`openItemTurnId`). */
async function reviewHandedOver(stack: Stack, f: Fixture, itemId: string) {
  const prefix = `${OPEN_ITEM_TURN_PREFIX}${itemId}:`;
  return (await turnsTo(stack, f)).filter((turn) => turn.clientTurnId.startsWith(prefix));
}

/** The message one wake was delivered to the coordinator as (`coordinatorDeliveryTurnId`). */
async function wakeHandedOver(stack: Stack, f: Fixture, idempotencyKey: string) {
  const turnId = coordinatorDeliveryTurnId(idempotencyKey);
  return (await turnsTo(stack, f)).filter((turn) => turn.clientTurnId === turnId);
}

/**
 * Two wakes about the one criterion, the second under a version of its own: the re-delivery was
 * derived again rather than taken for the delivery it was sent back from.
 */
async function derivedTwice(stack: Stack, f: Fixture, criterionKey: string) {
  const wakes = await unlandedWakes(stack, f);
  assert.deepEqual(
    wakes.map((wake) => wake.subjectId),
    [criterionSubjectId(f.projectId, criterionKey), criterionSubjectId(f.projectId, criterionKey)],
    'the criterion was not derived once per delivery',
  );
  assert.notEqual(wakes[0]!.subjectVersion, wakes[1]!.subjectVersion,
    'the delivery after the send-back has the version of the one before it');
  return wakes;
}

// (a) ----------------------------------------------------------------------------------------
test('one task’s delivery strays, is reviewed and sent back, and strays again: the new delivery is a '
  + 'new fact, it is reviewed again, and the coordinator is handed the new review',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'reviewed');
      const key = await state(stack, f, 'Reviewed: the only delivery strays, is sent back, and strays again');
      const task = await fileWork(stack, f, key, 'reviewed: the only delivery');
      const first = await deliver(stack, f, task, key, 'reviewed-first', [IN_SCOPE, STRAY]);
      assert.equal(first.spent?.review?.reason, 'OUTSIDE_DECLARED_SCOPE', 'the first delivery was not reviewed');
      const [asked] = await reviewsOf(stack, task);
      await coordinatorReads(stack, f);

      // What 01a10cd8 took: reviewed, and sent back before anybody closed the review.
      await sendBack(stack, f, task);
      await coordinatorReads(stack, f);
      const again = await deliver(stack, f, task, key, 'reviewed-again', [IN_SCOPE, STRAY]);

      // 1 — the delivery is derived again, under a key nothing held.
      assert.notEqual(again.spent?.outcome, 'ALREADY_AWAKE',
        'the delivery made after the send-back was taken for the one it was sent back from');
      assert.equal(again.spent?.outcome, 'CONSUMED');
      await derivedTwice(stack, f, key);

      // 2 — its reading is taken again: the stray file is a review of its own, about the new attempt.
      const reviews = await reviewsOf(stack, task);
      assert.deepEqual(reviews.map((row) => [row.id, row.state, row.resolution]), [
        [asked!.id, 'RESOLVED', 'RETRIED'],
        [reviews[1]?.id, 'OPEN', null],
      ], 'the delivery made after the send-back was not reviewed');
      assert.equal(reviews[1]!.reason, 'OUTSIDE_DECLARED_SCOPE');
      assert.equal(reviews[1]!.sessionId, again.sessionId, 'the new review is not about the new delivery');
      assert.deepEqual(reviews[1]!.paths, [STRAY]);
      assert.equal(again.spent?.review?.itemId, reviews[1]!.id, 'the fact did not report the review it filed');
      assert.equal(again.spent?.action, undefined, 'a delivery under review chose a mechanical action');

      // 3 — and the coordinator is handed it.
      const handed = await reviewHandedOver(stack, f, reviews[1]!.id);
      assert.equal(handed.length, 1, 'the coordinator was not handed the new review');
      assert.ok(handed[0]!.content.includes(STRAY), 'the review handed over does not name the stray file');
    } finally {
      await disconnect(stack);
    }
  });

// (b) ----------------------------------------------------------------------------------------
test('one task’s clean delivery is handed to the coordinator, sent back, and delivered clean again: '
  + 'a new fact, and a second message telling the coordinator to merge',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'merge-again');
      const key = await state(stack, f, 'Merge again: the only delivery is sent back and delivered again');
      const task = await fileWork(stack, f, key, 'merge-again: the only delivery');
      const first = await deliver(stack, f, task, key, 'merge-again-first', [IN_SCOPE]);
      assert.equal(first.spent?.outcome, 'DELIVERED', 'the first delivery did not reach the coordinator');
      await coordinatorReads(stack, f);

      await sendBack(stack, f, task);
      await coordinatorReads(stack, f);
      const again = await deliver(stack, f, task, key, 'merge-again-again', [IN_SCOPE]);

      // 1 — derived again, and with nothing to stop it, handed to the coordinator with the merge.
      assert.notEqual(again.spent?.outcome, 'ALREADY_AWAKE',
        'the delivery made after the send-back was taken for the one it was sent back from');
      assert.equal(again.spent?.outcome, 'DELIVERED', 'the new delivery did not reach the coordinator');
      assert.equal(again.spent?.review, undefined);
      assert.equal(again.spent?.blockerKind, undefined);
      assert.equal(again.spent?.action, 'MERGE_AND_RELEASE_NEXT');
      const wakes = await derivedTwice(stack, f, key);
      assert.deepEqual(wakes.map((wake) => wake.status), ['DELIVERED', 'DELIVERED']);

      // 2 — the coordinator was told twice, once per delivery, in the words that ask for the merge.
      for (const wake of wakes) {
        const told = await wakeHandedOver(stack, f, wake.idempotencyKey);
        assert.equal(told.length, 1, 'a delivery of this criterion did not reach the coordinator');
        assert.ok(told[0]!.content.includes('no merge receipt proves'),
          'the coordinator was not told that the work is not on the default branch');
      }
      assert.deepEqual(await reviewsOf(stack, task), [], 'a clean delivery was reviewed');
    } finally {
      await disconnect(stack);
    }
  });

// (c) ----------------------------------------------------------------------------------------
test('one task’s clean delivery is sent back and delivered with a file it was never asked to '
  + 'change: the reading is taken again and finds it',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'strays-later');
      const key = await state(stack, f, 'Strays later: the second delivery changes a file the first did not');
      const task = await fileWork(stack, f, key, 'strays-later: the only delivery');
      const first = await deliver(stack, f, task, key, 'strays-later-first', [IN_SCOPE]);
      assert.equal(first.spent?.outcome, 'DELIVERED', 'the first delivery did not reach the coordinator');
      await coordinatorReads(stack, f);

      await sendBack(stack, f, task);
      await coordinatorReads(stack, f);
      const again = await deliver(stack, f, task, key, 'strays-later-again', [IN_SCOPE, STRAY]);

      assert.notEqual(again.spent?.outcome, 'ALREADY_AWAKE',
        'the delivery made after the send-back was taken for the one it was sent back from');
      assert.equal(again.spent?.outcome, 'CONSUMED');
      await derivedTwice(stack, f, key);

      const reviews = await reviewsOf(stack, task);
      assert.deepEqual(reviews.map((row) => [row.state, row.reason, row.sessionId]),
        [['OPEN', 'OUTSIDE_DECLARED_SCOPE', again.sessionId]],
        'the stray file of the delivery made after the send-back was never read');
      assert.deepEqual(reviews[0]!.paths, [STRAY]);
      assert.equal(again.spent?.review?.itemId, reviews[0]!.id);
      assert.equal(again.spent?.action, undefined, 'a delivery under review chose a mechanical action');
      assert.equal((await reviewHandedOver(stack, f, reviews[0]!.id)).length, 1,
        'the coordinator was not handed the review');
    } finally {
      await disconnect(stack);
    }
  });

// (d) ----------------------------------------------------------------------------------------
test('two tasks, one sent back and delivered again while its sibling stays DONE: the same pairs the '
  + 'criterion was first told about, and still a new fact',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'sibling');
      const key = await state(stack, f, 'Sibling: one of two deliveries is sent back');
      const returned = await fileWork(stack, f, key, 'sibling: the delivery sent back');
      const sibling = await fileWork(stack, f, key, 'sibling: the one left alone');
      const opened = await deliver(stack, f, returned, key, 'sibling-first', [IN_SCOPE]);
      assert.equal(opened.spent, undefined, 'a criterion with open work derived a fact');
      const told = await deliver(stack, f, sibling, key, 'sibling-second', [IN_SCOPE]);
      assert.equal(told.spent?.outcome, 'DELIVERED', 'the finished criterion did not reach the coordinator');
      await coordinatorReads(stack, f);

      await sendBack(stack, f, returned);
      await coordinatorReads(stack, f);
      const again = await deliver(stack, f, returned, key, 'sibling-again', [IN_SCOPE]);

      // Both DONE again and the sibling never moved: the `(taskId, status)` pairs are exactly the ones
      // the criterion was told about the first time.
      assert.notEqual(again.spent?.outcome, 'ALREADY_AWAKE',
        'the delivery made after the send-back was taken for the one it was sent back from');
      assert.equal(again.spent?.outcome, 'DELIVERED', 'the new delivery did not reach the coordinator');
      assert.equal(again.spent?.action, 'MERGE_AND_RELEASE_NEXT');
      const wakes = await derivedTwice(stack, f, key);
      assert.deepEqual(wakes.map((wake) => wake.status), ['DELIVERED', 'DELIVERED']);
      assert.equal((await wakeHandedOver(stack, f, wakes[1]!.idempotencyKey)).length, 1,
        'the coordinator was not told about the new delivery');
    } finally {
      await disconnect(stack);
    }
  });

/**
 * The fact the code before this change derived for a criterion: the same subject, with
 * `settlementVersion` over the serving set as its version — what `criterionUnlandedFact` returned
 * until the lifecycle epoch was folded in.
 */
function factBeforeTheChange(f: Fixture, criterionKey: string, serving: TaskSettlement[]): WakeFact {
  return {
    event: 'CRITERION_UNLANDED',
    projectId: f.projectId,
    subjectType: 'CRITERION',
    subjectId: criterionSubjectId(f.projectId, criterionKey),
    subjectVersion: settlementVersion(serving),
    detail: { criterionKey, taskCount: serving.length, landing: 'UNKNOWN' },
  };
}

// (e) ----------------------------------------------------------------------------------------
test('a criterion nobody ever sent back derives the version it always had, so a fact spent before '
  + 'this change is not spent again after it',
  { skip, timeout: 300_000 }, async (t) => {
    const stack = await connect();
    t.after(() => disconnect(stack));

    /**
     * The deploy, replayed: the criterion's work is finished and the code before this change already
     * told the coordinator about it — the fact it derived, handed through the door it used for a
     * clean delivery (`openIfDecisive`, which delivers to the standing conversation). Then the first
     * derivation after the deploy, which every task write and receipt in the project runs.
     */
    async function deployedOver(label: string, tasks: number, reportProgress: boolean) {
      const f = await fixture(stack, label);
      const key = await state(stack, f, `${label}: nobody ever sends this work back`);
      const ids: string[] = [];
      for (let n = 1; n <= tasks; n += 1) ids.push(await fileWork(stack, f, key, `${label}: delivery ${n}`));
      if (reportProgress) {
        // A progress row of its own, at epoch 0: a task that reported progress has one, and was still
        // never sent back.
        await stack.progress.report(f.ownerId, ids[0]!, { phase: 'tests', current: 1, total: 2 });
        const progress = await stack.db.taskProgress.findUniqueOrThrow({ where: { taskId: ids[0]! } });
        assert.equal(progress.lifecycleEpoch, 0);
        assert.equal(progress.epochStartedAt, null);
      }
      for (const [n, id] of ids.entries()) {
        await attempt(stack, f, id, `${label}-${n + 1}`, [IN_SCOPE]);
        await settle(stack, id);
      }
      const before = factBeforeTheChange(f, key, ids.map((taskId) => ({ taskId, status: 'DONE' })));

      // 1 — the version is the one the code before this change derived, so the key is too.
      const derived = (await stack.unlanded.factsFor([f.projectId]))
        .filter((fact) => fact.subjectId === before.subjectId);
      assert.equal(derived.length, 1, 'the finished criterion derived no fact');
      assert.equal(derived[0]!.subjectVersion, before.subjectVersion,
        'a criterion nobody sent back derives a version it never had');
      assert.equal(wakeIdempotencyKey(derived[0]!), wakeIdempotencyKey(before));

      // 2 — spent before the deploy …
      assert.deepEqual(await stack.disposition.openIfDecisive(before, stack.unlanded.authorize),
        { outcome: 'DELIVERED' }, 'the fact before the change did not reach the coordinator');
      await coordinatorReads(stack, f);
      const toldBefore = await turnsTo(stack, f);
      assert.equal(toldBefore.length, 1);

      // … and held after it: the coordinator is not told about the same work a second time.
      const after = await stack.router.routeUnlandedCriteria([f.projectId]);
      assert.deepEqual(after.map((one) => [one.criterionSubjectId, one.outcome]),
        [[before.subjectId, 'ALREADY_AWAKE']], 'the first derivation after the deploy spent the fact again');
      assert.deepEqual((await unlandedWakes(stack, f)).map((wake) => [wake.idempotencyKey, wake.status]),
        [[wakeIdempotencyKey(before), 'DELIVERED']]);
      assert.deepEqual(await turnsTo(stack, f), toldBefore, 'the coordinator was told about the same work again');
    }

    await t.test('one task, which reported progress', () => deployedOver('progress-only', 1, true));
    await t.test('two siblings', () => deployedOver('siblings', 2, false));
  });
