import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import {
  IntegrationCheckResult,
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  RunEventType,
  RunStatus as SharedRunStatus,
} from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import {
  AutomaticConfirmationFacts,
  automaticConfirmationRefusal,
  promotionDedupeKey,
} from './project-promotion';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * The owner's decision of 2026-09-23 (integration contract §3.3 M7, M-T11, M-T12):
 *
 *   有自己的项目集成分支 + automatic 就可以合并；如果是 main 或非 automatic，就需要人来点。
 *
 * A project branch whose project has Automatic on, and whose promotion check came back clean, is
 * merged into main by the platform — no card, and a receipt that says so. Anything else gets the
 * card, exactly as before: a MAIN line, Automatic off, a red check, a conflict, main moving after
 * the check, an integration exception still open, a runner that would re-check a moved main — and
 * an authorization taken back between the check and the moment its landing is handed out.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-promotion-auto-authority.pg.spec.ts
 *
 * WHAT DRIVES EACH CASE. The doors a runner knocks on: a code task's DONE through its own
 * acceptance command queues its landing, the heartbeat hands the landing out, the result route
 * takes what the runner says it did — and the promotion candidate, its check, its landing and the
 * owner's press follow from those, through the same controller and relay production wires. What the
 * runner would have done in git is the one thing simulated, as the result it posts; what the runner
 * does in git is `src/runner-go/integrate_test.go`'s (`TestAutomaticPromotion*`).
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

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

/** What a runner of this build says about itself: it claims integration jobs, and it hands a moved
 *  main back instead of re-checking it on an automatic landing. */
const CAPABLE = [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND];
/** …and what a runner from before this build says: integration jobs, nothing more. */
const OLDER = [INTEGRATION_JOB_CLAIM];

// The commits the simulated runner reports. Distinct, so an assertion that picked up the wrong one
// fails on the value instead of passing on a coincidence.
const TASK_BRANCH_TIP = 'a'.repeat(40);
const LINE_BEFORE = 'c'.repeat(40);
/** Where the task landed on the project branch: the source every promotion below offers. */
const LANDED_ON_LINE = 'd'.repeat(40);
const LANDED_TREE = 'e'.repeat(40);
/** main as the promotion check found it. */
const MAIN_CHECKED = 'f'.repeat(40);
const CHECK_MERGE = '2'.repeat(40);
/** The combined tree the check passed on — the only tree an automatic landing may put on main. */
const CHECKED_TREE = '3'.repeat(40);
/** The merge commit the landing made on main. */
const MERGE_COMMIT = '4'.repeat(40);
/** main after somebody else landed first, between the check and the landing. */
const MAIN_MOVED = '5'.repeat(40);

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'ok\n',
};

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
}

/**
 * The production wiring over one client: the real completion-input router behind task writes, and
 * the runner controller with the integration relay AND the promotion service, so a landing's
 * after-commit edge makes the candidate (M-F1) the way it does in production rather than by a call
 * this file makes.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = new CoordinatorConvergenceService(prisma);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      convergence,
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const promotions = new ProjectPromotionService(prisma);
  // A device is never reached from here: every announcement resolves and says nothing.
  const push = new Proxy({}, { get: () => async () => undefined }) as never;
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    push,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    undefined,
    undefined,
    openItems,
    jobs,
    undefined,
    promotions,
  );
  return { db, tasks, api, jobs, promotions };
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** What this world's runner declares on every heartbeat. */
  capabilities: string[];
}

/**
 * One project in a repository, integrating on the line named, with a coordinator conversation
 * between turns and the owner's Automatic setting as given. The runner's declared capabilities are
 * written where its heartbeat writes them, because that row is what the decision reads.
 */
