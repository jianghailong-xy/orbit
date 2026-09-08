import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { completeHumanTaskForPgTest } from '../tasks/task-completion-test-helper';
import { TasksService } from '../tasks/tasks.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorDeliveryService,
  coordinatorDeliveryTurnId,
} from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { projectTasksSettledFact, wakeIdempotencyKey } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';

/**
 * The confirmation card: every task settled AND every stated criterion satisfied and landed.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/projects/project-settled-card.pg.spec.js
 *
 * WHAT IS UNDER TEST, AND WHAT DELIBERATELY IS NOT
 * ================================================
 * `PROJECT_TASKS_SETTLED` is a live fact with a producer, and `CoordinatorDeliveryService` is the
 * unit that turns a fact into a turn on the conversation a project is already coordinated from.
 * The wiring between them is the subject here: which of the two terminals the settled fact gets,
 * and what the turn it becomes actually says.
 *
 * The producer is called directly, exactly as `project-tasks-settled.pg.spec.ts` calls it. That
 * every committed task write reaches this producer is that spec's and the router specs' subject,
 * and re-proving it here would be measuring the write path rather than the card.
 *
 * WHY "TASKS SETTLED" IS NOT ENOUGH ON ITS OWN
 * ============================================
 * Every task reaching a terminal status says nothing about whether the project's stated conditions
 * are MET, and nothing at all about whether the work behind them is on the default branch — this
 * repository's own project reached "every task settled" with criteria whose landing was UNKNOWN.
 * So the second case below settles every task with one criterion off the branch and asserts that no
 * card is sent, and then, in the same fixture, records the missing receipt and asserts that one is:
 * without that second half, "no card" would be equally true of an implementation that never sends
 * anything at all.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

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
  projects: ProjectsService;
  producer: ProjectTasksSettledProducer;
}

/** The production wiring of unit T7, over one client and with no seam. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = new CoordinatorWakeService(prisma);
  const producer = new ProjectTasksSettledProducer(
    prisma,
    new CoordinatorJudgmentService(prisma, wakes, sessions),
    new CoordinatorConvergenceService(prisma),
    new CoordinatorDeliveryService(prisma, wakes, sessions),
  );
  return {
    db,
    producer,
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
    // No router: this spec drives the producer itself, so nothing settles a task by side effect.
    tasks: new TasksService(prisma, sessions, realtime),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The standing conversation this project is coordinated from, parked between turns. */
  coordinatorSessionId: string;
}

