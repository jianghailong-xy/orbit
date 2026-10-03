/**
 * A task filed under a project WITHOUT declaring one of its criteria, decided on its own
 * acceptance criteria — and a task that does declare one, still held to the project's wording.
 *
 * WHAT WENT WRONG
 * ---------------
 * The evidence lane chose the live standard by the task's FILING: any task with a `projectId` had
 * its quote resolved against the project's criterion table, whether or not it had declared a
 * criterion there (`criterionKey`, stored as `criterion_definition_id`). For a project task that
 * declared none, quoting its own `acceptanceCriteria` was therefore refused at every revision —
 * 409 EVIDENCE_JUDGMENT_CRITERION_MOVED for CONFIRM and SEND_BACK alike, nothing written (seen
 * live on 2026-10-03, task 34ZVCzgmJef9DtNr0PkDj) — while the one quote that did get through was
 * some OTHER criterion of the project's, borrowed verbatim as a wrapper. The lane is now chosen by
 * the declaration: a project task that declares no criterion is held to its own criteria, exactly
 * like a task in no project.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * Both shapes a task in a project can have, through the doors a run and a coordinator use:
 *
 *  - declaring none: evidence quoting the task's own criteria is reported live at submission,
 *    offered to the project's coordinator conversation as decidable, and that conversation records
 *    CONFIRM (which derives DONE) or SEND_BACK (which writes its note and leaves the task OPEN);
 *    the run that did the work is still refused as not independent; criteria rewritten after
 *    submission refuse the old revision as moved; and borrowing the project's criterion is refused;
 *  - declaring one (through `criterionKey` on the create door): the project criterion's CONTENT is
 *    still the standard — a rewording refuses the old evidence as moved even though the task's own
 *    criteria still say what the quote says, and deleting the criterion refuses it too.
 *
 * Nothing is stubbed: the services are the ones the API wires, over a real client, and every claim
 * about a write is read back out of the rows. Refusals are asserted by code AND requiredAction.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied:
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/evidence-judgment-undeclared-project-task.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  CreatorType,
  type PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { Client } from 'pg';
import { uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const PROJECT_CRITERION =
  'every task the project files is decided against the standard it states for itself';
const OWN_CRITERIA =
  'the decision door records an independent decision on evidence quoting these criteria';
const REWRITTEN_OWN_CRITERIA = `${OWN_CRITERIA}, and refuses evidence quoting their old wording`;

/** The receipt and the decision, as a reader of them sees them: every field optional. */
interface SubmissionView {
  revision?: string;
  criterionMatch?: { key?: string; text?: string; matchesLive?: boolean } | null;
}
interface DecisionView {
  evidenceId?: string;
  evidenceRevision?: string;
  criterionRevision?: string;
  evidenceDigest?: string;
  decision?: string;
  note?: string | null;
  decidingSessionId?: string;
}

async function refusal(
  promise: Promise<unknown>,
  kind: typeof ConflictException | typeof ForbiddenException,
  code: string,
  requiredAction: string,
): Promise<{ message?: string }> {
  let body: { code?: string; requiredAction?: string; message?: string } = {};
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof kind, `expected a ${kind.name}, got ${error}`);
    body = (error as ConflictException).getResponse() as typeof body;
    assert.equal(body.code, code);
    assert.equal(body.requiredAction, requiredAction);
    return true;
  });
  return body;
}

