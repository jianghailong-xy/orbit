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
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * A paused fuse is a card the account owner can act on, and resuming puts back everything the pause
 * held (`docs/project-integration-line-contract.md` §6.3–§6.5).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/coordinator-fuse-recovery.pg.spec.ts
 *
 * The four things the project's second acceptance criterion asks for, one test each:
 *
 *  1. THE CARD. Crossing the limit opens one OWNER item of kind FUSE_PAUSED, readable through the
 *     open-items door with the reason it paused, what was spent today and the way back — and
 *     carrying the one thing the platform CANNOT do, because a card that promised to hold the
 *     engine's own turns would be promising a recovery path that does not exist (F8).
 *  2. EXTERNAL FACTS ARE UNTOUCHED. A criterion finishing and a merge coming owed still reach the
 *     standing conversation while the project is paused: what a pause holds is what the agent
 *     STARTS, never what happens to it (F6).
 *  3. RESUMING PUTS BOTH BACK. An action the coordinator initiated is held rather than performed,
 *     and a fact that would have opened a judgment session is refused with the key released and
 *     NOTHING recorded against it — the old breaker's defect, where a refusal committed under a
 *     scope answered the same fact the same way for ever. The owner's resume replays the first and
 *     re-derives the second; a session that is not the owner cannot resume at all.
 *  4. A SECOND PAUSE IS A SECOND CARD. Resuming does not zero the window (F11), so the next
 *     crossing fact opens a new episode and a new item rather than finding the old row and writing
 *     nothing.
 *
 * The fuse is reached through a view rather than through its declared type, and its module by a
 * specifier this file does not let the compiler resolve, so this spec COMPILES against the tree
 * that predates it: the red there is the assertion "nothing pauses the project", which is the
 * finding, and not a compile error, which would be an accident of ordering.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Where the durable half of the fuse lives once it exists. Not a literal: see the header. */
const FUSE_SERVICE_MODULE = './project-fuse.service.js';

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

/** The committed row whose arrival made the fuse read itself (§6.2 `crossing_fact`). */
interface CrossingFact {
  table: 'run_event' | 'tool_call' | 'task';
  id: string;
}

/** One action the pause held, as the resume reports what became of it. */
interface ReplayedAction {
  heldActionId: string;
  kind: string;
  state: 'REPLAYED' | 'DROPPED';
}

/** One fact refused during the pause, as the resume reports re-deriving it. */
interface RejudgedFact {
  event: string;
  subjectId: string;
  outcome: string;
}

interface ResumeResult {
  episodeId: string;
  replayed: ReplayedAction[];
  rejudged: RejudgedFact[];
}

/** The durable half of the fuse, as far as this spec reads it. */
interface FuseView {
  /** F-T1: read the spend on a committed crossing fact, and pause if it is over. */
  evaluate(projectId: string, crossing: CrossingFact): Promise<string | null>;
  /** F-T2: hold what a paused project's coordinator tried to start. */
  holdIfPaused(
    actingSessionId: string,
    kind: string,
    request: unknown,
  ): Promise<{ code: string; heldActionId: string } | null>;
  /** F-T4/F-T5: the owner's door, and the edge that replays and re-derives. */
  resume(
    ownerId: string,
    projectId: string,
    episodeId: string,
    options?: { raiseLimits?: Record<string, number>; actingSessionId?: string },
  ): Promise<ResumeResult>;
}

type FuseConstructor = new (
  prisma: PrismaService,
  convergence: CoordinatorConvergenceService,
  sessions: SessionsService,
  router: CompletionInputRouter,
) => FuseView;

async function loadFuse(): Promise<FuseConstructor> {
  const loaded = await import(FUSE_SERVICE_MODULE).catch(() => null);
  const ctor = (loaded as { ProjectFuseService?: FuseConstructor } | null)?.ProjectFuseService;
  assert.equal(
    typeof ctor, 'function',
    'there is no ProjectFuseService: nothing turns a crossed fuse into an owner card, holds what the '
      + 'coordinator starts while it is paused, or puts either back',
  );
  return ctor!;
}

/** What the spend fuse read. Borrowed from the reading spec for the limits alone. */
interface SpendView {
  paused: boolean;
  spend: { selfStartedTurns: number; sessionsOpened: number; successorRetries: number };
  limits: { maxSelfStartedTurnsPerDay: number | null };
}

