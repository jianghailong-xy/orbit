/**
 * `GET /projects/:id/integration`'s `inFlight` on real PostgreSQL: WHICH job the project page's
 * landing line describes, and what its clock counts from.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Work overview card draws one live line while the platform is landing work — "Landing <task> ·
 * checking · 1m 20s" — and the four minutes it covers are exactly the minutes every count on that
 * card stands still (owner report, 2026-09-25: Running 0 · Ready 0 · only Integrating 1, read as a
 * stopped project). The line's facts are assembled from one `$queryRaw` whose shape no test would
 * otherwise exercise: `$queryRaw` is typed by the caller, so a wrong join, a wrong ORDER BY or the
 * wrong instant compiles and answers something plausible. Three of those mistakes are invisible in
 * the one case anybody would write by hand (a single running job with a task): the RUNNING-first rule only
 * shows with two jobs in flight, `claimed_at` versus `created_at` only shows when they differ, and
 * the task join only shows when a job has no task at all.
 *
 * So every case here writes its job rows the way the queue and the runner do — the enqueue's
 * `created_at`, the claim's `claimed_at` — and reads the answer through the same function the
 * endpoint calls.
 *
 * THE CASES
 * ---------
 *  (a) Nothing in flight: the line is absent, which is what removes the row from the card. The
 *      control for every case below — a read that always described something would pass them all.
 *  (b) Two jobs in flight, the OLDER one queued and the newer one running: the running one is
 *      described, since the line tells the reader what the platform is doing now.
 *  (c) The same shape with the instants swapped: the running one is older, and its clock starts at
 *      its CLAIM rather than at the enqueue that preceded it.
 *  (d) A job that names no task (a promotion of the project's own branch): it is still described,
 *      with a null title rather than a missing one.
 *  (e) A finished job is not in flight, and another project's job is not this project's: the two
 *      ways a row could be described that nothing is waiting on.
 *  (f) `inFlightJobs` lists every job the counts count, in `inFlight`'s order, with its task, its
 *      runner and its limit — and its first entry is the job `inFlight` describes.
 *  (g) A running job silent past the claim lease is timed out; one inside it is not.
 *  (h) While checking, the limit is the job's check budgets plus the lease, so a long healthy check
 *      is not called timed out.
 *  (i) A claim that has not reported while another job on the same runner, repository and ref was
 *      claimed first is waiting its turn, not timed out; one that reported and went silent is.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-integration-inflight.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CreatorType, Prisma, PrismaClient, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';
import type { IntegrationJobKind, IntegrationJobPhase } from '@orbit/shared';
import { Client } from 'pg';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readProjectIntegrationLines, readProjectIntegrationView } from './project-integration-line';

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  codebaseId: string;
}

/** An owner with one project, its codebase binding, and one code task to land. */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@inflight.invalid`, name: label, passwordHash: 'x' },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: label } });
  const codebase = await db.projectCodebase.create({
    data: {
      projectId,
      ownerId,
      // Normalised, the way 0231's CHECK requires it: no trailing `.git`, no trailing slash.
      canonicalRepoUrl: `ssh://git@example.invalid/${label}`,
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/project/${projectId}`,
      integrationRefSource: 'EXPLICIT',
      // The two closed sets 0231's CHECKs hold these to: a normalised URL and a known authority.
      refAuthority: 'REMOTE',
    },
  });
  return { ownerId, projectId, codebaseId: codebase.id };
}

/** One task of the project, as the landing's own task — the title `inFlight` carries to the card. */
async function task(db: PrismaClient, f: Fixture, title: string): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      ownerId: f.ownerId,
      projectId: f.projectId,
      title,
      creatorType: CreatorType.USER,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      creatorId: f.ownerId,
      status: TaskStatus.DONE,
    },
  });
  return id;
}

/**
 * One integration job, written the way the row is written in production: the enqueue stamps
 * `created_at` and leaves `claimed_at` null, and the claim sets `claimed_at` and moves the state to
 * RUNNING. `at` is the enqueue, `claimedAt` the claim when there is one, `finishedAt` the runner's
 * answer.
 *
 * A successful fixture supplies matching tree shas, as the landed-tree constraint requires.
 */
async function job(
  db: PrismaClient,
  f: Fixture,
  spec: { at: Date; claimedAt?: Date; finishedAt?: Date; startedAt?: Date | null; heartbeatAt?: Date; state: string;
          taskId?: string | null; idempotency: string;
          kind?: IntegrationJobKind; phase?: IntegrationJobPhase | null;
          checks?: Prisma.InputJsonValue; aheadOfUpstream?: number;
          runnerId?: string; targetRef?: string; generation?: number;
          sessionId?: string | null; promotionId?: string | null;
          confirmedAutomatically?: boolean; progressProtocol?: string | null;
          claimGeneration?: number; round?: number | null; step?: string | null;
          stepStartedAt?: Date | null; outputMovedAt?: Date | null;
          currentCheck?: Prisma.InputJsonValue | null; serialKey?: string;
          cancelRequestedAt?: Date | null; landingId?: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.projectIntegrationJob.create({
    data: {
      id,
      projectId: f.projectId,
      ownerId: f.ownerId,
      codebaseId: f.codebaseId,
      // §2.9 LS1: the landing subject this attempt belongs to, which the line hands to a client
      // that opens it. Absent in the older fixtures, exactly as on a row an older build queued.
      landingId: spec.landingId ?? null,
      kind: spec.kind ?? (spec.taskId ? 'LAND_TASK' : 'LAND_PROMOTION'),
      phase: spec.phase ?? null,
      checks: spec.checks ?? [],
      aheadOfUpstream: spec.aheadOfUpstream ?? null,
      ...(spec.state === 'LANDED'
        ? { landedSha: 'b'.repeat(40), testedTreeSha: 'a'.repeat(40), landedTreeSha: 'a'.repeat(40) }
        : {}),
      taskId: spec.taskId ?? null,
      sessionId: spec.sessionId ?? null,
      promotionId: spec.promotionId ?? null,
      confirmedAutomatically: spec.confirmedAutomatically ?? false,
      progressProtocol: spec.progressProtocol ?? null,
      claimGeneration: spec.claimGeneration ?? 0,
      round: spec.round ?? null,
      step: spec.step ?? null,
      stepStartedAt: spec.stepStartedAt ?? null,
      outputMovedAt: spec.outputMovedAt ?? null,
      currentCheck: spec.currentCheck ?? Prisma.DbNull,
      cancelRequestedAt: spec.cancelRequestedAt ?? null,
      generation: spec.generation ?? 1,
      runnerId: spec.runnerId ?? null,
      serialKey: spec.serialKey
        ?? `${f.projectId}:${spec.targetRef ?? `refs/heads/project/${f.projectId}`}`,
      targetRef: spec.targetRef ?? `refs/heads/project/${f.projectId}`,
      upstreamRef: 'refs/heads/main',
      sourceRef: `refs/heads/orbit/${spec.idempotency}`,
      state: spec.state,
      createdAt: spec.at,
      claimedAt: spec.claimedAt ?? null,
      startedAt: spec.startedAt === undefined ? spec.claimedAt ?? null : spec.startedAt,
      heartbeatAt: spec.heartbeatAt ?? null,
      finishedAt: spec.finishedAt ?? null,
      idempotencyKey: `ij:v1:test:${f.projectId}:${spec.idempotency}`,
    },
  });
  return id;
}

/** The read under test, with the settings the endpoint hands it (never the thing being read). */
function read(db: PrismaClient, f: Fixture) {
  return readProjectIntegrationView(db as unknown as PrismaService, f.projectId, {
    line: 'PROJECT_BRANCH',
    lineAbsentReason: null,
    ref: `project/${f.projectId}`,
    upstreamRef: 'main',
    source: 'EXPLICIT',
    locked: true,
    startedAt: new Date('2026-09-25T13:00:00.000Z'),
    mergeCheckCommand: 'npm test',
    mergeCheckCommandAbsentReason: null,
    mergeCheckTimeoutSeconds: 900,
    escalationSeconds: 3600,
  });
}

/** The list row's in-flight job, which the session list's project row states: the same job, by the
 *  same rule, as the project page's line. */
async function listInFlight(db: PrismaClient, f: Fixture) {
  return (await readProjectIntegrationLines(db, [f.projectId])).get(f.projectId)?.inFlight;
}

/** An instant the spec names in words, so a case reads as the sequence it is describing. */
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 13, 58, 0) + seconds * 1000);

/** An instant this many minutes before now — the timeout is measured against the database's clock,
 *  so these cases stay whole minutes away from every limit they test. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** A runner of the fixture's owner, named the way the job list prints it. */
async function runner(db: PrismaClient, f: Fixture, name: string): Promise<string> {
  const id = randomUUID();
  await db.runner.create({ data: { id, name, ownerId: f.ownerId, tokenHash: `hash-${id}` } });
  return id;
}

/** The one job of a project's list, for the cases about a single job's limit. */
async function onlyJob(db: PrismaClient, f: Fixture) {
  const jobs = (await read(db, f)).inFlightJobs ?? [];
  assert.equal(jobs.length, 1);
  return jobs[0];
}

/** A runner the queue would claim with: online, leased, reporting now, taking integration jobs
 *  (and, when asked, landing Automatic merges too). */
async function usableRunner(
  db: PrismaClient,
  f: Fixture,
  name: string,
  capabilities: string[] = ['integration-job/v1'],
): Promise<string> {
  const id = randomUUID();
  await db.runner.create({
    data: {
      id, name, ownerId: f.ownerId, tokenHash: `hash-${id}`,
      status: RunnerStatus.ONLINE,
      capabilities,
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
      heartbeatLeaseOwner: randomUUID(),
    },
  });
  return id;
}

/** A workspace on that runner — the only one a claim can hand the job to (J-T2). */
async function workspaceOn(db: PrismaClient, f: Fixture, runnerId: string, label: string): Promise<string> {
  const id = randomUUID();
  await db.workspace.create({
    data: {
      id, ownerId: f.ownerId, runnerId, name: `${label}-workspace`, enabled: true,
      repoUrl: `https://git.invalid/${label}.git`, workDir: `/srv/${label}`,
    },
  });
  return id;
}

