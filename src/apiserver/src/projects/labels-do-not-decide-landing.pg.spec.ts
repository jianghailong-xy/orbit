import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  Prisma,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { prerequisiteLandedSql } from '../tasks/task-dependencies';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import * as criterionLanding from './project-criterion-landing';
import { readDerivedProjectDone } from './project-done-derived';
import { doneReadiness, readDoneState } from './project-done-request';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * §12.15 P-M3 and P-M4 (`docs/project-integration-line-contract.md`, revision 42): neither the
 * project's non-code mark (`project.non_code`, 0535) nor a task's `codeless` flag decides landing.
 * Landing follows from the commits the work delivered.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/labels-do-not-decide-landing.pg.spec.ts
 *
 *  (1) a committing task in a project marked non-code is queued to land, its dependent waits for the
 *      landing, and the done check and `derivedDone` read its criterion unlanded — reporting the task
 *      by name — until a receipt puts it on main;
 *  (2) a task flagged codeless that has commits is code work: it is queued to land, J9 holds its
 *      dependent, and its criterion waits for it; a codeless run that made no branch still has
 *      nothing to land;
 *  (3) a project NOT marked non-code whose tasks delivered no commit — work that ran no branch and
 *      reported nothing, and a task with no work session at all — passes the done check with
 *      nothing unlanded, and `derivedDone` withholds nothing for landing.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const TOUCHED = [{ path: 'src/thing.ts', status: 'M', additions: 1, deletions: 0 }];

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

interface Stack {
  db: PrismaClient;
  confirmations: TaskOwnerConfirmationService;
}

/** The doors over one client, as production wires them. Nothing reaches a device or a runner. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
  const openItems = new ProjectOpenItemService(prisma, sessions, push);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  return { db, confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime) };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  criterionId: string;
}

/**
 * One owner, one online runner, the workspace the work runs in, a live coordinator conversation, a
 * started project with one criterion, and the non-code mark as `nonCode` says. `line: 'NONE'` is a
 * project with no codebase row (P-M2's project before its first commit); otherwise its line has
 * started on a branch of its own.
 */
async function world(
  stack: Stack, label: string, line: 'NONE' | 'PROJECT_BRANCH', nonCode: boolean,
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const criterionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@labels.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl,
      workDir: `/srv/${label}`,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'labels do not decide landing',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
      startedAt: new Date(),
      ...(nonCode ? { nonCode: true, nonCodeSetBy: 'OWNER', nonCodeSetAt: new Date() } : {}),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  if (line === 'PROJECT_BRANCH') {
    await db.projectCodebase.create({
      data: {
        ownerId, projectId, canonicalRepoUrl: criterionLanding.canonicalRepoUrl(repoUrl)!,
        upstreamRef: 'refs/heads/main', integrationRef: `refs/heads/project/${projectId.slice(0, 8)}`,
        refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(), deliveryMode: 'PLATFORM',
      },
    });
  }
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId, projectId, ordinal: 1, text: `${label}: the work is where it belongs`,
      verificationMethod: 'labels-do-not-decide-landing.pg.spec.ts reads its landing',
      contentHash: '0'.repeat(64),
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, criterionId };
}

/** A task the owner confirms, under the project: IN_PROGRESS, or OPEN and auto-run for a dependent. */
async function task(
  stack: Stack, w: World, title: string,
  options: { dependsOn?: string; serves?: boolean; codeless?: boolean } = {},
): Promise<string> {
  const row = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, completionCriterion: 'OWNER_CONFIRMED',
      status: options.dependsOn ? TaskStatus.OPEN : TaskStatus.IN_PROGRESS,
      autoRunWhenReady: true,
      ...(options.serves ? { criterionDefinitionId: w.criterionId, criterionRevision: 1 } : {}),
      ...(options.codeless ? { codeless: true, codelessReason: 'declared before it committed' } : {}),
    },
    select: { id: true },
  });
  if (options.dependsOn) {
    await stack.db.taskDependency.create({ data: { taskId: row.id, dependsOnTaskId: options.dependsOn } });
  }
  return row.id;
}

