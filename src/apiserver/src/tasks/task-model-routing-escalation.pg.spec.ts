import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  TaskStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { executableAcceptanceFailureReason } from './executable-acceptance-round';
import { AUTO_RUN_RETRY_BACKOFF_MS } from './task-retry-policy';
import { TASK_RUN_TRIGGER } from './task-run-identity';
import { TasksService } from './tasks.service';

/**
 * P3 of model routing (docs/model-routing-design.md §3.3): after a run that failed for anything but
 * a usage limit, the next fresh run is one tier up, to XL at most.
 *
 * The router's rules are unit-tested (model-routing.spec.ts). What is proven here is the history a
 * dispatch hands it, read off a real PostgreSQL: the task's work runs, newest first; the tier each
 * one's Route Decision named, found by `session_id`, else the model family the run used; how each
 * run ended, read as `autoRunHoldOff` reads it — a usage-limit error says nothing about the task —
 * with the acceptance round's `acceptance command exited N; expected M` told apart; and a verifier's
 * FAIL or the owner's SEND_BACK, counted against the run they followed.
 *
 * Driven through the doors that start a fresh run — Run Now / `task_start` (`execute`), a bulk Run
 * (`batchExecute`) and the sweep's automatic re-run — each a new run request, so each is routed.
 * Each fixture's Agent has smart selection on unless a case says otherwise, so a decided tier is the
 * model and effort its Session is created on.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
/** The Agent's own effort: what a run that is not routed gets. */
const AGENT_EFFORT = 'max';
const HINT_REASON = 'one service plus its spec';
/** Every task here is pinned to claude, so every decision ends its tier reasons with this. */
const ENGINE = 'Engine claude: pinned on the task';
/** An ordinary failure: the engine died, nothing about a quota. */
const CRASH = 'the engine exited 1';
/** Claude Code's refusals once a window is spent: two of the usage-limit markers. */
const SESSION_LIMIT = "You've hit your session limit · resets 6:20pm (Europe/Berlin)";
const WEEKLY_LIMIT = "You've hit your weekly limit · resets 1pm (Europe/Berlin)";

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  workspaces: WorkspacesService;
}

/** A whole service stack over its own pool, publishing nothing. */
function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return {
    db,
    tasks: new TasksService(prisma, sessions, publishes),
    workspaces: new WorkspacesService(prisma),
  };
}

interface Fixture {
  label: string;
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
}

/**
 * An owner, a runner reporting Opus and Sonnet, and its Agent — smart selection on unless `routing`
 * says otherwise, turned on through the user API as the owner turns it on. The project has no
 * coordinator; `started` makes it one the sweep starts tasks in.
 */
async function fixture(
  services: Services,
  label: string,
  { routing = true, started = false }: { routing?: boolean; started?: boolean } = {},
): Promise<Fixture> {
  const { db } = services;
  const target = {
    label,
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    agentId: randomUUID(),
    projectId: randomUUID(),
  };
  const { ownerId, runnerId, agentId, projectId } = target;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@routing.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 10,
      modelCatalog: {
        claude: [
          { value: OPUS, label: 'Opus 5.5', priority: 0, permissionModes: ['default', 'auto'] },
          { value: SONNET, label: 'Sonnet 5.5', priority: 2, permissionModes: ['default', 'auto'] },
        ],
      },
      runtimeDefaultModels: { claude: OPUS },
    },
  });
  await db.workspace.create({
    data: { id: agentId, ownerId, runnerId, name: `${label}-agent`, enabled: true, effort: AGENT_EFFORT },
  });
  if (routing) await services.workspaces.update(ownerId, agentId, { modelRouting: true });
  // LEGACY dispatch authority: no coordinator.
  await db.project.create({
    data: {
      id: projectId, ownerId, title: label, coordinatorEnabled: false, maxConcurrentTasks: 10,
      startedAt: started ? new Date() : null,
    },
  });
  if (started) await establishProjectContractForPgTest(db, ownerId, projectId, label);
  return target;
}

