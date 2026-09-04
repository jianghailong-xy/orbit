import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import { establishProjectContractWithPgClientForTest } from '../projects/project-contract-test-helper';
import { historicalTouchSql } from './pre-0132-dispatch-touch';

/**
 * A Project Coordinator dispatch, and the dependency mutations that race it, as the statements
 * each side actually issues.
 *
 * Written at the SQL level for the same reason the 40P01 fixtures are: the property under test is
 * which locks are taken and in what order, and that is not visible through a service call. The
 * statements here mirror `ProjectAuthorizationService.authorizeInTransaction`,
 * `ProjectTaskDispatcherService.dispatchInTransaction` and `TasksService.addDependency`;
 * `dependency-revision.pg.spec.ts` asserts each of those sources still contains its half, so the
 * fixture cannot quietly drift into replaying a dispatch this repo no longer performs.
 *
 * The Session insert goes through every guard 0122 installed — the authority gate, the frozen
 * snapshot check, and both deferred attribution triggers — because a fixture that bypassed them
 * would prove nothing about the one 0132 adds beside them.
 */

export interface RevisionIds {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The task a dispatch is attempted for. */
  dependentTaskId: string;
  /** A prerequisite that is already DONE: an edge onto it does not block a dispatch. */
  doneTaskId: string;
  /** A prerequisite that is OPEN: an edge onto it does. */
  openTaskId: string;
  actionId: string;
  sessionId: string;
}

export function newRevisionIds(label: string): RevisionIds {
  return {
    label,
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    dependentTaskId: randomUUID(),
    doneTaskId: randomUUID(),
    openTaskId: randomUUID(),
    actionId: randomUUID(),
    sessionId: randomUUID(),
  };
}

const INSERT_TASK = `
  INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "project_id",
                      "status", "updated_at", "completion_criterion")
  VALUES ($1::uuid, $2, $3::uuid, 'USER', $3::uuid, $4::uuid, $5::task_status, CURRENT_TIMESTAMP, 'EVIDENCE_JUDGMENT')`;

/** One more Task in the fixture's Project — for the cases that need a second dependent. */
export async function insertTask(
  client: Client,
  ids: RevisionIds,
  taskId: string,
  title: string,
  status: 'OPEN' | 'DONE' = 'OPEN',
): Promise<void> {
  await client.query(INSERT_TASK, [taskId, `${ids.label}-${title}`, ids.ownerId, ids.projectId, status]);
}

/**
 * An owner, a runner, an agent, a coordinator-enabled Project with its runtime row, and three
 * tasks: the dispatch subject, a DONE prerequisite and an OPEN one.
 *
 * `coordinator_enabled` is set on the Project BEFORE the tasks are inserted, so
 * `task_dispatch_authority_derive` gives them COORDINATOR authority at birth rather than through
 * the fan-out — the state a real coordinated Project is in by the time anything dispatches.
 */
