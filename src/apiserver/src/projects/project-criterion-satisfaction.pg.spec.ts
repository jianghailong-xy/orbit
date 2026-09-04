/**
 * T3 on real PostgreSQL: "is this criterion satisfied?", derived from the work side, with the
 * reason it is not.
 *
 * One positive and three negatives, one negative per clause, and every one of the four asserts the
 * derived answer AND what the derivation says about it — a boolean nobody can act on is the thing
 * this unit exists to avoid. The three negatives were run first against a `criterionSatisfaction`
 * whose body returned `satisfied: true, unmet: []` for every criterion; all three were red, and
 * that output is in the task's comments. The stub replaced the derivation function itself rather
 * than a caller of it, because a negative that a double could satisfy is not a negative.
 *
 * Why this is a `.pg.spec`. Every fact the derivation folds is produced here the way the product
 * produces it: criteria are written and edited through `ProjectsService.update` (the owner's own
 * path, and the only thing that increments a criterion's revision), work is filed through
 * `TasksService.create` (which is what resolves `criterionKey` into 0232's two columns), verdicts
 * are recorded through `TasksService.update`, and the two settled-by-EXECUTABLE rows are written
 * by the same compare-and-set `runnerApi.turnComplete` performs, through 0193/0230's DONE fence.
 * A fixture that INSERTed the answers would prove this file can read what it just wrote.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-criterion-satisfaction\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readCriterionDeclarations } from './project-criterion-declaration-staleness';
import {
  type CriterionSatisfaction,
  readCriterionSatisfaction,
} from './project-criterion-satisfaction';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';
/** The four columns on the CRITERION that T4 removed, spelled as the database spells them. */
const WIRING_COLUMNS = [
  'evidence_task_id',
  'completion_criterion',
  'acceptance_command',
  'acceptance_expected_exit_code',
] as const;
/**
 * What a criterion still stores besides its identity, and what this derivation must not read.
 *
 * The four above are gone (migration 0233), so dropping them is no longer a statement anybody can
 * make. These are the successor: everything a criterion carries today that is not `id`, `ordinal`
 * or `revision`. A derivation that named one of them could not survive the rolled-back DROP below.
 */
