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
import { ReaperService } from '../realtime/reaper.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { prerequisiteLandedSql } from '../tasks/task-dependencies';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import { readCriterionLandingReasonFacts, readInFlightLandingJobs } from './criterion-landing-reason';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import * as criterionLanding from './project-criterion-landing';
import { criterionLandingWithReasons } from './project-done-derived';
import { readDoneState } from './project-done-request';
import { readInFlightJobs } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { readTaskIntegrationViews } from './project-task-integration';
import { turnStateOfWord } from '../sessions/session-turn-state';

/**
 * §12.15 P-M1 (`docs/project-integration-line-contract.md`, revision 42): a DONE task with no commit
 * of its own on its branch — `delivered_sha = delivered_base_sha` once the identity is frozen (§10.5
 * O-L4) — queues no landing, and its dependents go on its DONE.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/no-commit-no-landing.pg.spec.ts
 *
 *  (1) a zero-commit DONE writes no project_integration_job, no candidate and no project_codebase row,
 *      starts no line, and its dependent is dispatched on that DONE; J9's SQL and TypeScript, and
 *      the P-M1 fact's two spellings, agree;
 *  (2) a three-layer graph of zero-commit tasks runs to its end from DONE edges, with no job at all;
 *  (3) in that graph, one committing task is the only one queued, the line starts then, the
 *      zero-commit task before it is not back-filled, and the task after it waits for its landing;
 *  (4) an empty branch beside a session that reported work opens LANDING_UNOBSERVED (WORK_ELSEWHERE),
 *      queues nothing, and its dependent waits;
 *  (5) a session that never reported a branch_sha nor a diff still queues — the runner's J-S2 answers it;
 *  (6) a DONE whose work still moves queues nothing and starts no line; the runner's finalize freezes
 *      an empty branch and queues nothing either, and the 60 s ready sweep — the backstop of the
 *      post-commit edge — releases the dependent (coordinator's condition 1);
 *  (7) the first committing task, DONE while its work moved: its dependent waits for its landing, not
 *      for its DONE, and the finish starts the line (condition 2);
 *  (8) on a started line, between a moving DONE and its finish the task row reads QUEUED with no
 *      landing attempt and nothing is in flight; after an empty finish it reads NOT_APPLICABLE
 *      (condition 3, the coordinator's ruling on the row);
 *  (9) the reaper's forced finish runs the same route: an empty branch queues nothing, a committing
 *      one queues and starts the line (condition 5);
 * (10) the fold: a criterion served only by zero-commit tasks reads LANDED (NOTHING_TO_LAND) in both
 *      lanes, and the done check reports nothing unlanded and nothing in flight for it.
 *
 * The regression of 2026-11-20 (P-M1 read a non-empty `changed_files` as work elsewhere, and the runner
 * reports it as the diff from the base to wherever HEAD is):
 * (11) a run that checked out the project line detached and committed nothing — production's V2 row —
 *      queues no job and opens no item, reads nothing to land in every spelling, releases its dependent
 *      and leaves its criterion LANDED;
 * (12) a delivered session that moved past its frozen empty identity afterwards — production's 01a1862d —
 *      reads as work not delivered: the freeze copied an empty tip, and the session went on;
 * (13) a session that ended with changes no commit carries (a failed finalize capture) is work of its
 *      own: WORK_ELSEWHERE, no job, the dependent waits;
 * (14) an identity nobody can name (the last session finished before the runner reported a tip) whose
 *      every work session reported an EMPTY diff reads nothing to land — production's T3 — while a NULL
 *      list, a non-empty one, an unfinished session or a MERGED receipt keep it unknown;
 * (15) the freeze copies the tip and base of the session the work ended on, so an empty identity never
 *      comes from a session whose own branch had moved past its base when it was frozen.
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
  tasks: TasksService;
  confirmations: TaskOwnerConfirmationService;
  runnerApi: RunnerApiController;
  reaper: ReaperService;
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
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    runnerApi,
    reaper: new ReaperService(prisma, realtime, openItems),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/**
 * One owner, one online runner, the workspace the work runs in (with a repository, so a first
 * landing can bind it), a live coordinator conversation, and a started project. `line: 'NONE'` is a
 * project that has no codebase row at all — P-M2's project before its first commit; otherwise its line
 * has started on a branch of its own.
 */
