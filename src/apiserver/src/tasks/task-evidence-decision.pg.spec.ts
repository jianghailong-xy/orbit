/**
 * The decision door, against real PostgreSQL: three refusals and one recorded decision.
 *
 * A decision is the whole of what EVIDENCE_JUDGMENT would mean, so the only thing that makes one
 * worth storing is that the three questions a reader would otherwise have to ask by hand were
 * answered at the moment it was made. Each is tested by making it FALSE and watching the write not
 * happen:
 *
 *  - answering revision N while the task is at N+1 is refused. The evidence a decision names is
 *    immutable, so an answer to a version that has been superseded is an answer to a question
 *    nobody is asking — and accepting it is exactly how a run would submit a weak version, collect
 *    a decision, and then quietly submit the one it wanted judged;
 *  - answering a criterion whose text has since been rewritten is refused. The quote binds to the
 *    criterion's CONTENT, not to its key, so a rewritten standard is a different standard;
 *  - answering from the session that submitted the evidence is refused. This is the self-DONE
 *    boundary, and it is the entire reason the third criterion is a check rather than a signature
 *    on one's own homework;
 *  - and an independent session answering the current revision writes one row, bound by foreign
 *    key to that exact evidence content, while the task itself is left exactly as it was.
 *
 * Every refusal is asserted by BOTH its stable code and its requiredAction: a refusal a caller
 * cannot act on sends a decider away holding an opinion with nowhere to put it.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
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

const CRITERION_TEXT = 'task_evidence_decide records one independent session decision per evidence revision';
const REWRITTEN_CRITERION_TEXT =
  'task_evidence_decide records one independent session decision per evidence revision, and refuses a stale one';

async function empty(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "task", "session", "project", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * One owner, one stated criterion, and two runs: the one that does the work and the one that
 * judges it.
 *
 * The judging run is a session of ANOTHER task, which is what an independent decision looks like
 * in life — somebody else's run, reading this task's ledger. It is created here rather than in the
 * test so that the one thing separating it from the submitting session is the only thing the
 * independence check reads: which task it belongs to.
 */
async function fixture(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const criterionId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const reviewTaskId = randomUUID();
  const reviewSessionId = randomUUID();

  await db.user.create({
    data: { id: ownerId, email: `decision-${ownerId}@invalid.test`, name: 'Decision', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'decision-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'decision-workspace', enabled: true },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: 'the evidence decision door' },
  });
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId,
      projectId,
      ordinal: 1,
      text: CRITERION_TEXT,
      verificationMethod: 'the pg spec asserts three refusal codes and one written row',
      // Written by the definition's own BEFORE trigger; the placeholder only has to satisfy the
      // column's 64-hex CHECK on the way in.
      contentHash: '0'.repeat(64),
    },
  });

  for (const [id, title] of [
    [taskId, 'the work being judged'],
    [reviewTaskId, 'the run doing the judging'],
  ] as const) {
    await db.task.create({
      data: {
        id,
        ownerId,
        projectId,
        title,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        assigneeId: workspaceId,
        status: TaskStatus.OPEN,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCriteria: 'an independent session decides the current evidence revision',
      },
    });
  }
  for (const [id, taskFor, title] of [
    [sessionId, taskId, 'the run that did the work'],
    [reviewSessionId, reviewTaskId, 'the independent run'],
  ] as const) {
    await db.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId: taskFor,
        workspaceId,
        assignedRunnerId: runnerId,
        title,
        prompt: 'run the task',
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
  }
  await db.toolCall.createMany({
    data: [
      {
        sessionId,
        name: 'Bash',
        toolUseId: 'toolu_first',
        input: { command: 'npm run test:outcome-reconciler:fast-gate', description: 'first pass' },
        isError: false,
      },
      {
        sessionId,
        name: 'Bash',
        toolUseId: 'toolu_second',
        input: { command: 'npm run test:outcome-reconciler:full-api', description: 'second pass' },
        isError: false,
      },
      {
        sessionId,
        name: 'Bash',
        toolUseId: 'toolu_third',
        input: { command: 'git log --oneline -1', description: 'third pass' },
        isError: false,
      },
    ],
  });

  return { ownerId, workspaceId, projectId, criterionId, taskId, sessionId, reviewTaskId, reviewSessionId };
}

/**
 * The decision receipt, as a reader of it sees it.
 *
 * Structural and with every field optional, on purpose: this spec has to be able to run — and
 * FAIL — against a build with no decision door at all. Reading the response through its DTO type
 * would turn a missing implementation into a compile error, which stops the whole suite and proves
 * nothing about this file.
 */
interface DecisionView {
  id?: string;
  taskId?: string;
  evidenceId?: string;
  evidenceRevision?: string;
  criterionRevision?: string;
  evidenceDigest?: string;
  decision?: string;
  note?: string | null;
  decidedByType?: string;
  decidedById?: string;
  decidingSessionId?: string;
}

/** A refusal is only useful if the decider can act on it, so both halves are asserted. */
async function refusal(
  promise: Promise<unknown>,
  kind: typeof ConflictException | typeof ForbiddenException,
  code: string,
  requiredAction: string,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof kind, `expected a ${kind.name}, got ${error}`);
    const body = (error as ConflictException).getResponse() as { code?: string; requiredAction?: string };
    assert.equal(body.code, code);
    assert.equal(body.requiredAction, requiredAction);
    return true;
  });
}

