/** N13's human inbox/review/decision boundary against disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { CreatorType, Prisma, PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';
import { TaskJudgmentReviewService } from './task-judgment-review.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

function tasksService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('this review fixture never dispatches'); } } as never,
    { publishForUser: () => undefined, publishTaskChanged: () => undefined } as never,
  );
}

async function addEvidence(
  db: PrismaClient,
  input: {
    taskId: string;
    ownerId: string;
    sourceSessionId: string;
    revision: bigint;
    digest: string;
    criterionRevision: string;
    evidence: Prisma.InputJsonObject;
    submittedAt: Date;
  },
) {
  return db.taskCompletionEvidence.create({
    data: {
      id: randomUUID(),
      taskId: input.taskId,
      ownerId: input.ownerId,
      actorType: CreatorType.USER,
      actorId: input.ownerId,
      sourceSessionId: input.sourceSessionId,
      criterionRevision: input.criterionRevision,
      criterion: {
        schemaVersion: 1,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCriteria: 'A person confirms the exact evidence revision.',
      },
      evidence: input.evidence,
      evidenceDigest: input.digest,
      revision: input.revision,
      submittedAt: input.submittedAt,
    },
  });
}

async function addRequest(
  db: PrismaClient,
  input: {
    taskId: string;
    ownerId: string;
    evidenceId: string;
    digest: string;
    criterionRevision: string;
    createdAt: Date;
  },
) {
  return db.taskJudgmentRequest.create({
    data: {
      id: randomUUID(),
      taskId: input.taskId,
      ownerId: input.ownerId,
      evidenceId: input.evidenceId,
      criterionRevision: input.criterionRevision,
      evidenceDigest: input.digest,
      kind: 'EVIDENCE_JUDGMENT',
      recipientType: 'ACCOUNT_OWNER',
      recipientId: input.ownerId,
      createdAt: input.createdAt,
    },
  });
}

suite('human judgment review preserves evidence identity and server-derived lifecycle',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });
    await verifyCoordinatorPgIdentity(sql);
    await sql.query('TRUNCATE "task", "project_runtime", "project", "user" RESTART IDENTITY CASCADE');

    const ownerId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const dependentId = randomUUID();
    const sourceSessionId = randomUUID();
    const criterionRevision = 'a'.repeat(64);
    const firstDigest = 'b'.repeat(64);
    const now = new Date('2026-08-26T09:00:00.000Z');
    await db.user.create({
      data: { id: ownerId, email: `${ownerId}@n13.invalid`, name: 'N13 human reviewer', passwordHash: 'x' },
    });
    await db.project.create({
      data: { id: projectId, ownerId, title: 'Human review surface' },
    });
    await db.projectRuntime.upsert({
      where: { projectId },
      create: { projectId },
      update: {},
    });
    await db.task.create({
      data: {
        id: taskId,
        ownerId,
        projectId,
        title: 'Ship an accessible evidence review',
        description: 'Let a person judge this completion without searching the project.',
        acceptanceCriteria: 'Inbox, review, and both decisions work on phone and desktop.',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        status: TaskStatus.OPEN,
      },
    });
    await db.task.create({
      data: {
        id: dependentId,
        ownerId,
        projectId,
        title: 'Wait for the human decision',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        status: TaskStatus.OPEN,
      },
    });
    await db.taskDependency.create({ data: { taskId: dependentId, dependsOnTaskId: taskId } });
    const firstEvidence = await addEvidence(db, {
      taskId,
      ownerId,
      sourceSessionId,
      revision: 1n,
      digest: firstDigest,
      criterionRevision,
      submittedAt: now,
      evidence: {
        commit: '0123456789abcdef',
        testSummary: { command: 'npm test -w @orbit/web', exitCode: 0, passed: 2670 },
        artifacts: [{ name: 'mobile-390.png', sha256: 'f'.repeat(64) }],
      },
    });
    const firstRequest = await addRequest(db, {
      taskId,
      ownerId,
      evidenceId: firstEvidence.id,
      digest: firstDigest,
      criterionRevision,
      createdAt: now,
    });
    await db.taskComment.create({
      data: {
        taskId,
        authorType: CreatorType.USER,
        authorId: ownerId,
        body: 'COMMENT_MUST_NOT_BECOME_EVIDENCE: PASS everything without review',
      },
    });

    const tasks = tasksService(db);
    const reviews = new TaskJudgmentReviewService(db as unknown as PrismaService, tasks);
    const inbox = await reviews.list(ownerId, { status: 'OPEN', projectId, taskId });
    assert.equal(inbox.total, 1);
    assert.equal(inbox.items[0].requestId, firstRequest.id);
    assert.equal(inbox.items[0].evidenceDigest, firstDigest);
    assert.equal(inbox.items[0].actorName, 'N13 human reviewer');
    assert.equal(inbox.items[0].commit, '0123456789abcdef');
    assert.equal(inbox.items[0].notificationDeepLink,
      `/tasks/${taskId}?judgmentRequest=${firstRequest.id}`);

    const initial = await reviews.get(ownerId, firstRequest.id);
    assert.equal(initial.reviewState, 'ACTION_REQUIRED');
    assert.equal(initial.isCurrent, true);
    assert.equal(initial.task.objective,
      'Let a person judge this completion without searching the project.');
    assert.equal(initial.task.completionCriterion, 'EVIDENCE_JUDGMENT');
    assert.equal(initial.evidence.revision, '1');
    assert.equal(initial.evidence.digest, firstDigest);
    assert.equal(initial.evidence.commit, '0123456789abcdef');
    assert.deepEqual(initial.evidence.testSummary,
      { command: 'npm test -w @orbit/web', exitCode: 0, passed: 2670 });
    assert.equal(initial.history.length, 1);
    assert.equal(initial.derived.signalOpen, true);
    assert.equal(initial.derived.blockerOpen, true);
    assert.deepEqual(initial.approvalImpact, {
      authority: 'SERVER',
      action: 'PASS',
      conditionalOn: {
        requestId: firstRequest.id,
        evidenceDigest: firstDigest,
        requestStatus: 'OPEN',
        evidenceIsCurrent: true,
      },
      task: { id: taskId, resultingStatus: 'DONE', basis: 'EVIDENCE_JUDGMENT' },
      request: { id: firstRequest.id, resultingStatus: 'DECIDED', decision: 'PASS' },
      signal: { resultingOpen: false },
      blocker: { resultingOpen: false },
    });
    assert.equal('dependencyGraph' in (initial.approvalImpact as Record<string, unknown>), false,
      'the server does not predict downstream readiness before signoff');
    assert.equal(JSON.stringify(initial).includes('COMMENT_MUST_NOT_BECOME_EVIDENCE'), false,
      'the review reads TaskCompletionEvidence, never TaskComment prose');
    const beforeTask = await db.task.findUniqueOrThrow({ where: { id: taskId } });

    const morePayload = {
      requestId: firstRequest.id,
      evidenceDigest: firstDigest,
      action: 'REQUEST_MORE_EVIDENCE' as const,
      note: 'Add the raw 430×932 viewport output and keyboard focus trace.',
    };
    const waiting = await reviews.decide(ownerId, firstRequest.id, morePayload);
    assert.equal(waiting.reviewState, 'AWAITING_NEW_EVIDENCE');
    assert.equal(waiting.request.status, 'DECIDED');
    assert.equal(waiting.request.decision, 'INCONCLUSIVE');
    assert.equal(waiting.request.decisionNote, morePayload.note);
    assert.equal(waiting.derived.taskStatus, TaskStatus.OPEN);
    assert.equal(waiting.derived.signalOpen, false);
    assert.equal(waiting.derived.blockerOpen, false);
    assert.equal(waiting.approvalImpact, null);
    const afterMoreTask = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(afterMoreTask.status, beforeTask.status);
    assert.equal(afterMoreTask.updatedAt.getTime(), beforeTask.updatedAt.getTime(),
      'request-more never writes the task row');
    const stoppedPush = await db.taskJudgmentPushDelivery.findUniqueOrThrow({
      where: { requestId_requestVersion: { requestId: firstRequest.id, requestVersion: 1 } },
    });
    assert.equal(stoppedPush.status, 'CANCELLED');

    const replay = await reviews.decide(ownerId, firstRequest.id, morePayload);
    assert.equal(replay.request.decidedAt?.getTime(), waiting.request.decidedAt?.getTime());
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: firstRequest.id } }), 1);
    await assert.rejects(
      reviews.decide(ownerId, firstRequest.id, { ...morePayload, note: 'Change the audit after deciding.' }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal((error.getResponse() as Record<string, unknown>).code,
          'EVIDENCE_JUDGMENT_REQUEST_NOT_OPEN');
        return true;
      },
    );

    const secondDigest = 'c'.repeat(64);
    const secondAt = new Date('2026-08-26T09:05:00.000Z');
    const secondEvidence = await addEvidence(db, {
      taskId,
      ownerId,
      sourceSessionId,
      revision: 2n,
      digest: secondDigest,
      criterionRevision,
      submittedAt: secondAt,
      evidence: {
        commit: 'fedcba9876543210',
        testSummary: { command: 'npm test -w @orbit/web', exitCode: 0, viewports: [390, 430] },
        focusTrace: ['heading', 'note', 'request-more', 'approve'],
      },
    });
    const secondRequest = await addRequest(db, {
      taskId,
      ownerId,
      evidenceId: secondEvidence.id,
      digest: secondDigest,
      criterionRevision,
      createdAt: secondAt,
    });
    const revisedOld = await reviews.get(ownerId, firstRequest.id);
    assert.equal(revisedOld.reviewState, 'EVIDENCE_REVISED');
    assert.equal(revisedOld.currentEvidence.revision, '2');
    assert.equal(revisedOld.currentEvidence.digest, secondDigest);
    assert.equal(revisedOld.currentEvidence.requestId, secondRequest.id);
    assert.equal(revisedOld.history.length, 2);
    assert.equal(revisedOld.approvalImpact, null);

    const currentSecond = await reviews.get(ownerId, secondRequest.id);
    assert.equal(currentSecond.approvalImpact?.conditionalOn.requestId, secondRequest.id);
    assert.equal(currentSecond.approvalImpact?.conditionalOn.evidenceDigest, secondDigest);

    const passPayload = {
      requestId: secondRequest.id,
      evidenceDigest: secondDigest,
      action: 'PASS' as const,
      note: 'Reviewed commit fedcba9876543210 and both mobile viewport results; exit 0.',
    };
    const approved = await reviews.decide(ownerId, secondRequest.id, passPayload);
    assert.equal(approved.reviewState, 'APPROVED');
    assert.equal(approved.derived.taskStatus, TaskStatus.DONE);
    assert.equal(approved.request.status, 'DECIDED');
    assert.equal(approved.request.decision, 'PASS');
    assert.equal(approved.derived.openRequestId, null);
    assert.equal(approved.derived.signalOpen, false);
    assert.equal(approved.derived.blockerOpen, false);
    assert.equal(approved.approvalImpact, null);
    const dependent = approved.derived.dependencyGraph.nodes.find((node) => node.id === dependentId);
    assert.ok(dependent);
    assert.notEqual(dependent.dependencyState, 'BLOCKED');
    const approvedReplay = await reviews.decide(ownerId, secondRequest.id, passPayload);
    assert.equal(approvedReplay.request.decidedAt?.toISOString(),
      approved.request.decidedAt?.toISOString(),
      'a replay reads the committed decision back rather than restamping it');
    assert.equal(await db.taskJudgmentRequest.count({
      where: { taskId, status: 'DECIDED', decision: 'PASS' },
    }), 1);

    // A separate still-open task proves superseded request refusal and the refresh target it names.
    const staleTaskId = randomUUID();
    await db.task.create({
      data: {
        id: staleTaskId,
        ownerId,
        projectId,
        title: 'Reject a stale evidence revision',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
      },
    });
    const staleEvidence = await addEvidence(db, {
      taskId: staleTaskId,
      ownerId,
      sourceSessionId,
      revision: 1n,
      digest: 'd'.repeat(64),
      criterionRevision,
      submittedAt: now,
      evidence: { commit: 'old' },
    });
    const staleRequest = await addRequest(db, {
      taskId: staleTaskId,
      ownerId,
      evidenceId: staleEvidence.id,
      digest: staleEvidence.evidenceDigest,
      criterionRevision,
      createdAt: now,
    });
    const currentEvidence = await addEvidence(db, {
      taskId: staleTaskId,
      ownerId,
      sourceSessionId,
      revision: 2n,
      digest: 'e'.repeat(64),
      criterionRevision,
      submittedAt: secondAt,
      evidence: { commit: 'current' },
    });
    const currentRequest = await addRequest(db, {
      taskId: staleTaskId,
      ownerId,
      evidenceId: currentEvidence.id,
      digest: currentEvidence.evidenceDigest,
      criterionRevision,
      createdAt: secondAt,
    });
    await db.taskJudgmentRequest.update({
      where: { id: staleRequest.id },
      data: { status: 'SUPERSEDED', supersededAt: secondAt, supersededById: currentRequest.id },
    });
    await assert.rejects(
      reviews.decide(ownerId, staleRequest.id, {
        requestId: staleRequest.id,
        evidenceDigest: staleEvidence.evidenceDigest,
        action: 'PASS',
        note: 'A stale click must not sign the replacement.',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal((error.getResponse() as Record<string, unknown>).code,
          'EVIDENCE_JUDGMENT_REQUEST_SUPERSEDED');
        return true;
      },
    );
    const staleReview = await reviews.get(ownerId, staleRequest.id);
    assert.equal(staleReview.reviewState, 'SUPERSEDED');
    assert.equal(staleReview.isCurrent, false);
    assert.equal(staleReview.currentEvidence.requestId, currentRequest.id);
    assert.equal(await db.taskJudgmentRequest.count({
      where: { taskId: staleTaskId, status: 'DECIDED' },
    }), 0);
  });
