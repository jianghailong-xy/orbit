import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  CompletionInputRouter,
  type TaskExceptionDelivery,
} from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criterionSubjectId } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import {
  CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED,
  CriterionUnlandedProducer,
  type CriterionUnlandedDelivery,
} from './criterion-unlanded.producer';
import { MECHANICAL_ACTIONS, type MechanicalAction } from './mechanical-disposition';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import {
  EXCEPTION_WAKE_COORDINATOR_DISABLED,
  TaskExceptionInputProducer,
} from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * The four rounds that needed no judgement, and the one action each one settles.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/projects/mechanical-disposition.pg.spec.js
 *
 * WHAT IS DRIVEN, AND WHY IT IS DRIVEN THAT WAY
 * =============================================
 * Every input here is a round that actually happened. The task declares a command, the runner door
 * queues it, bash runs it, the exit code goes back through `/turn-complete`, and the comparison
 * under the task's own row lock writes DONE or FAILED — the same route production settles nearly
 * every task by. Nothing writes `task.status`, nothing calls a producer by hand, and nothing hands
 * the unit under test an observation: the deliveries these cases read are the ones the post-commit
 * edge made on its own, captured by a router that records what the real one returned.
 *
 * That matters most for the two inputs the acceptance criteria single out. "Was anything else
 * running?" is counted from another task's acceptance turn that is genuinely still in flight, and
 * flipping it means finishing that round first. "Is `main` red too?" is answered by cloning the
 * project's bound repository at its integration ref and RUNNING the check there, and flipping it
 * means committing to that repository. Neither is a boolean this file passes to anybody.
 *
 * WHY THE CHECK IS AFFORDABLE HERE
 * ================================
 * Because the check is the TASK's, not this suite's. The probe runs whatever the task declared, so
 * a fixture that declares `test ! -e <marker>` gets a real clone, a real execution and a real exit
 * code for about a fifth of a second — while a task whose declaration is a whole round would cost
 * a whole round, which is exactly why the production unit bounds it and answers UNKNOWN rather
 * than holding a delivery open.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

/** The marker whose presence in a tree makes the declared check below fail in that tree. */
const MARKER = 'the-check-fails-here';

/**
 * The declaration every judged task carries.
 *
 * One command, run in two places: in the round's own tree, and — when the round comes back red —
 * at the tip of `main`. Which tree it runs in is the only difference between the two answers, which
 * is what makes "is this red mine?" a question about the world rather than about a flag.
 */
const CHECK = { acceptanceCommand: `test ! -e ${MARKER}`, acceptanceExpectedExitCode: 0 };

/** A declaration that outlives the patience of whoever runs it, so a kill is what ends it. */
const SLOW_CHECK = { acceptanceCommand: 'sleep 30', acceptanceExpectedExitCode: 0 };

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

/** Everything one delivery answered, in the order the post-commit edge produced it. */
interface Recorded {
  exceptions: TaskExceptionDelivery[];
  criteria: CriterionUnlandedDelivery[];
}

interface Stack {
  db: PrismaClient;
  api: RunnerApiController;
  tasks: TasksService;
  projects: ProjectsService;
  recorded: Recorded;
}

/**
 * The production wiring, over one client, with one seam that changes nothing.
 *
 * The router is the real one. What wraps it records what its doors RETURNED, because the caller in
 * production is `TasksService`, which logs a failure and drops the answer — so a spec that wants to
 * see the action the real edge chose has to watch the door rather than call it. Calling the doors
 * directly instead would be worse than a seam: the post-commit edge has already claimed the fact's
 * idempotency key by then, and a second delivery of it answers ALREADY_AWAKE.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorConvergenceService(prisma),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new WakeDispositionService(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  const recorded: Recorded = { exceptions: [], criteria: [] };
  const watched = {
    routeSettledProjects: (ids: ReadonlyArray<string | null | undefined>) =>
      router.routeSettledProjects(ids),
    routeReadyCriteria: (ids: ReadonlyArray<string | null | undefined>) =>
      router.routeReadyCriteria(ids),
    route: (...args: Parameters<CompletionInputRouter['route']>) => router.route(...args),
    routeTaskExceptions: async (ids: ReadonlyArray<string | null | undefined>) => {
      const delivered = await router.routeTaskExceptions(ids);
      recorded.exceptions.push(...delivered);
      return delivered;
    },
    routeUnlandedCriteria: async (ids: ReadonlyArray<string | null | undefined>) => {
      const delivered = await router.routeUnlandedCriteria(ids);
      recorded.criteria.push(...delivered);
      return delivered;
    },
  } as unknown as CompletionInputRouter;
  const tasks = new TasksService(prisma, sessions, realtime, undefined, watched);
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
  return { db, api, tasks, projects, recorded };
}

/** A repository with one branch, whose tip either carries the marker or does not. */
function upstream(label: string, mainIsRed: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), `orbit-${label}-`));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'fixture@orbit.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'fixture']);
  writeFileSync(path.join(dir, 'README'), `${label}\n`);
  commit(dir, 'the first commit on main');
  setMainTip(dir, mainIsRed);
  return dir;
}

