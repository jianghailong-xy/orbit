import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus, uuidToBase62, type IntegrationJobCommand } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  applyIntegrationJobResult,
  dispatchIntegrationJobs,
  receiveIntegrationJobOutput,
} from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { EvidenceReviewService } from '../tasks/evidence-review.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import { AttemptBudgetMeterService } from './attempt-budget-meter.service';
import { DEFAULT_ATTEMPT_BUDGET } from './convergence-contract';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { EMPTY_PROGRESS_VECTOR, scopeHash } from './convergence-progress';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { landingFixMessage, landingFixTurnId, readLandingFixFacts } from './landing-fix-turn';
import { canonicalRepoUrl } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { SessionAttemptService } from './session-attempt.service';

/**
 * W6 (docs/project-integration-line-contract.md §12.5, revision 42, ruling R3, R2): a failed landing
 * handed to its task's own work session reaches it as one platform turn keyed `landing-fix:v1:<jobId>`.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-fix-turn.pg.spec.ts
 *
 * Every job is queued by the product (the owner's Confirm writes DONE), claimed off a runner's beat,
 * answered through the J-T7 result transaction, and delivered the way the result route delivers it
 * (`deliverForItems`) and once more by the backstop (`deliverOwed`). The fix turn itself runs through
 * the runner's own doors: claim, dequeue, its transcript, and `turnComplete`.
 *
 *  - The turn's words come only from immutable rows: built twice (and once more after the task is
 *    renamed) they compare byte-equal, and a second delivery writes no second turn.
 *  - A session that ended because its task was done is revived; one still open is handed a NEXT_TURN;
 *    one that ended any other way — ended, cancelled, completed, deleted, failed — is not revived.
 *  - R2: the task's delivered identity is cleared exactly when the turn row is written, and is untouched
 *    when delivery is refused.
 *  - A convergence-managed task's session is revived as well (migration 1449), and the projection trigger
 *    still refuses an unverified landing claim.
 *  - Across the turn and its end: the task stays DONE with the same evidence, decisions, acceptance,
 *    lifecycle epoch and attempt generation; evidence submitted during it is refused; the coordinator's
 *    §6.1 spend and wake rows do not move, the open attempt is not metered; no stale SEND_BACK is handed
 *    to the session.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const CAPABILITIES = ['integration-job/v1', 'integration-observe/v1'];
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const UPSTREAM = sha('9');

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
  prisma: PrismaService;
  sessions: SessionsService;
  confirmations: TaskOwnerConfirmationService;
  openItems: ProjectOpenItemService;
  attempts: SessionAttemptService;
  convergence: CoordinatorConvergenceService;
  evidence: TaskCompletionEvidenceService;
  reviews: EvidenceReviewService;
  api: RunnerApiController;
}

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
  const attempts = new SessionAttemptService(prisma, new ConvergenceLedgerService(prisma));
  const convergence = new CoordinatorConvergenceService(prisma);
  const meter = new AttemptBudgetMeterService(prisma, attempts, new CoordinatorWakeService(prisma), convergence);
  const reviews = new EvidenceReviewService(prisma, sessions);
  // The runner's door, wired with what its turn end hands over: the attempt meter and the evidence
  // reviews, whose send-back drain is one of the gaps this file closes.
  const api = new RunnerApiController(
    prisma, queue, realtime, push as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    meter,
    undefined,
    tasks,
    undefined,
    sessions,
    openItems,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined,
    reviews,
  );
  return {
    db,
    prisma,
    sessions,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    openItems,
    attempts,
    convergence,
    evidence: new TaskCompletionEvidenceService(prisma, undefined, undefined, undefined, reviews),
    reviews,
    api,
  };
}

type Line = 'PROJECT_BRANCH' | 'MAIN';

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/** One owner, the runner the work runs on, a live coordinator conversation, and a project on `line`. */
async function world(stack: Stack, label: string, line: Line = 'PROJECT_BRANCH'): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@landing-fix-turn.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: CAPABILITIES, maxConcurrent: 4, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      heartbeatLeaseOwner: randomUUID(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}` },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'a landing failure goes to the work that caused it',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
      // One task at a time: the revived turn must not need a slot (R3).
      maxConcurrentTasks: 1,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: canonicalRepoUrl(repoUrl)!, upstreamRef: 'refs/heads/main',
      integrationRef: line === 'PROJECT_BRANCH' ? `refs/heads/project/${projectId}` : 'refs/heads/main',
      refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'EXPLICIT', deliveryMode: 'PLATFORM',
      integrationStartedAt: new Date(),
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

interface Finished {
  taskId: string;
  sessionId: string;
  title: string;
}

/**
 * A code task written DONE by the owner's Confirm, whose work session then ends the way production ends
 * it: parked on its branch when the DONE is written, the DONE asks for its end (`claimParkedSessionEnd`,
 * which leaves `cancel_requested_at` beside `end_reason = 'task_done'`), and the runner's finalize writes
 * the finish, which queues the landing. `beforeDone` runs while the work session is still running and the
 * task is IN_PROGRESS — where a run opens its attempt and a reviewer sends a revision back.
 */
async function finishedTask(
  stack: Stack,
  w: World,
  label: string,
  beforeDone?: (t: Finished) => Promise<void>,
): Promise<Finished> {
  const title = `Make ${label} land`;
  const { id: taskId } = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
      acceptanceCriteria: 'the work lands',
    },
    select: { id: true },
  });
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${label}`, prompt: 'work', provider: 'claude',
      status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      isolationStatus: 'worktree', branch: `orbit/${label}`, branchSha: sha('a'), baseSha: sha('b'), numTurns: 1,
      startedAt: minutesAgo(30), createdAt: minutesAgo(30), runtimeSessionId: randomUUID(),
      changedFiles: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }] as Prisma.InputJsonValue,
    },
  });
  const t = { taskId, sessionId, title };
  if (beforeDone) await beforeDone(t);
  // Its turn ends and it parks, idle on its branch.
  await stack.db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
  const receipt = await stack.confirmations.decide(
    w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
  const asked = await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { cancelRequestedAt: true, endReason: true },
  });
  assert.ok(asked.cancelRequestedAt, 'CONTROL: the DONE asked for the end of its idle work session');
  assert.equal(asked.endReason, 'task_done');
  await stack.api.finalize({ id: w.runnerId } as never, sessionId, {
    status: SharedRunStatus.SUCCEEDED, isolationStatus: 'worktree', branch: `orbit/${label}`, branchSha: sha('a'),
    baseSha: sha('b'),
  } as never);
  const ended = await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { finishedAt: true, endReason: true, cancelRequestedAt: true },
  });
  assert.ok(ended.finishedAt && ended.cancelRequestedAt, 'CONTROL: the finish kept the end the DONE asked for');
  assert.equal(ended.endReason, 'task_done');
  return t;
}