/** A task of the fixture's, pinned to claude with the coordinator's suggestion of M unless `seed` says otherwise. */
async function taskIn(db: PrismaClient, target: Fixture, seed: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
  const task = await db.task.create({
    data: {
      ownerId: target.ownerId, projectId: target.projectId, assigneeId: target.agentId,
      title: `${target.label} task`, creatorType: CreatorType.USER, creatorId: target.ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT', provider: 'claude', modelHint: 'M',
      modelHintReason: HINT_REASON, ...seed,
    },
  });
  return task.id;
}

/** One press of Run Now: a new run request. */
async function runNow(services: Services, target: Fixture, taskId: string): Promise<string> {
  const result = await services.tasks.execute(target.ownerId, taskId, undefined, randomUUID());
  assert.ok(result.sessionId, `Run Now must answer with a Session, got ${JSON.stringify(result)}`);
  return result.sessionId;
}

/**
 * The run ends as the runner's /finalize leaves it. `model` is what its first claim resolved, for a
 * run created with none (a baseline run names no model; the claim gives it the runtime default).
 */
async function end(
  db: PrismaClient,
  sessionId: string,
  status: RunStatus,
  data: { error?: string | null; model?: string } = {},
) {
  await db.session.update({ where: { id: sessionId }, data: { status, finishedAt: new Date(), ...data } });
}

const decisionOf = (db: PrismaClient, sessionId: string) =>
  db.taskRouteDecision.findFirstOrThrow({ where: { sessionId } });

/** What a decision chose, and what it read of the run before it. */
function routed(row: Awaited<ReturnType<typeof decisionOf>>) {
  const features = row.features as Record<string, unknown>;
  return {
    level: row.level, applied: row.applied, model: row.model, effort: row.effort,
    lastRun: features.lastRun, escalatedFrom: features.escalatedFrom,
  };
}

/** What a run actually is: the three values routing decides. */
const sessionOf = (db: PrismaClient, id: string) => db.session.findUniqueOrThrow({
  where: { id }, select: { provider: true, model: true, effort: true },
});

/** Whether the task's detail marks this run with the ↑ of an escalated tier. */
async function escalatedMark(services: Services, target: Fixture, taskId: string, sessionId: string) {
  const detail = await services.tasks.get(target.ownerId, taskId) as unknown as {
    sessions: Array<{ id: string; route: { escalated: boolean } | null }>;
  };
  return detail.sessions.find((s) => s.id === sessionId)?.route?.escalated;
}

/** The owner sends back the evidence a run submitted, as the evidence-decision door records it. */
async function sendBack(db: PrismaClient, target: Fixture, taskId: string, sessionId: string) {
  const evidence = await db.taskCompletionEvidence.create({
    data: {
      taskId, ownerId: target.ownerId, actorType: CreatorType.AGENT, actorId: target.agentId,
      sourceSessionId: sessionId, criterionRevision: 'a'.repeat(64), criterion: {}, evidence: {},
      evidenceDigest: 'b'.repeat(64), revision: 1n,
    },
  });
  await db.taskEvidenceDecision.create({
    data: {
      ownerId: target.ownerId, taskId, evidenceId: evidence.id,
      criterionRevision: evidence.criterionRevision, evidenceDigest: evidence.evidenceDigest,
      decision: 'SEND_BACK', note: 'the empty input is not handled',
      decidedByType: CreatorType.USER, decidedById: target.ownerId, decidingSessionId: randomUUID(),
    },
  });
}

