import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskProgressService } from '../tasks/task-progress.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criterionSubjectId } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import {
  CriterionUnlandedProducer,
  type CriterionUnlandedDelivery,
} from './criterion-unlanded.producer';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * A landing ends the questions about the delivery that landed, and no others: a task sent back with
 * `task_reopen` after its work landed, and delivered again, is asked about the new delivery, and
 * that question stays open under the old landing until the new work lands as well.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landed-question-redelivery.pg.spec.ts
 *
 * THE HOLE THIS PINS
 * ==================
 * `WakeDispositionService.resolveLandedBlockers` runs at the end of every unlanded-criterion
 * delivery, and it closed a task's open questions — the owner's blocker about a moved standard, the
 * coordinator's review of an argued exemption or of a branch git refused — as soon as ANY receipt
 * put the task's work on a branch it lands on. Since 2026-10-15 `blockerFor` reads a delivery made
 * after a send-back as new, because a landing from before the send-back belonged to the delivery it
 * was sent back from (0271's lifecycle epoch). So the new delivery's question was put, and the old
 * receipt closed it again in the same request: asked, and answered by nobody. Five of production's
 * criterion tasks had landed and then been sent back when this was written.
 *
 * WHAT EACH CASE SHOWS
 * ====================
 *   (a) a delivery sent back after its work landed, and delivered again still arguing an exemption,
 *       gets a review the old landing does not end, and its own landing does;
 *   (b) the same for the owner's blocker, when the standard moved after the first landing;
 *   (c) a task never sent back, whether or not it ever reported progress, still has its review and
 *       its blocker ended by its landing.
 *
 * Every question is raised by the production path, as in `delivery-review-repeat.pg.spec.ts`:
 * DONE through the database's DONE fence, the attempt's reported file set, and the router's own
 * unlanded-criterion door. A landing is a merge receipt recorded through `MergeReceiptService`,
 * whose post-commit edge is what ends a question in production, and a send-back is the status write
 * `task_reopen` sends. Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'VERIFICATION';
const PROMOTED_METHOD = 'EXECUTABLE';
const CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

const DECLARED_DIR = 'src/apiserver/src/projects';
/** The one file every delivery here changes, inside what its task declared. */
const IN_SCOPE = `${DECLARED_DIR}/landed-question-redelivery.ts`;
const DECLARATION = `Only change files under ${DECLARED_DIR}/ and leave every other directory alone.`;
const ARGUMENT = 'The negative half of this criterion does not apply here: it exercises a path this '
  + 'task never touches.';

/** What a question ended by a landing says about why. */
const LANDED_NOTE = 'the work landed on main';

const sha = (nibble: string) => nibble.repeat(40);

interface Stack {
  db: PrismaClient;
  sql: Client;
  router: CompletionInputRouter;
  tasks: TasksService;
  progress: TaskProgressService;
  projects: ProjectsService;
  receipts: MergeReceiptService;
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
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries, openItems),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  return {
    db,
    sql,
    router,
    tasks: new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems),
    progress: new TaskProgressService(prisma),
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
    receipts: new MergeReceiptService(prisma, router),
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
      email: `${label}-${ownerId}@landed-question-redelivery.invalid`,
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

/** State the criteria through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]): Promise<string[]> {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems).map((item) => item.key);
}

/** Move one criterion's method up the ladder: its revision advances and its id stays. */
async function moveTheStandard(stack: Stack, f: Fixture, texts: string[], moved: string) {
  const before = await stack.projects.get(f.ownerId, f.projectId);
  const items = criteriaFromDefinitions(before.acceptanceCriteriaItems);
  await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: items.map((item, index) => ({
      id: item.key,
      text: texts[index]!,
      verificationMethod: item.key === moved ? PROMOTED_METHOD : METHOD,
    })),
  } as never);
}

