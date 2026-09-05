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
 *  - and what DOES remove a row is a decision bound to the version being asked about, which is the
 *    negative control: without it the first two proofs would hold for a read that always answers
 *    "three". Since 0239 that happens through two different doors, and both are exercised here: a
 *    CONFIRM settles the TASK, so its row never comes back; a SEND_BACK settles only that VERSION,
 *    so the next revision is a new question.
 *
 * The second claim is about WHERE a row goes, and it has two halves. The queue used to promise a
 * decision on evidence the door refuses outright — legacy evidence quoting no criterion, or one
 * whose wording has since been rewritten — which put a card headed DECISION REQUIRED on screen
 * whose every action was refused. Those rows now go to the one run that can file the revision that
 * clears them and to nobody else, and the invariant that makes the split worth anything is proved
 * by calling the door for real: every row left in `pending` is one a CONFIRM is actually accepted
 * for.
 *
 * The other half is (ii), and it is about the READER rather than the row. The rows are found by
 * owner, so before this every session was handed every one of this account's open questions and
 * merely told, per row, which ones it was not allowed to answer — one fact painted onto as many
 * faces as there were open sessions, none of whose readers could act on most of it. What comes
 * back is now scoped, and scoped all the way: four readers of the same three facts are asked about
 * three, two, two and two of them, and the stalled row only its submitter can clear reaches the
 * submitter and no other session. A group that greyed the same row and showed it anyway was that
 * one fact on those same N faces under a politer heading, which is why the assertions below ask
 * which groups a task appears in AT ALL rather than which of two named ones it landed in.
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
import { readCriterionSatisfaction } from '../projects/project-criterion-satisfaction';
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
  // The stalled population this rail actually meets: evidence imported from a task comment, from
  // before the envelope existed. It quotes no criterion because there was nowhere to quote one.
  const legacyTaskId = randomUUID();
  const legacySessionId = randomUUID();
  const legacyCommentId = randomUUID();
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
    [legacyTaskId, 'the SOURCE contract rebase'] as const,
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
        // 0232's declaration, on the three tasks that were filed against a stated criterion. The
        // legacy task deliberately has none: work from before the criteria existed could not
        // declare one, which is the same reason its evidence quotes none.
        ...(work.some((unit) => unit.taskId === id)
          ? {
            criterionDefinitionId: work.find((unit) => unit.taskId === id)!.criterionId,
            criterionRevision: 1,
          }
          : {}),
      },
    });
  }
  for (const [id, taskFor, title] of [
    ...work.map((unit, index) => [unit.sessionId, unit.taskId, `run ${index + 1}`] as const),
    [coordinatorSessionId, coordinatorTaskId, 'the coordinator'] as const,
    [legacySessionId, legacyTaskId, 'the run that predates the envelope'] as const,
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

  // What a legacy import is imported FROM: the comment a run left behind when saying "done" was
  // prose in a thread rather than a submission.
  await db.taskComment.create({
    data: {
      id: legacyCommentId,
      taskId: legacyTaskId,
      authorType: CreatorType.USER,
      authorId: ownerId,
      body: 'rebased onto main; the suite passed locally',
    },
  });

  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    coordinatorTaskId,
    coordinatorSessionId,
    legacyTaskId,
    legacySessionId,
    legacyCommentId,
    work,
  };
}

/** The queue, as a reader sees it. Structural and optional throughout, on purpose: this spec has
 *  to be able to run — and FAIL — against a build with no derived read at all, and importing the
 *  response through a required type would turn that into a compile error instead. */
interface RowView {
  taskId?: string;
  title?: string;
  evidenceRevision?: string;
  criterion?: { key?: string; text?: string } | null;
  gaps?: string[];
  claim?: string;
  ageSeconds?: number;
  citations?: Array<{ ref?: string; resolved?: boolean; reason?: string | null }>;
  decidability?: { decidable?: boolean; refusal?: string | null; requiredAction?: string | null };
  independence?: { independent?: boolean; disqualification?: string | null; requiredAction?: string | null };
}