async function assessSpend(
  convergence: CoordinatorConvergenceService,
  projectId: string,
): Promise<SpendView> {
  const read = (convergence as unknown as {
    assessSpend?: (projectId: string) => Promise<SpendView>;
  }).assessSpend;
  assert.equal(typeof read, 'function', 'CoordinatorConvergenceService has no assessSpend');
  return read!.call(convergence, projectId);
}

interface Stack {
  db: PrismaClient;
  router: CompletionInputRouter;
  convergence: CoordinatorConvergenceService;
  openItems: ProjectOpenItemService;
  fuse: FuseView;
}

/** The production wiring of the router, every producer, the items door and the fuse, over one client. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = new CoordinatorWakeService(prisma);
  const convergence = new CoordinatorConvergenceService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const deliveries = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  const Fuse = await loadFuse();
  return {
    db,
    router,
    convergence,
    openItems: new ProjectOpenItemService(prisma, sessions),
    fuse: new Fuse(prisma, convergence, sessions, router),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The standing conversation the project is coordinated from, parked between turns. */
  coordinatorSessionId: string;
  criterion: { id: string; revision: number };
}

/**
 * One owner, one runnable workspace, one project stating one criterion, and the conversation it is
 * coordinated from — parked at AWAITING_INPUT with its opening prompt answered, so a delivery to it
 * really appends a turn and a spawn from it really opens a session.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@fuse-recovery.invalid`, name: label, passwordHash: 'x' },
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
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      enableOrchestration: true,
    },
  });
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
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
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
      title: `${label} 的保险丝`,
      goal: 'finish the work, and tell the owner when the coordinator has spent what it may spend',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
      acceptanceCriterionDefinitions: {
        create: [{
          ordinal: 1,
          text: 'the finished work is on main',
          verificationMethod: 'A person checks that the finished work is on main',
          // The normalize trigger recomputes it; Prisma needs a value for the required column.
          contentHash: '0'.repeat(64),
        }],
      },
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const criterion = await db.projectAcceptanceCriterionDefinition.findFirstOrThrow({
    where: { projectId },
    select: { id: true, revision: true },
  });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, criterion };
}

/**
 * `count` turns the engine started by itself: a `turn_end` under no `conversation_turn` at all
 * (§6.1 F1). Returns the crossing fact the last of them is.
 */
async function selfStartedTurns(
  db: PrismaClient,
  f: Fixture,
  firstSeq: number,
  count: number,
): Promise<CrossingFact> {
  await db.runEvent.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      sessionId: f.coordinatorSessionId,
      seq: firstSeq + i,
      type: 'turn_end',
      payload: { subtype: 'success' },
      turnId: null,
    })),
  });
  const last = await db.runEvent.findFirstOrThrow({
    where: { sessionId: f.coordinatorSessionId, seq: firstSeq + count - 1 },
    select: { id: true },
  });
  return { table: 'run_event', id: last.id };
}

/** Spend the project past its self-started-turn limit, and hand the fuse the row that did it. */
async function crossTheLimit(
  db: PrismaClient,
  convergence: CoordinatorConvergenceService,
  f: Fixture,
  firstSeq: number,
): Promise<{ crossing: CrossingFact; limit: number; nextSeq: number }> {
  const limit = (await assessSpend(convergence, f.projectId)).limits.maxSelfStartedTurnsPerDay!;
  assert.ok(Number.isInteger(limit) && limit > 0, `no finite limit on self-started turns: ${limit}`);
  const crossing = await selfStartedTurns(db, f, firstSeq, limit + 1);
  const over = await assessSpend(convergence, f.projectId);
  assert.equal(over.paused, true, 'the premise: this much self-started spend is over the limit');
  return { crossing, limit, nextSeq: firstSeq + limit + 1 };
}

/** One more finished task serving the criterion: a new serving set, so a new fact about it. */
async function finishServingWork(db: PrismaClient, f: Fixture, n: number): Promise<string> {
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId: f.ownerId,
      projectId: f.projectId,
      title: `serving work ${n}`,
      creatorType: 'USER',
      creatorId: f.ownerId,
      assigneeId: f.workspaceId,
      status: TaskStatus.DONE,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      criterionDefinitionId: f.criterion.id,
      criterionRevision: f.criterion.revision,
      autoRunWhenReady: false,
    },
  });
  return taskId;
}