async function world(stack: Stack, label: string, line: 'NONE' | 'PROJECT_BRANCH'): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@no-commit.invalid`, name: label, passwordHash: 'x' },
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
      id: projectId, ownerId, title: `${label} project`, goal: 'nothing lands that has no commit',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
      startedAt: new Date(),
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
  return { ownerId, runnerId, workspaceId, projectId };
}

/** A code task the owner confirms, under the project: IN_PROGRESS, or OPEN and auto-run for a dependent. */
async function task(
  stack: Stack, w: World, title: string,
  options: { dependsOn?: string; criterionId?: string } = {},
): Promise<string> {
  const row = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, completionCriterion: 'OWNER_CONFIRMED',
      status: options.dependsOn ? TaskStatus.OPEN : TaskStatus.IN_PROGRESS,
      autoRunWhenReady: true,
      ...(options.criterionId ? { criterionDefinitionId: options.criterionId, criterionRevision: 1 } : {}),
    },
    select: { id: true },
  });
  if (options.dependsOn) {
    await stack.db.taskDependency.create({ data: { taskId: row.id, dependsOnTaskId: options.dependsOn } });
  }
  return row.id;
}

interface Work {
  branch: string;
  /** The tip the runner reported; null for a session that never reported one (an older runner). */
  branchSha: string | null;
  baseSha: string | null;
  /** What its worktree reported as changed against its base; omitted, `[]`; null, never reported. */
  changedFiles?: unknown[] | null;
  /** Whether finishing left the checkout holding changes no commit carries; omitted, not reported. */
  worktreeDirty?: boolean;
  /** Omitted, the session is live (AWAITING_INPUT, no finish). */
  finishedMinutesAgo?: number;
  createdMinutesAgo?: number;
}

/** A worktree session of the task's work, as the runner's reports left it. */
async function workSession(stack: Stack, w: World, taskId: string, s: Work): Promise<string> {
  const id = randomUUID();
  const finished = s.finishedMinutesAgo !== undefined;
  await stack.db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${s.branch}`, prompt: 'work', provider: 'claude',
      turnState: turnStateOfWord(finished ? RunStatus.SUCCEEDED : RunStatus.AWAITING_INPUT),
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
      branch: s.branch, branchSha: s.branchSha, baseSha: s.baseSha,
      changedFiles: s.changedFiles === null ? Prisma.DbNull : (s.changedFiles ?? []) as Prisma.InputJsonValue,
      ...(s.worktreeDirty !== undefined ? { worktreeDirty: s.worktreeDirty } : {}),
      numTurns: 1, startedAt: minutesAgo(s.createdMinutesAgo ?? 30), createdAt: minutesAgo(s.createdMinutesAgo ?? 30),
      ...(finished ? { finishedAt: minutesAgo(s.finishedMinutesAgo!)} : {}),
    },
  });
  return id;
}

/**
 * The session the dependency dispatch started for a task, made to look as the runner leaves a
 * finished one: on a worktree branch with the tip and base given, its finish written.
 */
async function finishDispatchedWork(stack: Stack, taskId: string, s: Omit<Work, 'branch'>): Promise<void> {
  const session = await stack.db.session.findFirst({
    where: { taskId, startsTaskWork: true }, orderBy: { createdAt: 'desc' }, select: { id: true },
  });
  assert.ok(session, 'CONTROL: the dependency dispatch started a work session for the task');
  await stack.db.session.update({
    where: { id: session.id },
    data: {
      turnState: null, isolationStatus: 'worktree', branch: `orbit/${taskId.slice(0, 8)}`,
      branchSha: s.branchSha, baseSha: s.baseSha,
      changedFiles: s.changedFiles === null ? Prisma.DbNull : (s.changedFiles ?? []) as Prisma.InputJsonValue,
      finishedAt: new Date(),
    },
  });
  await stack.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.IN_PROGRESS } });
}

/** The owner's Confirm done — the OWNER_CONFIRMED door's DONE write, and the DONE edge after it. */
async function confirm(stack: Stack, w: World, taskId: string): Promise<void> {
  const receipt = await stack.confirmations.decide(
    w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
}

/** The runner's own finalize of a live session, reporting the tip after its finalize commit. */
async function finalize(stack: Stack, w: World, sessionId: string, branchSha: string, changedFiles?: unknown[]) {
  await stack.runnerApi.finalize({ id: w.runnerId } as never, sessionId, {
    status: RunStatus.SUCCEEDED, isolationStatus: 'worktree', branchSha,
    ...(changedFiles ? { changedFiles } : {}),
  } as never);
  const row = await stack.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { finishedAt: true } });
  assert.ok(row.finishedAt, 'CONTROL: the finalize wrote the finish');
}

/** Whether the dependency dispatch has started the task: a work session exists for it. */
async function dispatched(stack: Stack, taskId: string): Promise<boolean> {
  return (await stack.db.session.count({ where: { taskId, startsTaskWork: true } })) > 0;
}

/** Everything a route to a line writes: landings and observations, candidates, and the binding. */
async function routes(stack: Stack, w: World) {
  return {
    jobs: await stack.db.projectIntegrationJob.count({ where: { projectId: w.projectId } }),
    candidates: await stack.db.projectPromotion.count({ where: { projectId: w.projectId } }),
    codebases: await stack.db.projectCodebase.count({ where: { projectId: w.projectId } }),
  };
}
const NO_ROUTE = { jobs: 0, candidates: 0, codebases: 0 };

/** The jobs of one task, by kind. */
async function jobsOf(stack: Stack, taskId: string): Promise<string[]> {
  return (await stack.db.projectIntegrationJob.findMany({ where: { taskId }, select: { kind: true } }))
    .map((job) => job.kind);
}

/** The route a task's DONE was given: a landing on the project's own line, a candidate for main, or none. */
async function routeOf(stack: Stack, taskId: string): Promise<'LAND_TASK' | 'PROMOTION' | null> {
  if ((await jobsOf(stack, taskId)).includes('LAND_TASK')) return 'LAND_TASK';
  return (await stack.db.projectPromotion.count({ where: { taskId } })) > 0 ? 'PROMOTION' : null;
}

