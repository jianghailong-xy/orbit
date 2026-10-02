/**
 * A merge card that ends answers the exceptions it left open.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-integration-items-close.pg.spec.ts
 *
 * WHAT WAS WRONG (2026-10-02 07:07, project 34Yjjgt2ERe9tU5TUmjAP)
 * ==============================================================
 * A `LAND_PROMOTION`'s fetch lost a race for `refs/remotes/origin/main` — another `git fetch` in the
 * same repository held the ref at that moment — and the job was recorded as `ERROR /
 * BASE_REF_NOT_FOUND`. That blocked the merge card and opened `INTEGRATION_ERROR`
 * 01a0fb70-b1f3-763e-b697-185c60a4b773, saying main had not been changed. main was fine; the item was
 * the problem. A promotion's items name `promotion_id` and NO task (a promotion is not about one), so
 * the rule that closes these items when work lands — keyed by TASK — could not reach it, and nothing
 * else keyed on the promotion either: whether the card was later superseded by the next candidate,
 * turned down, called back or merged, the item stayed OPEN and only a person could close it.
 *
 * WHAT THIS SPEC ASSERTS
 * ======================
 * For each way a candidate ends — superseded (M-T6), declined (M-T5), merged (M-T9) — the still-OPEN
 * `INTEGRATION_*` items carrying its `promotion_id` are closed by the PLATFORM, in the transaction
 * that wrote the ending: `PROMOTION_MOVED_ON` with the candidate's own state, which is `SUPERSEDED`
 * for a candidate a newer one took the place of and `RESOLVED` for the other two (§4.2, and the same
 * pair the backstop writes). Items that are not about it — another candidate's, a task landing's (no
 * promotion at all) and a failed task's own — are left exactly as they were.
 *
 * The code under test is what main landed for this incident
 * (`feat(projects): close promotion items when a candidate moves on`, `closePromotionItems` in
 * projects/project-promotion.service.ts, migration 0353's index): this file is the task's own pin on
 * it, driven through the production doors rather than through that function.
 *
 * The items are opened by `recordIntegrationFailure`, the door a job's terminal state writes them
 * through, and the endings are driven through the production doors: `considerCandidate` for the
 * supersede the next landing causes, `decline` for the owner's press, and `applyPromotionJobResult`
 * for the landing the runner reports. Only the MERGED case's STARTING state is written where the
 * fixture stands: no door of this build leaves a live candidate with an open exception about it (a
 * candidate whose job fails goes BLOCKED, and a BLOCKED card cannot be confirmed), so the row it
 * starts from is made here — and the ending it is put through is not.
 *
 * The projects here have no coordinator conversation, so the items are the ACCOUNT OWNER's
 * (`NO_COORDINATOR`): what may close them is the point of the note under §4.2 — the owner, or a fact
 * the platform read for itself. A candidate ending is the second kind, and the assignee is not
 * consulted when it is written.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CreatorType, PrismaClient, RunStatus, TaskStatus } from '@prisma/client';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';
import {
  integrationDedupeKey,
  integrationIdempotencyKey,
  integrationSerialKey,
} from './project-integration-job';
import { recordIntegrationFailure } from './project-open-item';
import { ProjectPromotionService, applyPromotionJobResult } from './project-promotion.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/** A full 40-hex object name, the only kind an integration job's sha columns accept. */
const sha = (nibble: string) => nibble.repeat(40);

const REPO_URL = 'https://github.com/example/promotion-items';

interface World {
  ownerId: string;
  projectId: string;
  codebaseId: string;
  /** The project's integration branch, as a ref and as the short name a receipt holds. */
  integrationRef: string;
  branch: string;
}

/** One project on a PROJECT_BRANCH line, integrating on a branch of its own into main. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${RUN}-${ownerId}@promotion-items.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: `${label} project` } });
  const branch = `project/${projectId.slice(0, 8)}`;
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId,
      projectId,
      canonicalRepoUrl: REPO_URL,
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${branch}`,
      refAuthority: 'REMOTE',
      remoteName: 'origin',
      integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: new Date(),
    },
    select: { id: true },
  });
  return { ownerId, projectId, codebaseId: codebase.id, branch, integrationRef: `refs/heads/${branch}` };
}

/**
 * A candidate standing on the project branch, in the state named.
 *
 * `sourceRef` is the project branch unless a case names another one: one live candidate per source
 * is the partial unique index `project_promotion_active_source_key` (0286), and the candidate an
 * item is about has to be able to stand beside the one a case is NOT about.
 */