/** A session for a job to name, as production writes the work session it belongs to. */
async function sessionOf(
  db: PrismaClient,
  f: Fixture,
  workspaceId: string,
  opts: { taskId?: string | null; finished?: boolean; startsTaskWork?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: f.ownerId, creatorId: f.ownerId, workspaceId,
      taskId: opts.taskId ?? null, title: 'landing fixture', prompt: 'landing fixture',
      provider: 'claude', status: opts.finished ? RunStatus.SUCCEEDED : RunStatus.RUNNING,
      startsTaskWork: opts.startsTaskWork ?? false,
      startedAt: new Date(), ...(opts.finished ? { finishedAt: new Date() } : {}),
    },
  });
  return id;
}

/** Another project of an owner that already has one, bound to a repository of its own. */
async function projectOn(db: PrismaClient, ownerId: string, label: string): Promise<Fixture> {
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, ownerId, title: label } });
  const codebase = await db.projectCodebase.create({
    data: {
      projectId, ownerId, canonicalRepoUrl: `ssh://git@example.invalid/${label}`,
      upstreamRef: 'refs/heads/main', integrationRef: `refs/heads/project/${projectId}`,
      integrationRefSource: 'EXPLICIT', refAuthority: 'REMOTE',
    },
  });
  return { ownerId, projectId, codebaseId: codebase.id };
}

/** The OPEN INTEGRATION_CONFLICT item the claim's M2 condition reads. */
async function openItemFor(db: PrismaClient, f: Fixture, taskId: string, jobId: string): Promise<string> {
  const item = await db.projectOpenItem.create({
    data: {
      projectId: f.projectId, ownerId: f.ownerId, kind: 'INTEGRATION_CONFLICT', state: 'OPEN',
      assignee: 'OWNER', assigneeReason: 'NO_COORDINATOR', taskId, integrationJobId: jobId,
      dedupeKey: `IC:${jobId}:fixture`, title: 'A landing conflicted',
      payload: { files: ['a.txt'] }, waitingSince: new Date(), assignedAt: new Date(),
    },
    select: { id: true },
  });
  return item.id;
}

/** A passing or failing MERGE_CHECK result, in the shape `checks` (finished results) holds. */
function check(exitCode: number) {
  return { name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode,
    timedOut: false, durationMs: 100, outputTail: '' };
}

