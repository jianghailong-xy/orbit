import { seedPromotionRequest } from '../test-support/promotion-request';
/**
 * A task whose first landing reached main, reopened and landed again, is carried by the next
 * promotion — and reads as on main again only once that rework is.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-reworked-task.pg.spec.ts
 *
 * WHAT WAS WRONG (2026-11-02 and 2026-11-08)
 * ==========================================
 * Task F1-4 (34tKGcrnquvU39DMmkuPT) reached main with its revision 2 in a promotion (receipt
 * 34tkSRVv2Z2zFOZQl3CmC). It was reopened, and revision 3 (91938e64e) landed on the project line
 * (receipt 34tqN1ZPGNjRF9iDKDAqQ). `tasksOnTheLine` counted the task as on main because it had a
 * main receipt at all, so `includedTaskIds` was empty and no candidate — not even an explicitly
 * requested one — was offered. `task_get` read `integration.state` ON_UPSTREAM and the criterion it
 * served read LANDED, while the rework sat on the project line only. T1 of project
 * 34qIISTdcSurVokwRlp4w had the same shape on 2026-11-02 (8b1915dfa, then 54e59bc8b).
 *
 * WHAT THIS SPEC ASSERTS
 * ======================
 * One sequence, land → promote → reopen → land again → promote, read at each step through the
 * production doors: `considerCandidate` behind a coordinator's request (K7), `TasksService.get` for
 * `integration.state`, and `ProjectsService.get` for the criterion's landing and `derivedDone`.
 *
 *  - after the first promotion, the task reads ON_UPSTREAM, its criterion LANDED, and a request
 *    offers no candidate: work already on main is not offered again;
 *  - after the rework lands on the line, the task is not ON_UPSTREAM, its criterion is not counted
 *    on main, and a request offers a candidate that includes it — and not the task beside it that
 *    was never reworked, nor one an observation saw on main by the commit it landed (2026-11-10);
 *  - after the promotion carrying the rework writes its main receipt, all three read on main again.
 *
 * The receipts are written as their doors leave them; which commit contains which is a
 * repository's fact, and this lane decides from receipts alone.
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
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);
const REPO_URL = 'ssh://git@example.invalid/promotion-reworked-task';
const METHOD = 'Read it and say whether it holds';
const CRITERION = 'the reworked fix is on main';
const OTHER = 'the untouched work is on main';

test('a reworked task is carried by the next promotion, and reads on main only once its rework is', {
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
    data: { id: ownerId, email: `reworked-${ownerId}@promotion-reworked.invalid`, name: 'owner', passwordHash: 'x' },
  });
  const projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, ownerId, title: 'a project whose task was reworked' } });
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

  /** A landed receipt as the landing and promotion doors leave it; `observed` as an observation does. */
  async function receipt(work: Work, input: {
    targetBranch: string; sourceSha: string; at: Date; result?: 'MERGED' | 'ALREADY_MERGED'; observed?: boolean;
  }) {
    const result = input.result ?? 'MERGED';
    await prisma.sessionMergeReceipt.create({
      data: {
        ownerId, sessionId: work.sessionId, taskId: work.taskId, projectId, result,
        sourceBranch: input.targetBranch === 'main' ? line : work.branch, sourceSha: input.sourceSha,
        targetBranch: input.targetBranch, targetShaBefore: sha('8'),
        targetShaAfter: result === 'MERGED' ? sha('7') : null, recordedBy: 'RUNNER',
        detail: input.observed ? { observed: true, integrationJobId: randomUUID() } : { integrationJobId: randomUUID() },
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

  // ── land → promote ─────────────────────────────────────────────────────────────────────────────
  const reworked = await doneCodeTask('the fix that is reworked', criterion!.key);
  const untouched = await doneCodeTask('work that is never reworked', other!.key);
  const observedOnMain = await doneCodeTask('work an observation saw on main', other!.key);

  await landed(untouched, 1, sha('1'), at(50));
  await receipt(untouched, { targetBranch: line, sourceSha: sha('a'), at: at(50) });
  await landed(reworked, 1, sha('2'), at(45));
  await receipt(reworked, { targetBranch: line, sourceSha: sha('b'), at: at(45) });
  await landed(observedOnMain, 1, sha('3'), at(44));
  await receipt(observedOnMain, { targetBranch: line, sourceSha: sha('c'), at: at(44) });
  // The first promotion: one receipt on main per task it carried, naming each one's landed commit.
  await receipt(untouched, { targetBranch: 'main', sourceSha: sha('1'), at: at(40) });
  await receipt(reworked, { targetBranch: 'main', sourceSha: sha('2'), at: at(40) });
  // 2026-11-10's rule: an observation on main naming the commit the line receipt landed.
  await receipt(observedOnMain, { targetBranch: 'main', sourceSha: sha('c'), at: at(40), result: 'ALREADY_MERGED', observed: true });

  assert.equal(await integrationState(reworked.taskId), 'ON_UPSTREAM', 'after the first promotion the task is on main');
  const promoted = await criterionReading(CRITERION);
  assert.equal(promoted.landing, 'LANDED');
  assert.equal(promoted.derivedLanding, 'LANDED');
  assert.equal(promoted.landingReason, null, 'on main by work of its own');
  assert.equal(promoted.onMain, 2);
  assert.equal(await requestedCandidate(), null, 'work already on main is not offered again');

  // ── reopen → land again ────────────────────────────────────────────────────────────────────────
  await settle(reworked.taskId, 'OPEN');
  await settle(reworked.taskId, 'DONE');
  await landed(reworked, 2, sha('4'), at(30));
  await receipt(reworked, { targetBranch: line, sourceSha: sha('d'), at: at(30) });

  const stateBefore = await integrationState(reworked.taskId);
  assert.notEqual(stateBefore, 'ON_UPSTREAM', 'the rework is on the project line only');
  assert.equal(stateBefore, 'ON_INTEGRATION_LINE');
  assert.equal(await integrationState(untouched.taskId), 'ON_UPSTREAM', 'work never reworked is still on main');
  assert.equal(await integrationState(observedOnMain.taskId), 'ON_UPSTREAM', 'the 11-10 observed rule still puts it on main');
  const before = await criterionReading(CRITERION);
  assert.notEqual(before.landing, 'LANDED', 'its criterion is not on main before the rework is');
  assert.notEqual(before.derivedLanding, 'LANDED');
  assert.equal(before.onMain, 1, 'only the untouched criterion counts on main');
  assert.equal((await criterionReading(OTHER)).derivedLanding, 'LANDED');

  const included = await requestedCandidate();
  assert.deepEqual(included, [reworked.taskId],
    'the candidate carries the reworked task, and neither task whose work is already on main');

  // ── the promotion carrying the rework lands ────────────────────────────────────────────────────
  // Its landing writes the reworked task's receipt on main, naming the rework's landed commit
  // (`writeUpstreamReceipts`): the one fact all three readers below read.
  await receipt(reworked, { targetBranch: 'main', sourceSha: sha('4'), at: at(20) });

  assert.equal(await integrationState(reworked.taskId), 'ON_UPSTREAM', 'the rework reached main');
  const after = await criterionReading(CRITERION);
  assert.equal(after.landing, 'LANDED');
  assert.equal(after.derivedLanding, 'LANDED');
  assert.equal(after.landingReason, null);
  assert.equal(after.onMain, 2);
});
