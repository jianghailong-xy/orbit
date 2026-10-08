/**
 * The runner's repository operations (contracts/wiki.contract.json `repoOps`, migration 0402), against a
 * real PostgreSQL:
 *
 *   1. dispatch: an operation is handed only to a process that declared `wiki-repo-op/v1` and is the
 *      machine the space's workspace runs on — never to another runner, a draining process or one with no
 *      lease owner — at most two per heartbeat, oldest first, carrying the checkout to read;
 *   2. claiming an operation takes no concurrency slot: `runnerActiveTurns` (the RUNNING sessions a
 *      runner holds) is the same before and after, because a repository operation creates no session;
 *   3. a result, a progress or a fragment under a claim that was taken over is refused STALE_CLAIM and
 *      writes nothing, while the claim that holds the row can still settle it;
 *   4. a snapshot too large for one request body is uploaded in fragments and reassembled — to the byte,
 *      including the characters that are not one byte — into the space's cache, replacing the last one;
 *   5. a job parked on an operation is woken by the NOTIFY the settle writes, not by its poll: the wait
 *      resolves with the answer while its poll interval is still 30 seconds away, and the job is back in
 *      the queue afterwards;
 *   6. the health line: what the space's repository steps depend on, and the one word that says a runner
 *      is too old to be given them.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-repo-ops.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account and spaces, and deletes them afterwards.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';

import { Prisma, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { runnerActiveTurns } from '../common/session-tree-sql';
import { WIKI_REPO_OP_CAPABILITY } from '@orbit/shared';
import { enqueueWikiJob } from './wiki-jobs';
import { WikiRepoOpChannel } from './wiki-repo-op-notify';
import {
  WikiRepoOps,
  WIKI_REPO_OP_REFUSAL_STATUS,
  WikiRepoOpRefused,
  readWikiRepoReadiness,
  readWikiRepoSnapshot,
  waitForWikiRepoOpAsJob,
} from './wiki-repo-ops';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

interface Fixture {
  ownerId: string;
  spaceId: string;
  workspaceId: string;
  runnerId: string;
  otherRunnerId: string;
  workDir: string;
}

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  ops: WikiRepoOps;
  owner: Fixture;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const service = prisma as unknown as PrismaService;
    return { sql, prisma, ops: new WikiRepoOps(service), owner: await fixture(prisma) };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, owner } = await harness;
  await prisma.wikiSpace.deleteMany({ where: { ownerId: owner.ownerId } }).catch(() => undefined);
  await prisma.runner.deleteMany({ where: { ownerId: owner.ownerId } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { ownerId: owner.ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: owner.ownerId } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
});

/** One account with a space, a workspace on a machine, and another machine's id to hand things to. */
async function fixture(prisma: PrismaClient): Promise<Fixture> {
  const ownerId = randomUUID();
  await prisma.user.create({ data: { id: ownerId, email: `repo-ops-${ownerId}@wiki.invalid`, name: 'repo ops spec', passwordHash: 'x' } });
  const runnerId = randomUUID();
  const otherRunnerId = randomUUID();
  const runner = (id: string, capabilities: string[]) => ({
    id, name: `repo-ops-${id.slice(0, 8)}`, ownerId, tokenHash: `hash-${id}`,
    capabilities, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
  });
  await prisma.runner.create({ data: runner(runnerId, [WIKI_REPO_OP_CAPABILITY]) });
  await prisma.runner.create({ data: runner(otherRunnerId, [WIKI_REPO_OP_CAPABILITY]) });
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, name: 'repo ops checkout', runnerId, workDir: '/tmp/repo-ops-spec' },
  });
  const spaceId = randomUUID();
  await prisma.wikiSpace.create({
    data: {
      id: spaceId,
      ownerId,
      slug: `repo-ops-${spaceId.slice(0, 8)}`,
      title: 'Repo ops spec',
      repoUrlNorm: 'github.com/example/orbit',
      rootCommitSha: 'a'.repeat(40),
      settings: { maintenance: { workspaceId } },
    },
  });
  return { ownerId, spaceId, workspaceId, runnerId, otherRunnerId, workDir: '/tmp/repo-ops-spec' };
}

/** A job of this spec's account, and a repository operation hanging off it. */
async function queued(
  h: Harness,
  kind: 'snapshot' | 'read' | 'diff' | 'anchors',
  input: Record<string, unknown> = {},
): Promise<{ jobId: string; opId: string }> {
  const jobId = randomUUID();
  await enqueueWikiJob(h.prisma as unknown as PrismaService, {
    id: jobId, ownerId: h.owner.ownerId, spaceId: h.owner.spaceId, kind: 'maintain',
  });
  const { id } = await h.ops.enqueueWikiRepoOp({ jobId, kind, input });
  return { jobId, opId: id };
}