/** File one piece of work against a criterion. Every declaration here names the same directory. */
async function fileWork(
  stack: Stack,
  f: Fixture,
  criterionKey: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await stack.tasks.create(f.ownerId, {
    title,
    description: DECLARATION,
    projectId: f.projectId,
    criterionKey,
    ...CHECK,
    ...extra,
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
 * What `task_reopen` sends: the status write with any retirement cleared in the same request. It
 * starts the task's next delivery (0271's lifecycle epoch), and everything the task has landed is
 * older than that — the premise of every case that sends work back, asserted rather than assumed.
 */
async function sendBack(stack: Stack, f: Fixture, taskId: string): Promise<void> {
  await stack.tasks.update(f.ownerId, taskId, {
    status: 'OPEN', supersededByTaskId: null, terminalReason: null,
  } as never);
  const row = await stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { status: true, progress: { select: { epochStartedAt: true } } },
  });
  assert.equal(row.status, 'OPEN', 'the task was not sent back');
  const since = row.progress?.epochStartedAt;
  assert.ok(since, 'the send-back started no new delivery');
  const landings = await stack.db.sessionMergeReceipt.findMany({
    where: { taskId },
    select: { createdAt: true },
  });
  assert.ok(landings.length > 0 && landings.every((landing) => landing.createdAt < since),
    'the task’s landing is not from before the send-back');
}

/** The attempt's branch merged into main, recorded through the door every merge is recorded by. */
async function land(stack: Stack, f: Fixture, sessionId: string, nibble: string): Promise<void> {
  const recorded = await stack.receipts.record(f.ownerId, sessionId, {
    sourceSha: sha(nibble),
    targetShaBefore: sha('0'),
    targetBranch: 'main',
    result: 'MERGED',
    targetShaAfter: sha('f'),
  } as never, 'AGENT');
  assert.equal(recorded.created, true, 'the landing was not recorded');
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

/** Every delivery review ever filed about one task, oldest first. */
async function reviewsOf(stack: Stack, taskId: string) {
  const rows = await stack.db.projectOpenItem.findMany({
    where: { taskId, kind: 'DELIVERY_REVIEW' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, state: true, resolution: true, resolvedBy: true, resolutionNote: true,
      sessionId: true, payload: true,
    },
  });
  return rows.map(({ payload, ...row }) => ({ ...row, reason: (payload as { reason?: string }).reason }));
}

/** Every blocker ever raised about one task, oldest first. */
const blockersOf = (stack: Stack, f: Fixture, taskId: string) =>
  stack.db.projectBlocker.findMany({
    where: { projectId: f.projectId, subjectType: 'TASK', subjectId: taskId },
    orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, resolvedAt: true, resolvedBy: true, resolutionNote: true },
  });

/**
 * The walk is in id order, so the task sent back is only read before its sibling if it sorts first.
 * Asserted rather than assumed: without it, a red below could pass for the wrong reason.
 */
function sortsFirst(first: string, second: string): void {
  assert.ok(first < second, 'the task sent back does not sort before its sibling');
}