/** A finished work session of the task, as the runner's reports left it. */
async function workSession(
  stack: Stack, w: World, taskId: string,
  s: { isolationStatus: string; branch: string | null; branchSha?: string; baseSha?: string; changedFiles?: unknown[] },
): Promise<void> {
  await stack.db.session.create({
    data: {
      id: randomUUID(), ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${taskId.slice(0, 8)}`, prompt: 'work', provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      isolationStatus: s.isolationStatus, branch: s.branch, branchSha: s.branchSha ?? null,
      baseSha: s.baseSha ?? null, changedFiles: (s.changedFiles ?? []) as Prisma.InputJsonValue,
      numTurns: 1, startedAt: minutesAgo(30), createdAt: minutesAgo(30),
      finishedAt: minutesAgo(1), 
    },
  });
}

/** A finished worktree session with a commit of its own on its branch. */
function commits(stack: Stack, w: World, taskId: string, nibble: string): Promise<void> {
  return workSession(stack, w, taskId, {
    isolationStatus: 'worktree', branch: `orbit/${taskId.slice(0, 8)}`, branchSha: sha(nibble),
    baseSha: sha('0'), changedFiles: TOUCHED,
  });
}

/** The owner's Confirm done — the OWNER_CONFIRMED door's DONE write, and the DONE edge after it. */
async function confirm(stack: Stack, w: World, taskId: string): Promise<void> {
  const receipt = await stack.confirmations.decide(
    w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
}

/** Record that this task's branch was merged into `main`, as the production writers record one. */
async function landOnMain(stack: Stack, w: World, taskId: string, nibble: string): Promise<void> {
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: 'merge', prompt: 'merge', provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
      finishedAt: new Date(), 
    },
  });
  await stack.db.sessionMergeReceipt.create({
    data: {
      ownerId: w.ownerId, sessionId, taskId, projectId: w.projectId, result: 'MERGED',
      sourceBranch: `orbit/${taskId.slice(0, 8)}`, sourceSha: sha(nibble), targetBranch: 'main',
      targetShaBefore: sha('b'), targetShaAfter: sha('d'), recordedBy: 'AGENT',
      idempotencyKey: `landed:${taskId}`,
    },
  });
}

async function jobsOf(stack: Stack, taskId: string): Promise<string[]> {
  return (await stack.db.projectIntegrationJob.findMany({ where: { taskId }, select: { kind: true } }))
    .map((job) => job.kind);
}

async function dispatched(stack: Stack, taskId: string): Promise<boolean> {
  return (await stack.db.session.count({ where: { taskId, startsTaskWork: true } })) > 0;
}

/** §2.5 J9 and §1.1 `isCodeTask`, in SQL, over one task's rows. */
async function predicates(stack: Stack, taskId: string) {
  const [row] = await stack.db.$queryRaw<Array<{ landed: boolean; code: boolean }>>(Prisma.sql`
    SELECT ${Prisma.raw(prerequisiteLandedSql('t'))} AS "landed",
           ${Prisma.raw(criterionLanding.isCodeTaskSql('t'))} AS "code"
      FROM "task" t WHERE t."id" = ${taskId}::uuid`);
  return { landed: row!.landed, code: row!.code };
}

/** The done check as `project_request_done` reads it, and the project's `derivedDone`. */
async function doneReading(stack: Stack, w: World) {
  const state = await stack.db.$transaction((tx) => readDoneState(tx, w.ownerId, w.projectId, null));
  const criterion = state.criteria.find((row) => row.stated.definitionId === w.criterionId)!;
  const unlanded = doneReadiness(state, []).filter((finding) => finding.code === 'DONE_CRITERION_UNLANDED');
  const derived = await readDerivedProjectDone(stack.db as unknown as PrismaService, w.ownerId, w.projectId);
  return { state, criterion, unlanded, derived };
}

// ═══ (1) a committing task in a project marked non-code ═════════════════════════════════════════

test('(1) a committing task in a project marked non-code lands as any other, and reads unlanded until it does',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'marked-commits', 'PROJECT_BRANCH', true);
      const a = await task(stack, w, 'commits-in-marked', { serves: true });
      await commits(stack, w, a, 'c');
      const b = await task(stack, w, 'after-the-commit', { dependsOn: a });

      await confirm(stack, w, a);

      assert.deepEqual(await jobsOf(stack, a), ['LAND_TASK'], 'its DONE queued a landing');
      assert.equal(await dispatched(stack, b), false, 'its dependent waits for the landing (J9)');
      assert.equal((await predicates(stack, a)).landed, false, 'J9 in SQL: not landed yet');

      const before = await doneReading(stack, w);
      assert.notEqual(before.criterion.landing, 'LANDED', 'the criterion waits for the commit to land');
      assert.notEqual(before.criterion.reason, null, 'and says why');
      assert.deepEqual(before.criterion.heldOffLanded, [{ taskId: a, title: 'commits-in-marked' }],
        'naming the committing task');
      // (4) of the acceptance: the marked project with an unlanded committing task is reported unlanded.
      assert.equal(before.unlanded.length, 1, 'the done check reports the criterion unlanded');
      assert.deepEqual(before.unlanded[0].tasks, [{ taskId: a, title: 'commits-in-marked' }]);
      assert.ok(before.derived.withheld.includes('CRITERION_UNLANDED'), 'derivedDone withholds it for landing');
      assert.notEqual(before.derived.criteria[0].landingReason, null);
      assert.equal(before.state.nonCode, false, 'the done check no longer reports the mark');
      assert.equal(before.derived.nonCode, false, 'nor does derivedDone');

      await landOnMain(stack, w, a, 'c');
      const after = await doneReading(stack, w);
      assert.equal(after.criterion.landing, 'LANDED', 'on main, the criterion is LANDED');
      assert.deepEqual(after.criterion.heldOffLanded, []);
      assert.deepEqual(after.unlanded, []);
      assert.ok(!after.derived.withheld.includes('CRITERION_UNLANDED'));
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) a codeless task with commits ═══════════════════════════════════════════════════════════

test('(2) a task flagged codeless that has commits lands like any other; one that made no branch has nothing to land',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'codeless-commits', 'PROJECT_BRANCH', false);
      const a = await task(stack, w, 'codeless-but-commits', { serves: true, codeless: true });
      await commits(stack, w, a, 'e');
      const b = await task(stack, w, 'after-codeless', { dependsOn: a });

      await confirm(stack, w, a);

      assert.deepEqual(await predicates(stack, a), { landed: false, code: true },
        'isCodeTask holds for it, and J9 waits for its landing');
      assert.deepEqual(await jobsOf(stack, a), ['LAND_TASK'], 'its DONE queued a landing');
      assert.equal(await dispatched(stack, b), false, 'its dependent waits for the landing');
      const frozen = await stack.db.task.findUniqueOrThrow({
        where: { id: a }, select: { deliveredSha: true, deliveredBaseSha: true },
      });
      assert.deepEqual(frozen, { deliveredSha: sha('e'), deliveredBaseSha: sha('0') },
        'its delivered identity is frozen like any code task\'s');

      const reading = await doneReading(stack, w);
      assert.notEqual(reading.criterion.landing, 'LANDED', 'its criterion waits for its commit');
      assert.deepEqual(reading.criterion.heldOffLanded, [{ taskId: a, title: 'codeless-but-commits' }]);

      // A codeless run that changed nothing never makes a branch: it still has nothing to land.
      const quiet = await task(stack, w, 'codeless-quiet', { codeless: true });
      await workSession(stack, w, quiet, { isolationStatus: 'worktree', branch: null });
      const afterQuiet = await task(stack, w, 'after-quiet', { dependsOn: quiet });
      await confirm(stack, w, quiet);
      assert.deepEqual(await jobsOf(stack, quiet), [], 'nothing was queued for it');
      assert.deepEqual(await predicates(stack, quiet), { landed: true, code: false });
      assert.equal(await dispatched(stack, afterQuiet), true, 'its dependent went on its DONE');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (3) an unmarked project with no committing task ════════════════════════════════════════════

test('(3) a project not marked non-code whose tasks delivered no commit passes the done check with nothing unlanded',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'unmarked-no-commit', 'NONE', false);
      // Work that ran in shared isolation — no branch — and reported nothing.
      const shared = await task(stack, w, 'filing', { serves: true });
      await workSession(stack, w, shared, { isolationStatus: 'shared', branch: null });
      // A task the owner confirmed with no work session at all.
      const offline = await task(stack, w, 'phone call', { serves: true });
      await confirm(stack, w, shared);
      await confirm(stack, w, offline);

      assert.equal(await stack.db.projectIntegrationJob.count({ where: { projectId: w.projectId } }), 0,
        'CONTROL: nothing was queued');
      assert.equal(await stack.db.projectCodebase.count({ where: { projectId: w.projectId } }), 0,
        'CONTROL: no line was started');

      const reading = await doneReading(stack, w);
      assert.equal(reading.criterion.landing, 'LANDED', 'no commit was delivered, so nothing had to land');
      assert.equal(reading.criterion.reason, null);
      assert.deepEqual(reading.criterion.heldOffLanded, []);
      assert.deepEqual(reading.unlanded, [], 'the done check reports nothing unlanded');
      assert.ok(!reading.derived.withheld.includes('CRITERION_UNLANDED'), 'derivedDone withholds nothing for landing');
      assert.equal(reading.derived.criteria[0].landing, 'LANDED');
      assert.equal(reading.derived.criteria[0].landingReason, 'NOTHING_TO_LAND');
    } finally {
      await stack.db.$disconnect();
    }
  });
