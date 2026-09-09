/**
 * `project.status` is a PROJECTION of two committed facts, and the column in the database is where
 * this file reads the answer.
 *
 * WHAT IS BEING REVERSED, AND BY WHOM
 * -----------------------------------
 * Migration 0229 wrote down a decision, not an oversight: "The DONE gate is not replaced. The
 * owner was offered a narrower guard and chose the other option." The account owner was asked
 * again on 2026-09-08, with that sentence quoted back to them, and answered that the derivation
 * should be built. Nothing here is a bug fix, and nothing here restores what 0229 deleted — no
 * acceptance table, no `project` trigger, no dropped column, no gate. What it adds is a read of
 * rows that are already committed, stored back into the column those rows are about.
 *
 * WHY THE ASSERTIONS ARE ON THE STORED COLUMN
 * -------------------------------------------
 * Every case below reads `project.status` with SQL, past every service that could have computed a
 * nicer answer on the way out. A projection that only showed DONE in a response body would leave
 * the column — the thing every other reader in this repository consults, from `project_list` to
 * the scope contract — still saying OPEN, and the two would disagree with nobody able to say
 * which was the project's status. So the response body is not the subject here. The row is.
 *
 * WHY FOUR COMBINATIONS AND NOT ONE
 * ---------------------------------
 * A derivation asserted only where it says DONE is indistinguishable from a function that returns
 * DONE. The conjunction has two independent inputs and each of them is shown withholding DONE on
 * its own, from a state where the other one holds:
 *
 *   (2) every criterion satisfied and LANDED, and nobody has confirmed  → OPEN
 *   (1) the same, plus the owner's confirmation of THIS version         → DONE
 *   (4) DONE, then a new serving task arrives                           → OPEN
 *   (3) confirmed, and one criterion is unsatisfied — then satisfied
 *       with no receipt onto the default branch                         → OPEN
 *
 * They run as one timeline over one project, in that order, and every step moves exactly ONE
 * variable from the step before it. That is the whole reason it is a timeline rather than four
 * fixtures: four independent set-ups can each be wrong in their own way and still agree, while a
 * single change of one input that moves the column is evidence about that input.
 *
 * WHY A FIFTH CASE, WHICH IS ABOUT AN EDGE AND NOT ABOUT AN INPUT
 * ---------------------------------------------------------------
 * (1) to (4) show what the projection READS. None of them says anything about who performs it,
 * because every one of them reaches the column over a task write or the owner's confirmation —
 * the two edges that carried it. A merge receipt is an input to the same projection and had no
 * edge at all: an owner who confirmed the criteria BEFORE the last branch landed was left with a
 * column asserting OPEN until some unrelated task write happened along.
 *
 * So (5) walks to the position (3) walks to, records the missing receipt through
 * `MergeReceiptService.record` — the method all three writers of one go through — and then does
 * nothing whatever: no task write, no confirmation, no call to the projection. Its paired negative
 * is the reading taken immediately before that receipt, in the same case and over the same rows:
 * OPEN, with `CRITERION_UNLANDED` the only clause outstanding. Without that reading, a DONE
 * afterwards would be equally true of a column that already said DONE and of an implementation
 * that never projects anything at all.
 *
 * WHY A CASE ABOUT THE EDIT ITSELF, WHICH IS AN EDGE AND NOT AN INPUT
 * -------------------------------------------------------------------
 * (1) to (4) show what the projection READS. None of them says anything about WHO performs it,
 * because every one of them reaches the column over a task write or the owner's confirmation. An
 * EDIT of the criteria moves an input over neither: `ProjectsService.update` is the one writer
 * that states them, the digest moves under the confirmation already on record, and that write
 * re-projected nothing. A settled project whose owner reworded one assertion went on asserting
 * DONE in the column until some unrelated task write happened along — which, in the order this
 * repository runs in, is until something that has nothing to do with the edit happens.
 *
 * So the last case before CANCELLED walks back to DONE over the two edges that already carried
 * the projection, and then does exactly one thing: the edit. No task write, no confirmation, no
 * call to the projection. Its paired positive control is the reading taken immediately before the
 * edit and over the same rows — DONE — without which an OPEN afterwards would be equally true of
 * a column that already said OPEN and of an implementation that projects nothing on any edge
 * whatever; and the project's task rows are fingerprinted either side of the edit, so "no task
 * write" is asserted rather than described.
 *
 * WHY A `.pg.spec`
 * ----------------
 * Every fact is produced the way the product produces it. Criteria are stated through
 * `ProjectsService.update` (the only thing that advances a definition's revision, in a trigger);
 * the confirmation is written through `ProjectAcceptanceService.confirmStandardSet`, r3's one
 * writer; serving tasks reach DONE through 0193/0230's BEFORE UPDATE fence; receipts are written
 * by `MergeReceiptService`; and the criteria are EDITED through `ProjectsService.update` as well.
 * The projection is never invoked directly — it is driven only from the production edges that
 * carry it, so a green here is evidence that those edges carry it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-done-derived.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ProjectStatus, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import type { CompletionInputRouter } from './completion-input-router.service';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone, type DerivedDoneWithheld } from './project-done-derived';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
/**
 * The rungs of the HUMAN → VERIFICATION → EXECUTABLE ladder, in the order this fixture climbs them.
 *
 * The two edits below move a criterion UP the ladder rather than rewording it, and they have to:
 * a criteria edit takes effect only when it walks the ruler toward strictness, and a rewriting is
 * a direction nothing can read, so it is held as a proposal for the account owner and the
 * criterion does not move at all (`criteria-weakening-intent.pg.spec.ts`). What both cases below
 * need is a criterion that MOVED — the seal is the same either way, because it is taken over
 * `revision` and `content_hash` and the trigger rewrites both from the method as well as the words.
 */