/** Move the tip of `main`: put the marker on it, or take it off. Nothing else changes. */
function setMainTip(dir: string, red: boolean): void {
  const marker = path.join(dir, MARKER);
  if (red) writeFileSync(marker, '');
  else if (existsSync(marker)) rmSync(marker);
  commit(dir, red ? 'main is red here too' : 'main is green');
}

function commit(dir: string, message: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '--allow-empty', '-m', message]);
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The tree the ROUND runs in, which is not the tree the probe runs in. */
  branchDir: string;
  /** The repository the project is bound to, whose `main` the probe really asks. */
  upstreamDir: string;
  choreTaskId: string;
}

/**
 * One owner, one runner, one project bound to a repository, and one chore that never finishes.
 *
 * The binding is a `project_codebase` row because that is the row that owns what a project's
 * repository and its integration ref ARE. Nothing here tells the unit under test where `main` is;
 * it goes and reads this.
 */
async function fixture(
  stack: Stack,
  label: string,
  options: { coordinatorEnabled?: boolean; mainIsRed?: boolean } = {},
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@mechanical-disposition.invalid`,
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
  // The conversation a finished-but-unlanded criterion is handed to. A project without one
  // refuses that delivery outright (`DELIVERY_NO_COORDINATOR_SESSION`), and a refused fact is
  // never handed an action — so the standing conversation is a precondition of the pass row
  // reaching the unit under test at all, not decoration.
  const coordinatorSessionId = randomUUID();
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
    },
  });
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
      ownerId,
      title: `${label} 机械判定项目`,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const upstreamDir = upstream(label, options.mainIsRed ?? false);
  await db.projectCodebase.create({
    data: {
      projectId,
      ownerId,
      canonicalRepoUrl: `file://${upstreamDir}`,
      upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/main',
      refAuthority: 'REMOTE',
    },
  });

  const chore = await stack.tasks.create(ownerId, {
    title: `${label} 与任何标准无关的杂活`,
    assigneeId: workspaceId,
    projectId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
  } as never);
  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    branchDir: mkdtempSync(path.join(tmpdir(), `orbit-${label}-branch-`)),
    upstreamDir,
    choreTaskId: chore.id,
  };
}

function teardown(f: Fixture): void {
  for (const dir of [f.branchDir, f.upstreamDir]) rmSync(dir, { recursive: true, force: true });
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]) {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems);
}

/** File one piece of work against a criterion, through the door that resolves the key. */
async function serve(
  stack: Stack,
  f: Fixture,
  criterionKey: string,
  title: string,
  declaration: { acceptanceCommand: string; acceptanceExpectedExitCode: number } = CHECK,
) {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    criterionKey,
    ...declaration,
  } as never);
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
}

/** A second piece of work on the same criterion that never ends, so nothing is stranded. */
async function alsoServing(stack: Stack, f: Fixture, criterionKey: string, title: string) {
  await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    criterionKey,
    completionCriterion: 'EVIDENCE_JUDGMENT',
  } as never);
}

interface Queued {
  sessionId: string;
  turnId: string;
  command: string;
}

/** Start one attempt and get as far as the acceptance command being handed to the runner. */
async function queueRound(stack: Stack, f: Fixture, taskId: string, label: string): Promise<Queued> {
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
  assert.ok(next, 'the declared command was not queued');
  assert.equal(next.kind, 'shell');
  assert.equal(next.taskAcceptance, true, 'the queued turn is the reserved acceptance round');
  return { sessionId, turnId: next.turnId, command: next.content! };
}

/**
 * Run the queued command for real and report what it did, exactly as the runner does.
 *
 * `RED` is the same command in a tree that carries the marker, and `KILLED` is the same runner
 * behaviour a timeout produces: no code of its own, reported as -1.
 */
