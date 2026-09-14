import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
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
import { noProgressDedupeKey } from './coordinator-convergence';
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
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * The coordinator's fuse counts what the AGENT spends on its own, and nothing that happened to it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/coordinator-spend-fuse.pg.spec.ts
 *
 * (a) External facts. One project, twenty facts arriving through the router's own doors while the
 *     progress vector cannot move — no findings, no blockers, no edit to what the project asks
 *     for. Each is delivered to the standing conversation or recorded, exactly as the first was.
 *     Before this change the breaker charged every one of them, so the seventh came back REFUSED
 *     with `PROJECT_NOT_CONVERGING` and every fact after it was dropped on the floor.
 *
 * (b) Agent spend. Self-started turns, the sessions the coordinator opens, and the retries one
 *     successor chain has had — each past its limit pauses, each at its limit does not, and each
 *     case carries the rows that look like spend and must not be counted as it.
 *
 * The fuse is read through a view rather than through its declared type, so this file compiles
 * against the tree that predates it and the red there is an assertion, not a compile error.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const FACTS = 20;
const DAY_AND_AN_HOUR_MS = 25 * 60 * 60_000;

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

/** The fuse's answer, as far as this spec reads it. */
interface SpendAssessmentView {
  paused: boolean;
  reason: string | null;
  observed: number | null;
  limit: number | null;
  spend: { selfStartedTurns: number; sessionsOpened: number; successorRetries: number };
  limits: {
    maxSelfStartedTurnsPerDay: number | null;
    maxSessionsOpenedPerDay: number | null;
    maxRetriesPerSuccessorChain: number | null;
  };
}

async function assessSpend(
  convergence: CoordinatorConvergenceService,
  projectId: string,
  asOf?: Date,
): Promise<SpendAssessmentView> {
  const read = (convergence as unknown as {
    assessSpend?: (projectId: string, asOf?: Date) => Promise<SpendAssessmentView>;
  }).assessSpend;
  assert.equal(
    typeof read, 'function',
    'CoordinatorConvergenceService has no assessSpend: nothing decides whether agent spend pauses the coordinator',
  );
  return read!.call(convergence, projectId, asOf);
}

interface Stack {
  db: PrismaClient;
  router: CompletionInputRouter;
  convergence: CoordinatorConvergenceService;
}

