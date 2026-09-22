/**
 * `GET /projects/:id` on real PostgreSQL: "the work settled" and "the work is on main" are two
 * different facts, and the read serves both.
 *
 * WHAT THIS IS FOR
 * ----------------
 * An EXECUTABLE task reaches DONE because its declared command agreed with its declared exit code
 * — inside that task session's own worktree, on its own branch. That is a statement about work
 * having been done and no statement whatsoever about `main`. On 2026-09-04 the two came apart for
 * real: a criterion read `satisfied` while the migration implementing it did not exist on the
 * default branch. This spec is the case that keeps a reader from being handed that green light
 * with nothing beside it — `landing` says whether a merge receipt puts the work on the default
 * branch, and says UNKNOWN when nothing does.
 *
 * THE NEGATIVE THE UNIT WAS WRITTEN AROUND
 * ----------------------------------------
 * The first case below is that scenario exactly: two criteria whose serving work is DONE and for
 * which no merge receipt exists. It requires BOTH answers at once — `satisfied` true AND `landing`
 * UNKNOWN — because either one alone is the thing being fixed. A read that dropped the lane leaves
 * `landing` undefined and the case fails on the missing answer (which is why `StatedCriterion`
 * types it optional: typed as required, a projection that carried it nowhere would fail to
 * compile, and a compile error is not this file going red about the thing it is about).
 *
 * `UNKNOWN`, never `NOT_LANDED`. `session_merge` can land work without leaving a receipt behind,
 * so "no receipt" is absence of evidence; a boolean would have to read it as absence of the merge,
 * which is the same lie told in the other direction. Two cases here pin that: a receipt that
 * CONFLICTED, and a receipt that merged somewhere that is not the default branch, both of which
 * leave the answer UNKNOWN rather than turning it into a denial.
 *
 * Every fact is produced the way the product produces it: criteria through `ProjectsService.update`,
 * work through `TasksService.create`, DONE through the same compare-and-set `runnerApi.turnComplete`
 * performs against 0193/0230's fence, and receipts through `MergeReceiptService.record` — the door
 * an agent uses to record a merge it made itself, which is how this work actually lands.
 *
 * THE WORK THAT WAS NEVER GOING TO LAND
 * -------------------------------------
 * Cases 8–10 are about a criterion whose work includes a task that declares it needs no code — SR5's
 * escape hatch, which an acceptance task whose deliverable is evidence takes. On 2026-09-22 a project
 * of 48 finished tasks could not reach DONE because one such task held its criterion at
 * ON_INTEGRATION_LINE for ever: it has no commit of its own, so no receipt can ever put its work on
 * `main`, and the fold read that as "not there yet". §2.5 J9 already answers this question for the
 * other lane (a codeless prerequisite is not made to wait for a landing it can never have), and case
 * 8 is that answer arriving at the criterion. Case 9 is the guard that keeps it honest, and the two
 * differ by exactly one thing: the declaration. Everything else about their third task — the branch
 * it ran, the receipt that names the project line — is the same, and without the declaration the
 * criterion must go on withholding LANDED.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-get-criterion-landing\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
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
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

/** A full 40-hex object name, which is the only kind a receipt accepts. */
const sha = (nibble: string) => nibble.repeat(40);

/**
 * One criterion as the outward read states it, narrowed to what this spec reads.
 *
 * All three derived fields are OPTIONAL on purpose — see the header. `unmet` is restated here as
 * `{ clause: string }` rather than imported: this file never asks what a clause MEANS, only that
 * the lane below added none and removed none.
 */
interface StatedCriterion {
  id: string;
  text: string;
  satisfied?: boolean;
  unmet?: Array<{ clause: string }>;
  landing?: string;
}

