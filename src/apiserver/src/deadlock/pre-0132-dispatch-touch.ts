import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Client } from 'pg';

/**
 * `task_dependency_dispatch_touch`, as 0122 installed it and 0132 removed it.
 *
 * The 2026-08-21 05:47:43 three-party cycle ran THROUGH this trigger: the edge insert fired it,
 * its `UPDATE "task"` re-ran `task_creator_session_id_fkey`, and the foreign key asked for
 * FOR KEY SHARE on a Session another backend held FOR UPDATE. That report is evidence, and
 * evidence does not get edited when the code it is about changes — so the baseline still replays
 * the same statements, and installs the trigger they were issued against first.
 *
 * The alternative was to delete or weaken the baseline, which the project forbids for exactly
 * this reason: a fix that erases the case it fixed leaves nobody able to check it. Migration 0130
 * already established the shape (`project-session-event-scope.pg.spec.ts` rebuilds the pre-0130
 * trigger for its control and re-applies the migration afterwards); this is the same move.
 *
 * The definition is read out of 0122 rather than retyped, so the baseline can never drift into
 * replaying a trigger production never had.
 */
const MIGRATION_0122 = path.resolve(
  __dirname,
  '../../prisma/migrations/0122_project_dispatch_boundary/migration.sql',
);

export function historicalTouchSql(): string {
  const sql = readFileSync(MIGRATION_0122, 'utf8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION "task_dependency_dispatch_touch"');
  const end = sql.indexOf('FOR EACH ROW EXECUTE FUNCTION "task_dependency_dispatch_touch"();', start);
  if (start < 0 || end < 0) {
    throw new Error('0122 no longer contains task_dependency_dispatch_touch — update this helper');
  }
  return sql.slice(start, end) + 'FOR EACH ROW EXECUTE FUNCTION "task_dependency_dispatch_touch"();';
}

/**
 * Put the pre-0132 touch back, for a fixture that is evidence about it — or, in
 * `ROLLBACK_0132`'s case, because a rollback has to restore the boundary it removes.
 */
export async function installHistoricalDispatchTouch(client: Client): Promise<void> {
  await client.query(historicalTouchSql());
}

/**
 * Take it away again. Called from a `finally`, and idempotent: a run killed between the install
 * and the drop would otherwise leave the disposable server carrying a trigger 0132 removed, and
 * every later gate would be measuring the wrong schema. `dependency-revision.pg.spec.ts` asserts
 * the trigger is absent before its first round for the same reason.
 */
export async function dropHistoricalDispatchTouch(client: Client): Promise<void> {
  await client.query(
    'DROP TRIGGER IF EXISTS "task_dependency_dispatch_touch" ON "task_dependency"',
  );
  await client.query('DROP FUNCTION IF EXISTS "task_dependency_dispatch_touch"()');
}
