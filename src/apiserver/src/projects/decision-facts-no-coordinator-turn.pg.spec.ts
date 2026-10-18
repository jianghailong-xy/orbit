/**
 * A QUESTION ONLY THE ACCOUNT OWNER CAN ANSWER WAKES NO COORDINATOR — AND IN AN AUTOMATIC PROJECT,
 * COMPLETION EVIDENCE IS NOT ONE.
 *
 * A completion evidence revision and a held loosening of the acceptance criteria were both treated
 * as questions for the account owner, and until 2026-09-10 both were also said to the conversation
 * this project is coordinated from: the evidence as a turn telling the model to ask through
 * `AskUserQuestion`, the proposal as a turn relaying its diff. Neither turn could answer anything.
 * The owner's card is drawn from the pending read now and its buttons reach the decision door
 * directly, so neither is relayed.
 *
 * That still holds for the held loosening in every project — changing the standard is the owner's
 * alone — and for the evidence of every project whose coordinator switch is off. Since 2026-09-29 an
 * Automatic project's evidence revision is handed to its coordinator, and not to relay: deciding
 * evidence is COORDINATOR_BOUNDED, so the turn asks it to decide, and the owner's card waits
 * (`automatic-evidence-to-coordinator.pg.spec.ts` holds that whole behaviour).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/decision-facts-no-coordinator-turn.pg.spec.ts
 *
 * ONE FIXTURE, FOUR CASES, IN THIS ORDER
 * ======================================
 *   (a) with the coordinator switch OFF, evidence is submitted through the ledger's own door: the
 *       conversation's turns do not move, the fact is still recorded against its consumer, and the
 *       read the card is drawn from — with this conversation as the deciding session — lists the
 *       revision;
 *   (b) with the switch ON, a loosening edit is held through the owner's write path: the turns do
 *       not move, and the proposal read still lists the intent;
 *   (c) a `CRITERION_UNLANDED` fact is delivered to the same conversation by the delivery unit (a)
 *       and (b) were wired with, and the turns move by exactly one;
 *   (d) with the switch ON, the next revision of (a)'s evidence goes through the same door: the
 *       turns move by exactly one, the wake is DELIVERED to this conversation, the turn asks for a
 *       decision rather than a relay, and the card's read holds the revision back.
 *
 * (c) is what makes (a) and (b) mean anything: "no new turn" is also what a conversation nothing
 * could write to would show. So (a) and (b) each start by asserting the conversation is parked —
 * the state a delivery appends to — and (c) proves over that same conversation that a delivery
 * does append. (d) is (a)'s own pair: the same task, the same door, the same conversation, and the
 * switch the only thing turned — so what kept (a) silent is the switch, and not a door that tells
 * nobody whatever the switch says.
 *
 * The order is load-bearing. A message delivered through `deliver` leaves the conversation PENDING,
 * and `deliver` refuses a conversation holding a message nobody has read
 * (`coordinator-delivery.service.ts` §2.1), so a (c) that ran before (a) or (b) would turn a
 * delivery restored in them into a quiet refusal instead of a turn this file can count. (d) goes
 * through `queue`, which queues behind such a message instead of refusing it, so it can run last.
 *
 * WHY THE PROJECT SERVICE AND THE ROUTER ARE BUILT FROM THEIR DECLARED TYPES
 * =========================================================================
 * The held edit used to reach the conversation through an injected `CoordinatorDeliveryService`,
 * and a `ProjectsService` constructed by hand without one could not deliver whatever its code said
 * — so an argument list written here would decide (b) instead of the code under test. The router
 * is the same trap for (a) and (d): what delivers an Automatic project's evidence is its last,
 * optional collaborator, and a router written out by hand without it records every revision
 * whatever the switch says. Both are built the way Nest builds them: each constructor parameter
 * resolved by its declared type, from one set of collaborators that includes the delivery unit (c)
 * uses. A constructor that asks for anything else fails here, naming it.
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
import { CompletionEvidenceProducer } from './completion-evidence.producer';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorEvidenceQueueService } from './coordinator-evidence-queue.service';
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
import { DependentReadyProducer } from './dependent-ready.producer';
import { criterionKeyOf } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectSettledUnmergedProducer } from './project-settled-unmerged.producer';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskDispatchRefusalProducer } from './task-dispatch-refusal.producer';
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
 * A class as Nest builds it: each constructor parameter resolved by its declared type.
 *
 * The header says why this is not a hand-written argument list. A declared type nothing here
 * provides is a failure rather than a skipped argument, so a constructor that grows a collaborator
 * this file has not thought about says so instead of being built without it.
 */
