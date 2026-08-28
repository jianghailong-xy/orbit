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
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

function tasksService(db: PrismaClient, completionInputs?: CompletionInputRouter): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    {
      create: () => { throw new Error('unassigned verifier must not dispatch'); },
      cancel: async () => true,
    } as never,
    { publishForUser: () => undefined, publishTaskChanged: () => undefined } as never,
    undefined,
    completionInputs,
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
    const projectId = randomUUID();
    const subjectId = randomUUID();
    const dependentId = randomUUID();
    const sourceSessionId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `${ownerId}@n11-verification.invalid`, name: 'N11 verifier', passwordHash: 'x' },
    });
    await db.project.create({
      data: { id: projectId, ownerId, title: 'N7 versioned verification inputs' },
    });
    await db.task.create({
      data: {
        id: subjectId,
        ownerId,
        title: 'Subject requiring independent verification',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        projectId,
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
        projectId,
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

    const router = new CompletionInputRouter(
      new CoordinatorWakeService(db as unknown as PrismaService),
    );
    const tasks = tasksService(db, router);
    const evidenceService = new TaskCompletionEvidenceService(
      db as unknown as PrismaService,
      tasks,
      undefined,
      router,
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
    assert.equal(evidence.judgmentRequest!.kind, 'VERIFICATION');
    assert.equal(evidence.judgmentRequest!.recipientType, 'VERIFIER_TASK');
    assert.equal(evidence.judgmentRequest!.recipientId, evidence.judgmentRequest!.id);

    const verifier = await db.task.findUniqueOrThrow({ where: { id: evidence.judgmentRequest!.id } });
    assert.notEqual(verifier.id, subjectId);
    assert.equal(verifier.verifiesTaskId, subjectId);
    assert.match(verifier.description ?? '', new RegExp(evidence.evidenceDigest));
    assert.equal(await db.task.count({ where: { verifiesTaskId: subjectId } }), 1);
    assert.equal(
      await db.projectCoordinatorWake.count({
        where: {
          projectId,
          event: 'COMPLETION_EVIDENCE_REVISED',
          status: 'CONSUMED',
          consumerType: 'JUDGMENT_REQUEST_DERIVER',
        },
      }),
      1,
    );
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
    assert.equal(replay.judgmentRequest!.id, evidence.judgmentRequest!.id);
    assert.equal(await db.task.count({ where: { verifiesTaskId: subjectId } }), 1);

    const otherSubjectId = randomUUID();
    await db.task.create({
      data: {
        id: otherSubjectId,
        ownerId,
        title: 'A different verification subject',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        projectId,
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'VERIFICATION_PASSED',
      },
    });
    await assert.rejects(
      tasks.update(ownerId, verifier.id, {
        verifiesTaskId: null,
        completionCriterion: 'HUMAN_SIGNOFF',
        completionPolicy: 'MANUAL',
      }),
      (error: any) => {
        assert.equal(error.getResponse?.().code,
          'VERIFICATION_REQUEST_CARRIER_SUBJECT_IMMUTABLE');
        return true;
      },
      'the service refuses to detach an OPEN request carrier from its subject',
    );
    await assert.rejects(
      tasks.update(ownerId, verifier.id, { verifiesTaskId: otherSubjectId }),
      (error: any) => {
        assert.equal(error.getResponse?.().code,
          'VERIFICATION_REQUEST_CARRIER_SUBJECT_IMMUTABLE');
        return true;
      },
      'the service refuses to repoint an OPEN request carrier',
    );
    await assert.rejects(
      db.task.update({ where: { id: verifier.id }, data: { verifiesTaskId: null } }),
      /VERIFICATION_REQUEST_CARRIER_SUBJECT_IMMUTABLE/,
      'the database refuses to detach an OPEN request carrier',
    );
    await assert.rejects(
      db.task.update({ where: { id: verifier.id }, data: { verifiesTaskId: otherSubjectId } }),
      /VERIFICATION_REQUEST_CARRIER_SUBJECT_IMMUTABLE/,
      'the database refuses to repoint an OPEN request carrier',
    );
    await assert.rejects(
      tasks.remove(ownerId, verifier.id),
      (error: any) => {
        assert.equal(error.getResponse?.().code, 'VERIFICATION_REQUEST_CARRIER_DELETE_REFUSED');
        return true;
      },
      'the service refuses to orphan an OPEN request by deleting only its carrier',
    );
    await assert.rejects(
      db.task.delete({ where: { id: verifier.id } }),
      /VERIFICATION_REQUEST_CARRIER_DELETE_REFUSED/,
      'the deferred database guard refuses a direct carrier delete at commit',
    );
    assert.equal(await db.task.count({ where: { id: verifier.id } }), 1);
    assert.equal(await db.taskJudgmentRequest.count({
      where: { id: evidence.judgmentRequest!.id, status: 'OPEN' },
    }), 1);

    // The delete guard is deferred so a complete lifecycle delete is independent of PostgreSQL's
    // row order. Exercise both legal shapes without consuming the fixture needed below.
    await sql.query('BEGIN');
    try {
      await sql.query('DELETE FROM "task" WHERE "id" = $1::uuid', [subjectId]);
      await sql.query('SET CONSTRAINTS "task_judgment_verifier_delete_guard" IMMEDIATE');
      assert.equal((await sql.query(
        'SELECT count(*)::int AS n FROM "task" WHERE "id" IN ($1::uuid, $2::uuid)',
        [subjectId, verifier.id],
      )).rows[0].n, 0, 'subject deletion cascades its OPEN request carrier');
    } finally {
      await sql.query('ROLLBACK');
    }
    await sql.query('BEGIN');
    try {
      await sql.query(
        'DELETE FROM "task" WHERE "id" IN ($1::uuid, $2::uuid)',
        [subjectId, verifier.id],
      );
      await sql.query('SET CONSTRAINTS "task_judgment_verifier_delete_guard" IMMEDIATE');
      assert.equal((await sql.query(
        'SELECT count(*)::int AS n FROM "task" WHERE "id" IN ($1::uuid, $2::uuid)',
        [subjectId, verifier.id],
      )).rows[0].n, 0, 'an explicit subject-plus-carrier batch is not row-order dependent');
    } finally {
      await sql.query('ROLLBACK');
    }

    await assert.rejects(
      db.task.update({ where: { id: verifier.id }, data: { verdict: 'PASS' } }),
      /OPEN_VERIFICATION_REQUEST_CARRIER_VERDICT_REFUSED/,
      'a raw carrier verdict cannot commit while its VERIFICATION request remains OPEN',
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: verifier.id } })).verdict, null);

    // Model the pre-invariant split state that motivated the repair: a secondary writer already
    // put PASS on the carrier but did not decide the request. Repeating that same PATCH through the
    // service must consume the OPEN request even though the scalar verdict itself does not change.
    await sql.query(
      'ALTER TABLE "task" DISABLE TRIGGER "task_open_verification_request_carrier_guard"',
    );
    try {
      await db.task.update({ where: { id: verifier.id }, data: { verdict: 'PASS' } });
    } finally {
      await sql.query(
        'ALTER TABLE "task" ENABLE TRIGGER "task_open_verification_request_carrier_guard"',
      );
    }
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: verifier.id } })).status,
      TaskStatus.DONE);
    assert.equal((await db.taskJudgmentRequest.findUniqueOrThrow({
      where: { id: evidence.judgmentRequest!.id },
    })).status, 'OPEN');

    await assert.rejects(
      tasks.update(ownerId, verifier.id, { verdict: 'PASS' }, sourceSessionId),
      /independent run/,
      'same-value request consumption still enforces verifier independence',
    );
    assert.equal((await db.taskJudgmentRequest.findUniqueOrThrow({
      where: { id: evidence.judgmentRequest!.id },
    })).status, 'OPEN', 'refused split-state consumers leave the request actionable');

    await tasks.update(ownerId, verifier.id, { verdict: 'PASS' });
    const [subject, request, decidedVerifier] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: subjectId } }),
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: evidence.judgmentRequest!.id } }),
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
    const verdictInput = await db.projectCoordinatorWake.findFirstOrThrow({
      where: { projectId, event: 'VERIFICATION_VERDICT_RECORDED', subjectId: request.id },
    });
    assert.equal(verdictInput.status, 'CONSUMED');
    assert.equal(verdictInput.consumerType, 'DERIVED_COMPLETION_EVALUATOR');
    assert.match(verdictInput.subjectVersion, new RegExp(`^${decidedVerifier.verdictRevision}:`));
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

    await tasks.update(ownerId, verifier.id, { verdict: 'PASS' });
    assert.equal((await db.taskJudgmentRequest.findUniqueOrThrow({
      where: { id: evidence.judgmentRequest!.id },
    })).status, 'DECIDED', 'a retry after the atomic decision is idempotent too');

    await tasks.remove(ownerId, subjectId);
    assert.equal(await db.task.count({ where: { id: { in: [subjectId, verifier.id] } } }), 0);
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: evidence.judgmentRequest!.id } }), 0,
      'normal subject deletion cascades the request and carrier together');
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
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: first.judgmentRequest!.id } }),
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: second.judgmentRequest!.id } }),
      db.task.findUniqueOrThrow({ where: { id: first.judgmentRequest!.id } }),
      db.task.findUniqueOrThrow({ where: { id: second.judgmentRequest!.id } }),
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
      /VERIFICATION_REQUEST_SUPERSEDED|evidence version that is no longer open|cancelled or retired verification task/,
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

