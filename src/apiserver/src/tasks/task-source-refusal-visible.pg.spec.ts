import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * A start the runner refuses when it RESOLVES the source is a fact somebody can see.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-source-refusal-visible.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * §6.3's handshake has two gates and both can end a start with no engine. The CHECKOUT gate is the
 * one the sibling spec covers: a run pinned and then admitted or refused at `setupSourceWorktree`,
 * reported by the `/finalize` that ends it, recorded on the task since migration 0298. RESOLUTION is
 * the one BEFORE it — the machine that owns the repository fetches the selector's ref — and it was
 * silent everywhere a person looks.
 *
 * On 2026-09-23 (project 34TsjwkAMVVkeEUwi2IAJ) a task was dispatched from its project's
 * integration line and that line did not exist: the prerequisite's landing receipt said the work had
 * landed there, while the integration job had already answered ALREADY_LANDED and never created the
 * branch. The runner fetched, git said `fatal: couldn't find remote ref refs/heads/project/…`, and
 * the refusal was posted to `/runner/sessions/:id/source/pin` — which wrote `session.source_state`,
 * `source_refusal_code` and `source_refusal_detail` and NOTHING ELSE. The task row stayed untouched
 * with no comment, no exception item and no wake row, and the session sat idle for 5.5 hours with
 * nothing in the system saying a project had stopped until a person happened to look.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * Every case drives the production doors in the order a real start takes them: `TasksService.execute`
 * (the `task_start` door) freezes the selector, and then this file does what the runner does with a
 * claimed run, against a REAL repository — mark the session claimed, read the selector off the
 * snapshot, and run the runner's own resolution: `git fetch --no-tags <remote> <ref>`, then
 * `rev-parse --verify FETCH_HEAD^{commit}` on success (`resolveSourceSha`, src/runner-go/source.go).
 * A fetch that fails because git named no such ref is what the runner calls BASE_REF_NOT_FOUND, and
 * it is posted through the real pin route in the runner's own words. Nothing below writes a
 * refusal, a wake or a comment by hand.
 *
 *   (a) the project's integration line was never created: the start is refused at resolution, the
 *       SESSION records the code and the runner's stderr, the TASK records the refusal — code,
 *       fixAction, time, the ref that was not there, and no pin — the timeline gives the next step
 *       instead of "run it again", and the project's standing coordinator conversation is sent one
 *       message naming the task, through the wake ledger (`TASK_DISPATCH_REFUSED`, DELIVERED);
 *   (b) the negative control: a line that exists and holds the prerequisite's work resolves
 *       normally, leaves no refusal, no refusal comment and no delivery — and the wire answer
 *       carries no bookkeeping about the task either;
 *   (c) reporting the same refusal twice — a runner re-issuing a request whose response it never
 *       saw — leaves ONE fact: the compare-and-set is lost the second time, and a loser records
 *       nothing, which is what makes the transaction in (a) safe to retry;
 *   (d) the other negative control: a prerequisite that has not landed at all is still refused the
 *       dispatch itself, before any run exists — nothing here widened a gate. The refusal is the
 *       thing that was missing, not a way past it.
 *
 * plus a refused start under a switched-off coordinator (the refusal is still on the task, the wake
 * is refused on the switch and nobody is told).
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
  // The binding's `remoteName` is `origin` and its `refAuthority` is REMOTE, so this is the remote
  // the runner's fetch asks. It is the repository itself, which is what a local-path remote is and
  // what makes a fetch fail for the reason this file is about rather than for want of a network.
  git(dir, 'remote', 'add', 'origin', dir);
  return dir;
}

/** Commit one new file on whatever is checked out, and answer the new commit. */
function commitFile(dir: string, file: string): string {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '--quiet', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * The runner's own resolution question: `git fetch --no-tags <remote> <ref>` (`resolveSourceSha`,
 * src/runner-go/source.go). The stderr is the whole diagnosis when it fails.
 */
function fetchRef(dir: string, remote: string, ref: string): { ok: boolean; stderr: string } {
  const run = spawnSync('git', ['-C', dir, 'fetch', '--no-tags', remote, ref], { encoding: 'utf8' });
  return { ok: run.status === 0, stderr: (run.stderr ?? '').trim() };
}