const NON_IDENTITY_COLUMNS = [
  'text',
  'verification_method',
  'completion_criterion_override_reason',
  'content_hash',
  'semantic_hash',
  'evaluation_plan_hash',
] as const;
/** build/projects -> build -> apiserver -> src -> repository root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MODULE = 'src/apiserver/src/projects/project-criterion-satisfaction.ts';
const SPEC = 'src/apiserver/src/projects/project-criterion-satisfaction.pg.spec.ts';

/** Every source file that could wire this derivation into something. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist'
      || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|cjs|go|sql|swift|kt|prisma|json|sh|md)$/u.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

test('T3: a criterion is satisfied by three clauses, and says which one is missing', {
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

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `t3-${ownerId}@criterion-satisfaction.invalid`,
      name: 'T3',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'T3 subject project' },
  });

  /** State the whole collection through the owner's path, and read the keys back. */
  async function state(items: Array<{ id?: string; text: string }>) {
    const written = await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: METHOD,
      })),
    } as never);
    return criteriaFromDefinitions(written.acceptanceCriteriaItems);
  }

  /**
   * Settle an EXECUTABLE task exactly as `runnerApi.turnComplete` settles one: `status = 'DONE'`
   * as a compare-and-set that repeats the declaration in its WHERE clause, through 0193/0230's
   * BEFORE UPDATE fence. Nothing else is written, because 0230 stores nothing else — the exit code
   * is compared in memory there and dropped, which is precisely why this read has only the status
   * to look at for this criterion.
   */
  async function settleExecutable(taskId: string, command: string, exitCode: number) {
    const written = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid
          AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE'
          AND "acceptance_command" = $2
          AND "acceptance_expected_exit_code" = $3`,
      [taskId, command, exitCode],
    );
    assert.equal(written.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
  }

  /** The read under test, narrowed to one criterion. */
  async function satisfactionOf(definitionId: string): Promise<CriterionSatisfaction> {
    const derived = await readCriterionSatisfaction(prisma, ownerId, projectId);
    const row = derived.find((entry) => entry.definitionId === definitionId);
    assert.ok(row, 'the criterion must be in the read that answers for this project’s criteria');
    return row;
  }

  const ALL_MET = 'every clause of this one holds';
  const NOBODY_SERVES = 'nobody has filed any work against this one';
  const ONE_OUTSTANDING = 'two pieces of work serve this one and only one of them has settled';
  const MOVES = 'the wording of this one is about to be corrected';
  const MOVED = 'the wording of this one has been corrected';

  const [metAtFirst, unservedAtFirst, partialAtFirst, movingAtFirst] = await state([
    { text: ALL_MET }, { text: NOBODY_SERVES }, { text: ONE_OUTSTANDING }, { text: MOVES },
  ]);

  // ── the criterion every clause holds for ──────────────────────────────────────────────────────
  // Three serving tasks, one per settlement fact this system actually has: an EXECUTABLE
  // comparison that agreed, a subject settled by an independent PASS, and the check itself, which
  // is work filed against the same criterion and is settled by its own verdict.
  const EXECUTABLE_DECLARATION = { acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };
  const metExecutable = await tasks.create(ownerId, {
    title: 'the command that returns what it said it would',
    projectId,
    criterionKey: metAtFirst.key,
    completionCriterion: 'EXECUTABLE',
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(metExecutable.id, 'true', 0);
  const metSubject = await tasks.create(ownerId, {
    title: 'the work an independent check settles',
    projectId,
    criterionKey: metAtFirst.key,
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
  } as never);
  const metVerifier = await tasks.create(ownerId, {
    title: 'the check itself, which also serves this criterion',
    projectId,
    criterionKey: metAtFirst.key,
    verifiesTaskId: metSubject.id,
  } as never);
  await tasks.update(ownerId, metVerifier.id, { verdict: 'PASS' } as never);

  // ── the criterion two tasks serve, one of which has not settled ───────────────────────────────
  // The unsettled one is DONE. That is not a trick: its own declared criterion is
  // EVIDENCE_JUDGMENT, whose implementation was removed on 2026-09-02, and its status came from
  // the aggregate policy it also declares — a projection over its children, not the fact it said
  // would settle it. A derivation that read `status = 'DONE'` would call this criterion met.
  const partialSettled = await tasks.create(ownerId, {
    title: 'the piece of this one that did settle',
    projectId,
    criterionKey: partialAtFirst.key,
    completionCriterion: 'EXECUTABLE',
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(partialSettled.id, 'true', 0);
  const partialOutstanding = await tasks.create(ownerId, {
    title: 'the piece of this one that never settled by its own criterion',
    projectId,
    criterionKey: partialAtFirst.key,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    completionPolicy: 'ALL_CHILDREN_DONE',
  } as never);
  const outstandingChild = await tasks.create(ownerId, {
    title: 'a subtask that serves no criterion of its own',
    projectId,
    parentTaskId: partialOutstanding.id,
    completionCriterion: 'EXECUTABLE',
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(outstandingChild.id, 'true', 0);
  const aggregated = await sql.query(
    `UPDATE "task" SET "status" = 'DONE'
      WHERE "id" = $1::uuid AND "status" <> 'DONE'
        AND "completion_policy" = 'ALL_CHILDREN_DONE'`,
    [partialOutstanding.id],
  );
  assert.equal(aggregated.rowCount, 1,
    'the DONE fence must accept this row: a state the product itself produces, not an invention');

  // ── the criterion whose wording moves under settled work ──────────────────────────────────────
  const movingTask = await tasks.create(ownerId, {
    title: 'work filed, and settled, against a wording that then changed',
    projectId,
    criterionKey: movingAtFirst.key,
    completionCriterion: 'EXECUTABLE',
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(movingTask.id, 'true', 0);
  const [met, unserved, partial, moved] = await state([
    { id: metAtFirst.definitionId, text: ALL_MET },
    { id: unservedAtFirst.definitionId, text: NOBODY_SERVES },
    { id: partialAtFirst.definitionId, text: ONE_OUTSTANDING },
    { id: movingAtFirst.definitionId, text: MOVED },
  ]);
  assert.equal(moved.definitionId, movingAtFirst.definitionId,
    'the criterion must be the same row: an edit, not a replacement');
  assert.deepEqual(
    [met.definitionRevision, unserved.definitionRevision,
      partial.definitionRevision, moved.definitionRevision],
    [1, 1, 1, 2],
    'exactly one criterion moved, and nothing here wrote a revision by hand');

  // ═══ 1. the positive ══════════════════════════════════════════════════════════════════════════
  await t.test('all three clauses hold: the criterion is satisfied, with nothing missing',
    async () => {
    // Not vacuous: work really was filed against this one, and all of it really is there.
    const [declared] = (await readCriterionDeclarations(prisma, ownerId, projectId))
      .filter((row) => row.definitionId === met.definitionId);
    assert.deepEqual(declared.servingTasks.map((row) => row.taskId).sort(),
      [metExecutable.id, metSubject.id, metVerifier.id].sort());

    const derived = await satisfactionOf(met.definitionId);
    assert.equal(derived.satisfied, true);
    assert.deepEqual(derived.unmet, [],
      'the reason a satisfied criterion gives is that no clause is missing');
    assert.equal(derived.revision, 1);
  });

  // ═══ 2. the negative for clause 1: the empty case is not satisfied vacuously ═══════════════════
  await t.test('no work serves it: unsatisfied, and the reason is that nobody serves it',
    async () => {
    const derived = await satisfactionOf(unserved.definitionId);
    assert.equal(derived.satisfied, false,
      '"every one of zero serving tasks has settled" is true and useless');
    assert.deepEqual(derived.unmet, [{ clause: 'NO_WORK_SERVES_IT', heldUpBy: [] }],
      'the one clause that fails is the first one, and it has nobody to name');
  });

  // ═══ 3. the negative for clause 2: a conjunction, not a disjunction ═══════════════════════════
  await t.test('one of two serving tasks is unsettled: unsatisfied, and it is named', async () => {
    const derived = await satisfactionOf(partial.definitionId);
    assert.equal(derived.satisfied, false,
      'one settled task among two does not make the stated condition true');
    assert.deepEqual(derived.unmet, [{
      clause: 'SERVING_WORK_UNSETTLED',
      heldUpBy: [{
        taskId: partialOutstanding.id,
        title: 'the piece of this one that never settled by its own criterion',
        status: 'DONE',
        completionCriterion: 'EVIDENCE_JUDGMENT',
        requiredAction: 'AWAIT_EVIDENCE_JUDGMENT_IMPLEMENTATION',
        criterionRevision: 1,
        criterionRevisionStale: false,
      }],
    }], 'the reason names the task that holds it up and what would settle THAT task');

    // The two halves of "by its own declared criterion, not by a blanket status":
    // the named task IS DONE, and the task that is not named is the one whose criterion settled.
    const [held] = derived.unmet[0].heldUpBy;
    assert.equal(held.status, 'DONE');
    assert.ok(!derived.unmet[0].heldUpBy.some((row) => row.taskId === partialSettled.id),
      'the EXECUTABLE task whose comparison agreed is settled and is not holding anything up');
  });

  // ═══ 4. the negative for clause 3: a declaration measured against a criterion that moved ══════
  await t.test('a serving task declared a stale revision: unsatisfied, and the reason is stale',
    async () => {
    const derived = await satisfactionOf(moved.definitionId);
    assert.equal(derived.revision, 2);
    assert.equal(derived.satisfied, false,
      'the work settled, and it settled against a wording that has since moved');
    assert.deepEqual(derived.unmet, [{
      clause: 'DECLARATION_STALE',
      heldUpBy: [{
        taskId: movingTask.id,
        title: 'work filed, and settled, against a wording that then changed',
        status: 'DONE',
        completionCriterion: 'EXECUTABLE',
        requiredAction: 'RUN_ACCEPTANCE_COMMAND',
        criterionRevision: 1,
        criterionRevisionStale: true,
      }],
    }], 'clause 3 is the only one missing: the work is settled, it is the declaration that is old');
  });

  // ═══ nothing on the criterion side is on this path ════════════════════════════════════════════
  await t.test('the derivation reads nothing on the criterion but its identity', async () => {
    const before = await readCriterionSatisfaction(prisma, ownerId, projectId);
    assert.ok(before.length === 4 && before.some((row) => !row.satisfied),
      'the comparison below is only worth making over an answer with content in it');

    // T4 landed: the four columns this case used to drop are already gone, so dropping them is no
    // longer a statement — their absence is.
    const { rows: wiring } = await sql.query<{ column_name: string }>(
      `SELECT "column_name" FROM information_schema.columns
        WHERE "table_schema" = 'public'
          AND "table_name" = 'project_acceptance_criterion_definition'
          AND "column_name" = ANY($1::text[])`,
      [[...WIRING_COLUMNS]],
    );
    assert.deepEqual(wiring.map((row) => row.column_name), [],
      'migration 0233 removed the criterion’s wiring towards the work');

    class Rollback extends Error {}
    let survivingColumns: string[] = [];
    let after: CriterionSatisfaction[] = [];
    // The same technique, aimed at what is left, and stronger than reading the source for column
    // names: everything a criterion still carries beyond its identity is actually dropped, the
    // derivation is actually re-run, and the answer is actually the same. A derivation that named
    // any of them could not survive this — the statement would fail, not merely disagree.
    //
    // Inside one transaction that always rolls back, because Postgres DDL is transactional and
    // this case's database outlives this test. CASCADE because several of these are wired into
    // objects of their own — the normalize trigger's column list, the content index — and taking
    // those with them is a side effect the rollback undoes. The cascade cannot reach anything this
    // read needs, which is not an argument but an assertion below: the criterion's identity
    // columns are still there, and the answer is unchanged.
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "project_acceptance_criterion_definition" ${
        NON_IDENTITY_COLUMNS.map((column) => `DROP COLUMN "${column}" CASCADE`).join(', ')}`);
      const remaining = await tx.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT "column_name" FROM information_schema.columns
          WHERE "table_schema" = 'public'
            AND "table_name" = 'project_acceptance_criterion_definition'`);
      survivingColumns = remaining.map((row) => row.column_name).sort();
      after = await readCriterionSatisfaction(tx as unknown as PrismaService, ownerId, projectId);
      throw new Rollback();
    }, { timeout: 120_000, maxWait: 60_000 }), Rollback);

    assert.deepEqual(NON_IDENTITY_COLUMNS.filter((column) => survivingColumns.includes(column)), [],
      'all of them had to be gone for the re-derivation to have proved anything');
    for (const kept of ['id', 'ordinal', 'revision']) {
      assert.ok(survivingColumns.includes(kept),
        `the cascade must not have taken ${kept}, which is what the derivation reads`);
    }
    assert.deepEqual(after, before,
      'the same answer, derived from a criterion table stripped to its identity');

    // And the case's database is intact, so the rollback is a fact rather than an intention.
    const { rows } = await sql.query<{ column_name: string }>(
      `SELECT "column_name" FROM information_schema.columns
        WHERE "table_schema" = 'public'
          AND "table_name" = 'project_acceptance_criterion_definition'
          AND "column_name" = ANY($1::text[]) ORDER BY "column_name"`,
      [[...NON_IDENTITY_COLUMNS]],
    );
    assert.deepEqual(rows.map((row) => row.column_name), [...NON_IDENTITY_COLUMNS].sort());
  });

  // ═══ it is a read, and nothing consumes it ═══════════════════════════════════════════════════
  await t.test('nothing wires the derived answer into a status write or any gate', async () => {
    // Walked from the filesystem rather than from `git ls-files`, which reports nothing about a
    // file that has not been committed yet — the one state in which a new gate would be invisible.
    const mentions = [...sourceFiles(path.join(REPO_ROOT, 'src')),
      ...sourceFiles(path.join(REPO_ROOT, 'scripts'))]
      .filter((file) => readFileSync(file, 'utf8').includes('project-criterion-satisfaction'))
      .map((file) => path.relative(REPO_ROOT, file))
      .sort();
    assert.deepEqual(mentions, [MODULE, SPEC].sort(),
      'the derivation has exactly one reader, and it is this spec: no gate consumes it');

    const source = readFileSync(path.join(REPO_ROOT, MODULE), 'utf8');
    assert.doesNotMatch(
      source, /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/u,
      'the derivation writes nothing');
    assert.doesNotMatch(source, /\$execute/u, 'and it has no raw escape hatch either');
  });
});