async function claimJob(stack: Stack, w: World, kind: string): Promise<IntegrationJobCommand> {
  const handed = await dispatchIntegrationJobs(stack.prisma, {
    runnerId: w.runnerId, leaseOwner: randomUUID(), draining: false, capabilities: CAPABILITIES,
  });
  const command = handed.find((candidate) => candidate.kind === kind);
  assert.ok(command, `CONTROL: the runner was handed a ${kind} — it got ${JSON.stringify(handed.map((c) => c.kind))}`);
  return command;
}

/** The runner's result through the J-T7 transaction — not yet delivered. Answers the item it opened. */
async function fail(stack: Stack, w: World, command: IntegrationJobCommand, body: object): Promise<string> {
  const applied = await applyIntegrationJobResult(stack.prisma, {
    jobId: command.jobId, runnerId: w.runnerId, ownerId: w.ownerId,
    body: { claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, ...body } as never,
  });
  assert.equal(applied.answer.accepted, true, 'CONTROL: the result was taken');
  const [item] = await stack.db.$queryRaw<Array<{ id: string; work_session_id: string | null }>>(Prisma.sql`
    SELECT "id", to_jsonb(i)->>'work_session_id' AS "work_session_id"
      FROM "project_open_item" i WHERE i."integration_job_id" = ${command.jobId}::uuid`);
  assert.ok(item?.work_session_id, 'CONTROL: the failure was handed to the work session (W-T1)');
  return item.id;
}

/** Delivered as the result route delivers it after the commit, and once more by the backstop. */
async function deliver(stack: Stack, w: World, itemId: string): Promise<void> {
  await stack.openItems.deliverForItems([itemId]);
  await stack.openItems.deliverOwed(w.projectId);
}