/** `mentionsMissingRef`: the one thing separating "I could not ask" from "that ref is not there". */
function saysMissingRef(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("couldn't find remote ref")
    || text.includes('could not find remote ref')
    || text.includes('no such ref');
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
 *
 * `lineCreated: false` is the incident: the binding names an integration ref and a merge receipt
 * says work landed on it, while the branch was never created.
 */
async function fixture(
  stack: Stack,
  label: string,
  options: { coordinatorEnabled?: boolean; lineCreated?: boolean } = {},
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${RUN}-${ownerId}@source-refusal.invalid`, name: label,
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
      repoUrl: 'https://github.com/example/source-refusal',
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
      ownerId, projectId, canonicalRepoUrl: 'https://github.com/example/source-refusal',
      upstreamRef: 'refs/heads/main', integrationRef: `refs/heads/${branch}`,
      refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: new Date(),
    },
  });
  const repo = repository(label);
  const root = commitFile(repo, 'README');
  // The line's first landing is what creates it. A case that says the landing never happened leaves
  // the branch absent — and `main` is all the repository has.
  if (options.lineCreated ?? true) git(repo, 'branch', branch);
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
 *
 * `receiptOnly` is the incident's shape: the receipt names a landing the repository has no branch
 * for, because the integration job that was supposed to create it answered ALREADY_LANDED first.
 */
async function prerequisite(
  stack: Stack,
  f: Fixture,
  title: string,
  landed: { onto: 'main' | 'line'; receiptOnly?: boolean } | null,
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
  // What the receipt says the target stood on before. Where there is no branch to read it from,
  // it is the root the line would have started from — the receipt is the only record of a landing
  // that never created one, which is exactly what the case is about.
  const before = landed.receiptOnly ? f.root : git(f.repo, 'rev-parse', target);
  let after = work;
  if (!landed.receiptOnly) {
    git(f.repo, 'checkout', '--quiet', target);
    git(f.repo, 'merge', '--quiet', '--no-ff', '-m', `land ${title}`, branch);
    after = git(f.repo, 'rev-parse', 'HEAD');
  }
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

interface Resolution {
  /** The ref the selector pointed at, as the runner read it off the snapshot. */
  ref: string;
  /** What the pin door answered, byte for byte what the runner receives. */
  response: Awaited<ReturnType<RunnerApiController['pinSessionSource']>>;
  /** Git's own words, when the resolution was refused. */
  stderr: string | null;
  /** The commit the runner resolved, when it resolved one. */
  resolvedSha: string | null;
}

/**
 * What the runner does with a claimed run whose SOURCE is resolved (§6.3 steps 2 and 3).
 *
 * The claim's own write, then the selector off the snapshot, then the runner's resolution against a
 * real repository: FETCH, and only then resolve — reading a local ref instead of fetching is
 * forbidden (SR38/SR39), and fetching is what makes a refusal here mean "the authority does not
 * have it". A failure git attributes to the ref itself is BASE_REF_NOT_FOUND, by the runner's own
 * test (`mentionsMissingRef`), and is reported through the pin route with the runner's detail keys.
 * Anything else the caller sees as a failed assertion, because a fixture that cannot fetch for a
 * third reason would prove nothing about this one.
 */
async function runnerResolvesSource(
  stack: Stack,
  f: Fixture,
  sessionId: string,
): Promise<Resolution> {
  // The claim's own write: the run is this runner's now.
  await stack.db.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING } });
  const selected = await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { sourceState: true, sourceKind: true, sourceRef: true, sourceRequiredContains: true },
  });
  assert.equal(selected.sourceState, 'SELECTED');
  assert.equal(selected.sourceKind, 'DEPENDENCY_CLOSURE', 'a task with a landed prerequisite is P4');
  assert.equal(selected.sourceRef, `refs/heads/${f.branch}`, 'P4 starts from the integration line');
  const ref = selected.sourceRef!;

  const actor = { id: f.runnerId, ownerId: f.ownerId };
  const fetched = fetchRef(f.repo, 'origin', ref);
  if (!fetched.ok && saysMissingRef(fetched.stderr)) {
    const response = await stack.api.pinSessionSource(actor, sessionId, {
      refusal: {
        code: 'BASE_REF_NOT_FOUND',
        detail: { ref, refAuthority: 'REMOTE', remoteName: 'origin', stderr: fetched.stderr },
      },
    });
    return { ref, response, stderr: fetched.stderr, resolvedSha: null };
  }
  assert.equal(fetched.ok, true, `the fixture's remote did not serve ${ref}: ${fetched.stderr}`);
  // A ref is fetched and THEN resolved (SR38): the value is the authority's, never a local ref some
  // earlier operation left behind.
  const resolvedSha = git(f.repo, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}');
  const response = await stack.api.pinSessionSource(actor, sessionId, { baseSha: resolvedSha });
  return { ref, response, stderr: null, resolvedSha };
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

function refusalNotes(db: PrismaClient, taskId: string) {
  return db.taskComment.findMany({
    where: { taskId, body: { contains: `orbit:${DISPATCH_REFUSED_SIGNAL_CODE}` } },
    select: { body: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
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

function release(f: Fixture): void {
  rmSync(f.repo, { recursive: true, force: true });
}

// -------------------------------------------------------------------------------------------------

test('(a) a start whose integration line does not exist is refused at resolution, recorded on the task, and delivered to the coordinator naming the task',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'refused-source', { lineCreated: false });
    try {
      // The incident: a receipt says the prerequisite's work landed on the line, and the branch was
      // never created — so the dependent resolves against a ref the repository does not have.
      const p = await prerequisite(stack, f, 'quota-ledger', { onto: 'line', receiptOnly: true });
      const dependent = await dependentOf(stack, f, 'hint-from-the-line', p.taskId);

      const sessionId = await start(stack, f, dependent);
      const started = await stack.db.task.findUniqueOrThrow({
        where: { id: dependent }, select: { status: true, updatedAt: true },
      });
      const before = new Date();
      const resolution = await runnerResolvesSource(stack, f, sessionId);
      const after = new Date();

      // The refusal is git's, not the fixture's: the branch is absent from the repository the
      // binding names, and the sentence is the one the incident's session carried.
      assert.equal(resolution.stderr, `fatal: couldn't find remote ref refs/heads/${f.branch}`);
      assert.equal(resolution.resolvedSha, null);
      assert.equal(resolution.response.state, 'REFUSED');
      assert.equal(resolution.response.refusalCode, 'BASE_REF_NOT_FOUND');
      assert.equal(resolution.response.wonRace, true);
      assert.equal(resolution.response.baseSha, undefined, 'a refused resolution froze a pin');
      // The wire answer is §6.3's fact about the SESSION. Which task was written because of it is
      // the control plane's own bookkeeping and does not travel to the runner.
      assert.equal('refused' in resolution.response, false, 'the pin answer carries control-plane bookkeeping');

      // The session says it, in the columns migration 0231 gives a resolution refusal.
      const run = await stack.db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { sourceState: true, sourceRefusalCode: true, sourceRefusalDetail: true, sourceBaseSha: true },
      });
      assert.equal(run.sourceState, 'REFUSED');
      assert.equal(run.sourceRefusalCode, 'BASE_REF_NOT_FOUND');
      assert.equal(run.sourceBaseSha, null);
      assert.deepEqual(run.sourceRefusalDetail, {
        ref: resolution.ref, refAuthority: 'REMOTE', remoteName: 'origin',
        stderr: resolution.stderr, fixAction: 'FIX_REF',
      });

      // And the TASK says so — which is the whole of what did not happen before: code, its
      // fixAction, when, which run, the ref that was not there, and no pin to have failed to
      // contain anything.
      const refusal = await refusalOf(stack.db, dependent);
      assert.ok(refusal, 'the refused start left nothing on the task');
      assert.equal(refusal.code, 'BASE_REF_NOT_FOUND');
      assert.equal(refusal.fixAction, 'FIX_REF');
      assert.equal(refusal.sessionId, sessionId);
      assert.equal(refusal.baseSha, null);
      assert.equal(refusal.ref, `refs/heads/${f.branch}`);
      assert.deepEqual(refusal.missing, []);
      assert.equal(refusal.reason, resolution.stderr);
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
      const refusalNotesForTask = notes.filter(
        (note) => note.body.includes(`orbit:${DISPATCH_REFUSED_SIGNAL_CODE}`),
      );
      assert.equal(refusalNotesForTask.length, 1, 'one refused start, one note');
      assert.ok(refusalNotesForTask[0]!.body.includes(dispatchRefusalNextStep(refusal)));
      assert.ok(refusalNotesForTask[0]!.body.includes(`refs/heads/${f.branch}`),
        'the note does not name the ref that was not there');
      assert.ok(refusalNotesForTask[0]!.body.includes(resolution.stderr));
      assert.ok(!refusalNotesForTask[0]!.body.includes('在检出时'),
        'the note tells the reader the checkout refused this start');
      assert.ok(!notes.some((note) => note.body.includes('可重新运行本任务重试')),
        'the timeline still tells whoever reads it to run the task again');

      // And the coordinator is told: one wake, delivered to the standing conversation, whose one
      // message names the task and says what to do.
      assert.deepEqual(await refusalWakes(stack.db, f.projectId), [{
        subjectType: 'TASK', subjectId: dependent, subjectVersion: sessionId, status: 'DELIVERED',
        refusalCode: null, sessionId: f.coordinatorSessionId,
      }]);
      const messages = await coordinatorMessages(stack.db, f);
      assert.equal(messages.length, 1, 'the coordinator was not sent exactly one message');
      const message = messages[0]!.content ?? '';
      assert.ok(message.includes(uuidToBase62(dependent)), 'the message does not name the task');
      assert.ok(message.includes('BASE_REF_NOT_FOUND'));
      assert.ok(message.includes(`refs/heads/${f.branch}`), 'the message does not name the ref');
      assert.ok(message.includes(dispatchRefusalNextStep(refusal)), 'the message gives no next step');
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), [],
        'a refused start is delivered to the conversation that exists, not judged in a new one');
    } finally {
      release(f);
      await stack.db.$disconnect();
    }
  });

