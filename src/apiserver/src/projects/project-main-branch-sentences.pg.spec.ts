/**
 * The sentences the server writes about a merge into the project's main branch, read through the
 * doors that serve them, on real PostgreSQL (project 34cjQN5ynG6eIH5A0neeu, criterion 4). Each names
 * the binding's `upstream_ref` without `refs/heads/`. A project on main, and one with no repository
 * bound, reads each one word for word as before.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-main-branch-sentences.pg.spec.ts
 *
 *  (1) A candidate's check that fails (CHECK_FAILED, CONFLICT, ERROR, through the relay as a runner
 *      reports it) opens an item titled with the merge it is about. The open items read and the card
 *      its delivery is drawn from give that item's next step.
 *  (2) The next step of every item shape whose step says a merge reaches main, on the open items read
 *      and on the delivery card: on a project bound to master, one bound to main, and one with no
 *      repository. These rows are written as the item table holds them, since a project with no
 *      repository has no candidate to fail.
 *  (3) A line that has started refuses a change (409 INTEGRATION_LINE_LOCKED) and says which branch
 *      the project branch would have to be merged into first.
 *  (4) A task's landing queued behind the merge of the project branch: the reason the task page
 *      prints, and the merge approval's next step on the way there.
 *
 * Every "before" is the sentence as the source said it before the branch was named. Nothing here
 * reads a field the change added, so the file compiles on that source too, where the master cases
 * fail and the others pass.
 *
 * Not destructive: every case owns freshly generated ids.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ConflictException } from '@nestjs/common';
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
import { configureProjectIntegration } from './project-integration-line';
import { readOpenItemDeliveryCard } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A sentence before the branch was named, and on a project whose main branch is master. */
type Said = readonly [before: string, onMaster: string];

/** What a project bound to `upstream` (null: no repository) reads. */
const said = (upstream: string | null, [before, onMaster]: Said): string =>
  upstream === 'master' ? onMaster : before;

/** The next steps that say a merge reaches main (`openItemRequiredAction`). */
const STEPS = {
  CHECK_FAILED: [
    'Nothing on the project branch reaches main until this check passes — re-run it or ask the coordinator to fix it.',
    'Nothing on the project branch reaches master until this check passes — re-run it or ask the coordinator to fix it.',
  ],
  APPROVAL: [
    'You must decide whether this promotion reaches main — review it, then approve, decline, or cancel it.',
    'You must decide whether this promotion reaches master — review it, then approve, decline, or cancel it.',
  ],
  CONFLICT: [
    'The project branch cannot reach main until this promotion conflict is repaired — create a sync task or ask the coordinator to fix it.',
    'The project branch cannot reach master until this promotion conflict is repaired — create a sync task or ask the coordinator to fix it.',
  ],
  TIMED_OUT: [
    'The project branch cannot reach main until this check finishes — re-run it with a reason or ask the coordinator to fix it.',
    'The project branch cannot reach master until this check finishes — re-run it with a reason or ask the coordinator to fix it.',
  ],
  REPAIR: [
    'The project branch cannot reach main until this integration is repaired — re-run it or ask the coordinator to fix it.',
    'The project branch cannot reach master until this integration is repaired — re-run it or ask the coordinator to fix it.',
  ],
} as const satisfies Record<string, Said>;

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

