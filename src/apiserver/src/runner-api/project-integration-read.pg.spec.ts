/**
 * `GET /runner/projects/:id/integration` — the agent read of a project's integration line
 * (`project_integration_get`, contract §2.2 J-T4, §2.9 LS6) — on real PostgreSQL.
 *
 * WHY THIS EXISTS
 * ---------------
 * The read is the door that replaces a coordinator querying the production database, so what it
 * answers has to be the queue's own facts: which jobs are RUNNING and QUEUED, all three job kinds,
 * why each waits (the claim's own blocking reasons, including the cross-account case where only the
 * reason may travel), every current generation with its round and current check, each task's
 * newest landing, and each candidate's newest check and merge. A shape that compiled and answered
 * something plausible is exactly the failure this spec is for.
 *
 * THE CASES
 * ---------
 *  (a) One account's line with a RUNNING `LAND_TASK`, a QUEUED `CHECK_PROMOTION` blocked by
 *      ANOTHER account's running job, and a candidate already merged into main: the read lists the
 *      queue in `inFlightJobs` order, all three kinds, the blocking reason with no id or title of
 *      the other account's job, the generations with their round and current check, the task's
 *      newest landing, the candidate's newest check, and the merge.
 *  (b) The page slots revision 12 reserves (`jobId`, `claim`, `round`, `check`, `cursor`) are
 *      echoed under `pagination`.
 *  (c) Another account's project is the ordinary 404, as an id that names nothing is.
 *  (d) A session that is not one of the project's is refused, and so is a missing one.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/project-integration-read.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType, Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectsService } from '../projects/projects.service';
import type { ProjectHandoffService } from '../projects/project-handoff.service';
import type { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import { RunnerProjectsController } from './runner-projects.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Full 40-character object names for the tree columns the landed CHECKs compare. */
const sha = (nibble: string) => nibble.repeat(40);

interface Account {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  codebaseId: string;
  coordinatorSessionId: string;
  workSessionId: string;
  taskId: string;
  /** A second project of the same account, for a session that is a member of something else. */
  otherProjectId: string;
  otherCoordinatorSessionId: string;
}

/** One account with a project, its repository, a coordinator, and one piece of done code work. */
async function account(db: PrismaClient, label: string): Promise<Account> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const otherCoordinatorSessionId = randomUUID();

  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@agent-read.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: ['integration-job/v1'],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
      heartbeatLeaseOwner: randomUUID(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: 'ssh://git@example.invalid/agent-read',
    },
  });

  const session = async (
    id: string,
    title: string,
    extra: Partial<Omit<Prisma.SessionUncheckedCreateInput, 'id' | 'ownerId' | 'creatorId' | 'title' | 'prompt'>> = {},
  ) => {
    await db.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title,
        prompt: title,
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...extra,
      },
    });
  };
  await session(coordinatorSessionId, `${label}-coordinator`, { titleManagedByProject: true });
  await session(otherCoordinatorSessionId, `${label}-other-coordinator`, { titleManagedByProject: true });

  const project = async (id: string, coordinator: string) => {
    await db.project.create({
      data: {
        id,
        ownerId,
        title: `${label}-project`,
        coordinatorWorkspaceId: workspaceId,
        coordinatorSessionId: coordinator,
      },
    });
    await db.projectCodebase.create({
      data: {
        projectId: id,
        ownerId,
        canonicalRepoUrl: `ssh://git@example.invalid/agent-read/${id}`,
        upstreamRef: 'refs/heads/main',
        integrationRef: `refs/heads/project/${id}`,
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(),
        refAuthority: 'REMOTE',
      },
    });
  };
  await project(projectId, coordinatorSessionId);
  await project(otherProjectId, otherCoordinatorSessionId);

  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: `${label} landing task`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.DONE,
    },
  });
  const workSessionId = randomUUID();
  await session(workSessionId, `${label}-work`, {
    taskId,
    status: RunStatus.SUCCEEDED,
    startsTaskWork: true,
    isolationStatus: 'worktree',
    branch: `orbit/${label}`,
    finishedAt: new Date(),
  });

  const codebase = await db.projectCodebase.findFirstOrThrow({
    where: { projectId, slot: 'primary' },
    select: { id: true },
  });
  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    codebaseId: codebase.id,
    coordinatorSessionId,
    workSessionId,
    taskId,
    otherProjectId,
    otherCoordinatorSessionId,
  };
}

