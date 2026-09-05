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
} from './completion-input';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';

const URL = process.env.COORDINATOR_PG_URL;

/**
 * The router's other door, which nothing in this file goes through. A double that throws rather
 * than a real producer, so a test that reached the settled path by accident would say so instead
 * of quietly opening a judgment session against this database.
 */
const noSettledDeliveries = {
  afterCommit: () => {
    throw new Error('N7 evidence routing must not deliver project-settled facts');
  },
} as unknown as ProjectTasksSettledProducer;

/** The third door, doubled the same way and for the same reason. */
const noTaskExceptions = {
  factsFor: () => {
    throw new Error('N7 evidence routing must not derive task-exception facts');
  },
} as unknown as TaskExceptionInputProducer;

/** And the fourth. */
const noReadyCriteria = {
  factsFor: () => {
    throw new Error('N7 evidence routing must not derive criterion-readiness facts');
  },
} as unknown as CriterionReadyProducer;
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
          completionCriterion: 'EVIDENCE_JUDGMENT',
          status: TaskStatus.IN_PROGRESS,
        },
        {
          id: siblingId,
          ownerId,
          projectId,
          title: 'intentionally still open',
          creatorType: CreatorType.USER,
          completionCriterion: 'EVIDENCE_JUDGMENT',
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

    // The envelope needs a row of this task's own to cite; this is the one the evidence is about.
    await db.toolCall.create({
      data: {
        sessionId: sourceSessionId,
        name: 'Bash',
        toolUseId: 'toolu_n7_build',
        input: { command: 'npm test', description: 'the command this evidence is about' },
        isError: false,
      },
    });
    const n7Envelope = (claim: string, gaps: string[]) => ({
      claim,
      criterion: { key: 'n7-routing', text: 'the evidence revision reaches the router exactly once' },
      checks: [{ kind: 'TOOL_CALL', ref: 'toolu_n7_build', command: 'npm test', succeeded: true }],
      gaps,
    });
    const prisma = db as unknown as PrismaService;
    const router = new CompletionInputRouter(
      new CoordinatorWakeService(prisma), noSettledDeliveries, noTaskExceptions, noReadyCriteria,
    );
    const evidenceService = new TaskCompletionEvidenceService(prisma, undefined, router);
    const actor = { type: CreatorType.USER, id: ownerId };
    const first = await evidenceService.submit(ownerId, taskId, actor, {
      sourceSessionId,
      idempotencyKey: 'n7-evidence-v1',
      evidence: n7Envelope('the build produced dist/server.js', []),
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
      // One input per evidence revision since 2026-09-02. The second row here was
      // EVIDENCE_JUDGMENT_REQUESTED — the judgment question this revision used to raise — and it
      // went with the request ledger; the ledger itself, and this fact about it, did not.
      [['COMPLETION_EVIDENCE_REVISED', 'CONSUMED', 'JUDGMENT_REQUEST_DERIVER']],
    );

    // Same stable fact: producer re-enters the router, but the database admits no new consume.
    const replay = await evidenceService.submit(ownerId, taskId, actor, {
      sourceSessionId,
      // The same fact with its object keys in another order: one digest, one revision, one input.
      idempotencyKey: 'n7-evidence-v1',
      evidence: {
        gaps: [],
        checks: [{ ref: 'toolu_n7_build', command: 'npm test', succeeded: true, kind: 'TOOL_CALL' }],
        criterion: { text: 'the evidence revision reaches the router exactly once', key: 'n7-routing' },
        claim: 'the build produced dist/server.js',
      },
    });
    assert.equal(replay.id, first.id);
    assert.equal(await db.projectCoordinatorWake.count({ where: { projectId } }), 1);

    // A new digest is a new revision and therefore one more input, and nothing else: no request,
    // no inbox delivery, and no derived task status.
    const second = await evidenceService.submit(ownerId, taskId, actor, {
      sourceSessionId,
      idempotencyKey: 'n7-evidence-v2',
      evidence: n7Envelope('the build produced dist/server-v2.js', []),
    });
    assert.equal(second.revision, '2');
    assert.equal(
      await db.projectCoordinatorWake.count({ where: { projectId, status: 'CONSUMED' } }),
      2,
    );
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
      'IN_PROGRESS',
      'submitting evidence settles nothing on its own: the task is exactly where it was, and no '
      + 'criterion has an evaluator left to move it',
    );

    // Evidence routing neither opens an agent judgment nor steers the person's long-lived Session.
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
        completionCriterion: 'EVIDENCE_JUDGMENT',
        creatorId: ownerId,
      },
    });
    const router = new CompletionInputRouter(
      new CoordinatorWakeService(db as unknown as PrismaService), noSettledDeliveries,
      noTaskExceptions, noReadyCriteria,
    );
    // The key is computed/claimed before authorization. REFUSED rows remain audit, but leave the
    // partial unique index so the repaired authorization can consume this same immutable fact.
    const retryable = completionEvidenceRevisedFact({
      projectId,
      taskId,
      revision: '99',
      criterionRevision: 'c'.repeat(64),
      evidenceDigest: 'd'.repeat(64),
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

    // A genuinely new version is a new fact and therefore one new consumption.
    const laterRevision = completionEvidenceRevisedFact({
      projectId,
      taskId,
      revision: '100',
      criterionRevision: 'c'.repeat(64),
      evidenceDigest: 'f'.repeat(64),
    });
    assert.equal(
      (await router.route(laterRevision, 'JUDGMENT_REQUEST_DERIVER', () => { deliveries += 1; }))
        .outcome,
      'CONSUMED',
    );
    assert.equal(deliveries, 2);
  });