function builtByDeclaredTypes<T>(
  target: new (...args: never[]) => T,
  provided: ReadonlyMap<unknown, unknown>,
): T {
  const declared = Reflect.getMetadata('design:paramtypes', target) as unknown[] | undefined;
  assert.ok(declared, `${target.name} carries no constructor metadata to be resolved by`);
  const args = declared.map((type) => {
    assert.ok(
      provided.has(type),
      `${target.name} asks for ${(type as { name?: string } | undefined)?.name ?? String(type)}, `
      + 'which this spec does not provide',
    );
    return provided.get(type);
  });
  return new target(...(args as never[]));
}

/** The production wiring, over one client. The notification transports are the only stand-ins. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = new CoordinatorWakeService(prisma);
  const convergence = new CoordinatorConvergenceService(prisma);
  const deliveries = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const producer = new CompletionEvidenceProducer(prisma, convergence, deliveries);
  const provided = new Map<unknown, unknown>([
    [PrismaService, prisma],
    [ProjectAcceptanceService, new ProjectAcceptanceService(prisma)],
    [SessionsService, sessions],
    [RealtimeService, realtime],
    [CoordinatorWakeService, wakes],
    [CoordinatorConvergenceService, convergence],
    [CoordinatorDeliveryService, deliveries],
    [ProjectOpenItemService, new ProjectOpenItemService(prisma, sessions)],
    [ProjectTasksSettledProducer,
      new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries)],
    [TaskExceptionInputProducer, new TaskExceptionInputProducer(prisma, convergence)],
    [CriterionReadyProducer, new CriterionReadyProducer(prisma, convergence)],
    [WakeDispositionService, new WakeDispositionService(prisma, judgments, deliveries)],
    [CriterionUnlandedProducer, new CriterionUnlandedProducer(prisma, convergence)],
    [TaskDispatchRefusalProducer, new TaskDispatchRefusalProducer(prisma, convergence, deliveries)],
    [DependentReadyProducer, new DependentReadyProducer(prisma, convergence, deliveries)],
    [ProjectSettledUnmergedProducer,
      new ProjectSettledUnmergedProducer(prisma, convergence, deliveries)],
    [CompletionEvidenceProducer, producer],
    [CoordinatorEvidenceQueueService, new CoordinatorEvidenceQueueService(prisma, producer)],
  ]);
  return {
    db,
    evidence: new TaskCompletionEvidenceService(
      prisma,
      undefined,
      builtByDeclaredTypes(CompletionInputRouter, provided),
    ),
    projects: builtByDeclaredTypes(ProjectsService, provided),
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

/** Turn the project's coordinator switch — the one thing (a) and (d) differ in. */
async function switchCoordinator(db: PrismaClient, f: Fixture, coordinatorEnabled: boolean) {
  await db.project.update({ where: { id: f.projectId }, data: { coordinatorEnabled } });
}

/** One evidence revision of the judged task, through the ledger's own door, from its own run. */
function submitEvidence(stack: Stack, f: Fixture, idempotencyKey: string, claim: string) {
  return stack.evidence.submit(
    f.ownerId,
    f.taskId,
    { type: CreatorType.AGENT, id: f.workspaceId },
    {
      sourceSessionId: f.sourceSessionId,
      idempotencyKey,
      evidence: {
        claim,
        criterion: { key: criterionKeyOf(f.judged.id), text: JUDGED },
        checks: [{ kind: 'TOOL_CALL', ref: CITED, command: 'npm test', succeeded: true }],
        gaps: [],
      },
    },
  );
}