async function finishRound(
  stack: Stack,
  f: Fixture,
  queued: Queued,
  how: 'PASS' | 'RED' | 'KILLED',
): Promise<number> {
  const marker = path.join(f.branchDir, MARKER);
  if (how === 'RED') writeFileSync(marker, '');
  else if (existsSync(marker)) rmSync(marker);

  const ran = spawnSync('bash', ['-lc', queued.command], {
    cwd: f.branchDir,
    encoding: 'utf8',
    timeout: how === 'KILLED' ? 250 : 60_000,
  });
  // `status` is null exactly when the process was killed or never started, which is the whole of
  // what -1 means on this wire since the typed termination was removed.
  const exitCode = ran.status ?? -1;
  if (how === 'PASS') assert.equal(exitCode, 0, 'the round was supposed to pass');
  if (how === 'RED') assert.equal(exitCode, 1, 'the round was supposed to come back red');
  if (how === 'KILLED') assert.equal(exitCode, -1, 'the round was supposed to be killed');

  await stack.api.turnComplete({ id: f.runnerId }, queued.sessionId, {
    turnId: queued.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: exitCode,
    shellOutput: `${ran.stdout ?? ''}${ran.stderr ?? ''}`,
  });
  return exitCode;
}

/** One whole round, start to finish. */
async function round(
  stack: Stack,
  f: Fixture,
  taskId: string,
  label: string,
  how: 'PASS' | 'RED' | 'KILLED',
): Promise<number> {
  return finishRound(stack, f, await queueRound(stack, f, taskId, label), how);
}

const exceptionFor = (stack: Stack, taskId: string) =>
  stack.recorded.exceptions.filter((delivery) => delivery.taskId === taskId);

const criterionFor = (stack: Stack, f: Fixture, key: string) =>
  stack.recorded.criteria.filter(
    (delivery) => delivery.criterionSubjectId === criterionSubjectId(f.projectId, key),
  );

function wakesOf(db: PrismaClient, projectId: string, event: string, subjectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event, subjectId },
    select: { status: true, refusalCode: true, sessionId: true },
    orderBy: { id: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

// (a) -----------------------------------------------------------------------------------------
test('four rounds, four actions: a pass merges, a killed round with company re-runs, a red main '
  + 'rebases, and a red of its own goes back',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'four-rounds', { mainIsRed: true });
    try {
      const [passed, killed, ancestral, own] = await state(stack, f, [
        '这条标准的活干完了，但成果还不在 main 上',
        '这条标准的活被杀在半路上',
        '这条标准的活红了，而 main tip 上也红',
        '这条标准的活红了，而 main tip 上是绿的',
      ]);

      // ROW 1 — the round exited what it declared. Nothing else serves this criterion, so its work
      // is finished; no receipt puts it on main, so it is finished and off main.
      const passing = await serve(stack, f, passed!.key, '退出码 0 的那一轮');
      await round(stack, f, passing, 'exit-0', 'PASS');
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: passing } })).status,
        TaskStatus.DONE,
        'the exit code comparison is what settled this task',
      );
      const [merge] = criterionFor(stack, f, passed!.key);
      assert.equal(merge?.outcome, 'DELIVERED', 'the pass was not handed to the coordinator');

      // ROW 2 — a round that came back with no code of its own, while another round was genuinely
      // still in flight: this second attempt is dequeued and left running across the first.
      const alongside = await serve(stack, f, killed!.key, '另一条同时在跑的整轮', SLOW_CHECK);
      const inFlight = await queueRound(stack, f, alongside, 'concurrent-round');
      assert.ok(inFlight.turnId, 'a second round is in flight');
      const cancelled = await serve(stack, f, killed!.key, '退出码 -1 的那一轮', SLOW_CHECK);
      await alsoServing(stack, f, killed!.key, '这条标准上还没干完的活');
      await round(stack, f, cancelled, 'exit-minus-one', 'KILLED');
      const [redispatch] = exceptionFor(stack, cancelled);

      // ROW 3 — a red round whose check is red at the tip of main too. The fixture's main carries
      // the marker, so the same command really fails there.
      const inherited = await serve(stack, f, ancestral!.key, '退出码 1、main 上也红的那一轮');
      await alsoServing(stack, f, ancestral!.key, '这条标准上还没干完的活');
      await round(stack, f, inherited, 'exit-one-ancestral', 'RED');
      const [rebase] = exceptionFor(stack, inherited);

      // ROW 4 — the same red, after somebody fixed main. Same declaration, same tree, same exit
      // code: the only thing that moved is the commit the probe finds at the tip.
      setMainTip(f.upstreamDir, false);
      const mine = await serve(stack, f, own!.key, '退出码 1、main 上是绿的那一轮');
      await alsoServing(stack, f, own!.key, '这条标准上还没干完的活');
      await round(stack, f, mine, 'exit-one-own', 'RED');
      const [sendBack] = exceptionFor(stack, mine);

      const chosen = [merge?.action, redispatch?.action, rebase?.action, sendBack?.action];
      assert.deepEqual(chosen, [
        'MERGE_AND_RELEASE_NEXT',
        'REDISPATCH_UNCHANGED',
        'REBASE_AND_RERUN',
        'SEND_BACK',
      ], 'the four rounds did not choose the four actions');
      assert.equal(new Set(chosen).size, 4, 'two of the four rounds chose the same action');
      assert.equal(
        new Set(MECHANICAL_ACTIONS).size, MECHANICAL_ACTIONS.length,
        'the action vocabulary itself has a duplicate',
      );
    } finally {
      teardown(f);
      await stack.db.$disconnect();
    }
  });

