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
 * A delivery is asked about once: a sibling finishing under the same criterion does not put the
 * same question about it again, and does not keep its own question from being asked.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/delivery-review-repeat.pg.spec.ts
 *
 * THE INCIDENT THIS PINS
 * ======================
 * A criterion's `CRITERION_UNLANDED` fact is derived again whenever its work is all DONE in a new
 * way — a sibling finishing is enough — and `WakeDispositionService` then read every serving task in
 * id order and stopped at the first one with something a person has to decide. Nothing remembered
 * that the question had been put and answered: the open-item and blocker keys only stop a second
 * OPEN row. Up to 2026-10-15, production had 106 OUTSIDE_DECLARED_SCOPE reviews over 76 tasks, one
 * task asked six times, 52 of them after the work they asked about had merged — and owner blockers
 * re-raised up to their eighth generation, 89 of them after the work had landed and 84 of those
 * closed again within seconds. A sibling behind such a task never had its own delivery read at all.
 *
 * WHAT EACH CASE SHOWS
 * ====================
 *   (a) a review the coordinator handled is not filed again when a sibling finishes, and the
 *       sibling's own stray files get a review of their own;
 *   (b) a review the landing ended is not filed again either;
 *   (c) an owner blocker the owner resolved is not raised again, and with nothing else to decide the
 *       criterion goes on to the coordinator with the merge it is owed;
 *   (d) a question that is still open is not asked twice, and does not hide a later sibling's own;
 *   (e) a delivery sent back with `task_reopen` and delivered again IS asked about again — after a
 *       handled review, and after a landing, which belonged to the delivery it was sent back from.
 *
 * Every question is raised by the production path, as in `automatic-coordinator-routing.pg.spec.ts`:
 * DONE through the database's DONE fence, the attempt's reported file set, and the router's own
 * unlanded-criterion door — the edge every task write and every merge receipt runs. Answers go
 * through the doors that give them: the coordinator's `open_item_resolve`, the owner's blocker
 * resolution, a merge receipt, and the status write `task_reopen` sends. Not destructive: every case
 * owns freshly generated ids.
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
const IN_SCOPE = `${DECLARED_DIR}/delivery-review-repeat.ts`;
/** The file the first delivery was never asked to change. */
const STRAY = 'src/runner-go/worktree.go';
/** The one its sibling was never asked to change — a different file, so the two reviews differ. */
const SIBLING_STRAY = 'src/web/src/App.tsx';
const DECLARATION = `Only change files under ${DECLARED_DIR}/ and leave every other directory alone.`;
const ARGUMENT = 'The negative half of this criterion does not apply here: it exercises a path this '
  + 'task never touches.';

const sha = (nibble: string) => nibble.repeat(40);

interface Stack {
  db: PrismaClient;
  sql: Client;
  router: CompletionInputRouter;
  tasks: TasksService;
  projects: ProjectsService;
  openItems: ProjectOpenItemService;
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
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
    openItems,
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
      email: `${label}-${ownerId}@delivery-review-repeat.invalid`,
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

/** What `task_reopen` sends: the status write with any retirement cleared in the same request. */
async function sendBack(stack: Stack, f: Fixture, taskId: string): Promise<void> {
  await stack.tasks.update(f.ownerId, taskId, {
    status: 'OPEN', supersededByTaskId: null, terminalReason: null,
  } as never);
  const row = await stack.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } });
  assert.equal(row.status, 'OPEN', 'the task was not sent back');
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

/** The coordinator's own door, closing a review with its judgment. */
async function handle(stack: Stack, f: Fixture, itemId: string): Promise<void> {
  const resolved = await stack.openItems.resolveOpenItem(
    f.ownerId, f.projectId, itemId,
    { note: 'Accepted: the extra file is part of what this delivery had to change.' },
    { kind: 'SESSION', sessionId: f.coordinatorSessionId },
  );
  assert.equal(resolved.resolution, 'HANDLED', 'the coordinator did not close the review');
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
      id: true, state: true, resolution: true, sessionId: true, dedupeKey: true, payload: true,
    },
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
    select: { id: true, kind: true, resolvedAt: true, lifecycleGeneration: true },
  });

/**
 * The walk is in id order, so "the first task" only stands in front of its sibling if it sorts
 * first. Asserted rather than assumed: without it, every red below could pass for the wrong reason.
 */