// (a) ----------------------------------------------------------------------------------------
test('a delivery sent back after its work landed, and delivered again still arguing an exemption, '
  + 'keeps its new review open under the old landing until its own work lands',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'argued');
      const [key] = await state(stack, f, ['Argued: the delivery is sent back after it landed']);
      const first = await fileWork(stack, f, key!, 'argued: the delivery sent back', {
        completionCriterionOverrideReason: ARGUMENT,
      });
      const firstDelivery = await deliver(stack, f, first, key!, 'argued-first', [IN_SCOPE]);
      assert.equal(firstDelivery.spent?.review?.reason, 'CRITERION_EXEMPTION_ARGUED',
        'the argued exemption was not put to the coordinator at all');
      await land(stack, f, firstDelivery.sessionId, 'a');
      const [landedReview] = await reviewsOf(stack, first);
      assert.deepEqual([landedReview?.state, landedReview?.resolution], ['RESOLVED', 'LANDED'],
        'the first landing did not end the review of the delivery that landed');
      await coordinatorReads(stack, f);

      // The sibling is filed before the send-back because a criterion derives its fact again only
      // once all of its work is DONE again — the order `delivery-review-repeat.pg.spec.ts` (e) takes.
      const sibling = await fileWork(stack, f, key!, 'argued: its sibling');
      sortsFirst(first, sibling);
      await sendBack(stack, f, first);
      const again = await deliver(stack, f, first, key!, 'argued-again', [IN_SCOPE]);
      assert.equal(again.spent, undefined, 'a criterion with open work derived a fact');
      const siblingDelivery = await deliver(stack, f, sibling, key!, 'argued-sibling', [IN_SCOPE]);

      // 1 — the new delivery is asked about, and the landing from before the send-back does not
      // answer it. Before this file it was closed as LANDED by the request that filed it.
      const reviews = await reviewsOf(stack, first);
      assert.deepEqual(reviews.map((row) => [row.id, row.state, row.resolution]), [
        [landedReview!.id, 'RESOLVED', 'LANDED'],
        [reviews[1]?.id, 'OPEN', null],
      ], 'the landing from before the send-back ended the review of the delivery made after it');
      const asked = reviews[1]!;
      assert.equal(asked.reason, 'CRITERION_EXEMPTION_ARGUED');
      assert.equal(asked.sessionId, again.sessionId, 'the new review is not about the new delivery');
      assert.equal(siblingDelivery.spent?.review?.itemId, asked.id,
        'the fact did not report the review it filed');

      // 2 — the new delivery's own landing ends it, the way a landing always has.
      await coordinatorReads(stack, f);
      await land(stack, f, again.sessionId, 'b');
      assert.deepEqual(
        (await reviewsOf(stack, first))
          .map((row) => [row.id, row.state, row.resolution, row.resolvedBy, row.resolutionNote]),
        [
          [landedReview!.id, 'RESOLVED', 'LANDED', 'PLATFORM', LANDED_NOTE],
          [asked.id, 'RESOLVED', 'LANDED', 'PLATFORM', LANDED_NOTE],
        ],
        'the new delivery’s own landing did not end its review',
      );
    } finally {
      await disconnect(stack);
    }
  });

// (b) ----------------------------------------------------------------------------------------
test('a delivery sent back after its work landed, and delivered again under a standard that moved '
  + 'since, keeps the owner’s blocker open under the old landing until its own work lands',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'moved');
      const texts = ['Moved: the standard moves after the first landing'];
      const [key] = await state(stack, f, texts);
      const first = await fileWork(stack, f, key!, 'moved: the delivery sent back');
      const firstDelivery = await deliver(stack, f, first, key!, 'moved-first', [IN_SCOPE]);
      assert.equal(firstDelivery.spent?.action, 'MERGE_AND_RELEASE_NEXT',
        'the ordinary first delivery was not handed on to be merged');
      await land(stack, f, firstDelivery.sessionId, 'a');
      await coordinatorReads(stack, f);

      // The standard moves after the landing. The sibling, filed after the move, is ordinary.
      await moveTheStandard(stack, f, texts, key!);
      const sibling = await fileWork(stack, f, key!, 'moved: its sibling');
      sortsFirst(first, sibling);
      await sendBack(stack, f, first);
      const again = await deliver(stack, f, first, key!, 'moved-again', [IN_SCOPE]);
      assert.equal(again.spent, undefined, 'a criterion with open work derived a fact');
      const siblingDelivery = await deliver(stack, f, sibling, key!, 'moved-sibling', [IN_SCOPE]);
      assert.equal(siblingDelivery.spent?.blockerKind, 'POLICY_MANUAL_HOLD',
        'the delivery made under the moved standard was not put to the owner');

      // 1 — the owner is asked, and the landing from before the send-back does not answer it.
      const raised = await blockersOf(stack, f, first);
      assert.deepEqual(
        raised.map((row) => [row.kind, row.resolvedAt, row.resolutionNote]),
        [['POLICY_MANUAL_HOLD', null, null]],
        'the landing from before the send-back resolved the owner’s blocker about the delivery made after it',
      );

      // 2 — the new delivery's own landing resolves it, the way a landing always has.
      await coordinatorReads(stack, f);
      await land(stack, f, again.sessionId, 'b');
      const blockers = await blockersOf(stack, f, first);
      assert.equal(blockers.length, 1, 'the landing raised another blocker about the task');
      assert.ok(blockers[0]!.resolvedAt, 'the new delivery’s own landing did not resolve its blocker');
      assert.deepEqual(
        [blockers[0]!.id, blockers[0]!.resolvedBy, blockers[0]!.resolutionNote],
        [raised[0]!.id, 'AUTO', LANDED_NOTE],
      );
    } finally {
      await disconnect(stack);
    }
  });