// (b) -----------------------------------------------------------------------------------------
test('the answer about main tip is run, not read: the same red swaps its action when main tip does',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    // Green to begin with, which is the opposite of what (a) starts from — so a unit that had
    // learned the answer instead of asking for it would have to be wrong in one of the two.
    const f = await fixture(stack, 'flip-main-tip', { mainIsRed: false });
    try {
      const [before, after] = await state(stack, f, [
        'main tip 是绿的时候红的那一轮',
        'main tip 被改红之后红的那一轮',
      ]);

      const first = await serve(stack, f, before!.key, '第一次：同样的红');
      await alsoServing(stack, f, before!.key, '这条标准上还没干完的活');
      await round(stack, f, first, 'green-main', 'RED');

      // The world changes, and nothing else does: same declaration, same tree, same exit code.
      setMainTip(f.upstreamDir, true);

      const second = await serve(stack, f, after!.key, '第二次：同样的红');
      await alsoServing(stack, f, after!.key, '这条标准上还没干完的活');
      await round(stack, f, second, 'red-main', 'RED');

      const [green] = exceptionFor(stack, first);
      const [red] = exceptionFor(stack, second);
      assert.equal(green?.action, 'SEND_BACK', 'a red of its own was not sent back');
      assert.equal(red?.action, 'REBASE_AND_RERUN', 'a red main did not turn this into a rebase');
      assert.notEqual(green?.action, red?.action, 'the action did not move when main tip did');
    } finally {
      teardown(f);
      await stack.db.$disconnect();
    }
  });

// (c) -----------------------------------------------------------------------------------------
test('the concurrent-round count is observed: the same kill stops being a re-run once the other '
  + 'round has finished',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'flip-concurrency');
    try {
      const [contended, alone] = await state(stack, f, [
        '当时还有别的整轮在跑',
        '当时没有别的整轮在跑',
      ]);

      // One other round, genuinely in flight: dequeued by the runner and not yet reported.
      const other = await serve(stack, f, contended!.key, '另一条同时在跑的整轮', SLOW_CHECK);
      const inFlight = await queueRound(stack, f, other, 'concurrent-round');

      const withCompany = await serve(stack, f, contended!.key, '有并发时的那一轮 -1', SLOW_CHECK);
      await alsoServing(stack, f, contended!.key, '这条标准上还没干完的活');
      await round(stack, f, withCompany, 'kill-with-company', 'KILLED');

      // The fact changes, and only it: that other round comes back, so by the time the second
      // kill happens there is nothing in flight for it to have contended with.
      await finishRound(stack, f, inFlight, 'KILLED');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const onItsOwn = await serve(stack, f, alone!.key, '没有并发时的那一轮 -1', SLOW_CHECK);
      await alsoServing(stack, f, alone!.key, '这条标准上还没干完的活');
      await round(stack, f, onItsOwn, 'kill-on-its-own', 'KILLED');

      const [busy] = exceptionFor(stack, withCompany);
      const [lonely] = exceptionFor(stack, onItsOwn);
      assert.equal(busy?.outcome, 'CONSUMED', 'the first kill was not delivered at all');
      assert.equal(lonely?.outcome, 'CONSUMED', 'the second kill was not delivered at all');
      assert.equal(busy?.action, 'REDISPATCH_UNCHANGED', 'a kill with company was not re-run');
      assert.equal(
        lonely?.action, undefined,
        'a kill with nothing running beside it is not a mechanical judgement',
      );
      assert.notEqual(
        busy?.action, lonely?.action,
        'the action did not move when the rounds running beside it did',
      );
    } finally {
      teardown(f);
      await stack.db.$disconnect();
    }
  });

