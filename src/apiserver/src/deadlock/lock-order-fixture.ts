import type { Client } from 'pg';

import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import type { FixtureIds } from './orbit-lock-fixture';
import type { PlanStep, ScenarioSpec } from './pg-barrier';

/**
 * The 2026-08-21 cycles again, at the same timings, with the statements each path issues AFTER
 * the canonical lock order landed (`src/common/lock-order.ts`, `docs/postgres-lock-order.md`).
 *
 * `orbit-lock-fixture.ts` is the baseline: it holds the pre-fix statements and stays exactly as
 * it was, because it is the evidence for what production did. It cannot double as the regression,
 * because the fix changed the SQL — the point of it is that a Task transaction no longer takes a
 * Session lock in the middle of its Task writes, and that a runner events transaction no longer
 * writes its Session row twice. So this file states the post-fix statements beside the baseline
 * step each replaces, and the regression drives them through the SAME `pg-barrier.ts` scheduler,
 * from BOTH arrival orders, asserting that every party commits.
 *
 * Every scenario here reuses `seedLockFixture` / `seedThreePartyFixture`, so the rows, the
 * foreign keys and the triggers are the same ones the baseline runs on.
 */

/** `TasksService.lockDependencyGraph` → `lockOwnerTaskGraph`. Rank 10, unchanged by the fix. */
const LOCK_OWNER = 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE';

/**
 * `lockCreatorSessions` — rank 30, and the new statement. It takes exactly the mode
 * `task_creator_session_id_fkey` would have taken later on, in id order, in one statement.
 */
const LOCK_CREATOR_SESSIONS =
  'SELECT "id" FROM "session" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR KEY SHARE';

const INSERT_TASK = `
  INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id",
                      "creator_session_id", "project_id", "updated_at")
  VALUES ($1::uuid, $2, $3::uuid, 'AGENT'::creator_type, $4::uuid, $5::uuid, $6::uuid, CURRENT_TIMESTAMP)`;

const INSERT_DEPENDENCY = `
  INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
  VALUES ($1::uuid, $2::uuid, $3::uuid)`;

const UPDATE_TASK_STATUS = `
  UPDATE "task" SET "status" = $2::task_status, "updated_at" = $3
   WHERE "id" = $1::uuid`;

/** `RunnerApiController.lockSessionLeaseOwner`. Rank 30, unchanged by the fix. */
const LOCK_SESSION_LEASE_OWNER = `
  SELECT id, ("inbox_lease_owner" IS NOT DISTINCT FROM $2::uuid) AS "leaseOwnerMatches"
    FROM "session"
   WHERE id = $1::uuid AND "assigned_runner_id" = $3::uuid
   FOR UPDATE`;

const INSERT_RUN_EVENT = `
  INSERT INTO "run_event" ("id", "session_id", "seq", "type", "payload", "created_at")
  VALUES ($1::uuid, $2::uuid, 1, 'assistant', '{"text":"fixture"}'::jsonb, CURRENT_TIMESTAMP)
  ON CONFLICT DO NOTHING`;

/**
 * The events transaction's ONE Session write (I3), replacing the baseline's separate
 * telemetry-only update and preview denormalisation. Everything a batch changes about the row is
 * accumulated in the controller and issued here; a second write of the same row would re-run
 * every Session foreign key and take FOR KEY SHARE on `user`, `workspace`, `runner` and `task`.
 */
const SESSION_BATCH_UPDATE = `
  UPDATE "session"
     SET "last_turn_at" = $2, "last_assistant_text" = $3, "last_tool_use" = $4, "updated_at" = $2
   WHERE "id" = $1::uuid`;

/** The two arrival orders every scenario below is run in. */
export type Arrival = 'task-first' | 'runner-first';

export const ARRIVALS: readonly Arrival[] = ['task-first', 'runner-first'];

