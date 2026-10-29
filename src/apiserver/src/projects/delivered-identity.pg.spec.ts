import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { PREREQUISITE_NOT_LANDED_MESSAGE, prerequisiteLandedSql } from '../tasks/task-dependencies';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { readCriterionLandingReasonFacts, readInFlightLandingJobs } from './criterion-landing-reason';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import * as criterionLanding from './project-criterion-landing';
import { criterionLandingWithReasons } from './project-done-derived';
import { canonicalRepoUrl, isCodeTask } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { TaskCheckpointService } from './task-checkpoint.service';

/**
 * The delivered identity (`docs/project-integration-line-contract.md` §10.4, §10.5 O-L4 and O-L7,
 * §10.6 O-T1): what a code task's DONE freezes, when, from where, and what clears it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/delivered-identity.pg.spec.ts
 *
 *  (1) O-L4 2: an ordinary task's DONE freezes the session its work ENDED on (`workBranchEndedOn`,
 *      the last to finish, not the newest) — its `branch_sha` and `base_sha`, on its
 *      `worktree_branch` when it moved off `branch`, else `branch` — with the session and the instant;
 *  (2) O-L4 1: a task under convergence management freezes the checkpoint `checkpointLandingGate`
 *      accepts — commit, base, branch and the session that recorded it — not the session's tip; one
 *      whose checkpoints the gate accepts none of freezes nothing;
 *  (3) O-L4 3: a DONE written while its work is still moving freezes nothing, and the finish that
 *      settles the work freezes it — the runner's finalize, and the end of a session that never ran
 *      — once, whatever finishes afterwards;
 *  (4) O-L4 / O-T1: an identity the settled work cannot name opens LANDING_UNOBSERVED
 *      (IDENTITY_UNKNOWN, `LU:<taskId>:identity`) in an AGENT_PUSH project — at the DONE and at the
 *      finish — and nothing at all in a PLATFORM project, whose `delivered_at` stays NULL;
 *  (5) O-L4: `task_reopen` clears the five columns, and the next DONE freezes them again from the
 *      work as it then stands; a revert out of DONE through the same door clears them too;
 *  (6) O-L7: a task whose work session ran in another repository than the project's binding is not
 *      this line's code task — J9 lets its dependent start, the SQL and TypeScript spellings agree,
 *      and its DONE freezes nothing — while the same repository spelled another way (SR36) is;
 *  (7) SR36: `canonicalRepoUrlSql` answers what `canonicalRepoUrl` answers, over one corpus;
 *  (8) O-L4 2: the tip a finalize reports — its finalize commit included — is what the deferred
 *      freeze reads, and an older runner's finalize, which reports none, leaves the last live tip;
 *  (9) O-L7 and J-T1a: a DONE task whose work is in another repository is given no route to the
 *      line — no LAND_TASK on a project branch, no candidate on a MAIN line, nothing frozen to observe;
 * (10) O-L7 at §1.4: such work leaves its criterion's landing conjunction as codeless work does —
 *      alone it reads LANDED with the codeless reason, beside an unlanded code task UNKNOWN, beside a
 *      landed one LANDED;
 * (11) O-L7: a repository nobody names is not another one — work whose session has no workspace, or
 *      a workspace with no `repo_url`, stays this line's code task: J9 waits on it, its DONE freezes
 *      and queues it, and it holds its criterion off LANDED.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const { isCodeTaskSql } = criterionLanding;
// Read through the module rather than named, so this file also compiles on a tree from before the SQL
// spelling existed and is red there for want of it.
const canonicalRepoUrlSql = (raw: string): string => {
  const spelled = (criterionLanding as { canonicalRepoUrlSql?: (raw: string) => string }).canonicalRepoUrlSql;
  assert.ok(spelled, 'there is no SQL spelling of SR36 (canonicalRepoUrlSql)');
  return spelled(raw);
};
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

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
  tasks: TasksService;
  sessions: SessionsService;
  confirmations: TaskOwnerConfirmationService;
  checkpoints: TaskCheckpointService;
  runnerApi: RunnerApiController;
}

/** The services the doors live in, over one client. Nothing reaches a device or a runner. */
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
  const runnerApi = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  return {
    db,
    tasks,
    sessions,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    checkpoints: new TaskCheckpointService(prisma, new ConvergenceLedgerService(prisma)),
    runnerApi,
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The binding's repository, canonical (SR36). */
  repository: string;
}

/**
 * One owner, one runner, the workspace the work runs in, a coordinator conversation that is live,
 * and a project whose line has started on `repository` — a MAIN line, or a branch of its own, with
 * the delivery mode asked for (AGENT_PUSH only on MAIN, as 0453's CHECK has it).
 */
