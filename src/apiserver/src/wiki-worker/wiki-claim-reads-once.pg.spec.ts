/**
 * A claim reads its candidates once (contracts/wiki.contract.json `modelQueue.claim`, `jobs.lease.claim`, `repoOps.claim`),
 * against a real PostgreSQL pushed into the plan that would read them again:
 *
 *   1. the model queue's claim takes no more than the room the concurrency leaves, the first in the queue's order;
 *   2. a job's cap holds under the same plan: a job passes `maxInFlightPerJob` neither in one claim nor in the next;
 *   3. the job claim takes no more than the room the worker gave it, the first in the line;
 *   4. a heartbeat's operations are claimed one row at a time, so it hands over `perHeartbeat` and strands none.
 *
 * THE PLAN
 * `UPDATE t AS r … FROM (SELECT … LIMIT n FOR UPDATE SKIP LOCKED) AS due WHERE r.id = due.id` may run as a nested loop
 * with `r` outside, which executes the subquery once for each row of `r`. Each execution locks past the rows this
 * statement has already updated, so LIMIT reaches further down the candidates, and with `r` in the claim's own order
 * the statement takes every one of them. n stops bounding anything.
 *
 * PostgreSQL picks that plan when its statistics say the table has one row: a table analyzed while it was nearly
 * empty, under default settings. So a case that leaves the plan to the planner proves nothing: on 2026-10-28 one run of
 * the queue's spec took 3 under a room of 2 in 28 passes, and the next 400 passes took 2. `underRescan` sets that plan
 * up inside the claim's own transaction instead, and each case reads the plan back, so a case the plan stopped
 * reaching goes red rather than green.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-claim-reads-once.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account and spaces, and deletes them afterwards. The statistics
 * it changes are put back in the transaction that changed them.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test, type TestContext } from 'node:test';

import { Prisma, type PrismaClient } from '@prisma/client';
import { WIKI_MODEL_QUEUE, WIKI_REPO_OPS, WIKI_REPO_OP_CAPABILITY } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { claimWikiJobs } from './wiki-jobs';
import { claimWikiModelRequests, wikiModelRequestSha256, type WikiModelRequestCall } from './wiki-model-queue';
import { claimWikiRepoOps, WikiRepoOps } from './wiki-repo-ops';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  ownerId: string;
  spaceId: string;
  runnerId: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    return { sql, prisma, ...(await fixture(prisma)) };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, ownerId } = await harness;
  await prisma.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.runner.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
});

/** One account, a machine with a checkout, and a space that reads its repository there. */
async function fixture(prisma: PrismaClient): Promise<Pick<Harness, 'ownerId' | 'spaceId' | 'runnerId'>> {
  const ownerId = randomUUID();
  await prisma.user.create({ data: { id: ownerId, email: `wiki-reads-once-${ownerId}@wiki.invalid`, name: 'reads once spec', passwordHash: 'x' } });
  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId, name: `reads-once-${runnerId.slice(0, 8)}`, ownerId, tokenHash: `hash-${runnerId}`,
      capabilities: [WIKI_REPO_OP_CAPABILITY], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, ownerId, name: 'reads once checkout', runnerId, workDir: '/tmp/reads-once-spec' } });
  const spaceId = randomUUID();
  await prisma.wikiSpace.create({
    data: {
      id: spaceId, ownerId, slug: `reads-once-${spaceId.slice(0, 8)}`, title: 'Reads once spec',
      repoUrlNorm: 'github.com/example/orbit', rootCommitSha: 'a'.repeat(40), settings: { maintenance: { workspaceId } },
    },
  });
  return { ownerId, spaceId, runnerId };
}

/** This account's jobs gone, and with them their requests and operations; the spaces a case made gone too. */
async function reset(h: Harness): Promise<void> {
  await h.prisma.wikiJob.deleteMany({ where: { ownerId: h.ownerId } });
  await h.prisma.wikiSpace.deleteMany({ where: { ownerId: h.ownerId, id: { not: h.spaceId } } });
}

const service = (h: Harness): PrismaService => h.prisma as unknown as PrismaService;

/** `count` jobs of the fixture's space, to hang requests and operations on. */
async function jobs(h: Harness, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await h.prisma.wikiJob.createMany({ data: ids.map((id) => ({ id, ownerId: h.ownerId, spaceId: h.spaceId, kind: 'smoke' })) });
  return ids;
}

