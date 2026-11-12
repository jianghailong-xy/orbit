import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ConflictException } from '@nestjs/common';
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
import { EvidenceReviewService } from '../tasks/evidence-review.service';
import { readPendingEvidenceJudgments } from '../tasks/pending-evidence-judgments';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { criterionStandingRefusal } from '../tasks/task-evidence-decision';
import { CompletionEvidenceProducer } from './completion-evidence.producer';
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
import { DependentReadyProducer } from './dependent-ready.producer';
import { criterionKeyOf } from './project-acceptance';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskDispatchRefusalProducer } from './task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * THE SERVER BINDS THE STANDARD A REVISION IS JUDGED AGAINST.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/evidence-server-binds-standard.pg.spec.ts
 *
 * WHAT WENT WRONG
 * ===============
 * On 2026-11-12 task D of project 34vcDOhN0OCStfnVuTyPq (34vcF5TXYgAVx3dCr6pnS) declared no
 * criterionKey, so it was held to its own acceptanceCriteria — but its run, told to copy a criterion
 * from project_get, quoted ANOTHER criterion of the project in revision 1. The decision door compared
 * that quote with the live standard and refused it, the coordinator was never handed it, and it sat
 * for 3 h 46 min (docs/evidence-always-has-an-addressee-design.md §1–§2).
 *
 * Now the server writes the standard the task is held to into the revision at submit time — the
 * declared criterion's key and live text, else the task's public id and its acceptanceCriteria — and
 * the envelope's own `criterion` is accepted and dropped. The door holds that snapshot against the
 * live standard, through the one predicate every reader shares (`criterionStandingRefusal`).
 *
 * WHAT EACH CASE HOLDS
 * ====================
 *   (1) An envelope shaped exactly like task D's revision 1 — an undeclared project task quoting
 *       another project criterion, two TOOL_CALL checks (one with command and succeeded, one with
 *       succeeded alone) and six gaps — is stored with the task's own standard, is decidable on the
 *       predicate and on the pending read, is handed to the Automatic coordinator, and the
 *       coordinator's CONFIRM settles it DONE.
 *   (2) An envelope with no `criterion` at all is accepted for a declared task, bound to that
 *       criterion, and decidable: the coordinator's CONFIRM settles it.
 *   (3) Rewording the declared criterion after submission makes the revision undecidable: the
 *       predicate, the pending read and the door all refuse it, and nothing is written.
 *   (4) A revision stored before the server bound the standard — the submitter's quote in the row —
 *       behaves as before: a quote of another criterion is refused as it always was, and a quote of
 *       the live standard is decided.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Task D's own acceptanceCriteria, word for word. */
const OWN_CRITERIA =
  'Android unit tests cover parsing of the new fields, the toggle, the failure actions and copy parity with Swift and '
  + 'web. `./gradlew testDebugUnitTest assembleDebug` passes. Screenshots of the Settings group and a translated '
  + 'conversation are uploaded and match board frames 9–10.';
/** The project criterion task D's revision 1 quoted instead, word for word. */
const OTHER_CRITERION =
  'Assistant prose replies are translated after each text block completes and shown translated with a per-message '
  + 'Show original toggle on all three clients; tool calls, output, thinking and code are untouched.';
/** A second criterion of the project, the one case (2)'s and (3)'s tasks declare. */
const DECLARED_CRITERION = 'Settings › Translation saves each change on its own and is off by default.';

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
  evidence: TaskCompletionEvidenceService;
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
    undefined,
    producer,
  );
  return {
    db,
    prisma,
    evidence: new TaskCompletionEvidenceService(
      prisma, undefined, router, undefined, new EvidenceReviewService(prisma, sessions),
    ),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  /** The criterion task D quoted, which no task here declares. */
  otherDefinitionId: string;
  /** The criterion a declared task here declares. */
  declaredDefinitionId: string;
}

interface Judged {
  taskId: string;
  runSessionId: string;
  /** The two tool calls the evidence cites: the gate, and the targeted rerun. */
  gate: string;
  rerun: string;
}

