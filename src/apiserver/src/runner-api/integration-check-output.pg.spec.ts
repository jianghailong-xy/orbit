import { seedPromotionRequest } from '../test-support/promotion-request';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import type { IntegrationCheckResult, IntegrationJobCommand, IntegrationJobResultRequest } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_PROGRESS_V2,
  MAX_CHECK_OUTPUT_TAIL,
  enqueueForDoneTask,
} from '../projects/project-integration-job';
import { lastLandingCheck } from '../projects/project-integration-line';
import { readIntegrationJobTimeline } from '../projects/project-integration-event';
import { readProjectIntegrationLog } from '../projects/project-integration-log';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectPromotionService } from '../projects/project-promotion.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  IntegrationJobRefused,
  IntegrationJobRelay,
  receiveIntegrationJobOutput,
} from './integration-job-relay';

/**
 * What a check printed, from the door it comes in through to where anybody reads it: the job row, the exception item's
 * payload, the turn the coordinator is handed, a candidate's card, the log. Each result here is sent the way a runner
 * from before the tail was redacted sends it, raw, because that is what this door exists for: every case below failed
 * on the code before it, by holding the password or by the database refusing the text.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/integration-check-output.pg.spec.ts
 *
 * The rule itself is `check-output-redaction.spec.ts`. The passwords are made up.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const PASSWORD = 's3cret-pass';
const ADDRESS = `postgres://app:${PASSWORD}@db/orbit`;
const REDACTED_ADDRESS = 'postgres://[redacted]@db/orbit';

const sha = (digit: string): string => digit.repeat(40);

const RED_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'bash check.sh',
  expectedExitCode: 0,
  exitCode: 1,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'FAIL\n',
};

test('baseline result events preserve scope and the timeline reads exact copy and legacy events', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'baseline-timeline');
    await doneTask(stack, w, 'baseline-timeline');
    const job = await claim(stack, w);
    const baseline: IntegrationCheckResult = { ...RED_CHECK, name: 'LANDING_CHECK', scope: 'BASELINE' };
    const checks: IntegrationCheckResult[] = [
      baseline,
      { ...baseline, exitCode: 7, expectedExitCode: 7 },
      { ...baseline, timedOut: true },
      { ...baseline, exitCode: null },
      { ...RED_CHECK, name: 'LANDING_CHECK' },
    ];
    await report(stack, w, job, { ...CHECK_FAILED, checks });
    const events = await stack.db.projectIntegrationJobEvent.findMany({
      where: { jobId: job.jobId, kind: { in: ['CHECK_STARTED', 'CHECK_FINISHED'] } },
    });
    assert.equal(events.length, checks.length * 2);
    for (const event of events) {
      const data = event.data as { index: number; scope?: string };
      assert.equal(data.scope, data.index <= 4 ? 'BASELINE' : undefined);
    }
    const timeline = await readIntegrationJobTimeline(stack.prisma, w.projectId, { jobId: job.jobId });
    const finished = timeline.entries.filter((entry) => entry.kind === 'CHECK_FINISHED');
    assert.deepEqual(finished.map((entry) => entry.text), [
      'Checked the project branch with main, without this task · also fails',
      'Checked the project branch with main, without this task · passes',
      'Checked the project branch with main, without this task timed out after 0m 01s',
      'Checked the project branch with main, without this task failed · no exit code · 0m 01s',
      'Landing check failed · exit 1 · 0m 01s',
    ]);
    assert.equal(finished[4].data?.scope, undefined);
  } finally {
    await hangUp(stack);
  }
});

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

const CHECK_FAILED: Answer = {
  state: 'CHECK_FAILED',
  phase: 'CHECK',
  sourceSha: sha('a'),
  targetShaBefore: sha('c'),
  testedSha: sha('d'),
  testedTreeSha: sha('e'),
};

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  jobs: IntegrationJobRelay;
  openItems: ProjectOpenItemService;
  promotions: ProjectPromotionService;
  tasks: TasksService;
  sql: Client;
}

async function connect(): Promise<Stack> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
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
  return { db, prisma, jobs, openItems, promotions, tasks, sql };
}

async function hangUp(stack: Stack): Promise<void> {
  await stack.db.$disconnect().catch(() => undefined);
  await stack.sql.end().catch(() => undefined);
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/** A started line and a coordinator between turns, so a failure really is handed to somebody. */
async function world(stack: Stack, label: string): Promise<World> {
  const { db } = stack;
  const [ownerId, runnerId, workspaceId, projectId, coordinatorSessionId] = [
    randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(),
  ];
  const repoUrl = `ssh://git@example.invalid/${label}-${projectId.slice(0, 8)}`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@check-output.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}` },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER, titleManagedByProject: true,
      numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId, seq: 1, clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message', content: `coordinator: ${label}`, status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: repoUrl, upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/project/${projectId}`, refAuthority: 'REMOTE', integrationRefSource: 'EXPLICIT',
      integrationStartedAt: new Date(Date.now() - 60_000),
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

