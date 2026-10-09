/**
 * A merge recorded somewhere other than the merge card ends the candidate that was offering the same
 * branch (contract §3.3 M-T13), on real PostgreSQL.
 *
 * WHAT WAS WRONG (2026-10-09, project 34b78EQPNkVF8kM3ki7Ch)
 * ----------------------------------------------------------
 * A MAIN-line task went DONE and its branch was offered as a `TASK_BRANCH` candidate. The branch had
 * never been pushed; the coordinator fast-forwarded main to its commit by hand and recorded the merge
 * receipt. The check then failed to fetch the branch (`SOURCE_BRANCH_MISSING`) and blocked the
 * candidate, the coordinator closed the exception ("the work is already on main"), the project went
 * DONE — and its sessions page went on saying "Can't merge into main yet" with "Coordinator is
 * resolving it" under it, because nothing ends a blocked candidate but a newer one, a decline or a
 * merge the platform makes itself. Every BLOCKED task-branch candidate in production had that shape.
 *
 * THE CASES
 * ---------
 *  (1) The incident, through the queue as the runner reports it: blocked by a branch that was never
 *      pushed, then the receipt — the candidate is SUPERSEDED, the card is served as nothing to draw,
 *      and the exception it left open is closed by the platform.
 *  (2) A receipt before the check is claimed: the queued check is cancelled and never handed out.
 *  (3) A receipt while the check runs: the check is asked to stop, and what it reports afterwards
 *      opens nothing.
 *  (4) What a receipt leaves alone: another branch of the same task, another target, a merge that
 *      did not land.
 *  (5) A candidate already asking the owner: the card closes with it.
 *  (6) A candidate the owner confirmed is the platform's own merge, and stays its own.
 *  (7) The replay: recording a merge again retires a candidate a build without the rule left beside
 *      it — and never one made after the merge was recorded.
 *  (8) The runner's own merge (the Merge button's result) retires it the same way.
 *  (9) Migration 0411 retires what was already standing, once, and leaves the rest alone.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-landed-by-receipt.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import type {
  IntegrationCheckResult,
  IntegrationJobCommand,
  IntegrationJobResultRequest,
} from '@orbit/shared';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { mergeReceiptIdempotencyKey } from '../sessions/merge-receipt';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask, queueTaskBranchCandidate } from './project-integration-job';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A full 40-hex object name, which is the only kind a job column and a receipt accept. */
const sha = (nibble: string) => nibble.repeat(40);
const UPSTREAM_TIP = sha('9');
const WORK_TIP = sha('a');

const MIGRATION = path.resolve(
  __dirname, '../../prisma/migrations/0411_retire_candidates_landed_by_receipt/migration.sql',
);

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'ok\n',
};

/** What the incident's check answered: it could not fetch a branch nobody had pushed. */
const BRANCH_NEVER_PUSHED: Answer = {
  state: 'ERROR', phase: 'FETCH', errorCode: 'SOURCE_BRANCH_MISSING',
  errorDetail: { detail: "fatal: couldn't find remote ref" },
};

/** A clean check of the task's branch on main: the owner is asked. */
const CLEAN: Answer = {
  state: 'READY', phase: 'CHECK', sourceSha: WORK_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
  testedSha: sha('4'), testedTreeSha: sha('5'), aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
};