async function conversation(
  db: PrismaClient,
  w: Pick<World, 'ownerId' | 'workspaceId' | 'runnerId'>,
  title: string,
  taskId?: string,
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId,
      startsTaskWork: taskId !== undefined,
      title,
      prompt: title,
      provider: 'claude',
      status: taskId === undefined ? RunStatus.AWAITING_INPUT : RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      ...(taskId === undefined ? { titleManagedByProject: true } : {}),
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

/** One owner, an Automatic project with a live coordinator conversation, and two criteria. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: { id: ids.ownerId, email: `${label}-${ids.ownerId}@binds-standard.invalid`, name: label, passwordHash: 'x' },
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
    data: { id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-ws`, enabled: true },
  });
  const coordinatorSessionId = await conversation(db, ids, `Coordinator: ${label}`);
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId: ids.ownerId,
      title: `${label} translation`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: ids.workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const otherDefinitionId = randomUUID();
  const declaredDefinitionId = randomUUID();
  for (const [ordinal, id, text] of [
    [1, otherDefinitionId, OTHER_CRITERION],
    [2, declaredDefinitionId, DECLARED_CRITERION],
  ] as const) {
    await db.projectAcceptanceCriterionDefinition.create({
      data: { id, projectId, ordinal, text, verificationMethod: 'Read the evidence.', contentHash: '0'.repeat(64) },
    });
  }
  return { ...ids, projectId, coordinatorSessionId, otherDefinitionId, declaredDefinitionId };
}

/** An EVIDENCE_JUDGMENT task of the project, declaring `declares` or nothing, with its run. */
async function judgedTask(db: PrismaClient, w: World, label: string, declares: string | null): Promise<Judged> {
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId: w.ownerId,
      projectId: w.projectId,
      title: `${label} Android translation`,
      creatorType: CreatorType.USER,
      creatorId: w.ownerId,
      assigneeId: w.workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: OWN_CRITERIA,
      criterionDefinitionId: declares,
      criterionRevision: declares === null ? null : 1,
    },
  });
  const runSessionId = await conversation(db, w, `${label} run`, taskId);
  const gate = `bgj_gate_${taskId.slice(0, 8)}`;
  const rerun = `bgj_rerun_${taskId.slice(0, 8)}`;
  for (const [toolUseId, command] of [
    [gate, '/mnt/data/tmp/34vcF5TXYgAVx3dCr6pnS/gradle.sh testDebugUnitTest assembleDebug'],
    [rerun, '/mnt/data/tmp/34vcF5TXYgAVx3dCr6pnS/web-parity.sh'],
  ] as const) {
    await db.toolCall.create({
      data: { sessionId: runSessionId, name: 'Bash', toolUseId, input: { command }, isError: false },
    });
  }
  return { taskId, runSessionId, gate, rerun };
}

/**
 * Task D's revision 1, field for field: its claim, a criterion quoting ANOTHER project criterion,
 * a TOOL_CALL with command and succeeded, a TOOL_CALL with succeeded alone, and six gaps. Its three
 * FILE checks are left out: they cite uploaded bytes, and this spec is about the criterion.
 */
function taskDRevisionOne(w: World, t: Judged): Record<string, unknown> {
  return {
    gaps: [
      'Swift parity is not established: the iOS/macOS task has no translation copy yet, so iosAndMacosSayTheSameWords skips on this tree. It runs for real once that copy lands.',
      'Web parity was proven against the web task\'s uncommitted files laid over this tree (bgj_e3e77fab5be1, webSaysTheSameWords PASSED). On this branch alone it skips until the web task lands.',
      'Screenshots are Compose/Robolectric NATIVE renders of the production screens over a fake server, not an emulator. The language bottom sheet is covered by assertions but not by a screenshot.',
      'The full gate ran at 377830ddf. 806f9fa6b changes only the parity test\'s source set, verified by the targeted rerun in bgj_e3e77fab5be1.',
      'Frame 9\'s switch description uses the web\'s full hint text, not the board\'s shortened phone wording, so all three clients keep identical copy.',
      'No live apiserver or DeepSeek round trip was exercised; the wire shapes come from src/shared/src/translation.ts.',
    ],
    claim: 'Android Settings › Translation and translated conversations (commits 377830ddf, 806f9fa6b).',
    checks: [
      {
        ref: t.gate,
        kind: 'TOOL_CALL',
        command: '/mnt/data/tmp/34vcF5TXYgAVx3dCr6pnS/gradle.sh testDebugUnitTest assembleDebug',
        succeeded: true,
      },
      { ref: t.rerun, kind: 'TOOL_CALL', succeeded: true },
    ],
    criterion: { key: criterionKeyOf(w.otherDefinitionId), text: OTHER_CRITERION },
  };
}

