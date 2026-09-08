import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

import { RunStatus as SharedRunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import {
  ConvergenceCounters,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  ZERO_COUNTERS,
} from '../projects/convergence-contract';
import {
  COORDINATOR_NO_PROGRESS_KIND,
  PROJECT_NOT_CONVERGING,
  noProgressDedupeKey,
} from '../projects/coordinator-convergence';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionSubjectId } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import {
  CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED,
  CriterionUnlandedProducer,
} from '../projects/criterion-unlanded.producer';
import { criteriaFromDefinitions, criterionKeyOf } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { ProjectsService } from '../projects/projects.service';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * The three guardrails that keep "merge it" from becoming a machine that never stops.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-unlanded-merge-guardrails.pg.spec.js
 *
 * §0 — WHAT "A MERGE THAT FAILED" IS, GIVEN THAT NOTHING HERE MERGES
 * ==================================================================
 * The apiserver performs no merge. It tells the project's standing conversation to perform one,
 * and that conversation is a model turn on somebody else's runner. So there is no return value to
 * read and no exception to catch: the only thing this process can ever observe about a merge it
 * ordered is what the merge receipts say afterwards, and the observation is always the same
 * sentence — **this criterion's finished work is STILL not on the default branch**.
 *
 * That is the reading every case below is written against, and it is stated here because it is a
 * reading rather than a deduction: a retry is a SECOND observation that the work has not landed,
 * consecutive such observations are what the convergence budget counts, and crossing the budget is
 * what raises one blocker and stops the waking. Nothing waits for a merge to "come back", because
 * nothing here ever gets a merge back.
 *
 * §1 — THE THREE GUARDRAILS, AND WHY EACH ONE IS A DIFFERENT CASE
 * ===============================================================
 *   1. **The retry is charged.** `criterion-unlanded.producer.ts` composes its authorizer cheapest
 *      refusal first with `convergence.authorizeWake` LAST, so every observation that reaches the
 *      ledger has spent a convergence pass by the time it is allowed. Case (a) drives N + 3 of them
 *      and reads the `blocker_id` column, which is the only place the difference between "raised
 *      once, on the transition" and "re-derived on every later fact" is visible: the partial unique
 *      index over open blockers would absorb the second raise and leave the ROW count at one.
 *   2. **The same result is ordered merged once.** Case (c). The fact's identity is
 *      `settlementVersion(serving)` and deliberately carries no receipt, so re-observing one
 *      criterion's unchanged finished work is the same fact and stops at 0174's index. That claim
 *      is worth nothing on its own — a delivery point nobody wired satisfies it too — so the same
 *      fixture then files work against a DIFFERENT criterion and both counts move by one.
 *   3. **`project.status` is not written by any of this.** Not here: it is a claim about the whole
 *      source tree rather than about a run, and `projects/project-status-frozen-list.spec.ts`
 *      holds the frozen census list to the words it had before this work started.
 *
 * §2 — WHY THE OBSERVATIONS ARE MADE BY HAND, AND WHERE THEY ARE NOT
 * ==================================================================
 * Cases (a), (b) and (c) settle their work through the production write path with the router
 * silenced, and then call `routeUnlandedCriteria` themselves. Two reasons, both about being able
 * to say what the ledger rows mean:
 *
 *   * the write path delivers FOUR kinds of fact, and three of them charge the same budget. A run
 *     that let it deliver would produce a ledger this file cannot make an exact statement about,
 *     and "the unlanded fact is what spent the budget" would be an inference rather than an
 *     assertion (every case below asserts the ledger's `event` set is exactly one value);
 *   * an observation is the unit under test. Making it explicitly is what lets a case put a merge
 *     receipt — or nothing at all — between two of them.
 *
 * Case (d), the switched-off control, does the opposite and drives the whole write path, because
 * what it has to show is that the switch stops a fact that would otherwise have travelled the
 * production route from a task's settlement all the way to the budget.
 *
 * §3 — WHAT MOVES THE FACT, AND WHY EVERY ROUND FILES ANOTHER PIECE OF WORK
 * =========================================================================
 * `criterionUnlandedFact`'s version is a digest of `(taskId, status)` over the criterion's serving
 * set, and receipts are deliberately not in it. So observing the same criterion twice with nothing
 * else changed is ONE fact by construction — which is guardrail 2, and is asserted as such in (c).
 * It also means a case that wants N consecutive observations has to move the serving set N times,
 * and the honest way to move it is the way a coordinator moves it: file another piece of work
 * against the same criterion and let it finish. Every round below does exactly that, so each round
 * is a real second observation rather than the same one delivered twice.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** N: the documented default, read from the frozen table rather than restated as a literal. */
const N = DEFAULT_CONVERGENCE_THRESHOLDS.maxDecisionsWithoutProgress as number;

/** Every counter name, from the contract's own zero, so a new one cannot skip the monotonicity. */
const COUNTER_NAMES = Object.keys(ZERO_COUNTERS) as Array<keyof ConvergenceCounters>;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';
/** The declaration every serving task carries, so its DONE is a comparison that happened. */
const ACCEPTANCE = { acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };

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
  /** The runner door, holding the one `TasksService` the production module gives it. */
  api: RunnerApiController;
  tasks: TasksService;
  projects: ProjectsService;
  /** The fifth door, so a case can make one observation at a time. */
  router: CompletionInputRouter;
}

