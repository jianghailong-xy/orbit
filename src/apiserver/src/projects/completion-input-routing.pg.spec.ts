/** N7 criterion-input routing against a guarded disposable PostgreSQL database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  RunStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { CompletionInputRouter } from './completion-input-router.service';
import {
  completionEvidenceRevisedFact,
  executableResultRecordedFact,
  verificationVerdictRecordedFact,
} from './completion-input';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

suite('OPEN work and AWAITING_INPUT do not gate evidence/request/decision input routing',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    await sql.query('TRUNCATE "user" RESTART IDENTITY CASCADE');
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });

    const ownerId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const siblingId = randomUUID();
    const sourceSessionId = randomUUID();
    const coordinatorSessionId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `n7-${ownerId}@completion-input.invalid`,
        name: 'N7 owner',
        passwordHash: 'x',
      },
    });
    await db.session.create({
      data: {
        id: coordinatorSessionId,
        ownerId,
        creatorId: ownerId,
        title: 'person-opened long-running coordinator',
        prompt: 'stay open for the person',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: false,
      },
    });
    await db.project.create({
      data: {
        id: projectId,
        ownerId,
        title: 'N7 fact-driven completion',
        coordinatorEnabled: true,
        coordinatorSessionId,
      },
    });
    await db.task.createMany({
      data: [
        {
          id: taskId,
          ownerId,
          projectId,
          title: 'human-reviewed delivery',
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          completionCriterion: 'HUMAN_SIGNOFF',
          status: TaskStatus.IN_PROGRESS,
        },
        {
          id: siblingId,
          ownerId,
          projectId,
          title: 'intentionally still open',
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          status: TaskStatus.OPEN,
        },
      ],
    });
    await db.session.create({
      data: {
        id: sourceSessionId,
        ownerId,
        creatorId: ownerId,
        taskId,
        title: 'resumable evidence source',
        prompt: 'evidence has committed; transport remains resumable',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });

    const prisma = db as unknown as PrismaService;
    const router = new CompletionInputRouter(new CoordinatorWakeService(prisma));
    const evidenceService = new TaskCompletionEvidenceService(prisma, undefined, undefined, router);
    const actor = { type: CreatorType.USER, id: ownerId };
    const first = await evidenceService.submit(ownerId, taskId, actor, {
      sourceSessionId,
      idempotencyKey: 'n7-evidence-v1',
      evidence: { artifact: 'dist/server.js', command: 'npm test', exitCode: 0 },
    });

    assert.equal((await db.task.findUniqueOrThrow({ where: { id: siblingId } })).status, 'OPEN');
    assert.equal(
      (await db.session.findUniqueOrThrow({ where: { id: sourceSessionId } })).status,
      'AWAITING_INPUT',
    );
    assert.deepEqual(
      (await db.projectCoordinatorWake.findMany({
        where: { projectId },
        orderBy: { createdAt: 'asc' },
        select: { event: true, status: true, consumerType: true },
      })).map((row) => [row.event, row.status, row.consumerType]),
      [
        ['COMPLETION_EVIDENCE_REVISED', 'CONSUMED', 'JUDGMENT_REQUEST_DERIVER'],
        ['HUMAN_SIGNOFF_REQUESTED', 'CONSUMED', 'HUMAN_INBOX'],
      ],
    );

    // Same stable fact: producer re-enters the router, but the database admits no new consume.
    const replay = await evidenceService.submit(ownerId, taskId, actor, {
      sourceSessionId,
      idempotencyKey: 'n7-evidence-v1',
      evidence: { exitCode: 0, command: 'npm test', artifact: 'dist/server.js' },
    });
    assert.equal(replay.id, first.id);
    assert.equal(await db.projectCoordinatorWake.count({ where: { projectId } }), 2);

    // A new digest is a new revision, request and inbox delivery; it also retracts the old request.
    const second = await evidenceService.submit(ownerId, taskId, actor, {
      sourceSessionId,
      idempotencyKey: 'n7-evidence-v2',
      evidence: { artifact: 'dist/server-v2.js', command: 'npm test', exitCode: 0 },
    });
    assert.equal(second.revision, '2');
    assert.equal(
      await db.projectCoordinatorWake.count({ where: { projectId, status: 'CONSUMED' } }),
      5,
    );
    assert.equal(
      await db.projectCoordinatorWake.count({
        where: { projectId, event: 'HUMAN_SIGNOFF_REQUEST_SUPERSEDED', consumerType: 'HUMAN_INBOX' },
      }),
      1,
    );

    const realtime = new Proxy({}, { get: () => () => undefined }) as never;
    const tasks = new TasksService(prisma, {} as never, realtime, undefined, router);
    const signed = await tasks.signoff(ownerId, taskId, {
      requestId: second.judgmentRequest!.id,
      evidenceDigest: second.evidenceDigest,
      evidence: 'A person reviewed the exact revision-2 artifact and test output.',
    });
    assert.equal(signed.status, TaskStatus.DONE);
    assert.equal(
      await db.projectCoordinatorWake.count({
        where: {
          projectId,
          event: 'HUMAN_SIGNOFF_DECIDED',
          status: 'CONSUMED',
          consumerType: 'DERIVED_COMPLETION_EVALUATOR',
        },
      }),
      1,
    );
    await tasks.signoff(ownerId, taskId, {
      requestId: second.judgmentRequest!.id,
      evidenceDigest: second.evidenceDigest,
      evidence: 'transport replay must return the original signoff',
    });
    assert.equal(
      await db.projectCoordinatorWake.count({ where: { projectId, event: 'HUMAN_SIGNOFF_DECIDED' } }),
      1,
    );

    // Human routing neither opens an agent judgment nor steers the person's long-lived Session.
    assert.equal(await db.session.count({ where: { dispatchOrigin: 'PROJECT_COORDINATOR' } }), 0);
    const coordinator = await db.session.findUniqueOrThrow({ where: { id: coordinatorSessionId } });
    assert.equal(coordinator.status, RunStatus.AWAITING_INPUT);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: coordinatorSessionId } }), 0);
    assert.equal(
      await db.projectCoordinatorWake.count({ where: { projectId, event: 'PROJECT_TASKS_SETTLED' } }),
      0,
    );
  });

suite('result/verdict inputs consume once; refusal releases the exact fact for retry',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    await sql.query('TRUNCATE "user" RESTART IDENTITY CASCADE');
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });
    const ownerId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `${ownerId}@n7-input.invalid`, name: 'N7 inputs', passwordHash: 'x' },
    });
    await db.project.create({ data: { id: projectId, ownerId, title: 'input versions' } });
    await db.task.create({
      data: {
        id: taskId,
        ownerId,
        projectId,
        title: 'input subject',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
      },
    });
    const router = new CompletionInputRouter(
      new CoordinatorWakeService(db as unknown as PrismaService),
    );
    let executableEvaluations = 0;
    const executable = executableResultRecordedFact({
      projectId,
      taskId,
      requestId: randomUUID(),
      resultId: randomUUID(),
      evidenceDigest: 'a'.repeat(64),
      actualExitCode: 0,
    });
    assert.equal((await router.route(executable, 'DERIVED_COMPLETION_EVALUATOR', () => {
      executableEvaluations += 1;
    })).outcome, 'CONSUMED');
    assert.equal((await router.route(executable, 'DERIVED_COMPLETION_EVALUATOR', () => {
      executableEvaluations += 1;
    })).outcome, 'ALREADY_AWAKE');
    assert.equal(executableEvaluations, 1);

    let verificationEvaluations = 0;
    const verification = verificationVerdictRecordedFact({
      projectId,
      taskId,
      requestId: randomUUID(),
      verifierTaskId: randomUUID(),
      verdictRevision: '1',
      evidenceDigest: 'b'.repeat(64),
      verdict: 'PASS',
    });
    await router.route(verification, 'DERIVED_COMPLETION_EVALUATOR', () => {
      verificationEvaluations += 1;
    });
    await router.route(verification, 'DERIVED_COMPLETION_EVALUATOR', () => {
      verificationEvaluations += 1;
    });
    assert.equal(verificationEvaluations, 1);

    // The key is computed/claimed before authorization. REFUSED rows remain audit, but leave the
    // partial unique index so the repaired authorization can consume this same immutable fact.
    const retryable = completionEvidenceRevisedFact({
      projectId,
      taskId,
      revision: '99',
      criterionRevision: 'c'.repeat(64),
      evidenceDigest: 'd'.repeat(64),
      requestId: randomUUID(),
      requestKind: 'VERIFICATION',
    });
    let deliveries = 0;
    const refused = await router.route(
      retryable,
      'JUDGMENT_REQUEST_DERIVER',
      () => { deliveries += 1; },
      async (_fact, claim) => {
        assert.match(claim.idempotencyKey, /COMPLETION_EVIDENCE_REVISED/);
        return { allowed: false, refusalCode: 'TEST_AUTHORITY_NOT_READY' };
      },
    );
    assert.equal(refused.outcome, 'REFUSED');
    assert.equal(deliveries, 0);
    const accepted = await router.route(retryable, 'JUDGMENT_REQUEST_DERIVER', () => {
      deliveries += 1;
    });
    assert.equal(accepted.outcome, 'CONSUMED');
    assert.equal(deliveries, 1);
    assert.equal(refused.idempotencyKey, accepted.idempotencyKey);
    const retryRows = await db.projectCoordinatorWake.findMany({
      where: { idempotencyKey: accepted.idempotencyKey },
      orderBy: { createdAt: 'asc' },
      select: { status: true, refusalCode: true },
    });
    assert.deepEqual(retryRows, [
      { status: 'REFUSED', refusalCode: 'TEST_AUTHORITY_NOT_READY' },
      { status: 'CONSUMED', refusalCode: null },
    ]);

    // A genuinely new result/version is a new fact and therefore one new consumption.
    await router.route(executableResultRecordedFact({
      projectId,
      taskId,
      requestId: executable.subjectId,
      resultId: randomUUID(),
      evidenceDigest: 'e'.repeat(64),
      actualExitCode: 1,
    }), 'DERIVED_COMPLETION_EVALUATOR', () => { executableEvaluations += 1; });
    assert.equal(executableEvaluations, 2);
  });