test('(b) a start whose line exists and holds the prerequisite\'s work resolves normally, and leaves no refusal and no delivery',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'admitted-source');
    try {
      // The prerequisite's landing is on the line itself, so the ref exists and carries the commit.
      const p = await prerequisite(stack, f, 'landed-on-the-line', { onto: 'line' });
      const dependent = await dependentOf(stack, f, 'starts-cleanly', p.taskId);

      const sessionId = await start(stack, f, dependent);
      const resolution = await runnerResolvesSource(stack, f, sessionId);
      const tip = git(f.repo, 'rev-parse', `refs/heads/${f.branch}`);

      assert.equal(resolution.resolvedSha, tip, 'the resolution did not read the line\'s tip');
      assert.equal(resolution.response.state, 'PINNED');
      assert.equal(resolution.response.baseSha, tip);
      assert.equal(resolution.response.wonRace, true);
      assert.equal(resolution.response.refusalCode, undefined);
      assert.equal('refused' in resolution.response, false, 'a pin answered with a task to write');
      const run = await stack.db.session.findUniqueOrThrow({
        where: { id: sessionId }, select: { sourceState: true, sourceBaseSha: true, sourceRefusalCode: true },
      });
      assert.equal(run.sourceState, 'PINNED');
      assert.equal(run.sourceBaseSha, tip);
      assert.equal(run.sourceRefusalCode, null);

      // The run ran and ended the ordinary way.
      await stack.api.finalize({ id: f.runnerId }, sessionId, { status: SharedRunStatus.SUCCEEDED });

      assert.equal(await refusalOf(stack.db, dependent), null, 'an admitted start recorded a refusal');
      assert.deepEqual(await refusalNotes(stack.db, dependent), []);
      assert.deepEqual(await refusalWakes(stack.db, f.projectId), []);
      assert.deepEqual(await coordinatorMessages(stack.db, f), [], 'the coordinator was told about a start that ran');
    } finally {
      release(f);
      await stack.db.$disconnect();
    }
  });