/** §2.5 J9 in SQL, and §12.15 P-M1's fact in SQL and in TypeScript, over one task's rows. */
async function readings(stack: Stack, taskId: string) {
  const [row] = await stack.db.$queryRaw<Array<{ landed: boolean; nothing: boolean }>>(Prisma.sql`
    SELECT ${Prisma.raw(prerequisiteLandedSql('t'))} AS "landed",
           ${Prisma.raw(criterionLanding.deliveredNothingOfItsOwnSql('t'))} AS "nothing"
      FROM "task" t WHERE t."id" = ${taskId}::uuid`);
  const facts = await stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      status: true, deliveredSha: true, deliveredBaseSha: true,
      sessions: criterionLanding.WORK_SESSIONS_NEWEST_FIRST,
      mergeReceipts: { select: { result: true } },
    },
  });
  return { landed: row!.landed, nothing: row!.nothing, nothingTs: criterionLanding.deliveredNothingOfItsOwn(facts) };
}

/** The dependency state the task's own read gives — the TypeScript spelling of J9. */
async function dependencyState(stack: Stack, w: World, taskId: string): Promise<string> {
  const read = await stack.tasks.get(w.ownerId, taskId) as unknown as { dependencyState: string };
  return read.dependencyState;
}

/** The 60 s ready sweep, called as its timer calls it. */
function readySweep(stack: Stack): Promise<void> {
  return (stack.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();
}

// ═══ (1) one zero-commit DONE ═══════════════════════════════════════════════════════════════════

test('(1) a zero-commit DONE writes no job, no candidate and no codebase row, and its dependent goes on that DONE',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'one-empty', 'NONE');
      const a = await task(stack, w, 'empty-a');
      await workSession(stack, w, a, { branch: 'orbit/empty-a', branchSha: sha('a'), baseSha: sha('a'), finishedMinutesAgo: 1 });
      const b = await task(stack, w, 'after-a', { dependsOn: a });

      await confirm(stack, w, a);

      const frozen = await stack.db.task.findUniqueOrThrow({
        where: { id: a }, select: { deliveredSha: true, deliveredBaseSha: true, deliveredAt: true },
      });
      assert.ok(frozen.deliveredAt, 'CONTROL: the DONE froze the identity');
      assert.equal(frozen.deliveredSha, frozen.deliveredBaseSha, 'CONTROL: no commit past the base');
      assert.deepEqual(await routes(stack, w), NO_ROUTE,
        'a DONE with no commit of its own starts no line and queues nothing (§12.15 P-M1)');
      assert.deepEqual(await readings(stack, a), { landed: true, nothing: true, nothingTs: true },
        'J9 and the P-M1 fact, SQL and TypeScript, read it as nothing to land');
      assert.equal(await dispatched(stack, b), true, 'its dependent was dispatched on the DONE edge (J10)');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) and (3) a three-layer graph ════════════════════════════════════════════════════════════

test('(2) a three-layer graph of zero-commit tasks runs to its end from DONE edges, with no job anywhere',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'graph-empty', 'NONE');
      const a = await task(stack, w, 'layer-1');
      await workSession(stack, w, a, { branch: 'orbit/layer-1', branchSha: sha('1'), baseSha: sha('1'), finishedMinutesAgo: 1 });
      const b = await task(stack, w, 'layer-2', { dependsOn: a });
      const c = await task(stack, w, 'layer-3', { dependsOn: b });

      await confirm(stack, w, a);
      assert.equal(await dispatched(stack, b), true, 'layer 2 went on layer 1\'s DONE');
      assert.equal(await dispatched(stack, c), false, 'CONTROL: layer 3 waits for layer 2');
      await finishDispatchedWork(stack, b, { branchSha: sha('2'), baseSha: sha('2') });
      await confirm(stack, w, b);
      assert.equal(await dispatched(stack, c), true, 'layer 3 went on layer 2\'s DONE');
      await finishDispatchedWork(stack, c, { branchSha: sha('3'), baseSha: sha('3') });
      await confirm(stack, w, c);

      const done = await stack.db.task.count({ where: { id: { in: [a, b, c] }, status: TaskStatus.DONE } });
      assert.equal(done, 3, 'the graph ran to its end');
      assert.deepEqual(await routes(stack, w), NO_ROUTE, 'with no job to claim, no candidate and no line');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(3) one committing task in the graph is the only one queued, the line starts then, and the task after it waits for its landing',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'graph-one-commit', 'NONE');
      const a = await task(stack, w, 'empty-first');
      await workSession(stack, w, a, { branch: 'orbit/empty-first', branchSha: sha('1'), baseSha: sha('1'), finishedMinutesAgo: 1 });
      const b = await task(stack, w, 'commits', { dependsOn: a });
      const c = await task(stack, w, 'after-the-commit', { dependsOn: b });

      await confirm(stack, w, a);
      assert.deepEqual(await routes(stack, w), NO_ROUTE, 'CONTROL: the empty first layer started nothing');
      assert.equal(await dispatched(stack, b), true, 'the committing task went on the empty one\'s DONE');

      await finishDispatchedWork(stack, b, { branchSha: sha('c'), baseSha: sha('2'), changedFiles: TOUCHED });
      await confirm(stack, w, b);

      const line = await stack.db.projectCodebase.findFirst({
        where: { projectId: w.projectId }, select: { integrationStartedAt: true },
      });
      assert.ok(line?.integrationStartedAt, 'the first commit started the line (§12.15 P-M2)');
      assert.deepEqual(await jobsOf(stack, b), ['LAND_TASK'], 'the committing task is queued');
      assert.deepEqual(await jobsOf(stack, a), [], 'the empty task before it is not back-filled');
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { projectId: w.projectId } }), 1,
        'and nothing else in the project is');
      assert.equal(await dispatched(stack, c), false, 'the task after it waits for its landing (J9)');
      assert.equal((await readings(stack, b)).landed, false, 'J9 in SQL: the committing task has not landed');
      assert.equal((await readings(stack, a)).landed, true, 'J9 in SQL: the empty one still has nothing to land');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (4) and (5) the two cases P-M1 does not take ═══════════════════════════════════════════════