/**
 * The only work serving the criterion, failed: nothing is going to deliver that criterion, which is
 * the one coverage `wake-disposition.ts` answers with a judgment session (`STRANDED` → OPEN_JUDGMENT).
 * That is the fact a pause refuses, and the fact a resume has to be able to ask again.
 */
async function strandWork(db: PrismaClient, f: Fixture): Promise<string> {
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId: f.ownerId,
      projectId: f.projectId,
      title: 'the only work serving the criterion',
      creatorType: 'USER',
      creatorId: f.ownerId,
      assigneeId: f.workspaceId,
      status: TaskStatus.FAILED,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      criterionDefinitionId: f.criterion.id,
      criterionRevision: f.criterion.revision,
      autoRunWhenReady: false,
    },
  });
  await db.session.create({
    data: {
      id: randomUUID(),
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: 'the attempt that failed',
      prompt: 'the attempt that failed',
      provider: 'claude',
      status: RunStatus.FAILED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  return taskId;
}

/** The project's FUSE_PAUSED cards, newest last, whatever state they ended in. */
function pauseCards(db: PrismaClient, projectId: string) {
  return db.projectOpenItem.findMany({
    where: { projectId, kind: 'FUSE_PAUSED' },
    orderBy: { waitingSince: 'asc' },
    select: {
      id: true, state: true, assignee: true, resolution: true,
      fuseEpisodeId: true, dedupeKey: true, escalateAt: true,
    },
  });
}

test('the pause card is readable with the reason, the spend and the way back',
  { skip, timeout: 300_000 }, async () => {
    const { db, convergence, openItems, fuse } = await connect();
    try {
      const f = await fixture(db, 'pause-card');
      const { crossing, limit } = await crossTheLimit(db, convergence, f, 1);

      const episodeId = await fuse.evaluate(f.projectId, crossing);
      assert.ok(episodeId, 'spend over the limit did not pause the project');

      const items = await openItems.list(f.ownerId, f.projectId);
      assert.deepEqual(items.withCoordinator, [], 'a pause is nobody’s to handle but the owner’s');
      assert.equal(items.needsYou.length, 1, 'the pause opened no card the owner can read');
      const card = items.needsYou[0]!;
      assert.equal(card.kind, 'FUSE_PAUSED');
      assert.equal(card.assignee, 'OWNER');
      assert.equal(card.title, 'The coordinator paused itself');
      assert.equal(card.fuseEpisodeId, episodeId, 'the card does not name the pause it is about');
      assert.equal(card.escalateAt, null, 'there is nobody to escalate an owner’s card to');
      assert.deepEqual(
        card.delivery, { state: 'NOT_REQUIRED', sessionId: null, at: null },
        'an owner’s card is not queued on a conversation',
      );

      // Why it paused, and the two numbers that say so.
      assert.match(
        card.detailLine, /on its own/,
        `the card does not say WHICH spend crossed: ${card.detailLine}`,
      );
      assert.match(
        card.detailLine, new RegExp(`\\b${limit + 1}\\b`),
        `the card does not say what was observed: ${card.detailLine}`,
      );
      assert.match(
        card.detailLine, new RegExp(`\\b${limit}\\b`),
        `the card does not say what the limit is: ${card.detailLine}`,
      );
      // What was spent today — all three kinds, so the owner reads the whole budget and not the
      // one line that happened to cross.
      assert.match(
        card.detailLine, /Spent today: .*self-started turns.*sessions opened.*retries/,
        `the card does not say what was spent today: ${card.detailLine}`,
      );
      // The way back, and the one thing resuming does NOT buy: a pause cannot hold the turns the
      // engine starts by itself, so a card that implied it could would be offering a recovery path
      // the platform does not have (§6.4 F8).
      assert.ok(
        (card.actions as readonly string[]).includes('RESUME'),
        `the card offers no way back: ${JSON.stringify(card.actions)}`,
      );
      assert.match(
        card.detailLine, /counted, not held/,
        `the card does not say the engine’s own turns are not held: ${card.detailLine}`,
      );

      // One pause at a time: a second crossing fact while this one is open changes nothing.
      const again = await fuse.evaluate(f.projectId, crossing);
      assert.equal(again, episodeId, 'a second reading opened a second pause');
      assert.equal((await pauseCards(db, f.projectId)).length, 1);
    } finally {
      await db.$disconnect();
    }
  });

test('an external fact is delivered while the project is paused', { skip, timeout: 300_000 }, async () => {
  const { db, router, convergence, openItems, fuse } = await connect();
  try {
    const f = await fixture(db, 'external-during-pause');
    const { crossing } = await crossTheLimit(db, convergence, f, 1);
    assert.ok(await fuse.evaluate(f.projectId, crossing), 'the project did not pause');

    // A criterion whose last serving task finished: recorded, and the pause does not touch it.
    await finishServingWork(db, f, 1);
    const ready = await router.routeReadyCriteria([f.projectId]);
    assert.equal(ready.length, 1);
    assert.equal(
      ready[0]!.outcome, 'CONSUMED',
      `a finished criterion was ${ready[0]!.outcome} ${ready[0]!.refusalCode ?? ''} during the pause`,
    );

    // And the merge that finished work owes: delivered to the standing conversation, because what a
    // pause holds is what the agent starts, not what the project tells it (§6.4 F6).
    const unlanded = await router.routeUnlandedCriteria([f.projectId]);
    assert.equal(unlanded.length, 1);
    assert.equal(
      unlanded[0]!.outcome, 'DELIVERED',
      `an owed merge was ${unlanded[0]!.outcome} ${unlanded[0]!.refusalCode ?? ''} during the pause`,
    );
    assert.equal(
      await db.conversationTurn.count({ where: { sessionId: f.coordinatorSessionId, seq: { gt: 1 } } }),
      1,
      'the fact was reported delivered and no turn reached the conversation',
    );

    const refused = await db.projectCoordinatorWake.findMany({
      where: { projectId: f.projectId, status: 'REFUSED' },
      select: { event: true, refusalCode: true },
    });
    assert.deepEqual(refused, [], 'a pause refused an external fact');
    // And the pause is still the owner's one open card: an external fact neither resolves it nor
    // opens another.
    assert.equal((await openItems.list(f.ownerId, f.projectId)).needsYou.length, 1);
  } finally {
    await db.$disconnect();
  }
});

test('resuming replays what the pause held and re-derives the fact it refused',
  { skip, timeout: 300_000 }, async () => {
    const { db, router, convergence, openItems, fuse } = await connect();
    try {
      const f = await fixture(db, 'resume');
      const { crossing } = await crossTheLimit(db, convergence, f, 1);
      const episodeId = await fuse.evaluate(f.projectId, crossing);
      assert.ok(episodeId, 'the project did not pause');
      const decisionsAtPause = await db.projectConvergenceDecision.count({
        where: { projectId: f.projectId },
      });

      // (a) What the coordinator tried to start is held, not performed.
      const heldPrompt = 'look into the failure';
      const spawned = () => db.session.count({ where: { ownerId: f.ownerId, prompt: heldPrompt } });
      const held = await fuse.holdIfPaused(f.coordinatorSessionId, 'SESSION_CREATE', {
        dto: { prompt: heldPrompt, workspaceId: f.workspaceId },
      });
      assert.ok(held, 'the coordinator’s own action was performed while the project was paused');
      assert.equal(held.code, 'PROJECT_FUSE_PAUSED');
      assert.equal(await spawned(), 0, 'the action was held and the session was opened anyway');

      // (b) A fact that would open a judgment session is refused — and nothing is recorded against
      // it, which is the whole difference from the breaker this replaces: a judgment committed
      // under the project's scope answered the same fact the same way for ever.
      const stranded = await strandWork(db, f);
      const exceptions = await router.routeTaskExceptions([stranded]);
      assert.equal(exceptions.length, 1);
      assert.equal(exceptions[0]!.outcome, 'REFUSED', 'a paused project opened a judgment session');
      assert.equal(exceptions[0]!.refusalCode, 'PROJECT_FUSE_PAUSED');
      assert.equal(
        await db.projectConvergenceDecision.count({ where: { projectId: f.projectId } }),
        decisionsAtPause,
        'the refusal recorded a judgment, which is what answers the same fact the same way for ever',
      );
      const key = await db.projectCoordinatorWake.findFirstOrThrow({
        where: { projectId: f.projectId, status: 'REFUSED', refusalCode: 'PROJECT_FUSE_PAUSED' },
        select: { idempotencyKey: true },
      });

      // Only the account owner resumes. A session holding the owner's credential is not the owner.
      await assert.rejects(
        () => fuse.resume(f.ownerId, f.projectId, episodeId, {
          actingSessionId: f.coordinatorSessionId,
        }),
        (error: { status?: number; response?: { code?: string } }) => {
          assert.equal(error.status, 403, 'a session was allowed to resume the fuse that holds it');
          assert.equal(error.response?.code, 'FUSE_RESUME_OWNER_ONLY');
          return true;
        },
      );

      const resumed = await fuse.resume(f.ownerId, f.projectId, episodeId);
      assert.equal(resumed.episodeId, episodeId);

      // The held action went out, through the door it was held at.
      assert.deepEqual(
        resumed.replayed.map((action) => [action.kind, action.state]), [['SESSION_CREATE', 'REPLAYED']],
        'the held action was not replayed',
      );
      assert.equal(await spawned(), 1, 'the replay opened no session');

      // The refused fact was asked again, from the same committed rows, and this time it is judged.
      assert.deepEqual(
        resumed.rejudged.map((fact) => [fact.event, fact.subjectId, fact.outcome]),
        [['ATTEMPT_ENDED_UNSETTLED', stranded, 'OPENED']],
        'the fact refused during the pause was not re-derived after it',
      );
      const asked = await db.projectCoordinatorWake.findMany({
        where: { projectId: f.projectId, idempotencyKey: key.idempotencyKey },
        select: { status: true },
      });
      assert.deepEqual(
        asked.map((wake) => wake.status).sort(), ['REFUSED', 'SESSION_OPENED'],
        'the same fact key could not be claimed again after the pause released it',
      );

      // And the card is closed, by the fact that closed it.
      assert.deepEqual((await openItems.list(f.ownerId, f.projectId)).needsYou, []);
      assert.deepEqual(
        (await pauseCards(db, f.projectId)).map((card) => [card.state, card.resolution]),
        [['RESOLVED', 'RESUMED']],
      );
    } finally {
      await db.$disconnect();
    }
  });

test('crossing the limit again after a resume opens a second card, not the old row',
  { skip, timeout: 300_000 }, async () => {
    const { db, convergence, openItems, fuse } = await connect();
    try {
      const f = await fixture(db, 'second-pause');
      const { crossing, nextSeq } = await crossTheLimit(db, convergence, f, 1);
      const first = await fuse.evaluate(f.projectId, crossing);
      assert.ok(first, 'the project did not pause');
      await fuse.resume(f.ownerId, f.projectId, first);

      // Resuming does not zero the window (§6.5 F11): the same day's spend is still over, so the
      // next crossing fact pauses again.
      const crossedAgain = await selfStartedTurns(db, f, nextSeq, 1);
      const second = await fuse.evaluate(f.projectId, crossedAgain);
      assert.ok(second, 'the project never paused a second time');
      assert.notEqual(second, first, 'the second pause reused the first episode');

      const cards = await pauseCards(db, f.projectId);
      assert.equal(cards.length, 2, 'the second pause wrote no card of its own');
      assert.deepEqual(
        cards.map((card) => [card.state, card.resolution, card.fuseEpisodeId]),
        [['RESOLVED', 'RESUMED', first], ['OPEN', null, second]],
        'a second pause must open a new card, not find the old row and write nothing',
      );
      assert.equal(
        new Set(cards.map((card) => card.dedupeKey)).size, 2,
        'both cards share one key, so the second could only ever have been a no-op',
      );
      const open = await openItems.list(f.ownerId, f.projectId);
      assert.equal(open.needsYou.length, 1);
      assert.equal(open.needsYou[0]!.fuseEpisodeId, second);
    } finally {
      await db.$disconnect();
    }
  });

test('the fuse-recovery PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
