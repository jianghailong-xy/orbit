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

import { uuidToBase62 } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  countPendingEvidenceJudgments,
  readPendingEvidenceJudgments,
} from '../tasks/pending-evidence-judgments';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import {
  COMPLETION_EVIDENCE_WAKE_COORDINATOR_DISABLED,
  CompletionEvidenceProducer,
} from './completion-evidence.producer';
import { completionEvidenceRevisedFact, completionEvidenceWakeKey } from './completion-input';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
  DELIVERY_NO_COORDINATOR_SESSION,
  CoordinatorDeliveryService,
  coordinatorDeliveryTurnId,
} from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { DependentReadyProducer } from './dependent-ready.producer';
import { readOwnerDecisionSignals } from './owner-decision-signal';
import { criterionKeyOf } from './project-acceptance';
import { PROJECT_FUSE_PAUSED } from './project-fuse';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskDispatchRefusalProducer } from './task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * AN AUTOMATIC PROJECT'S COORDINATOR DECIDES THE EVIDENCE; THE OWNER'S CARD IS THE FALLBACK.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/automatic-evidence-to-coordinator.pg.spec.ts
 *
 * WHAT CHANGED
 * ============
 * From 2026-09-10 a submitted evidence revision was recorded and told to nobody, and the account
 * owner's card was drawn straight from `readPendingEvidenceJudgments`, on the premise that only the
 * owner could answer it. In Automatic projects that had the owner pressing 96 of 100 evidence cards
 * between 09-14 and 09-29, although deciding evidence is COORDINATOR_BOUNDED. Now a project whose
 * coordinator switch is on has the revision queued on its standing conversation to DECIDE, and the
 * owner's read and the "Needs you" count leave the revision out while the coordinator holds it:
 * delivered, the project still Automatic, the conversation not ended, and less than the project's
 * `exceptionEscalationSeconds` since the delivery.
 *
 * WHAT EACH CASE HOLDS
 * ====================
 *    (1) Automatic, a live coordinator: one queued turn, the wake DELIVERED under the revision's
 *        own key, a message asking for a decision rather than a relay — and neither the owner's
 *        read nor either count holds the revision. A replayed submission says nothing twice.
 *    (2) The escalation clock: the owner is asked from `exceptionEscalationSeconds` after the
 *        delivery and not a second earlier — by a later read, with the setting lowered, and through
 *        the production reads once the delivery is that old.
 *    (3) Not Automatic: recorded as before, nobody told, the owner asked — and the same fixture,
 *        switched on, delivers the next revision.
 *    (4) The switch is the producer's own authorizer too: a claim made after it went off is refused
 *        on it and nothing is written to anybody.
 *    (5) A paused fuse: refused, the owner asked; after the resume the same revision is delivered.
 *    (6) An ended coordinator conversation is neither written to nor revived; the owner is asked.
 *    (7) No coordinator conversation at all: the owner is asked.
 *    (8) The coordinator's CONFIRM settles the task, and nobody is asked any more, then or later.
 *    (9) The hold ends the moment the coordinator cannot act: switched off, or its conversation
 *        over.
 *   (10) A revision the coordinator could not decide is only recorded, and is the owner's at once.
 *
 * Every "the owner is asked" is paired with a "the owner is not asked" over the same read, so a
 * read that filters nothing and a read that filters everything both fail.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The criterion every task here is measured against, quoted verbatim by every envelope. */
const STANDARD = 'the declared command exits zero and its output names the artifact';

/** The default `exceptionEscalationSeconds` (migration 0278), which every fixture starts on. */
const ESCALATION_SECONDS = 7200;

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
  prisma: PrismaService;
  /** The evidence ledger holding the router with every door, the way the module wires it. */
  evidence: TaskCompletionEvidenceService;
  /** The same ledger with no router: writes a revision and routes it nowhere. */
  unrouted: TaskCompletionEvidenceService;
  producer: CompletionEvidenceProducer;
  deliveries: CoordinatorDeliveryService;
}