/**
 * One Task create against one runner events batch, on the Session the create names as its
 * creator — the two-party 05:53:11 pairing.
 *
 * Baseline (`twoPartyDeadlockScenario`): task-create wrote a Session row (A2), then asked for a
 * SECOND Session row through `task_creator_session_id_fkey` (A5), while runner-events held that
 * second row and wanted the first. Two Session rows, two transactions, opposite orders.
 *
 * Post-fix: the create takes the Session it will foreign-key check FIRST, in one ordered
 * statement, and takes no other Session lock at all. Whichever party arrives first holds the
 * Session and the other waits for it once — a wait, not a cycle, from either side.
 */
export function orderedCreateScenario(ids: FixtureIds, arrival: Arrival): ScenarioSpec {
  const task = [
    { label: 'T1 lock-owner-graph', sql: LOCK_OWNER, values: [ids.ownerId] },
    {
      label: 'T2 lock-creator-sessions',
      sql: LOCK_CREATOR_SESSIONS,
      values: [[ids.contendedSessionId]],
    },
  ];
  const taskWrites = [
    {
      label: 'T3 insert-task',
      sql: INSERT_TASK,
      values: [ids.victimTaskId, `${ids.label}-created`, ids.ownerId, ids.ownerId,
               ids.contendedSessionId, ids.projectId],
    },
    {
      label: 'T4 insert-task-dependency',
      sql: INSERT_DEPENDENCY,
      values: [ids.dependencyId, ids.victimTaskId, ids.prerequisiteTaskId],
    },
  ];
  const events = [
    {
      label: 'E1 lock-session-lease-owner',
      sql: LOCK_SESSION_LEASE_OWNER,
      values: [ids.contendedSessionId, null, ids.runnerId],
    },
    { label: 'E2 insert-run-event', sql: INSERT_RUN_EVENT, values: [ids.runEventId, ids.contendedSessionId] },
    {
      label: 'E3 session-batch-update',
      sql: SESSION_BATCH_UPDATE,
      values: [ids.telemetrySessionId, ids.survivorTurnAt, `${ids.label}-preview`, null],
    },
  ];
  return twoPartyPlan('ordered-create', ids, arrival, task, taskWrites, events);
}

/**
 * The same pairing for `createMany`: two Task rows and their edges under one owner mutex and one
 * ordered Session pre-lock. The batch is what makes multi-row ordering visible — it writes
 * several `task` rows in item order, which is why the owner mutex is unconditional for it.
 */
export function orderedBatchCreateScenario(ids: FixtureIds, arrival: Arrival): ScenarioSpec {
  const task = [
    { label: 'B1 lock-owner-graph', sql: LOCK_OWNER, values: [ids.ownerId] },
    {
      label: 'B2 lock-creator-sessions',
      sql: LOCK_CREATOR_SESSIONS,
      values: [[ids.contendedSessionId]],
    },
  ];
  const taskWrites = [
    {
      label: 'B3 insert-task-1',
      sql: INSERT_TASK,
      values: [ids.batchTaskId, `${ids.label}-batch-1`, ids.ownerId, ids.ownerId,
               ids.contendedSessionId, ids.projectId],
    },
    {
      label: 'B4 insert-task-2',
      sql: INSERT_TASK,
      values: [ids.victimTaskId, `${ids.label}-batch-2`, ids.ownerId, ids.ownerId,
               ids.contendedSessionId, ids.projectId],
    },
    {
      label: 'B5 insert-task-dependency',
      sql: INSERT_DEPENDENCY,
      values: [ids.dependencyId, ids.victimTaskId, ids.batchTaskId],
    },
  ];
  const events = [
    {
      label: 'E1 lock-session-lease-owner',
      sql: LOCK_SESSION_LEASE_OWNER,
      values: [ids.contendedSessionId, null, ids.runnerId],
    },
    { label: 'E2 insert-run-event', sql: INSERT_RUN_EVENT, values: [ids.runEventId, ids.contendedSessionId] },
    {
      label: 'E3 session-batch-update',
      sql: SESSION_BATCH_UPDATE,
      values: [ids.telemetrySessionId, ids.survivorTurnAt, `${ids.label}-preview`, null],
    },
  ];
  return twoPartyPlan('ordered-batch-create', ids, arrival, task, taskWrites, events);
}

