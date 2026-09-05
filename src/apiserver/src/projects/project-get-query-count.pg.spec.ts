/**
 * `GET /projects/:id` on real PostgreSQL: what the project page costs does not depend on how big
 * the project is.
 *
 * WHY THIS EXISTS
 * ---------------
 * The project page is a page people leave open. Before this project's work it made two reads —
 * `project.findFirst` and one `task.groupBy` — neither of which grows with anything. Then two
 * derived facts were bolted onto the same read, each of which is ABOUT the project's criteria and
 * about the work filed under them: whether each stated criterion is satisfied, and whether that
 * work reached the default branch. Both are the shape of thing that is written as one query per
 * criterion by accident, and a per-criterion query is invisible in every test that asserts on the
 * answer — the answer is identical either way. Only the statement count tells them apart.
 *
 * WHAT IS COUNTED, AND WHY IT HAD TO BE BUILT
 * -------------------------------------------
 * Statements, not Prisma calls. `project-list-rollup.audit.pg.spec.ts` counts `$queryRaw` property
 * gets, which is the right instrument for a read written as raw SQL and the wrong one here: this
 * read is one `findMany` whose nested `select` reaches four relations, and how many statements
 * that becomes — and whether the number moves with the rows — is precisely the question. Nothing
 * in the repository could answer it, so `countingPrismaClientFor` taps the driver adapter every
 * statement passes through. The first case below is the control that proves the tap is live before
 * any number from it is trusted.
 *
 * WHY THE ABSOLUTE NUMBER IS PINNED TOO
 * -------------------------------------
 * "The two sizes cost the same" is true of a read that is N+1 at BOTH sizes as soon as somebody
 * makes it so — every criterion of a five-criterion project costing one query apiece is still
 * "equal" to the one-criterion project measured against a matching per-criterion cost. Pinning the
 * count makes the regression land on this file rather than passing through it, and makes an
 * honest addition — a fifth fact on the page — an edit somebody has to make deliberately.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-get-query-count\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { Client } from 'pg';
import type { PrismaService } from '../prisma/prisma.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { TasksService } from '../tasks/tasks.service';
import { countingPrismaClientFor } from '../test-support/counting-prisma-client';
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
 * What one project detail read costs, whatever is in the project.
 *
 * Thirteen statements, and every one of them is per RELATION rather than per row:
 *
 *   4  the project document — the row, its coordinator members, its runtime, its criteria;
 *   1  the per-status task tally (`task.groupBy`);
 *   5  the satisfaction derivation — its criteria, their serving tasks, and, off those tasks, the
 *      verifications pointed at them, their newest completion evidence, and that evidence's
 *      decisions;
 *   3  the landing lane — its criteria, their serving tasks, and those tasks' merge receipts.
 *
 * Measured, not asserted from the code: the two derivations are each written as ONE `findMany`,
 * and Prisma resolves a nested `select` with one statement per relation level, so the fan-out is
 * bounded by the shape of the read rather than by the size of the project. This number is what
 * that costs today. It is not a budget anybody is entitled to spend up to — a change that moves it
 * should move this line, in the same commit, with the reason written down.
 */
const STATEMENTS_PER_READ = 13;