/** The production wiring, over one client. The notification transports are the only stand-ins. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = new CoordinatorWakeService(prisma);
  const convergence = new CoordinatorConvergenceService(prisma);
  const deliveries = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const producer = new CompletionEvidenceProducer(prisma, convergence, deliveries);
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, convergence),
    new TaskDispatchRefusalProducer(prisma, convergence, deliveries),
    new DependentReadyProducer(prisma, convergence, deliveries),
    // The eighth door is about settled projects' integration lines; nothing here settles one.
    undefined,
    producer,
  );
  return {
    db,
    prisma,
    evidence: new TaskCompletionEvidenceService(prisma, undefined, router),
    unrouted: new TaskCompletionEvidenceService(prisma),
    producer,
    deliveries,
  };
}

/** What the project's coordinator conversation is: parked and live, ended, or absent. */
type Coordinator = 'PARKED' | 'ENDED' | 'NONE';

interface Ids {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

interface JudgedTask {
  taskId: string;
  title: string;
  /** The run doing the work — the one that submits its evidence. */
  runSessionId: string;
  /** The tool call its evidence cites. */
  cited: string;
}

interface World extends Ids, JudgedTask {
  projectId: string;
  coordinatorSessionId: string | null;
  /** A conversation of the same owner that took part in nothing: who reads when there is no
   *  coordinator. */
  readerSessionId: string;
  criterionKey: string;
}

/** One conversation with its opening prompt as a turn, so nothing below is what seeds it. */
async function conversation(
  db: PrismaClient,
  ids: Ids,
  title: string,
  options: { status?: RunStatus; ended?: boolean; taskId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: ids.ownerId,
      creatorId: ids.ownerId,
      workspaceId: ids.workspaceId,
      assignedRunnerId: ids.runnerId,
      taskId: options.taskId,
      startsTaskWork: options.taskId !== undefined,
      title,
      prompt: title,
      provider: 'claude',
      status: options.status ?? RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      ...(options.taskId === undefined ? { titleManagedByProject: true } : {}),
      ...(options.ended ? { completedAt: new Date() } : {}),
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: id,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(id),
      kind: 'message',
      content: title,
      status: 'ANSWERED',
    },
  });
  return id;
}

/** An EVIDENCE_JUDGMENT task filed under the project, the run working it, and a check to cite. */
async function judgedTask(
  db: PrismaClient,
  ids: Ids & { projectId: string },
  label: string,
): Promise<JudgedTask> {
  const taskId = randomUUID();
  const title = `${label} 要交证据的活`;
  await db.task.create({
    data: {
      id: taskId,
      ownerId: ids.ownerId,
      projectId: ids.projectId,
      title,
      creatorType: CreatorType.USER,
      creatorId: ids.ownerId,
      assigneeId: ids.workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: STANDARD,
    },
  });
  const runSessionId = await conversation(db, ids, `${label} 执行会话`, { taskId });
  const cited = `toolu_${label}_${taskId.slice(0, 8)}`;
  await db.toolCall.create({
    data: {
      sessionId: runSessionId,
      name: 'Bash',
      toolUseId: cited,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
    },
  });
  return { taskId, title, runSessionId, cited };
}

/**
 * One owner with an online runner and a workspace, one project stating one criterion, the
 * conversation it is coordinated from (or none), an unrelated reader, and one task to judge.
 */