interface Step { label: string; sql: string; values: unknown[] }

/**
 * The shared plan: the two parties race for one Session row, and the loser waits for it exactly
 * once. `arrival` decides which one gets there first, so the same statements are proven from both
 * directions rather than from whichever one happens to be convenient.
 */
function twoPartyPlan(
  name: string,
  ids: FixtureIds,
  arrival: Arrival,
  taskPreLocks: Step[],
  taskWrites: Step[],
  events: Step[],
): ScenarioSpec {
  const parties = [
    // Short on both sides: after the fix there is no cycle to detect, so a detector that fires is
    // reporting a real regression rather than costing the run time.
    { name: 'task-create', deadlockTimeout: '2s' },
    { name: 'runner-events', deadlockTimeout: '2s' },
  ];
  const run = (party: string, step: Step): PlanStep =>
    ({ op: 'run', party, label: step.label, sql: step.sql, values: step.values });

  if (arrival === 'task-first') {
    return {
      name: `${name}/task-first`,
      parties,
      plan: [
        ...taskPreLocks.map((s) => run('task-create', s)),
        // The events transaction wants the Session the create is holding FOR KEY SHARE. One
        // edge, in the direction the order predicts.
        { op: 'block', party: 'runner-events', label: events[0].label, sql: events[0].sql,
          values: events[0].values, blockedBy: ['task-create'] },
        ...taskWrites.map((s) => run('task-create', s)),
        { op: 'finish', party: 'task-create', action: 'COMMIT' },
        { op: 'settle', party: 'runner-events' },
        ...events.slice(1).map((s) => run('runner-events', s)),
        { op: 'finish', party: 'runner-events', action: 'COMMIT' },
      ],
    };
  }
  return {
    name: `${name}/runner-first`,
    parties,
    plan: [
      ...events.map((s) => run('runner-events', s)),
      run('task-create', taskPreLocks[0]),
      // The create holds the owner row and waits for the Session — the exact state that used to
      // close the cycle, because the events transaction's second Session write wanted that owner
      // row back. It writes the row once now, so it wants nothing and this is a plain wait.
      { op: 'block', party: 'task-create', label: taskPreLocks[1].label, sql: taskPreLocks[1].sql,
        values: taskPreLocks[1].values, blockedBy: ['runner-events'] },
      { op: 'finish', party: 'runner-events', action: 'COMMIT' },
      { op: 'settle', party: 'task-create' },
      ...taskWrites.map((s) => run('task-create', s)),
      { op: 'finish', party: 'task-create', action: 'COMMIT' },
    ],
  };
}

/**
 * The three-party 05:47:43 pairing, post-fix: a dependency mutation, a runner inbox batch on the
 * Session that mutation's Task was created from, and a second runner transaction on a different
 * Session.
 *
 * Baseline (`threePartyDeadlockScenario`): dependency → runner-inbox → telemetry → dependency,
 * where the last edge existed only because the telemetry transaction wrote its Session row twice
 * and the second write re-checked `session_owner_id_fkey` onto the owner row the dependency
 * transaction held FOR UPDATE.
 *
 * Post-0131, all three edges are gone, and two of them for a stronger reason than "taken in a
 * better order": the dependency mutation no longer touches a Session AT ALL. 0122's
 * `task_dependency_dispatch_touch` was what made an edge write re-write its dependent Task and so
 * re-check `task_creator_session_id_fkey`; 0131 advances `task_dependency_revision` instead, and
 * that row's only parent is the Task. The telemetry transaction writes its Session row once, so
 * it never asks for the owner either.
 *
 * So the shape this proves is not a drained chain but a DISJOINT one: the dependency party and
 * the two runner parties contend for nothing, and the only wait left in the plan is the one the
 * fix never claimed to remove — two writers of one Session row. `lock-order.pg.spec.ts` reads the
 * dependency backend's held relations out of that observation and asserts `session` is not among
 * them, which is the claim 0131 actually makes.
 */
