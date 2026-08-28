/**
 * N12's transactional inbox and retryable device outbox against real PostgreSQL.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * migration 0182 applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import {
  JUDGMENT_DELIVERY_LIMITS,
  JudgmentDeliveryService,
} from './judgment-delivery.service';
import { PushService, type JudgmentPushResult } from './push.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

function enabledConfig(): ConfigService {
  const values: Record<string, string> = {
    APNS_KEY_ID: 'key-id',
    APNS_TEAM_ID: 'team-id',
    APNS_KEY: Buffer.from('test-key').toString('base64'),
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

async function empty(sql: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`
    TRUNCATE "task", "project_runtime", "project", "session", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function fixture(db: PrismaClient, suffix = 'one') {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `n12-${suffix}-${ownerId}@invalid.test`, name: 'N12', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `n12-${suffix}`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `n12-${suffix}`, enabled: true },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: `N12 project ${suffix}` } });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: `Human review ${suffix}`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'HUMAN_SIGNOFF',
      acceptanceCriteria: 'A person reviews the evidence and signs off.',
    },
  });
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `Evidence ${suffix}`,
      prompt: 'collect evidence',
      provider: 'codex',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  const evidence = new TaskCompletionEvidenceService(db as unknown as PrismaService);
  const submit = (revision: number, key = `evidence-${revision}`) => evidence.submit(
    ownerId,
    taskId,
    { type: CreatorType.AGENT, id: workspaceId },
    {
      sourceSessionId: sessionId,
      idempotencyKey: key,
      evidence: { revision, command: 'npm test', exitCode: 0 },
    },
  );
  return { ownerId, runnerId, workspaceId, projectId, taskId, sessionId, submit };
}

function deliveredPush(onCall?: () => Promise<void> | void) {
  let calls = 0;
  return {
    get calls() { return calls; },
    deliverJudgmentRequest: async (): Promise<JudgmentPushResult> => {
      calls += 1;
      await onCall?.();
      return { outcome: 'DELIVERED', devices: 1, payload: { attempt: calls } };
    },
  };
}

suite('N12 reliable human judgment delivery', { timeout: 180_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });

  await t.test('request, in-app item and push outbox commit or roll back as one fact', async () => {
    await empty(sql);
    const f = await fixture(db, 'atomic');
    const results = await Promise.all(Array.from({ length: 6 }, () => f.submit(1, 'same-fact')));
    const requestId = results[0].judgmentRequest!.id;
    assert.equal(new Set(results.map((result) => result.judgmentRequest!.id)).size, 1);
    assert.equal(results[0].judgmentRequest!.recipientId, f.ownerId);

    const inbox = await db.taskJudgmentInboxItem.findMany({
      where: { requestId },
      include: { pushDelivery: true },
    });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].recipientId, f.ownerId);
    assert.equal(inbox[0].ownerId, f.ownerId);
    assert.equal(inbox[0].requestVersion, 1);
    assert.equal(inbox[0].requiredAction, 'REVIEW_EVIDENCE_AND_SIGN_OFF');
    assert.match(inbox[0].deepLink, new RegExp(`${f.taskId}.*${requestId}`));
    assert.ok(inbox[0].deliveredAt instanceof Date, 'the primary in-app channel has a receipt');
    assert.equal(inbox[0].pushDelivery?.status, 'PENDING');
    assert.equal(inbox[0].pushDelivery?.logicalNotificationKey, `task-judgment:${requestId}:v1`);

    assert.equal(await db.taskComment.count({ where: { taskId: f.taskId } }), 0,
      'judgment delivery does not depend on a comment or mention');
    const passive = await db.taskComment.create({
      data: {
        taskId: f.taskId,
        authorType: CreatorType.USER,
        authorId: f.ownerId,
        body: 'ordinary passive timeline note',
        mentionDeliveryVersion: 1,
        mentions: [],
      },
    });
    assert.equal(await db.taskCommentMentionDelivery.count({ where: { commentId: passive.id } }), 0);
    const explicit = await db.taskComment.create({
      data: {
        taskId: f.taskId,
        authorType: CreatorType.USER,
        authorId: f.ownerId,
        body: 'explicit mention',
        mentionDeliveryVersion: 1,
        mentions: [f.workspaceId],
      },
    });
    assert.equal(await db.taskCommentMentionDelivery.count({ where: { commentId: explicit.id } }), 1,
      'explicit mentions keep using the existing mention ledger');

    const rollbackEvidenceId = randomUUID();
    const rollbackRequestId = randomUUID();
    const rollbackDigest = 'e'.repeat(64);
    await db.taskCompletionEvidence.create({
      data: {
        id: rollbackEvidenceId,
        taskId: f.taskId,
        ownerId: f.ownerId,
        actorType: CreatorType.USER,
        actorId: f.ownerId,
        sourceSessionId: f.sessionId,
        criterionRevision: results[0].criterionRevision,
        criterion: { completionCriterion: 'HUMAN_SIGNOFF' },
        evidence: { rollback: true },
        evidenceDigest: rollbackDigest,
        revision: 2n,
      },
    });
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.taskJudgmentRequest.create({
        data: {
          id: rollbackRequestId,
          taskId: f.taskId,
          ownerId: f.ownerId,
          evidenceId: rollbackEvidenceId,
          criterionRevision: results[0].criterionRevision,
          evidenceDigest: rollbackDigest,
          kind: 'HUMAN_SIGNOFF',
          recipientType: 'ACCOUNT_OWNER',
          recipientId: f.ownerId,
        },
      });
      assert.equal(await tx.taskJudgmentInboxItem.count({ where: { requestId: rollbackRequestId } }), 1);
      assert.equal(await tx.taskJudgmentPushDelivery.count({ where: { requestId: rollbackRequestId } }), 1);
      throw new Error('ROLL_BACK_AFTER_REQUEST');
    }), /ROLL_BACK_AFTER_REQUEST/);
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: rollbackRequestId } }), 0);
    assert.equal(await db.taskJudgmentInboxItem.count({ where: { requestId: rollbackRequestId } }), 0);
    assert.equal(await db.taskJudgmentPushDelivery.count({ where: { requestId: rollbackRequestId } }), 0);

    await assert.rejects(sql.query(`
      INSERT INTO "task_judgment_inbox_item" (
        "id", "request_id", "task_id", "owner_id", "recipient_id",
        "task_title", "required_action", "deep_link"
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, 'orphan', 'decide', '/tasks/x')
    `, [randomUUID(), randomUUID(), f.taskId, f.ownerId]), /foreign key/i,
    'an inbox item cannot outlive or precede its request');

    const blankEvidenceId = randomUUID();
    const blankRequestId = randomUUID();
    const blankDigest = 'f'.repeat(64);
    await db.taskCompletionEvidence.create({
      data: {
        id: blankEvidenceId,
        taskId: f.taskId,
        ownerId: f.ownerId,
        actorType: CreatorType.USER,
        actorId: f.ownerId,
        sourceSessionId: f.sessionId,
        criterionRevision: results[0].criterionRevision,
        criterion: { completionCriterion: 'HUMAN_SIGNOFF' },
        evidence: { blankRecipient: true },
        evidenceDigest: blankDigest,
        revision: 3n,
      },
    });
    await assert.rejects(db.taskJudgmentRequest.create({
      data: {
        id: blankRequestId,
        taskId: f.taskId,
        ownerId: f.ownerId,
        evidenceId: blankEvidenceId,
        criterionRevision: results[0].criterionRevision,
        evidenceDigest: blankDigest,
        kind: 'HUMAN_SIGNOFF',
        recipientType: 'ACCOUNT_OWNER',
        recipientId: ' ',
      },
    }), /constraint|recipient/i);
    assert.equal(await db.taskJudgmentInboxItem.count({ where: { requestId: blankRequestId } }), 0);
  });

  await t.test('no device, offline push and repair advance the same auditable row', async () => {
    await empty(sql);
    const f = await fixture(db, 'retry');
    const evidence = await f.submit(1);
    const requestId = evidence.judgmentRequest!.id;
    const push = new PushService(db as unknown as PrismaService, enabledConfig());
    (push as any).authToken = () => 'auth';
    let accepted = 0;
    let transportError = false;
    (push as any).deliver = async () => {
      if (transportError) throw new Error('simulated APNs outage');
      return accepted;
    };
    const worker = new JudgmentDeliveryService(db as unknown as PrismaService, push);

    await worker.deliverDue();
    let row = await db.taskJudgmentPushDelivery.findFirstOrThrow({ where: { requestId } });
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.errorCode, 'NO_DEVICES');
    assert.equal(row.attempts, 1);
    assert.equal(row.failures, 0, 'availability does not spend the DEAD budget');
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: requestId } }), 1);
    assert.equal(await db.taskJudgmentInboxItem.count({ where: { requestId } }), 1);

    await db.deviceToken.create({
      data: {
        userId: f.ownerId,
        token: 'offline-device',
        environment: 'sandbox',
        bundleId: 'io.orbitd.app',
      },
    });
    transportError = true;
    await db.taskJudgmentPushDelivery.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await worker.deliverDue();
    row = await db.taskJudgmentPushDelivery.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(row.status, 'PENDING');
    assert.equal(row.errorCode, 'PUSH_FAILED');
    assert.match(row.lastError ?? '', /simulated APNs outage/);
    assert.equal(row.attempts, 2);
    assert.equal(row.failures, 1);
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: requestId } }), 1);
    assert.equal(await db.taskJudgmentInboxItem.count({ where: { requestId } }), 1);

    transportError = false;
    await db.taskJudgmentPushDelivery.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await worker.deliverDue();
    row = await db.taskJudgmentPushDelivery.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(row.status, 'PENDING');
    assert.equal(row.errorCode, 'PUSH_NOT_ACCEPTED');
    assert.equal(row.attempts, 3);
    assert.equal(row.failures, 2);

    accepted = 1;
    await db.taskJudgmentPushDelivery.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await worker.deliverDue();
    const repaired = await db.taskJudgmentPushDelivery.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(repaired.status, 'DELIVERED');
    assert.equal(repaired.attempts, 4);
    assert.equal(repaired.deliveredDevices, 1);
    assert.ok(repaired.deliveredAt);
    assert.equal(repaired.requestId, requestId);
    assert.match(JSON.stringify(repaired.lastPayload), /human-signoff-required/);

    // A separate request that repeatedly reaches APNs but is never accepted exhausts into a DEAD
    // receipt. The human responsibility and its primary inbox delivery remain independent facts.
    const exhaustedEvidence = await f.submit(2);
    const exhaustedRequestId = exhaustedEvidence.judgmentRequest!.id;
    const exhausted = await db.taskJudgmentPushDelivery.findFirstOrThrow({
      where: { requestId: exhaustedRequestId },
    });
    accepted = 0;
    for (let attempt = 0; attempt < JUDGMENT_DELIVERY_LIMITS.maxFailures; attempt += 1) {
      await db.taskJudgmentPushDelivery.update({
        where: { id: exhausted.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await worker.deliverDue();
    }
    const dead = await db.taskJudgmentPushDelivery.findUniqueOrThrow({
      where: { id: exhausted.id },
    });
    assert.equal(dead.status, 'DEAD');
    assert.equal(dead.attempts, JUDGMENT_DELIVERY_LIMITS.maxFailures);
    assert.equal(dead.failures, JUDGMENT_DELIVERY_LIMITS.maxFailures);
    assert.ok(dead.stoppedAt);
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: exhaustedRequestId } }), 1);
    assert.equal(await db.taskJudgmentInboxItem.count({ where: { requestId: exhaustedRequestId } }), 1);
    accepted = 1;
    assert.equal(await worker.deliverDue(), 0, 'a DEAD receipt is not resurrected implicitly');
  });

  await t.test('restart recovery and two workers send one logical notification', async () => {
    await empty(sql);
    const f = await fixture(db, 'concurrent');
    const evidence = await f.submit(1);
    const requestId = evidence.judgmentRequest!.id;
    const original = await db.taskJudgmentPushDelivery.findFirstOrThrow({ where: { requestId } });
    await db.taskJudgmentPushDelivery.update({
      where: { id: original.id },
      data: {
        status: 'DELIVERING',
        attempts: 1,
        nextAttemptAt: null,
        leaseHolder: 'dead-process',
        leaseExpiresAt: new Date(0),
        lastAttemptAt: new Date(0),
      },
    });

    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { started = resolve; });
    const push = deliveredPush(async () => {
      started();
      await gate;
    });
    const first = new JudgmentDeliveryService(
      db as unknown as PrismaService,
      push as unknown as PushService,
    );
    const second = new JudgmentDeliveryService(
      db as unknown as PrismaService,
      push as unknown as PushService,
    );
    const a = first.deliverDue();
    await began;
    const b = second.deliverDue();
    await b;
    release();
    await a;

    const receipt = await db.taskJudgmentPushDelivery.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(push.calls, 1);
    assert.equal(receipt.status, 'DELIVERED');
    assert.equal(receipt.attempts, 2, 'the stale lease is recovered on the same row');
    assert.equal(receipt.logicalNotificationKey, original.logicalNotificationKey);
    assert.equal(await db.taskJudgmentInboxItem.count({ where: { requestId } }), 1);
    assert.equal(await db.taskJudgmentPushDelivery.count({ where: { requestId } }), 1);

    const restarted = new JudgmentDeliveryService(
      db as unknown as PrismaService,
      push as unknown as PushService,
    );
    assert.equal(await restarted.deliverDue(), 0);
    assert.equal(push.calls, 1, 'a restart reads the terminal receipt instead of notifying again');
  });

  await t.test('supersession stops pending work; a decision retains an earlier delivery receipt', async () => {
    await empty(sql);
    const f = await fixture(db, 'terminal');
    const firstEvidence = await f.submit(1);
    const firstRequestId = firstEvidence.judgmentRequest!.id;
    const firstDelivery = await db.taskJudgmentPushDelivery.findFirstOrThrow({
      where: { requestId: firstRequestId },
    });
    const secondEvidence = await f.submit(2);
    const secondRequestId = secondEvidence.judgmentRequest!.id;
    const cancelled = await db.taskJudgmentPushDelivery.findUniqueOrThrow({
      where: { id: firstDelivery.id },
    });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.errorCode, 'REQUEST_SUPERSEDED');
    assert.ok(cancelled.stoppedAt);

    const push = deliveredPush();
    const worker = new JudgmentDeliveryService(
      db as unknown as PrismaService,
      push as unknown as PushService,
    );
    await worker.deliverDue();
    assert.equal(push.calls, 1, 'only the current request is projected');
    const delivered = await db.taskJudgmentPushDelivery.findFirstOrThrow({
      where: { requestId: secondRequestId },
    });
    assert.equal(delivered.status, 'DELIVERED');
    assert.ok(delivered.deliveredAt);

    await db.$transaction(async (tx) => {
      await tx.taskHumanSignoff.create({
        data: {
          taskId: f.taskId,
          requestId: secondRequestId,
          signedById: f.ownerId,
          evidenceDigest: secondEvidence.evidenceDigest,
          evidence: 'Reviewed the exact evidence digest and signed this request.',
        },
      });
      await tx.taskJudgmentRequest.update({
        where: { id: secondRequestId },
        data: {
          status: 'DECIDED',
          decidedAt: new Date(),
          decidedByType: 'USER',
          decidedById: f.ownerId,
          decision: 'PASS',
        },
      });
    });
    const historical = await db.taskJudgmentPushDelivery.findUniqueOrThrow({
      where: { id: delivered.id },
    });
    assert.equal(historical.status, 'DELIVERED');
    assert.equal(historical.deliveredAt?.toISOString(), delivered.deliveredAt?.toISOString());
    assert.equal(await worker.deliverDue(), 0);
    assert.equal(push.calls, 1, 'a decided request cannot be retried');
  });
});
