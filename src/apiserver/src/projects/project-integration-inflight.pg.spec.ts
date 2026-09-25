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
 * the one case anybody would write by hand (a single running job with a task): the OLDEST rule only
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
 *  (b) Two jobs in flight, the OLDER one queued and the newer one running: the queued one is
 *      described, and its clock starts at its `created_at`, since a job that was never claimed has
 *      no `claimed_at` to count from.
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
import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readProjectIntegrationView } from './project-integration-line';

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
      refAuthority: 'RUNNER',
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
 * RUNNING. `at` is the enqueue, `claimedAt` the claim when there is one.
 */
async function job(
  db: PrismaClient,
  f: Fixture,
  spec: { at: Date; claimedAt?: Date; state: string; taskId?: string | null; idempotency: string },
): Promise<string> {
  const id = randomUUID();
  await db.projectIntegrationJob.create({
    data: {
      id,
      projectId: f.projectId,
      ownerId: f.ownerId,
      codebaseId: f.codebaseId,
      kind: spec.taskId ? 'LAND_TASK' : 'LAND_PROMOTION',
      taskId: spec.taskId ?? null,
      serialKey: `${f.projectId}:refs/heads/project/${f.projectId}`,
      targetRef: `refs/heads/project/${f.projectId}`,
      upstreamRef: 'refs/heads/main',
      sourceRef: `refs/heads/orbit/${spec.idempotency}`,
      state: spec.state,
      createdAt: spec.at,
      claimedAt: spec.claimedAt ?? null,
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

/** An instant the spec names in words, so a case reads as the sequence it is describing. */
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 13, 58, 0) + seconds * 1000);

test('the landing line describes the oldest job in flight, on real PostgreSQL',
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
          await job(db, f, { at: at(0), state: 'LANDED', idempotency: 'finished' });

          const view = await read(db, f);

          assert.equal(view.inFlight, null);
          assert.equal(view.integratingCount, 0);
          assert.equal(view.queuedCount, 0);
        });

      await t.test('a queued job older than the running one is the one described, counted from '
        + 'its enqueue', async () => {
        const f = await fixture(db, 'queued-first');
        const taskId = await task(db, f, 'T1 wiki 契约');
        // Queued a minute before the other was claimed: the queue serves it first, and the card
        // must not reset its clock to the job that overtook it — or name that job's task.
        await job(db, f, { at: at(0), state: 'QUEUED', taskId, idempotency: 'older' });
        await job(db, f, { at: at(30), claimedAt: at(60), state: 'RUNNING', idempotency: 'newer' });

        const view = await read(db, f);

        assert.deepEqual(view.inFlight, {
          taskTitle: 'T1 wiki 契约',
          state: 'QUEUED',
          startedAt: at(0),
        });
        assert.equal(view.integratingCount, 1);
        assert.equal(view.queuedCount, 1);
      });

      await t.test('a running job older than the queued one counts from its CLAIM, not its '
        + 'enqueue', async () => {
        const f = await fixture(db, 'running-first');
        const taskId = await task(db, f, 'T2 wiki 契约、迁移与共享类型');
        // Enqueued at 0, claimed at 60, a second job enqueued at 30. The claim is when the wait
        // this card counts really began, and it is also what makes this job the oldest.
        await job(db, f, { at: at(0), claimedAt: at(60), state: 'RUNNING', taskId, idempotency: 'older' });
        await job(db, f, { at: at(30), state: 'QUEUED', idempotency: 'newer' });

        const view = await read(db, f);

        assert.deepEqual(view.inFlight, {
          taskTitle: 'T2 wiki 契约、迁移与共享类型',
          state: 'RUNNING',
          startedAt: at(60),
        });
      });

      await t.test('a job that names no task is described with a null title', async () => {
        const f = await fixture(db, 'promotion');
        // A promotion of the project's own branch lands no single task, so there is no title to
        // carry — and the row still says the platform is working.
        await job(db, f, { at: at(0), claimedAt: at(10), state: 'RUNNING', taskId: null,
                           idempotency: 'promotion' });

        const view = await read(db, f);

        assert.deepEqual(view.inFlight, { taskTitle: null, state: 'RUNNING', startedAt: at(10) });
      });

      await t.test('a finished job, and another project’s job, are both not in flight', async () => {
        const f = await fixture(db, 'settled');
        const other = await fixture(db, 'settled-other');
        await job(db, f, { at: at(0), claimedAt: at(1), state: 'CHECK_FAILED', idempotency: 'failed' });
        await job(db, other, { at: at(0), claimedAt: at(1), state: 'RUNNING', idempotency: 'theirs' });

        const view = await read(db, f);

        assert.equal(view.inFlight, null);
        // The newest finished job still answers the tip — a job that did not run its checks to a
        // verdict leaves it UNKNOWN rather than failing it.
        assert.equal(view.mergeCheckOnTip, 'FAILING');
      });
    } finally {
      await db.$disconnect();
      // Both halves of the harness: the `pg` Client holds an open socket, and a spec that leaves it
      // connected never lets `node --test` exit — a green run that hangs until the timeout kills it
      // reads as a red one.
      await identity.end();
    }
  });
