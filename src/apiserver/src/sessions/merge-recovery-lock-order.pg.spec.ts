/**
 * A LANDING LOCKS THE SESSIONS WHOSE MERGE RECOVERY IT CLEARS AHEAD OF THE BINDING AND OF ITS FIRST RECEIPT —
 * OVER A REAL POSTGRESQL.
 *
 * S3 of the merge-recovery repair loop (project 34hIv3wbdtsxpc5RzDlOk) clears the merge recovery a session was
 * holding in the transaction of the receipt that says it landed: `MergeReceiptService.clearLandedRecoveries` takes
 * the session FOR NO KEY UPDATE (rank 30 of common/lock-order.ts). Merged with main's J-T8, that clear ran after
 * the project binding (rank 55) when a stopped LAND_TASK reported a landing. And when one result wrote J12's
 * receipts beside its own, or beside a promotion's, it ran after receipts the result had already written (rank 60).
 * The stopped landing's receipt also took its session and task FOR KEY SHARE through their foreign keys after the
 * binding, while turnComplete's DONE holds both FOR UPDATE on its way to that same binding.
 *
 * The cases are the S3 wrap-up's named scenarios (task 34ivMR9MjIQEjnTw4Xmx2), run through the result route's own
 * transaction (`applyIntegrationJobResult`) over real rows. The order is read from the statements the client sends
 * (Prisma's query log). The races are driven from a second connection that holds what the other transaction
 * holds, and a deadlock would show as a retried attempt or as an error on that connection.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/merge-recovery-lock-order.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';
import type {
  IntegrationCheckResult,
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  MergeRecovery,
} from '@orbit/shared';
import { Client } from 'pg';

import type { TransactionOutcome } from '../common/transaction-retry';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from '../projects/project-integration-job';
import { configureProjectIntegration, stopInFlightJob } from '../projects/project-integration-line';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectPromotionService } from '../projects/project-promotion.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay, applyIntegrationJobResult } from '../runner-api/integration-job-relay';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const sha = (nibble: string) => nibble.repeat(40);
const UPSTREAM_TIP = sha('9');

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 1_200,
  outputTail: 'ok\n',
};

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** A task's branch landed on the project branch. */
const LANDED: Answer = {
  state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), targetShaBefore: sha('0'), testedSha: sha('1'),
  testedTreeSha: sha('2'), landedSha: sha('1'), landedTreeSha: sha('2'), checks: [GREEN_CHECK], conflicts: [],
};

/** A candidate's branch merges cleanly onto main. */
const CLEAN: Answer = {
  state: 'READY', phase: 'CHECK', sourceSha: sha('a'), targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
  testedSha: sha('4'), testedTreeSha: sha('5'), aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
};

/** What an earlier Merge into main and its check left on a session: a diverged target, never repaired. */
function diverged(): MergeRecovery {
  return {
    code: 'TARGET_DIVERGED', targetBranch: 'main', repoRoot: '/repo', previewId: randomUUID().replace(/-/g, ''),
    sourceSha: sha('a'), localSha: sha('b'), remoteSha: sha('c'), checkedAt: new Date().toISOString(), patch: '',
  };
}

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
  tasks: TasksService;
}

function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  return { db, prisma, jobs: new IntegrationJobRelay(prisma, openItems), promotions: new ProjectPromotionService(prisma), tasks };
}

/** One statement a client sent, with its parameters. */
interface Statement { query: string; params: string }

/** A client that keeps every statement it sends, for a case to read the order of its locks from. */
function loggedClient(url: string): { db: PrismaClient; prisma: PrismaService; statements: Statement[] } {
  const statements: Statement[] = [];
  const db = new PrismaClient({ adapter: new PrismaPg(url), log: [{ emit: 'event', level: 'query' }] });
  (db as unknown as { $on: (event: 'query', listener: (query: Statement) => void) => void })
    .$on('query', (query) => statements.push({ query: query.query, params: query.params }));
  return { db, prisma: db as unknown as PrismaService, statements };
}

