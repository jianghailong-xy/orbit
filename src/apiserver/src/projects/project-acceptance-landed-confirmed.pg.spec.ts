import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
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
import { buildCoordinatorDeliveryMessage } from './coordinator-judgment-opening';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import type { WakeFact } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { classifyCriteriaEdit } from './criteria-edit-classification';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { criteriaFromDefinitions, type StatedAcceptanceCriterion } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone, type DerivedDoneWithheld } from './project-done-derived';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * `PROJECT_ACCEPTANCE_LANDED` on a project whose owner has ALREADY confirmed the standard set.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-acceptance-landed-confirmed.pg.spec.ts
 *
 * THE INCIDENT
 * ============
 * 2026-09-25, project 34JNIW4b31ujSVqEG784v: the owner confirmed the version of the criteria that
 * stood at 04:37:25Z; the last merge receipt onto main was recorded at 13:49:08.041Z; the project
 * was projected DONE at 13:49:08.723Z — and the coordinator conversation was still sent the card
 * that asks it to have the owner "在这个会话里的那张确认卡上确认". There was no such card to press:
 * the clients draw it only while the project is OPEN and its standing can still be answered
 * (`settlementHeldOnConfirmation`), and a confirmed, DONE project is neither. A coordinator that
 * did what the message said would send the owner looking for something that does not exist.
 *
 * WHAT IS UNDER TEST
 * ==================
 * The words the standing conversation is sent, on the production edge that sends them: the last
 * receipt recorded through `MergeReceiptService.record`, whose post-commit knock reaches the
 * settled-project producer, the delivery service and the DONE projection in that order. Nothing
 * here calls the producer for the receipt or the projection by hand, so a green is a statement
 * about what that edge does. The wiring is `project-settled-card.pg.spec.ts`'s; the confirmation
 * and the criteria edit go through the doors `project-done-derived.pg.spec.ts` uses — r3's
 * `confirmStandardSet` and `ProjectsService.update` — because a row written behind them would not
 * be the standing the product reads.
 *
 * THREE STANDINGS, ONE WALK
 * =========================
 * Every case walks the same project shape to the same moment — two criteria, both met, one on
 * main, the last task settled with the other still on a branch — and differs ONLY in what the
 * owner did about the standard set before the last receipt arrived:
 *
 *   (1) confirmed this version                → DONE, and nobody is asked to confirm anything
 *   (2) never confirmed                       → OPEN, and the card asks, exactly as it always has
 *   (3) confirmed, then a criterion was edited → OPEN, the confirmation is STALE, and the card asks
 *
 * (2) and (3) are the controls that keep (1) honest: a message that stopped asking for
 * confirmation altogether would pass (1) and fail both of them. And they hold the words to what
 * they were: the message is compared, whole, with what the card has always rendered for the fact
 * the ledger recorded — a confirmation that is missing or stale changes nothing about it.
 *
 * (4) is the control that keeps (1)'s DONE honest. The fact is derived from the serving tasks'
 * STATUSES, and the projection asks more of them — among other things that each one declared the
 * revision of its criterion that stands. So a criterion tightened after its work was filed, and
 * then confirmed by the owner as it now reads, leaves a confirmed project the projection is still
 * holding back: the message may neither report DONE nor ask for a confirmation that is on record,
 * and says what IS missing instead.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The rungs of the verification ladder the criteria are stated on. (3) steps one criterion up
 *  it, because an edit that walks toward strictness takes effect where it is made — a rewording is
 *  held as a proposal for the owner and moves nothing (`project-done-derived.pg.spec.ts`). */
const METHOD = 'HUMAN';
const STRICTER = 'VERIFICATION';

/** The two conditions every case states. */
const ROUTING = 'main 上的路由行为符合设计';
const SUITE = '全量服务测试通过';

/** The sentence the card asks the coordinator to relay — the one (1) must no longer carry. */
const ASKS_FOR_THE_CARD = /确认卡上确认/;

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
  /** r3's one writer of a confirmation, and the reader of the standing. */
  acceptance: ProjectAcceptanceService;
  producer: ProjectTasksSettledProducer;
  /** The production writer of a merge receipt, holding the production router. */
  receipts: MergeReceiptService;
}

