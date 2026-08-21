import assert from 'node:assert/strict';

import type { Client } from 'pg';

let announced = false;

/**
 * Destructive coordinator PostgreSQL specs must prove their target before creating or dropping
 * anything. The explicit expected identity makes a copied production URL fail before the first
 * write; the pcc_ naming rule also rejects Orbit's shared database and role by construction.
 */
export function assertCoordinatorPgUrlIsIsolated(
  connectionString: string | undefined,
): asserts connectionString is string {
  assert.ok(connectionString, 'COORDINATOR_PG_URL is required');
  const expectedDatabase = process.env.COORDINATOR_PG_EXPECTED_DATABASE;
  const expectedUser = process.env.COORDINATOR_PG_EXPECTED_USER;
  const expectedSystemIdentifier = process.env.COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER;
  assert.ok(expectedDatabase, 'COORDINATOR_PG_EXPECTED_DATABASE is required for destructive PG specs');
  assert.ok(expectedUser, 'COORDINATOR_PG_EXPECTED_USER is required for destructive PG specs');
  assert.ok(expectedSystemIdentifier, 'COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER is required for destructive PG specs');

  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  // `pcc<unit>_`, where a unit is 03, 04, 03a — a repair of a unit is not the unit, and its
  // database must not be the unit's either. The prefix is the cheap half of the guard; the
  // explicit expected database, role and server identity below are the half that decides.
  assert.match(database, /^pcc[0-9a-z]*[_-]/, 'destructive coordinator specs require a dedicated pcc_* database');
  assert.match(user, /^pcc[0-9a-z]*[_-]/, 'destructive coordinator specs require a dedicated pcc_* role');
  assert.doesNotMatch(`${url.hostname}/${database}/${user}`, /orbit-postgres|(^|[\/_-])orbit([\/_-]|$)/i,
    'shared Orbit PostgreSQL targets are forbidden');
  assert.equal(database, expectedDatabase, 'URL database does not match the explicitly expected isolated database');
  assert.equal(user, expectedUser, 'URL user does not match the explicitly expected isolated role');
}

/** Read-only identity probe. Call immediately after connect and before every fixture mutation. */
export async function verifyCoordinatorPgIdentity(client: Client): Promise<void> {
  const expectedDatabase = process.env.COORDINATOR_PG_EXPECTED_DATABASE!;
  const expectedUser = process.env.COORDINATOR_PG_EXPECTED_USER!;
  const expectedSystemIdentifier = process.env.COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER!;
  const result = await client.query<{
    database: string;
    role: string;
    server_addr: string | null;
    server_port: number;
    system_identifier: string;
    server_version: string;
  }>(`
    SELECT current_database() AS database,
           current_user AS role,
           inet_server_addr()::text AS server_addr,
           inet_server_port() AS server_port,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS server_version
  `);
  const identity = result.rows[0];
  assert.equal(identity.database, expectedDatabase, 'connected database is not the expected isolated database');
  assert.equal(identity.role, expectedUser, 'connected role is not the expected isolated role');
  assert.equal(identity.system_identifier, expectedSystemIdentifier,
    'server identity differs from the explicitly expected disposable PostgreSQL server');
  assert.doesNotMatch(`${identity.database}/${identity.role}`, /(^|[\/_-])orbit([\/_-]|$)/i,
    'shared Orbit PostgreSQL identity is forbidden');

  if (!announced) {
    announced = true;
    console.log(`coordinator-pg-isolation database=${identity.database} user=${identity.role} ` +
      `server=${identity.server_addr ?? 'local'}:${identity.server_port} ` +
      `system_identifier=${identity.system_identifier} version=${identity.server_version}`);
  }
}