interface World {
  label: string; ownerId: string; runnerId: string; workspaceId: string; projectId: string; repoUrl: string;
  upstreamRef: string;
}

/** One project with its own runner and workspace; two worlds may share a repository, and an account. */
async function world(
  stack: Stack,
  label: string,
  line: 'MAIN' | 'PROJECT_BRANCH',
  repoUrl = `https://git.invalid/${label}-${randomUUID().slice(0, 6)}.git`,
  existingOwnerId?: string,
): Promise<World> {
  const ownerId = existingOwnerId ?? randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  if (!existingOwnerId) {
    await stack.db.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@merge-recovery-lock-order.invalid`, name: label, passwordHash: 'x' },
    });
  }
  await stack.db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await stack.db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}` },
  });
  await stack.db.project.create({
    data: { id: projectId, ownerId, title: `${label} project`, coordinatorWorkspaceId: workspaceId },
  });
  await stack.db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await stack.db.$transaction((tx) => configureProjectIntegration(tx, { ownerId, projectId, settings: { line } }));
  const codebase = await stack.db.projectCodebase.findFirstOrThrow({ where: { projectId, slot: 'primary' } });
  return { label, ownerId, runnerId, workspaceId, projectId, repoUrl, upstreamRef: codebase.upstreamRef };
}

