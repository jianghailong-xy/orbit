import { seedPromotionRequest } from '../test-support/promotion-request';
/**
 * An observed receipt about another commit does not keep a task's work off the promotion.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-observed-receipt-other-sha.pg.spec.ts
 *
 * WHAT WAS WRONG (2026-11-10, project 34uUvixOgW5SbuNGvkAKA)
 * ========================================================
 * Task 34vJmfV0DZk5cySoXlB3r, the runner 0.1.253 bump, committed 6b84ce7d4 on its branch, but its
 * delivered identity was frozen at fe5db828a: a tip from before the commit, already on main. Its
 * LAND_TASK merged the real tip into the project branch (MERGED, source 6b84ce7d4), and an
 * OBSERVE_LANDING found the stale commit on main and wrote ALREADY_MERGED to main (source
 * fe5db828a, `detail.observed`). `ProjectPromotionService.tasksOnTheLine` read any receipt on main
 * as "already there", so the bump was in no candidate, `considerCandidate` offered none, and it
 * reached main only because a later task's candidate carried it along.
 *
 * WHAT THIS SPEC ASSERTS
 * ======================
 * Through `considerCandidate`, the production door: a task on the project line whose only receipt
 * on main is an observed one naming a commit other than the one its project-line receipt landed is
 * included in the candidate. The rules that keep work already on main out of it still hold: an
 * observed receipt naming the commit the line receipt landed, and a receipt a landing wrote to
 * main, each exclude their task.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CreatorType, PrismaClient, RunStatus, TaskStatus } from '@prisma/client';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';
import { integrationIdempotencyKey, integrationSerialKey } from './project-integration-job';
import { ProjectPromotionService } from './project-promotion.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const sha = (nibble: string) => nibble.repeat(40);
const REPO_URL = 'https://github.com/example/promotion-observed-other-sha';

interface World {
  ownerId: string;
  projectId: string;
  codebaseId: string;
  integrationRef: string;
  branch: string;
}

/** One project on a PROJECT_BRANCH line, integrating on a branch of its own into main. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@promotion-observed.invalid`, name: label, passwordHash: 'x' },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: `${label} project` } });
  const branch = `project/${projectId.slice(0, 8)}`;
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: REPO_URL, upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${branch}`, refAuthority: 'REMOTE', remoteName: 'origin',
      integrationRefSource: 'DEFAULT_RULE', integrationStartedAt: new Date(),
    },
    select: { id: true },
  });
  return { ownerId, projectId, codebaseId: codebase.id, branch, integrationRef: `refs/heads/${branch}` };
}

/** A DONE task of the project with its finished work session. */
async function doneTask(db: PrismaClient, w: World, title: string): Promise<{ taskId: string; sessionId: string }> {
  const task = await db.task.create({
    data: {
      ownerId: w.ownerId, projectId: w.projectId, title, status: TaskStatus.DONE,
      creatorType: CreatorType.AGENT, creatorId: w.ownerId, completionCriterion: 'EXECUTABLE',
    },
    select: { id: true },
  });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: task.id, title, prompt: title,
      status: RunStatus.SUCCEEDED, startsTaskWork: true, completedAt: new Date(),
    },
  });
  return { taskId: task.id, sessionId };
}

/** A receipt row as the receipt doors leave it. */
async function receipt(
  db: PrismaClient,
  w: World,
  t: { taskId: string; sessionId: string },
  input: { result: 'MERGED' | 'ALREADY_MERGED'; targetBranch: string; sourceSha: string; observed?: boolean; at: Date },
): Promise<void> {
  await db.sessionMergeReceipt.create({
    data: {
      ownerId: w.ownerId, sessionId: t.sessionId, taskId: t.taskId, projectId: w.projectId,
      result: input.result, sourceBranch: `orbit/${t.taskId.slice(0, 8)}`, sourceSha: input.sourceSha,
      targetBranch: input.targetBranch, targetShaBefore: sha('8'),
      targetShaAfter: input.result === 'MERGED' ? sha('7') : null,
      recordedBy: 'RUNNER', detail: input.observed ? { observed: true, integrationJobId: randomUUID() } : {},
      idempotencyKey: randomUUID(), createdAt: input.at,
    },
  });
}

