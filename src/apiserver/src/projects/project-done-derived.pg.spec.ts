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
 * WHY A `.pg.spec`
 * ----------------
 * Every fact is produced the way the product produces it. Criteria are stated through
 * `ProjectsService.update` (the only thing that advances a definition's revision, in a trigger);
 * the confirmation is written through `ProjectAcceptanceService.confirmStandardSet`, r3's one
 * writer; serving tasks reach DONE through 0193/0230's BEFORE UPDATE fence; receipts are written
 * by `MergeReceiptService`. The projection is never invoked directly — it is driven only from the
 * two production edges that carry it, so a green here is evidence that those edges carry it.
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
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone, type DerivedDoneWithheld } from './project-done-derived';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

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
  const receipts = new MergeReceiptService(prisma as unknown as PrismaService);
  /**
   * A `TasksService` with a completion-input router present.
   *
   * The router is a stand-in and its one method answers with nothing, because what a settled
   * project WAKES is a different unit's question and is covered where that unit is tested. What it
   * is here for is the guard those deliveries share — `if (!this.completionInputs) return` — which
   * is also what holds the projection off the ~40 fixtures that build this service directly. A
   * spec that left it out would exercise no post-commit edge at all and could then only reach the
   * projection by calling it, which is the one thing this file must not do.
   */
  const tasks = new TasksService(
    prisma as never,
    {} as never,
    { publishTaskChanged() {}, publishForUser() {}, publishTaskResync() {} } as never,
    undefined,
    {
      routeSettledProjects: async () => [],
      routeReadyCriteria: async () => [],
      routeUnlandedCriteria: async () => [],
      routeTaskExceptions: async () => [],
    } as never,
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

  /** A merge of that session's branch into the default branch: the landing lane's whole input. */
  async function landOnMain(sessionId: string, nibble: string) {
    await receipts.record(ownerId, sessionId, {
      result: 'MERGED',
      sourceSha: sha(nibble),
      targetBranch: 'main',
      targetShaBefore: sha('a'),
      targetShaAfter: sha('b'),
    }, 'AGENT');
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
        { id: first.definitionId, text: `${FIRST}, and says which version it read`, verificationMethod: METHOD },
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
