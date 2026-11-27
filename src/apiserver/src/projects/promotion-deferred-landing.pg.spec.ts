import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { IntegrationCheckResult, IntegrationJobResultRequest } from '@orbit/shared';
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
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions, standardSetVersion } from './project-acceptance';
import * as criterionLanding from './project-criterion-landing';
import { readDerivedProjectDoneReading } from './project-done-derived';
import { INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2 } from './project-integration-job';
import { landingDeferred } from './project-looks-finished';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { turnStateOfWord } from '../sessions/session-turn-state';

/**
 * No promotion candidate while a DONE task's landing is deferred (§12.15 P-M1, M-F1, J-T1a of
 * `docs/project-integration-line-contract.md`).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-deferred-landing.pg.spec.ts
 *
 * WHAT WAS WRONG (2026-11-20, revision 42 part two's end-to-end run `final1`, b-mixed.mjs)
 * ========================================================================================
 * In an Automatic PROJECT_BRANCH project, M1 and M2 landed while M4 was already DONE with its run's
 * session still open. Since P-M1 such a DONE queues its LAND_TASK only at the finish, so when M2's
 * landing result asked for a candidate (`considerCandidate`) the queue was empty, every criterion
 * read satisfied with only CRITERION_UNLANDED withheld, and a candidate was made from the partial tip.
 * Automatic merged it; M4 landed 26 s later and a second promotion merged that. Main got two merges
 * where one was due. `landingDeferred` already named the state ("work still moving towards the line
 * exactly as it is with a job queued"); the candidate did not ask it.
 *
 * THE CASES
 * =========
 *  (1) the incident: A lands while M is DONE over an open session — no candidate. M's finish (the
 *      runner's finalize) queues M's landing — still none. M lands — one candidate, carrying both,
 *      named by M's landed commit;
 *  (2) the deferred task's finish finds nothing of its own to land (an empty branch), so no landing
 *      result will ever ask again: the finish itself asks (`dispatchDependentsOfSettledWork` →
 *      `considerPromotionAfterSettledWork`), and A's tip gets its one candidate;
 *  (3) the same, when the finish is the reaper's forced one (`routeSettledWork`).
 *
 * Everything is driven through the production doors: the owner's Confirm done writes DONE, the
 * heartbeat claims a landing and the runner's result route (`integrationJobResult`) answers it and
 * asks for the candidate after its commit, the runner's finalize and the reaper end the work. Which
 * commit contains which is a repository's fact; the results report it.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);
const TOUCHED = [{ path: 'src/thing.ts', status: 'M', additions: 1, deletions: 0 }];
const UPSTREAM_TIP = sha('9');
const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false,
  durationMs: 1_000, outputTail: 'ok\n',
};

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
  runnerApi: RunnerApiController;
  reaper: ReaperService;
  jobs: IntegrationJobRelay;
}

/**
 * The doors over one client, as production wires them where this file's subject runs. The completion
 * router is the production class for the two methods a settled finish reaches it by; its producers'
 * doors, which deliver coordinator facts this file is not about, answer nothing.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions, push);
  const promotions = new ProjectPromotionService(prisma);
  const real = new Set<PropertyKey>(['routeSettledWork', 'considerPromotionAfterSettledWork']);
  // The router finds the promotion service through the module graph (`ModuleRef.get`); here, this one.
  const moduleRef = { get: () => promotions };
  const router = new Proxy({ moduleRef, logger: console } as Record<PropertyKey, unknown>, {
    get(target, key) {
      if (real.has(key)) return (CompletionInputRouter.prototype as unknown as Record<PropertyKey, unknown>)[key];
      if (key in target) return target[key];
      if (key === 'then') return undefined;
      return async () => [];
    },
  }) as unknown as CompletionInputRouter;
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma);
  const runnerApi = new RunnerApiController(
    prisma,
    queue,
    realtime,
    push,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  // The optional doors the module provides in production, set by name: the constructor's positions
  // past the seventh are not this file's subject.
  Object.assign(runnerApi as unknown as Record<string, unknown>, { tasks, promotions, integrationJobs: jobs, openItems });
  const reaper = new ReaperService(prisma, realtime, openItems);
  Object.assign(reaper as unknown as Record<string, unknown>, { completionInputs: router });
  return {
    db,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    runnerApi,
    reaper,
    jobs,
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  criterionId: string;
}

/** One owner, one online runner, its workspace, a coordinator, one stated criterion, and a project
 *  integrating on a branch of its own, started. */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const criterionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@deferred-landing.invalid`, name: label, passwordHash: 'x' },
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
      id: projectId, ownerId, title: `${label} project`, goal: 'one promotion carries all of it',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
      startedAt: new Date(),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: criterionLanding.canonicalRepoUrl(repoUrl)!,
      upstreamRef: 'refs/heads/main', integrationRef: `refs/heads/project/${projectId.slice(0, 8)}`,
      refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'EXPLICIT',
      integrationStartedAt: new Date(Date.now() - 3_600_000), deliveryMode: 'PLATFORM',
    },
  });
  const definition = await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId, projectId, ordinal: 1, text: 'all of the work is on main',
      verificationMethod: 'promotion-deferred-landing.pg.spec.ts reads it', contentHash: '0'.repeat(64),
    },
  });
  // The owner confirmed the standard set, as in the incident's project: K7 then waits only on the landing.
  const standing = standardSetVersion(criteriaFromDefinitions([definition]));
  await db.projectStandardSetConfirmation.create({
    data: {
      projectId, ownerId, criteriaDigest: standing.digest,
      criteriaMaterial: standing.material as unknown as Prisma.InputJsonValue, confirmedById: ownerId,
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, criterionId };
}

/** An IN_PROGRESS code task serving the project's criterion, which the owner confirms. */
async function task(stack: Stack, w: World, title: string): Promise<string> {
  const row = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, completionCriterion: 'OWNER_CONFIRMED', status: TaskStatus.IN_PROGRESS,
      criterionDefinitionId: w.criterionId, criterionRevision: 1,
    },
    select: { id: true },
  });
  return row.id;
}

/** A worktree session of the task's work as the runner's reports left it; live unless `finished`. */
async function workSession(
  stack: Stack, w: World, taskId: string,
  s: { branch: string; branchSha: string; baseSha: string; changedFiles?: unknown[]; finished?: boolean },
): Promise<string> {
  const id = randomUUID();
  await stack.db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${s.branch}`, prompt: 'work', provider: 'claude',
      turnState: turnStateOfWord(s.finished ? RunStatus.SUCCEEDED : RunStatus.AWAITING_INPUT),
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
      branch: s.branch, branchSha: s.branchSha, baseSha: s.baseSha,
      changedFiles: (s.changedFiles ?? []) as Prisma.InputJsonValue,
      numTurns: 1, startedAt: new Date(Date.now() - 30 * 60_000), createdAt: new Date(Date.now() - 30 * 60_000),
      ...(s.finished ? { finishedAt: new Date(Date.now() - 60_000) } : {}),
    },
  });
  return id;
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

