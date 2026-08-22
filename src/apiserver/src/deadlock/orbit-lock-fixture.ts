import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import type { ScenarioSpec } from './pg-barrier';

/**
 * The Orbit half of the barrier fixture: the rows the production lock edges are taken on, and
 * the plan that reproduces the 2026-08-21 05:53:11 two-party deadlock on them.
 *
 * Every statement below is the SQL a production path already issues, cited at its source. The
 * fixture composes them; it does not invent lock modes.
 *
 *   task-create (the production victim)
 *     A1  SELECT "user" … FOR UPDATE          TasksService.lockDependencyGraph (tasks.service.ts)
 *     A2  UPDATE "session" SET last_turn_at    the telemetry-only Session write of the runner
 *                                              events transaction (runner-api.controller.ts)
 *     A3  INSERT "task"                        TasksService.create → tx.task.create
 *     A4  INSERT "task_dependency"             TasksService.create → tx.taskDependency.createMany
 *     A5  INSERT "task" (creator_session_id)   the same insert, this time naming the contended
 *                                              Session — task_creator_session_id_fkey makes the
 *                                              row check take FOR KEY SHARE on that Session
 *
 *   runner-events (the production survivor)
 *     B1  SELECT "session" … FOR UPDATE        RunnerApiController.lockSessionLeaseOwner
 *     B2  INSERT "run_event"                   the events transaction's durable event write
 *     B3  UPDATE "session" SET last_turn_at    the same telemetry-only Session write as A2
 *
 * The cycle: A holds the telemetry Session row A2 wrote and wants FOR KEY SHARE on the Session
 * B holds FOR UPDATE; B holds that Session and wants the telemetry row A holds. FOR KEY SHARE
 * conflicts with FOR UPDATE and with nothing weaker, which is why the FK check is what waits.
 */

/** Row identities for one round. Every round gets fresh ids so rounds cannot interfere. */
export interface FixtureIds {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The Session named by the victim task's creator_session_id, and locked FOR UPDATE by events. */
  contendedSessionId: string;
  /** The Session both transactions write telemetry to. */
  telemetrySessionId: string;
  /** A committed task: the prerequisite edge target, and the telemetry Session's task. */
  prerequisiteTaskId: string;
  /** Written by the victim before it blocks — the row a failed rollback would leave behind. */
  batchTaskId: string;
  /** The insert that blocks on task_creator_session_id_fkey. */
  victimTaskId: string;
  dependencyId: string;
  runEventId: string;
  /** last_turn_at the survivor writes; distinguishable from the victim's. */
  survivorTurnAt: Date;
  victimTurnAt: Date;
}

export function newFixtureIds(label: string): FixtureIds {
  return {
    label,
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    contendedSessionId: randomUUID(),
    telemetrySessionId: randomUUID(),
    prerequisiteTaskId: randomUUID(),
    batchTaskId: randomUUID(),
    victimTaskId: randomUUID(),
    dependencyId: randomUUID(),
    runEventId: randomUUID(),
    victimTurnAt: new Date('2026-08-21T05:53:11.000Z'),
    survivorTurnAt: new Date('2026-08-21T05:53:12.000Z'),
  };
}

/** The telemetry-only Session write, as Prisma emits it for the events transaction's
 *  `session.updateMany({ where: { id, cancelRequestedAt: null, status: { in: OPEN } }, … })`. */
const TELEMETRY_SESSION_UPDATE = `
  UPDATE "session" SET "last_turn_at" = $2, "updated_at" = $2
   WHERE "id" = $1::uuid
     AND "cancel_requested_at" IS NULL
     AND "status" = ANY($3::run_status[])`;

const INSERT_TASK = `
  INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id",
                      "creator_session_id", "project_id", "updated_at")
  VALUES ($1::uuid, $2, $3::uuid, 'AGENT'::creator_type, $4::uuid, $5::uuid, $6::uuid, CURRENT_TIMESTAMP)`;