export function orderedDependencyScenario(ids: FixtureIds, arrival: Arrival): ScenarioSpec {
  const parties = [
    { name: 'dependency', deadlockTimeout: '2s' },
    { name: 'runner-inbox', deadlockTimeout: '2s' },
    { name: 'telemetry', deadlockTimeout: '2s' },
  ];
  const dependencyWrites: PlanStep[] = [
    { op: 'run', party: 'dependency', label: 'D1 lock-owner-graph',
      sql: LOCK_OWNER, values: [ids.ownerId] },
    // Rank 40. The status write below fires `project_acceptance_task_fact_update`, which takes
    // this exact lock from an AFTER trigger; taking it here is what stops the transaction being
    // caught holding the Task while the Project authorization adapter waits for it.
    { op: 'run', party: 'dependency', label: 'D2 lock-project',
      sql: 'SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE', values: [ids.projectId] },
    { op: 'run', party: 'dependency', label: 'D3 update-task',
      sql: UPDATE_TASK_STATUS, values: [ids.dependentTaskId, 'IN_PROGRESS', ids.telemetryTurnAt] },
    // The step the baseline died on, and the reason the pre-lock that used to precede it is gone.
    // In the baseline this INSERT fired the dispatch touch, the touch re-wrote a Task row D3 had
    // already written, and that second write re-checked `task_creator_session_id_fkey` onto a
    // Session somebody else held. After 0131 it writes the edge and advances
    // `task_dependency_revision` — a row whose only foreign key is the Task this transaction is
    // already holding — so no Session is asked for and none is pre-locked.
    { op: 'run', party: 'dependency', label: 'D4 insert-task-dependency',
      sql: INSERT_DEPENDENCY, values: [ids.dependencyId, ids.dependentTaskId, ids.prerequisiteTaskId] },
  ];
  const inboxHead = {
    label: 'I1 lock-session-lease-owner',
    sql: LOCK_SESSION_LEASE_OWNER,
    values: [ids.contendedSessionId, null, ids.runnerId],
  };
  const telemetryArgs = (turnAt: Date, preview: string) => [ids.telemetrySessionId, turnAt, preview, null];

  if (arrival === 'task-first') {
    return {
      name: 'ordered-dependency/dependency-first',
      parties,
      plan: [
        // The dependency mutation goes ALL the way through — owner, project, Task, edge — while
        // the inbox owns the contended Session. In the baseline it could not: its edge insert
        // wanted that Session. Nothing here waits for anything the runner holds.
        ...dependencyWrites,
        { op: 'run', party: 'runner-inbox', ...inboxHead },
        { op: 'run', party: 'runner-inbox', label: 'I2 insert-run-event',
          sql: INSERT_RUN_EVENT, values: [ids.runEventId, ids.contendedSessionId] },
        { op: 'run', party: 'telemetry', label: 'P1 session-batch-update',
          sql: SESSION_BATCH_UPDATE, values: telemetryArgs(ids.telemetryTurnAt, `${ids.label}-telemetry`) },
        // The one edge the fix does not remove, and must not: two writers of the same Session
        // row. It is an ordinary FOR NO KEY UPDATE conflict with no trigger or FK in it. It is
        // also the observation the spec reads the dependency backend's lock set out of, which is
        // why it is taken while that transaction is still open.
        { op: 'block', party: 'runner-inbox', label: 'I3 session-batch-update',
          sql: SESSION_BATCH_UPDATE, values: telemetryArgs(ids.inboxTurnAt, `${ids.label}-inbox`),
          blockedBy: ['telemetry'] },
        { op: 'finish', party: 'dependency', action: 'COMMIT' },
        { op: 'finish', party: 'telemetry', action: 'COMMIT' },
        { op: 'settle', party: 'runner-inbox' },
        { op: 'finish', party: 'runner-inbox', action: 'COMMIT' },
      ],
    };
  }
  return {
    name: 'ordered-dependency/runner-first',
    parties,
    plan: [
      { op: 'run', party: 'runner-inbox', ...inboxHead },
      { op: 'run', party: 'runner-inbox', label: 'I2 insert-run-event',
        sql: INSERT_RUN_EVENT, values: [ids.runEventId, ids.contendedSessionId] },
      { op: 'run', party: 'telemetry', label: 'P1 session-batch-update',
        sql: SESSION_BATCH_UPDATE, values: telemetryArgs(ids.telemetryTurnAt, `${ids.label}-telemetry`) },
      // The baseline's closing edge came from here: the dependency mutation, arriving last,
      // asked for the Session the inbox owns and closed the ring. It does not ask any more — it
      // runs straight through with both runner transactions already holding their Sessions.
      ...dependencyWrites,
      // Taken after those writes, and before either side commits, so the observation carries the
      // dependency backend's lock set — which is the assertion this arrival exists to make from
      // the other direction.
      { op: 'block', party: 'runner-inbox', label: 'I3 session-batch-update',
        sql: SESSION_BATCH_UPDATE, values: telemetryArgs(ids.inboxTurnAt, `${ids.label}-inbox`),
        blockedBy: ['telemetry'] },
      { op: 'finish', party: 'dependency', action: 'COMMIT' },
      { op: 'finish', party: 'telemetry', action: 'COMMIT' },
      { op: 'settle', party: 'runner-inbox' },
      { op: 'finish', party: 'runner-inbox', action: 'COMMIT' },
    ],
  };
}