async function world(
  stack: Stack,
  label: string,
  options: { line: 'PROJECT_BRANCH' | 'MAIN'; automatic: boolean; capabilities?: string[] },
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const capabilities = options.capabilities ?? CAPABLE;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@auto-authority.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities,
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}.git`,
      workDir: `/srv/${label}`,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `coordinator: ${label}`,
      prompt: `coordinator: ${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      numTurns: 1,
      startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `coordinator: ${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'the owner is asked about main only when they said they wanted to be',
      coordinatorEnabled: options.automatic,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: { line: options.line },
  }));
  return { label, ownerId, runnerId, workspaceId, projectId, capabilities };
}

/**
 * A code task of this project settled DONE by its own acceptance command, through the runner's
 * doors: the work turn answered and completed, the acceptance command queued and passed. Its DONE
 * is what queues its integration (§2.3 J-T1a) — a landing on a project branch, a candidate on main.
 */
async function doneCodeTask(stack: Stack, w: World, label: string): Promise<{ taskId: string; sessionId: string }> {
  const db = stack.db;
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    acceptanceCommand: 'exit 0',
    acceptanceExpectedExitCode: 0,
  });
  const sessionId = randomUUID();
  const turnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId: declared.id,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title,
      prompt: title,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      // The task's work has STOPPED MOVING: this is the column the LAND_TASK claim guard reads
      // (contract §2.6 J-T1a), and a fixture that leaves it null is a task whose work is still in
      // flight — the line holds such a job QUEUED by design, which is not what this scenario is
      // about. A minute ago, so the claim that follows is unambiguously later than it.
      finishedAt: new Date(Date.now() - 60_000),
      branch: `orbit/${label}`,
      isolationStatus: 'worktree',
      baseSha: 'b'.repeat(40),
    },
  });
  await db.conversationTurn.create({
    data: {
      id: turnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${turnId}`,
      kind: 'message',
      content: 'execute the task',
      status: 'IN_FLIGHT',
      deliveredAt: new Date(),
    },
  });
  await stack.api.events({ id: w.runnerId }, sessionId, {
    events: [{
      seq: 1,
      type: RunEventType.ASSISTANT,
      ts: new Date().toISOString(),
      turnId,
      payload: { text: 'the work is on the branch' },
    }],
  });
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, { turnId, status: SharedRunStatus.SUCCEEDED });
  const acceptance = await (stack.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) =>
      Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, w.runnerId, null);
  assert.equal(acceptance?.taskAcceptance, true, 'the acceptance command was queued for the task');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  const task = await db.task.findUniqueOrThrow({ where: { id: declared.id }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DONE, 'the acceptance command agreed');
  return { taskId: declared.id, sessionId };
}

/** One heartbeat's claim, as the runner's own process would make it. */
function heartbeat(stack: Stack, w: World, capabilities: string[] = w.capabilities): Promise<IntegrationJobCommand[]> {
  return stack.jobs.dispatch({ runnerId: w.runnerId, leaseOwner: `lease-${w.label}`, draining: false, capabilities });
}

/** The result a runner posts for a job it holds, over the route it posts it on. */
function report(
  stack: Stack,
  w: World,
  job: IntegrationJobCommand,
  result: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>,
) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}

/** The one job a heartbeat hands out, which has to be of the kind named. */
async function onlyClaim(stack: Stack, w: World, kind: string, capabilities?: string[]): Promise<IntegrationJobCommand> {
  const claimed = await heartbeat(stack, w, capabilities);
  assert.equal(claimed.length, 1, `expected one ${kind} to be handed out — ${await jobsOf(stack.db, w.projectId)}`);
  assert.equal(claimed[0]!.kind, kind);
  return claimed[0]!;
}

/** A check that found the project branch merging cleanly onto main, every check green. */
function cleanCheck(overrides: Partial<IntegrationJobResultRequest> = {}): Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'> {
  return {
    state: 'READY',
    phase: 'CHECK',
    sourceSha: LANDED_ON_LINE,
    targetShaBefore: MAIN_CHECKED,
    upstreamSha: MAIN_CHECKED,
    testedSha: CHECK_MERGE,
    testedTreeSha: CHECKED_TREE,
    aheadOfUpstream: 1,
    filesChanged: 3,
    checks: [GREEN_CHECK],
    conflicts: [],
    ...overrides,
  };
}

/**
 * A PROJECT_BRANCH project carried up to the moment its promotion check is in a runner's hands: one
 * task DONE, its landing claimed and reported LANDED on the project branch, the candidate the
 * landing's after-commit edge made (M-F1), and the CHECK_PROMOTION claimed.
 */
async function checkInHand(stack: Stack, w: World): Promise<{ taskId: string; sessionId: string; check: IntegrationJobCommand }> {
  const task = await doneCodeTask(stack, w, w.label);
  const landing = await onlyClaim(stack, w, 'LAND_TASK');
  const landed = await report(stack, w, landing, {
    state: 'LANDED',
    phase: 'VERIFY',
    sourceSha: TASK_BRANCH_TIP,
    targetShaBefore: LINE_BEFORE,
    testedSha: LANDED_ON_LINE,
    testedTreeSha: LANDED_TREE,
    landedSha: LANDED_ON_LINE,
    landedTreeSha: LANDED_TREE,
    aheadOfUpstream: 1,
  });
  assert.equal(landed.accepted, true, 'the task landed on the project branch');
  const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
  return { ...task, check };
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

function promotionOf(db: PrismaClient, projectId: string) {
  return db.projectPromotion.findFirstOrThrow({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, state: true, sourceKind: true, sourceSha: true, upstreamShaChecked: true,
      mergeTreeSha: true, confirmedByUserId: true, confirmedAutomatically: true, confirmedAt: true,
      landJobId: true, openItemId: true, mergedSha: true, mergedAt: true, receiptIds: true,
    },
  });
}