// (d) -----------------------------------------------------------------------------------------
test('a killed round with company is re-run: never sent back, never merged',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'kill-never-sends-back');
    try {
      const [contended] = await state(stack, f, ['被杀在半路上的那一轮']);
      const alongside = await serve(stack, f, contended!.key, '同时在跑的另一条整轮', SLOW_CHECK);
      await queueRound(stack, f, alongside, 'concurrent-round');
      const cancelled = await serve(stack, f, contended!.key, '被杀的那一轮', SLOW_CHECK);
      await alsoServing(stack, f, contended!.key, '这条标准上还没干完的活');
      await round(stack, f, cancelled, 'killed-with-company', 'KILLED');

      const [killed] = exceptionFor(stack, cancelled);
      assert.equal(killed?.action, 'REDISPATCH_UNCHANGED');
      assert.notEqual(killed?.action, 'SEND_BACK', 'a killed round was sent back');
      assert.notEqual(killed?.action, 'MERGE_AND_RELEASE_NEXT', 'a killed round was merged');
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: cancelled } })).status,
        TaskStatus.FAILED,
        'the round is still a failure — re-running it is not a claim that it passed',
      );
    } finally {
      teardown(f);
      await stack.db.$disconnect();
    }
  });

// (e) -----------------------------------------------------------------------------------------
/**
 * The production files this unit added or changed. Merging is the one irreversible action the
 * account owner kept out of the apiserver on 2026-09-06: this work may compute that a merge is
 * what a round calls for, and may not perform one.
 */
const OWN_PRODUCTION_SOURCES = [
  'src/projects/mechanical-disposition.ts',
  'src/projects/main-tip-probe.ts',
  'src/projects/wake-disposition.service.ts',
  'src/projects/completion-input-router.service.ts',
  'src/projects/criterion-unlanded.producer.ts',
  'src/projects/criterion-ready.producer.ts',
  'src/tasks/executable-acceptance-round.ts',
  'src/runner-api/runner-api.controller.ts',
];

/** A file that DOES merge, so the scan below is known to be able to find one. */
const A_FILE_THAT_MERGES = 'src/runner-api/runner-sessions.controller.ts';