function sortsFirst(first: string, second: string): void {
  assert.ok(first < second, 'the first delivery does not sort before its sibling');
}

// (a) ----------------------------------------------------------------------------------------
test('a review the coordinator handled is not filed again when a sibling under the same criterion '
  + 'finishes, and the sibling’s own stray file gets a review of its own',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'handled');
      const [key] = await state(stack, f, ['Handled: the first delivery strays, and so does its sibling']);
      const first = await fileWork(stack, f, key!, 'handled: the first delivery');
      const firstDelivery = await deliver(stack, f, first, key!, 'handled-first', [IN_SCOPE, STRAY]);
      assert.equal(firstDelivery.spent?.review?.reason, 'OUTSIDE_DECLARED_SCOPE',
        'the first delivery was not put to the coordinator at all');
      const [asked] = await reviewsOf(stack, first);
      await handle(stack, f, asked!.id);
      await coordinatorReads(stack, f);

      const second = await fileWork(stack, f, key!, 'handled: its sibling');
      sortsFirst(first, second);
      const secondDelivery = await deliver(
        stack, f, second, key!, 'handled-second', [IN_SCOPE, SIBLING_STRAY],
      );

      // 1 — the handled delivery is not asked about again, as a review or as a blocker.
      assert.deepEqual(
        (await reviewsOf(stack, first)).map((row) => [row.id, row.state, row.resolution]),
        [[asked!.id, 'RESOLVED', 'HANDLED']],
        'the delivery the coordinator already handled was put to it again',
      );
      assert.deepEqual(await blockersOf(stack, f, first), [],
        'the delivery the coordinator already handled was put to the owner instead');

      // 2 — and the sibling's own delivery is read: its stray file is its own review.
      const own = await reviewsOf(stack, second);
      assert.equal(own.length, 1, 'the sibling’s stray file was not put to the coordinator');
      assert.equal(own[0]!.state, 'OPEN');
      assert.equal(own[0]!.reason, 'OUTSIDE_DECLARED_SCOPE');
      assert.deepEqual(own[0]!.paths, [SIBLING_STRAY], 'the sibling’s review is about another file');
      assert.equal(own[0]!.sessionId, secondDelivery.sessionId);
      assert.equal(secondDelivery.spent?.review?.itemId, own[0]!.id,
        'the fact did not report the review it filed');
      assert.equal(secondDelivery.spent?.action, undefined,
        'a criterion with a delivery under review chose a mechanical action');
    } finally {
      await disconnect(stack);
    }
  });

// (b) ----------------------------------------------------------------------------------------
test('a review the landing ended is not filed again when a sibling finishes, and the sibling’s own '
  + 'stray file gets a review of its own',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'landed');
      const [key] = await state(stack, f, ['Landed: the first delivery argues, then lands']);
      const first = await fileWork(stack, f, key!, 'landed: the first delivery', {
        completionCriterionOverrideReason: ARGUMENT,
      });
      const firstDelivery = await deliver(stack, f, first, key!, 'landed-first', [IN_SCOPE]);
      assert.equal(firstDelivery.spent?.review?.reason, 'CRITERION_EXEMPTION_ARGUED',
        'the argued exemption was not put to the coordinator at all');
      const [asked] = await reviewsOf(stack, first);

      // The work lands. The receipt's own post-commit edge is what ends the review.
      await land(stack, f, firstDelivery.sessionId, 'a');
      assert.deepEqual(
        (await reviewsOf(stack, first)).map((row) => [row.id, row.state, row.resolution]),
        [[asked!.id, 'RESOLVED', 'LANDED']],
        'the landing did not end the review it answers',
      );
      await coordinatorReads(stack, f);

      const second = await fileWork(stack, f, key!, 'landed: its sibling');
      sortsFirst(first, second);
      const secondDelivery = await deliver(
        stack, f, second, key!, 'landed-second', [IN_SCOPE, SIBLING_STRAY],
      );

      // 1 — the delivery that already landed is not asked about again. Before 2026-10-15 it was,
      // and the new review was then closed by the same landing within the same request.
      assert.deepEqual(
        (await reviewsOf(stack, first)).map((row) => [row.id, row.state, row.resolution]),
        [[asked!.id, 'RESOLVED', 'LANDED']],
        'the delivery whose work already landed was put to the coordinator again',
      );
      assert.deepEqual(await blockersOf(stack, f, first), [],
        'the delivery whose work already landed was put to the owner instead');

      // 2 — and the sibling's own delivery is read.
      const own = await reviewsOf(stack, second);
      assert.equal(own.length, 1, 'the sibling’s stray file was not put to the coordinator');
      assert.equal(own[0]!.state, 'OPEN');
      assert.equal(own[0]!.reason, 'OUTSIDE_DECLARED_SCOPE');
      assert.deepEqual(own[0]!.paths, [SIBLING_STRAY]);
      assert.equal(secondDelivery.spent?.review?.itemId, own[0]!.id,
        'the fact did not report the review it filed');
    } finally {
      await disconnect(stack);
    }
  });

