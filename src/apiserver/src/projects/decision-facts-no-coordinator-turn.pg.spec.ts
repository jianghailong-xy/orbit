/**
 * NEITHER QUESTION ONLY THE ACCOUNT OWNER CAN ANSWER WAKES THE COORDINATOR.
 *
 * A completion evidence revision and a held loosening of the acceptance criteria are both questions
 * for the account owner, and until 2026-09-10 both were also said to the conversation this project
 * is coordinated from: the evidence as a turn telling the model to ask through `AskUserQuestion`,
 * the proposal as a turn relaying its diff. Neither turn could answer anything. The owner's card is
 * drawn from the pending read now and its buttons reach the decision door directly, so neither fact
 * writes a turn.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/decision-facts-no-coordinator-turn.pg.spec.ts
 *
 * ONE FIXTURE, THREE CASES, IN THIS ORDER
 * =======================================
 *   (a) evidence is submitted through the ledger's own door: the conversation's turns do not move,
 *       the fact is still recorded against its consumer, and the read the card is drawn from — with
 *       this conversation as the deciding session — still lists the revision;
 *   (b) a loosening edit is held through the owner's write path: the turns do not move, and the
 *       proposal read still lists the intent;
 *   (c) a `CRITERION_UNLANDED` fact is delivered to the same conversation by the delivery unit (a)
 *       and (b) were wired with, and the turns move by exactly one.
 *
 * (c) is what makes (a) and (b) mean anything: "no new turn" is also what a conversation nothing
 * could write to would show. So (a) and (b) each start by asserting the conversation is parked —
 * the state a delivery appends to — and (c) proves over that same conversation that a delivery
 * does append. It runs LAST on purpose. A delivered message leaves the conversation PENDING, and a
 * delivery onto a message nobody has read is refused (`coordinator-delivery.service.ts` §2.1), so
 * a (c) that ran first would turn a delivery restored in (a) or (b) into a quiet refusal instead of
 * a turn this file can count.
 *
 * WHY THE PROJECT SERVICE IS BUILT FROM ITS DECLARED TYPES
 * ========================================================
 * The held edit used to reach the conversation through an injected `CoordinatorDeliveryService`,
 * and a `ProjectsService` constructed by hand without one could not deliver whatever its code said
 * — so an argument list written here would decide (b) instead of the code under test. It is built
 * the way Nest builds it: each constructor parameter resolved by its declared type, from a set of
 * collaborators that includes the delivery unit (c) uses. A constructor that asked for that unit
 * again would be handed it.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to this fixture.
 */
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
import { readPendingEvidenceJudgments } from '../tasks/pending-evidence-judgments';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criterionUnlandedFact } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { readPendingCriteriaDecisions } from './criteria-pending-decisions';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { criterionKeyOf } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** How both criteria say they are to be judged. Restated byte for byte by the held edit. */
const METHOD = 'A person reads the criterion and says whether it holds';
/** The criterion (a)'s evidence is measured against. */
const JUDGED = 'the submitted evidence names the artifact its command produced';
/** The criterion (b) rewords and (c) reports as finished and off the default branch. */
const LANDED = 'the finished work is on the default branch';
/** The tool call the evidence cites, recorded under the run that submits it. */
const CITED = 'toolu_decision_facts_build';

interface Stack {
  db: PrismaClient;
  /** The evidence ledger, holding a router wired the way the module wires it. */
  evidence: TaskCompletionEvidenceService;
  /** The owner's criteria write path. */
  projects: ProjectsService;
  /** The one delivery unit everything above was wired with, and the one (c) drives. */
  deliveries: CoordinatorDeliveryService;
}

/**
 * `ProjectsService` as Nest builds it: each constructor parameter resolved by its declared type.
 *
 * The header says why this is not a hand-written argument list. A declared type nothing here
 * provides is a failure rather than a skipped argument, so a constructor that grows a collaborator
 * this file has not thought about says so instead of being built without it.
 */
function builtByDeclaredTypes(provided: ReadonlyMap<unknown, unknown>): ProjectsService {
  const declared = Reflect.getMetadata('design:paramtypes', ProjectsService) as unknown[] | undefined;
  assert.ok(declared, 'ProjectsService carries no constructor metadata to be resolved by');
  const args = declared.map((type) => {
    assert.ok(
      provided.has(type),
      `ProjectsService asks for ${(type as { name?: string } | undefined)?.name ?? String(type)}, `
      + 'which this spec does not provide',
    );
    return provided.get(type);
  });
  return new ProjectsService(...(args as ConstructorParameters<typeof ProjectsService>));
}

