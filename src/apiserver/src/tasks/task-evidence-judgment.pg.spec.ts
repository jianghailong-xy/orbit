/**
 * The EVIDENCE_JUDGMENT boundary against real PostgreSQL, after migration 0224 removed the human
 * step from it.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable database accepted by the
 * coordinator PG safety guard, with migration 0224 applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const ATOMIC_TRIGGER = 'evidence_judgment_atomic_assert';
const ATOMIC_FUNCTION = 'evidence_judgment_atomic_assert_fn';

function tasksService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('this fixture never dispatches'); } } as never,
    {
      publishForUser: () => undefined,
      publishTaskChanged: () => undefined,
    } as unknown as RealtimeService,
  );
}

test('the decision is the request row, bound to one evidence version and forced to say why', () => {
  const removal = readFileSync(join(
    process.cwd(), 'prisma', 'migrations',
    '0224_evidence_judgment_removal_of_human_signoff', 'migration.sql',
  ), 'utf8');
  const n11 = readFileSync(join(
    process.cwd(), 'prisma', 'migrations', '0181_task_judgment_request', 'migration.sql',
  ), 'utf8');
  // The separate human-authored event table is gone, and its prose moved onto the request first.
  assert.match(removal, /SET "decision_note" = s\."evidence"/);
  assert.match(removal, /DROP TABLE "task_human_signoff"/);
  assert.match(removal, /DROP TRIGGER IF EXISTS "task_human_signoff_current_request_guard"/);
  // The evidence binding it used to sit beside is untouched and still four columns wide.
  assert.match(n11, /CONSTRAINT "task_judgment_request_evidence_fact_fkey"/);
  assert.match(
    n11,
    /FOREIGN KEY \("evidence_id", "task_id", "criterion_revision", "evidence_digest"\)/,
  );
  assert.doesNotMatch(removal.replace(/^\s*--.*$/gm, ''),
    /task_judgment_request_evidence_fact_fkey/,
    'the removal migration must not restate, replace or weaken the evidence binding');
  // What replaces the human-only decider rule: any attributed principal, and a stated finding.
  assert.match(
    removal,
    /"kind" = 'EVIDENCE_JUDGMENT' AND "decided_by_type" IN \('USER', 'AGENT'\)\s*\n\s*AND length\(btrim\("decision_note"\)\) > 0/,
  );
});

suite('an evidence judgment atomically derives DONE and removes the open decision view',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await sql.query(`DROP TRIGGER IF EXISTS "${ATOMIC_TRIGGER}" ON "task"`);
      await sql.query(`DROP FUNCTION IF EXISTS "${ATOMIC_FUNCTION}"()`);
      await db.$disconnect();
      await sql.end();
    });
    await verifyCoordinatorPgIdentity(sql);
    await sql.query(`
      DROP TRIGGER IF EXISTS "${ATOMIC_TRIGGER}" ON "task";
      DROP FUNCTION IF EXISTS "${ATOMIC_FUNCTION}"();
      TRUNCATE "task", "project_runtime", "project", "user" RESTART IDENTITY CASCADE
    `);

    const ownerId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const dependentId = randomUUID();
    const oldEvidenceId = randomUUID();
    const oldRequestId = randomUUID();
    const evidenceId = randomUUID();
    const requestId = randomUUID();
    const sourceSessionId = randomUUID();
    const criterionRevision = 'b'.repeat(64);
    const oldEvidenceDigest = 'c'.repeat(64);
    const evidenceDigest = 'd'.repeat(64);
    const now = new Date();
    await db.user.create({
      data: { id: ownerId, email: `${ownerId}@n2.invalid`, name: 'N2 signer', passwordHash: 'x' },
    });
    await db.project.create({ data: { id: projectId, ownerId, title: 'N2 atomic signoff' } });
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
        title: 'Needs a human judgment',
        creatorType: 'USER',
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
        title: 'Released only by the derived completion',
        creatorType: 'USER',
        creatorId: ownerId,
        status: TaskStatus.OPEN,
      },
    });
    await db.taskDependency.create({ data: { taskId: dependentId, dependsOnTaskId: taskId } });
    const oldCreatedAt = new Date(now.getTime() - 1_000);
    await db.taskCompletionEvidence.create({
      data: {
        id: oldEvidenceId,
        taskId,
        ownerId,
        actorType: 'USER',
        actorId: ownerId,
        sourceSessionId,
        criterionRevision,
        criterion: { completionCriterion: 'EVIDENCE_JUDGMENT' },
        evidence: { revision: 'old' },
        evidenceDigest: oldEvidenceDigest,
        revision: 1n,
        submittedAt: oldCreatedAt,
      },
    });
    await db.taskJudgmentRequest.create({
      data: {
        id: oldRequestId,
        taskId,
        ownerId,
        evidenceId: oldEvidenceId,
        criterionRevision,
        evidenceDigest: oldEvidenceDigest,
        kind: 'EVIDENCE_JUDGMENT',
        recipientType: 'ACCOUNT_OWNER',
        recipientId: ownerId,
        createdAt: oldCreatedAt,
      },
    });
    await db.taskCompletionEvidence.create({
      data: {
        id: evidenceId,
        taskId,
        ownerId,
        actorType: 'USER',
        actorId: ownerId,
        sourceSessionId,
        criterionRevision,
        criterion: { completionCriterion: 'EVIDENCE_JUDGMENT' },
        evidence: { revision: 'current', command: 'npm test', exitCode: 0 },
        evidenceDigest,
        revision: 2n,
        submittedAt: now,
      },
    });
    await db.taskJudgmentRequest.create({
      data: {
        id: requestId,
        taskId,
        ownerId,
        evidenceId,
        criterionRevision,
        evidenceDigest,
        kind: 'EVIDENCE_JUDGMENT',
        recipientType: 'ACCOUNT_OWNER',
        recipientId: ownerId,
        createdAt: now,
      },
    });
    await db.taskJudgmentRequest.update({
      where: { id: oldRequestId },
      data: {
        status: 'SUPERSEDED',
        supersededAt: now,
        supersededById: requestId,
      },
    });
    const blocker = await db.projectBlocker.create({
      data: {
        projectId,
        kind: 'HUMAN_DECISION_REQUIRED',
        owner: 'USER',
        recovery: 'HUMAN',
        severity: 'CRITICAL',
        requiredAction: 'A person must inspect the evidence and sign off this task.',
        nextCheckAt: now,
        subjectType: 'TASK',
        subjectId: taskId,
        detail: { source: 'ATTEMPT_ENDED_UNSETTLED' },
        dedupeKey: `HUMAN_DECISION_REQUIRED:TASK_NO_JUDGMENT:${taskId}`,
        lifecycleGeneration: 1n,
        conditionVersion: 'a'.repeat(64),
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    await db.taskComment.create({
      data: {
        taskId,
        authorType: 'USER',
        authorId: ownerId,
        body: '<!-- orbit:ATTEMPT_ENDED_WITHOUT_JUDGMENT_PATH -->\nNeeds human decision',
      },
    });

    // Negative control: before the decision the criterion is unsatisfied and its signal is open.
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.OPEN);
    assert.equal(await db.taskJudgmentRequest.count({
      where: { taskId, status: 'DECIDED' },
    }), 0);
    assert.equal(await db.projectBlocker.count({
      where: { id: blocker.id, resolvedAt: null },
    }), 1);
    assert.equal(await db.taskJudgmentRequest.count({ where: { taskId, status: 'OPEN' } }), 1);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "task_judgment_signal" WHERE "task_id" = $1::uuid`,
      [taskId],
    )).rows[0].n, 1);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "project_judgment_blocker" WHERE "task_id" = $1::uuid`,
      [taskId],
    )).rows[0].n, 1);

    const service = tasksService(db);
    const judgment = {
      requestId,
      evidenceDigest,
      evidence: 'Reviewed commit 0123456789abcdef and `npm test`; exit 0, 2670 tests.',
    };

    // Negative: the finding is what replaced the signoff row, so a blank one is refused and
    // consumes nothing. This is the evidence requirement, not a human requirement.
    await assert.rejects(
      service.judge(ownerId, taskId, { ...judgment, evidence: '   ' }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        const body = error.getResponse() as Record<string, unknown>;
        assert.equal(body.code, 'EVIDENCE_JUDGMENT_FINDING_REQUIRED');
        assert.equal(body.criterion, 'EVIDENCE_JUDGMENT');
        return true;
      },
    );
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: requestId, status: 'OPEN' } }), 1,
      'a refused judgment does not consume the request fact');

    await assert.rejects(
      service.judge(ownerId, taskId, {
        requestId: oldRequestId,
        evidenceDigest: oldEvidenceDigest,
        evidence: 'trying to decide stale evidence',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal((error.getResponse() as Record<string, unknown>).code,
          'EVIDENCE_JUDGMENT_REQUEST_SUPERSEDED');
        return true;
      },
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.OPEN);

    // This BEFORE UPDATE trigger runs at the exact status transition, inside the production
    // transaction. It makes the spec fail if either the event INSERT or blocker resolution is
    // moved to an after-commit cleanup while a later read still happens to see the final state.
    await sql.query(`
      CREATE FUNCTION "${ATOMIC_FUNCTION}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${taskId}'::uuid
           AND OLD."status" IS DISTINCT FROM 'DONE'::task_status
           AND NEW."status" = 'DONE'::task_status THEN
          IF NOT EXISTS (
            SELECT 1 FROM "task_judgment_request" r
             WHERE r."id" = '${requestId}'::uuid
               AND r."task_id" = NEW."id"
               AND r."evidence_digest" = '${evidenceDigest}'
               AND r."status" = 'DECIDED' AND r."decision" = 'PASS'
               AND r."decided_at" IS NOT NULL
               AND r."decided_by_type" IN ('USER', 'AGENT')
               AND length(btrim(r."decided_by_id")) > 0
               AND length(btrim(r."decision_note")) > 0
          ) THEN
            RAISE EXCEPTION 'ATOMIC_ASSERT: decided finding absent at DONE transition';
          END IF;
          IF EXISTS (
            SELECT 1 FROM "task_judgment_signal" signal WHERE signal."task_id" = NEW."id"
          ) OR EXISTS (
            SELECT 1 FROM "project_judgment_blocker" blocker WHERE blocker."task_id" = NEW."id"
          ) THEN
            RAISE EXCEPTION 'N11_ATOMIC_ASSERT: derived request view still open at DONE transition';
          END IF;
          IF EXISTS (
            SELECT 1 FROM "project_blocker" b
             WHERE b."project_id" = NEW."project_id"
               AND b."kind" = 'HUMAN_DECISION_REQUIRED'
               AND b."subject_type" = 'TASK'
               AND b."subject_id" = NEW."id"::text
               AND b."resolved_at" IS NULL
          ) THEN
            RAISE EXCEPTION 'N2_ATOMIC_ASSERT: blocker still open at DONE transition';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "${ATOMIC_TRIGGER}"
        BEFORE UPDATE OF "status" ON "task"
        FOR EACH ROW EXECUTE FUNCTION "${ATOMIC_FUNCTION}"()
    `);

    // Two authorised handlers race on the same fact, and one of them is an agent session — the
    // call the removed HUMAN_SIGNOFF gate refused outright. The owner/task/request locks make the
    // loser observe the committed decision and replay it instead of deciding twice.
    const agentSessionId = randomUUID();
    await db.session.create({
      data: {
        id: agentSessionId,
        ownerId,
        creatorId: ownerId,
        taskId,
        title: 'judging run',
        prompt: 'decide the open evidence judgment',
        dispatchOrigin: 'PROJECT_COORDINATOR',
        startsTaskWork: false,
      },
    });
    const [first, second] = await Promise.all([
      service.judge(ownerId, taskId, judgment, agentSessionId),
      service.judge(ownerId, taskId, { ...judgment, evidence: 'concurrent duplicate review' }),
    ]);
    const results = [first, second];
    const result = results.find((candidate) => candidate.transitioned)!;

    assert.equal(result.status, TaskStatus.DONE);
    assert.equal(result.transitioned, true);
    assert.equal(results.filter((candidate) => candidate.transitioned).length, 1);
    assert.equal(result.blockersResolved, 1);
    assert.equal(result.judgment.taskId, taskId);
    assert.ok(result.judgment.decidedById, 'who decided is durable and non-empty');
    assert.ok(result.judgment.decidedAt instanceof Date, 'when they decided is durable');
    assert.equal(second.judgment.requestId, result.judgment.requestId);
    assert.ok([judgment.evidence, 'concurrent duplicate review'].includes(result.judgment.evidence));
    assert.equal(result.judgment.requestId, requestId);
    assert.equal(result.judgment.evidenceDigest, evidenceDigest);

    const [storedTask, storedBlocker, storedRequest] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: taskId } }),
      db.projectBlocker.findUniqueOrThrow({ where: { id: blocker.id } }),
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: requestId } }),
    ]);
    assert.equal(storedTask.status, TaskStatus.DONE);
    assert.equal(storedRequest.status, 'DECIDED');
    assert.equal(storedRequest.decision, 'PASS');
    assert.ok(['USER', 'AGENT'].includes(storedRequest.decidedByType!));
    assert.ok((storedRequest.decisionNote ?? '').trim().length > 0,
      'the finding is mandatory and is what the deleted signoff row used to hold');
    assert.ok(storedRequest.decidedAt);
    assert.ok(storedBlocker.resolvedAt);
    assert.equal(storedBlocker.resolvedBy, 'AUTO');
    assert.equal(await db.projectBlocker.count({
      where: {
        projectId,
        kind: 'HUMAN_DECISION_REQUIRED',
        subjectType: 'TASK',
        subjectId: taskId,
        resolvedAt: null,
      },
    }), 0, 'the unsatisfied-criterion view no longer exists as an open blocker');
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "task_judgment_signal" WHERE "task_id" = $1::uuid`,
      [taskId],
    )).rows[0].n, 0);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "project_judgment_blocker" WHERE "task_id" = $1::uuid`,
      [taskId],
    )).rows[0].n, 0);
    assert.equal((await service.get(ownerId, dependentId) as { dependencyState: string }).dependencyState,
      'READY', 'the derived DONE releases the dependent');

    // A transport retry returns the original decision; it does not rewrite who/when/finding.
    const replay = await service.judge(ownerId, taskId, {
      ...judgment,
      evidence: 'different retry payload',
    });
    assert.equal(replay.judgment.requestId, storedRequest.id);
    assert.equal(replay.judgment.evidence, storedRequest.decisionNote);
    assert.equal((await db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: requestId } }))
      .decidedAt?.getTime(), storedRequest.decidedAt?.getTime(),
      'append-only: a replay never restamps the committed decision');
  });