test('a run that failed its acceptance command is followed by a fresh run one tier up, on that tier\'s model',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services, 'acceptance');
      const taskId = await taskIn(services.db, target, {
        completionCriterion: 'EXECUTABLE', acceptanceCommand: 'npm test', acceptanceExpectedExitCode: 0,
      });
      const run1 = await runNow(services, target, taskId);
      assert.deepEqual(await sessionOf(services.db, run1), { provider: 'claude', model: SONNET, effort: 'medium' });
      // The acceptance round disagreed: the Session ends FAILED naming both codes, and the task FAILED.
      await end(services.db, run1, RunStatus.FAILED, { error: executableAcceptanceFailureReason(1, 0) });
      await services.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.FAILED } });

      const run2 = await runNow(services, target, taskId);

      const row = await decisionOf(services.db, run2);
      assert.deepEqual(routed(row), {
        level: 'L', applied: true, model: OPUS, effort: 'high',
        lastRun: { ordinal: 1, level: 'M', model: SONNET, outcome: 'ACCEPTANCE_FAILED' },
        escalatedFrom: 'M',
      });
      assert.deepEqual(row.reasons, ['Tier L — raised after run 1 (M) failed its acceptance command', ENGINE]);
      assert.deepEqual(await sessionOf(services.db, run2), { provider: 'claude', model: OPUS, effort: 'high' });
      assert.equal(await escalatedMark(services, target, taskId, run2), true);
      assert.deepEqual(
        await services.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { provider: true, model: true } }),
        { provider: 'claude', model: null },
        'the route is never written back onto the task',
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('a verifier\'s FAIL and the owner\'s SEND_BACK each count against the run they followed, and only that run',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'judged');
      const taskId = await taskIn(db, target, { modelHint: 'S' });
      const run1 = await runNow(services, target, taskId);
      await end(db, run1, RunStatus.SUCCEEDED);
      // A check of run 1's work concluded FAIL.
      await db.task.create({
        data: {
          ownerId: target.ownerId, projectId: target.projectId, assigneeId: target.agentId, title: 'verify',
          creatorType: CreatorType.USER, creatorId: target.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
          verifiesTaskId: taskId, verdict: 'FAIL', status: TaskStatus.DONE,
        },
      });

      const run2 = await runNow(services, target, taskId);

      let row = await decisionOf(db, run2);
      assert.deepEqual(routed(row), {
        level: 'M', applied: true, model: SONNET, effort: 'medium',
        lastRun: { ordinal: 1, level: 'S', model: SONNET, outcome: 'VERIFICATION_FAILED' },
        escalatedFrom: 'S',
      });
      assert.deepEqual(row.reasons, ['Tier M — raised after run 1 (S) was failed by its verifier', ENGINE]);

      // Run 2 finishes and submits its work; the owner sends it back.
      await end(db, run2, RunStatus.SUCCEEDED);
      await sendBack(db, target, taskId, run2);
      // A bulk Run this time: each item is routed on the same history (§8.2).
      const press = randomUUID();
      const answer = await services.tasks.batchExecute(target.ownerId, [taskId], undefined, press);
      const run3 = answer.results.find((r) => r.id === taskId)?.sessionId;
      assert.ok(run3, JSON.stringify(answer));

      row = await decisionOf(db, run3);
      assert.equal(row.requestToken, TASK_RUN_TRIGGER.batch(press, taskId));
      assert.deepEqual(routed(row), {
        level: 'L', applied: true, model: OPUS, effort: 'high',
        lastRun: { ordinal: 2, level: 'M', model: SONNET, outcome: 'SENT_BACK' },
        escalatedFrom: 'M',
      });
      assert.deepEqual(row.reasons, ['Tier L — raised after run 2 (M) was sent back by the owner', ENGINE]);
      assert.equal((row.features as Record<string, unknown>).priorFailures, 2,
        'run 1 failed by its verifier and run 2 sent back, each once');
      assert.deepEqual(await sessionOf(db, run3), { provider: 'claude', model: OPUS, effort: 'high' });

      // Run 3 ends with nothing said against it. The FAIL and the SEND_BACK are still on record, and
      // neither is about run 3: the next run is the suggestion again.
      await end(db, run3, RunStatus.SUCCEEDED);
      const run4 = await runNow(services, target, taskId);

      row = await decisionOf(db, run4);
      assert.deepEqual(routed(row), {
        level: 'S', applied: true, model: SONNET, effort: 'low',
        lastRun: { ordinal: 3, level: 'L', model: OPUS, outcome: 'OK' },
        escalatedFrom: null,
      });
      assert.deepEqual(row.reasons, [`Tier S: suggested by the coordinator — ${HINT_REASON}`, ENGINE]);
      assert.equal((row.features as Record<string, unknown>).priorFailures, 2);
    } finally {
      await services.db.$disconnect();
    }
  });