const conflict = (phase: 'REBASE' | 'MERGE' | 'MAIN_SYNC') => ({
  state: 'CONFLICT', phase, sourceSha: sha('a'), targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
  conflicts: ['src/a.ts', 'src/b.ts'],
});

const redCheck = () => ({
  state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: sha('a'), targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
  testedSha: sha('d'), testedTreeSha: sha('e'),
  checks: [{
    name: 'LANDING_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false,
    durationMs: 1_000, outputTail: 'the tail the runner kept, without the failure section',
  }],
});

async function turnOf(stack: Stack, sessionId: string, jobId: string) {
  return stack.db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: landingFixTurnId(jobId) } },
    select: { id: true, kind: true, status: true, content: true, sendIntent: true },
  });
}

async function identityOf(stack: Stack, taskId: string) {
  return stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      status: true, deliveredSha: true, deliveredBaseSha: true, deliveredBranch: true,
      deliveredSessionId: true, deliveredAt: true,
    },
  });
}

const CLEARED = { deliveredSha: null, deliveredBaseSha: null, deliveredBranch: null, deliveredSessionId: null, deliveredAt: null };

// ─── The words: immutable rows, byte-equal on a replay ────────────────────────────────────────────

test('W6: a red check\'s landing-fix turn is built from the job, its failure lines and its landing, byte-equal twice',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'words-red');
      const t = await finishedTask(stack, w, 'words-red');
      const command = await claimJob(stack, w, 'LAND_TASK');
      // The check's output as a v2 runner streams it: the whole output, then the failure section
      // `addFailureLines` uploads under the same check.
      for (const [seq, text] of [
        'npm test\n> vitest run\n',
        '\nFailure lines from the whole output:\nnot ok 1 - the work broke it\n × src/a.spec.ts > adds 3ms',
      ].entries()) {
        await receiveIntegrationJobOutput(stack.prisma, {
          jobId: command.jobId, runnerId: w.runnerId, ownerId: w.ownerId,
          body: {
            claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner,
            check: { name: 'LANDING_CHECK', index: 1 }, seq, text,
          } as never,
        });
      }
      const itemId = await fail(stack, w, command, redCheck());
      await deliver(stack, w, itemId);

      const turns = await turnOf(stack, t.sessionId, command.jobId);
      assert.equal(turns.length, 1, 'the landing-fix turn was not written once');
      const job = await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: command.jobId }, select: { landingId: true, targetRef: true },
      });
      const landing = await stack.db.projectLanding.findUniqueOrThrow({ where: { id: job.landingId! } });
      const target = job.targetRef.replace('refs/heads/', '');
      assert.equal(turns[0]!.content, [
        `Orbit could not land your work for "${t.title}" on ${target}.`,
        '',
        `The check "landing check" (npm test) failed on the combined tree (${sha('d')}), exit 1:`,
        'not ok 1 - the work broke it',
        ' × src/a.spec.ts > adds 3ms',
        '',
        `Nothing was pushed. ${target} is unchanged.`,
        '',
        'Fix it on your own branch, in this checkout:',
        `1. Merge ${target} and main into your branch and resolve what conflicts.`,
        '2. Run what failed until it passes.',
        '3. Commit, then end your turn.',
        '',
        `Orbit lands the new commit and runs the checks again by itself. Do not push ${target}.`,
        'If this is not yours to fix, end your turn without committing and say why; the project\'s coordinator takes it from there.',
        `The full record: landing ${uuidToBase62(landing.sessionId)}.`,
      ].join('\n'));
      assert.equal(turns[0]!.kind, 'message');

      // Built again from the rows — after the task was renamed, which is not one of them — byte-equal.
      await stack.db.task.update({ where: { id: t.taskId }, data: { title: 'a later name' } });
      const item = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: itemId } });
      const again = landingFixMessage((await readLandingFixFacts(stack.db, {
        integrationJobId: command.jobId, title: item.title, payload: item.payload,
      }))!);
      assert.equal(Buffer.compare(Buffer.from(again), Buffer.from(turns[0]!.content!)), 0, 'a replay says something else');

      // And delivered again: the key holds the one turn, unchanged.
      await deliver(stack, w, itemId);
      const replayed = await turnOf(stack, t.sessionId, command.jobId);
      assert.deepEqual(replayed, turns, 'a second delivery wrote or changed a turn');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W6: a conflict\'s landing-fix turn names the phase, the commit and the files', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'words-conflict');
    const t = await finishedTask(stack, w, 'words-conflict');
    const command = await claimJob(stack, w, 'LAND_TASK');
    // A REBASE conflict: since revision 45 a MAIN_SYNC conflict is the line's and never reaches the work session
    // (docs/design/project-line-upstream-sync.md §4.2; line-sync-hold.pg.spec.ts).
    const itemId = await fail(stack, w, command, conflict('REBASE'));
    await deliver(stack, w, itemId);
    const [turn, ...more] = await turnOf(stack, t.sessionId, command.jobId);
    assert.deepEqual(more, []);
    const target = `project/${w.projectId}`;
    assert.ok(turn!.content!.includes(
      `Conflict while rebasing onto ${target} at ${sha('c')}:\nsrc/a.ts, src/b.ts\n`,
    ), turn!.content!);
    const item = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: itemId } });
    assert.equal(landingFixMessage((await readLandingFixFacts(stack.db, {
      integrationJobId: command.jobId, title: item.title, payload: item.payload,
    }))!), turn!.content, 'a replay says something else');
  } finally {
    await stack.db.$disconnect();
  }
});

