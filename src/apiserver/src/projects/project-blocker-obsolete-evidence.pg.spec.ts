import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import test from 'node:test';
import { RunStatus, TaskStatus } from '@prisma/client';
import {
  E2eServices,
  World,
  connectIsolatedPg,
  deliver,
  drainToIdle,
  emptyWorld,
  servicesOn,
  session,
  task,
  world,
} from './project-e2e-harness';

/**
 * §11's two EVIDENCE detectors on a real PostgreSQL: the half the pure spec cannot state.
 *
 * `project-supersession-guards.spec.ts` proves what `mergeConditions` and
 * `awaitingUserInputConditions` return for a frozen snapshot. What only a database can answer is
 * everything AROUND that answer, and it is the whole remedy:
 *
 *   * a row that is already OPEN resolves on the NEXT reconcile, by §11.4's own auto-clear, with
 *     `resolved_by = AUTO` — nobody deletes an audit row to unblock a project;
 *   * the retirement that causes it is atomic: all four columns in one statement, and the database
 *     refuses the halves (0130's `task_retirement_status_check`);
 *   * a redelivered event does not open a second episode, and does not un-resolve the first;
 *   * a server restart does not re-raise what a previous process resolved;
 *   * the historical Session and its branch are byte-identical afterwards — compared as
 *     `to_jsonb(session)`, so a column added later is compared without this file being edited.
 *
 * The shape every scenario is built on is the reachable one, not a hypothetical: 0130 refuses a
 * live run on a retired task, but it exempts a SALVAGE session on INSERT (`starts_task_work =
 * false`) — somebody opening the replaced attempt to read it. That session can park on a question,
 * and until this unit nothing ever stopped asking the project's owner to answer it.
 */

const URL = process.env.COORDINATOR_PG_URL;
const RESTART_COMMAND = process.env.COORDINATOR_PG_RESTART_COMMAND;
const skip = !URL;

/** The three ways a row says "this attempt is not the live one" (see the pure spec's table). */
const RETIREMENTS: Array<{ name: string; successor: boolean; reason: string | null }> = [
  { name: 'linked to its successor', successor: true, reason: 'SUPERSEDED' },
  { name: 'successor deleted, reason kept', successor: false, reason: 'SUPERSEDED' },
  { name: 'abandoned', successor: false, reason: 'ABANDONED' },
];

interface BlockerRow {
  kind: string;
  dedupe_key: string;
  subject_type: string;
  subject_id: string;
  lifecycle_generation: string;
  occurrences: number;
  resolved_at: Date | null;
  resolved_by: string | null;
}

async function blockers(services: E2eServices, projectId: string): Promise<BlockerRow[]> {
  return services.db.$queryRawUnsafe<BlockerRow[]>(
    `SELECT "kind", "dedupe_key", "subject_type", "subject_id",
            "lifecycle_generation"::text AS lifecycle_generation, "occurrences",
            "resolved_at", "resolved_by"::text AS resolved_by
       FROM "project_blocker"
      WHERE "project_id" = $1::uuid
        AND "kind" IN ('MERGE_CONFLICT', 'UNKNOWN_FAILURE', 'AWAITING_USER_INPUT')
      ORDER BY "dedupe_key", "lifecycle_generation"`,
    projectId,
  );
}

function open(rows: BlockerRow[]): string[] {
  return rows.filter((row) => row.resolved_at === null).map((row) => row.dedupe_key).sort();
}

/** Every open blocker, of every kind — §13.4's DONE gate counts these, not just the two above. */
async function allOpenKinds(services: E2eServices, projectId: string): Promise<string[]> {
  const rows = await services.db.$queryRawUnsafe<Array<{ kind: string }>>(
    `SELECT "kind" FROM "project_blocker"
      WHERE "project_id" = $1::uuid AND "resolved_at" IS NULL ORDER BY "kind"`,
    projectId,
  );
  return rows.map((row) => row.kind);
}

async function runState(services: E2eServices, projectId: string): Promise<string> {
  const [row] = await services.db.$queryRawUnsafe<Array<{ state: string }>>(
    `SELECT "run_state"::text AS state FROM "project_runtime" WHERE "project_id" = $1::uuid`,
    projectId,
  );
  return row.state;
}

/**
 * Every column of every Session this owner has, as JSON.
 *
 * `to_jsonb(s)` rather than a column list: the property is "nothing about the history was
 * rewritten", and a hand-maintained list silently stops covering a column somebody adds later.
 */
