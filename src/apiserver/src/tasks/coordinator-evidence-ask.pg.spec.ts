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
import { uuidToBase62, type QuestionAnswers } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import {
  CONFIRM_OPTION,
  EVIDENCE_ASK_HEADER,
  EVIDENCE_ASK_TOOL,
  SEND_BACK_OPTION,
  buildEvidenceAsk,
  evidenceDecisionFromAnswers,
  type EvidenceAsk,
  type EvidenceQuestion,
} from './coordinator-evidence-ask';
import { readPendingEvidenceJudgments } from './pending-evidence-judgments';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import {
  REQUIRES_INDEPENDENT_SESSION_CODE,
  SEND_BACK_NOTE_CODE,
} from './task-evidence-decision';

/**
 * A2's answer half: the delivered turn ASKS a person, and the person's pick becomes the decision.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/coordinator-evidence-ask.pg.spec.js
 *
 * WHERE THE SPEC STANDS IN FOR SOMETHING, AND WHERE IT DELIBERATELY DOES NOT
 * =========================================================================
 * One actor here cannot be run: the model that reads the delivered turn and decides to call
 * `AskUserQuestion`. Everything on either side of it is the production path and is called as such
 * — `TaskCompletionEvidenceService.submit` writes the revision and routes the fact,
 * `CoordinatorDeliveryService` composes the turn, `readPendingEvidenceJudgments` answers what may
 * be decided, `RunnerApiController.createApproval` is the door the runner's permission tool posts
 * through, `SessionsService.decideApproval` is the door the browser answers through, and
 * `TaskCompletionEvidenceService.decide` is the door that records it. What the spec supplies in
 * the model's place is exactly what the opening tells the model to supply: the tool name, and the
 * questions `buildEvidenceQuestion` built from the queue. A spec that also invented the question
 * would be asserting over its own JSON.
 *
 * THE TWO CLAIMS, AND WHY EACH HAS A PAIRED CONTROL
 * =================================================
 * "No REQUIRES_INDEPENDENT_SESSION was raised" and "nothing was written" are both claims about an
 * absence, and an absence is what a broken build produces for free. So neither is asserted alone:
 * the run that DID the work is put through the same door and must be refused with that exact code,
 * and the send-back that carries a note must write the row the noteless one did not.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
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

/** A collaborator this file's question is not about: every call answers undefined. */
function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

interface Stack {
  db: PrismaClient;
  /** The ledger: the door the work submits through, and the door the answer is recorded through. */
  evidence: TaskCompletionEvidenceService;
  /** The runner's permission tool, as the control plane receives it. */
  runner: RunnerApiController;
  /** The browser's approval door, as the person answers through it. */
  sessions: SessionsService;
}

/**
 * The production wiring, over one client.
 *
 * The stand-ins are the notification transports and nothing else: a realtime publish, a push
 * notification and a queue nudge are how other processes hear about a row, never how the row is
 * decided, so a proxy for them removes no check this file makes.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = inert<ConstructorParameters<typeof SessionsService>[2]>();
  const queue = inert<ConstructorParameters<typeof SessionsService>[1]>();
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
    new ProjectTasksSettledProducer(prisma, judgments, new CoordinatorConvergenceService(prisma)),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    disposition,
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  return {
    db,
    evidence: new TaskCompletionEvidenceService(prisma, undefined, router),
    runner: new RunnerApiController(prisma, queue, realtime, inert(), inert(), inert()),
    sessions,
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  criterionId: string;
  taskId: string;
  /** The run whose tool call the evidence cites, and which submits it. */
  sourceSessionId: string;
  /** The standing conversation this project is coordinated from — and the deciding session. */
  coordinatorSessionId: string;
}

/** The project's one stated criterion, quoted verbatim by every envelope below. */
const STANDARD = 'the delivered turn asks the account owner and records what they answered';