/** The reaper's forced finish of a live session whose runner is gone. */
async function reap(stack: Stack, w: World, sessionId: string, taskId: string): Promise<void> {
  await (stack.reaper as unknown as {
    forceFinalize(sessionId: string, runnerId: string | null, taskId: string | null, reason: string,
      opts: { status?: RunStatus }): Promise<void>;
  }).forceFinalize(sessionId, w.runnerId, taskId, 'runner lost', { status: RunStatus.CANCELLED });
  const row = await stack.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { finishedAt: true } });
  assert.ok(row.finishedAt, 'CONTROL: the reaper wrote the finish');
}

/**
 * The task's queued landing claimed off the heartbeat (J-T2) and answered LANDED through the runner's
 * result route (J-T5), whose post-commit step asks for the candidate (M-F1).
 */
async function land(stack: Stack, w: World, taskId: string, s: { sourceSha: string; before: string; landed: string }) {
  const queued = await stack.db.projectIntegrationJob.findFirst({
    where: { taskId, kind: 'LAND_TASK', state: 'QUEUED' }, select: { id: true },
  });
  assert.ok(queued, 'CONTROL: the task has a landing queued');
  const commands = await stack.jobs.dispatch({
    runnerId: w.runnerId, leaseOwner: `lease-${randomUUID()}`, draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2],
  });
  const job = commands.find((command) => command.jobId === queued.id);
  assert.ok(job, `CONTROL: the heartbeat handed out the landing (${JSON.stringify(commands.map((c) => c.jobId))})`);
  const answer = await stack.runnerApi.integrationJobResult({ id: w.runnerId, ownerId: w.ownerId }, job.jobId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner,
    state: 'LANDED', phase: 'VERIFY', sourceSha: s.sourceSha, targetShaBefore: s.before,
    testedSha: s.landed, testedTreeSha: sha('5'), landedSha: s.landed, landedTreeSha: sha('5'),
    aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
  } as IntegrationJobResultRequest);
  assert.equal(answer.accepted, true, `CONTROL: the result was taken: ${JSON.stringify(answer)}`);
}

/** The project's candidates, oldest first. */
function candidates(stack: Stack, w: World) {
  return stack.db.projectPromotion.findMany({
    where: { projectId: w.projectId }, orderBy: { createdAt: 'asc' },
    select: { sourceKind: true, sourceSha: true, includedTaskIds: true, state: true },
  });
}

/** The K7 reading the candidate is gated on without a coordinator's request: every criterion met,
 *  only CRITERION_UNLANDED withheld. Asserted so a red here is the deferred landing, not the gate. */