/** `project-settled-card.pg.spec.ts`'s production wiring of the settled-project edge, one client. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = new CoordinatorWakeService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const deliveries = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const producer = new ProjectTasksSettledProducer(
    prisma,
    judgments,
    new CoordinatorConvergenceService(prisma),
    deliveries,
  );
  const router = new CompletionInputRouter(
    wakes,
    producer,
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  const acceptance = new ProjectAcceptanceService(prisma);
  return {
    db,
    producer,
    acceptance,
    projects: new ProjectsService(prisma, acceptance),
    // No router: task writes here deliver nothing, so the receipt is the only edge that does.
    tasks: new TasksService(prisma, sessions, realtime),
    receipts: new MergeReceiptService(prisma, router),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  /** The standing conversation this project is coordinated from, parked between turns. */
  coordinatorSessionId: string;
}

async function fixture(stack: Stack, label: string): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const title = `${label} 验收项目`;
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@landed-confirmed.invalid`,
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
  // The conversation a person opened to drive this project, parked at AWAITING_INPUT with its
  // opening prompt already on it — what the delivery appends to.
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
      title,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId, title, coordinatorSessionId };
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(
  stack: Stack,
  f: Fixture,
  items: ReadonlyArray<{ id?: string; text: string; verificationMethod: string }>,
): Promise<StatedAcceptanceCriterion[]> {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: items,
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems);
}

/** The owner confirms the version standing now, through r3's door. Answers when it was recorded. */
async function confirm(stack: Stack, f: Fixture): Promise<Date> {
  const standing = await stack.acceptance.standardSetConfirmation(f.ownerId, f.projectId);
  const after = await stack.acceptance.confirmStandardSet(f.ownerId, f.projectId, {
    criteriaDigest: standing.currentVersion.digest,
  });
  assert.equal(after.state, 'CONFIRMED', 'the owner’s confirmation did not take');
  return after.confirmation!.confirmedAt;
}

async function standingOf(stack: Stack, f: Fixture): Promise<string> {
  return (await stack.acceptance.standardSetConfirmation(f.ownerId, f.projectId)).state;
}

/** File one EXECUTABLE task against a criterion, through the door that resolves the key. */
async function serve(stack: Stack, f: Fixture, criterionKey: string, title: string) {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    projectId: f.projectId,
    criterionKey,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
    autoRunWhenReady: false,
  } as never);
  return declared.id;
}

/** Settle it the way `runnerApi.turnComplete` does: through 0193/0230's DONE fence. */
async function settle(db: PrismaClient, taskId: string) {
  const written = await db.$executeRaw`
    UPDATE "task" SET "status" = 'DONE'
     WHERE "id" = ${taskId}::uuid
       AND "status" IN ('OPEN', 'IN_PROGRESS')
       AND "completion_criterion" = 'EXECUTABLE'
       AND "acceptance_command" = 'true'
       AND "acceptance_expected_exit_code" = 0`;
  assert.equal(written, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
}

/** The session whose branch a merge is about — a session OF the task, ended, on this workspace. */
async function mergeSession(stack: Stack, f: Fixture, taskId: string, label: string) {
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
      branch: `orbit/${label}`,
    },
  });
  return sessionId;
}

/** A landing that is already on file before the walk reaches the receipt under test. */
async function recordLanding(stack: Stack, f: Fixture, taskId: string, label: string) {
  const sessionId = await mergeSession(stack, f, taskId, label);
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

/** The last landing, through `record` — the method the agent door calls, and nothing else. */
async function recordLandingThroughTheDoor(stack: Stack, f: Fixture, taskId: string, label: string) {
  const sessionId = await mergeSession(stack, f, taskId, label);
  const recorded = await stack.receipts.record(
    f.ownerId,
    sessionId,
    {
      result: 'MERGED',
      sourceBranch: `orbit/${label}`,
      sourceSha: 'd'.repeat(40),
      targetBranch: 'main',
      targetShaBefore: 'e'.repeat(40),
      targetShaAfter: 'f'.repeat(40),
    },
    'AGENT',
  );
  assert.equal(recorded.created, true,
    'the door recorded no new receipt, so nothing below is a statement about one');
  assert.equal(recorded.receipt.landed, true);
}

/**
 * Walk the project to the last receipt, in the order production runs in: work filed against both
 * criteria, the routing work already on main, both settled — so the last task settles with the
 * suite work still on a branch and the settled fact is spent on a judgment session — and then the
 * missing receipt through the door, with no task write anywhere near it.
 *
 * Answers the readings a case needs from either side of that receipt: the projection's withheld
 * clauses just before it, and every message the standing conversation was sent because of it.
 * `afterFiling` runs once the work is filed and before any of it settles — where (4) moves the
 * ruler under a declaration that has already been made.
 */
async function walkToTheLastReceipt(
  stack: Stack,
  f: Fixture,
  [routing, suite]: StatedAcceptanceCriterion[],
  { afterFiling }: { afterFiling?: () => Promise<void> } = {},
) {
  const routingWork = await serve(stack, f, routing!.key, '把路由改对并合进 main');
  const suiteWork = await serve(stack, f, suite!.key, '把全量服务测试跑绿并合进 main');
  await afterFiling?.();
  await recordLanding(stack, f, routingWork, 'routing');
  await settle(stack.db, routingWork);
  await settle(stack.db, suiteWork);

  assert.deepEqual(
    await stack.producer.afterCommit([f.projectId]),
    [{ projectId: f.projectId, outcome: 'OPENED' }],
    'the settled project was carded while one criterion was still off the branch',
  );
  const withheldBefore = await withheld(stack, f);
  const told = await coordinatorMessages(stack.db, f);
  assert.deepEqual(told, [], 'the standing conversation was told something before the receipt');
  assert.equal(await storedStatus(stack.db, f), ProjectStatus.OPEN,
    'the column must not say DONE before the last receipt, or nothing after it is evidence');

  await recordLandingThroughTheDoor(stack, f, suiteWork, 'suite');

  const said = await coordinatorMessages(stack.db, f);
  assert.equal(said.length, 1, 'the last receipt did not put exactly one message on the conversation');
  const wakes = await landedWakes(stack.db, f.projectId);
  assert.equal(wakes.length, 1, 'the last receipt derived no PROJECT_ACCEPTANCE_LANDED fact');
  assert.equal(wakes[0]!.status, 'DELIVERED');
  assert.equal(wakes[0]!.sessionId, f.coordinatorSessionId,
    'the fact was delivered somewhere other than the conversation this project is coordinated from');
  assert.equal(
    said[0]!.clientTurnId, (wakes[0]!.delivery as { clientTurnId?: string } | null)?.clientTurnId,
    'the message on the conversation is not the one the fact was delivered as',
  );
  return { withheldBefore, message: said[0]!.content ?? '', wake: wakes[0]! };
}

/** The stored column, past every service that could compute a nicer answer on the way out. */
async function storedStatus(db: PrismaClient, f: Fixture): Promise<ProjectStatus> {
  return (await db.project.findUniqueOrThrow({
    where: { id: f.projectId },
    select: { status: true },
  })).status;
}

async function withheld(stack: Stack, f: Fixture): Promise<DerivedDoneWithheld[]> {
  return (await readDerivedProjectDone(stack.db as unknown as PrismaService, f.ownerId, f.projectId))
    .withheld;
}

/** Every message the standing conversation has been sent, oldest first, its own opening excluded. */
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

function landedWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'PROJECT_ACCEPTANCE_LANDED' },
    select: {
      event: true,
      subjectType: true,
      subjectId: true,
      subjectVersion: true,
      status: true,
      sessionId: true,
      detail: true,
      delivery: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * What the card has always said about the fact the ledger recorded: the fact rebuilt from its own
 * row, rendered with nothing but the fact and the title.
 */
function theCardAsItWas(
  wake: Awaited<ReturnType<typeof landedWakes>>[number],
  f: Fixture,
): string {
  return buildCoordinatorDeliveryMessage({
    event: wake.event,
    projectId: f.projectId,
    subjectType: wake.subjectType,
    subjectId: wake.subjectId,
    subjectVersion: wake.subjectVersion,
    detail: wake.detail as Record<string, unknown>,
  } as WakeFact, f.title);
}

test('(1) confirmed before the last receipt: the project is DONE and nobody is sent to a card',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'confirmed-first');
      const criteria = await state(stack, f, [
        { text: ROUTING, verificationMethod: METHOD },
        { text: SUITE, verificationMethod: METHOD },
      ]);
      // The incident's order: the owner confirms this version long before the work lands.
      const confirmedAt = await confirm(stack, f);

      const { withheldBefore, message } = await walkToTheLastReceipt(stack, f, criteria);

      // The negative half: before the receipt the one clause outstanding was the landing — the
      // confirmation already named the version that stands.
      assert.deepEqual(withheldBefore, ['CRITERION_UNLANDED']);
      // And the receipt is what settled it, on the same edge that sent the message.
      assert.equal(await storedStatus(stack.db, f), ProjectStatus.DONE,
        'every criterion satisfied and landed, and the owner’s confirmation of this version on '
        + 'record: the last receipt must project DONE');
      assert.equal(await standingOf(stack, f), 'CONFIRMED');

      // ── what the coordinator was told ──────────────────────────────────────────────────────
      assert.doesNotMatch(message, ASKS_FOR_THE_CARD,
        'the project is confirmed and DONE, so no confirmation card can be drawn — and the '
        + 'coordinator was still asked to have the owner confirm on it');
      assert.doesNotMatch(message, /请账号所有者/,
        'the coordinator was asked to take something to the owner of a project that needs nothing');
      assert.ok(message.includes(confirmedAt.toISOString()),
        'the message does not say WHEN the owner confirmed the version that stands');
      assert.match(message, /DONE/);
      assert.match(message, /无需任何动作/);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(2) never confirmed: the card asks the owner to confirm, exactly as it always has',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'never-confirmed');
      const criteria = await state(stack, f, [
        { text: ROUTING, verificationMethod: METHOD },
        { text: SUITE, verificationMethod: METHOD },
      ]);
      assert.equal(await standingOf(stack, f), 'UNCONFIRMED');

      const { withheldBefore, message, wake } = await walkToTheLastReceipt(stack, f, criteria);

      assert.deepEqual(withheldBefore, ['CRITERION_UNLANDED', 'STANDARD_SET_UNCONFIRMED']);
      assert.equal(await storedStatus(stack.db, f), ProjectStatus.OPEN,
        'nobody confirmed what these criteria are for, so the work landing cannot settle it');
      assert.deepEqual(await withheld(stack, f), ['STANDARD_SET_UNCONFIRMED']);

      assert.match(message, ASKS_FOR_THE_CARD,
        'the card no longer asks for the one act this project is waiting on');
      assert.match(message, /请账号所有者在这个会话里的那张确认卡上确认/);
      assert.match(message, /CONFIRM_ACCEPTANCE_CRITERIA/);
      assert.equal(message, theCardAsItWas(wake, f),
        'an unconfirmed project’s card changed: it must read exactly as it always has');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(3) confirmed, then a criterion was edited: the confirmation is stale and the card asks again',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'confirmed-then-edited');
      const [routing, suite] = await state(stack, f, [
        { text: ROUTING, verificationMethod: METHOD },
        { text: SUITE, verificationMethod: METHOD },
      ]);
      await confirm(stack, f);

      // One criterion steps UP the ladder: nothing about it got easier, so the edit takes effect
      // where it is made. Were the repository's rules ever to call it WEAKENING, `update` would
      // hold it and move nothing — so that is asserted here, as itself, rather than surfacing
      // below as a confirmation that never went stale.
      const before = [
        { id: routing!.definitionId, text: ROUTING, verificationMethod: METHOD },
        { id: suite!.definitionId, text: SUITE, verificationMethod: METHOD },
      ];
      const after = [
        { id: routing!.definitionId, text: ROUTING, verificationMethod: STRICTER },
        { id: suite!.definitionId, text: SUITE, verificationMethod: METHOD },
      ];
      assert.equal(classifyCriteriaEdit(before, after), 'ADDITIVE');
      const edited = await state(stack, f, after);
      assert.equal(await standingOf(stack, f), 'STALE',
        'the confirmation on record names a version of the criteria that no longer stands');

      // The work is filed against the criteria as they read now, so the declarations are current
      // and the confirmation is the only thing the projection can hold back.
      const { withheldBefore, message, wake } = await walkToTheLastReceipt(stack, f, edited);

      assert.deepEqual(withheldBefore, ['CRITERION_UNLANDED', 'STANDARD_SET_UNCONFIRMED']);
      assert.equal(await storedStatus(stack.db, f), ProjectStatus.OPEN,
        'a confirmation of an earlier version does not settle the one that stands');
      assert.deepEqual(await withheld(stack, f), ['STANDARD_SET_UNCONFIRMED']);
      assert.equal(await standingOf(stack, f), 'STALE');

      assert.match(message, ASKS_FOR_THE_CARD,
        'the confirmation on record is stale, so the card must still ask for one');
      assert.match(message, /请账号所有者在这个会话里的那张确认卡上确认/);
      assert.equal(message, theCardAsItWas(wake, f),
        'a stale confirmation changed the card: it must read exactly as it always has');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(4) confirmed, but a serving task declared an older revision: not DONE, and the message says why',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'confirmed-declaration-stale');
      const [routing, suite] = await state(stack, f, [
        { text: ROUTING, verificationMethod: METHOD },
        { text: SUITE, verificationMethod: METHOD },
      ]);

      let confirmedAt: Date | undefined;
      const { withheldBefore, message } = await walkToTheLastReceipt(stack, f, [routing!, suite!], {
        // The order that strands a declaration: the work is filed, THEN one criterion steps up the
        // ladder, THEN the owner confirms the set as it now reads. The confirmation is current; the
        // routing work still declares the revision it was filed against.
        afterFiling: async () => {
          const before = [
            { id: routing!.definitionId, text: ROUTING, verificationMethod: METHOD },
            { id: suite!.definitionId, text: SUITE, verificationMethod: METHOD },
          ];
          const after = [
            { id: routing!.definitionId, text: ROUTING, verificationMethod: STRICTER },
            { id: suite!.definitionId, text: SUITE, verificationMethod: METHOD },
          ];
          assert.equal(classifyCriteriaEdit(before, after), 'ADDITIVE');
          await state(stack, f, after);
          confirmedAt = await confirm(stack, f);
        },
      });

      assert.equal(await standingOf(stack, f), 'CONFIRMED',
        'the owner confirmed the version that stands, so nothing here is about the confirmation');
      assert.deepEqual(withheldBefore, ['CRITERION_UNSATISFIED', 'CRITERION_UNLANDED']);
      // The receipt landed the last criterion's work and the projection still holds DONE back:
      // the routing work declared a revision its criterion no longer carries.
      assert.equal(await storedStatus(stack.db, f), ProjectStatus.OPEN,
        'a stale declaration is unmet work, whatever the task’s status says');
      assert.deepEqual(await withheld(stack, f), ['CRITERION_UNSATISFIED']);

      // ── what the coordinator was told ──────────────────────────────────────────────────────
      assert.doesNotMatch(message, /记为 DONE/,
        'the message reports DONE for a project the projection is still holding back');
      assert.doesNotMatch(message, ASKS_FOR_THE_CARD,
        'the version that stands is confirmed, so there is no card — and the message sent the '
        + 'coordinator to one');
      assert.doesNotMatch(message, /请账号所有者/);
      assert.ok(message.includes(confirmedAt!.toISOString()),
        'the message does not say WHEN the owner confirmed the version that stands');
      // What IS missing, in the projection's own words, and where the rest of it is read.
      assert.match(message, /CRITERION_UNSATISFIED/);
      assert.match(message, /DECLARATION_STALE/);
      assert.match(message, /derivedDone/);
      assert.match(message, /unmet/);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the landed-confirmed PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