suite('OPEN VERIFICATION request/carrier invariant survives concurrent raw writers',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const admin = new Client({ connectionString: URL });
    const left = new Client({ connectionString: URL });
    const right = new Client({ connectionString: URL });
    await Promise.all([admin.connect(), left.connect(), right.connect()]);
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await Promise.all([admin.end(), left.end(), right.end()]);
    });
    await verifyCoordinatorPgIdentity(admin);
    await admin.query(`TRUNCATE "task", "session", "user" RESTART IDENTITY CASCADE`);

    const ownerId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `${ownerId}@verification-carrier-race.invalid`,
        name: 'Verification carrier race',
        passwordHash: 'x',
      },
    });

    type RaceFixture = {
      subjectId: string;
      otherSubjectId: string;
      carrierId: string;
      evidenceId: string;
      criterionRevision: string;
      evidenceDigest: string;
    };
    const digest = () => randomUUID().replaceAll('-', '').repeat(2);
    const fixture = async (label: string): Promise<RaceFixture> => {
      const subjectId = randomUUID();
      const otherSubjectId = randomUUID();
      const carrierId = randomUUID();
      const evidenceId = randomUUID();
      const criterionRevision = digest();
      const evidenceDigest = digest();
      await db.task.createMany({
        data: [subjectId, otherSubjectId].map((id, index) => ({
          id,
          ownerId,
          title: `${label} subject ${index + 1}`,
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          completionCriterion: 'VERIFICATION' as const,
          completionPolicy: 'VERIFICATION_PASSED' as const,
          status: TaskStatus.IN_PROGRESS,
        })),
      });
      await db.task.create({
        data: {
          id: carrierId,
          ownerId,
          title: `${label} carrier`,
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          verifiesTaskId: subjectId,
          completionCriterion: 'VERIFICATION',
          completionPolicy: 'MANUAL',
        },
      });
      await db.taskCompletionEvidence.create({
        data: {
          id: evidenceId,
          taskId: subjectId,
          ownerId,
          actorType: CreatorType.USER,
          actorId: ownerId,
          sourceSessionId: randomUUID(),
          criterionRevision,
          criterion: { completionCriterion: 'VERIFICATION' },
          evidence: { race: label },
          evidenceDigest,
          revision: 1n,
        },
      });
      return {
        subjectId,
        otherSubjectId,
        carrierId,
        evidenceId,
        criterionRevision,
        evidenceDigest,
      };
    };
    const insertRequest = (client: Client, target: RaceFixture) => client.query(`
      INSERT INTO "task_judgment_request" (
        "id", "task_id", "owner_id", "evidence_id", "criterion_revision", "evidence_digest",
        "kind", "recipient_type", "recipient_id"
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
                'VERIFICATION', 'VERIFIER_TASK', $1::uuid::text)
    `, [
      target.carrierId,
      target.subjectId,
      ownerId,
      target.evidenceId,
      target.criterionRevision,
      target.evidenceDigest,
    ]);
    const concurrent = async (
      target: RaceFixture,
      mutateCarrier: (client: Client, target: RaceFixture) => Promise<unknown>,
      expected: RegExp,
    ) => {
      await Promise.all([left.query('BEGIN'), right.query('BEGIN')]);
      await Promise.all([mutateCarrier(left, target), insertRequest(right, target)]);
      const results = await Promise.allSettled([left.query('COMMIT'), right.query('COMMIT')]);
      await Promise.all([left.query('ROLLBACK').catch(() => undefined),
        right.query('ROLLBACK').catch(() => undefined)]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1,
        'the two conflicting raw facts cannot both commit');
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.match(String(rejected.reason?.message ?? rejected.reason), expected);
    };

    const verdictRace = await fixture('verdict race');
    await concurrent(
      verdictRace,
      (client, target) => client.query(
        `UPDATE "task" SET "verdict" = 'PASS' WHERE "id" = $1::uuid`,
        [target.carrierId],
      ),
      /OPEN_VERIFICATION_REQUEST_CARRIER_VERDICT_REFUSED/,
    );
    const verdictState = await db.task.findUniqueOrThrow({ where: { id: verdictRace.carrierId } });
    const verdictRequest = await db.taskJudgmentRequest.findUnique({
      where: { id: verdictRace.carrierId },
    });
    assert.ok(!verdictRequest || verdictState.verdict == null,
      'an OPEN request never coexists with a carrier verdict after the race');

    const supersedeRace = await fixture('supersede race');
    await insertRequest(admin, supersedeRace);
    const successorCarrierId = randomUUID();
    const successorEvidenceId = randomUUID();
    const successorCriterionRevision = digest();
    const successorEvidenceDigest = digest();
    await db.taskCompletionEvidence.create({
      data: {
        id: successorEvidenceId,
        taskId: supersedeRace.subjectId,
        ownerId,
        actorType: CreatorType.USER,
        actorId: ownerId,
        sourceSessionId: randomUUID(),
        criterionRevision: successorCriterionRevision,
        criterion: { completionCriterion: 'VERIFICATION' },
        evidence: { race: 'supersede race successor' },
        evidenceDigest: successorEvidenceDigest,
        revision: 2n,
      },
    });
    await db.taskJudgmentRequest.create({
      data: {
        id: successorCarrierId,
        taskId: supersedeRace.subjectId,
        ownerId,
        evidenceId: successorEvidenceId,
        criterionRevision: successorCriterionRevision,
        evidenceDigest: successorEvidenceDigest,
        kind: 'VERIFICATION',
        recipientType: 'VERIFIER_TASK',
        recipientId: successorCarrierId,
      },
    });

    // Let the SUPERSEDED transition win the shared fence but remain uncommitted, then start a raw
    // verdict commit from the snapshot in which the request was still OPEN. Once the request
    // commits, that writer must re-read the terminal state and refuse the stranded verdict.
    await right.query('BEGIN');
    await right.query(`
      UPDATE "task_judgment_request"
         SET "status" = 'SUPERSEDED',
             "superseded_at" = clock_timestamp(),
             "superseded_by_id" = $2::uuid,
             "supersession_rule" = 'EVIDENCE_REVISED',
             "superseded_actor_type" = 'USER',
             "superseded_actor_id" = $3::uuid,
             "superseded_source_session_id" = $4::uuid
       WHERE "id" = $1::uuid
    `, [supersedeRace.carrierId, successorCarrierId, ownerId, randomUUID()]);
    await right.query('SET CONSTRAINTS "task_open_verification_request_guard" IMMEDIATE');
    await left.query('BEGIN');
    await left.query(
      `UPDATE "task" SET "verdict" = 'PASS' WHERE "id" = $1::uuid`,
      [supersedeRace.carrierId],
    );
    const staleVerdictCommit = left.query('COMMIT');
    const supersedeCommit = right.query('COMMIT');
    const supersedeResults = await Promise.allSettled([staleVerdictCommit, supersedeCommit]);
    await Promise.all([left.query('ROLLBACK').catch(() => undefined),
      right.query('ROLLBACK').catch(() => undefined)]);
    assert.equal(supersedeResults[0].status, 'rejected');
    if (supersedeResults[0].status === 'rejected') {
      assert.match(String(supersedeResults[0].reason?.message ?? supersedeResults[0].reason),
        /SUPERSEDED_VERIFICATION_REQUEST_CARRIER_VERDICT_REFUSED/);
    }
    assert.equal(supersedeResults[1].status, 'fulfilled');
    assert.equal((await db.task.findUniqueOrThrow({
      where: { id: supersedeRace.carrierId },
    })).verdict, null);
    assert.equal((await db.taskJudgmentRequest.findUniqueOrThrow({
      where: { id: supersedeRace.carrierId },
    })).status, 'SUPERSEDED');

    for (const change of ['repoint', 'detach'] as const) {
      const subjectRace = await fixture(`${change} race`);
      await concurrent(
        subjectRace,
        (client, target) => change === 'repoint'
          ? client.query(
            `UPDATE "task" SET "verifies_task_id" = $2::uuid WHERE "id" = $1::uuid`,
            [target.carrierId, target.otherSubjectId],
          )
          : client.query(`
              UPDATE "task"
                 SET "verifies_task_id" = NULL,
                     "completion_policy" = 'VERIFICATION_PASSED'
               WHERE "id" = $1::uuid
            `, [target.carrierId]),
        /VERIFICATION_REQUEST_CARRIER_SUBJECT_IMMUTABLE/,
      );
      const [carrier, request] = await Promise.all([
        db.task.findUniqueOrThrow({ where: { id: subjectRace.carrierId } }),
        db.taskJudgmentRequest.findUnique({ where: { id: subjectRace.carrierId } }),
      ]);
      assert.ok(!request || carrier.verifiesTaskId === request.taskId,
        `an OPEN request remains bound to its original subject after concurrent ${change}`);
    }

    const deleteRace = await fixture('delete race');
    await right.query('BEGIN');
    await insertRequest(right, deleteRace);
    // Force this request to win the shared commit fence while the transaction remains open. The
    // concurrent direct DELETE may remove its row locally, but must fail when it reaches the fence.
    await right.query('SET CONSTRAINTS "task_open_verification_request_guard" IMMEDIATE');
    await left.query('BEGIN');
    await left.query(`DELETE FROM "task" WHERE "id" = $1::uuid`, [deleteRace.carrierId]);
    const deleteResults = await Promise.allSettled([right.query('COMMIT'), left.query('COMMIT')]);
    await Promise.all([left.query('ROLLBACK').catch(() => undefined),
      right.query('ROLLBACK').catch(() => undefined)]);
    assert.equal(deleteResults[0].status, 'fulfilled');
    assert.equal(deleteResults[1].status, 'rejected');
    if (deleteResults[1].status === 'rejected') {
      assert.match(String(deleteResults[1].reason?.message ?? deleteResults[1].reason),
        /VERIFICATION_REQUEST_CARRIER_DELETE_REFUSED/);
    }
    assert.equal(await db.task.count({ where: { id: deleteRace.carrierId } }), 1);
    assert.equal(await db.taskJudgmentRequest.count({
      where: { id: deleteRace.carrierId, status: 'OPEN' },
    }), 1, 'the request-first delete race leaves one actionable request with its carrier');
  });