test('(4) an empty branch beside a session that reported work opens LANDING_UNOBSERVED (WORK_ELSEWHERE), queues nothing, and its dependent waits',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'work-elsewhere', 'PROJECT_BRANCH');
      const a = await task(stack, w, 'elsewhere');
      // The first attempt reported work on its branch; the attempt that finished last, which the
      // identity is frozen from, has nothing past its base.
      await workSession(stack, w, a, {
        branch: 'orbit/elsewhere-1', branchSha: sha('e'), baseSha: sha('0'), changedFiles: TOUCHED,
        createdMinutesAgo: 60, finishedMinutesAgo: 30,
      });
      await workSession(stack, w, a, {
        branch: 'orbit/elsewhere-2', branchSha: sha('0'), baseSha: sha('0'), createdMinutesAgo: 20, finishedMinutesAgo: 1,
      });
      const b = await task(stack, w, 'after-elsewhere', { dependsOn: a });

      await confirm(stack, w, a);

      const items = await stack.db.projectOpenItem.findMany({
        where: { taskId: a, kind: 'LANDING_UNOBSERVED' }, select: { state: true, payload: true },
      });
      assert.equal(items.length, 1, 'one LANDING_UNOBSERVED for the work that is not on the branch');
      assert.equal(items[0].state, 'OPEN');
      assert.equal((items[0].payload as { reason?: string }).reason, 'WORK_ELSEWHERE');
      assert.deepEqual(await jobsOf(stack, a), [], 'no landing queued for the empty branch');
      assert.deepEqual(await readings(stack, a), { landed: false, nothing: false, nothingTs: false },
        'reported work is not nothing to land');
      assert.equal(await dispatched(stack, b), false, 'its dependent waits, with the item in front of somebody');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(5) a session that never reported a branch_sha nor a diff still queues: the runner\'s J-S2 answers it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'no-tip', 'PROJECT_BRANCH');
      const a = await task(stack, w, 'older-runner');
      // No tip and no list either: nothing measured the branch, so the line is asked. (An EMPTY list beside a
      // missing tip is a measurement since the owner's ruling of 2026-11-20 — case (14).)
      await workSession(stack, w, a, {
        branch: 'orbit/older-runner', branchSha: null, baseSha: sha('0'), changedFiles: null, finishedMinutesAgo: 1,
      });

      await confirm(stack, w, a);

      const row = await stack.db.task.findUniqueOrThrow({ where: { id: a }, select: { deliveredAt: true } });
      assert.equal(row.deliveredAt, null, 'CONTROL: an identity with no tip is not frozen');
      assert.deepEqual(await jobsOf(stack, a), ['LAND_TASK'], 'the landing is queued, as before P-M1');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (6)–(9) the identity frozen late ═══════════════════════════════════════════════════════════

