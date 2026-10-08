/**
 * The rollback sweep (contracts/wiki.contract.json `jobs.executor.rollback`; design §10), against a
 * real PostgreSQL — the 2026-10-08 production incident as a spec: the executor switch moved back to
 * `runner` while the owner's `maintain` job was still extracting, and nothing cancelled what the
 * server had in flight, so the unfinished job held the space's maintenance on both paths.
 *
 *   1. switching to `runner` cancels, at the sweep the apiserver start runs, every in-flight job of
 *      an account the switch no longer serves — the `maintain` job's run row is failed / infra (and
 *      is not counted against the space's streak), the verify job's calls and the plan draft's job
 *      are ended with why — and the next fact makes the runner path's maintenance task;
 *   2. an account still on the `canary` list is untouched: the sweep cancels nothing, and the
 *      unfinished job holds the space the way it did;
 *   3. under `canary`, an account off the list is cancelled while one on it is not.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-executor-sweep.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own accounts, spaces and sessions, and deletes
 * them afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { cancelUnservedWikiJobs } from './wiki-executor-sweep';
import { considerWikiMaintenance } from './wiki-maintenance-run';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

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
    await prisma.user.create({ data: { id: ownerId, email: `wiki-executor-sweep-${ownerId}@wiki.invalid`, name: 'executor sweep spec', passwordHash: 'x' } });
    return { sql, prisma, ownerId };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, ownerId } = await harness;
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  await prisma.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.runner.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.taskList.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
});

interface Fixture {
  spaceId: string;
  workspaceId: string;
  listId: string;
  sessionId: string;
}

/**
 * One space of its own with a workspace, the hidden maintenance list, and a session that came to
 * rest a day and an hour ago — a fact after the cursor, past the settle grace, and old enough for
 * the space to be due by age, so the trigger has something to make once the sweep has run.
 */
async function fixture(h: Harness, ownerId: string): Promise<Fixture> {
  const runnerId = randomUUID();
  await h.prisma.runner.create({
    data: { id: runnerId, name: `sweep-${runnerId.slice(0, 8)}`, ownerId, tokenHash: `hash-${runnerId}`, lastHeartbeatAt: new Date() },
  });
  const workspaceId = randomUUID();
  await h.prisma.workspace.create({
    data: { id: workspaceId, ownerId, name: 'sweep checkout', runnerId, workDir: '/tmp/sweep-spec' },
  });
  const spaceId = randomUUID();
  const listId = randomUUID();
  await h.prisma.taskList.create({ data: { id: listId, ownerId, title: 'Wiki maintenance', hidden: true, maxConcurrent: 1 } });
  await h.prisma.wikiSpace.create({
    data: {
      id: spaceId, ownerId, slug: `sweep-${spaceId.slice(0, 8)}`, title: 'app',
      repoUrlNorm: `github.com/example/sweep-${spaceId.slice(0, 8)}`, rootCommitSha: 'b'.repeat(40),
      settings: { reviewMode: 'manual', maintenance: { enabled: true, workspaceId, provider: 'local-vllm', listId } } as never,
    },
  });
  await h.prisma.wikiSpaceWorkspace.create({ data: { spaceId, ownerId, workspaceId } });
  const sessionId = randomUUID();
  const settled = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await h.prisma.session.create({
    data: {
      id: sessionId, title: 'a settled session', prompt: 'p', ownerId, creatorId: ownerId,
      dispatchOrigin: 'USER', status: 'SUCCEEDED', workspaceId, assignedRunnerId: runnerId, lastTurnAt: settled,
    },
  });
  return { spaceId, workspaceId, listId, sessionId };
}

/** The lease a claimed row holds, a minute from running out. */
function lease() {
  return {
    leaseOwner: randomUUID(),
    leaseGeneration: randomUUID(),
    leaseDeadlineAt: new Date(Date.now() + 60_000),
  };
}