/** The owner's merge cards on this project — the thing this whole decision is about. */
function approvalCards(db: PrismaClient, projectId: string) {
  return db.projectOpenItem.findMany({
    where: { projectId, kind: 'PROMOTION_APPROVAL' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, state: true, assignee: true, promotionId: true, dedupeKey: true, title: true,
      payload: true, resolution: true, resolvedBy: true,
    },
  });
}

function landingsOf(db: PrismaClient, projectId: string) {
  return db.projectIntegrationJob.findMany({
    where: { projectId, kind: 'LAND_PROMOTION' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, state: true, confirmedAutomatically: true, landedSha: true, upstreamSha: true },
  });
}

/** Receipts that say a task's work is on main. */
function mainReceipts(db: PrismaClient, taskId: string) {
  return db.sessionMergeReceipt.findMany({
    where: { taskId, targetBranch: 'main' },
    select: { id: true, result: true, targetShaAfter: true, detail: true },
  });
}

async function jobsOf(db: PrismaClient, projectId: string): Promise<string> {
  const rows = await db.projectIntegrationJob.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { kind: true, generation: true, state: true, errorCode: true, confirmedAutomatically: true },
  });
  return `jobs: ${JSON.stringify(rows)}`;
}

/** Everything a "the owner is asked, exactly as before" assertion checks, said once. */
async function assertAskedAsBefore(stack: Stack, w: World, what: string): Promise<void> {
  const promotion = await promotionOf(stack.db, w.projectId);
  const cards = await approvalCards(stack.db, w.projectId);
  assert.equal(promotion.state, 'READY', `${what}: the candidate waits for the owner`);
  assert.equal(promotion.confirmedAutomatically, false, `${what}: nothing confirmed it by itself`);
  assert.equal(promotion.confirmedAt, null);
  assert.equal(cards.length, 1, `${what}: one card in front of the owner — ${await jobsOf(stack.db, w.projectId)}`);
  const card = cards[0]!;
  assert.equal(card.state, 'OPEN');
  assert.equal(card.assignee, 'OWNER');
  assert.equal(card.promotionId, promotion.id);
  assert.equal(card.dedupeKey, promotionDedupeKey(promotion.id));
  assert.equal(promotion.openItemId, card.id, `${what}: the candidate names its card`);
  assert.deepEqual(await landingsOf(stack.db, w.projectId), [], `${what}: nothing was queued to land`);
}

/** Everything "the automatic landing went back to the owner without landing" means, said once. */
async function assertHandedBack(stack: Stack, w: World, taskId: string, what: string): Promise<void> {
  const promotion = await promotionOf(stack.db, w.projectId);
  const cards = await approvalCards(stack.db, w.projectId);
  assert.equal(promotion.state, 'READY', `${what}: the candidate is a question again`);
  assert.equal(promotion.confirmedAutomatically, false, `${what}: nothing stands confirmed by itself`);
  assert.equal(promotion.confirmedByUserId, null);
  assert.equal(promotion.landJobId, null, `${what}: no landing is in flight`);
  assert.equal(promotion.mergedSha, null, `${what}: nothing was merged`);
  assert.equal(promotion.upstreamShaChecked, MAIN_CHECKED, 'the check it has is the one it had');
  assert.equal(cards.length, 1, `${what}: the owner is asked — ${await jobsOf(stack.db, w.projectId)}`);
  assert.equal(cards[0]!.state, 'OPEN');
  assert.equal(cards[0]!.assignee, 'OWNER');
  assert.equal(promotion.openItemId, cards[0]!.id, `${what}: the candidate names its card`);
  assert.equal((cards[0]!.payload as { upstreamShaChecked?: string }).upstreamShaChecked, MAIN_CHECKED);
  const [attempted] = await landingsOf(stack.db, w.projectId);
  assert.equal(attempted!.state, 'READY', `${what}: the automatic landing ended without landing`);
  assert.equal(attempted!.confirmedAutomatically, true, 'and its record still says whose it was');
  assert.equal(attempted!.landedSha, null);
  assert.deepEqual(await mainReceipts(stack.db, taskId), [], `${what}: no receipt says the work is on main`);
}

// ── the rule, as a table ─────────────────────────────────────────────────────────────────────

