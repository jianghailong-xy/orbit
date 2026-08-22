import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { addTwins } from '../common/public-id-body';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  PROJECT_ACTIVITY_KINDS,
  PROJECT_ACTIVITY_OUTCOMES,
  ProjectActivityItem,
} from './project-panorama-activity';
import { ProjectsService } from './projects.service';

/**
 * The merged coordinator activity stream on real PostgreSQL, against a DISPOSABLE server.
 *
 * Everything this endpoint is depends on a database: it is one UNION ALL over three tables whose
 * columns only the migrations know, ordered and paged by a composite key. Three properties no unit
 * test can decide --
 *
 *  - the composite cursor. A pass writes its decision and the actions it produced in ONE
 *    transaction, so rows sharing a timestamp to the millisecond are the normal case here, not the
 *    exotic one. `<` on the timestamp alone drops the rest of such a group and `<=` repeats it,
 *    and both bugs look like a working endpoint until somebody counts. The fixture puts a page
 *    boundary in the MIDDLE of a three-row tie so that both halves of that are reachable;
 *  - the projection. The row interface is the only thing tying the SQL to the schema, so a column
 *    renamed in a migration and not here still compiles, still runs, and serves `undefined`;
 *  - `timestamp(3) without time zone` in and out of the cursor. Every bound crosses the boundary
 *    as an instant explicitly; read bare, a cursor built from one shifts by the session's offset
 *    and skips an hour of history.
 *
 * The fixture builds `project` and `project_runtime` by hand and then applies the REAL migrations
 * for the three tables under test, so the columns being read are the shipped ones.
 *
 *   docker run -d --name pcc21-activity-pg16 -e POSTGRES_PASSWORD=pcc21_activity \
 *     -e POSTGRES_USER=pcc21_activity -e POSTGRES_DB=pcc21_activity \
 *     -p 127.0.0.1:55631:5432 postgres:16
 *   COORDINATOR_PG_URL=postgresql://pcc21_activity:pcc21_activity@127.0.0.1:55631/pcc21_activity \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcc21_activity COORDINATOR_PG_EXPECTED_USER=pcc21_activity \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql ... 'SELECT system_identifier FROM pg_control_system()') \
 *     node --test --test-concurrency=1 build/projects/project-panorama-activity.pg.spec.js
 *
 * The server is proved disposable before the first write (`coordinator-pg-test-safety.ts`).
 */

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc21_activity';
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

const OWNER = '00000000-0000-7000-8000-000000003001';
const OTHER_OWNER = '00000000-0000-7000-8000-000000003002';
const PROJECT = '00000000-0000-7000-8000-000000003003';
const NEIGHBOUR = '00000000-0000-7000-8000-000000003004';
const EMPTY = '00000000-0000-7000-8000-000000003005';
const TASK_A = '00000000-0000-7000-8000-00000000300a';
const TASK_B = '00000000-0000-7000-8000-00000000300b';
const TASK_C = '00000000-0000-7000-8000-00000000300c';
const SESSION = '00000000-0000-7000-8000-00000000300e';
const BLOCKER = '00000000-0000-7000-8000-00000000300f';

/** How many rows the project under test has, over all three tables. The neighbouring project's
 *  rows are deliberately NOT part of it: they exist to be absent from every page. */
const PROJECT_ROW_COUNT = 12;

const OUTBOX = migration('0116_project_event_outbox');
const RECONCILE = migration('0119_project_reconcile_runtime');
const DECISIONS = migration('0120_project_decision_audit');
/** 0122 gives the ledger the `reason_code` this read serves, in a migration that also ALTERs
 *  `runner`, `task` and `session` — three tables this fixture has no reason to build. The one
 *  statement that concerns the table under test is taken from the shipped file rather than copied
 *  into it, and asserted, so a migration that stops containing it fails here loudly instead of
 *  leaving the fixture one column short of production. */
const ACTION_REASON = statement('0122_project_dispatch_boundary', /ALTER TABLE "project_action"\n  ADD COLUMN "execution_context"[\s\S]*?;/);

type ClientCtor = new (config: { connectionString?: string; connectionTimeoutMillis?: number }) => Client;

function migration(name: string): string {
  return readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
}

