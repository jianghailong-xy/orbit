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
import { OPEN_ITEM_TURN_PREFIX } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * A merge git refused is a reading about the delivery it was refused for: a task sent back with
 * `task_reopen` after git refused its branch, and delivered again, is not read as refused until a
 * merge of the new delivery is refused in turn.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/conflict-reading-redelivery.pg.spec.ts
 *
 * THE HOLE THIS PINS
 * ==================
 * `WakeDispositionService.deliveriesUnder` read a task's `conflictedPaths` off its latest CONFLICT
 * receipt on a branch it lands on, whichever delivery that receipt was about. Since 2026-10-15 its
 * landings and the questions answered about it are read per delivery (0271's lifecycle epoch); the
 * refusal was not. So a task whose earlier delivery git refused, sent back and delivered again, was
 * read as MERGE_REFUSED_BY_GIT before anybody had tried to merge the new delivery, and the
 * coordinator was handed a "Git refused to merge it" review about it. Since 2026-10-16 a landing
 * from before the send-back no longer closes that review, so it stayed open until the new work
 * landed, the coordinator answered it, or the task was sent back again. One criterion task in
 * production had a CONFLICT receipt from before its send-back when this was written.
 *
 * WHAT EACH CASE SHOWS
 * ====================
 *   (a) a delivery git refused, sent back and delivered again with no merge tried since, is handed
 *       to the coordinator as finished work to merge, with no review — whether nobody merged the
 *       refused delivery, or somebody merged it by hand before it was sent back;
 *   (b) a delivery made after the send-back that git refuses in turn gets a review of its own,
 *       naming its own conflict;
 *   (c) a task never sent back, whether or not it ever reported progress, has its refused merge
 *       reviewed as before.
 *
 * (a) is red on the old reading and green on the new one; (b) and (c) are green on both, which is
 * their point. Every delivery goes through the production path, as in
 * `landed-question-redelivery.pg.spec.ts`: DONE through the database's DONE fence, the attempt's
 * reported file set, and the router's own unlanded-criterion door. A merge, refused or made, is a
 * receipt recorded through `MergeReceiptService`, and a send-back is the status write `task_reopen`
 * sends. Not destructive: every case owns freshly generated ids.
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
/** The file a delivery here changes when nothing is refused, inside what its task declared. */
const IN_SCOPE = `${DECLARED_DIR}/conflict-reading-redelivery.ts`;
/** The file the first delivery changes, and the one git refuses to merge it on. */
const FIRST = `${DECLARED_DIR}/conflict-reading-first.ts`;
/** The file the delivery made after the send-back changes — a different one, so two readings differ. */
const AGAIN = `${DECLARED_DIR}/conflict-reading-again.ts`;
const DECLARATION = `Only change files under ${DECLARED_DIR}/ and leave every other directory alone.`;

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
      email: `${label}-${ownerId}@conflict-reading-redelivery.invalid`,
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

/** File one piece of work against a criterion. Every declaration here names the same directory. */
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

/** Git refused to merge the attempt's branch into main, recorded through the door every merge is. */
async function refuse(
  stack: Stack,
  f: Fixture,
  sessionId: string,
  conflicts: readonly string[],
): Promise<void> {
  const recorded = await stack.receipts.record(f.ownerId, sessionId, {
    sourceSha: sha('c'),
    targetShaBefore: sha('0'),
    targetBranch: 'main',
    result: 'CONFLICT',
    conflicts: [...conflicts],
  } as never, 'RUNNER');
  assert.equal(recorded.created, true, 'the refused merge was not recorded');
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
 * One delivery: the attempt that made it, git refusing its branch on `refusedOn` when it names any
 * paths, its DONE, and what the router's unlanded-criterion door answered about the criterion it
 * serves — `undefined` when the criterion derived no fact, which is what a criterion with work still
 * open answers. A refusal is recorded while the task is still running, the way a runner's merge of
 * the session's branch reports it, so the fact it is read from is derived by the DONE below — the
 * order `automatic-coordinator-routing.pg.spec.ts` (f) takes.
 */
async function deliver(
  stack: Stack,
  f: Fixture,
  taskId: string,
  criterionKey: string,
  label: string,
  paths: readonly string[],
  refusedOn: readonly string[] = [],
): Promise<{ sessionId: string; spent: CriterionUnlandedDelivery | undefined }> {
  const sessionId = await attempt(stack, f, taskId, label, paths);
  if (refusedOn.length > 0) await refuse(stack, f, sessionId, refusedOn);
  await settle(stack, taskId);
  const delivered = await stack.router.routeUnlandedCriteria([f.projectId]);
  const spent = delivered.find(
    (one) => one.criterionSubjectId === criterionSubjectId(f.projectId, criterionKey),
  );
  return { sessionId, spent };
}

/**
 * What `task_reopen` sends: the status write with any retirement cleared in the same request. It
 * starts the task's next delivery (0271's lifecycle epoch), and the merge git refused is older than
 * that — the premise of every case that sends work back, asserted rather than assumed.
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
  const receipts = await stack.db.sessionMergeReceipt.findMany({
    where: { taskId },
    select: { result: true, createdAt: true },
  });
  assert.ok(receipts.some((receipt) => receipt.result === 'CONFLICT')
    && receipts.every((receipt) => receipt.createdAt < since),
  'the merge git refused is not from before the send-back');
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
    select: { id: true, state: true, resolution: true, sessionId: true, payload: true },
  });
  return rows.map((row) => ({
    ...row,
    reason: (row.payload as { reason?: string }).reason,
    paths: (row.payload as { paths?: string[] }).paths,
  }));
}

/** Every blocker ever raised about one task, oldest first. */
const blockersOf = (stack: Stack, f: Fixture, taskId: string) =>
  stack.db.projectBlocker.findMany({
    where: { projectId: f.projectId, subjectType: 'TASK', subjectId: taskId },
    orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, resolvedAt: true },
  });

/** The message one review was handed to the coordinator as (`openItemTurnId`). */
async function reviewHandedOver(stack: Stack, f: Fixture, itemId: string) {
  const turns = await stack.db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      clientTurnId: { startsWith: `${OPEN_ITEM_TURN_PREFIX}${itemId}:` },
    },
    orderBy: { seq: 'asc' },
    select: { content: true },
  });
  return turns.map((turn) => turn.content ?? '');
}