async function fixture(stack: Stack, label: string): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@settled-card.invalid`,
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
  // The conversation a person opened to drive this project, parked between turns at
  // AWAITING_INPUT, with the opening prompt already on it as a turn — so the delivery below appends
  // to a conversation somebody has been talking to rather than seeding one.
  const coordinatorSessionId = randomUUID();
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
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
      content: `协调：${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 验收项目`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]) {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems);
}

/** File one piece of work against a criterion, through the door that resolves the key. */
async function serve(
  stack: Stack,
  f: Fixture,
  criterionKey: string | undefined,
  title: string,
): Promise<string> {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    ...(criterionKey ? { criterionKey } : {}),
    // Settled by hand below: this spec is about which FACT a settled project produces, not about
    // what a completion starts next.
    autoRunWhenReady: false,
  } as never);
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
}

/**
 * Record that this task's branch was merged into `main`.
 *
 * The receipt is the whole input the landing answer is defined over, written the way the production
 * writers of one write it: a session of the task, a `MERGED` result, and a default target branch.
 */
async function recordLanding(stack: Stack, f: Fixture, taskId: string, label: string) {
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: `${label}-merge`,
      prompt: `${label}-merge`,
      provider: 'claude',
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await stack.db.sessionMergeReceipt.create({
    data: {
      ownerId: f.ownerId,
      sessionId,
      taskId,
      projectId: f.projectId,
      result: 'MERGED',
      sourceBranch: `orbit/${label}`,
      sourceSha: 'a'.repeat(40),
      targetBranch: 'main',
      targetShaBefore: 'b'.repeat(40),
      targetShaAfter: 'c'.repeat(40),
      recordedBy: 'AGENT',
      idempotencyKey: `landed:${taskId}`,
    },
  });
}

/**
 * Every message this project's standing conversation has been SENT, oldest first.
 *
 * The seeded opening turn is excluded, exactly as `SessionsService`'s own queued-turn reader
 * excludes it: it is the conversation's own prompt rather than something anybody told it.
 */
function coordinatorMessages(db: PrismaClient, f: Fixture) {
  return db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    select: { clientTurnId: true, content: true },
    orderBy: { seq: 'asc' },
  });
}

/**
 * Every session this owner has, as a set of ids.
 *
 * The baseline for "no conversation was opened". A count of judgment sessions alone would be a
 * bare zero — true of a delivery that never happened and of one that could not happen — so the
 * comparison here is against the set that stood BEFORE the delivery, and the second case below
 * shows the same reader returning one more id when a session really is opened.
 */
async function sessionIds(db: PrismaClient, f: Fixture): Promise<string[]> {
  const rows = await db.session.findMany({
    where: { ownerId: f.ownerId, deletedAt: null },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}

function settledWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'PROJECT_TASKS_SETTLED' },
    select: {
      subjectType: true,
      subjectId: true,
      status: true,
      refusalCode: true,
      consumerType: true,
      sessionId: true,
      detail: true,
    },
    // Never by `id`: the claim supplies a random uuid, so id order says nothing about which
    // derivation came first.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** The turn id the settled fact's message must be written under, derived from the committed rows. */
async function expectedTurnId(db: PrismaClient, projectId: string): Promise<string> {
  const tasks = await db.task.findMany({
    where: { projectId },
    select: { id: true, status: true },
  });
  const fact = projectTasksSettledFact(
    projectId,
    tasks.map((task) => ({ taskId: task.id, status: task.status })),
  );
  assert.ok(fact, 'the fixture has not settled every task');
  return coordinatorDeliveryTurnId(wakeIdempotencyKey(fact));
}

test('every task settled and every criterion landed puts one card on the standing conversation',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'settled-and-landed');
      const [routing, suite] = await state(stack, f, [
        'main 上的路由行为符合设计',
        '全量服务测试通过',
      ]);

      const routingWork = await serve(stack, f, routing!.key, '把路由改对并合进 main');
      const suiteWork = await serve(stack, f, suite!.key, '把全量服务测试跑绿并合进 main');
      await recordLanding(stack, f, routingWork, 'routing');
      await recordLanding(stack, f, suiteWork, 'suite');
      await completeHumanTaskForPgTest(stack.db, f.ownerId, routingWork, 'routing-work');
      await completeHumanTaskForPgTest(stack.db, f.ownerId, suiteWork, 'suite-work');

      const before = await sessionIds(stack.db, f);
      assert.ok(
        before.includes(f.coordinatorSessionId),
        'the baseline reader does not see the conversation this project is coordinated from',
      );
      assert.deepEqual(await coordinatorMessages(stack.db, f), []);

      const turnId = await expectedTurnId(stack.db, f.projectId);
      assert.deepEqual(
        await stack.producer.afterCommit([f.projectId]),
        [{ projectId: f.projectId, outcome: 'DELIVERED' }],
      );

      // ── the fact ended on the conversation the project already has ──────────────────────────
      const wakes = await settledWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.subjectType, 'PROJECT');
      assert.equal(wakes[0]!.subjectId, f.projectId);
      assert.equal(wakes[0]!.status, 'DELIVERED');
      assert.notEqual(wakes[0]!.status, 'SESSION_OPENED');
      assert.equal(wakes[0]!.consumerType, null);
      assert.equal(
        wakes[0]!.sessionId, f.coordinatorSessionId,
        'the wake names a session that is not the one Project.coordinatorSessionId points at',
      );

      // ── one turn, on that conversation, under the key the fact derives ──────────────────────
      const said = await coordinatorMessages(stack.db, f);
      assert.equal(said.length, 1, 'the standing conversation was not sent exactly one card');
      assert.equal(said[0]!.clientTurnId, turnId);

      // ── and no conversation was opened, measured against the baseline above ─────────────────
      assert.deepEqual(
        await sessionIds(stack.db, f), before,
        'the delivery opened a session instead of writing to the one that already existed',
      );

      // ── what the card ASKS ──────────────────────────────────────────────────────────────────
      const card = said[0]!.content ?? '';
      assert.match(card, /CONFIRM_ACCEPTANCE_CRITERIA/,
        'the card does not name the one act this project is now waiting on');
      assert.match(card, /表达的是你.*要的.*目标|表达了你.*要的.*目标/u,
        'the card asks whether the criteria are met rather than whether they express the goal');
      // Every stated criterion is IN the card, with both dimensions and the work that served it:
      // a question about "these two conditions" that does not carry them is a question its reader
      // cannot answer.
      for (const criterion of [routing!, suite!]) {
        assert.ok(card.includes(criterion.text), `the card omits the criterion ${criterion.key}`);
      }
      assert.ok(card.includes('把路由改对并合进 main'), 'the card omits the work serving a criterion');
      assert.ok(card.includes('把全量服务测试跑绿并合进 main'));
      assert.match(card, /LANDED/, 'the card does not report each criterion’s landing');
      assert.match(card, /这是一条通知，不是打断/, 'the card claims to interrupt the reader');
      // The card is not the merge instruction its sibling fact carries.
      assert.equal(card.includes('有干完但还没落 main 的成果'), false);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a criterion that is not landed gets no card, and the same fixture gets one once it is',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'settled-but-unlanded');
      const [landed, offBranch] = await state(stack, f, [
        '这条标准的活已经合进 main',
        '这条标准的活干完了，但还在分支上',
      ]);

      const onMain = await serve(stack, f, landed!.key, '已经合进 main 的那件活');
      const onBranch = await serve(stack, f, offBranch!.key, '还在分支上的那件活');
      await recordLanding(stack, f, onMain, 'on-main');
      await completeHumanTaskForPgTest(stack.db, f.ownerId, onMain, 'on-main-work');
      await completeHumanTaskForPgTest(stack.db, f.ownerId, onBranch, 'on-branch-work');

      const before = await sessionIds(stack.db, f);

      // ── the negative: every task is terminal, one criterion is not on the branch ─────────────
      const refusedCard = await stack.producer.afterCommit([f.projectId]);
      assert.deepEqual(
        await coordinatorMessages(stack.db, f), [],
        'a project whose work is still off the default branch was asked to confirm it',
      );
      assert.deepEqual(refusedCard, [{ projectId: f.projectId, outcome: 'OPENED' }]);

      // And it is not vacuous: the fact travelled the whole way and was SPENT — on the judgment
      // session this event has always opened when the branch evidence is missing. The same
      // baseline reader that stayed still in the case above moves by exactly one here, which is
      // what makes "no card" a statement about this delivery rather than about a dead producer.
      const opened = await sessionIds(stack.db, f);
      assert.equal(opened.length, before.length + 1, 'the unlanded fact was spent on nothing');
      const first = await settledWakes(stack.db, f.projectId);
      assert.equal(first.length, 1);
      assert.equal(first[0]!.status, 'SESSION_OPENED');
      assert.notEqual(first[0]!.status, 'DELIVERED');
      assert.notEqual(
        first[0]!.sessionId, f.coordinatorSessionId,
        'the unlanded fact was delivered to the standing conversation after all',
      );

      // ── the fact is re-derived, WITHOUT the receipt, and there is still no card ──────────────
      // The task set has to move for a second derivation to exist at all: the fact's version is a
      // digest of it, so re-deriving over identical rows is refused as ALREADY_AWAKE by the key
      // alone. That is also why this step comes before the receipt rather than with it — it moves
      // exactly the thing the flip below would otherwise have moved twice, so what is left
      // different between this derivation and that one is the receipt and nothing else. The chore
      // serves no criterion, so the roster is untouched by it.
      const chore = await serve(stack, f, undefined, '与任何标准无关的杂活');
      await stack.tasks.update(f.ownerId, chore, { status: TaskStatus.CANCELLED } as never);
      assert.deepEqual(
        await stack.producer.afterCommit([f.projectId]),
        [{ projectId: f.projectId, outcome: 'OPENED' }],
        'a moved task set alone carded a project whose work is still on a branch',
      );
      assert.deepEqual(await coordinatorMessages(stack.db, f), []);
      assert.equal(
        (await settledWakes(stack.db, f.projectId)).length, 2,
        'the moved task set produced no second fact, so nothing below is about the receipt',
      );

      // ── the positive control: the receipt arrives, and the same fixture gets the card ────────
      await recordLanding(stack, f, onBranch, 'caught-up');
      const secondChore = await serve(stack, f, undefined, '第二件与标准无关的杂活');
      await stack.tasks.update(f.ownerId, secondChore, { status: TaskStatus.CANCELLED } as never);

      // Taken here rather than reusing the count above: recording a receipt writes the merged
      // session it is a receipt FOR, and the derivation just above opened a judgment session, so
      // the baseline for "the card opened nothing" is the world as it stands the moment before
      // the card is sent.
      const beforeCard = await sessionIds(stack.db, f);
      const turnId = await expectedTurnId(stack.db, f.projectId);
      assert.deepEqual(
        await stack.producer.afterCommit([f.projectId]),
        [{ projectId: f.projectId, outcome: 'DELIVERED' }],
      );

      const said = await coordinatorMessages(stack.db, f);
      assert.equal(said.length, 1, 'the receipt did not turn the same fixture into a card');
      assert.equal(said[0]!.clientTurnId, turnId);
      assert.ok((said[0]!.content ?? '').includes(offBranch!.text));

      // Asserted as a set rather than by position: which terminal each row took is what this case
      // is about, and the ledger's own order is not part of the claim. Two derivations without the
      // receipt were judged; the one with it was carded.
      const wakes = await settledWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 3, 'the third derivation did not reach the ledger');
      assert.deepEqual(
        wakes.map((wake) => [wake.status, wake.sessionId === f.coordinatorSessionId]).sort(),
        [['DELIVERED', true], ['SESSION_OPENED', false], ['SESSION_OPENED', false]].sort(),
        'the three derivations of this project did not take the terminals the receipts imply',
      );
      assert.deepEqual(
        await sessionIds(stack.db, f), beforeCard,
        'the card opened a second conversation instead of writing to the standing one',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the same committed fact is not carded twice', { skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    const f = await fixture(stack, 'carded-once');
    const [only] = await state(stack, f, ['唯一的一条标准，活已经合进 main']);
    const work = await serve(stack, f, only!.key, '服务这条标准的唯一一件活');
    await recordLanding(stack, f, work, 'only');
    await completeHumanTaskForPgTest(stack.db, f.ownerId, work, 'only-work');

    const before = await sessionIds(stack.db, f);
    const first = await stack.producer.afterCommit([f.projectId]);
    const second = await stack.producer.afterCommit([f.projectId]);

    assert.deepEqual(first, [{ projectId: f.projectId, outcome: 'DELIVERED' }]);
    assert.deepEqual(
      second, [{ projectId: f.projectId, outcome: 'ALREADY_AWAKE' }],
      'a re-derivation of the same committed fact was delivered a second time',
    );
    assert.equal(
      (await coordinatorMessages(stack.db, f)).length, 1,
      'the standing conversation was told the same thing twice',
    );
    assert.equal((await settledWakes(stack.db, f.projectId)).length, 1);
    assert.deepEqual(await sessionIds(stack.db, f), before);
  } finally {
    await stack.db.$disconnect();
  }
});

test('the settled-card PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