function statement(name: string, pattern: RegExp): string {
  const match = migration(name).match(pattern);
  assert.ok(match, `${name} no longer contains ${pattern}`);
  return match[0];
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
 * ownership lookup `assertOwned` makes -- which runs against the real `project` row rather than a
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
  await client.query(OUTBOX);
  await client.query(RECONCILE);
  await client.query(DECISIONS);
  await client.query(ACTION_REASON);
  await client.query(`
    INSERT INTO "project" ("id", "owner_id", "title") VALUES
      ($1, $2, 'the project with a history'),
      ($3, $2, 'the project next door'),
      ($4, $2, 'nothing has happened here yet')
  `, [PROJECT, OWNER, NEIGHBOUR, EMPTY]);
}

/** The wall clock every seeded row is placed against. The column is `timestamp(3)` and stores
 *  UTC, so a literal here is the same instant on any machine that runs this. */
const T0 = '2026-08-20 12:00:00';

async function action(client: Client, spec: {
  id: string;
  project?: string;
  type: string;
  status: string;
  subjectType: string;
  subjectId?: string | null;
  refusalCode?: string | null;
  reasonCode?: string | null;
  detail?: Record<string, unknown>;
  seconds: number;
}): Promise<void> {
  await client.query(`
    INSERT INTO "project_action" (
      "id", "project_id", "idempotency_key", "type", "status", "subject_type", "subject_id",
      "fencing_token", "refusal_code", "reason_code", "detail", "created_at", "updated_at"
    ) VALUES (
      $1::uuid, $2::uuid, $1::text, $3::"project_action_type", $4::"project_action_status",
      $5, $6::uuid, 1, $7, $8, $9::jsonb,
      TIMESTAMP '${T0}' + make_interval(secs => $10::double precision), CURRENT_TIMESTAMP
    )
  `, [spec.id, spec.project ?? PROJECT, spec.type, spec.status, spec.subjectType,
      spec.subjectId ?? null, spec.refusalCode ?? null, spec.reasonCode ?? null,
      JSON.stringify(spec.detail ?? {}), spec.seconds]);
}

async function decision(client: Client, spec: {
  id: string;
  project?: string;
  reason: string;
  before: string;
  after: string;
  seconds: number;
}): Promise<void> {
  // The 0120 CHECKs tie the hash to both JSON documents and the version to the input, so the row
  // is built the way the decision service builds it rather than with placeholder JSON.
  await client.query(`
    INSERT INTO "project_decision" (
      "id", "project_id", "input_version", "decision_input_hash", "decision_input", "outcome",
      "decided_by", "fencing_token", "reason", "created_at"
    ) VALUES (
      $1::uuid, $2::uuid, 1, md5($1::text) || md5($1::text),
      jsonb_build_object('v', 1, 'decisionInputHash', md5($1::text) || md5($1::text)),
      jsonb_build_object(
        'decisionInputHash', md5($1::text) || md5($1::text),
        'runStateBefore', $3::text, 'runStateAfter', $4::text
      ),
      'ORCHESTRATOR', 1, $5,
      TIMESTAMP '${T0}' + make_interval(secs => $6::double precision)
    )
  `, [spec.id, spec.project ?? PROJECT, spec.before, spec.after, spec.reason, spec.seconds]);
}

async function event(client: Client, spec: {
  id: string;
  project?: string;
  kind: string;
  sourceType: string;
  sourceId: string;
  payload?: Record<string, unknown>;
  seconds: number;
}): Promise<void> {
  await client.query(`
    INSERT INTO "project_event" (
      "id", "project_id", "kind", "occurred_at", "source_type", "source_id", "dedupe_key",
      "payload", "last_at"
    ) VALUES (
      $1::uuid, $2::uuid, $3, TIMESTAMP '${T0}' + make_interval(secs => $6::double precision),
      $4, $5::uuid, $1::text, $7::jsonb, CURRENT_TIMESTAMP
    )
  `, [spec.id, spec.project ?? PROJECT, spec.kind, spec.sourceType, spec.sourceId,
      spec.seconds, JSON.stringify(spec.payload ?? {})]);
}

/** `00000000-0000-7000-8000-0000000004NN`, so a row's position in the tie is decided by a digit. */
function id(n: number): string {
  return `00000000-0000-7000-8000-0000000004${n.toString().padStart(2, '0')}`;
}

/**
 * One project's history: twelve rows over the three tables.
 *
 * Positions 4, 5 and 6 (counting from the newest) share `T0+80s` to the millisecond and come from
 * TWO different tables -- the shape a single reconcile pass really produces, and the shape that
 * decides whether the cursor has to be composite. With `limit=5` the page boundary falls between
 * the second and the third of them, so a cursor comparing timestamps alone drops one row or serves
 * it twice, depending on which way it is wrong.
 */
