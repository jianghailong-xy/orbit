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
 * re-projected nothing. A settled project whose owner tightened one assertion went on asserting
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
import { classifyCriteriaEdit } from './criteria-edit-classification';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone, type DerivedDoneWithheld } from './project-done-derived';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/**
 * The rungs of the HUMAN → VERIFICATION → EXECUTABLE ladder, in the order this fixture climbs them.
 *
 * The two edits below move a criterion UP the ladder rather than rewording it, and they have to:
 * a criteria edit takes effect only when it walks the ruler toward strictness, and a rewriting is
 * a direction nothing can read, so it is held as a proposal for the account owner and the
 * criterion does not move at all (`criteria-weakening-intent.pg.spec.ts`). What both cases below
 * need is a criterion that MOVED — the seal is the same either way, because it is taken over
 * `revision` and `content_hash` and the trigger rewrites both from the method as well as the words.
 *
 * `METHOD` is what every criterion is stated with and is never the thing under test; the other two
 * are only ever the far side of an edit.
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

    // The direction, from the repository's own rules rather than from this file's opinion: the
    // assertion's words are untouched and its method steps UP the ladder, so nothing about this
    // criterion got easier and the edit may take effect where it is made. Were those rules ever to
    // call it `WEAKENING`, `update` would hold it and move nothing, and the readings below would
    // fail as statements about the confirmation when what changed is the classification — so that
    // change fails here, as itself.
    assert.equal(
      classifyCriteriaEdit(
        [
          { id: first.definitionId, text: FIRST, verificationMethod: METHOD },
          { id: second.definitionId, text: SECOND, verificationMethod: METHOD },
        ],
        [
          { id: first.definitionId, text: FIRST, verificationMethod: STRICTER },
          { id: second.definitionId, text: SECOND, verificationMethod: METHOD },
        ],
      ),
      'ADDITIVE',
    );

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
      // owner's side there is nothing left to do. A step up the ladder rather than a rewording,
      // for the reason the constants above give, and asserted to be one rather than described as
      // one: an edit classified `WEAKENING` is held rather than applied, and this case would then
      // be reading a column nothing had moved.
      assert.equal(
        classifyCriteriaEdit(
          [
            { id: first.definitionId, text: FIRST, verificationMethod: STRICTER },
            { id: second.definitionId, text: SECOND, verificationMethod: METHOD },
          ],
          [
            { id: first.definitionId, text: FIRST, verificationMethod: STRICTEST },
            { id: second.definitionId, text: SECOND, verificationMethod: METHOD },
          ],
        ),
        'ADDITIVE',
      );
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
          + 'declared the tightened criterion declared a revision that is no longer the one it '
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

/** What `update` hands back instead of applying an edit whose direction cannot be read. */
interface HeldEdit {
  intentId: string;
  baselineSeal: string;
}

/** The two criteria of the second timeline: the one its own evidence rewrites, and the one that is
 *  only there so the readings below are about a criterion and not about the whole project. */
const MARKED = 'the work whose own session moved the ruler it is measured by';
const CONTROL = 'the work whose ruler nobody who ran it touched';

/**
 * The FIFTH clause, which the timeline above cannot reach.
 *
 * WHY A SECOND TIMELINE RATHER THAN MORE STEPS ON THE FIRST
 * ---------------------------------------------------------
 * Every criterion in the fixture above is authored through the owner's own door, and that is not
 * an accident of how it was written — it is what makes those ten readings statements about
 * satisfaction, landing and the confirmation and about nothing else. To pose §6's question a
 * criterion has to be REWORDED by one of the very sessions running its work, and a rewording is
 * not something a timeline can step back out of: it advances a revision, strands the confirmation,
 * and leaves an authorship row that every later reading would then be carrying. So this is its own
 * project, whose criteria are stated, met, landed and confirmed exactly as the first one's are,
 * and which is then walked into the one state the first cannot enter.
 *
 * WHAT IS ASSERTED HERE THAT THE §6 SPEC DOES NOT ASSERT
 * ------------------------------------------------------
 * `criteria-settlement-independence.pg.spec.ts` is where the clause's own meaning lives — the
 * equality between two committed session ids, the conflicts it names, the repair it offers. What
 * it never shows is this clause STANDING BESIDE THE OTHERS, because every reading it takes has the
 * fifth clause alone. This file is the one that pins the SET of clauses and their ORDER, and
 * `withheld` is an ordered array a reader is shown in the order it arrives. So the two cases below
 * are about POSITION, not about independence:
 *
 *   (6) the clause appears in the middle of the two the same edit raises
 *   (7) the landing clause joins them, making four — and then all four are walked back to green
 *       one at a time, until this one is the whole of what withholds DONE
 *
 * Four is the most that can ever hold together, and the fifth of the five is the reason: a project
 * that states no criteria has none to be unsatisfied, none to be unlanded and none for anybody to
 * have authored, so `NO_CRITERIA_STATED` excludes the three work-side clauses rather than joining
 * them. Between them the two readings order all four against each other.
 *
 * WHY THE REWORD TAKES A DETOUR
 * -----------------------------
 * `classifyCriteriaEdit` cannot read the direction of prose, so a reword comes out `WEAKENING` and
 * `update` holds it as a proposal instead of applying it. A fixture that ignored the hold would
 * leave the criterion at revision 1 authored by the owner, and would be asserting nothing at all —
 * so `state()` below answers its own proposal, standing in for the account owner. That detour does
 * not move the author: `decideCriteriaChange` records the intent row's own principal, which is the
 * acting session that proposed it, and not the owner who let it through.
 */