/** The migration's own statements, comments taken out, in file order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

test('a merge recorded outside the card ends the candidate offering the same branch', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // The production wiring over one client. Only the publishes and the queue nudge are inert.
  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const openItems = new ProjectOpenItemService(db, sessions);
  const jobs = new IntegrationJobRelay(db, openItems);
  const promotions = new ProjectPromotionService(db);
  const receipts = new MergeReceiptService(db);
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `landed-by-receipt-${ownerId}@promotion.invalid`, name: 'The owner', passwordHash: 'x' },
  });

  /** One candidate's world: its own runner (a heartbeat hands out the oldest job it may), the
   *  workspace its checkout is bound to, and a project whose line is main itself. */
  async function world(label: string) {
    const runnerId = randomUUID();
    await prisma.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}: the runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
    const workspaceId = randomUUID();
    await prisma.workspace.create({
      data: {
        id: workspaceId, ownerId, runnerId, name: `${label}: the workspace`, enabled: true,
        repoUrl: 'ssh://git@example.invalid/the-project', workDir: `/srv/landed-by-receipt-${label}`,
      },
    });
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: `${label}: the project` } });
    await prisma.projectCodebase.create({
      data: {
        ownerId,
        projectId,
        canonicalRepoUrl: 'ssh://git@example.invalid/the-project',
        upstreamRef: 'refs/heads/main',
        // A MAIN line: the task's own branch is what is offered (M-F2).
        integrationRef: 'refs/heads/main',
        refAuthority: 'REMOTE',
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    return { label, runnerId, workspaceId, projectId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** The world's runner asks for work; `kind` is the job it is owed, or null for none of that kind. */
  async function heartbeat(w: World, kind: IntegrationJobCommand['kind']): Promise<IntegrationJobCommand | null> {
    const handed = await jobs.dispatch({
      runnerId: w.runnerId, leaseOwner: `lease-${randomUUID()}`, draining: false, capabilities: [INTEGRATION_JOB_CLAIM],
    });
    return handed.find((command) => command.kind === kind) ?? null;
  }

  async function claim(w: World, kind: IntegrationJobCommand['kind']): Promise<IntegrationJobCommand> {
    const job = await heartbeat(w, kind);
    assert.ok(job, `the heartbeat was handed no ${kind}`);
    return job;
  }

  async function report(w: World, job: IntegrationJobCommand, answer: Answer) {
    const { answer: taken } = await jobs.applyResult(job.jobId, w.runnerId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...answer,
    });
    assert.ok(taken.accepted, `the answer was refused: ${JSON.stringify(taken)}`);
  }

  /**
   * A finished task whose branch is offered: the task DONE, its work session finished on `branch`,
   * and the candidate plus the queued check its DONE makes on a MAIN line.
   */
  async function offered(w: World) {
    const task = await tasks.create(ownerId, {
      title: `${w.label}: the work`,
      projectId: w.projectId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    const settled = await sql.query(
      `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`,
      [task.id],
    );
    assert.equal(settled.rowCount, 1);
    // Not off the task id: a v7 id's first characters are its clock, shared by tasks made together.
    const branch = `orbit/work-${randomUUID().slice(0, 8)}`;
    const session = await prisma.session.create({
      data: {
        ownerId, creatorId: ownerId, taskId: task.id, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
        title: 'the work', prompt: 'do the work', branch,
        isolationStatus: 'worktree', status: RunStatus.SUCCEEDED, startsTaskWork: true,
        finishedAt: new Date(Date.now() - 60_000), worktreeBranch: branch,
        worktreeDirty: false, changedFiles: [{ path: 'src/the-work.ts' }] as never,
      },
      select: { id: true },
    });
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, task.id));
    assert.ok(queued.enqueued && queued.kind === 'PROMOTION', JSON.stringify(queued));
    return { taskId: task.id, sessionId: session.id, branch, promotionId: queued.promotionId, checkJobId: queued.jobId };
  }
  type Offer = Awaited<ReturnType<typeof offered>>;

  /** What the coordinator did by hand: main fast-forwarded to the work, and the merge recorded. */
  async function mergedByHand(offer: Offer, input: Partial<Parameters<MergeReceiptService['record']>[2]> = {}) {
    return receipts.record(ownerId, offer.sessionId, {
      result: 'MERGED',
      sourceSha: WORK_TIP,
      targetBranch: 'main',
      targetShaBefore: UPSTREAM_TIP,
      targetShaAfter: WORK_TIP,
      ...input,
    }, 'AGENT');
  }

  async function promotion(id: string) {
    return prisma.projectPromotion.findUniqueOrThrow({
      where: { id },
      select: { state: true, decidedAt: true, checkJobId: true, openItemId: true },
    });
  }

  async function job(id: string) {
    return prisma.projectIntegrationJob.findUniqueOrThrow({
      where: { id },
      select: { state: true, cancelRequestedAt: true },
    });
  }

  async function itemsAbout(promotionId: string) {
    return prisma.projectOpenItem.findMany({
      where: { promotionId },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, state: true, resolution: true, resolvedBy: true },
    });
  }

  // ═══ (1) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(1) the incident: blocked by a branch nobody pushed, then merged by hand — the card ends',
    async () => {
      const w = await world('incident');
      const offer = await offered(w);
      await report(w, await claim(w, 'CHECK_PROMOTION'), BRANCH_NEVER_PUSHED);
      assert.equal((await promotion(offer.promotionId)).state, 'BLOCKED', 'the check blocked it, as it did');
      assert.deepEqual((await itemsAbout(offer.promotionId)).map((item) => [item.kind, item.state]),
        [['INTEGRATION_ERROR', 'OPEN']], 'and opened the exception the coordinator went on to close');

      await mergedByHand(offer);

      const after = await promotion(offer.promotionId);
      assert.equal(after.state, 'SUPERSEDED', 'the merge recorded outside the card answered it');
      assert.ok(after.decidedAt, 'at the moment the receipt was recorded');
      const served = await promotions.readCurrent(ownerId, w.projectId);
      assert.equal(served?.state, 'SUPERSEDED',
        'the card is served as a candidate nothing is waiting on, which no client draws');
      assert.deepEqual(await itemsAbout(offer.promotionId), [{
        kind: 'INTEGRATION_ERROR', state: 'RESOLVED', resolution: 'PROMOTION_MOVED_ON', resolvedBy: 'PLATFORM',
      }], 'the failure about it is closed by the platform, nobody pressed anything');
    });

  // ═══ (2) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(2) a receipt before the check is claimed cancels the check, which is never handed out',
    async () => {
      const w = await world('queued');
      const offer = await offered(w);
      assert.equal((await job(offer.checkJobId)).state, 'QUEUED');

      await mergedByHand(offer);

      assert.equal((await promotion(offer.promotionId)).state, 'SUPERSEDED');
      assert.equal((await job(offer.checkJobId)).state, 'CANCELLED', 'J-T8: a queued check is taken out');
      assert.equal(await heartbeat(w, 'CHECK_PROMOTION'), null, 'and no runner is handed it');
      assert.deepEqual(await itemsAbout(offer.promotionId), [], 'nothing was ever opened about it');
    });

  // ═══ (3) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(3) a receipt while the check runs asks it to stop, and its late answer opens nothing',
    async () => {
      const w = await world('running');
      const offer = await offered(w);
      const check = await claim(w, 'CHECK_PROMOTION');

      await mergedByHand(offer);

      assert.equal((await promotion(offer.promotionId)).state, 'SUPERSEDED');
      const stopping = await job(offer.checkJobId);
      assert.equal(stopping.state, 'RUNNING', 'a running job is asked, not told (J-T8)');
      assert.ok(stopping.cancelRequestedAt, 'and the asking is written down for the runner to read');

      await report(w, check, BRANCH_NEVER_PUSHED);
      assert.equal((await promotion(offer.promotionId)).state, 'SUPERSEDED',
        'a check reporting on a candidate that has gone moves nothing');
      assert.deepEqual(await itemsAbout(offer.promotionId), [],
        'and opens no exception: nobody is waiting on that candidate any more');
    });

  // ═══ (4) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(4) another branch, another target and a merge that did not land leave it standing',
    async () => {
      const w = await world('unrelated');
      const offer = await offered(w);

      await mergedByHand(offer, { sourceBranch: 'orbit/another-attempt', sourceSha: sha('b'), targetShaAfter: sha('b') });
      assert.equal((await promotion(offer.promotionId)).state, 'CHECKING',
        'another branch of the same task can carry work main does not have');

      await mergedByHand(offer, { targetBranch: 'release' });
      assert.equal((await promotion(offer.promotionId)).state, 'CHECKING', 'release is not its upstream');

      await mergedByHand(offer, {
        result: 'CONFLICT', conflicts: ['src/the-work.ts'], targetShaAfter: null,
      });
      assert.equal((await promotion(offer.promotionId)).state, 'CHECKING', 'a conflict put nothing on main');
      assert.equal((await job(offer.checkJobId)).state, 'QUEUED', 'and its check is still owed');

      await mergedByHand(offer);
      assert.equal((await promotion(offer.promotionId)).state, 'SUPERSEDED',
        'the receipt that does say it landed is the one that ends it');
    });

  // ═══ (5) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(5) a candidate already asking the owner takes its card with it', async () => {
    const w = await world('asking');
    const offer = await offered(w);
    await report(w, await claim(w, 'CHECK_PROMOTION'), CLEAN);
    const asking = await promotion(offer.promotionId);
    assert.equal(asking.state, 'READY');
    assert.ok(asking.openItemId, 'the owner was asked');

    await mergedByHand(offer);

    assert.equal((await promotion(offer.promotionId)).state, 'SUPERSEDED');
    assert.deepEqual(await itemsAbout(offer.promotionId), [{
      kind: 'PROMOTION_APPROVAL', state: 'RESOLVED', resolution: 'PROMOTION_MOVED_ON', resolvedBy: 'PLATFORM',
    }], 'there is nothing left for the owner to approve');
  });

  // ═══ (6) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(6) a candidate the owner confirmed stays the platform’s own merge', async () => {
    const w = await world('confirmed');
    const offer = await offered(w);
    await report(w, await claim(w, 'CHECK_PROMOTION'), CLEAN);
    await promotions.confirm({ userId: ownerId }, w.projectId, offer.promotionId, WORK_TIP);
    assert.equal((await promotion(offer.promotionId)).state, 'CONFIRMED');

    await mergedByHand(offer);

    assert.equal((await promotion(offer.promotionId)).state, 'CONFIRMED',
      'its landing is in flight, and answers ALREADY_LANDED itself if the work is there (M-T8)');
  });

  // ═══ (7) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(7) recording the merge again retires what an older build left beside it, and nothing newer',
    async () => {
      const w = await world('replay');
      const offer = await offered(w);
      await report(w, await claim(w, 'CHECK_PROMOTION'), BRANCH_NEVER_PUSHED);
      // The receipt as a build without the rule wrote it: the row and nothing else.
      const key = mergeReceiptIdempotencyKey({
        sessionId: offer.sessionId, sourceSha: WORK_TIP, targetBranch: 'main', result: 'MERGED',
      });
      await prisma.sessionMergeReceipt.create({
        data: {
          ownerId, sessionId: offer.sessionId, taskId: offer.taskId, projectId: w.projectId, result: 'MERGED',
          sourceBranch: offer.branch, sourceSha: WORK_TIP, targetBranch: 'main',
          targetShaBefore: UPSTREAM_TIP, targetShaAfter: WORK_TIP, recordedBy: 'AGENT', idempotencyKey: key,
        },
      });
      assert.equal((await promotion(offer.promotionId)).state, 'BLOCKED', 'the shape production was left in');

      const replayed = await mergedByHand(offer);
      assert.equal(replayed.created, false, 'the same merge, recorded again, is the same receipt');
      assert.equal((await promotion(offer.promotionId)).state, 'SUPERSEDED', 'and it ends what it answered');

      // The same branch offered again after that merge — new work, which only a later receipt answers.
      // A moment later than the receipt, as it would be: the two clocks are read to the millisecond.
      await sleep(20);
      const codebase = await prisma.projectCodebase.findFirstOrThrow({
        where: { projectId: w.projectId },
        select: { id: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true },
      });
      const again = await prisma.$transaction((tx) => queueTaskBranchCandidate(tx, {
        ownerId, projectId: w.projectId, taskId: offer.taskId, codebase,
        session: { id: offer.sessionId, branch: offer.branch, runnerId: w.runnerId },
      }));
      assert.ok(again, 'the branch is offered again');
      await mergedByHand(offer);
      assert.equal((await promotion(again.promotionId)).state, 'CHECKING',
        'a replay never answers a question asked after the merge it records');
    });

  // ═══ (8) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(8) the runner’s own merge of the branch retires it the same way', async () => {
    const w = await world('merge-button');
    const offer = await offered(w);

    await prisma.$transaction((tx) => MergeReceiptService.fromRunnerMergeResult(tx, {
      ownerId, sessionId: offer.sessionId, taskId: offer.taskId, projectId: w.projectId, result: 'MERGED',
      sourceBranch: offer.branch, sourceSha: WORK_TIP, targetBranch: 'main', targetShaBefore: UPSTREAM_TIP,
      targetShaAfter: WORK_TIP, rebaseBaseSha: null, conflicts: [], message: null, operationId: null,
    }));

    assert.equal((await promotion(offer.promotionId)).state, 'SUPERSEDED');
    assert.equal((await job(offer.checkJobId)).state, 'CANCELLED');
  });

  // ═══ (9) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(9) migration 0411 retires what was already standing, once, and nothing else', async () => {
    const w = await world('history');
    // Two candidates as production held them: blocked, with the receipt written after them by a build
    // without the rule — one for its own branch, one for a branch the receipt is not about.
    const answered = await offered(w);
    await report(w, await claim(w, 'CHECK_PROMOTION'), BRANCH_NEVER_PUSHED);
    const other = await offered(w);
    await report(w, await claim(w, 'CHECK_PROMOTION'), BRANCH_NEVER_PUSHED);
    for (const [offer, branch] of [[answered, answered.branch], [other, 'orbit/somewhere-else']] as const) {
      await prisma.sessionMergeReceipt.create({
        data: {
          ownerId, sessionId: offer.sessionId, taskId: offer.taskId, projectId: w.projectId, result: 'ALREADY_MERGED',
          sourceBranch: branch, sourceSha: WORK_TIP, targetBranch: 'main', targetShaBefore: WORK_TIP,
          recordedBy: 'AGENT', idempotencyKey: `history-${offer.promotionId}`,
        },
      });
    }

    const statements = migrationStatements();
    assert.equal(statements.length, 3, 'the check jobs, the items, the candidates');
    const moved: number[] = [];
    for (const statement of statements) moved.push((await sql.query(statement)).rowCount ?? 0);
    // One candidate across the database: (7)'s re-offer has only a receipt older than itself.
    assert.deepEqual(moved, [0, 1, 1], 'its check had already ended; its exception and itself are retired');
    assert.equal((await promotion(answered.promotionId)).state, 'SUPERSEDED');
    assert.deepEqual((await itemsAbout(answered.promotionId)).map((item) => [item.state, item.resolution, item.resolvedBy]),
      [['RESOLVED', 'PROMOTION_MOVED_ON', 'PLATFORM']]);
    assert.equal((await promotion(other.promotionId)).state, 'BLOCKED', 'a receipt for another branch answers nothing');

    const again: number[] = [];
    for (const statement of statements) again.push((await sql.query(statement)).rowCount ?? 0);
    assert.deepEqual(again, [0, 0, 0], 'applied twice, the repair is a no-op');
  });
});
