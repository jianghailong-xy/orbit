import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

import { type ChangedFile, RunStatus as SharedRunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { BLOCKER_KIND_FOR, declaredPaths } from './blocker-disposition';
import {
  CompletionInputRouter,
  type TaskExceptionDelivery,
} from './completion-input-router.service';
import { COORDINATOR_AUTHORITY } from './coordinator-authority';
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
import { mechanicalAction } from './mechanical-disposition';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * The four deliveries a coordinator may not settle, and the one blocker each of them raises.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/projects/blocker-disposition.pg.spec.js
 *
 * WHAT IS DRIVEN, AND WHY IT IS DRIVEN THAT WAY
 * =============================================
 * Every input here is a delivery that actually happened. The task declares a command, the runner
 * door queues it, `bash` runs it, the exit code comes back through `/turn-complete`, and the
 * comparison under the task's own row lock writes DONE — after which the post-commit edge derives
 * the criterion's fact on its own. Nothing writes `task.status`, nothing calls a producer by hand,
 * and nothing hands the unit under test an observation.
 *
 * The one the acceptance criteria single out is the file set. It is not a list this file passes to
 * anybody: each delivery is a REAL git tree, the files are really written into it, and what the
 * runner reports at the turn boundary is what `git diff --cached --name-only` says about that
 * tree. Flipping it means staging a different file, and case (b) is the pair where that is the
 * only thing that differs.
 *
 * WHY THESE FOUR AND NOT THE OTHER FOUR
 * =====================================
 * `mechanical-disposition.pg.spec.ts` drives the rounds a machine may settle. These are the
 * deliveries it may not, and the two tables must never both answer: a delivery that raised a
 * blocker carries no action at all, which (a) and (b) assert from both sides — four blockers with
 * no action, and one ordinary delivery with an action and no blocker.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

/** The one the standard is MOVED to in case (a) — a different method, the same words. */
const REWORDED_METHOD = 'Read it again and say whether it still holds';

/** A declaration whose command reads the delivery tree, and passes there. */
const CHECK = { acceptanceCommand: 'test -f README', acceptanceExpectedExitCode: 0 };

/** The directory every task below authorizes, spelled the way a declaration spells one. */
const DECLARED_DIR = 'src/apiserver/src/projects';

/** What a delivery inside that directory changes. */
const IN_SCOPE = [`${DECLARED_DIR}/blocker-disposition.ts`, `${DECLARED_DIR}/notes.ts`];

/** The one file nobody asked for. */
const STRAY = 'src/runner-go/worktree.go';

/** The declaration text, identical for every task here: the scope is never the variable. */
const DECLARATION =
  `只改 ${DECLARED_DIR}/ 下面的东西，别碰别的目录。`
  + `具体要动的是 ${DECLARED_DIR}/blocker-disposition.ts。`;

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
  receipts: MergeReceiptService;
  recorded: Recorded;
}

/**
 * The production wiring, over one client, with one seam that changes nothing.
 *
 * The router is the real one. What wraps it records what its doors RETURNED, because the caller in
 * production is `TasksService`, which logs a failure and drops the answer — so a spec that wants to
 * see what the real edge decided has to watch the door rather than call it. Calling the doors
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
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
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
  return { db, api, tasks, projects, receipts: new MergeReceiptService(prisma), recorded };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The conversation this project is already coordinated from, parked and waiting. */
  coordinatorSessionId: string;
  /** The one tree every delivery in this fixture is made in. */
  treeDir: string;
}

/**
 * One owner, one runner, one project with a standing coordinator conversation, and one real
 * repository to deliver into.
 *
 * The conversation is not scenery. A criterion whose finished work is off `main` is DELIVERED to
 * it — told, in those words, to merge — so a fixture without one would refuse every fact on
 * "there is nobody to deliver to" and never reach anything this file is about. With one, the two
 * outcomes are distinguishable: an ordinary delivery reaches the conversation, and one that has to
 * stop does not.
 */
