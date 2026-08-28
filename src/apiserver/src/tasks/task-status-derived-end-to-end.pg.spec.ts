/**
 * N9: one real-PostgreSQL replay of the complete fact-driven completion protocol.
 *
 * The three source sessions deliberately begin and end AWAITING_INPUT. Ordinary comments are
 * written before any evidence and are never imported. Every optimistic Task status transition is
 * observed by a test-only database trigger which refuses the transition unless its declared
 * criterion fact is already visible in that same transaction.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must identify the disposable database accepted by
 * the coordinator PG safety guard, with migrations through 0184 applied.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  ProjectAcceptanceVerdict,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectsService } from '../projects/projects.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { JudgmentDeliveryService } from '../push/judgment-delivery.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TaskJudgmentReviewService } from './task-judgment-review.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const FACT_TRIGGER = 'n9_task_done_requires_current_fact';
const FACT_FUNCTION = 'n9_task_done_requires_current_fact_fn';
const FACT_AUDIT = 'n9_task_done_derivation_audit';

function completionRouter(db: PrismaClient): CompletionInputRouter {
  return new CompletionInputRouter(
    new CoordinatorWakeService(db as unknown as PrismaService),
  );
}

function taskService(db: PrismaClient, completionInputs: CompletionInputRouter): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('the N9 fixture creates sessions explicitly'); } } as never,
    {
      publishForUser: () => undefined,
      publishTaskChanged: () => undefined,
    } as unknown as RealtimeService,
    undefined,
    completionInputs,
  );
}

function runnerController(
  db: PrismaClient,
  completionInputs: CompletionInputRouter,
): RunnerApiController {
  const realtime = {
    publishSessionUpdated: () => undefined,
    publishTaskChanged: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
    publish: () => undefined,
    notifyInbox: () => undefined,
    waitForInbox: async () => undefined,
  } as unknown as RealtimeService;
  return new RunnerApiController(
    db as unknown as PrismaService,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    completionInputs,
  );
}

function enabledPushConfig(): ConfigService {
  const values: Record<string, string> = {
    APNS_KEY_ID: 'n9-key',
    APNS_TEAM_ID: 'n9-team',
    APNS_KEY: Buffer.from('n9-test-key').toString('base64'),
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

async function resetDatabase(sql: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`
    DROP TRIGGER IF EXISTS "${FACT_TRIGGER}" ON "task";
    DROP FUNCTION IF EXISTS "${FACT_FUNCTION}"();
    DROP TABLE IF EXISTS "${FACT_AUDIT}";
    TRUNCATE "task", "session", "workspace", "runner", "project_runtime", "project", "user"
      RESTART IDENTITY CASCADE
  `);
}

/**
 * Observe the exact database boundary, rather than trusting that the service method which returned
 * DONE took the intended branch. The carrier verifier is special: its verdict and derived terminal
 * status are one UPDATE, while its request decision is the next statement in the same transaction.
 */
