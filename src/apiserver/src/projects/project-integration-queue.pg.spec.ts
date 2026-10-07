/**
 * `GET /projects/:id/integration/queue` on real PostgreSQL: WHICH jobs a project's merge is waiting
 * behind, in what order, and which of their facts the asking owner is allowed to see.
 *
 * WHY THIS EXISTS
 * ---------------
 * The queue sheet exists because "Queued for 70m 55s" answered nothing: a landing claim is
 * serialised per repository-and-target-ref (J1), so the row in front of a project's merge can be
 * another project's — and on 2026-10-07 one was, wedged, for three and a half hours, while every
 * card on the line said "nothing to do". The read that says so is one `$queryRaw` whose shape no
 * test would otherwise exercise: `$queryRaw` is typed by the caller, so the wrong key, the wrong
 * ORDER BY, a missing kind join or a missing owner boundary all compile and answer something
 * plausible.
 *
 * THE CASES
 * ---------
 *  (a) A project with a binding and nothing in flight: an empty queue naming its target ref — the
 *      control every case below is read against.
 *  (b) Four jobs on one repository-and-main, from two accounts: claim order is the enqueue order,
 *      the head is `running` and the rest `waiting`, and the other account's rows carry no title,
 *      no project id and no task id while the owner's do.
 *  (c) What is NOT on the key: a landed job, a job on the project's own branch, and a promotion
 *      check (which serialises per project and never holds a landing slot).
 *  (d) The head that has gone quiet: `stale` is the claim's own lease window, so a head silent past
 *      it reads stale, one that reported a minute ago does not, and one that never reported does.
 *  (e) A project with no binding at all: no ref to queue on, so no queue.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-integration-queue.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';
import type { IntegrationJobKind, IntegrationJobPhase } from '@orbit/shared';
import { Client } from 'pg';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readIntegrationQueue } from './project-integration-queue';

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  codebaseId: string;
  repo: string;
}

/** An owner with one project on a shared repository, its primary binding, and nothing else. */
async function fixture(db: PrismaClient, label: string, repo: string, ownerId?: string): Promise<Fixture> {
  const owner = ownerId ?? randomUUID();
  const projectId = randomUUID();
  if (!ownerId) {
    await db.user.create({
      data: { id: owner, email: `${label}-${owner}@queue.invalid`, name: label, passwordHash: 'x' },
    });
  }
  await db.project.create({ data: { id: projectId, ownerId: owner, title: `Project ${label}` } });
  const codebase = await db.projectCodebase.create({
    data: {
      projectId,
      ownerId: owner,
      canonicalRepoUrl: repo,
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/project/${projectId}`,
      integrationRefSource: 'EXPLICIT',
      refAuthority: 'REMOTE',
    },
  });
  return { ownerId: owner, projectId, codebaseId: codebase.id, repo };
}

/** One task of a fixture's project — the title a `LAND_TASK` row carries. */
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
 * `created_at` and leaves `claimed_at` null; the claim sets `claimed_at`, `heartbeat_at` and moves
 * the state to RUNNING. The serial key is spelled out here as the production key is —
 * `<canonical repo>#<target ref>` — rather than computed through the helper the read uses, so a
 * read that looked up a different key fails these cases instead of agreeing with itself.
 */
async function job(
  db: PrismaClient,
  f: Fixture,
  spec: {
    at: Date;
    state: string;
    idempotency: string;
    kind?: IntegrationJobKind;
    phase?: IntegrationJobPhase | null;
    taskId?: string | null;
    claimedAt?: Date;
    heartbeatAt?: Date | null;
    /// A job on another ref of the same repository (the project's own branch).
    targetRef?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const targetRef = spec.targetRef ?? 'refs/heads/main';
  const kind = spec.kind ?? (spec.taskId ? 'LAND_TASK' : 'LAND_PROMOTION');
  await db.projectIntegrationJob.create({
    data: {
      id,
      projectId: f.projectId,
      ownerId: f.ownerId,
      codebaseId: f.codebaseId,
      kind,
      phase: spec.phase ?? null,
      checks: [],
      // A LANDED row carries the trees the constraint requires: what was tested is what landed.
      ...(spec.state === 'LANDED'
        ? { landedSha: 'b'.repeat(40), testedTreeSha: 'a'.repeat(40), landedTreeSha: 'a'.repeat(40) }
        : {}),
      taskId: spec.taskId ?? null,
      // A check's key is per project (`#check:<projectId>`); every landing's is the repo and ref.
      serialKey: kind === 'CHECK_PROMOTION' ? `${f.repo}#check:${f.projectId}` : `${f.repo}#${targetRef}`,
      targetRef,
      upstreamRef: 'refs/heads/main',
      sourceRef: `refs/heads/orbit/${spec.idempotency}`,
      state: spec.state,
      createdAt: spec.at,
      claimedAt: spec.claimedAt ?? null,
      heartbeatAt: spec.heartbeatAt ?? null,
      idempotencyKey: `ij:v1:test:${f.projectId}:${spec.idempotency}`,
    },
  });
  return id;
}

function read(db: PrismaClient, f: Fixture) {
  return readIntegrationQueue(db as unknown as PrismaService, f.ownerId, f.projectId);
}

/** An instant the spec names in words, so a case reads as the sequence it is describing. */
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 7, 13, 58, 0) + seconds * 1000);

test('the queue a merge waits in is the ref’s, in claim order, named only for its owner',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);
    // A repository per case: J1's partial unique index allows one RUNNING job per serial key, and
    // cases that seeded two on one repo would fail on the index rather than on what they assert.
    const repoFor = (label: string) => `ssh://git@example.invalid/queue-${label}`;

    try {
      await t.test('a project with nothing in flight answers an empty queue naming its ref',
        async () => {
          const f = await fixture(db, 'idle', repoFor('idle'));

          const view = await read(db, f);

          assert.deepEqual(view, { targetRef: 'refs/heads/main', running: 0, waiting: 0, jobs: [] });
        });

      await t.test('the whole line is returned in claim order, titles only for their owner',
        async () => {
          const repo = repoFor('line');
          const mine = await fixture(db, 'mine', repo);
          const theirs = await fixture(db, 'theirs', repo);
          // The owner's own MAIN-line project — same account, so its landing is named.
          const otherProject = await fixture(db, 'mine-other', repo, mine.ownerId);
          const theirTask = await task(db, theirs, 'their code task');
          const myTask = await task(db, otherProject, 'my code task');
          // The head: another account's landing, claimed and reporting normally.
          await job(db, theirs, { at: at(0), state: 'RUNNING', taskId: theirTask,
                                  claimedAt: at(5), heartbeatAt: at(6), idempotency: 'their-landing' });
          // This owner's MAIN-line landing, queued behind it.
          await job(db, otherProject, { at: at(30), state: 'QUEUED', taskId: myTask,
                                        idempotency: 'my-landing' });
          // The merge this spec is about, and another account's promotion behind it.
          await job(db, mine, { at: at(60), state: 'QUEUED', idempotency: 'my-merge' });
          await job(db, theirs, { at: at(90), state: 'QUEUED', idempotency: 'their-merge' });

          const view = await read(db, mine);

          assert.equal(view.targetRef, 'refs/heads/main');
          assert.equal(view.running, 1);
          assert.equal(view.waiting, 3);
          assert.deepEqual(view.jobs.map((j) => j.enqueuedAt), [at(0), at(30), at(60), at(90)]);
          // The head is another account's: no title, no ids, and `mine` says so once.
          assert.deepEqual(
            { mine: view.jobs[0]!.mine, title: view.jobs[0]!.title,
              projectId: view.jobs[0]!.projectId, taskId: view.jobs[0]!.taskId,
              state: view.jobs[0]!.state, kind: view.jobs[0]!.kind },
            { mine: false, title: null, projectId: null, taskId: null,
              state: 'RUNNING', kind: 'LAND_TASK' },
          );
          // This owner's landing names its task and the project it lands for.
          assert.deepEqual(
            { mine: view.jobs[1]!.mine, title: view.jobs[1]!.title, kind: view.jobs[1]!.kind,
              projectId: view.jobs[1]!.projectId, taskId: view.jobs[1]!.taskId },
            { mine: true, title: 'my code task', kind: 'LAND_TASK',
              projectId: otherProject.projectId, taskId: myTask },
          );
          // The merge names its project and lands no single task.
          assert.deepEqual(
            { mine: view.jobs[2]!.mine, title: view.jobs[2]!.title, kind: view.jobs[2]!.kind,
              projectId: view.jobs[2]!.projectId, taskId: view.jobs[2]!.taskId },
            { mine: true, title: `Project mine`, kind: 'LAND_PROMOTION',
              projectId: mine.projectId, taskId: null },
          );
          assert.equal(view.jobs[3]!.mine, false);
          assert.equal(view.jobs[3]!.title, null);
        });

      await t.test('landed work, the project’s own branch and a promotion check are not on the queue',
        async () => {
          const f = await fixture(db, 'scoped', repoFor('scoped'));
          const live = await job(db, f, { at: at(0), state: 'QUEUED', idempotency: 'live' });
          await job(db, f, { at: at(10), state: 'LANDED', idempotency: 'done' });
          await job(db, f, { at: at(20), state: 'RUNNING', idempotency: 'branch',
                             targetRef: `refs/heads/project/${f.projectId}` });
          await job(db, f, { at: at(30), state: 'RUNNING', kind: 'CHECK_PROMOTION',
                             idempotency: 'check' });

          const view = await read(db, f);

          assert.deepEqual(view.jobs.map((j) => j.jobId), [live]);
        });

      await t.test('only the head, silent past the claim’s own lease window, reads stale',
        async () => {
          const f = await fixture(db, 'stale', repoFor('stale'));
          const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
          // The window is INTEGRATION_CLAIM_STALE_MS (10m): 11 minutes of silence is past it, a
          // minute of it is not, and a claim that never reported is not reporting either.
          await job(db, f, { at: minutesAgo(20), state: 'RUNNING', claimedAt: minutesAgo(11),
                             heartbeatAt: minutesAgo(11), idempotency: 'quiet' });

          const quiet = await read(db, f);
          assert.equal(quiet.jobs[0]!.stale, true);

          await db.projectIntegrationJob.updateMany({
            where: { projectId: f.projectId },
            data: { heartbeatAt: minutesAgo(1) },
          });
          assert.equal((await read(db, f)).jobs[0]!.stale, false);

          await db.projectIntegrationJob.updateMany({
            where: { projectId: f.projectId },
            data: { heartbeatAt: null },
          });
          assert.equal((await read(db, f)).jobs[0]!.stale, true,
            'no heartbeat at all is the claim’s own takeover condition: silent, past the window');
          // A quiet QUEUED job is never stale: nothing has claimed it to fall silent.
          await db.projectIntegrationJob.updateMany({
            where: { projectId: f.projectId },
            data: { state: 'QUEUED', claimedAt: null, heartbeatAt: null },
          });
          assert.equal((await read(db, f)).jobs[0]!.stale, false);
        });

      await t.test('a project with no binding has no ref to queue on', async () => {
        const ownerId = randomUUID();
        const projectId = randomUUID();
        await db.user.create({
          data: { id: ownerId, email: `nobind-${ownerId}@queue.invalid`, name: 'nobind', passwordHash: 'x' },
        });
        await db.project.create({ data: { id: projectId, ownerId, title: 'No binding' } });

        const view = await readIntegrationQueue(db as unknown as PrismaService, ownerId, projectId);

        assert.deepEqual(view, { targetRef: null, running: 0, waiting: 0, jobs: [] });
      });
    } finally {
      await db.$disconnect();
      await identity.end().catch(() => undefined);
    }
  });