// Task 352ZEtmx7cOXY91yIodUk: on a line that is not on origin yet the job's T0 is the upstream's tip, and there is
// no line branch to merge: the turn names main alone.
test('W6: a fresh line\'s red check (T0 = U) tells the session to merge main, not the missing line branch',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'fresh-line');
      const t = await finishedTask(stack, w, 'fresh-line');
      const command = await claimJob(stack, w, 'LAND_TASK');
      const itemId = await fail(stack, w, command, { ...redCheck(), targetShaBefore: UPSTREAM });
      await deliver(stack, w, itemId);
      const [turn, ...more] = await turnOf(stack, t.sessionId, command.jobId);
      assert.ok(turn, 'the task\'s own red was not handed to its session');
      assert.deepEqual(more, []);
      assert.ok(turn.content!.includes('\n1. Merge main into your branch and resolve what conflicts.\n'), turn.content!);
      assert.ok(!turn.content!.includes(`Merge project/${w.projectId}`), turn.content!);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W6: a MAIN line\'s task-branch candidate that conflicts reaches the task\'s session the same way',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'main-line', 'MAIN');
      const t = await finishedTask(stack, w, 'main-line');
      const command = await claimJob(stack, w, 'CHECK_PROMOTION');
      assert.equal(command.promotionSourceKind, 'TASK_BRANCH', 'CONTROL: the candidate is the task branch');
      const itemId = await fail(stack, w, command, conflict('MERGE'));
      await deliver(stack, w, itemId);
      const [turn, ...more] = await turnOf(stack, t.sessionId, command.jobId);
      assert.ok(turn, 'the MAIN line\'s failure was not handed to the task\'s session');
      assert.deepEqual(more, []);
      assert.ok(turn.content!.startsWith(`Orbit could not land your work for "${t.title}" on main.\n`), turn.content!);
      assert.ok(turn.content!.includes('\n1. Merge main into your branch and resolve what conflicts.\n'), turn.content!);
      assert.deepEqual(await identityOf(stack, t.taskId), { status: TaskStatus.DONE, ...CLEARED });
    } finally {
      await stack.db.$disconnect();
    }
  });

// ─── Revived, handed, refused ─────────────────────────────────────────────────────────────────────

