import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { UNSPECIFIED_REFUSAL_CODE } from './project-panorama-dispatch-health';
import { ProjectsService } from './projects.service';

/**
 * The dispatch-health read on real PostgreSQL, against a DISPOSABLE server.
 *
 * Everything this endpoint returns is a GROUP BY in `$queryRaw`, which is exactly the shape a unit
 * test cannot check: the row interface is the ONLY thing tying the SQL to the schema, so a column
 * renamed in the migration and not in the query still compiles, still runs, and serves `undefined`
 * under the old name. Three more properties only a database decides —
 *
 *  - `COALESCE(refusal_code, 'UNSPECIFIED')` and NOT `GROUP BY refusal_code`: whether the refusals
 *    nobody classified survive the grouping at all, or become the NULL bucket every keyed client
 *    then drops;
 *  - the half-open window against a `timestamp(3) without time zone` column: whether the bounds
 *    survive the trip through the driver as the instants they were computed as;
 *  - `resolved_at IS NULL`: what "open" means to the partial index the raise path writes against.
 *
 * The fixture builds `project` and `project_runtime` by hand and then applies the REAL migrations
 * for the two tables under test, so the columns being read are the shipped ones.
 *
 *   docker run -d --name pcc20-panorama-pg16 -e POSTGRES_PASSWORD=pcc20_panorama \
 *     -e POSTGRES_USER=pcc20_panorama -e POSTGRES_DB=pcc20_panorama \
 *     -p 127.0.0.1:55630:5432 postgres:16
 *   COORDINATOR_PG_URL=postgresql://pcc20_panorama:pcc20_panorama@127.0.0.1:55630/pcc20_panorama \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcc20_panorama COORDINATOR_PG_EXPECTED_USER=pcc20_panorama \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql … 'SELECT system_identifier FROM pg_control_system()') \
 *     node --test --test-concurrency=1 build/projects/project-panorama-dispatch-health.pg.spec.js
 *
 * The server is proved disposable before the first write (`coordinator-pg-test-safety.ts`).
 */

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc20_panorama';
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

const OWNER = '00000000-0000-7000-8000-000000002001';
const OTHER_OWNER = '00000000-0000-7000-8000-000000002002';
const PROJECT = '00000000-0000-7000-8000-000000002003';
const NEIGHBOUR = '00000000-0000-7000-8000-000000002004';
const EMPTY = '00000000-0000-7000-8000-000000002005';

const RECONCILE = migration('0119_project_reconcile_runtime');
const BLOCKER = migration('0125_project_blocker');

type ClientCtor = new (config: { connectionString?: string; connectionTimeoutMillis?: number }) => Client;

function migration(name: string): string {
  return readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
}

function rows<T>(result: QueryResult): T[] {
  return result.rows as T[];
}

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  await client.query(`SET search_path TO ${SCHEMA}`);
  return client;
}

/**
 * Enough of `PrismaService` for the read under test: the raw door it queries through, and the
 * ownership lookup `assertOwned` makes — which runs against the real `project` row rather than a
 * stub, so "this is somebody else's project" is decided by the same WHERE the service ships.
 */