test('the project detail read costs the same number of statements at either size', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);

  const { prisma, statements } = countingPrismaClientFor(url);
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
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `count-${ownerId}@project-detail-cost.invalid`,
      name: 'Project detail',
      passwordHash: 'x',
    },
  });

  /**
   * Settle an EXECUTABLE task exactly as `runnerApi.turnComplete` settles one: `status = 'DONE'`
   * as a compare-and-set that repeats the declaration in its WHERE clause, through 0193/0230's
   * BEFORE UPDATE fence.
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

  /**
   * A project of a stated size, built the way the product builds one: criteria through
   * `ProjectsService.update`, work through `TasksService.create`, DONE through the fence above,
   * and the merge through `MergeReceiptService.record`.
   *
   * The two sizes differ in AMOUNT and not in KIND. Each criterion's first task is settled and
   * merged, so at both sizes every relation the read walks — serving tasks, their receipts, their
   * evidence, the verifications pointed at them — is reached with the same kinds of rows behind
   * it. A comparison where one size populated a relation the other left empty would be measuring
   * which tables were touched rather than how the cost scales.
   */
  async function buildProject(label: string, criteria: number, tasksPerCriterion: number) {
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: label } });
    const stated = criteriaFromDefinitions((await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: Array.from({ length: criteria }, (_, index) => ({
        text: `${label}: the criterion in position ${index + 1}`,
        verificationMethod: METHOD,
      })),
    } as never)).acceptanceCriteriaItems);

    for (const [position, criterion] of stated.entries()) {
      for (let index = 0; index < tasksPerCriterion; index += 1) {
        const task = await tasks.create(ownerId, {
          title: `${label}: work ${index + 1} for criterion ${position + 1}`,
          projectId,
          criterionKey: criterion.key,
          completionCriterion: 'EXECUTABLE',
          acceptanceCommand: 'true',
          acceptanceExpectedExitCode: 0,
        } as never);
        if (index > 0) continue;
        await settleExecutable(task.id);
        const sessionId = randomUUID();
        await prisma.session.create({
          data: {
            id: sessionId,
            ownerId,
            creatorId: ownerId,
            taskId: task.id,
            title: `ran ${task.id}`,
            prompt: 'do the work',
            status: RunStatus.SUCCEEDED,
            branch: `orbit/${label}-${position}-${index}`,
            isolationStatus: 'worktree',
          },
        });
        await receipts.record(ownerId, sessionId, {
          result: 'MERGED',
          sourceSha: sha('1'),
          targetBranch: 'main',
          targetShaBefore: sha('2'),
          targetShaAfter: sha('3'),
        }, 'AGENT');
      }
    }
    return projectId;
  }

  /** One criterion as the outward read states it, narrowed to what this spec reads. */
  interface StatedCriterion {
    text: string;
    satisfied?: boolean;
    unmet?: Array<{ clause: string; heldUpBy: Array<{ title: string }> }>;
    landing?: string;
  }

  /** The read under test, with the statements it sent. */
  async function measure(projectId: string) {
    statements.reset();
    const read = await projects.get(ownerId, projectId) as unknown as {
      acceptanceCriteriaItems: StatedCriterion[];
    };
    return { criteria: read.acceptanceCriteriaItems, sent: [...statements.sql] };
  }

  /** Every statement of a reading, one per line, for a failure a reader has to diagnose from TAP. */
  const listing = (sent: readonly string[]) => sent
    .map((text, index) => `  ${index + 1}. ${text.replace(/\s+/gu, ' ').slice(0, 120)}`)
    .join('\n');

  const small = await buildProject('one', 1, 1);
  const large = await buildProject('five', 5, 3);

  // ═══ 1. the control: the counter is counting this read's real statements ══════════════════════
  await t.test('the counter records the SQL that is actually sent, and only that', async () => {
    statements.reset();
    assert.deepEqual(statements.sql, [], 'a reset log is empty, or every count below is a total');
    await prisma.$queryRaw`SELECT 1 AS live`;
    assert.equal(statements.sql.length, 1, 'one statement issued, one statement recorded');
    assert.match(statements.sql[0], /SELECT 1 AS live/u,
      'the recorded text is the statement that was sent, not a placeholder for it');

    // And what it records for the read under test is that read: a log that counted the right
    // number of the wrong things would satisfy every assertion after this one.
    const { sent } = await measure(large);
    for (const table of ['"project"', '"task"', '"project_acceptance_criterion_definition"',
      '"session_merge_receipt"']) {
      assert.ok(sent.some((text) => text.includes(table)),
        `the project detail read must reach ${table}; it sent:\n${listing(sent)}`);
    }
  });

  // ═══ 2. the measurement: same cost at either size, and that cost is this number ═══════════════
  await t.test('one criterion with one task and five criteria with fifteen cost the same', async () => {
    const one = await measure(small);
    const five = await measure(large);

    assert.equal(one.criteria.length, 1);
    assert.equal(five.criteria.length, 5);

    assert.equal(five.sent.length, one.sent.length,
      'the project page is a page people leave open, and this read has to be independent of how '
        + `much work the project holds.\nOne criterion, one task sent ${one.sent.length}:\n`
        + `${listing(one.sent)}\nFive criteria, fifteen tasks sent ${five.sent.length}:\n`
        + `${listing(five.sent)}`);

    assert.equal(one.sent.length, STATEMENTS_PER_READ,
      'equal counts alone would still pass if both sides became N+1 together, so the cost is '
        + `pinned. It sent ${one.sent.length}:\n${listing(one.sent)}`);
    assert.equal(five.sent.length, STATEMENTS_PER_READ);
  });

  // ═══ 3. and the count is not bought by answering less ═════════════════════════════════════════
  await t.test('both sizes still carry every per-criterion and per-task answer', async () => {
    const one = await measure(small);
    const five = await measure(large);

    assert.deepEqual(one.criteria.map((item) => ({
      satisfied: item.satisfied, clauses: item.unmet?.map((reason) => reason.clause),
      landing: item.landing,
    })), [{ satisfied: true, clauses: [], landing: 'LANDED' }]);

    // Five criteria, each naming the two tasks of its own that have not settled — which is the
    // per-task work a read could have dropped to make itself cheap, and did not. `landing` is
    // UNKNOWN for all five even though each has a merged receipt, because that lane is a
    // conjunction over serving tasks and two of every three here have no receipt at all.
    for (const [position, item] of five.criteria.entries()) {
      assert.equal(item.satisfied, false, `criterion ${position + 1} has unsettled work`);
      assert.equal(item.landing, 'UNKNOWN',
        `criterion ${position + 1} has two serving tasks that no receipt mentions`);
      assert.deepEqual(item.unmet?.map((reason) => reason.clause), ['SERVING_WORK_UNSETTLED']);
      assert.deepEqual(item.unmet?.[0].heldUpBy.map((held) => held.title), [
        `five: work 2 for criterion ${position + 1}`,
        `five: work 3 for criterion ${position + 1}`,
      ], 'each criterion names its OWN unsettled work, so the fixed cost is not a fixed answer');
    }
  });
});