async function world(
  stack: Stack,
  label: string,
  options: { line?: 'MAIN' | 'PROJECT_BRANCH'; deliveryMode?: 'PLATFORM' | 'AGENT_PUSH'; repoUrl?: string } = {},
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = options.repoUrl ?? `https://git.invalid/orbit/${label}.git`;
  const repository = canonicalRepoUrl(repoUrl)!;
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${ownerId}@delivered-identity.invalid`, name: label, passwordHash: 'x',
    },
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
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'the work is named by its commit',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const integrationRef = (options.line ?? 'PROJECT_BRANCH') === 'MAIN'
    ? 'refs/heads/main'
    : `refs/heads/project/${projectId.slice(0, 8)}`;
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: repository, upstreamRef: 'refs/heads/main', integrationRef,
      refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'EXPLICIT',
      integrationStartedAt: new Date(), deliveryMode: options.deliveryMode ?? 'PLATFORM',
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, repository };
}

/** A code task the owner confirms: OWNER_CONFIRMED, in progress, under the project. */
async function ownerTask(stack: Stack, w: World, title: string): Promise<string> {
  const task = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
    },
    select: { id: true },
  });
  return task.id;
}

interface WorkSession {
  /** Created this long ago — the order `isCodeTask` reads the newest by. */
  createdMinutesAgo: number;
  branch: string;
  worktreeBranch?: string | null;
  branchSha?: string | null;
  baseSha?: string | null;
  /** Finished this long ago; omitted, the session is live (AWAITING_INPUT, no finish). */
  finishedMinutesAgo?: number;
  /** The workspace it ran in: omitted, the world's; null, none at all. */
  workspaceId?: string | null;
}

/** A worktree session of the task's work, as the runner's reports left it. */
async function workSession(stack: Stack, w: World, taskId: string, s: WorkSession): Promise<string> {
  const id = randomUUID();
  const finished = s.finishedMinutesAgo !== undefined;
  await stack.db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, taskId,
      workspaceId: s.workspaceId === undefined ? w.workspaceId : s.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${s.branch}`, prompt: 'work', provider: 'claude',
      status: finished ? RunStatus.SUCCEEDED : RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
      branch: s.branch, worktreeBranch: s.worktreeBranch ?? null, branchSha: s.branchSha ?? null,
      baseSha: s.baseSha ?? null, numTurns: 1, startedAt: minutesAgo(s.createdMinutesAgo),
      createdAt: minutesAgo(s.createdMinutesAgo),
      ...(finished ? { finishedAt: minutesAgo(s.finishedMinutesAgo!) } : {}),
    },
  });
  return id;
}

/** The owner's Confirm done — the OWNER_CONFIRMED door's DONE write. */
async function confirm(stack: Stack, w: World, taskId: string): Promise<void> {
  const receipt = await stack.confirmations.decide(
    w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
}

interface Delivered {
  status: string;
  deliveredSha: string | null;
  deliveredBaseSha: string | null;
  deliveredBranch: string | null;
  deliveredSessionId: string | null;
  deliveredAt: Date | null;
}

function delivered(stack: Stack, taskId: string): Promise<Delivered> {
  return stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      status: true, deliveredSha: true, deliveredBaseSha: true, deliveredBranch: true,
      deliveredSessionId: true, deliveredAt: true,
    },
  });
}

/** The five columns, without the instant, which only has to be there. */
async function identityOf(stack: Stack, taskId: string) {
  const row = await delivered(stack, taskId);
  return {
    sha: row.deliveredSha,
    baseSha: row.deliveredBaseSha,
    branch: row.deliveredBranch,
    sessionId: row.deliveredSessionId,
    frozen: row.deliveredAt !== null,
  };
}

const NOTHING_FROZEN = { sha: null, baseSha: null, branch: null, sessionId: null, frozen: false };

function landingUnobserved(stack: Stack, taskId: string) {
  return stack.db.projectOpenItem.findMany({
    where: { taskId, kind: 'LANDING_UNOBSERVED' },
    select: { state: true, dedupeKey: true, payload: true, sessionId: true },
  });
}

/** The runner's own finalize of a live session: what writes its `finished_at`. `branchSha` is the
 *  tip a current runner reports after its finalize commit; an older runner sends none. */
async function finalize(stack: Stack, w: World, sessionId: string, branchSha?: string): Promise<void> {
  await stack.runnerApi.finalize({ id: w.runnerId } as never, sessionId, {
    status: RunStatus.SUCCEEDED, isolationStatus: 'worktree', ...(branchSha ? { branchSha } : {}),
  } as never);
  const row = await stack.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { finishedAt: true } });
  assert.ok(row.finishedAt, 'CONTROL: the finalize wrote the finish');
}

/** §1.1 `isCodeTask` in SQL and in TypeScript, and §2.5 J9's SQL spelling, over one task's rows. */
async function codeTaskReading(stack: Stack, w: World, taskId: string) {
  const [row] = await stack.db.$queryRaw<Array<{ isCode: boolean; landed: boolean }>>(Prisma.sql`
    SELECT ${Prisma.raw(isCodeTaskSql('t'))} AS "isCode", ${Prisma.raw(prerequisiteLandedSql('t'))} AS "landed"
      FROM "task" t WHERE t."id" = ${taskId}::uuid`);
  return { ...row!, isCodeTs: await isCodeTask(stack.db as never, w.ownerId, taskId) };
}