// (c) ----------------------------------------------------------------------------------------
test('an owner blocker the owner resolved is not raised again when a sibling finishes, and with '
  + 'nothing left to decide the criterion goes on to the coordinator with the merge it is owed',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'ruled');
      const texts = ['Ruled: the standard moved under the first delivery'];
      const [key] = await state(stack, f, texts);
      const first = await fileWork(stack, f, key!, 'ruled: the first delivery');
      await moveTheStandard(stack, f, texts, key!);
      const firstDelivery = await deliver(stack, f, first, key!, 'ruled-first', [IN_SCOPE]);
      assert.equal(firstDelivery.spent?.blockerKind, 'POLICY_MANUAL_HOLD',
        'the moved standard was not put to the owner at all');
      const [raised] = await blockersOf(stack, f, first);
      await stack.projects.resolveBlocker(
        f.ownerId, f.projectId, raised!.id, 'It still passes under today’s wording.',
      );
      await coordinatorReads(stack, f);

      // Filed after the move, so nothing moved under this one: its delivery is ordinary.
      const second = await fileWork(stack, f, key!, 'ruled: its sibling');
      sortsFirst(first, second);
      const secondDelivery = await deliver(stack, f, second, key!, 'ruled-second', [IN_SCOPE]);

      // 1 — the owner's answer stands: no second generation of the same blocker.
      const blockers = await blockersOf(stack, f, first);
      assert.equal(blockers.length, 1, 'the blocker the owner resolved was raised again');
      assert.ok(blockers[0]!.resolvedAt, 'the owner’s resolution was undone');
      assert.equal(blockers[0]!.lifecycleGeneration, 1n, 'the blocker came back as a later generation');
      assert.deepEqual(await reviewsOf(stack, first), [],
        'the delivery the owner ruled on was put to the coordinator instead');

      // 2 — nothing else stops the criterion, so it reaches the coordinator as finished work that is
      // not on main yet, with the action a passed round settles.
      assert.equal(secondDelivery.spent?.blockerKind, undefined, 'the criterion still stopped on a blocker');
      assert.equal(secondDelivery.spent?.review, undefined, 'the criterion still stopped on a review');
      assert.equal(secondDelivery.spent?.outcome, 'DELIVERED',
        'the criterion’s finished work did not reach the coordinator');
      assert.equal(secondDelivery.spent?.action, 'MERGE_AND_RELEASE_NEXT');
    } finally {
      await disconnect(stack);
    }
  });

// (d) ----------------------------------------------------------------------------------------
test('a question still open is not asked twice, and does not hide a later sibling’s own question',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'waiting');
      const [key] = await state(stack, f, ['Waiting: the first review is still open']);
      const first = await fileWork(stack, f, key!, 'waiting: the first delivery');
      await deliver(stack, f, first, key!, 'waiting-first', [IN_SCOPE, STRAY]);
      const [asked] = await reviewsOf(stack, first);
      assert.equal(asked?.state, 'OPEN', 'the first delivery was not put to the coordinator at all');
      await coordinatorReads(stack, f);

      const second = await fileWork(stack, f, key!, 'waiting: its sibling');
      sortsFirst(first, second);
      const secondDelivery = await deliver(
        stack, f, second, key!, 'waiting-second', [IN_SCOPE, SIBLING_STRAY],
      );

      assert.deepEqual(
        (await reviewsOf(stack, first)).map((row) => [row.id, row.state]),
        [[asked!.id, 'OPEN']],
        'the first delivery’s open review was not left as the one question about it',
      );
      const own = await reviewsOf(stack, second);
      assert.equal(own.length, 1, 'the open review in front of it hid the sibling’s stray file');
      assert.deepEqual(own[0]!.paths, [SIBLING_STRAY]);
      assert.equal(secondDelivery.spent?.review?.itemId, own[0]!.id);
      // Both questions are still unanswered, so nothing about this criterion may merge yet.
      assert.equal(secondDelivery.spent?.action, undefined,
        'a criterion with two deliveries under review chose a mechanical action');
    } finally {
      await disconnect(stack);
    }
  });

