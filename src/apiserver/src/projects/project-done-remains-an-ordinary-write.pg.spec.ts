/**
 * The negative control for the unit that made each stated criterion's satisfaction readable:
 * after it, `project.status = 'DONE'` is still an ordinary column write.
 *
 * Written LAST on purpose. A negative control measures the system AFTER the work it is about.
 * Written first it is green against a tree nobody has touched yet, which is not evidence of
 * anything — the claim is that four units of read-side work added no gate, and only a tree that
 * carries all four can be asked.
 *
 * TWO CASES, TWO HALVES OF THE SAME CLAIM
 * ---------------------------------------
 * 1. The database half. The `project` table's triggers are EXACTLY the seven named below.
 *    Set equality rather than "none of these four names is present": the removal migration 0229
 *    recorded is already asserted that way in `project-done-gate.pg.spec.ts`, and a list of names
 *    NOT to have is green in the one case that matters — an eighth trigger arriving under a name
 *    nobody thought to forbid. Equality makes a new trigger on this table something somebody has
 *    to come here and write down, with what it is for, which is the whole of the guarantee.
 *
 * 2. The application half. A project every one of whose stated criteria is unmet settles DONE
 *    through `ProjectsService.update` — the write path the product uses — and the column holds it.
 *
 * The two together also answer the case set equality alone cannot: a gate hidden inside one of the
 * seven whitelisted trigger functions rather than beside them. Case 2 performs the write those
 * triggers fire on, against a project in the exact state a gate would exist to refuse, and reads
 * the committed column back. A refusal from anywhere — a trigger body, the service, the DTO —
 * fails it.
 *
 * WHY THIS RUNS ON REAL POSTGRESQL, WITH THE REAL SERVICE
 * ------------------------------------------------------
 * "Every criterion is unmet" is a fact about rows: which tasks declare they serve which criterion,
 * whether each has settled by the criterion IT declared, and whether the wording moved under a
 * declaration. A Prisma double handed canned criteria would make the premise of this control
 * something this file asserted about itself, and a service double would make the conclusion one
 * too — a negative control that a test double can satisfy has controlled for nothing. So the
 * criteria are written through the owner's own path, the work is filed through `TasksService`, the
 * settled task reaches DONE through the same compare-and-set the runner performs, the premise is
 * read back off `ProjectsService.get`, and the write under test is the service's.
 *
 * All three ways of not being met are used, one criterion each. "Every criterion is unmet" as
 * three copies of the cheapest clause would leave the interesting states untested.
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-done-remains-an-ordinary-write\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, type PrismaClient, ProjectStatus } from '@prisma/client';
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
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/**
 * Every trigger the `project` table carries, and the column each one watches.
 *
 * Not one of them watches `status`, and that is the shape of the claim rather than a coincidence
 * worth restating as a second assertion: the seven are the coordinator pointer, the coordinator's
 * companion rows, and the authorization set. Acceptance had four here — `project_acceptance_
 * done_gate`, `_advance_epoch`, `_epoch_audit` and `_criteria_fact` — and migration 0229 dropped
 * all four when the account owner was offered a narrower guard and chose the other option.
 *
 * A trigger added to this table has to be added here too, with what it is for. That is the point
 * of the list being exact: an acceptance gate does not have to arrive under a name containing
 * "acceptance", and nothing else about it would be visible from a catalog query.
 */
const PROJECT_TRIGGERS: Record<string, string> = {
  project_coordinator_companions_bind:
    'deferred AFTER UPDATE OF coordinator_workspace_id — reconciles the coordinator’s membership '
    + 'rows when its landing moves (0112/0113)',
  project_coordinator_companions_insert:
    'deferred AFTER INSERT — the same reconciliation for a project created with a coordinator '
    + 'already named (0112/0113)',
  project_coordinator_identity_window_repair:
    'BEFORE UPDATE OF coordinator_workspace_id — repairs the identity window a landing move '
    + 'opens (0115)',
  project_coordinator_pointer_guard:
    'BEFORE INSERT OR UPDATE OF coordinator_session_id, coordinator_workspace_id — the pointer '
    + 'and its landing are written as a pair or not at all (0126)',
  project_coordinator_rotation_count:
    'deferred AFTER UPDATE OF coordinator_session_id — counts a rotation of the coordinator '
    + 'pointer (0112/0113)',
  project_dispatch_authority_fanout:
    'AFTER UPDATE OF coordinator_enabled — revoking the coordinator has to reach the work it had '
    + 'already authorized (0122)',
  zz_project_completion_contract_project:
    'AFTER INSERT OR UPDATE OF the authorization set (goal, instructions, coordinator_enabled, '
    + 'automation_policy, max_concurrent_tasks, session_budget_per_day, config_revision, '
    + 'convergence_thresholds, attempt_budget, unbounded_authorized_by) — the completion contract',
};

