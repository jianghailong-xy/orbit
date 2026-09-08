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
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService, coordinatorDeliveryTurnId } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { wakeIdempotencyKey } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import type { PendingEvidenceJudgment } from './pending-evidence-judgments';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

/**
 * The three states in which a submitted completion evidence revision has NO ADDRESSEE, and what
 * happens to it instead.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/coordinator-evidence-no-addressee.pg.spec.js
 *
 * WHICH THREE, AND WHY THEY ARE ONE FILE
 * ======================================
 * The carrier assumes a project has a standing conversation to be told things in. Three states
 * have none, and they fail in three different places, which is why one case each:
 *
 *   1. `Project.coordinatorSessionId` is null — the column is nullable and only carries a value
 *      once somebody has actually opened that conversation. The fact reaches the delivery unit and
 *      is refused there for want of a recipient.
 *   2. The task is filed under no project. The route is inside `if (committed.projectId ...)`, so
 *      the fact is never even derived: there is no wake row, let alone a delivery.
 *   3. The standing conversation IS the run of the task being judged — what promoting a task's own
 *      session to the project's coordinator produces. Here there is a recipient and the message
 *      arrives; what is missing is a DECIDER, because the decision door refuses a session that took
 *      part in the work.
 *
 * WHAT THE DEFINED BEHAVIOUR IS, IN ALL THREE
 * ===========================================
 * The fact is never dropped: it falls back to the derived read that finds these questions from the
 * rows themselves — `TaskCompletionEvidenceService.pending`, which is what
 * `GET /api/tasks/evidence-decisions/pending` returns and what the decision rail renders. That is
 * the timeout fallback this project already chose for a card nobody answers, and these three are
 * the same shape one step earlier: a question with no reader is still a question, and the read
 * that recomputes it from the ledger cannot lose one.
 *
 * So every case below asserts BOTH halves. What the carrier did — a fact recorded and nothing
 * said, no fact at all, or a message to a conversation that may not answer it — and then that the
 * evidence is still in front of a session that CAN settle it, and that settling it there really
 * does take it off the list.
 *
 * HOW EACH "NOTHING HAPPENED" IS KEPT FROM BEING VACUOUS
 * =====================================================
 * Every count of rows that must not appear is paired, in the same fixture, with a fact that DOES
 * produce them: case 1 points the project at a conversation and submits again, case 2 carries a
 * sibling task that is filed under a project with one, and case 3 reads the same queue for a second
 * session. A count asserted alone would be green over a system that delivers nothing at all and
 * over a read that returns nothing at all, which is exactly what these cases are here to rule out.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

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
  /** The unit under test: the real evidence ledger, holding the real router. */
  evidence: TaskCompletionEvidenceService;
}