/** One integration job, written the way the queue writes it. */
async function job(
  db: PrismaClient,
  f: Account,
  spec: {
    state: string;
    kind: 'LAND_TASK' | 'CHECK_PROMOTION' | 'LAND_PROMOTION';
    idempotency: string;
    at: Date;
    taskId?: string | null;
    sessionId?: string | null;
    landingId?: string | null;
    promotionId?: string | null;
    serialKey?: string;
    targetRef?: string;
    claimedAt?: Date | null;
    heartbeatAt?: Date | null;
    finishedAt?: Date | null;
    runnerId?: string | null;
    progressProtocol?: string | null;
    claimGeneration?: bigint;
    round?: number | null;
    phase?: string | null;
    errorCode?: string | null;
    currentCheck?: Prisma.InputJsonValue | null;
    checks?: Prisma.InputJsonValue;
  },
): Promise<string> {
  const id = randomUUID();
  const landed = spec.state === 'LANDED';
  await db.projectIntegrationJob.create({
    data: {
      id,
      projectId: f.projectId,
      ownerId: f.ownerId,
      codebaseId: f.codebaseId,
      kind: spec.kind,
      generation: 1,
      taskId: spec.taskId ?? null,
      sessionId: spec.sessionId ?? null,
      landingId: spec.landingId ?? null,
      promotionId: spec.promotionId ?? null,
      serialKey: spec.serialKey ?? `${f.projectId}:${spec.idempotency}`,
      targetRef: spec.targetRef ?? 'refs/heads/main',
      upstreamRef: 'refs/heads/main',
      sourceRef: `refs/heads/orbit/${spec.idempotency}`,
      state: spec.state,
      phase: spec.phase ?? null,
      runnerId: spec.runnerId ?? null,
      progressProtocol: spec.progressProtocol ?? null,
      claimLeaseOwner: spec.claimedAt ? `lease-${id}` : null,
      claimGeneration: spec.claimGeneration ?? 0n,
      round: spec.round ?? null,
      currentCheck: spec.currentCheck ?? Prisma.DbNull,
      checks: spec.checks ?? [],
      errorCode: spec.errorCode ?? null,
      claimedAt: spec.claimedAt ?? null,
      startedAt: spec.claimedAt ?? null,
      heartbeatAt: spec.heartbeatAt ?? null,
      finishedAt: spec.finishedAt ?? null,
      createdAt: spec.at,
      idempotencyKey: `ij:v1:test:${f.projectId}:${spec.idempotency}`,
      ...(landed
        ? { landedSha: sha('b'), testedTreeSha: sha('a'), landedTreeSha: sha('a') }
        : {}),
    },
  });
  return id;
}

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sql: Client;
  controller: RunnerProjectsController;
}

async function connect(): Promise<Stack> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
  const controller = new RunnerProjectsController(
    projects,
    {} as ProjectAcceptanceService,
    {} as ProjectHandoffService,
    {} as RunnerOrchestrationAuthorizer,
  );
  return { db, prisma, sql, controller };
}

/** The status a refusal would answer with, so a case asserts the door's answer rather than a class. */
const statusOf = (error: unknown) =>
  (error as { getStatus?: () => number }).getStatus?.();

const codeOf = (error: unknown) =>
  ((error as { getResponse?: () => { code?: string } }).getResponse?.() ?? {}).code;