test('the landing line describes running work before the queue, on real PostgreSQL',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);

    try {
      await t.test('nothing in flight is the line’s absence, not a row with nothing in it',
        async () => {
          const f = await fixture(db, 'idle');
          await job(db, f, { at: at(0), claimedAt: at(1), finishedAt: at(60), state: 'CHECK_FAILED',
                             idempotency: 'finished' });

          const view = await read(db, f);

          assert.equal(view.inFlight, null);
          assert.equal(view.integratingCount, 0);
          assert.equal(view.queuedCount, 0);
          assert.equal((await readProjectIntegrationLines(db, [f.projectId]))
            .get(f.projectId)?.activeJobCount, 0);          assert.equal(await listInFlight(db, f), undefined);
        });

      await t.test('a queued job older than the running one cannot hide the running work', async () => {
        const f = await fixture(db, 'queued-first');
        const taskId = await task(db, f, 'T1 wiki 契约');
        await job(db, f, { at: at(0), state: 'QUEUED', idempotency: 'older' });
        const running = await job(db, f, { at: at(30), claimedAt: at(60), state: 'RUNNING', taskId,
                          phase: 'CHECK', heartbeatAt: at(65), idempotency: 'newer' });

        const view = await read(db, f);

        assert.deepEqual(view.inFlight, {
          taskTitle: 'T1 wiki 契约',
          kind: 'LAND_TASK',
          phase: 'CHECK',
          state: 'RUNNING',
          startedAt: at(60),
          heartbeatAt: at(65),
          // The wait it paid: enqueued at :30, claimed at :60.
          waitMs: 30_000,
          jobId: running,
          landingSessionId: null,
          taskId,
          promotionId: null,
          runner: null,
          claim: 0,
          round: null,
          check: null,
          stepStartedAt: null,
          outputMovedAt: null,
          progressProtocol: null,
          typicalMs: null,
          // A legacy claim whose last word was on 2026-09-25: silent past its lease.
          liveness: 'LEASE_EXPIRED',
          blockingReason: null,
        });
        assert.equal(view.integratingCount, 1);
        assert.equal(view.queuedCount, 1);
        assert.equal((await readProjectIntegrationLines(db, [f.projectId]))
          .get(f.projectId)?.activeJobCount, 2);        assert.deepEqual(await listInFlight(db, f), view.inFlight);
      });

      await t.test('a running job older than the queued one counts from its CLAIM, not its '
        + 'enqueue', async () => {
        const f = await fixture(db, 'running-first');
        const taskId = await task(db, f, 'T2 wiki 契约、迁移与共享类型');
        // Enqueued at 0, claimed at 10, and a second job enqueued at 30 — after the first was
        // already being checked. The claim is when the wait this card counts really began: measured
        // from the enqueue instead, the job that started first would read as the newer of the two.
        const running = await job(db, f, { at: at(0), claimedAt: at(10), state: 'RUNNING', taskId,
                                           idempotency: 'older' });
        await job(db, f, { at: at(30), state: 'QUEUED', idempotency: 'newer' });

        const view = await read(db, f);

        assert.deepEqual(view.inFlight, {
          taskTitle: 'T2 wiki 契约、迁移与共享类型',
          kind: 'LAND_TASK',
          phase: null,
          state: 'RUNNING',
          startedAt: at(10),
          heartbeatAt: null,
          waitMs: 10_000,
          jobId: running,
          landingSessionId: null,
          taskId,
          promotionId: null,
          runner: null,
          claim: 0,
          round: null,
          check: null,
          stepStartedAt: null,
          outputMovedAt: null,
          progressProtocol: null,
          typicalMs: null,
          liveness: 'LEASE_EXPIRED',
          blockingReason: null,
        });        assert.deepEqual(await listInFlight(db, f), view.inFlight);
      });

      await t.test('a job that names no task is described with a null title', async () => {
        const f = await fixture(db, 'promotion');
        // A promotion of the project's own branch lands no single task, so there is no title to
        // carry — and the row still says the platform is working.
        const promotion = await job(db, f, { at: at(0), claimedAt: at(10), state: 'RUNNING', taskId: null,
                           idempotency: 'promotion' });

        const view = await read(db, f);

        assert.deepEqual(view.inFlight, {
          taskTitle: null, kind: 'LAND_PROMOTION', phase: null,
          state: 'RUNNING', startedAt: at(10), heartbeatAt: null, waitMs: 10_000,
          jobId: promotion, taskId: null, landingSessionId: null, promotionId: null, runner: null, claim: 0,
          round: null, check: null, stepStartedAt: null, outputMovedAt: null,
          progressProtocol: null, typicalMs: null, liveness: 'LEASE_EXPIRED', blockingReason: null,
        });        assert.deepEqual(await listInFlight(db, f), view.inFlight);
      });

      await t.test('without a running job the oldest queued job counts from its enqueue', async () => {
        const f = await fixture(db, 'only-queued');
        const taskId = await task(db, f, 'Oldest queued task');
        await job(db, f, { at: at(30), state: 'QUEUED', idempotency: 'newer' });
        const older = await job(db, f, { at: at(0), state: 'QUEUED', taskId, idempotency: 'older' });

        assert.deepEqual((await read(db, f)).inFlight, {
          // A queued job's whole clock is the wait, so it carries no separate measurement of one.
          taskTitle: 'Oldest queued task', kind: 'LAND_TASK', phase: null,
          state: 'QUEUED', startedAt: at(0), heartbeatAt: null, waitMs: null,
          jobId: older, taskId, landingSessionId: null, promotionId: null, runner: null, claim: 0,
          round: null, check: null, stepStartedAt: null, outputMovedAt: null,
          progressProtocol: null, typicalMs: null, liveness: null,
          // No session, so there is no workspace whose runner could take it.
          blockingReason: {
            code: 'WAITING_RUNNER',
            summary: 'Waiting for a runner: the work’s workspace has no runner to land it',
          },
        });
        assert.deepEqual(await listInFlight(db, f), (await read(db, f)).inFlight);
      });

      await t.test('a promotion check carries its operation and every reported phase', async () => {
        const f = await fixture(db, 'check-promotion');
        const id = await job(db, f, {
          at: at(0), claimedAt: at(10), state: 'RUNNING', kind: 'CHECK_PROMOTION',
          phase: 'FETCH', idempotency: 'checking',
        });
        for (const phase of ['FETCH', 'MAIN_SYNC', 'REBASE', 'MERGE', 'CHECK', 'PUSH', 'VERIFY']) {
          await db.projectIntegrationJob.update({ where: { id }, data: { phase } });
          assert.deepEqual((await read(db, f)).inFlight, {
            taskTitle: null, kind: 'CHECK_PROMOTION', phase,
            state: 'RUNNING', startedAt: at(10), heartbeatAt: null, waitMs: 10_000,
            jobId: id, taskId: null, landingSessionId: null, promotionId: null, runner: null, claim: 0,
            round: null, check: null, stepStartedAt: null, outputMovedAt: null,
            progressProtocol: null, typicalMs: null, liveness: 'LEASE_EXPIRED', blockingReason: null,
          });
        }
      });

      await t.test('a finished job, and another project’s job, are both not in flight', async () => {
        const f = await fixture(db, 'settled');
        const other = await fixture(db, 'settled-other');
        const taskId = await task(db, f, 'T3 唯一写入口');
        await job(db, f, { at: at(0), claimedAt: at(1), finishedAt: at(60), state: 'CHECK_FAILED',
                           taskId, idempotency: 'failed', checks: [check(1)] });
        await job(db, other, { at: at(0), claimedAt: at(1), state: 'RUNNING', idempotency: 'theirs' });

        const view = await read(db, f);

        assert.equal(view.inFlight, null);
        assert.equal(view.integratingCount, 0);
        assert.equal(view.queuedCount, 0);
        assert.equal((await readProjectIntegrationLines(db, [f.projectId]))
          .get(f.projectId)?.activeJobCount, 0);
        assert.equal(await listInFlight(db, f), undefined);
        // The last attempt's failure remains visible even though no job is active.
        assert.equal(view.mergeCheckOnTip, 'FAILING');
      });

      await t.test('a failed attempt preserves the last successful distance measurement', async () => {
        const f = await fixture(db, 'failed-after-landed');
        const taskId = await task(db, f, 'Measured landing');
        await job(db, f, { at: at(0), finishedAt: at(10), state: 'LANDED', taskId,
          idempotency: 'landed', aheadOfUpstream: 3, checks: [check(0)] });
        await job(db, f, { at: at(20), finishedAt: at(30), state: 'CHECK_FAILED', taskId,
          idempotency: 'failed', checks: [check(1)] });

        const view = await read(db, f);
        assert.equal(view.commitsAheadOfUpstream, 3);
        assert.equal(view.commitsAheadOfUpstreamAbsentReason, null);
        assert.equal(view.mergeCheckOnTip, 'FAILING');
      });

      await t.test('successful or already landed jobs without checks are not passing checks', async () => {
        for (const state of ['LANDED', 'ALREADY_LANDED']) {
          const f = await fixture(db, `unchecked-${state.toLowerCase()}`);
          const taskId = await task(db, f, 'No check configured');
          await job(db, f, { at: at(0), finishedAt: at(10), state, taskId,
            idempotency: 'unchecked', aheadOfUpstream: 0 });
          assert.equal((await read(db, f)).mergeCheckOnTip, 'UNKNOWN');
        }
      });

      await t.test('a push failure does not erase the checks that actually passed', async () => {
        const f = await fixture(db, 'passed-checks-push-failed');
        const taskId = await task(db, f, 'Push failed');
        await job(db, f, { at: at(0), finishedAt: at(10), state: 'ERROR', taskId,
          idempotency: 'error', phase: 'PUSH', checks: [check(0)] });
        const view = await read(db, f);
        assert.equal(view.mergeCheckOnTip, 'PASSING');
        assert.equal(view.commitsAheadOfUpstream, null);
      });

      await t.test('(f) the job list carries every job the counts count, in the line’s order',
        async () => {
          const f = await fixture(db, 'job-list');
          const machine = await runner(db, f, 'workstation-gpu');
          const landing = await task(db, f, 'C5 · 登录后开通默认托管 runner');
          const waiting = await task(db, f, 'C6 · 容量准入');
          const running = await job(db, f, { at: minutesAgo(3), claimedAt: minutesAgo(2), state: 'RUNNING',
            taskId: landing, phase: 'REBASE', heartbeatAt: minutesAgo(1), runnerId: machine,
            generation: 2, idempotency: 'running' });
          const promotion = await job(db, f, { at: minutesAgo(5), state: 'QUEUED', idempotency: 'merge' });
          const queued = await job(db, f, { at: minutesAgo(1), state: 'QUEUED', taskId: waiting,
            idempotency: 'queued' });

          const view = await read(db, f);
          const jobs = view.inFlightJobs ?? [];

          assert.deepEqual(jobs.map((j) => j.jobId), [running, promotion, queued]);
          assert.deepEqual(jobs[0], {
            jobId: running, kind: 'LAND_TASK', state: 'RUNNING', phase: 'REBASE',
            taskId: landing, taskTitle: 'C5 · 登录后开通默认托管 runner', generation: 2,
            startedAt: jobs[0].startedAt, queuedAt: jobs[0].queuedAt, heartbeatAt: jobs[0].heartbeatAt,
            runnerName: 'workstation-gpu', retriedBy: null, timedOut: false, limitSeconds: 600,
            retryable: false,
            // A row claimed before the progress protocol existed — which is every fixture here — is
            // a legacy claim (§2.2 J-T4). The optional field travels on the wire from 0434.
            progressProtocol: null,
            // The landing-session fields travel beside it (0434's columns, §7.2 V6). A fixture
            // without them reads their empty forms: no promotion, no current check, no round.
            promotionId: null, claim: 0, round: null, check: null, stepStartedAt: null,
            outputMovedAt: null, typicalMs: null,
            // No landing subject was opened for this fixture's job, so there is no address to it.
            landingSessionId: null,
            // Claimed one minute before its last report, which is inside the lease.
            liveness: 'LEGACY', blockingReason: null,
          });
          assert.deepEqual(
            { taskTitle: jobs[0].taskTitle, kind: jobs[0].kind, phase: jobs[0].phase, state: jobs[0].state,
              startedAt: jobs[0].startedAt, heartbeatAt: jobs[0].heartbeatAt,
              // The line's own "Waited …", derived from the two instants the row above carries: a
              // claimed job's wait is its claim minus its enqueue (project-integration-line.ts).
              waitMs: jobs[0].startedAt.getTime() - jobs[0].queuedAt.getTime(),
              jobId: jobs[0].jobId, landingSessionId: jobs[0].landingSessionId,
              taskId: jobs[0].taskId, promotionId: jobs[0].promotionId,
              runner: jobs[0].runnerName, claim: jobs[0].claim, round: jobs[0].round,
              check: jobs[0].check, stepStartedAt: jobs[0].stepStartedAt,
              outputMovedAt: jobs[0].outputMovedAt, progressProtocol: jobs[0].progressProtocol,
              typicalMs: jobs[0].typicalMs, liveness: jobs[0].liveness,
              blockingReason: jobs[0].blockingReason },
            view.inFlight,
            'the first job is the one inFlight describes');
          assert.deepEqual(
            { taskId: jobs[1].taskId, taskTitle: jobs[1].taskTitle, kind: jobs[1].kind, phase: jobs[1].phase,
              runnerName: jobs[1].runnerName, timedOut: jobs[1].timedOut, limitSeconds: jobs[1].limitSeconds },
            { taskId: null, taskTitle: null, kind: 'LAND_PROMOTION', phase: null,
              runnerName: null, timedOut: false, limitSeconds: null },
            'a queued promotion names no task and has no limit yet');
          assert.equal(jobs[2].taskTitle, 'C6 · 容量准入');
          assert.equal(view.integratingCount + view.queuedCount, jobs.length);
        });

      await t.test('(g) a running job silent past the lease is timed out; one inside it is not',
        async () => {
          for (const [label, silent, timedOut] of [['quiet', 9, false], ['lost', 11, true]] as const) {
            const f = await fixture(db, `lease-${label}`);
            const taskId = await task(db, f, 'C5');
            // The claim the runner never answered: its heartbeat is the claim's own instant.
            await job(db, f, { at: minutesAgo(silent + 1), claimedAt: minutesAgo(silent), state: 'RUNNING',
              taskId, phase: 'FETCH', heartbeatAt: minutesAgo(silent), idempotency: label });
            const only = await onlyJob(db, f);
            assert.equal(only.limitSeconds, 600, label);
            assert.equal(only.timedOut, timedOut, label);
            assert.equal(only.retryable, timedOut, `${label}: a timed-out task landing takes a retry`);
          }
        });

      await t.test('(h) while checking, the limit is the check budgets plus the lease', async () => {
        for (const [label, silent, timedOut] of [['checking', 24, false], ['overdue', 26, true]] as const) {
          const f = await fixture(db, `check-${label}`);
          await db.projectCodebase.update({
            where: { id: f.codebaseId },
            data: { mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: 900 },
          });
          const taskId = await task(db, f, 'C2b');
          await job(db, f, { at: minutesAgo(silent + 2), claimedAt: minutesAgo(silent + 1), state: 'RUNNING',
            taskId, phase: 'CHECK', heartbeatAt: minutesAgo(silent), idempotency: label });
          const only = await onlyJob(db, f);
          assert.equal(only.limitSeconds, 900 + 600, label);
          assert.equal(only.timedOut, timedOut, label);
        }
      });

      await t.test('(i) a claim queued behind another job on its runner is waiting, not timed out',
        async () => {
          const f = await fixture(db, 'runner-turn');
          const other = await fixture(db, 'runner-turn-other');
          const machine = await runner(db, f, 'workstation-gpu');
          // Another project's merge check holds the runner's lock on main, on the same repository.
          const repo = (await db.projectCodebase.findUniqueOrThrow({ where: { id: f.codebaseId } }))
            .canonicalRepoUrl;
          await db.projectCodebase.update({ where: { id: other.codebaseId }, data: { canonicalRepoUrl: repo } });
          const holder = await job(db, other, { at: minutesAgo(40), claimedAt: minutesAgo(30), state: 'RUNNING',
            kind: 'CHECK_PROMOTION', phase: 'CHECK', heartbeatAt: minutesAgo(29), runnerId: machine,
            targetRef: 'refs/heads/main', idempotency: 'holder' });
          const waiting = await job(db, f, { at: minutesAgo(25), claimedAt: minutesAgo(20), state: 'RUNNING',
            kind: 'LAND_PROMOTION', phase: 'FETCH', heartbeatAt: minutesAgo(20), runnerId: machine,
            targetRef: 'refs/heads/main', idempotency: 'waiting' });

          assert.equal((await onlyJob(db, f)).timedOut, false, 'waiting its turn on the runner');

          // Once it has reported it is past the lock, and its silence is its own again.
          await db.projectIntegrationJob.update({ where: { id: waiting }, data: { heartbeatAt: minutesAgo(15) } });
          assert.equal((await onlyJob(db, f)).timedOut, true, 'reported, then silent past the lease');

          // And with nothing ahead of it, an unanswered claim is a lost one.
          await db.projectIntegrationJob.update({ where: { id: waiting }, data: { heartbeatAt: minutesAgo(20) } });
          await db.projectIntegrationJob.update({ where: { id: holder }, data: { state: 'CHECK_FAILED', finishedAt: minutesAgo(1) } });
          assert.equal((await onlyJob(db, f)).timedOut, true, 'nothing ahead of it on the runner');
        });

      // (j)–(p): the landing-session read model — blocking reasons for all three kinds, the
      // runner's local lock, the five liveness values, and the typical duration of a merge check.

      await t.test('(j) the three kinds say what holds a queued job, as the claim reads it', async () => {
        const f = await fixture(db, 'queue-reasons');
        const machine = await usableRunner(db, f, 'queue-runner');
        const ws = await workspaceOn(db, f, machine, 'queue-reasons');
        const workTask = await task(db, f, 'Waits on its own work');
        const heldSession = await sessionOf(db, f, ws, { taskId: workTask, startsTaskWork: true });
        const held = await job(db, f, { at: at(0), state: 'QUEUED', taskId: workTask,
          sessionId: heldSession, idempotency: 'held' });

        const promotionTask = await task(db, f, 'Waits on the task its branch froze');
        const frozenSession = await sessionOf(db, f, ws, { taskId: promotionTask, finished: true });
        await sessionOf(db, f, ws, { taskId: promotionTask, startsTaskWork: true });
        const checked = await job(db, f, { at: at(1), state: 'QUEUED', kind: 'CHECK_PROMOTION',
          sessionId: frozenSession, idempotency: 'checked' });

        const dispatchSession = await sessionOf(db, f, ws);
        const dispatches = await job(db, f, { at: at(2), state: 'QUEUED', kind: 'LAND_PROMOTION',
          sessionId: dispatchSession, idempotency: 'dispatch' });

        const jobs = (await read(db, f)).inFlightJobs ?? [];
        const reasonOf = (id: string) => jobs.find((entry) => entry.jobId === id)?.blockingReason;
        assert.deepEqual(reasonOf(held), {
          code: 'WAITING_TASK_WORK',
          summary: 'Waiting to land: the task’s work session is still running, and its branch can still move',
        });
        assert.deepEqual(reasonOf(checked), {
          code: 'WAITING_TASK_WORK',
          summary: 'Waiting to land: the task’s work session is still running, and its branch can still move',
        }, 'a promotion check is held by the work its branch froze');
        assert.deepEqual(reasonOf(dispatches), {
          code: 'WAITING_DISPATCH',
          summary: 'Waiting to land: next for runner queue-runner, which claims it on its next heartbeat',
        });
      });

      await t.test('(k) a serial wait names another account’s job by its reason alone', async () => {
        const f = await fixture(db, 'serial-mine');
        const shared = `repo-serial-${f.projectId}`;
        const machine = await usableRunner(db, f, 'serial-runner');
        const ws = await workspaceOn(db, f, machine, 'serial-mine');
        const mineSession = await sessionOf(db, f, ws);
        const queued = await job(db, f, { at: minutesAgo(2), state: 'QUEUED', kind: 'LAND_PROMOTION',
          sessionId: mineSession, serialKey: shared, targetRef: 'refs/heads/main', idempotency: 'queued' });

        const otherProject = await projectOn(db, f.ownerId, 'serial-mine-other');
        const blockerTask = await task(db, otherProject, 'Their merge');
        const holder = await job(db, otherProject, { at: minutesAgo(5), claimedAt: minutesAgo(4),
          state: 'RUNNING', taskId: blockerTask, serialKey: shared, targetRef: 'refs/heads/main',
          heartbeatAt: minutesAgo(3), idempotency: 'holder' });
        let reason = ((await read(db, f)).inFlightJobs ?? [])
          .find((entry) => entry.jobId === queued)?.blockingReason;
        assert.deepEqual(reason, {
          code: 'WAITING_SERIAL_SLOT',
          summary: 'Waiting to land: the landing of “Their merge” is running on this branch first',
          jobId: holder,
        });

        // Ended, so another account's landing can hold the same repository and ref.
        await db.projectIntegrationJob.update({ where: { id: holder },
          data: { state: 'CHECK_FAILED', finishedAt: minutesAgo(1) } });
        const theirs = await fixture(db, 'serial-theirs');
        const theirTask = await task(db, theirs, 'Another account’s merge');
        await job(db, theirs, { at: minutesAgo(5), claimedAt: minutesAgo(4), state: 'RUNNING',
          taskId: theirTask, serialKey: shared, targetRef: 'refs/heads/main',
          heartbeatAt: minutesAgo(3), idempotency: 'theirs' });
        reason = ((await read(db, f)).inFlightJobs ?? [])
          .find((entry) => entry.jobId === queued)?.blockingReason;
        assert.deepEqual(reason, {
          code: 'WAITING_SERIAL_SLOT',
          summary: 'Waiting to land: another integration job is running on this branch first',
        }, 'no id and no title from another account');
      });

      await t.test('(l) an open MAIN_SYNC conflict holds later landings, named only within the account',
        async () => {
          const f = await fixture(db, 'sync-hold');
          const shared = `repo-sync-${f.projectId}`;
          const machine = await usableRunner(db, f, 'sync-runner');
          const ws = await workspaceOn(db, f, machine, 'sync-hold');
          const mineSession = await sessionOf(db, f, ws);
          const queued = await job(db, f, { at: minutesAgo(2), state: 'QUEUED', kind: 'LAND_PROMOTION',
            sessionId: mineSession, serialKey: shared, targetRef: 'refs/heads/main', idempotency: 'queued' });

          const otherProject = await projectOn(db, f.ownerId, 'sync-hold-other');
          const conflicted = await task(db, otherProject, 'Their conflicted landing');
          const failed = await job(db, otherProject, { at: minutesAgo(9), claimedAt: minutesAgo(8),
            state: 'CONFLICT', phase: 'MAIN_SYNC', taskId: conflicted, serialKey: shared,
            targetRef: 'refs/heads/main', finishedAt: minutesAgo(7), idempotency: 'failed' });
          const item = await openItemFor(db, otherProject, conflicted, failed);
          let reason = ((await read(db, f)).inFlightJobs ?? [])
            .find((entry) => entry.jobId === queued)?.blockingReason;
          assert.deepEqual(reason, {
            code: 'WAITING_MAIN_SYNC',
            summary: 'Waiting for the project line to sync: the landing of “Their conflicted landing” '
              + 'could not merge upstream into this branch, and its conflict is still open',
            jobId: failed,
            openItemId: item,
          });

          // Another account's conflict is the reason alone.
          await db.projectOpenItem.delete({ where: { id: item } });
          const theirs = await fixture(db, 'sync-hold-theirs');
          const theirTask = await task(db, theirs, 'Another account’s conflict');
          const theirFailed = await job(db, theirs, { at: minutesAgo(9), claimedAt: minutesAgo(8),
            state: 'CONFLICT', phase: 'MAIN_SYNC', taskId: theirTask, serialKey: shared,
            targetRef: 'refs/heads/main', finishedAt: minutesAgo(7), idempotency: 'failed' });
          await openItemFor(db, theirs, theirTask, theirFailed);
          reason = ((await read(db, f)).inFlightJobs ?? [])
            .find((entry) => entry.jobId === queued)?.blockingReason;
          assert.deepEqual(reason, {
            code: 'WAITING_MAIN_SYNC',
            summary: 'Waiting for the project line to sync: an earlier landing could not merge upstream '
              + 'into this branch, and its conflict is still open',
          }, 'no id and no title from another account');
        });

      await t.test('(m) an automatic merge waits for a runner that declares promotion-automatic-land/v1',
        async () => {
          const f = await fixture(db, 'automatic-wait');
          const plain = await usableRunner(db, f, 'plain-runner');
          const plainWs = await workspaceOn(db, f, plain, 'automatic-wait');
          const plainSession = await sessionOf(db, f, plainWs);
          const waiting = await job(db, f, { at: minutesAgo(3), state: 'QUEUED', kind: 'LAND_PROMOTION',
            sessionId: plainSession, confirmedAutomatically: true, targetRef: 'refs/heads/main',
            idempotency: 'automatic' });

          const able = await usableRunner(db, f, 'landing-runner',
            ['integration-job/v1', 'promotion-automatic-land/v1']);
          const ableWs = await workspaceOn(db, f, able, 'automatic-able');
          const ableSession = await sessionOf(db, f, ableWs);
          const dispatch = await job(db, f, { at: minutesAgo(2), state: 'QUEUED', kind: 'LAND_PROMOTION',
            sessionId: ableSession, confirmedAutomatically: true, targetRef: 'refs/heads/merge',
            idempotency: 'automatic-able' });

          const jobs = (await read(db, f)).inFlightJobs ?? [];
          assert.deepEqual(jobs.find((entry) => entry.jobId === waiting)?.blockingReason, {
            code: 'WAITING_AUTOMATIC_RUNNER',
            summary: 'Waiting for runner plain-runner: it cannot land a merge the Automatic setting '
              + 'approved, which needs promotion-automatic-land/v1',
          });
          assert.equal(jobs.find((entry) => entry.jobId === dispatch)?.blockingReason?.code,
            'WAITING_DISPATCH', 'a runner that declares it is handed the merge');
        });

      await t.test('(n) a historical queued cancellation is CANCELLING for every kind', async () => {
        const f = await fixture(db, 'cancelling');
        const cancelledAt = minutesAgo(1);
        // The rows this reason exists for were written before J-T8, when a QUEUED stop request was
        // only a column; 0433's CHECK now forbids creating one. Dropped for this fixture alone.
        await db.$executeRawUnsafe(
          'ALTER TABLE "project_integration_job" DROP CONSTRAINT IF EXISTS "project_integration_job_queued_cancel_chk"');
        const ids: string[] = [];
        try {
          const landingTask = await task(db, f, 'Cancelled landing');
          ids.push(await job(db, f, { at: at(0), state: 'QUEUED', taskId: landingTask,
            cancelRequestedAt: cancelledAt, idempotency: 'cancel-land' }));
          ids.push(await job(db, f, { at: at(1), state: 'QUEUED', kind: 'CHECK_PROMOTION',
            cancelRequestedAt: cancelledAt, idempotency: 'cancel-check' }));
          ids.push(await job(db, f, { at: at(2), state: 'QUEUED', kind: 'LAND_PROMOTION',
            cancelRequestedAt: cancelledAt, idempotency: 'cancel-promotion' }));

          const jobs = (await read(db, f)).inFlightJobs ?? [];
          for (const id of ids) {
            assert.deepEqual(jobs.find((entry) => entry.jobId === id)?.blockingReason, {
              code: 'CANCELLING',
              summary: 'Waiting to land: it was cancelled and will not start',
            });
          }
        } finally {
          await db.projectIntegrationJob.deleteMany({ where: { id: { in: ids } } });
          await db.$executeRawUnsafe('ALTER TABLE "project_integration_job" ADD CONSTRAINT '
            + '"project_integration_job_queued_cancel_chk" CHECK ("state" <> \'QUEUED\' '
            + 'OR "cancel_requested_at" IS NULL) NOT VALID');
          await db.$executeRawUnsafe('ALTER TABLE "project_integration_job" '
            + 'VALIDATE CONSTRAINT "project_integration_job_queued_cancel_chk"');
        }
      });

      await t.test('(o) a claimed job waiting on the runner’s local lock says so, for every kind',
        async () => {
          const f = await fixture(db, 'local-lock');
          const ids: string[] = [];
          for (const [index, kind] of (['LAND_TASK', 'CHECK_PROMOTION', 'LAND_PROMOTION'] as const)
            .entries()) {
            ids.push(await job(db, f, {
              at: minutesAgo(3), claimedAt: minutesAgo(2), state: 'RUNNING', kind,
              taskId: kind === 'LAND_TASK' ? await task(db, f, `Local lock ${kind}`) : null,
              progressProtocol: 'v2', step: 'WAITING_LOCAL_LOCK', stepStartedAt: minutesAgo(2),
              heartbeatAt: minutesAgo(1), outputMovedAt: minutesAgo(1),
              targetRef: `refs/heads/local-${index}`, serialKey: `local-lock-${index}`,
              idempotency: `local-${index}`,
            }));
          }
          const jobs = (await read(db, f)).inFlightJobs ?? [];
          for (const id of ids) {
            const entry = jobs.find((candidate) => candidate.jobId === id);
            assert.deepEqual(entry?.blockingReason, {
              code: 'WAITING_LOCAL_LOCK',
              summary: 'Waiting for another job on this runner: it is using this repository and target branch',
            });
            assert.equal(entry?.liveness, 'LIVE');
          }

          // A legacy claim says the same thing by being behind an earlier claim on the runner.
          const g = await fixture(db, 'legacy-lock');
          const other = await fixture(db, 'legacy-lock-holder');
          const machine = await usableRunner(db, g, 'legacy-runner');
          const repo = (await db.projectCodebase.findUniqueOrThrow({ where: { id: g.codebaseId } }))
            .canonicalRepoUrl;
          await db.projectCodebase.update({
            where: { id: other.codebaseId }, data: { canonicalRepoUrl: repo },
          });
          await job(db, other, { at: minutesAgo(40), claimedAt: minutesAgo(30), state: 'RUNNING',
            kind: 'CHECK_PROMOTION', phase: 'CHECK', heartbeatAt: minutesAgo(29), runnerId: machine,
            targetRef: 'refs/heads/main', idempotency: 'holder' });
          const waiting = await job(db, g, { at: minutesAgo(25), claimedAt: minutesAgo(20),
            state: 'RUNNING', kind: 'LAND_PROMOTION', phase: 'FETCH', heartbeatAt: minutesAgo(20),
            runnerId: machine, targetRef: 'refs/heads/main', idempotency: 'waiting' });
          const legacy = ((await read(db, g)).inFlightJobs ?? [])
            .find((entry) => entry.jobId === waiting);
          assert.equal(legacy?.timedOut, false, 'waiting its turn is not a lost runner');
          assert.deepEqual(legacy?.blockingReason, {
            code: 'WAITING_LOCAL_LOCK',
            summary: 'Waiting for another job on this runner: it is using this repository and target branch',
          });
          assert.equal(legacy?.liveness, 'LEGACY');
        });

      await t.test('(p) the five liveness values ride on v2 and legacy claims', async () => {
        const cases: Array<{ label: string; protocol: string | null; heartbeatAgo: number;
                             outputAgo: number | null; liveness: string }> = [
          { label: 'live', protocol: 'v2', heartbeatAgo: 0.5, outputAgo: 2, liveness: 'LIVE' },
          { label: 'quiet', protocol: 'v2', heartbeatAgo: 0.5, outputAgo: 11, liveness: 'QUIET' },
          { label: 'silent', protocol: 'v2', heartbeatAgo: 2, outputAgo: 1, liveness: 'SILENT' },
          { label: 'expired', protocol: 'v2', heartbeatAgo: 11, outputAgo: 1, liveness: 'LEASE_EXPIRED' },
          { label: 'legacy', protocol: null, heartbeatAgo: 1, outputAgo: null, liveness: 'LEGACY' },
        ];
        for (const spec of cases) {
          const f = await fixture(db, `liveness-${spec.label}`);
          const id = await job(db, f, {
            at: minutesAgo(12), claimedAt: minutesAgo(12), state: 'RUNNING', kind: 'LAND_PROMOTION',
            phase: 'CHECK', progressProtocol: spec.protocol,
            heartbeatAt: minutesAgo(spec.heartbeatAgo),
            outputMovedAt: spec.outputAgo === null ? null : minutesAgo(spec.outputAgo),
            idempotency: spec.label,
          });
          const entry = (await read(db, f)).inFlightJobs?.[0];
          assert.equal(entry?.jobId, id);
          assert.equal(entry?.liveness, spec.liveness, spec.label);
        }
      });

      await t.test('(q) every new field on a live v2 job, and the legacy claim beside it', async () => {
        const f = await fixture(db, 'v2-fields');
        const machine = await usableRunner(db, f, 'v2-runner');
        const taskId = await task(db, f, 'A live v2 landing');
        const queuedAt = minutesAgo(6);
        const startedAt = minutesAgo(4);
        const heartbeatAt = minutesAgo(0.5);
        const checkStartedAt = minutesAgo(3);
        const outputMovedAt = minutesAgo(1);
        const promotionId = (await db.projectPromotion.create({
          data: {
            projectId: f.projectId, ownerId: f.ownerId, codebaseId: f.codebaseId,
            sourceKind: 'PROJECT_BRANCH', sourceRef: `refs/heads/project/${f.projectId}`,
            upstreamRef: 'refs/heads/main', includedTaskIds: [], state: 'CHECKING',
          },
          select: { id: true },
        })).id;
        const running = await job(db, f, {
          at: queuedAt, claimedAt: startedAt, state: 'RUNNING', taskId,
          runnerId: machine, progressProtocol: 'v2', claimGeneration: 2, round: 2,
          step: 'PREPARE', stepStartedAt: checkStartedAt, outputMovedAt,
          heartbeatAt,
          currentCheck: { name: 'MERGE_CHECK', index: 1, count: 2, budgetSeconds: 3600,
            startedAt: checkStartedAt.toISOString() },
          idempotency: 'v2',
        });
        await job(db, f, {
          at: minutesAgo(5), claimedAt: minutesAgo(5), state: 'RUNNING', kind: 'LAND_PROMOTION',
          promotionId, runnerId: machine, heartbeatAt: minutesAgo(1), progressProtocol: 'v2',
          targetRef: 'refs/heads/merge', serialKey: 'v2-fields-promotion', idempotency: 'promotion',
        });

        const view = await read(db, f);
        const entry = view.inFlightJobs?.find((candidate) => candidate.jobId === running);
        assert.deepEqual(entry, {
          jobId: running, kind: 'LAND_TASK', state: 'RUNNING', phase: null, taskId,
          taskTitle: 'A live v2 landing', promotionId: null, generation: 1,
          startedAt, queuedAt, heartbeatAt,
          runnerName: 'v2-runner', retriedBy: null, timedOut: false, limitSeconds: 600,
          progressProtocol: 'v2', claim: 2, round: 2,
          check: { name: 'MERGE_CHECK', index: 1, count: 2, budgetSeconds: 3600,
            startedAt: checkStartedAt },
          stepStartedAt: checkStartedAt, outputMovedAt, typicalMs: null,
          // This fixture writes its jobs directly, with no landing subject beside them.
          landingSessionId: null,
          liveness: 'LIVE', blockingReason: null, retryable: false,
        });
        const promotion = view.inFlightJobs?.find((entry) => entry.kind === 'LAND_PROMOTION');
        assert.equal(promotion?.promotionId, promotionId);
        assert.equal(promotion?.progressProtocol, 'v2');
        assert.equal(promotion?.claim, 0);
        assert.equal(promotion?.check, null);
        assert.deepEqual(await listInFlight(db, f), view.inFlight, 'the list and the view agree');
      });

      await t.test('(r) typicalMs is the middle of PASSING merge checks, from their last claim',
        async () => {
          const f = await fixture(db, 'typical');
          const base = new Date('2026-10-01T10:00:00Z');
          const minutes = (n: number) => new Date(base.getTime() + n * 60_000);
          // Three passing runs of 10, 20 and 10 minutes from their LAST claim; the third began an
          // hour earlier under a claim that was given back (J-T11 keeps `started_at`). The failing
          // run must not be a sample: 10, 10, 20 has its middle at 10m, while including the failure
          // (60m) or measuring from `started_at` (40m) would read 15m or 20m.
          await job(db, f, { at: minutes(0), claimedAt: minutes(0), startedAt: minutes(0),
            finishedAt: minutes(10), state: 'ALREADY_LANDED', checks: [check(0)],
            idempotency: 'passed-10' });
          await job(db, f, { at: minutes(20), claimedAt: minutes(20), startedAt: minutes(20),
            finishedAt: minutes(40), state: 'ALREADY_LANDED', checks: [check(0)],
            idempotency: 'passed-20' });
          await job(db, f, { at: minutes(0), claimedAt: minutes(30), startedAt: minutes(0),
            finishedAt: minutes(40), state: 'ALREADY_LANDED', checks: [check(0)],
            idempotency: 'passed-requeued' });
          await job(db, f, { at: minutes(40), claimedAt: minutes(40), startedAt: minutes(40),
            finishedAt: minutes(100), state: 'CHECK_FAILED', checks: [check(1)],
            idempotency: 'failed-60' });

          const running = await job(db, f, {
            at: minutesAgo(2), claimedAt: minutesAgo(1), state: 'RUNNING', kind: 'LAND_PROMOTION',
            progressProtocol: 'v2', heartbeatAt: minutesAgo(0.5),
            currentCheck: { name: 'MERGE_CHECK', index: 1, count: 1, budgetSeconds: 3600,
              startedAt: minutesAgo(1).toISOString() },
            idempotency: 'running',
          });
          const entry = (await read(db, f)).inFlightJobs?.find((job) => job.jobId === running);
          assert.equal(entry?.typicalMs, 10 * 60_000);

          // Only a MERGE_CHECK has a usual duration: a task's own acceptance command is not one.
          const g = await fixture(db, 'typical-task');
          const taskAcceptance = await job(db, g, {
            at: minutesAgo(2), claimedAt: minutesAgo(1), state: 'RUNNING',
            progressProtocol: 'v2', heartbeatAt: minutesAgo(0.5),
            currentCheck: { name: 'TASK_ACCEPTANCE', index: 1, count: 2, budgetSeconds: 900,
              startedAt: minutesAgo(1).toISOString() },
            idempotency: 'task-check',
          });
          assert.equal(((await read(db, g)).inFlightJobs ?? [])
            .find((job) => job.jobId === taskAcceptance)?.typicalMs, null);
        });

      await t.test('(s) a job names its landing session in the line and in the job list, and the '
        + 'session survives on a queued job too', async () => {
        const f = await fixture(db, 'landing-session');
        const taskId = await task(db, f, 'C7 · 落地有自己的会话');
        const queuedTaskId = await task(db, f, 'C8 · 排队中的落地');
        const runningLanding = { id: randomUUID(), sessionId: randomUUID(), taskId };
        const queuedLanding = { id: randomUUID(), sessionId: randomUUID(), taskId: queuedTaskId };
        for (const landing of [runningLanding, queuedLanding]) {
          await db.projectLanding.create({
            data: {
              id: landing.id, projectId: f.projectId, ownerId: f.ownerId, codebaseId: f.codebaseId,
              subject: 'TASK', taskId: landing.taskId, episode: 1, sessionId: landing.sessionId,
            },
          });
        }
        // A RUNNING job and a QUEUED one, each on its own task's landing (J3 allows one in-flight
        // landing per task): the line describes the running one and the list carries both.
        const running = await job(db, f, {
          at: at(0), claimedAt: at(10), state: 'RUNNING', taskId,
          landingId: runningLanding.id, idempotency: 'with-session',
        });
        const queued = await job(db, f, {
          at: at(20), state: 'QUEUED', taskId: queuedTaskId, landingId: queuedLanding.id,
          idempotency: 'queued-session', serialKey: `${f.projectId}:refs/heads/other`,
        });

        const view = await read(db, f);
        assert.equal(view.inFlight?.jobId, running);
        assert.equal(view.inFlight?.landingSessionId, runningLanding.sessionId,
          'the line opens the landing its job belongs to');
        const jobs = view.inFlightJobs ?? [];
        assert.equal(jobs.find((entry) => entry.jobId === running)?.landingSessionId,
          runningLanding.sessionId, 'the job list lost the running landing');
        assert.equal(jobs.find((entry) => entry.jobId === queued)?.landingSessionId,
          queuedLanding.sessionId, 'a queued job carries the landing it will join');
        // Every entry carries the field — the ones with a subject and the ones without — so a list
        // row and the page describe one job the same way.
        assert.ok(jobs.every((entry) => 'landingSessionId' in entry),
          'an in-flight job did not state its landing session at all');
        assert.deepEqual(await listInFlight(db, f), view.inFlight,
          'the list row and the view agree, field by field');
      });
    } finally {
      await db.$disconnect();
      // Both halves of the harness: the `pg` Client holds an open socket, and a spec that leaves it
      // connected never lets `node --test` exit — a green run that hangs until the timeout kills it
      // reads as a red one.
      await identity.end();
    }
  });