/**
 * One project being coordinated from a parked conversation, with one task submitting evidence.
 *
 * The coordinator conversation has NO `taskId` and submits nothing, which is not a convenience
 * here — it is the fact `decidingSessionDisqualification` reads, and the reason a decision made in
 * it is independent on the facts rather than by exemption.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const criterionId = randomUUID();
  const taskId = randomUUID();
  const sourceSessionId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@evidence-ask.invalid`,
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
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      providerBuiltin: true,
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
      title: `${label} 证据问人项目`,
      goal: '把完成裁决变成协调会话里问给人的一张卡片',
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  // The live stated standard. Without a definition row the quote below resolves to nothing, the
  // decision door refuses every answer about it, and the queue would put the row where nobody can
  // press anything — which is a different spec's subject, and would make this one vacuous.
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId,
      projectId,
      ordinal: 1,
      text: STANDARD,
      verificationMethod: 'the pg spec drives the ask and reads the decision back',
      contentHash: '0'.repeat(64),
    },
  });
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
      acceptanceCriteria: STANDARD,
      criterionDefinitionId: criterionId,
      criterionRevision: 1,
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
      providerBuiltin: true,
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await db.toolCall.create({
    data: {
      sessionId: sourceSessionId,
      name: 'Bash',
      toolUseId: `toolu_${label}`,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
    },
  });
  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    criterionId,
    taskId,
    sourceSessionId,
    coordinatorSessionId,
  };
}

/** The four-field envelope, quoting the criterion this project states and citing the run's own call. */
function envelope(f: Fixture, label: string, claim: string, gaps: string[]) {
  return {
    claim,
    criterion: { key: uuidToBase62(f.criterionId), text: STANDARD },
    checks: [{ kind: 'TOOL_CALL', ref: `toolu_${label}`, command: 'npm test', succeeded: true }],
    gaps,
  };
}

/** The code a Nest refusal carries, so a rejection can be asserted to be the RIGHT rejection. */
function refusalCode(error: unknown): string | null {
  const response = (error as { getResponse?: () => unknown })?.getResponse?.();
  if (!response || typeof response !== 'object') return null;
  const code = (response as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** The message the delivery put in the coordinator's inbox — its own opening turn excluded. */
async function deliveredTurn(db: PrismaClient, f: Fixture): Promise<string> {
  const turns = await db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    select: { content: true },
    orderBy: { seq: 'asc' },
  });
  assert.equal(turns.length, 1, 'the coordinator conversation was told nothing');
  return turns[0]!.content ?? '';
}

/**
 * What the model is told to ask, read off the queue the way the delivery read it.
 *
 * Called with the coordinator's own row rather than with a literal `{ taskId: null }`, so the
 * independence this file is about is read from the session table and not asserted into existence.
 */
async function askFor(db: PrismaClient, f: Fixture): Promise<EvidenceAsk> {
  const standing = await db.session.findUniqueOrThrow({
    where: { id: f.coordinatorSessionId },
    select: { id: true, taskId: true },
  });
  assert.equal(standing.taskId, null, 'the coordinator conversation is a run of some task');
  const queue = await readPendingEvidenceJudgments(
    db as unknown as PrismaService,
    f.ownerId,
    standing,
  );
  assert.equal(queue.count, 1, 'the coordinator is not being asked about the submitted evidence');
  assert.equal(
    queue.pending[0]!.independence.independent, true,
    'the queue says this coordinator may not answer its own project\'s evidence',
  );
  assert.equal(queue.pending[0]!.independence.disqualification, null);
  const ask = buildEvidenceAsk(queue);
  assert.ok(ask, 'the queue produced no question to ask');
  return ask;
}

/**
 * The runner's permission tool registers the call, exactly as `--permission-prompt-tool` does.
 *
 * Returns the row as stored, because what this file asserts about it — the tool it is for and that
 * it is still waiting on somebody — are columns rather than a response body.
 */
async function raiseApproval(stack: Stack, f: Fixture, ask: EvidenceAsk) {
  const raised = await stack.runner.createApproval(
    { id: f.runnerId },
    f.coordinatorSessionId,
    { toolName: EVIDENCE_ASK_TOOL, input: ask, toolUseId: `toolu_ask_${f.taskId}` },
  );
  return stack.db.approval.findUniqueOrThrow({ where: { id: raised.id } });
}