// (e) ----------------------------------------------------------------------------------------
test('a delivery sent back with task_reopen and delivered again is asked about again — after a '
  + 'handled review, and after a landing, which belonged to the delivery it was sent back from',
  { skip, timeout: 300_000 }, async (t) => {
    const stack = await connect();
    t.after(() => disconnect(stack));

    /**
     * The first delivery strays and is answered the way `answer` says; a sibling is filed; the first
     * is sent back and delivered again, straying once more; the sibling then finishes. The sibling is
     * filed before the send-back because a criterion derives its fact only once all of its work is
     * DONE again — the order task 01a10cd8 took in production on 2026-10-06.
     */
    async function sentBackAfter(label: string, answer: 'HANDLED' | 'LANDED') {
      const f = await fixture(stack, label);
      const [key] = await state(stack, f, [`${label}: the first delivery is sent back`]);
      const first = await fileWork(stack, f, key!, `${label}: the first delivery`);
      const firstDelivery = await deliver(stack, f, first, key!, `${label}-first`, [IN_SCOPE, STRAY]);
      const [asked] = await reviewsOf(stack, first);
      assert.equal(asked?.reason, 'OUTSIDE_DECLARED_SCOPE', `${label}: the first delivery was not reviewed`);
      if (answer === 'HANDLED') {
        await handle(stack, f, asked!.id);
      } else {
        // A merge decides nothing about files outside the declaration, so this review stays open
        // across the landing — and the landing is the delivery's, not the task's for ever.
        await land(stack, f, firstDelivery.sessionId, 'b');
      }
      await coordinatorReads(stack, f);

      const second = await fileWork(stack, f, key!, `${label}: its sibling`);
      sortsFirst(first, second);
      await sendBack(stack, f, first);
      const again = await deliver(stack, f, first, key!, `${label}-again`, [IN_SCOPE, STRAY]);
      assert.equal(again.spent, undefined, `${label}: a criterion with open work derived a fact`);
      assert.equal((await reviewsOf(stack, first)).length, 1,
        `${label}: the second delivery was reviewed before its criterion had a fact`);

      const secondDelivery = await deliver(stack, f, second, key!, `${label}-second`, [IN_SCOPE]);
      return { first, second, asked: asked!, again, secondDelivery };
    }

    await t.test('after the coordinator handled the first delivery’s review', async () => {
      const { first, second, asked, again, secondDelivery } = await sentBackAfter('handled-again', 'HANDLED');
      const reviews = await reviewsOf(stack, first);
      assert.deepEqual(reviews.map((row) => [row.id, row.state, row.resolution]), [
        [asked.id, 'RESOLVED', 'HANDLED'],
        [reviews[1]?.id, 'OPEN', null],
      ], 'the delivery made after the send-back was not read again');
      assert.equal(reviews[1]!.sessionId, again.sessionId, 'the new review is not about the new delivery');
      assert.deepEqual(reviews[1]!.paths, [STRAY]);
      assert.equal(secondDelivery.spent?.review?.itemId, reviews[1]!.id);
      assert.deepEqual(await reviewsOf(stack, second), [], 'the in-scope sibling was reviewed');
    });

    await t.test('after the first delivery’s work landed', async () => {
      const { first, asked, again, secondDelivery } = await sentBackAfter('landed-again', 'LANDED');
      const reviews = await reviewsOf(stack, first);
      // The send-back answered the review the landing left open (`resolveByFact`: RETRIED).
      assert.deepEqual(reviews.map((row) => [row.id, row.state, row.resolution]), [
        [asked.id, 'RESOLVED', 'RETRIED'],
        [reviews[1]?.id, 'OPEN', null],
      ], 'a landing from before the send-back kept the new delivery from being read');
      assert.equal(reviews[1]!.sessionId, again.sessionId, 'the new review is not about the new delivery');
      assert.equal(secondDelivery.spent?.review?.itemId, reviews[1]!.id);
    });
  });
