/**
 * The watch claims read their candidates once, against a real PostgreSQL pushed into the plan that would read them again:
 *
 *   1. the delivery claim (`WatchDeliveryService.claimDue`) leases no more than `claimBatch`, the longest-due first;
 *   2. the lease-expiry sweep (`WatchDeliveryService.reclaimExpired`) takes back no more than `claimBatch`;
 *   3. the evaluation claim (`WatchEvaluatorService.claimDue`) leases no more than `claimBatch`, and still answers how
 *      long each watch had been due, from the value before its update.
 *
 * THE PLAN
 * `UPDATE t AS r … FROM (SELECT … LIMIT n FOR UPDATE SKIP LOCKED) AS due WHERE r.id = due.id` may run as a nested loop
 * with `r` outside, which executes the subquery once for each row of `r`. Each execution locks past the rows this
 * statement has already updated, so LIMIT reaches further down the candidates, and with `r` in the claim's own order
 * the statement takes every one of them. A batch claimed that way is worked through one row at a time under one lease,
 * so the rows at the back can outlast it: a delivery then has a lost attempt counted, and can become a dead letter.
 *
 * The kit is the one in src/apiserver/src/wiki-worker/wiki-claim-reads-once.pg.spec.ts (`underRescan`, `readsOf`),
 * whose header says why the plan is forced inside the claim's own transaction rather than left to the planner.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-claim-reads-once.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account and deletes them afterwards. The statistics it changes
 * are put back in the transaction that changed them.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test, type TestContext } from 'node:test';

import { Prisma, type PrismaClient } from '@prisma/client';
import { WATCH_LIMITS } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { SessionsService } from '../sessions/sessions.service';
import { WatchDeliveryService } from './watch-delivery.service';
import { WatchEvaluatorService } from './watch-evaluator.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

/** What each case puts in front of a claim, and the batch it is allowed. */
const CANDIDATES = 5;
const BATCH = 2;

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  ownerId: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `watch-reads-once-${ownerId}@watch.invalid`, name: 'reads once spec', passwordHash: 'x' } });
    return { sql, prisma, ownerId };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, ownerId } = await harness;
  await prisma.watch.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
});

/** This account's watches gone, and with them their matches and deliveries. */
async function reset(h: Harness): Promise<void> {
  await h.prisma.watch.deleteMany({ where: { ownerId: h.ownerId } });
}

/**
 * `count` ACTIVE NOTIFY_USER watches, `due` of them past their `next_evaluate_at`, the longest-due first. One statement,
 * so the rows lie in the table in the order the claim takes them: the order in which `r`, read first, meets each one
 * among the candidates, and the plan's worst.
 */
async function dueWatches(h: Harness, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await h.sql.query(
    `INSERT INTO "watch" ("id", "owner_id", "observer_type", "predicate", "action", "expires_at", "next_evaluate_at", "updated_at")
     SELECT o."id", $2, 'USER', '{"kind":"TASK_TERMINAL"}'::jsonb, 'NOTIFY_USER', now() + interval '1 day',
            now() - interval '1 hour' + o."place" * interval '1 second', now()
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o("id", "place")
      ORDER BY o."place"`,
    [ids, h.ownerId],
  );
  return ids;
}

/**
 * One matched watch per delivery, and its delivery: PENDING and due, or IN_FLIGHT under a lease that ran out, the
 * longest-due (or longest-expired) first, in the table in that order too. `attempts` is what each has already used.
 */
async function deliveries(h: Harness, state: 'PENDING' | 'IN_FLIGHT', count: number, attempts = 0): Promise<string[]> {
  const watches = Array.from({ length: count }, () => randomUUID());
  const matches = watches.map(() => randomUUID());
  const ids = watches.map(() => randomUUID());
  await h.sql.query(
    `INSERT INTO "watch" ("id", "owner_id", "observer_type", "predicate", "action", "state", "generation", "expires_at", "updated_at")
     SELECT o."id", $2, 'USER', '{"kind":"TASK_TERMINAL"}'::jsonb, 'NOTIFY_USER', 'MATCHED', 1, now() + interval '1 day', now()
       FROM unnest($1::uuid[]) AS o("id")`,
    [watches, h.ownerId],
  );
  await h.sql.query(
    `INSERT INTO "watch_match" ("id", "watch_id", "generation", "reason", "predicate_version", "per_target_snapshot")
     SELECT o."id", o."watch", 1, 'ALL_TERMINAL', 1, '{}'::jsonb FROM unnest($1::uuid[], $2::uuid[]) AS o("id", "watch")`,
    [matches, watches],
  );
  const inFlight = state === 'IN_FLIGHT';
  await h.sql.query(
    `INSERT INTO "watch_delivery" ("id", "kind", "match_id", "action", "state", "attempts",
                                   "lease_owner", "lease_generation", "lease_deadline_at", "next_attempt_at", "updated_at")
     SELECT o."id", 'MATCH', o."match", 'NOTIFY_USER', $3, $4,
            CASE WHEN $5 THEN gen_random_uuid() END, CASE WHEN $5 THEN gen_random_uuid() END,
            CASE WHEN $5 THEN now() - interval '1 hour' + o."place" * interval '1 second' END,
            now() - interval '1 hour' + o."place" * interval '1 second', now()
       FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS o("id", "match", "place")
      ORDER BY o."place"`,
    [ids, matches, state, attempts, inFlight],
  );
  return ids;
}

