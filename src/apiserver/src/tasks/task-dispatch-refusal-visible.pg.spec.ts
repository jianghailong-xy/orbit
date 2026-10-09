import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

import { RunStatus as SharedRunStatus, uuidToBase62, type TaskDispatchRefusal } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { freezeSessionSourcePin } from '../projects/session-source';
import {
  DISPATCH_REFUSED_WAKE_COORDINATOR_DISABLED,
  TaskDispatchRefusalProducer,
} from '../projects/task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { PREREQUISITE_NOT_LANDED_MESSAGE } from './task-dependencies';
import { DISPATCH_REFUSED_SIGNAL_CODE, dispatchRefusalNextStep } from './task-dispatch-refusal';
import { TasksService } from './tasks.service';

/**
 * A start the runner refuses before its run can begin is a fact somebody can see.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-dispatch-refusal-visible.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * A task run whose SOURCE is resolved is pinned first and checked out second, and the checkout is
 * where the runner applies G5: every commit `requiredContains` names must be an ancestor of the pin
 * (`setupSourceWorktree`, src/runner-go/worktree.go). A refusal there spawns no engine and ends the
 * run FAILED with `DEPENDENCY_BASE_NOT_LANDED: pinned commit … does not contain prerequisite
 * commit(s) …` as its error — and on 2026-09-23 (project 34Tcl0kralZrY8opuLJU4) that line was all
 * there was: the task stayed OPEN with its `updated_at` unmoved, no exception item, no
 * `project_coordinator_wake` row, and a comment underneath telling whoever found it to run the task
 * again, which cannot help. Nothing in the system recorded that the project had stopped.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * Every case drives the production doors in the order a real start takes them: `TasksService.execute`
 * (the `task_start` door) freezes the selector, and then this file does what the runner does with a
 * claimed run, against a REAL repository — resolve the ref, freeze the pin through
 * `freezeSessionSourcePin` (the control plane's own compare-and-set), run `git merge-base
 * --is-ancestor` for every required commit exactly as `setupSourceWorktree` does, and either stand a
 * worktree on the pin (admitted) or report the refusal through `RunnerApiController.finalize` in the
 * runner's own words (refused). Nothing below writes a refusal, a wake or a comment by hand.
 *
 *   (a) the prerequisite's work reached `main` directly and the project branch — a line that
 *       exists, with one landing of its own and nothing from main yet (v1.2) — has not absorbed it:
 *       the start is refused, the TASK records it — code, time, the pinned commit, the missing
 *       commit and the prerequisite that landed it — the timeline says what to do instead of "run it
 *       again", and the project's standing coordinator conversation is sent one message naming the
 *       task and the prerequisite, through the wake ledger (`TASK_DISPATCH_REFUSED`, DELIVERED);
 *   (b) the way out this change chose is (B), the executable next step: the refusal's fixAction is
 *       now SYNC_INTEGRATION_LINE, not "land the prerequisite" (it HAS landed). Starting again
 *       before that step is the same refusal, of a second run, recorded as a second fact; the case
 *       then does the step — the line absorbs main — and starts the task again: the new start
 *       re-pins to the line's current tip, is admitted with the prerequisite's file in its
 *       checkout, the task stops saying it was refused, and the admitted run is reported to nobody;
 *   (c) the negative control: a prerequisite whose landing is already on the line is admitted
 *       first time, and leaves no refusal, no refusal comment and no delivery;
 *   (d) the other negative control: a prerequisite that has not landed at all still refuses the
 *       start — before any run exists — so nothing here widened the gate;
 *
 * plus the switched-off coordinator (the refusal is still on the task, the wake is refused on the
 * switch and nobody is told), an ordinary run failure (not mistaken for a refused start), and the
 * PROJECT's own side of a refusal (SR50) from BOTH gates: one `SOURCE_UNRESOLVED` item per line and
 * code — the same key, the same detail and the same next-step sentence whether the runner refused
 * at resolution or at the checkout, because §10.3's claim is about the CODE and not about the gate
 * that produced it — raised once however many runs that line stops, and none at all for a task in
 * no project.
 *
 * Not destructive: every case owns freshly generated ids and its own temporary repository.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/** The declaration every task here carries; never the thing under test. */
const CHECK = {
  completionCriterion: 'EXECUTABLE' as const,
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

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
  tasks: TasksService;
  /** The runner door, holding the one `TasksService` the production module gives it. */
  api: RunnerApiController;
}

/** The production wiring over one client, the delivery router included. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = new CoordinatorConvergenceService(prisma);
  const wakes = new CoordinatorWakeService(prisma);
  const delivery = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, delivery),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, delivery),
    new CriterionUnlandedProducer(prisma, convergence),
    new TaskDispatchRefusalProducer(prisma, convergence, delivery),
  );
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router);
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
  return { db, prisma, tasks, api };
}

// --- the repository ------------------------------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
}

/** A throwaway repository holding nothing but the history the case writes into it. */
function repository(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `orbit-${label}-`));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'fixture@orbit.invalid');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/** Commit one new file on whatever is checked out, and answer the new commit. */
function commitFile(dir: string, file: string): string {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '--quiet', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}

/** The runner's G5 question (`setupSourceWorktree`): is `sha` an ancestor of `pin`? */
function contains(dir: string, pin: string, sha: string): boolean {
  return spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', sha, pin]).status === 0;
}

// --- the world -----------------------------------------------------------------------------------

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The project's integration branch, by the short name a receipt's branch columns hold. */
  branch: string;
  /** The standing conversation this project is coordinated from, parked between turns. */
  coordinatorSessionId: string;
  repo: string;
  /** The root commit the line and `main` both start from. */
  root: string;
}

