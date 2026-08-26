/** N11's VERIFICATION route and decision boundary against disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreatorType, PrismaClient, RunStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TasksService } from './tasks.service';
import { verificationEpochOpenSql } from './verification-dependency';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

function tasksService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('unassigned verifier must not dispatch'); } } as never,
    { publishForUser: () => undefined, publishTaskChanged: () => undefined } as never,
  );
}

suite('VERIFICATION evidence creates one independent verifier whose PASS decides the subject',
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
    await sql.query(`
      TRUNCATE "task", "session", "user" RESTART IDENTITY CASCADE
    `);

    const ownerId = randomUUID();
    const subjectId = randomUUID();
    const dependentId = randomUUID();
    const sourceSessionId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `${ownerId}@n11-verification.invalid`, name: 'N11 verifier', passwordHash: 'x' },
    });
    await db.task.create({
      data: {
        id: subjectId,
        ownerId,
        title: 'Subject requiring independent verification',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'VERIFICATION_PASSED',
        status: TaskStatus.IN_PROGRESS,
      },
    });
    await db.task.create({
      data: {
        id: dependentId,
        ownerId,
        title: 'Waits for verified subject',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
      },
    });
    await db.taskDependency.create({ data: { taskId: dependentId, dependsOnTaskId: subjectId } });
    await db.session.create({
      data: {
        id: sourceSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: subjectId,
        title: 'resumable evidence source',
        prompt: 'submit evidence',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });

    const tasks = tasksService(db);
    const evidenceService = new TaskCompletionEvidenceService(
      db as unknown as PrismaService,
      tasks,
    );
    const evidence = await evidenceService.submit(
      ownerId,
      subjectId,
      { type: CreatorType.USER, id: ownerId },
      {
        sourceSessionId,
        idempotencyKey: 'verification-fact',
        evidence: { command: 'npm test', exitCode: 0, artifact: 'dist/server.js' },
      },
    );
    assert.equal(evidence.judgmentRequest.kind, 'VERIFICATION');
    assert.equal(evidence.judgmentRequest.recipientType, 'VERIFIER_TASK');
    assert.equal(evidence.judgmentRequest.recipientId, evidence.judgmentRequest.id);

    const verifier = await db.task.findUniqueOrThrow({ where: { id: evidence.judgmentRequest.id } });
    assert.notEqual(verifier.id, subjectId);
    assert.equal(verifier.verifiesTaskId, subjectId);
    assert.match(verifier.description ?? '', new RegExp(evidence.evidenceDigest));
    assert.equal(await db.task.count({ where: { verifiesTaskId: subjectId } }), 1);
    assert.equal(
      (await tasks.get(ownerId, dependentId) as { dependencyState: string }).dependencyState,
      'BLOCKED',
    );
    assert.equal((await sql.query(
      `SELECT ${verificationEpochOpenSql('subject')} AS ok
         FROM "task" subject WHERE subject."id" = $1::uuid`,
      [subjectId],
    )).rows[0].ok, false, 'an OPEN judgment request closes the verification epoch');

    const replay = await evidenceService.submit(
      ownerId,
      subjectId,
      { type: CreatorType.USER, id: ownerId },
      {
        sourceSessionId,
        idempotencyKey: 'verification-fact',
        evidence: { artifact: 'dist/server.js', exitCode: 0, command: 'npm test' },
      },
    );
    assert.equal(replay.judgmentRequest.id, evidence.judgmentRequest.id);
    assert.equal(await db.task.count({ where: { verifiesTaskId: subjectId } }), 1);

    await tasks.update(ownerId, verifier.id, { verdict: 'PASS' });
    const [subject, request, decidedVerifier] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: subjectId } }),
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: evidence.judgmentRequest.id } }),
      db.task.findUniqueOrThrow({ where: { id: verifier.id } }),
    ]);
    assert.equal(subject.status, TaskStatus.DONE);
    assert.equal(decidedVerifier.status, TaskStatus.DONE,
      'the verdict derives the request-bound verifier carrier terminal in the same transaction');
    assert.equal(decidedVerifier.verdict, 'PASS');
    assert.equal(request.status, 'DECIDED');
    assert.equal(request.decision, 'PASS');
    assert.equal(request.decidedByType, 'USER');
    assert.ok(request.decidedAt);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "task_judgment_signal" WHERE "task_id" = $1::uuid`,
      [subjectId],
    )).rows[0].n, 0);
    assert.equal((await sql.query(
      `SELECT ${verificationEpochOpenSql('subject')} AS ok
         FROM "task" subject WHERE subject."id" = $1::uuid`,
      [subjectId],
    )).rows[0].ok, true, 'the request-bound PASS opens the SQL dependency epoch');
    assert.equal((await tasks.get(ownerId, dependentId) as { dependencyState: string }).dependencyState,
      'READY');

    await assert.rejects(
      db.task.update({ where: { id: verifier.id }, data: { verdict: null } }),
      /TASK_JUDGMENT_VERIFIER_TERMINAL_IMMUTABLE/,
      'a raw writer cannot revoke the verdict behind a decided request',
    );
    await assert.rejects(
      db.task.update({ where: { id: verifier.id }, data: { status: TaskStatus.OPEN } }),
      /TASK_JUDGMENT_VERIFIER_TERMINAL_IMMUTABLE/,
      'a raw writer cannot reopen the verifier carrier behind a decided request',
    );
    const immutable = await db.task.findUniqueOrThrow({ where: { id: verifier.id } });
    assert.equal(immutable.status, TaskStatus.DONE);
    assert.equal(immutable.verdict, 'PASS');
  });

suite('new VERIFICATION evidence retires the old carrier and only the new request can decide',
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
    await sql.query(`
      TRUNCATE "task", "session", "user" RESTART IDENTITY CASCADE
    `);

    const ownerId = randomUUID();
    const subjectId = randomUUID();
    const sourceSessionId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `${ownerId}@n11-verification-supersede.invalid`,
        name: 'N11 verifier supersession',
        passwordHash: 'x',
      },
    });
    await db.task.create({
      data: {
        id: subjectId,
        ownerId,
        title: 'Subject with revised verification evidence',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'VERIFICATION_PASSED',
        status: TaskStatus.IN_PROGRESS,
      },
    });
    await db.session.create({
      data: {
        id: sourceSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: subjectId,
        title: 'revisable evidence source',
        prompt: 'submit revised evidence',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });

    const tasks = tasksService(db);
    const evidenceService = new TaskCompletionEvidenceService(
      db as unknown as PrismaService,
      tasks,
    );
    const first = await evidenceService.submit(
      ownerId,
      subjectId,
      { type: CreatorType.USER, id: ownerId },
      {
        sourceSessionId,
        idempotencyKey: 'verification-v1',
        evidence: { artifact: 'dist/v1.js', command: 'npm test', exitCode: 0 },
      },
    );
    const second = await evidenceService.submit(
      ownerId,
      subjectId,
      { type: CreatorType.USER, id: ownerId },
      {
        sourceSessionId,
        idempotencyKey: 'verification-v2',
        evidence: { artifact: 'dist/v2.js', command: 'npm test', exitCode: 0 },
      },
    );

    const [oldRequest, currentRequest, oldCarrier, currentCarrier] = await Promise.all([
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: first.judgmentRequest.id } }),
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: second.judgmentRequest.id } }),
      db.task.findUniqueOrThrow({ where: { id: first.judgmentRequest.id } }),
      db.task.findUniqueOrThrow({ where: { id: second.judgmentRequest.id } }),
    ]);
    assert.equal(oldRequest.status, 'SUPERSEDED');
    assert.equal(oldRequest.supersededById, currentRequest.id);
    assert.equal(oldCarrier.status, TaskStatus.CANCELLED,
      'historical verifier work is terminal and cannot wedge project settlement');
    assert.equal(currentRequest.status, 'OPEN');
    assert.equal(currentCarrier.status, TaskStatus.OPEN);
    assert.equal(await db.taskJudgmentRequest.count({
      where: { taskId: subjectId, status: 'OPEN' },
    }), 1);

    await assert.rejects(
      tasks.update(ownerId, oldCarrier.id, { verdict: 'PASS' }),
      /VERIFICATION_REQUEST_SUPERSEDED|evidence version that is no longer open/,
    );
    await assert.rejects(
      db.task.update({ where: { id: oldCarrier.id }, data: { verdict: 'PASS' } }),
      /TASK_JUDGMENT_VERIFIER_TERMINAL_IMMUTABLE/,
      'the database also refuses a verdict on a superseded carrier',
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: subjectId } })).status,
      TaskStatus.IN_PROGRESS, 'the obsolete request cannot complete the subject');

    await tasks.update(ownerId, currentCarrier.id, { verdict: 'PASS' });
    const [subject, decidedCurrent] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: subjectId } }),
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: currentRequest.id } }),
    ]);
    assert.equal(subject.status, TaskStatus.DONE);
    assert.equal(decidedCurrent.status, 'DECIDED');
    assert.equal(decidedCurrent.decision, 'PASS');
  });