/**
 * The production wiring, over one client — the same graph the module provides.
 *
 * A stand-in for any of these would let this file answer its own question: whether the fact
 * reaches a recipient is decided by the collaborators, not by the door that hands it to them.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = () => new CoordinatorWakeService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, wakes(), sessions);
  const disposition = new WakeDispositionService(
    prisma,
    judgments,
    new CoordinatorDeliveryService(prisma, wakes(), sessions),
  );
  const router = new CompletionInputRouter(
    wakes(),
    new ProjectTasksSettledProducer(
      prisma,
      judgments,
      new CoordinatorConvergenceService(prisma),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    disposition,
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  return { db, evidence: new TaskCompletionEvidenceService(prisma, undefined, router) };
}

/** One account with somewhere to run: everything below is created under it. */
interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@no-addressee.invalid`,
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
  return { ownerId, runnerId, workspaceId };
}

/**
 * One conversation, parked, carrying the opening prompt a conversation somebody has talked to has.
 *
 * The opening turn is written here so no assertion below counts it: it is the conversation's own
 * prompt rather than something anybody told it, and counting it would make "was this conversation
 * told about the evidence" answer yes for one nobody has said a word to.
 */
async function conversation(
  db: PrismaClient,
  w: World,
  title: string,
  run?: { taskId: string },
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId: run?.taskId,
      startsTaskWork: run !== undefined,
      title,
      prompt: title,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
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

/** The task's stated standard, quoted verbatim by every envelope below. */
const STANDARD = 'the declared command exits zero and its output names the artifact';

/**
 * One project, with one stated criterion for its work to quote.
 *
 * The criterion is a real definition row because the decision door resolves the quote against one:
 * a queue whose rows were all undecidable for want of a live standard would answer "still visible"
 * with a row nobody could act on, which is a different claim from the one these cases make.
 */
async function project(
  db: PrismaClient,
  w: World,
  label: string,
  coordinatorSessionId: string | null,
): Promise<{ projectId: string; criterionKey: string }> {
  const projectId = randomUUID();
  const criterionKey = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId: w.ownerId,
      title: `${label} 项目`,
      goal: '提交完成证据后，这条证据要有人收得到',
      coordinatorWorkspaceId: w.workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionKey,
      projectId,
      ordinal: 1,
      text: STANDARD,
      verificationMethod: '读那条命令的退出码和输出',
      contentHash: '0'.repeat(64),
    },
  });
  return { projectId, criterionKey };
}

/** One piece of work settled by judgment, filed under a project or under none. */
async function task(
  db: PrismaClient,
  w: World,
  label: string,
  projectId: string | null,
): Promise<string> {
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId: w.ownerId,
      projectId,
      title: `${label} 要交证据的活`,
      creatorType: CreatorType.USER,
      creatorId: w.ownerId,
      assigneeId: w.workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      // Its own stated standard, which is what a task in NO project is held to. Written on every
      // task here so the two lanes quote the same words and the cases differ in one thing only.
      acceptanceCriteria: STANDARD,
    },
  });
  return taskId;
}

/** The row an envelope cites, recorded under the run that submits it. */
async function citedToolCall(db: PrismaClient, sessionId: string, ref: string): Promise<void> {
  await db.toolCall.create({
    data: {
      sessionId,
      name: 'Bash',
      toolUseId: ref,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
    },
  });
}

/** The four-field envelope, quoting one live standard and citing one row of this task's own. */
function envelope(criterionKey: string, ref: string, claim: string) {
  return {
    claim,
    criterion: { key: criterionKey, text: STANDARD },
    checks: [{ kind: 'TOOL_CALL', ref, command: 'npm test', succeeded: true }],
    gaps: [],
  };
}

/** Everything anybody was TOLD, across this whole account. Opening prompts are not that. */
async function everythingSaid(db: PrismaClient, ownerId: string) {
  const turns = await db.conversationTurn.findMany({
    where: { session: { ownerId } },
    select: { sessionId: true, clientTurnId: true, content: true, status: true },
    orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }],
  });
  return turns.filter((turn) => (
    turn.clientTurnId !== SessionsService.initialTurnClientId(turn.sessionId)
  ));
}

/** The wake ledger's record of one task's evidence revisions, oldest first. */
function evidenceWakes(db: PrismaClient, taskId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { event: 'COMPLETION_EVIDENCE_REVISED', subjectType: 'TASK', subjectId: taskId },
    select: {
      projectId: true,
      subjectType: true,
      subjectId: true,
      subjectVersion: true,
      status: true,
      consumerType: true,
      refusalCode: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

/** The turn key one recorded fact's message is written under, derived the way the product derives it. */
function expectedTurnId(row: { subjectType: string; subjectId: string; subjectVersion: string }) {
  return coordinatorDeliveryTurnId(wakeIdempotencyKey({
    event: 'COMPLETION_EVIDENCE_REVISED',
    subjectType: row.subjectType as 'TASK',
    subjectId: row.subjectId,
    subjectVersion: row.subjectVersion,
  }));
}

/** Every session row this owner has — the count "nothing was opened" is really about. */
function allSessions(db: PrismaClient, ownerId: string) {
  return db.session.count({ where: { ownerId } });
}

/** Which of these tasks this reader is being asked to decide, in the queue's own order. */
function asked(
  queue: { pending: PendingEvidenceJudgment[] },
  taskIds: readonly string[],
): string[] {
  return queue.pending.filter((row) => taskIds.includes(row.taskId)).map((row) => row.taskId);
}

test('a project nobody has opened a coordinator for records the fact and tells no one',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack.db, 'unopened');
      // The conversation this account DOES have open. The project does not name it yet, which is
      // the whole of this case: `coordinator_session_id` carries a value only once somebody has
      // opened that conversation, and until then there is nobody to tell.
      const standing = await conversation(stack.db, w, '协调：还没被指派');
      const reader = await conversation(stack.db, w, '另一条会话');
      const { projectId, criterionKey } = await project(stack.db, w, 'unopened', null);
      const taskId = await task(stack.db, w, 'unopened', projectId);
      const run = await conversation(stack.db, w, 'unopened 执行会话', { taskId });
      await citedToolCall(stack.db, run, 'toolu_unopened');

      const sessionsBefore = await allSessions(stack.db, w.ownerId);
      assert.deepEqual(await everythingSaid(stack.db, w.ownerId), []);

      const first = await stack.evidence.submit(
        w.ownerId,
        taskId,
        { type: CreatorType.AGENT, id: w.workspaceId },
        {
          sourceSessionId: run,
          evidence: envelope(criterionKey, 'toolu_unopened', 'the declared command ran and passed'),
          idempotencyKey: 'unopened-1',
        },
      );
      assert.equal(first.revision, '1');

      // (1) The fact is RECORDED. It reaches the ledger and ends against its named consumer
      // exactly as it does when there is somebody to tell — a missing recipient is not a refused
      // wake, and a reader of this table is not told one thing about the world in place of another.
      const recorded = await evidenceWakes(stack.db, taskId);
      assert.equal(recorded.length, 1, 'the evidence revision never reached the wake ledger');
      assert.equal(recorded[0]!.status, 'CONSUMED');
      assert.equal(recorded[0]!.consumerType, 'JUDGMENT_REQUEST_DERIVER');
      assert.equal(recorded[0]!.refusalCode, null);

      // (2) And nobody was told anything — not the conversation this account has open, not any
      // other, and nothing was opened to carry it either.
      assert.deepEqual(
        await everythingSaid(stack.db, w.ownerId), [],
        'a project with no coordinator conversation delivered the fact to somebody anyway',
      );
      assert.equal(
        await allSessions(stack.db, w.ownerId), sessionsBefore,
        'the delivery opened a conversation for a project that has none',
      );

      // (3) The defined behaviour: the evidence is on the derived read, in front of a session that
      // may answer it. This is the surface the decision rail renders, so "nobody was told" is not
      // "nobody can find out".
      const queue = await stack.evidence.pending(w.ownerId, reader);
      const row = queue.pending.find((pending) => pending.taskId === taskId);
      assert.ok(row, 'the evidence of a project with no coordinator fell off the pending read');
      assert.equal(row.evidenceRevision, '1');
      assert.equal(row.projectId, projectId);
      assert.equal(row.decidability.decidable, true);
      assert.equal(row.independence.independent, true);
      assert.deepEqual(row.criterion, { key: criterionKey, text: STANDARD });

      // (4) The paired positive, in this same fixture: the person opens the coordinator, and the
      // NEXT fact is delivered. So the silence above is a property of the missing recipient rather
      // than of a stack that cannot deliver at all.
      await stack.db.project.update({
        where: { id: projectId },
        data: { coordinatorSessionId: standing },
      });
      const second = await stack.evidence.submit(
        w.ownerId,
        taskId,
        { type: CreatorType.AGENT, id: w.workspaceId },
        {
          sourceSessionId: run,
          evidence: envelope(criterionKey, 'toolu_unopened', 're-read the artifact and it holds'),
          idempotencyKey: 'unopened-2',
        },
      );
      assert.equal(second.revision, '2');
      const said = await everythingSaid(stack.db, w.ownerId);
      assert.equal(said.length, 1, 'a project WITH a coordinator was told nothing either');
      assert.equal(said[0]!.sessionId, standing);
      const wakes = await evidenceWakes(stack.db, taskId);
      assert.equal(wakes.length, 2);
      assert.equal(said[0]!.clientTurnId, expectedTurnId(wakes[1]!));

      // (5) And the negative control for (3): answering it takes it off the same read. Without
      // this, "the row is still there" would also be true of a read that filters nothing.
      await stack.evidence.decide(
        w.ownerId,
        taskId,
        { type: CreatorType.USER, id: w.ownerId },
        { decidingSessionId: reader, evidenceRevision: '2', decision: 'CONFIRM' },
      );
      assert.deepEqual(
        asked(await stack.evidence.pending(w.ownerId, reader), [taskId]), [],
        'the answered evidence is still being asked about',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a task in no project derives no fact at all, and is still asked about',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack.db, 'unfiled');
      const reader = await conversation(stack.db, w, '另一条会话');

      // The task this case is about: filed under nothing. Such a row can no longer be CREATED
      // through the write doors, so what is covered here is the population that already exists —
      // which is why it is built on the table rather than through them.
      const unfiled = await task(stack.db, w, 'unfiled', null);
      const unfiledRun = await conversation(stack.db, w, 'unfiled 执行会话', { taskId: unfiled });
      await citedToolCall(stack.db, unfiledRun, 'toolu_unfiled');

      // Its sibling, filed under a project that HAS a standing conversation: the same account, the
      // same stack, the same submission — so every count below that must be zero for the unfiled
      // task is one that this task moves.
      const standing = await conversation(stack.db, w, '协调：兄弟项目');
      const { projectId, criterionKey } = await project(stack.db, w, 'unfiled', standing);
      const filed = await task(stack.db, w, 'filed', projectId);
      const filedRun = await conversation(stack.db, w, 'filed 执行会话', { taskId: filed });
      await citedToolCall(stack.db, filedRun, 'toolu_filed');

      const actor = { type: CreatorType.AGENT, id: w.workspaceId };
      await stack.evidence.submit(w.ownerId, unfiled, actor, {
        sourceSessionId: unfiledRun,
        // The key is the task's own id rather than a project criterion's: a task in no project has
        // one stated standard, its `acceptanceCriteria`, and the quote binds to that TEXT.
        evidence: envelope(unfiled, 'toolu_unfiled', 'the declared command ran and passed'),
        idempotencyKey: 'unfiled-1',
      });
      await stack.evidence.submit(w.ownerId, filed, actor, {
        sourceSessionId: filedRun,
        evidence: envelope(criterionKey, 'toolu_filed', 'the declared command ran and passed'),
        idempotencyKey: 'filed-1',
      });

      // (1) No fact was derived for the unfiled task — not a refused one, not a consumed one, none.
      // The route is inside `if (committed.projectId ...)`, and a wake row names a project. The
      // sibling's row is read in the same breath, so "no rows" is a difference between two tasks
      // rather than an empty table.
      assert.deepEqual(
        await evidenceWakes(stack.db, unfiled), [],
        'a task in no project reached the wake ledger',
      );
      const sibling = await evidenceWakes(stack.db, filed);
      assert.equal(sibling.length, 1, 'the sibling in a project never reached the wake ledger');
      assert.equal(sibling[0]!.status, 'CONSUMED');
      assert.equal(sibling[0]!.projectId, projectId);

      // (2) And only the sibling was said out loud, on the conversation its project names.
      const said = await everythingSaid(stack.db, w.ownerId);
      assert.equal(said.length, 1, 'the unfiled task was delivered to somebody');
      assert.equal(said[0]!.sessionId, standing);
      assert.equal(said[0]!.clientTurnId, expectedTurnId(sibling[0]!));

      // (3) The defined behaviour: it is still asked about, beside the one that was delivered, and
      // it is decidable — the derived read holds a task in no project to its OWN stated standard.
      const queue = await stack.evidence.pending(w.ownerId, reader);
      assert.deepEqual(
        asked(queue, [unfiled, filed]).sort(), [unfiled, filed].sort(),
        'the evidence of a task in no project fell off the pending read',
      );
      const row = queue.pending.find((pending) => pending.taskId === unfiled)!;
      assert.equal(row.projectId, null);
      assert.equal(row.decidability.decidable, true);
      assert.equal(row.decidability.refusal, null);
      assert.equal(row.independence.independent, true);
      assert.deepEqual(row.criterion, { key: unfiled, text: STANDARD });

      // (4) Answering it takes it off, and leaves the sibling on: the read filters by the answer,
      // not by having run out of rows.
      await stack.evidence.decide(
        w.ownerId,
        unfiled,
        { type: CreatorType.USER, id: w.ownerId },
        { decidingSessionId: reader, evidenceRevision: '1', decision: 'CONFIRM' },
      );
      assert.deepEqual(
        asked(await stack.evidence.pending(w.ownerId, reader), [unfiled, filed]), [filed],
        'answering one question answered the other one too, or neither',
      );
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: unfiled } })).status,
        TaskStatus.DONE,
        'a confirmed task in no project was not settled by its own criterion',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a coordinator that is the run being judged is told, may not answer, and is not the only reader',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack.db, 'selfcoord');
      const reader = await conversation(stack.db, w, '另一条会话');
      const { projectId, criterionKey } = await project(stack.db, w, 'selfcoord', null);
      const taskId = await task(stack.db, w, 'selfcoord', projectId);
      // The collision: the project is coordinated FROM the conversation that is running the task,
      // which is what promoting an existing session to coordinator produces.
      const run = await conversation(stack.db, w, 'selfcoord 执行会话', { taskId });
      await stack.db.project.update({
        where: { id: projectId },
        data: { coordinatorSessionId: run },
      });
      await citedToolCall(stack.db, run, 'toolu_selfcoord');

      await stack.evidence.submit(
        w.ownerId,
        taskId,
        { type: CreatorType.AGENT, id: w.workspaceId },
        {
          sourceSessionId: run,
          evidence: envelope(criterionKey, 'toolu_selfcoord', 'the declared command ran and passed'),
          idempotencyKey: 'selfcoord-1',
        },
      );

      // (1) The carrier does not know the difference: there is a standing conversation, it is not
      // ended, so the message is written to it. Pinned rather than wished away, because it is what
      // a reader of that conversation will actually find.
      const wakes = await evidenceWakes(stack.db, taskId);
      assert.equal(wakes.length, 1);
      const said = await everythingSaid(stack.db, w.ownerId);
      assert.equal(said.length, 1, 'the standing conversation was told nothing');
      assert.equal(said[0]!.sessionId, run);
      assert.equal(said[0]!.clientTurnId, expectedTurnId(wakes[0]!));

      // (2) What it may not do is answer. The door refuses it by name, and writes nothing.
      await assert.rejects(
        () => stack.evidence.decide(
          w.ownerId,
          taskId,
          { type: CreatorType.AGENT, id: w.workspaceId },
          { decidingSessionId: run, evidenceRevision: '1', decision: 'CONFIRM' },
        ),
        (error: { response?: { code?: string; message?: string; requiredAction?: string } }) => {
          // Spelled out rather than imported: these two are what a client reads off the wire, so a
          // rename is a change to the contract and has to be seen here.
          assert.equal(error.response?.code, 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION');
          assert.equal(
            error.response?.requiredAction, 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
            'the refusal does not say what would clear it',
          );
          assert.match(
            error.response?.message ?? '', /a run of the task it is deciding/,
            'the refusal does not name the disqualification this case is about',
          );
          return true;
        },
      );
      assert.equal(
        await stack.db.taskEvidenceDecision.count({ where: { taskId } }), 0,
        'the refused decision was written anyway',
      );

      // (3) So the queue does not put the question in front of it — in neither group, because a
      // row this reader may not answer is not one it can act on and not one it can fix either.
      const itsOwn = await stack.evidence.pending(w.ownerId, run);
      assert.deepEqual(asked(itsOwn, [taskId]), []);
      assert.deepEqual(
        itsOwn.waitingOnYou.filter((row) => row.taskId === taskId), [],
        'a decidable row was filed under the group for rows waiting on a new revision',
      );

      // (4) And the answer to "then nobody can judge it": a session that took no part in the work
      // is asked, and its answer settles the task. The same read, in the same fixture, one reader
      // apart — so (3) is about who is reading and not about the row having disappeared.
      const independent = await stack.evidence.pending(w.ownerId, reader);
      const row = independent.pending.find((pending) => pending.taskId === taskId);
      assert.ok(row, 'the evidence reached neither the coordinator nor anybody else');
      assert.equal(row.independence.independent, true);
      assert.equal(row.decidability.decidable, true);

      const decision = await stack.evidence.decide(
        w.ownerId,
        taskId,
        { type: CreatorType.USER, id: w.ownerId },
        { decidingSessionId: reader, evidenceRevision: '1', decision: 'CONFIRM' },
      );
      assert.equal(decision.decision, 'CONFIRM');
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
        TaskStatus.DONE,
      );
      assert.deepEqual(
        asked(await stack.evidence.pending(w.ownerId, reader), [taskId]), [],
        'the answered evidence is still being asked about',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the no-addressee PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