test('(6) a DONE whose work still moves queues nothing; an empty finish queues nothing either, and the ready sweep releases the dependent',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'moving-empty', 'NONE');
      const a = await task(stack, w, 'moving');
      const live = await workSession(stack, w, a, { branch: 'orbit/moving', branchSha: sha('d'), baseSha: sha('d') });
      const b = await task(stack, w, 'after-moving', { dependsOn: a });

      await confirm(stack, w, a);
      assert.deepEqual(await routes(stack, w), NO_ROUTE, 'a DONE whose work moves starts no line and queues nothing');
      assert.equal(await dispatched(stack, b), false,
        'its dependent does not go yet: whether it lands is not known (J9, §12.15 P-M1)');
      assert.equal((await readings(stack, a)).landed, false, 'J9 in SQL agrees');
      assert.notEqual(await dependencyState(stack, w, b), 'READY', 'and in TypeScript');

      // The finalize this harness's runner door makes has no TasksService, so its post-commit edge is
      // absent here: what releases the dependent is the sweep that backs that edge up.
      await finalize(stack, w, live, sha('d'));
      const frozen = await stack.db.task.findUniqueOrThrow({
        where: { id: a }, select: { deliveredSha: true, deliveredBaseSha: true },
      });
      assert.equal(frozen.deliveredSha, sha('d'), 'CONTROL: the finish froze the identity');
      assert.deepEqual(await routes(stack, w), NO_ROUTE, 'the finish found no commit and queued nothing');
      assert.equal((await readings(stack, a)).landed, true, 'J9 now reads nothing to land');
      assert.equal(await dependencyState(stack, w, b), 'READY', 'the TypeScript spelling agrees');
      await readySweep(stack);
      assert.equal(await dispatched(stack, b), true, 'the 60 s ready sweep dispatched the dependent');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(7) the first committing task, DONE while its work moved: its dependent waits for its landing, and the finish starts the line',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'moving-commit', 'NONE');
      const a = await task(stack, w, 'first-commit');
      const live = await workSession(stack, w, a, { branch: 'orbit/first-commit', branchSha: sha('0'), baseSha: sha('0') });
      const b = await task(stack, w, 'after-first-commit', { dependsOn: a });

      await confirm(stack, w, a);
      assert.deepEqual(await routes(stack, w), NO_ROUTE, 'CONTROL: nothing is decided at the DONE');
      assert.equal(await dispatched(stack, b), false, 'the dependent does not go on the DONE');

      await finalize(stack, w, live, sha('f'), TOUCHED);
      const line = await stack.db.projectCodebase.findFirst({
        where: { projectId: w.projectId }, select: { integrationStartedAt: true },
      });
      assert.ok(line?.integrationStartedAt, 'the finish that found a commit started the line');
      assert.deepEqual(await jobsOf(stack, a), ['LAND_TASK'], 'and queued its landing');
      await readySweep(stack);
      assert.equal(await dispatched(stack, b), false, 'the dependent waits for the landing, not for the DONE');
      assert.equal((await readings(stack, a)).landed, false, 'J9 in SQL: not landed');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(8) on a started line the moving DONE reads QUEUED with no attempt and nothing in flight; an empty finish leaves it NOT_APPLICABLE',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'row-reading', 'PROJECT_BRANCH');
      const a = await task(stack, w, 'row');
      const live = await workSession(stack, w, a, { branch: 'orbit/row', branchSha: sha('7'), baseSha: sha('7') });
      const prisma = stack.db as unknown as PrismaService;
      const view = async () => (await readTaskIntegrationViews(prisma, w.ownerId, w.projectId, [a])).get(a)!;

      await confirm(stack, w, a);
      const between = await view();
      assert.equal(between.state, 'QUEUED', 'between the DONE and its finish: the existing "not queued yet" reading');
      assert.equal(between.landTask, null, 'with no landing attempt behind it');
      assert.equal((await readInFlightJobs(prisma, w.projectId)).length, 0, 'and nothing in flight for the project');

      await finalize(stack, w, live, sha('7'));
      const after = await view();
      assert.equal(after.state, 'NOT_APPLICABLE', 'an empty finish reads as nothing to land (coordinator\'s ruling)');
      assert.equal(after.landTask, null);
      assert.deepEqual(await jobsOf(stack, a), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(9) the reaper\'s forced finish runs the same route: an empty branch queues nothing, a committing one queues and starts the line',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'reaper', 'NONE');
      const forceFinalize = (sessionId: string, taskId: string) => (stack.reaper as unknown as {
        forceFinalize(sessionId: string, runnerId: string | null, taskId: string | null, reason: string,
          opts: { status: typeof RunStatus.CANCELLED }): Promise<void>;
      }).forceFinalize(sessionId, w.runnerId, taskId, 'runner lost', {
        status: RunStatus.CANCELLED, 
      });

      const empty = await task(stack, w, 'reaped-empty');
      const emptyLive = await workSession(stack, w, empty, { branch: 'orbit/reaped-empty', branchSha: sha('e'), baseSha: sha('e') });
      await confirm(stack, w, empty);
      await forceFinalize(emptyLive, empty);
      const frozen = await stack.db.task.findUniqueOrThrow({ where: { id: empty }, select: { deliveredAt: true } });
      assert.ok(frozen.deliveredAt, 'CONTROL: the reaper\'s finish froze the identity');
      assert.deepEqual(await routes(stack, w), NO_ROUTE, 'an empty branch the reaper settles queues nothing');

      const commits = await task(stack, w, 'reaped-commit');
      const commitLive = await workSession(stack, w, commits, {
        branch: 'orbit/reaped-commit', branchSha: sha('c'), baseSha: sha('0'), changedFiles: TOUCHED,
      });
      await confirm(stack, w, commits);
      assert.equal(await routeOf(stack, commits), null, 'CONTROL: nothing at the moving DONE');
      await forceFinalize(commitLive, commits);
      // The line the default rule picks decides which route that is (L2): a LAND_TASK on a branch of the
      // project's own, a candidate for main on a MAIN line.
      assert.notEqual(await routeOf(stack, commits), null, 'the reaper\'s finish gave the work its route');
      const line = await stack.db.projectCodebase.findFirst({
        where: { projectId: w.projectId }, select: { integrationStartedAt: true },
      });
      assert.ok(line?.integrationStartedAt, 'and started the line');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (10) the fold ═════════════════════════════════════════════════════════════════════════════

