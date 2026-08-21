import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProjectEventsService,
} from './project-events.service';
import type {
  EnqueueProjectEvent,
  ProjectEventHandler,
} from './project-events.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc05_event_outbox';
const PROJECT = '00000000-0000-7000-8000-000000000551';
const PROJECT_OTHER = '00000000-0000-7000-8000-000000000552';
const SOURCE = '00000000-0000-7000-8000-000000000553';
const BUSINESS = '00000000-0000-7000-8000-000000000554';
const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0116_project_event_outbox/migration.sql'),
  'utf8',
);

type ClientCtor = new (config: { connectionString?: string }) => Client;
type Tx = Prisma.TransactionClient;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

function sqlResult<T>(result: QueryResult): T[] {
  return result.rows as T[];
}

/** A tiny Prisma raw-query adapter: production and this spec execute the exact same Prisma.Sql. */
function transactionClient(client: Client): Tx {
  return {
    $queryRaw: async (query: Prisma.Sql) => sqlResult(await client.query(query.text, query.values)),
    $executeRaw: async (query: Prisma.Sql) =>
      (await client.query(query.text, query.values)).rowCount ?? 0,
    $executeRawUnsafe: async (query: string, ...values: unknown[]) =>
      (await client.query(query, values)).rowCount ?? 0,
  } as unknown as Tx;
}