/** The heartbeat of the machine the workspace runs on. */
function beat(h: Harness, over: Partial<Parameters<WikiRepoOps['dispatch']>[0]> = {}) {
  return h.ops.dispatch({
    runnerId: h.owner.runnerId,
    leaseOwner: randomUUID(),
    draining: false,
    capabilities: [WIKI_REPO_OP_CAPABILITY],
    ...over,
  });
}

/** A fresh claim of one operation, by a process the spec can name. */
async function claim(
  h: Harness,
  opId: string,
  leaseOwner: string,
  runnerId = h.owner.runnerId,
): Promise<number> {
  // The claim takes the oldest queued row of this machine; the spec asks for its own by taking one at a
  // time and checking it is the one it wanted.
  const claimed = await h.ops.dispatch({ runnerId, leaseOwner, draining: false, capabilities: [WIKI_REPO_OP_CAPABILITY] });
  const row = claimed.find((candidate) => candidate.id === opId);
  assert.ok(row, `the heartbeat did not claim ${opId}: ${claimed.map((candidate) => candidate.id).join(', ')}`);
  return row.claimGeneration;
}

/** How many RUNNING sessions this runner holds — the slot count a repository operation must not move. */
async function activeTurns(h: Harness, runnerId = h.owner.runnerId): Promise<number> {
  const [row] = await h.prisma.$queryRaw<Array<{ active: bigint }>>(
    Prisma.sql`SELECT ${runnerActiveTurns(Prisma.sql`${runnerId}::uuid`)} AS "active"`,
  );
  return Number(row?.active ?? -1);
}

test('an operation is handed only to a capable process on the space\'s own machine', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const { jobId, opId } = await queued(h, 'read', { sha: 'b'.repeat(40), items: [] });

  assert.deepEqual(await beat(h, { leaseOwner: null }), [], 'a heartbeat with no process identity is handed nothing');
  assert.deepEqual(await beat(h, { draining: true }), [], 'a draining process is handed nothing');
  assert.deepEqual(await beat(h, { capabilities: ['integration-job/v1'] }), [], 'a runner without the capability is handed nothing');
  assert.deepEqual(
    await beat(h, { runnerId: h.owner.otherRunnerId }),
    [],
    'another machine is handed nothing, even with the capability',
  );

  // At most two per beat, oldest first — a machine that took three would be holding the third's slot
  // while it worked on the first.
  await queued(h, 'diff', { from: 'c'.repeat(40), to: 'd'.repeat(40) });
  const { opId: third } = await queued(h, 'anchors', {});
  const first = await beat(h);
  assert.equal(first.length, 2, 'a heartbeat claims at most two operations');
  assert.deepEqual(first.map((row) => row.kind), ['read', 'diff'], 'the oldest first');
  assert.equal(first[0].workDir, h.owner.workDir, 'the checkout to read travels with the claim');
  assert.equal(first[0].repoUrlNorm, 'github.com/example/orbit');
  assert.equal(first[0].rootCommitSha, 'a'.repeat(40));
  assert.deepEqual(first[0].input, { sha: 'b'.repeat(40), items: [] });
  const rest = await beat(h, { leaseOwner: first[0].leaseOwner });
  assert.deepEqual(rest.map((row) => row.id), [third], 'the third waits for the next beat');
  // The claims are written down: these rows are running under this process's lease, so the beat after them
  // is handed nothing it already holds.
  assert.deepEqual(await beat(h, { leaseOwner: first[0].leaseOwner }), []);

  await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
});

test('claiming an operation takes no concurrency slot: runnerActiveTurns does not move', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const { jobId } = await queued(h, 'read', { sha: 'b'.repeat(40), items: [] });
  const before = await activeTurns(h);
  await beat(h);
  assert.equal(await activeTurns(h), before, 'a claimed repository operation is not a RUNNING session');
  // And the row that proves it: no session was created for this account at all.
  assert.equal(await h.prisma.session.count({ where: { ownerId: h.owner.ownerId } }), 0);
  await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
});