/** J9 as the start door reads it: what refuses a new dependent of the task, or null when it starts. */
async function dependentRefusal(stack: Stack, w: World, title: string, prerequisiteId: string): Promise<string | null> {
  const created = await stack.tasks.create(w.ownerId, {
    title, projectId: w.projectId, assigneeId: w.workspaceId, autoRunWhenReady: false,
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    dependsOnTaskIds: [prerequisiteId],
  } as never);
  try {
    await stack.tasks.execute(w.ownerId, created.id);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** The routes onto the line a task's DONE was given: landings queued, candidates filed. */
async function routesOf(stack: Stack, taskId: string) {
  return {
    landings: await stack.db.projectIntegrationJob.count({ where: { taskId } }),
    candidates: await stack.db.projectPromotion.count({ where: { taskId } }),
  };
}

/** One criterion the world's project states. */
async function criterionOf(stack: Stack, w: World, ordinal: number): Promise<string> {
  const id = randomUUID();
  await stack.db.projectAcceptanceCriterionDefinition.create({
    data: {
      id, projectId: w.projectId, ordinal, text: `criterion ${ordinal}`,
      verificationMethod: 'delivered-identity.pg.spec.ts reads its landing',
      // Written by the definition's own BEFORE trigger; the placeholder satisfies the CHECK.
      contentHash: '0'.repeat(64),
    },
  });
  return id;
}

/** A DONE task serving the criterion, its work one finished worktree session in `workspaceId`. */
async function servingTask(
  stack: Stack, w: World, title: string, criterionId: string, workspaceId: string | null,
): Promise<{ taskId: string; sessionId: string }> {
  const task = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, status: TaskStatus.DONE, completionCriterion: 'OWNER_CONFIRMED',
      criterionDefinitionId: criterionId, criterionRevision: 1,
    },
    select: { id: true },
  });
  const sessionId = await workSession(stack, w, task.id, {
    createdMinutesAgo: 20, branch: `orbit/${title}`, branchSha: sha('a'), baseSha: sha('b'),
    finishedMinutesAgo: 2, workspaceId,
  });
  return { taskId: task.id, sessionId };
}

/** Each criterion's landing and the reason beside it, as the project's own reads fold them. */
async function criterionLandings(stack: Stack, w: World) {
  const prisma = stack.db as unknown as PrismaService;
  const answers = criterionLandingWithReasons(
    await readCriterionLandingReasonFacts(prisma, w.ownerId, w.projectId),
    await criterionLanding.readLandingBranches(prisma, w.projectId),
    await readInFlightLandingJobs(prisma, w.projectId),
  );
  return (definitionId: string) => {
    const answer = answers.find((row) => row.definitionId === definitionId);
    return { landing: answer?.landing, reason: answer?.landingReason };
  };
}

/** The same criteria through the plain landing lane — the share link's and the coordinator's read. */
async function laneLandings(stack: Stack, w: World, definitionIds: string[]) {
  const lane = await criterionLanding.readCriterionLanding(stack.db as unknown as PrismaService, w.ownerId, w.projectId);
  return definitionIds.map((id) => lane.find((row) => row.definitionId === id)?.landing);
}

// ═══ (1) an ordinary task ════════════════════════════════════════════════════════════════════════

test('(1) O-L4 2: a DONE freezes the session the work ended on — branch_sha, base_sha, worktree_branch else branch — with the session and the instant',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'ended-on');
      const taskId = await ownerTask(stack, w, 'two-sessions');
      // The newer session finished first; the older one finished LAST and holds the work, on a
      // branch its agent checked out inside the worktree.
      const holder = await workSession(stack, w, taskId, {
        createdMinutesAgo: 60, branch: 'orbit/two-sessions-1', worktreeBranch: 'feature/the-work',
        branchSha: sha('a'), baseSha: sha('b'), finishedMinutesAgo: 5,
      });
      await workSession(stack, w, taskId, {
        createdMinutesAgo: 30, branch: 'orbit/two-sessions-2', branchSha: sha('c'), baseSha: sha('d'),
        finishedMinutesAgo: 20,
      });
      assert.deepEqual(await identityOf(stack, taskId), NOTHING_FROZEN, 'CONTROL: nothing frozen before DONE');

      const before = Date.now();
      await confirm(stack, w, taskId);
      const row = await delivered(stack, taskId);
      assert.equal(row.status, TaskStatus.DONE);
      assert.deepEqual(await identityOf(stack, taskId), {
        sha: sha('a'), baseSha: sha('b'), branch: 'feature/the-work', sessionId: holder, frozen: true,
      });
      assert.ok(row.deliveredAt!.getTime() >= before - 1_000, 'delivered_at is the DONE\'s instant');

      // On the branch it was started on when the checkout never moved.
      const plain = await ownerTask(stack, w, 'one-session');
      const only = await workSession(stack, w, plain, {
        createdMinutesAgo: 10, branch: 'orbit/one-session', branchSha: sha('e'), baseSha: sha('f'),
        finishedMinutesAgo: 2,
      });
      await confirm(stack, w, plain);
      assert.deepEqual(await identityOf(stack, plain), {
        sha: sha('e'), baseSha: sha('f'), branch: 'orbit/one-session', sessionId: only, frozen: true,
      });
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) a task under convergence management ═════════════════════════════════════════════════════

