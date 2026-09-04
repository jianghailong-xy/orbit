/**
 * The third criterion, end to end against real PostgreSQL: one CONFIRM from a session that did not
 * do the work is what turns an EVIDENCE_JUDGMENT task DONE.
 *
 * One task, one evidence revision, and three answers to the same question — asked in this order
 * because each one is what makes the next mean anything:
 *
 *  (i)  the session that DID the work confirms its own evidence. Refused, nothing written, and the
 *       task is still OPEN. This is the negative the whole criterion exists for: without it a run
 *       could sign its own homework, and the refusal is only worth asserting in a world where the
 *       accepted call WOULD have settled the task — which is (iii), one call later, differing in
 *       nothing but which session is deciding;
 *  (ii) nobody writes the status by hand either. The same UPDATE is refused by 0193's canonical
 *       writer fence while no CONFIRM exists, so DONE here is not a status somebody may reach for
 *       once the criterion has an implementation;
 *  (iii) the coordinator's session — which never ran this task — confirms that exact revision, and
 *       the task's status becomes DONE. Read back from the row rather than from the receipt: what
 *       is being claimed is a database effect, and a service return value is not one.
 *
 * DONE stays DERIVED. Nothing here writes a status as a principal: the decision row is the fact,
 * the evaluator projects it, and the fence in the database refuses every DONE that cannot name it.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied.
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
import { uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const CRITERION_TEXT =
  'a CONFIRM from an independent session derives DONE for an EVIDENCE_JUDGMENT task';

/**
 * The two runs the criterion is about: the one that produced the work, and one that did not.
 *
 * The deciding session is the coordinator's — it executes no task at all, which is the shape the
 * independence check reads. Everything else about the two is identical, so the only thing that can
 * explain the different answers below is which of them is deciding.
 */
async function fixture(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const criterionId = randomUUID();
  const taskId = randomUUID();
  const workerSessionId = randomUUID();
  const coordinatorSessionId = randomUUID();

  await db.user.create({
    data: { id: ownerId, email: `confirm-${ownerId}@invalid.test`, name: 'Confirm', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'confirm-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'confirm-workspace', enabled: true },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: 'the third completion criterion' },
  });
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId,
      projectId,
      ordinal: 1,
      text: CRITERION_TEXT,
      verificationMethod: 'this pg spec drives the door and reads the task row back',
      // Written by the definition's own BEFORE trigger; the placeholder only has to satisfy the
      // column's 64-hex CHECK on the way in.
      contentHash: '0'.repeat(64),
    },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: 'the work an independent session judges',
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: TaskStatus.OPEN,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: 'an independent session confirms the current evidence revision',
    },
  });
  await db.session.create({
    data: {
      id: workerSessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: 'the run that did the work',
      prompt: 'do the work and submit the evidence',
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      // No task: this run executes nothing, it reads what other runs produced.
      taskId: null,
      workspaceId,
      assignedRunnerId: runnerId,
      title: 'the project coordinator',
      prompt: 'read the ledger and decide',
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: false,
    },
  });
  await db.toolCall.create({
    data: {
      sessionId: workerSessionId,
      name: 'Bash',
      toolUseId: 'toolu_confirm',
      input: { command: 'npm run test:outcome-reconciler:fast-gate', description: 'the work' },
      isError: false,
    },
  });

  return { ownerId, workspaceId, projectId, criterionId, taskId, workerSessionId, coordinatorSessionId };
}

/**
 * The decision receipt, as a reader of it sees it.
 *
 * Structural and with every field optional, so this spec can run — and FAIL — against a build in
 * which CONFIRM derives nothing. Reading it through its DTO type would turn a missing field into a
 * compile error, which stops the suite and proves nothing about this file.
 */
interface DecisionView {
  id?: string;
  evidenceId?: string;
  evidenceRevision?: string;
  decision?: string;
  decidingSessionId?: string;
}

suite('one CONFIRM from an independent session derives DONE, and self-judgment derives nothing',
  async (t) => {
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
      TRUNCATE "task", "session", "project", "workspace", "runner", "user"
      RESTART IDENTITY CASCADE
    `);
    const f = await fixture(db);
    const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);
    const actor = { type: CreatorType.AGENT, id: f.workspaceId } as const;
    const key = uuidToBase62(f.criterionId);

    const decide = (decidingSessionId: string): Promise<DecisionView> => service.decide(
      f.ownerId, f.taskId, actor,
      { decidingSessionId, evidenceRevision: '1', decision: 'CONFIRM' },
    );
    const status = async (): Promise<string> => (await sql.query<{ status: string }>(
      'SELECT "status" FROM "task" WHERE "id" = $1', [f.taskId],
    )).rows[0].status;
    const decisionCount = async (): Promise<number> => Number((await sql.query<{ n: string }>(
      'SELECT count(*) AS n FROM "task_evidence_decision" WHERE "task_id" = $1', [f.taskId],
    )).rows[0].n);

    // The work: one run does it and submits one revision of the evidence, citing what it ran.
    const submitted = await service.submit(f.ownerId, f.taskId, actor, {
      sourceSessionId: f.workerSessionId,
      evidence: {
        claim: 'the declared work is done and the gate it names passes',
        criterion: { key, text: CRITERION_TEXT },
        checks: [{ kind: 'TOOL_CALL', ref: 'toolu_confirm' }],
        gaps: [],
      },
    });
    assert.equal(submitted.revision, '1');
    assert.equal(await status(), 'OPEN', 'submitting evidence is a claim, not a completion');

    // (i) ---------------------------------------------------------------------------------------
    await t.test('the session that did the work cannot confirm its own evidence', async () => {
      await assert.rejects(decide(f.workerSessionId), (error: unknown) => {
        assert.ok(error instanceof ForbiddenException, `expected a 403, got ${error}`);
        const body = (error as ForbiddenException).getResponse() as
          { code?: string; requiredAction?: string };
        assert.equal(body.code, 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION');
        assert.equal(body.requiredAction, 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK');
        return true;
      });
      assert.equal(await decisionCount(), 0, 'a refused decision writes no row');
      assert.equal(await status(), 'OPEN', 'and settles nothing: the task is where it was');
    });

    // (ii) --------------------------------------------------------------------------------------
    // The other half of "derived": with no CONFIRM to name, the production fence refuses the
    // status outright. This is what stops the lane added for this criterion from being read as
    // "EVIDENCE_JUDGMENT may now be written DONE".
    await t.test('and nobody writes the status by hand while no decision exists', async () => {
      await assert.rejects(
        sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1`, [f.taskId]),
        /TASK_DONE_CANONICAL_FACT_REQUIRED/,
      );
      assert.equal(await status(), 'OPEN');
    });

    // (iii) -------------------------------------------------------------------------------------
    await t.test('the coordinator session confirms that revision, and the task becomes DONE',
      async () => {
        const evidence = (await sql.query<{ id: string }>(
          'SELECT "id" FROM "task_completion_evidence" WHERE "task_id" = $1 AND "revision" = 1',
          [f.taskId],
        )).rows[0];

        const confirmed = await decide(f.coordinatorSessionId);

        assert.equal(confirmed.decision, 'CONFIRM');
        assert.equal(confirmed.evidenceRevision, '1');
        assert.equal(confirmed.evidenceId, evidence.id);
        assert.equal(confirmed.decidingSessionId, f.coordinatorSessionId);
        assert.equal(await decisionCount(), 1, 'one decision, on the revision that was answered');
        // The claim of this file, read from the row and not from the receipt above.
        assert.equal(await status(), 'DONE');
      });
  });
