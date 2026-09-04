/**
 * The completion protocol against real PostgreSQL: what settles a task, and what merely asks to.
 *
 * This file used to replay all three criteria end to end: an exit code that derived DONE, a
 * judgment request that a person decided, and an independent verifier's verdict. The account
 * owner had the first two implementations deleted on 2026-09-02 — the machine, explicitly not the
 * declaration — and asked for the exit-code comparison back on 2026-09-03, without any of the
 * recording. What is replayed here is the state that leaves behind:
 *
 *   * VERIFICATION completes through this service. An independent verifier's PASS still settles
 *     its subject, a FAIL or INCONCLUSIVE still does not, and both go through the real service
 *     against the real triggers.
 *   * EVIDENCE_JUDGMENT is settled by a decision this file does not drive either: one CONFIRM
 *     from a session that did not do the work, recorded at the evidence door and replayed end to
 *     end in `evidence-judgment-confirm-derives-done.pg.spec.ts`. What is asserted here is the
 *     other half — that a direct DONE is still refused, with a remedy naming that act.
 *   * EXECUTABLE is settled by neither of the above and by nothing in THIS file: its one
 *     comparison happens in the runner callback, which is `task-executable-acceptance.pg.spec.ts`.
 *     What is asserted here is the other half — that the service still refuses to let anybody
 *     write its DONE by hand, and now says which action would earn it.
 *   * The ordinary writes around them — comments, dependencies, run events, merge receipts,
 *     sessions — are untouched.
 *
 * Every optimistic DONE transition is observed by a test-only trigger that refuses it unless one
 * of the derivations this file drives is already visible in the same transaction. That is what
 * stops a service method returning DONE from standing in for the database effect it claims.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must identify the disposable database accepted by
 * the coordinator PG safety guard, with migrations through 0230 applied.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
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
import { VERIFICATION_RUN_END_REASON } from './verification-dependency';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const FACT_TRIGGER = 'jr_task_done_requires_current_fact';
const FACT_FUNCTION = 'jr_task_done_requires_current_fact_fn';
const FACT_AUDIT = 'jr_task_done_derivation_audit';

function taskService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('this fixture never dispatches through SessionsService'); } } as never,
    {
      publishForUser: () => undefined,
      publishTaskChanged: () => undefined,
      publishSessionUpdated: () => undefined,
      publishQueuedTurnsChanged: () => undefined,
    } as never,
  );
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
 * Two derivations survive, and this refuses every other route to DONE.
 *
 * `VERIFIER_VERDICT` is the carrier's own conclusion; `VERIFICATION_PASS` is its subject's. There
 * is deliberately no arm for EXECUTABLE or EVIDENCE_JUDGMENT: a transition on either of those is
 * exactly the thing this change removed, and it must raise rather than be quietly recorded.
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
        IF NEW."verifies_task_id" IS NOT NULL AND NEW."verdict" IS NOT NULL THEN
          derivation := 'VERIFIER_VERDICT';
        ELSIF NEW."completion_criterion" = 'VERIFICATION'::task_completion_criterion THEN
          IF NOT EXISTS (
            SELECT 1
              FROM "task" verifier
             WHERE verifier."verifies_task_id" = NEW."id"
               AND verifier."status" = 'DONE'::task_status
               AND verifier."verdict" = 'PASS'::task_verdict
               AND verifier."terminal_reason" IS NULL
               AND verifier."superseded_by_task_id" IS NULL
          ) THEN
            RAISE EXCEPTION 'JR_DIRECT_DONE: VERIFICATION has no independent passing verdict fact';
          END IF;
          derivation := 'VERIFICATION_PASS';
        ELSE
          -- EXECUTABLE derives DONE from one exit-code comparison in runnerApi.turnComplete, and
          -- EVIDENCE_JUDGMENT from a CONFIRM recorded at the evidence door; this suite drives
          -- neither. Either way, a bare status UPDATE arriving here is not a derivation this
          -- suite can name.
          RAISE EXCEPTION 'JR_DIRECT_DONE: % did not reach DONE through a derivation',
            NEW."completion_criterion";
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
  expectedRequiredAction: string,
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
      assert.equal(body.requiredAction, expectedRequiredAction,
        `${actor} is told which fact could actually complete this task`);
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
  'VERIFICATION still completes work end to end; the other two criteria are declared and inert',
  { timeout: 300_000 },
  async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
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
        email: `jr-${ownerId}@status-derived.invalid`,
        name: 'judgment removal owner',
        passwordHash: 'x',
      },
    });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: 'disposable runner', tokenHash: 'x',
        status: RunnerStatus.ONLINE,
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: 'disposable workspace', enabled: true },
    });
    const project = await db.project.create({
      data: { id: randomUUID(), ownerId, title: 'judgment removal replay' },
    });
    await db.projectRuntime.upsert({
      where: { projectId: project.id }, create: { projectId: project.id }, update: {},
    });
    await installDerivedDoneGuard(sql);

    const tasks = taskService(db);

    // ---------------------------------------------------------------------------------------
    // The two declarations that no longer have an implementation.
    // ---------------------------------------------------------------------------------------
    const executable = await tasks.create(ownerId, {
      title: 'declares EXECUTABLE acceptance',
      projectId: project.id,
      assigneeId: workspaceId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCriteria: 'The declared shell command exits zero.',
      acceptanceCommand: 'printf jr-executable',
      acceptanceExpectedExitCode: 0,
    });
    assert.equal(executable.status, TaskStatus.OPEN);
    assert.equal(executable.completionCriterion, 'EXECUTABLE');
    assert.equal(executable.acceptanceCommand, 'printf jr-executable');
    assert.equal(executable.acceptanceExpectedExitCode, 0);

    const evidenceJudgment = await tasks.create(ownerId, {
      title: 'declares EVIDENCE_JUDGMENT',
      projectId: project.id,
      assigneeId: workspaceId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: 'Somebody decides the submitted evidence.',
    });
    assert.equal(evidenceJudgment.status, TaskStatus.OPEN);

    // The refusal is the same one it always was, and it names the action that CAN settle the
    // task: since 2026-09-03 EXECUTABLE has an implementation again, so the remedy is to let the
    // declared command run rather than to wait for a rebuild.
    await assertDirectDoneRefused(
      tasks, db, ownerId, executable.id, 'owner on EXECUTABLE',
      'RUN_ACCEPTANCE_COMMAND',
    );
    await assertDirectDoneRefused(
      tasks, db, ownerId, evidenceJudgment.id, 'owner on EVIDENCE_JUDGMENT',
      'SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION',
    );
    // And raw SQL cannot reach DONE through THIS suite either. Which wall answers changed with
    // 0230: the production fence now admits an EXECUTABLE row carrying an intact declaration,
    // because with nothing recorded the declaration is the only fact it can see — so what refuses
    // here is this suite's own derivation guard, and it is named exactly rather than left to an
    // alternation that would pass whichever way the walls moved.
    await assert.rejects(
      sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1`, [executable.id]),
      /JR_DIRECT_DONE/,
    );
    // The production fence is still the wall here: this task has submitted no evidence, so its
    // EVIDENCE_JUDGMENT lane has no CONFIRM to find and refuses the write on its own terms.
    await assert.rejects(
      sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1`, [evidenceJudgment.id]),
      /JR_DIRECT_DONE|TASK_DONE_CANONICAL_FACT_REQUIRED/,
    );

    // ---------------------------------------------------------------------------------------
    // VERIFICATION, the one criterion with an implementation.
    // ---------------------------------------------------------------------------------------
    const subject = await tasks.create(ownerId, {
      title: 'settled by an independent check',
      assigneeId: workspaceId,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      acceptanceCriteria: 'A different session checks the artifact and records PASS.',
    });
    const downstream = await tasks.create(ownerId, {
      title: 'waits on the verified subject',
      dependsOnTaskIds: [subject.id],
      autoRunWhenReady: false,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
    });
    assert.equal(await dependencyState(tasks, ownerId, downstream.id), 'BLOCKED');

    const verifier = await tasks.create(ownerId, {
      title: '[VERIFY] settled by an independent check',
      assigneeId: workspaceId,
      verifiesTaskId: subject.id,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'MANUAL',
    });
    assert.equal(verifier.verifiesTaskId, subject.id);
    assert.equal(await db.task.count({ where: { verifiesTaskId: subject.id } }), 1);

    const verifierSessionId = randomUUID();
    await db.session.create({
      data: {
        id: verifierSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: verifier.id,
        workspaceId,
        assignedRunnerId: runnerId,
        title: 'independent verifier',
        prompt: 'Independently inspect the artifact and record a verdict.',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
    // Even the verifier cannot write its subject DONE by hand; it records a verdict.
    await assertDirectDoneRefused(
      tasks, db, ownerId, subject.id, 'independent verifier',
      'OBTAIN_INDEPENDENT_VERIFICATION_PASS', verifierSessionId,
    );

    await tasks.update(ownerId, verifier.id, { verdict: 'PASS' }, verifierSessionId);
    const [verifiedSubject, decidedVerifier] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: subject.id } }),
      db.task.findUniqueOrThrow({ where: { id: verifier.id } }),
    ]);
    assert.equal(decidedVerifier.verdict, 'PASS');
    assert.equal(decidedVerifier.status, TaskStatus.DONE, 'the carrier concludes on its verdict');
    assert.equal(verifiedSubject.status, TaskStatus.DONE,
      'a PASS from an independent verifier still settles its subject');
    assert.equal(
      (await db.session.findUniqueOrThrow({ where: { id: verifierSessionId } })).status,
      RunStatus.AWAITING_INPUT,
      'the verifier session lifecycle is not what settled anything',
    );

    // §13.3 DEP is a second, independent question: a DONE subject with a check outstanding is not
    // yet a released prerequisite, because the check's own run has to have finished. That rule is
    // older than this change and survives it — which is why the dependent is still BLOCKED here
    // even though the subject is DONE.
    assert.equal(await dependencyState(tasks, ownerId, downstream.id), 'BLOCKED');
    await db.session.update({
      where: { id: verifierSessionId },
      data: {
        status: RunStatus.SUCCEEDED,
        endReason: VERIFICATION_RUN_END_REASON,
        completedAt: new Date(),
      },
    });
    assert.equal(await dependencyState(tasks, ownerId, downstream.id), 'READY',
      'with the check settled and the subject DONE, the epoch is open and the dependent releases');

    const statusAudit = await db.$queryRaw<Array<{ taskId: string; derivation: string }>>`
      SELECT "task_id" AS "taskId", "derivation" FROM "jr_task_done_derivation_audit"
       ORDER BY "derivation", "task_id"`;
    assert.deepEqual(
      new Set(statusAudit.map((row) => row.derivation)),
      new Set(['VERIFIER_VERDICT', 'VERIFICATION_PASS']),
    );
    assert.deepEqual(
      new Set(statusAudit.map((row) => row.taskId)),
      new Set([verifier.id, subject.id]),
    );

    // ---------------------------------------------------------------------------------------
    // The negative half: a conclusion that is not PASS settles nothing.
    // ---------------------------------------------------------------------------------------
    for (const [verdict, label] of [['FAIL', 'fail'], ['INCONCLUSIVE', 'inconclusive']] as const) {
      const held = await tasks.create(ownerId, {
        title: `subject whose check answers ${verdict}`,
        projectId: project.id,
        assigneeId: workspaceId,
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'VERIFICATION_PASSED',
      });
      const check = await tasks.create(ownerId, {
        title: `[VERIFY] ${label}`,
        projectId: project.id,
        assigneeId: workspaceId,
        verifiesTaskId: held.id,
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'MANUAL',
      });
      const checkSessionId = randomUUID();
      await db.session.create({
        data: {
          id: checkSessionId,
          ownerId,
          creatorId: ownerId,
          taskId: check.id,
          workspaceId,
          assignedRunnerId: runnerId,
          title: `independent verifier (${label})`,
          prompt: 'Independently inspect the artifact and record a verdict.',
          provider: 'codex',
          status: RunStatus.AWAITING_INPUT,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork: true,
        },
      });
      await tasks.update(ownerId, check.id, { verdict }, checkSessionId);
      assert.equal(
        (await db.task.findUniqueOrThrow({ where: { id: check.id } })).verdict,
        verdict,
      );
      assert.notEqual(
        (await db.task.findUniqueOrThrow({ where: { id: held.id } })).status,
        TaskStatus.DONE,
        `${verdict} must not settle the subject`,
      );
    }

    // ---------------------------------------------------------------------------------------
    // Ordinary writes around the removal, each one positively.
    // ---------------------------------------------------------------------------------------
    const plain = await tasks.create(ownerId, {
      title: 'an ordinary task',
      projectId: project.id,
      assigneeId: workspaceId,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
    });
    const renamed = await tasks.update(ownerId, plain.id, { title: 'an ordinary task, renamed' });
    assert.equal(renamed.title, 'an ordinary task, renamed');
    // The edge goes on a THIRD task rather than on `plain`: `plain` gets a run below, and 0130's
    // dispatch fence refuses a session on a task whose prerequisite tail is unresolved. That fence
    // firing here would be the removal breaking an ordinary path, so the fixture respects it.
    const dependent = await tasks.create(ownerId, {
      title: 'waits on the ordinary task',
      projectId: project.id,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      autoRunWhenReady: false,
    });
    await tasks.addDependency(ownerId, dependent.id, plain.id);
    assert.equal(
      await db.taskDependency.count({ where: { taskId: dependent.id, dependsOnTaskId: plain.id } }),
      1,
    );
    assert.equal(await dependencyState(tasks, ownerId, dependent.id), 'BLOCKED');
    const comment = await db.taskComment.create({
      data: {
        taskId: plain.id,
        authorType: CreatorType.AGENT,
        authorId: workspaceId,
        body: 'an ordinary comment, still an ordinary write',
      },
    });
    assert.ok(comment.id);

    const workSessionId = randomUUID();
    await db.session.create({
      data: {
        id: workSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: plain.id,
        workspaceId,
        assignedRunnerId: runnerId,
        title: 'ordinary run',
        prompt: 'do the ordinary work',
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
    const event = await db.runEvent.create({
      data: { id: randomUUID(), sessionId: workSessionId, seq: 1, type: 'STATUS', payload: {} },
    });
    assert.ok(event.id);
    const receipt = await db.sessionMergeReceipt.create({
      data: {
        id: randomUUID(),
        ownerId,
        sessionId: workSessionId,
        taskId: plain.id,
        projectId: project.id,
        result: 'MERGED',
        sourceBranch: 'orbit/ordinary',
        sourceSha: 'a'.repeat(40),
        targetBranch: 'main',
        targetShaBefore: 'b'.repeat(40),
        targetShaAfter: 'c'.repeat(40),
        recordedBy: 'RUNNER',
        idempotencyKey: `jr-merge:${workSessionId}`,
      },
    });
    assert.equal(receipt.result, 'MERGED');

    // A supersede link is an ordinary lifecycle write too. On its own task, because `plain` now
    // carries a live run and retiring a task under one is a different rule.
    // MANUAL, because a `VERIFICATION_PASSED` row is only ever finished — or reopened — by the
    // aggregation recompute (§13.1 AG6), which would put a hand-written FAILED straight back.
    const attempt = await tasks.create(ownerId, {
      title: 'an attempt that stopped',
      projectId: project.id,
      assigneeId: workspaceId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    });
    await tasks.update(ownerId, attempt.id, { status: TaskStatus.FAILED } as never);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      TaskStatus.FAILED,
      'FAILED is still a run\'s conservative self-report, on any criterion',
    );
    const successor = await tasks.create(ownerId, {
      title: 'the replacement attempt',
      projectId: project.id,
      assigneeId: workspaceId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      supersedesTaskId: attempt.id,
    });
    const superseded = await db.task.findUniqueOrThrow({ where: { id: attempt.id } });
    assert.equal(superseded.supersededByTaskId, successor.id);
    assert.equal(superseded.terminalReason, 'SUPERSEDED');
  },
);