/**
 * An owner with one online runner, one workspace, a project on a PROJECT_BRANCH line, and the
 * conversation a person opened to coordinate it — parked at AWAITING_INPUT, so a delivery appends a
 * turn to it rather than reviving anything.
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
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${RUN}-${ownerId}@dispatch-refusal.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true,
      repoUrl: 'https://github.com/example/dispatch-refusal',
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId,
      assignedRunnerId: runnerId, title: `协调：${label}`, prompt: `协调：${label}`,
      provider: 'claude', status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER, titleManagedByProject: true,
    },
  });
  // A conversation that has been running has its opening prompt on the row as a turn, so the
  // delivery below is not the thing that seeds it.
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId, seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message', content: `协调：${label}`, status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} 项目`,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const branch = `project/${projectId.slice(0, 8)}`;
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: 'https://github.com/example/dispatch-refusal',
      upstreamRef: 'refs/heads/main', integrationRef: `refs/heads/${branch}`,
      refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: new Date(),
    },
  });
  const repo = repository(label);
  const root = commitFile(repo, 'README');
  git(repo, 'branch', branch);
  return {
    ownerId, runnerId, workspaceId, projectId, branch, coordinatorSessionId, repo, root,
  };
}

/** A task filed under the project, through the door a person and an agent both use. */
async function task(
  stack: Stack,
  f: Fixture,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await stack.tasks.create(f.ownerId, {
    title,
    projectId: f.projectId,
    assigneeId: f.workspaceId,
    // Started by hand, like the task the incident was about: a start is the thing under test.
    autoRunWhenReady: false,
    ...CHECK,
    ...extra,
  } as never);
  return created.id;
}

/**
 * A finished piece of code work: DONE, with the worktree session whose branch did it, and — when
 * the case says where — the commit that carries it and the receipt that says it landed there.
 */
async function prerequisite(
  stack: Stack,
  f: Fixture,
  title: string,
  landed: { onto: 'main' | 'line' } | null,
): Promise<{ taskId: string; landedSha: string | null }> {
  const taskId = await task(stack, f, title);
  const branch = `orbit/${title}`;
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: f.ownerId, creatorId: f.ownerId, taskId,
      workspaceId: f.workspaceId, assignedRunnerId: f.runnerId, title, prompt: title,
      provider: 'claude', status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      isolationStatus: 'worktree', branch, completedAt: new Date(),
    },
  });
  await stack.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  if (!landed) return { taskId, landedSha: null };

  // The prerequisite's own commit — the file that proves, later, whose work a checkout has.
  git(f.repo, 'checkout', '--quiet', '-b', branch, f.root);
  const work = commitFile(f.repo, `${title}.txt`);
  const target = landed.onto === 'main' ? 'main' : f.branch;
  git(f.repo, 'checkout', '--quiet', target);
  const before = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'merge', '--quiet', '--no-ff', '-m', `land ${title}`, branch);
  const after = git(f.repo, 'rev-parse', 'HEAD');
  await stack.db.sessionMergeReceipt.create({
    data: {
      ownerId: f.ownerId, sessionId, taskId, projectId: f.projectId, result: 'MERGED',
      sourceBranch: branch, sourceSha: work, targetBranch: target,
      targetShaBefore: before, targetShaAfter: after, recordedBy: 'AGENT',
      idempotencyKey: `landed:${taskId}`,
    },
  });
  return { taskId, landedSha: after };
}

/**
 * The scene every DEPENDENCY_BASE_NOT_LANDED case below needs before it has a line to be about.
 *
 * v1.2 (`docs/project-source-contract.md` §4.1): P4's baseline spells the line the way P5's does —
 * `integrationRef` once something has landed on it, `upstreamRef` until then — because §1.5 L10's
 * first row says the project branch is created BY the first landing on it, and a landing is a
 * receipt. A case whose prerequisite landed on `main` while nothing has landed on the line
 * therefore resolves onto upstream, which contains that landing, and is admitted: the refusal it
 * means to drive never happens. So the case has to say the line exists first. The fixture's
 * `git branch` is not that statement — the readers ask the receipts table, not the repository.
 */
async function lineExists(stack: Stack, f: Fixture): Promise<void> {
  const first = await prerequisite(stack, f, 'first-landing', { onto: 'line' });
  assert.ok(first.landedSha, 'the scene-setting landing on the line did not land');
}

/** The dependent under test: waits on one prerequisite and is started by hand. */
async function dependentOf(stack: Stack, f: Fixture, title: string, prerequisiteId: string) {
  return task(stack, f, title, { dependsOnTaskIds: [prerequisiteId] });
}

/** `task_start`, through the service door it reaches: the new run's session. */
async function start(stack: Stack, f: Fixture, taskId: string): Promise<string> {
  const answer = await stack.tasks.execute(f.ownerId, taskId) as { ok?: boolean; sessionId?: string };
  assert.equal(answer.ok, true, `the start was not made: ${JSON.stringify(answer)}`);
  assert.ok(answer.sessionId, 'the start named no session');
  return answer.sessionId!;
}

/**
 * The claim's own write, as a current replica makes it: one that reads the session's engine, which
 * every run is created with (migration 0414's acquisition guard drops the claim of any replica that
 * does not).
 */
async function claimWrite(stack: Stack, sessionId: string): Promise<void> {
  await stack.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING } });
  });
}