test('(10) a criterion served only by zero-commit tasks reads LANDED (NOTHING_TO_LAND), and the done check reports nothing unlanded',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'fold', 'PROJECT_BRANCH');
      const criterionId = randomUUID();
      await stack.db.projectAcceptanceCriterionDefinition.create({
        data: {
          id: criterionId, projectId: w.projectId, ordinal: 1, text: 'nothing of it had to land',
          verificationMethod: 'no-commit-no-landing.pg.spec.ts reads its landing', contentHash: '0'.repeat(64),
        },
      });
      const served: string[] = [];
      for (const title of ['fold-one', 'fold-two']) {
        const id = await task(stack, w, title, { criterionId });
        await workSession(stack, w, id, { branch: `orbit/${title}`, branchSha: sha('9'), baseSha: sha('9'), finishedMinutesAgo: 1 });
        await confirm(stack, w, id);
        served.push(id);
      }
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { projectId: w.projectId } }), 0,
        'CONTROL: nothing was queued for them');

      const prisma = stack.db as unknown as PrismaService;
      const reasons = criterionLandingWithReasons(
        await readCriterionLandingReasonFacts(prisma, w.ownerId, w.projectId),
        await criterionLanding.readLandingBranches(prisma, w.projectId),
        await readInFlightLandingJobs(prisma, w.projectId),
      ).find((row) => row.definitionId === criterionId);
      assert.equal(reasons?.landing, 'LANDED', 'the criterion folds its zero-commit work as nothing to land');
      assert.equal(reasons?.landingReason, 'NOTHING_TO_LAND', 'with the reason NOTHING_TO_LAND reads today');
      const lane = await criterionLanding.readCriterionLanding(prisma, w.ownerId, w.projectId);
      assert.equal(lane.find((row) => row.definitionId === criterionId)?.landing, 'LANDED', 'the plain lane agrees');

      const state = await stack.db.$transaction((tx) => readDoneState(tx, w.ownerId, w.projectId, null));
      const criterion = state.criteria.find((row) => row.stated.definitionId === criterionId);
      assert.equal(criterion?.landing, 'LANDED', 'the done check reads it landed');
      assert.deepEqual(criterion?.heldOffLanded, [], 'and holds no task of it off as unlanded');
      assert.deepEqual(state.jobs, [], 'with nothing in flight');
      const views = await readTaskIntegrationViews(prisma, w.ownerId, w.projectId, served);
      assert.deepEqual(served.map((id) => views.get(id)?.state), ['NOT_APPLICABLE', 'NOT_APPLICABLE'],
        'each task row reads NOT_APPLICABLE');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (11)–(15) the regression of 2026-11-20 ═════════════════════════════════════════════════════

/**
 * What the runner reported for production's verification task V2 (task 34q3LH8LqvdbgtwmxxSHL, work session
 * 62b3280c-ab6e-5dea-aaeb-c917ce420422) on 2026-11-20: 61 entries, exactly
 * `git diff --name-only <base> <project-line commit the run checked out detached>` — none its own.
 */
const DETACHED_CHECKOUT_DIFF = [
  { path: '.github/workflows/pages.yml', status: 'M', additions: 2, deletions: 2 },
  ...Array.from({ length: 60 }, (_, index) => ({
    path: `scripts/install/step-${String(index).padStart(2, '0')}.sh`, status: 'M', additions: 3, deletions: 1,
  })),
];

/** One stated criterion of the project, for the fold to read. */
async function criterion(stack: Stack, w: World, text: string): Promise<string> {
  const id = randomUUID();
  await stack.db.projectAcceptanceCriterionDefinition.create({
    data: {
      id, projectId: w.projectId, ordinal: 1, text,
      verificationMethod: 'no-commit-no-landing.pg.spec.ts reads its landing', contentHash: '0'.repeat(64),
    },
  });
  return id;
}

/** The criterion's landing and its reason, as the project's criteria read them. */
async function criterionReading(stack: Stack, w: World, criterionId: string) {
  const prisma = stack.db as unknown as PrismaService;
  const row = criterionLandingWithReasons(
    await readCriterionLandingReasonFacts(prisma, w.ownerId, w.projectId),
    await criterionLanding.readLandingBranches(prisma, w.projectId),
    await readInFlightLandingJobs(prisma, w.projectId),
  ).find((answer) => answer.definitionId === criterionId);
  return { landing: row?.landing, reason: row?.landingReason };
}

/** The LANDING_UNOBSERVED items of one task, by their reason. */
async function unobserved(stack: Stack, taskId: string): Promise<Array<string | undefined>> {
  return (await stack.db.projectOpenItem.findMany({
    where: { taskId, kind: 'LANDING_UNOBSERVED' }, select: { payload: true },
  })).map((item) => (item.payload as { reason?: string }).reason);
}