suite('a project task is decided against the standard it declares, or its own', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(
    'TRUNCATE "task", "session", "project", "workspace", "runner", "user" RESTART IDENTITY CASCADE',
  );

  const tasks = new TasksService(db as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  const evidence = new TaskCompletionEvidenceService(db as unknown as PrismaService);

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const criterionId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const criterionKey = uuidToBase62(criterionId);
  await db.user.create({
    data: { id: ownerId, email: `undeclared-${ownerId}@invalid.test`, name: 'Undeclared', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'undeclared-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'undeclared-workspace', enabled: true },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: 'the project these tasks are filed under' } });
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId,
      projectId,
      ordinal: 1,
      text: PROJECT_CRITERION,
      verificationMethod: 'this pg spec submits, decides and reads the rows back',
      // Written by the definition's own BEFORE trigger; the placeholder only has to satisfy the
      // column's 64-hex CHECK on the way in.
      contentHash: '0'.repeat(64),
    },
  });
  // The project's coordinator conversation: a session of no task, which is what makes it
  // independent of every task it decides.
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: 'the project coordinator',
      prompt: 'coordinate the project',
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.project.update({ where: { id: projectId }, data: { coordinatorSessionId } });

  interface Filed { id: string; key: string; runSessionId: string; cited: string }

  /** One EVIDENCE_JUDGMENT task under the project, filed through the create door — declaring the
   *  criterion `declares` names, or none — with the run that does its work and one tool call that
   *  run recorded. */
  async function file(label: string, acceptanceCriteria: string, declares?: string): Promise<Filed> {
    const created = await tasks.create(ownerId, {
      title: `${label}: work filed under the project`,
      projectId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria,
      ...(declares === undefined ? {} : { criterionKey: declares }),
    } as never) as { id: string };
    const runSessionId = randomUUID();
    await db.session.create({
      data: {
        id: runSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: created.id,
        workspaceId,
        assignedRunnerId: runnerId,
        title: `${label}: the run that did the work`,
        prompt: 'run the task',
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
    const cited = `toolu_${label}`;
    await db.toolCall.create({
      data: {
        sessionId: runSessionId,
        name: 'Bash',
        toolUseId: cited,
        input: { command: 'npm --prefix src/apiserver test', description: label },
        isError: false,
      },
    });
    return { id: created.id, key: uuidToBase62(created.id), runSessionId, cited };
  }

  const submit = async (
    task: Filed,
    criterion: { key: string; text: string },
  ): Promise<SubmissionView> => await evidence.submit(
    ownerId,
    task.id,
    { type: CreatorType.AGENT, id: workspaceId },
    {
      sourceSessionId: task.runSessionId,
      evidence: {
        claim: 'the suite passed',
        criterion,
        checks: [{ kind: 'TOOL_CALL', ref: task.cited }],
        gaps: [],
      },
    },
  ) as SubmissionView;

  const decide = async (
    task: Filed,
    evidenceRevision: string,
    decidingSessionId: string,
    decision: 'CONFIRM' | 'SEND_BACK',
    note?: string,
  ): Promise<DecisionView> => await evidence.decide(
    ownerId,
    task.id,
    { type: CreatorType.AGENT, id: workspaceId },
    { decidingSessionId, evidenceRevision, decision, note },
  ) as DecisionView;

  const decisionCount = async (task: Filed): Promise<number> => Number((await sql.query<{ n: string }>(
    'SELECT count(*) AS n FROM "task_evidence_decision" WHERE "task_id" = $1', [task.id],
  )).rows[0].n);
  const taskRow = async (task: Filed) => (await sql.query<{
    status: string;
    updated_at: Date;
    project_id: string | null;
    criterion_definition_id: string | null;
  }>(
    'SELECT "status", "updated_at", "project_id", "criterion_definition_id" FROM "task" WHERE "id" = $1',
    [task.id],
  )).rows[0];
  const evidenceRow = async (task: Filed, revision: string) => (await sql.query<{
    id: string; criterion_revision: string; evidence_digest: string;
  }>(
    'SELECT "id", "criterion_revision", "evidence_digest" FROM "task_completion_evidence" '
    + 'WHERE "task_id" = $1 AND "revision" = $2', [task.id, revision],
  )).rows[0];

  // ═══ 1. declaring none: CONFIRM against its own criteria ═══════════════════════════════════
  await t.test('a project task that declares no criterion is CONFIRMed by the coordinator against its own criteria',
    async () => {
      const task = await file('confirm', OWN_CRITERIA);
      // The shape under test, read off the row: filed under the project, declaring nothing there.
      const filed = await taskRow(task);
      assert.equal(filed.project_id, projectId);
      assert.equal(filed.criterion_definition_id, null);

      const submitted = await submit(task, { key: task.key, text: OWN_CRITERIA });
      assert.equal(submitted.criterionMatch?.matchesLive, true,
        'the receipt told the run its own criteria are not the standard it is held to');

      // The queue the coordinator reads offers it, as decidable, before anybody presses anything.
      const queue = await evidence.pending(ownerId, coordinatorSessionId);
      const offered = queue.pending.find((row) => row.taskId === task.id);
      assert.ok(offered, 'the coordinator was not offered the revision to decide');
      assert.equal(offered.decidability.decidable, true);
      assert.equal(offered.independence.independent, true);

      // The run that did the work still may not settle it: the independence rule is not what moved.
      await refusal(
        decide(task, '1', task.runSessionId, 'CONFIRM'),
        ForbiddenException,
        'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION',
        'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
      );
      assert.equal(await decisionCount(task), 0);

      const stored = await evidenceRow(task, '1');
      const written = await decide(task, '1', coordinatorSessionId, 'CONFIRM');
      assert.equal(written.decision, 'CONFIRM');
      assert.equal(written.evidenceRevision, '1');
      assert.equal(written.evidenceId, stored.id);
      assert.equal(written.criterionRevision, stored.criterion_revision);
      assert.equal(written.evidenceDigest, stored.evidence_digest);
      assert.equal(written.decidingSessionId, coordinatorSessionId);
      assert.equal(await decisionCount(task), 1);
      assert.equal((await taskRow(task)).status, 'DONE',
        'a CONFIRM of an EVIDENCE_JUDGMENT task\'s current revision derives DONE');
    });

  // ═══ 2. declaring none: SEND_BACK writes its note and nothing else ═════════════════════════
  await t.test('the coordinator can SEND_BACK such a task, which stays OPEN with the note written',
    async () => {
      const task = await file('send-back', OWN_CRITERIA);
      await submit(task, { key: task.key, text: OWN_CRITERIA });
      const before = await taskRow(task);

      const sent = await decide(task, '1', coordinatorSessionId, 'SEND_BACK',
        'cite the run of the full apiserver suite, not one file');

      assert.equal(sent.decision, 'SEND_BACK');
      assert.equal(sent.note, 'cite the run of the full apiserver suite, not one file');
      assert.equal(await decisionCount(task), 1);
      const after = await taskRow(task);
      assert.deepEqual(after, before, 'SEND_BACK wrote to the task');
      assert.equal(after.status, 'OPEN');
    });

  // ═══ 3. declaring none: its own criteria are what the old evidence is held to ══════════════
  await t.test('own criteria rewritten after submission refuse the old revision as moved', async () => {
    const task = await file('rewritten', OWN_CRITERIA);
    await submit(task, { key: task.key, text: OWN_CRITERIA });
    await tasks.update(ownerId, task.id, { acceptanceCriteria: REWRITTEN_OWN_CRITERIA } as never);

    for (const decision of ['CONFIRM', 'SEND_BACK'] as const) {
      const body = await refusal(
        decide(task, '1', coordinatorSessionId, decision, 'the next revision must quote the new wording'),
        ConflictException,
        'EVIDENCE_JUDGMENT_CRITERION_MOVED',
        'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
      );
      assert.match(String(body.message), /not what this task states today/);
    }
    assert.equal(await decisionCount(task), 0);
    assert.equal((await taskRow(task)).status, 'OPEN');

    // The way out is the ordinary one: a revision quoting what the task states now.
    const resubmitted = await submit(task, { key: task.key, text: REWRITTEN_OWN_CRITERIA });
    assert.equal(resubmitted.revision, '2');
    assert.equal(resubmitted.criterionMatch?.matchesLive, true);
    assert.equal((await decide(task, '2', coordinatorSessionId, 'CONFIRM')).decision, 'CONFIRM');
    assert.equal((await taskRow(task)).status, 'DONE');
  });

  // ═══ 4. declaring none: the project's criterion is not a wrapper it can borrow ═════════════
  await t.test('quoting the project criterion it never declared is refused, and writes nothing',
    async () => {
      const task = await file('borrowed', OWN_CRITERIA);
      const submitted = await submit(task, { key: criterionKey, text: PROJECT_CRITERION });
      assert.equal(submitted.criterionMatch?.matchesLive, false,
        'a live criterion of the project passed as the standard of a task that declared none');

      await refusal(
        decide(task, '1', coordinatorSessionId, 'CONFIRM'),
        ConflictException,
        'EVIDENCE_JUDGMENT_CRITERION_MOVED',
        'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
      );
      assert.equal(await decisionCount(task), 0);
      assert.equal((await taskRow(task)).status, 'OPEN');
    });

  // ═══ 5. declaring one: the project criterion's content, unchanged ══════════════════════════
  await t.test('a task that declares the criterion is still held to its wording, which a rewrite moves',
    async () => {
      // The decoy: this task's OWN criteria are word for word the project criterion as quoted, so
      // the rewrite below would be rescued if the declared task fell back to its own column.
      const task = await file('declared', PROJECT_CRITERION, criterionKey);
      assert.equal((await taskRow(task)).criterion_definition_id, criterionId,
        'the create door did not write the declaration this case is about');

      const submitted = await submit(task, { key: criterionKey, text: PROJECT_CRITERION });
      assert.equal(submitted.criterionMatch?.matchesLive, true);

      await db.projectAcceptanceCriterionDefinition.update({
        where: { id: criterionId },
        data: { text: `${PROJECT_CRITERION}, reworded after the evidence was submitted` },
      });
      const body = await refusal(
        decide(task, '1', coordinatorSessionId, 'CONFIRM'),
        ConflictException,
        'EVIDENCE_JUDGMENT_CRITERION_MOVED',
        'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
      );
      assert.match(String(body.message), /is not what the project states today/);
      assert.equal(await decisionCount(task), 0);

      // Worded back, the same revision is decidable again: the binding is to the content.
      await db.projectAcceptanceCriterionDefinition.update({
        where: { id: criterionId },
        data: { text: PROJECT_CRITERION },
      });
      assert.equal((await decide(task, '1', coordinatorSessionId, 'CONFIRM')).decision, 'CONFIRM');
      assert.equal((await taskRow(task)).status, 'DONE');
    });

  await t.test('a task that declares the criterion refuses evidence quoting its own criteria instead',
    async () => {
      const task = await file('declared-own', OWN_CRITERIA, criterionKey);
      const submitted = await submit(task, { key: task.key, text: OWN_CRITERIA });
      assert.equal(submitted.criterionMatch?.matchesLive, false,
        'a task that declared a project criterion was let off with its own criteria');
      await refusal(
        decide(task, '1', coordinatorSessionId, 'SEND_BACK', 'quote the criterion this task serves'),
        ConflictException,
        'EVIDENCE_JUDGMENT_CRITERION_MOVED',
        'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
      );
      assert.equal(await decisionCount(task), 0);
    });

  await t.test('deleting the declared criterion refuses the evidence that quoted it', async () => {
    const goneId = randomUUID();
    await db.projectAcceptanceCriterionDefinition.create({
      data: {
        id: goneId,
        projectId,
        ordinal: 2,
        text: 'a criterion the owner later drops',
        verificationMethod: 'deleted below',
        contentHash: '0'.repeat(64),
      },
    });
    const task = await file('dropped', OWN_CRITERIA, uuidToBase62(goneId));
    assert.equal((await taskRow(task)).criterion_definition_id, goneId);
    const submitted = await submit(task, { key: uuidToBase62(goneId), text: 'a criterion the owner later drops' });
    assert.equal(submitted.criterionMatch?.matchesLive, true);

    await db.projectAcceptanceCriterionDefinition.delete({ where: { id: goneId } });
    assert.equal((await taskRow(task)).criterion_definition_id, null, 'ON DELETE SET NULL did not apply');

    await refusal(
      decide(task, '1', coordinatorSessionId, 'CONFIRM'),
      ConflictException,
      'EVIDENCE_JUDGMENT_CRITERION_MOVED',
      'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
    );
    assert.equal(await decisionCount(task), 0);
  });
});