// ── the kit of wiki-claim-reads-once.pg.spec.ts ─────────────────────────────────────────────────

/** A node of what `EXPLAIN (ANALYZE, FORMAT JSON)` answers: the parts of it these cases read. */
interface PlanNode {
  'Node Type': string;
  Alias?: string;
  'Actual Loops': number;
  Plans?: PlanNode[];
}

const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

/** What one execution of a claim did with its candidates. */
interface Reads {
  /** How the statement reaches them: a `Subquery Scan` runs the read again, a `CTE Scan` only goes back over its result. */
  scan: string;
  /** How many times the join went to them: more than one is the plan these cases are about. */
  visits: number;
  /** How many times they were read from the table, by the one node that locks them and that LIMIT counts. */
  reads: number;
}

function readsOf(plan: PlanNode, alias: string): Reads {
  const nodes = nodesOf(plan);
  const scan = nodes.find((node) => node.Alias === alias);
  assert.ok(scan, `the plan has no scan of ${alias}: ${JSON.stringify(plan)}`);
  const locks = nodes.filter((node) => node['Node Type'] === 'LockRows');
  assert.equal(locks.length, 1, `the plan locks its candidates in one place: ${JSON.stringify(plan)}`);
  return { scan: scan['Node Type'], visits: scan['Actual Loops'], reads: locks[0]['Actual Loops'] };
}

/** How `$queryRaw` and `$executeRaw` are called: as a tag, or given a `Prisma.sql`. */
type Issued = [query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]];

const statementOf = ([query, ...values]: Issued): Prisma.Sql => ('raw' in query ? Prisma.sql(query, ...values) : query);

/**
 * Run a claim, the real method and the real statement, with `r` planned on the outside of a nested loop: inside the
 * claim's own transaction the statistics say `table` has one row and the joins that would read the candidates once
 * anyway are shut. The statement is first run under `EXPLAIN (ANALYZE)` and rolled back to a savepoint, so `reads` is
 * what that very statement does with these rows; the claim then runs and commits, and the statistics go back with it.
 */
async function underRescan<T>(
  h: Harness,
  table: 'watch' | 'watch_delivery',
  alias: string,
  claim: (db: PrismaService) => Promise<T>,
): Promise<{ result: T; reads: Reads[] }> {
  const relation = `'"${table}"'::regclass`;
  const reads: Reads[] = [];
  const result = await h.prisma.$transaction(async (tx) => {
    for (const join of ['enable_hashjoin', 'enable_mergejoin', 'enable_material']) await tx.$executeRawUnsafe(`SET LOCAL ${join} = off`);
    const [stats] = await tx.$queryRawUnsafe<Array<{ reltuples: number; relpages: number }>>(
      `SELECT "reltuples", "relpages" FROM pg_class WHERE "oid" = ${relation}`);
    await tx.$executeRawUnsafe(`UPDATE pg_class SET "reltuples" = 1, "relpages" = 1000000 WHERE "oid" = ${relation}`);
    const dryRun = async (statement: Prisma.Sql): Promise<void> => {
      await tx.$executeRawUnsafe('SAVEPOINT dry_run');
      const [explained] = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, ...statement.values);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT dry_run');
      reads.push(readsOf(explained['QUERY PLAN'][0].Plan, alias));
    };
    const db = {
      $transaction: (work: (client: unknown) => Promise<unknown>) => work(db),
      $executeRaw: (...issued: Issued) => tx.$executeRaw(statementOf(issued)),
      $queryRaw: async (...issued: Issued) => {
        const statement = statementOf(issued);
        if (statement.text.includes('RETURNING')) await dryRun(statement);
        return tx.$queryRaw(statement);
      },
    };
    const claimed = await claim(db as unknown as PrismaService);
    await tx.$executeRawUnsafe(`UPDATE pg_class SET "reltuples" = ${stats.reltuples}, "relpages" = ${stats.relpages} WHERE "oid" = ${relation}`);
    return claimed;
  }, { maxWait: 30_000, timeout: 30_000 });
  assert.notEqual(reads.length, 0, 'the claim issued no statement to read a plan from');
  return { result, reads };
}

/** Prints what the plan did, so a red run says it too. */
function report(t: TestContext, reads: readonly Reads[], claimed: string): void {
  for (const one of reads) t.diagnostic(`${one.scan}: visits ${one.visits}, reads of the candidates ${one.reads}; ${claimed}`);
}