/**
 * What the runner does with a claimed run whose ref it could not resolve (§6.3 steps 2 and 3).
 *
 * The claim's own write, the selector off the row, and the refusal POSTed through the real pin
 * route in the runner's own words — `git fetch`'s sentence for a ref the authority does not have,
 * which is what `mentionsMissingRef` turns into BASE_REF_NOT_FOUND (src/runner-go/source.go). No
 * repository is needed: the refusal is the runner's answer, and the door is what is under test.
 */
async function refuseAtResolution(
  stack: Stack,
  f: Fixture,
  sessionId: string,
): Promise<{ ref: string; stderr: string; response: Awaited<ReturnType<RunnerApiController['pinSessionSource']>> }> {
  await claimWrite(stack, sessionId);
  const selected = await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { sourceState: true, sourceRef: true },
  });
  assert.equal(selected.sourceState, 'SELECTED');
  const ref = selected.sourceRef!;
  const stderr = `fatal: couldn't find remote ref ${ref}`;
  const response = await stack.api.pinSessionSource(
    { id: f.runnerId, ownerId: f.ownerId },
    sessionId,
    {
      refusal: {
        code: 'BASE_REF_NOT_FOUND',
        detail: { ref, refAuthority: 'REMOTE', remoteName: 'origin', stderr },
      },
    },
  );
  return { ref, stderr, response };
}

interface RunnerOutcome {
  /** The commit the run was pinned to. */
  pin: string;
  /** The required commits the pin does not contain — empty when the checkout was admitted. */
  missing: string[];
  /** Where the engine would have run, when it was admitted. */
  checkout: string | null;
}

/**
 * What the runner does with a claimed run whose SOURCE is resolved, up to the engine.
 *
 * `ensureSourcePinned` then `setupSourceWorktree` (src/runner-go/source.go, worktree.go), with the
 * one liberty the fixture takes: the ref is read from this repository rather than fetched from a
 * remote, which is what RUNNER_LOCAL authority does anyway. The pin is frozen by the control
 * plane's own compare-and-set; the gate is `git merge-base --is-ancestor`, commit by commit; and a
 * refusal is reported the way `runSessionProcess` reports one — no engine, and `/finalize` with the
 * run FAILED and `<code>: <reason>` as its error, byte for byte the runner's sentence.
 */
async function runnerTakes(stack: Stack, f: Fixture, sessionId: string): Promise<RunnerOutcome> {
  // The claim's own write: the run is this runner's now.
  await claimWrite(stack, sessionId);
  const selected = await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { sourceState: true, sourceKind: true, sourceRef: true, sourceRequiredContains: true },
  });
  assert.equal(selected.sourceState, 'SELECTED');
  assert.equal(selected.sourceKind, 'DEPENDENCY_CLOSURE', 'a task with a landed prerequisite is P4');
  assert.equal(selected.sourceRef, `refs/heads/${f.branch}`, 'P4 starts from the integration line');
  const pin = git(f.repo, 'rev-parse', '--verify', `${selected.sourceRef}^{commit}`);
  const frozen = await freezeSessionSourcePin(
    stack.prisma,
    { sessionId, runnerId: f.runnerId, ownerId: f.ownerId },
    { baseSha: pin },
  );
  assert.equal(frozen.state, 'PINNED');
  assert.equal(frozen.baseSha, pin);

  const missing = selected.sourceRequiredContains.filter((sha) => !contains(f.repo, pin, sha));
  if (missing.length > 0) {
    const finalized = await stack.api.finalize({ id: f.runnerId }, sessionId, {
      status: SharedRunStatus.FAILED,
      error: 'DEPENDENCY_BASE_NOT_LANDED: '
        + `pinned commit ${pin} does not contain prerequisite commit(s) ${missing.join(', ')}`,
    });
    assert.equal(finalized.ok, true);
    return { pin, missing, checkout: null };
  }
  const checkout = mkdtempSync(path.join(tmpdir(), 'orbit-checkout-'));
  rmSync(checkout, { recursive: true, force: true });
  git(f.repo, 'worktree', 'add', '--quiet', '--detach', checkout, pin);
  return { pin, missing, checkout };
}

// --- what a reader of the system can see ---------------------------------------------------------

function refusalWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'TASK_DISPATCH_REFUSED' },
    select: {
      subjectType: true, subjectId: true, subjectVersion: true, status: true,
      refusalCode: true, sessionId: true,
    },
    orderBy: { id: 'asc' },
  });
}

/** Every message the standing conversation has been SENT, its own opening prompt excluded. */
function coordinatorMessages(db: PrismaClient, f: Fixture) {
  return db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    select: { content: true },
    orderBy: { seq: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

function timeline(db: PrismaClient, taskId: string) {
  return db.taskComment.findMany({
    where: { taskId }, select: { body: true }, orderBy: { createdAt: 'asc' },
  });
}

const refusalOf = async (db: PrismaClient, taskId: string) =>
  (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { dispatchRefusal: true } }))
    .dispatchRefusal as unknown as TaskDispatchRefusal | null;

/** The project's own exception items: what the project page counts as needing a person (SR50). */
function blockers(db: PrismaClient, projectId: string) {
  return db.projectBlocker.findMany({
    where: { projectId },
    select: {
      id: true, kind: true, owner: true, recovery: true, severity: true, subjectType: true,
      subjectId: true, detail: true, dedupeKey: true, requiredAction: true, resolvedAt: true,
      lifecycleGeneration: true,
    },
    orderBy: { id: 'asc' },
  });
}