/**
 * The walk is in id order, so the task sent back is only read before its sibling if it sorts first.
 * Asserted rather than assumed: without it, a red below could pass for the wrong reason.
 */
function sortsFirst(first: string, second: string): void {
  assert.ok(first < second, 'the task sent back does not sort before its sibling');
}

// (a) ----------------------------------------------------------------------------------------
test('a delivery git refused, sent back and delivered again with no merge tried since, is handed to '
  + 'the coordinator to merge and is not reviewed as refused',
  { skip, timeout: 300_000 }, async (t) => {
    const stack = await connect();
    t.after(() => disconnect(stack));

    await t.test('when nobody merged the refused delivery', async () => {
      const f = await fixture(stack, 'refused');
      const [key] = await state(stack, f, ['Refused: git refused the only delivery, which is sent back']);
      const task = await fileWork(stack, f, key!, 'refused: the delivery sent back');
      const first = await deliver(stack, f, task, key!, 'refused-first', [FIRST], [FIRST]);
      assert.equal(first.spent?.review?.reason, 'MERGE_REFUSED_BY_GIT',
        'the refused merge was not put to the coordinator at all');
      const [refused] = await reviewsOf(stack, task);
      await coordinatorReads(stack, f);

      await sendBack(stack, f, task);
      await coordinatorReads(stack, f);
      const again = await deliver(stack, f, task, key!, 'refused-again', [AGAIN]);

      // 1 — nobody has tried to merge the new delivery, so nothing says git refused it. Before this
      // file it was reviewed as refused, on the receipt of the delivery it was sent back from.
      assert.deepEqual(
        (await reviewsOf(stack, task)).map((row) => [row.id, row.state, row.resolution, row.paths]),
        [[refused!.id, 'RESOLVED', 'RETRIED', [FIRST]]],
        'the delivery made after the send-back was reviewed as refused on the old delivery’s receipt',
      );
      assert.deepEqual(await blockersOf(stack, f, task), [],
        'the delivery made after the send-back was put to the owner as refused');

      // 2 — it is finished work that is not on main yet, and the coordinator is told to merge it.
      assert.equal(again.spent?.review, undefined, 'the new delivery stopped on a review');
      assert.equal(again.spent?.blockerKind, undefined, 'the new delivery stopped on a blocker');
      assert.equal(again.spent?.outcome, 'DELIVERED', 'the new delivery did not reach the coordinator');
      assert.equal(again.spent?.action, 'MERGE_AND_RELEASE_NEXT');
    });

    await t.test('when the refused delivery was merged by hand before it was sent back', async () => {
      const f = await fixture(stack, 'untangled');
      const [key] = await state(stack, f, ['Untangled: git refused it, it was merged by hand, then sent back']);
      const task = await fileWork(stack, f, key!, 'untangled: the delivery sent back');
      const first = await deliver(stack, f, task, key!, 'untangled-first', [FIRST], [FIRST]);
      assert.equal(first.spent?.review?.reason, 'MERGE_REFUSED_BY_GIT',
        'the refused merge was not put to the coordinator at all');
      await coordinatorReads(stack, f);
      // The coordinator untangles the tree and merges it; the receipt is what ends the review.
      await land(stack, f, first.sessionId, 'a');
      const [refused] = await reviewsOf(stack, task);
      assert.deepEqual([refused?.state, refused?.resolution], ['RESOLVED', 'LANDED'],
        'the merge made by hand did not end the review of the delivery it merged');
      await coordinatorReads(stack, f);

      // The sibling keeps the criterion off main: with the first delivery's work landed and nothing
      // else serving it, the criterion would read LANDED and derive no fact for the redelivery.
      const sibling = await fileWork(stack, f, key!, 'untangled: its sibling');
      sortsFirst(task, sibling);
      await sendBack(stack, f, task);
      await coordinatorReads(stack, f);
      const again = await deliver(stack, f, task, key!, 'untangled-again', [AGAIN]);
      assert.equal(again.spent, undefined, 'a criterion with open work derived a fact');
      await coordinatorReads(stack, f);
      const siblingDelivery = await deliver(stack, f, sibling, key!, 'untangled-sibling', [IN_SCOPE]);

      // 1 — the new delivery is not reviewed as refused. Before this file it was, and the landing
      // from before the send-back no longer ends that review, so it would have stayed open.
      assert.deepEqual(
        (await reviewsOf(stack, task)).map((row) => [row.id, row.state, row.resolution]),
        [[refused!.id, 'RESOLVED', 'LANDED']],
        'the delivery made after the send-back was reviewed as refused on the old delivery’s receipt',
      );
      assert.deepEqual(await blockersOf(stack, f, task), [],
        'the delivery made after the send-back was put to the owner as refused');

      // 2 — and with nothing left to decide, the criterion goes on to the coordinator with the merge
      // it is owed.
      assert.equal(siblingDelivery.spent?.review, undefined, 'the criterion still stopped on a review');
      assert.equal(siblingDelivery.spent?.blockerKind, undefined,
        'the criterion still stopped on a blocker');
      assert.equal(siblingDelivery.spent?.outcome, 'DELIVERED',
        'the criterion’s finished work did not reach the coordinator');
      assert.equal(siblingDelivery.spent?.action, 'MERGE_AND_RELEASE_NEXT');
    });
  });

