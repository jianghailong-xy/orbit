/**
 * The second conjunct of settlement: a criterion written by the very session that produces its
 * evidence does not count, and a project cannot settle while one of its criteria does not count.
 *
 * WHAT THIS REPLACES
 * ------------------
 * "The person being examined must not write their own exam" used to be expressed as an identity
 * gate — `refuseHumanOnlyAction` refuses a criteria edit from
 * `session.dispatch_origin = 'PROJECT_COORDINATOR'` and passes everything else as NON_JUDGMENT.
 * That gate cannot decide this question and its own header says so: NON_JUDGMENT "is expressly not
 * evidence that a human held the authenticated credential". Every ordinary agent session — the
 * ones that do the work — is NON_JUDGMENT too, so the session in `(1)` below walks straight
 * through it.
 *
 * "Are these two session ids the same?" is a question the database can answer, and this file is
 * that answer end to end: migration 0251's `project_criteria_authorship` on one side,
 * `session.task_id` on the other, and `readDerivedProjectDone` folding the equality into the
 * projection of `project.status`.
 *
 * WHY ONE TIMELINE AND NOT TWO FIXTURES
 * -------------------------------------
 * The two halves are the same project, the same criteria, the same tasks and the same
 * confirmation. Between the reading in `(1)` and the reading in `(2)` exactly ONE thing changes:
 * WHICH CONVERSATION RAN THE WORK. Two independently built fixtures could each be wrong in their
 * own way and still disagree in the expected direction; one timeline with one variable moved
 * cannot.
 *
 * The same principle inside a single reading. `(1)` asserts about TWO criteria at once: the one
 * whose author also ran its work, and a sibling in the same project, confirmed under the same
 * seal, landed on the same branch, whose work was run by somebody else. A lane that marked
 * everything would pass a spec that only looked at the first one.
 *
 * WHY EVERYTHING ELSE IS MADE TO HOLD FIRST
 * -----------------------------------------
 * `(1)` asserts `satisfied`, `LANDED` and `CONFIRMED` about the very criterion it then says is
 * withheld. Without that, "the project is not DONE" would be evidence about whichever clause
 * happened to be outstanding, and this file would go green on a fixture that never reached the
 * question.
 *
 * WHY A `.pg.spec`
 * ----------------
 * Every fact is produced the way the product produces it: criteria are stated through
 * `ProjectsService.update` — which is also the door the conflicted session edits them through, and
 * the only thing that advances a definition's revision, in a trigger — declarations are brought
 * current through `TasksService.update`, tasks reach DONE through 0193/0230's BEFORE UPDATE fence,
 * receipts are written by `MergeReceiptService`, and the confirmation through
 * `ProjectAcceptanceService`. The projection is never called to move the column; it rides the
 * post-commit edges production runs it on, and `project.status` is read back with SQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-settlement-independence.pg.spec.ts
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
import type { CompletionInputRouter } from './completion-input-router.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { criterionIndependenceRemedy } from './project-criterion-independence';
import {
  readDerivedProjectDone,
  type DerivedDoneCriterion,
  type DerivedProjectDone,
} from './project-done-derived';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

/** A full 40-hex object name, which is the only kind a receipt accepts. */
const sha = (nibble: string) => nibble.repeat(40);

/** What `update` hands back instead of applying an edit whose direction cannot be read. */
interface HeldEdit {
  intentId: string;
  baselineSeal: string;
}

const MARKED = 'the work whose own session moved the ruler it is measured by';
const CONTROL = 'the work whose ruler was moved by somebody else';

