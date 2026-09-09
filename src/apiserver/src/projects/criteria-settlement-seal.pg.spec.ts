/**
 * The fourth clause of the settlement conjunction: DONE is withheld until the account owner has
 * confirmed THE VERSION OF THE CRITERIA THAT STANDS — and a tightening edit moves that version, so
 * the confirmation the project settled under does not come along with it.
 *
 * WHAT IS ALREADY HERE, AND WHAT THIS FILE IS FOR
 * -----------------------------------------------
 * The machine is not new. `deriveProjectDone` has read `standardSetConfirmationStanding` since
 * 2026-09-08, and `project-done-derived.pg.spec.ts` already shows an unconfirmed project staying
 * OPEN and a confirmed one settling. What that file does NOT pin is the direction of an edit: the
 * one it makes is a REWORDING, which `classifyCriteriaEdit` calls `WEAKENING`, and a weakening edit
 * is on its way to not taking effect at all. The case this file exists for is the other one — the
 * edit that DOES take effect where it is made, and what it does to a confirmation already on
 * record.
 *
 * THE PROPOSITION
 * ---------------
 * A tightening re-seals. Not "the old confirmation carries over because nothing got easier": the
 * seal is `criteriaSemanticRevision` over the live rows, the trigger advances `revision` and
 * rewrites `content_hash` when the verification method moves, so the version the owner approved is
 * simply no longer the version that stands. Their confirmation goes STALE and has to be given
 * again. That costs a click, and the alternative costs an owner a standard set they never read
 * being counted as one they approved.
 *
 * WHY THE NEGATIVE IS PAIRED, TWICE
 * ---------------------------------
 * "Unconfirmed, therefore not DONE" is an assertion about something not happening, and a project
 * that was never going to settle satisfies it for free — an implementation with the clause deleted
 * would pass it just as well as this one, so on its own it is a green that means nothing. So every
 * withholding here stands next to a reading, over the SAME fixture rows, where DONE is actually
 * produced:
 *
 *   (A)  satisfied and landed, nobody has confirmed         → OPEN     ── the negative
 *   (B)  the owner confirms the version that stands         → DONE     ── the sibling that produces
 *   (C)  one TIGHTENING edit                                → OPEN     ── the negative that matters
 *   (C2) the same, with the work brought up to date         → OPEN     ── and the seal is why
 *   (D)  the owner confirms again, naming the new version   → DONE     ── the sibling that produces
 *
 * (D) is not decoration. Without it, (C) would be equally true of a rule that lets a tightening
 * settle the confirmation question permanently, and the difference between "re-confirm" and "this
 * project can never be DONE again" is the whole of what (C) claims.
 *
 * WHY THE EDIT IN (C) IS ASSERTED TO BE A TIGHTENING RATHER THAN DESCRIBED AS ONE
 * ------------------------------------------------------------------------------
 * `classifyCriteriaEdit` is the repository's own answer to which way an edit walks, and it is
 * called here on the two criterion shapes this case actually writes. If a later change to those
 * rules made this edit a `WEAKENING`, this file would be quietly testing the case it was written
 * to avoid, and the assertion is what makes that a failure instead of a silent change of subject.
 * On the criterion shape 0233 left behind, the tightening available is a step UP the
 * HUMAN → VERIFICATION → EXECUTABLE ladder with the assertion's text untouched — which is also why
 * this fixture is a single criterion whose `verificationMethod` moves and whose `text` never does.
 *
 * WHY THE WITHHELD LIST IS ASSERTED EXACTLY, AND WHY THE WORK RE-DECLARES FIRST
 * ----------------------------------------------------------------------------
 * A tightening moves TWO things at once: the seal, and every serving task's `criterionRevision`
 * snapshot, which `readCriterionSatisfaction` folds into `DECLARATION_STALE`. A case that stopped
 * at "still OPEN" after the edit would be green on an implementation that ignored the seal
 * entirely, because the declaration clause alone holds DONE back. So (C2) does the thing that
 * discharges the other clause — the serving task re-declares the same criterion key, which is how
 * work brought up to date against a moved ruler is recorded — and then asserts the withheld list is
 * exactly `['STANDARD_SET_UNCONFIRMED']`. Every other clause of the conjunction holds. The one
 * thing between this project and DONE is a confirmation of the ruler as it now reads.
 *
 * That isolating assertion is a case of its own rather than the fourth line of (C), and the split
 * is what makes it evidence: behind three earlier assertions it would never be REACHED under a
 * mutation of the seal — the case would already have failed — so it could be a line that never
 * ran and nobody would learn it. First in its own case, it is the line that goes red.
 *
 * WHY THE REPLAY IS REFUSED
 * -------------------------
 * (D) first offers the digest the owner confirmed in (B) and is refused
 * `PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED`. "The old confirmation does not carry over" is a
 * statement about the read side; this is the same statement on the write side, and together they
 * say a caller cannot get the carry-over by replaying the version it remembers.
 *
 * WHY A `.pg.spec`
 * ----------------
 * Every fact is produced the way the product produces it, and the projection is never called to
 * make something happen. The criteria are stated and EDITED through `ProjectsService.update`, the
 * only writer that advances a definition's revision — in a trigger, which is why the seal cannot be
 * computed in TypeScript from a DTO. The confirmation is written through
 * `ProjectAcceptanceService.confirmStandardSet`, its one writer. The serving task settles through
 * 0193/0230's BEFORE UPDATE fence and lands through `MergeReceiptService`. `readDerivedProjectDone`
 * appears only where this file asks what is outstanding; what moved the column is always an edge.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-settlement-seal.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ProjectStatus, RunStatus, type PrismaClient } from '@prisma/client';
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

/** The one assertion this project states. It never changes: an edit to it would be a rewording,
 *  which is the WEAKENING case this file is deliberately not about. */