/** The production wiring of the router and every producer, over one client. */
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
  return { db, router, convergence };
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
 * really appends a turn.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@spend-fuse.invalid`, name: label, passwordHash: 'x' },
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
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
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
      goal: 'finish the work without the coordinator being stopped by the facts it is told',
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

/** One more finished task serving the criterion: a new serving set, so a new fact about it. */
async function finishServingWork(db: PrismaClient, f: Fixture, n: number): Promise<void> {
  await db.task.create({
    data: {
      id: randomUUID(),
      ownerId: f.ownerId,
      projectId: f.projectId,
      title: `serving work ${n}`,
      creatorType: CreatorType.USER,
      creatorId: f.ownerId,
      assigneeId: f.workspaceId,
      status: TaskStatus.DONE,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      criterionDefinitionId: f.criterion.id,
      criterionRevision: f.criterion.revision,
      autoRunWhenReady: false,
    },
  });
}

/**
 * A task whose attempt ended badly, with the attempt that ran it. It serves no criterion, so its
 * fact is recorded rather than judged (`wake-disposition.ts` §3).
 */
async function failWork(db: PrismaClient, f: Fixture, n: number): Promise<string> {
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId: f.ownerId,
      projectId: f.projectId,
      title: `work that failed ${n}`,
      creatorType: CreatorType.USER,
      creatorId: f.ownerId,
      assigneeId: f.workspaceId,
      status: TaskStatus.FAILED,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      autoRunWhenReady: false,
    },
  });
  await openSession(db, f, { taskId, status: RunStatus.FAILED, startsTaskWork: true });
  return taskId;
}

async function openSession(
  db: PrismaClient,
  f: Fixture,
  options: { taskId?: string; status?: RunStatus; startsTaskWork?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId: options.taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: `session ${id}`,
      prompt: `session ${id}`,
      provider: 'claude',
      status: options.status ?? RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: options.startsTaskWork ?? false,
    },
  });
  return id;
}

/** `count` turn_end events on a session, filed under `turnId` — null is a turn nobody delivered. */
async function turnEnds(
  db: PrismaClient,
  sessionId: string,
  firstSeq: number,
  count: number,
  turnId: string | null,
): Promise<number> {
  await db.runEvent.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      sessionId,
      seq: firstSeq + i,
      type: 'turn_end',
      payload: { subtype: 'success' },
      turnId,
    })),
  });
  return firstSeq + count;
}

/**
 * The coordinator reads the message it was delivered, the way a runner reports it: the turn is
 * answered, its `turn_end` is filed under that turn, and the conversation parks again.
 */
async function coordinatorReads(db: PrismaClient, f: Fixture, seq: number): Promise<number> {
  const unread = await db.conversationTurn.findMany({
    where: { sessionId: f.coordinatorSessionId, status: { not: 'ANSWERED' } },
    select: { id: true },
  });
  assert.equal(unread.length, 1, 'a delivery put exactly one message on the standing conversation');
  const now = new Date();
  await db.conversationTurn.update({
    where: { id: unread[0]!.id },
    data: { status: 'ANSWERED', deliveredAt: now, answeredAt: now },
  });
  const next = await turnEnds(db, f.coordinatorSessionId, seq, 1, unread[0]!.id);
  await db.session.update({
    where: { id: f.coordinatorSessionId },
    data: { status: RunStatus.AWAITING_INPUT },
  });
  return next;
}

/** What each kind of external fact ends as when nothing refuses it. */
const ARRIVES_AS = {
  CRITERION_READY: 'CONSUMED',
  CRITERION_UNLANDED: 'DELIVERED',
  ATTEMPT_ENDED_UNSETTLED: 'CONSUMED',
} as const;
const KINDS = Object.keys(ARRIVES_AS) as Array<keyof typeof ARRIVES_AS>;

test('(a) twenty external facts with the progress vector unchanged are all delivered or recorded, and the project is not paused',
  { skip, timeout: 300_000 }, async () => {
    const { db, router, convergence } = await connect();
    try {
      const f = await fixture(db, 'external-facts');
      let seq = 1;
      for (let n = 1; n <= FACTS; n += 1) {
        const kind = KINDS[(n - 1) % KINDS.length]!;
        let routed: Array<{ outcome: string; refusalCode?: string }>;
        if (kind === 'CRITERION_READY') {
          await finishServingWork(db, f, n);
          routed = await router.routeReadyCriteria([f.projectId]);
        } else if (kind === 'CRITERION_UNLANDED') {
          routed = await router.routeUnlandedCriteria([f.projectId]);
        } else {
          routed = await router.routeTaskExceptions([await failWork(db, f, n)]);
        }
        assert.equal(routed.length, 1, `fact ${n} (${kind}) was not derived exactly once`);
        const { outcome, refusalCode } = routed[0]!;
        assert.equal(
          outcome, ARRIVES_AS[kind],
          `fact ${n} of ${FACTS} (${kind}) came back ${outcome}`
            + (refusalCode ? ` with ${refusalCode}` : '')
            + ' — an external fact must be delivered or recorded however many arrived before it',
        );
        if (outcome === 'DELIVERED') seq = await coordinatorReads(db, f, seq);
      }

      const wakes = await db.projectCoordinatorWake.findMany({
        where: { projectId: f.projectId },
        select: { status: true, refusalCode: true },
      });
      assert.equal(wakes.length, FACTS);
      assert.deepEqual(wakes.filter((wake) => wake.status === 'REFUSED'), []);

      // The premise, stated as a measurement rather than assumed: every judgment the audit ledger
      // kept saw the same vector, charged nothing for it, and stopped nothing.
      const decisions = await db.projectConvergenceDecision.findMany({
        where: { projectId: f.projectId },
        orderBy: { seq: 'asc' },
      });
      assert.equal(decisions.length, FACTS, 'every fact still leaves its audit row');
      assert.equal(new Set(decisions.map((row) => row.progressVectorDigest)).size, 1);
      assert.deepEqual([...new Set(decisions.map((row) => row.outcome))], ['PROCEED']);
      assert.deepEqual(
        decisions.map((row) => (row.counters as { decisionsWithoutProgress: number }).decisionsWithoutProgress),
        Array.from({ length: FACTS }, () => 0),
        'an external fact charged the budget',
      );
      assert.deepEqual(
        await db.projectBlocker.findMany({
          where: { projectId: f.projectId, dedupeKey: noProgressDedupeKey(f.projectId) },
        }),
        [],
      );

      // One message per merge owed, and the turns that answered them do not count as anything the
      // coordinator started on its own.
      const owed = Array.from({ length: FACTS }, (_, i) => KINDS[i % KINDS.length])
        .filter((kind) => kind === 'CRITERION_UNLANDED').length;
      const told = await db.conversationTurn.count({
        where: { sessionId: f.coordinatorSessionId, seq: { gt: 1 } },
      });
      assert.equal(told, owed);
      const fuse = await assessSpend(convergence, f.projectId);
      assert.deepEqual(fuse.spend, { selfStartedTurns: 0, sessionsOpened: 0, successorRetries: 0 });
      assert.equal(fuse.paused, false);
      assert.equal(fuse.reason, null);
    } finally {
      await db.$disconnect();
    }
  });

/**
 * Now on the clock that stamps `run_event.ingested_at`, as a Date no earlier than any row stamped so far.
 * The column keeps microseconds and a Date keeps milliseconds, so `new Date()` taken in the millisecond a
 * turn was ingested truncates to before that turn — and the fuse, rightly, does not count a turn ingested
 * after the instant it is asked about.
 */
async function afterIngestion(db: PrismaClient): Promise<Date> {
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`
    SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS "now"`;
  return now;
}

test('(b) self-started turns past the limit pause the coordinator; delivered turns, other sessions and old turns do not count',
  { skip, timeout: 240_000 }, async () => {
    const { db, convergence } = await connect();
    try {
      const f = await fixture(db, 'self-started-turns');
      const limit = (await assessSpend(convergence, f.projectId)).limits.maxSelfStartedTurnsPerDay!;
      assert.ok(Number.isInteger(limit) && limit > 0, `no finite limit on self-started turns: ${limit}`);

      // What must not count, written first and generously past the limit.
      const delivered = await db.conversationTurn.create({
        data: {
          sessionId: f.coordinatorSessionId,
          seq: 2,
          clientTurnId: randomUUID(),
          kind: 'message',
          content: 'the owner asks how it is going',
          status: 'ANSWERED',
        },
      });
      let seq = await turnEnds(db, f.coordinatorSessionId, 1, limit + 5, delivered.id);
      await db.runEvent.createMany({
        data: Array.from({ length: limit + 5 }, (_, i) => ({
          sessionId: f.coordinatorSessionId,
          seq: seq + i,
          type: 'tool_use',
          payload: { id: `toolu_${i}`, name: 'Bash' },
          turnId: null,
        })),
      });
      seq += limit + 5;
      await turnEnds(db, await openSession(db, f), 1, limit + 5, null);

      seq = await turnEnds(db, f.coordinatorSessionId, seq, limit, null);
      const atLimit = await assessSpend(convergence, f.projectId, await afterIngestion(db));
      assert.equal(atLimit.spend.selfStartedTurns, limit);
      assert.equal(atLimit.paused, false, 'reaching the limit is not exceeding it');

      const nextDay = await assessSpend(
        convergence, f.projectId, new Date(Date.now() + DAY_AND_AN_HOUR_MS),
      );
      assert.equal(nextDay.spend.selfStartedTurns, 0, 'turns from more than a day ago were counted');

      await turnEnds(db, f.coordinatorSessionId, seq, 1, null);
      const over = await assessSpend(convergence, f.projectId, await afterIngestion(db));
      assert.equal(over.paused, true);
      assert.equal(over.reason, 'SELF_STARTED_TURNS');
      assert.equal(over.observed, limit + 1);
      assert.equal(over.limit, limit);
      assert.deepEqual(over.spend, { selfStartedTurns: limit + 1, sessionsOpened: 0, successorRetries: 0 });
    } finally {
      await db.$disconnect();
    }
  });

test('(b) sessions opened past the limit pause the coordinator; refused, unfinished, read-only and foreign calls do not count',
  { skip, timeout: 240_000 }, async () => {
    const { db, convergence } = await connect();
    try {
      const f = await fixture(db, 'sessions-opened');
      const limit = (await assessSpend(convergence, f.projectId)).limits.maxSessionsOpenedPerDay!;
      assert.ok(Number.isInteger(limit) && limit > 0, `no finite limit on opened sessions: ${limit}`);
      const now = new Date();
      const call = (sessionId: string, name: string, extra: { isError?: boolean; finishedAt?: Date | null } = {}) => ({
        sessionId,
        name,
        toolUseId: randomUUID(),
        input: {},
        isError: extra.isError ?? false,
        startedAt: now,
        finishedAt: extra.finishedAt === undefined ? now : extra.finishedAt,
      });

      const other = await openSession(db, f);
      await db.toolCall.createMany({
        data: [
          ...Array.from({ length: limit + 1 }, () => call(f.coordinatorSessionId, 'mcp__orbit__task_start', { isError: true })),
          ...Array.from({ length: limit + 1 }, () => call(f.coordinatorSessionId, 'mcp__orbit__task_start', { finishedAt: null })),
          ...Array.from({ length: limit + 1 }, () => call(f.coordinatorSessionId, 'mcp__orbit__task_get')),
          ...Array.from({ length: limit + 1 }, () => call(f.coordinatorSessionId, 'mcp__elsewhere__task_start')),
          ...Array.from({ length: limit + 1 }, () => call(other, 'mcp__orbit__session_create')),
        ],
      });

      // Both spellings a runner files these under: Claude's MCP prefix and Codex's.
      await db.toolCall.createMany({
        data: Array.from({ length: limit }, (_, i) => call(
          f.coordinatorSessionId,
          i % 2 === 0 ? 'mcp__orbit__task_start' : 'orbit__session_create',
        )),
      });
      const atLimit = await assessSpend(convergence, f.projectId);
      assert.equal(atLimit.spend.sessionsOpened, limit);
      assert.equal(atLimit.paused, false, 'reaching the limit is not exceeding it');

      const nextDay = await assessSpend(
        convergence, f.projectId, new Date(now.getTime() + DAY_AND_AN_HOUR_MS),
      );
      assert.equal(nextDay.spend.sessionsOpened, 0, 'sessions opened more than a day ago were counted');

      await db.toolCall.create({ data: call(f.coordinatorSessionId, 'orbit__task_start') });
      const over = await assessSpend(convergence, f.projectId);
      assert.equal(over.paused, true);
      assert.equal(over.reason, 'SESSIONS_OPENED');
      assert.equal(over.observed, limit + 1);
      assert.equal(over.limit, limit);
      assert.deepEqual(over.spend, { selfStartedTurns: 0, sessionsOpened: limit + 1, successorRetries: 0 });
    } finally {
      await db.$disconnect();
    }
  });

/** One attempt in a chain. `supersededBy` makes it a FAILED attempt that was replaced. */
async function attempt(
  db: PrismaClient,
  f: Fixture,
  filedBy: CreatorType,
  supersededBy?: { taskId: string; at: Date },
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      ownerId: f.ownerId,
      projectId: f.projectId,
      title: `attempt ${id}`,
      creatorType: filedBy,
      creatorId: filedBy === CreatorType.AGENT ? f.workspaceId : f.ownerId,
      assigneeId: f.workspaceId,
      status: supersededBy ? TaskStatus.FAILED : TaskStatus.OPEN,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      autoRunWhenReady: false,
      ...(supersededBy
        ? { supersededByTaskId: supersededBy.taskId, supersededAt: supersededBy.at, terminalReason: 'SUPERSEDED' as never }
        : {}),
    },
  });
  return id;
}

/**
 * A chain of `retries` replacements, built from its live end backwards so every successor exists
 * before the attempt it replaces names it. The first attempt is the person's; every replacement is
 * filed by `filedBy`. Returns the live attempt at the end.
 */
async function chain(
  db: PrismaClient,
  f: Fixture,
  retries: number,
  filedBy: CreatorType,
  at: Date,
): Promise<string> {
  const live = await attempt(db, f, filedBy);
  let successor = live;
  for (let i = 0; i < retries; i += 1) {
    const first = i === retries - 1;
    successor = await attempt(db, f, first ? CreatorType.USER : filedBy, { taskId: successor, at });
  }
  return live;
}

test('(b) a successor chain retried past the limit pauses the coordinator; retries a person filed, and chains that stopped, do not count',
  { skip, timeout: 240_000 }, async () => {
    const { db, convergence } = await connect();
    try {
      const f = await fixture(db, 'retry-chain');
      const limit = (await assessSpend(convergence, f.projectId)).limits.maxRetriesPerSuccessorChain!;
      assert.ok(Number.isInteger(limit) && limit > 0, `no finite limit on chain retries: ${limit}`);
      const now = new Date();

      await chain(db, f, limit + 2, CreatorType.USER, now);
      await chain(db, f, limit + 2, CreatorType.AGENT, new Date(now.getTime() - DAY_AND_AN_HOUR_MS));
      const live = await chain(db, f, limit, CreatorType.AGENT, now);

      const atLimit = await assessSpend(convergence, f.projectId);
      assert.equal(atLimit.spend.successorRetries, limit);
      assert.equal(atLimit.paused, false, 'reaching the limit is not exceeding it');

      // The agent retries the live attempt once more.
      const retry = await attempt(db, f, CreatorType.AGENT);
      await db.task.update({
        where: { id: live },
        data: {
          status: TaskStatus.FAILED,
          supersededByTaskId: retry,
          supersededAt: new Date(),
          terminalReason: 'SUPERSEDED' as never,
        },
      });
      const over = await assessSpend(convergence, f.projectId);
      assert.equal(over.paused, true);
      assert.equal(over.reason, 'SUCCESSOR_RETRIES');
      assert.equal(over.observed, limit + 1);
      assert.equal(over.limit, limit);
      assert.deepEqual(over.spend, { selfStartedTurns: 0, sessionsOpened: 0, successorRetries: limit + 1 });

      // The limit is the project's: raising it on this project is what lets the same chain go on.
      await db.project.update({
        where: { id: f.projectId },
        data: { convergenceThresholds: { maxRetriesPerSuccessorChain: limit + 1 } },
      });
      const raised = await assessSpend(convergence, f.projectId);
      assert.equal(raised.limits.maxRetriesPerSuccessorChain, limit + 1);
      assert.equal(raised.paused, false);
    } finally {
      await db.$disconnect();
    }
  });

test('the spend-fuse PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