test('a criterion written by the session producing its evidence does not count, and says so', {
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
   * The completion-input router both post-commit edges are held behind. A stand-in that answers
   * with nothing: what a settled project wakes is another unit's question, and what this is here
   * for is the `if (!this.completionInputs) return` guard those deliveries share — which is also
   * what would hold the projection off a fixture that left it out, leaving no way to reach the
   * column except by calling the projection, the one thing this file must not do.
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
      email: `independence-${ownerId}@settlement.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose ruler has authors' },
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

  /** The whole projection, as every caller of it sees it. */
  async function derived(): Promise<DerivedProjectDone> {
    return readDerivedProjectDone(prisma as unknown as PrismaService, ownerId, projectId);
  }

  /** One criterion's row in the projection — which must still BE there for a withheld criterion,
   *  because "does not count" implemented as a silent filter tells nobody anything. */
  function criterionOf(read: DerivedProjectDone, definitionId: string): DerivedDoneCriterion {
    const row = read.criteria.find((entry) => entry.definitionId === definitionId);
    assert.ok(row, 'a criterion that does not count is still one of the criteria this project '
      + 'states, and dropping it from the projection would settle the project against a shorter '
      + 'standard set than the one on record');
    return row;
  }

  /**
   * A conversation, as `sessions.create` writes one. `taskId` is what makes it the session that
   * PRODUCED a task's evidence, and `USER` is the origin every ordinary agent run carries —
   * deliberately not the judgment origin, because the whole point of `(1)` is that the identity
   * gate lets this session edit the criteria and cannot see anything wrong with it.
   */
  async function session(title: string, branch: string, taskId?: string): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        ...(taskId ? { taskId } : {}),
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

  /**
   * State the whole collection, through the runner door when a session is named — and see it
   * through to the definitions whatever route it has to take to get there.
   *
   * TWO ROUTES, ONE AUTHOR. An edit that plainly tightens the ruler lands where it is made. An
   * edit that REWORDS a criterion does not: `classifyCriteriaEdit` cannot read the direction of
   * prose, so it comes out `WEAKENING`, is held as a proposal, and reaches the definitions only
   * once the account owner approves it. A rewording is exactly what this file has to perform —
   * §6 asks "did the session producing this evidence write the criterion", and a fixture that
   * could not reword anything could never pose the question — so this helper answers the proposal
   * it just filed, standing in for the owner: it reads the proposal's own one-time key out of the
   * table (the proposer never receives it, by construction) and posts it back with no acting
   * session, which is the only credential that door accepts.
   *
   * That detour does NOT move the author, and the equality this file asserts is unharmed by it:
   * `decideCriteriaChange` records the PROPOSER — the intent row's own `principal_id`, which is
   * `actingSessionId` — and not the owner who let it through. Permitting a version somebody else
   * composed is not writing one. So both routes record the same session, and every assertion below
   * is a statement about that session rather than about which route the edit happened to take.
   */
  async function state(
    items: Array<{ id?: string; text: string }>,
    actingSessionId?: string,
  ): Promise<void> {
    const result = await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
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

  const EXECUTABLE_DECLARATION = {
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  };

  /** Settle an EXECUTABLE task the way `runnerApi.turnComplete` does: a compare-and-set repeating
   *  the declaration in its WHERE clause, through 0193/0230's BEFORE UPDATE fence. */
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

  /** A merge of that session's branch into the default branch — the landing lane's whole input,
   *  and a post-commit edge the projection rides. */
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
   * The ruler and its authors, read straight out of the two relations.
   *
   * Taken either side of the change in `(2)` so that "the only thing that moved is who ran the
   * work" is an assertion. Without it, a DONE afterwards would be equally true of an
   * implementation that quietly rewrote the authorship row, or the criterion, to get there — and
   * rewriting the criterion after its evidence is the one repair the seal exists to refuse.
   */
  async function rulerFingerprint(): Promise<Array<Record<string, string>>> {
    const { rows } = await sql.query<Record<string, string>>(
      `SELECT d."id"::text, d."revision"::text, d."text", d."content_hash",
              a."authored_by_session_id"::text AS author, a."authored_by_type" AS author_type
         FROM "project_acceptance_criterion_definition" d
         LEFT JOIN "project_criteria_authorship" a
                ON a."definition_id" = d."id" AND a."revision" = d."revision"
        WHERE d."project_id" = $1::uuid ORDER BY d."ordinal"`,
      [projectId],
    );
    return rows;
  }

  // ── the starting position ──────────────────────────────────────────────────────────────────────
  //
  // The owner states both criteria, so both start out authored through the owner's own door. Then
  // the work is filed, the conversations that run it are opened, and ONE of those conversations
  // rewrites the criterion it is about to be measured by. That is the whole abuse §6 is about, and
  // it is performed here through the ordinary door with the ordinary origin.

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
    projectId, criterionKey: marked.key, ...EXECUTABLE_DECLARATION,
  } as never);
  const controlWork = await tasks.create(ownerId, {
    title: 'the work filed against the sibling criterion',
    projectId, criterionKey: control.key, ...EXECUTABLE_DECLARATION,
  } as never);

  const authorAndRunner = await session(
    'the conversation that ran the work AND rewrote the criterion', 'orbit/marked', markedWork.id,
  );
  const otherRunner = await session(
    'the conversation that only ran its work', 'orbit/control', controlWork.id,
  );

  // The edit, from the session that is running `markedWork`. `refuseHumanOnlyAction` sees a
  // NON_JUDGMENT principal and permits it — as it must, since refusing every agent edit is not
  // what this rule says — and 0251 records the session against the version this write creates.
  // A reword is `WEAKENING`, so it travels the held route and the owner approves it; `state()`
  // above says why that changes nothing about WHO the recorded author is.
  await state([
    { id: marked.definitionId, text: `${MARKED}, as its own session would have it` },
    { id: control.definitionId, text: CONTROL },
  ], authorAndRunner);

  // The rewrite advanced the marked criterion's revision, which is what makes the declaration
  // filed against the older wording stale. Re-sending the same key is how that is brought current
  // — the ordinary repair, so that staleness is not what `(1)` is measuring.
  await tasks.update(ownerId, markedWork.id, { criterionKey: marked.key } as never);

  await settleExecutable(markedWork.id);
  await settleExecutable(controlWork.id);
  await landOnMain(authorAndRunner, '1');
  await landOnMain(otherRunner, '2');

  // ═══ (1) the criterion its own evidence wrote does not count, and the project does not settle ══

  await t.test('(1) a criterion authored by the session producing its evidence withholds DONE', async () => {
    // Before the confirmation, so that what the confirmation removes from this list is visible and
    // what it does not remove is the subject. Without this reading, the one below would be equally
    // true of a projection that never re-read anything.
    assert.deepEqual((await derived()).withheld,
      ['CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE', 'STANDARD_SET_UNCONFIRMED'],
      'the work side holds completely, so the only two clauses outstanding are the owner’s '
        + 'confirmation and the conflict this file is about');

    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    await acceptance.confirmStandardSet(ownerId, projectId, {
      criteriaDigest: standing.currentVersion.digest,
    });

    const read = await derived();
    assert.equal(read.confirmation, 'CONFIRMED',
      'the owner has confirmed the version of the criteria that stands today');
    assert.deepEqual(read.withheld, ['CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE'],
      'and with the confirmation on record the conflict is the ONLY thing left — so everything '
        + 'below is a statement about it and not about whichever clause happened to be missing');
    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'the column may not say DONE: one of the criteria this project states does not count, and '
        + 'a project settled against the rest of them would be settled against a standard set '
        + 'nobody confirmed');

    // ── the withheld criterion, and its sibling, in the same reading ──────────────────────────
    const withheldRow = criterionOf(read, marked.definitionId);
    assert.equal(withheldRow.satisfied, true,
      'its work has settled by its own declared criterion — so `satisfied` is not what is '
        + 'withholding it');
    assert.equal(withheldRow.landing, 'LANDED',
      'and its branch is on the default branch — so the landing lane is not what is withholding '
        + 'it either');
    assert.equal(withheldRow.independence, 'AUTHORED_BY_ITS_OWN_EVIDENCE',
      'what is withholding it is that the conversation which wrote the version standing today is '
        + 'the conversation whose work is being counted as evidence for it');
    assert.deepEqual(withheldRow.conflicts, [{
      sessionId: authorAndRunner,
      taskId: markedWork.id,
      taskTitle: 'the work filed against the criterion its own session rewrote',
    }], 'and it names both sides of the equality: a reader who is told a criterion does not count '
      + 'has to be able to go and look at the conversation and the work that collide');

    // The repair, quoted from the one place it is stated rather than retyped here.
    assert.deepEqual(withheldRow.remedy, criterionIndependenceRemedy());
    assert.match(criterionIndependenceRemedy().requiredAction, /^ASSIGN_AN_INDEPENDENT_VERIFICATION_TASK$/);
    assert.match(criterionIndependenceRemedy().instruction, /VERIFICATION task/,
      'the instruction has to name the thing to file, because a withheld criterion with no '
        + 'available repair is a project that can never settle');

    // ── the paired positive control, in the SAME reading and under the same seal ───────────────
    const cleanRow = criterionOf(read, control.definitionId);
    assert.equal(cleanRow.independence, 'INDEPENDENT',
      'the sibling criterion was rewritten by that same session and is served by work that '
        + 'session did not run — the comparison is per criterion, so moving somebody ELSE’s ruler '
        + 'is not marking your own homework');
    assert.deepEqual(cleanRow.conflicts, []);
    assert.equal(cleanRow.remedy, null,
      'a criterion that already counts is offered no repair, or every criterion would arrive '
        + 'carrying advice about a problem it does not have');
  });

  // ═══ (2) the same read, with the evidence produced by another conversation → DONE ═════════════

  await t.test('(2) hand the work to another conversation and the same read settles the project', async () => {
    const before = await rulerFingerprint();
    assert.equal(await storedStatus(), ProjectStatus.OPEN,
      'this case has to start from a column that does NOT say DONE, or nothing after it is a '
        + 'statement about what moved it');

    // The one variable. `session.task_id` IS what "produced this criterion's evidence" means, so
    // the run that produced it is detached and the work is handed to a conversation that did not
    // write the criterion. The receipt the first session recorded keeps its own `task_id` —
    // denormalized at write time — so the landing lane reads exactly as it read a moment ago.
    const detached = await sql.query(
      `UPDATE "session" SET "task_id" = NULL WHERE "id" = $1::uuid AND "task_id" = $2::uuid`,
      [authorAndRunner, markedWork.id],
    );
    assert.equal(detached.rowCount, 1, 'the conflicted run must have been the one detached');
    const independentRunner = await session(
      'the conversation that re-ran the work and wrote none of the criteria',
      'orbit/marked-again', markedWork.id,
    );

    // Its merge, through the door production records one through — and the post-commit edge that
    // re-projects the column. No task write, no confirmation, no call to the projection.
    const recorded = await landOnMain(independentRunner, '3');
    assert.equal(recorded.created, true,
      'the door recorded no new receipt, so nothing below is a statement about one');

    const read = await derived();
    assert.deepEqual(read.withheld, [],
      'nothing is outstanding any more: the criterion is met, landed, confirmed — and now also '
        + 'measured by evidence its author did not produce');
    assert.equal(await storedStatus(), ProjectStatus.DONE,
      'so the column says so, and it says so because one conversation was replaced by another: '
        + 'the same rows that withheld DONE in (1) settle it here');

    const repaired = criterionOf(read, marked.definitionId);
    assert.equal(repaired.independence, 'INDEPENDENT');
    assert.deepEqual(repaired.conflicts, []);
    assert.equal(repaired.remedy, null);
    assert.equal(criterionOf(read, control.definitionId).independence, 'INDEPENDENT',
      'and the sibling never moved, in either direction');

    assert.deepEqual(await rulerFingerprint(), before,
      'the criteria and their recorded authors are byte for byte what they were in (1): this '
        + 'project was NOT settled by rewriting the criterion after its evidence, which is the '
        + 'repair the standard-set seal exists to refuse, but by the work being measured by '
        + 'somebody the author is not');
  });
});