/**
 * The production wiring, over one client, with no double anywhere in it.
 *
 * `silent` swaps the router the WRITE PATH holds for four doors that deliver nothing; the real one
 * is returned either way, so a silenced stack is a stack whose deliveries a case makes itself. The
 * convergence ledger is never substituted: what these cases are about is what the real budget does
 * with real facts, and a double would answer that with its own arithmetic.
 */
async function connect(options: { silent?: boolean } = {}): Promise<Stack> {
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
  const silent = {
    routeSettledProjects: async () => [],
    routeTaskExceptions: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
  } as unknown as CompletionInputRouter;
  const tasks = new TasksService(
    prisma, sessions, realtime, undefined, options.silent ? silent : router,
  );
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
  );
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
  return { db, api, tasks, projects, router };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The task that serves no criterion and never finishes, so the project cannot settle. */
  choreTaskId: string;
  /** The standing conversation this project is coordinated from. */
  coordinatorSessionId: string;
}

interface Space {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

/** One owner, one online runner, one workspace — shared by the projects a case compares. */
async function space(db: PrismaClient, label: string): Promise<Space> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@unlanded-guardrails.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  return { ownerId, runnerId, workspaceId };
}

/**
 * One project with the standing conversation a merge would be ordered from.
 *
 * `AWAITING_INPUT` and `dispatch_origin: USER`, which is what `ProjectsService.coordinator` writes
 * and the state a coordinator is really in between turns: it is one of `SessionsService.LIVE`, so
 * a delivery APPENDS a turn to it rather than reviving anything.
 *
 * Titles and goals here name no file. `blocker-disposition.ts` reads a task's declaration for the
 * paths it authorizes, and a fixture that mentioned one would be filing work whose declared scope
 * is a path — which raises a blocker for a reason that has nothing to do with these cases.
 */