/** A DONE task whose finished work session is handed to the line, as its DONE would (J-T1a). */
async function doneTask(stack: Stack, w: World, label: string): Promise<{ taskId: string; sessionId: string }> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const created = await stack.tasks.create(w.ownerId, {
    title, projectId: w.projectId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
  } as never);
  const settled = await stack.db.$executeRawUnsafe(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`, created.id,
  );
  assert.equal(settled, 1, 'the task could not be marked DONE');
  const branch = `orbit/${label}-${randomUUID().slice(0, 8)}`;
  const session = await stack.db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, taskId: created.id, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title, prompt: title, branch, isolationStatus: 'worktree', baseSha: sha('e'),
      status: RunStatus.SUCCEEDED, startsTaskWork: true, finishedAt: new Date(Date.now() - 60_000),
      worktreeBranch: branch, worktreeDirty: false, changedFiles: [{ path: 'src/the-work.ts' }] as never,
    },
    select: { id: true },
  });
  const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, created.id));
  assert.ok(queued.enqueued, `the DONE queued nothing: ${JSON.stringify(queued)}`);
  return { taskId: created.id, sessionId: session.id };
}

/** The jobs a heartbeat of this world's runner is handed. */
function beat(stack: Stack, w: World) {
  return stack.jobs.dispatch({
    runnerId: w.runnerId, leaseOwner: `lease-${randomUUID()}`, draining: false, capabilities: [INTEGRATION_JOB_CLAIM],
  });
}

async function claim(stack: Stack, w: World): Promise<IntegrationJobCommand> {
  const [job, ...more] = await beat(stack, w);
  assert.ok(job, 'the heartbeat was handed nothing');
  assert.equal(more.length, 0, 'the heartbeat was handed more than one job');
  return job;
}

/** The result a runner posts for a job it holds, through the result route's transaction. */
async function report(stack: Stack, w: World, job: IntegrationJobCommand, answer: Answer) {
  const { answer: taken } = await stack.jobs.applyResult(job.jobId, w.runnerId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...answer,
  });
  assert.equal(taken.accepted, true, `the result route refused ${answer.state}`);
  return taken;
}

/**
 * The same result, through a client that keeps the statements it sends: those of the result's own transaction,
 * up to its COMMIT. What runs after it — the landing subject settled in a transaction of its own (§2.9 LS3) — is
 * not part of the order this file is about.
 */
async function reportLogged(url: string, w: World, job: IntegrationJobCommand, answer: Answer) {
  const logged = loggedClient(url);
  try {
    const applied = await applyIntegrationJobResult(logged.prisma, {
      jobId: job.jobId, runnerId: w.runnerId,
      body: { claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...answer },
    });
    assert.equal(applied.answer.accepted, true, `the result route refused ${answer.state}`);
    const commit = logged.statements.findIndex((statement) => statement.query.trim() === 'COMMIT');
    assert.ok(commit > 0, 'the result committed in one transaction');
    return { applied, statements: logged.statements.slice(0, commit) };
  } finally {
    await logged.db.$disconnect();
  }
}

/** The PUSH report a v2 runner sends before it pushes, leaving the row what J12 checks later. */
function pushReport(
  stack: Stack,
  w: World,
  job: IntegrationJobCommand,
  facts: { testedSha: string; testedTreeSha: string; sourceSha: string; targetShaBefore: string },
) {
  return stack.jobs.progress(w.runnerId, job.jobId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase: 'PUSH', ...facts,
  });
}

/** A claim left silent past its limit, so the next door that stops it ends it as J12 says. */
async function goSilent(stack: Stack, jobId: string): Promise<void> {
  await stack.db.projectIntegrationJob.update({
    where: { id: jobId },
    data: { claimedAt: new Date(Date.now() - 11 * 60_000), heartbeatAt: new Date(Date.now() - 11 * 60_000) },
  });
}

/** A session's merge state as a recovery check left it; `row` overrides any of it. */
async function strand(db: PrismaClient, sessionId: string, row: Prisma.SessionUncheckedUpdateInput = {}) {
  await db.session.update({
    where: { id: sessionId },
    data: {
      mergeStatus: 'error', mergeError: 'local main has diverged from origin/main', mergeTarget: 'main',
      mergeRecovery: diverged() as unknown as Prisma.InputJsonValue, mergeRecoveryAction: 'preview', ...row,
    },
  });
}

/** The task taken away while its landing runs: the running landing is asked to stop (J-T8). */
async function stopLanding(stack: Stack, w: World, taskId: string, jobId: string): Promise<void> {
  await stack.tasks.update(w.ownerId, taskId, { status: TaskStatus.CANCELLED } as never);
  const job = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(job.state, 'RUNNING');
  assert.ok(job.cancelRequestedAt, 'the landing was asked to stop');
}

const recoveryOf = (db: PrismaClient, sessionId: string) => db.session.findUniqueOrThrow({
  where: { id: sessionId }, select: { mergeRecovery: true, mergeRecoveryAction: true, mergeStatus: true },
});

/** The receipts written against one integration job, by the id their detail names. */
const receiptsOf = (db: PrismaClient, jobId: string) => db.sessionMergeReceipt.findMany({
  where: { detail: { path: ['integrationJobId'], equals: jobId } },
  select: { sessionId: true, taskId: true, result: true, detail: true },
});

type Relation = 'session' | 'project' | 'task' | 'project_codebase';

/** A row lock a statement takes, read off its text: the relation, the mode and the ids it names. */
interface Lock { index: number; relation: Relation; mode: string; ids: string[] }

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function locksIn(statements: Statement[]): Lock[] {
  return statements.flatMap((statement, index) => {
    const mode = /\bFOR (NO KEY UPDATE|KEY SHARE|UPDATE|SHARE)\b/.exec(statement.query)?.[1];
    const relation = /\bFROM "(session|project|task|project_codebase)"\s/.exec(statement.query)?.[1] as Relation | undefined;
    return mode && relation ? [{ index, relation, mode, ids: [...new Set(statement.params.match(UUID) ?? [])].sort() }] : [];
  });
}

/** The first statement that writes anything but a session row: the first write of rank 60 or above. */
function firstChildWrite(statements: Statement[]): number {
  return statements.findIndex((statement) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(statement.query)
    && !/^\s*UPDATE\s+"(?:public"\.")?session"/i.test(statement.query));
}

/**
 * The order a stopped LAND_TASK's result took its locks in: every session, the project and every task before the
 * binding, in that order, and the binding before its first write; after the binding, nothing of a lower rank
 * except the clear re-taking a session the pre-lock already holds FOR NO KEY UPDATE. Answers with the locks taken
 * before the binding.
 */
function assertStoppedOrder(statements: Statement[], expected: { projectId: string; taskIds: string[]; held: string[] }) {
  const locks = locksIn(statements);
  const binding = locks.find((lock) => lock.relation === 'project_codebase' && lock.mode === 'UPDATE');
  assert.ok(binding, 'the binding was taken');
  const before = locks.filter((lock) => lock.index < binding.index);
  const relations = before.map((lock) => lock.relation).filter((relation, i, all) => relation !== all[i - 1]);
  assert.deepEqual(relations, ['session', 'project', 'task'], 'the sessions, then the project, then the tasks, then the binding');
  const project = before.find((lock) => lock.relation === 'project')!;
  assert.equal(project.mode, 'KEY SHARE');
  assert.deepEqual(project.ids, [expected.projectId]);
  const tasks = before.filter((lock) => lock.relation === 'task');
  assert.equal(tasks.length, 1, 'the tasks are taken in one statement');
  assert.equal(tasks[0]!.mode, 'KEY SHARE');
  assert.deepEqual(tasks[0]!.ids, [...expected.taskIds].sort());
  assert.ok(firstChildWrite(statements) > binding.index, 'nothing was written before the binding');
  for (const lock of locks.filter((lock) => lock.index > binding.index)) {
    assertReentrant(statements, lock, expected.held, 'after the binding');
  }
  return before.filter((lock) => lock.relation === 'session');
}

/** A lock taken after the pre-lock: the clear, re-taking a session already held FOR NO KEY UPDATE. */
function assertReentrant(statements: Statement[], lock: Lock, held: string[], where: string): void {
  const text = statements[lock.index]!.query.replace(/\s+/g, ' ').slice(0, 400);
  assert.equal(lock.relation, 'session', `a ${lock.relation} lock ${where}: ${text}`);
  assert.equal(lock.mode, 'NO KEY UPDATE', `a session lock ${where}: ${text}`);
  assert.ok(lock.ids.length > 0 && lock.ids.every((id) => held.includes(id)),
    `a session locked ${where} that the pre-lock does not hold FOR NO KEY UPDATE: ${text}`);
}

/** Until a backend of this database other than the asking one waits on a lock, or the call it awaits ended. */
async function waitsOnALock(db: PrismaClient, settled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (!settled() && Date.now() < deadline) {
    const [row] = await db.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS "n" FROM pg_stat_activity
       WHERE "wait_event_type" = 'Lock' AND "datname" = current_database() AND "pid" <> pg_backend_pid()`);
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Race a stopped landing's result against another transaction, which `hold` opens on its own connection and
 * which `finish` completes once the result is waiting on it. Neither side may meet a deadlock: the result commits
 * on its first attempt and every statement of the other transaction answers.
 */