async function fixture(
  stack: Stack,
  label: string,
  options: { coordinatorEnabled?: boolean } = {},
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@blocker-disposition.invalid`,
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
  // A conversation somebody has been talking to already has its opening prompt on the row as a
  // turn, so the delivery below is never the thing that seeds one. Counted back out by
  // `messagesTo`, which is why it is written here rather than left to `createTurn`.
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
      title: `${label} 必须停下来的项目`,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return {
    ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, treeDir: repository(label),
  };
}

function teardown(f: Fixture): void {
  rmSync(f.treeDir, { recursive: true, force: true });
}

/** A real repository with one commit, so a diff taken in it is a diff git computed. */
function repository(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `orbit-${label}-tree-`));
  execFileSync('git', ['-C', dir, 'init', '--quiet', '--initial-branch=main']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'fixture@orbit.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'fixture']);
  writeFileSync(path.join(dir, 'README'), `${label}\n`);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', 'the first commit']);
  return dir;
}

/**
 * Make the change this delivery IS, and report what git says about it.
 *
 * The return value is the runner's own snapshot shape, and every path in it came out of
 * `git diff --cached --name-only`. Nothing downstream is told which files these are.
 */
function stage(dir: string, paths: readonly string[]): ChangedFile[] {
  execFileSync('git', ['-C', dir, 'reset', '--quiet']);
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--', '.']);
  execFileSync('git', ['-C', dir, 'clean', '--quiet', '-fd']);
  for (const relative of paths) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `${relative}\n`);
  }
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const named = execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], {
    encoding: 'utf8',
  }).split('\n').filter(Boolean);
  assert.deepEqual([...named].sort(), [...paths].sort(),
    'git named a different file set than this delivery staged');
  return named.map((file) => ({ path: file, additions: 1, deletions: 0, status: 'A' }));
}

function headSha(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]) {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems);
}

/**
 * Move ONE stated criterion, through the owner's own path, keeping every id.
 *
 * The words are left alone and the verification method is what changes, which is enough to
 * advance `revision` and is the smallest edit that does: it makes "the exam moved after this work
 * was declared against it" true without also making the work serve different words.
 */
async function moveTheStandard(stack: Stack, f: Fixture, texts: string[], moved: string) {
  const before = await stack.projects.get(f.ownerId, f.projectId);
  const items = criteriaFromDefinitions(before.acceptanceCriteriaItems);
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: items.map((item, index) => ({
      id: item.key,
      text: texts[index]!,
      verificationMethod: item.key === moved ? REWORDED_METHOD : METHOD,
    })),
  } as never);
  const after = criteriaFromDefinitions(written.acceptanceCriteriaItems)
    .find((item) => item.key === moved);
  assert.equal(after?.definitionRevision, 2,
    'the edit did not advance the criterion this case is about');
  return after!;
}

/**
 * A second OPEN task in the same project, serving no criterion.
 *
 * It exists to be RELEASABLE: OPEN, opted into auto-run, assigned to a workspace on a live runner,
 * depending on nothing. That makes "the next task was not released" a statement about a task that
 * would otherwise have started, rather than about an empty project — and case (b) shows it start.
 */
async function releasableSibling(stack: Stack, f: Fixture, title: string): Promise<string> {
  const chore = await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
  } as never);
  return chore.id;
}

/** File one piece of work against a criterion, through the door that resolves the key. */
async function serve(
  stack: Stack,
  f: Fixture,
  criterionKey: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    description: DECLARATION,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    criterionKey,
    ...CHECK,
    ...extra,
  } as never);
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
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
      branch: `orbit/${label}`,
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
 * Run the queued command for real, and report the round AND the worktree snapshot together.
 *
 * Both halves are what the runner sends on this one request: the exit code the command produced,
 * and the diff it computed against the session's base. That is why the file set the disposition
 * reads is the delivery rather than a description of it.
 */
async function finishRound(
  stack: Stack,
  f: Fixture,
  queued: Queued,
  changedFiles: ChangedFile[],
): Promise<void> {
  const ran = spawnSync('bash', ['-lc', queued.command], {
    cwd: f.treeDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(ran.status, 0, 'the round was supposed to pass');
  await stack.api.turnComplete({ id: f.runnerId }, queued.sessionId, {
    turnId: queued.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: `${ran.stdout ?? ''}${ran.stderr ?? ''}`,
    baseSha: headSha(f.treeDir),
    changedFiles,
  });
}

/** One whole delivery: stage it in the tree, run its round, report both. */
async function deliver(
  stack: Stack,
  f: Fixture,
  taskId: string,
  label: string,
  paths: readonly string[],
): Promise<{ sessionId: string; reported: ChangedFile[] }> {
  const reported = stage(f.treeDir, paths);
  const queued = await queueRound(stack, f, taskId, label);
  await finishRound(stack, f, queued, reported);
  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    TaskStatus.DONE,
    'the exit code comparison is what settled this task',
  );
  return { sessionId: queued.sessionId, reported };
}

const criterionFor = (stack: Stack, f: Fixture, key: string) =>
  stack.recorded.criteria.filter(
    (delivery) => delivery.criterionSubjectId === criterionSubjectId(f.projectId, key),
  );

const blockerCount = (db: PrismaClient, projectId: string) =>
  db.projectBlocker.count({ where: { projectId } });

const openBlockers = (db: PrismaClient, projectId: string) =>
  db.projectBlocker.findMany({
    where: { projectId, resolvedAt: null },
    select: { kind: true, subjectType: true, subjectId: true, detail: true, owner: true },
    orderBy: { id: 'asc' },
  });

/** Every merge this project could be said to have made. Nothing that stops may produce one. */
const landedReceipts = (db: PrismaClient, projectId: string) =>
  db.sessionMergeReceipt.count({
    where: { projectId, result: { in: ['MERGED', 'ALREADY_MERGED'] } },
  });

/**
 * What the standing coordinator conversation was told, beyond the prompt it opened with.
 *
 * The message a delivered `CRITERION_UNLANDED` fact carries is an instruction to merge, in that
 * order — so counting these is how "nothing was told to merge this" becomes observable rather than
 * asserted.
 */
const messagesTo = async (db: PrismaClient, sessionId: string) =>
  (await db.conversationTurn.count({ where: { sessionId } })) - 1;

/** Whether this task was started — the observable half of "the next one was released". */
const sessionsOf = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId, deletedAt: null } });

function wakesOf(db: PrismaClient, projectId: string, subjectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'CRITERION_UNLANDED', subjectId },
    select: { status: true, refusalCode: true, sessionId: true },
    orderBy: { id: 'asc' },
  });
}

/** Which of the four (or the control), and what the delivery has to look like for it to be that. */
type Case = 'EXEMPTION' | 'STANDARD' | 'SCOPE' | 'CONFLICT' | 'CONTROL';

const STATED: Readonly<Record<Case, string>> = {
  EXEMPTION: '这条标准的活声称某条判据不适用',
  STANDARD: '这条标准的活要通过就得改验收标准',
  SCOPE: '这条标准的活改了没让它改的东西',
  CONFLICT: '这条标准的活合不进去',
  CONTROL: '这条标准的活规规矩矩',
};

const EXPECTED_KIND: Readonly<Record<Exclude<Case, 'CONTROL'>, string>> = {
  EXEMPTION: 'HUMAN_DECISION_REQUIRED',
  STANDARD: 'POLICY_MANUAL_HOLD',
  SCOPE: 'AWAITING_USER_APPROVAL',
  CONFLICT: 'MERGE_CONFLICT',
};

interface Delivered {
  f: Fixture;
  criterionKey: string;
  taskId: string;
  choreId: string;
  reported: ChangedFile[];
}

/**
 * One whole project with one delivery in it, differing from the next only in which case it is.
 *
 * Each case gets its OWN project deliberately. A criterion's fact is re-derived every time any
 * task in its project settles, and a fact whose key is already held answers ALREADY_AWAKE — so
 * four cases in one project would deliver the first one's fact four times and leave case (c) with
 * four refusal rows to explain. One project, one criterion, one delivery: what each assertion
 * counts is then unambiguous.
 */
async function deliverCase(
  stack: Stack,
  label: string,
  which: Case,
  options: { coordinatorEnabled?: boolean } = {},
): Promise<Delivered> {
  const f = await fixture(stack, label, options);
  const [stated] = await state(stack, f, [STATED[which]]);
  const choreId = await releasableSibling(stack, f, `${label} 的下一条`);
  const taskId = await serve(stack, f, stated!.key, `${label} 的交付`,
    which === 'EXEMPTION'
      ? {
          completionCriterionOverrideReason:
            '这条标准的阴性一项没红过。那是因为配对的阳性那半更早被拒，'
            + '所以我认为这一项对本任务不适用。',
        }
      : {});
  if (which === 'STANDARD') await moveTheStandard(stack, f, [STATED[which]], stated!.key);

  const reported = stage(f.treeDir, which === 'SCOPE' ? [...IN_SCOPE, STRAY] : IN_SCOPE);
  const queued = await queueRound(stack, f, taskId, label);
  if (which === 'CONFLICT') {
    // The runner merged this session's branch and git refused. Recorded through the door that
    // records every merge, which is where a conflict already lives.
    const recorded = await stack.receipts.record(f.ownerId, queued.sessionId, {
      targetBranch: 'main',
      sourceSha: headSha(f.treeDir),
      result: 'CONFLICT',
      conflicts: [`${DECLARED_DIR}/blocker-disposition.ts`],
    } as never, 'RUNNER');
    assert.equal(recorded.created, true, 'the conflict was not recorded');
  }
  await finishRound(stack, f, queued, reported);
  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    TaskStatus.DONE,
    'the exit code comparison is what settled this task',
  );
  return { f, criterionKey: stated!.key, taskId, choreId, reported };
}

// (a) -----------------------------------------------------------------------------------------
test('four deliveries a machine may not settle — an argued exemption, a moved standard, an '
  + 'unasked-for file and a branch git refused — each raise exactly one blocker of their own kind',
  { skip, timeout: 420_000 }, async () => {
    const stack = await connect();
    const four: Array<Exclude<Case, 'CONTROL'>> = ['EXEMPTION', 'STANDARD', 'SCOPE', 'CONFLICT'];
    const delivered: Delivered[] = [];
    try {
      for (const which of four) {
        const before = await stack.db.projectBlocker.count();
        const one = await deliverCase(stack, `stop-${which.toLowerCase()}`, which);
        delivered.push(one);
        const spent = criterionFor(stack, one.f, one.criterionKey);
        // Recorded, not DELIVERED. The standing conversation is the thing that performs merges,
        // and what it is sent is an instruction to perform one; case (b)'s control shows the same
        // fact reach it when nothing has to stop.
        assert.equal(spent[0]?.outcome, 'CONSUMED', `${which}: the fact took the wrong terminal`);
        assert.equal(await messagesTo(stack.db, one.f.coordinatorSessionId), 0,
          `${which}: a delivery that had to stop still told the coordinator to merge it`);

        // 1 — its own kind, and exactly one row for it.
        assert.equal(spent[0]?.blockerKind, EXPECTED_KIND[which],
          `${which}: the delivery raised the wrong kind, or none`);
        assert.equal(await blockerCount(stack.db, one.f.projectId), 1,
          `${which}: the delivery raised something other than exactly one blocker`);
        assert.equal(await stack.db.projectBlocker.count() - before, 1,
          `${which}: the blocker table did not gain exactly one row`);
        const [row] = await openBlockers(stack.db, one.f.projectId);
        assert.equal(row?.kind, EXPECTED_KIND[which], `${which}: the row is not the reported kind`);
        assert.equal(row?.subjectId, one.taskId, `${which}: the row is about a different task`);
        assert.equal(row?.owner, 'USER', `${which}: the row was not addressed to a person`);

        // 2 — nothing merged, and the next task was not released. The sibling is OPEN, opted in
        // and assigned to a live runner: case (b) shows the same task start when nothing stops.
        assert.equal(await landedReceipts(stack.db, one.f.projectId), 0,
          `${which}: a delivery that had to stop produced a merge`);
        assert.equal(await sessionsOf(stack.db, one.choreId), 0,
          `${which}: a delivery that had to stop released the next task anyway`);
        assert.equal(
          await stack.db.session.count({
            where: {
              ownerId: one.f.ownerId,
              dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
            },
          }),
          0,
          `${which}: a delivery that had to stop opened a coordinator session`,
        );
      }

      const stops = delivered.map((one) => criterionFor(stack, one.f, one.criterionKey)[0]);
      assert.deepEqual(stops.map((d) => d?.blockerKind),
        four.map((which) => EXPECTED_KIND[which]),
        'the four deliveries did not raise the four kinds');
      assert.equal(new Set(stops.map((d) => d?.blockerKind)).size, 4,
        'two of the four deliveries raised the same kind');

      // 5 — and none of them chose an action. This is the whole of "the two tables never both
      // answer", and it is not a vacuous statement about deliveries nothing was going to be done
      // with: every one of these four rounds exited the code it declared, which is the one reading
      // the mechanical table answers with a merge. Case (b)'s control is the same round with a
      // different file set, and it DOES settle that action.
      assert.equal(
        mechanicalAction({ round: 'PASSED', concurrentRounds: 0, mainTip: 'UNKNOWN' }),
        'MERGE_AND_RELEASE_NEXT',
        'the other table no longer merges a round that passed, so this non-overlap says nothing',
      );
      assert.deepEqual(stops.map((d) => d?.action), [undefined, undefined, undefined, undefined],
        'a delivery that raised a blocker also chose an action a coordinator would act on');

      // And the four words are words the vocabulary already had: no migration, no new member of
      // the closed set, nothing for the censuses that keep that set and the code agreeing.
      const [constraint] = await stack.db.$queryRaw<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(oid) AS def
          FROM pg_constraint WHERE conname = 'project_blocker_kind_chk'`;
      assert.ok(constraint?.def, 'the closed set of kinds is not enforced by that constraint');
      for (const which of four) {
        assert.ok(constraint!.def.includes(`'${EXPECTED_KIND[which]}'`),
          `${which}: its kind is not a member of the live closed set`);
      }

      // The two rows that are about paths name them: a question that cannot say WHICH files is
      // not a question anybody can answer.
      const scope = delivered[four.indexOf('SCOPE')]!;
      const [scopeRow] = await openBlockers(stack.db, scope.f.projectId);
      assert.deepEqual((scopeRow?.detail as { paths?: string[] })?.paths, [STRAY],
        'the blocker did not name the file nobody asked for');
      const conflict = delivered[four.indexOf('CONFLICT')]!;
      const [conflictRow] = await openBlockers(stack.db, conflict.f.projectId);
      assert.deepEqual((conflictRow?.detail as { paths?: string[] })?.paths,
        [`${DECLARED_DIR}/blocker-disposition.ts`],
        'the blocker did not name what git refused to merge');

      // The reason a moved standard is a HOLD rather than an opinion: the table that decides who
      // may edit the exam says it is not this coordinator.
      assert.equal(COORDINATOR_AUTHORITY.EDIT_ACCEPTANCE_CRITERIA, 'HUMAN_ONLY',
        'the standard is no longer human-only, so this row would not be a policy hold');
    } finally {
      for (const one of delivered) teardown(one.f);
      await stack.db.$disconnect();
    }
  });