function prisma(client: Client): PrismaService {
  return {
    $queryRaw: async (query: Prisma.Sql) => rows(await client.query(query.text, query.values)),
    project: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) => rows<{ id: string }>(
        await client.query(
          `SELECT "id" FROM "project" WHERE "id" = $1::uuid AND "owner_id" = $2::uuid`,
          [where.id, where.ownerId],
        ),
      )[0] ?? null,
    },
  } as unknown as PrismaService;
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TYPE "project_status" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
    CREATE TYPE "project_automation_policy" AS ENUM ('MANUAL', 'GUARDED_AUTO', 'AUTO');
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "title" TEXT NOT NULL,
      "status" "project_status" NOT NULL DEFAULT 'OPEN',
      "coordinator_enabled" BOOLEAN NOT NULL DEFAULT true,
      "automation_policy" "project_automation_policy" NOT NULL DEFAULT 'GUARDED_AUTO'
    );
    -- 0119 ALTERs this table rather than creating it (it arrives in 0113), so the subset declares
    -- the shape 0119 expects to find and nothing else.
    CREATE TABLE "project_runtime" (
      "project_id" UUID PRIMARY KEY REFERENCES "project"("id") ON DELETE CASCADE,
      "coordinator_generation" BIGINT NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL
    );
  `);
  await client.query(RECONCILE);
  await client.query(BLOCKER);
  await client.query(`
    INSERT INTO "project" ("id", "owner_id", "title") VALUES
      ($1, $2, 'refused a lot'),
      ($3, $2, 'the project next door'),
      ($4, $2, 'nothing has happened here yet')
  `, [PROJECT, OWNER, NEIGHBOUR, EMPTY]);
}

/** One ledger row, `hoursAgo` before now. `refusalCode` NULL is the case this endpoint is about. */
async function action(client: Client, spec: {
  project: string;
  type?: string;
  status: 'APPLIED' | 'REFUSED' | 'CLAIMED';
  refusalCode?: string | null;
  hoursAgo: number;
  key: string;
}): Promise<void> {
  await client.query(`
    INSERT INTO "project_action" (
      "id", "project_id", "idempotency_key", "type", "status", "subject_type", "subject_id",
      "fencing_token", "refusal_code", "created_at", "updated_at"
    ) VALUES (
      gen_random_uuid(), $1, $2, $3::"project_action_type", $4::"project_action_status",
      'TASK', NULL, 1, $5,
      CURRENT_TIMESTAMP - make_interval(secs => $6::double precision), CURRENT_TIMESTAMP
    )
  `, [spec.project, spec.key, spec.type ?? 'DISPATCH_TASK', spec.status,
      spec.refusalCode ?? null, spec.hoursAgo * 3600]);
}

/** One blocker episode. Resolved rows are written resolved: the triggers guard UPDATE, not INSERT. */
async function blocker(client: Client, spec: {
  project: string;
  kind: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  occurrences: number;
  firstSeenHoursAgo: number;
  resolved?: boolean;
}): Promise<void> {
  await client.query(`
    INSERT INTO "project_blocker" (
      "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
      "next_check_at", "subject_type", "subject_id", "dedupe_key", "lifecycle_generation",
      "condition_version", "first_seen_at", "last_seen_at", "occurrences",
      "resolved_at", "resolved_by", "created_at", "updated_at"
    ) VALUES (
      gen_random_uuid(), $1::uuid, $2, 'COORDINATOR', 'EVENT', $3::"project_blocker_severity",
      'clear it', CURRENT_TIMESTAMP, 'PROJECT', $7, $2 || ':PROJECT:' || $7, 1,
      repeat('0', 64),
      CURRENT_TIMESTAMP - make_interval(secs => $4::double precision), CURRENT_TIMESTAMP, $5,
      CASE WHEN $6::boolean THEN CURRENT_TIMESTAMP END,
      CASE WHEN $6::boolean THEN 'AUTO'::"project_blocker_resolved_by" END,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `, [spec.project, spec.kind, spec.severity, spec.firstSeenHoursAgo * 3600, spec.occurrences,
      spec.resolved ?? false, spec.project]);
}

/**
 * The world every test reads.
 *
 * Inside a 24 hour window: five refusals over three codes — one of which is no code at all — and
 * two applied dispatches. Outside it: ten more refusals under a code that appears nowhere else, so
 * a window that stopped filtering would announce itself at the top of the ranking rather than as an
 * off-by-one. A CLAIMED dispatch and an applied RAISE_BLOCKER sit in the window as well: neither is
 * a dispatch outcome, and counting either would inflate the answer to "did anything start".
 */
async function seed(client: Client): Promise<void> {
  await action(client, { project: PROJECT, status: 'REFUSED', refusalCode: 'PROVIDER_UNAVAILABLE', hoursAgo: 3, key: 'p-3' });
  await action(client, { project: PROJECT, status: 'REFUSED', refusalCode: 'PROVIDER_UNAVAILABLE', hoursAgo: 2, key: 'p-2' });
  await action(client, { project: PROJECT, status: 'REFUSED', refusalCode: 'PROVIDER_UNAVAILABLE', hoursAgo: 1, key: 'p-1' });
  await action(client, { project: PROJECT, status: 'REFUSED', refusalCode: 'WHO_NOT_IN_TEAM', hoursAgo: 5, key: 'w-5' });
  await action(client, { project: PROJECT, status: 'REFUSED', refusalCode: null, hoursAgo: 4, key: 'n-4' });
  await action(client, { project: PROJECT, status: 'APPLIED', hoursAgo: 6, key: 'a-6' });
  await action(client, { project: PROJECT, status: 'APPLIED', hoursAgo: 2, key: 'a-2' });
  await action(client, { project: PROJECT, status: 'CLAIMED', hoursAgo: 2, key: 'c-2' });
  await action(client, { project: PROJECT, type: 'RAISE_BLOCKER', status: 'APPLIED', hoursAgo: 2, key: 'rb-2' });
  for (let i = 0; i < 10; i += 1) {
    await action(client, {
      project: PROJECT, status: 'REFUSED', refusalCode: 'STALE_SNAPSHOT', hoursAgo: 48 + i, key: `s-${i}`,
    });
  }
  await action(client, { project: NEIGHBOUR, status: 'REFUSED', refusalCode: 'MERGE_CONFLICT', hoursAgo: 1, key: 'nb-1' });
  await action(client, { project: NEIGHBOUR, status: 'APPLIED', hoursAgo: 1, key: 'nb-a-1' });

  // Older than any window this endpoint offers, and still open: a blocker is current state, not an
  // event in the window, so ageing out of the ledger must not age it out of the answer.
  await blocker(client, { project: PROJECT, kind: 'PROVIDER_UNAVAILABLE', severity: 'CRITICAL', occurrences: 7, firstSeenHoursAgo: 50 });
  await blocker(client, { project: PROJECT, kind: 'NO_MATCHING_RUNNER', severity: 'WARNING', occurrences: 1, firstSeenHoursAgo: 2 });
  await blocker(client, { project: PROJECT, kind: 'MERGE_CONFLICT', severity: 'INFO', occurrences: 3, firstSeenHoursAgo: 3, resolved: true });
  await blocker(client, { project: NEIGHBOUR, kind: 'TEST_FAILED', severity: 'CRITICAL', occurrences: 2, firstSeenHoursAgo: 1 });
}

/**
 * A fresh world per test, dropped again after it.
 *
 * The teardown is registered on the connection and not on the fixture being complete: a fixture
 * that throws half way through would otherwise leave its connection open, and eight leaked
 * connections do not fail a run — they hang it, which reads as "the test never finished" instead
 * of "the INSERT was wrong".
 */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const client = await connect();
  t.after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });
  await reset(client);
  await seed(client);
  return { client, service: new ProjectsService(prisma(client), {} as never) };
}

test('the window decides the dispatch counts, and the ranking adds up to them', { skip }, async (t) => {
  const { service } = await fixture(t);

  const health = await service.dispatchHealth(OWNER, PROJECT);

  assert.equal(health.windowHours, 24);
  assert.equal(health.dispatch.refused, 5);
  assert.equal(health.dispatch.applied, 2);
  // The invariant the single GROUP BY exists to hold: a total its own breakdown does not add up to
  // is how a reader concludes the ranking is missing a reason.
  assert.equal(health.refusals.reduce((sum, r) => sum + r.count, 0), health.dispatch.refused);
});

test('refusals rank by count, and the ones with no code keep a group of their own', { skip }, async (t) => {
  const { service } = await fixture(t);

  const { refusals } = await service.dispatchHealth(OWNER, PROJECT);

  assert.deepEqual(refusals.map((r) => [r.refusalCode, r.count]), [
    ['PROVIDER_UNAVAILABLE', 3],
    [UNSPECIFIED_REFUSAL_CODE, 1],
    ['WHO_NOT_IN_TEAM', 1],
  ]);
  // Ten rows out of the window and two more in the project next door; both would outrank something
  // here if their filter had gone missing.
  assert.equal(refusals.find((r) => r.refusalCode === 'STALE_SNAPSHOT'), undefined);
  assert.equal(refusals.find((r) => r.refusalCode === 'MERGE_CONFLICT'), undefined);
});

test('each group reports the newest refusal in it', { skip }, async (t) => {
  const { client, service } = await fixture(t);

  const { refusals } = await service.dispatchHealth(OWNER, PROJECT);
  const expected = rows<{ code: string; last: Date }>(await client.query(`
    SELECT COALESCE("refusal_code", $1) AS "code", MAX("created_at") AS "last"
      FROM "project_action"
     WHERE "project_id" = $2::uuid AND "status" = 'REFUSED'
       AND "created_at" >= CURRENT_TIMESTAMP - interval '24 hours'
     GROUP BY 1
  `, [UNSPECIFIED_REFUSAL_CODE, PROJECT]));

  assert.equal(refusals.length, expected.length);
  for (const group of refusals) {
    const match = expected.find((row) => row.code === group.refusalCode);
    assert.ok(match, `no seeded group for ${group.refusalCode}`);
    assert.equal(group.lastSeenAt.getTime(), match.last.getTime());
  }
  // …and the newest of the three PROVIDER_UNAVAILABLE rows is the one an hour old, not the one
  // three hours old that a MIN or a first-row-wins would have served.
  const provider = refusals.find((r) => r.refusalCode === 'PROVIDER_UNAVAILABLE')!;
  const others = refusals.filter((r) => r.refusalCode !== 'PROVIDER_UNAVAILABLE');
  for (const other of others) {
    assert.ok(provider.lastSeenAt.getTime() > other.lastSeenAt.getTime());
  }
});

test('openBlockers are the unresolved episodes, however old', { skip }, async (t) => {
  const { service } = await fixture(t);

  const { openBlockers } = await service.dispatchHealth(OWNER, PROJECT);

  assert.deepEqual(openBlockers.map((b) => [b.kind, b.severity, b.occurrences]), [
    ['PROVIDER_UNAVAILABLE', 'CRITICAL', 7],
    ['NO_MATCHING_RUNNER', 'WARNING', 1],
  ]);
  assert.ok(openBlockers.every((b) => b.firstSeenAt instanceof Date));
  // The resolved episode stays in the table forever (§11.4) and must not be reported as current;
  // the neighbouring project's open one is not this project's problem.
  assert.equal(openBlockers.find((b) => b.kind === 'MERGE_CONFLICT'), undefined);
  assert.equal(openBlockers.find((b) => b.kind === 'TEST_FAILED'), undefined);
});

test('a project nothing has been attempted on answers with zeros, not a 404', { skip }, async (t) => {
  const { service } = await fixture(t);

  assert.deepEqual(await service.dispatchHealth(OWNER, EMPTY), {
    windowHours: 24,
    dispatch: { applied: 0, refused: 0 },
    refusals: [],
    openBlockers: [],
  });
});

test('a narrower windowHours drops whole groups rather than trimming them', { skip }, async (t) => {
  const { service } = await fixture(t);

  const health = await service.dispatchHealth(OWNER, PROJECT, '2.5');

  assert.equal(health.windowHours, 2.5);
  assert.equal(health.dispatch.refused, 2);
  assert.equal(health.dispatch.applied, 1);
  assert.deepEqual(health.refusals.map((r) => [r.refusalCode, r.count]), [['PROVIDER_UNAVAILABLE', 2]]);
  // Unchanged: the blockers are current state and the window says nothing about them.
  assert.equal(health.openBlockers.length, 2);
});

test('an unusable windowHours is refused rather than silently defaulted', { skip }, async (t) => {
  const { service } = await fixture(t);

  for (const raw of ['soon', '0', '-3', 'NaN', '1e9']) {
    await assert.rejects(
      () => service.dispatchHealth(OWNER, PROJECT, raw),
      (error: Error) => error.message.includes('windowHours'),
      `${raw} should not have been accepted`,
    );
  }
  assert.equal((await service.dispatchHealth(OWNER, PROJECT, '')).windowHours, 24);
});

test('somebody else\'s project is the 404 an unknown one is', { skip }, async (t) => {
  const { service } = await fixture(t);

  await assert.rejects(() => service.dispatchHealth(OTHER_OWNER, PROJECT), NotFoundException);
});