function release(f: Fixture, checkouts: Array<string | null>): void {
  for (const checkout of checkouts) if (checkout) rmSync(checkout, { recursive: true, force: true });
  rmSync(f.repo, { recursive: true, force: true });
}

// -------------------------------------------------------------------------------------------------

test('(a) a start whose pinned commit lacks the prerequisite\'s landed commit is refused, recorded on the task, and delivered to the coordinator naming the task and the prerequisite',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'refused-start');
    try {
      await lineExists(stack, f);
      // The prerequisite's work reached main directly; the project branch has not absorbed main.
      // The line exists — one landing of its own, nothing from main yet — which is what makes this
      // a case about the line's tip rather than about the line not existing (v1.2).
      const p = await prerequisite(stack, f, 'quota-by-account', { onto: 'main' });
      const dependent = await dependentOf(stack, f, 'duplicate-account-hint', p.taskId);

      const sessionId = await start(stack, f, dependent);
      const started = await stack.db.task.findUniqueOrThrow({
        where: { id: dependent }, select: { status: true, updatedAt: true },
      });
      const before = new Date();
      const outcome = await runnerTakes(stack, f, sessionId);
      const after = new Date();

      // The gate held, on real history: the line's tip does not contain the landing on main.
      assert.deepEqual(outcome.missing, [p.landedSha], 'the runner admitted a checkout it should have refused');
      assert.equal(outcome.checkout, null);
      const run = await stack.db.session.findUniqueOrThrow({
        where: { id: sessionId }, select: { status: true, sourceBaseSha: true, error: true },
      });
      assert.equal(run.status, RunStatus.FAILED, 'the refused run is over');
      assert.equal(run.sourceBaseSha, outcome.pin);

      // The task says so: code, time, the commit it stood on, what that commit lacked and whose
      // landing that is — and the row moved, which is the first thing the incident did not do.
      const refusal = await refusalOf(stack.db, dependent);
      assert.ok(refusal, 'the refused start left nothing on the task');
      assert.equal(refusal.code, 'DEPENDENCY_BASE_NOT_LANDED');
      assert.equal(refusal.fixAction, 'SYNC_INTEGRATION_LINE');
      assert.equal(refusal.sessionId, sessionId);
      assert.equal(refusal.baseSha, outcome.pin);
      assert.equal(refusal.ref, `refs/heads/${f.branch}`);
      assert.deepEqual(refusal.missing, [{ sha: p.landedSha, taskId: p.taskId }]);
      const refusedAt = new Date(refusal.refusedAt).getTime();
      assert.ok(refusedAt >= before.getTime() && refusedAt <= after.getTime(), 'refusedAt is not when it happened');
      const row = await stack.db.task.findUniqueOrThrow({
        where: { id: dependent }, select: { status: true, updatedAt: true },
      });
      assert.ok(row.updatedAt > started.updatedAt, 'the refusal did not move the task row');
      assert.equal(row.status, TaskStatus.OPEN, 'a refused start is not a failed task');

      // Both reads a person and an agent use carry it: the detail (task_get) and the list row.
      const detail = await stack.tasks.get(f.ownerId, dependent) as { dispatchRefusal?: unknown };
      assert.deepEqual(detail.dispatchRefusal, refusal);
      const listed = await stack.tasks.listRow(f.ownerId, dependent) as { dispatchRefusal?: unknown };
      assert.deepEqual(listed.dispatchRefusal, refusal);

      // The timeline gives the next step, and no longer says "run it again".
      const notes = await timeline(stack.db, dependent);
      const refusalNotes = notes.filter((note) => note.body.includes(`orbit:${DISPATCH_REFUSED_SIGNAL_CODE}`));
      assert.equal(refusalNotes.length, 1, 'one refused start, one note');
      assert.ok(refusalNotes[0]!.body.includes(dispatchRefusalNextStep(refusal)));
      assert.ok(refusalNotes[0]!.body.includes(p.landedSha!));
      assert.ok(refusalNotes[0]!.body.includes(uuidToBase62(p.taskId)));
      assert.ok(!notes.some((note) => note.body.includes('可重新运行本任务重试')),
        'the timeline still tells whoever reads it to run the task again');

      // And the coordinator is told: one wake, delivered to the standing conversation, whose one
      // message names the task, the prerequisite and the commit, and says what to do.
      assert.deepEqual(await refusalWakes(stack.db, f.projectId), [{
        subjectType: 'TASK', subjectId: dependent, subjectVersion: sessionId, status: 'DELIVERED',
        refusalCode: null, sessionId: f.coordinatorSessionId,
      }]);
      const messages = await coordinatorMessages(stack.db, f);
      assert.equal(messages.length, 1, 'the coordinator was not sent exactly one message');
      const message = messages[0]!.content ?? '';
      assert.ok(message.includes(uuidToBase62(dependent)), 'the message does not name the task');
      assert.ok(message.includes(uuidToBase62(p.taskId)), 'the message does not name the prerequisite');
      assert.ok(message.includes(p.landedSha!.slice(0, 10)), 'the message does not name the missing commit');
      assert.ok(message.includes('DEPENDENCY_BASE_NOT_LANDED'));
      assert.ok(message.includes(dispatchRefusalNextStep(refusal)), 'the message gives no next step');
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), [],
        'a refused start is delivered to the conversation that exists, not judged in a new one');
    } finally {
      release(f, []);
      await stack.db.$disconnect();
    }
  });