test('a usage-limit failure is not counted: it neither raises the tier nor breaks the chain before it',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'quota');
      const taskId = await taskIn(db, target);
      const run1 = await runNow(services, target, taskId);
      await end(db, run1, RunStatus.FAILED, { error: SESSION_LIMIT });

      // Run 1 only hit a usage limit: run 2 is the suggestion, M.
      const run2 = await runNow(services, target, taskId);

      let row = await decisionOf(db, run2);
      assert.deepEqual(routed(row), {
        level: 'M', applied: true, model: SONNET, effort: 'medium', lastRun: null, escalatedFrom: null,
      });
      assert.deepEqual(row.reasons, [
        `Tier M: suggested by the coordinator — ${HINT_REASON}`, 'Run 1 hit a usage limit — not counted', ENGINE,
      ]);

      // M fails with no error text — the runner's /finalize when the engine died silently. That counts,
      // as it does for autoRunHoldOff: run 3 is L.
      await end(db, run2, RunStatus.FAILED, { error: null });
      const run3 = await runNow(services, target, taskId);
      assert.equal((await decisionOf(db, run3)).level, 'L');

      // L stops at a usage limit: run 4 is still L — not XL, and not back to the suggested M.
      await end(db, run3, RunStatus.FAILED, { error: WEEKLY_LIMIT });
      const run4 = await runNow(services, target, taskId);

      row = await decisionOf(db, run4);
      assert.deepEqual(routed(row), {
        level: 'L', applied: true, model: OPUS, effort: 'high',
        lastRun: { ordinal: 2, level: 'M', model: SONNET, outcome: 'FAILED' },
        escalatedFrom: 'M',
      });
      assert.deepEqual(row.reasons, [
        'Tier L — raised after run 2 (M) failed', 'Run 3 hit a usage limit — not counted', ENGINE,
      ]);
      const features = row.features as Record<string, unknown>;
      assert.deepEqual(
        { priorRuns: features.priorRuns, priorFailures: features.priorFailures,
          quotaFailuresSkipped: features.quotaFailuresSkipped },
        { priorRuns: 3, priorFailures: 1, quotaFailuresSkipped: 1 },
      );
      assert.deepEqual(await sessionOf(db, run4), { provider: 'claude', model: OPUS, effort: 'high' });
    } finally {
      await services.db.$disconnect();
    }
  });