test('a result, a progress and a fragment under a taken-over claim are refused STALE_CLAIM', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const { jobId, opId } = await queued(h, 'read', { sha: 'b'.repeat(40), items: [] });
  const first = randomUUID();
  const firstGeneration = await claim(h, opId, first);

  // The process stops beating, and another one on the same machine takes the operation over.
  await h.sql.query(`UPDATE "wiki_repo_op" SET "heartbeat_at" = now() - interval '10 minutes' WHERE "id" = $1`, [opId]);
  const second = randomUUID();
  const secondGeneration = await claim(h, opId, second);
  assert.equal(secondGeneration, firstGeneration + 1, 'a takeover is a new generation');

  const stale = { claimGeneration: firstGeneration, leaseOwner: first };
  await assert.rejects(
    () => h.ops.applyWikiRepoOpResult({ id: opId, runnerId: h.owner.runnerId, ...{ body: { ...stale, state: 'succeeded', result: { ok: true } } } }),
    (error: unknown) => error instanceof WikiRepoOpRefused && error.refusal === 'STALE_CLAIM',
  );
  await assert.rejects(
    () => h.ops.progress({ id: opId, runnerId: h.owner.runnerId, ...stale }),
    (error: unknown) => error instanceof WikiRepoOpRefused && error.refusal === 'STALE_CLAIM',
  );
  await assert.rejects(
    () => h.ops.storeWikiRepoOpFragment({
      id: opId, runnerId: h.owner.runnerId, ...stale, index: 0, total: 1, sha: 'b'.repeat(40), content: '{"a":1}',
    }),
    (error: unknown) => error instanceof WikiRepoOpRefused && error.refusal === 'STALE_CLAIM',
  );
  assert.equal(WIKI_REPO_OP_REFUSAL_STATUS.STALE_CLAIM, 409, 'the route answers 409 for it');
  // Nothing was written by the process that lost the claim.
  const { rows: [row] } = await h.sql.query<{ state: string; result: unknown }>(`SELECT "state", "result" FROM "wiki_repo_op" WHERE "id" = $1`, [opId]);
  assert.equal(row.state, 'running');
  assert.equal(row.result, null);
  assert.equal(await h.prisma.wikiRepoOpFragment.count({ where: { opId } }), 0);
  // The claim that holds it can still settle it.
  const answer = await h.ops.applyWikiRepoOpResult({
    id: opId, runnerId: h.owner.runnerId, body: { claimGeneration: secondGeneration, leaseOwner: second, state: 'succeeded', result: { items: [] } },
  });
  assert.deepEqual(answer, { accepted: true, state: 'succeeded' });
  // And a second copy of the same result — a response that was lost — is answered with what the row says
  // rather than refused.
  const again = await h.ops.applyWikiRepoOpResult({
    id: opId, runnerId: h.owner.runnerId, body: { claimGeneration: secondGeneration, leaseOwner: second, state: 'succeeded', result: { items: [] } },
  });
  assert.equal(again.accepted, false);
  assert.equal(again.state, 'succeeded');
  await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
});