test('(b) doing the next step the refusal names — the line absorbs main — lets the next start re-pin to the line\'s tip and be admitted with the prerequisite\'s work in its tree',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'way-out');
    const checkouts: Array<string | null> = [];
    try {
      // A line that exists (v1.2): one landing of its own, and it has not absorbed main, which is
      // what the prerequisite's work went to.
      await lineExists(stack, f);
      const p = await prerequisite(stack, f, 'landed-on-main', { onto: 'main' });
      const dependent = await dependentOf(stack, f, 'waits-for-it', p.taskId);

      const refusedRun = await start(stack, f, dependent);
      const refused = await runnerTakes(stack, f, refusedRun);
      checkouts.push(refused.checkout);
      assert.deepEqual(refused.missing, [p.landedSha]);
      const recorded = await refusalOf(stack.db, dependent);
      assert.equal(recorded?.fixAction, 'SYNC_INTEGRATION_LINE');

      // Starting again before anything changes is the same refusal — which is why the note no
      // longer says to — and it is a second refusal of a second run, recorded as such.
      const again = await start(stack, f, dependent);
      const refusedAgain = await runnerTakes(stack, f, again);
      checkouts.push(refusedAgain.checkout);
      assert.deepEqual(refusedAgain.missing, [p.landedSha], 'a restart changed what the gate found');
      assert.equal((await refusalOf(stack.db, dependent))?.sessionId, again);

      // The next step: bring the line up to main, the way the next landing's main sync does.
      git(f.repo, 'checkout', '--quiet', f.branch);
      git(f.repo, 'merge', '--quiet', '--no-ff', '-m', 'absorb main', 'main');
      const tip = git(f.repo, 'rev-parse', 'HEAD');

      const admittedRun = await start(stack, f, dependent);
      // A run is away on the task, so the task no longer says its latest start was refused.
      assert.equal(await refusalOf(stack.db, dependent), null, 'the new start left the old refusal standing');
      const admitted = await runnerTakes(stack, f, admittedRun);
      checkouts.push(admitted.checkout);
      assert.equal(admitted.pin, tip, 'the new start did not re-pin to the line\'s current tip');
      assert.deepEqual(admitted.missing, [], 'the line that absorbed main was still refused');
      assert.ok(admitted.checkout && existsSync(path.join(admitted.checkout, 'landed-on-main.txt')),
        'the admitted checkout does not have the prerequisite\'s work in it');
      assert.equal(await refusalOf(stack.db, dependent), null);

      // Two refused runs, two facts; the admitted one added none.
      const wakes = await refusalWakes(stack.db, f.projectId);
      assert.deepEqual(wakes.map((wake) => wake.subjectVersion).sort(), [refusedRun, again].sort());
    } finally {
      release(f, checkouts);
      await stack.db.$disconnect();
    }
  });

test('(c) a start whose pinned commit already contains the prerequisite\'s landed commit is admitted, and leaves no refusal and no delivery',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'admitted-start');
    let checkout: string | null = null;
    try {
      // The prerequisite's landing is on the line itself, so the line's tip contains it.
      const p = await prerequisite(stack, f, 'landed-on-line', { onto: 'line' });
      const dependent = await dependentOf(stack, f, 'starts-cleanly', p.taskId);

      const sessionId = await start(stack, f, dependent);
      const outcome = await runnerTakes(stack, f, sessionId);
      checkout = outcome.checkout;

      assert.deepEqual(outcome.missing, [], 'a checkout that contains the prerequisite was refused');
      assert.ok(checkout && existsSync(path.join(checkout, 'landed-on-line.txt')),
        'the admitted checkout does not have the prerequisite\'s work in it');
      // The run ran and ended the ordinary way.
      await stack.api.finalize({ id: f.runnerId }, sessionId, { status: SharedRunStatus.SUCCEEDED });

      assert.equal(await refusalOf(stack.db, dependent), null, 'an admitted start recorded a refusal');
      const notes = await timeline(stack.db, dependent);
      assert.ok(!notes.some((note) => note.body.includes(`orbit:${DISPATCH_REFUSED_SIGNAL_CODE}`)));
      assert.deepEqual(await refusalWakes(stack.db, f.projectId), []);
      assert.deepEqual(await coordinatorMessages(stack.db, f), [], 'the coordinator was told about a start that ran');
    } finally {
      release(f, [checkout]);
      await stack.db.$disconnect();
    }
  });

test('(d) a start whose prerequisite has not landed is still refused, before any run exists',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'not-landed');
    try {
      // DONE, with a worktree branch — code work — and no receipt anywhere.
      const p = await prerequisite(stack, f, 'finished-not-landed', null);
      const dependent = await dependentOf(stack, f, 'must-wait', p.taskId);

      await assert.rejects(
        stack.tasks.execute(f.ownerId, dependent),
        (error: Error) => error.message === PREREQUISITE_NOT_LANDED_MESSAGE,
        'a start whose prerequisite has not landed was let through',
      );
      assert.equal(
        await stack.db.session.count({ where: { taskId: dependent, startsTaskWork: true } }), 0,
        'a run exists for a task whose prerequisite has not landed',
      );
      assert.equal(await refusalOf(stack.db, dependent), null);
      assert.deepEqual(await refusalWakes(stack.db, f.projectId), []);
    } finally {
      release(f, []);
      await stack.db.$disconnect();
    }
  });

