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
import { CreatorType, Prisma, PrismaClient, TaskStatus } from '@prisma/client';
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
  spec: { at: Date; claimedAt?: Date; finishedAt?: Date; heartbeatAt?: Date; state: string;
          taskId?: string | null; idempotency: string;
          kind?: IntegrationJobKind; phase?: IntegrationJobPhase | null;
          checks?: Prisma.InputJsonValue; aheadOfUpstream?: number;
          runnerId?: string; targetRef?: string; generation?: number },
): Promise<string> {
  const id = randomUUID();
  await db.projectIntegrationJob.create({
    data: {
      id,
      projectId: f.projectId,
      ownerId: f.ownerId,
      codebaseId: f.codebaseId,
      kind: spec.kind ?? (spec.taskId ? 'LAND_TASK' : 'LAND_PROMOTION'),
      phase: spec.phase ?? null,
      checks: spec.checks ?? [],
      aheadOfUpstream: spec.aheadOfUpstream ?? null,
      ...(spec.state === 'LANDED'
        ? { landedSha: 'b'.repeat(40), testedTreeSha: 'a'.repeat(40), landedTreeSha: 'a'.repeat(40) }
        : {}),
      taskId: spec.taskId ?? null,
      generation: spec.generation ?? 1,
      runnerId: spec.runnerId ?? null,
      serialKey: `${f.projectId}:${spec.targetRef ?? `refs/heads/project/${f.projectId}`}`,
      targetRef: spec.targetRef ?? `refs/heads/project/${f.projectId}`,
      upstreamRef: 'refs/heads/main',
      sourceRef: `refs/heads/orbit/${spec.idempotency}`,
      state: spec.state,
      createdAt: spec.at,
      claimedAt: spec.claimedAt ?? null,
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
        await job(db, f, { at: at(30), claimedAt: at(60), state: 'RUNNING', taskId,
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
        await job(db, f, { at: at(0), claimedAt: at(10), state: 'RUNNING', taskId, idempotency: 'older' });
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
        });        assert.deepEqual(await listInFlight(db, f), view.inFlight);
      });

      await t.test('a job that names no task is described with a null title', async () => {
        const f = await fixture(db, 'promotion');
        // A promotion of the project's own branch lands no single task, so there is no title to
        // carry — and the row still says the platform is working.
        await job(db, f, { at: at(0), claimedAt: at(10), state: 'RUNNING', taskId: null,
                           idempotency: 'promotion' });

        const view = await read(db, f);

        assert.deepEqual(view.inFlight, {
          taskTitle: null, kind: 'LAND_PROMOTION', phase: null,
          state: 'RUNNING', startedAt: at(10), heartbeatAt: null, waitMs: 10_000,
        });        assert.deepEqual(await listInFlight(db, f), view.inFlight);
      });

      await t.test('without a running job the oldest queued job counts from its enqueue', async () => {
        const f = await fixture(db, 'only-queued');
        const taskId = await task(db, f, 'Oldest queued task');
        await job(db, f, { at: at(30), state: 'QUEUED', idempotency: 'newer' });
        await job(db, f, { at: at(0), state: 'QUEUED', taskId, idempotency: 'older' });

        assert.deepEqual((await read(db, f)).inFlight, {
          // A queued job's whole clock is the wait, so it carries no separate measurement of one.
          taskTitle: 'Oldest queued task', kind: 'LAND_TASK', phase: null,
          state: 'QUEUED', startedAt: at(0), heartbeatAt: null, waitMs: null,
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
          });
          assert.deepEqual(
            { taskTitle: jobs[0].taskTitle, kind: jobs[0].kind, phase: jobs[0].phase, state: jobs[0].state,
              startedAt: jobs[0].startedAt, heartbeatAt: jobs[0].heartbeatAt,
              // The line's own "Waited …", derived from the two instants the row above carries: a
              // claimed job's wait is its claim minus its enqueue (project-integration-line.ts).
              waitMs: jobs[0].startedAt.getTime() - jobs[0].queuedAt.getTime() },
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
    } finally {
      await db.$disconnect();
      // Both halves of the harness: the `pg` Client holds an open socket, and a spec that leaves it
      // connected never lets `node --test` exit — a green run that hangs until the timeout kills it
      // reads as a red one.
      await identity.end();
    }
  });

function check(exitCode: number) {
  return { name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode,
    timedOut: false, durationMs: 100, outputTail: '' };
}