/** The person answers the card, and the runner reads their picks back off the row. */
async function answer(
  stack: Stack,
  f: Fixture,
  approvalId: string,
  question: EvidenceQuestion,
  label: string,
): Promise<QuestionAnswers> {
  const decided = await stack.sessions.decideApproval(
    f.ownerId,
    f.coordinatorSessionId,
    approvalId,
    { behavior: 'allow', answers: { [question.question]: [label] } },
  );
  assert.equal(decided.status, 'ALLOWED');
  const row = await stack.db.approval.findUniqueOrThrow({ where: { id: approvalId } });
  return (row.answers as QuestionAnswers | null) ?? {};
}

test('the delivered turn asks the person, and Confirm completion becomes this coordinator\'s decision',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'confirm');
      const claim = 'the delivered turn carries the card, and the pg spec drove it end to end';
      const gaps = ['nothing here proves a model chooses to call the tool'];

      const submitted = await stack.evidence.submit(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        {
          sourceSessionId: f.sourceSessionId,
          evidence: envelope(f, 'confirm', claim, gaps),
          idempotencyKey: 'ask-1-complete',
        },
      );
      assert.equal(submitted.revision, '1');

      // (0) The opening the turn arrived on. It names the tool, the two options, and carries the
      // card body verbatim — which is what makes the approval below the call this turn was told to
      // make rather than one the spec invented.
      const ask = await askFor(stack.db, f);
      assert.equal(ask.questions.length, 1);
      const question = ask.questions[0]!;
      const opening = await deliveredTurn(stack.db, f);
      for (const said of [EVIDENCE_ASK_TOOL, CONFIRM_OPTION, SEND_BACK_OPTION, question.question]) {
        assert.ok(opening.includes(said), `the opening never says ${JSON.stringify(said)}`);
      }

      // The card says what is being confirmed, in the order a reader needs it: the claim leads,
      // the standard it is measured against is next, and the gaps the submitter declared are last.
      assert.ok(question.question.startsWith(claim), 'the card does not lead with the claim');
      assert.ok(
        question.question.indexOf(STANDARD) > question.question.indexOf(claim),
        'the card states the criterion before the claim it is measuring',
      );
      assert.ok(
        question.question.indexOf(gaps[0]!) > question.question.indexOf(STANDARD),
        'the card states the declared gaps before the criterion',
      );
      assert.equal(question.header, EVIDENCE_ASK_HEADER);
      assert.ok(question.header.length <= 12, 'the header is longer than a header may be');
      assert.deepEqual(
        question.options.map((option) => option.label), [CONFIRM_OPTION, SEND_BACK_OPTION],
        'the card does not offer the decision rail\'s own two options',
      );
      // And the labels are those WORDS, spelled out rather than compared to themselves: the two
      // constants are imported from the unit under test, so an assertion made only against them
      // would follow a rename instead of catching one. `DecisionRail.tsx` exports these same two
      // strings, and a person meeting this card in the transcript and that one on the rail is
      // being asked one question.
      assert.deepEqual(
        question.options.map((option) => option.label), ['Confirm completion', 'Send back'],
        'the card no longer uses the decision card\'s wording',
      );
      assert.equal(question.multiSelect, false);

      // (1) The approval row: raised through the runner's own door, on the CONVERSATION rather than
      // on the run that did the work, and waiting on somebody.
      const approval = await raiseApproval(stack, f, ask);
      // The tool is named twice on purpose: once against the constant the delivery is built from,
      // and once against the WORD, because a rename would move the constant and both sides of an
      // assertion made only against it.
      assert.equal(approval.toolName, EVIDENCE_ASK_TOOL);
      assert.equal(approval.toolName, 'AskUserQuestion');
      assert.equal(approval.status, 'PENDING', 'the card was answered by something automatic');
      assert.equal(approval.sessionId, f.coordinatorSessionId);
      assert.equal(approval.decidedAt, null);
      assert.deepEqual(
        approval.input, JSON.parse(JSON.stringify(ask)),
        'the card that landed is not the one built from the queue',
      );

      // The paired positive for the absence asserted below: the door DOES raise
      // REQUIRES_INDEPENDENT_SESSION, and it raises it for the run that submitted this evidence.
      // Without this, "the coordinator was never refused" would be green over a build with no
      // independence check at all.
      await assert.rejects(
        () => stack.evidence.decide(
          f.ownerId,
          f.taskId,
          { type: CreatorType.AGENT, id: f.workspaceId },
          { decidingSessionId: f.sourceSessionId, decision: 'CONFIRM', evidenceRevision: '1' },
        ),
        (error: unknown) => refusalCode(error) === REQUIRES_INDEPENDENT_SESSION_CODE,
        'the run that did the work was allowed to confirm its own evidence',
      );
      assert.equal(await stack.db.taskEvidenceDecision.count({ where: { taskId: f.taskId } }), 0);

      // (2) The person picks, and the pick is read back through the same transport the runner
      // reads it through.
      const answers = await answer(stack, f, approval.id, question, CONFIRM_OPTION);
      assert.deepEqual(answers, { [question.question]: [CONFIRM_OPTION] });
      assert.equal(evidenceDecisionFromAnswers(question, answers), 'CONFIRM');

      // (3) And the coordinator records it. Not refused — for want of independence or for anything
      // else — which is asserted by letting the call throw rather than by catching it.
      const decided = await stack.evidence.decide(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        {
          decidingSessionId: f.coordinatorSessionId,
          decision: evidenceDecisionFromAnswers(question, answers)!,
          evidenceRevision: '1',
        },
      );
      assert.equal(decided.decision, 'CONFIRM');

      const project = await stack.db.project.findUniqueOrThrow({
        where: { id: f.projectId },
        select: { coordinatorSessionId: true },
      });
      const rows = await stack.db.taskEvidenceDecision.findMany({
        where: { taskId: f.taskId },
        select: { decision: true, note: true, decidingSessionId: true },
      });
      assert.equal(rows.length, 1, 'the answer did not reach the ledger as exactly one row');
      assert.equal(rows[0]!.decision, 'CONFIRM');
      assert.equal(
        rows[0]!.decidingSessionId, project.coordinatorSessionId,
        'the decision is not bound to the conversation the project is coordinated from',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('Send back with no note is refused, and the same send-back with one is recorded',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'sendback');

      await stack.evidence.submit(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        {
          sourceSessionId: f.sourceSessionId,
          evidence: envelope(f, 'sendback', 'the command ran, and the artifact is not named', []),
          idempotencyKey: 'ask-1-complete',
        },
      );

      const ask = await askFor(stack.db, f);
      const question = ask.questions[0]!;
      const approval = await raiseApproval(stack, f, ask);
      assert.equal(approval.toolName, EVIDENCE_ASK_TOOL);
      assert.equal(approval.status, 'PENDING');

      const answers = await answer(stack, f, approval.id, question, SEND_BACK_OPTION);
      assert.equal(evidenceDecisionFromAnswers(question, answers), 'SEND_BACK');

      // The other half of check 4: a rejection nobody can act on is not recorded at all. The
      // coordinator is independent and the revision is current, so this refusal is the note's and
      // nothing else's.
      await assert.rejects(
        () => stack.evidence.decide(
          f.ownerId,
          f.taskId,
          { type: CreatorType.AGENT, id: f.workspaceId },
          {
            decidingSessionId: f.coordinatorSessionId,
            decision: 'SEND_BACK',
            evidenceRevision: '1',
          },
        ),
        (error: unknown) => refusalCode(error) === SEND_BACK_NOTE_CODE,
        'a send-back with nothing to aim at was recorded',
      );
      assert.equal(await stack.db.taskEvidenceDecision.count({ where: { taskId: f.taskId } }), 0);

      // The paired positive, so "nothing was written" above is a refusal rather than a door that
      // writes nothing either way: the same answer WITH a note lands.
      const note = 'name the artifact the command produced, and quote the line that names it';
      const decided = await stack.evidence.decide(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        {
          decidingSessionId: f.coordinatorSessionId,
          decision: 'SEND_BACK',
          evidenceRevision: '1',
          note,
        },
      );
      assert.equal(decided.decision, 'SEND_BACK');
      assert.equal(decided.note, note);

      const rows = await stack.db.taskEvidenceDecision.findMany({
        where: { taskId: f.taskId },
        select: { decision: true, note: true, decidingSessionId: true },
      });
      assert.deepEqual(rows, [{
        decision: 'SEND_BACK',
        note,
        decidingSessionId: f.coordinatorSessionId,
      }]);
      // SEND_BACK writes its row and nothing else: the task is still waiting for a next revision.
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
        TaskStatus.IN_PROGRESS,
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the coordinator-evidence-ask PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