/**
 * One due request for each job named, oldest first. One statement, so the rows lie in the table in the order the claim
 * takes them: that is the order in which `r`, read first, meets each one among the candidates, and the plan's worst.
 */
async function enqueue(h: Harness, jobIds: readonly string[]): Promise<string[]> {
  const ids = jobIds.map(() => randomUUID());
  const call: WikiModelRequestCall = { system: 's', prompt: 'p', maxTokens: 32 };
  await h.sql.query(
    `INSERT INTO "wiki_model_request" ("id", "job_id", "owner_id", "space_id", "step", "unit", "request", "request_sha256", "enqueued_at")
     SELECT o."id", o."job", $3, $4, 'extract', 'unit-' || o."place", $5::jsonb, $6, now() - interval '1 hour' + o."place" * interval '1 second'
       FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS o("id", "job", "place")
      ORDER BY o."place"`,
    [ids, jobIds, h.ownerId, h.spaceId, JSON.stringify(call), wikiModelRequestSha256(call)],
  );
  return ids;
}

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
 * Run a claim, the real function and the real statement, with `r` planned on the outside of a nested loop.
 *
 * Inside the claim's own transaction, so nothing a concurrent autovacuum writes can move the plan: the statistics say
 * `table` has one row, however many pages it has, which is what makes the planner put it outside, and the settings
 * shut the joins that would read the candidates once anyway. The statement that writes is first run under
 * `EXPLAIN (ANALYZE)` and rolled back to a savepoint, so `reads` is what that very statement does with these rows and
 * these settings. The claim then runs and commits, and the statistics go back with it.
 */