async function seed(client: Client): Promise<void> {
  // 1 -- the loop woke on its own clock.
  await event(client, { id: id(1), kind: 'timer.due', sourceType: 'TIMER', sourceId: PROJECT, seconds: 100 });
  // 2 -- and concluded something, moving the project's run state.
  await decision(client, {
    id: id(2), reason: 'planning requires coordinator decision',
    before: 'PLANNING', after: 'EXECUTING', seconds: 95,
  });
  // 3 -- one blocker raised against a session.
  await action(client, {
    id: id(3), type: 'RAISE_BLOCKER', status: 'APPLIED', subjectType: 'SESSION', subjectId: SESSION,
    detail: { kind: 'AWAITING_USER_INPUT' }, seconds: 90,
  });
  // 4, 5, 6 -- one pass, one millisecond, two tables.
  await action(client, {
    id: id(6), type: 'DISPATCH_TASK', status: 'APPLIED', subjectType: 'TASK', subjectId: TASK_A,
    reasonCode: 'POLICY_ALLOWED', seconds: 80,
  });
  await action(client, {
    id: id(5), type: 'DISPATCH_TASK', status: 'REFUSED', subjectType: 'TASK', subjectId: TASK_B,
    refusalCode: 'PROVIDER_UNAVAILABLE', reasonCode: 'PROVIDER_UNAVAILABLE', seconds: 80,
  });
  await event(client, {
    id: id(4), kind: 'task.status_changed', sourceType: 'TASK', sourceId: TASK_A,
    payload: { taskId: TASK_A, from: 'OPEN', to: 'IN_PROGRESS' }, seconds: 80,
  });
  // 7 -- the blocker from 3 cleared again.
  await action(client, {
    id: id(7), type: 'CLEAR_BLOCKER', status: 'APPLIED', subjectType: 'BLOCKER', subjectId: BLOCKER,
    detail: { kind: 'AWAITING_USER_INPUT', resolvedBy: 'AUTO' }, seconds: 70,
  });
  // 8 -- a session ended; the task it was working on is named in the payload, not in source_id.
  await event(client, {
    id: id(8), kind: 'session.ended', sourceType: 'SESSION', sourceId: SESSION,
    payload: { taskId: TASK_A, from: 'RUNNING', to: 'SUCCEEDED' }, seconds: 60,
  });
  // 9 -- a pass that concluded nothing: same run state either side.
  await decision(client, {
    id: id(9), reason: 'in-flight session may end',
    before: 'EXECUTING', after: 'EXECUTING', seconds: 50,
  });
  // 10 -- a verdict applied to a task.
  await action(client, {
    id: id(10), type: 'APPLY_VERIFICATION_VERDICT', status: 'APPLIED', subjectType: 'TASK',
    subjectId: TASK_C, reasonCode: 'VERDICT', seconds: 40,
  });
  // 11 -- a person asked for a pass. Not a task, and not the coordinator's own doing.
  await event(client, {
    id: id(11), kind: 'user.manual_trigger', sourceType: 'USER', sourceId: OWNER, seconds: 30,
  });
  // 12 -- an action still in flight: claimed, no outcome yet.
  await action(client, {
    id: id(12), type: 'OPEN_COORDINATOR_TURN', status: 'CLAIMED', subjectType: 'PROJECT',
    subjectId: PROJECT, seconds: 20,
  });

  // The project next door, at timestamps that would interleave with every one of the above.
  await action(client, {
    id: id(90), project: NEIGHBOUR, type: 'DISPATCH_TASK', status: 'APPLIED', subjectType: 'TASK',
    subjectId: TASK_C, seconds: 85,
  });
  await decision(client, {
    id: id(91), project: NEIGHBOUR, reason: 'somebody else\'s pass',
    before: 'PLANNING', after: 'BLOCKED', seconds: 75,
  });
  await event(client, {
    id: id(92), project: NEIGHBOUR, kind: 'timer.due', sourceType: 'TIMER', sourceId: NEIGHBOUR,
    seconds: 65,
  });
}

/**
 * A fresh world per test, dropped again after it.
 *
 * The teardown is registered on the connection and not on the fixture being complete: a fixture
 * that throws half way through would otherwise leave its connection open, and leaked connections
 * do not fail a run -- they hang it, which reads as "the test never finished" instead of "the
 * INSERT was wrong".
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

/** Every page, followed to the end. Returns what a client that scrolled the card would have. */
async function drain(
  service: ProjectsService,
  project: string,
  limit: string,
): Promise<{ items: ProjectActivityItem[]; pages: number }> {
  const items: ProjectActivityItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await service.activity(OWNER, project, { limit, cursor });
    items.push(...page.items);
    pages += 1;
    assert.ok(pages <= 20, 'paging did not terminate');
    if (!page.nextCursor) return { items, pages };
    cursor = page.nextCursor;
  }
}