test('(c) the same refusal reported twice leaves one fact: a lost compare-and-set records nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'refused-twice', { lineCreated: false });
    try {
      const p = await prerequisite(stack, f, 'never-created-line', { onto: 'line', receiptOnly: true });
      const dependent = await dependentOf(stack, f, 'reports-twice', p.taskId);

      const sessionId = await start(stack, f, dependent);
      const first = await runnerResolvesSource(stack, f, sessionId);
      assert.equal(first.response.refusalCode, 'BASE_REF_NOT_FOUND');
      const recorded = await refusalOf(stack.db, dependent);

      // The runner re-issues the request its response was lost for — same words, same stderr.
      const again = await stack.api.pinSessionSource(
        { id: f.runnerId, ownerId: f.ownerId },
        sessionId,
        {
          refusal: {
            code: 'BASE_REF_NOT_FOUND',
            detail: { ref: first.ref, refAuthority: 'REMOTE', remoteName: 'origin', stderr: first.stderr },
          },
        },
      );
      assert.equal(again.wonRace, false, 'a second report won the compare-and-set again');
      assert.equal(again.state, 'REFUSED');
      assert.equal(again.refusalCode, 'BASE_REF_NOT_FOUND');
      assert.equal('refused' in again, false, 'the loser reported a task to write');

      // One refusal, one note, one wake, one message — the row is the first report's.
      assert.deepEqual(await refusalOf(stack.db, dependent), recorded);
      assert.equal((await refusalNotes(stack.db, dependent)).length, 1);
      assert.equal((await refusalWakes(stack.db, f.projectId)).length, 1);
      assert.equal((await coordinatorMessages(stack.db, f)).length, 1);
    } finally {
      release(f);
      await stack.db.$disconnect();
    }
  });

test('(d) a start whose prerequisite has not landed is still refused the dispatch itself',
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
      release(f);
      await stack.db.$disconnect();
    }
  });

test('a refused resolution under a switched-off coordinator is recorded on the task and wakes nobody',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    const f = await fixture(stack, 'switched-off', { coordinatorEnabled: false, lineCreated: false });
    try {
      const p = await prerequisite(stack, f, 'line-that-never-was', { onto: 'line', receiptOnly: true });
      const dependent = await dependentOf(stack, f, 'refused-off', p.taskId);
      const sessionId = await start(stack, f, dependent);
      const resolution = await runnerResolvesSource(stack, f, sessionId);
      assert.equal(resolution.response.refusalCode, 'BASE_REF_NOT_FOUND');

      // The switch governs who is woken, not whether the task says it could not start.
      const refusal = await refusalOf(stack.db, dependent);
      assert.equal(refusal?.code, 'BASE_REF_NOT_FOUND');
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
      release(f);
      await stack.db.$disconnect();
    }
  });