// (b) -----------------------------------------------------------------------------------------
test('the file set is the input: two deliveries in one project, with one declaration and one '
  + 'tree, differ only in what they staged — and only one of them stops',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'file-set-is-the-input');
    try {
      const [outside, inside] = await state(stack, f, [STATED.SCOPE, STATED.CONTROL]);
      const chore = await releasableSibling(stack, f, '这个项目的下一条');
      const strayed = await serve(stack, f, outside!.key, '范围外的那一份');
      const kept = await serve(stack, f, inside!.key, '范围内的那一份');

      // The two tasks carry the same declaration: the same words, the same command, no argued
      // exemption on either. What each authorizes is read back through the extraction the
      // production fold uses, so "the file set is the only variable" is checked, not asserted.
      const [strayedRow, keptRow] = await Promise.all([strayed, kept].map((id) =>
        stack.db.task.findUniqueOrThrow({
          where: { id },
          select: {
            title: true, description: true, acceptanceCriteria: true,
            acceptanceCommand: true, completionCriterionOverrideReason: true,
          },
        })));
      assert.deepEqual(declaredPaths(keptRow), declaredPaths(strayedRow),
        'the two tasks do not authorize the same paths, so the file set is not the only variable');
      assert.deepEqual(declaredPaths(keptRow),
        [DECLARED_DIR, `${DECLARED_DIR}/blocker-disposition.ts`],
        'the declaration named something other than the paths it says it names');
      assert.equal(keptRow.acceptanceCommand, strayedRow.acceptanceCommand);
      assert.equal(keptRow.completionCriterionOverrideReason, null);
      assert.equal(strayedRow.completionCriterionOverrideReason, null);

      // The out-of-scope half first, so that what it stops is still there to be released.
      const strayedFiles = stage(f.treeDir, [...IN_SCOPE, STRAY]);
      await finishRound(stack, f, await queueRound(stack, f, strayed, 'outside-scope'), strayedFiles);
      const [strayedSpent] = criterionFor(stack, f, outside!.key);

      // 3 — the same declaration, one more file in the diff, and the answer moves.
      assert.equal(strayedSpent?.blockerKind, BLOCKER_KIND_FOR.OUTSIDE_DECLARED_SCOPE,
        'a delivery outside its declaration did not stop');
      assert.equal(strayedSpent?.action, undefined,
        'the out-of-scope delivery both stopped and chose an action');
      assert.equal(await sessionsOf(stack.db, chore), 0,
        'the stopped delivery released the next task anyway');
      assert.equal(await sessionsOf(stack.db, kept), 0,
        'the stopped delivery started the other half of this pair');
      assert.equal(await messagesTo(stack.db, f.coordinatorSessionId), 0,
        'the stopped delivery told the coordinator to merge it anyway');

      const keptFiles = stage(f.treeDir, IN_SCOPE);
      await finishRound(stack, f, await queueRound(stack, f, kept, 'inside-scope'), keptFiles);
      const [keptSpent] = criterionFor(stack, f, inside!.key);

      // The two staged sets came out of the same repository and differ by exactly one path, and
      // the rows the fold reads are the ones the runner wrote at the turn boundary.
      assert.deepEqual(
        strayedFiles.map((file) => file.path)
          .filter((file) => !keptFiles.some((other) => other.path === file)),
        [STRAY],
        'the two deliveries differ by something other than the one unasked-for file',
      );
      for (const [taskId, expected] of [[strayed, strayedFiles], [kept, keptFiles]] as const) {
        const [stored] = await stack.db.session.findMany({
          where: { taskId, startsTaskWork: true }, select: { changedFiles: true },
        });
        assert.deepEqual(
          (stored?.changedFiles as Array<{ path: string }>).map((file) => file.path),
          expected.map((file) => file.path),
          'the delivered snapshot is not what the runner reported at the turn boundary',
        );
      }

      // 4 — the control. A file set inside the declaration raises nothing and is not misjudged:
      // it settles the very action the mechanical table has for a round that passed, and the next
      // task starts. Without this half, every "it did not stop" above would be true of a unit
      // that was never wired up.
      assert.equal(keptSpent?.outcome, 'DELIVERED', 'the in-scope fact did not reach the coordinator');
      assert.equal(keptSpent?.blockerKind, undefined,
        'a delivery that stayed inside its declaration was stopped anyway');
      assert.equal(keptSpent?.action, 'MERGE_AND_RELEASE_NEXT',
        'the in-scope control settled nothing either — this pair would be green over a dead unit');
      assert.equal(await messagesTo(stack.db, f.coordinatorSessionId), 1,
        'the coordinator was told nothing even by the delivery that stopped at nothing');
      assert.notEqual(keptSpent?.blockerKind, strayedSpent?.blockerKind,
        'the answer did not move when the file set did');
      assert.equal(await sessionsOf(stack.db, chore), 1,
        'nothing was released even by the delivery that stopped at nothing');

      assert.equal(await blockerCount(stack.db, f.projectId), 1,
        'the pair raised something other than the one blocker the strayed half owns');
      assert.equal(await landedReceipts(stack.db, f.projectId), 0,
        'this pair performed a merge; the action is computed and merging is somebody else’s');
    } finally {
      teardown(f);
      await stack.db.$disconnect();
    }
  });