test('the tier is one above the last run\'s or the suggestion, whichever is higher, and stops at XL',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'ceiling');
      const taskId = await taskIn(db, target, { modelHint: 'S' });
      const run1 = await runNow(services, target, taskId);
      await end(db, run1, RunStatus.FAILED, { error: CRASH });
      const run2 = await runNow(services, target, taskId);
      assert.equal((await decisionOf(db, run2)).level, 'M');

      // The coordinator has since suggested XL, above the one-up L.
      await db.task.update({
        where: { id: taskId }, data: { modelHint: 'XL', modelHintReason: 'a redesign, not a fix' },
      });
      await end(db, run2, RunStatus.FAILED, { error: CRASH });
      const run3 = await runNow(services, target, taskId);

      let row = await decisionOf(db, run3);
      assert.deepEqual(routed(row), {
        level: 'XL', applied: true, model: OPUS, effort: 'max',
        lastRun: { ordinal: 2, level: 'M', model: SONNET, outcome: 'FAILED' },
        escalatedFrom: 'M',
      });
      assert.deepEqual(row.reasons, [
        'Tier XL — raised after run 2 (M) failed', 'Coordinator suggested tier XL: a redesign, not a fix', ENGINE,
      ]);

      // XL fails too: XL is as high as it goes, so the next run stays there, without the ↑.
      await end(db, run3, RunStatus.FAILED, { error: CRASH });
      const run4 = await runNow(services, target, taskId);

      row = await decisionOf(db, run4);
      assert.deepEqual(routed(row), {
        level: 'XL', applied: true, model: OPUS, effort: 'max',
        lastRun: { ordinal: 3, level: 'XL', model: OPUS, outcome: 'FAILED' },
        escalatedFrom: null,
      });
      assert.deepEqual(row.reasons, ['Tier XL — already the highest tier after run 3 (XL) failed', ENGINE]);
      assert.deepEqual(await sessionOf(db, run4), { provider: 'claude', model: OPUS, effort: 'max' });
      assert.equal(await escalatedMark(services, target, taskId, run4), false);
    } finally {
      await services.db.$disconnect();
    }
  });

test('a task with no suggestion still escalates; with no tier on record, the model family its run used decides',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'unsuggested');
      const unsuggested = { modelHint: null, modelHintReason: null };

      // Run 1 predates routing — it has no decision — and ran on the runtime default, Opus.
      const legacy = await taskIn(db, target, unsuggested);
      const legacyRun = await runNow(services, target, legacy);
      assert.equal((await decisionOf(db, legacyRun)).level, null, 'no suggestion, nothing failed: not routed');
      await db.taskRouteDecision.deleteMany({ where: { sessionId: legacyRun } });
      await end(db, legacyRun, RunStatus.FAILED, { error: CRASH, model: OPUS });

      const afterLegacy = await runNow(services, target, legacy);

      let row = await decisionOf(db, afterLegacy);
      assert.deepEqual(routed(row), {
        level: 'XL', applied: true, model: OPUS, effort: 'max',
        lastRun: { ordinal: 1, level: 'L', model: OPUS, outcome: 'FAILED' },
        escalatedFrom: 'L',
      });
      assert.deepEqual(row.reasons, [
        'Tier XL — raised after run 1 (L) failed', `Run 1 used Opus 5.5 · ${AGENT_EFFORT}, which counts as tier L`, ENGINE,
      ]);
      assert.deepEqual(await sessionOf(db, afterLegacy), { provider: 'claude', model: OPUS, effort: 'max' });

      // Run 1 ran on a Sonnet pin the owner has since taken off: its decision named no tier.
      const unpinned = await taskIn(db, target, { ...unsuggested, model: SONNET });
      const pinnedRun = await runNow(services, target, unpinned);
      assert.deepEqual((await decisionOf(db, pinnedRun)).reasons, [`Task pin: ${SONNET}`]);
      await end(db, pinnedRun, RunStatus.FAILED, { error: CRASH });
      await db.task.update({ where: { id: unpinned }, data: { model: null } });

      const afterPin = await runNow(services, target, unpinned);

      row = await decisionOf(db, afterPin);
      assert.deepEqual(routed(row), {
        level: 'L', applied: true, model: OPUS, effort: 'high',
        lastRun: { ordinal: 1, level: 'M', model: SONNET, outcome: 'FAILED' },
        escalatedFrom: 'M',
      });
      assert.deepEqual(row.reasons, [
        'Tier L — raised after run 1 (M) failed', `Run 1 used Sonnet 5.5 · ${AGENT_EFFORT}, which counts as tier M`, ENGINE,
      ]);
      assert.deepEqual(await sessionOf(db, afterPin), { provider: 'claude', model: OPUS, effort: 'high' });
    } finally {
      await services.db.$disconnect();
    }
  });