test('the rule: a project branch + Automatic + clean, and nothing less', () => {
  const clean: AutomaticConfirmationFacts = {
    sourceKind: 'PROJECT_BRANCH',
    line: 'PROJECT_BRANCH',
    coordinatorEnabled: true,
    conflicts: [],
    checks: [GREEN_CHECK],
    upstreamShaChecked: MAIN_CHECKED,
    mergeTreeSha: CHECKED_TREE,
    openIntegrationItems: 0,
    runnerHandsBackMovedUpstream: true,
  };
  assert.equal(automaticConfirmationRefusal(clean), null, 'both halves and a clean check: merged by itself');
  // No merge check configured is still a clean check — the tasks on the line each passed their own.
  assert.equal(automaticConfirmationRefusal({ ...clean, checks: [] }), null);

  const refused: Array<[string, Partial<AutomaticConfirmationFacts>]> = [
    ['a MAIN-line candidate', { sourceKind: 'TASK_BRANCH', line: 'MAIN' }],
    ['a project branch whose binding is now main', { line: 'MAIN' }],
    ['a project branch with no binding to read', { line: null }],
    ['Automatic off', { coordinatorEnabled: false }],
    ['a conflict', { conflicts: ['src/a.ts'] }],
    ['a red check', { checks: [GREEN_CHECK, { ...GREEN_CHECK, exitCode: 1 }] }],
    ['a check that timed out', { checks: [{ ...GREEN_CHECK, timedOut: true }] }],
    ['a check that never exited', { checks: [{ ...GREEN_CHECK, exitCode: null }] }],
    ['no checked main to hold the landing to', { upstreamShaChecked: null }],
    ['no checked tree to hold the landing to', { mergeTreeSha: null }],
    ['an integration exception still open', { openIntegrationItems: 1 }],
    ['a runner that would re-check a moved main and merge it', { runnerHandsBackMovedUpstream: false }],
  ];
  for (const [what, change] of refused) {
    assert.notEqual(automaticConfirmationRefusal({ ...clean, ...change }), null, `${what} must go to the owner`);
  }
});

test('the runner declares the exact capability the claim fence and the decision look for', () => {
  // Two codebases that never compile together agree on one word, and on a promise: a runner that
  // says it hands a moved main back must be one that does. `TestAutomaticPromotionHandsBackAMovedUpstream`
  // in integrate_test.go is the promise kept; this is the word.
  const REPO = path.resolve(__dirname, '../../../..');
  const integrate = readFileSync(path.join(REPO, 'src/runner-go/integrate.go'), 'utf8');
  const transport = readFileSync(path.join(REPO, 'src/runner-go/transport.go'), 'utf8');
  assert.match(integrate, new RegExp(`promotionAutomaticLandCapabilityV1\\s*=\\s*"${PROMOTION_AUTOMATIC_LAND}"`));
  const declared = transport.slice(transport.indexOf('runnerCapabilitiesV1 = strings.Join'));
  assert.ok(
    declared.slice(0, declared.indexOf('}')).includes('promotionAutomaticLandCapabilityV1'),
    'the runner defines the capability but never puts it in the header it sends',
  );
  assert.match(integrate, /if landing && cmd\.Automatic && \(cmd\.UpstreamShaChecked == "" \|\| cmd\.UpstreamShaChecked != upstreamSha\)/);
});

// ── (a) project branch + Automatic + clean: merged by itself, with a receipt ─────────────────────