// (c) -----------------------------------------------------------------------------------------
test('a switched-off coordinator stops nothing and raises nothing: each of the four facts leaves '
  + 'exactly one REFUSED row, no blocker and no session',
  { skip, timeout: 420_000 }, async () => {
    const stack = await connect();
    const four: Array<Exclude<Case, 'CONTROL'>> = ['EXEMPTION', 'STANDARD', 'SCOPE', 'CONFLICT'];
    const delivered: Delivered[] = [];
    let control: Delivered | undefined;
    try {
      for (const which of four) {
        const one = await deliverCase(stack, `off-${which.toLowerCase()}`, which, {
          coordinatorEnabled: false,
        });
        delivered.push(one);

        // The fact travelled the whole way and was refused on the switch: one row, saying so,
        // carrying no session. Zero rows would be the state this work replaced.
        const rows = await wakesOf(
          stack.db, one.f.projectId, criterionSubjectId(one.f.projectId, one.criterionKey),
        );
        assert.equal(rows.length, 1, `${which}: the fact did not leave exactly one row`);
        assert.equal(rows[0]!.status, 'REFUSED', `${which}: the fact was not refused`);
        assert.equal(rows[0]!.sessionId, null, `${which}: the refused wake opened a session`);
        assert.equal(rows[0]!.refusalCode, CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED,
          `${which}: the fact was refused for some reason other than the switch`);

        const spent = criterionFor(stack, one.f, one.criterionKey);
        assert.equal(spent.length, 1, `${which}: the fact was delivered more than once`);
        assert.equal(spent[0]?.outcome, 'REFUSED', `${which}: the delivery did not report a refusal`);
        assert.equal(await messagesTo(stack.db, one.f.coordinatorSessionId), 0,
          `${which}: a switched-off coordinator was written to`);
        assert.equal(spent[0]?.blockerKind, undefined,
          `${which}: a switched-off coordinator raised a blocker anyway`);
        assert.equal(spent[0]?.action, undefined,
          `${which}: a switched-off coordinator was handed an action to take`);
        assert.equal(await blockerCount(stack.db, one.f.projectId), 0,
          `${which}: a switched-off project ended up with a blocker on it`);
        assert.deepEqual(
          await stack.db.session.findMany({
            where: {
              ownerId: one.f.ownerId,
              dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
              deletedAt: null,
            },
            select: { id: true },
          }),
          [],
          `${which}: a switched-off coordinator was woken`,
        );
      }

      // The control, against the same code and the same case: with the switch ON, that delivery
      // DOES stop. Without it, every assertion above is true of a unit that was never wired up.
      control = await deliverCase(stack, 'on-scope', 'SCOPE');
      const [stopped] = criterionFor(stack, control.f, control.criterionKey);
      assert.equal(stopped?.outcome, 'CONSUMED', 'the control fact was not delivered');
      assert.equal(await messagesTo(stack.db, control.f.coordinatorSessionId), 0,
        'the control told its coordinator to merge a delivery that had to stop');
      assert.equal(
        stopped?.blockerKind, EXPECTED_KIND.SCOPE,
        'the control delivery stopped at nothing either — this negative would be green over a '
        + 'dead unit',
      );
      assert.equal(await blockerCount(stack.db, control.f.projectId), 1,
        'the control raised something other than the one blocker it owns');
    } finally {
      for (const one of delivered) teardown(one.f);
      if (control) teardown(control.f);
      await stack.db.$disconnect();
    }
  });