/**
 * `session_project_capacity_serialize`, kept and proven from both sides.
 *
 * The fence exists because Project/Agent admission counts Session rows: a Session entering or
 * leaving the live-claim set has to line up with the Project row lock the authorization adapter
 * takes, or a dispatch decision is made against a count that is already wrong. It is rank 40 of
 * the canonical order, taken by a transaction that already holds its Session at rank 30 — so it
 * is IN order, and the reason it is kept rather than narrowed further.
 *
 * `capacity` is the Session status write; `admission` is the adapter's
 * `SELECT … FROM "project" … FOR NO KEY UPDATE`.
 */
export function capacityFenceScenario(ids: FixtureIds, arrival: Arrival): ScenarioSpec {
  const parties = [
    { name: 'capacity', deadlockTimeout: '2s' },
    { name: 'admission', deadlockTimeout: '2s' },
  ];
  const lockSession = {
    label: 'C1 lock-session',
    sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
    values: [ids.telemetrySessionId],
  };
  // The write that moves the Session out of the live-claim set, so the BEFORE trigger's early
  // return does not fire and it really does take the Project row.
  const statusWrite = {
    label: 'C2 session-status-write',
    sql: `UPDATE "session" SET "status" = 'SUCCEEDED'::run_status, "finished_at" = $2, "updated_at" = $2
           WHERE "id" = $1::uuid`,
    values: [ids.telemetrySessionId, ids.telemetryTurnAt],
  };
  const admissionLock = {
    label: 'A1 lock-project',
    sql: 'SELECT "id" FROM "project" WHERE "id" = $1::uuid AND "owner_id" = $2::uuid FOR NO KEY UPDATE',
    values: [ids.projectId, ids.ownerId],
  };
  const admissionRead = {
    label: 'A2 read-task',
    sql: 'SELECT "id", "status"::text FROM "task" WHERE "id" = $1::uuid FOR SHARE',
    values: [ids.prerequisiteTaskId],
  };
  const run = (party: string, step: Step): PlanStep =>
    ({ op: 'run', party, label: step.label, sql: step.sql, values: step.values });

  if (arrival === 'task-first') {
    // The Session write gets there first: the adapter's project lock waits for the fence.
    return {
      name: 'capacity-fence/session-first',
      parties,
      plan: [
        run('capacity', lockSession),
        run('capacity', statusWrite),
        { op: 'block', party: 'admission', ...admissionLock, blockedBy: ['capacity'] },
        { op: 'finish', party: 'capacity', action: 'COMMIT' },
        { op: 'settle', party: 'admission' },
        run('admission', admissionRead),
        { op: 'finish', party: 'admission', action: 'COMMIT' },
      ],
    };
  }
  // The adapter gets there first: the Session write waits inside its BEFORE trigger, which is
  // the whole point — the count the adapter is reading cannot move under it.
  return {
    name: 'capacity-fence/admission-first',
    parties,
    plan: [
      run('admission', admissionLock),
      run('admission', admissionRead),
      run('capacity', lockSession),
      { op: 'block', party: 'capacity', ...statusWrite, blockedBy: ['admission'] },
      { op: 'finish', party: 'admission', action: 'COMMIT' },
      { op: 'settle', party: 'capacity' },
      { op: 'finish', party: 'capacity', action: 'COMMIT' },
    ],
  };
}

