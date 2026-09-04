import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Client } from 'pg';

/**
 * The rows and the two statements that make `task_dispatch_epoch`'s acquisition order observable.
 *
 * At the SQL level, like the other fixtures here, because the property under test is WHICH LOCKS a
 * statement takes and in what order — and that is not visible through a service call. The two
 * writes are ordinary `task` status updates: a task reaching DONE, a sweep clearing FAILED. Nothing
 * about the cycle needs a Project, a Session or a dependency cycle, which is the point.
 */

export interface EpochIds {
  label: string;
  ownerId: string;
  /** Three tasks, named by their SORT order — `a` < `b` < `c` as PostgreSQL compares uuid. */
  a: string;
  b: string;
  c: string;
}

/**
 * Three ids in a known order, because the whole question is what "sorted" means.
 *
 * PostgreSQL compares `uuid` by bytes and the canonical hex spelling sorts identically, so sorting
 * the strings here IS the order `ORDER BY task_id` will take.
 */
export function newEpochIds(label: string): EpochIds {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()].sort();
  return { label, ownerId: randomUUID(), a, b, c };
}

/**
 * An owner and three PROJECT-LESS tasks in a chain: `b` depends on `a`, `c` depends on `b`.
 *
 * No cycle anywhere — that is the finding. The 0137 two-pass advance can be made to deadlock by an
 * ordinary chain, so nothing here has to construct a dependency cycle the application forbids.
 *
 * Project-less deliberately: a task with a Project would fire `task_acceptance_fact_lock_order`,
 * `project_acceptance_task_fact` and `project_task_event_source` on the same status write, each of
 * which takes or writes the Project. All three return immediately on a NULL `project_id`, so what
 * is left in the wait graph is exactly the epoch table.
 */
export async function seedEpochFixture(client: Client, ids: EpochIds): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "user" ("id", "email", "name", "password_hash")
       VALUES ($1::uuid, $2, $3, 'x')`,
      [ids.ownerId, `${ids.label}-${ids.ownerId}@pcc40p01.invalid`, ids.label],
    );
    for (const [id, title] of [[ids.a, 'a'], [ids.b, 'b'], [ids.c, 'c']] as Array<[string, string]>) {
      await client.query(
        `INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "status",
                            "updated_at", "completion_criterion")
         VALUES ($1::uuid, $2, $3::uuid, 'USER', $3::uuid, 'OPEN'::task_status, CURRENT_TIMESTAMP, 'EVIDENCE_JUDGMENT')`,
        [id, `${ids.label}-${title}`, ids.ownerId],
      );
    }
    // The chain. `b` waits on `a`, `c` waits on `b` — so the dependents of `a` are `{b}` and the
    // dependents of `b` are `{c}`, which is what puts a dependent BETWEEN two own rows in sort
    // order and makes `sorted(own) ++ sorted(dependents)` disagree with `sorted(own ∪ dependents)`.
    for (const [dependent, prerequisite] of [[ids.b, ids.a], [ids.c, ids.b]] as Array<[string, string]>) {
      await client.query(
        `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`,
        [dependent, prerequisite],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** Every epoch this fixture's tasks are at, by id. */
export async function epochsOf(client: Client, ids: EpochIds): Promise<Map<string, bigint>> {
  const { rows } = await client.query<{ task_id: string; epoch: string }>(
    `SELECT "task_id", "epoch"::text AS epoch FROM "task_dispatch_epoch"
      WHERE "task_id" = ANY($1::uuid[])`,
    [[ids.a, ids.b, ids.c]],
  );
  return new Map(rows.map((row) => [row.task_id, BigInt(row.epoch)]));
}

/** Take one epoch row and hold it, which is how a round is given a deterministic starting point. */
export const HOLD_EPOCH_ROW =
  'SELECT 1 FROM "task_dispatch_epoch" WHERE "task_id" = $1::uuid FOR NO KEY UPDATE';

/**
 * An ordinary multi-row Task status write — the shape `updateMany` produces, and the shape a
 * statement-level trigger with a transition table exists to see.
 */
export const WRITE_STATUS =
  `UPDATE "task" SET "status" = 'IN_PROGRESS'::task_status, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ANY($1::uuid[])`;

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

/**
 * The body a named migration gives a named function, lifted out of the migration itself.
 *
 * EXTRACTED rather than transcribed. The control round installs 0137's advance to prove it really
 * does deadlock, and a hand-copied control is one that keeps saying so after somebody changes the
 * real thing — a green "the fix works" that is measuring a fixture. Reading the file means the
 * control is the deployed function or the test fails to find it.
 */
export function functionFromMigration(migrationDir: string, fn: string): string {
  const sql = readFileSync(path.join(MIGRATIONS, migrationDir, 'migration.sql'), 'utf8');
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION "${fn}"()`);
  if (start < 0) throw new Error(`${migrationDir} does not define ${fn}`);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  const tail = sql.indexOf(';', close);
  if (open < 0 || close < 0 || tail < 0) throw new Error(`${migrationDir}'s ${fn} is not readable`);
  return sql.slice(start, tail + 1);
}