test('the clause for a criterion its own evidence wrote takes its place in order among the rest', {
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
  /** The router both post-commit edges are held behind; the first timeline says why a stand-in
   *  that answers with nothing is what a fixture building these services directly needs. */
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
      email: `authored-${ownerId}@project-done.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose ruler one of its own runners moved' },
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

  /** What the projection says today, and — when it is not DONE — every clause holding it back, in
   *  the order the derivation pushes them. */
  async function withheld(): Promise<DerivedDoneWithheld[]> {
    return (await readDerivedProjectDone(prisma as unknown as PrismaService, ownerId, projectId))
      .withheld;
  }

  /**
   * A conversation, as `sessions.create` writes one.
   *
   * `taskId` is what makes it the session that PRODUCED that task's evidence, and `USER` is the
   * origin every ordinary agent run carries — deliberately not the judgment origin, because the
   * identity gate is precisely what cannot see anything wrong with the edit in (6).
   */
  async function session(title: string, branch: string, taskId: string): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        title,
        prompt: 'do the work',
        provider: 'claude',
        status: RunStatus.SUCCEEDED,
        branch,
        isolationStatus: 'worktree',
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    return id;
  }

  /** Restate the whole collection through the runner door, from the named session, and see the
   *  edit through to the definitions whatever route it has to take: a reword is held as a
   *  proposal, and this answers it with the proposal's own one-time key, standing in for the
   *  account owner — who is the only principal that door accepts. */
  async function state(items: Array<{ id: string; text: string }>, actingSessionId: string) {
    const result = await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        id: item.id,
        text: item.text,
        verificationMethod: METHOD,
      })),
    } as never, actingSessionId) as { acceptanceCriteriaHold?: HeldEdit };
    const held = result.acceptanceCriteriaHold;
    if (!held) return;

    const { rows: [proposal] } = await sql.query<{ commit_token: string }>(
      `SELECT "commit_token" FROM "project_ratified_action_intent" WHERE "id" = $1::uuid`,
      [held.intentId],
    );
    assert.ok(proposal, 'a held edit files a proposal row this test can answer');
    const decided = await projects.decideCriteriaChange(ownerId, projectId, held.intentId, {
      decision: 'APPROVE',
      commitToken: proposal.commit_token,
      // The seal the proposal was composed against, which is still the one that stands: nothing
      // has edited these criteria between the hold and this line.
      baseSeal: held.baselineSeal,
    } as never);
    assert.equal(decided.applied, true, 'the owner approved it, so the edit is in force');
  }

  const DECLARATION = {
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  };

  /** Settle an EXECUTABLE task the way `runnerApi.turnComplete` settles one, through 0193/0230's
   *  BEFORE UPDATE fence. */
  async function settle(taskId: string) {
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

  /** A merge of that session's branch into the default branch: the landing lane's whole input. */
  async function landOnMain(sessionId: string, nibble: string) {
    return receipts.record(ownerId, sessionId, {
      result: 'MERGED',
      sourceSha: sha(nibble),
      targetBranch: 'main',
      targetShaBefore: sha('a'),
      targetShaAfter: sha('b'),
    }, 'AGENT');
  }

  /** The owner confirms the version of the criteria that stands as this line runs. */
  async function confirmWhatStands() {
    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    await acceptance.confirmStandardSet(ownerId, projectId, {
      criteriaDigest: standing.currentVersion.digest,
    });
  }

  // ── the starting position: two criteria, met, landed, and confirmed by their owner ─────────────
  //
  // Both authored through the owner's own door, which is the one authorship that is never a
  // conflict of interest — so this project reaches DONE with the fifth clause silent, and that
  // DONE is what makes the OPEN readings below statements about what took it away.

  const [marked, control] = criteriaFromDefinitions(
    (await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [MARKED, CONTROL].map((text) => ({
        text, verificationMethod: METHOD,
      })),
    } as never)).acceptanceCriteriaItems,
  );
  assert.ok(marked && control, 'the fixture states two criteria');

  const markedWork = await tasks.create(ownerId, {
    title: 'the work filed against the criterion its own session rewrote',
    projectId, criterionKey: marked.key, ...DECLARATION,
  } as never);
  const controlWork = await tasks.create(ownerId, {
    title: 'the work filed against the sibling criterion',
    projectId, criterionKey: control.key, ...DECLARATION,
  } as never);

  const authorAndRunner = await session(
    'the conversation that ran the work AND rewrote the criterion', 'orbit/marked', markedWork.id,
  );
  const otherRunner = await session(
    'the conversation that only ran its work', 'orbit/control', controlWork.id,
  );

  await settle(markedWork.id);
  await settle(controlWork.id);
  await landOnMain(authorAndRunner, '1');
  await landOnMain(otherRunner, '2');
  await confirmWhatStands();

  // ═══ (6) the clause appears in the middle of the two the same edit raises ═════════════════════

  await t.test('(6) the clause arrives in the middle of the ones the same edit raises', async () => {
    // The positive control, over the same rows: without it, every OPEN below would be equally true
    // of a column that already said OPEN and of an implementation that projects nothing at all.
    assert.equal(await storedStatus(), ProjectStatus.DONE,
      'this timeline has to start from a column that DOES say DONE');
    assert.deepEqual(await withheld(), [],
      'and from a projection with nothing outstanding, so that whatever appears below appeared '
        + 'here');

    // The abuse §6 is about, through the ordinary door with the ordinary origin: the session that
    // ran `markedWork` rewrites the criterion `markedWork` is measured by.
    await state([
      { id: marked.definitionId, text: `${MARKED}, as its own session would have it` },
      { id: control.definitionId, text: CONTROL },
    ], authorAndRunner);

    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'a criterion its own evidence wrote does not count, and a project cannot settle against a '
        + 'standard set smaller than the one its owner confirmed');
    assert.deepEqual(await withheld(), [
      'CRITERION_UNSATISFIED',
      'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE',
      'STANDARD_SET_UNCONFIRMED',
    ], 'three clauses on the one edit, and the new one is in the MIDDLE of them: the rewrite '
      + 'advanced the revision, so the declaration filed against the older wording is stale and '
      + 'the confirmation on record names a version that no longer stands — while the clause this '
      + 'case is about sits where the derivation pushes it, after the two work-side clauses and '
      + 'before the owner’s');
  });

  // ═══ (7) the landing clause joins them, and then all four walk back to green ══════════════════

  await t.test('(7) it follows CRITERION_UNLANDED, and is the last clause left standing', async () => {
    // The one clause (6) is missing, and the last one that can join it: a new piece of work under
    // the OTHER criterion, settled by nobody and landed nowhere. `NO_CRITERIA_STATED` cannot make
    // a fifth — a project that states no criteria has none to be unsatisfied, none to be unlanded
    // and none for anybody to have authored — so four is the whole of what this array can hold at
    // once, and this reading is the widest one there is.
    const late = await tasks.create(ownerId, {
      title: 'the work that arrives after the criteria were confirmed',
      projectId, criterionKey: control.key, ...DECLARATION,
    } as never);
    const lateRunner = await session(
      'the conversation running the late work', 'orbit/late', late.id,
    );

    assert.deepEqual(await withheld(), [
      'CRITERION_UNSATISFIED',
      'CRITERION_UNLANDED',
      'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE',
      'STANDARD_SET_UNCONFIRMED',
    ], 'every clause that can hold together, holding together — and `withheld` is an ORDERED '
      + 'array a reader is shown in the order it arrives, so this is what pins the clause BETWEEN '
      + 'CRITERION_UNLANDED and STANDARD_SET_UNCONFIRMED rather than merely present somewhere');

    // ── and back to green from there, one variable at a time ──────────────────────────────────
    // Each step moves exactly ONE of the four, so the shrinking list is evidence about the clause
    // that left rather than about a fixture that was rebuilt between readings.
    await settle(late.id);
    await landOnMain(lateRunner, '3');
    assert.deepEqual(await withheld(), [
      'CRITERION_UNSATISFIED',
      'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE',
      'STANDARD_SET_UNCONFIRMED',
    ], 'the late work settled and landed together, so the landing clause goes while the '
      + 'satisfaction clause stays: the declaration the rewrite stranded is a different fact');

    // The ordinary repair for a declaration a rewrite left behind — re-sending the same key is how
    // a task's revision is brought up to date — so staleness is not what the readings below are
    // measuring.
    await tasks.update(ownerId, markedWork.id, { criterionKey: marked.key } as never);
    assert.deepEqual(await withheld(), [
      'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE',
      'STANDARD_SET_UNCONFIRMED',
    ], 'and the work side is whole again: every criterion is satisfied and every one has landed, '
      + 'so what is left is the owner’s half of the conjunction and the clause this case is about');

    // The owner's half, over the ruler as it reads today: the one edge left.
    await confirmWhatStands();

    assert.deepEqual(await withheld(), ['CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE'],
      'the other four are green and this one is the whole of what withholds DONE — there are '
        + 'criteria, they are all satisfied, they have all landed, and the owner has confirmed '
        + 'the version that stands');
    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'and the column follows it: the confirmation is a post-commit edge this projection rides — '
        + 'the same edge that settled this project at the top of the file — so the projection ran '
        + 'here and declined to settle, which is a different fact from a column nothing touched');
  });
});