async function underRescan<T>(
  h: Harness,
  table: 'wiki_model_request' | 'wiki_job' | 'wiki_repo_op',
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

/** Prints what the plan did, so a red run says it too; a case reads these itself, with `assertRevisited` and `assertReadOnce`. */
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

/** The requests in flight, by job. */
async function inFlight(h: Harness): Promise<Record<string, number>> {
  const { rows } = await h.sql.query<{ job_id: string; n: number }>(
    `SELECT "job_id", count(*)::int AS "n" FROM "wiki_model_request"
      WHERE "owner_id" = $1 AND "state" = 'running' AND "lease_deadline_at" > now() GROUP BY 1`, [h.ownerId]);
  return Object.fromEntries(rows.map((row) => [row.job_id, row.n]));
}

test('the model queue\'s claim takes no more than the room, under a plan that goes back to its candidates once per row', { skip, timeout: 60_000 }, async (t) => {
  const h = await boot();
  await reset(h);
  const [one, two] = await jobs(h, 2);
  // Two jobs, so the per-job cap decides nothing. The oldest goes in flight first, so a concurrency of 3 leaves a room of 2.
  const ids = await enqueue(h, [one, one, one, two, two, two]);
  const [running] = await claimWikiModelRequests(service(h), { workerId: randomUUID(), concurrency: 1, owners: null });
  assert.equal(running.id, ids[0]);

  const { result: claimed, reads } = await underRescan(h, 'wiki_model_request', 'due', (db) =>
    claimWikiModelRequests(db, { workerId: randomUUID(), concurrency: 3, owners: null }));

  report(t, reads, `claimed ${claimed.length} under a room of 2`);
  assertRevisited(reads);
  assert.deepEqual(claimed.map((row) => row.id).sort(), ids.slice(1, 3).sort(), `claimed ${claimed.length} under a room of 2`);
  assert.deepEqual(await inFlight(h), { [one]: 3 }, 'running with a live lease: the concurrency and no more');
  assertReadOnce(reads);
});

test('a job\'s cap holds under the same plan, in one claim and in the next', { skip, timeout: 60_000 }, async (t) => {
  const h = await boot();
  await reset(h);
  const cap = WIKI_MODEL_QUEUE.maxInFlightPerJob;
  const [full, other] = await jobs(h, 2);
  // More of one job than its cap, all ahead of another's, under a room wider than the cap: the cap is what stops `full`.
  await enqueue(h, [...Array<string>(cap + 4).fill(full), ...Array<string>(3).fill(other)]);
  const room = cap + 2;

  const first = await underRescan(h, 'wiki_model_request', 'due', (db) =>
    claimWikiModelRequests(db, { workerId: randomUUID(), concurrency: room, owners: null }));

  report(t, first.reads, `claimed ${first.result.length} under a room of ${room}, ${(await inFlight(h))[full]} of one job under a cap of ${cap}`);
  assertRevisited(first.reads);
  assert.equal((await inFlight(h))[full], cap, 'the job at its cap, by its own rows and no others');
  assert.equal(first.result.length, room, `claimed ${first.result.length} under a room of ${room}`);
  assert.deepEqual(await inFlight(h), { [full]: cap, [other]: 2 });

  // What is already in flight counts: the room is 2 again, and only `other` has anything left to take.
  const next = await underRescan(h, 'wiki_model_request', 'due', (db) =>
    claimWikiModelRequests(db, { workerId: randomUUID(), concurrency: room + 2, owners: null }));

  report(t, next.reads, `then ${next.result.length} more under a room of 2, ${(await inFlight(h))[full]} of that job under its cap`);
  assertRevisited(next.reads);
  assert.deepEqual(await inFlight(h), { [full]: cap, [other]: 3 });
  assertReadOnce([...first.reads, ...next.reads]);
});

test('the job claim takes no more than the worker\'s room, under the same plan', { skip, timeout: 60_000 }, async (t) => {
  const h = await boot();
  await reset(h);
  // A free space per job, so every one of them is a candidate: the claim's LIMIT is all that stands between them.
  const spaces = Array.from({ length: 5 }, () => randomUUID());
  const ids = spaces.map(() => randomUUID());
  await h.prisma.wikiSpace.createMany({
    data: spaces.map((id) => ({ id, ownerId: h.ownerId, slug: `reads-once-${id.slice(0, 8)}`, title: 'Reads once spec' })),
  });
  // One statement again, oldest first: the line is by place, and this is its order in the table too.
  await h.sql.query(
    `INSERT INTO "wiki_job" ("id", "owner_id", "space_id", "kind", "created_at")
     SELECT o."id", $3, o."space", 'smoke', now() - interval '1 hour' + o."place" * interval '1 second'
       FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS o("id", "space", "place")
      ORDER BY o."place"`, [ids, spaces, h.ownerId]);

  const { result: claimed, reads } = await underRescan(h, 'wiki_job', 'due', (db) =>
    claimWikiJobs(db, { workerId: randomUUID(), kinds: ['smoke'], owners: [h.ownerId], limit: 2 }));

  report(t, reads, `claimed ${claimed.length} under a room of 2`);
  assertRevisited(reads);
  assert.deepEqual(claimed.map((row) => row.id).sort(), ids.slice(0, 2).sort(), `claimed ${claimed.length} under a room of 2`);
  const { rows } = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS "n" FROM "wiki_job" WHERE "owner_id" = $1 AND "state" = 'running'`, [h.ownerId]);
  assert.equal(rows[0].n, 2, 'running, and nothing claimed that the worker was not told about');
  assertReadOnce(reads);
});

test('a heartbeat hands over its operations one row at a time, and strands none', { skip, timeout: 60_000 }, async (t) => {
  const h = await boot();
  await reset(h);
  const [job] = await jobs(h, 1);
  const ops = new WikiRepoOps(service(h));
  for (let i = 0; i < WIKI_REPO_OPS.perHeartbeat + 3; i += 1) await ops.enqueueWikiRepoOp({ jobId: job, kind: 'read' });
  const warnings: string[] = [];

  const { result: claims, reads } = await underRescan(h, 'wiki_repo_op', 'candidate', (db) =>
    claimWikiRepoOps(db, {
      runnerId: h.runnerId, leaseOwner: randomUUID(), draining: false, capabilities: [WIKI_REPO_OP_CAPABILITY],
    }, { warn: (message) => warnings.push(message) }));

  report(t, reads, `handed over ${claims.length} of ${WIKI_REPO_OPS.perHeartbeat}`);
  assert.deepEqual(warnings, []);
  assert.equal(reads.length, WIKI_REPO_OPS.perHeartbeat, 'one statement per operation');
  assertRevisited(reads);
  assert.equal(claims.length, WIKI_REPO_OPS.perHeartbeat);
  // `claimOne` reads the first row its statement answers: a second one would be running under a claim nobody holds.
  const { rows } = await h.sql.query<{ id: string }>(`SELECT "id" FROM "wiki_repo_op" WHERE "job_id" = $1 AND "state" = 'running'`, [job]);
  assert.deepEqual(rows.map((row) => row.id).sort(), claims.map((claim) => claim.id).sort());
  assertReadOnce(reads);
});