/** The tasks the card in this conversation is drawn for: the pending read, read for it. */
async function cardRows(db: PrismaClient, f: Fixture): Promise<Array<[string, string, boolean, boolean]>> {
  const standing = await db.session.findUniqueOrThrow({
    where: { id: f.coordinatorSessionId },
    select: { id: true, taskId: true },
  });
  const queue = await readPendingEvidenceJudgments(db as unknown as PrismaService, f.ownerId, standing);
  return queue.pending.map((row) => [
    row.taskId, row.evidenceRevision, row.decidability.decidable, row.independence.independent,
  ]);
}

test('no owner-only question writes a coordinator turn; an Automatic project’s evidence and a delivery do', {
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

  // ═══ (a) a completion evidence revision, the switch off ═══════════════════════════════════════
  await t.test('(a) with the switch off, submitted evidence writes no coordinator turn, and its card’s read lists it',
    async () => {
      await switchCoordinator(db, f, false);
      assert.equal(await standingStatus(db, f), RunStatus.AWAITING_INPUT,
        'the conversation is not parked, so "no new turn" would say nothing about the evidence door');
      const before = await turnsOn(db, f);

      const submitted = await submitEvidence(stack, f, 'decision-facts-evidence-1',
        'the declared command ran and its output names dist/server.js');
      assert.equal(submitted.revision, '1');

      assert.equal(await turnsOn(db, f), before,
        'submitting completion evidence wrote a turn on a coordinator whose switch is off');

      // The route's own record is what it always was: the fact reached the ledger and ended against
      // the consumer these rows have always named. So the door was really taken; what it does not
      // do with the switch off is tell anybody.
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
      assert.deepEqual(await cardRows(db, f), [[f.taskId, '1', true, true]],
        'the revision nobody was told about is not on the read its card is drawn from');
    });

  // ═══ (b) a held loosening of the criteria, the switch on ══════════════════════════════════════
  await t.test('(b) with the switch on, a held loosening writes no coordinator turn, and its card’s read still lists it',
    async () => {
      // On, as every project whose standard set its owner confirmed is: the loosening is the owner's
      // question in an Automatic project too.
      await switchCoordinator(db, f, true);
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

  // ═══ (d) (a)'s pair: the next revision, the switch on ═════════════════════════════════════════
  await t.test('(d) with the switch on, the next revision is handed to this conversation to decide, and the card waits',
    async () => {
      // Still on from (b); asserted rather than assumed, because it is the whole difference from (a).
      const { coordinatorEnabled } = await db.project.findUniqueOrThrow({
        where: { id: f.projectId },
        select: { coordinatorEnabled: true },
      });
      assert.equal(coordinatorEnabled, true);
      const before = await turnsOn(db, f);

      const submitted = await submitEvidence(stack, f, 'decision-facts-evidence-2',
        're-ran it: the output still names dist/server.js');
      assert.equal(submitted.revision, '2');

      assert.equal(await turnsOn(db, f), before + 1,
        'an Automatic project’s coordinator was not handed the revision it is to decide');
      assert.deepEqual(
        await db.projectCoordinatorWake.findMany({
          where: { projectId: f.projectId, event: 'COMPLETION_EVIDENCE_REVISED' },
          orderBy: { createdAt: 'asc' },
          select: { status: true, consumerType: true, sessionId: true },
        }),
        [
          { status: 'CONSUMED', consumerType: 'JUDGMENT_REQUEST_DERIVER', sessionId: null },
          { status: 'DELIVERED', consumerType: null, sessionId: f.coordinatorSessionId },
        ],
      );
      const [told] = await db.conversationTurn.findMany({
        where: { sessionId: f.coordinatorSessionId },
        orderBy: { seq: 'desc' },
        take: 1,
        select: { content: true },
      });
      assert.match(told?.content ?? '', /task_evidence_decide/, 'the turn does not ask for a decision');
      assert.doesNotMatch(told?.content ?? '', /AskUserQuestion/, 'the turn relays the question instead');

      // The card waits while the conversation it is drawn in decides: revision 2 is not asked of
      // anybody else, and revision 1 is no longer anybody's question.
      assert.deepEqual(await cardRows(db, f), [],
        'the owner’s card is drawn for a revision the coordinator is deciding');
    });
});

test('the decision-facts PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