/** The verification method every criterion here states; never the thing under test. */
const METHOD = 'Somebody reads it and says whether it holds';

const UNSERVED = 'nobody has filed any work against this one';
const UNSETTLED = 'the work filed against this one has not settled by its own criterion';
const MOVES = 'the wording of this one is about to be corrected';
const MOVED = 'the wording of this one has been corrected under work that already settled';

/**
 * One criterion as the project read states it, narrowed to what this control needs.
 *
 * `satisfied` and `unmet` are OPTIONAL, and the assertions are what require them. Typed as
 * required, the guard below could not be written at all — comparing a `boolean` to `undefined` is
 * a type error — so a read that had stopped carrying them would reach the assertions as
 * `undefined === false` and this file would go red about the wrong thing. A control whose premise
 * cannot be observed to be MISSING, as opposed to false, is a control whose premise nobody checks.
 */
interface StatedCriterion {
  id: string;
  text: string;
  satisfied?: boolean;
  unmet?: Array<{ clause: string }>;
}

/** The answer for one criterion, required to be there — a missing one is not an unmet one. */
function answerOf(item: StatedCriterion): { satisfied: boolean; unmet: Array<{ clause: string }> } {
  const { satisfied, unmet } = item;
  if (satisfied === undefined || unmet === undefined) {
    assert.fail(`the project read carries no satisfaction answer for “${item.text}”, so this `
      + 'control cannot establish that every criterion is unmet before it writes DONE');
  }
  return { satisfied, unmet };
}

// ═══ 1. the database half ═══════════════════════════════════════════════════════════════════════
test('the `project` table carries exactly the triggers written down here', {
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

  const installed = await prisma.$queryRaw<Array<{ tgname: string }>>(Prisma.sql`
    SELECT t."tgname" FROM "pg_trigger" t
     WHERE t."tgrelid" = 'project'::regclass AND NOT t."tgisinternal"
     ORDER BY t."tgname"`);

  assert.deepEqual(
    installed.map((row) => row.tgname),
    Object.keys(PROJECT_TRIGGERS).sort(),
    'the triggers on `project` are exactly the ones written down above, each with what it is for. '
      + 'A name here that the catalog does not have is a trigger that was removed and not '
      + 'un-recorded; a name the catalog has and this list does not is a trigger somebody '
      + 'installed without saying why — and "no trigger called acceptance-something" would not '
      + 'have noticed it');
});