test('a snapshot uploaded in fragments is reassembled to the byte, and replaces the last one', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const { jobId, opId } = await queued(h, 'snapshot', { skipSha: null });
  const leaseOwner = randomUUID();
  const generation = await claim(h, opId, leaseOwner);
  const fence = { claimGeneration: generation, leaseOwner };

  // Three fragments, cut where a character is two bytes wide, so a reassembly that counted characters
  // instead of bytes would come back short.
  const payload = JSON.stringify({ sha: 'b'.repeat(40), files: ['文档/一.md', 'src/a.ts'], note: '中文与 ASCII 混排' }, null, 1);
  const pieces = [payload.slice(0, 40), payload.slice(40, 90), payload.slice(90)];
  for (const [index, content] of pieces.entries()) {
    const stored = await h.ops.storeWikiRepoOpFragment({
      id: opId, runnerId: h.owner.runnerId, ...fence, index, total: pieces.length, sha: 'b'.repeat(40), content,
    });
    assert.equal(stored.received, index + 1, 'the fragments stage one at a time');
  }
  // A fragment that was sent twice is one fragment, not one more.
  await h.ops.storeWikiRepoOpFragment({
    id: opId, runnerId: h.owner.runnerId, ...fence, index: 2, total: pieces.length, sha: 'b'.repeat(40), content: pieces[2],
  });

  const bytes = Buffer.byteLength(payload, 'utf8');
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  const answer = await h.ops.applyWikiRepoOpResult({
    id: opId,
    runnerId: h.owner.runnerId,
    body: { ...fence, state: 'succeeded', result: { sha: 'b'.repeat(40), bytes, digest, fragments: pieces.length } },
  });
  assert.deepEqual(answer, { accepted: true, state: 'succeeded' });

  const snapshot = await readWikiRepoSnapshot(h.prisma as unknown as PrismaService, { ownerId: h.owner.ownerId, spaceId: h.owner.spaceId });
  assert.ok(snapshot, 'the space has a snapshot');
  assert.equal(snapshot.sha, 'b'.repeat(40));
  assert.equal(snapshot.bytes, bytes);
  assert.equal(snapshot.digest, digest);
  assert.equal(snapshot.index, payload, 'the fragments reassemble to exactly the bytes that were sent');
  assert.equal(await h.prisma.wikiRepoOpFragment.count({ where: { opId } }), 0, 'the staging is dropped with the settle');

  // A newer commit replaces it whole: one snapshot per space, and the old fragments go with it.
  const { jobId: secondJob, opId: secondOp } = await queued(h, 'snapshot', {});
  const secondLease = randomUUID();
  const secondGeneration = await claim(h, secondOp, secondLease);
  const secondPayload = JSON.stringify({ sha: 'e'.repeat(40) });
  await h.ops.applyWikiRepoOpResult({
    id: secondOp,
    runnerId: h.owner.runnerId,
    body: {
      claimGeneration: secondGeneration,
      leaseOwner: secondLease,
      state: 'succeeded',
      result: { sha: 'e'.repeat(40), index: secondPayload },
    },
  });
  assert.equal(await h.prisma.wikiRepoSnapshot.count({ where: { spaceId: h.owner.spaceId } }), 1);
  const replaced = await readWikiRepoSnapshot(h.prisma as unknown as PrismaService, { ownerId: h.owner.ownerId, spaceId: h.owner.spaceId });
  assert.equal(replaced?.index, secondPayload);
  assert.equal(await h.prisma.wikiRepoSnapshotFragment.count({ where: { spaceId: h.owner.spaceId } }), 1);

  // A snapshot the runner says the server already holds is only honoured while that is true.
  const { jobId: thirdJob, opId: thirdOp } = await queued(h, 'snapshot', {});
  const thirdLease = randomUUID();
  const thirdGeneration = await claim(h, thirdOp, thirdLease);
  await assert.rejects(
    () => h.ops.applyWikiRepoOpResult({
      id: thirdOp,
      runnerId: h.owner.runnerId,
      body: { claimGeneration: thirdGeneration, leaseOwner: thirdLease, state: 'succeeded', result: { sha: 'f'.repeat(40), skipped: true } },
    }),
    (error: unknown) => error instanceof WikiRepoOpRefused && error.refusal === 'INVALID_RESULT',
  );
  const skipped = await h.ops.applyWikiRepoOpResult({
    id: thirdOp,
    runnerId: h.owner.runnerId,
    body: { claimGeneration: thirdGeneration, leaseOwner: thirdLease, state: 'succeeded', result: { sha: 'e'.repeat(40), skipped: true } },
  });
  assert.deepEqual(skipped, { accepted: true, state: 'succeeded' });

  await h.prisma.wikiJob.deleteMany({ where: { id: { in: [jobId, secondJob, thirdJob] } } });
});