/** A DONE task whose branch is on the line's queue. */
async function doneTask(stack: Stack, w: World, label: string): Promise<string> {
  const task = await stack.tasks.create(w.ownerId, {
    title: `${label} ${randomUUID().slice(0, 8)}`,
    projectId: w.projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  } as never);
  const settled = await stack.sql.query(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`,
    [task.id],
  );
  assert.equal(settled.rowCount, 1);
  const branch = `orbit/${label}-${task.id.slice(0, 8)}`;
  await stack.db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, taskId: task.id, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: label, prompt: label, branch, isolationStatus: 'worktree', baseSha: sha('b'), status: RunStatus.SUCCEEDED,
      startsTaskWork: true, finishedAt: new Date(Date.now() - 60_000), worktreeBranch: branch, worktreeDirty: false,
      changedFiles: [{ path: 'src/the-work.ts' }] as never,
    },
  });
  const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, task.id));
  assert.ok(queued.enqueued, JSON.stringify(queued));
  return task.id;
}

async function claim(stack: Stack, w: World, kind: IntegrationJobCommand['kind'] = 'LAND_TASK'): Promise<IntegrationJobCommand> {
  const handed = await stack.jobs.dispatch({
    runnerId: w.runnerId, leaseOwner: `lease-${randomUUID()}`, draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2],
  });
  const job = handed.find((command) => command.kind === kind);
  assert.ok(job, `the heartbeat was handed no ${kind}: ${JSON.stringify(handed.map((command) => command.kind))}`);
  return job;
}

/** The result, over the door a runner posts it to, and what the controller does next. */
async function report(stack: Stack, w: World, job: IntegrationJobCommand, answer: Answer) {
  const { answer: taken, after } = await stack.jobs.applyResult(job.jobId, w.runnerId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...answer,
  });
  assert.ok(taken.accepted, `the answer was refused: ${JSON.stringify(taken)}`);
  if (after && after.openItemIds.length > 0) await stack.openItems.deliverForItems(after.openItemIds);
  return taken;
}

function itemOf(stack: Stack, jobId: string) {
  return stack.db.projectOpenItem.findFirstOrThrow({ where: { integrationJobId: jobId } });
}

function turnsOn(stack: Stack, sessionId: string) {
  return stack.db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: 'open-item:v1:' } },
    select: { content: true },
  });
}

function assertNoPassword(where: string, value: unknown, secret = PASSWORD): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(secret), `${where} holds the password: ${text.slice(0, 400)}`);
}

test('a tail sent raw comes out with no password in the job row, the item or the coordinator\'s turn', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'raw-tail');
    await doneTask(stack, w, 'raw-tail');
    const job = await claim(stack, w);
    await report(stack, w, job, {
      ...CHECK_FAILED,
      checks: [{ ...RED_CHECK, outputTail: `dial ${ADDRESS}\nFAIL\n` }],
    });

    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });
    assert.equal(row.state, 'CHECK_FAILED');
    assertNoPassword('the job row', row.checks);

    const item = await itemOf(stack, job.jobId);
    assert.equal(item.kind, 'INTEGRATION_CHECK_FAILED');
    assertNoPassword('the item', item.payload);
    assert.equal(
      (item.payload as { check: { outputTail: string } }).check.outputTail,
      `dial ${REDACTED_ADDRESS}\nFAIL\n`,
      'the rest of the output is what was printed',
    );

    const turns = await turnsOn(stack, w.coordinatorSessionId);
    assert.equal(turns.length, 1, 'the coordinator was told');
    assertNoPassword('the turn', turns[0].content);
    assert.match(turns[0].content ?? '', /The end of its output:/);
    assert.ok(turns[0].content?.includes(REDACTED_ADDRESS), 'the turn still says which address failed');
  } finally {
    await hangUp(stack);
  }
});

test('a tail a runner cut inside an address keeps no part of the password', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'cut-tail');
    await doneTask(stack, w, 'cut-tail');
    const job = await claim(stack, w);
    // Where a runner's 16 KiB started: past the scheme, so no rule can see an address here.
    const fragment = ADDRESS.slice(ADDRESS.indexOf(PASSWORD) + 2);
    const end = '\n--- FAIL: TestDial (0.00s)\nFAIL\n';
    const tail = fragment + 'x'.repeat(MAX_CHECK_OUTPUT_TAIL - fragment.length - end.length) + end;
    await report(stack, w, job, { ...CHECK_FAILED, checks: [{ ...RED_CHECK, outputTail: tail }] });

    const item = await itemOf(stack, job.jobId);
    const stored = (item.payload as { check: { outputTail: string } }).check.outputTail;
    assertNoPassword('the item', stored, PASSWORD.slice(2));
    assert.ok(stored.endsWith(end), 'the end, which says what failed, stays');
    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });
    assertNoPassword('the job row', row.checks, PASSWORD.slice(2));
  } finally {
    await hangUp(stack);
  }
});

test('a failure\'s detail carries no password and no NUL: a failing recipe says why through its own output', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'detail');
    await doneTask(stack, w, 'detail');
    const job = await claim(stack, w);
    await report(stack, w, job, {
      state: 'ERROR',
      phase: 'CHECK',
      errorCode: 'CHECK_TREE_UNPREPARED',
      errorDetail: {
        command: 'scripts/worktree-overlay.sh',
        detail: `scripts/worktree-overlay.sh failed (exit status 1): dial ${ADDRESS}\0\n`,
      },
    });

    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });
    assert.deepEqual(row.errorDetail, {
      command: 'scripts/worktree-overlay.sh',
      detail: `scripts/worktree-overlay.sh failed (exit status 1): dial ${REDACTED_ADDRESS}\n`,
    });
    const item = await itemOf(stack, job.jobId);
    assert.equal(item.kind, 'INTEGRATION_ERROR');
    assertNoPassword('the item', item.payload);
    const turns = await turnsOn(stack, w.coordinatorSessionId);
    assert.equal(turns.length, 1, 'the coordinator was told');
    assertNoPassword('the turn', turns[0].content);
    assert.ok(turns[0].content?.includes(REDACTED_ADDRESS), 'the turn still says which address failed');
  } finally {
    await hangUp(stack);
  }
});

test('a candidate\'s check holds to the same rule, on the candidate\'s row and on both the items it can open', {
  skip, concurrency: 1, timeout: 180_000,
}, async () => {
  const stack = await connect();
  try {
    for (const [label, answer] of [
      ['red', {
        ...CHECK_FAILED,
        upstreamSha: sha('c'),
        checks: [{ ...RED_CHECK, outputTail: `dial ${ADDRESS}\n` }],
      }],
      ['green', {
        state: 'READY',
        phase: 'CHECK',
        sourceSha: sha('d'),
        targetShaBefore: sha('c'),
        upstreamSha: sha('c'),
        testedSha: sha('2'),
        testedTreeSha: sha('3'),
        aheadOfUpstream: 1,
        filesChanged: 1,
        conflicts: [],
        checks: [{ ...RED_CHECK, exitCode: 0, outputTail: `dial ${ADDRESS}\nok\n` }],
      }],
    ] as ReadonlyArray<readonly [string, Answer]>) {
      const w = await world(stack, `candidate-${label}`);
      await doneTask(stack, w, `candidate-${label}`);
      await report(stack, w, await claim(stack, w), {
        state: 'LANDED', phase: 'VERIFY', sourceSha: sha('d'), targetShaBefore: sha('c'), upstreamSha: sha('c'),
        testedSha: sha('f'), testedTreeSha: sha('e'), landedSha: sha('f'), landedTreeSha: sha('e'), aheadOfUpstream: 1,
        checks: [{ ...RED_CHECK, exitCode: 0, outputTail: `dial ${ADDRESS}\nok\n` }],
      });
      await seedPromotionRequest(stack.prisma, w.projectId);
      const made = await stack.promotions.considerCandidate(w.projectId);
      assert.ok(made, 'the landing made a candidate');
      await report(stack, w, await claim(stack, w, 'CHECK_PROMOTION'), answer);

      const candidate = await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: made.promotionId },
        select: { state: true, checks: true },
      });
      assert.equal(candidate.state, label === 'red' ? 'BLOCKED' : 'READY', `the ${label} candidate`);
      assertNoPassword('the candidate', candidate.checks);
      assert.ok(JSON.stringify(candidate.checks).includes(REDACTED_ADDRESS), 'the candidate says which address it dialed');

      const items = await stack.db.projectOpenItem.findMany({ where: { projectId: w.projectId } });
      assert.ok(items.length > 0, 'the candidate opened an item');
      for (const item of items) assertNoPassword(`the ${item.kind} item`, item.payload);
      const jobs = await stack.db.projectIntegrationJob.findMany({ where: { projectId: w.projectId } });
      for (const job of jobs) assertNoPassword(`the ${job.kind} job`, job.checks);
    }
  } finally {
    await hangUp(stack);
  }
});

test('half a surrogate pair where the clip lands does not lose the result', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'surrogate');
    await doneTask(stack, w, 'surrogate');
    const job = await claim(stack, w);
    // A marker can now lengthen a tail past the cap, so the clip is reachable by what a real runner sends. An odd
    // count of units before it lands it inside a pair, and jsonb refuses half of one.
    const tail = `${'\u{1F600}'.repeat(9_000)}x`;
    await report(stack, w, job, { ...CHECK_FAILED, checks: [{ ...RED_CHECK, outputTail: tail }] });
    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });
    assert.equal(row.state, 'CHECK_FAILED');
    const [check] = row.checks as unknown as IntegrationCheckResult[];
    assert.ok(check.outputTail.endsWith('\u{1F600}x'));
    assert.ok(check.outputTail.length <= MAX_CHECK_OUTPUT_TAIL);
  } finally {
    await hangUp(stack);
  }
});

test('a chunk with NUL in it is stored, and so is every chunk after it', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'nul');
    await doneTask(stack, w, 'nul');
    const job = await claim(stack, w);
    const chunks = ['before\n', 'a NUL\0 in the middle, and at the end\0', 'only NUL after this:\n', '\0\0\0', 'after\n'];
    for (const [seq, text] of chunks.entries()) {
      const answer = await receiveIntegrationJobOutput(stack.prisma, {
        jobId: job.jobId,
        runnerId: w.runnerId,
        ownerId: w.ownerId,
        body: {
          claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner,
          check: { name: 'MERGE_CHECK', index: 1 }, seq, text,
        },
      });
      assert.deepEqual(answer, { accepted: true });
    }
    const page = await readProjectIntegrationLog(stack.prisma, w.projectId, job.jobId, {});
    assert.deepEqual(page.entries.map((entry) => entry.seq), [0, 1, 2, 3, 4]);
    assert.equal(
      page.entries.map((entry) => entry.text).join(''),
      'before\na NUL in the middle, and at the endonly NUL after this:\nafter\n',
    );
  } finally {
    await hangUp(stack);
  }
});

test('a chunk is held to the rule the tail is held to, and one the rule grows past the column is refused, not a 500', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'chunk');
    await doneTask(stack, w, 'chunk');
    const job = await claim(stack, w);
    const send = (seq: number, text: string) => receiveIntegrationJobOutput(stack.prisma, {
      jobId: job.jobId,
      runnerId: w.runnerId,
      ownerId: w.ownerId,
      body: {
        claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner,
        check: { name: 'MERGE_CHECK', index: 1 }, seq, text,
      },
    });
    await send(0, `dial ${ADDRESS}\n`);
    const [stored] = await stack.db.projectIntegrationJobLog.findMany({ where: { jobId: job.jobId } });
    assert.equal(stored.text, `dial ${REDACTED_ADDRESS}\n`);

    // Within the limit going in; every `a://b@c ` comes out longer. A runner's chunk is a quarter of this.
    const addresses = 'a://b@c '.repeat(6_000);
    assert.ok(Buffer.byteLength(addresses, 'utf8') <= 64 * 1024);
    await assert.rejects(
      () => send(1, addresses),
      (error: unknown) => error instanceof IntegrationJobRefused && error.refusal === 'INVALID_RESULT',
    );
    // The chunk after it is not held up by that.
    await send(2, 'after\n');
    const rows = await stack.db.projectIntegrationJobLog.findMany({ where: { jobId: job.jobId }, orderBy: { seq: 'asc' } });
    assert.deepEqual(rows.map((row) => row.seq), [0, 2]);
  } finally {
    await hangUp(stack);
  }
});