// ═══ 2. the application half ════════════════════════════════════════════════════════════════════
test('a project with every stated criterion unmet still settles DONE through the service', {
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
      email: `done-${ownerId}@ordinary-write.invalid`,
      name: 'The owner who settles it anyway',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'A project nothing has met' },
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
   * Settle an EXECUTABLE task the way `runnerApi.turnComplete` settles one: `status = 'DONE'` as a
   * compare-and-set repeating the declaration in its WHERE clause, through 0193/0230's fence.
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

  /** The criteria as the project read states them, in the project's own order. */
  async function stated(): Promise<StatedCriterion[]> {
    const read = await projects.get(ownerId, projectId) as unknown as {
      acceptanceCriteriaItems: StatedCriterion[];
    };
    return read.acceptanceCriteriaItems;
  }

  /** The column itself, read outside Prisma so the answer is the row's and not the service's. */
  async function storedStatus(): Promise<string> {
    const row = await sql.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "project" WHERE "id" = $1::uuid`, [projectId]);
    assert.equal(row.rowCount, 1);
    return row.rows[0].status;
  }

  const EXECUTABLE_DECLARATION = {
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  };

  const [unservedAtFirst, unsettledAtFirst, movingAtFirst] = await state([
    { text: UNSERVED }, { text: UNSETTLED }, { text: MOVES },
  ]);

  // Clause 2: work is filed against it and has not settled.
  const unsettledTask = await tasks.create(ownerId, {
    title: 'the work that has not run yet',
    projectId,
    criterionKey: unsettledAtFirst.key,
    ...EXECUTABLE_DECLARATION,
  } as never);

  // Clause 3: work settled, and then the wording moved out from under the declaration.
  const movingTask = await tasks.create(ownerId, {
    title: 'work filed, and settled, against a wording that then changed',
    projectId,
    criterionKey: movingAtFirst.key,
    ...EXECUTABLE_DECLARATION,
  } as never);
  await settleExecutable(movingTask.id);
  const [, , moved] = await state([
    { id: unservedAtFirst.definitionId, text: UNSERVED },
    { id: unsettledAtFirst.definitionId, text: UNSETTLED },
    { id: movingAtFirst.definitionId, text: MOVED },
  ]);
  assert.equal(moved.definitionRevision, 2,
    'the wording moved once, and nothing here wrote a revision by hand');

  // ═══ the premise ═════════════════════════════════════════════════════════════════════════════
  await t.test('every criterion this project states is unmet, each for its own reason', async () => {
    const items = await stated();
    assert.deepEqual(items.map((item) => item.text), [UNSERVED, UNSETTLED, MOVED],
      'the read states the criteria in the project’s own order');
    assert.deepEqual(items.map((item) => answerOf(item).satisfied), [false, false, false],
      'the premise of this control is that NOTHING here is met — a project with a satisfied '
        + 'criterion in it would make the write below prove nothing about the unmet ones');
    assert.deepEqual(
      items.map((item) => answerOf(item).unmet.map((reason) => reason.clause)),
      [['NO_WORK_SERVES_IT'], ['SERVING_WORK_UNSETTLED'], ['DECLARATION_STALE']],
      'and all three ways of not being met are here, one criterion each: three copies of the '
        + 'cheapest clause would leave the states a gate would most want to refuse untested');
  });

  // ═══ the control ═════════════════════════════════════════════════════════════════════════════
  await t.test('DONE is written, and the column holds it', async () => {
    assert.equal(await storedStatus(), 'OPEN', 'the project has not been settled by anything yet');

    // No `expectedConfigRevision`, no acknowledgement, no evidence: the request is the value.
    const settled = await projects.update(ownerId, projectId, {
      status: ProjectStatus.DONE,
    } as never) as unknown as { status: string };

    // The removed refusal is named nowhere in this file, on purpose: 0229's removal suite scans
    // every live source for the symbols and the refusal code it dropped, and a name quoted here
    // would be the second one. This case does not need to name it — it performs the request that
    // used to meet it.
    assert.equal(settled.status, ProjectStatus.DONE,
      'the service returned the settled project rather than refusing the write. Migration 0229 '
        + 'removed the database gate and the application-layer refusal together, and the account '
        + 'owner chose that over the narrower guard they were offered; serving each criterion’s '
        + 'satisfaction beside it does not reinstate what was removed');
    assert.equal(await storedStatus(), 'DONE',
      'and the column committed it — a service that answered DONE without the row reaching it '
        + 'would be a gate rolling the write back');
  });

  // ═══ the write consulted nothing, and changed nothing ════════════════════════════════════════
  await t.test('settling it moved no criterion, and no criterion moved it', async () => {
    const items = await stated();
    assert.deepEqual(items.map((item) => answerOf(item).satisfied), [false, false, false],
      'the criteria read exactly as they did before the write: satisfaction is derived from the '
        + 'work filed under each criterion, and a project’s status is not one of its inputs');
    assert.deepEqual(
      items.map((item) => answerOf(item).unmet.map((reason) => reason.clause)),
      [['NO_WORK_SERVES_IT'], ['SERVING_WORK_UNSETTLED'], ['DECLARATION_STALE']]);
    // The tasks are untouched too: settling the project is not a way of settling its work.
    // Keyed by id rather than ordered, because two rows written in one batch can share a
    // millisecond and this is not a claim about which was created first.
    const held = Object.fromEntries((await prisma.task.findMany({
      where: { projectId },
      select: { id: true, status: true },
    })).map((row) => [row.id, row.status]));
    assert.deepEqual(held, {
      [unsettledTask.id]: 'OPEN',
      [movingTask.id]: 'DONE',
    });
  });
});