suite('one independent session decides one version of the evidence, or is refused', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);
  const f = await fixture(db);
  const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);
  // The key a reader is given for a stated criterion is the definition row's public id, which is
  // what the envelope quotes and what the decision door resolves back to a live row.
  const key = uuidToBase62(f.criterionId);

  const submit = (ref: string, claim: string) => service.submit(
    f.ownerId,
    f.taskId,
    { type: CreatorType.AGENT, id: f.workspaceId },
    {
      sourceSessionId: f.sessionId,
      evidence: {
        claim,
        criterion: { key, text: CRITERION_TEXT },
        checks: [{ kind: 'TOOL_CALL', ref }],
        gaps: [],
      },
    },
  );
  const decide = (
    evidenceRevision: string,
    decidingSessionId: string,
    decision: 'CONFIRM' | 'SEND_BACK' = 'CONFIRM',
    note?: string,
  ): Promise<DecisionView> => service.decide(
    f.ownerId,
    f.taskId,
    { type: CreatorType.AGENT, id: f.workspaceId },
    { decidingSessionId, evidenceRevision, decision, note },
  );
  const decisionCount = async (): Promise<number> => Number((await sql.query<{ n: string }>(
    'SELECT count(*) AS n FROM "task_evidence_decision" WHERE "task_id" = $1', [f.taskId],
  )).rows[0].n);

  await submit('toolu_first', 'the fast gate passed');
  await submit('toolu_second', 'the full suite passed too');

  // (i) ------------------------------------------------------------------------------------------
  await t.test('an answer to a superseded revision is refused, and writes nothing', async () => {
    await refusal(
      decide('1', f.reviewSessionId),
      ConflictException,
      'EVIDENCE_JUDGMENT_EVIDENCE_SUPERSEDED',
      'DECIDE_THE_CURRENT_EVIDENCE_REVISION',
    );
    assert.equal(await decisionCount(), 0);
  });

  // (ii) -----------------------------------------------------------------------------------------
  // The key does not move when the wording does — that is the point. Nothing about this rewrite is
  // visible to a check that matched on the identifier; only comparing the TEXT catches it.
  await t.test('an answer to a criterion whose text was rewritten is refused', async () => {
    await db.projectAcceptanceCriterionDefinition.update({
      where: { id: f.criterionId },
      data: { text: REWRITTEN_CRITERION_TEXT },
    });

    await refusal(
      decide('2', f.reviewSessionId),
      ConflictException,
      'EVIDENCE_JUDGMENT_CRITERION_MOVED',
      'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
    );
    assert.equal(await decisionCount(), 0);

    await db.projectAcceptanceCriterionDefinition.update({
      where: { id: f.criterionId },
      data: { text: CRITERION_TEXT },
    });
  });

  // (iii) ----------------------------------------------------------------------------------------
  await t.test('the session that submitted the evidence cannot decide it', async () => {
    await refusal(
      decide('2', f.sessionId),
      ForbiddenException,
      'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION',
      'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
    );
    assert.equal(await decisionCount(), 0);
  });

  // (iv) -----------------------------------------------------------------------------------------
  await t.test('an independent session confirming the current revision writes one bound row',
    async () => {
      const evidence = (await sql.query<{ id: string; criterion_revision: string; evidence_digest: string }>(
        'SELECT "id", "criterion_revision", "evidence_digest" FROM "task_completion_evidence" '
        + 'WHERE "task_id" = $1 AND "revision" = 2', [f.taskId],
      )).rows[0];

      const written = await decide('2', f.reviewSessionId);

      assert.equal(written.decision, 'CONFIRM');
      assert.equal(written.evidenceRevision, '2');
      assert.equal(written.taskId, f.taskId);
      assert.equal(written.evidenceId, evidence.id);
      assert.equal(written.decidingSessionId, f.reviewSessionId);
      assert.equal(written.decidedById, f.workspaceId);
      assert.equal(written.decidedByType, CreatorType.AGENT);
      assert.equal(written.note, null);
      // The three columns the binding is made of, and the reason no column had to be added: they
      // are the evidence row's own, carried onto the decision and joined back by foreign key.
      assert.equal(written.criterionRevision, evidence.criterion_revision);
      assert.equal(written.evidenceDigest, evidence.evidence_digest);
      assert.equal(await decisionCount(), 1);

      // The binding is structural, not a copied string: the decided evidence cannot be deleted out
      // from under it. Rolled back, so the row this suite goes on to read is left where it is.
      await sql.query('BEGIN');
      await assert.rejects(
        sql.query('DELETE FROM "task_completion_evidence" WHERE "id" = $1', [evidence.id]),
        (error: unknown) => {
          assert.match(String((error as Error).message), /task_evidence_decision/);
          return true;
        },
      );
      await sql.query('ROLLBACK');

      // A decision is a fact about the evidence, and nothing else. The task it is about is not
      // written to at all — deriving a status from this row is a separate step that does not exist.
      const task = (await sql.query<{ status: string; updated_at: Date }>(
        'SELECT "status", "updated_at" FROM "task" WHERE "id" = $1', [f.taskId],
      )).rows[0];
      assert.equal(task.status, 'OPEN');
    });

  // (v) ------------------------------------------------------------------------------------------
  await t.test('SEND_BACK carries its note, leaves the task OPEN, and waits for the next revision',
    async () => {
      await submit('toolu_third', 'a third attempt at the same criterion');

      const sent = await decide('3', f.reviewSessionId, 'SEND_BACK', 'cite the full-api manifest, not the log');

      assert.equal(sent.decision, 'SEND_BACK');
      assert.equal(sent.evidenceRevision, '3');
      assert.equal(sent.note, 'cite the full-api manifest, not the log');
      assert.equal(await decisionCount(), 2);
      const task = (await sql.query<{ status: string }>(
        'SELECT "status" FROM "task" WHERE "id" = $1', [f.taskId],
      )).rows[0];
      assert.equal(task.status, 'OPEN');
    });
});
