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
          checks?: Prisma.InputJsonValue; aheadOfUpstream?: number },
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
      serialKey: `${f.projectId}:refs/heads/project/${f.projectId}`,
      targetRef: `refs/heads/project/${f.projectId}`,
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
          state: 'RUNNING', startedAt: at(10), heartbeatAt: null,
        });        assert.deepEqual(await listInFlight(db, f), view.inFlight);
      });

      await t.test('without a running job the oldest queued job counts from its enqueue', async () => {
        const f = await fixture(db, 'only-queued');
        const taskId = await task(db, f, 'Oldest queued task');
        await job(db, f, { at: at(30), state: 'QUEUED', idempotency: 'newer' });
        await job(db, f, { at: at(0), state: 'QUEUED', taskId, idempotency: 'older' });

        assert.deepEqual((await read(db, f)).inFlight, {
          taskTitle: 'Oldest queued task', kind: 'LAND_TASK', phase: null,
          state: 'QUEUED', startedAt: at(0), heartbeatAt: null,
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
            state: 'RUNNING', startedAt: at(10), heartbeatAt: null,
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