async function installDerivedDoneGuard(sql: Client): Promise<void> {
  await sql.query(`
    CREATE UNLOGGED TABLE "${FACT_AUDIT}" (
      "task_id" uuid NOT NULL,
      "derivation" text NOT NULL,
      "old_status" text NOT NULL,
      "new_status" text NOT NULL,
      "observed_at" timestamptz NOT NULL DEFAULT statement_timestamp()
    );

    CREATE FUNCTION "${FACT_FUNCTION}"() RETURNS trigger AS $$
    DECLARE
      derivation text;
    BEGIN
      IF OLD."status" IS DISTINCT FROM NEW."status"
         AND NEW."status" = 'DONE'::task_status THEN
        IF NEW."verifies_task_id" IS NOT NULL AND NEW."verdict" = 'PASS'::task_verdict THEN
          IF NOT EXISTS (
            SELECT 1
              FROM "task_judgment_request" request
             WHERE request."id" = NEW."id"
               AND request."task_id" = NEW."verifies_task_id"
               AND request."kind" = 'VERIFICATION'
               AND request."status" IN ('OPEN', 'DECIDED')
          ) THEN
            RAISE EXCEPTION 'N9_DIRECT_DONE: verifier carrier has no evidence-bound request';
          END IF;
          derivation := 'VERIFIER_VERDICT';
        ELSIF NEW."completion_criterion" = 'EXECUTABLE'::task_completion_criterion THEN
          IF NOT EXISTS (
            SELECT 1
              FROM "task_judgment_request" request
              JOIN "task_executable_judgment_result" result
                ON result."request_id" = request."id"
             WHERE request."task_id" = NEW."id"
               AND request."kind" = 'EXECUTABLE'
               AND request."status" = 'DECIDED'
               AND request."decision" = 'PASS'
               AND result."actual_exit_code" = result."expected_exit_code"
          ) THEN
            RAISE EXCEPTION 'N9_DIRECT_DONE: EXECUTABLE has no passing command-result fact';
          END IF;
          derivation := 'EXECUTABLE_RESULT';
        ELSIF NEW."completion_criterion" = 'VERIFICATION'::task_completion_criterion THEN
          IF NOT EXISTS (
            SELECT 1
              FROM "task" verifier
              JOIN "task_judgment_request" request ON request."id" = verifier."id"
             WHERE verifier."verifies_task_id" = NEW."id"
               AND verifier."status" = 'DONE'::task_status
               AND verifier."verdict" = 'PASS'::task_verdict
               AND request."task_id" = NEW."id"
               AND request."status" = 'DECIDED'
               AND request."decision" = 'PASS'
          ) THEN
            RAISE EXCEPTION 'N9_DIRECT_DONE: VERIFICATION has no independent passing verdict fact';
          END IF;
          derivation := 'VERIFICATION_PASS';
        ELSIF NEW."completion_criterion" = 'HUMAN_SIGNOFF'::task_completion_criterion THEN
          IF NOT EXISTS (
            SELECT 1
              FROM "task_human_signoff" signoff
              JOIN "task_judgment_request" request ON request."id" = signoff."request_id"
             WHERE signoff."task_id" = NEW."id"
               AND signoff."signed_by_id" IS NOT NULL
               AND signoff."signed_at" IS NOT NULL
               AND length(btrim(signoff."evidence")) > 0
               AND request."status" = 'DECIDED'
               AND request."decision" = 'PASS'
               AND request."decided_by_type" = 'USER'
          ) THEN
            RAISE EXCEPTION 'N9_DIRECT_DONE: HUMAN_SIGNOFF has no signed current-request fact';
          END IF;
          IF EXISTS (
            SELECT 1 FROM "task_judgment_signal" signal
             WHERE signal."task_id" = NEW."id"
          ) OR EXISTS (
            SELECT 1 FROM "project_judgment_blocker" blocker
             WHERE blocker."task_id" = NEW."id"
          ) THEN
            RAISE EXCEPTION 'N9_ATOMIC_CLOSE: request signal or blocker is still open';
          END IF;
          derivation := 'HUMAN_SIGNOFF';
        ELSE
          RAISE EXCEPTION 'N9_DIRECT_DONE: no declared completion fact owns this transition';
        END IF;

        INSERT INTO "${FACT_AUDIT}" ("task_id", "derivation", "old_status", "new_status")
        VALUES (NEW."id", derivation, OLD."status"::text, NEW."status"::text);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER "${FACT_TRIGGER}"
      BEFORE UPDATE OF "status" ON "task"
      FOR EACH ROW EXECUTE FUNCTION "${FACT_FUNCTION}"()
  `);
}

async function assertDirectDoneRefused(
  tasks: TasksService,
  db: PrismaClient,
  ownerId: string,
  taskId: string,
  actor: string,
  actingSessionId?: string,
): Promise<void> {
  const before = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { status: true, updatedAt: true },
  });
  await assert.rejects(
    tasks.update(ownerId, taskId, { status: TaskStatus.DONE } as never, actingSessionId),
    (error: unknown) => {
      assert.ok(error instanceof ForbiddenException, `${actor} received ${String(error)}`);
      const body = error.getResponse() as Record<string, unknown>;
      assert.equal(body.code, 'DIRECT_TASK_DONE_REFUSED', actor);
      assert.ok(body.requiredAction, `${actor} gets the criterion's usable route`);
      return true;
    },
  );
  const after = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { status: true, updatedAt: true },
  });
  assert.deepEqual(after, before, `${actor}'s refused request wrote no Task field`);
}

async function dependencyState(tasks: TasksService, ownerId: string, taskId: string) {
  return (await tasks.get(ownerId, taskId) as { dependencyState: string }).dependencyState;
}