test('the stream is every row of all three tables, newest first', { skip }, async (t) => {
  const { service } = await fixture(t);

  const { items, nextCursor } = await service.activity(OWNER, PROJECT, { limit: '50' });

  assert.equal(items.length, PROJECT_ROW_COUNT);
  assert.equal(nextCursor, null);
  for (let i = 1; i < items.length; i += 1) {
    const previous = items[i - 1];
    const current = items[i];
    assert.ok(
      previous.at.getTime() > current.at.getTime()
        || (previous.at.getTime() === current.at.getTime() && previous.id > current.id),
      `row ${i} is not older than the row above it`,
    );
  }
  // The three interleaved rows next door would each have landed inside this page.
  assert.equal(items.filter((item) => item.title === 'somebody else\'s pass').length, 0);
  assert.equal(items.filter((item) => item.kind === 'WAKE').length, 1);
});

test('paging a tie in the middle loses nothing and repeats nothing', { skip }, async (t) => {
  const { service } = await fixture(t);

  const whole = await service.activity(OWNER, PROJECT, { limit: '50' });
  const { items, pages } = await drain(service, PROJECT, '5');

  assert.equal(pages, 3);
  assert.equal(items.length, PROJECT_ROW_COUNT);
  assert.equal(new Set(items.map((item) => item.id)).size, PROJECT_ROW_COUNT);
  assert.deepEqual(items.map((item) => item.id), whole.items.map((item) => item.id));
  // The rows the boundary ran through: three of them, one millisecond, two tables, and the page
  // ends between the second and the third.
  const tied = items.filter((item) => item.at.toISOString() === '2026-08-20T12:01:20.000Z');
  assert.equal(tied.length, 3);
  assert.deepEqual(items.slice(3, 6).map((item) => item.id), tied.map((item) => item.id));
});

test('every page size walks the same twelve rows in the same order', { skip }, async (t) => {
  const { service } = await fixture(t);

  const expected = (await service.activity(OWNER, PROJECT, { limit: '50' })).items.map((i) => i.id);

  for (const limit of ['1', '2', '3', '5', '11', '12', '13']) {
    const { items } = await drain(service, PROJECT, limit);
    assert.deepEqual(items.map((item) => item.id), expected, `limit=${limit} walked a different set`);
  }
});

test('kind and outcome only ever come from the two closed sets', { skip }, async (t) => {
  const { service } = await fixture(t);

  const { items } = await service.activity(OWNER, PROJECT, { limit: '50' });

  for (const item of items) {
    assert.ok(PROJECT_ACTIVITY_KINDS.includes(item.kind), `${item.kind} is not a known kind`);
    assert.ok(PROJECT_ACTIVITY_OUTCOMES.includes(item.outcome), `${item.outcome} is not a known outcome`);
    assert.ok(item.title.length > 0, 'every row says something');
  }
  // The raw enums the three tables key by, none of which is a value of the shared vocabulary: an
  // action status, and an event kind with a namespace in it.
  assert.equal(items.filter((item) => (item.kind as string) === 'CLAIMED').length, 0);
  assert.equal(items.filter((item) => (item.kind as string).includes('.')).length, 0);
});

