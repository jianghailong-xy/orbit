/**
 * Why a merge candidate is BLOCKED, stored with the block and served to the card (0409), on real
 * PostgreSQL.
 *
 * WHAT THIS IS FOR
 * ----------------
 * On 2026-10-09 (project 34PBlWiEZytRLTcPufJht) a candidate was made for a project branch that was
 * already an ancestor of main. Its check answered ALREADY_LANDED, the candidate was blocked with
 * `checks = []` and `conflicts = []`, and the card told the owner "the checks on the combined tree
 * did not pass". No check had run. A job that errors before its checks leaves the same two empty
 * arrays. A card that has to guess the reason from them guesses wrong in both cases, so the reason is
 * now the job's answer, written by the statement that writes BLOCKED.
 *
 * THE CASES
 * ---------
 *  (1) Each of the four answers a check can block a candidate with, through the queue as the runner
 *      reports it: ALREADY_LANDED, CHECK_FAILED, CONFLICT, ERROR. Each is stored and served.
 *  (2) A re-check asked for through the owner's door clears the reason, since the candidate is asking
 *      again. A clean re-check leaves it READY with no reason.
 *  (3) The other place a candidate is blocked: a confirmed merge whose landing errored is ERROR.
 *  (4) The column holds only the four (its CHECK), and a candidate blocked before the column existed
 *      reads null, which the card reads the old way (`projectMerge.ts`).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-blocked-reason.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
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
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from './project-integration-job';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A full 40-hex object name, which is the only kind a job column and a receipt accept. */
const sha = (nibble: string) => nibble.repeat(40);
const UPSTREAM_TIP = sha('9');
const LINE_TIP = sha('a');

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

/** What a check answers, for each way it can block a candidate. */
const BLOCKING_ANSWERS: Record<'ALREADY_LANDED' | 'CHECK_FAILED' | 'CONFLICT' | 'ERROR', Answer> = {
  // The branch is already an ancestor of main (M-S1): nothing was merged, nothing was checked.
  ALREADY_LANDED: {
    state: 'ALREADY_LANDED', phase: 'MERGE', sourceSha: LINE_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
  },
  CHECK_FAILED: {
    state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: LINE_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
    testedSha: sha('2'), testedTreeSha: sha('3'), checks: [{ ...GREEN_CHECK, exitCode: 1, outputTail: 'FAIL\n' }],
  },
  CONFLICT: {
    state: 'CONFLICT', phase: 'MERGE', sourceSha: LINE_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
    conflicts: ['src/contested.ts'],
  },
  // The job stopped before any check could answer.
  ERROR: {
    state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED', errorDetail: { detail: 'the remote hung up' },
  },
};