/** Create the owner, runner, workspace, project, both Sessions and the prerequisite task. */
export async function seedLockFixture(client: Client, ids: FixtureIds): Promise<void> {
  try {
    await seed(client, ids);
  } catch (e) {
    // Without this the connection is left in an aborted transaction and every later round fails
    // for a reason that has nothing to do with the round.
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

async function seed(client: Client, ids: FixtureIds): Promise<void> {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO "user" ("id", "email", "name", "password_hash")
     VALUES ($1::uuid, $2, $3, 'x')`,
    [ids.ownerId, `${ids.label}-${ids.ownerId}@pcc40p01.invalid`, ids.label],
  );
  await client.query(
    `INSERT INTO "runner" ("id", "owner_id", "name", "token_hash", "status")
     VALUES ($1::uuid, $2::uuid, $3, 'x', 'ONLINE'::runner_status)`,
    [ids.runnerId, ids.ownerId, `${ids.label}-runner`],
  );
  await client.query(
    `INSERT INTO "workspace" ("id", "owner_id", "name", "runner_id")
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid)`,
    [ids.workspaceId, ids.ownerId, `${ids.label}-workspace`, ids.runnerId],
  );
  await client.query(
    `INSERT INTO "project" ("id", "owner_id", "title", "updated_at")
     VALUES ($1::uuid, $2::uuid, $3, CURRENT_TIMESTAMP)`,
    [ids.projectId, ids.ownerId, `${ids.label}-project`],
  );
  await client.query(INSERT_TASK, [
    ids.prerequisiteTaskId,
    `${ids.label}-prerequisite`,
    ids.ownerId,
    ids.ownerId,
    null,
    ids.projectId,
  ]);
  for (const [id, taskId] of [
    [ids.contendedSessionId, null],
    // The telemetry Session carries a project task, so the AFTER UPDATE event-source trigger
    // runs its real body (it looks the project up through session.task_id) instead of
    // short-circuiting on a NULL.
    [ids.telemetrySessionId, ids.prerequisiteTaskId],
  ] as Array<[string, string | null]>) {
    await client.query(
      `INSERT INTO "session" ("id", "title", "prompt", "owner_id", "creator_id", "assigned_runner_id",
                              "workspace_id", "task_id", "status", "updated_at")
       VALUES ($1::uuid, $2, 'fixture', $3::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
               'RUNNING'::run_status, CURRENT_TIMESTAMP)`,
      [id, `${ids.label}-session`, ids.ownerId, ids.runnerId, ids.workspaceId, taskId],
    );
  }
  await client.query('COMMIT');
}

/**
 * The 2026-08-21 05:53:11 two-party cycle.
 *
 * `deadlockTimeout` is what pins the victim. PostgreSQL aborts whichever backend runs the
 * deadlock check that finds the cycle, so a survivor whose detector never fires within the run
 * cannot be chosen — the victim is decided by configuration, not by who happened to arrive
 * first. Production's victim was Task creation, so `task-create` is the party that detects.
 */
export function twoPartyDeadlockScenario(ids: FixtureIds): ScenarioSpec {
  const telemetryArgs = (turnAt: Date) => [ids.telemetrySessionId, turnAt, OPEN_SESSION_STATUSES];
  return {
    name: 'two-party/task-create-vs-runner-events',
    parties: [
      { name: 'task-create', deadlockTimeout: '2s' },
      { name: 'runner-events', deadlockTimeout: '30min' },
    ],
    plan: [
      { op: 'run', party: 'task-create', label: 'A1 lock-dependency-graph',
        sql: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE', values: [ids.ownerId] },
      { op: 'run', party: 'task-create', label: 'A2 telemetry-session-update',
        sql: TELEMETRY_SESSION_UPDATE, values: telemetryArgs(ids.victimTurnAt) },
      { op: 'run', party: 'task-create', label: 'A3 insert-task',
        sql: INSERT_TASK,
        values: [ids.batchTaskId, `${ids.label}-batch`, ids.ownerId, ids.ownerId, null, ids.projectId] },
      { op: 'run', party: 'task-create', label: 'A4 insert-task-dependency',
        sql: `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
              VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        values: [ids.dependencyId, ids.batchTaskId, ids.prerequisiteTaskId] },

      { op: 'run', party: 'runner-events', label: 'B1 lock-session-lease-owner',
        sql: `SELECT id, ("inbox_lease_owner" IS NOT DISTINCT FROM $2::uuid) AS "leaseOwnerMatches"
                FROM "session"
               WHERE id = $1::uuid AND "assigned_runner_id" = $3::uuid
               FOR UPDATE`,
        values: [ids.contendedSessionId, null, ids.runnerId] },
      { op: 'run', party: 'runner-events', label: 'B2 insert-run-event',
        sql: `INSERT INTO "run_event" ("id", "session_id", "seq", "type", "payload", "created_at")
              VALUES ($1::uuid, $2::uuid, 1, 'assistant', '{"text":"fixture"}'::jsonb, CURRENT_TIMESTAMP)
              ON CONFLICT DO NOTHING`,
        values: [ids.runEventId, ids.contendedSessionId] },

      // Edge 1: the events transaction, already holding the contended Session FOR UPDATE, waits
      // for the telemetry Session row the task-create transaction wrote.
      { op: 'block', party: 'runner-events', label: 'B3 telemetry-session-update',
        sql: TELEMETRY_SESSION_UPDATE, values: telemetryArgs(ids.survivorTurnAt),
        blockedBy: ['task-create'] },
      // Edge 2 closes the cycle: task_creator_session_id_fkey makes this insert take FOR KEY
      // SHARE on the Session the events transaction holds FOR UPDATE.
      { op: 'block', party: 'task-create', label: 'A5 insert-task-creator-session',
        sql: INSERT_TASK,
        values: [ids.victimTaskId, `${ids.label}-victim`, ids.ownerId, ids.ownerId,
                 ids.contendedSessionId, ids.projectId],
        blockedBy: ['runner-events'] },

      { op: 'settle', party: 'task-create' },
      { op: 'finish', party: 'task-create', action: 'ROLLBACK' },
      { op: 'settle', party: 'runner-events' },
      { op: 'finish', party: 'runner-events', action: 'COMMIT' },
    ],
  };
}