test('a refused start under a switched-off coordinator is recorded on the task and wakes nobody',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'switched-off', { coordinatorEnabled: false });
    try {
      await lineExists(stack, f);
      const p = await prerequisite(stack, f, 'landed-on-main-off', { onto: 'main' });
      const dependent = await dependentOf(stack, f, 'refused-off', p.taskId);
      const sessionId = await start(stack, f, dependent);
      const outcome = await runnerTakes(stack, f, sessionId);
      assert.deepEqual(outcome.missing, [p.landedSha]);

      // The switch governs who is woken, not whether the task says it could not start.
      const refusal = await refusalOf(stack.db, dependent);
      assert.equal(refusal?.code, 'DEPENDENCY_BASE_NOT_LANDED');
      assert.equal(refusal?.sessionId, sessionId);

      const [wake, ...more] = await refusalWakes(stack.db, f.projectId);
      assert.deepEqual(more, [], 'one refused start, one wake row');
      assert.ok(wake, 'the refusal never reached the ledger: a switched-off control over a producer nobody calls');
      assert.equal(wake.status, 'REFUSED');
      assert.equal(wake.refusalCode, DISPATCH_REFUSED_WAKE_COORDINATOR_DISABLED);
      assert.equal(wake.sessionId, null);
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      assert.deepEqual(await coordinatorMessages(stack.db, f), [], 'a switched-off coordinator was told');
    } finally {
      release(f, []);
      await stack.db.$disconnect();
    }
  });

test('a run that fails for any other reason is not taken for a refused start',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'ordinary-failure');
    let checkout: string | null = null;
    try {
      const p = await prerequisite(stack, f, 'landed-on-line-too', { onto: 'line' });
      const dependent = await dependentOf(stack, f, 'fails-later', p.taskId);
      const sessionId = await start(stack, f, dependent);
      const outcome = await runnerTakes(stack, f, sessionId);
      checkout = outcome.checkout;
      assert.deepEqual(outcome.missing, []);

      // The engine ran and died: an error of its own, upper-case words and a colon included.
      await stack.api.finalize({ id: f.runnerId }, sessionId, {
        status: SharedRunStatus.FAILED,
        error: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      });

      assert.equal(await refusalOf(stack.db, dependent), null, 'an engine failure was recorded as a refused start');
      const notes = await timeline(stack.db, dependent);
      assert.ok(notes.some((note) => note.body.startsWith('**执行失败（系统自动记录）**')),
        'the ordinary failure note is gone');
      assert.ok(!notes.some((note) => note.body.includes(`orbit:${DISPATCH_REFUSED_SIGNAL_CODE}`)));
      assert.deepEqual(await refusalWakes(stack.db, f.projectId), []);
    } finally {
      release(f, [checkout]);
      await stack.db.$disconnect();
    }
  });

test('a start refused at resolution opens the project\'s SOURCE_UNRESOLVED item, once per line and code',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'source-item');
    try {
      // The line the dependent is dispatched from is the project's own, and the runner cannot
      // resolve it (the incident's shape: the branch was never created).
      const p = await prerequisite(stack, f, 'landed-on-the-line', { onto: 'line' });
      const first = await dependentOf(stack, f, 'refused-line', p.taskId);
      const sessionId = await start(stack, f, first);
      const refused = await refuseAtResolution(stack, f, sessionId);
      assert.equal(refused.response.state, 'REFUSED');
      assert.equal(refused.response.wonRace, true);
      assert.equal(refused.response.refusalCode, 'BASE_REF_NOT_FOUND');
      assert.equal(await refusalOf(stack.db, first).then((r) => r?.ref), refused.ref,
        'the refusal on the task is not about the ref that could not be resolved');

      // SR50: the project's own exception item — the kind migration 0231 declared, on the project,
      // owned by the person who can change the binding or create the branch.
      const items = await blockers(stack.db, f.projectId);
      assert.equal(items.length, 1, 'one refused start left the project with no item, or with two');
      const [item] = items;
      assert.equal(item.kind, 'SOURCE_UNRESOLVED');
      assert.equal(item.owner, 'USER');
      assert.equal(item.recovery, 'HUMAN');
      assert.equal(item.severity, 'CRITICAL');
      assert.equal(item.subjectType, 'PROJECT');
      assert.equal(item.subjectId, f.projectId);
      assert.equal(item.resolvedAt, null);
      assert.equal(item.lifecycleGeneration, 1n);
      assert.deepEqual(item.detail, {
        code: 'BASE_REF_NOT_FOUND',
        fixAction: 'FIX_REF',
        ref: refused.ref,
        taskIds: [first],
      });
      // The row's advice is the task comment's and the coordinator message's own sentence: three
      // readers, one next step, no second copy of §10.1's pairing to drift.
      assert.ok(
        item.requiredAction.includes(dispatchRefusalNextStep({ fixAction: 'FIX_REF', ref: refused.ref })),
        'the project item gives a next step of its own',
      );

      // A second task dispatched from the same line is the same thing to fix, and so is a re-issue
      // of the first refusal (a runner whose response was lost): one open item, and the row that is
      // there is the first one.
      const second = await dependentOf(stack, f, 'refused-line-again', p.taskId);
      const secondSession = await start(stack, f, second);
      await refuseAtResolution(stack, f, secondSession);
      await stack.api.pinSessionSource(
        { id: f.runnerId, ownerId: f.ownerId },
        sessionId,
        {
          refusal: {
            code: 'BASE_REF_NOT_FOUND',
            detail: { ref: refused.ref, refAuthority: 'REMOTE', remoteName: 'origin', stderr: refused.stderr },
          },
        },
      );
      assert.deepEqual(await blockers(stack.db, f.projectId), items, 'the item was raised a second time');
    } finally {
      release(f, []);
      await stack.db.$disconnect();
    }
  });