// (b) ----------------------------------------------------------------------------------------
test('a delivery made after the send-back that git refuses in turn is reviewed as refused, naming '
  + 'its own conflict',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'refused-twice');
      const [key] = await state(stack, f, ['Refused twice: git refuses the delivery made since, too']);
      const task = await fileWork(stack, f, key!, 'refused-twice: the delivery sent back');
      const first = await deliver(stack, f, task, key!, 'refused-twice-first', [FIRST], [FIRST]);
      assert.equal(first.spent?.review?.reason, 'MERGE_REFUSED_BY_GIT',
        'the refused merge was not put to the coordinator at all');
      const [refused] = await reviewsOf(stack, task);
      await coordinatorReads(stack, f);

      await sendBack(stack, f, task);
      await coordinatorReads(stack, f);
      const again = await deliver(stack, f, task, key!, 'refused-twice-again', [AGAIN], [AGAIN]);

      // 1 — the new delivery's own refusal is put to the coordinator, as a refusal always was.
      const reviews = await reviewsOf(stack, task);
      assert.deepEqual(reviews.map((row) => [row.id, row.state, row.resolution]), [
        [refused!.id, 'RESOLVED', 'RETRIED'],
        [reviews[1]?.id, 'OPEN', null],
      ], 'the merge git refused for the new delivery was not put to the coordinator');
      const asked = reviews[1]!;
      assert.equal(asked.reason, 'MERGE_REFUSED_BY_GIT');
      assert.equal(asked.sessionId, again.sessionId, 'the new review is not about the new delivery');
      assert.deepEqual(asked.paths, [AGAIN],
        'the new review does not name the new delivery’s own conflict');
      assert.equal(again.spent?.review?.itemId, asked.id, 'the fact did not report the review it filed');
      assert.equal(again.spent?.action, undefined, 'a delivery git refused chose a mechanical action');
      assert.deepEqual(await blockersOf(stack, f, task), [], 'the refusal was put to the owner instead');

      // 2 — and the coordinator is handed it, in the words a refusal has always been put in.
      const handed = await reviewHandedOver(stack, f, asked.id);
      assert.equal(handed.length, 1, 'the coordinator was not handed the new review');
      assert.ok(handed[0]!.includes('Git refused to merge it'), 'the review handed over is not a refusal');
      assert.ok(handed[0]!.includes(AGAIN), 'the review handed over does not name the new conflict');
    } finally {
      await disconnect(stack);
    }
  });