async function sessionRows(services: E2eServices, ownerId: string): Promise<string> {
  const rows = await services.db.$queryRawUnsafe<Array<{ row: unknown }>>(
    `SELECT to_jsonb(s) AS row FROM "session" s WHERE s."owner_id" = $1::uuid ORDER BY s."id"`,
    ownerId,
  );
  return JSON.stringify(rows);
}

/**
 * A retirement, in ONE statement.
 *
 * 0130's `task_retirement_status_check` is about several columns at once and PostgreSQL evaluates a
 * CHECK per statement, so a fixture that moved the status separately would be refused on whichever
 * half it wrote first. That is the atomicity this unit depends on, and the scenario below asserts
 * the database enforces it rather than trusting this helper to be careful.
 */
async function retire(
  services: E2eServices,
  taskId: string,
  shape: { successor: boolean; reason: string | null },
  successorId: string | null,
): Promise<void> {
  await services.db.$executeRawUnsafe(
    `UPDATE "task"
        SET "superseded_by_task_id" = $1::uuid, "superseded_at" = $2, "terminal_reason" = $3,
            "status" = CASE WHEN "status" IN ('FAILED', 'CANCELLED') THEN "status"
                            ELSE 'CANCELLED'::"task_status" END
      WHERE "id" = $4::uuid`,
    shape.successor ? successorId : null,
    shape.reason ? new Date() : null,
    shape.reason,
    taskId,
  );
}

/**
 * A finished attempt that left two things behind: a branch that would not merge, and a salvage
 * session parked on a question. Both are the evidence §11's two detectors read.
 */
async function replacedAttempt(
  services: E2eServices,
  target: World,
  label: string,
): Promise<{ taskId: string; runId: string; salvageId: string }> {
  const taskId = await task(services.db, target, label, { status: TaskStatus.CANCELLED });
  const runId = await session(services.db, target, {
    taskId,
    status: RunStatus.SUCCEEDED,
    branch: `orbit/${label}`,
    mergeStatus: 'conflict',
    mergeTarget: 'main',
    changedFiles: [{ path: 'src/a.ts' }],
  });
  // `startsTaskWork: false` is 0130's salvage door: a session opened to READ a replaced attempt.
  // It is also the only shape of live session a retired task may hold, which is exactly why the
  // question it asks used to sit on the project forever.
  const salvageId = await session(services.db, target, {
    taskId,
    status: RunStatus.AWAITING_INPUT,
    startsTaskWork: false,
    finishedAt: null,
  });
  return { taskId, runId, salvageId };
}

// ---------------------------------------------------------------------------------------------
// 1. Open, retire, and the NEXT reconcile clears both rows on its own
// ---------------------------------------------------------------------------------------------

