import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { IntegrationJobCommand } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  INTEGRATION_LOG_HEAD_BYTES,
  INTEGRATION_LOG_TAIL_BYTES,
  readLandingIntegrationLog,
  readProjectIntegrationLog,
} from './project-integration-log';
import {
  IntegrationJobRefused,
  IntegrationJobRelay,
  receiveIntegrationJobOutput,
} from '../runner-api/integration-job-relay';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemService } from './project-open-item.service';
import {
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_PROGRESS_V2,
  enqueueForDoneTask,
} from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectPromotionService } from './project-promotion.service';

/**
 * Check output as the control plane stores and pages it (docs/project-integration-line-contract.md
 * §2.2 J-T4's output route, §2.9 LS2; design docs/landing-session-design.md §8 phase 3):
 *
 *   * the per-check cap keeps a head and a tail, deletes the middle, and records the dropped bytes
 *     on the first retained tail chunk — a reader draws one "N bytes omitted" line there;
 *   * a chunk is fenced on the claim it names: a claim that moved on is refused STALE_CLAIM, a
 *     terminal job ALREADY_FINAL, another account's job 404, and a resent seq is the chunk already
 *     stored;
 *   * the page read narrows by job, claim, round and check, and a cursor continues it;
 *   * a landing session's log is the reader's: another account's session, a session that is not a
 *     landing, and another landing's job are all 404.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-job-log.pg.spec.ts
 *
 * Every case owns freshly generated ids; nothing here reads another project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

async function connect(): Promise<Stack> {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const promotions = new ProjectPromotionService(prisma);
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  return { db, prisma, sessions, openItems, jobs, promotions, tasks };
}

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sessions: SessionsService;
  openItems: ProjectOpenItemService;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
  tasks: TasksService;
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  repoUrl: string;
}

/** One project with its own owner, runner and workspace, and a started line. */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const repoUrl = `https://git.invalid/${label}-${randomUUID().slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@log.invalid`, name: label, passwordHash: 'x' },
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
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true,
      repoUrl, workDir: `/srv/${label}`,
    },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: `${label} project`, coordinatorWorkspaceId: workspaceId },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId, projectId, settings: { line: 'PROJECT_BRANCH' },
  }));
  return { label, ownerId, runnerId, workspaceId, projectId, repoUrl };
}