/** The production wiring, over one client. The notification transports are the only stand-ins. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const deliveries = new CoordinatorDeliveryService(
    prisma,
    new CoordinatorWakeService(prisma),
    sessions,
  );
  const judgments = new CoordinatorJudgmentService(
    prisma,
    new CoordinatorWakeService(prisma),
    sessions,
  );
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      judgments,
      new CoordinatorConvergenceService(prisma),
      deliveries,
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  return {
    db,
    evidence: new TaskCompletionEvidenceService(prisma, undefined, router),
    projects: builtByDeclaredTypes(new Map<unknown, unknown>([
      [PrismaService, prisma],
      [ProjectAcceptanceService, new ProjectAcceptanceService(prisma)],
      [SessionsService, sessions],
      [RealtimeService, realtime],
      [CoordinatorDeliveryService, deliveries],
    ])),
    deliveries,
  };
}

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  /** The standing conversation this project is coordinated from. */
  coordinatorSessionId: string;
  /** The two criteria as the owner's write path stored them. */
  judged: { id: string; revision: number };
  landed: { id: string; revision: number };
  /** The EVIDENCE_JUDGMENT task (a) submits for, and the run that submits it. */
  taskId: string;
  sourceSessionId: string;
}

/**
 * One owner, one runnable workspace, one project with two stated criteria, the conversation the
 * project is coordinated from, and one task waiting on a judgment.
 *
 * The conversation is one a delivery really appends to: parked at AWAITING_INPUT with its opening
 * prompt on it, on a workspace whose runner is heartbeating. The criteria are stated through the
 * owner's own write path, because (b) holds an edit against the seal that path computes.
 */
async function fixture(stack: Stack, label: string): Promise<Fixture> {
  const { db } = stack;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const taskId = randomUUID();
  const sourceSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@decision-facts.invalid`,
      name: 'The account owner',
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
      title: `${label} 的两类决定`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const stated = await stack.projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: [
      { text: JUDGED, verificationMethod: METHOD },
      { text: LANDED, verificationMethod: METHOD },
    ],
  } as never) as unknown as { acceptanceCriteriaHold?: unknown };
  assert.equal(stated.acceptanceCriteriaHold, undefined,
    'stating a project’s first criteria is ADDITIVE and is never held');
  const [judged, landed] = await db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: { id: true, revision: true },
  });
  assert.ok(judged && landed, 'the write path stored fewer criteria than it was given');

  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: `${label} 要交证据的活`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: JUDGED,
      criterionDefinitionId: judged.id,
      criterionRevision: judged.revision,
    },
  });
  await db.session.create({
    data: {
      id: sourceSessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} 执行会话`,
      prompt: `${label} 执行会话`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await db.toolCall.create({
    data: {
      sessionId: sourceSessionId,
      name: 'Bash',
      toolUseId: CITED,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
    },
  });
  return {
    ownerId,
    workspaceId,
    projectId,
    coordinatorSessionId,
    judged,
    landed,
    taskId,
    sourceSessionId,
  };
}

/** Every turn the standing conversation has, its opening prompt included: what (a)–(c) count. */
function turnsOn(db: PrismaClient, f: Fixture): Promise<number> {
  return db.conversationTurn.count({ where: { sessionId: f.coordinatorSessionId } });
}

/** Where the standing conversation is. A delivery appends a turn only to a parked one. */
async function standingStatus(db: PrismaClient, f: Fixture): Promise<RunStatus> {
  return (await db.session.findUniqueOrThrow({
    where: { id: f.coordinatorSessionId },
    select: { status: true },
  })).status;
}

