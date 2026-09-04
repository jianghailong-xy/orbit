/**
 * The pending-decision queue, against real PostgreSQL: it is a READ, and nothing else.
 *
 * The claim under test is not that the rows are right — it is that they are DERIVED. A queue is a
 * thing you can lose: a delivery that was dropped, a card a background socket never heard the
 * answer to, a local list that drifted from the world. This one cannot be any of those, and the
 * way to show it is to take away everything a queue would have been made of and watch the same
 * rows come back:
 *
 *  - the session that read them is ENDED and then DELETED, and a new session reads the same set.
 *    Nothing was addressed to the first session, so nothing went with it;
 *  - the `approval` table and every `run_event` row are dropped inside a rolled-back transaction
 *    and the answer is re-derived unchanged. Those are the seq:0 channel — `approval_request` and
 *    `approval_resolved` are published live-only and `?sinceSeq=` never replays them — so this is
 *    the structural form of "it does not hang on that channel", stronger than grepping for the
 *    names. A reader that consulted either would either throw or answer differently;
 *  - and the one thing that DOES remove a row is a decision bound to the version being asked
 *    about, which is the negative control: without it the first two proofs would hold for a read
 *    that always answers "three".
 *
 * Destructive: it truncates, and it drops two tables inside a transaction it rolls back.
 * COORDINATOR_PG_URL must name the disposable guarded database with current migrations applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
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
import { readPendingEvidenceJudgments } from './pending-evidence-judgments';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

/** Three stated criteria, one per task, so a row's `criterion` is checkable rather than shared. */
const CRITERION_TEXT = [
  'the rail is derived from the facts and shows a count with the oldest age',
  'every row names the criterion it is measured against and what it did not establish',
  'no screen answers more than one of these at a time',
] as const;

async function empty(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "task", "session", "project", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Three runs that did work, and one that did not.
 *
 * The three working tasks submit at deliberately spaced `submitted_at` values, because "the oldest
 * question" is a claim about order and a fixture that wrote all three in the same millisecond
 * would let a read that ignores the clock pass.
 */
async function fixture(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorTaskId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const work = [0, 1, 2].map(() => ({
    taskId: randomUUID(),
    sessionId: randomUUID(),
    criterionId: randomUUID(),
  }));

  await db.user.create({
    data: { id: ownerId, email: `pending-${ownerId}@invalid.test`, name: 'Pending', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'pending-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'pending-workspace', enabled: true },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: 'the decision rail' },
  });
  for (const [index, unit] of work.entries()) {
    await db.projectAcceptanceCriterionDefinition.create({
      data: {
        id: unit.criterionId,
        projectId,
        ordinal: index + 1,
        text: CRITERION_TEXT[index],
        verificationMethod: 'the pg spec reads the queue back',
        contentHash: '0'.repeat(64),
      },
    });
  }

  for (const [id, title] of [
    ...work.map((unit, index) => [unit.taskId, `work ${index + 1}`] as const),
    [coordinatorTaskId, 'the run doing the deciding'] as const,
  ]) {
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
    ...work.map((unit, index) => [unit.sessionId, unit.taskId, `run ${index + 1}`] as const),
    [coordinatorSessionId, coordinatorTaskId, 'the coordinator'] as const,
  ]) {
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
    data: work.flatMap((unit, index) => [
      {
        sessionId: unit.sessionId,
        name: 'Bash',
        toolUseId: `toolu_work_${index}`,
        input: { command: `npm test -- work-${index}`, description: 'the run that produced it' },
        isError: false,
      },
    ]),
  });

  return { ownerId, runnerId, workspaceId, projectId, coordinatorTaskId, coordinatorSessionId, work };
}

/** The queue, as a reader sees it. Structural and optional throughout, on purpose: this spec has
 *  to be able to run — and FAIL — against a build with no derived read at all, and importing the
 *  response through a required type would turn that into a compile error instead. */
interface QueueView {
  count?: number;
  oldestAgeSeconds?: number | null;
  decidingSessionId?: string;
  pending?: Array<{
    taskId?: string;
    title?: string;
    evidenceRevision?: string;
    criterion?: { key?: string; text?: string } | null;
    gaps?: string[];
    claim?: string;
    ageSeconds?: number;
    citations?: Array<{ ref?: string; resolved?: boolean; reason?: string | null }>;
    independence?: { independent?: boolean; disqualification?: string | null; requiredAction?: string | null };
  }>;
}