async function fixture(
  stack: Stack,
  home: Space,
  label: string,
  options: { coordinatorEnabled?: boolean } = {},
): Promise<Fixture> {
  const db = stack.db;
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId: home.ownerId,
      creatorId: home.ownerId,
      workspaceId: home.workspaceId,
      assignedRunnerId: home.runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
    },
  });
  // The opening prompt a conversation somebody has been talking to already carries, seeded here so
  // that the deliveries below are not the thing that seeds it.
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `协调：${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId: home.ownerId,
      title: `${label} 合并护栏`,
      goal: '干完但没落 main 的成果，交给已经在协调的那条会话，并且有个尽头',
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: home.workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const chore = await stack.tasks.create(home.ownerId, {
    title: `${label} 与任何标准无关的杂活`,
    assigneeId: home.workspaceId,
    projectId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    autoRunWhenReady: false,
  } as never);
  return {
    ownerId: home.ownerId,
    runnerId: home.runnerId,
    workspaceId: home.workspaceId,
    projectId,
    choreTaskId: chore.id,
    coordinatorSessionId,
  };
}

/**
 * State the whole collection through the owner's own path, ONCE per fixture.
 *
 * Once, and not once per round: re-stating a criterion advances its `revision`, every task already
 * declared against it reads as work whose exam moved, and `blocker-disposition.ts` stops such a
 * delivery for a person. That is correct behaviour and it is not what any case here is measuring.
 */
async function state(stack: Stack, f: Fixture, texts: string[]) {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems);
}

/** File one piece of EXECUTABLE work against a criterion, through the door that resolves the key. */
async function serve(stack: Stack, f: Fixture, criterionKey: string, title: string) {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    criterionKey,
    ...ACCEPTANCE,
    autoRunWhenReady: false,
  } as never);
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
}

/**
 * Settle one task the way production settles most of them: an acceptance command that ran.
 *
 * The whole route is the product's own — an attempt session, the model turn that ends, the shell
 * turn the same transaction queues, a real bash exit code, and the comparison `turnComplete` makes
 * under the task's row lock. This function never writes `task.status`.
 */
async function settleByAcceptance(stack: Stack, f: Fixture, taskId: string, label: string) {
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await stack.db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'execute the task',
      status: 'IN_FLIGHT',
    },
  });
  const opened = await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: messageTurnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  assert.deepEqual(opened, { ok: true, status: RunStatus.RUNNING });

  const next = await (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, f.runnerId, null);
  assert.ok(next);
  assert.equal(next.kind, 'shell');
  assert.equal(next.taskAcceptance, true);

  const shell = spawnSync('bash', ['-lc', next.content!], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  assert.equal(shell.status, ACCEPTANCE.acceptanceExpectedExitCode);
  await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: next.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: `${shell.stdout}${shell.stderr}`,
  });

  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    TaskStatus.DONE,
    'the comparison between the declared code and the one bash returned is what wrote this status',
  );
}

/** File one more piece of work against this criterion and finish it. One more observation's worth. */
async function anotherFinishedPiece(
  stack: Stack,
  f: Fixture,
  criterionKey: string,
  round: number,
): Promise<string> {
  const taskId = await serve(stack, f, criterionKey, `第 ${round} 件干完但还没落 main 的活`);
  await settleByAcceptance(stack, f, taskId, `round-${round}`);
  return taskId;
}

/**
 * Record one merge against this task's branch.
 *
 * `MERGED` into `main` is the only shape `receiptIsLandingEvidence` accepts, and it is what a case
 * writes when it means "this really landed". Every other shape — a merge that git refused, one
 * that errored, one into somebody else's branch — leaves the criterion exactly as unlanded as it
 * was, which is what makes an `ERROR` receipt the honest way to say "the merge was attempted and
 * did not happen".
 */
async function recordMerge(
  stack: Stack,
  f: Fixture,
  taskId: string,
  label: string,
  result: 'MERGED' | 'ERROR',
) {
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: `${label}-merge`,
      prompt: `${label}-merge`,
      provider: 'claude',
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await stack.db.sessionMergeReceipt.create({
    data: {
      ownerId: f.ownerId,
      sessionId,
      taskId,
      projectId: f.projectId,
      result,
      sourceBranch: `orbit/${label}`,
      sourceSha: 'a'.repeat(40),
      targetBranch: 'main',
      targetShaBefore: 'b'.repeat(40),
      ...(result === 'MERGED' ? { targetShaAfter: 'c'.repeat(40) } : {}),
      recordedBy: 'AGENT',
      idempotencyKey: `${result.toLowerCase()}:${taskId}`,
    },
  });
}

/**
 * The row id behind a criterion's stable key.
 *
 * Resolved by re-deriving the key with `criterionKeyOf` rather than by parsing it: how a criterion
 * is named is that function's, and a second reading of it here would be a second definition of
 * what a criterion is called.
 */
async function definitionIdOf(stack: Stack, f: Fixture, criterionKey: string): Promise<string> {
  const stated = await stack.db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId: f.projectId },
    select: { id: true },
  });
  const found = stated.find((row) => criterionKeyOf(row.id) === criterionKey);
  assert.ok(found, 'this project states no criterion with that key');
  return found.id;
}

/** Land every piece of work serving this criterion that has not landed yet. */
async function landEverything(stack: Stack, f: Fixture, criterionKey: string) {
  const serving = await stack.db.task.findMany({
    where: { projectId: f.projectId, criterionDefinitionId: await definitionIdOf(stack, f, criterionKey) },
    select: { id: true, mergeReceipts: { select: { result: true, targetBranch: true } } },
  });
  assert.ok(serving.length > 0, 'no work serves the criterion this call was asked to land');
  for (const task of serving) {
    if (task.mergeReceipts.some((r) => r.result === 'MERGED' && r.targetBranch === 'main')) continue;
    await recordMerge(stack, f, task.id, `landed-${task.id.slice(0, 8)}`, 'MERGED');
  }
}

/** One observation of every criterion this project states, through the door production uses. */
function observe(stack: Stack, f: Fixture) {
  return stack.router.routeUnlandedCriteria([f.projectId]);
}

/**
 * The runner picks the message up, answers it, and the conversation parks again.
 *
 * Written on the row rather than driven through the runner door, and named so the shortcut is
 * visible: a delivery moves a parked conversation to PENDING, and `resume` refuses to queue a
 * second message behind one nobody has read. What every case here is about is the state a
 * coordinator is in when the NEXT observation arrives, which is this one.
 */
async function coordinatorReadsIt(db: PrismaClient, f: Fixture) {
  await db.conversationTurn.updateMany({
    where: { sessionId: f.coordinatorSessionId, status: 'PENDING' },
    data: { status: 'ANSWERED', answeredAt: new Date() },
  });
  await db.session.update({
    where: { id: f.coordinatorSessionId },
    data: { status: RunStatus.AWAITING_INPUT },
  });
}

/** The ledger, oldest first — the audit, read the way a person would. */
function decisions(db: PrismaClient, projectId: string) {
  return db.projectConvergenceDecision.findMany({ where: { projectId }, orderBy: { seq: 'asc' } });
}

function noProgressBlockers(db: PrismaClient, projectId: string) {
  return db.projectBlocker.findMany({
    where: { projectId, kind: COORDINATOR_NO_PROGRESS_KIND },
    orderBy: { lifecycleGeneration: 'asc' },
  });
}

function allBlockers(db: PrismaClient, projectId: string) {
  return db.projectBlocker.findMany({ where: { projectId }, select: { kind: true } });
}

function unlandedWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'CRITERION_UNLANDED' },
    select: {
      subjectId: true,
      subjectVersion: true,
      status: true,
      refusalCode: true,
      consumerType: true,
      sessionId: true,
      delivery: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Every message this project's standing conversation has been SENT, oldest first.
 *
 * The seeded opening turn is excluded, exactly as `SessionsService`'s own queued-turn reader
 * excludes it: it is the conversation's own prompt rather than something anybody told it.
 */
function coordinatorMessages(db: PrismaClient, f: Fixture) {
  return db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    select: { clientTurnId: true, content: true },
    orderBy: { seq: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

function decisionsWithoutProgress(rows: Array<{ counters: unknown }>): number[] {
  return rows.map((row) => (row.counters as ConvergenceCounters).decisionsWithoutProgress);
}

/**
 * Nothing the ledger counts ever walks backwards while nothing improves.
 *
 * Asserted over EVERY counter rather than the one these runs move: a counter that went down
 * without progress is the shape every escape from this breaker has — a restart re-initialising
 * from zero, a redelivery processed as a fresh charge, a second writer starting its own count —
 * and which counter it happened to be is not the interesting part.
 */
function assertCountersNeverRetreat(rows: Array<{ counters: unknown }>, where: string): void {
  for (let i = 1; i < rows.length; i += 1) {
    const before = rows[i - 1]!.counters as ConvergenceCounters;
    const after = rows[i]!.counters as ConvergenceCounters;
    for (const name of COUNTER_NAMES) {
      assert.ok(
        after[name] >= before[name],
        `${where}: counter ${name} fell from ${before[name]} to ${after[name]} between decisions `
        + `${i} and ${i + 1}, and nothing in this run improved`,
      );
    }
  }
}

// (a) ---------------------------------------------------------------------------------------------
/**
 * The whole of the stop-loss, over the fact a merge is ordered from.
 *
 * N + 3 observations that the same criterion's finished work is still off `main`, each of them a
 * genuinely new fact because the criterion gained one more finished piece of work between them.
 * Nothing improves, so every one of them is a decision without progress; the N + 1th crosses the
 * line and is the only one that raises anything.
 */
test('a criterion observed unlanded past the budget raises one blocker, at the crossing',
  { skip, timeout: 900_000 }, async () => {
    const stack = await connect({ silent: true });
    try {
      const home = await space(stack.db, 'unlanded-budget');
      const f = await fixture(stack, home, 'stalled');
      const [criterion] = await state(stack, f, ['这条标准的活一直干完，一直没落 main']);

      const ledgerRows: number[] = [];
      const openRows: number[] = [];
      const outcomes: string[] = [];
      for (let round = 1; round <= N + 3; round += 1) {
        await anotherFinishedPiece(stack, f, criterion!.key, round);
        const [delivered, ...rest] = await observe(stack, f);
        assert.deepEqual(rest, [], `round ${round} observed more than one criterion`);
        assert.equal(delivered!.criterionSubjectId, criterionSubjectId(f.projectId, criterion!.key));
        outcomes.push(delivered!.outcome);
        ledgerRows.push((await decisions(stack.db, f.projectId)).length);
        openRows.push((await noProgressBlockers(stack.db, f.projectId)).length);
        await coordinatorReadsIt(stack.db, f);
      }

      // 1. Each observation is one more judgment. A door that stopped charging once the project was
      //    stopped — or one that never charged at all — reads flat here.
      const ledger = await decisions(stack.db, f.projectId);
      assert.deepEqual(
        ledgerRows,
        Array.from({ length: N + 3 }, (_, index) => index + 1),
        'each observation that the work is still off main must leave one more decision',
      );
      assert.deepEqual(
        [...new Set(ledger.map((row) => row.event))],
        ['CRITERION_UNLANDED'],
        'every decision in this run was charged to the unlanded fact, not to a sibling door',
      );

      // 2. The counters, monotone. The exact sequence is asserted as well as the property, because
      //    a budget that charged the same fact twice would also be monotone.
      assert.deepEqual(
        decisionsWithoutProgress(ledger),
        Array.from({ length: N + 3 }, (_, index) => index + 1),
        'a merge that has not happened improves nothing, so every observation is progress-free',
      );
      assertCountersNeverRetreat(ledger, 'stalled');
      assert.deepEqual(
        ledger.map((row) => row.progressed),
        Array.from({ length: N + 3 }, () => false),
      );

      // 3. The transition, and only the transition. `blocker_id` is the column that says which
      //    DECISION raised the row: a stop re-derived on every later observation would show a
      //    second id here while the open-row count below stayed at one.
      assert.deepEqual(
        ledger.map((row) => row.raisedBlockerId !== null),
        [...Array.from({ length: N }, () => false), true, false, false],
        'the blocker belongs to the observation that CROSSED the limit and to no other',
      );
      assert.deepEqual(
        openRows,
        [...Array.from({ length: N }, () => 0), 1, 1, 1],
        'before the crossing there is no row to act on, and after it there is exactly one',
      );
      assert.deepEqual(
        ledger.map((row) => row.outcome),
        [...Array.from({ length: N }, () => 'PROCEED'), 'STOP', 'STOP', 'STOP'],
        'the limit is crossed once and stays crossed',
      );
      assert.equal(ledger[N]!.nonConvergenceReason, 'NO_PROGRESS');
      assert.equal(ledger[N]!.crossedLimit, N);
      assert.equal(ledger[N]!.observed, N + 1);

      const raised = await noProgressBlockers(stack.db, f.projectId);
      assert.equal(raised.length, 1);
      assert.equal(raised[0]!.id, ledger[N]!.raisedBlockerId);
      assert.equal(raised[0]!.subjectType, 'PROJECT');
      assert.equal(raised[0]!.subjectId, f.projectId);
      assert.equal(raised[0]!.dedupeKey, noProgressDedupeKey(f.projectId));
      assert.equal(
        raised[0]!.lifecycleGeneration, 1n,
        'one episode, not one per observation — a second generation is a project that stalled twice',
      );
      assert.equal(raised[0]!.resolvedAt, null);

      // 4. What the budget is FOR: past the crossing the observations stop ordering anything. The
      //    refusal is the ledger's own rather than a delivery that quietly failed, and the standing
      //    conversation is told nothing further — which is the merge loop actually stopping.
      assert.deepEqual(
        outcomes,
        [...Array.from({ length: N }, () => 'DELIVERED'), 'REFUSED', 'REFUSED', 'REFUSED'],
      );
      const wakes = await unlandedWakes(stack.db, f.projectId);
      assert.equal(wakes.length, N + 3);
      assert.equal(wakes.filter((wake) => wake.status === 'DELIVERED').length, N);
      const stopped = wakes.filter((wake) => wake.status === 'REFUSED');
      assert.equal(stopped.length, 3);
      assert.deepEqual([...new Set(stopped.map((w) => w.refusalCode))], [PROJECT_NOT_CONVERGING]);
      assert.equal(
        (await coordinatorMessages(stack.db, f)).length, N,
        'the standing conversation was told to merge after the budget said to stop',
      );
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

// (b) ---------------------------------------------------------------------------------------------
/**
 * The control: the same run, with the work actually landing partway through it.
 *
 * Both projects are driven by the same loop, the same number of times, filing and finishing the
 * same shape of work against one criterion each. One statement differs — from round
 * `LANDS_FROM_ROUND` the second project's serving work carries a `MERGED` receipt into `main` —
 * and everything asserted below follows from that one row.
 *
 * What the difference IS, stated precisely, because it is not the sibling exception ledger's
 * shape: landing is not a dimension of the progress vector (`convergence-progress.ts` §4 freezes
 * that list, and a merge receipt moves none of its counts), so a landing does not RESET the
 * counters. What it does is end the fact: `criterionUnlandedFact` returns null for a criterion
 * whose every serving task has landing evidence, so from that round on there is nothing to charge.
 * A budget that went on being spent on work that had landed is the failure this pair rules out.
 */
test('work that lands stops the budget being spent; the identical run without it does not',
  { skip, timeout: 900_000 }, async () => {
    const stack = await connect({ silent: true });
    try {
      const home = await space(stack.db, 'unlanded-control');
      const stalled = await fixture(stack, home, 'never-lands');
      const landing = await fixture(stack, home, 'lands-partway');
      const [stalledCriterion] = await state(stack, stalled, ['这条标准的活一直没落 main']);
      const [landingCriterion] = await state(stack, landing, ['这条标准的活中途落了 main']);

      const LANDS_FROM_ROUND = 4;
      for (let round = 1; round <= N + 1; round += 1) {
        await anotherFinishedPiece(stack, stalled, stalledCriterion!.key, round);
        await anotherFinishedPiece(stack, landing, landingCriterion!.key, round);
        // The only variable in this loop.
        if (round >= LANDS_FROM_ROUND) await landEverything(stack, landing, landingCriterion!.key);
        await observe(stack, stalled);
        await observe(stack, landing);
        await coordinatorReadsIt(stack.db, stalled);
        await coordinatorReadsIt(stack.db, landing);
      }

      const stalledLedger = await decisions(stack.db, stalled.projectId);
      const landedLedger = await decisions(stack.db, landing.projectId);

      // Both halves really were driven the same number of times, with the same amount of work.
      for (const [f, key] of [
        [stalled, stalledCriterion!.key] as const,
        [landing, landingCriterion!.key] as const,
      ]) {
        assert.equal(
          await stack.db.task.count({
            where: { projectId: f.projectId, criterionDefinitionId: await definitionIdOf(stack, f, key) },
          }),
          N + 1,
          'the two halves did not receive the same amount of work',
        );
      }

      // The stalled half, restated here because it is this case's baseline: without it "the
      // counters behaved differently" has nothing to differ from.
      assert.deepEqual(
        decisionsWithoutProgress(stalledLedger),
        Array.from({ length: N + 1 }, (_, index) => index + 1),
      );
      assertCountersNeverRetreat(stalledLedger, 'never-lands');

      // The landing half: charged for exactly the observations made BEFORE the work landed, and
      // for none afterwards.
      assert.deepEqual(
        decisionsWithoutProgress(landedLedger),
        Array.from({ length: LANDS_FROM_ROUND - 1 }, (_, index) => index + 1),
        'the budget went on being spent on work that was already on main',
      );
      assert.notDeepEqual(
        decisionsWithoutProgress(landedLedger),
        decisionsWithoutProgress(stalledLedger),
        'a run in which the work landed must not spend its budget like one in which it did not',
      );
      assertCountersNeverRetreat(landedLedger, 'lands-partway');

      // And the consequence a person sees: the same N + 1 rounds stop one project and not the
      // other. Nothing was raised on the landing project at all — not raised and cleared.
      assert.equal((await noProgressBlockers(stack.db, stalled.projectId)).length, 1);
      assert.equal(
        stalledLedger[N]!.raisedBlockerId,
        (await noProgressBlockers(stack.db, stalled.projectId))[0]!.id,
      );
      assert.deepEqual(
        landedLedger.map((row) => row.raisedBlockerId),
        Array.from({ length: LANDS_FROM_ROUND - 1 }, () => null),
      );
      assert.deepEqual(await noProgressBlockers(stack.db, landing.projectId), []);
      assert.deepEqual(
        [...new Set(landedLedger.map((row) => row.outcome))], ['PROCEED'],
        'a project whose work reached main was stopped anyway',
      );

      // The one row the whole difference rests on, read back rather than assumed.
      assert.equal(
        await stack.db.sessionMergeReceipt.count({
          where: { projectId: stalled.projectId, result: 'MERGED', targetBranch: 'main' },
        }),
        0,
      );
      assert.equal(
        await stack.db.sessionMergeReceipt.count({
          where: { projectId: landing.projectId, result: 'MERGED', targetBranch: 'main' },
        }),
        N + 1,
        'the landing half did not actually land its work, so the comparison above proves nothing',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

// (c) ---------------------------------------------------------------------------------------------
/**
 * One result, one merge instruction — and a second result to prove that is idempotency rather than
 * silence.
 *
 * The middle of this case is the observation that matters most under §0: a merge really was
 * attempted, it really did not land (an `ERROR` receipt into `main`), and the criterion is
 * re-observed. That is the retry, and it must not become a second order to merge the same thing.
 */
test('the same unlanded result is ordered merged once; a different result is ordered too',
  { skip, timeout: 600_000 }, async () => {
    const stack = await connect({ silent: true });
    try {
      const home = await space(stack.db, 'said-once');
      const f = await fixture(stack, home, 'one-order-per-result');
      const [first, second] = await state(stack, f, [
        '第一条标准的活干完了但没合', '第二条标准的活也干完了但没合',
      ]);
      const firstWork = await serve(stack, f, first!.key, '第一条标准的那件活');
      await settleByAcceptance(stack, f, firstWork, 'first');
      assert.deepEqual(
        await unlandedWakes(stack.db, f.projectId), [],
        'the silenced write path delivered something, so the observations below are not the only ones',
      );

      // ── the first observation ─────────────────────────────────────────────────────────────────
      assert.deepEqual(await observe(stack, f), [{
        criterionSubjectId: criterionSubjectId(f.projectId, first!.key),
        outcome: 'DELIVERED',
        action: 'MERGE_AND_RELEASE_NEXT',
      }]);
      const afterFirst = await coordinatorMessages(stack.db, f);
      assert.equal(afterFirst.length, 1);
      assert.match(
        afterFirst[0]!.content ?? '', /project_merge_evidence/,
        'the message left out the merge order, which is the only reason it is worth sending',
      );
      assert.equal((await unlandedWakes(stack.db, f.projectId)).length, 1);
      await coordinatorReadsIt(stack.db, f);

      // ── the merge was attempted and it did not land; observe the same result again ────────────
      // An ERROR receipt into `main` is a merge that happened and produced nothing: it is not
      // landing evidence, so the criterion is exactly as unlanded as it was, and this observation
      // is the retry §0 defines. The serving set has not moved, so the fact has not either.
      await recordMerge(stack, f, firstWork, 'refused-by-git', 'ERROR');
      assert.deepEqual(await observe(stack, f), [{
        criterionSubjectId: criterionSubjectId(f.projectId, first!.key),
        outcome: 'ALREADY_AWAKE',
      }]);
      assert.deepEqual(
        await coordinatorMessages(stack.db, f), afterFirst,
        'the same unlanded result was ordered merged a second time',
      );
      assert.equal(
        (await unlandedWakes(stack.db, f.projectId)).length, 1,
        'the same unlanded result left a second row in the wake ledger',
      );
      await coordinatorReadsIt(stack.db, f);

      // ── a DIFFERENT result, in the same fixture: both counts move by one ──────────────────────
      // Without this half every count above is equally true of a delivery point nobody wired.
      const secondWork = await serve(stack, f, second!.key, '第二条标准的那件活');
      await settleByAcceptance(stack, f, secondWork, 'second');
      assert.deepEqual(await observe(stack, f), [
        // The first criterion is still unlanded and still the same fact: observed again in the
        // same pass, and still ordered nothing.
        {
          criterionSubjectId: criterionSubjectId(f.projectId, first!.key),
          outcome: 'ALREADY_AWAKE',
        },
        {
          criterionSubjectId: criterionSubjectId(f.projectId, second!.key),
          outcome: 'DELIVERED',
          action: 'MERGE_AND_RELEASE_NEXT',
        },
      ]);
      const afterSecond = await coordinatorMessages(stack.db, f);
      assert.equal(afterSecond.length, afterFirst.length + 1, 'a second result ordered nothing');
      assert.notEqual(
        afterSecond[1]!.clientTurnId, afterSecond[0]!.clientTurnId,
        'two results wrote one turn key',
      );
      const ledger = await unlandedWakes(stack.db, f.projectId);
      assert.equal(ledger.length, 2, 'two results, two rows — no more and no fewer');
      assert.deepEqual(ledger.map((row) => row.status), ['DELIVERED', 'DELIVERED']);
      assert.deepEqual(
        ledger.map((row) => row.sessionId),
        [f.coordinatorSessionId, f.coordinatorSessionId],
      );
      assert.notEqual(
        ledger[0]!.subjectId, ledger[1]!.subjectId,
        'both rows are about one criterion, so the pair proves nothing about a different result',
      );
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      // Three observations, two of which reached the budget: the repeat did not charge one either.
      assert.equal((await decisions(stack.db, f.projectId)).length, 2);
    } finally {
      await stack.db.$disconnect();
    }
  });

// (d) ---------------------------------------------------------------------------------------------
/**
 * The negative, and the positive that keeps it honest.
 *
 * "No decision rows and no blocker" is true of a project nobody ever delivered anything to, so
 * asserted alone it would survive the delivery point being deleted outright. Both halves are
 * therefore the SAME project driven through the SAME production write path, and the only thing
 * that changes between them is the switch. This case is the one that does NOT silence the router:
 * what it has to show is that a fact travelling the real route from a task's settlement is stopped
 * on the column before anything is charged.
 *
 * The ledger claims before it authorizes, so the switched-off half leaves exactly ONE row saying
 * so — never an empty table.
 */
test('a switched-off coordinator charges no budget, raises no blocker, and leaves one refusal',
  { skip, timeout: 600_000 }, async () => {
    const stack = await connect();
    try {
      const home = await space(stack.db, 'unlanded-switch');
      const f = await fixture(stack, home, 'switched-off', { coordinatorEnabled: false });
      const [criterion] = await state(stack, f, ['开关关着，活干完了但还在分支上']);

      const dark = await serve(stack, f, criterion!.key, '开关关着时干完的那件活');
      await settleByAcceptance(stack, f, dark, 'switched-off');

      const refused = await unlandedWakes(stack.db, f.projectId);
      assert.equal(refused.length, 1, 'the unlanded criterion never reached the wake ledger');
      assert.equal(refused[0]!.status, 'REFUSED');
      assert.equal(refused[0]!.refusalCode, CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED);
      assert.equal(refused[0]!.sessionId, null);
      assert.equal(refused[0]!.consumerType, null);
      assert.equal(refused[0]!.delivery, null);
      assert.notEqual(refused[0]!.status, 'DELIVERED');

      // The three things this case adds to its siblings: the switch refuses BEFORE the convergence
      // ledger is reached, so no pass is charged; nothing is raised for a person; and the standing
      // conversation is told nothing.
      assert.deepEqual(
        await decisions(stack.db, f.projectId), [],
        'a refusal cheaper than convergence must not have charged a convergence pass',
      );
      assert.deepEqual(await allBlockers(stack.db, f.projectId), []);
      assert.deepEqual(await coordinatorMessages(stack.db, f), []);
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      // And the switch is not read by the door that settles work: the task finished exactly as it
      // would have with the switch on, and only the wake was refused.
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: dark } })).status,
        TaskStatus.DONE,
      );

      // ── one variable, flipped ────────────────────────────────────────────────────────────────
      // Everything else about the next write is what the one above was: the same project, the same
      // criterion, the same declaration, the same settlement route.
      await stack.db.project.update({
        where: { id: f.projectId },
        data: { coordinatorEnabled: true },
      });
      const lit = await serve(stack, f, criterion!.key, '开关开着时干完的那件活');
      await settleByAcceptance(stack, f, lit, 'switched-on');

      // Two, and naming both is the point: the write path derives the readiness fact and the
      // landing fact from the same committed rows, and BOTH carry a producer-owned authorizer that
      // ends at the convergence ledger. The switched-off half charged neither.
      const charged = await decisions(stack.db, f.projectId);
      assert.deepEqual(
        charged.map((row) => row.event),
        ['CRITERION_READY', 'CRITERION_UNLANDED'],
        'with the switch on, the same kind of write is judged',
      );
      assert.deepEqual(decisionsWithoutProgress(charged), [1, 2]);
      const both = await unlandedWakes(stack.db, f.projectId);
      assert.equal(both.length, 2);
      assert.deepEqual(
        both.map((wake) => wake.status).sort(),
        ['DELIVERED', 'REFUSED'],
        'the switched-off write kept its refusal, and the switched-on one reached the coordinator',
      );
      assert.equal(
        (await coordinatorMessages(stack.db, f)).length, 1,
        'with the switch on the standing conversation was told nothing either, so the negative '
          + 'above is a statement about a delivery point that does not work',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the unlanded-guardrail PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