/** The code a Nest refusal carries, so a rejection can be asserted to be the RIGHT rejection. */
function refusalCode(error: unknown): string | null {
  const response = (error as { getResponse?: () => unknown })?.getResponse?.();
  if (!response || typeof response !== 'object') return null;
  const code = (response as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

interface QueueView {
  count?: number;
  oldestAgeSeconds?: number | null;
  decidingSessionId?: string;
  pending?: RowView[];
  /** Optional for the same reason the rest of this view is: this spec has to be able to FAIL
   *  against a build whose read has one group, rather than not compile against it. */
  waitingOnYou?: RowView[];
}

/** The fields the read is allowed to come back with. Written out because the claim of this round
 *  is subtractive: a group is gone, and the way to hold it gone is to compare the whole key set
 *  rather than to ask whether one name happens to be absent from one call. */
const QUEUE_FIELDS = [
  'readAt',
  'decidingSessionId',
  'count',
  'oldestAgeSeconds',
  'pending',
  'waitingOnYou',
] as const;

/** Every group the read returns, whatever it is called — read off the object rather than from a
 *  list of the two names this spec knows. A third group added back under a third name is then
 *  caught by the assertions below instead of quietly becoming the next place to broadcast from. */
function groupsOf(view: QueueView): Array<[string, RowView[]]> {
  const groups: Array<[string, RowView[]]> = [];
  for (const [name, value] of Object.entries(view)) {
    if (Array.isArray(value)) groups.push([name, value as RowView[]]);
  }
  return groups;
}

/** Which groups this read puts a given task in, by name. `[]` is the claim that matters here: the
 *  reader is not shown it at all, which is a different fact from "it is in the other one". */
function homeOf(view: QueueView, taskId: string): string[] {
  return groupsOf(view)
    .filter(([, rows]) => rows.some((row) => row.taskId === taskId))
    .map(([name]) => name)
    .sort();
}

/** How many rows this reader is handed in total, across every group the read returns. */
function rowsIn(view: QueueView): number {
  return groupsOf(view).reduce((total, [, rows]) => total + rows.length, 0);
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
      // And the two are the same fact rather than two that agree today: `count` is the length of
      // the list it sits above, so no reader can be led with a number the list under it misses.
      assert.equal(read.count, read.pending?.length);
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

  // (i.b) ----------------------------------------------------------------------------------------
  // What the read comes back WITH, as a set. The claim of this round is a subtraction — the group
  // that carried a stall to every session other than the one that could clear it is gone — and a
  // subtraction is only held by comparing the whole key set. `!('awaitingSubmitter' in queue)`
  // would say what happened on one call and nothing about the next; this fails the moment any
  // group is added back, under that name or any other.
  await t.test('the read comes back as exactly these fields, and no group beyond them', async () => {
    const session = await db.session.findFirstOrThrow({
      where: { id: f.coordinatorSessionId, ownerId: f.ownerId },
      select: { id: true, taskId: true },
    });
    const read = await readPendingEvidenceJudgments(db, f.ownerId, session);

    assert.deepEqual(Object.keys(read).sort(), [...QUEUE_FIELDS].sort());
    // Two of those six are groups, and the other four describe the read itself.
    assert.deepEqual(groupsOf(read as QueueView).map(([name]) => name).sort(),
      ['pending', 'waitingOnYou']);
  });

  // (ii) -----------------------------------------------------------------------------------------
  // The scope claim, and the one the screenshot was of. Three questions exist on this ACCOUNT; the
  // number any one session is asked about is decided by what that session may answer, so four
  // readers of the same three facts get four different answers. A read that only decorated its
  // rows with independence — which is what this was before — answers "three" to every one of them.
  await t.test('what comes back is scoped to the reader, not to the account', async () => {
    const read = await queue(f.coordinatorSessionId);
    assert.deepEqual(read.pending?.map((row) => row.independence?.independent), [true, true, true]);

    // Read from the run that DID the first task's work. That question has not gone anywhere — the
    // coordinator above is still being asked it — it is simply not among the ones put to a reader
    // the door would refuse. Nothing this session can act on is withheld, and nothing it cannot
    // act on is shown.
    const fromTheSubmitter = await queue(f.work[0].sessionId);
    assert.equal(fromTheSubmitter.count, 2);
    assert.deepEqual(fromTheSubmitter.pending?.map((row) => row.taskId),
      [f.work[1].taskId, f.work[2].taskId]);
    assert.equal(fromTheSubmitter.pending?.some((row) => row.taskId === f.work[0].taskId), false,
      'a session was handed the question about its own work');
    // Not shunted into another group either: the other group is about evidence no decision can be
    // recorded about, which is a different fact from "not by you". Asked of every group the read
    // returns rather than of the ones this spec can name.
    assert.deepEqual(homeOf(fromTheSubmitter, f.work[0].taskId), []);
    assert.equal(fromTheSubmitter.count, fromTheSubmitter.pending?.length);
    // And the headline number follows the rows rather than the account, so a session cannot lead
    // with a count of questions it is not being asked.
    assert.equal(fromTheSubmitter.oldestAgeSeconds, fromTheSubmitter.pending?.[0].ageSeconds);

    // The whole shape of the bug, stated as one assertion: N readers, the same three account-level
    // facts, and the size of the list is a function of the READER. Before this, every entry in
    // `asked` was 3.
    const asked = new Map<string, number>();
    for (const [label, sessionId] of [
      ['coordinator', f.coordinatorSessionId],
      ['run 1', f.work[0].sessionId],
      ['run 2', f.work[1].sessionId],
      ['run 3', f.work[2].sessionId],
    ] as const) {
      asked.set(label, (await queue(sessionId)).count ?? -1);
    }
    assert.deepEqual([...asked.entries()],
      [['coordinator', 3], ['run 1', 2], ['run 2', 2], ['run 3', 2]],
      'the same account-level list was handed to every session');
  });

  // (iii) ----------------------------------------------------------------------------------------
  // The negative control for everything below it. If these rows did not leave, "the same rows are
  // still there" would be true of a read that never looked at anything.
  //
  // Two decisions, because since 0239 a row leaves this queue through two DIFFERENT doors and the
  // read needs both clauses to be right. A CONFIRM of the current revision derives DONE, so its row
  // goes because the TASK settled and stays gone however many revisions follow it. A SEND_BACK
  // writes nothing to the task, so its row goes only because that VERSION has been answered, and
  // the next revision brings it back. Either clause on its own gets one of these two wrong.
  await t.test('a decision on the version being asked about is what removes a row', async () => {
    const statusOf = async (taskId: string): Promise<string> => (
      await sql.query<{ status: string }>('SELECT "status" FROM "task" WHERE "id" = $1', [taskId])
    ).rows[0].status;

    await service.decide(
      f.ownerId,
      f.work[1].taskId,
      { type: CreatorType.USER, id: f.ownerId },
      { decidingSessionId: f.coordinatorSessionId, evidenceRevision: '1', decision: 'CONFIRM' },
    );

    const read = await queue(f.coordinatorSessionId);
    assert.equal(read.count, 2);
    assert.deepEqual(read.pending?.map((row) => row.taskId), [f.work[0].taskId, f.work[2].taskId]);
    // Which door it left by is part of the claim: the CONFIRM settled the task itself.
    assert.equal(await statusOf(f.work[1].taskId), TaskStatus.DONE);

    // A later submission does NOT put a settled task back: the decision door reopens nothing, and a
    // task that has settled is not a question whatever revision its ledger is at.
    await submit(1, 'the migration applied, and the rollback was rehearsed', []);
    const afterConfirmed = await queue(f.coordinatorSessionId);
    assert.equal(await statusOf(f.work[1].taskId), TaskStatus.DONE);
    assert.equal(afterConfirmed.count, 2);
    assert.deepEqual(afterConfirmed.pending?.map((row) => row.taskId),
      [f.work[0].taskId, f.work[2].taskId]);

    // SEND_BACK is the answer that settles nothing, and it is where "bound to one immutable
    // version" is still observable: the row leaves with the task still OPEN, because THIS version
    // was answered...
    await service.decide(
      f.ownerId,
      f.work[2].taskId,
      { type: CreatorType.USER, id: f.ownerId },
      {
        decidingSessionId: f.coordinatorSessionId,
        evidenceRevision: '1',
        decision: 'SEND_BACK',
        note: 'cite the run that produced it, not the summary of it',
      },
    );
    const afterSendBack = await queue(f.coordinatorSessionId);
    assert.equal(await statusOf(f.work[2].taskId), TaskStatus.OPEN);
    assert.equal(afterSendBack.count, 1);
    assert.deepEqual(afterSendBack.pending?.map((row) => row.taskId), [f.work[0].taskId]);

    // ...and a new revision is a new question, at the version nobody has answered.
    await submit(2, 'the rail renders three rows, and the empty state', ['nothing was checked on a phone']);
    const afterRevision = await queue(f.coordinatorSessionId);
    assert.equal(afterRevision.count, 2);
    assert.equal(
      afterRevision.pending?.find((row) => row.taskId === f.work[2].taskId)?.evidenceRevision,
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

  // (vi) -----------------------------------------------------------------------------------------
  // The row the screenshot was of. Imported through the app's own legacy door rather than written
  // by hand, so what is under test is the shape production actually has: a submission from before
  // the envelope, which quotes no criterion because there was nowhere to quote one.
  await t.test('evidence quoting no criterion reaches its submitter, and no other session',
    async () => {
      const before = await queue(f.coordinatorSessionId);

      await service.importLegacyComment(
        f.ownerId,
        f.legacyTaskId,
        { type: CreatorType.USER, id: f.ownerId },
        {
          sourceCommentId: f.legacyCommentId,
          sourceSessionId: f.legacySessionId,
          evidence: { summary: 'rebased onto main; the suite passed locally' },
          idempotencyKey: 'legacy-import-of-the-source-contract-rebase',
          reviewNote: 'imported while reconciling the stalled EVIDENCE_JUDGMENT population',
        },
      );

      // A reader who cannot clear it is not handed it — under any heading. This is the negative
      // control of the round: the row exists, it is open, it is on this account, and this read
      // returns nothing about it, because there is nothing this session could do with it. Being
      // able to see a stall on every screen was never the same as having told somebody.
      const read = await queue(f.coordinatorSessionId);
      assert.deepEqual(homeOf(read, f.legacyTaskId), [],
        'a stall nobody here can clear was put in front of this reader anyway');
      assert.equal(rowsIn(read), rowsIn(before),
        'the reader was handed more rows than before by evidence addressed to somebody else');
      assert.equal(read.count, before.count);

      // It has ONE home, and it is the run that filed it: the only place where "the next revision
      // has to quote a criterion" is an instruction to somebody rather than a fact about somebody
      // else. That is the difference between delivering a stall and broadcasting one.
      const fromTheSubmitter = await queue(f.legacySessionId);
      assert.deepEqual(homeOf(fromTheSubmitter, f.legacyTaskId), ['waitingOnYou'],
        'the row that only the submitter can clear was not put in front of the submitter');

      // The row says why, in the door's own words, and names the action in the door's vocabulary.
      const [row] = fromTheSubmitter.waitingOnYou ?? [];
      assert.equal(row.decidability?.decidable, false);
      assert.match(String(row.decidability?.refusal), /quotes no project criterion/);
      assert.equal(row.decidability?.requiredAction,
        'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION');
      // Everything the submitter needs in order to clear it is still on it.
      assert.equal(row.title, 'the SOURCE contract rebase');
      assert.equal(row.criterion, null);
      assert.equal(row.evidenceRevision, '1');
      assert.ok((row.ageSeconds ?? -1) >= 0);

      // The decidable group says the opposite about every one of its rows, for both readers.
      assert.deepEqual(read.pending?.map((each) => each.decidability?.decidable),
        read.pending?.map(() => true));
      assert.equal(read.pending?.some((each) => each.taskId === f.legacyTaskId), false);
    });

  // (vii) ----------------------------------------------------------------------------------------
  // The reverse assertion, against a derivation that shares no code with this one: T3 answers "is
  // this criterion satisfied" from the criterion side, and the work it names as outstanding is
  // exactly the work this rail is asking about. Two reads, one truth.
  await t.test('the decidable group is exactly the work the criterion side is still waiting on',
    async () => {
      const read = await queue(f.coordinatorSessionId);
      const satisfaction = await readCriterionSatisfaction(
        db as unknown as PrismaService,
        f.ownerId,
        f.projectId,
      );

      const outstanding = [...new Set(satisfaction
        .flatMap((criterion) => criterion.unmet)
        .filter((reason) => reason.clause === 'SERVING_WORK_UNSETTLED')
        .flatMap((reason) => reason.heldUpBy)
        // The queue only asks about tasks that have not settled; a criterion held up by one that
        // has is a different disagreement and not this one.
        .filter((task) => task.status === TaskStatus.OPEN || task.status === TaskStatus.IN_PROGRESS)
        .map((task) => task.taskId))];

      assert.ok((read.pending?.length ?? 0) > 0, 'the comparison is vacuous with an empty group');
      assert.deepEqual(
        outstanding.sort(),
        (read.pending ?? []).map((row) => String(row.taskId)).sort(),
      );
      // And the legacy row is in neither: the reason it serves no stated criterion is the same
      // reason no decision can be recorded about it.
      assert.equal(outstanding.includes(f.legacyTaskId), false);
    });

  // (viii) ---------------------------------------------------------------------------------------
  // The other way a row becomes undecidable, and the one that moves: nothing about the submission
  // changes, the STANDARD does. One row crosses from one group to the other and back.
  await t.test('a criterion rewritten after the fact takes its row out of the decidable group',
    async () => {
      const before = await queue(f.coordinatorSessionId);
      assert.equal(before.pending?.some((row) => row.taskId === f.work[0].taskId), true);

      await db.projectAcceptanceCriterionDefinition.update({
        where: { id: f.work[0].criterionId },
        data: { text: `${CRITERION_TEXT[0]}, and every row says which group it is in` },
      });

      const moved = await queue(f.coordinatorSessionId);
      assert.equal(moved.pending?.some((row) => row.taskId === f.work[0].taskId), false);
      assert.equal(moved.count, (before.count ?? 0) - 1);
      // It leaves this reader's read entirely rather than moving down it: nothing about a rewritten
      // standard is this session's to fix, and a greyed copy here would say only "not yours".
      assert.deepEqual(homeOf(moved, f.work[0].taskId), []);

      // It moves TO the run that filed the submission, which is the one that can quote the
      // standard as it now stands.
      const fromTheSubmitter = await queue(f.work[0].sessionId);
      assert.deepEqual(homeOf(fromTheSubmitter, f.work[0].taskId), ['waitingOnYou']);
      const row = (fromTheSubmitter.waitingOnYou ?? []).find(
        (each) => each.taskId === f.work[0].taskId,
      );
      assert.ok(row, 'the row left the decidable group and was not handed over at all');
      assert.equal(row?.decidability?.decidable, false);
      assert.match(String(row?.decidability?.refusal), /is not what the project states today/);
      // What it quotes is unchanged — the quote is the evidence's, and only the standard moved.
      assert.equal(row?.criterion?.text, CRITERION_TEXT[0]);

      await db.projectAcceptanceCriterionDefinition.update({
        where: { id: f.work[0].criterionId },
        data: { text: CRITERION_TEXT[0] },
      });
      const restored = await queue(f.coordinatorSessionId);
      assert.equal(restored.pending?.some((each) => each.taskId === f.work[0].taskId), true);
      assert.equal(restored.count, before.count);
    });

  // (ix) -----------------------------------------------------------------------------------------
  // The invariant the split exists for, proved by calling the door rather than by comparing
  // fields: every row this read puts in front of a decider is a row the decider can actually
  // settle. Destructive, and last for that reason — each CONFIRM settles its task.
  await t.test('every row in the decidable group is one the door really accepts a CONFIRM for',
    async () => {
      const read = await queue(f.coordinatorSessionId);
      assert.ok((read.pending?.length ?? 0) >= 2, 'the invariant is vacuous with nothing to confirm');

      for (const row of read.pending ?? []) {
        assert.equal(row.independence?.independent, true);
        const written = await service.decide(
          f.ownerId,
          String(row.taskId),
          { type: CreatorType.USER, id: f.ownerId },
          {
            decidingSessionId: f.coordinatorSessionId,
            evidenceRevision: String(row.evidenceRevision),
            decision: 'CONFIRM',
          },
        ) as { decision?: string; evidenceRevision?: string };
        assert.equal(written.decision, 'CONFIRM');
        assert.equal(written.evidenceRevision, row.evidenceRevision);
      }

      // And the row in the other group is refused — which is why it is in the other group rather
      // than being quietly dropped from a queue that could have answered it.
      const legacyDecision = (decision: 'CONFIRM' | 'SEND_BACK', note?: string) => service.decide(
        f.ownerId,
        f.legacyTaskId,
        { type: CreatorType.USER, id: f.ownerId },
        { decidingSessionId: f.coordinatorSessionId, evidenceRevision: '1', decision, note },
      );
      await assert.rejects(legacyDecision('CONFIRM'),
        (error: unknown) => refusalCode(error) === 'EVIDENCE_JUDGMENT_CRITERION_MOVED');
      // SEND_BACK too, and for the same reason: check 2 runs before the door looks at WHICH
      // decision was asked for. That is why the card for this group lights nothing at all rather
      // than offering to send it back.
      await assert.rejects(legacyDecision('SEND_BACK', 'quote the criterion this work serves'),
        (error: unknown) => refusalCode(error) === 'EVIDENCE_JUDGMENT_CRITERION_MOVED');

      const after = await queue(f.coordinatorSessionId);
      assert.equal(after.count, 0);
      // Nothing at all, not an empty decidable group above a grey one: every question this account
      // still has is addressed to somebody else, so this reader is handed no rows.
      assert.equal(rowsIn(after), 0);
      // The refused row has not gone anywhere, though — it is still open, and still in front of
      // the run that has to file the revision that clears it.
      assert.deepEqual(homeOf(await queue(f.legacySessionId), f.legacyTaskId), ['waitingOnYou']);
    });
});