async function race(
  stack: Stack,
  url: string,
  w: World,
  job: IntegrationJobCommand,
  hold: (other: Client) => Promise<void>,
  finish: (other: Client) => Promise<void>,
): Promise<void> {
  const other = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await other.connect();
  try {
    await other.query('BEGIN');
    await hold(other);
    const outcomes: TransactionOutcome[] = [];
    let settled = false;
    const result = applyIntegrationJobResult(stack.prisma, {
      jobId: job.jobId, runnerId: w.runnerId,
      body: { claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...LANDED },
    }, { onOutcome: (event) => { outcomes.push(event.outcome); } });
    void result.then(() => { settled = true; }, () => { settled = true; });
    assert.equal(await waitsOnALock(stack.db, () => settled), true, 'the result waits for the other transaction');
    await finish(other);
    await other.query('COMMIT');
    const applied = await result;
    assert.equal(applied.answer.accepted, true);
    assert.deepEqual(outcomes, ['COMMITTED'], 'the result committed on its first attempt: no deadlock was detected and retried');
  } finally {
    await other.query('ROLLBACK').catch(() => undefined);
    await other.end().catch(() => undefined);
  }
}

test('S3 a landing locks the sessions whose recovery it clears before the binding and before its first receipt, on PostgreSQL', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  await t.test('S3 a stopped LAND_TASK that lands locks its session, the project and the task before the binding, and still clears the recovery and writes the receipt', async () => {
    const w = await world(stack, 'stopped-recovering', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'stopped-recovering');
    const job = await claim(stack, w);
    await strand(stack.db, work.sessionId);
    await stopLanding(stack, w, work.taskId, job.jobId);

    const { statements } = await reportLogged(url, w, job, LANDED);
    const sessions = assertStoppedOrder(statements, { projectId: w.projectId, taskIds: [work.taskId], held: [work.sessionId] });
    assert.deepEqual(sessions.map((lock) => [lock.mode, lock.ids]), [['NO KEY UPDATE', [work.sessionId]]],
      'the session holding a recovery is taken FOR NO KEY UPDATE, once');

    const after = await recoveryOf(stack.db, work.sessionId);
    assert.equal(after.mergeRecovery, null, 'the recovery is cleared');
    assert.equal(after.mergeRecoveryAction, null, 'and its action');
    const receipts = await receiptsOf(stack.db, job.jobId);
    assert.deepEqual(receipts.map((receipt) => [receipt.sessionId, receipt.taskId, receipt.result]),
      [[work.sessionId, work.taskId, 'MERGED']], 'the receipt is written');
    assert.equal((await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } })).state, 'LANDED');
  });

  await t.test('S3 a stopped LAND_TASK takes its session FOR KEY SHARE when there is no recovery to clear, and a check in flight keeps its own', async () => {
    for (const label of ['stopped-no-recovery', 'stopped-check-in-flight'] as const) {
      const w = await world(stack, label, 'PROJECT_BRANCH');
      const work = await doneTask(stack, w, label);
      const job = await claim(stack, w);
      if (label === 'stopped-check-in-flight') {
        await strand(stack.db, work.sessionId, { mergeStatus: 'pending', mergeOperationId: randomUUID(), mergeRequestedAt: new Date() });
      }
      const before = await recoveryOf(stack.db, work.sessionId);
      await stopLanding(stack, w, work.taskId, job.jobId);

      const { statements } = await reportLogged(url, w, job, LANDED);
      const sessions = assertStoppedOrder(statements, { projectId: w.projectId, taskIds: [work.taskId], held: [] });
      assert.deepEqual(sessions.map((lock) => lock.mode), ['NO KEY UPDATE', 'KEY SHARE'],
        `${label}: the recovery filter matched nothing, so the session is taken FOR KEY SHARE`);
      assert.ok(sessions.every((lock) => lock.ids.length === 1 && lock.ids[0] === work.sessionId));

      assert.deepEqual(await recoveryOf(stack.db, work.sessionId), before, `${label}: the session row is as it was`);
      assert.deepEqual((await receiptsOf(stack.db, job.jobId)).map((receipt) => [receipt.sessionId, receipt.result]),
        [[work.sessionId, 'MERGED']], `${label}: the receipt is written`);
    }
  });

  await t.test('S3 a stopped LAND_TASK and the DONE that races it finish without a deadlock', async () => {
    for (const recovering of [true, false]) {
      const label = recovering ? 'race-done-recovering' : 'race-done';
      const w = await world(stack, label, 'PROJECT_BRANCH');
      const work = await doneTask(stack, w, label);
      const job = await claim(stack, w);
      if (recovering) await strand(stack.db, work.sessionId);
      // Taken away and reopened while its landing runs: the landing is asked to stop, and the marker says the
      // DONE the reopened task is written next is owed the next generation (J-T8).
      await stopLanding(stack, w, work.taskId, job.jobId);
      await stack.tasks.update(w.ownerId, work.taskId, {
        status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null,
      } as never);
      assert.ok(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }));

      // The other side is turnComplete's DONE for the acceptance turn of that task, in its order: the session
      // under its lease fence, the project, the task — each FOR UPDATE where it takes one — and then, once the
      // task is written DONE, the binding enqueueForDoneTask takes.
      await race(stack, url, w, job, async (done) => {
        await done.query(`SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE`, [work.sessionId]);
        await done.query(`SELECT "id" FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE`, [w.projectId]);
        await done.query(`SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [work.taskId]);
      }, async (done) => {
        await done.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [work.taskId]);
        await done.query(
          `SELECT "id" FROM "project_codebase" WHERE "project_id" = $1::uuid AND "slot" = 'primary' FOR UPDATE`, [w.projectId]);
      });

      const after = await recoveryOf(stack.db, work.sessionId);
      assert.equal(after.mergeRecovery, null, `${label}: no recovery is left`);
      assert.equal(after.mergeRecoveryAction, null, `${label}: and no action`);
      assert.deepEqual((await receiptsOf(stack.db, job.jobId)).map((receipt) => [receipt.sessionId, receipt.result]),
        [[work.sessionId, 'MERGED']], `${label}: the receipt is written`);
      const generations = await stack.db.projectIntegrationJob.findMany({
        where: { taskId: work.taskId, kind: 'LAND_TASK' }, orderBy: { generation: 'asc' }, select: { generation: true, state: true },
      });
      assert.deepEqual(generations.map((row) => [row.generation, row.state]), [[1, 'LANDED'], [2, 'QUEUED']],
        `${label}: the DONE written after the reopen got its generation`);
      assert.equal(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }), null);
    }
  });

  await t.test('S3 a stopped LAND_TASK and a project delete that races it finish without a deadlock', async () => {
    const w = await world(stack, 'race-project-delete', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'race-project-delete');
    const job = await claim(stack, w);
    await strand(stack.db, work.sessionId);
    await stopLanding(stack, w, work.taskId, job.jobId);

    // The other side is ProjectsService.remove's two locks: the project FOR UPDATE, and the binding row its
    // ON DELETE CASCADE deletes. The task count between them is what lets a delete go on, and only a project whose
    // tasks are all gone gets there; the order of the two locks is what this case is about.
    await race(stack, url, w, job, async (remove) => {
      await remove.query(`SELECT "id" FROM "project" WHERE "id" = $1::uuid FOR UPDATE`, [w.projectId]);
    }, async (remove) => {
      await remove.query(
        `SELECT "id" FROM "project_codebase" WHERE "project_id" = $1::uuid AND "slot" = 'primary' FOR UPDATE`, [w.projectId]);
    });

    assert.equal((await recoveryOf(stack.db, work.sessionId)).mergeRecovery, null, 'the recovery is cleared');
    assert.deepEqual((await receiptsOf(stack.db, job.jobId)).map((receipt) => [receipt.sessionId, receipt.result]),
      [[work.sessionId, 'MERGED']], 'the receipt is written');
  });

  /**
   * A project-branch landing whose push outcome nobody could read (ERROR · PUSH_OUTCOME_UNKNOWN), and the next
   * landing on the same serial key, claimed and told to check it: both sessions hold a merge recovery.
   */
  async function unknownTaskPushOnTheQueue(label: string) {
    const w = await world(stack, label, 'PROJECT_BRANCH');
    const first = await doneTask(stack, w, `${label}-first`);
    const lost = await claim(stack, w);
    const tested = sha('7');
    await pushReport(stack, w, lost, { testedSha: tested, testedTreeSha: sha('8'), sourceSha: sha('6'), targetShaBefore: sha('0') });
    await goSilent(stack, lost.jobId);
    await stack.tasks.update(w.ownerId, first.taskId, { status: TaskStatus.CANCELLED } as never);
    const ended = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: lost.jobId } });
    assert.equal(ended.state, 'ERROR');
    assert.equal(ended.errorCode, 'PUSH_OUTCOME_UNKNOWN');

    const next = await doneTask(stack, w, `${label}-next`);
    const job = await claim(stack, w);
    assert.deepEqual(job.unknownPushes, [{ jobId: lost.jobId, testedSha: tested }]);
    await strand(stack.db, first.sessionId);
    await strand(stack.db, next.sessionId);
    return { w, first, next, lost, job };
  }

  await t.test('S3 a landing that repairs an unknown push locks every session it clears in one statement before its first receipt', async () => {
    const { w, first, next, lost, job } = await unknownTaskPushOnTheQueue('j12-task');
    const { statements } = await reportLogged(url, w, job, { ...LANDED, unknownPushes: [{ jobId: lost.jobId, landed: true }] });

    const held = [first.sessionId, next.sessionId].sort();
    const [upFront, ...rest] = locksIn(statements);
    assert.deepEqual(upFront && [upFront.relation, upFront.mode, upFront.ids], ['session', 'NO KEY UPDATE', held],
      'both sessions, in one statement in id order, are the first thing locked');
    assert.ok(upFront!.index < firstChildWrite(statements), 'before the first receipt');
    for (const lock of rest) assertReentrant(statements, lock, held, 'after the up-front lock');

    for (const sessionId of [first.sessionId, next.sessionId]) {
      const after = await recoveryOf(stack.db, sessionId);
      assert.equal(after.mergeRecovery, null, 'each recovery is cleared');
      assert.equal(after.mergeRecoveryAction, null);
    }
    assert.deepEqual((await receiptsOf(stack.db, job.jobId)).map((receipt) => [receipt.sessionId, receipt.result]),
      [[next.sessionId, 'MERGED']], 'the landing\'s own receipt');
    const repaired = await receiptsOf(stack.db, lost.jobId);
    assert.deepEqual(repaired.map((receipt) => [receipt.sessionId, receipt.taskId, receipt.result]),
      [[first.sessionId, first.taskId, 'MERGED']], 'and the repair\'s, against the job that lost its outcome');
    assert.equal((repaired[0]!.detail as { recoveredUnknownPush?: boolean }).recoveredUnknownPush, true);
  });

  await t.test('S3 a stopped LAND_TASK that repairs an unknown push locks the repair\'s session and task before the binding too', async () => {
    const { w, first, next, lost, job } = await unknownTaskPushOnTheQueue('j12-task-stopped');
    await stopLanding(stack, w, next.taskId, job.jobId);
    const { statements } = await reportLogged(url, w, job, { ...LANDED, unknownPushes: [{ jobId: lost.jobId, landed: true }] });

    const held = [first.sessionId, next.sessionId].sort();
    const sessions = assertStoppedOrder(statements, {
      projectId: w.projectId, taskIds: [first.taskId, next.taskId], held,
    });
    assert.deepEqual(sessions.map((lock) => [lock.mode, lock.ids]), held.map((id) => ['NO KEY UPDATE', [id]]),
      'each session holding a recovery, one at a time in id order');

    for (const sessionId of held) assert.equal((await recoveryOf(stack.db, sessionId)).mergeRecovery, null);
    assert.deepEqual((await receiptsOf(stack.db, job.jobId)).map((receipt) => [receipt.sessionId, receipt.result]),
      [[next.sessionId, 'MERGED']]);
    assert.deepEqual((await receiptsOf(stack.db, lost.jobId)).map((receipt) => [receipt.sessionId, receipt.result]),
      [[first.sessionId, 'MERGED']]);
  });

  await t.test('S3 a promotion that merges beside a J12 repair locks the sessions of both in one statement before its first receipt', async () => {
    // A MAIN-line candidate, confirmed, whose landing pushed and then went silent: ended PUSH_OUTCOME_UNKNOWN.
    const w = await world(stack, 'j12-promotion', 'MAIN');
    const lostWork = await doneTask(stack, w, 'j12-promotion-lost');
    const lostCandidate = await stack.db.projectPromotion.findFirstOrThrow({
      where: { projectId: w.projectId, sourceKind: 'TASK_BRANCH' },
    });
    await report(stack, w, await claim(stack, w), CLEAN);
    await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, lostCandidate.id, sha('a'));
    const lost = await claim(stack, w);
    assert.equal(lost.kind, 'LAND_PROMOTION');
    const tested = sha('3');
    await pushReport(stack, w, lost, { testedSha: tested, testedTreeSha: sha('5'), sourceSha: sha('a'), targetShaBefore: UPSTREAM_TIP });
    await goSilent(stack, lost.jobId);
    const stopped = await stack.db.$transaction((tx) => stopInFlightJob(tx, { projectId: w.projectId, jobId: lost.jobId, now: new Date() }));
    assert.equal(stopped.errorCode, 'PUSH_OUTCOME_UNKNOWN');
    await stack.db.projectPromotion.update({
      where: { id: lostCandidate.id }, data: { state: 'BLOCKED', blockedReason: 'ERROR', decidedAt: new Date() },
    });

    // The next landing on the same serial key: another project of the same account and repository, whose own
    // candidate the owner confirmed after its check.
    const other = await world(stack, 'j12-promotion-next', 'MAIN', w.repoUrl, w.ownerId);
    const otherWork = await doneTask(stack, other, 'j12-promotion-next');
    const candidate = await stack.db.projectPromotion.findFirstOrThrow({
      where: { projectId: other.projectId, sourceKind: 'TASK_BRANCH' },
    });
    await report(stack, other, await claim(stack, other), CLEAN);
    await stack.promotions.confirm({ userId: other.ownerId }, other.projectId, candidate.id, sha('a'));
    const job = await claim(stack, other);
    assert.equal(job.kind, 'LAND_PROMOTION');
    assert.deepEqual(job.unknownPushes, [{ jobId: lost.jobId, testedSha: tested }]);
    await strand(stack.db, lostWork.sessionId);
    await strand(stack.db, otherWork.sessionId);

    const { statements } = await reportLogged(url, other, job, {
      state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
      testedSha: sha('d'), testedTreeSha: sha('f'), landedSha: sha('d'), landedTreeSha: sha('f'),
      unknownPushes: [{ jobId: lost.jobId, landed: true }],
    });

    const held = [lostWork.sessionId, otherWork.sessionId].sort();
    const [upFront, ...rest] = locksIn(statements);
    assert.deepEqual(upFront && [upFront.relation, upFront.mode, upFront.ids], ['session', 'NO KEY UPDATE', held],
      'the repaired promotion\'s session and the merging one\'s, in one statement in id order, are the first thing locked');
    assert.ok(upFront!.index < firstChildWrite(statements), 'before the first receipt');
    for (const lock of rest) assertReentrant(statements, lock, held, 'after the up-front lock');

    for (const sessionId of held) {
      assert.equal((await recoveryOf(stack.db, sessionId)).mergeRecovery, null, 'each recovery is cleared');
    }
    assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id } })).state, 'MERGED');
    assert.deepEqual((await receiptsOf(stack.db, job.jobId)).map((receipt) => [receipt.sessionId, receipt.result]),
      [[otherWork.sessionId, 'MERGED']], 'the merge\'s receipt');
    assert.deepEqual((await receiptsOf(stack.db, lost.jobId)).map((receipt) => [receipt.sessionId, receipt.result]),
      [[lostWork.sessionId, 'MERGED']], 'and the repair\'s');
  });
});