test('W6: a session that ended because its task was done is revived, and R2 clears the identity with the turn',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'revived');
      // Another task of the project holds the one slot: the revival must not need it (R3).
      const busy = await stack.db.task.create({
        data: {
          ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title: 'busy', projectId: w.projectId,
          status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
        },
        select: { id: true },
      });
      const t = await finishedTask(stack, w, 'revived');
      await stack.db.session.create({
        data: {
          ownerId: w.ownerId, creatorId: w.ownerId, taskId: busy.id, workspaceId: w.workspaceId,
          assignedRunnerId: w.runnerId, title: 'busy', prompt: 'busy', provider: 'claude', status: RunStatus.RUNNING,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, startedAt: new Date(),
        },
      });
      const command = await claimJob(stack, w, 'LAND_TASK');
      const itemId = await fail(stack, w, command, conflict('REBASE'));
      const frozen = await identityOf(stack, t.taskId);
      assert.equal(frozen.status, TaskStatus.DONE);
      assert.ok(frozen.deliveredSha && frozen.deliveredAt, 'CONTROL: the DONE froze an identity');
      assert.deepEqual(await turnOf(stack, t.sessionId, command.jobId), [], 'CONTROL: nothing delivered yet');

      await deliver(stack, w, itemId);

      const [turn] = await turnOf(stack, t.sessionId, command.jobId);
      assert.ok(turn, 'the task_done session was not handed the landing-fix turn');
      assert.equal(turn.status, 'PENDING');
      const session = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId } });
      assert.equal(session.finishedAt, null, 'the session was not revived');
      assert.equal(session.endReason, null);
      assert.equal(session.cancelRequestedAt, null, 'the revive kept the end its task\'s DONE asked for');
      assert.equal(session.archivedAt, null);
      assert.equal(session.status, RunStatus.PENDING);
      assert.equal(session.assignedRunnerId, w.runnerId, 'the revival moved the session to another runner');
      // R2: cleared exactly with the turn; the task is still DONE.
      assert.deepEqual(await identityOf(stack, t.taskId), { status: TaskStatus.DONE, ...CLEARED });
      const item = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: itemId } });
      assert.equal(item.state, 'OPEN', 'the item stays in the session\'s hands while it fixes');
      assert.equal(
        await stack.db.projectOpenItemDelivery.count({ where: { itemId, sessionId: w.coordinatorSessionId } }), 0,
        'the coordinator was handed the item',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W6: a work session still open is handed the turn as its next turn', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'live');
    const t = await finishedTask(stack, w, 'live');
    const command = await claimJob(stack, w, 'LAND_TASK');
    const itemId = await fail(stack, w, command, conflict('MERGE'));
    // Revived by its owner's message and open when the item reaches it. The revive (`SessionsService.resume`)
    // clears the end its task's DONE asked for, `cancel_requested_at` with it.
    await stack.sessions.resume(w.ownerId, t.sessionId, { clientTurnId: randomUUID(), content: 'one more thing' });
    const revived = await stack.db.session.findUniqueOrThrow({
      where: { id: t.sessionId }, select: { finishedAt: true, endReason: true, cancelRequestedAt: true },
    });
    assert.deepEqual(revived, { finishedAt: null, endReason: null, cancelRequestedAt: null },
      'CONTROL: the revive left an end on the session');
    await deliver(stack, w, itemId);
    const [turn] = await turnOf(stack, t.sessionId, command.jobId);
    assert.ok(turn, 'the open session was not handed the landing-fix turn');
    assert.equal(turn.sendIntent, 'NEXT_TURN');
    assert.deepEqual(await identityOf(stack, t.taskId), { status: TaskStatus.DONE, ...CLEARED });
  } finally {
    await stack.db.$disconnect();
  }
});

test('W6: a task_done session of a convergence-managed task is revived too (1449: a cleared merge state is no claim)',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'managed');
      const t = await finishedTask(stack, w, 'managed', (run) => attemptOpen(stack, w, run));
      const [managed] = await stack.db.$queryRaw<Array<{ managed: boolean }>>(Prisma.sql`
        SELECT "task_is_convergence_managed"(${t.taskId}::uuid) AS "managed"`);
      assert.equal(managed?.managed, true, 'CONTROL: the task is convergence-managed (a task_scope_revision row)');
      const command = await claimJob(stack, w, 'LAND_TASK');
      const itemId = await fail(stack, w, command, conflict('MERGE'));

      await deliver(stack, w, itemId);

      const [turn] = await turnOf(stack, t.sessionId, command.jobId);
      assert.ok(turn, 'the managed task\'s task_done session was not handed the landing-fix turn');
      const session = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId } });
      assert.equal(session.finishedAt, null, 'the managed task\'s session was not revived');
      assert.equal(session.endReason, null);
      assert.equal(session.mergeStatus, null);
      assert.deepEqual(await identityOf(stack, t.taskId), { status: TaskStatus.DONE, ...CLEARED });
    } finally {
      await stack.db.$disconnect();
    }
  });