/** One running `maintain` job mid-extraction, with its run row, two calls out and one repo op queued. */
async function inFlightMaintainJob(h: Harness, ownerId: string, fx: Fixture) {
  const runId = randomUUID();
  const jobId = randomUUID();
  await h.prisma.wikiMaintenanceRun.create({
    data: {
      id: runId, spaceId: fx.spaceId, ownerId, jobId, due: 'backlog', pendingSessions: 1,
      startedAt: new Date(), lastStartedAt: new Date(), attempts: 1,
    },
  });
  await h.prisma.wikiJob.create({
    data: {
      id: jobId, ownerId, spaceId: fx.spaceId, kind: 'maintain', input: { runId }, priority: 0,
      state: 'running', startedAt: new Date(), ...lease(),
    },
  });
  // What the production incident left running: two extract calls in flight, one with a partial.
  const running = await h.prisma.wikiModelRequest.create({
    data: {
      jobId, ownerId, spaceId: fx.spaceId, step: 'extract', unit: `${fx.sessionId}:0`, attempt: 1,
      request: { system: 's', prompt: 'p', maxTokens: 1 }, requestSha256: 'a'.repeat(64),
      state: 'running', partial: 'the first tokens', startedAt: new Date(), enqueuedAt: new Date(), ...lease(),
    },
  });
  const queued = await h.prisma.wikiModelRequest.create({
    data: {
      jobId, ownerId, spaceId: fx.spaceId, step: 'extract', unit: `${fx.sessionId}:1`, attempt: 1,
      request: { system: 's', prompt: 'p', maxTokens: 1 }, requestSha256: 'b'.repeat(64),
      state: 'queued', enqueuedAt: new Date(), notBefore: new Date(Date.now() + 30_000), error: 'a retryable blip', errorKind: 'retryable',
    },
  });
  // A succeeded call of the same job: the sweep ends only what has not ended.
  const done = await h.prisma.wikiModelRequest.create({
    data: {
      jobId, ownerId, spaceId: fx.spaceId, step: 'extract', unit: `${fx.sessionId}:2`, attempt: 1,
      request: { system: 's', prompt: 'p', maxTokens: 1 }, requestSha256: 'c'.repeat(64),
      state: 'succeeded', answer: 'an answer', enqueuedAt: new Date(), startedAt: new Date(), endedAt: new Date(),
      inputTokens: 3, outputTokens: 1, httpStatus: 200,
    },
  });
  const op = await h.prisma.wikiRepoOp.create({
    data: { jobId, ownerId, spaceId: fx.spaceId, workspaceId: fx.workspaceId, kind: 'snapshot', state: 'queued' },
  });
  return { runId, jobId, running, queued, done, op };
}

/**
 * One `verify` job of the space, queued behind the running one (the claim runs one job of a space
 * at a time), whose op waits for the verdict only a run of it was going to give — and the call its
 * interrupted earlier attempt had out, still running on the queue that answers to no job state.
 */