/** The newest LANDED LAND_TASK, which names the project-branch tip a candidate is about. */
async function landedJob(db: PrismaClient, w: World, t: { taskId: string; sessionId: string }, landedSha: string) {
  await db.projectIntegrationJob.create({
    data: {
      projectId: w.projectId, ownerId: w.ownerId, codebaseId: w.codebaseId, kind: 'LAND_TASK',
      state: 'LANDED', phase: 'VERIFY', taskId: t.taskId, sessionId: t.sessionId,
      serialKey: integrationSerialKey({ kind: 'LAND_TASK', canonicalRepoUrl: REPO_URL, targetRef: w.integrationRef, projectId: w.projectId }),
      targetRef: w.integrationRef, upstreamRef: 'refs/heads/main', sourceRef: `refs/heads/orbit/${t.taskId.slice(0, 8)}`,
      landedSha, testedTreeSha: sha('6'), landedTreeSha: sha('6'), finishedAt: new Date(),
      idempotencyKey: integrationIdempotencyKey({ kind: 'LAND_TASK', subjectId: t.taskId, generation: 1 }),
    },
  });
}

test('a task whose own tip is only on the project line is in the candidate though an observed receipt puts another commit of its on main', {
  skip, timeout: 120_000,
}, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  const promotions = new ProjectPromotionService(db as unknown as PrismaService);
  try {
    const w = await world(db, 'observed-other-sha');
    const t0 = new Date(Date.now() - 60_000);
    const t1 = new Date(Date.now() - 30_000);

    // The 0.1.253 bump: its LAND_TASK merged the real tip (c) into the project line, and an
    // observation wrote ALREADY_MERGED to main for the stale tip (a) its identity was frozen at.
    const bump = await doneTask(db, w, 'the bump, frozen at a stale tip');
    await receipt(db, w, bump, { result: 'ALREADY_MERGED', targetBranch: 'main', sourceSha: sha('a'), observed: true, at: t0 });
    await receipt(db, w, bump, { result: 'MERGED', targetBranch: w.branch, sourceSha: sha('c'), at: t0 });

    // Work that really is on main, observed there by the commit its line receipt landed.
    const observedOnMain = await doneTask(db, w, 'observed on main by the commit it landed');
    await receipt(db, w, observedOnMain, { result: 'MERGED', targetBranch: w.branch, sourceSha: sha('d'), at: t0 });
    await receipt(db, w, observedOnMain, { result: 'ALREADY_MERGED', targetBranch: 'main', sourceSha: sha('d'), observed: true, at: t1 });

    // Work a promotion's landing put on main: its receipt there names the project-line commit.
    const promoted = await doneTask(db, w, 'promoted to main');
    await receipt(db, w, promoted, { result: 'MERGED', targetBranch: w.branch, sourceSha: sha('e'), at: t0 });
    await receipt(db, w, promoted, { result: 'MERGED', targetBranch: 'main', sourceSha: sha('5'), at: t1 });

    await landedJob(db, w, bump, sha('1'));
    await seedPromotionRequest(db, w.projectId);
    const made = await promotions.considerCandidate(w.projectId);
    assert.ok(made, 'no candidate was offered: the bump, whose own commit is only on the project line, was excluded by the observed receipt about the stale commit');
    const row = await db.projectPromotion.findUniqueOrThrow({ where: { id: made.promotionId }, select: { includedTaskIds: true } });
    assert.deepEqual(row.includedTaskIds, [bump.taskId],
      'the candidate includes the bump, and not the two tasks whose work is on main');
  } finally {
    await db.$disconnect();
  }
});