/** A DONE task whose branch is handed to the line, as its DONE would (J-T1a). */
async function doneTask(stack: Stack, w: World, label: string): Promise<{ taskId: string; sessionId: string }> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const created = await stack.tasks.create(w.ownerId, {
    title,
    projectId: w.projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  } as never);
  const settled = await stack.db.$executeRawUnsafe(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`,
    created.id,
  );
  assert.equal(settled, 1, 'the task could not be marked DONE');
  const branch = `orbit/${label}-${randomUUID().slice(0, 8)}`;
  const session = await stack.db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, taskId: created.id, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title, prompt: title, branch, isolationStatus: 'worktree',
      baseSha: 'b'.repeat(40), status: RunStatus.SUCCEEDED, startsTaskWork: true,
      finishedAt: new Date(Date.now() - 60_000), worktreeBranch: branch, worktreeDirty: false,
    },
    select: { id: true },
  });
  const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, created.id));
  assert.ok(queued.enqueued, `the DONE queued nothing: ${JSON.stringify(queued)}`);
  return { taskId: created.id, sessionId: session.id };
}

/** One v2 claim of the world's queued landing. */
async function claim(stack: Stack, w: World): Promise<IntegrationJobCommand> {
  const leaseOwner = `lease-${randomUUID()}`;
  const [job] = await stack.jobs.dispatch({
    runnerId: w.runnerId, leaseOwner, draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2],
  });
  assert.ok(job, 'the heartbeat was handed nothing');
  return job;
}

/** The body fields a case varies; everything else is the job's own claim. */
type OutputOverrides = {
  claimGeneration?: string;
  leaseOwner?: string;
  check?: { name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK'; index: number };
  seq?: number;
  text?: string;
};

/** One upload under the job's claim. */
async function output(
  stack: Stack,
  w: World,
  job: IntegrationJobCommand,
  seq: number,
  text: string,
  overrides: OutputOverrides = {},
) {
  return receiveIntegrationJobOutput(stack.prisma, {
    jobId: job.jobId,
    runnerId: w.runnerId,
    ownerId: w.ownerId,
    body: {
      claimGeneration: job.claimGeneration,
      leaseOwner: job.leaseOwner,
      check: { name: 'MERGE_CHECK', index: 1 },
      seq,
      text,
      ...overrides,
    },
  });
}

/** The job's round as its row holds it (the chunk is filed under that round). */
async function jobRound(stack: Stack, jobId: string): Promise<number> {
  const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId }, select: { round: true },
  });
  return row.round ?? 1;
}

test('check output keeps a head and a tail per check and records the bytes it dropped', { skip, concurrency: 1 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'cap');
    await doneTask(stack, w, 'cap');
    const job = await claim(stack, w);
    const round = await jobRound(stack, job.jobId);
    const size = 32 * 1024;
    for (let seq = 0; seq < 12; seq += 1) {
      await output(stack, w, job, seq, String(seq % 10).repeat(size));
    }
    const rows = await stack.db.projectIntegrationJobLog.findMany({
      where: { jobId: job.jobId },
      orderBy: { seq: 'asc' },
    });
    // The head is the first 64 KiB (two 32 KiB chunks); the tail is the last 192 KiB (six chunks);
    // chunks 2..5 are the middle and are gone.
    assert.deepEqual(rows.map((row) => row.seq), [0, 1, 6, 7, 8, 9, 10, 11]);
    assert.equal(rows[0].truncatedBytes, 0);
    assert.equal(rows[2].seq, 6);
    assert.equal(rows[2].truncatedBytes, 4 * size, 'the middle four chunks are recorded on the first tail chunk');
    assert.equal(rows[2].text, '6'.repeat(size), 'the marker sits on the chunk that follows the gap');
    const kept = rows.reduce((sum, row) => sum + Buffer.byteLength(row.text, 'utf8'), 0);
    assert.equal(kept, INTEGRATION_LOG_HEAD_BYTES + INTEGRATION_LOG_TAIL_BYTES);
    assert.ok(round >= 1);

    // The page read serves what is kept, in order, with the gap where it belongs.
    const page = await readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, {});
    assert.deepEqual(page.entries.map((entry) => entry.seq), [0, 1, 6, 7, 8, 9, 10, 11]);
    assert.equal(page.entries[2].truncatedBytes, 4 * size);
    assert.equal(page.nextCursor, null);

    // No transcript row was written: this is a log, not a run_event.
    const events = await stack.db.runEvent.count({ where: { sessionId: job.jobId } });
    assert.equal(events, 0);
  } finally {
    await stack.db.$disconnect();
  }
});

test('a chunk is fenced on the claim it names, and a resent seq is the chunk already stored', { skip, concurrency: 1 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'fence');
    await doneTask(stack, w, 'fence');
    const job = await claim(stack, w);
    const refused = async (overrides: OutputOverrides) => {
      await assert.rejects(
        () => output(stack, w, job, 0, 'refused\n', overrides),
        (error: unknown) => error instanceof IntegrationJobRefused,
      );
    };
    await refused({ claimGeneration: '999' });
    await refused({ leaseOwner: 'somebody-else' });
    await assert.rejects(
      () => receiveIntegrationJobOutput(stack.prisma, {
        jobId: job.jobId, runnerId: w.runnerId, ownerId: randomUUID(),
        body: {
          claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner,
          check: { name: 'MERGE_CHECK', index: 1 }, seq: 0, text: 'other account\n',
        },
      }),
      (error: unknown) => error instanceof IntegrationJobRefused && error.refusal === 'NOT_FOUND',
    );
    // A malformed body is refused before any fence is read.
    for (const bad of [
      { check: { name: 'NOT_A_CHECK', index: 1 } },
      { check: { name: 'MERGE_CHECK', index: 0 } },
      { seq: -1 },
      { text: 'x'.repeat(64 * 1024 + 1) },
    ]) {
      await assert.rejects(
        () => output(stack, w, job, 0, 'bad\n', bad as OutputOverrides),
        (error: unknown) => error instanceof IntegrationJobRefused && error.refusal === 'INVALID_RESULT',
      );
    }

    await output(stack, w, job, 0, 'the chunk\n');
    await output(stack, w, job, 0, 'the chunk\n');
    const stored = await stack.db.projectIntegrationJobLog.findMany({ where: { jobId: job.jobId } });
    assert.equal(stored.length, 1, 'a resent chunk is one row');

    const ended = await stack.db.projectIntegrationJob.updateMany({
      where: { id: job.jobId },
      data: { state: 'ERROR', errorCode: 'FETCH_FAILED', finishedAt: new Date() },
    });
    assert.equal(ended.count, 1);
    await assert.rejects(
      () => output(stack, w, job, 1, 'too late\n'),
      (error: unknown) => error instanceof IntegrationJobRefused && error.refusal === 'ALREADY_FINAL',
    );
  } finally {
    await stack.db.$disconnect();
  }
});

test('the log pages by job, claim, round and check, and a cursor continues it', { skip, concurrency: 1 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'page');
    await doneTask(stack, w, 'page');
    const job = await claim(stack, w);
    const round = await jobRound(stack, job.jobId);
    for (let seq = 0; seq < 4; seq += 1) await output(stack, w, job, seq, `check-one-${seq}\n`);
    for (let seq = 0; seq < 2; seq += 1) {
      await output(stack, w, job, seq, `check-two-${seq}\n`, { check: { name: 'TASK_ACCEPTANCE', index: 2 } });
    }
    const all = await readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, {});
    assert.deepEqual(
      all.entries.map((entry) => [entry.check.index, entry.seq]),
      [[1, 0], [1, 1], [1, 2], [1, 3], [2, 0], [2, 1]],
    );
    const onlyTwo = await readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, { check: 2 });
    assert.deepEqual(onlyTwo.entries.map((entry) => entry.text), ['check-two-0\n', 'check-two-1\n']);
    // A cursor continues the same narrowed read: the position of the last entry a page answered.
    const cursor = Buffer.from(JSON.stringify({ c: Number(job.claimGeneration), r: round, k: 1, s: 1 }))
      .toString('base64url');
    const after = await readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, { check: 1, cursor });
    assert.deepEqual(after.entries.map((entry) => entry.text), ['check-one-2\n', 'check-one-3\n']);
    await assert.rejects(
      () => readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, { cursor: 'not-a-cursor' }),
      /cursor/,
    );

    // A second round inside the same claim is its own set of chunks, even at the same seq.
    await stack.db.projectIntegrationJob.update({ where: { id: job.jobId }, data: { round: round + 1 } });
    await output(stack, w, job, 0, 'round-two\n');
    const second = await readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, { round: round + 1 });
    assert.deepEqual(second.entries.map((entry) => entry.text), ['round-two\n']);
    const first = await readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, { round, check: 1 });
    assert.equal(first.entries.length, 4);

    // A second claim (a takeover) is its own set too, fenced by its own generation.
    const takeover = (BigInt(job.claimGeneration) + 1n).toString();
    await stack.db.projectIntegrationJob.update({
      where: { id: job.jobId }, data: { claimGeneration: BigInt(takeover) },
    });
    await output(stack, w, job, 0, 'second-claim\n', { claimGeneration: takeover });
    const secondClaim = await readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, { claim: Number(takeover) });
    assert.deepEqual(secondClaim.entries.map((entry) => entry.text), ['second-claim\n']);

    // A job that is not this project's is a 404 rather than another project's output.
    await assert.rejects(
      () => readProjectIntegrationLog(stack.prisma, randomUUID(), job.jobId, {}),
      /integration job not found/,
    );
  } finally {
    await stack.db.$disconnect();
  }
});

test("a landing session's log is the reader's; another account's session, another landing's job and a non-landing session are 404", { skip, concurrency: 1 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'landing');
    const { taskId } = await doneTask(stack, w, 'landing');
    const job = await claim(stack, w);
    await output(stack, w, job, 0, 'the landing printed this\n');
    // The enqueue opened the landing subject (§2.9 LS1) and pre-generated the session id; the
    // session row itself is what `ensureLandingSession` inserts after a claim, which the claim's
    // dispatch now does (the engine-path guard task). A build where that compensation point is not
    // wired yet leaves this spec to stand the row up the way that function writes it.
    const landing = await stack.db.projectLanding.findFirstOrThrow({
      where: { taskId }, select: { id: true, sessionId: true },
    });
    const landingSessionId = landing.sessionId;
    const inserted = await stack.db.session.findUnique({ where: { id: landingSessionId }, select: { id: true } });
    if (!inserted) {
      await stack.db.session.create({
        data: {
          id: landingSessionId, title: 'the landing', prompt: 'Orbit runs this landing.', ownerId: w.ownerId,
          creatorId: w.ownerId, workspaceId: w.workspaceId, status: 'AWAITING_INPUT',
          sessionKind: 'LANDING', startsTaskWork: false, provider: 'orbit', providerBuiltin: true,
          titleManagedByProject: true, dispatchOrigin: 'USER', runSource: 'MANUAL',
        },
      });
    }
    assert.equal(
      (await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId }, select: { landingId: true } })).landingId,
      landing.id,
      'the claim is the enqueue landing subject\'s attempt',
    );

    // The newest attempt of the landing when no job is named.
    const page = await stack.sessions.landingLog(w.ownerId, landingSessionId, {});
    assert.equal(page.jobId, job.jobId);
    assert.deepEqual(page.entries.map((entry) => entry.text), ['the landing printed this\n']);

    // Another account's session is the same 404 as one that does not exist.
    await assert.rejects(
      () => stack.sessions.landingLog(randomUUID(), landingSessionId, {}),
      /session not found/,
    );
    // A conversation has no landing subject.
    const conversation = await stack.db.session.create({
      data: {
        ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'chat', prompt: 'chat',
        status: 'AWAITING_INPUT',
      },
      select: { id: true },
    });
    await assert.rejects(
      () => stack.sessions.landingLog(w.ownerId, conversation.id, {}),
      /not a landing session/,
    );
    // A job that is not this landing's — even one of the same account's — is not readable through it.
    await assert.rejects(
      () => readLandingIntegrationLog(stack.prisma, {
        ownerId: w.ownerId, sessionId: landingSessionId, selectors: { jobId: randomUUID() },
      }),
      /integration job not found/,
    );
  } finally {
    await stack.db.$disconnect();
  }
});