test('a paths-exempt landing check preserves its files and is skipped on the timeline', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'paths-exempt');
    await doneTask(stack, w, 'paths-exempt');
    const job = await claim(stack, w);
    const check: IntegrationCheckResult = {
      ...RED_CHECK, name: 'LANDING_CHECK', exitCode: null, timedOut: false,
      durationMs: 0, outputTail: '', skipped: 'PATHS_EXEMPT', files: ['docs/a.md', 'docs/b.md'],
    };
    for (const invalid of [
      { ...check, skipped: 'UNKNOWN' },
      { ...check, name: 'TASK_ACCEPTANCE' },
      { ...check, files: [] },
      { ...check, files: [1] },
    ]) {
      await assert.rejects(report(stack, w, job, { ...CHECK_FAILED, checks: [invalid] } as Answer),
        (error: unknown) => error instanceof IntegrationJobRefused && error.refusal === 'INVALID_RESULT');
    }
    await report(stack, w, job, {
      state: 'LANDED', phase: 'VERIFY', sourceSha: sha('d'), targetShaBefore: sha('c'), upstreamSha: sha('c'),
      testedSha: sha('f'), testedTreeSha: sha('e'), landedSha: sha('f'), landedTreeSha: sha('e'),
      checks: [check],
    });
    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });
    assert.deepEqual(row.checks, [check]);
    assert.equal(lastLandingCheck(row.checks), 'PASSING');
    const events = await stack.db.projectIntegrationJobEvent.findMany({ where: { jobId: job.jobId, kind: 'CHECK_FINISHED' } });
    assert.equal(events.length, 1);
    assert.equal(events[0].text, 'Landing check skipped · only exempt paths changed');
    assert.deepEqual((events[0].data as { files: string[] }).files, check.files);
    assert.equal((events[0].data as { skipped: string }).skipped, 'PATHS_EXEMPT');
  } finally {
    await hangUp(stack);
  }
});