async function candidate(
  db: PrismaClient,
  w: World,
  input: {
    state: string;
    sourceSha: string;
    sourceRef?: string;
    /** The person the confirmation is attributed to: the three states after one must name somebody
     *  (`project_promotion_confirmed_by_chk`, 0301), and the row a landing is applied to becomes
     *  one of them. */
    confirmedBy?: string;
    /** A card that reached the upstream: MERGED must name the commit it became (0286). */
    mergedSha?: string;
  },
): Promise<string> {
  const row = await db.projectPromotion.create({
    data: {
      projectId: w.projectId,
      ownerId: w.ownerId,
      codebaseId: w.codebaseId,
      sourceKind: 'PROJECT_BRANCH',
      sourceRef: input.sourceRef ?? w.integrationRef,
      sourceSha: input.sourceSha,
      upstreamRef: 'refs/heads/main',
      state: input.state,
      includedTaskIds: [],
      ...(input.confirmedBy ? { confirmedByUserId: input.confirmedBy, confirmedAt: new Date() } : {}),
      ...(input.mergedSha ? { mergedSha: input.mergedSha, mergedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

/** A task of this project, so an item that HAS a task can be told apart from one that has none. */
async function task(db: PrismaClient, w: World, title: string): Promise<string> {
  const row = await db.task.create({
    data: {
      ownerId: w.ownerId, projectId: w.projectId, title, status: TaskStatus.DONE,
      creatorType: CreatorType.AGENT, creatorId: w.ownerId,
      completionCriterion: 'EXECUTABLE',
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * A finished integration job row, as the queue writes it: the row an item's `integration_job_id`
 * points at (the foreign key 0281 added), and the row a job's terminal state is read back from.
 */
async function finishedJob(
  db: PrismaClient,
  w: World,
  input: {
    kind: 'LAND_TASK' | 'CHECK_PROMOTION' | 'LAND_PROMOTION';
    state: 'ERROR' | 'CONFLICT' | 'CHECK_FAILED' | 'LANDED';
    subjectId: string;
    promotionId?: string;
    taskId?: string;
    sessionId?: string;
    sourceRef?: string;
    /** The three shas J2's CHECK requires of a LANDED row, all the same tree. */
    landedSha?: string;
  },
): Promise<string> {
  const targetRef = input.kind === 'LAND_TASK' ? w.integrationRef : 'refs/heads/main';
  const row = await db.projectIntegrationJob.create({
    data: {
      projectId: w.projectId, ownerId: w.ownerId, codebaseId: w.codebaseId,
      kind: input.kind, state: input.state, phase: input.state === 'LANDED' ? 'VERIFY' : 'FETCH',
      promotionId: input.promotionId ?? null,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      serialKey: integrationSerialKey({
        kind: input.kind, canonicalRepoUrl: REPO_URL, targetRef, projectId: w.projectId,
      }),
      targetRef, upstreamRef: 'refs/heads/main', sourceRef: input.sourceRef ?? w.integrationRef,
      landedSha: input.landedSha ?? null,
      testedTreeSha: input.landedSha ? sha('7') : null,
      landedTreeSha: input.landedSha ? sha('7') : null,
      finishedAt: new Date(),
      idempotencyKey: integrationIdempotencyKey({ kind: input.kind, subjectId: input.subjectId, generation: 1 }),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * The exception a promotion job's failure opens, through the door that opens it in production — the
 * job row, and the payload the incident recorded: stopped in FETCH, main not changed.
 */
async function promotionException(
  db: PrismaClient,
  w: World,
  promotionId: string,
  state: 'ERROR' | 'CONFLICT' | 'CHECK_FAILED' = 'ERROR',
): Promise<string> {
  const jobId = await finishedJob(db, w, { kind: 'LAND_PROMOTION', state, subjectId: promotionId, promotionId });
  const opened = await db.$transaction((tx) => recordIntegrationFailure(tx, {
    projectId: w.projectId,
    ownerId: w.ownerId,
    jobId,
    taskId: null,
    sessionId: null,
    promotionId,
    state,
    title: `Merge into refs/heads/main stopped (${state})`,
    dedupeKey: integrationDedupeKey(state, jobId),
    payload: {
      jobKind: 'LAND_PROMOTION',
      phase: 'FETCH',
      targetRef: 'refs/heads/main',
      errorCode: 'BASE_REF_NOT_FOUND',
      failureClass: 'ERROR',
      branchUnchanged: true,
    },
  }));
  assert.ok(opened, 'the failure opened no exception item');
  return opened.itemId;
}

/**
 * The items nothing here is about: another candidate's exception, a task landing's (which names no
 * promotion at all) and a failed task's own. All three must still be OPEN when the cases below are
 * done with their own.
 */
async function unrelatedItems(db: PrismaClient, w: World, otherPromotionId: string): Promise<string[]> {
  const aTask = await task(db, w, 'a task whose item is not about any promotion');
  const check = await finishedJob(db, w, {
    kind: 'CHECK_PROMOTION', state: 'CHECK_FAILED', subjectId: otherPromotionId, promotionId: otherPromotionId,
  });
  const landing = await finishedJob(db, w, { kind: 'LAND_TASK', state: 'CONFLICT', subjectId: aTask, taskId: aTask });
  return await db.$transaction(async (tx) => {
    const other = await recordIntegrationFailure(tx, {
      projectId: w.projectId, ownerId: w.ownerId, jobId: check, taskId: null, sessionId: null,
      promotionId: otherPromotionId, state: 'CHECK_FAILED',
      title: 'another candidate failed its check',
      dedupeKey: integrationDedupeKey('CHECK_FAILED', check),
      payload: { jobKind: 'CHECK_PROMOTION', check: null, failureClass: 'CHECK_FAILED' },
    });
    const taskLanding = await recordIntegrationFailure(tx, {
      projectId: w.projectId, ownerId: w.ownerId, jobId: landing, taskId: aTask, sessionId: null,
      promotionId: null, state: 'CONFLICT',
      title: 'a task landing conflicted',
      dedupeKey: integrationDedupeKey('CONFLICT', landing),
      payload: { jobKind: 'LAND_TASK', files: ['a.txt'], failureClass: 'CONFLICT' },
    });
    const failed = await tx.projectOpenItem.create({
      data: {
        projectId: w.projectId, ownerId: w.ownerId, kind: 'TASK_FAILED', state: 'OPEN',
        assignee: 'OWNER', assigneeReason: 'NO_COORDINATOR', taskId: aTask,
        dedupeKey: `TF:${aTask}:fixture`, title: 'Task failed',
        payload: { how: 'RUN_FAILED', chain: { failuresInChain: 1, limit: 3 } },
        waitingSince: new Date(), assignedAt: new Date(),
      },
      select: { id: true },
    });
    assert.ok(other && taskLanding, 'a fixture item was not opened');
    return [other.itemId, taskLanding.itemId, failed.id];
  });
}

/** What an item is, in the five columns an ending is read in. */
async function itemState(db: PrismaClient, itemId: string) {
  return db.projectOpenItem.findUniqueOrThrow({
    where: { id: itemId },
    select: { state: true, resolution: true, resolvedBy: true, resolvedByUserId: true, assignee: true },
  });
}

/**
 * What an ending the platform read for itself leaves on the item: `PROMOTION_MOVED_ON`, closed by
 * the PLATFORM, in the state the candidate itself ended in — `SUPERSEDED` when a newer candidate
 * took its place, `RESOLVED` for the endings that lead nowhere else (§4.2).
 */
async function assertMovedOn(
  db: PrismaClient,
  itemId: string,
  state: 'SUPERSEDED' | 'RESOLVED',
  what: string,
): Promise<void> {
  const item = await itemState(db, itemId);
  assert.equal(item.state, state, `${what}: the item is ${item.state}, not ${state}`);
  assert.equal(item.resolution, 'PROMOTION_MOVED_ON', `${what}: the fact it was closed on`);
  assert.equal(item.resolvedBy, 'PLATFORM', `${what}: closed by the platform, nobody pressed anything`);
  assert.equal(item.resolvedByUserId, null, `${what}: no person decided this`);
}

async function assertOpen(db: PrismaClient, itemIds: readonly string[], what: string): Promise<void> {
  for (const id of itemIds) {
    const item = await itemState(db, id);
    assert.equal(item.state, 'OPEN', `${what}: item ${id} is ${item.state} ${item.resolution ?? ''}`);
  }
}

function connect(): { db: PrismaClient; prisma: PrismaService; promotions: ProjectPromotionService } {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  return { db, prisma, promotions: new ProjectPromotionService(prisma) };
}

test('the next candidate supersedes the one standing, and closes the exception its job left behind', {
  skip, timeout: 120_000,
}, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const { db, promotions } = connect();
  try {
    const w = await world(db, 'supersede');
    const working = await task(db, w, 'the work the next candidate offers');
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: working,
        title: 'the work', prompt: 'the work', status: RunStatus.SUCCEEDED,
        startsTaskWork: true, completedAt: new Date(),
      },
    });
    // The task's work is on the project branch and not yet on main: what `tasksOnTheLine` looks for,
    // through the receipt door both integration jobs write through.
    const onTheLine = sha('1');
    await MergeReceiptService.fromIntegrationJob(db, {
      ownerId: w.ownerId, sessionId, taskId: working, projectId: w.projectId, jobId: randomUUID(),
      state: 'LANDED', sourceBranch: 'orbit/the-work', targetBranch: w.branch,
      sourceSha: sha('9'), targetShaBefore: sha('8'), landedSha: onTheLine, rebaseBaseSha: sha('8'),
      testedTreeSha: null, landedTreeSha: null, mainSyncSha: null,
    });
    // The landing that put it there: the newest LANDED LAND_TASK names the tip a candidate is about.
    await finishedJob(db, w, {
      kind: 'LAND_TASK', state: 'LANDED', subjectId: working, taskId: working, sessionId,
      sourceRef: 'refs/heads/orbit/the-work', landedSha: onTheLine,
    });

    // The candidate whose check failed on main: BLOCKED, with the item its job opened.
    const standing = await candidate(db, w, { state: 'BLOCKED', sourceSha: sha('c') });
    const stale = await promotionException(db, w, standing);
    // Another candidate of this project, on a source of its own — what the retire is scoped to says
    // nothing about it.
    const other = await candidate(db, w, {
      state: 'CHECKING', sourceSha: sha('d'), sourceRef: `refs/heads/${w.branch}-other`,
    });
    const untouched = await unrelatedItems(db, w, other);

    const made = await promotions.considerCandidate(w.projectId);
    assert.ok(made, 'the landing offered no candidate');
    const after = await db.projectPromotion.findUniqueOrThrow({
      where: { id: standing }, select: { state: true },
    });
    assert.equal(after.state, 'SUPERSEDED', 'the candidate standing was not retired by the new one');

    // SUPERSEDED rather than RESOLVED: the item is closed because a newer candidate took the old
    // one's place, which is the same state the backstop writes for that fact (open-item-escalation).
    await assertMovedOn(db, stale, 'SUPERSEDED', 'the superseded candidate\'s exception');
    await assertOpen(db, untouched, 'the supersede closed somebody else\'s item');
  } finally {
    await db.$disconnect();
  }
});

test("the owner's Not now closes the exception the blocked card left behind", {
  skip, timeout: 120_000,
}, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const { db, promotions } = connect();
  try {
    const w = await world(db, 'declined');
    const blocked = await candidate(db, w, { state: 'BLOCKED', sourceSha: sha('c') });
    const stale = await promotionException(db, w, blocked);
    const other = await candidate(db, w, {
      state: 'READY', sourceSha: sha('d'), sourceRef: `refs/heads/${w.branch}-other`,
    });
    const untouched = await unrelatedItems(db, w, other);

    // No coordinator conversation in this world, so the item is the account owner's — and it is the
    // platform that closes it, on a fact it read for itself.
    assert.equal((await itemState(db, stale)).assignee, 'OWNER');

    const view = await promotions.decline({ userId: w.ownerId }, w.projectId, blocked);
    assert.equal(view.state, 'DECLINED');

    await assertMovedOn(db, stale, 'RESOLVED', 'the declined card\'s exception');
    await assertOpen(db, untouched, 'the decline closed somebody else\'s item');
  } finally {
    await db.$disconnect();
  }
});

test('a merge that lands closes the exception an earlier generation of the candidate left behind', {
  skip, timeout: 120_000,
}, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const { db } = connect();
  try {
    const w = await world(db, 'merged');
    // Confirmed and then handed back to the owner waiting on a card: the row `handBackToOwner`
    // leaves, and the one whose merge the CHECKs below have to let through.
    const ready = await candidate(db, w, { state: 'READY', sourceSha: sha('a'), confirmedBy: w.ownerId });
    const stale = await promotionException(db, w, ready);
    const other = await candidate(db, w, {
      state: 'BLOCKED', sourceSha: sha('d'), sourceRef: `refs/heads/${w.branch}-other`,
    });
    const untouched = await unrelatedItems(db, w, other);

    const merged = sha('4');
    // The landing the runner reports (M-T9), in the transaction the relay applies it in.
    const outcome = await db.$transaction((tx) => applyPromotionJobResult(tx, {
      promotionId: ready,
      jobId: randomUUID(),
      jobKind: 'LAND_PROMOTION',
      runnerId: null,
      state: 'LANDED',
      upstreamSha: sha('e'),
      sourceSha: sha('a'),
      testedSha: sha('f'),
      testedTreeSha: sha('3'),
      landedSha: merged,
      targetShaBefore: sha('e'),
      aheadOfUpstream: 1,
      filesChanged: 1,
      checks: [],
      conflicts: [],
    }));
    assert.equal(outcome?.state, 'MERGED');

    await assertMovedOn(db, stale, 'RESOLVED', 'the merged candidate\'s exception');
    await assertOpen(db, untouched, 'the merge closed somebody else\'s item');
  } finally {
    await db.$disconnect();
  }
});