// (c) ----------------------------------------------------------------------------------------
test('a task never sent back has its review and its blocker ended by its landing, as before — '
  + 'whether or not it ever reported progress',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'never');
      const texts = ['Never: the delivery argues an exemption', 'Never: the standard moved under the delivery'];
      const [arguedKey, movedKey] = await state(stack, f, texts);
      const argued = await fileWork(stack, f, arguedKey!, 'never: the argued delivery', {
        completionCriterionOverrideReason: ARGUMENT,
      });
      const moved = await fileWork(stack, f, movedKey!, 'never: the delivery under a moved standard');
      await moveTheStandard(stack, f, texts, movedKey!);
      // A task that reported progress has a row in its first lifecycle epoch, which began when the
      // task was created and has no start written down; one that never reported has no row at all.
      await stack.progress.report(f.ownerId, argued, { phase: 'implementation' });

      const arguedDelivery = await deliver(stack, f, argued, arguedKey!, 'never-argued', [IN_SCOPE]);
      assert.equal(arguedDelivery.spent?.review?.reason, 'CRITERION_EXEMPTION_ARGUED',
        'the argued exemption was not put to the coordinator at all');
      await coordinatorReads(stack, f);
      const movedDelivery = await deliver(stack, f, moved, movedKey!, 'never-moved', [IN_SCOPE]);
      assert.equal(movedDelivery.spent?.blockerKind, 'POLICY_MANUAL_HOLD',
        'the moved standard was not put to the owner at all');
      assert.deepEqual(
        await stack.db.taskProgress.findMany({
          where: { taskId: { in: [argued, moved] } },
          select: { taskId: true, lifecycleEpoch: true, epochStartedAt: true },
        }),
        [{ taskId: argued, lifecycleEpoch: 0, epochStartedAt: null }],
        'the fixture does not hold one task in its first epoch and one with no epoch row',
      );

      const [review] = await reviewsOf(stack, argued);
      const [blocker] = await blockersOf(stack, f, moved);
      assert.equal(review?.state, 'OPEN', 'the review ended before its work landed');
      assert.equal(blocker?.resolvedAt, null, 'the blocker ended before its work landed');

      // Each ends when its own work lands, and nothing else does.
      await coordinatorReads(stack, f);
      await land(stack, f, arguedDelivery.sessionId, 'a');
      assert.deepEqual(
        (await reviewsOf(stack, argued))
          .map((row) => [row.id, row.state, row.resolution, row.resolvedBy, row.resolutionNote]),
        [[review!.id, 'RESOLVED', 'LANDED', 'PLATFORM', LANDED_NOTE]],
        'landing the argued delivery did not end its review',
      );
      assert.equal((await blockersOf(stack, f, moved))[0]?.resolvedAt, null,
        'landing the argued delivery resolved the blocker about another task');

      await coordinatorReads(stack, f);
      await land(stack, f, movedDelivery.sessionId, 'b');
      const blockers = await blockersOf(stack, f, moved);
      assert.equal(blockers.length, 1, 'the landing raised another blocker about the task');
      assert.ok(blockers[0]!.resolvedAt, 'landing the delivery under the moved standard left its blocker open');
      assert.deepEqual(
        [blockers[0]!.id, blockers[0]!.resolvedBy, blockers[0]!.resolutionNote],
        [blocker!.id, 'AUTO', LANDED_NOTE],
      );
    } finally {
      await disconnect(stack);
    }
  });