test('a blocked candidate carries why it is blocked, as its job answered', {
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
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `blocked-reason-${ownerId}@promotion.invalid`, name: 'The owner', passwordHash: 'x' },
  });

  /** One candidate's world: its own runner (a heartbeat hands out the oldest job it may), the
   *  workspace its checkout is bound to, and a project on a branch of its own that is integrating. */
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
        repoUrl: 'ssh://git@example.invalid/the-project', workDir: `/srv/blocked-reason-${label}`,
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
        integrationRef: `refs/heads/project/${projectId}`,
        refAuthority: 'REMOTE',
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    return { runnerId, workspaceId, projectId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** The world's runner asks for work, and is handed the one job of this kind it is owed. */
  async function claim(w: World, kind: IntegrationJobCommand['kind']): Promise<IntegrationJobCommand> {
    const handed = await jobs.dispatch({
      runnerId: w.runnerId, leaseOwner: `lease-${randomUUID()}`, draining: false, capabilities: [INTEGRATION_JOB_CLAIM],
    });
    const job = handed.find((command) => command.kind === kind);
    assert.ok(job, `the heartbeat was handed no ${kind}: ${JSON.stringify(handed.map((command) => command.kind))}`);
    return job;
  }

  async function report(w: World, job: IntegrationJobCommand, answer: Answer) {
    const { answer: taken } = await jobs.applyResult(job.jobId, w.runnerId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...answer,
    });
    assert.ok(taken.accepted, `the answer was refused: ${JSON.stringify(taken)}`);
  }

  /**
   * A finished task landed on the project branch, and the candidate that landing makes, with its
   * check claimed: what a check is about to answer for.
   */
  async function candidateBeingChecked(w: World) {
    const task = await tasks.create(ownerId, {
      title: 'the work on the project branch',
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
    await prisma.session.create({
      data: {
        ownerId, creatorId: ownerId, taskId: task.id, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
        title: 'the work', prompt: 'do the work', branch: `orbit/work-${task.id.slice(0, 8)}`,
        isolationStatus: 'worktree', status: RunStatus.SUCCEEDED, startsTaskWork: true,
        finishedAt: new Date(Date.now() - 60_000), worktreeBranch: `orbit/work-${task.id.slice(0, 8)}`,
        worktreeDirty: false, changedFiles: [{ path: 'src/the-work.ts' }] as never,
      },
    });
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, task.id));
    assert.ok(queued.enqueued, JSON.stringify(queued));
    await report(w, await claim(w, 'LAND_TASK'), {
      state: 'LANDED', phase: 'VERIFY', sourceSha: sha('d'), targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
      testedSha: LINE_TIP, testedTreeSha: sha('e'), landedSha: LINE_TIP, landedTreeSha: sha('e'), aheadOfUpstream: 1,
    });
    const made = await promotions.considerCandidate(w.projectId);
    assert.ok(made, 'the landing made a candidate');
    return { promotionId: made.promotionId, check: await claim(w, 'CHECK_PROMOTION') };
  }

  /** The candidate as the table holds it, and as the card is served it. */
  async function candidate(w: World, promotionId: string) {
    const row = await prisma.projectPromotion.findUniqueOrThrow({
      where: { id: promotionId },
      select: { state: true, blockedReason: true, checks: true, conflicts: true },
    });
    const view = await promotions.readCurrent(ownerId, w.projectId);
    assert.ok(view, 'the project has a card to draw');
    assert.equal(view.promotionId, promotionId, 'the card is drawn from this candidate');
    return { ...row, served: view.blockedReason };
  }

  const blocked = new Map<string, { w: World; promotionId: string }>();

  // ═══ (1) ══════════════════════════════════════════════════════════════════════════════════════
  for (const [reason, answer] of Object.entries(BLOCKING_ANSWERS)) {
    await t.test(`(1) a check that answers ${reason} blocks the candidate for ${reason}`, async () => {
      const w = await world(reason.toLowerCase());
      const { promotionId, check } = await candidateBeingChecked(w);
      await report(w, check, answer);
      const now = await candidate(w, promotionId);
      assert.equal(now.state, 'BLOCKED');
      assert.equal(now.blockedReason, reason, 'stored by the statement that blocked it');
      assert.equal(now.served, reason, 'and served to the card, which no longer has to guess');
      blocked.set(reason, { w, promotionId });
    });
  }

  await t.test('(1) nothing to merge and an error leave no check and no conflict behind — which is why '
    + 'the reason is stored', async () => {
    for (const reason of ['ALREADY_LANDED', 'ERROR']) {
      const { w, promotionId } = blocked.get(reason)!;
      const now = await candidate(w, promotionId);
      assert.deepEqual([now.checks, now.conflicts], [[], []],
        `${reason}: read off these two arrays, the card said a check on the combined tree had failed`);
    }
  });

  // ═══ (2) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(2) a re-check clears the reason, and a clean one leaves the candidate READY with none',
    async () => {
      const { w, promotionId } = blocked.get('CHECK_FAILED')!;
      await openItems.retryPromotionCheckAsOwner(ownerId, w.projectId, promotionId,
        { reason: 'the flaky suite was quarantined; the same tree should pass now' });
      const asking = await candidate(w, promotionId);
      assert.deepEqual([asking.state, asking.blockedReason, asking.served], ['CHECKING', null, null],
        'a candidate asking again is not blocked by anything');

      await report(w, await claim(w, 'CHECK_PROMOTION'), {
        state: 'READY', phase: 'CHECK', sourceSha: LINE_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
        testedSha: sha('4'), testedTreeSha: sha('5'), aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
      });
      const ready = await candidate(w, promotionId);
      assert.deepEqual([ready.state, ready.blockedReason, ready.served], ['READY', null, null]);
    });

  // ═══ (3) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(3) a confirmed merge whose landing errored is blocked for ERROR, not for a check',
    async () => {
      const { w, promotionId } = blocked.get('CHECK_FAILED')!;
      await promotions.confirm({ userId: ownerId }, w.projectId, promotionId, LINE_TIP);
      await report(w, await claim(w, 'LAND_PROMOTION'), {
        state: 'ERROR', phase: 'PUSH', sourceSha: LINE_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
        testedSha: sha('4'), testedTreeSha: sha('5'), errorCode: 'PUSH_REJECTED',
        errorDetail: { detail: 'pre-receive hook declined' },
      });
      const now = await candidate(w, promotionId);
      assert.deepEqual([now.state, now.blockedReason, now.served], ['BLOCKED', 'ERROR', 'ERROR'],
        'the landing job blocks it through the same statement, with its own answer');
    });

  // ═══ (4) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(4) the column holds the four reasons and nothing else', async () => {
    const { promotionId } = blocked.get('CONFLICT')!;
    await assert.rejects(
      sql.query(`UPDATE "project_promotion" SET "blocked_reason" = 'CHECKS_FAILED' WHERE "id" = $1::uuid`, [promotionId]),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' && error.constraint === 'project_promotion_blocked_reason_chk',
    );
  });

  await t.test('(4) a candidate blocked before the reason was recorded is served without one', async () => {
    const { w, promotionId } = blocked.get('ALREADY_LANDED')!;
    // What every BLOCKED row written before 0409 holds.
    await sql.query(`UPDATE "project_promotion" SET "blocked_reason" = NULL WHERE "id" = $1::uuid`, [promotionId]);
    const before = await candidate(w, promotionId);
    assert.deepEqual([before.state, before.blockedReason, before.served], ['BLOCKED', null, null],
      'null, which the card reads off the checks and conflicts as it always did');
  });
});