test('GET /runner/projects/:id/integration reads the line, and only this account\'s line', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const stack = await connect();
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await stack.sql.end().catch(() => undefined);
  });

  const a = await account(stack.db, 'a');
  const b = await account(stack.db, 'b');
  const runnerA = await stack.db.runner.findUniqueOrThrow({ where: { id: a.runnerId } });
  const runnerB = await stack.db.runner.findUniqueOrThrow({ where: { id: b.runnerId } });
  const now = Date.now();
  const minutes = (n: number) => new Date(now - n * 60_000);

  // ── A's line ──────────────────────────────────────────────────────────────────────────────────
  // The subject the running landing belongs to (§2.9 LS1): its address is pre-generated here, and
  // the session row is deliberately NOT created — the link answers from the subject.
  const landingSessionId = randomUUID();
  const landingId = randomUUID();
  await stack.db.projectLanding.create({
    data: {
      id: landingId,
      projectId: a.projectId,
      ownerId: a.ownerId,
      codebaseId: a.codebaseId,
      subject: 'TASK',
      taskId: a.taskId,
      episode: 1,
      sessionId: landingSessionId,
    },
  });
  // A running LAND_TASK, mid-check, on its second round.
  const runningTaskJob = await job(stack.db, a, {
    state: 'RUNNING',
    kind: 'LAND_TASK',
    idempotency: 'running-land-task',
    at: minutes(6),
    claimedAt: minutes(5),
    heartbeatAt: minutes(1),
    taskId: a.taskId,
    sessionId: a.workSessionId,
    landingId,
    runnerId: a.runnerId,
    progressProtocol: 'v2',
    claimGeneration: 1n,
    round: 2,
    phase: 'CHECK',
    currentCheck: {
      name: 'TASK_ACCEPTANCE',
      index: 1,
      count: 2,
      budgetSeconds: 600,
      startedAt: minutes(2).toISOString(),
    },
  });

  // A candidate whose check is queued, held behind ANOTHER account's running job on the same
  // repository and target ref — the cross-account blocking reason.
  const blockedPromotionId = randomUUID();
  await stack.db.projectPromotion.create({
    data: {
      id: blockedPromotionId,
      projectId: a.projectId,
      ownerId: a.ownerId,
      codebaseId: a.codebaseId,
      sourceKind: 'PROJECT_BRANCH',
      sourceRef: `refs/heads/project/${a.projectId}`,
      sourceSha: sha('d'),
      upstreamRef: 'refs/heads/main',
      includedTaskIds: [],
      state: 'CHECKING',
    },
  });
  const serial = 'agent-read-shared-serial';
  const queuedCheckJob = await job(stack.db, a, {
    state: 'QUEUED',
    kind: 'CHECK_PROMOTION',
    idempotency: 'queued-check',
    at: minutes(4),
    sessionId: a.workSessionId,
    promotionId: blockedPromotionId,
    serialKey: serial,
  });
  // B owns the job A is waiting behind, on the same repository and target ref.
  const otherTaskId = randomUUID();
  await stack.db.task.create({
    data: {
      id: otherTaskId,
      ownerId: b.ownerId,
      projectId: b.projectId,
      title: 'b private landing task',
      creatorType: CreatorType.USER,
      creatorId: b.ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.DONE,
    },
  });
  await job(stack.db, b, {
    state: 'RUNNING',
    kind: 'LAND_TASK',
    idempotency: 'b-running',
    at: minutes(5),
    claimedAt: minutes(4),
    heartbeatAt: minutes(1),
    taskId: otherTaskId,
    sessionId: b.workSessionId,
    runnerId: b.runnerId,
    serialKey: serial,
  });

  // A candidate already merged into main: the third kind, and the last merge.
  const mergedPromotionId = randomUUID();
  const mergedAt = minutes(60);
  await stack.db.projectPromotion.create({
    data: {
      id: mergedPromotionId,
      projectId: a.projectId,
      ownerId: a.ownerId,
      codebaseId: a.codebaseId,
      sourceKind: 'PROJECT_BRANCH',
      sourceRef: `refs/heads/project/${a.projectId}/merged`,
      sourceSha: sha('e'),
      upstreamRef: 'refs/heads/main',
      includedTaskIds: [],
      state: 'MERGED',
      confirmedByUserId: a.ownerId,
      confirmedAt: mergedAt,
      mergedSha: sha('c'),
      mergedAt,
    },
  });
  const mergedJob = await job(stack.db, a, {
    state: 'LANDED',
    kind: 'LAND_PROMOTION',
    idempotency: 'merged-land',
    at: minutes(70),
    claimedAt: minutes(65),
    finishedAt: mergedAt,
    sessionId: a.workSessionId,
    promotionId: mergedPromotionId,
  });

  await t.test('the queue is every RUNNING and QUEUED job, all three kinds, in the queue\'s order',
    async () => {
      const read = await stack.controller.getProjectIntegration(
        runnerA, a.projectId, a.coordinatorSessionId,
      );
      assert.deepEqual(read.queue.map((entry) => entry.jobId), [runningTaskJob, queuedCheckJob],
        'running work first, then the queue oldest first');
      assert.deepEqual(read.queue.map((entry) => entry.state), ['RUNNING', 'QUEUED']);
      assert.deepEqual(read.queue.map((entry) => entry.kind), ['LAND_TASK', 'CHECK_PROMOTION']);

      const running = read.queue[0];
      assert.equal(running.taskId, a.taskId);
      assert.equal(running.generation, 1);
      assert.equal(running.round, 2);
      assert.equal(running.check?.name, 'TASK_ACCEPTANCE');
      assert.equal(running.check?.index, 1);
      assert.equal(running.check?.count, 2);
      assert.equal(running.liveness, 'LIVE');
      // §2.9 LS6: every job item carries the landing session its subject opened, even though that
      // session's row does not exist yet — the address is served from `project_landing`.
      assert.equal(running.landingSessionId, landingSessionId);
      assert.equal(read.queue[1].landingSessionId, null,
        'a job written without a subject carries no landing address');
    });

  await t.test('another account\'s blocking job is named by its reason alone', async () => {
    const read = await stack.controller.getProjectIntegration(
      runnerA, a.projectId, a.coordinatorSessionId,
    );
    const queued = read.queue.find((entry) => entry.jobId === queuedCheckJob);
    assert.ok(queued, 'the queued check is missing from the queue');
    assert.equal(queued.blockingReason?.code, 'WAITING_SERIAL_SLOT');
    assert.equal(queued.blockingReason?.jobId, undefined,
      'the other account\'s job id travelled to this account');
    assert.doesNotMatch(queued.blockingReason?.summary ?? '', /b private landing task/,
      'the other account\'s task title travelled to this account');
  });

  await t.test('every current generation carries its state, phase, round and check, and the three kinds are present',
    async () => {
      const read = await stack.controller.getProjectIntegration(
        runnerA, a.projectId, a.coordinatorSessionId,
      );
      assert.deepEqual(
        [...new Set(read.generations.map((generation) => generation.kind))].sort(),
        ['CHECK_PROMOTION', 'LAND_PROMOTION', 'LAND_TASK'],
      );
      const running = read.generations.find((generation) => generation.jobId === runningTaskJob);
      assert.deepEqual(
        {
          jobId: running?.jobId,
          generation: running?.generation,
          state: running?.state,
          phase: running?.phase,
          round: running?.round,
          check: running?.check?.name,
        },
        {
          jobId: runningTaskJob,
          generation: 1,
          state: 'RUNNING',
          phase: 'CHECK',
          round: 2,
          check: 'TASK_ACCEPTANCE',
        },
      );
      // §2.9 LS6: a generation addresses its landing session too, so any attempt the read lists
      // can be opened with session_get.
      assert.equal(running?.landingSessionId, landingSessionId);
      const queued = read.generations.find((generation) => generation.jobId === queuedCheckJob);
      assert.equal(queued?.blockingReason?.code, 'WAITING_SERIAL_SLOT');
      assert.equal(queued?.landingSessionId, null);
      const landed = read.generations.find((generation) => generation.jobId === mergedJob);
      assert.equal(landed?.kind, 'LAND_PROMOTION');
      assert.equal(landed?.state, 'LANDED');
    });

  await t.test('each task\'s newest landing and each candidate\'s newest check and merge are listed',
    async () => {
      const read = await stack.controller.getProjectIntegration(
        runnerA, a.projectId, a.coordinatorSessionId,
      );
      assert.equal(read.landTasks.length, 1);
      assert.equal(read.landTasks[0].taskId, a.taskId);
      assert.equal(read.landTasks[0].integration.landTask?.jobId, runningTaskJob);
      assert.equal(read.landTasks[0].integration.landTask?.generation, '1');

      const blocked = read.promotions.find((candidate) => candidate.promotionId === blockedPromotionId);
      assert.ok(blocked, 'the blocked candidate is missing');
      assert.equal(blocked.state, 'CHECKING');
      assert.equal(blocked.check?.jobId, queuedCheckJob);
      assert.equal(blocked.land, null);

      const merged = read.promotions.find((candidate) => candidate.promotionId === mergedPromotionId);
      assert.ok(merged, 'the last merge is missing');
      assert.equal(merged.state, 'MERGED');
      assert.deepEqual(merged.merged, {
        sha: sha('c'),
        at: mergedAt,
        automatic: false,
        byUserId: a.ownerId,
      });
      assert.equal(merged.land?.jobId, mergedJob);
      assert.equal(merged.land?.state, 'LANDED');
    });

  await t.test('the line\'s settings travel with the queue', async () => {
    const read = await stack.controller.getProjectIntegration(
      runnerA, a.projectId, a.coordinatorSessionId,
    );
    assert.equal(read.projectId, a.projectId);
    assert.equal(read.projectTitle, 'a-project');
    assert.equal(read.line.line, 'PROJECT_BRANCH');
    assert.equal(read.line.locked, true);
  });

  await t.test('the page slots revision 12 reserves are echoed under pagination', async () => {
    // A cursor the log read itself issues (its opaque position: claim, round, check, seq). The
    // slots are read now, not merely echoed: `jobId` resolves the attempt and the rest narrow it.
    const cursor = Buffer.from(JSON.stringify({ c: 1, r: 2, k: 3, s: 0 }), 'utf8').toString('base64url');
    const read = await stack.controller.getProjectIntegration(
      runnerA, a.projectId, a.coordinatorSessionId,
      runningTaskJob, '1', '2', '3', cursor,
    );
    assert.deepEqual(read.pagination, {
      jobId: runningTaskJob,
      claim: 1,
      round: 2,
      check: 3,
      cursor,
    });
    // The attempt is this project's, so its log slot is served (empty until the runner uploads).
    assert.equal(read.log?.jobId, runningTaskJob);
    assert.deepEqual(read.log?.entries, []);
  });

  await t.test('a job the request names serves its check output, narrowed by check', async () => {
    for (let seq = 0; seq < 3; seq += 1) {
      await stack.db.projectIntegrationJobLog.create({
        data: {
          jobId: runningTaskJob, claimGeneration: 1n, round: 2,
          checkName: 'MERGE_CHECK', checkIndex: 3, seq, text: `line ${seq}\n`,
        },
      });
    }
    const read = await stack.controller.getProjectIntegration(
      runnerA, a.projectId, a.coordinatorSessionId, runningTaskJob,
    );
    assert.deepEqual(read.log?.entries.map((entry) => entry.text), ['line 0\n', 'line 1\n', 'line 2\n']);
    const otherCheck = await stack.controller.getProjectIntegration(
      runnerA, a.projectId, a.coordinatorSessionId, runningTaskJob, undefined, undefined, '1',
    );
    assert.deepEqual(otherCheck.log?.entries, []);
    // Another account's job id is not this project's attempt: the same 404 as an id naming nothing.
    await assert.rejects(
      () => stack.controller.getProjectIntegration(runnerB, b.projectId, b.coordinatorSessionId, runningTaskJob),
      (error) => statusOf(error) === 404,
      'another account\'s job was readable as this project\'s',
    );
  });

  await t.test('another account\'s project is the ordinary 404', async () => {
    await assert.rejects(
      stack.controller.getProjectIntegration(runnerB, a.projectId, b.coordinatorSessionId),
      (error) => statusOf(error) === 404,
      'another account\'s project was readable',
    );
  });

  await t.test('a session that is not one of the project\'s is refused, and so is a missing one',
    async () => {
      await assert.rejects(
        stack.controller.getProjectIntegration(runnerA, a.projectId, a.otherCoordinatorSessionId),
        (error) => statusOf(error) === 403 && codeOf(error) === 'INTEGRATION_READ_NOT_PROJECT_SESSION',
        'a session of another project read this project\'s line',
      );
      await assert.rejects(
        stack.controller.getProjectIntegration(runnerA, a.projectId, b.coordinatorSessionId),
        (error) => statusOf(error) === 403 && codeOf(error) === 'INTEGRATION_READ_NOT_PROJECT_SESSION',
        'another account\'s session read this project\'s line',
      );
      await assert.rejects(
        stack.controller.getProjectIntegration(runnerA, a.projectId, undefined),
        (error) => statusOf(error) === 403 && codeOf(error) === 'INTEGRATION_READ_SESSION_REQUIRED',
        'the line was readable with no session at all',
      );
      await assert.rejects(
        stack.controller.getProjectIntegration(runnerA, a.projectId, 'not-a-session'),
        (error) => statusOf(error) === 403 && codeOf(error) === 'INTEGRATION_READ_NOT_PROJECT_SESSION',
        'a header that names no session at all was not refused as one',
      );
    });

  await t.test('a purged source session is not an error and does not unaddress the landing', async () => {
    // 0424: a job's `session_id` is a history reference with no foreign key, so the conversation
    // that produced the work can be deleted under a job that still runs.
    await stack.db.session.delete({ where: { id: a.workSessionId } });
    const read = await stack.controller.getProjectIntegration(
      runnerA, a.projectId, a.coordinatorSessionId,
    );
    const running = read.queue.find((entry) => entry.jobId === runningTaskJob);
    assert.ok(running, 'the queue lost its job when the source session was purged');
    assert.equal(running.landingSessionId, landingSessionId,
      'the landing address is the subject’s own, never derived from the purged source session');
  });
});