test('a start refused for a task in no project records the refusal and opens no project item',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'refused-without-project');
    try {
      // A defensive case, and a deliberately constructed one: `task_claimed_project_move_guard`
      // (0122, widened by 0130) refuses to move a task out of its project while any session of it
      // is live, so a refused run's task is normally still in the project that gave it a SOURCE.
      // What is asserted is that the door INVENTS nothing — the session is what the refusal is
      // about, and its task is the only row that can name a project for the item.
      const orphan = await stack.tasks.create(f.ownerId, {
        title: 'refused-without-a-project',
        assigneeId: f.workspaceId,
        autoRunWhenReady: false,
        ...CHECK,
      } as never) as { id: string };
      const sessionId = randomUUID();
      await stack.db.session.create({
        data: {
          id: sessionId, ownerId: f.ownerId, creatorId: f.ownerId, taskId: orphan.id,
          workspaceId: f.workspaceId, assignedRunnerId: f.runnerId,
          title: 'refused-without-a-project', prompt: 'do the thing', provider: 'claude',
          providerBuiltin: true, status: RunStatus.PENDING,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
          // The frozen selector a run of a code task carries (SR28) — the one part of this row the
          // fixture has to state, because no door resolves a SOURCE for a task in no project.
          sourceState: 'SELECTED', sourceKind: 'PROJECT_UPSTREAM',
          sourceCodebaseId: randomUUID(), sourceRepoUrl: 'https://github.com/example/dispatch-refusal',
          sourceRef: 'refs/heads/main', sourceRefAuthority: 'REMOTE', sourceConfigRevision: 0n,
          sourceRequiredContains: [],
        },
      });

      const refused = await refuseAtResolution(stack, f, sessionId);
      assert.equal(refused.response.state, 'REFUSED');
      assert.equal(refused.response.wonRace, true);

      // The task still says it — the refusal is recorded where it can legally be recorded, and
      // nothing is filed against a project this task is not in.
      const recorded = await refusalOf(stack.db, orphan.id);
      assert.equal(recorded?.code, 'BASE_REF_NOT_FOUND');
      assert.equal(recorded?.sessionId, sessionId);
      assert.deepEqual(await blockers(stack.db, f.projectId), [], 'a task in no project opened an item');
      const stray = await stack.db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "project_blocker"
         WHERE "detail" -> 'taskIds' @> ${JSON.stringify([orphan.id])}::jsonb
      `;
      assert.deepEqual(stray, [], 'the refusal of a project-less task was filed against some project');
    } finally {
      release(f, []);
      await stack.db.$disconnect();
    }
  });

test('a start refused at its checkout opens the project\'s SOURCE_UNRESOLVED item, once per line and code',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'checkout-item');
    try {
      // The scene case (a) drives: the line exists and has not absorbed main, and the prerequisite's
      // landing went to main — so the checkout is where this start stops.
      await lineExists(stack, f);
      const p = await prerequisite(stack, f, 'landed-on-main-for-item', { onto: 'main' });
      const first = await dependentOf(stack, f, 'refused-at-checkout', p.taskId);

      const sessionId = await start(stack, f, first);
      const outcome = await runnerTakes(stack, f, sessionId);
      assert.deepEqual(outcome.missing, [p.landedSha], 'the checkout was admitted, so nothing was refused');

      // The refusal is on the task (case a) — and the PROJECT now carries its own item for the same
      // fact. SR50 says all eight codes reach the one kind, and §10.3's claim is about the CODE: the
      // gate that produced it is not part of it, so a checkout refusal has to raise the row a
      // resolution refusal raises, in the same shape.
      assert.equal((await refusalOf(stack.db, first))?.code, 'DEPENDENCY_BASE_NOT_LANDED');
      const items = await blockers(stack.db, f.projectId);
      assert.equal(items.length, 1, 'one refused start left the project with no item, or with two');
      const [item] = items;
      assert.equal(item.kind, 'SOURCE_UNRESOLVED');
      assert.equal(item.owner, 'USER');
      assert.equal(item.recovery, 'HUMAN');
      assert.equal(item.severity, 'CRITICAL');
      assert.equal(item.subjectType, 'PROJECT');
      assert.equal(item.subjectId, f.projectId);
      assert.equal(item.resolvedAt, null);
      assert.equal(item.lifecycleGeneration, 1n);
      // Key, detail and advice, the same three the pin door's row carries: the two facts a person has
      // to change under the one kind, and §10.1's own next step for this code rather than a second
      // sentence free to drift from the task comment's.
      assert.equal(item.dedupeKey, `SOURCE_UNRESOLVED:DEPENDENCY_BASE_NOT_LANDED:refs/heads/${f.branch}`);
      assert.deepEqual(item.detail, {
        code: 'DEPENDENCY_BASE_NOT_LANDED',
        fixAction: 'SYNC_INTEGRATION_LINE',
        ref: `refs/heads/${f.branch}`,
        taskIds: [first],
      });
      assert.ok(
        item.requiredAction.includes(
          dispatchRefusalNextStep({ fixAction: 'SYNC_INTEGRATION_LINE', ref: `refs/heads/${f.branch}` }),
        ),
        'the project item gives a next step of its own',
      );

      // One row per line and code, not one per run: starting the same task again meets the same
      // refusal, and a second task dispatched from the same line is the same thing to fix. The row
      // that is there is the first one — same id, same generation, its `taskIds` still the first
      // task's, because a second refusal finds it open and writes nothing.
      const again = await start(stack, f, first);
      assert.deepEqual((await runnerTakes(stack, f, again)).missing, [p.landedSha]);
      const second = await dependentOf(stack, f, 'refused-at-checkout-again', p.taskId);
      const secondSession = await start(stack, f, second);
      assert.deepEqual((await runnerTakes(stack, f, secondSession)).missing, [p.landedSha]);
      assert.deepEqual(await blockers(stack.db, f.projectId), items, 'the item was raised a second time');

      // And the key's OTHER half is the code, which is what lets the kind stay one value while the
      // fix does not (SR50). The same line can be unresolved because it has not absorbed the
      // prerequisite, or because the commit this run pinned to is not in the runner's repository at
      // all: the second is a different action (RESTORE_COMMIT) and gets a row of its own.
      const gone = 'b'.repeat(40);
      const missingObject = await dependentOf(stack, f, 'refused-object-missing', p.taskId);
      const objectSession = await start(stack, f, missingObject);
      await claimWrite(stack, objectSession);
      const frozen = await freezeSessionSourcePin(
        stack.prisma,
        { sessionId: objectSession, runnerId: f.runnerId, ownerId: f.ownerId },
        // G4 is judged at the checkout, after the pin froze, so this scene states the pin the runner
        // stood on — a commit object that is not in the repository it asked.
        { baseSha: gone },
      );
      assert.equal(frozen.state, 'PINNED');
      const finalized = await stack.api.finalize({ id: f.runnerId }, objectSession, {
        status: SharedRunStatus.FAILED,
        error: `BASE_SHA_UNAVAILABLE: no commit object for ${gone} in this repository`,
      });
      assert.equal(finalized.ok, true);
      const rows = await blockers(stack.db, f.projectId);
      assert.equal(rows.length, 2, 'a second code on the same line did not get an item of its own');
      const objectItem = rows.find((row) => row.id !== item.id);
      assert.ok(objectItem, 'the second code raised no item of its own');
      assert.equal(objectItem.dedupeKey, `SOURCE_UNRESOLVED:BASE_SHA_UNAVAILABLE:refs/heads/${f.branch}`);
      assert.deepEqual(objectItem.detail, {
        code: 'BASE_SHA_UNAVAILABLE',
        fixAction: 'RESTORE_COMMIT',
        ref: `refs/heads/${f.branch}`,
        taskIds: [missingObject],
      });
      assert.ok(objectItem.requiredAction.includes(
        dispatchRefusalNextStep({ fixAction: 'RESTORE_COMMIT', ref: `refs/heads/${f.branch}` }),
      ));
    } finally {
      release(f, []);
      await stack.db.$disconnect();
    }
  });

test('a checkout refusal for a task in no project records the refusal and opens no project item',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'checkout-without-project');
    try {
      // Constructed, for the reason the resolution case above gives: `task_claimed_project_move_guard`
      // (0122, widened by 0130) refuses to take a task out of its project while any session of it is
      // live, so a refused run's task is normally still in the project that gave it a SOURCE. What is
      // asserted is that this door INVENTS nothing — the refusal is recorded where it can legally be
      // recorded, and a project the task is not in is not told about it.
      const orphan = await stack.tasks.create(f.ownerId, {
        title: 'refused-at-checkout-without-a-project',
        assigneeId: f.workspaceId,
        autoRunWhenReady: false,
        ...CHECK,
      } as never) as { id: string };
      const sessionId = randomUUID();
      await stack.db.session.create({
        data: {
          id: sessionId, ownerId: f.ownerId, creatorId: f.ownerId, taskId: orphan.id,
          workspaceId: f.workspaceId, assignedRunnerId: f.runnerId,
          title: 'refused-at-checkout-without-a-project', prompt: 'do the thing', provider: 'claude',
          providerBuiltin: true, status: RunStatus.RUNNING,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
          // The other half of the fixture the resolution case states: a checkout refusal is decided
          // AFTER the pin froze (G4/G5/G6), so the row carries the pin this run stood on. That is
          // also what `readDispatchRefusal` reads — anything less is a Legacy session, which never
          // reaches a checkout at all.
          sourceState: 'PINNED', sourceKind: 'PROJECT_UPSTREAM',
          sourceCodebaseId: randomUUID(), sourceRepoUrl: 'https://github.com/example/dispatch-refusal',
          sourceRef: 'refs/heads/main', sourceRefAuthority: 'REMOTE', sourceConfigRevision: 0n,
          // `session_source_pin_chk` (0231): a PINNED row IS a frozen pin, so both halves of it —
          // the SHA and the moment a runner resolved it — travel together.
          sourceBaseSha: 'a'.repeat(40), sourceResolvedAt: new Date(),
          sourceRequiredContains: [],
        },
      });

      const finalized = await stack.api.finalize({ id: f.runnerId }, sessionId, {
        status: SharedRunStatus.FAILED,
        error: 'WORKTREE_REQUIRED: the workspace cannot take an isolated worktree on this base',
      });
      assert.equal(finalized.ok, true);

      const recorded = await refusalOf(stack.db, orphan.id);
      assert.equal(recorded?.code, 'WORKTREE_REQUIRED');
      assert.equal(recorded?.sessionId, sessionId);
      assert.deepEqual(await blockers(stack.db, f.projectId), [], 'a task in no project opened an item');
      const stray = await stack.db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "project_blocker"
         WHERE "detail" -> 'taskIds' @> ${JSON.stringify([orphan.id])}::jsonb
      `;
      assert.deepEqual(stray, [], 'the refusal of a project-less task was filed against some project');
    } finally {
      release(f, []);
      await stack.db.$disconnect();
    }
  });