suite(
  'N9 replays AWAITING_INPUT evidence through all three judgments and an acceptance-only doneGate without a direct DONE write',
  { timeout: 300_000 },
  async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    let deliveryWorker: JudgmentDeliveryService | undefined;
    t.after(async () => {
      deliveryWorker?.onModuleDestroy();
      await sql.query(`DROP TRIGGER IF EXISTS "${FACT_TRIGGER}" ON "task"`);
      await sql.query(`DROP FUNCTION IF EXISTS "${FACT_FUNCTION}"()`);
      await sql.query(`DROP TABLE IF EXISTS "${FACT_AUDIT}"`);
      await db.$disconnect();
      await sql.end();
    });
    await resetDatabase(sql);

    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `n9-${ownerId}@status-derived.invalid`,
        name: 'N9 human reviewer',
        passwordHash: 'x',
      },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: 'N9 disposable runner',
        tokenHash: 'x',
        status: RunnerStatus.ONLINE,
      },
    });
    await db.workspace.create({
      data: {
        id: workspaceId,
        ownerId,
        runnerId,
        name: 'N9 evidence agent',
        enabled: true,
      },
    });

    const prisma = db as unknown as PrismaService;
    const acceptance = new ProjectAcceptanceService(prisma);
    const projects = new ProjectsService(prisma, acceptance);
    const router = completionRouter(db);
    const tasks = taskService(db, router);
    const project = await projects.create(ownerId, {
      title: 'N9 structured completion replay',
      goal: 'Completion is a projection of explicit evidence and judgment facts.',
      acceptanceCriteriaItems: [
        {
          text: 'The executable declaration has a recorded matching exit code',
          verificationMethod: 'Inspect the request-bound raw command result and require exit code 0',
          completionCriterion: 'HUMAN_SIGNOFF',
        },
        {
          text: 'An independent verifier concludes PASS on the submitted revision',
          verificationMethod: 'Inspect the verifier task, its independent session, verdict and request audit',
          completionCriterion: 'HUMAN_SIGNOFF',
        },
        {
          text: 'A person signs the current evidence revision after reliable delivery',
          verificationMethod: 'Open the current inbox revision and inspect the human signature and delivery ledger',
          completionCriterion: 'HUMAN_SIGNOFF',
        },
      ],
    });
    const definitions = await db.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: project.id },
      orderBy: { ordinal: 'asc' },
    });
    assert.equal(project.acceptanceCriteriaFormat, 'STRUCTURED');
    assert.equal(definitions.length, 3);
    assert.ok(definitions.every((criterion) => criterion.verificationMethod.trim().length > 0));

    const executable = await tasks.create(ownerId, {
      title: 'N9 EXECUTABLE',
      projectId: project.id,
      assigneeId: workspaceId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCriteria: 'The request-bound shell command exits zero.',
      acceptanceCommand: 'printf n9-executable',
      acceptanceExpectedExitCode: 0,
    });
    const verification = await tasks.create(ownerId, {
      title: 'N9 VERIFICATION',
      projectId: project.id,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      acceptanceCriteria: 'A different session checks the submitted artifact and records PASS.',
    });
    const human = await tasks.create(ownerId, {
      title: 'N9 HUMAN_SIGNOFF',
      projectId: project.id,
      assigneeId: workspaceId,
      completionCriterion: 'HUMAN_SIGNOFF',
      acceptanceCriteria: 'The account owner reviews and signs the current evidence revision.',
    });
    const downstream = await tasks.create(ownerId, {
      title: 'N9 downstream release',
      projectId: project.id,
      dependsOnTaskIds: [executable.id, verification.id, human.id],
      autoRunWhenReady: false,
      completionCriterion: 'HUMAN_SIGNOFF',
    });
    assert.deepEqual(
      [executable, verification, human].map((task) => task.completionCriterion),
      ['EXECUTABLE', 'VERIFICATION', 'HUMAN_SIGNOFF'],
    );

    // Fixture precondition only: the replay starts after work began. From this point forward every
    // optimistic transition is guarded and audited by installDerivedDoneGuard.
    await db.task.updateMany({
      where: { id: { in: [executable.id, verification.id, human.id] } },
      data: { status: TaskStatus.IN_PROGRESS },
    });

    const sourceSessions = {
      executable: randomUUID(),
      verification: randomUUID(),
      human: randomUUID(),
    };
    await db.session.createMany({
      data: [
        [sourceSessions.executable, executable.id, 'N9 executable evidence'],
        [sourceSessions.verification, verification.id, 'N9 verification evidence'],
        [sourceSessions.human, human.id, 'N9 human evidence'],
      ].map(([id, taskId, title]) => ({
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        workspaceId,
        assignedRunnerId: runnerId,
        title,
        prompt: 'Submit explicit structured evidence, then wait.',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      })),
    });
    const coordinatorSessionId = randomUUID();
    await db.session.create({
      data: {
        id: coordinatorSessionId,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: 'N9 notification/coordinator negative control',
        prompt: 'This principal cannot declare a task complete.',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
        startsTaskWork: false,
      },
    });
    await installDerivedDoneGuard(sql);

    // N8: every public actor receives the same refusal before a database write is attempted.
    await assertDirectDoneRefused(tasks, db, ownerId, human.id, 'person/front end');
    await assertDirectDoneRefused(
      tasks, db, ownerId, executable.id, 'task execution agent', sourceSessions.executable,
    );
    await assertDirectDoneRefused(
      tasks, db, ownerId, verification.id, 'coordinator judgment', coordinatorSessionId,
    );

    // N10 negative control: emphatic completion prose is still just timeline prose.
    const commentMarker = 'N9_COMMENT_MUST_NOT_BECOME_EVIDENCE: complete, PASS, DONE';
    await db.taskComment.createMany({
      data: [executable.id, verification.id, human.id].map((taskId) => ({
        taskId,
        authorType: CreatorType.AGENT,
        authorId: workspaceId,
        body: commentMarker,
      })),
    });
    assert.equal(await db.taskCompletionEvidence.count({
      where: { taskId: { in: [executable.id, verification.id, human.id] } },
    }), 0);
    assert.equal(await db.taskJudgmentRequest.count({
      where: { taskId: { in: [executable.id, verification.id, human.id] } },
    }), 0);
    assert.equal(await db.taskLegacyEvidenceImport.count(), 0);
    assert.equal(await db.projectCoordinatorWake.count({
      where: { projectId: project.id, event: 'COMPLETION_EVIDENCE_REVISED' },
    }), 0);

    const evidence = new TaskCompletionEvidenceService(prisma, tasks, undefined, router);
    const executableEvidence = await evidence.submit(
      ownerId,
      executable.id,
      { type: CreatorType.AGENT, id: workspaceId },
      {
        sourceSessionId: sourceSessions.executable,
        idempotencyKey: 'n9-executable-revision-1',
        evidence: {
          commit: '1111111111111111',
          command: 'printf n9-executable',
          expectedExitCode: 0,
          artifact: 'build/n9-executable.txt',
        },
      },
    );
    const verificationEvidence = await evidence.submit(
      ownerId,
      verification.id,
      { type: CreatorType.AGENT, id: workspaceId },
      {
        sourceSessionId: sourceSessions.verification,
        idempotencyKey: 'n9-verification-revision-1',
        evidence: {
          commit: '2222222222222222',
          command: 'sha256sum build/n9-verification.txt',
          exitCode: 0,
          sha256: '2'.repeat(64),
        },
      },
    );
    const firstHumanEvidence = await evidence.submit(
      ownerId,
      human.id,
      { type: CreatorType.AGENT, id: workspaceId },
      {
        sourceSessionId: sourceSessions.human,
        idempotencyKey: 'n9-human-revision-1',
        evidence: {
          commit: '3333333333333333',
          testSummary: { command: 'npm test -w @orbit/web', exitCode: 0, passed: 1199 },
          artifact: 'build/n9-review-v1.json',
        },
      },
    );

    assert.deepEqual(
      [
        executableEvidence.judgmentRequest!.kind,
        verificationEvidence.judgmentRequest!.kind,
        firstHumanEvidence.judgmentRequest!.kind,
      ],
      ['EXECUTABLE', 'VERIFICATION', 'HUMAN_SIGNOFF'],
    );
    assert.deepEqual(
      [
        executableEvidence.judgmentRequest!.recipientType,
        verificationEvidence.judgmentRequest!.recipientType,
        firstHumanEvidence.judgmentRequest!.recipientType,
      ],
      ['SYSTEM_EXECUTABLE_EVALUATOR', 'VERIFIER_TASK', 'ACCOUNT_OWNER'],
    );
    assert.equal(executableEvidence.judgmentRequest!.recipientId, sourceSessions.executable);
    assert.equal(
      verificationEvidence.judgmentRequest!.recipientId,
      verificationEvidence.judgmentRequest!.id,
    );
    assert.equal(firstHumanEvidence.judgmentRequest!.recipientId, ownerId);
    assert.equal(await db.taskJudgmentRequest.count({
      where: {
        taskId: { in: [executable.id, verification.id, human.id] },
        status: 'OPEN',
      },
    }), 3);
    assert.ok((await db.task.findMany({
      where: { id: { in: [executable.id, verification.id, human.id] } },
      select: { status: true },
    })).every((task) => task.status === TaskStatus.IN_PROGRESS));
    assert.ok((await db.session.findMany({
      where: { id: { in: Object.values(sourceSessions) } },
      select: { status: true },
    })).every((session) => session.status === RunStatus.AWAITING_INPUT));
    assert.equal(await dependencyState(tasks, ownerId, downstream.id), 'BLOCKED');
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "task_judgment_signal"
        WHERE "task_id" = ANY($1::uuid[])`,
      [[executable.id, verification.id, human.id]],
    )).rows[0].n, 3);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "project_judgment_blocker"
        WHERE "task_id" = $1::uuid`,
      [human.id],
    )).rows[0].n, 1);

    // N1/N11 EXECUTABLE: the source was allowed to park before the explicit evidence arrived. It
    // resumes only to run the request-bound command, records raw output, then parks again.
    const messageTurnId = randomUUID();
    await db.session.update({
      where: { id: sourceSessions.executable },
      data: { status: RunStatus.RUNNING },
    });
    await db.conversationTurn.create({
      data: {
        id: messageTurnId,
        sessionId: sourceSessions.executable,
        seq: 1,
        clientTurnId: `message:${messageTurnId}`,
        kind: 'message',
        content: 'The structured evidence is submitted; run the declared command.',
        status: 'IN_FLIGHT',
      },
    });
    const api = runnerController(db, router);
    assert.deepEqual(
      await api.turnComplete({ id: runnerId }, sourceSessions.executable, {
        turnId: messageTurnId,
        status: SharedRunStatus.SUCCEEDED,
      }),
      { ok: true, status: RunStatus.RUNNING },
    );
    const acceptanceTurn = await (api as unknown as {
      dequeueTurn: (
        sessionId: string,
        runnerId: string,
        leaseGeneration: string | null,
      ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
    }).dequeueTurn(sourceSessions.executable, runnerId, null);
    assert.ok(acceptanceTurn);
    assert.equal(acceptanceTurn.kind, 'shell');
    assert.equal(acceptanceTurn.taskAcceptance, true);
    assert.equal(acceptanceTurn.content, 'printf n9-executable');
    const rawOutput = 'n9-executable\nraw-output-is-preserved';
    assert.deepEqual(
      await api.turnComplete({ id: runnerId }, sourceSessions.executable, {
        turnId: acceptanceTurn.turnId,
        status: SharedRunStatus.SUCCEEDED,
        subtype: 'shell',
        shellExitCode: 0,
        shellOutput: rawOutput,
      }),
      { ok: true, status: RunStatus.AWAITING_INPUT },
    );
    const executableResult = await db.taskExecutableJudgmentResult.findUniqueOrThrow({
      where: { requestId: executableEvidence.judgmentRequest!.id },
    });
    assert.equal(executableResult.command, 'printf n9-executable');
    assert.equal(executableResult.expectedExitCode, 0);
    assert.equal(executableResult.actualExitCode, 0);
    assert.equal(executableResult.rawOutput, rawOutput);
    assert.equal(executableResult.recordedById, runnerId);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: executable.id } })).status,
      TaskStatus.DONE);
    assert.equal((await db.taskJudgmentRequest.findUniqueOrThrow({
      where: { id: executableEvidence.judgmentRequest!.id },
    })).decision, 'PASS');
    assert.equal(await dependencyState(tasks, ownerId, downstream.id), 'BLOCKED');

    // N11 VERIFICATION: the evidence transaction created one deterministic carrier. A different
    // task-bound session supplies its verdict; neither source session nor subject may self-PASS.
    const verifier = await db.task.findUniqueOrThrow({
      where: { id: verificationEvidence.judgmentRequest!.id },
    });
    assert.equal(verifier.verifiesTaskId, verification.id);
    assert.equal(await db.task.count({ where: { verifiesTaskId: verification.id } }), 1);
    const verifierSessionId = randomUUID();
    await db.session.create({
      data: {
        id: verifierSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: verifier.id,
        workspaceId,
        assignedRunnerId: runnerId,
        title: 'N9 independent verifier',
        prompt: 'Independently inspect the evidence revision and record a verdict.',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
    await assertDirectDoneRefused(
      tasks, db, ownerId, verification.id, 'independent verifier', verifierSessionId,
    );
    await tasks.update(ownerId, verifier.id, { verdict: 'PASS' }, verifierSessionId);
    const [verifiedSubject, decidedVerifier, verificationRequest] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: verification.id } }),
      db.task.findUniqueOrThrow({ where: { id: verifier.id } }),
      db.taskJudgmentRequest.findUniqueOrThrow({
        where: { id: verificationEvidence.judgmentRequest!.id },
      }),
    ]);
    assert.equal(verifiedSubject.status, TaskStatus.DONE);
    assert.equal(decidedVerifier.status, TaskStatus.DONE);
    assert.equal(decidedVerifier.verdict, 'PASS');
    assert.equal(verificationRequest.status, 'DECIDED');
    assert.equal(verificationRequest.decision, 'PASS');
    assert.equal(verificationRequest.decidedByType, 'AGENT');
    assert.equal(verificationRequest.decidedById, workspaceId);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: verifierSessionId } })).status,
      RunStatus.AWAITING_INPUT);
    assert.equal(await dependencyState(tasks, ownerId, downstream.id), 'BLOCKED');

    // N12: the first human request is already reachable in-app. Its one push row experiences an
    // offline transport and later succeeds; retry changes the receipt, not the logical request.
    const firstRequestId = firstHumanEvidence.judgmentRequest!.id;
    const firstInbox = await db.taskJudgmentInboxItem.findUniqueOrThrow({
      where: { requestId_requestVersion: { requestId: firstRequestId, requestVersion: 1 } },
      include: { pushDelivery: true },
    });
    assert.ok(firstInbox.deliveredAt instanceof Date);
    assert.equal(firstInbox.recipientId, ownerId);
    assert.ok(firstInbox.pushDelivery);
    await db.deviceToken.create({
      data: {
        userId: ownerId,
        token: 'n9-offline-device',
        environment: 'sandbox',
        bundleId: 'io.orbitd.app',
      },
    });
    const push = new PushService(prisma, enabledPushConfig());
    (push as unknown as { authToken: () => string }).authToken = () => 'n9-auth';
    let deviceOffline = true;
    let transportCalls = 0;
    (push as unknown as { deliver: () => Promise<number> }).deliver = async () => {
      transportCalls += 1;
      if (deviceOffline) throw new Error('simulated N9 device offline');
      return 1;
    };
    deliveryWorker = new JudgmentDeliveryService(prisma, push);
    const humanBeforeDelivery = await db.task.findUniqueOrThrow({
      where: { id: human.id },
      select: { status: true, updatedAt: true },
    });
    await deliveryWorker.deliverDue();
    const offlineReceipt = await db.taskJudgmentPushDelivery.findUniqueOrThrow({
      where: { id: firstInbox.pushDelivery!.id },
    });
    assert.equal(offlineReceipt.status, 'PENDING');
    assert.equal(offlineReceipt.errorCode, 'PUSH_FAILED');
    assert.match(offlineReceipt.lastError ?? '', /simulated N9 device offline/);
    assert.equal(offlineReceipt.attempts, 1);
    assert.equal(offlineReceipt.failures, 1);
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: firstRequestId } }), 1);
    assert.equal(await db.taskJudgmentInboxItem.count({ where: { requestId: firstRequestId } }), 1);

    deviceOffline = false;
    await db.taskJudgmentPushDelivery.update({
      where: { id: offlineReceipt.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await deliveryWorker.deliverDue();
    const recoveredReceipt = await db.taskJudgmentPushDelivery.findUniqueOrThrow({
      where: { id: offlineReceipt.id },
    });
    assert.equal(recoveredReceipt.id, offlineReceipt.id);
    assert.equal(recoveredReceipt.status, 'DELIVERED');
    assert.equal(recoveredReceipt.attempts, 2);
    assert.equal(recoveredReceipt.deliveredDevices, 1);
    assert.ok(recoveredReceipt.deliveredAt);
    assert.equal(transportCalls, 2);
    assert.equal(await db.taskJudgmentPushDelivery.count({ where: { requestId: firstRequestId } }), 1);
    assert.equal(await db.taskJudgmentPushDelivery.count({
      where: { logicalNotificationKey: `task-judgment:${firstRequestId}:v1` },
    }), 1);
    assert.deepEqual(await db.task.findUniqueOrThrow({
      where: { id: human.id },
      select: { status: true, updatedAt: true },
    }), humanBeforeDelivery, 'the notification worker never writes Task status or any Task field');

    // N10/N11/N13: a substantive second revision supersedes the old request. The inbox opens the
    // current revision; an old click and an agent signature both fail before the human decision.
    const currentHumanEvidence = await evidence.submit(
      ownerId,
      human.id,
      { type: CreatorType.AGENT, id: workspaceId },
      {
        sourceSessionId: sourceSessions.human,
        idempotencyKey: 'n9-human-revision-2',
        evidence: {
          commit: '4444444444444444',
          testSummary: { command: 'npm test -w @orbit/web', exitCode: 0, passed: 1199 },
          artifact: 'build/n9-review-v2.json',
          sha256: '4'.repeat(64),
        },
      },
    );
    const currentRequestId = currentHumanEvidence.judgmentRequest!.id;
    assert.equal(currentHumanEvidence.revision, '2');
    assert.notEqual(currentRequestId, firstRequestId);
    const staleRequest = await db.taskJudgmentRequest.findUniqueOrThrow({
      where: { id: firstRequestId },
    });
    assert.equal(staleRequest.status, 'SUPERSEDED');
    assert.equal(staleRequest.supersededById, currentRequestId);
    assert.equal(await db.taskJudgmentRequest.count({
      where: { taskId: human.id, status: 'OPEN' },
    }), 1);
    assert.equal(await db.taskJudgmentInboxItem.count({ where: { taskId: human.id } }), 2);
    assert.equal(await db.taskJudgmentPushDelivery.count({
      where: { requestId: { in: [firstRequestId, currentRequestId] } },
    }), 2);

    const reviews = new TaskJudgmentReviewService(prisma, tasks);
    await assert.rejects(
      reviews.decide(ownerId, firstRequestId, {
        requestId: firstRequestId,
        evidenceDigest: firstHumanEvidence.evidenceDigest,
        action: 'PASS',
        note: 'A stale inbox click must not sign the replacement revision.',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal(
          (error.getResponse() as Record<string, unknown>).code,
          'HUMAN_SIGNOFF_REQUEST_SUPERSEDED',
        );
        return true;
      },
    );
    await assert.rejects(
      tasks.signoff(ownerId, human.id, {
        requestId: currentRequestId,
        evidenceDigest: currentHumanEvidence.evidenceDigest,
        evidence: 'An agent is not the human signer.',
      }, sourceSessions.human),
      (error: unknown) => {
        assert.ok(error instanceof ForbiddenException);
        assert.equal(
          (error.getResponse() as Record<string, unknown>).code,
          'HUMAN_SIGNOFF_REQUIRES_USER',
        );
        return true;
      },
    );
    const inbox = await reviews.list(ownerId, {
      status: 'OPEN',
      projectId: project.id,
      taskId: human.id,
    });
    assert.equal(inbox.total, 1);
    assert.equal(inbox.items[0].requestId, currentRequestId);
    assert.equal(inbox.items[0].evidenceRevision, '2');
    assert.equal(inbox.items[0].evidenceDigest, currentHumanEvidence.evidenceDigest);
    const review = await reviews.get(ownerId, currentRequestId);
    assert.equal(review.reviewState, 'ACTION_REQUIRED');
    assert.equal(review.isCurrent, true);
    assert.equal(review.evidence.revision, '2');
    assert.equal(review.currentEvidence.id, currentHumanEvidence.id);
    assert.equal(review.currentEvidence.requestId, currentRequestId);
    assert.equal(review.history.length, 2);
    assert.equal(JSON.stringify(review).includes(commentMarker), false,
      'the review is built from evidence revisions and never parses task_comment prose');
    assert.equal(review.derived.signalOpen, true);
    assert.equal(review.derived.blockerOpen, true);
    assert.equal(await dependencyState(tasks, ownerId, downstream.id), 'BLOCKED');

    const signatureNote =
      'N9 human reviewed revision 2, commit 4444444444444444, raw test exit 0 and artifact SHA-256.';
    const approved = await reviews.decide(ownerId, currentRequestId, {
      requestId: currentRequestId,
      evidenceDigest: currentHumanEvidence.evidenceDigest,
      action: 'PASS',
      note: signatureNote,
    });
    assert.equal(approved.reviewState, 'APPROVED');
    assert.equal(approved.derived.taskStatus, TaskStatus.DONE);
    assert.equal(approved.request.status, 'DECIDED');
    assert.equal(approved.request.decision, 'PASS');
    assert.equal(approved.derived.openRequestId, null);
    assert.equal(approved.derived.signalOpen, false);
    assert.equal(approved.derived.blockerOpen, false);
    const [storedSignoff, storedHumanRequest] = await Promise.all([
      db.taskHumanSignoff.findUniqueOrThrow({ where: { taskId: human.id } }),
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: currentRequestId } }),
    ]);
    assert.equal(storedSignoff.requestId, currentRequestId);
    assert.equal(storedSignoff.evidenceDigest, currentHumanEvidence.evidenceDigest);
    assert.equal(storedSignoff.signedById, ownerId);
    assert.ok(storedSignoff.signedAt instanceof Date);
    assert.equal(storedSignoff.evidence, signatureNote);
    assert.equal(storedHumanRequest.decidedByType, 'USER');
    assert.equal(storedHumanRequest.decidedById, ownerId);
    assert.ok(storedHumanRequest.decidedAt instanceof Date);
    assert.equal(await db.task.count({ where: { verifiesTaskId: human.id } }), 0,
      'HUMAN_SIGNOFF is a peer route and must not cascade into a legacy verifier');
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "task_judgment_signal" WHERE "task_id" = $1::uuid`,
      [human.id],
    )).rows[0].n, 0);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "project_judgment_blocker" WHERE "task_id" = $1::uuid`,
      [human.id],
    )).rows[0].n, 0);
    assert.equal(await dependencyState(tasks, ownerId, downstream.id), 'READY');

    const statusAudit = await db.$queryRaw<Array<{
      taskId: string;
      derivation: string;
      oldStatus: string;
      newStatus: string;
    }>>`
      SELECT "task_id" AS "taskId", "derivation",
             "old_status" AS "oldStatus", "new_status" AS "newStatus"
        FROM "n9_task_done_derivation_audit"
       ORDER BY "derivation", "task_id"`;
    assert.equal(statusAudit.length, 4);
    assert.deepEqual(
      new Set(statusAudit.map((row) => row.derivation)),
      new Set(['EXECUTABLE_RESULT', 'VERIFIER_VERDICT', 'VERIFICATION_PASS', 'HUMAN_SIGNOFF']),
    );
    assert.deepEqual(
      new Set(statusAudit.map((row) => row.taskId)),
      new Set([executable.id, verifier.id, verification.id, human.id]),
    );
    assert.ok(statusAudit.every((row) => row.newStatus === 'DONE'));

    // N3/N4/N5: structured criteria are concluded from the four durable facts. The source and
    // verifier Sessions are still AWAITING_INPUT, and two ordinary project tasks remain OPEN.
    const acceptanceRun = await acceptance.openRun(ownerId, project.id, { decidedBy: 'USER' });
    await acceptance.confirmCriteriaSet(ownerId, project.id, {
      actorType: 'USER',
      actorId: ownerId,
    });
    const passedRun = await acceptance.finalizeRun(
      ownerId,
      project.id,
      acceptanceRun.id,
      [
        {
          ordinal: 1,
          verdict: ProjectAcceptanceVerdict.PASS,
          summary: 'The request-bound executable result matched exit code 0.',
          evidence: {
            requestId: executableEvidence.judgmentRequest!.id,
            resultId: executableResult.id,
            command: executableResult.command,
            actualExitCode: executableResult.actualExitCode,
            rawOutput: executableResult.rawOutput,
          },
          evidenceTaskId: executable.id,
          evidenceSessionId: sourceSessions.executable,
        },
        {
          ordinal: 2,
          verdict: ProjectAcceptanceVerdict.PASS,
          summary: 'The independent verifier session recorded PASS on the current evidence.',
          evidence: {
            requestId: verificationRequest.id,
            verifierTaskId: verifier.id,
            verdictRevision: decidedVerifier.verdictRevision.toString(),
          },
          evidenceTaskId: verification.id,
          evidenceSessionId: verifierSessionId,
        },
        {
          ordinal: 3,
          verdict: ProjectAcceptanceVerdict.PASS,
          summary: 'The owner signed the current inbox evidence after delivery recovery.',
          evidence: {
            requestId: currentRequestId,
            evidenceRevision: currentHumanEvidence.revision,
            signoffId: storedSignoff.id,
            deliveryId: recoveredReceipt.id,
          },
          evidenceTaskId: human.id,
          evidenceSessionId: sourceSessions.human,
        },
      ],
    );
    assert.equal(passedRun.verdict, ProjectAcceptanceVerdict.PASS);
    const conclusions = await db.projectAcceptanceConclusion.findMany({
      where: { projectId: project.id, evidenceRunId: acceptanceRun.id },
      orderBy: { ordinal: 'asc' },
    });
    assert.equal(conclusions.length, 3);
    assert.ok(conclusions.every((row) => row.verdict === ProjectAcceptanceVerdict.PASS));
    assert.ok(conclusions.every((row) => row.decidedBy === 'USER'));
    assert.ok(conclusions.every((row) => row.decidedById === ownerId));
    assert.ok(conclusions.every((row) => row.decidedAt instanceof Date));
    assert.ok(conclusions.every(
      (row) => row.evidenceVersion.toString() === acceptanceRun.attempt,
    ));
    const gateBeforeOptional = await acceptance.evaluateGate(project.id);
    assert.equal(gateBeforeOptional.allowed, true,
      String(gateBeforeOptional.reason.message ?? 'doneGate refused'));

    const optional = await tasks.create(ownerId, {
      title: 'N9 optional follow-up outside acceptance criteria',
      projectId: project.id,
      completionCriterion: 'HUMAN_SIGNOFF',
      autoRunWhenReady: false,
    });
    assert.equal(optional.status, TaskStatus.OPEN);
    const gateAfterOptional = await acceptance.evaluateGate(project.id);
    assert.equal(gateAfterOptional.allowed, true,
      String(gateAfterOptional.reason.message ?? 'an irrelevant OPEN task changed acceptance'));
    assert.equal(await db.projectAcceptanceRun.count({ where: { projectId: project.id } }), 1,
      'task creation does not mint or invalidate an acceptance evidence version');

    const sourceStates = await db.session.findMany({
      where: { id: { in: [...Object.values(sourceSessions), verifierSessionId] } },
      select: { id: true, status: true, finishedAt: true },
    });
    assert.equal(sourceStates.length, 4);
    assert.ok(sourceStates.every((session) => session.status === RunStatus.AWAITING_INPUT));
    assert.ok(sourceStates.every((session) => session.finishedAt === null));
    assert.equal(await db.task.count({
      where: { projectId: project.id, status: TaskStatus.OPEN },
    }), 2, 'downstream and optional work stay OPEN; all-tasks-terminal is not a doneGate input');

    const storedProject = await db.project.findUniqueOrThrow({ where: { id: project.id } });
    assert.equal(storedProject.status, ProjectStatus.DONE,
      'the confirmed all-PASS conjunction automatically projects project DONE');
    assert.equal(storedProject.acceptedRunId, acceptanceRun.id);
    assert.equal(await db.taskComment.count({
      where: { body: commentMarker },
    }), 3, 'comments remain timeline facts and were neither consumed nor rewritten');
    assert.equal(await db.taskLegacyEvidenceImport.count(), 0,
      'no explicit legacy-import receipt means no comment became evidence');
  },
);