test('1449: the projection trigger still refuses a managed task\'s unverified landing claim', { skip, timeout: 180_000 },
  async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'claim');
      const t = await finishedTask(stack, w, 'claim', (run) => attemptOpen(stack, w, run));
      const refusal = async (data: Prisma.SessionUpdateInput): Promise<string | null> => {
        try {
          await stack.db.session.update({ where: { id: t.sessionId }, data });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      // A newly claimed merge, or a new merged sha, with no accepted checkpoint there: refused.
      assert.match((await refusal({ mergeStatus: 'merged', mergedSourceSha: sha('f') })) ?? 'accepted',
        /CHECKPOINT_AUTHORITY_REQUIRED/);
      assert.match((await refusal({ mergeStatus: 'merged' })) ?? 'accepted', /CHECKPOINT_AUTHORITY_REQUIRED/);
      assert.match((await refusal({ mergedSourceSha: sha('f') })) ?? 'accepted', /CHECKPOINT_AUTHORITY_REQUIRED/);
      // Clearing the merge state claims nothing — it is what every revive writes — and neither does a failed merge.
      assert.equal(await refusal({ mergeStatus: null, mergedSourceSha: null, branchMerged: null }), null);
      assert.equal(await refusal({ mergeStatus: 'error' }), null);
    } finally {
      await stack.db.$disconnect();
    }
  });

/** The other ways a session ends, written onto a work session that was handed the failure. */
const OTHER_ENDINGS: Record<string, Prisma.SessionUpdateInput> = {
  ended: { endReason: 'ended' },
  cancelled: { status: RunStatus.CANCELLED, endReason: 'cancelled' },
  completed: { endReason: 'completed', completedAt: new Date() },
  deleted: { endReason: 'deleted', deletedAt: new Date() },
  failed: { status: RunStatus.FAILED, endReason: null },
};

for (const [ending, write] of Object.entries(OTHER_ENDINGS)) {
  test(`W6: a work session that was ${ending} is not revived, and the identity is left as it was`,
    { skip, timeout: 180_000 }, async () => {
      const stack = await connect();
      try {
        const w = await world(stack, `refused-${ending}`);
        const t = await finishedTask(stack, w, `refused-${ending}`);
        const command = await claimJob(stack, w, 'LAND_TASK');
        const itemId = await fail(stack, w, command, conflict('MERGE'));
        // Handed to it while it was a task_done session; ended another way before the turn reached it.
        await stack.db.session.update({ where: { id: t.sessionId }, data: write });
        const before = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId } });
        const identity = await identityOf(stack, t.taskId);
        assert.ok(identity.deliveredSha, 'CONTROL: the DONE froze an identity');

        await deliver(stack, w, itemId);

        assert.deepEqual(await turnOf(stack, t.sessionId, command.jobId), [], `a session ${ending} was handed the turn`);
        const after = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId } });
        assert.ok(after.finishedAt, `a session ${ending} was revived`);
        assert.equal(after.status, before.status);
        assert.equal(after.endReason, before.endReason);
        assert.deepEqual(await identityOf(stack, t.taskId), identity, 'a refused delivery touched the identity');
        // W7 (R3): handed back SESSION_ENDED, and from then the coordinator's, delivered to it.
        const item = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: itemId } });
        assert.equal(item.state, 'OPEN');
        assert.equal(item.workSessionReturnReason, 'SESSION_ENDED', `a session ${ending} was not handed back from`);
        assert.ok(item.workSessionReturnedAt);
        assert.equal(
          await stack.db.projectOpenItemDelivery.count({ where: { itemId, sessionId: w.coordinatorSessionId } }), 1,
          'the handed-back item was not delivered to the coordinator',
        );
      } finally {
        await stack.db.$disconnect();
      }
    });
}

// ─── Across the turn: the task stays DONE, nothing is asked of it, nobody is charged ─────────────