test('the vocabulary says what each row came to', { skip }, async (t) => {
  const { service } = await fixture(t);

  const { items } = await service.activity(OWNER, PROJECT, { limit: '50' });
  const byId = new Map(items.map((item) => [item.id, item]));

  // A refusal carries the code it was refused under, so the card can say why without a second read.
  assert.equal(byId.get(id(5))?.kind, 'DISPATCH_TASK');
  assert.equal(byId.get(id(5))?.outcome, 'REFUSED');
  assert.equal(byId.get(id(5))?.detail, 'PROVIDER_UNAVAILABLE');
  assert.equal(byId.get(id(6))?.outcome, 'APPLIED');
  // Clearing a blocker is the one applied action a reader scans for: it ENDED a wait.
  assert.equal(byId.get(id(7))?.kind, 'CLEAR_BLOCKER');
  assert.equal(byId.get(id(7))?.outcome, 'RESOLVED');
  assert.equal(byId.get(id(7))?.detail, 'AWAITING_USER_INPUT');
  assert.equal(byId.get(id(3))?.kind, 'RAISE_BLOCKER');
  assert.equal(byId.get(id(3))?.outcome, 'APPLIED');
  assert.equal(byId.get(id(3))?.detail, 'AWAITING_USER_INPUT');
  // Claimed is not an outcome: nothing has come of it yet.
  assert.equal(byId.get(id(12))?.kind, 'OPEN_COORDINATOR_TURN');
  assert.equal(byId.get(id(12))?.outcome, 'INFO');
  // A pass that moved the project says where to; one that concluded nothing says nothing.
  assert.equal(byId.get(id(2))?.kind, 'DECIDE');
  assert.equal(byId.get(id(2))?.title, 'planning requires coordinator decision');
  assert.equal(byId.get(id(2))?.detail, 'PLANNING → EXECUTING');
  assert.equal(byId.get(id(9))?.kind, 'DECIDE');
  assert.equal(byId.get(id(9))?.detail, null);
  // The timer's own kind is the one event promoted out of SIGNAL.
  assert.equal(byId.get(id(1))?.kind, 'WAKE');
  assert.equal(byId.get(id(1))?.title, 'timer.due');
  assert.equal(byId.get(id(8))?.kind, 'SIGNAL');
  assert.equal(byId.get(id(8))?.title, 'session.ended');
  assert.equal(byId.get(id(8))?.detail, 'RUNNING → SUCCEEDED');
});

test('a row about a task names it, in a spelling the API can serve', { skip }, async (t) => {
  const { service } = await fixture(t);

  const { items } = await service.activity(OWNER, PROJECT, { limit: '50' });
  const byId = new Map(items.map((item) => [item.id, item]));

  assert.equal(byId.get(id(6))?.subjectTaskId, TASK_A);
  assert.equal(byId.get(id(5))?.subjectTaskId, TASK_B);
  assert.equal(byId.get(id(10))?.subjectTaskId, TASK_C);
  // A TASK-sourced event names its task in source_id...
  assert.equal(byId.get(id(4))?.subjectTaskId, TASK_A);
  // ...and a session's names it in the payload, which is the difference between "a session ended"
  // and "the session working on THAT task ended".
  assert.equal(byId.get(id(8))?.subjectTaskId, TASK_A);
  // Rows that are about no task say so, rather than pointing at the session or the blocker they
  // are about as if it were one.
  assert.equal(byId.get(id(3))?.subjectTaskId, null);
  assert.equal(byId.get(id(7))?.subjectTaskId, null);
  assert.equal(byId.get(id(1))?.subjectTaskId, null);
  assert.equal(byId.get(id(9))?.subjectTaskId, null);

  // Every id this body carries is one `PublicIdInterceptor` rewrites, which is the whole of the
  // convention: run the mapping the interceptor runs and no raw uuid survives it.
  const encoded = addTwins(JSON.parse(JSON.stringify(items)), true);
  assert.doesNotMatch(
    JSON.stringify(encoded),
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    'a raw uuid reached the wire',
  );
  for (const item of items) {
    assert.equal(typeof uuidToBase62(item.id), 'string');
    if (item.subjectTaskId) assert.equal(typeof uuidToBase62(item.subjectTaskId), 'string');
  }
});

test('a project nothing has happened to answers empty, not a 404', { skip }, async (t) => {
  const { service } = await fixture(t);

  assert.deepEqual(await service.activity(OWNER, EMPTY), { items: [], nextCursor: null });
  assert.deepEqual(await service.activity(OWNER, EMPTY, { limit: '5' }), { items: [], nextCursor: null });
});

test('an unusable limit or cursor is refused rather than silently defaulted', { skip }, async (t) => {
  const { service } = await fixture(t);

  for (const limit of ['0', '-1', '2.5', 'soon', '101']) {
    await assert.rejects(
      () => service.activity(OWNER, PROJECT, { limit }),
      (error: Error) => error.message.includes('limit'),
      `${limit} should not have been accepted`,
    );
  }
  await assert.rejects(
    () => service.activity(OWNER, PROJECT, { cursor: 'not-a-cursor' }),
    (error: Error) => error.message.includes('cursor'),
  );
  // No limit at all is a screenful, which this history fits inside.
  const page = await service.activity(OWNER, PROJECT);
  assert.equal(page.items.length, PROJECT_ROW_COUNT);
  assert.equal(page.nextCursor, null);
});

test('somebody else\'s project is the 404 an unknown one is', { skip }, async (t) => {
  const { service } = await fixture(t);

  await assert.rejects(() => service.activity(OTHER_OWNER, PROJECT), NotFoundException);
});