/**
 * Two reverse edges written at once — A→B and B→A — which is what the owner graph mutex exists
 * for. `first` writes its edge under the mutex; `second` blocks on the mutex, and only once
 * `first` has committed does it get to read the graph, so it sees the edge that would close the
 * loop instead of the snapshot from before it.
 *
 * The barrier makes that deterministic. The assertion that matters is on the READ `second` does
 * after it is unblocked: it has to return `first`'s edge.
 */
export function reverseCycleScenario(ids: FixtureIds, secondTaskId: string): ScenarioSpec {
  return {
    name: 'reverse-cycle/owner-mutex',
    parties: [
      { name: 'first', deadlockTimeout: '2s' },
      { name: 'second', deadlockTimeout: '2s' },
    ],
    plan: [
      { op: 'run', party: 'first', label: 'F1 lock-owner-graph', sql: LOCK_OWNER, values: [ids.ownerId] },
      { op: 'run', party: 'first', label: 'F2 insert-edge', sql: INSERT_DEPENDENCY,
        values: [ids.dependencyId, ids.dependentTaskId, ids.prerequisiteTaskId] },
      { op: 'block', party: 'second', label: 'S1 lock-owner-graph', sql: LOCK_OWNER,
        values: [ids.ownerId], blockedBy: ['first'] },
      { op: 'finish', party: 'first', action: 'COMMIT' },
      { op: 'settle', party: 'second' },
      { op: 'run', party: 'second', label: 'S2 read-graph',
        sql: 'SELECT "task_id", "depends_on_task_id" FROM "task_dependency" WHERE "id" = $1::uuid',
        values: [ids.dependencyId] },
      { op: 'run', party: 'second', label: 'S3 insert-reverse-edge', sql: INSERT_DEPENDENCY,
        values: [secondTaskId, ids.prerequisiteTaskId, ids.dependentTaskId] },
      { op: 'finish', party: 'second', action: 'ROLLBACK' },
    ],
  };
}

/** The statuses a telemetry-only Session write is filtered on, kept in step with the service. */
export const OPEN_STATUSES = OPEN_SESSION_STATUSES;

/** Read the relations one backend holds a row-lock projection on, for an I3 lock-set assertion. */
export async function heldRelations(client: Client, pid: number): Promise<string[]> {
  const { rows } = await client.query<{ rel: string }>(
    `SELECT DISTINCT l.relation::regclass::text AS rel
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = $1 AND l.locktype = 'relation' AND c.relkind = 'r'
        AND l.mode IN ('RowShareLock', 'RowExclusiveLock')
      ORDER BY 1`,
    [pid],
  );
  return rows.map((r) => r.rel.replace(/"/g, ''));
}