/** The package root, so the list above reads the way a reviewer would write those paths. */
const API = path.resolve(__dirname, '../..');
const MERGE_CALL = /(?<![A-Za-z0-9_$])mergeToMain\s*\(/;

/** Comments are prose about the boundary; only code can cross it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the merge is computed here and performed elsewhere: no merge call site in this unit', () => {
  assert.ok(OWN_PRODUCTION_SOURCES.length > 0, 'the scan has nothing to scan');
  const control = withoutComments(readFileSync(path.join(API, A_FILE_THAT_MERGES), 'utf8'));
  assert.match(control, MERGE_CALL, 'the scan cannot even find a merge where one exists');

  for (const relative of OWN_PRODUCTION_SOURCES) {
    const full = path.join(API, relative);
    assert.ok(existsSync(full), `${relative} is registered here and does not exist`);
    const code = withoutComments(readFileSync(full, 'utf8'));
    assert.doesNotMatch(code, MERGE_CALL, `${relative} calls the merge it is only allowed to choose`);
    assert.doesNotMatch(
      code, /mergeToMain/,
      `${relative} names the merge in live code — this unit may not reach it at all`,
    );
  }
});

// (f) -----------------------------------------------------------------------------------------
test('a switched-off coordinator chooses no action for any of the four rounds, opens nothing, and '
  + 'leaves exactly one REFUSED row for each fact',
  { skip, timeout: 420_000 }, async () => {
    const stack = await connect();
    const off = await fixture(stack, 'switched-off', { coordinatorEnabled: false, mainIsRed: true });
    const on = await fixture(stack, 'switched-on');
    try {
      const [passed, killed, ancestral, own] = await state(stack, off, [
        '开关关着，这条标准的活干完了但没落 main',
        '开关关着，这条标准的活被杀在半路上',
        '开关关着，这条标准的活红了而 main 上也红',
        '开关关着，这条标准的活红了而 main 上是绿的',
      ]);

      const passing = await serve(stack, off, passed!.key, '开关关着的退出码 0');
      await round(stack, off, passing, 'off-exit-0', 'PASS');

      const alongside = await serve(stack, off, killed!.key, '开关关着时同跑的整轮', SLOW_CHECK);
      await queueRound(stack, off, alongside, 'off-concurrent');
      const cancelled = await serve(stack, off, killed!.key, '开关关着的退出码 -1', SLOW_CHECK);
      await alsoServing(stack, off, killed!.key, '开关关着时还没干完的活');
      await round(stack, off, cancelled, 'off-exit-minus-one', 'KILLED');

      const inherited = await serve(stack, off, ancestral!.key, '开关关着的祖传红');
      await alsoServing(stack, off, ancestral!.key, '开关关着时还没干完的活');
      await round(stack, off, inherited, 'off-ancestral', 'RED');

      setMainTip(off.upstreamDir, false);
      const mine = await serve(stack, off, own!.key, '开关关着的真红');
      await alsoServing(stack, off, own!.key, '开关关着时还没干完的活');
      await round(stack, off, mine, 'off-own-red', 'RED');

      // Each of the four facts travelled the whole way and was refused on the switch: one row,
      // saying so, carrying no session. Zero rows would be the state this work replaced.
      for (const [label, rows] of [
        ['退出码 0', await wakesOf(
          stack.db, off.projectId, 'CRITERION_UNLANDED',
          criterionSubjectId(off.projectId, passed!.key),
        )],
        ['退出码 -1', await wakesOf(
          stack.db, off.projectId, 'ATTEMPT_ENDED_UNSETTLED', cancelled,
        )],
        ['祖传红', await wakesOf(stack.db, off.projectId, 'ATTEMPT_ENDED_UNSETTLED', inherited)],
        ['真红', await wakesOf(stack.db, off.projectId, 'ATTEMPT_ENDED_UNSETTLED', mine)],
      ] as const) {
        assert.equal(rows.length, 1, `${label}: the fact did not leave exactly one row`);
        assert.equal(rows[0]!.status, 'REFUSED', `${label}: the fact was not refused`);
        assert.equal(rows[0]!.sessionId, null, `${label}: the refused wake opened a session`);
      }
      assert.equal(
        (await wakesOf(
          stack.db, off.projectId, 'CRITERION_UNLANDED',
          criterionSubjectId(off.projectId, passed!.key),
        ))[0]!.refusalCode,
        CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED,
      );
      assert.equal(
        (await wakesOf(stack.db, off.projectId, 'ATTEMPT_ENDED_UNSETTLED', mine))[0]!.refusalCode,
        EXCEPTION_WAKE_COORDINATOR_DISABLED,
      );

      const chosen = [
        ...stack.recorded.exceptions.filter((d) => [cancelled, inherited, mine].includes(d.taskId)),
        ...criterionFor(stack, off, passed!.key),
      ];
      assert.equal(chosen.length, 4, 'the four facts were not all delivered');
      assert.deepEqual(
        chosen.map((delivery) => delivery.action), [undefined, undefined, undefined, undefined],
        'a switched-off coordinator was handed an action to take',
      );
      assert.deepEqual(
        await judgmentSessions(stack.db, off.ownerId), [],
        'a switched-off coordinator was woken',
      );

      // The control, in the same fixture and against the same code: with the switch ON, the same
      // round DOES settle an action. Without it, every assertion above is true of a unit that was
      // never wired up at all.
      const [alsoPassed] = await state(stack, on, ['开关开着，这条标准的活干完了但没落 main']);
      const control = await serve(stack, on, alsoPassed!.key, '开关开着的退出码 0');
      await round(stack, on, control, 'on-exit-0', 'PASS');
      const [merge] = criterionFor(stack, on, alsoPassed!.key);
      assert.equal(merge?.outcome, 'DELIVERED', 'the control fact was not delivered');
      assert.equal(
        merge?.action, 'MERGE_AND_RELEASE_NEXT',
        'the control round chose nothing either — this negative would be green over a dead unit',
      );
    } finally {
      teardown(off);
      teardown(on);
      await stack.db.$disconnect();
    }
  });