function submit(stack: Stack, w: World, t: Judged, evidence: Record<string, unknown>, key: string) {
  return stack.evidence.submit(
    w.ownerId,
    t.taskId,
    { type: CreatorType.AGENT, id: w.workspaceId },
    { sourceSessionId: t.runSessionId, idempotencyKey: key, evidence },
  );
}

function confirm(stack: Stack, w: World, t: Judged, revision: string) {
  return stack.evidence.decide(
    w.ownerId,
    t.taskId,
    { type: CreatorType.AGENT, id: w.workspaceId },
    { decidingSessionId: w.coordinatorSessionId, evidenceRevision: revision, decision: 'CONFIRM' },
  );
}

/** The task row as the shared predicate reads it, and the stored evidence of one revision. */
async function standing(stack: Stack, t: Judged, revision: bigint) {
  const task = await stack.db.task.findUniqueOrThrow({
    where: { id: t.taskId },
    select: { projectId: true, criterionDefinitionId: true, criterionRevision: true, acceptanceCriteria: true },
  });
  const row = await stack.db.taskCompletionEvidence.findUniqueOrThrow({
    where: { taskId_revision: { taskId: t.taskId, revision } },
    select: { evidence: true },
  });
  return { evidence: row.evidence as Record<string, unknown>, refusal: await criterionStandingRefusal(stack.prisma, task, row.evidence) };
}

/**
 * The pending read's row for this task. A decidable row is asked of a reader that may decide it;
 * in an Automatic project nobody else is asked while its coordinator holds the row or the row waits
 * for it, so the read is made with the switch off for that moment — the owner's card, drawn on the
 * coordinator's conversation — and the switch is turned back on. An undecidable row is put in front
 * of the run that has to file the next revision (`waitingOnYou`), and of nobody else.
 */
async function pendingRow(stack: Stack, w: World, t: Judged, as: 'coordinator' | 'run') {
  if (as === 'coordinator') {
    await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorEnabled: false } });
    try {
      const read = await readPendingEvidenceJudgments(stack.prisma, w.ownerId, { id: w.coordinatorSessionId, taskId: null });
      return read.pending.find((row) => row.taskId === t.taskId);
    } finally {
      await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorEnabled: true } });
    }
  }
  const read = await readPendingEvidenceJudgments(stack.prisma, w.ownerId, { id: t.runSessionId, taskId: t.taskId });
  return read.waitingOnYou.find((row) => row.taskId === t.taskId);
}

/** The wake the revision raised for the project's coordinator. */
async function wakeOf(stack: Stack, t: Judged) {
  const wakes = await stack.db.projectCoordinatorWake.findMany({
    where: { event: 'COMPLETION_EVIDENCE_REVISED', subjectType: 'TASK', subjectId: t.taskId },
    select: { status: true, sessionId: true, refusalCode: true, consumerType: true },
  });
  assert.equal(wakes.length, 1, 'the revision reached the wake ledger other than once');
  return wakes[0]!;
}

const taskStatus = async (stack: Stack, t: Judged) =>
  (await stack.db.task.findUniqueOrThrow({ where: { id: t.taskId } })).status;

// -------------------------------------------------------------------------------------------------