/** A revision of the run's evidence, and the reviewer's SEND_BACK of it, written while the task ran. */
async function sentBack(stack: Stack, w: World, t: Finished): Promise<void> {
  const evidenceId = randomUUID();
  const digest = 'a'.repeat(64);
  const criterionRevision = 'b'.repeat(64);
  await stack.db.taskCompletionEvidence.create({
    data: {
      id: evidenceId, taskId: t.taskId, ownerId: w.ownerId, actorType: CreatorType.AGENT, actorId: randomUUID(),
      sourceSessionId: t.sessionId, criterionRevision, criterion: { acceptanceCriteria: 'the work lands' },
      evidence: { claim: 'done', checks: [], gaps: [] }, evidenceDigest: digest, revision: 1n,
    },
  });
  await stack.db.taskEvidenceDecision.create({
    data: {
      taskId: t.taskId, ownerId: w.ownerId, evidenceId, criterionRevision, evidenceDigest: digest,
      decision: 'SEND_BACK', note: 'the tests are not cited', decidedByType: CreatorType.USER,
      decidedById: w.ownerId, decidingSessionId: w.coordinatorSessionId,
    },
  });
}

async function attemptOpen(stack: Stack, w: World, t: Finished): Promise<void> {
  const task = await stack.db.task.findUniqueOrThrow({
    where: { id: t.taskId }, select: { title: true, description: true, acceptanceCriteria: true },
  });
  await stack.attempts.open(w.ownerId, t.taskId, {
    attemptKey: `dispatch:${t.sessionId}`,
    sessionId: t.sessionId,
    hypothesis: 'land the obvious change',
    progressVector: { ...EMPTY_PROGRESS_VECTOR, scopeHash: scopeHash(task) },
    observedAt: new Date(),
  });
}

/** Everything about the task and the coordinator that the turn must leave as it was. */
async function snapshot(stack: Stack, w: World, t: Finished) {
  const task = await stack.db.task.findUniqueOrThrow({
    where: { id: t.taskId },
    select: { status: true, attemptGeneration: true, verdict: true, verdictRevision: true, scopeRevision: true },
  });
  const progress = await stack.db.taskProgress.findUnique({ where: { taskId: t.taskId }, select: { lifecycleEpoch: true } });
  const spend = await stack.convergence.assessSpend(w.projectId);
  return {
    task,
    lifecycleEpoch: progress?.lifecycleEpoch ?? 0,
    evidence: await stack.db.taskCompletionEvidence.count({ where: { taskId: t.taskId } }),
    evidenceDecisions: await stack.db.taskEvidenceDecision.count({ where: { taskId: t.taskId } }),
    ownerDecisions: await stack.db.taskOwnerDecision.count({ where: { taskId: t.taskId } }),
    acceptanceTurns: await stack.db.conversationTurn.count({
      where: { session: { taskId: t.taskId }, clientTurnId: { startsWith: 'system:task-acceptance:v1:' } },
    }),
    sendBackTurns: await stack.db.conversationTurn.count({
      where: { sessionId: t.sessionId, clientTurnId: { startsWith: 'evidence-send-back:v1:' } },
    }),
    attempts: await stack.db.taskAttempt.findMany({
      where: { taskId: t.taskId }, select: { id: true, status: true, spend: true, attemptGeneration: true },
    }),
    wakes: await stack.db.projectCoordinatorWake.count({ where: { projectId: w.projectId } }),
    coordinatorSpend: spend.spend,
    coordinatorTurns: await stack.db.conversationTurn.count({ where: { sessionId: w.coordinatorSessionId } }),
  };
}

/**
 * The fix turn, end to end on the runner's doors, delivered to a session that ended with its task's DONE
 * and revived for it, and everything the task and the coordinator are must read the same after it as
 * before the turn was delivered. `withAttempt`: the run's attempt is still open, which also makes the task
 * convergence-managed (a task_scope_revision row) — the revive that 0152's trigger refused before 1449.
 */