test('the last tier is the one its decision named, a shadow one included, not the model the run happened to use',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'shadow', { routing: false });
      const taskId = await taskIn(db, target);
      // Smart selection is off: run 1 was decided at M in shadow and ran the baseline, which its first
      // claim resolved to the runtime default, Opus — tier L by its family.
      const run1 = await runNow(services, target, taskId);
      assert.deepEqual(await sessionOf(db, run1), { provider: 'claude', model: null, effort: AGENT_EFFORT });
      await end(db, run1, RunStatus.FAILED, { error: CRASH, model: OPUS });

      const run2 = await runNow(services, target, taskId);

      const row = await decisionOf(db, run2);
      assert.deepEqual(routed(row), {
        level: 'L', applied: false, model: OPUS, effort: 'high',
        lastRun: { ordinal: 1, level: 'M', model: OPUS, outcome: 'FAILED' },
        escalatedFrom: 'M',
      });
      assert.deepEqual(row.reasons, ['Tier L — raised after run 1 (M) failed', ENGINE], 'one above M, not above Opus\'s L');
      assert.deepEqual(await sessionOf(db, run2), { provider: 'claude', model: null, effort: AGENT_EFFORT },
        'and in shadow the run is still the baseline');
    } finally {
      await services.db.$disconnect();
    }
  });

test('an automatic re-run is a fresh run too: the sweep starts it one tier up',
  { skip, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    // The instant the sweep's failure backoff is measured against.
    const clock = { now: new Date() };
    (services.tasks as unknown as { now: () => Date }).now = () => clock.now;
    const sweep = () =>
      (services.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();
    const epochOf = async (taskId: string) => {
      const [row] = await services.db.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT "epoch" FROM "task_dispatch_epoch" WHERE "task_id" = ${taskId}::uuid`;
      return row.epoch;
    };
    const workRuns = (taskId: string) => services.db.session.findMany({
      where: { taskId, startsTaskWork: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, createdAt: true },
    });
    try {
      const { db } = services;
      const target = await fixture(services, 'rerun', { started: true });
      // READY on a finished prerequisite, so the sweep starts it with nobody pressing anything.
      const prerequisite = await taskIn(db, target, { status: TaskStatus.DONE, autoRunWhenReady: false });
      const taskId = await taskIn(db, target, { autoRunWhenReady: true });
      await db.taskDependency.create({ data: { taskId, dependsOnTaskId: prerequisite } });

      await sweep();
      const [run1] = await workRuns(taskId);
      assert.ok(run1, 'the sweep did not start the task');
      const moment = await epochOf(taskId);
      const first = await decisionOf(db, run1.id);
      assert.equal(first.requestToken, TASK_RUN_TRIGGER.dependency(taskId, moment));
      assert.deepEqual({ level: first.level, applied: first.applied }, { level: 'M', applied: true });
      await end(db, run1.id, RunStatus.FAILED, { error: CRASH });

      // Past the first failure's backoff the sweep re-arms the task and starts it again, at a new moment.
      clock.now = new Date(run1.createdAt.getTime() + AUTO_RUN_RETRY_BACKOFF_MS[0] + 1_000);
      await sweep();
      const runs = await workRuns(taskId);
      assert.equal(runs.length, 2, 'the sweep did not re-run the task');
      const run2 = runs[1].id;

      const row = await decisionOf(db, run2);
      assert.equal(row.requestToken, TASK_RUN_TRIGGER.dependency(taskId, moment + 1n));
      assert.deepEqual(routed(row), {
        level: 'L', applied: true, model: OPUS, effort: 'high',
        lastRun: { ordinal: 1, level: 'M', model: SONNET, outcome: 'FAILED' },
        escalatedFrom: 'M',
      });
      assert.deepEqual(row.reasons, ['Tier L — raised after run 1 (M) failed', ENGINE]);
      assert.deepEqual(await sessionOf(db, run2), { provider: 'claude', model: OPUS, effort: 'high' });
    } finally {
      await services.db.$disconnect();
    }
  });