export interface VictimRollback {
  tasks: number;
  dependencies: number;
  projectEvents: number;
  dispatchActions: number;
  prerequisiteTouched: boolean;
}

/** Nothing the victim wrote may survive: not the task rows, not the dependency edge, not the
 *  project_event rows their triggers enqueued, not a dispatch action, and not the
 *  `task_dependency_dispatch_touch` bump of an unrelated task's updated_at. */
export async function inspectVictimRollback(client: Client, ids: FixtureIds): Promise<VictimRollback> {
  const doomed = [ids.batchTaskId, ids.victimTaskId];
  const one = async (sql: string, values: unknown[]): Promise<number> => {
    const { rows } = await client.query<{ n: string }>(sql, values as never);
    return Number(rows[0].n);
  };
  // Seeded in one statement, so the two timestamps start out equal; anything that bumped
  // updated_at afterwards — task_dependency_dispatch_touch above all — separates them.
  const { rows: prereq } = await client.query<{ touched: boolean }>(
    `SELECT ("updated_at" <> "created_at") AS touched FROM "task" WHERE "id" = $1::uuid`,
    [ids.prerequisiteTaskId],
  );
  return {
    tasks: await one(`SELECT count(*) AS n FROM "task" WHERE "id" = ANY($1::uuid[])`, [doomed]),
    dependencies: await one(
      `SELECT count(*) AS n FROM "task_dependency"
        WHERE "task_id" = ANY($1::uuid[]) OR "depends_on_task_id" = ANY($1::uuid[])`,
      [doomed],
    ),
    projectEvents: await one(
      `SELECT count(*) AS n FROM "project_event" WHERE "source_id" = ANY($1::uuid[])`,
      [doomed],
    ),
    dispatchActions: await one(
      `SELECT count(*) AS n FROM "project_action" WHERE "subject_id" = ANY($1::uuid[])`,
      [doomed],
    ),
    prerequisiteTouched: prereq[0]?.touched ?? true,
  };
}

export interface SurvivorState {
  runEvents: number;
  telemetryLastTurnAt: string | null;
}

/** What the surviving transaction committed. */
export async function inspectSurvivor(client: Client, ids: FixtureIds): Promise<SurvivorState> {
  const { rows: events } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM "run_event" WHERE "id" = $1::uuid`,
    [ids.runEventId],
  );
  const { rows: session } = await client.query<{ last_turn_at: Date | null }>(
    `SELECT "last_turn_at" FROM "session" WHERE "id" = $1::uuid`,
    [ids.telemetrySessionId],
  );
  return {
    runEvents: Number(events[0].n),
    telemetryLastTurnAt: session[0]?.last_turn_at?.toISOString() ?? null,
  };
}