suite('the pending-decision queue is derived from the facts, not delivered to anybody', async (t) => {
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

  const submit = (index: number, claim: string, gaps: string[]) => service.submit(
    f.ownerId,
    f.work[index].taskId,
    { type: CreatorType.AGENT, id: f.workspaceId },
    {
      sourceSessionId: f.work[index].sessionId,
      evidence: {
        claim,
        criterion: { key: uuidToBase62(f.work[index].criterionId), text: CRITERION_TEXT[index] },
        checks: [{ kind: 'TOOL_CALL', ref: `toolu_work_${index}` }],
        gaps,
      },
    },
  );

  const queue = (sessionId: string): Promise<QueueView> =>
    service.pending(f.ownerId, sessionId) as Promise<QueueView>;

  await submit(0, 'the fast gate passed', ['the full suite has not been run against this branch']);
  // Space the submissions so "oldest" is decided by the clock and not by insertion order.
  await sql.query(
    `UPDATE "task_completion_evidence" SET "submitted_at" = now() - interval '90 minutes'
      WHERE "task_id" = $1`,
    [f.work[0].taskId],
  );
  await submit(1, 'the migration applied', []);
  await sql.query(
    `UPDATE "task_completion_evidence" SET "submitted_at" = now() - interval '30 minutes'
      WHERE "task_id" = $1`,
    [f.work[1].taskId],
  );
  await submit(2, 'the rail renders three rows', ['nothing was checked on a phone']);

  // (i) ------------------------------------------------------------------------------------------
  await t.test('three pending facts are three rows, a count, and the age of the oldest',
    async () => {
      const read = await queue(f.coordinatorSessionId);

      assert.equal(read.count, 3);
      assert.equal(read.pending?.length, 3);
      assert.equal(read.decidingSessionId, f.coordinatorSessionId);
      // Oldest first, and the rail's headline number is that row's age rather than a fourth fact
      // that could disagree with it.
      assert.deepEqual(read.pending?.map((row) => row.taskId),
        [f.work[0].taskId, f.work[1].taskId, f.work[2].taskId]);
      assert.equal(read.oldestAgeSeconds, read.pending?.[0].ageSeconds);
      assert.ok((read.pending?.[0].ageSeconds ?? 0) >= 90 * 60);
      assert.ok((read.pending?.[1].ageSeconds ?? 0) >= 30 * 60);

      // Every row carries what the decision is made against: the criterion by key AND by the text
      // that was quoted, the version being answered, what the submitter says it did not establish,
      // and what each cited handle resolves to now.
      const oldest = read.pending?.[0];
      assert.equal(oldest?.evidenceRevision, '1');
      assert.equal(oldest?.criterion?.key, uuidToBase62(f.work[0].criterionId));
      assert.equal(oldest?.criterion?.text, CRITERION_TEXT[0]);
      assert.deepEqual(oldest?.gaps, ['the full suite has not been run against this branch']);
      assert.equal(oldest?.claim, 'the fast gate passed');
      assert.deepEqual(oldest?.citations,
        [{ kind: 'TOOL_CALL', ref: 'toolu_work_0', resolved: true, reason: null }]);
      // A declared-nothing-missing row says so with an empty list rather than by omitting the
      // field: "no gaps" is a claim the submitter made and a reader is entitled to see it.
      assert.deepEqual(read.pending?.[1].gaps, []);
    });

  // (ii) -----------------------------------------------------------------------------------------
  await t.test('the reader is told which rows it may answer, and why not for the rest',
    async () => {
      const read = await queue(f.coordinatorSessionId);
      assert.deepEqual(read.pending?.map((row) => row.independence?.independent), [true, true, true]);

      // Read from the run that DID the first task's work: the same three questions are there — a
      // question does not disappear because this particular reader cannot answer it — and the one
      // it may not answer says so, with the action that would clear it.
      const fromTheSubmitter = await queue(f.work[0].sessionId);
      assert.equal(fromTheSubmitter.count, 3);
      assert.deepEqual(fromTheSubmitter.pending?.map((row) => row.independence?.independent),
        [false, true, true]);
      assert.equal(fromTheSubmitter.pending?.[0].independence?.requiredAction,
        'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK');
      assert.match(String(fromTheSubmitter.pending?.[0].independence?.disqualification),
        /run of the task it is deciding/);
    });

  // (iii) ----------------------------------------------------------------------------------------
  // The negative control for everything below it. If this row did not leave, "the same rows are
  // still there" would be true of a read that never looked at anything.
  await t.test('a decision on the version being asked about is what removes a row', async () => {
    await service.decide(
      f.ownerId,
      f.work[1].taskId,
      { type: CreatorType.USER, id: f.ownerId },
      { decidingSessionId: f.coordinatorSessionId, evidenceRevision: '1', decision: 'CONFIRM' },
    );

    const read = await queue(f.coordinatorSessionId);
    assert.equal(read.count, 2);
    assert.deepEqual(read.pending?.map((row) => row.taskId), [f.work[0].taskId, f.work[2].taskId]);

    // And a NEW revision of the same task is a new question: the decision was bound to version 1,
    // so it says nothing about version 2 and the row comes back at the version nobody answered.
    await submit(1, 'the migration applied, and the rollback was rehearsed', []);
    const afterRevision = await queue(f.coordinatorSessionId);
    assert.equal(afterRevision.count, 3);
    assert.equal(
      afterRevision.pending?.find((row) => row.taskId === f.work[1].taskId)?.evidenceRevision,
      '2',
    );
  });

  // (iv) -----------------------------------------------------------------------------------------
  await t.test('closing and reopening the session leaves the same rows', async () => {
    const before = await queue(f.coordinatorSessionId);

    // Ended, then deleted outright — the strong form. If any part of this were addressed TO that
    // session, it would go with it.
    await db.session.update({
      where: { id: f.coordinatorSessionId },
      data: { status: RunStatus.SUCCEEDED, completedAt: new Date() },
    });
    await db.session.delete({ where: { id: f.coordinatorSessionId } });

    const reopenedId = randomUUID();
    await db.session.create({
      data: {
        id: reopenedId,
        ownerId: f.ownerId,
        creatorId: f.ownerId,
        taskId: f.coordinatorTaskId,
        workspaceId: f.workspaceId,
        assignedRunnerId: f.runnerId,
        title: 'the coordinator, reopened',
        prompt: 'keep going',
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });

    const after = await queue(reopenedId);
    assert.equal(after.count, before.count);
    assert.deepEqual(
      after.pending?.map((row) => [row.taskId, row.evidenceRevision]),
      before.pending?.map((row) => [row.taskId, row.evidenceRevision]),
    );
    assert.equal(after.decidingSessionId, reopenedId);
    f.coordinatorSessionId = reopenedId;
  });

  // (v) ------------------------------------------------------------------------------------------
  await t.test('the same rows are derived with the seq:0 channel taken out of the database',
    async () => {
      const before = await queue(f.coordinatorSessionId);

      // Give the channel something to be read: an approval waiting on this account's session and a
      // handful of run events. A read that consulted either would now have material to consult.
      await sql.query(
        `INSERT INTO "approval" ("id", "session_id", "tool_name", "input", "status")
         VALUES (gen_random_uuid(), $1, 'orbit_task_batch', '{}'::jsonb, 'PENDING')`,
        [f.coordinatorSessionId],
      );
      for (const [index, unit] of f.work.entries()) {
        await sql.query(
          `INSERT INTO "run_event" ("id", "session_id", "seq", "type", "payload")
           VALUES (gen_random_uuid(), $1, $2, 'assistant', '{}'::jsonb)`,
          [unit.sessionId, index + 1],
        );
      }
      const withChannel = await queue(f.coordinatorSessionId);
      assert.equal(withChannel.count, before.count,
        'rows appeared or vanished when unrelated live frames existed');

      // Now take the whole channel away and re-derive inside the same transaction. Rolled back, so
      // the suite's database is left as it was; what it proves is that neither table is reachable
      // from this read — a reader of either would raise 42P01 rather than answer.
      const ROLLBACK = new Error('rollback the dropped channel');
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('DROP TABLE "approval" CASCADE');
          await tx.$executeRawUnsafe('DROP TABLE "run_event" CASCADE');
          const session = await tx.session.findFirstOrThrow({
            where: { id: f.coordinatorSessionId, ownerId: f.ownerId },
            select: { id: true, taskId: true },
          });
          const withoutChannel = await readPendingEvidenceJudgments(tx, f.ownerId, session);
          assert.equal(withoutChannel.count, before.count);
          assert.deepEqual(
            withoutChannel.pending.map((row) => [row.taskId, row.evidenceRevision]),
            before.pending?.map((row) => [row.taskId, row.evidenceRevision]),
          );
          throw ROLLBACK;
        }, { timeout: 60_000 }),
        (error: unknown) => error === ROLLBACK,
      );

      // The rollback really did roll back: the tables are still there for the next reader.
      const remaining = await sql.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "pg_class"
          WHERE "relname" IN ('approval', 'run_event') AND "relkind" = 'r'`,
      );
      assert.equal(remaining.rows[0].n, '2');
    });
});