/** Each way a check of the merge can fail: the runner's answer, the item's title, its next step. */
const FAILURES: Record<'CHECK_FAILED' | 'CONFLICT' | 'ERROR', { answer: Answer; title: Said; step: Said }> = {
  CHECK_FAILED: {
    answer: {
      state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: LINE_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
      testedSha: sha('2'), testedTreeSha: sha('3'), checks: [{ ...GREEN_CHECK, exitCode: 1, outputTail: 'FAIL\n' }],
    },
    title: [
      'Checks failed on the combined tree: merging the project branch into main',
      'Checks failed on the combined tree: merging the project branch into master',
    ],
    step: STEPS.CHECK_FAILED,
  },
  CONFLICT: {
    answer: {
      state: 'CONFLICT', phase: 'MERGE', sourceSha: LINE_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
      conflicts: ['src/contested.ts'],
    },
    title: ['Merge conflict: merging the project branch into main', 'Merge conflict: merging the project branch into master'],
    step: STEPS.CONFLICT,
  },
  ERROR: {
    answer: { state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED', errorDetail: { detail: 'the remote hung up' } },
    title: ['Integration error: merging the project branch into main', 'Integration error: merging the project branch into master'],
    step: STEPS.REPAIR,
  },
};

test('the sentences about a merge into main name the project’s main branch, and main as before', {
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
  const tasks = new TasksService(db, sessions, realtime);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `sentences-${ownerId}@main-branch.invalid`, name: 'The owner', passwordHash: 'x' },
  });

  /**
   * One project's world: its own runner and repository, the workspace its checkout is bound to, and
   * a project on a branch of its own that is integrating into `upstream` — or, with null, bound to
   * no repository at all.
   */
  async function world(label: string, upstream: string | null) {
    const runnerId = randomUUID();
    await prisma.runner.create({
      data: {
        id: runnerId, ownerId, name: `${label}: the runner`, tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    const repository = `ssh://git@example.invalid/${label}-${runnerId}`;
    const workspaceId = randomUUID();
    await prisma.workspace.create({
      data: {
        id: workspaceId, ownerId, runnerId, name: `${label}: the workspace`, enabled: true,
        repoUrl: repository, workDir: `/srv/main-branch-sentences-${label}`,
      },
    });
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: `${label}: the project` } });
    if (upstream) {
      await prisma.projectCodebase.create({
        data: {
          ownerId, projectId, canonicalRepoUrl: repository,
          upstreamRef: `refs/heads/${upstream}`,
          integrationRef: `refs/heads/project/${projectId}`,
          refAuthority: 'REMOTE', integrationRefSource: 'EXPLICIT',
          integrationStartedAt: new Date(Date.now() - 60_000),
        },
      });
    }
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

  /** A DONE task of the world's project whose work session has finished on a branch of its own. */
  async function finishedTask(w: World, title: string): Promise<string> {
    const task = await tasks.create(ownerId, {
      title,
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
        title, prompt: 'do the work', branch: `orbit/work-${task.id.slice(0, 8)}`,
        isolationStatus: 'worktree', status: RunStatus.SUCCEEDED, startsTaskWork: true,
        finishedAt: new Date(Date.now() - 60_000), worktreeBranch: `orbit/work-${task.id.slice(0, 8)}`,
        worktreeDirty: false, changedFiles: [{ path: 'src/the-work.ts' }] as never,
      },
    });
    return task.id;
  }

  /** A finished task landed on the project branch, and the candidate it makes, with its check claimed. */
  async function candidateBeingChecked(w: World) {
    const taskId = await finishedTask(w, 'the work on the project branch');
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, taskId));
    assert.ok(queued.enqueued, JSON.stringify(queued));
    await report(w, await claim(w, 'LAND_TASK'), {
      state: 'LANDED', phase: 'VERIFY', sourceSha: sha('d'), targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
      testedSha: LINE_TIP, testedTreeSha: sha('e'), landedSha: LINE_TIP, landedTreeSha: sha('e'), aheadOfUpstream: 1,
    });
    const made = await promotions.considerCandidate(w.projectId);
    assert.ok(made, 'the landing made a candidate');
    return { promotionId: made.promotionId, check: await claim(w, 'CHECK_PROMOTION') };
  }

  /** An open item's next step as the project's open items read serves it, and as its delivery card does. */
  async function nextStep(w: World, itemId: string) {
    const listed = await openItems.list(ownerId, w.projectId);
    const row = [...listed.needsYou, ...listed.withCoordinator].find((each) => each.itemId === itemId);
    assert.ok(row, `CONTROL: the open items read lists ${itemId}`);
    const card = await readOpenItemDeliveryCard(db, itemId, ownerId);
    assert.ok(card, `CONTROL: ${itemId} reads as a card`);
    return { listed: row.requiredAction, card: card.requiredAction };
  }

  // ═══ (1) ══════════════════════════════════════════════════════════════════════════════════════
  for (const upstream of ['master', 'main']) {
    for (const [answer, failure] of Object.entries(FAILURES)) {
      await t.test(`(1) on ${upstream}, a check of the merge answering ${answer} opens an item named after the merge`,
        async () => {
          const w = await world(`${upstream}-${answer.toLowerCase()}`, upstream);
          const { promotionId, check } = await candidateBeingChecked(w);
          await report(w, check, failure.answer);
          const item = await prisma.projectOpenItem.findFirstOrThrow({
            where: { projectId: w.projectId, promotionId, state: 'OPEN', kind: { not: 'PROMOTION_APPROVAL' } },
            select: { id: true, title: true, assignee: true },
          });
          assert.equal(item.assignee, 'OWNER', 'CONTROL: the project has no coordinator, so the item is the owner’s');
          assert.equal(item.title, said(upstream, failure.title));
          assert.deepEqual(await nextStep(w, item.id), {
            listed: said(upstream, failure.step),
            card: said(upstream, failure.step),
          });
        });
    }
  }

  // ═══ (2) ══════════════════════════════════════════════════════════════════════════════════════
  /** Every item shape whose next step says a merge reaches main, as the item table holds it. */
  const SHAPES: Array<{ kind: string; assignee: 'OWNER' | 'COORDINATOR'; payload: object; step: Said }> = [
    {
      kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER',
      payload: { jobKind: 'CHECK_PROMOTION', failureClass: 'CHECK_FAILED' }, step: STEPS.CHECK_FAILED,
    },
    { kind: 'PROMOTION_APPROVAL', assignee: 'OWNER', payload: {}, step: STEPS.APPROVAL },
    {
      kind: 'INTEGRATION_CONFLICT', assignee: 'COORDINATOR',
      payload: { jobKind: 'CHECK_PROMOTION', failureClass: 'CONFLICT', files: ['src/contested.ts'] }, step: STEPS.CONFLICT,
    },
    {
      kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR',
      payload: { jobKind: 'CHECK_PROMOTION', failureClass: 'CHECK_TIMED_OUT' }, step: STEPS.TIMED_OUT,
    },
    {
      kind: 'INTEGRATION_ERROR', assignee: 'OWNER',
      payload: { jobKind: 'LAND_PROMOTION', failureClass: 'ERROR', errorCode: 'PUSH_REJECTED' }, step: STEPS.REPAIR,
    },
  ];
  for (const upstream of ['master', 'main', null]) {
    await t.test(`(2) ${upstream ? `on ${upstream}` : 'with no repository'}, every next step about the merge, `
      + 'on the open items read and the delivery card', async () => {
      const w = await world(`steps-${upstream ?? 'unbound'}`, upstream);
      for (const [index, shape] of SHAPES.entries()) {
        const now = new Date();
        const item = await prisma.projectOpenItem.create({
          data: {
            projectId: w.projectId, ownerId, kind: shape.kind, state: 'OPEN', assignee: shape.assignee,
            assigneeReason: 'DEFAULT', dedupeKey: `sentences:${index}`, title: `${shape.kind} ${index}`,
            payload: shape.payload, waitingSince: now, assignedAt: now,
          },
          select: { id: true },
        });
        const expected = said(upstream, shape.step);
        assert.deepEqual(await nextStep(w, item.id), { listed: expected, card: expected },
          `${shape.kind} with the ${shape.assignee.toLowerCase()}`);
      }
    });
  }

  // ═══ (3) ══════════════════════════════════════════════════════════════════════════════════════
  for (const upstream of ['master', 'main']) {
    await t.test(`(3) on ${upstream}, a started line refuses a change and names the branch to merge into first`,
      async () => {
        const w = await world(`locked-${upstream}`, upstream);
        const line = await prisma.projectCodebase.findFirstOrThrow({
          where: { projectId: w.projectId },
          select: { integrationStartedAt: true },
        });
        const refused = await prisma.$transaction((tx) => configureProjectIntegration(tx, {
          ownerId, projectId: w.projectId, settings: { line: 'MAIN' },
        })).then(() => null, (error: unknown) => error);
        assert.ok(refused instanceof ConflictException, `refused with a 409: ${String(refused)}`);
        const body = refused.getResponse() as { code: string; message: string };
        assert.equal(body.code, 'INTEGRATION_LINE_LOCKED');
        const head = `this project started integrating into project/${w.projectId} at `
          + `${line.integrationStartedAt!.toISOString()}, so its integration line can no longer change. `;
        assert.equal(body.message, head + said(upstream, [
          'To change it, merge the project branch into main or abandon it first.',
          'To change it, merge the project branch into master or abandon it first.',
        ]));
      });
  }

  // ═══ (4) ══════════════════════════════════════════════════════════════════════════════════════
  for (const upstream of ['master', 'main']) {
    await t.test(`(4) on ${upstream}, a landing queued behind the merge of the project branch says which branch `
      + 'that merge goes into', async () => {
      const w = await world(`behind-${upstream}`, upstream);
      const { promotionId, check } = await candidateBeingChecked(w);
      await report(w, check, {
        state: 'READY', phase: 'CHECK', sourceSha: LINE_TIP, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
        testedSha: sha('4'), testedTreeSha: sha('5'), aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
      });
      // The clean check put the merge in front of the owner.
      const approval = await prisma.projectOpenItem.findFirstOrThrow({
        where: { projectId: w.projectId, promotionId, state: 'OPEN', kind: 'PROMOTION_APPROVAL' },
        select: { id: true },
      });
      const asked = said(upstream, STEPS.APPROVAL);
      assert.deepEqual(await nextStep(w, approval.id), { listed: asked, card: asked });

      // The owner confirms it, and a runner starts merging the project branch.
      await promotions.confirm({ userId: ownerId }, w.projectId, promotionId, LINE_TIP);
      const merge = await claim(w, 'LAND_PROMOTION');
      const running = await prisma.projectIntegrationJob.findUniqueOrThrow({
        where: { id: merge.jobId },
        select: { state: true, serialKey: true },
      });
      assert.equal(running.state, 'RUNNING', 'CONTROL: the merge is running');

      // A second finished task's landing, serialised on the ref that merge writes. No door queues a
      // landing there today, so its key is set by hand: what is under test is what the task page says.
      const second = await finishedTask(w, 'the next piece of work');
      const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, second));
      assert.ok(queued.enqueued, JSON.stringify(queued));
      const landing = await prisma.projectIntegrationJob.findFirstOrThrow({
        where: { taskId: second, kind: 'LAND_TASK' },
        select: { id: true },
      });
      await prisma.projectIntegrationJob.update({ where: { id: landing.id }, data: { serialKey: running.serialKey } });
      // A runner ready to take it, so the busy branch is the only thing holding it.
      await prisma.runner.update({
        where: { id: w.runnerId },
        data: {
          capabilities: [INTEGRATION_JOB_CLAIM], heartbeatLeaseOwner: randomUUID(), heartbeatDraining: false,
          lastHeartbeatAt: new Date(),
        },
      });

      const page = await tasks.get(ownerId, second);
      assert.deepEqual(page.integration?.landTask?.blockingReason, {
        code: 'WAITING_SERIAL_SLOT',
        summary: said(upstream, [
          'Waiting to land: the merge into main is running on this branch first',
          'Waiting to land: the merge into master is running on this branch first',
        ]),
        jobId: merge.jobId,
      });
    });
  }
});