// (c) ----------------------------------------------------------------------------------------
test('a task never sent back has its refused merge reviewed as before — whether or not it ever '
  + 'reported progress',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'never');
      const [reportedKey, silentKey] = await state(stack, f, [
        'Never: git refused a delivery that reported progress',
        'Never: git refused a delivery that never reported progress',
      ]);
      const reported = await fileWork(stack, f, reportedKey!, 'never: the delivery that reported progress');
      const silent = await fileWork(stack, f, silentKey!, 'never: the delivery that never did');
      // A task that reported progress has a row in its first lifecycle epoch, which began when the
      // task was created and has no start written down; one that never reported has no row at all.
      await stack.progress.report(f.ownerId, reported, { phase: 'implementation' });

      const reportedDelivery = await deliver(
        stack, f, reported, reportedKey!, 'never-reported', [IN_SCOPE], [IN_SCOPE],
      );
      await coordinatorReads(stack, f);
      const silentDelivery = await deliver(
        stack, f, silent, silentKey!, 'never-silent', [IN_SCOPE], [IN_SCOPE],
      );
      assert.deepEqual(
        await stack.db.taskProgress.findMany({
          where: { taskId: { in: [reported, silent] } },
          select: { taskId: true, lifecycleEpoch: true, epochStartedAt: true },
        }),
        [{ taskId: reported, lifecycleEpoch: 0, epochStartedAt: null }],
        'the fixture does not hold one task in its first epoch and one with no epoch row',
      );

      for (const [taskId, delivery] of [[reported, reportedDelivery], [silent, silentDelivery]] as const) {
        const reviews = await reviewsOf(stack, taskId);
        assert.deepEqual(
          reviews.map((row) => [row.state, row.reason, row.sessionId, row.paths]),
          [['OPEN', 'MERGE_REFUSED_BY_GIT', delivery.sessionId, [IN_SCOPE]]],
          'the merge git refused for a task never sent back was not put to the coordinator',
        );
        assert.equal(delivery.spent?.review?.itemId, reviews[0]!.id,
          'the fact did not report the review it filed');
        assert.equal(delivery.spent?.action, undefined, 'a delivery git refused chose a mechanical action');
        assert.deepEqual(await blockersOf(stack, f, taskId), [],
          'the refusal was put to the owner instead');
      }
    } finally {
      await disconnect(stack);
    }
  });