test('(11) a run that checked out the project line detached and committed nothing (V2, 2026-11-20) queues no job and opens no item, reads nothing to land in every spelling, releases its dependent and leaves its criterion LANDED',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'detached', 'PROJECT_BRANCH');
      const criterionId = await criterion(stack, w, 'install.sh was verified before and after a run');
      const a = await task(stack, w, 'codex verify T1 before and after a run', { criterionId });
      // Production's row, column for column: tip = base, a clean checkout, no source pin, and the diff to
      // the commit it checked out. Its branch is gone from origin, which nothing here reads.
      await workSession(stack, w, a, {
        branch: 'orbit/task-v2-codex-verify-t1-before-after-run-24579f',
        branchSha: sha('9'), baseSha: sha('9'), changedFiles: DETACHED_CHECKOUT_DIFF, worktreeDirty: false,
        finishedMinutesAgo: 1,
      });
      const b = await task(stack, w, 'after the verification', { dependsOn: a });

      await confirm(stack, w, a);

      const frozen = await stack.db.task.findUniqueOrThrow({
        where: { id: a }, select: { deliveredSha: true, deliveredBaseSha: true, deliveredAt: true },
      });
      assert.ok(frozen.deliveredAt, 'CONTROL: the DONE froze the identity');
      assert.equal(frozen.deliveredSha, frozen.deliveredBaseSha, 'CONTROL: no commit past the base');
      assert.deepEqual(await jobsOf(stack, a), [], 'no landing is queued for a run that committed nothing');
      assert.deepEqual(await unobserved(stack, a), [],
        'and no LANDING_UNOBSERVED: the 61 files were the commit it checked out, not work somewhere else');
      assert.deepEqual(await readings(stack, a), { landed: true, nothing: true, nothingTs: true },
        'J9 and the P-M1 fact, SQL and TypeScript, read it as nothing to land');
      assert.equal(await dispatched(stack, b), true, 'its dependent was dispatched on the DONE edge (J10)');
      assert.deepEqual(await criterionReading(stack, w, criterionId), { landing: 'LANDED', reason: 'NOTHING_TO_LAND' },
        'its criterion reads LANDED, with nothing to land');
      const views = await readTaskIntegrationViews(stack.db as unknown as PrismaService, w.ownerId, w.projectId, [a]);
      assert.equal(views.get(a)?.state, 'NOT_APPLICABLE', 'the task row reads NOT_APPLICABLE, not QUEUED');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(12) a delivered session that moved past its frozen empty identity afterwards (01a1862d) reads as work not delivered, and the identity is not frozen again',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'moved-after-freeze', 'PROJECT_BRANCH');
      const a = await task(stack, w, 'the task frozen at 07:20');
      const base = '46dd9c68'.padEnd(40, '0');
      // Production's three work sessions: the first ended at its base, the second never reported a tip or
      // a base and its list is not a list, and the third is the one the identity is frozen from.
      await workSession(stack, w, a, {
        branch: 'orbit/first-attempt', branchSha: sha('4'), baseSha: sha('4'), worktreeDirty: false,
        createdMinutesAgo: 90, finishedMinutesAgo: 80,
      });
      const second = await workSession(stack, w, a, {
        branch: 'orbit/second-attempt', branchSha: null, baseSha: null, createdMinutesAgo: 70, finishedMinutesAgo: 60,
      });
      await stack.db.session.update({ where: { id: second }, data: { changedFiles: { files: 'not a list' } } });
      const delivered = await workSession(stack, w, a, {
        branch: 'orbit/delivered-attempt', branchSha: base, baseSha: base, worktreeDirty: false,
        createdMinutesAgo: 50, finishedMinutesAgo: 40,
      });

      await confirm(stack, w, a);
      const frozen = await stack.db.task.findUniqueOrThrow({
        where: { id: a }, select: { deliveredSha: true, deliveredBaseSha: true, deliveredSessionId: true },
      });
      assert.deepEqual(frozen, { deliveredSha: base, deliveredBaseSha: base, deliveredSessionId: delivered },
        'CONTROL: the DONE froze the delivered session\'s empty tip');

      // The delivered session is revived after the DONE and finishes again with a commit on its own branch
      // (07:42:54 in production): the runner's finalize rewrites its tip and its list.
      await stack.db.session.update({
        where: { id: delivered },
        data: {
          branchSha: '87c3bb8d'.padEnd(40, '0'), finishedAt: new Date(),
          changedFiles: [{ path: 'src/one-file.ts', status: 'M', additions: 4, deletions: 1 }],
        },
      });

      const after = await stack.db.task.findUniqueOrThrow({
        where: { id: a }, select: { deliveredSha: true, deliveredBaseSha: true },
      });
      assert.deepEqual(after, { deliveredSha: base, deliveredBaseSha: base },
        'the identity stays as it was frozen: a DONE task is not frozen again');
      assert.deepEqual(await readings(stack, a), { landed: false, nothing: false, nothingTs: false },
        'the commit past the frozen tip is work not delivered, in both spellings');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(13) a session that ended with changes no commit carries (a failed finalize capture) is work of its own: WORK_ELSEWHERE, no job, the dependent waits',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'dirty-end', 'PROJECT_BRANCH');
      const a = await task(stack, w, 'the work whose finalize could not commit');
      // What a finalize whose commit failed reports: the unchanged tip, `[]` beside its capture error, and
      // the checkout measured dirty — the work is still in it, on no branch.
      await workSession(stack, w, a, {
        branch: 'orbit/dirty-end', branchSha: sha('5'), baseSha: sha('5'), changedFiles: [], worktreeDirty: true,
        finishedMinutesAgo: 1,
      });
      const b = await task(stack, w, 'after the dirty end', { dependsOn: a });

      await confirm(stack, w, a);

      assert.deepEqual(await jobsOf(stack, a), [], 'no landing for a branch with nothing on it');
      assert.deepEqual(await unobserved(stack, a), ['WORK_ELSEWHERE'],
        'one LANDING_UNOBSERVED: the work is in the checkout, not on the branch');
      assert.deepEqual(await readings(stack, a), { landed: false, nothing: false, nothingTs: false },
        'uncommitted work is not nothing, in both spellings');
      assert.equal(await dispatched(stack, b), false, 'its dependent waits, with the item in front of somebody');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(14) an identity nobody can name whose every work session reported an empty diff (T3) reads nothing to land in every spelling; a NULL or non-empty list, an unfinished session or a MERGED receipt keeps it unknown',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'unnamed', 'PROJECT_BRANCH');
      const criterionId = await criterion(stack, w, 'the October measurement was taken');
      /** A task whose one work session ended before the runner reported a tip, as T3's did. */
      async function unnamed(title: string, work: Partial<Work>, options: { criterionId?: string } = {}) {
        const id = await task(stack, w, title, options);
        await stack.db.task.update({ where: { id }, data: { codeless: true } });
        const session = await workSession(stack, w, id, {
          branch: `orbit/${title.replace(/\W+/g, '-')}`, branchSha: null, baseSha: sha('3'), changedFiles: [],
          worktreeDirty: false, finishedMinutesAgo: 1, ...work,
        });
        return { id, session };
      }

      const t3 = await unnamed('t3 measurement', {}, { criterionId });
      const after = await task(stack, w, 'after the measurement', { dependsOn: t3.id });
      await confirm(stack, w, t3.id);
      const identity = await stack.db.task.findUniqueOrThrow({
        where: { id: t3.id }, select: { deliveredSha: true, deliveredAt: true },
      });
      assert.deepEqual(identity, { deliveredSha: null, deliveredAt: null },
        'CONTROL: nobody can name its identity — the session reported no tip');
      assert.deepEqual(await jobsOf(stack, t3.id), [], 'no landing is queued for it');
      assert.deepEqual(await readings(stack, t3.id), { landed: true, nothing: true, nothingTs: true },
        'J9 and the P-M1 fact, SQL and TypeScript, read it as nothing to land');
      assert.equal(await dispatched(stack, after), true, 'its dependent was dispatched on the DONE edge');
      assert.deepEqual(await criterionReading(stack, w, criterionId), { landing: 'LANDED', reason: 'NOTHING_TO_LAND' },
        'its criterion reads LANDED, with nothing to land');

      // What keeps it unknown: no list, a list with something in it, a session still moving, a target
      // that moved with its work.
      const nullList = await unnamed('no list', { changedFiles: null });
      const fullList = await unnamed('a full list', { changedFiles: DETACHED_CHECKOUT_DIFF.slice(0, 2) });
      const moving = await unnamed('still moving', { finishedMinutesAgo: 2 });
      await workSession(stack, w, moving.id, {
        branch: 'orbit/still-moving-retry', branchSha: null, baseSha: sha('3'), changedFiles: [],
      });
      const merged = await unnamed('merged once', {});
      for (const unknown of [nullList, fullList, merged]) await confirm(stack, w, unknown.id);
      await stack.db.sessionMergeReceipt.create({
        data: {
          ownerId: w.ownerId, sessionId: merged.session, taskId: merged.id, result: 'MERGED',
          sourceBranch: 'orbit/merged-once', sourceSha: sha('6'), targetBranch: 'main', recordedBy: 'AGENT',
          targetShaBefore: sha('7'), targetShaAfter: sha('8'),
          idempotencyKey: `no-commit-${merged.id}`,
        },
      });
      for (const unknown of [nullList, fullList, moving, merged]) {
        const reading = await readings(stack, unknown.id);
        assert.equal(reading.nothing, false, 'an unmeasured or moved identity is not nothing (SQL)');
        assert.equal(reading.nothingTs, false, 'nor in TypeScript');
      }
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(15) the freeze copies the tip and base of the session the work ended on: an empty identity never comes from a session whose own branch had moved past its base',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'freeze-invariant', 'NONE');
      for (const [title, tip, base] of [['moved', sha('c'), sha('0')], ['empty', sha('7'), sha('7')]] as const) {
        const id = await task(stack, w, `freeze ${title}`);
        const session = await workSession(stack, w, id, {
          branch: `orbit/freeze-${title}`, branchSha: tip, baseSha: base, worktreeDirty: false, finishedMinutesAgo: 1,
        });
        await confirm(stack, w, id);
        const frozen = await stack.db.task.findUniqueOrThrow({
          where: { id }, select: { deliveredSha: true, deliveredBaseSha: true, deliveredSessionId: true },
        });
        assert.deepEqual(frozen, { deliveredSha: tip, deliveredBaseSha: base, deliveredSessionId: session },
          `the ${title} session's own tip and base are what was frozen`);
        assert.equal(frozen.deliveredSha === frozen.deliveredBaseSha, tip === base,
          'the identity is empty exactly when the session\'s own branch was');
      }
    } finally {
      await stack.db.$disconnect();
    }
  });