test('(2) O-L4 1: a task under convergence management freezes the checkpoint checkpointLandingGate accepts, and none when the gate accepts none',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'checkpoint');
      const record = (taskId: string, commit: string, evidence: boolean, sessionId: string) =>
        stack.checkpoints.record({
          ownerId: w.ownerId, taskId, scopeRevision: 1,
          commit: { branch: 'orbit/verified', commitSha: commit, treeSha: sha('9'), baseSha: sha('8') },
          evidence: evidence ? { suite: 'apiserver', treeSha: sha('9'), passed: 3, failed: 0, skipped: 0 } : null,
          artifact: evidence
            ? null
            : { kind: 'GIT_BUNDLE', ref: `bundle-${commit.slice(0, 6)}`, digest: createHash('sha256').update(commit).digest('hex') },
          recordedBy: 'WORKER',
          sessionId,
        });

      const managed = await ownerTask(stack, w, 'verified');
      const run = await workSession(stack, w, managed, {
        createdMinutesAgo: 30, branch: 'orbit/verified', branchSha: sha('7'), baseSha: sha('8'),
        finishedMinutesAgo: 3,
      });
      const accepted = await record(managed, sha('1'), true, run);
      assert.equal(typeof accepted === 'string' ? accepted : accepted.kind, 'ACCEPTED');
      // A red one recorded after it is not what the gate accepts.
      const red = await record(managed, sha('2'), false, run);
      assert.notEqual(typeof red === 'string' ? red : red.kind, 'ACCEPTED');
      await confirm(stack, w, managed);
      assert.deepEqual(await identityOf(stack, managed), {
        sha: sha('1'), baseSha: sha('8'), branch: 'orbit/verified', sessionId: run, frozen: true,
      }, 'the identity is the accepted checkpoint, not the session\'s tip');

      // Only a red checkpoint: the gate accepts nothing, so the identity is unknown, and a PLATFORM
      // project leaves it unfrozen even though the session reported a tip.
      const unverified = await ownerTask(stack, w, 'unverified');
      const redRun = await workSession(stack, w, unverified, {
        createdMinutesAgo: 30, branch: 'orbit/unverified', branchSha: sha('6'), baseSha: sha('8'),
        finishedMinutesAgo: 3,
      });
      await record(unverified, sha('3'), false, redRun);
      await confirm(stack, w, unverified);
      assert.deepEqual(await identityOf(stack, unverified), NOTHING_FROZEN);
      assert.deepEqual(await landingUnobserved(stack, unverified), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (3) work still moving ═══════════════════════════════════════════════════════════════════════

test('(3) O-L4 3: a DONE written while the work still moves freezes nothing, and the finish that settles it freezes it, once',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'moving');
      const taskId = await ownerTask(stack, w, 'still-running');
      await workSession(stack, w, taskId, {
        createdMinutesAgo: 60, branch: 'orbit/still-running-1', branchSha: sha('a'), baseSha: sha('b'),
        finishedMinutesAgo: 40,
      });
      const live = await workSession(stack, w, taskId, {
        createdMinutesAgo: 30, branch: 'orbit/still-running-2', branchSha: sha('c'), baseSha: sha('d'),
      });
      await confirm(stack, w, taskId);
      assert.equal((await delivered(stack, taskId)).status, TaskStatus.DONE);
      assert.deepEqual(await identityOf(stack, taskId), NOTHING_FROZEN,
        'a session of the task is live, so the commit its work ends on is not known yet');

      // The runner finishes the live session: the work has stopped moving, and it ended there.
      await finalize(stack, w, live);
      const frozen = await identityOf(stack, taskId);
      assert.deepEqual(frozen, {
        sha: sha('c'), baseSha: sha('d'), branch: 'orbit/still-running-2', sessionId: live, frozen: true,
      });
      const frozenAt = (await delivered(stack, taskId)).deliveredAt;

      // Finishing more work later does not move what the DONE delivered.
      const later = await workSession(stack, w, taskId, {
        createdMinutesAgo: 1, branch: 'orbit/still-running-3', branchSha: sha('e'), baseSha: sha('f'),
      });
      await finalize(stack, w, later);
      assert.deepEqual(await identityOf(stack, taskId), frozen);
      assert.equal((await delivered(stack, taskId)).deliveredAt?.getTime(), frozenAt?.getTime());

      // A session that never ran ends PENDING, and its end is the finish the DONE waited for. (It is
      // the older one: §1.1 reads the NEWEST work session, and a newest one that never ran is not code
      // work at all.)
      const queuedTask = await ownerTask(stack, w, 'queued-retry');
      const pending = randomUUID();
      await stack.db.session.create({
        data: {
          id: pending, ownerId: w.ownerId, creatorId: w.ownerId, taskId: queuedTask, workspaceId: w.workspaceId,
          assignedRunnerId: w.runnerId, title: 'still queued', prompt: 'queued', provider: 'claude',
          status: RunStatus.PENDING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
          createdAt: minutesAgo(50),
        },
      });
      const ran = await workSession(stack, w, queuedTask, {
        createdMinutesAgo: 30, branch: 'orbit/queued-retry-1', branchSha: sha('1'), baseSha: sha('2'),
        finishedMinutesAgo: 20,
      });
      await confirm(stack, w, queuedTask);
      assert.deepEqual(await identityOf(stack, queuedTask), NOTHING_FROZEN, 'CONTROL: the queued session holds it');
      await stack.sessions.end(w.ownerId, pending);
      assert.deepEqual(await identityOf(stack, queuedTask), {
        sha: sha('1'), baseSha: sha('2'), branch: 'orbit/queued-retry-1', sessionId: ran, frozen: true,
      });
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (4) an identity nobody can name ═════════════════════════════════════════════════════════════

test('(4) O-T1: an unknown identity opens LANDING_UNOBSERVED (IDENTITY_UNKNOWN) in an AGENT_PUSH project, at the DONE and at the finish, and nothing in a PLATFORM one',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const pushed = await world(stack, 'agent-push', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      const untold = await ownerTask(stack, pushed, 'no-tip');
      const session = await workSession(stack, pushed, untold, {
        createdMinutesAgo: 20, branch: 'orbit/no-tip', branchSha: null, baseSha: sha('b'), finishedMinutesAgo: 2,
      });
      await confirm(stack, pushed, untold);
      assert.deepEqual(await identityOf(stack, untold), NOTHING_FROZEN);
      const items = await landingUnobserved(stack, untold);
      assert.equal(items.length, 1, `one LANDING_UNOBSERVED, got ${JSON.stringify(items)}`);
      assert.equal(items[0]!.state, 'OPEN');
      assert.equal(items[0]!.dedupeKey, `LU:${untold}:identity`);
      assert.equal(items[0]!.sessionId, session);
      const payload = items[0]!.payload as Record<string, unknown>;
      assert.equal(payload.reason, 'IDENTITY_UNKNOWN');
      assert.equal(payload.deliveredSha, null);
      assert.equal(payload.branch, 'orbit/no-tip');
      assert.equal(payload.baseSha, sha('b'));

      // Found at the finish instead: the DONE waited, and the finish opens it.
      const waited = await ownerTask(stack, pushed, 'no-tip-yet');
      const live = await workSession(stack, pushed, waited, {
        createdMinutesAgo: 20, branch: 'orbit/no-tip-yet', branchSha: null, baseSha: sha('b'),
      });
      await confirm(stack, pushed, waited);
      assert.deepEqual(await landingUnobserved(stack, waited), [], 'CONTROL: nothing is known while the work moves');
      await finalize(stack, pushed, live);
      const atFinish = await landingUnobserved(stack, waited);
      assert.deepEqual(atFinish.map((item) => [item.state, item.dedupeKey, (item.payload as { reason: string }).reason]),
        [['OPEN', `LU:${waited}:identity`, 'IDENTITY_UNKNOWN']]);
      assert.deepEqual(await identityOf(stack, waited), NOTHING_FROZEN);

      // The same shapes in a PLATFORM project: delivered_at stays NULL, and nobody is handed an item.
      const platform = await world(stack, 'platform', { line: 'MAIN', deliveryMode: 'PLATFORM' });
      const quiet = await ownerTask(stack, platform, 'no-tip');
      await workSession(stack, platform, quiet, {
        createdMinutesAgo: 20, branch: 'orbit/no-tip', branchSha: null, baseSha: sha('b'), finishedMinutesAgo: 2,
      });
      await confirm(stack, platform, quiet);
      assert.deepEqual(await identityOf(stack, quiet), NOTHING_FROZEN);
      assert.deepEqual(await landingUnobserved(stack, quiet), []);
      const quietLater = await ownerTask(stack, platform, 'no-tip-yet');
      const quietLive = await workSession(stack, platform, quietLater, {
        createdMinutesAgo: 20, branch: 'orbit/no-tip-yet', branchSha: null, baseSha: sha('b'),
      });
      await confirm(stack, platform, quietLater);
      await finalize(stack, platform, quietLive);
      assert.deepEqual(await identityOf(stack, quietLater), NOTHING_FROZEN);
      assert.deepEqual(await landingUnobserved(stack, quietLater), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (5) task_reopen ═════════════════════════════════════════════════════════════════════════════

test('(5) O-L4: task_reopen clears the five columns and the next DONE freezes them again; a revert out of DONE clears them too',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'reopen');
      const taskId = await ownerTask(stack, w, 'reworked');
      const first = await workSession(stack, w, taskId, {
        createdMinutesAgo: 60, branch: 'orbit/reworked-1', branchSha: sha('a'), baseSha: sha('b'),
        finishedMinutesAgo: 50,
      });
      await confirm(stack, w, taskId);
      assert.deepEqual(await identityOf(stack, taskId), {
        sha: sha('a'), baseSha: sha('b'), branch: 'orbit/reworked-1', sessionId: first, frozen: true,
      });

      // `task_reopen`'s own body (src/runner-go/task_reopen.go).
      await stack.tasks.update(w.ownerId, taskId, {
        status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null,
      } as never);
      assert.equal((await delivered(stack, taskId)).status, TaskStatus.OPEN);
      assert.deepEqual(await identityOf(stack, taskId), NOTHING_FROZEN, 'task_reopen left the identity standing');

      // The rework: a new session ends on a new commit, and the next DONE names it.
      const second = await workSession(stack, w, taskId, {
        createdMinutesAgo: 10, branch: 'orbit/reworked-2', branchSha: sha('c'), baseSha: sha('a'),
        finishedMinutesAgo: 1,
      });
      await confirm(stack, w, taskId);
      assert.deepEqual(await identityOf(stack, taskId), {
        sha: sha('c'), baseSha: sha('a'), branch: 'orbit/reworked-2', sessionId: second, frozen: true,
      });

      // Out of DONE by an ordinary status write: a task that is not DONE has delivered nothing.
      await stack.tasks.update(w.ownerId, taskId, { status: TaskStatus.IN_PROGRESS } as never);
      assert.deepEqual(await identityOf(stack, taskId), NOTHING_FROZEN);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (6) another repository ══════════════════════════════════════════════════════════════════════

test('(6) O-L7: work in another repository is not this line\'s code task — J9 exempts it, both spellings agree, and its DONE freezes nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // The binding is `ssh://git.invalid/orbit/repository`.
      const w = await world(stack, 'repository', {
        line: 'MAIN', deliveryMode: 'AGENT_PUSH', repoUrl: 'ssh://git.invalid/orbit/repository',
      });
      const elsewhere = randomUUID();
      await stack.db.workspace.create({
        data: {
          id: elsewhere, ownerId: w.ownerId, runnerId: w.runnerId, name: 'another-repository', enabled: true,
          repoUrl: 'https://git.invalid/orbit/a-different-repository.git', workDir: '/srv/elsewhere',
        },
      });
      const sameRepository = randomUUID();
      await stack.db.workspace.create({
        data: {
          // The binding's repository spelled the way a clone over ssh spells it (SR36).
          id: sameRepository, ownerId: w.ownerId, runnerId: w.runnerId, name: 'same-repository-over-ssh',
          enabled: true, repoUrl: '  git@GIT.invalid:orbit/repository.git/ ', workDir: '/srv/same',
        },
      });

      const prerequisite = async (title: string, workspaceId: string) => {
        const taskId = await ownerTask(stack, w, title);
        await workSession(stack, w, taskId, {
          createdMinutesAgo: 20, branch: `orbit/${title}`, branchSha: sha('a'), baseSha: sha('b'),
          finishedMinutesAgo: 2, workspaceId,
        });
        await confirm(stack, w, taskId);
        return taskId;
      };
      const foreign = await prerequisite('in-another-repository', elsewhere);
      const ours = await prerequisite('in-this-repository', sameRepository);

      assert.deepEqual(await codeTaskReading(stack, w, foreign), { isCode: false, landed: true, isCodeTs: false },
        'work outside the binding\'s repository is not this line\'s code task');
      assert.deepEqual(await identityOf(stack, foreign), NOTHING_FROZEN, 'its DONE froze an identity');
      assert.deepEqual(await landingUnobserved(stack, foreign), [], 'it was handed an item about this line');
      assert.deepEqual(await codeTaskReading(stack, w, ours), { isCode: true, landed: false, isCodeTs: true },
        'CONTROL: the same repository spelled another way is this line\'s code task');
      assert.equal((await identityOf(stack, ours)).frozen, true, 'CONTROL: and its DONE froze the identity');

      // J9 as the start door reads it: the dependent of the foreign task starts, and the control's waits.
      assert.notEqual(await dependentRefusal(stack, w, 'after-the-foreign-work', foreign), PREREQUISITE_NOT_LANDED_MESSAGE,
        'J9 held a dependent on work that cannot land on this line');
      assert.equal(await dependentRefusal(stack, w, 'after-our-work', ours), PREREQUISITE_NOT_LANDED_MESSAGE,
        'CONTROL: J9 holds the dependent of this line\'s code task until its work lands');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (7) SR36 twice ══════════════════════════════════════════════════════════════════════════════

test('(7) SR36: canonicalRepoUrlSql answers what canonicalRepoUrl answers', { skip, timeout: 60_000 }, async () => {
  await verifyDisposableDatabase();
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  try {
    const corpus = [
      'https://github.com/acme/payments-api.git',
      'HTTPS://GitHub.com/Acme/Payments-API.git/',
      'git@github.com:acme/payments-api.git',
      'git@github.com:acme/payments-api.git/',
      'Git@GitHub.com:Acme/Repo.GIT',
      'github.com:acme/repo',
      'ssh://git@github.com/acme/payments-api',
      'ssh://git@GitHub.com:22/acme/payments-api.git',
      '  https://user:token@gitlab.example.com/group/sub/repo.git  ',
      '\thttps://example.com/a.git.git\n',
      'git@host:/abs/path.git',
      'file:///srv/git/repo.git/',
      '/srv/git/repo.git',
      'repo.git/.git/',
      'HTTP://EXAMPLE.COM',
      '',
      '   ',
      '/',
      '.git',
    ];
    for (const raw of corpus) {
      const { rows } = await client.query(`SELECT ${canonicalRepoUrlSql('$1::text')} AS "url"`, [raw]);
      assert.equal(rows[0].url, canonicalRepoUrl(raw), `SR36 disagrees on ${JSON.stringify(raw)}`);
    }
    const { rows } = await client.query(`SELECT ${canonicalRepoUrlSql('NULL::text')} AS "url"`);
    assert.equal(rows[0].url, null, 'no URL is no repository');
  } finally {
    await client.end();
  }
});

// ═══ (8) the finalize's own tip ══════════════════════════════════════════════════════════════════

test('(8) O-L4 2: the tip a finalize reports, its finalize commit included, is what the deferred freeze reads; an older runner\'s finalize leaves the last live tip',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'final-tip');
      // The last live report said `a`; the finalize then committed what the session had left, and
      // the branch ends on `b`.
      const taskId = await ownerTask(stack, w, 'leftovers');
      const live = await workSession(stack, w, taskId, {
        createdMinutesAgo: 30, branch: 'orbit/leftovers', branchSha: sha('a'), baseSha: sha('0'),
      });
      await confirm(stack, w, taskId);
      assert.deepEqual(await identityOf(stack, taskId), NOTHING_FROZEN, 'CONTROL: the session is live');
      await finalize(stack, w, live, sha('b'));
      assert.deepEqual(await identityOf(stack, taskId), {
        sha: sha('b'), baseSha: sha('0'), branch: 'orbit/leftovers', sessionId: live, frozen: true,
      }, 'the freeze missed the finalize commit');
      const session = await stack.db.session.findUniqueOrThrow({ where: { id: live }, select: { branchSha: true } });
      assert.equal(session.branchSha, sha('b'), 'the finalize did not write the session\'s tip');

      // A runner too old to report the tip: the tip of its last live report stands.
      const older = await ownerTask(stack, w, 'older-runner');
      const oldSession = await workSession(stack, w, older, {
        createdMinutesAgo: 30, branch: 'orbit/older-runner', branchSha: sha('c'), baseSha: sha('0'),
      });
      await confirm(stack, w, older);
      await finalize(stack, w, oldSession);
      assert.deepEqual(await identityOf(stack, older), {
        sha: sha('c'), baseSha: sha('0'), branch: 'orbit/older-runner', sessionId: oldSession, frozen: true,
      });
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (9) no route for work in another repository ═════════════════════════════════════════════════

test('(9) O-L7, J-T1a: a DONE task whose work is in another repository is given no route — no LAND_TASK, no candidate, nothing frozen to observe',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      for (const [label, line] of [['route-branch', 'PROJECT_BRANCH'], ['route-main', 'MAIN']] as const) {
        const w = await world(stack, label, { line });
        const elsewhere = randomUUID();
        await stack.db.workspace.create({
          data: {
            id: elsewhere, ownerId: w.ownerId, runnerId: w.runnerId, name: `${label}-elsewhere`, enabled: true,
            repoUrl: 'https://git.invalid/orbit/a-different-repository.git', workDir: `/srv/${label}-elsewhere`,
          },
        });
        const done = async (title: string, workspaceId: string) => {
          const taskId = await ownerTask(stack, w, title);
          await workSession(stack, w, taskId, {
            createdMinutesAgo: 20, branch: `orbit/${title}`, branchSha: sha('a'), baseSha: sha('b'),
            finishedMinutesAgo: 2, workspaceId,
          });
          await confirm(stack, w, taskId);
          return taskId;
        };
        const foreign = await done(`${label}-foreign`, elsewhere);
        const ours = await done(`${label}-ours`, w.workspaceId);

        assert.deepEqual(await routesOf(stack, foreign), { landings: 0, candidates: 0 },
          `${line}: work in another repository was given a route to this line`);
        assert.equal((await identityOf(stack, foreign)).frozen, false, `${line}: an identity was frozen to observe`);
        assert.deepEqual(await routesOf(stack, ours), line === 'PROJECT_BRANCH'
          ? { landings: 1, candidates: 0 }
          : { landings: 0, candidates: 1 },
        `CONTROL ${line}: this line's own work is routed as before`);
      }
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (10) the criterion fold ═════════════════════════════════════════════════════════════════════

test('(10) O-L7 at §1.4: work in another repository leaves its criterion\'s conjunction as codeless work does — alone LANDED with the codeless reason, beside an unlanded code task UNKNOWN, beside a landed one LANDED',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'criteria');
      const elsewhere = randomUUID();
      await stack.db.workspace.create({
        data: {
          id: elsewhere, ownerId: w.ownerId, runnerId: w.runnerId, name: 'criteria-elsewhere', enabled: true,
          repoUrl: 'https://git.invalid/orbit/a-different-repository.git', workDir: '/srv/criteria-elsewhere',
        },
      });
      const alone = await criterionOf(stack, w, 1);
      await servingTask(stack, w, 'alone-elsewhere', alone, elsewhere);

      const waiting = await criterionOf(stack, w, 2);
      await servingTask(stack, w, 'waiting-elsewhere', waiting, elsewhere);
      await servingTask(stack, w, 'waiting-ours', waiting, w.workspaceId);

      const landed = await criterionOf(stack, w, 3);
      await servingTask(stack, w, 'landed-elsewhere', landed, elsewhere);
      const ours = await servingTask(stack, w, 'landed-ours', landed, w.workspaceId);
      await stack.db.sessionMergeReceipt.create({
        data: {
          ownerId: w.ownerId, sessionId: ours.sessionId, taskId: ours.taskId, projectId: w.projectId,
          result: 'MERGED', sourceBranch: 'orbit/landed-ours', sourceSha: sha('a'), targetBranch: 'main',
          targetShaBefore: sha('b'), targetShaAfter: sha('c'), recordedBy: 'AGENT',
          idempotencyKey: `landed:${ours.taskId}`,
        },
      });

      const read = await criterionLandings(stack, w);
      assert.deepEqual(read(alone), { landing: 'LANDED', reason: 'CODELESS' },
        'a criterion served only by work in another repository waits on it, or reads another reason');
      assert.deepEqual(read(waiting), { landing: 'UNKNOWN', reason: 'NO_RECEIPT' },
        'the unlanded code task beside it no longer holds the criterion');
      assert.deepEqual(read(landed), { landing: 'LANDED', reason: null },
        'work in another repository withholds LANDED from a criterion whose own work is on main');
      // The plain landing lane — the share link's and the coordinator's reads — answers the same.
      assert.deepEqual(await laneLandings(stack, w, [alone, waiting, landed]), ['LANDED', 'UNKNOWN', 'LANDED']);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (11) a repository nobody names ══════════════════════════════════════════════════════════════

test('(11) O-L7: a repository nobody names is not another one — work with no workspace, or in a workspace with no repo_url, stays this line\'s code task: J9 waits on it, its DONE freezes and routes it, and it holds its criterion off LANDED',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'unnamed');
      const unnamed = randomUUID();
      await stack.db.workspace.create({
        data: {
          id: unnamed, ownerId: w.ownerId, runnerId: w.runnerId, name: 'no-repository', enabled: true,
          repoUrl: null, workDir: '/srv/unnamed',
        },
      });
      const spellings = [['in-a-workspace-with-no-repo-url', unnamed], ['in-no-workspace', null]] as const;

      for (const [title, workspaceId] of spellings) {
        const taskId = await ownerTask(stack, w, title);
        await workSession(stack, w, taskId, {
          createdMinutesAgo: 20, branch: `orbit/${title}`, branchSha: sha('a'), baseSha: sha('b'),
          finishedMinutesAgo: 2, workspaceId,
        });
        await confirm(stack, w, taskId);
        assert.deepEqual(await codeTaskReading(stack, w, taskId), { isCode: true, landed: false, isCodeTs: true },
          `${title}: a repository nobody names was read as another one`);
        assert.equal((await identityOf(stack, taskId)).frozen, true, `${title}: its DONE froze no identity`);
        assert.deepEqual(await routesOf(stack, taskId), { landings: 1, candidates: 0 },
          `${title}: its DONE queued no landing`);
        assert.equal(await dependentRefusal(stack, w, `after-${title}`, taskId), PREREQUISITE_NOT_LANDED_MESSAGE,
          `${title}: J9 let a dependent start before the work landed`);
      }

      // §1.4: a criterion served by such work alone waits on it, as on any code task's.
      const criteria: string[] = [];
      for (const [title, workspaceId] of spellings) {
        const criterionId = await criterionOf(stack, w, criteria.length + 1);
        await servingTask(stack, w, `serving-${title}`, criterionId, workspaceId);
        criteria.push(criterionId);
      }
      const read = await criterionLandings(stack, w);
      for (const criterionId of criteria) {
        assert.deepEqual(read(criterionId), { landing: 'UNKNOWN', reason: 'NO_RECEIPT' },
          'a criterion read LANDED over work nobody can place in another repository');
      }
      assert.deepEqual(await laneLandings(stack, w, criteria), ['UNKNOWN', 'UNKNOWN']);
    } finally {
      await stack.db.$disconnect();
    }
  });