test('(a) a project branch with Automatic on and a clean check is merged without a card, and says so',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'auto-clean', { line: 'PROJECT_BRANCH', automatic: true });
      const { taskId, check } = await checkInHand(stack, w);
      const checked = await report(stack, w, check, cleanCheck());
      assert.equal(checked.accepted, true);
      assert.equal(checked.openItemId, null, 'the check opened nothing for anybody');

      // No card: the setting confirmed it, and the row says the setting did — nobody is named.
      assert.deepEqual(await approvalCards(stack.db, w.projectId), [], 'no merge card was put in front of the owner');
      const confirmed = await promotionOf(stack.db, w.projectId);
      assert.equal(confirmed.state, 'CONFIRMED');
      assert.equal(confirmed.confirmedAutomatically, true);
      assert.equal(confirmed.confirmedByUserId, null, 'nobody pressed it, so nobody is named');
      assert.ok(confirmed.confirmedAt, 'when it was confirmed is recorded all the same');
      assert.equal(confirmed.upstreamShaChecked, MAIN_CHECKED);
      assert.equal(confirmed.mergeTreeSha, CHECKED_TREE);
      const [queued] = await landingsOf(stack.db, w.projectId);
      assert.ok(queued, `the confirmation queued no landing — ${await jobsOf(stack.db, w.projectId)}`);
      assert.equal(queued.state, 'QUEUED');
      assert.equal(queued.confirmedAutomatically, true, 'the job itself is marked as the setting\'s');
      assert.equal(confirmed.landJobId, queued.id);

      // M-T12's fence: a process that has not said it hands a moved main back is not handed it.
      assert.deepEqual(await heartbeat(stack, w, OLDER), [], 'an older runner was handed an automatic landing');
      const land = await onlyClaim(stack, w, 'LAND_PROMOTION', CAPABLE);
      assert.equal(land.automatic, true, 'the runner is told this landing is the setting\'s');
      assert.equal(land.upstreamShaChecked, MAIN_CHECKED, '…and which main it may land onto');
      assert.equal(land.mergeTreeSha, CHECKED_TREE, '…and which tree');
      assert.equal(land.sourceSha, LANDED_ON_LINE);

      const landed = await report(stack, w, land, {
        state: 'LANDED',
        phase: 'VERIFY',
        sourceSha: LANDED_ON_LINE,
        targetShaBefore: MAIN_CHECKED,
        upstreamSha: MAIN_CHECKED,
        testedSha: MERGE_COMMIT,
        testedTreeSha: CHECKED_TREE,
        landedSha: MERGE_COMMIT,
        landedTreeSha: CHECKED_TREE,
        aheadOfUpstream: 2,
      });
      assert.equal(landed.accepted, true);
      assert.equal(landed.openItemId, null);

      const merged = await promotionOf(stack.db, w.projectId);
      assert.equal(merged.state, 'MERGED');
      assert.equal(merged.mergedSha, MERGE_COMMIT);
      assert.equal(merged.confirmedAutomatically, true, 'the record keeps saying who merged it');
      assert.equal(merged.confirmedByUserId, null);
      assert.deepEqual(await approvalCards(stack.db, w.projectId), [], 'still no card, before or after');
      const [landingJob] = await landingsOf(stack.db, w.projectId);
      assert.equal(landingJob!.state, 'LANDED');
      assert.equal(landingJob!.confirmedAutomatically, true, 'the job record says the landing was automatic');

      // The ledger: the task's work is on main, and the receipt itself says nobody pressed it.
      const receipts = await mainReceipts(stack.db, taskId);
      assert.equal(receipts.length, 1, 'one receipt that the task is on main');
      assert.equal(receipts[0]!.result, 'MERGED');
      assert.equal(receipts[0]!.targetShaAfter, MERGE_COMMIT);
      assert.equal((receipts[0]!.detail as Record<string, unknown>).confirmedAutomatically, true,
        'the ledger marks this merge as the platform\'s, not a person\'s');
      assert.deepEqual([...merged.receiptIds].sort(), receipts.map((r) => r.id).sort());

      // The receipt card the conversation draws: what went onto main, that the setting did it, and
      // the one command that takes it back out.
      const [record] = await stack.promotions.readMerged(w.ownerId, w.projectId);
      assert.ok(record?.merged, 'the merge is on the record the conversation draws its receipt from');
      assert.equal(record.merged.sha, MERGE_COMMIT, 'the receipt names the merge commit now on main');
      assert.equal(record.merged.automatic, true, 'the receipt says it was merged under Automatic');
      assert.equal(record.merged.byUserId, null);
      assert.equal(record.merged.revert, `git revert -m 1 ${MERGE_COMMIT}`, 'and how to undo exactly this merge');
      assert.equal(record.landsAs, 'MERGE_COMMIT');
      assert.deepEqual(record.taskIds, [taskId], 'and what it carried');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (b) project branch + Automatic off: the card ────────────────────────────────────────────────

test('(b) a project branch with Automatic off is put in front of the owner, exactly as before',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'auto-off', { line: 'PROJECT_BRANCH', automatic: false });
      const { check } = await checkInHand(stack, w);
      const checked = await report(stack, w, check, cleanCheck());
      assert.equal(checked.accepted, true);
      await assertAskedAsBefore(stack, w, 'Automatic off');
      const [card] = await approvalCards(stack.db, w.projectId);
      assert.equal(checked.openItemId, card!.id, 'the result names the card it opened, as it always has');
      assert.equal((card!.payload as { upstreamShaChecked?: string }).upstreamShaChecked, MAIN_CHECKED);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (c) MAIN line + Automatic on: the card ──────────────────────────────────────────────────────