test('GET /projects/:id says whether the work settled AND whether it landed, separately', {
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

  const projects = new ProjectsService(prisma as unknown as PrismaService,
    new ProjectAcceptanceService(prisma as unknown as PrismaService));
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  const receipts = new MergeReceiptService(prisma as unknown as PrismaService);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `landing-${ownerId}@criterion-landing.invalid`,
      name: 'Project detail',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose work may or may not be on main' },
  });
  // The project's own binding (§1.4). Its upstream is `main` and its line is a project branch,
  // which is the only shape in which a receipt can read ON_INTEGRATION_LINE at all: the legacy pair
  // is one branch named twice, so every criterion above is unaffected by this row — `main` is still
  // the upstream their receipts name.
  const PROJECT_LINE = `project/${projectId}`;
  await prisma.projectCodebase.create({
    data: {
      ownerId,
      projectId,
      canonicalRepoUrl: 'ssh://git@example.invalid/the-project',
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${PROJECT_LINE}`,
      refAuthority: 'REMOTE',
    },
  });

  /**
   * Settle an EXECUTABLE task exactly as `runnerApi.turnComplete` settles one: `status = 'DONE'`
   * as a compare-and-set that repeats the declaration in its WHERE clause, through 0193/0230's
   * BEFORE UPDATE fence — in a worktree, on a branch, saying nothing about `main`, which is the
   * whole reason this file exists.
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

  /** The read under test: the project detail, and its criteria in the order it states them. */
  async function detail(): Promise<StatedCriterion[]> {
    const read = await projects.get(ownerId, projectId) as unknown as {
      acceptanceCriteriaItems: StatedCriterion[];
    };
    return read.acceptanceCriteriaItems;
  }

  /** One criterion's three answers, all required to be there — a missing one is not a passing one. */
  function answerOf(items: StatedCriterion[], text: string) {
    const item = items.find((row) => row.text === text);
    assert.ok(item, `the project must still state “${text}”`);
    const { satisfied, unmet, landing } = item;
    if (satisfied === undefined || unmet === undefined || landing === undefined) {
      assert.fail(`the outward read carries no complete answer for “${text}”: `
        + `satisfied=${satisfied}, unmet=${unmet && 'present'}, landing=${landing}`);
    }
    return { satisfied, clauses: unmet.map((reason) => reason.clause), landing };
  }

  const SETTLED_AND_LANDS = 'the work for this one settled, and its branch reaches main';
  const SETTLED_ONLY = 'the work for this one settled, and nothing says where it went';
  const UNSETTLED_BUT_LANDS = 'the work for this one is on main and is still not finished';
  /** Case 8: finished work, one piece of which never had a commit of its own to land. */
  const NOTHING_TO_LAND = 'the work for this one settled, and one piece of it ran no branch';
  /** Case 9: the guard — the work carries commits, and only the project branch has them. */
  const ITS_OWN_WORK_ON_THE_LINE = 'the work for this one carries commits and only the line has them';
  /** Case 10: work that ran on branches, none of which landed anywhere. */
  const NEVER_LANDED = 'none of the work for this one has landed anywhere';

  const [landsAt, settledAt, unsettledAt, nothingToLandAt, onTheLineAt, neverLandedAt] =
    criteriaFromDefinitions(
      (await projects.update(ownerId, projectId, {
        acceptanceCriteriaItems: [
          SETTLED_AND_LANDS, SETTLED_ONLY, UNSETTLED_BUT_LANDS,
          NOTHING_TO_LAND, ITS_OWN_WORK_ON_THE_LINE, NEVER_LANDED,
        ].map((text) => ({ text, verificationMethod: METHOD })),
      } as never)).acceptanceCriteriaItems,
    );

  const EXECUTABLE_DECLARATION = {
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  };

  // Two criteria whose work is finished, in the state this whole unit is about: green, and nowhere.
  const landingTask = await tasks.create(ownerId, {
    title: 'the work that will be merged',
    projectId,
    criterionKey: landsAt.key,
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(landingTask.id);
  const landingSession = await sessionFor(landingTask.id, 'orbit/work-that-lands');

  const strandedTask = await tasks.create(ownerId, {
    title: 'the work that stays in its own worktree',
    projectId,
    criterionKey: settledAt.key,
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(strandedTask.id);
  const strandedSession = await sessionFor(strandedTask.id, 'orbit/work-that-strands');

  // And one whose branch lands while the work itself is not settled: VERIFICATION with no carrier
  // pointed at it. Landing and settling are independent, and this is the direction that proves it.
  // A work row (`MANUAL`) rather than a gate: what this fixture needs is a row whose criterion is
  // VERIFICATION and whose PASS does not exist, and `servingTaskSettled` reads the criterion — the
  // policy decides nothing here. A gate would additionally have to be filed with the very carrier
  // this case is about not having.
  const unsettledTask = await tasks.create(ownerId, {
    title: 'the work merged before anybody checked it',
    projectId,
    criterionKey: unsettledAt.key,
    completionCriterion: 'VERIFICATION',
  } as never);
  const unsettledSession = await sessionFor(unsettledTask.id, 'orbit/work-merged-unchecked');

  /**
   * One finished piece of code work: an EXECUTABLE task settled through the fence, and the worktree
   * session on its branch. Having run a branch is the whole of §1.1's second half — it is what says
   * a task carries commits of its own — so every task below that is meant to have some gets one.
   */
  async function finishedWork(title: string, criterionKey: string, branch: string) {
    const task = await tasks.create(ownerId, {
      title, projectId, criterionKey, ...EXECUTABLE_DECLARATION,
    } as never);
    await settleExecutable(task.id);
    return sessionFor(task.id, branch);
  }

  /** One receipt, through the door an agent records a merge it made itself with. */
  function mergeRecorded(
    sessionId: string,
    body: {
      result: string; sourceSha: string; targetBranch: string;
      targetShaBefore?: string; targetShaAfter?: string;
    },
  ) {
    return receipts.record(ownerId, sessionId, body as never, 'AGENT');
  }

  // ── 8. finished work, one piece of which had no commit of its own ──────────────────────────────
  // Two pieces reached main. The third is an acceptance task whose deliverable is evidence, declared
  // codeless — SR5's escape hatch, "this task needs no code, even though its project is bound to a
  // codebase". It resolves no SOURCE, so it has no branch, no commit of its own and no receipt; and
  // before this unit, no way to stop holding its criterion at ON_INTEGRATION_LINE for ever.
  //
  // The declaration is written on the row directly, which is how the product writes it today: the
  // column is declared by the schema and read by three lanes (source resolution, §2.5 J9's wait,
  // and the integration backfill), and no DTO carries it yet. `dependency-landed-on-integration-ref`
  // declares its codeless prerequisite the same way.
  for (const [nibble, branch] of [['b', 'orbit/nothing-to-land-1'], ['c', 'orbit/nothing-to-land-2']]) {
    const session = await finishedWork(`the part that reached main (${branch})`, nothingToLandAt.key, branch);
    await mergeRecorded(session, {
      result: 'MERGED', sourceSha: sha(nibble), targetBranch: 'main',
      targetShaBefore: sha('0'), targetShaAfter: sha(nibble),
    });
  }
  const evidenceOnlyTask = await tasks.create(ownerId, {
    title: 'the acceptance task that only produces evidence',
    projectId,
    criterionKey: nothingToLandAt.key,
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(evidenceOnlyTask.id);
  await prisma.task.update({
    where: { id: evidenceOnlyTask.id },
    data: { codeless: true },
  });

  // ── 9. the guard: the same two landed pieces, and a third whose commits are only on the line ───
  // The third ran a branch, so it has commits of its own, and its only receipt names the project's
  // own line — the shape the finished UI-acceptance task of 2026-09-22 actually has. It must go on
  // withholding LANDED: the read cannot tell a branch that carried nothing from one whose work is
  // on the line and not yet on main, and guessing is the false green this lane exists to break up.
  for (const [nibble, branch] of [['d', 'orbit/own-work-1'], ['e', 'orbit/own-work-2']]) {
    const session = await finishedWork(`the part that reached main (${branch})`, onTheLineAt.key, branch);
    await mergeRecorded(session, {
      result: 'MERGED', sourceSha: sha(nibble), targetBranch: 'main',
      targetShaBefore: sha('0'), targetShaAfter: sha(nibble),
    });
  }
  const ownWorkOnTheLine = await finishedWork(
    'the work whose commits are only on the project branch', onTheLineAt.key, 'orbit/own-work-on-the-line',
  );
  await mergeRecorded(ownWorkOnTheLine, {
    result: 'ALREADY_MERGED', sourceSha: sha('f'), targetBranch: PROJECT_LINE,
    targetShaBefore: sha('1'), targetShaAfter: sha('1'),
  });

  // ── 10. work that ran branches, and landed none of them ────────────────────────────────────────
  for (const branch of ['orbit/never-landed-1', 'orbit/never-landed-2', 'orbit/never-landed-3']) {
    await finishedWork(`the work that never landed (${branch})`, neverLandedAt.key, branch);
  }

  /** Every read this spec takes, so the invariant at the end is over all of them and not a rerun. */
  const satisfiedOverTime: boolean[][] = [];
  async function readAll() {
    const items = await detail();
    const answers = [SETTLED_AND_LANDS, SETTLED_ONLY, UNSETTLED_BUT_LANDS]
      .map((text) => answerOf(items, text));
    satisfiedOverTime.push(answers.map((answer) => answer.satisfied));
    return answers;
  }

  // ═══ 1. the negative: settled work, no receipt, and the read says both things ═════════════════
  await t.test('work that is DONE with no merge receipt reads satisfied, and UNKNOWN', async () => {
    const [lands, stranded] = await readAll();
    assert.deepEqual(lands, { satisfied: true, clauses: [], landing: 'UNKNOWN' });
    assert.deepEqual(stranded, { satisfied: true, clauses: [], landing: 'UNKNOWN' },
      'the exact shape of the false green this lane exists to break up: the work settled, and '
        + 'nothing anywhere says it reached the default branch');
    for (const answer of [lands, stranded]) {
      assert.notEqual(answer.landing, 'NOT_LANDED',
        'a merge can land without leaving a receipt, so "no receipt" is absence of evidence — '
          + 'reporting it as a denial would swap this false green for an equally false red');
    }
  });

  // ═══ 2. it is a fact, not a gate ═════════════════════════════════════════════════════════════
  await t.test('nothing about an unlanded criterion stops the project being marked DONE', async () => {
    // Every criterion is UNKNOWN at this point, which is the state a gate would have to refuse in.
    const before = await readAll();
    assert.deepEqual(before.map((answer) => answer.landing), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    const done = await projects.update(ownerId, projectId, { status: ProjectStatus.DONE } as never);
    assert.equal(done.status, ProjectStatus.DONE,
      '0223 removed that protection rather than relocating it and 0229 recorded the owner’s '
        + 'choice not to put a narrower one back; serving this fact does not reinstate either');
    await projects.update(ownerId, projectId, { status: ProjectStatus.OPEN } as never);
  });

  // ═══ 3. receipts that are not evidence of a landing on the default branch ═════════════════════
  await t.test('a conflict, and a merge into somewhere else, both leave the answer UNKNOWN',
    async () => {
      await receipts.record(ownerId, strandedSession, {
        result: 'CONFLICT',
        sourceSha: sha('1'),
        targetBranch: 'main',
        conflicts: ['src/apiserver/src/projects/projects.service.ts'],
      }, 'AGENT');
      await receipts.record(ownerId, strandedSession, {
        result: 'MERGED',
        sourceSha: sha('1'),
        targetBranch: 'orbit/somebody-elses-integration-branch',
        targetShaBefore: sha('2'),
        targetShaAfter: sha('3'),
      }, 'AGENT');

      const [, stranded] = await readAll();
      assert.deepEqual(stranded, { satisfied: true, clauses: [], landing: 'UNKNOWN' },
        'git refusing, and a merge into a branch that is not the default one, are both real '
          + 'events and neither is evidence that this work is on main');
    });

  // ═══ 4. the positive, and it belongs to its own criterion ════════════════════════════════════
  await t.test('a MERGED receipt into the default branch reads LANDED, and only there', async () => {
    await receipts.record(ownerId, landingSession, {
      result: 'MERGED',
      sourceSha: sha('4'),
      targetBranch: 'main',
      targetShaBefore: sha('5'),
      targetShaAfter: sha('6'),
    }, 'AGENT');

    const [lands, stranded, unsettled] = await readAll();
    assert.equal(lands.landing, 'LANDED');
    assert.equal(stranded.landing, 'UNKNOWN',
      'one criterion’s receipt is not another’s: a lane that answered every item with the first '
        + 'row it read would have moved this one too');
    assert.equal(unsettled.landing, 'UNKNOWN');
  });

  // ═══ 5. ALREADY_MERGED is a landing, because that is how this work actually lands ═════════════
  await t.test('an ALREADY_MERGED receipt lands the work as much as a MERGED one', async () => {
    await receipts.record(ownerId, strandedSession, {
      result: 'ALREADY_MERGED',
      sourceSha: sha('1'),
      targetBranch: 'main',
      targetShaBefore: sha('7'),
      targetShaAfter: sha('7'),
    }, 'AGENT');

    const [, stranded] = await readAll();
    assert.deepEqual(stranded, { satisfied: true, clauses: [], landing: 'LANDED' },
      'the external fast-forward case — an agent merged it itself and Orbit found out afterwards '
        + '— is the case this table was built for, and reading it as anything but landed would '
        + 'leave the commonest landing invisible');
  });

  // ═══ 6. the other direction: landed work that has not settled ════════════════════════════════
  await t.test('landing does not settle anything either: LANDED beside satisfied false', async () => {
    await receipts.record(ownerId, unsettledSession, {
      result: 'MERGED',
      sourceSha: sha('8'),
      targetBranch: 'main',
      targetShaBefore: sha('9'),
      targetShaAfter: sha('a'),
    }, 'AGENT');

    const [, , unsettled] = await readAll();
    assert.deepEqual(unsettled, {
      satisfied: false,
      clauses: ['SERVING_WORK_UNSETTLED'],
      landing: 'LANDED',
    }, 'code on main that nobody has checked is exactly as unmet as it was before it was merged: '
      + 'the lane adds a fact and does not fold itself into the clauses');
  });

  // ═══ 7. no value of the lane ever moved `satisfied` ══════════════════════════════════════════
  await t.test('`satisfied` is the same at every landing state the criteria passed through',
    async () => {
      const landings = (await readAll()).map((answer) => answer.landing);
      assert.deepEqual(landings, ['LANDED', 'LANDED', 'LANDED'],
        'the invariant below is only worth stating if the lane actually moved');
      assert.ok(satisfiedOverTime.length >= 6,
        'every case above contributes a reading, or this compares fewer states than were visited');
      for (const [index, reading] of satisfiedOverTime.entries()) {
        assert.deepEqual(reading, [true, true, false],
          `read ${index} disagreed with the others about which criteria the work has met — `
            + '`satisfied` says the work settled, and no landing state is an input to that');
      }
    });

  // ═══ 8. finished work with nothing to land does not hold its criterion off the upstream ═══════
  await t.test('a criterion with a piece that declares it needs no code reads LANDED', async () => {
    assert.deepEqual(answerOf(await detail(), NOTHING_TO_LAND),
      { satisfied: true, clauses: [], landing: 'LANDED' },
      'the acceptance task resolves no SOURCE, so it has no branch of its own, no commit of its own '
        + 'and no receipt — there is nothing of it that could be on main. A fold that demanded a '
        + 'landing from it would leave this criterion, and with it the whole project, at '
        + 'ON_INTEGRATION_LINE for ever, which is what happened to 48 finished tasks on 2026-09-22');
  });

  // ═══ 9. the guard: the same rows, one declaration short ═══════════════════════════════════════
  await t.test('work whose own commits are only on the line still reads ON_INTEGRATION_LINE',
    async () => {
      assert.deepEqual(answerOf(await detail(), ITS_OWN_WORK_ON_THE_LINE),
        { satisfied: true, clauses: [], landing: 'ON_INTEGRATION_LINE' },
        'the third task ran a branch, so it carries commits of its own and its only receipt names '
          + 'the project line. This is the shape the finished UI-acceptance task actually has, and '
          + 'it differs from case 8 by the declaration alone: reading LANDED here is the false green '
          + 'this lane exists to break up, because the read cannot tell a branch that carried '
          + 'nothing from one whose work is on the line, and it may not guess between them');
    });

  // ═══ 10. and work that landed nothing is never reported as landed ══════════════════════════════
  await t.test('a criterion none of whose work landed is not LANDED', async () => {
    const neverLanded = answerOf(await detail(), NEVER_LANDED);
    assert.deepEqual(neverLanded, { satisfied: true, clauses: [], landing: 'UNKNOWN' },
      'three branches and no receipt: absence of evidence is not evidence of absence, and it is '
        + 'certainly not a landing');
    assert.notEqual(neverLanded.landing, 'LANDED');
  });
});