test('a job parked on an operation is woken by the NOTIFY, and is back in the queue afterwards', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const { jobId, opId } = await queued(h, 'read', { sha: 'b'.repeat(40), items: [] });
  const leaseOwner = randomUUID();
  const generation = await claim(h, opId, leaseOwner);

  // The job is claimed and running, as the worker would have it.
  const jobGeneration = randomUUID();
  await h.sql.query(
    `UPDATE "wiki_job" SET "state" = 'running', "lease_owner" = $2::uuid, "lease_generation" = $3::uuid,
       "lease_deadline_at" = now() + interval '60 seconds' WHERE "id" = $1`,
    [jobId, randomUUID(), jobGeneration],
  );

  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = URL_;
  const channel = new WikiRepoOpChannel();
  channel.onModuleInit();
  try {
    const waiting = waitForWikiRepoOpAsJob(h.prisma as unknown as PrismaService, {
      jobId,
      generation: jobGeneration,
      opId,
      timeoutMs: 20_000,
      // Long enough that only the NOTIFY can end this wait in time.
      pollMs: 30_000,
      wake: channel,
    });
    // The job holds no lease while it waits: the row is waiting, and nothing else may claim it.
    await delay(200);
    const { rows: [parked] } = await h.sql.query<{ state: string; waiting_for: string | null; lease_owner: string | null }>(
      `SELECT "state", "waiting_for", "lease_owner" FROM "wiki_job" WHERE "id" = $1`, [jobId]);
    assert.equal(parked.state, 'waiting');
    assert.equal(parked.waiting_for, 'repo');
    assert.equal(parked.lease_owner, null);

    const started = Date.now();
    await h.ops.applyWikiRepoOpResult({
      id: opId,
      runnerId: h.owner.runnerId,
      body: { claimGeneration: generation, leaseOwner, state: 'succeeded', result: { items: [{ path: 'a.md', found: true }] } },
    });
    const answer = await waiting;
    assert.equal(answer.state, 'succeeded');
    assert.deepEqual(answer.result, { items: [{ path: 'a.md', found: true }] });
    assert.ok(Date.now() - started < 10_000, 'the wait ended on the notification, not on its 30-second poll');
  } finally {
    channel.onModuleDestroy();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  const { rows: [job] } = await h.sql.query<{ state: string; waiting_for: string | null; next_attempt_at: Date | null }>(
    `SELECT "state", "waiting_for", "next_attempt_at" FROM "wiki_job" WHERE "id" = $1`, [jobId]);
  assert.equal(job.state, 'queued', 'the job is back in the queue, where the claim picks it up again');
  assert.equal(job.waiting_for, null);

  await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
});

test('a read that waits past its limit puts the job back as an infra failure', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const { jobId, opId } = await queued(h, 'read', { sha: 'b'.repeat(40), items: [] });
  const jobGeneration = randomUUID();
  await h.sql.query(
    `UPDATE "wiki_job" SET "state" = 'running', "lease_owner" = $2::uuid, "lease_generation" = $3::uuid,
       "lease_deadline_at" = now() + interval '60 seconds' WHERE "id" = $1`,
    [jobId, randomUUID(), jobGeneration],
  );
  await assert.rejects(
    () => waitForWikiRepoOpAsJob(h.prisma as unknown as PrismaService, {
      jobId, generation: jobGeneration, opId, timeoutMs: 300, pollMs: 50,
    }),
    (error: unknown) => error instanceof Error && error.name === 'WikiRepoOpWaitTimedOut',
  );
  const { rows: [job] } = await h.sql.query<{ state: string; failure_kind: string | null; attempts: number; error: string | null }>(
    `SELECT "state", "failure_kind", "attempts", "error" FROM "wiki_job" WHERE "id" = $1`, [jobId]);
  assert.equal(job.state, 'queued');
  assert.equal(job.failure_kind, 'infra');
  assert.equal(job.attempts, 1);
  // The operation is still queued and still belongs to the job: nothing was cancelled by the wait ending.
  assert.equal((await h.prisma.wikiRepoOp.findUnique({ where: { id: opId } }))?.state, 'queued');
  await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
});

test('the health line: what the repository steps depend on, and which word says upgrade the runner', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  const service = h.prisma as unknown as PrismaService;
  const read = () => readWikiRepoReadiness(service, { ownerId: h.owner.ownerId, spaceId: h.owner.spaceId });
  // This space is the spec's one space, so the count is read against where it stands before this case:
  // what the number means is that a queued operation of this space is counted.
  const before = (await read()).pending;
  const { jobId } = await queued(h, 'read', { sha: 'b'.repeat(40), items: [] });

  const ready = await read();
  assert.equal(ready.look, 'ready');
  assert.equal(ready.pending, before + 1, 'the queued operation is what a reader is waiting on');
  assert.equal(ready.runner?.capability, true);
  assert.equal(ready.runner?.online, true);

  await h.prisma.runner.update({ where: { id: h.owner.runnerId }, data: { capabilities: ['integration-job/v1'] } });
  assert.equal((await read()).look, 'runner_upgrade', 'a runner that never declared the capability is upgraded');

  await h.prisma.runner.update({
    where: { id: h.owner.runnerId },
    data: { capabilities: [WIKI_REPO_OP_CAPABILITY], lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
  });
  assert.equal((await read()).look, 'runner_offline');

  await h.prisma.runner.update({ where: { id: h.owner.runnerId }, data: { lastHeartbeatAt: new Date() } });
  await h.prisma.workspace.update({ where: { id: h.owner.workspaceId }, data: { workDir: null } });
  assert.equal((await read()).look, 'no_workspace');

  await h.prisma.wikiJob.deleteMany({ where: { id: jobId } });
});