async function acrossTheTurn(label: string, withAttempt: boolean): Promise<void> {
  const stack = await connect();
  try {
    const w = await world(stack, label);
    const t = await finishedTask(stack, w, label, async (run) => {
      if (withAttempt) await attemptOpen(stack, w, run);
      await sentBack(stack, w, run);
    });
    const command = await claimJob(stack, w, 'LAND_TASK');
    const itemId = await fail(stack, w, command, redCheck());
    const before = await snapshot(stack, w, t);
    assert.equal(before.task.status, TaskStatus.DONE);
    if (withAttempt) {
      assert.ok(before.attempts.some((attempt) => attempt.status !== 'CLOSED'), 'CONTROL: the run\'s attempt is still open');
    }
    assert.equal(before.evidenceDecisions, 1, 'CONTROL: the SEND_BACK is recorded');
    assert.equal(before.sendBackTurns, 0, 'CONTROL: the SEND_BACK never reached the run');

    await deliver(stack, w, itemId);
    const [turn] = await turnOf(stack, t.sessionId, command.jobId);
    assert.ok(turn, 'CONTROL: the landing-fix turn was delivered');

    // The runner claims the session, under an inbox generation of its own, and runs the turn.
    const generation = randomUUID();
    const leaseOwner = randomUUID();
    await stack.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
      await tx.session.updateMany({
        where: { id: t.sessionId, status: { in: [RunStatus.PENDING, RunStatus.AWAITING_INPUT] } },
        data: { status: RunStatus.RUNNING, inboxLeaseOwner: leaseOwner, inboxLeaseGeneration: generation },
      });
      await tx.inboxLeaseGeneration.updateMany({
        where: { sessionId: t.sessionId, retiredAt: null }, data: { retiredAt: new Date() },
      });
      await tx.inboxLeaseGeneration.create({ data: { generation, sessionId: t.sessionId, leaseOwner } });
    });
    const delivered = await (stack.api as unknown as {
      dequeueTurn: (sessionId: string, runnerId: string, lease: string | null) => Promise<{ turnId: string } | null>;
    }).dequeueTurn(t.sessionId, w.runnerId, generation);
    assert.equal(delivered?.turnId, turn.id, 'the runner was not handed the landing-fix turn');

    // During it the session tries to hand in evidence: refused, nothing stored.
    await assert.rejects(
      stack.evidence.submit(w.ownerId, t.taskId, { type: CreatorType.AGENT, id: randomUUID() }, {
        sourceSessionId: t.sessionId,
        evidence: { claim: 'fixed the landing', checks: [{ kind: 'TOOL_CALL', ref: randomUUID() }], gaps: [] },
      }),
      (error: { getResponse?: () => { code?: string } }) => error.getResponse?.()?.code === 'TASK_DONE_LANDING_FIX',
    );

    // And the leader's reconcile sweep runs while the turn does (tasks.service.ts, every send-back owed to
    // any session): the revived session is live again, and the old SEND_BACK must not be put to it.
    await stack.reviews.deliverSendBacksOwedTo();

    // The turn spends past the attempt's budget, as a long fix would, and ends.
    await stack.db.session.update({
      where: { id: t.sessionId }, data: { numTurns: (DEFAULT_ATTEMPT_BUDGET.maxTurns as number) + 5 },
    });
    const last = await stack.db.runEvent.aggregate({ where: { sessionId: t.sessionId }, _max: { seq: true } });
    await stack.api.events({ id: w.runnerId } as never, t.sessionId, {
      leaseOwner,
      events: [{
        seq: (last._max.seq ?? 0) + 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(),
        turnId: turn.id, payload: { text: 'merged the project branch in and fixed the test; committed' },
      }],
    } as never);
    const ended = await stack.api.turnComplete({ id: w.runnerId } as never, t.sessionId, {
      turnId: turn.id, status: SharedRunStatus.SUCCEEDED, leaseOwner,
    } as never);
    assert.equal((ended as { ok: boolean }).ok, true, 'CONTROL: the turn completed');
    assert.equal((await stack.db.conversationTurn.findUniqueOrThrow({ where: { id: turn.id } })).status, 'ANSWERED',
      'CONTROL: the landing-fix turn was answered');

    // The turn end's own drain, and the sweep once more after it.
    await stack.reviews.deliverSendBacksOwedTo(t.sessionId);
    await stack.reviews.deliverSendBacksOwedTo();
    const after = await snapshot(stack, w, t);
    assert.deepEqual(after, before, 'the landing-fix turn moved the task, its evidence, or the coordinator');
  } finally {
    await stack.db.$disconnect();
  }
}

test('W6: across a revived landing-fix turn the task stays DONE, no evidence is taken, no SEND_BACK is redelivered, '
  + 'and neither the coordinator\'s spend nor its wakes move', { skip, timeout: 240_000 }, async () => {
  await acrossTheTurn('across-revived', false);
});

test('W6: across a revived landing-fix turn the run\'s open attempt is not metered and wakes no coordinator',
  { skip, timeout: 240_000 }, async () => {
    await acrossTheTurn('across-attempt', true);
  });