test('neither owner-only question writes a coordinator turn, and a delivery to that conversation does', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const { db } = stack;
  const f = await fixture(stack, 'decision-facts');

  // ═══ (a) a completion evidence revision ═══════════════════════════════════════════════════════
  await t.test('(a) submitted evidence writes no coordinator turn, and its card’s read still lists it',
    async () => {
      assert.equal(await standingStatus(db, f), RunStatus.AWAITING_INPUT,
        'the conversation is not parked, so "no new turn" would say nothing about the evidence door');
      const before = await turnsOn(db, f);

      const submitted = await stack.evidence.submit(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        {
          sourceSessionId: f.sourceSessionId,
          idempotencyKey: 'decision-facts-evidence-1',
          evidence: {
            claim: 'the declared command ran and its output names dist/server.js',
            criterion: { key: criterionKeyOf(f.judged.id), text: JUDGED },
            checks: [{ kind: 'TOOL_CALL', ref: CITED, command: 'npm test', succeeded: true }],
            gaps: [],
          },
        },
      );
      assert.equal(submitted.revision, '1');

      assert.equal(await turnsOn(db, f), before,
        'submitting completion evidence wrote a turn on the coordinator conversation');

      // The route's own record is what it always was: the fact reached the ledger and ended against
      // the consumer these rows have always named. So the door was really taken; what it no longer
      // does is tell anybody.
      assert.deepEqual(
        await db.projectCoordinatorWake.findMany({
          where: { projectId: f.projectId },
          select: { event: true, status: true, consumerType: true, sessionId: true },
        }),
        [{
          event: 'COMPLETION_EVIDENCE_REVISED',
          status: 'CONSUMED',
          consumerType: 'JUDGMENT_REQUEST_DERIVER',
          sessionId: null,
        }],
      );

      // And the question is where the card finds it: this conversation, as the deciding session,
      // is asked about exactly this revision, and may answer it.
      const standing = await db.session.findUniqueOrThrow({
        where: { id: f.coordinatorSessionId },
        select: { id: true, taskId: true },
      });
      const queue = await readPendingEvidenceJudgments(
        db as unknown as PrismaService,
        f.ownerId,
        standing,
      );
      assert.deepEqual(
        queue.pending.map((row) => [
          row.taskId, row.evidenceRevision, row.decidability.decidable, row.independence.independent,
        ]),
        [[f.taskId, '1', true, true]],
        'the revision nobody was told about is not on the read its card is drawn from',
      );
    });

  // ═══ (b) a held loosening of the criteria ═════════════════════════════════════════════════════
  await t.test('(b) a held loosening writes no coordinator turn, and its card’s read still lists it',
    async () => {
      assert.equal(await standingStatus(db, f), RunStatus.AWAITING_INPUT,
        'the conversation is not parked: something above put a message on it');
      const before = await turnsOn(db, f);

      const response = await stack.projects.update(f.ownerId, f.projectId, {
        acceptanceCriteriaItems: [
          { id: f.judged.id, text: JUDGED, verificationMethod: METHOD },
          {
            id: f.landed.id,
            text: `${LANDED}, or on a branch somebody means to merge`,
            verificationMethod: METHOD,
          },
        ],
      } as never) as unknown as { acceptanceCriteriaHold?: { intentId: string } };
      const held = response.acceptanceCriteriaHold;
      assert.ok(held, 'rewording a stated criterion is a loosening and has to be held');

      assert.equal(await turnsOn(db, f), before,
        'holding a loosening edit wrote a turn on the coordinator conversation');
      assert.equal(
        await db.projectCoordinatorWake.count({
          where: { projectId: f.projectId, event: 'CRITERIA_DECISION_PENDING' },
        }),
        0,
        'the held proposal was claimed as a wake, so something still sets out to deliver it',
      );

      const queue = await readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
      assert.deepEqual(
        queue.pending.map((row) => [row.intentId, row.decidability.decidable]),
        [[held.intentId, true]],
        'the held proposal is not on the read its card is drawn from',
      );
    });

  // ═══ (c) the positive control ═════════════════════════════════════════════════════════════════
  await t.test('(c) a CRITERION_UNLANDED delivery to the same conversation writes exactly one turn',
    async () => {
      assert.equal(await standingStatus(db, f), RunStatus.AWAITING_INPUT,
        'the conversation is not parked: something above put a message on it');
      const before = await turnsOn(db, f);

      // Composed here rather than derived from settled work, because what is being paired is the
      // carrier and not the derivation (`tasks/task-coordinator-session-delivery.pg.spec.ts` holds
      // that). The serving task is only a name: the delivery reads the fact's identity, and nothing
      // about the task.
      const fact = criterionUnlandedFact(
        f.projectId,
        criterionKeyOf(f.landed.id),
        [{ taskId: randomUUID(), status: TaskStatus.DONE }],
        'UNKNOWN',
      )!;
      const delivered = await stack.deliveries.deliver(fact, async () => ({ allowed: true as const }));
      assert.equal(delivered.outcome, 'DELIVERED',
        `this conversation could not be delivered to (${JSON.stringify(delivered)}), `
        + 'so (a) and (b) prove nothing');
      assert.equal((delivered as { sessionId?: string }).sessionId, f.coordinatorSessionId);

      assert.equal(await turnsOn(db, f), before + 1,
        'a delivery to this conversation did not write exactly one turn');
    });
});

test('the decision-facts PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