/** The case is about the plan it asked for: the join went back to the candidates, once per row of the table. */
function assertRevisited(reads: readonly Reads[]): void {
  for (const one of reads) assert.ok(one.visits > 1, `the plan went to the candidates once, so this case proved nothing: ${JSON.stringify(one)}`);
}

/** Whatever the join did, the table was read for candidates once. */
function assertReadOnce(reads: readonly Reads[]): void {
  for (const one of reads) assert.equal(one.reads, 1, `the candidates were read from the table more than once: ${JSON.stringify(one)}`);
}

// ── the workers, with nothing but their database ────────────────────────────────────────────────

/** A collaborator these claims never reach. */
const unused = <T>(): T => ({}) as T;

const deliveryOn = (db: PrismaService): WatchDeliveryService =>
  new WatchDeliveryService(db, unused<SessionsService>(), unused<PushService>(), { claimBatch: BATCH });

const evaluatorOn = (db: PrismaService): WatchEvaluatorService =>
  new WatchEvaluatorService(db, unused<RealtimeService>(), { claimBatch: BATCH });

async function statesOf(h: Harness, ids: readonly string[]): Promise<Record<string, string>> {
  const { rows } = await h.sql.query<{ id: string; state: string }>(
    `SELECT "id", "state" FROM "watch_delivery" WHERE "id" = ANY($1::uuid[])`, [ids]);
  return Object.fromEntries(rows.map((row) => [row.id, row.state]));
}

test('the delivery claim leases no more than its batch, under a plan that goes back to its candidates once per row', { skip, timeout: 60_000 }, async (t) => {
  const h = await boot();
  await reset(h);
  const ids = await deliveries(h, 'PENDING', CANDIDATES);

  const { result: claimed, reads } = await underRescan(h, 'watch_delivery', 'due', (db) => deliveryOn(db).claimDue());

  report(t, reads, `claimed ${claimed.length} under a batch of ${BATCH}`);
  assertRevisited(reads);
  assert.deepEqual(claimed.map((row) => row.id).sort(), ids.slice(0, BATCH).sort(), `claimed ${claimed.length} under a batch of ${BATCH}`);
  const states = await statesOf(h, ids);
  assert.deepEqual(ids.map((id) => states[id]), [...Array<string>(BATCH).fill('IN_FLIGHT'), ...Array<string>(CANDIDATES - BATCH).fill('PENDING')],
    'in flight: the batch, and nothing the worker was not told about');
  assertReadOnce(reads);
});

test('the lease-expiry sweep takes back no more than its batch, under the same plan', { skip, timeout: 60_000 }, async (t) => {
  const h = await boot();
  await reset(h);
  // Each on its last attempt, so what the sweep takes it dead-letters: a sweep past its batch would do that to every one.
  const ids = await deliveries(h, 'IN_FLIGHT', CANDIDATES, WATCH_LIMITS.maxDeliveryAttempts - 1);

  const { result: reclaimed, reads } = await underRescan(h, 'watch_delivery', 'expired', (db) => deliveryOn(db).reclaimExpired());

  report(t, reads, `reclaimed ${reclaimed} under a batch of ${BATCH}`);
  assertRevisited(reads);
  assert.equal(reclaimed, BATCH, `reclaimed ${reclaimed} under a batch of ${BATCH}`);
  const states = await statesOf(h, ids);
  assert.deepEqual(ids.map((id) => states[id]), [...Array<string>(BATCH).fill('DEAD_LETTER'), ...Array<string>(CANDIDATES - BATCH).fill('IN_FLIGHT')],
    'the longest-expired dead-lettered, the rest left for the next pass');
  assertReadOnce(reads);
});

test('the evaluation claim leases no more than its batch under the same plan, and says how long each had been due', { skip, timeout: 60_000 }, async (t) => {
  const h = await boot();
  await reset(h);
  const ids = await dueWatches(h, CANDIDATES);

  const { result: claimed, reads } = await underRescan(h, 'watch', 'due', async (db) => {
    const evaluator = evaluatorOn(db);
    // `claimDue` drops the delay; the statement under test is the one that reads it.
    return (evaluator as unknown as { claimDueWithDelay(): Promise<Array<{ id: string; dueSeconds: number }>> }).claimDueWithDelay();
  });

  report(t, reads, `claimed ${claimed.length} under a batch of ${BATCH}`);
  assertRevisited(reads);
  assert.deepEqual(claimed.map((row) => row.id).sort(), ids.slice(0, BATCH).sort(), `claimed ${claimed.length} under a batch of ${BATCH}`);
  // Due an hour ago, less a second or two: the value before the lease moved it, not after.
  for (const row of claimed) assert.ok(row.dueSeconds > 3_500 && row.dueSeconds < 3_600, `due for ${row.dueSeconds} s`);
  const { rows } = await h.sql.query<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM "watch" WHERE "owner_id" = $1 AND "next_evaluate_at" > now()`, [h.ownerId]);
  assert.equal(rows[0].n, BATCH, 'leased: the batch, and nothing the evaluator was not told about');
  assertReadOnce(reads);
});