async function assertK7Open(stack: Stack, w: World, why: string): Promise<void> {
  const { derived } = await readDerivedProjectDoneReading(stack.db as never, w.ownerId, w.projectId);
  assert.deepEqual(derived.withheld, ['CRITERION_UNLANDED'], `CONTROL (${why}): only CRITERION_UNLANDED is withheld`);
  assert.ok(derived.criteria.every((criterion) => criterion.satisfied), `CONTROL (${why}): every criterion is met`);
  assert.equal(await stack.db.projectPromotionRequest.count({ where: { projectId: w.projectId } }), 0,
    'CONTROL: no coordinator request is involved');
}

/** A lands its work on the project line while M is DONE over a session that is still open. */
async function landBesideADeferredDone(stack: Stack, w: World, m: { branchSha: string; baseSha: string; changedFiles?: unknown[] }) {
  const a = await task(stack, w, 'lands-first');
  await workSession(stack, w, a, {
    branch: 'orbit/lands-first', branchSha: sha('a'), baseSha: sha('0'), changedFiles: TOUCHED, finished: true,
  });
  const deferred = await task(stack, w, 'done-over-an-open-session');
  const live = await workSession(stack, w, deferred, { branch: 'orbit/done-over-an-open-session', ...m });

  await confirm(stack, w, a);
  await confirm(stack, w, deferred);
  assert.equal(await stack.db.projectIntegrationJob.count({ where: { taskId: deferred } }), 0,
    'CONTROL: a DONE over moving work queues nothing (§12.15 P-M1)');
  assert.equal(await landingDeferred(stack.db as never, w.projectId), true, 'CONTROL: its landing reads deferred');

  await land(stack, w, a, { sourceSha: sha('a'), before: UPSTREAM_TIP, landed: sha('1') });
  await assertK7Open(stack, w, 'after A landed');
  assert.deepEqual(await candidates(stack, w), [],
    'no candidate while a DONE task\'s landing is deferred: the tip is not what the owner would be confirming');
  return { a, deferred, live };
}

test('(1) a landing beside a deferred DONE makes no candidate; the deferred landing, once it lands, makes one carrying both',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'deferred-commit');
      const { a, deferred, live } = await landBesideADeferredDone(stack, w, {
        branchSha: sha('c'), baseSha: sha('0'), changedFiles: TOUCHED,
      });

      await finalize(stack, w, live, sha('c'), TOUCHED);
      assert.deepEqual(
        (await stack.db.projectIntegrationJob.findMany({ where: { taskId: deferred }, select: { kind: true, state: true } })),
        [{ kind: 'LAND_TASK', state: 'QUEUED' }], 'CONTROL: the finish queued the deferred landing');
      assert.equal(await landingDeferred(stack.db as never, w.projectId), false, 'CONTROL: it is no longer deferred');
      assert.deepEqual(await candidates(stack, w), [], 'still none while that landing is queued');

      await land(stack, w, deferred, { sourceSha: sha('c'), before: sha('1'), landed: sha('2') });
      const made = await candidates(stack, w);
      assert.equal(made.length, 1, 'one candidate, once all the work is on the line');
      assert.equal(made[0]!.sourceKind, 'PROJECT_BRANCH');
      assert.equal(made[0]!.sourceSha, sha('2'), 'named by the tip the deferred landing produced');
      assert.deepEqual([...made[0]!.includedTaskIds].sort(), [a, deferred].sort(), 'carrying both tasks');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(2) a deferred DONE whose finish finds nothing to land: that finish asks for the candidate, and A\'s tip gets one',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'deferred-empty');
      const { a, deferred, live } = await landBesideADeferredDone(stack, w, { branchSha: sha('d'), baseSha: sha('d') });

      await finalize(stack, w, live, sha('d'));
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { taskId: deferred } }), 0,
        'CONTROL: an empty branch queues nothing at its finish either');
      const made = await candidates(stack, w);
      assert.equal(made.length, 1, 'the finish that decided the deferred landing asked again, and made one');
      assert.equal(made[0]!.sourceSha, sha('1'), 'named by the tip A\'s landing produced');
      assert.deepEqual(made[0]!.includedTaskIds, [a], 'carrying the work that is on the line');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(3) the same when the reaper\'s forced finish decides the deferred landing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'deferred-reaped');
      const { a, deferred, live } = await landBesideADeferredDone(stack, w, { branchSha: sha('e'), baseSha: sha('e') });

      await reap(stack, w, live, deferred);
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { taskId: deferred } }), 0,
        'CONTROL: an empty branch the reaper settles queues nothing');
      const made = await candidates(stack, w);
      assert.equal(made.length, 1, 'the reaper\'s finish asked again, and made one');
      assert.deepEqual(made[0]!.includedTaskIds, [a]);
    } finally {
      await stack.db.$disconnect();
    }
  });