async function world(
  stack: Stack,
  label: string,
  options: { coordinator?: Coordinator; coordinatorEnabled?: boolean } = {},
): Promise<World> {
  const db = stack.db;
  const ids: Ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `${label}-${ids.ownerId}@automatic-evidence.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: `${label}-ws`,
      enabled: true,
    },
  });
  const readerSessionId = await conversation(db, ids, `${label} 另一条会话`);
  const shape = options.coordinator ?? 'PARKED';
  const coordinatorSessionId = shape === 'NONE'
    ? null
    : await conversation(db, ids, `协调：${label}`, shape === 'ENDED'
      ? { status: RunStatus.SUCCEEDED, ended: true }
      : {});

  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId: ids.ownerId,
      title: `${label} 由协调者判证据`,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: ids.workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  // A real definition row, because the decision door resolves the quote against one: a revision
  // whose quote resolved to nothing would be undecidable, which is case (10) and not the rest.
  const definitionId = randomUUID();
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: definitionId,
      projectId,
      ordinal: 1,
      text: STANDARD,
      verificationMethod: 'EVIDENCE_JUDGMENT：读那条命令的退出码和输出',
      contentHash: '0'.repeat(64),
    },
  });
  const judged = await judgedTask(db, { ...ids, projectId }, label);
  return {
    ...ids,
    ...judged,
    projectId,
    coordinatorSessionId,
    readerSessionId,
    criterionKey: criterionKeyOf(definitionId),
  };
}

interface Submission {
  /** Another task of the same project; the world's own when absent. */
  task?: JudgedTask;
  key?: string;
  claim?: string;
  /** The criterion text the envelope quotes; the live one when absent. */
  quote?: string;
  service?: TaskCompletionEvidenceService;
}

/** Submit one revision of the four-field envelope, quoting `quote`, through `service`. */
function submit(stack: Stack, w: World, options: Submission = {}) {
  const task = options.task ?? w;
  return (options.service ?? stack.evidence).submit(
    w.ownerId,
    task.taskId,
    { type: CreatorType.AGENT, id: w.workspaceId },
    {
      sourceSessionId: task.runSessionId,
      idempotencyKey: options.key ?? `evidence-${task.taskId}-1`,
      evidence: {
        claim: options.claim ?? 'the declared command ran and its output names dist/server.js',
        criterion: { key: w.criterionKey, text: options.quote ?? STANDARD },
        checks: [{ kind: 'TOOL_CALL', ref: task.cited, command: 'npm test', succeeded: true }],
        gaps: ['did not run the suite on a second machine'],
      },
    },
  );
}

/** The wake ledger's rows for one task's evidence revisions, oldest first. */
function evidenceWakes(db: PrismaClient, taskId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { event: 'COMPLETION_EVIDENCE_REVISED', subjectType: 'TASK', subjectId: taskId },
    select: {
      id: true,
      idempotencyKey: true,
      status: true,
      refusalCode: true,
      consumerType: true,
      sessionId: true,
      delivery: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** Everything put on a conversation after its opening prompt, oldest first. */
function messagesOn(db: PrismaClient, sessionId: string | null) {
  const id = sessionId ?? '00000000-0000-0000-0000-000000000000';
  return db.conversationTurn.findMany({
    where: { sessionId: id, clientTurnId: { not: SessionsService.initialTurnClientId(id) } },
    select: { clientTurnId: true, content: true, sendIntent: true },
    orderBy: { seq: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/**
 * The tasks the owner's evidence card is drawn for: `readPendingEvidenceJudgments` read for the
 * project's coordinator conversation — where the card is drawn — or, in a project that has none,
 * for an unrelated conversation of the same owner.
 */
async function ownerAsked(stack: Stack, w: World, readAt?: Date): Promise<string[]> {
  const queue = await readPendingEvidenceJudgments(
    stack.prisma,
    w.ownerId,
    { id: w.coordinatorSessionId ?? w.readerSessionId, taskId: null },
    readAt,
  );
  return queue.pending.map((row) => row.taskId);
}

/** The "Needs you" evidence count keyed on this project's coordinator conversation. */
async function ownerCount(stack: Stack, w: World, readAt?: Date): Promise<number> {
  assert.ok(w.coordinatorSessionId, 'the count is keyed on a coordinator conversation');
  const counts = await countPendingEvidenceJudgments(
    stack.prisma,
    w.ownerId,
    [{ projectId: w.projectId, session: { id: w.coordinatorSessionId, taskId: null } }],
    readAt,
  );
  return counts.get(w.projectId) ?? 0;
}

/**
 * What the session list's badge counts on the coordinator's row, through the production read. It
 * also counts the standard set nobody has confirmed here, so the cases compare it with itself.
 */
async function badge(stack: Stack, w: World): Promise<number> {
  const signals = await readOwnerDecisionSignals(stack.prisma, w.ownerId);
  return signals
    .filter((signal) => (
      signal.sessionId === w.coordinatorSessionId && signal.kind === 'PROJECT_DECISION'
    ))
    .reduce((sum, signal) => sum + signal.count, 0);
}

const convergenceDecisions = (db: PrismaClient, projectId: string) =>
  db.projectConvergenceDecision.count({ where: { projectId } });

/** Change the project's switch or clock, the two columns these cases turn. */
const setProject = (
  stack: Stack,
  w: World,
  data: { coordinatorEnabled?: boolean; exceptionEscalationSeconds?: number },
) => stack.db.project.update({ where: { id: w.projectId }, data });

/** The card's read as the app makes it (`GET /tasks/evidence-decisions/pending`), at "now". */
async function cardNow(stack: Stack, w: World): Promise<string[]> {
  const queue = await stack.evidence.pending(w.ownerId, w.coordinatorSessionId!);
  return queue.pending.map((row) => row.taskId);
}

// -------------------------------------------------------------------------------------------------

test('(1) an Automatic project hands the revision to its coordinator to decide, and does not ask the owner',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'held');
      const badgeBefore = await badge(stack, w);
      assert.deepEqual(await messagesOn(stack.db, w.coordinatorSessionId), []);

      const receipt = await submit(stack, w);
      assert.equal(receipt.revision, '1');

      // The ledger: one wake, DELIVERED to the standing conversation, under the key the owner's
      // read looks it up by.
      const wakes = await evidenceWakes(stack.db, w.taskId);
      assert.equal(wakes.length, 1, 'the revision reached the wake ledger other than once');
      const [row] = wakes;
      assert.equal(row!.status, 'DELIVERED', `refused with ${row!.refusalCode}`);
      assert.equal(row!.sessionId, w.coordinatorSessionId);
      assert.equal(row!.consumerType, null, 'a delivered revision was also consumed as a record');
      assert.equal(
        row!.idempotencyKey,
        completionEvidenceWakeKey(w.taskId, {
          revision: receipt.revision,
          criterionRevision: receipt.criterionRevision,
          evidenceDigest: receipt.evidenceDigest,
        }),
        'the owner\'s read would look this delivery up under a key it was not claimed under',
      );

      // The conversation: exactly one queued turn, and it is that delivery.
      const said = await messagesOn(stack.db, w.coordinatorSessionId);
      assert.equal(said.length, 1, 'the coordinator was told other than once');
      const [message] = said;
      assert.equal(message!.clientTurnId, coordinatorDeliveryTurnId(row!.idempotencyKey));
      assert.deepEqual(row!.delivery, { clientTurnId: message!.clientTurnId });
      assert.equal(message!.sendIntent, 'NEXT_TURN');

      // What it says: the task by title and id, the revision, the criterion's own words, the two
      // calls and the two answers, the clock, and where a question for the owner goes.
      const content = message!.content ?? '';
      assert.match(content, /held 要交证据的活/);
      assert.match(content, new RegExp(uuidToBase62(w.taskId)));
      assert.match(content, /第 1 版/);
      assert.match(content, /evidenceRevision 传 "1"/);
      assert.ok(content.includes(`「${STANDARD}」`), 'the quoted criterion is not in it');
      assert.ok(content.includes(w.criterionKey), 'the criterion is not named by its key');
      for (const word of [
        'task_evidence_list', 'task_evidence_decide', 'CONFIRM', 'SEND_BACK', 'note',
        'exceptionEscalationSeconds', `${ESCALATION_SECONDS} 秒`, 'ask_owner',
      ]) {
        assert.ok(content.includes(word), `the message does not say ${word}`);
      }
      // A decision, not the relay 2026-09-10 removed.
      assert.doesNotMatch(content, /AskUserQuestion/);

      // The owner is not asked while the coordinator holds it: neither the card's read, nor the
      // count, nor the badge the session list draws.
      assert.deepEqual(await ownerAsked(stack, w), [],
        'the owner is asked about a revision the coordinator holds');
      assert.equal(await ownerCount(stack, w), 0);
      assert.equal(await badge(stack, w), badgeBefore,
        'the badge lit for a revision the coordinator holds');
      // ...and the hold is only that: the reader it hides the row from is not disqualified, and a
      // row of the same shape it did not deliver would be listed (cases (3) and (10)).
      const read = await readPendingEvidenceJudgments(stack.prisma, w.ownerId, {
        id: w.coordinatorSessionId!, taskId: null,
      });
      assert.deepEqual(read.waitingOnYou, []);

      // Nothing was settled or opened by telling it.
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: w.taskId } })).status,
        TaskStatus.IN_PROGRESS,
      );
      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);

      // A replayed submission routes the same fact again, and it says nothing twice.
      await submit(stack, w);
      assert.equal((await evidenceWakes(stack.db, w.taskId)).length, 1);
      assert.equal((await messagesOn(stack.db, w.coordinatorSessionId)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(2) once exceptionEscalationSeconds have passed since the delivery, the owner is asked',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'escalated');
      const badgeBefore = await badge(stack, w);
      await submit(stack, w);
      const [row] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(row!.status, 'DELIVERED', `refused with ${row!.refusalCode}`);
      const deliveredAt = row!.updatedAt.getTime();

      // By the read's own clock: held until the second before the escalation, asked from it on.
      const window = ESCALATION_SECONDS * 1_000;
      const justBefore = new Date(deliveredAt + window - 1_000);
      const due = new Date(deliveredAt + window);
      assert.deepEqual(await ownerAsked(stack, w, justBefore), []);
      assert.equal(await ownerCount(stack, w, justBefore), 0);
      assert.deepEqual(await ownerAsked(stack, w, due), [w.taskId],
        'the escalation passed and the owner is still not asked');
      assert.equal(await ownerCount(stack, w, due), 1, 'the count did not follow the read');

      // The clock is the project's setting as it stands: lowered, the same delivery is due sooner.
      await setProject(stack, w, { exceptionEscalationSeconds: 300 });
      assert.deepEqual(await ownerAsked(stack, w, new Date(deliveredAt + 299_000)), []);
      assert.deepEqual(await ownerAsked(stack, w, new Date(deliveredAt + 300_000)), [w.taskId]);
      assert.equal(await ownerCount(stack, w, new Date(deliveredAt + 300_000)), 1);

      // And through the two production reads, which read at "now": until the delivery is old
      // enough the owner is not asked, and once it is — the row aged by the same 300 seconds the
      // clock would take — the card's read lists it and the badge lights.
      assert.deepEqual(await cardNow(stack, w), []);
      assert.equal(await badge(stack, w), badgeBefore);
      await stack.db.$executeRaw`
        UPDATE "project_coordinator_wake"
           SET "updated_at" = "updated_at" - make_interval(secs => 301)
         WHERE "id" = ${row!.id}::uuid`;
      assert.deepEqual(await cardNow(stack, w), [w.taskId],
        'the delivery is past its escalation and the owner is still not asked');
      assert.equal(await badge(stack, w), badgeBefore + 1, 'the badge did not light with the card');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(3) a project that is not Automatic records the revision, tells its coordinator nothing, and asks the owner',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'manual', { coordinatorEnabled: false });
      const badgeBefore = await badge(stack, w);
      await submit(stack, w);

      // Recorded exactly as every revision was from 2026-09-10: consumed against the consumer these
      // rows have always named, reaching no session, and told to nobody.
      const wakes = await evidenceWakes(stack.db, w.taskId);
      assert.equal(wakes.length, 1, 'the revision never reached the wake ledger');
      const [row] = wakes;
      assert.equal(row!.status, 'CONSUMED');
      assert.equal(row!.consumerType, 'JUDGMENT_REQUEST_DERIVER');
      assert.equal(row!.sessionId, null);
      assert.deepEqual(await messagesOn(stack.db, w.coordinatorSessionId), [],
        'a coordinator whose switch is off was told about the evidence');
      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);
      assert.equal(await convergenceDecisions(stack.db, w.projectId), 0);

      // The owner is asked, at once, through all three reads.
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
      assert.equal(await ownerCount(stack, w), 1);
      assert.equal(await badge(stack, w), badgeBefore + 1);

      // The paired positive, in this fixture: switched on, the next revision is delivered — so the
      // silence above was the switch, not a conversation nothing could be written to.
      await setProject(stack, w, { coordinatorEnabled: true });
      const next = await submit(stack, w, { key: 'manual-2', claim: 're-ran it; it still holds' });
      assert.equal(next.revision, '2');
      const [, delivered] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(delivered!.status, 'DELIVERED', `refused with ${delivered!.refusalCode}`);
      assert.equal((await messagesOn(stack.db, w.coordinatorSessionId)).length, 1);
      assert.deepEqual(await ownerAsked(stack, w), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(4) a claim made after the switch went off is refused on it by the producer, tells nobody, and opens nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // The router reads the switch before it asks the producer; this is the claim that lost that
      // race — the revision is written with no router, and its fact delivered with the switch off.
      const w = await world(stack, 'raced', { coordinatorEnabled: false });
      const receipt = await submit(stack, w, { service: stack.unrouted });
      assert.deepEqual(await evidenceWakes(stack.db, w.taskId), []);
      const fact = completionEvidenceRevisedFact({
        projectId: w.projectId,
        taskId: w.taskId,
        revision: receipt.revision,
        criterionRevision: receipt.criterionRevision,
        evidenceDigest: receipt.evidenceDigest,
      });

      const answer = await stack.deliveries.queue(fact, stack.producer.authorize);
      assert.equal(answer.outcome, 'REFUSED');

      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);
      // Exactly one row, and not zero: the ledger claims before it authorizes, so a fact refused on
      // the switch travelled the whole way — zero would also be a producer nobody calls.
      const wakes = await evidenceWakes(stack.db, w.taskId);
      assert.equal(wakes.length, 1);
      const [row] = wakes;
      assert.equal(row!.status, 'REFUSED');
      assert.equal(row!.refusalCode, COMPLETION_EVIDENCE_WAKE_COORDINATOR_DISABLED);
      assert.equal(row!.sessionId, null);
      assert.deepEqual(await messagesOn(stack.db, w.coordinatorSessionId), [],
        'the switched-off coordinator was told anyway');
      // Refused before the convergence ledger: the switch is the cheapest refusal, asked first.
      assert.equal(await convergenceDecisions(stack.db, w.projectId), 0);
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(5) a paused coordinator is refused on the fuse, is told nothing, and the owner is asked',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'paused');
      const episode = await stack.db.projectFuseEpisode.create({
        data: {
          projectId: w.projectId,
          ownerId: w.ownerId,
          generation: 1,
          dimension: 'SELF_STARTED_TURNS',
          observed: 31,
          limitValue: 30,
          windowStart: new Date(Date.now() - 3_600_000),
          spend: { selfStartedTurns: 31, sessionsOpened: 0, successorRetries: 0 },
          crossingFact: { kind: 'SELF_STARTED_TURN' },
        },
        select: { id: true },
      });
      await submit(stack, w);

      const [row] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(row!.status, 'REFUSED');
      assert.equal(row!.refusalCode, PROJECT_FUSE_PAUSED);
      assert.equal(row!.sessionId, null);
      assert.deepEqual(await messagesOn(stack.db, w.coordinatorSessionId), []);
      // Refused in front of the ledger, so the same fact can be judged afresh after the resume.
      assert.equal(await convergenceDecisions(stack.db, w.projectId), 0);
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
      assert.equal(await ownerCount(stack, w), 1);

      // The refusal gave the key back: resumed, the same revision routed again is delivered, and
      // the coordinator holds it.
      await stack.db.projectFuseEpisode.update({
        where: { id: episode.id },
        data: { resumedAt: new Date(), resumedByUserId: w.ownerId },
      });
      await submit(stack, w);
      const wakes = await evidenceWakes(stack.db, w.taskId);
      assert.deepEqual(wakes.map((wake) => wake.status), ['REFUSED', 'DELIVERED']);
      assert.equal((await messagesOn(stack.db, w.coordinatorSessionId)).length, 1);
      assert.deepEqual(await ownerAsked(stack, w), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(6) a coordinator conversation that has ended is not written to or revived, and the owner is asked',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'ended', { coordinator: 'ENDED' });
      await submit(stack, w);

      const [row] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(row!.status, 'REFUSED');
      assert.equal(row!.refusalCode, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
      assert.equal(row!.sessionId, null);
      assert.deepEqual(await messagesOn(stack.db, w.coordinatorSessionId), [],
        'an ended conversation was written to');
      const standing = await stack.db.session.findUniqueOrThrow({
        where: { id: w.coordinatorSessionId! },
        select: { status: true, completedAt: true },
      });
      assert.equal(standing.status, RunStatus.SUCCEEDED, 'the ended conversation was revived');
      assert.ok(standing.completedAt);
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
      assert.equal(await ownerCount(stack, w), 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(7) a project with no coordinator conversation cannot be told, and the owner is asked',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'unopened', { coordinator: 'NONE' });
      const sessionsBefore = await stack.db.session.count({ where: { ownerId: w.ownerId } });
      await submit(stack, w);

      const [row] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(row!.status, 'REFUSED');
      assert.equal(row!.refusalCode, DELIVERY_NO_COORDINATOR_SESSION);
      assert.equal(row!.sessionId, null);
      assert.equal(await stack.db.session.count({ where: { ownerId: w.ownerId } }), sessionsBefore,
        'a conversation was opened to carry the revision');
      assert.deepEqual(await messagesOn(stack.db, w.readerSessionId), []);
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(8) the coordinator confirms the revision, the task is DONE, and nobody is asked any more',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'confirmed');
      await submit(stack, w);
      const [row] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(row!.status, 'DELIVERED', `refused with ${row!.refusalCode}`);

      // What `task_evidence_decide` does when the coordinator calls it: the runner door hands its
      // own session in as the deciding one, and the actor is the agent.
      const decided = await stack.evidence.decide(
        w.ownerId,
        w.taskId,
        { type: CreatorType.AGENT, id: w.workspaceId },
        { decidingSessionId: w.coordinatorSessionId!, evidenceRevision: '1', decision: 'CONFIRM' },
      );
      assert.equal(decided.decision, 'CONFIRM');
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: w.taskId } })).status,
        TaskStatus.DONE,
        'the coordinator\'s CONFIRM did not settle the task',
      );

      // Nobody is asked: not the owner now, not the owner once the escalation would have come, not
      // an unrelated reader, and the count agrees.
      const later = new Date(Date.now() + (ESCALATION_SECONDS + 60) * 1_000);
      assert.deepEqual(await ownerAsked(stack, w), []);
      assert.deepEqual(await ownerAsked(stack, w, later), []);
      assert.equal(await ownerCount(stack, w, later), 0);
      const reader = await readPendingEvidenceJudgments(stack.prisma, w.ownerId, {
        id: w.readerSessionId, taskId: null,
      }, later);
      assert.deepEqual(reader.pending, []);

      // And the conversation keeps the receipt of the answer it gave.
      const own = await readPendingEvidenceJudgments(stack.prisma, w.ownerId, {
        id: w.coordinatorSessionId!, taskId: null,
      });
      assert.deepEqual(
        own.decided.map((d) => [d.taskId, d.evidenceRevision, d.decision, d.decidedByType]),
        [[w.taskId, '1', 'CONFIRM', CreatorType.AGENT]],
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(9) the hold ends the moment the coordinator cannot act on it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'released');
      await submit(stack, w);
      const [row] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(row!.status, 'DELIVERED', `refused with ${row!.refusalCode}`);
      assert.deepEqual(await ownerAsked(stack, w), []);

      // Switched off: the project is the owner's to judge again, as every non-Automatic one is.
      await setProject(stack, w, { coordinatorEnabled: false });
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
      assert.equal(await ownerCount(stack, w), 1);
      await setProject(stack, w, { coordinatorEnabled: true });
      assert.deepEqual(await ownerAsked(stack, w), [], 'switched back on, it is held again');

      // The conversation it was delivered to is over: it will not decide anything.
      await stack.db.session.update({
        where: { id: w.coordinatorSessionId! },
        data: { status: RunStatus.FAILED },
      });
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
      assert.equal(await ownerCount(stack, w), 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(10) a revision the coordinator could not decide is only recorded, and the owner is asked',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // A quote that is not the live criterion: nobody may decide it, so nobody is told.
      const w = await world(stack, 'moved');
      await submit(stack, w, { quote: `${STANDARD}, as it read before somebody reworded it` });
      const [moved] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(moved!.status, 'CONSUMED');
      assert.equal(moved!.consumerType, 'JUDGMENT_REQUEST_DERIVER');
      assert.deepEqual(await messagesOn(stack.db, w.coordinatorSessionId), []);
      // In the same fixture, a revision of another task that CAN be decided is delivered.
      const sibling = await judgedTask(stack.db, w, 'moved-sibling');
      await submit(stack, w, { task: sibling });
      const [siblingWake] = await evidenceWakes(stack.db, sibling.taskId);
      assert.equal(siblingWake!.status, 'DELIVERED', `refused with ${siblingWake!.refusalCode}`);
      assert.equal((await messagesOn(stack.db, w.coordinatorSessionId)).length, 1);

      // A coordinator that is the run being judged may not decide it: recorded, the owner asked.
      const selfRun = await world(stack, 'selfcoord');
      await stack.db.project.update({
        where: { id: selfRun.projectId },
        data: { coordinatorSessionId: selfRun.runSessionId },
      });
      await submit(stack, selfRun);
      const [recorded] = await evidenceWakes(stack.db, selfRun.taskId);
      assert.equal(recorded!.status, 'CONSUMED');
      assert.equal(recorded!.consumerType, 'JUDGMENT_REQUEST_DERIVER');
      assert.deepEqual(await messagesOn(stack.db, selfRun.runSessionId), []);
      const reader = await readPendingEvidenceJudgments(stack.prisma, selfRun.ownerId, {
        id: selfRun.readerSessionId, taskId: null,
      });
      assert.deepEqual(reader.pending.map((r) => r.taskId), [selfRun.taskId]);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the automatic-evidence PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