const CRITERION = 'the settlement seal is confirmed by the owner before the project is DONE';

/** Two rungs of the HUMAN → VERIFICATION → EXECUTABLE ladder, weakest first. Moving from the first
 *  to the second is a step UP, and on today's criterion shape it is the tightening available. */
const LOOSER_METHOD = 'HUMAN';
const STRICTER_METHOD = 'EXECUTABLE';

/** A full 40-hex object name, which is the only kind a receipt accepts. */
const sha = (nibble: string) => nibble.repeat(40);

/** How a typed refusal reaches a caller through Nest's exception response. */
interface RefusalBody { code?: string; currentDigest?: string; message?: string }

test('a tightening re-seals the standard set, so the confirmation it was settled under is spent', {
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
   * The completion-input router every post-commit edge is held behind: `if (!this.completionInputs)
   * return`. Supplying a stand-in is what lets a fixture that builds these services directly reach
   * those edges at all — what a settled project WAKES is another unit's question, so the methods
   * answer with nothing. One object for the task writer and the receipt writer alike, because the
   * projection rides both and a fixture that wired only one would decide by omission which edges
   * this file is allowed to notice.
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
      email: `seal-${ownerId}@criteria-settlement.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose ruler may only tighten' },
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

  /** Every clause of the conjunction that does not hold, in clause order. */
  async function withheld(): Promise<DerivedDoneWithheld[]> {
    return (await readDerivedProjectDone(prisma as unknown as PrismaService, ownerId, projectId))
      .withheld;
  }

  /** The seal as it stands right now. Computed at read time from the live rows, never stored — so
   *  "the seal moved" is only ever provable by two readings taken either side of an edit. */
  async function seal(): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  }

  /** State the criteria through the one door that states them, and hand back the stored shape. */
  async function stateCriteria(items: Array<{ id?: string; verificationMethod: string }>) {
    const updated = await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id === undefined ? {} : { id: item.id }),
        text: CRITERION,
        verificationMethod: item.verificationMethod,
      })),
    } as never);
    return criteriaFromDefinitions(updated.acceptanceCriteriaItems);
  }

  /**
   * Settle an EXECUTABLE task the way `runnerApi.turnComplete` settles one: a compare-and-set that
   * repeats the declaration in its WHERE clause, through 0193/0230's BEFORE UPDATE fence.
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

  // ── the starting position: one criterion, its work settled and on main, nobody has confirmed ──

  const [stated] = await stateCriteria([{ verificationMethod: LOOSER_METHOD }]);
  assert.ok(stated, 'the fixture states one criterion');

  const work = await tasks.create(ownerId, {
    title: 'the work that serves the one criterion',
    projectId,
    criterionKey: stated.key,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  } as never);
  const workSessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: workSessionId,
      ownerId,
      creatorId: ownerId,
      taskId: work.id,
      title: 'ran orbit/seal',
      prompt: 'do the work',
      status: RunStatus.SUCCEEDED,
      branch: 'orbit/seal',
      isolationStatus: 'worktree',
    },
  });
  await settleExecutable(work.id);
  await receipts.record(ownerId, workSessionId, {
    result: 'MERGED',
    sourceSha: sha('1'),
    targetBranch: 'main',
    targetShaBefore: sha('a'),
    targetShaAfter: sha('b'),
  }, 'AGENT');

  // ═══ (A) the negative: everything the work can supply is in, and DONE is still withheld ═══════

  await t.test('(A) work that is settled and landed does not settle the project by itself', async () => {
    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'whether these conditions express the goal is the one act reserved to the account owner, '
        + 'and a projection that settled the project without it would be answering that question '
        + 'itself');
    assert.deepEqual(await withheld(), ['STANDARD_SET_UNCONFIRMED'],
      'and the confirmation is the ONLY clause outstanding — three of the four hold, so what (B) '
        + 'changes below is the one variable this pair is about');
  });

  // ═══ (B) the sibling that produces DONE, without which (A) is a green about nothing ═══════════

  const firstSeal = await seal();

  await t.test('(B) the owner confirms the version that stands, and the column becomes DONE', async () => {
    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(standing.state, 'UNCONFIRMED', 'nobody has confirmed anything yet');
    assert.equal(standing.currentVersion.digest, firstSeal);

    await acceptance.confirmStandardSet(ownerId, projectId, { criteriaDigest: firstSeal });

    assert.equal(await storedStatus(), ProjectStatus.DONE,
      'this fixture DOES reach DONE, which is what makes every withholding in this file a '
        + 'statement about a clause rather than about a project that was never going to settle');
    assert.deepEqual(await withheld(), []);
    assert.equal((await acceptance.standardSetConfirmation(ownerId, projectId)).state, 'CONFIRMED');
  });

  // ═══ (C) one tightening edit, and the confirmation it settled under is spent ══════════════════

  await t.test('(C) a tightening moves the seal, and the confirmation on record stops counting', async () => {
    // The direction, from the repository's own rules rather than from this file's opinion. Same
    // criterion, same assertion, and the predicate steps UP the ladder: nothing about it got
    // easier, so it is an edit that may take effect where it is made.
    assert.equal(
      classifyCriteriaEdit(
        [{ id: stated.definitionId, text: CRITERION, verificationMethod: LOOSER_METHOD }],
        [{ id: stated.definitionId, text: CRITERION, verificationMethod: STRICTER_METHOD }],
      ),
      'ADDITIVE',
      'the case this file is about is the edit that APPLIES; if these rules ever made this one a '
        + 'WEAKENING, everything below would be testing a different question',
    );

    // ── the edit, through the one door that states criteria ────────────────────────────────────
    const [retightened] = await stateCriteria([
      { id: stated.definitionId, verificationMethod: STRICTER_METHOD },
    ]);
    assert.equal(retightened?.definitionId, stated.definitionId,
      'the same criterion, tightened — not a new one, so the work still serves it and its merge '
        + 'receipt still lands it');

    const secondSeal = await seal();
    assert.notEqual(secondSeal, firstSeal,
      'the seal is a function of (definitionId, revision, contentHash) over the live rows, and '
        + 'the trigger moved both halves: the version the owner approved is not the version that '
        + 'stands');

    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(standing.state, 'STALE',
      'a tightening does not carry the confirmation forward — it is the ruler moving, and every '
        + 'move of the ruler is one the owner has to have seen');
    assert.equal(standing.confirmation?.criteriaDigest, firstSeal,
      'and STALE rather than gone: the row is still on record, still naming exactly the version '
        + 'that was approved, so what changed is which version stands and not what was said');

    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'the column may not go on asserting DONE against a standard set nobody has confirmed');
    assert.deepEqual(await withheld(), ['CRITERION_UNSATISFIED', 'STANDARD_SET_UNCONFIRMED'],
      'both halves moved on the one edit: the task declared a revision the criterion no longer '
        + 'carries, and the confirmation names a version that no longer stands');

  });

  // ═══ the half that makes (C) mean something: the seal ALONE holds DONE back ═══════════════════
  //
  // A case of its own, and its first assertion is the isolating one. Inside (C) that assertion sits
  // behind three others, so a mutation to the seal kills the case before ever reaching it and the
  // line could be dead weight without anybody noticing. Here it is reached first: the only writes
  // between (C) and this reading are the re-declaration below, and every clause of the conjunction
  // except the seal is discharged.

  await t.test('(C2) with the work brought up to date, the seal alone is what withholds DONE', async () => {
    // The work is brought up to date against the ruler as it now reads, which is how a declaration
    // made against a revision that has moved is recorded as current again. Without this step,
    // "still OPEN" would be just as true of an implementation that never looked at a confirmation.
    await tasks.update(ownerId, work.id, { criterionKey: stated.key } as never);

    assert.deepEqual(await withheld(), ['STANDARD_SET_UNCONFIRMED'],
      'every other clause of the conjunction holds — the criterion is stated, its work has settled '
        + 'by its own declared criterion against the revision that stands, and that work is on '
        + 'main. The ONE thing missing is a confirmation of the tightened ruler');
    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'so a project that was DONE is OPEN again, held there by the seal alone');
  });

  // ═══ (D) the second sibling: re-confirming is a new act, and it does settle the project ═══════

  await t.test('(D) the owner confirms the tightened set, and only that restores DONE', async () => {
    // The write side of the same sentence. A caller cannot recover the carry-over by replaying the
    // version it remembers: the digest that settled this project in (B) is refused by name.
    let refusal: RefusalBody | null = null;
    try {
      await acceptance.confirmStandardSet(ownerId, projectId, { criteriaDigest: firstSeal });
    } catch (error) {
      refusal = (error as { response?: RefusalBody }).response ?? null;
    }
    assert.equal(refusal?.code, 'PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED',
      'confirming the spent version is refused rather than accepted as a re-confirmation: a '
        + 'confirmation carried over an edit would say a person approved wording they never saw');
    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'and the refused request wrote nothing');

    const currentSeal = await seal();
    assert.equal(refusal?.currentDigest, currentSeal,
      'the refusal names the version that stands, so the caller can read that one and confirm it');

    await acceptance.confirmStandardSet(ownerId, projectId, { criteriaDigest: currentSeal });

    assert.equal(await storedStatus(), ProjectStatus.DONE,
      'a re-confirmation is what it costs, and it is a click: the alternative is an owner being '
        + 'recorded as having approved a standard set they never read');
    assert.deepEqual(await withheld(), [],
      'so the tightening never made this project unsettleable — it made it unsettled');
  });
});