test('(c) a MAIN-line project asks for every merge into main, Automatic on or not',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'auto-main-line', { line: 'MAIN', automatic: true });
      // On a MAIN line the DONE itself makes the candidate — the task's own branch (M-F2).
      await doneCodeTask(stack, w, w.label);
      const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      assert.equal(check.promotionSourceKind, 'TASK_BRANCH');
      const checked = await report(stack, w, check, cleanCheck({ sourceSha: TASK_BRANCH_TIP }));
      assert.equal(checked.accepted, true);
      await assertAskedAsBefore(stack, w, 'a MAIN line with Automatic on');
      assert.equal((await promotionOf(stack.db, w.projectId)).sourceKind, 'TASK_BRANCH');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (d) project branch + Automatic on, but not clean: the card (or today's block) ───────────────

test('(d) a red check does not merge by itself: blocked for the coordinator as before, and nothing lands',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'auto-red', { line: 'PROJECT_BRANCH', automatic: true });
      const { check } = await checkInHand(stack, w);
      const failed = await report(stack, w, check, {
        state: 'CHECK_FAILED',
        phase: 'CHECK',
        sourceSha: LANDED_ON_LINE,
        targetShaBefore: MAIN_CHECKED,
        upstreamSha: MAIN_CHECKED,
        testedSha: CHECK_MERGE,
        testedTreeSha: CHECKED_TREE,
        checks: [{ ...GREEN_CHECK, exitCode: 1, outputTail: '1 failing\n' }],
      });
      assert.equal(failed.accepted, true);
      const promotion = await promotionOf(stack.db, w.projectId);
      assert.equal(promotion.state, 'BLOCKED', 'a red check blocks the candidate, as it always has');
      assert.equal(promotion.confirmedAutomatically, false);
      const items = await stack.db.projectOpenItem.findMany({ where: { projectId: w.projectId }, select: { kind: true, state: true } });
      assert.deepEqual(items, [{ kind: 'INTEGRATION_CHECK_FAILED', state: 'OPEN' }], 'the failing check is somebody\'s to look at');
      assert.deepEqual(await landingsOf(stack.db, w.projectId), [], 'nothing was queued to land');

      // And a READY that carries a red check is not taken at its word: the card, not a merge.
      const w2 = await world(stack, 'auto-red-ready', { line: 'PROJECT_BRANCH', automatic: true });
      const second = await checkInHand(stack, w2);
      await report(stack, w2, second.check, cleanCheck({ checks: [GREEN_CHECK, { ...GREEN_CHECK, exitCode: 2 }] }));
      await assertAskedAsBefore(stack, w2, 'a READY with a red check in it');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(d) a conflict does not merge by itself: blocked for the coordinator as before, and nothing lands',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'auto-conflict', { line: 'PROJECT_BRANCH', automatic: true });
      const { check } = await checkInHand(stack, w);
      const conflicted = await report(stack, w, check, {
        state: 'CONFLICT',
        phase: 'MERGE',
        sourceSha: LANDED_ON_LINE,
        targetShaBefore: MAIN_CHECKED,
        upstreamSha: MAIN_CHECKED,
        conflicts: ['src/apiserver/src/projects/project-promotion.service.ts'],
      });
      assert.equal(conflicted.accepted, true);
      const promotion = await promotionOf(stack.db, w.projectId);
      assert.equal(promotion.state, 'BLOCKED');
      assert.equal(promotion.confirmedAutomatically, false);
      const items = await stack.db.projectOpenItem.findMany({ where: { projectId: w.projectId }, select: { kind: true, state: true } });
      assert.deepEqual(items, [{ kind: 'INTEGRATION_CONFLICT', state: 'OPEN' }]);
      assert.deepEqual(await landingsOf(stack.db, w.projectId), [], 'nothing was queued to land');

      // A READY that still names conflicting paths is not a clean one either.
      const w2 = await world(stack, 'auto-conflict-ready', { line: 'PROJECT_BRANCH', automatic: true });
      const second = await checkInHand(stack, w2);
      await report(stack, w2, second.check, cleanCheck({ conflicts: ['README.md'] }));
      await assertAskedAsBefore(stack, w2, 'a READY that names a conflict');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(d) main moving after the check hands the merge back to the owner — nothing re-checked, nothing merged',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'auto-main-moved', { line: 'PROJECT_BRANCH', automatic: true });
      const { taskId, check } = await checkInHand(stack, w);
      await report(stack, w, check, cleanCheck());
      assert.equal((await promotionOf(stack.db, w.projectId)).confirmedAutomatically, true, 'clean at the check');
      const land = await onlyClaim(stack, w, 'LAND_PROMOTION');
      assert.equal(land.automatic, true);

      // The runner found main at MAIN_MOVED, not MAIN_CHECKED: it merges nothing, checks nothing,
      // and says READY (TestAutomaticPromotionHandsBackAMovedUpstream).
      const handedBack = await report(stack, w, land, {
        state: 'READY',
        phase: 'MERGE',
        sourceSha: LANDED_ON_LINE,
        targetShaBefore: MAIN_MOVED,
        upstreamSha: MAIN_MOVED,
      });
      assert.equal(handedBack.accepted, true);

      const promotion = await promotionOf(stack.db, w.projectId);
      assert.equal(promotion.state, 'READY', 'the candidate is a question again');
      assert.equal(promotion.confirmedAutomatically, false);
      assert.equal(promotion.confirmedByUserId, null);
      assert.equal(promotion.mergedSha, null, 'nothing was merged');
      assert.equal(promotion.landJobId, null, 'no landing is in flight');
      assert.equal(promotion.upstreamShaChecked, MAIN_CHECKED, 'the check it has is the one it had');
      assert.equal(promotion.mergeTreeSha, CHECKED_TREE);
      const cards = await approvalCards(stack.db, w.projectId);
      assert.equal(cards.length, 1, `main moved, so the owner is asked — ${await jobsOf(stack.db, w.projectId)}`);
      assert.equal(cards[0]!.state, 'OPEN');
      assert.equal(cards[0]!.assignee, 'OWNER');
      assert.equal(handedBack.openItemId, cards[0]!.id, 'the hand-back names the card it opened');
      assert.equal(promotion.openItemId, cards[0]!.id);
      assert.equal((cards[0]!.payload as { upstreamShaChecked?: string }).upstreamShaChecked, MAIN_CHECKED,
        'the card is about the main the check ran against, not the one the landing found');
      assert.deepEqual(await mainReceipts(stack.db, taskId), [], 'no receipt says the work is on main');
      const [attempted] = await landingsOf(stack.db, w.projectId);
      assert.equal(attempted!.state, 'READY', 'the automatic landing ended without landing');
      assert.equal(attempted!.confirmedAutomatically, true, 'and its record still says whose it was');
      assert.equal(attempted!.landedSha, null);
      const exceptions = await stack.db.projectOpenItem.count({
        where: { projectId: w.projectId, kind: { in: ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'] } },
      });
      assert.equal(exceptions, 0, 'a moved main is the owner\'s question, not a failure for the coordinator');

      // The owner presses the card, and from here it is the landing it always was: not the
      // setting's, bound to nothing tighter than M5, re-checked on the new main and merged.
      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, promotion.id, LANDED_ON_LINE);
      const pressed = await onlyClaim(stack, w, 'LAND_PROMOTION');
      assert.equal(pressed.automatic, undefined, 'the owner\'s landing carries no automatic mark');
      assert.equal(pressed.upstreamShaChecked, MAIN_CHECKED);
      await stack.jobs.progress(w.runnerId, pressed.jobId, {
        claimGeneration: pressed.claimGeneration,
        leaseOwner: pressed.leaseOwner,
        phase: 'MERGE',
        upstreamMoved: { from: MAIN_CHECKED, to: MAIN_MOVED, commits: 1 },
      });
      assert.equal((await promotionOf(stack.db, w.projectId)).state, 'RECHECKING', 'M5: re-checked, not asked again');
      await report(stack, w, pressed, {
        state: 'LANDED',
        phase: 'VERIFY',
        sourceSha: LANDED_ON_LINE,
        targetShaBefore: MAIN_MOVED,
        upstreamSha: MAIN_MOVED,
        testedSha: MERGE_COMMIT,
        testedTreeSha: CHECKED_TREE,
        landedSha: MERGE_COMMIT,
        landedTreeSha: CHECKED_TREE,
        checks: [GREEN_CHECK],
      });
      const merged = await promotionOf(stack.db, w.projectId);
      assert.equal(merged.state, 'MERGED');
      assert.equal(merged.confirmedByUserId, w.ownerId, 'merged by the owner\'s press');
      assert.equal(merged.confirmedAutomatically, false);
      const [record] = await stack.promotions.readMerged(w.ownerId, w.projectId);
      assert.equal(record?.merged?.automatic, false);
      assert.equal(record?.merged?.byUserId, w.ownerId);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(d) an integration exception still open on the project keeps its next merge in front of the owner',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'auto-open-item', { line: 'PROJECT_BRANCH', automatic: true });
      // Task one lands on the project branch; task two's landing conflicts and is left open.
      await doneCodeTask(stack, w, `${w.label}-one`);
      await doneCodeTask(stack, w, `${w.label}-two`);
      const first = await onlyClaim(stack, w, 'LAND_TASK');
      await report(stack, w, first, {
        state: 'LANDED',
        phase: 'VERIFY',
        sourceSha: TASK_BRANCH_TIP,
        targetShaBefore: LINE_BEFORE,
        testedSha: LANDED_ON_LINE,
        testedTreeSha: LANDED_TREE,
        landedSha: LANDED_ON_LINE,
        landedTreeSha: LANDED_TREE,
      });
      const second = await onlyClaim(stack, w, 'LAND_TASK');
      await report(stack, w, second, {
        state: 'CONFLICT',
        phase: 'REBASE',
        sourceSha: 'b'.repeat(40),
        targetShaBefore: LANDED_ON_LINE,
        conflicts: ['src/web/src/pages/ProjectsPage.tsx'],
      });
      const open = await stack.db.projectOpenItem.count({
        where: { projectId: w.projectId, kind: 'INTEGRATION_CONFLICT', state: 'OPEN' },
      });
      assert.equal(open, 1, 'the second task\'s conflict is open');

      // The queue is empty now, so the landing that finished last made the candidate; its check is clean.
      const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      await report(stack, w, check, cleanCheck());
      await assertAskedAsBefore(stack, w, 'an integration exception still open');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(d) a runner that would re-check a moved main and merge it is never trusted with an automatic merge',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'auto-older-runner', { line: 'PROJECT_BRANCH', automatic: true, capabilities: OLDER });
      const { check } = await checkInHand(stack, w);
      await report(stack, w, check, cleanCheck());
      await assertAskedAsBefore(stack, w, 'a runner that has not said it hands a moved main back');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(d) the authorization is read again when the landing is handed out: taken back since the check, the owner is asked and nothing lands',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // Automatic switched off between the check that confirmed the merge and the heartbeat that
      // would hand its landing to a runner: the yes it was queued under has been withdrawn.
      const off = await world(stack, 'auto-revoked', { line: 'PROJECT_BRANCH', automatic: true });
      const first = await checkInHand(stack, off);
      await report(stack, off, first.check, cleanCheck());
      assert.equal((await promotionOf(stack.db, off.projectId)).confirmedAutomatically, true, 'clean, Automatic on, at the check');
      await stack.db.project.update({
        where: { id: off.projectId },
        data: { coordinatorEnabled: false, configRevision: { increment: 1 } },
      });
      assert.deepEqual(await heartbeat(stack, off), [], 'a landing Automatic no longer covers was handed to a runner');
      await assertHandedBack(stack, off, first.taskId, 'Automatic switched off after the check');
      assert.equal(await stack.db.projectOpenItem.count({
        where: { projectId: off.projectId, kind: { in: ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'] } },
      }), 0, 'a withdrawn authorization is the owner\'s question, not a failure for the coordinator');

      // An integration exception opened on the project in the same interval — a later task's landing
      // on the project branch conflicted. Its landing is claimed by a process that is never handed an
      // automatic one, so it is the only job that moves before the one under test is claimed.
      const since = await world(stack, 'auto-item-since', { line: 'PROJECT_BRANCH', automatic: true });
      const second = await checkInHand(stack, since);
      await report(stack, since, second.check, cleanCheck());
      assert.equal((await promotionOf(stack.db, since.projectId)).confirmedAutomatically, true, 'clean at the check');
      await doneCodeTask(stack, since, `${since.label}-later`);
      const later = await onlyClaim(stack, since, 'LAND_TASK', OLDER);
      await report(stack, since, later, {
        state: 'CONFLICT',
        phase: 'REBASE',
        sourceSha: 'b'.repeat(40),
        targetShaBefore: LANDED_ON_LINE,
        conflicts: ['src/web/src/pages/ProjectsPage.tsx'],
      });
      assert.deepEqual(await heartbeat(stack, since), [], 'a landing an open exception now stands against was handed out');
      await assertHandedBack(stack, since, second.taskId, 'an integration exception opened after the check');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (e) the owner's own press: unchanged ────────────────────────────────────────────────────────

test('(e) the owner\'s confirmation still merges and leaves the receipt it always did',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'owner-press', { line: 'PROJECT_BRANCH', automatic: false });
      const { taskId, check } = await checkInHand(stack, w);
      await report(stack, w, check, cleanCheck());
      await assertAskedAsBefore(stack, w, 'before the press');
      const promotion = await promotionOf(stack.db, w.projectId);

      const view = await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, promotion.id, LANDED_ON_LINE);
      assert.equal(view.state, 'CONFIRMED');
      const [card] = await approvalCards(stack.db, w.projectId);
      assert.equal(card!.state, 'RESOLVED');
      assert.equal(card!.resolution, 'APPROVED');
      assert.equal(card!.resolvedBy, 'USER');
      const confirmed = await promotionOf(stack.db, w.projectId);
      assert.equal(confirmed.confirmedByUserId, w.ownerId);
      assert.equal(confirmed.confirmedAutomatically, false);

      const land = await onlyClaim(stack, w, 'LAND_PROMOTION');
      assert.equal(land.automatic, undefined, 'a pressed landing is not bound the way an automatic one is');
      assert.equal(land.upstreamShaChecked, MAIN_CHECKED);
      assert.equal(land.mergeTreeSha, CHECKED_TREE);
      const [queued] = await landingsOf(stack.db, w.projectId);
      assert.equal(queued!.confirmedAutomatically, false);

      await report(stack, w, land, {
        state: 'LANDED',
        phase: 'VERIFY',
        sourceSha: LANDED_ON_LINE,
        targetShaBefore: MAIN_CHECKED,
        upstreamSha: MAIN_CHECKED,
        testedSha: MERGE_COMMIT,
        testedTreeSha: CHECKED_TREE,
        landedSha: MERGE_COMMIT,
        landedTreeSha: CHECKED_TREE,
      });
      const merged = await promotionOf(stack.db, w.projectId);
      assert.equal(merged.state, 'MERGED');
      assert.equal(merged.mergedSha, MERGE_COMMIT);
      assert.equal(merged.confirmedByUserId, w.ownerId);
      const receipts = await mainReceipts(stack.db, taskId);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.result, 'MERGED');
      assert.equal('confirmedAutomatically' in (receipts[0]!.detail as Record<string, unknown>), false,
        'a pressed merge\'s receipt is written exactly as before');
      const [record] = await stack.promotions.readMerged(w.ownerId, w.projectId);
      assert.equal(record?.merged?.sha, MERGE_COMMIT);
      assert.equal(record?.merged?.byUserId, w.ownerId);
      assert.equal(record?.merged?.automatic, false);
    } finally {
      await stack.db.$disconnect();
    }
  });