test('unit H1: retiring an attempt auto-resolves the rows its evidence was holding open',
  { skip }, async (t) => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      for (const shape of RETIREMENTS) {
        await t.test(`a ${shape.name} attempt stops asking`, async () => {
          await emptyWorld(client);
          const target = await world(services.db, 'h1-clear');
          const successorId = await task(services.db, target, 'the fresh attempt');
          const old = await replacedAttempt(services, target, 'h1-old');

          await drainToIdle(services);
          const raised = await blockers(services, target.projectId);
          assert.deepEqual(open(raised), [
            `AWAITING_USER_INPUT:SESSION:${old.salvageId}`,
            `MERGE_CONFLICT:TASK:${old.taskId}`,
          ].sort(), 'a settled-but-live attempt still reports both — SU6 is the filter, not DONE');

          // What the history looked like before anything was retired.
          const before = await sessionRows(services, target.ownerId);

          await retire(services, old.taskId, shape, successorId);
          await deliver(services, target.projectId, 'task.updated');

          const after = await blockers(services, target.projectId);
          assert.deepEqual(open(after), [], 'both rows resolve on the next pass');
          assert.deepEqual(
            after.map((row) => [row.dedupe_key, row.resolved_by, row.lifecycle_generation]),
            [
              [`AWAITING_USER_INPUT:SESSION:${old.salvageId}`, 'AUTO', '1'],
              [`MERGE_CONFLICT:TASK:${old.taskId}`, 'AUTO', '1'],
            ],
            'resolved by the loop, one episode each, and the audit row is kept',
          );
          assert.equal(await sessionRows(services, target.ownerId), before,
            'the Session and its branch are not rewritten — not one column');

          // The point of the whole unit: the project is no longer HELD. §13.4's DONE gate counts
          // open blockers of every kind, and §4.2's guards read the same set to decide the state.
          assert.deepEqual(await allOpenKinds(services, target.projectId), [],
            'nothing at all holds this project open now');
          const state = await runState(services, target.projectId);
          assert.ok(state !== 'AWAITING_HUMAN' && state !== 'BLOCKED',
            `the project left the blocked states (${state})`);
        });
      }
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 2. The derived half: the CHECK is healthy, its subject is not
// ---------------------------------------------------------------------------------------------

test('unit H1: a check whose subject was replaced stops asking, though the check itself is fine',
  { skip }, async () => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      await emptyWorld(client);
      const target = await world(services.db, 'h1-subject');
      const successorId = await task(services.db, target, 'the fresh attempt');
      const subjectId = await task(services.db, target, 'the work', {
        status: TaskStatus.CANCELLED,
      });
      // OPEN, un-retired, and pointed at work that is about to be replaced.
      const checkId = await task(services.db, target, 'the check', { verifiesTaskId: subjectId });
      const branchSession = await session(services.db, target, {
        taskId: checkId,
        status: RunStatus.SUCCEEDED,
        branch: 'orbit/h1-check',
        mergeStatus: 'conflict',
        mergeTarget: 'main',
        changedFiles: [{ path: 'src/b.ts' }],
      });
      const parked = await session(services.db, target, {
        taskId: checkId,
        status: RunStatus.AWAITING_INPUT,
        startsTaskWork: false,
        finishedAt: null,
      });
      assert.ok(branchSession);

      await drainToIdle(services);
      assert.deepEqual(open(await blockers(services, target.projectId)), [
        `AWAITING_USER_INPUT:SESSION:${parked}`,
        `MERGE_CONFLICT:TASK:${checkId}`,
      ].sort(), 'a live check reports its own evidence');

      const before = await sessionRows(services, target.ownerId);
      await retire(services, subjectId, RETIREMENTS[0], successorId);
      await deliver(services, target.projectId, 'task.updated');

      assert.deepEqual(open(await blockers(services, target.projectId)), [],
        'the check can never run again, so its evidence asks nobody anything');
      assert.equal(await sessionRows(services, target.ownerId), before);
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 3. Atomicity: the database refuses a half-written retirement
// ---------------------------------------------------------------------------------------------

test('unit H1: a retirement is all four columns or none, so no pass can read a half-retired task',
  { skip }, async () => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      await emptyWorld(client);
      const target = await world(services.db, 'h1-atomic');
      const old = await replacedAttempt(services, target, 'h1-half');
      await drainToIdle(services);
      const openedAt = await blockers(services, target.projectId);
      assert.equal(open(openedAt).length, 2);

      // A retirement on a row that is not terminal: refused, so a task can never be readable as
      // retired by §11 and as OPEN by every list at the same time.
      await services.db.$executeRawUnsafe(
        `UPDATE "task" SET "status" = 'OPEN'::"task_status" WHERE "id" = $1::uuid`, old.taskId);
      await assert.rejects(
        () => services.db.$executeRawUnsafe(
          `UPDATE "task" SET "terminal_reason" = 'ABANDONED' WHERE "id" = $1::uuid`, old.taskId),
        /task_retirement_status_check|check constraint/i,
        'a reason without a terminal status is refused',
      );

      // And the refusal changed nothing: the rows are still open, and still asking.
      await deliver(services, target.projectId, 'task.updated');
      assert.deepEqual(open(await blockers(services, target.projectId)), [
        `AWAITING_USER_INPUT:SESSION:${old.salvageId}`,
        `MERGE_CONFLICT:TASK:${old.taskId}`,
      ].sort(), 'a refused retirement resolves nothing');
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 4. Redelivery: the same fact arriving again is not a second episode
// ---------------------------------------------------------------------------------------------

test('unit H1: repeated and duplicate events resolve the rows once and never re-open them',
  { skip }, async () => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      await emptyWorld(client);
      const target = await world(services.db, 'h1-dupe');
      const successorId = await task(services.db, target, 'the fresh attempt');
      const old = await replacedAttempt(services, target, 'h1-dupe-old');
      await drainToIdle(services);
      assert.equal(open(await blockers(services, target.projectId)).length, 2);

      await retire(services, old.taskId, RETIREMENTS[0], successorId);

      // The same dedupe key twice — what a producer that retries its commit sends — and then two
      // more passes on top. §11.4 recomputes from the world every time, so the answer has to be
      // the same answer, not a new episode of it.
      const key = 'h1:duplicate';
      await deliver(services, target.projectId, 'task.updated', key);
      await deliver(services, target.projectId, 'task.updated', key);
      await drainToIdle(services);
      await deliver(services, target.projectId, 'task.updated');

      const rows = await blockers(services, target.projectId);
      assert.deepEqual(open(rows), [], 'still resolved');
      assert.equal(rows.length, 2, 'two rows in the whole history, not one per delivery');
      for (const row of rows) {
        assert.equal(row.lifecycle_generation, '1', `${row.dedupe_key} is one episode`);
        assert.equal(row.resolved_by, 'AUTO', `${row.dedupe_key} resolved by the loop`);
      }
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 5. A settled task is NOT silenced — the decision this unit deliberately did not take
// ---------------------------------------------------------------------------------------------

test('unit H1: a DONE task keeps its merge blocker, because merging happens after DONE',
  { skip }, async () => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      await emptyWorld(client);
      const target = await world(services.db, 'h1-done');
      const doneId = await task(services.db, target, 'finished work', { status: TaskStatus.DONE });
      await session(services.db, target, {
        taskId: doneId,
        status: RunStatus.SUCCEEDED,
        branch: 'orbit/h1-done',
        mergeStatus: 'conflict',
        mergeTarget: 'main',
        changedFiles: [{ path: 'src/c.ts' }],
      });
      const parked = await session(services.db, target, {
        taskId: doneId,
        status: RunStatus.AWAITING_INPUT,
        startsTaskWork: false,
        finishedAt: null,
      });

      await drainToIdle(services);
      await deliver(services, target.projectId, 'task.updated');
      const rows = await blockers(services, target.projectId);

      assert.deepEqual(open(rows), [
        `AWAITING_USER_INPUT:SESSION:${parked}`,
        `MERGE_CONFLICT:TASK:${doneId}`,
      ].sort(), 'a finished task whose branch did not land is exactly when somebody must be told');
      for (const row of rows) {
        assert.equal(row.lifecycle_generation, '1', 'one episode, seen repeatedly — not re-raised');
        assert.ok(row.occurrences >= 2, 'and it is still being observed every pass');
      }
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 6. A real server restart does not re-raise what a previous process resolved
// ---------------------------------------------------------------------------------------------

test('unit H1: a resolved row stays resolved across a PostgreSQL restart',
  { skip: skip || !RESTART_COMMAND, timeout: 300_000 }, async () => {
    let projectId: string;
    let ownerId: string;
    let before: string;
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      await emptyWorld(client);
      const target = await world(services.db, 'h1-restart');
      projectId = target.projectId;
      ownerId = target.ownerId;
      const successorId = await task(services.db, target, 'the fresh attempt');
      const old = await replacedAttempt(services, target, 'h1-restart-old');
      await drainToIdle(services);
      assert.equal(open(await blockers(services, projectId)).length, 2);
      await retire(services, old.taskId, RETIREMENTS[2], successorId);
      await deliver(services, projectId, 'task.updated');
      assert.deepEqual(open(await blockers(services, projectId)), []);
      before = await sessionRows(services, ownerId);
    } finally {
      await client.end();
      await services.dispose();
    }

    execSync(RESTART_COMMAND!, { stdio: 'pipe' });

    // A process that has never seen this project, against a server that has just come back.
    const revived = servicesOn(URL!);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        try {
          await revived.db.$queryRawUnsafe('SELECT 1');
          ready = true;
        } catch {
          await new Promise((resolve) => { setTimeout(resolve, 1_000); });
        }
      }
      assert.ok(ready, 'the disposable server must come back');

      await deliver(revived, projectId, 'task.updated');
      await drainToIdle(revived);
      const rows = await blockers(revived, projectId);
      assert.deepEqual(open(rows), [], 'nothing is re-raised by a fresh process');
      assert.equal(rows.length, 2, 'and no second episode was opened');
      for (const row of rows) assert.equal(row.lifecycle_generation, '1');
      assert.equal(await sessionRows(revived, ownerId), before,
        'the history the rows were about is still byte-identical');
    } finally {
      await revived.dispose();
    }
  });