test('(1) task D\'s revision 1 — another project criterion quoted — is decidable and handed to the coordinator',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack.db, 'task-d');
      const t = await judgedTask(stack.db, w, 'task-d', null);
      const receipt = await submit(stack, w, t, taskDRevisionOne(w, t), `${t.taskId}-evidence-1b`);
      assert.equal(receipt.revision, '1');

      // The quote was dropped: the revision carries the standard the task is held to, its own criteria.
      const ownStandard = { key: uuidToBase62(t.taskId), text: OWN_CRITERIA };
      assert.deepEqual((receipt.evidence as Record<string, unknown>).criterion, ownStandard);
      assert.deepEqual(receipt.criterionMatch, { ...ownStandard, matchesLive: true });
      const stored = await standing(stack, t, 1n);
      assert.deepEqual(stored.evidence.criterion, ownStandard);
      assert.equal(stored.refusal, null, `the shared predicate refuses it: ${stored.refusal?.reason}`);
      // Everything else of the envelope is stored as it was sent.
      const sent = taskDRevisionOne(w, t);
      assert.deepEqual(stored.evidence.claim, sent.claim);
      assert.deepEqual(stored.evidence.checks, sent.checks);
      assert.deepEqual(stored.evidence.gaps, sent.gaps);

      // Handed to the Automatic coordinator to decide, not recorded for nobody.
      const wake = await wakeOf(stack, t);
      assert.equal(wake.status, 'DELIVERED', `refused with ${wake.refusalCode}`);
      assert.equal(wake.sessionId, w.coordinatorSessionId);
      const row = await pendingRow(stack, w, t, 'coordinator');
      assert.ok(row, 'the pending read does not list the revision');
      assert.deepEqual(row.decidability, { decidable: true, refusal: null, requiredAction: null });
      assert.deepEqual(row.criterion, ownStandard);

      // And the coordinator's CONFIRM settles it.
      const decided = await confirm(stack, w, t, '1');
      assert.equal(decided.decision, 'CONFIRM');
      assert.equal(await taskStatus(stack, t), TaskStatus.DONE);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(2) an envelope without `criterion` is accepted, bound to the declared criterion, and decidable',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack.db, 'no-quote');
      const t = await judgedTask(stack.db, w, 'no-quote', w.declaredDefinitionId);
      const { criterion: _dropped, ...envelope } = taskDRevisionOne(w, t);
      assert.equal('criterion' in envelope, false);
      const receipt = await submit(stack, w, t, envelope, `${t.taskId}-evidence-1`);
      assert.equal(receipt.revision, '1');

      const declared = { key: criterionKeyOf(w.declaredDefinitionId), text: DECLARED_CRITERION };
      assert.deepEqual(receipt.criterionMatch, { ...declared, matchesLive: true });
      const stored = await standing(stack, t, 1n);
      assert.deepEqual(stored.evidence.criterion, declared);
      assert.equal(stored.refusal, null, `the shared predicate refuses it: ${stored.refusal?.reason}`);
      assert.equal((await wakeOf(stack, t)).status, 'DELIVERED');
      assert.equal((await pendingRow(stack, w, t, 'coordinator'))?.decidability.decidable, true);

      // A retry of the same submission replays the same revision.
      const replay = await submit(stack, w, t, envelope, `${t.taskId}-evidence-1`);
      assert.equal(replay.revision, '1');
      assert.equal(replay.evidenceDigest, receipt.evidenceDigest);

      await confirm(stack, w, t, '1');
      assert.equal(await taskStatus(stack, t), TaskStatus.DONE);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(3) rewording the declared criterion after submission makes the revision undecidable',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack.db, 'reworded');
      const t = await judgedTask(stack.db, w, 'reworded', w.declaredDefinitionId);
      await submit(stack, w, t, taskDRevisionOne(w, t), `${t.taskId}-evidence-1`);
      assert.equal((await standing(stack, t, 1n)).refusal, null, 'decidable before the rewording');

      await stack.db.projectAcceptanceCriterionDefinition.update({
        where: { id: w.declaredDefinitionId },
        data: { text: `${DECLARED_CRITERION} It also syncs across devices.` },
      });

      // The snapshot still says what the criterion said; the live standard no longer does.
      const stored = await standing(stack, t, 1n);
      assert.deepEqual(stored.evidence.criterion, {
        key: criterionKeyOf(w.declaredDefinitionId), text: DECLARED_CRITERION,
      });
      assert.ok(stored.refusal, 'the shared predicate still finds a live standard');
      assert.match(stored.refusal.reason, /is not what the project states today/);
      const row = await pendingRow(stack, w, t, 'run');
      assert.ok(row, 'the run that has to resubmit is not shown the undecidable revision');
      assert.equal(row.decidability.decidable, false);
      assert.equal(row.decidability.requiredAction, 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION');

      await assert.rejects(confirm(stack, w, t, '1'), (error: unknown) => {
        assert.ok(error instanceof ConflictException, String(error));
        const body = error.getResponse() as { code?: string; requiredAction?: string };
        assert.equal(body.code, 'EVIDENCE_JUDGMENT_CRITERION_MOVED');
        assert.equal(body.requiredAction, 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION');
        return true;
      });
      assert.equal(await stack.db.taskEvidenceDecision.count({ where: { taskId: t.taskId } }), 0);
      assert.equal(await taskStatus(stack, t), TaskStatus.IN_PROGRESS);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(4) a revision stored before the server bound the standard behaves as it always did',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack.db, 'stored-before');
      // A row the way submit wrote it before this change: the submitter's quote, kept as sent.
      const storeAsBefore = async (t: Judged, criterion: { key: string; text: string }, revision: bigint) => {
        const evidence = { ...taskDRevisionOne(w, t), criterion };
        await stack.db.taskCompletionEvidence.create({
          data: {
            taskId: t.taskId,
            ownerId: w.ownerId,
            actorType: CreatorType.AGENT,
            actorId: w.workspaceId,
            sourceSessionId: t.runSessionId,
            criterionRevision: revision.toString().padStart(64, '0'),
            criterion: { schemaVersion: 1 },
            evidence,
            evidenceDigest: randomUUID().replace(/-/g, '').padEnd(64, '0'),
            revision,
          },
        });
      };

      // Task D's revision 1 as it was stored on 2026-11-12: refused, for the reason it always was.
      const taskD = await judgedTask(stack.db, w, 'old-task-d', null);
      await storeAsBefore(taskD, { key: criterionKeyOf(w.otherDefinitionId), text: OTHER_CRITERION }, 1n);
      const refused = await standing(stack, taskD, 1n);
      assert.ok(refused.refusal, 'an old quote of another criterion became decidable');
      assert.match(refused.refusal.reason, /the acceptance criteria this evidence quotes are not what this task states today/);
      assert.equal((await pendingRow(stack, w, taskD, 'run'))?.decidability.decidable, false);
      await assert.rejects(confirm(stack, w, taskD, '1'), (error: unknown) => {
        assert.ok(error instanceof ConflictException, String(error));
        assert.equal((error.getResponse() as { code?: string }).code, 'EVIDENCE_JUDGMENT_CRITERION_MOVED');
        return true;
      });

      // A declared task's old quote of a criterion it does not declare: refused as it always was.
      const declared = await judgedTask(stack.db, w, 'old-declared', w.declaredDefinitionId);
      await storeAsBefore(declared, { key: criterionKeyOf(w.otherDefinitionId), text: OTHER_CRITERION }, 1n);
      const wrongKey = await standing(stack, declared, 1n);
      assert.match(wrongKey.refusal?.reason ?? '', /is not the one this task declares/);

      // An old quote of the live standard: decided, as it always was.
      const right = await judgedTask(stack.db, w, 'old-right', null);
      await storeAsBefore(right, { key: uuidToBase62(right.taskId), text: OWN_CRITERIA }, 1n);
      assert.equal((await standing(stack, right, 1n)).refusal, null);
      assert.equal((await pendingRow(stack, w, right, 'coordinator'))?.decidability.decidable, true);
      await confirm(stack, w, right, '1');
      assert.equal(await taskStatus(stack, right), TaskStatus.DONE);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the binds-standard PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