const METHOD = 'HUMAN';
const STRICTER = 'VERIFICATION';
const STRICTEST = 'EXECUTABLE';

/** A full 40-hex object name, which is the only kind a receipt accepts. */
const sha = (nibble: string) => nibble.repeat(40);

const FIRST = 'the projection reads the criteria and the confirmation, and writes neither';
const SECOND = 'the projection can take DONE away again';

/** How an `AuthorityRefusal` reaches a caller through Nest's exception response. */
interface RefusalBody { code?: string; message?: string }

test('project.status = DONE is projected from confirmed criteria that landed, and only from those', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const acceptance = new ProjectAcceptanceService(prisma as unknown as PrismaService);
  const projects = new ProjectsService(prisma as unknown as PrismaService, acceptance);
  /**
   * The completion-input router BOTH post-commit edges are held behind.
   *
   * A stand-in, and its methods answer with nothing, because what a settled project or a landed
   * criterion WAKES is a different unit's question and is covered where that unit is tested. What
   * it is here for is the guard those deliveries share — `if (!this.completionInputs) return` —
   * which is also what holds the projection off the fixtures that build these services directly. A
   * spec that left it out would exercise no post-commit edge at all and could then only reach the
   * projection by calling it, which is the one thing this file must not do.
   *
   * One object for the task writer and the receipt writer alike: the projection rides both edges,
   * and a fixture that wired only one of them would decide by omission which of the two this file
   * is allowed to notice.
   */
  const completionInputs = {
    routeSettledProjects: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
    routeTaskExceptions: async () => [],
  } as unknown as CompletionInputRouter;

  const receipts = new MergeReceiptService(prisma as unknown as PrismaService, completionInputs);
  const tasks = new TasksService(
    prisma as never,
    {} as never,
    { publishTaskChanged() {}, publishForUser() {}, publishTaskResync() {} } as never,
    undefined,
    completionInputs,
  );

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `derived-${ownerId}@project-done.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose status is projected' },
  });

  // ── the fixture's own vocabulary ───────────────────────────────────────────────────────────────

  /** The stored column, read with SQL: past every service, and past every response body. */
  async function storedStatus(): Promise<string> {
    const { rows } = await sql.query<{ status: string }>(
      `SELECT "status"::text FROM "project" WHERE "id" = $1::uuid`, [projectId],
    );
    assert.equal(rows.length, 1, 'the project must still exist');
    return rows[0]!.status;
  }

  /** What the projection says today, and — when it is not DONE — every clause holding it back. */
  async function withheld(): Promise<DerivedDoneWithheld[]> {
    return (await readDerivedProjectDone(prisma as unknown as PrismaService, ownerId, projectId))
      .withheld;
  }

  /**
   * The next task write on this project — the post-commit edge the projection rides.
   *
   * A rename, deliberately: it changes nothing either input is derived from, so what it shows is
   * that a project is re-projected by ANY of its task writes and not only by the one that moved
   * the answer. That generosity is `deliverSettledProjects`'s own, and this spec depends on it in
   * exactly the way production does.
   */
  let renames = 0;
  async function nextTaskWrite(taskId: string) {
    await tasks.update(ownerId, taskId, { title: `still here (${++renames})` } as never);
  }

  /**
   * Settle an EXECUTABLE task the way `runnerApi.turnComplete` settles one: a compare-and-set that
   * repeats the declaration in its WHERE clause, through 0193/0230's BEFORE UPDATE fence. In a
   * worktree, on a branch, saying nothing whatever about `main` — which is why (3) below can hold
   * `satisfied` true and the landing lane silent at the same time.
   */
  async function settleExecutable(taskId: string) {
    const written = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid
          AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE'
          AND "acceptance_command" = 'true'
          AND "acceptance_expected_exit_code" = 0`,
      [taskId],
    );
    assert.equal(written.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
  }

  /** The worktree session a task's branch belongs to — what a receipt is recorded against. */
  async function sessionFor(taskId: string, branch: string) {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        title: `ran ${branch}`,
        prompt: 'do the work',
        status: RunStatus.SUCCEEDED,
        branch,
        isolationStatus: 'worktree',
      },
    });
    return id;
  }

  /**
   * A merge of that session's branch into the default branch: the landing lane's whole input, and
   * — because the writer above holds the router — a post-commit edge in its own right.
   *
   * What it recorded is handed back rather than discarded, so (5) can say that the receipt it is
   * about is a NEW one: this method is idempotent, and a re-report of a landing already on file
   * would leave the landing lane reading exactly as it read before.
   */
  async function landOnMain(sessionId: string, nibble: string) {
    return receipts.record(ownerId, sessionId, {
      result: 'MERGED',
      sourceSha: sha(nibble),
      targetBranch: 'main',
      targetShaBefore: sha('a'),
      targetShaAfter: sha('b'),
    }, 'AGENT');
  }

  /**
   * Every task row of this project, in the columns a task write moves.
   *
   * Read either side of the receipt in (5), and either side of the edit in the last case. The
   * projection's other edges are a TASK write and a confirmation, and this is what makes those
   * cases statements about the edge each one exercises rather than about a rename that happened
   * to be standing nearby.
   */
  async function taskFingerprint(): Promise<Array<Record<string, string>>> {
    const { rows } = await sql.query<Record<string, string>>(
      `SELECT "id"::text, "title", "status"::text, "updated_at"::text
         FROM "task" WHERE "project_id" = $1::uuid ORDER BY "id"`,
      [projectId],
    );
    return rows;
  }

  const EXECUTABLE_DECLARATION = {
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  };

  /**
   * One EXECUTABLE task filed against a criterion, with the worktree session its branch lives in.
   *
   * Every declaration is remembered, because a criterion edit later on makes ALL of them stale at
   * once and the last case needs to put them back — a task declares the revision that stood when
   * it declared it, and re-sending the same key is how that is brought up to date.
   */
  const servingDeclarations: Array<[taskId: string, criterionKey: string]> = [];
  async function servingTask(criterionKey: string, title: string, branch: string) {
    const task = await tasks.create(ownerId, {
      title, projectId, criterionKey, ...EXECUTABLE_DECLARATION,
    } as never);
    servingDeclarations.push([task.id, criterionKey]);
    return { id: task.id, sessionId: await sessionFor(task.id, branch) };
  }

  // ── the starting position: two criteria, both met, both on main, nobody has confirmed ─────────

  const [first, second] = criteriaFromDefinitions(
    (await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [FIRST, SECOND].map((text) => ({ text, verificationMethod: METHOD })),
    } as never)).acceptanceCriteriaItems,
  );
  assert.ok(first && second, 'the fixture states two criteria');

  const firstWork = await servingTask(first.key, 'the work for the first criterion', 'orbit/first');
  const secondWork = await servingTask(second.key, 'the work for the second criterion', 'orbit/second');
  await settleExecutable(firstWork.id);
  await settleExecutable(secondWork.id);
  await landOnMain(firstWork.sessionId, '1');
  await landOnMain(secondWork.sessionId, '2');

  assert.equal(await storedStatus(), ProjectStatus.OPEN,
    'a project is OPEN until something projects otherwise');

  // ═══ (2) every criterion satisfied and LANDED, and nobody has confirmed → still OPEN ══════════

  await t.test('(2) work that is finished and landed does not settle the project by itself', async () => {
    await nextTaskWrite(secondWork.id);

    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'the work side of the conjunction holds completely and the column must not move: whether '
        + 'these conditions express the goal is the one act reserved to the account owner, and a '
        + 'projection that settled the project without it would be answering that question itself');
    assert.deepEqual(await withheld(), ['STANDARD_SET_UNCONFIRMED'],
      'and the ONLY thing missing is the confirmation — so the single change (1) makes is the '
        + 'one variable this pair is about');
  });

  // ═══ (1) the same, plus the owner's confirmation of this version → DONE, in the column ════════

  await t.test('(1) the owner confirms this version of the criteria and the column becomes DONE', async () => {
    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(standing.state, 'UNCONFIRMED');

    await acceptance.confirmStandardSet(ownerId, projectId, {
      criteriaDigest: standing.currentVersion.digest,
    });

    assert.equal(await storedStatus(), ProjectStatus.DONE,
      'both inputs hold, so the column says so — and it says so because the rows say so, not '
        + 'because a request asked for it');
    assert.deepEqual(await withheld(), []);
  });

  // ═══ the write is a projection, not a request — which is what lets it coexist with r2 ═════════

  await t.test('a session still cannot ask for this, and the projection still made it so', async () => {
    // r2's rule, on the same project in the same state the projection just settled. The refusal is
    // about the FIELD and about the presence of an acting session; the projection carries neither
    // a `status` from a caller nor a session header, which is why the two stack instead of
    // colliding. Had the projection been implemented by calling `update`, this is the refusal it
    // would have met on every path a coordinator's own conversation produces its inputs on.
    const sessionId = randomUUID();
    await prisma.session.create({
      data: {
        id: sessionId,
        ownerId,
        creatorId: ownerId,
        title: 'a session acting on this project',
        prompt: 'act',
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: false,
      },
    });

    let refusal: RefusalBody | null = null;
    try {
      await projects.update(ownerId, projectId, { status: ProjectStatus.OPEN } as never, sessionId);
    } catch (error) {
      refusal = (error as { response?: RefusalBody }).response ?? null;
    }
    assert.equal(refusal?.code, 'PROJECT_STATUS_NOT_SESSION_WRITABLE',
      'r2 is untouched: a request made from a session cannot write this column, in either '
        + 'direction');
    assert.equal(await storedStatus(), ProjectStatus.DONE,
      'and the refused request wrote nothing, so what stands is what the projection wrote');
  });

  // ═══ (4) DONE, and then a new serving task arrives → the column stops claiming DONE ═══════════

  await t.test('(4) a new task filed against a met criterion takes DONE back', async () => {
    const late = await servingTask(first.key, 'more work for the first criterion', 'orbit/late');
    await nextTaskWrite(late.id);

    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'the criterion is no longer met, so the column may not go on asserting that it is: a '
        + 'projection that could only ever set DONE would be a latch, and a latch is a decision '
        + 'rather than a reading');
    assert.deepEqual(await withheld(), ['CRITERION_UNSATISFIED', 'CRITERION_UNLANDED'],
      'both clauses, and neither is redundant: a task nobody has finished has not settled, and a '
        + 'task with no merge receipt leaves its criterion’s landing UNKNOWN — the landing lane is '
        + 'a conjunction over the serving set, so one new task takes the whole criterion back');

    // ═══ (3) confirmed, and one criterion's work has not landed → still OPEN ═══════════════════
    //
    // The same criterion, one variable further on: the new task settles, so the work side reads
    // satisfied again — in its own worktree, on its own branch, with no receipt anywhere. This is
    // the false green the landing lane exists to break up, and it is the half of (3) that
    // `satisfied` alone cannot see.
    await settleExecutable(late.id);
    await nextTaskWrite(late.id);

    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'settled is not landed: the code implementing this criterion is on nobody’s main');
    assert.deepEqual(await withheld(), ['CRITERION_UNLANDED']);

    // And the receipt that was missing, which is the only thing that changes.
    await landOnMain(late.sessionId, '3');
    await nextTaskWrite(late.id);

    assert.equal(await storedStatus(), ProjectStatus.DONE,
      'the projection restores DONE from the same rows that took it away — it is a reading of '
        + 'the facts each time, not a decision recorded once');
  });

  // ═══ (5) the last input is a RECEIPT, and the edge that records one is what projects it ═══════

  await t.test('(5) recording the last receipt is what projects DONE, with no task write anywhere',
    async () => {
      // The position (3) reaches, walked to once more by the same three steps: a new task under a
      // criterion that was met, settled in its own worktree, on a branch, with no receipt anywhere.
      // The rename below is the LAST task write this case makes — everything after it happens on a
      // project whose task rows do not move again, which is what leaves the receipt as the only
      // candidate for whatever moves the column.
      const last = await servingTask(second.key, 'the work whose receipt arrives last', 'orbit/last');
      await settleExecutable(last.id);
      await nextTaskWrite(last.id);

      // The negative half of the pair, and the reason the positive half below is evidence at all:
      // without it, a DONE afterwards would be equally true of a column that already said DONE,
      // and of an implementation that projects nothing on any edge whatever.
      assert.equal(await storedStatus(), ProjectStatus.OPEN,
        'this case has to start from a column that does NOT say DONE, or nothing after it is a '
          + 'statement about what moved it');
      assert.deepEqual(await withheld(), ['CRITERION_UNLANDED'],
        'and the one clause outstanding is the receipt: the work is settled and the owner’s '
          + 'confirmation from (1) still names the version of the criteria that stands, so the '
          + 'landing of this one branch is the whole of what is left');

      const before = await taskFingerprint();

      // ── the receipt, through the door production records one through, and nothing else ────────
      // No task write, no confirmation, no call to the projection. This is the order this
      // repository actually runs in: the last task settles on a branch, the owner is carded and
      // confirms, and a session then merges and records the receipt — after which nothing writes a
      // task again.
      const recorded = await landOnMain(last.sessionId, '4');
      assert.equal(recorded.created, true,
        'the door recorded no new receipt, so nothing below is a statement about one');

      assert.equal(await storedStatus(), ProjectStatus.DONE,
        'a merge receipt is the whole of the landing half of this projection, and recording one '
          + 'is what re-projects it — an owner who confirms before the last branch lands would '
          + 'otherwise be left with a column asserting OPEN until some unrelated task write '
          + 'happened along');
      assert.deepEqual(await withheld(), []);
      assert.deepEqual(await taskFingerprint(), before,
        'a task row moved between the two readings, so the DONE above says nothing about the '
          + 'receipt edge');
    });

  // ═══ (4, the other half) a criterion is reopened after the project was DONE ═══════════════════

  await t.test('(4) reopening the work under a criterion takes DONE back too', async () => {
    await tasks.update(ownerId, firstWork.id, { status: 'OPEN' } as never);

    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'the reopened task is the same fact as an unfinished one and the column must follow it '
        + 'down as readily as it followed it up');
    assert.deepEqual(await withheld(), ['CRITERION_UNSATISFIED']);
  });

  // ═══ the confirmation is bound to a VERSION, and the projection is bound to that ══════════════

  await t.test('an edited criterion strands the confirmation, and the column follows', async () => {
    // Put the work back first, so the only thing standing between this project and DONE is again
    // the confirmation — the state (1) settled from. Through the DONE fence, because a task's own
    // status is not directly writable either.
    await settleExecutable(firstWork.id);
    await nextTaskWrite(firstWork.id);
    assert.equal(await storedStatus(), ProjectStatus.DONE);

    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [
        { id: first.definitionId, text: FIRST, verificationMethod: STRICTER },
        { id: second.definitionId, text: SECOND, verificationMethod: METHOD },
      ],
    } as never);
    await nextTaskWrite(secondWork.id);

    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'the confirmation names a version that has been edited since, so it is not a confirmation '
        + 'of the criteria that stand — and there is no flag anybody had to remember to clear');
    assert.equal(
      (await acceptance.standardSetConfirmation(ownerId, projectId)).state, 'STALE',
      'and it is STALE rather than gone: the row is still on record, it just no longer names '
        + 'this ruler',
    );
  });

  // ═══ the EDIT is an edge of its own: nothing else has to happen for the column to follow ══════

  await t.test('editing the criteria re-projects the column by itself, with no task write anywhere',
    async () => {
      // Back to DONE over the two edges that already carried the projection, and no further: the
      // tasks re-declare the criteria at the revision the edit above left standing, and the owner
      // confirms the ruler as it reads today. These are the LAST task writes this case makes —
      // everything below happens on a project whose task rows do not move again, which is what
      // leaves the edit as the only candidate for whatever moves the column.
      for (const [taskId, key] of servingDeclarations) {
        await tasks.update(ownerId, taskId, { criterionKey: key } as never);
      }
      const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
      await acceptance.confirmStandardSet(ownerId, projectId, {
        criteriaDigest: standing.currentVersion.digest,
      });

      // The positive half of the pair, and the reason the reading after the edit is evidence at all:
      // without it, an OPEN below would be equally true of a column that already said OPEN, and of
      // an implementation that projects nothing on any edge whatever.
      assert.equal(await storedStatus(), ProjectStatus.DONE,
        'this case has to start from a column that DOES say DONE, or nothing after it is a '
          + 'statement about what took it away');

      const before = await taskFingerprint();

      // ── the edit, through the one door that states criteria, and nothing else ──────────────────
      // No task write, no confirmation, no call to the projection. This is the order the product
      // runs in: a project settles, and the owner then tightens how one of the assertions it
      // settled against is to be judged — an edit nobody follows with anything, because from the
      // owner's side there is nothing left to do.
      await projects.update(ownerId, projectId, {
        acceptanceCriteriaItems: [
          { id: first.definitionId, text: FIRST, verificationMethod: STRICTEST },
          { id: second.definitionId, text: SECOND, verificationMethod: METHOD },
        ],
      } as never);

      assert.equal(await storedStatus(), ProjectStatus.OPEN,
        'the criteria this project was settled against are not the criteria it states now, so the '
          + 'column may not go on asserting DONE until something unrelated happens along to '
          + 're-derive it: the write that moves an input is the edge that re-projects it');
      assert.deepEqual(await taskFingerprint(), before,
        'a task row moved between the two readings, so the OPEN above says nothing about the edit');
      assert.deepEqual(await withheld(), ['CRITERION_UNSATISFIED', 'STANDARD_SET_UNCONFIRMED'],
        'and BOTH halves of the conjunction moved on the one edit, which is what an edit does: the '
          + 'confirmation on record names a version that no longer stands, and every task that '
          + 'declared the reworded criterion declared a revision that is no longer the one it '
          + 'carries — either clause alone would be enough to take DONE away');
      assert.equal(
        (await acceptance.standardSetConfirmation(ownerId, projectId)).state, 'STALE',
        'and the confirmation is STALE rather than gone: the row is still on record, it just no '
          + 'longer names this ruler',
      );
    });

  // ═══ CANCELLED is a person's decision about the project, not a reading of its work ════════════

  await t.test('a cancelled project is never settled or reopened by the projection', async () => {
    // Bring both inputs back so the projection WOULD act, which is what makes the two assertions
    // below evidence rather than a description of a project nothing was going to touch. The tasks
    // re-declare the criteria at the revision that stands now — the edit above left their earlier
    // declarations behind — and the owner confirms the ruler as it reads today.
    for (const [taskId, key] of servingDeclarations) {
      await tasks.update(ownerId, taskId, { criterionKey: key } as never);
    }
    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    await acceptance.confirmStandardSet(ownerId, projectId, {
      criteriaDigest: standing.currentVersion.digest,
    });
    assert.equal(await storedStatus(), ProjectStatus.DONE,
      'the control this case needs: from here the projection does move the column');

    await sql.query(`UPDATE "project" SET "status" = 'CANCELLED' WHERE "id" = $1::uuid`, [projectId]);
    await nextTaskWrite(secondWork.id);
    assert.equal(await storedStatus(), ProjectStatus.CANCELLED,
      'DONE would be the projected answer and the column stays CANCELLED anyway: cancelling says '
        + 'a person dropped this project, which is not a claim the work can settle');

    // And the other direction, from the same row: an input breaks and nothing reopens it either.
    await tasks.update(ownerId, firstWork.id, { status: 'OPEN' } as never);
    assert.deepEqual(await withheld(), ['CRITERION_UNSATISFIED']);
    assert.equal(await storedStatus(), ProjectStatus.CANCELLED,
      'a projection that reopened a cancelled project would be overruling the owner with a '
        + 'merge receipt');
  });
});
