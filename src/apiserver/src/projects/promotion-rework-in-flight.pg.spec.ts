import { seedPromotionRequest } from '../test-support/promotion-request';
/**
 * A task reworked while a promotion carrying its earlier landing is in flight: that promotion's
 * merge does not put the rework on main, and the next promotion carries it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-rework-in-flight.pg.spec.ts
 *
 * WHAT WAS WRONG (gap 6 of task 34qPFG2UHldscszOvO5dG's evidence, 2026-11-14)
 * ============================================================================
 * A candidate freezes the project line's tip and, once confirmed, is never replaced by a newer
 * landing (`considerCandidate` waits for it). When the task was reopened and its rework landed on
 * the line during that wait, the merge's `writeUpstreamReceipts` named the task's newest LANDED
 * landing — the rework, which the frozen source does not contain — in a receipt newer than the
 * rework's line receipt. `taskLanding` read ON_UPSTREAM, the next candidate left the task out, and
 * main held the revision before the rework.
 *
 * WHAT THIS SPEC ASSERTS
 * ======================
 * land → candidate confirmed, merge in flight → reopen, rework lands on the line → that merge lands
 * and writes its receipts (`applyPromotionJobResult`, the relay's door), then:
 *
 *  - the reworked task's main receipt names the landing the frozen source carries, and the
 *    untouched task's receipt is what it always was;
 *  - the reworked task is not ON_UPSTREAM (`TasksService.get`, `taskLandingSql`), its criterion is
 *    not on main (`ProjectsService.get`, `taskLanding`), and a coordinator's request (K7) offers a
 *    candidate carrying it and only it (`tasksOnTheLine`);
 *  - once that candidate lands, all three read on main again.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import type { CompletionInputRouter } from './completion-input-router.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { integrationIdempotencyKey, integrationSerialKey } from './project-integration-job';
import { applyPromotionJobResult, ProjectPromotionService } from './project-promotion.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);
const REPO_URL = 'ssh://git@example.invalid/promotion-rework-in-flight';
const METHOD = 'Read it and say whether it holds';
const CRITERION = 'the reworked fix is on main';
const OTHER = 'the untouched work is on main';

test('a rework that lands while a promotion is in flight is not read as on main by that promotion', {
  skip, concurrency: 1, timeout: 180_000,
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

  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const completionInputs = {
    routeSettledUnmerged: async () => [],
    routeSettledProjects: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
    routeReadyDependents: async () => [],
    routeTaskExceptions: async () => [],
  } as unknown as CompletionInputRouter;
  const tasks = new TasksService(
    prisma as never,
    {} as never,
    { publishTaskChanged() {}, publishForUser() {}, publishTaskResync() {} } as never,
    undefined,
    completionInputs,
  );
  const promotions = new ProjectPromotionService(db);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `in-flight-${ownerId}@promotion-rework-in-flight.invalid`, name: 'owner', passwordHash: 'x' },
  });
  const projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, ownerId, title: 'a project whose task was reworked mid-merge' } });
  const line = `project/${projectId.slice(0, 8)}`;
  const integrationRef = `refs/heads/${line}`;
  const codebase = await prisma.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: REPO_URL, upstreamRef: 'refs/heads/main', integrationRef,
      refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: new Date(Date.now() - 3_600_000),
    },
    select: { id: true },
  });
  const [criterion, other] = criteriaFromDefinitions((await projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: [CRITERION, OTHER].map((text) => ({ text, verificationMethod: METHOD })),
  } as never)).acceptanceCriteriaItems);

  /** A DONE code task serving one criterion, with the work session that ran its branch. */
  async function doneCodeTask(title: string, criterionKey: string) {
    const task = await tasks.create(ownerId, {
      title, projectId, criterionKey,
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never);
    await settle(task.id, 'DONE');
    const branch = `orbit/${task.id.slice(0, 8)}`;
    const sessionId = randomUUID();
    await prisma.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, taskId: task.id, title, prompt: title, branch,
        isolationStatus: 'worktree', turnState: null, startsTaskWork: true,
        finishedAt: new Date(Date.now() - 3_000_000), worktreeBranch: branch, worktreeDirty: false,
      },
    });
    return { taskId: task.id, sessionId, branch };
  }
  type Work = Awaited<ReturnType<typeof doneCodeTask>>;

  async function settle(taskId: string, status: 'OPEN' | 'DONE') {
    const written = await prisma.task.updateMany({ where: { id: taskId, ownerId }, data: { status } });
    assert.equal(written.count, 1);
  }

  /** A landing's receipt on the project line, as the relay writes it: the branch tip it merged,
   *  and where it left the line (`targetShaAfter`, the job's `landed_sha`). */
  async function lineReceipt(work: Work, input: { sourceSha: string; landedSha: string; at: Date }) {
    await prisma.sessionMergeReceipt.create({
      data: {
        ownerId, sessionId: work.sessionId, taskId: work.taskId, projectId, result: 'MERGED',
        sourceBranch: work.branch, sourceSha: input.sourceSha, targetBranch: line, targetShaBefore: sha('8'),
        targetShaAfter: input.landedSha, recordedBy: 'RUNNER', detail: { integrationJobId: randomUUID() },
        idempotencyKey: randomUUID(), createdAt: input.at,
      },
    });
  }

  /** A LAND_TASK the line answered LANDED: what names the project-branch tip a candidate is about. */
  async function landed(work: Work, generation: number, landedSha: string, at: Date) {
    await prisma.projectIntegrationJob.create({
      data: {
        projectId, ownerId, codebaseId: codebase.id, kind: 'LAND_TASK', state: 'LANDED', phase: 'VERIFY',
        taskId: work.taskId, sessionId: work.sessionId, generation,
        serialKey: integrationSerialKey({ kind: 'LAND_TASK', canonicalRepoUrl: REPO_URL, targetRef: integrationRef, projectId }),
        targetRef: integrationRef, upstreamRef: 'refs/heads/main', sourceRef: `refs/heads/${work.branch}`,
        landedSha, testedTreeSha: sha('6'), landedTreeSha: sha('6'), createdAt: at, finishedAt: at,
        idempotencyKey: integrationIdempotencyKey({ kind: 'LAND_TASK', subjectId: work.taskId, generation }),
      },
    });
  }

  async function integrationState(taskId: string): Promise<string> {
    const read = await tasks.get(ownerId, taskId) as unknown as { integration: { state: string } };
    return read.integration.state;
  }

  async function criterionReading(text: string) {
    const read = await projects.get(ownerId, projectId) as unknown as {
      acceptanceCriteriaItems: Array<{ id: string; text: string; landing: string }>;
      derivedDone: { criteria: Array<{ definitionId: string; landing: string; landingReason: string | null }>; counts: { onMain: number } };
    };
    const item = read.acceptanceCriteriaItems.find((row) => row.text === text);
    assert.ok(item, `the project must state “${text}”`);
    const derived = read.derivedDone.criteria.find((row) => row.definitionId === item.id);
    assert.ok(derived, `derivedDone must answer for “${text}”`);
    return { landing: item.landing, derivedLanding: derived.landing, landingReason: derived.landingReason, onMain: read.derivedDone.counts.onMain };
  }

  /** A coordinator's request, then the production door. The candidate's task set, or null. */
  async function requestedCandidate(): Promise<string[] | null> {
    const pending = await prisma.projectPromotionRequest.count({ where: { projectId, consumedByPromotionId: null } });
    if (pending === 0) await seedPromotionRequest(prisma, projectId);
    const made = await promotions.considerCandidate(projectId);
    if (!made) return null;
    const row = await prisma.projectPromotion.findUniqueOrThrow({ where: { id: made.promotionId }, select: { includedTaskIds: true } });
    return row.includedTaskIds;
  }

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  /** The relay's LAND_PROMOTION result for a confirmed candidate, in its own transaction. */
  async function promotionLands(promotionId: string, mergedSha: string) {
    const row = await prisma.projectPromotion.findUniqueOrThrow({ where: { id: promotionId }, select: { sourceSha: true } });
    const outcome = await prisma.$transaction((tx) => applyPromotionJobResult(tx, {
      promotionId, jobId: randomUUID(), jobKind: 'LAND_PROMOTION', runnerId: null, state: 'LANDED',
      upstreamSha: sha('e'), sourceSha: row.sourceSha, testedSha: mergedSha, testedTreeSha: sha('5'),
      landedSha: mergedSha, targetShaBefore: sha('e'), aheadOfUpstream: 1, filesChanged: 1,
      checks: [], conflicts: [], cancelRequested: false, errorCode: null, movedCommitsReported: false,
    }));
    assert.equal(outcome?.state, 'MERGED');
  }

  /** The candidate checked and confirmed: the merge is in flight from here on. */
  async function confirm(promotionId: string) {
    const row = await prisma.projectPromotion.update({
      where: { id: promotionId },
      data: { state: 'CONFIRMED', confirmedByUserId: ownerId, confirmedAt: new Date(), upstreamShaChecked: sha('e') },
      select: { checkJobId: true },
    });
    if (row.checkJobId) {
      await prisma.projectIntegrationJob.update({ where: { id: row.checkJobId }, data: { state: 'READY', finishedAt: new Date() } });
    }
  }

  async function mainReceiptShas(work: Work): Promise<string[]> {
    const rows = await prisma.sessionMergeReceipt.findMany({
      where: { taskId: work.taskId, targetBranch: 'main' }, orderBy: { createdAt: 'asc' }, select: { sourceSha: true },
    });
    return rows.map((row) => row.sourceSha);
  }

  // ── land → candidate confirmed, merge in flight ────────────────────────────────────────────────
  const reworked = await doneCodeTask('the fix that is reworked mid-merge', criterion!.key);
  const untouched = await doneCodeTask('work that is never reworked', other!.key);

  await landed(untouched, 1, sha('1'), at(50));
  await lineReceipt(untouched, { sourceSha: sha('a'), landedSha: sha('1'), at: at(50) });
  await landed(reworked, 1, sha('2'), at(45));
  await lineReceipt(reworked, { sourceSha: sha('b'), landedSha: sha('2'), at: at(45) });

  await seedPromotionRequest(prisma, projectId);
  const first = await promotions.considerCandidate(projectId);
  assert.ok(first, 'the line\'s tip is offered');
  const frozen = await prisma.projectPromotion.findUniqueOrThrow({
    where: { id: first.promotionId }, select: { sourceSha: true, includedTaskIds: true },
  });
  assert.equal(frozen.sourceSha, sha('2'), 'the candidate froze the tip the first landing left');
  assert.deepEqual([...frozen.includedTaskIds].sort(), [reworked.taskId, untouched.taskId].sort());
  await confirm(first.promotionId);

  // ── reopen → the rework lands on the line while the merge is in flight ─────────────────────────
  await settle(reworked.taskId, 'OPEN');
  await settle(reworked.taskId, 'DONE');
  await landed(reworked, 2, sha('4'), at(1));
  await lineReceipt(reworked, { sourceSha: sha('d'), landedSha: sha('4'), at: at(1) });
  assert.equal(await requestedCandidate(), null, 'a merge in flight is not replaced by the newer landing');

  // ── the in-flight promotion lands ──────────────────────────────────────────────────────────────
  await promotionLands(first.promotionId, sha('9'));

  assert.deepEqual(await mainReceiptShas(reworked), [sha('2')],
    'the merge names the landing its frozen source carries, not the rework');
  assert.deepEqual(await mainReceiptShas(untouched), [sha('1')], 'a task with no race gets the receipt it always did');

  const stateAfterRace = await integrationState(reworked.taskId);
  assert.notEqual(stateAfterRace, 'ON_UPSTREAM', 'the rework is not on main');
  assert.equal(stateAfterRace, 'ON_INTEGRATION_LINE');
  assert.equal(await integrationState(untouched.taskId), 'ON_UPSTREAM');
  const raced = await criterionReading(CRITERION);
  assert.notEqual(raced.landing, 'LANDED', 'its criterion is not on main');
  assert.notEqual(raced.derivedLanding, 'LANDED');
  assert.equal(raced.onMain, 1, 'only the untouched criterion counts on main');
  assert.equal((await criterionReading(OTHER)).derivedLanding, 'LANDED');

  const included = await requestedCandidate();
  assert.deepEqual(included, [reworked.taskId], 'the next candidate carries the rework, and only it');

  // ── the promotion carrying the rework lands ────────────────────────────────────────────────────
  const second = await prisma.projectPromotion.findFirstOrThrow({
    where: { projectId, state: 'CHECKING' }, select: { id: true, sourceSha: true },
  });
  assert.equal(second.sourceSha, sha('4'));
  await confirm(second.id);
  await promotionLands(second.id, sha('c'));

  assert.deepEqual(await mainReceiptShas(reworked), [sha('2'), sha('4')], 'this merge names the rework');
  assert.equal(await integrationState(reworked.taskId), 'ON_UPSTREAM', 'the rework reached main');
  const after = await criterionReading(CRITERION);
  assert.equal(after.landing, 'LANDED');
  assert.equal(after.derivedLanding, 'LANDED');
  assert.equal(after.landingReason, null);
  assert.equal(after.onMain, 2);
  assert.equal(await requestedCandidate(), null, 'nothing is left to offer');
});
