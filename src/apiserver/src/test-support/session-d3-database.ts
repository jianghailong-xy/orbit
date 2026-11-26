/**
 * The database deploy D3 left (docs/session-status-retirement-plan.md §4.1), for the specs that hold what D3 and the
 * deploys before it did to account: since deploy D4 (migration 1691) session.status and run_status are gone from a
 * migrated database, so such a spec puts them back with the rollback script operators run,
 * scripts/session-status-drop-down.sql, before it starts (and applies the older down scripts on top of that).
 * What that script restores is held to the D3 database itself by sessions/session-status-drop.pg.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from 'pg';

/** The repository's scripts/, from the compiled build/test-support/ this module runs from. */
export const REPO_SCRIPTS = join(__dirname, '..', '..', '..', '..', 'scripts');

/** Put session.status and everything of deploy D3 back on a database migrated through D4. */
export async function restoreStatusColumn(sql: Client): Promise<void> {
  await sql.query(readFileSync(join(REPO_SCRIPTS, 'session-status-drop-down.sql'), 'utf8'));
}