async function inFlightVerifyJob(h: Harness, ownerId: string, fx: Fixture) {
  const jobId = randomUUID();
  await h.prisma.wikiJob.create({
    data: {
      id: jobId, ownerId, spaceId: fx.spaceId, kind: 'verify', input: { sessionId: fx.sessionId }, priority: 1,
      state: 'queued',
    },
  });
  const call = await h.prisma.wikiModelRequest.create({
    data: {
      jobId, ownerId, spaceId: fx.spaceId, step: 'verify', unit: randomUUID(), attempt: 1,
      request: { system: 's', prompt: 'p', maxTokens: 1 }, requestSha256: 'd'.repeat(64),
      state: 'running', partial: 'half a verdict', startedAt: new Date(), enqueuedAt: new Date(), ...lease(),
    },
  });
  const changeset = await h.prisma.wikiChangeset.create({
    data: { ownerId, spaceId: fx.spaceId, origin: 'agent', sessionId: fx.sessionId, status: 'pending', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const op = await h.prisma.wikiChangesetOp.create({
    data: {
      changesetId: changeset.id, ownerId, seq: 0, op: 'add', payload: { kind: 'pitfall', title: 't', body: 'b', sources: [] },
      decision: 'verifying',
    },
  });
  return { jobId, call, op };
}

/**
 * One `plan_draft` job of the space, queued behind the running one, with the made plan job row
 * that names it: the work the owner asked for, waiting for a run the rollback cancels.
 */
async function inFlightPlanJob(h: Harness, ownerId: string, fx: Fixture) {
  const jobId = randomUUID();
  const planJob = await h.prisma.wikiPlanJob.create({
    data: {
      spaceId: fx.spaceId, ownerId, kind: 'draft', trigger: 'owner', state: 'made', jobId, madeAt: new Date(),
    },
  });
  await h.prisma.wikiJob.create({
    data: {
      id: jobId, ownerId, spaceId: fx.spaceId, kind: 'plan_draft', input: { planJobId: planJob.id }, priority: 1,
      state: 'queued',
    },
  });
  return { jobId, planJobId: planJob.id };
}

test('switching back to runner cancels the in-flight server jobs and their calls, and the next fact makes the runner path\'s task', { skip }, async () => {
  const h = await boot();
  const prisma = h.prisma as unknown as PrismaService;
  process.env.ORBIT_WIKI_EXECUTOR = 'canary';
  process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS = h.ownerId;
  const fx = await fixture(h, h.ownerId);
  const maintain = await inFlightMaintainJob(h, h.ownerId, fx);
  const verify = await inFlightVerifyJob(h, h.ownerId, fx);
  const plan = await inFlightPlanJob(h, h.ownerId, fx);

  // The rollback: the switch moves back to runner, and the apiserver start runs the sweep.
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
  const swept = await cancelUnservedWikiJobs(prisma);
  assert.equal(swept.cancelled, 3, JSON.stringify(swept));

  // The maintain job: cancelled, its lease and the reason for it on its row; its run failed / infra,
  // which the space's streak does not count.
  const job = await h.prisma.wikiJob.findFirstOrThrow({ where: { id: maintain.jobId } });
  assert.equal(job.state, 'cancelled');
  assert.ok(job.endedAt, 'the cancellation is an end');
  assert.equal(job.leaseOwner, null);
  assert.equal(job.leaseGeneration, null);
  assert.equal(job.leaseDeadlineAt, null);
  assert.match(job.error ?? '', /ORBIT_WIKI_EXECUTOR/u);
  const run = await h.prisma.wikiMaintenanceRun.findFirstOrThrow({ where: { id: maintain.runId } });
  assert.equal(run.outcome, 'failed');
  assert.equal(run.failureKind, 'infra');
  assert.ok(run.endedAt);
  assert.match(run.error ?? '', /ORBIT_WIKI_EXECUTOR/u);
  // Its calls: the running and the queued are cancelled with the 0401 clears; the succeeded is left.
  const running = await h.prisma.wikiModelRequest.findFirstOrThrow({ where: { id: maintain.running.id } });
  assert.equal(running.state, 'cancelled');
  assert.equal(running.error, null);
  assert.equal(running.errorKind, null);
  assert.equal(running.partial, null, 'a cancelled row keeps no partial (the 0401 constraint)');
  assert.equal(running.leaseOwner, null);
  assert.equal(running.leaseGeneration, null);
  assert.equal(running.leaseDeadlineAt, null);
  assert.ok(running.endedAt);
  const queued = await h.prisma.wikiModelRequest.findFirstOrThrow({ where: { id: maintain.queued.id } });
  assert.equal(queued.state, 'cancelled');
  assert.equal(queued.error, null, 'a cancelled row keeps no error');
  assert.equal(queued.errorKind, null);
  assert.equal(queued.notBefore, null, 'no backoff waits on a row nobody will run again');
  const done = await h.prisma.wikiModelRequest.findFirstOrThrow({ where: { id: maintain.done.id } });
  assert.equal(done.state, 'succeeded');
  assert.equal(done.answer, 'an answer');
  // Its repository operation: cancelled, so no runner spends work on a result nobody will read.
  const op = await h.prisma.wikiRepoOp.findFirstOrThrow({ where: { id: maintain.op.id } });
  assert.equal(op.state, 'cancelled');
  assert.equal(op.leaseOwner, null);
  assert.equal(op.claimedAt, null);
  assert.equal(op.heartbeatAt, null);
  assert.equal(op.runnerId, null);
  assert.ok(op.endedAt);

  // The verify job: cancelled with its call; the op it never judged stays verifying — the next
  // maintenance run of the space adopts it, which is now the runner path's run again.
  const verifyJob = await h.prisma.wikiJob.findFirstOrThrow({ where: { id: verify.jobId } });
  assert.equal(verifyJob.state, 'cancelled');
  const verifyCall = await h.prisma.wikiModelRequest.findFirstOrThrow({ where: { id: verify.call.id } });
  assert.equal(verifyCall.state, 'cancelled');
  const waitingOp = await h.prisma.wikiChangesetOp.findFirstOrThrow({ where: { id: verify.op.id } });
  assert.equal(waitingOp.decision, 'verifying', 'the op waits for the verdict the next run gives it');
  assert.equal(waitingOp.verificationVerdict, null);

  // The plan job: ended failed with why, still naming its wiki_job (a made or ended plan job must
  // name its maker), and the job itself is cancelled.
  const planJob = await h.prisma.wikiPlanJob.findFirstOrThrow({ where: { id: plan.planJobId } });
  assert.equal(planJob.state, 'ended');
  assert.equal(planJob.outcome, 'failed');
  assert.equal(planJob.jobId, plan.jobId);
  assert.match(planJob.error ?? '', /ORBIT_WIKI_EXECUTOR/u);
  assert.ok(planJob.endedAt);
  const planWikiJob = await h.prisma.wikiJob.findFirstOrThrow({ where: { id: plan.jobId } });
  assert.equal(planWikiJob.state, 'cancelled');

  // And the fact the production incident starved: the next one makes the runner path's maintenance
  // task — no job still in flight holds the space.
  const outcome = await considerWikiMaintenance(prisma, h.ownerId, fx.spaceId, {
    sessionIds: [fx.sessionId], taskIds: [],
  });
  assert.equal(outcome.made, true, JSON.stringify(outcome));
  if (!outcome.made) return;
  assert.ok(outcome.taskId, 'the runner path makes a task');
  assert.equal(outcome.jobId, null);
  const task = await h.prisma.task.findFirstOrThrow({ where: { id: outcome.taskId! } });
  assert.ok(task.acceptanceCommand?.includes('orbit wiki check'), 'the task is the maintenance task');
  assert.equal((await h.prisma.wikiJob.count({ where: { spaceId: fx.spaceId, kind: 'maintain' } })), 1);
  // The failed / infra run the sweep wrote is not a streak entry: the cursor says none.
  const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
  assert.equal(cursor.consecutiveFailures, 0);
  delete process.env.ORBIT_WIKI_EXECUTOR;
});

test('an account still on the canary list is untouched: the sweep cancels nothing and the unfinished job still holds the space', { skip }, async () => {
  const h = await boot();
  const prisma = h.prisma as unknown as PrismaService;
  process.env.ORBIT_WIKI_EXECUTOR = 'canary';
  process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS = h.ownerId;
  const fx = await fixture(h, h.ownerId);
  const maintain = await inFlightMaintainJob(h, h.ownerId, fx);

  const swept = await cancelUnservedWikiJobs(prisma);
  assert.equal(swept.cancelled, 0, JSON.stringify(swept));
  const job = await h.prisma.wikiJob.findFirstOrThrow({ where: { id: maintain.jobId } });
  assert.equal(job.state, 'running', 'the served account\'s job is still running, lease and all');
  assert.ok(job.leaseOwner);
  const run = await h.prisma.wikiMaintenanceRun.findFirstOrThrow({ where: { id: maintain.runId } });
  assert.equal(run.outcome, null, 'its run is still open');
  assert.equal(run.failureKind, null);
  const call = await h.prisma.wikiModelRequest.findFirstOrThrow({ where: { id: maintain.running.id } });
  assert.equal(call.state, 'running');
  assert.equal(call.partial, 'the first tokens');
  // And the trigger still answers the way one run of a space at a time answers.
  const outcome = await considerWikiMaintenance(prisma, h.ownerId, fx.spaceId, {
    sessionIds: [fx.sessionId], taskIds: [],
  });
  assert.deepEqual(outcome, { made: false, spaceId: fx.spaceId, why: 'unfinished' });
  delete process.env.ORBIT_WIKI_EXECUTOR;
});

test('under canary, an account off the list is cancelled while one on it is not', { skip }, async () => {
  const h = await boot();
  const prisma = h.prisma as unknown as PrismaService;
  const otherOwnerId = randomUUID();
  await h.prisma.user.create({ data: { id: otherOwnerId, email: `wiki-executor-sweep-${otherOwnerId}@wiki.invalid`, name: 'executor sweep spec', passwordHash: 'x' } });
  try {
    process.env.ORBIT_WIKI_EXECUTOR = 'canary';
    process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS = h.ownerId;
    const fx = await fixture(h, h.ownerId);
    const served = await inFlightMaintainJob(h, h.ownerId, fx);
    const otherFx = await fixture(h, otherOwnerId);
    const unserved = await inFlightMaintainJob(h, otherOwnerId, otherFx);

    const swept = await cancelUnservedWikiJobs(prisma);
    assert.equal(swept.cancelled, 1, JSON.stringify(swept));

    const kept = await h.prisma.wikiJob.findFirstOrThrow({ where: { id: served.jobId } });
    assert.equal(kept.state, 'running');
    const keptRun = await h.prisma.wikiMaintenanceRun.findFirstOrThrow({ where: { id: served.runId } });
    assert.equal(keptRun.outcome, null);
    const gone = await h.prisma.wikiJob.findFirstOrThrow({ where: { id: unserved.jobId } });
    assert.equal(gone.state, 'cancelled');
    const goneRun = await h.prisma.wikiMaintenanceRun.findFirstOrThrow({ where: { id: unserved.runId } });
    assert.equal(goneRun.outcome, 'failed');
    assert.equal(goneRun.failureKind, 'infra');
  } finally {
    await h.prisma.wikiSpace.deleteMany({ where: { ownerId: otherOwnerId } }).catch(() => undefined);
    await h.prisma.session.deleteMany({ where: { ownerId: otherOwnerId } }).catch(() => undefined);
    await h.prisma.workspace.deleteMany({ where: { ownerId: otherOwnerId } }).catch(() => undefined);
    await h.prisma.runner.deleteMany({ where: { ownerId: otherOwnerId } }).catch(() => undefined);
    await h.prisma.taskList.deleteMany({ where: { ownerId: otherOwnerId } }).catch(() => undefined);
    await h.prisma.user.deleteMany({ where: { id: otherOwnerId } }).catch(() => undefined);
    delete process.env.ORBIT_WIKI_EXECUTOR;
  }
});