export async function seedRevisionFixture(client: Client, ids: RevisionIds): Promise<void> {
  try {
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
      `INSERT INTO "project" ("id", "owner_id", "title", "goal", "coordinator_enabled", "updated_at")
       VALUES ($1::uuid, $2::uuid, $3, 'prove the dependency dispatch fence', true, CURRENT_TIMESTAMP)`,
      [ids.projectId, ids.ownerId, `${ids.label}-project`],
    );
    await client.query(
      `INSERT INTO "project_acceptance_criterion_definition" (
         "id", "project_id", "ordinal", "text", "verification_method",
         "content_hash", "semantic_hash"
       ) VALUES (
         gen_random_uuid(), $1::uuid, 1, 'dependency dispatch remains fenced',
         'exercise both observed PostgreSQL commit orders',
         repeat('a', 64), repeat('b', 64)
       )`,
      [ids.projectId],
    );
    await client.query(
      `INSERT INTO "project_runtime" ("project_id", "fencing_token", "updated_at")
       VALUES ($1::uuid, 1, CURRENT_TIMESTAMP)`,
      [ids.projectId],
    );
    await client.query(
      `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'COORDINATOR')`,
      [ids.projectId, ids.workspaceId],
    );
    for (const [id, title, status] of [
      [ids.dependentTaskId, 'dependent', 'OPEN'],
      [ids.doneTaskId, 'done-prerequisite', 'DONE'],
      [ids.openTaskId, 'open-prerequisite', 'OPEN'],
    ] as Array<[string, string, string]>) {
      await client.query(INSERT_TASK, [
        id, `${ids.label}-${title}`, ids.ownerId, ids.projectId, status,
      ]);
    }
    await client.query(
      `UPDATE "task" SET "assignee_id" = $2::uuid WHERE "id" = $1::uuid`,
      [ids.dependentTaskId, ids.workspaceId],
    );
    await establishProjectContractWithPgClientForTest(client, ids.ownerId, ids.projectId, ids.label);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/**
 * The CLAIMED dispatch action a Session is minted against, with the frozen execution context
 * `session_coordinator_snapshot_guard` verifies.
 *
 * Both digests are computed by `coordinator_json_digest` — the database's own function, which is
 * deliberately also the application's oracle — so the fixture cannot disagree with the guard about
 * what the canonical serialisation of a context is.
 */
export async function claimDispatchAction(client: Client, ids: RevisionIds): Promise<void> {
  await client.query(
    `INSERT INTO "project_action" ("id", "project_id", "idempotency_key", "type", "status",
       "subject_type", "subject_id", "fencing_token", "detail", "execution_context",
       "execution_context_digest", "execution_result_digest", "updated_at")
     SELECT $1::uuid, $2::uuid, $3, 'DISPATCH_TASK', 'CLAIMED', 'TASK', $4::uuid, 1, '{}'::jsonb,
            ctx,
            "coordinator_json_digest"(ctx -> 'authorization'),
            "coordinator_json_digest"(ctx - 'authorization'),
            CURRENT_TIMESTAMP
       FROM (SELECT jsonb_build_object(
               'authorization', jsonb_build_object('decision', 'ALLOW'),
               'result', jsonb_build_object(
                 'provider', 'claude',
                 'model', NULL,
                 'workspaceId', $5::text,
                 'runnerId', $6::text,
                 'permissionMode', NULL,
                 'requiredCapabilities', '[]'::jsonb,
                 'resolution', jsonb_build_object('v', 1))) AS ctx) frozen`,
    [
      ids.actionId,
      ids.projectId,
      `pc:v1:${ids.projectId}:${ids.label}`,
      ids.dependentTaskId,
      ids.workspaceId,
      ids.runnerId,
    ],
  );
}

/**
 * `ProjectTaskDispatcherService.dispatchInTransaction`, first statement: rank 10 and rank 50 in
 * one go. The owner row is taken at exactly the mode this transaction's Session insert will take
 * it at later (I2), so a dispatch is never caught holding rank 70 while it asks for rank 10.
 *
 * `dispatchSteps({ preLockOwner: false })` drops the owner half — which is how the spec shows
 * that without it the pair is a 40P01, rather than asserting it from the shape of the SQL.
 */
export const LOCK_OWNER_AND_SUBJECT_TASK = `
  SELECT t."id" FROM "task" t JOIN "user" u ON u."id" = t."owner_id"
   WHERE t."id" = $1::uuid FOR KEY SHARE OF u FOR SHARE OF t`;
export const LOCK_SUBJECT_TASK =
  'SELECT t."id" FROM "task" t WHERE t."id" = $1::uuid FOR SHARE OF t';

/** `ProjectAuthorizationService.authorizeInTransaction`, first statement: rank 40. */
export const LOCK_PROJECT =
  'SELECT p."id" FROM "project" p WHERE p."id" = $1::uuid FOR NO KEY UPDATE OF p';

/** The prerequisite set, locked at rank 50/60 before it is interpreted. */
export const LOCK_EDGES = `
  SELECT d."task_id", prerequisite."id"
    FROM "task_dependency" d
    JOIN "task" prerequisite ON prerequisite."id" = d."depends_on_task_id"
   WHERE d."task_id" = $1::uuid
   ORDER BY prerequisite."id"
   FOR SHARE OF d, prerequisite`;

/** Rank 70, and the statement an old apiserver replica does not issue. */
export const LOCK_DEPENDENCY_REVISION = `
  SELECT r."revision" FROM "task_dependency_revision" r
   WHERE r."task_id" = $1::uuid
   FOR SHARE`;

/** The admission fact the whole boundary exists to keep true. */
export const COUNT_INCOMPLETE_PREREQUISITES = `
  SELECT count(*)::int AS "incomplete" FROM "task_dependency" d
    JOIN "task" prerequisite ON prerequisite."id" = d."depends_on_task_id"
   WHERE d."task_id" = $1::uuid
     AND prerequisite."owner_id" = $2::uuid
     AND prerequisite."status"::text <> 'DONE'`;

/** `TasksService.addDependency`: rank 10, then the edge. Nothing else since 0132. */
export const LOCK_OWNER_GRAPH = 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE';
export const INSERT_EDGE = `
  INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
  VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`;
export const DELETE_EDGE =
  'DELETE FROM "task_dependency" WHERE "task_id" = $1::uuid AND "depends_on_task_id" = $2::uuid';

/**
 * The Session insert and the action's APPLIED transition, as one dispatch performs them: the
 * insert first (the authority gate and the snapshot guard run BEFORE it), then the link that both
 * deferred attribution triggers verify at COMMIT — where `session_dispatch_dependency_check` also
 * runs.
 */
export const INSERT_COORDINATOR_SESSION = `
  INSERT INTO "session" ("id", "title", "prompt", "status", "provider", "provider_builtin",
    "uses_runtime_default_model", "source", "creator_id", "owner_id", "task_id", "workspace_id",
    "assigned_runner_id", "project_action_id", "dispatch_origin", "run_source", "resolution",
    "snapshot_frozen_at", "updated_at")
  VALUES ($1::uuid, 'dispatch', 'dispatch', 'PENDING', 'claude', true, true, 'user',
    $2::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
    'PROJECT_COORDINATOR', 'PROJECT_COORDINATOR', '{"v": 1}'::jsonb,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
export const APPLY_DISPATCH_ACTION = `
  UPDATE "project_action"
     SET "status" = 'APPLIED', "result_session_id" = $2::uuid, "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = $1::uuid`;

/** Every statement a dispatch issues against one task, in the order it issues them. */
export function dispatchSteps(
  ids: RevisionIds,
  opts: { takeRevisionLock: boolean; preLockOwner?: boolean },
): Array<{ label: string; sql: string; values: unknown[] }> {
  return [
    { label: 'lock-subject-task',
      sql: opts.preLockOwner === false ? LOCK_SUBJECT_TASK : LOCK_OWNER_AND_SUBJECT_TASK,
      values: [ids.dependentTaskId] },
    { label: 'lock-project', sql: LOCK_PROJECT, values: [ids.projectId] },
    { label: 'lock-edges', sql: LOCK_EDGES, values: [ids.dependentTaskId] },
    ...(opts.takeRevisionLock
      ? [{ label: 'lock-dependency-revision', sql: LOCK_DEPENDENCY_REVISION,
           values: [ids.dependentTaskId] as unknown[] }]
      : []),
  ];
}

/**
 * The documented down-migration for 0132, executable so that "the rollback works" is a test
 * result rather than a paragraph. `docs/task-dependency-revision.md` points here rather than
 * repeating it, because a rollback nobody has run is a guess.
 *
 * It restores 0122's touch before dropping the revision: on the way back, the boundary has to
 * exist at every instant, or a dispatch in flight during the rollback would have none. The touch
 * itself is read out of 0122 rather than retyped here, so a rollback can never restore a trigger
 * production did not have.
 */
export const ROLLBACK_0132 = `
  ${historicalTouchSql()}

  DROP TRIGGER "session_dispatch_dependency_check" ON "session";
  DROP FUNCTION "session_dispatch_dependency_check"();
  DROP TRIGGER "task_dependency_revision_insert" ON "task_dependency";
  DROP TRIGGER "task_dependency_revision_update" ON "task_dependency";
  DROP TRIGGER "task_dependency_revision_delete" ON "task_dependency";
  DROP FUNCTION "task_dependency_revision_bump_insert"();
  DROP FUNCTION "task_dependency_revision_bump_update"();
  DROP FUNCTION "task_dependency_revision_bump_delete"();
  DROP FUNCTION "task_dependency_revision_advance"(UUID[]);
  DROP TRIGGER "task_dependency_revision_seed" ON "task";
  DROP FUNCTION "task_dependency_revision_seed"();
  DROP TABLE "task_dependency_revision";
`;

export async function revisionOf(client: Client, taskId: string): Promise<number | null> {
  const { rows } = await client.query<{ revision: string }>(
    'SELECT "revision"::text AS revision FROM "task_dependency_revision" WHERE "task_id" = $1::uuid',
    [taskId],
  );
  return rows.length === 0 ? null : Number(rows[0].revision);
}

export async function liveSessionCount(client: Client, taskId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "session"
      WHERE "task_id" = $1::uuid AND "deleted_at" IS NULL`,
    [taskId],
  );
  return Number(rows[0].n);
}