function prisma(client: Client): PrismaService {
  return {
    $transaction: async <T>(fn: (tx: Tx) => Promise<T>) => {
      await client.query('BEGIN');
      try {
        const result = await fn(transactionClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  } as unknown as PrismaService;
}

async function inTransaction<T>(client: Client, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma(client).$transaction(fn) as Promise<T>;
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "coordinator_enabled" BOOLEAN NOT NULL DEFAULT true
    );
    INSERT INTO "project" ("id") VALUES ('${PROJECT}'), ('${PROJECT_OTHER}');
    CREATE TABLE "business_write" ("id" UUID PRIMARY KEY, "value" TEXT NOT NULL);
    CREATE TABLE "delivery_effect" (
      "dedupe_key" TEXT PRIMARY KEY,
      "project_id" UUID NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "dead_letter" (
      "event_id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL,
      "error" TEXT NOT NULL
    );
  `);
  await client.query(MIGRATION);
}

async function useSchema(client: Client): Promise<void> {
  await client.query(`SET search_path TO ${SCHEMA}`);
}

function input(over: Partial<EnqueueProjectEvent> = {}): EnqueueProjectEvent {
  return {
    projectId: PROJECT,
    kind: 'task.updated',
    source: { type: 'TASK', id: SOURCE },
    dedupeKey: `task.updated:${SOURCE}`,
    payload: { audit: 'only' },
    ...over,
  };
}

function idempotentHandler(beforeEffect?: () => Promise<void>): ProjectEventHandler {
  return {
    handle: async (tx, projectId, events) => {
      for (const event of events) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "delivery_effect" ("dedupe_key", "project_id")
          VALUES (${event.dedupeKey}, ${projectId}::uuid)
          ON CONFLICT ("dedupe_key") DO NOTHING
        `);
      }
      await beforeEffect?.();
    },
    deadLetter: async (tx, projectId, events, error) => {
      for (const event of events) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "dead_letter" ("event_id", "project_id", "error")
          VALUES (${event.id}::uuid, ${projectId}::uuid, ${error})
          ON CONFLICT ("event_id") DO NOTHING
        `);
      }
    },
  };
}

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

test('business state and its outbox signal commit or roll back atomically', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const events = new ProjectEventsService(prisma(client));

    await assert.rejects(
      inTransaction(client, async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "business_write" ("id", "value") VALUES (${BUSINESS}::uuid, 'rolled back')
        `);
        await events.enqueue(tx, input());
        throw new Error('force rollback');
      }),
      /force rollback/,
    );
    assert.equal((await client.query(`SELECT count(*)::int n FROM "business_write"`)).rows[0].n, 0);
    assert.equal((await client.query(`SELECT count(*)::int n FROM "project_event"`)).rows[0].n, 0);

    await inTransaction(client, async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "business_write" ("id", "value") VALUES (${BUSINESS}::uuid, 'committed')
      `);
      await events.enqueue(tx, input());
    });
    assert.equal((await client.query(`SELECT count(*)::int n FROM "business_write"`)).rows[0].n, 1);
    assert.equal((await client.query(`SELECT count(*)::int n FROM "project_event"`)).rows[0].n, 1);
  } finally {
    await client.end();
  }
});

test('pending duplicates coalesce and newer unknown envelopes remain deliverable', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const events = new ProjectEventsService(prisma(client));
    const first = new Date('2026-08-20T05:00:00.000Z');
    const second = new Date('2026-08-20T05:00:01.000Z');
    await inTransaction(client, (tx) => events.enqueue(tx, input({ occurredAt: first })));
    await inTransaction(client, (tx) => events.enqueue(tx, input({
      v: 99,
      kind: 'future.kind',
      occurredAt: second,
      payload: { from: 'new binary' },
    })));

    const row = (await client.query(`
      SELECT v, kind, occurrences, occurred_at, last_at, payload
        FROM "project_event"`)).rows[0];
    assert.equal(row.occurrences, 2);
    assert.equal(row.v, 99);
    assert.equal(row.kind, 'future.kind');
    assert.equal(row.occurred_at.toISOString(), first.toISOString(), 'the first occurrence stays auditable');
    assert.equal(row.last_at.toISOString(), second.toISOString());
    assert.deepEqual(row.payload, { from: 'new binary' });

    let deliveredVersion = 0;
    events.registerHandler({
      ...idempotentHandler(),
      handle: async (_tx, _projectId, batch) => {
        deliveredVersion = batch[0].v;
      },
    });
    assert.equal((await events.drainOnce(second)).status, 'CONSUMED');
    assert.equal(deliveredVersion, 99, 'unknown versions are signals, not poison messages');
  } finally {
    await client.end();
  }
});

test('two consumers serialize on the Project lease and only one handles the batch', { skip }, async () => {
  const firstClient = await connect();
  const secondClient = await connect();
  try {
    await reset(firstClient);
    await useSchema(secondClient);
    const producer = new ProjectEventsService(prisma(firstClient));
    await inTransaction(firstClient, (tx) => producer.enqueue(tx, input()));

    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const handler = idempotentHandler(async () => {
      calls += 1;
      entered();
      await releasePromise;
    });
    const first = new ProjectEventsService(prisma(firstClient));
    const second = new ProjectEventsService(prisma(secondClient));
    first.registerHandler(handler);
    second.registerHandler(handler);

    const winning = first.drainOnce();
    await enteredPromise;
    const losing = await second.drainOnce();
    assert.equal(losing.status, 'IDLE', 'SKIP LOCKED never waits behind or shares the Project claim');
    release();
    assert.equal((await winning).status, 'CONSUMED');
    assert.equal(calls, 1);
    assert.equal((await firstClient.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 1);
  } finally {
    await firstClient.end();
    await secondClient.end();
  }
});

test('a failed handler rolls back partial effects and persists the next attempt across restart', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const producer = new ProjectEventsService(prisma(client));
    await inTransaction(client, (tx) => producer.enqueue(tx, input()));
    const failedAt = new Date(Date.now() + 10_000);
    producer.registerHandler({
      ...idempotentHandler(),
      handle: async (tx, projectId, batch) => {
        await idempotentHandler().handle(tx, projectId, batch);
        throw new Error('injected reconcile failure');
      },
    });

    const failed = await producer.drainOnce(failedAt);
    assert.equal(failed.status, 'RETRY_SCHEDULED');
    assert.equal((await client.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 0,
      'the savepoint removes effects written before the failure');
    const pending = (await client.query(`
      SELECT attempts, next_attempt_at, consumed_at FROM "project_event"`)).rows[0];
    assert.equal(pending.attempts, 1);
    assert.equal(pending.consumed_at, null);
    assert.equal(pending.next_attempt_at.toISOString(), new Date(failedAt.getTime() + 1_000).toISOString());

    // A new service instance represents an apiserver restart: there is no in-memory claim or queue
    // to restore, only the durable row and its persisted due time.
    const restarted = new ProjectEventsService(prisma(client));
    restarted.registerHandler(idempotentHandler());
    assert.equal((await restarted.drainOnce(new Date(failedAt.getTime() + 999))).status, 'IDLE');
    assert.equal((await restarted.drainOnce(new Date(failedAt.getTime() + 1_001))).status, 'CONSUMED');
    assert.equal((await client.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 1);
    const consumed = (await client.query(`SELECT consumed_at, disposition FROM "project_event"`)).rows[0];
    assert.ok(consumed.consumed_at);
    assert.equal(consumed.disposition, 'RECONCILED');
  } finally {
    await client.end();
  }
});

test('redelivery can commit twice while its idempotent database effect happens once', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const events = new ProjectEventsService(prisma(client));
    events.registerHandler(idempotentHandler());
    await inTransaction(client, (tx) => events.enqueue(tx, input()));
    assert.equal((await events.drainOnce()).status, 'CONSUMED');
    await inTransaction(client, (tx) => events.enqueue(tx, input()));
    assert.equal((await events.drainOnce()).status, 'CONSUMED');

    assert.equal((await client.query(`SELECT count(*)::int n FROM "project_event"`)).rows[0].n, 2);
    assert.equal((await client.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 1);
    assert.equal((await client.query(`
      SELECT count(*)::int n FROM "project_event"
       WHERE consumed_at IS NOT NULL AND disposition = 'RECONCILED'`)).rows[0].n, 2);
  } finally {
    await client.end();
  }
});

test('the tenth failure becomes DEAD only with a fail-closed durable record', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const events = new ProjectEventsService(prisma(client));
    await inTransaction(client, (tx) => events.enqueue(tx, input()));
    await client.query(`UPDATE "project_event" SET attempts = 9`);
    events.registerHandler({
      ...idempotentHandler(),
      handle: async () => { throw new Error('still broken'); },
    });

    assert.equal((await events.drainOnce()).status, 'DEAD');
    const row = (await client.query(`
      SELECT attempts, consumed_at, disposition FROM "project_event"`)).rows[0];
    assert.equal(row.attempts, 10);
    assert.ok(row.consumed_at);
    assert.equal(row.disposition, 'DEAD');
    const dead = (await client.query(`SELECT project_id, error FROM "dead_letter"`)).rows[0];
    assert.equal(dead.project_id, PROJECT);
    assert.match(dead.error, /still broken/);
  } finally {
    await client.end();
  }
});

test('migration installs the partial indexes, closed disposition check, and NOTIFY accelerator', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const indexes = (await client.query(`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = '${SCHEMA}' AND tablename = 'project_event'`)).rows;
    const open = indexes.find((row) => row.indexname === 'project_event_open_dedupe_idx');
    const due = indexes.find((row) => row.indexname === 'project_event_due_idx');
    assert.match(open.indexdef, /UNIQUE.*\(project_id, dedupe_key\).*WHERE \(consumed_at IS NULL\)/i);
    assert.match(due.indexdef, /next_attempt_at.*WHERE \(consumed_at IS NULL\)/i);
    const trigger = (await client.query(`
      SELECT pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'project_event' AND t.tgname = 'project_event_notify_pending'
         AND NOT t.tgisinternal`)).rows[0];
    assert.match(trigger.definition, /AFTER INSERT OR UPDATE OF occurrences, next_attempt_at/i);

    await assert.rejects(
      client.query(`
        INSERT INTO "project_event" (
          id, project_id, kind, source_type, source_id, dedupe_key, consumed_at, disposition
        ) VALUES (gen_random_uuid(), $1, 'x', 'USER', $2, 'bad', now(), 'UNKNOWN')`,
      [PROJECT, SOURCE]),
      /project_event_disposition_chk/,
    );
  } finally {
    await client.end();
  }
});
