import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreatorType, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';
import { TASK_RUN_TRIGGER, taskRunDesiredSessionId, taskRunRequestKey } from './task-run-identity';
import { TASK_RUN_ACTION } from './task-run-receipt';

/**
 * P1 of model routing (docs/model-routing-design.md §8): every fresh run is routed IN SHADOW.
 *
 * Driven through `TasksService.execute` / `batchExecute` — the doors Run Now, `task_start`, the
 * sweeps and bulk Run all reach — on a real PostgreSQL, because what is being proven lives in it:
 * the receipt's frozen target, `task_route_decision`'s `UNIQUE (task_id, request_token)`, and the
 * Session `sessions.create` writes. Each fixture's Agent has smart selection off (the default),
 * an effort of its own, and a runner reporting Opus and Sonnet — so a decision that routes always
 * differs from what runs, and "the Session is the baseline" is a claim with something to lose.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
/** The Agent's own effort, which no tier picks below XL: the baseline's, and the Session's. */
const AGENT_EFFORT = 'max';
const HINT_REASON = 'one service plus its spec';

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  sessions: SessionsService;
}

/** A whole service stack over its own pool, as each delivery of a request has. */
function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return { db, sessions, tasks: new TasksService(prisma, sessions, publishes) };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
  taskIds: string[];
}

type TaskSeed = { provider?: string | null; model?: string | null; modelHint?: string | null };

async function fixture(db: PrismaClient, label: string, tasks: TaskSeed[] = [{}]): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  // The account has smart model selection on: these cases are about routing with it on.
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${RUN}-${ownerId}@routing.invalid`, name: label, passwordHash: 'x',
      preferences: { modelRouting: true },
    },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
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
  // LEGACY dispatch authority: these presses go through `execute`, not through a Coordinator.
  await db.project.create({ data: { id: projectId, ownerId, title: label, coordinatorEnabled: false } });
  const taskIds: string[] = [];
  for (const [index, seed] of tasks.entries()) {
    const task = await db.task.create({
      data: {
        ownerId, projectId, assigneeId: agentId, title: `${label} ${index + 1}`,
        creatorType: CreatorType.USER, creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
        provider: 'claude', modelHint: 'M', modelHintReason: HINT_REASON, ...seed,
      },
    });
    taskIds.push(task.id);
  }
  return { ownerId, runnerId, agentId, projectId, taskIds };
}

const desiredIdFor = (taskId: string, requestToken: string) =>
  taskRunDesiredSessionId(taskRunRequestKey({ taskId, requestToken }));

async function runNow(services: Services, target: Fixture, taskId: string, press: string) {
  const result = await services.tasks.execute(target.ownerId, taskId, undefined, press);
  assert.ok(result.sessionId, `Run Now must answer with a Session, got ${JSON.stringify(result)}`);
  return result.sessionId;
}

async function receipt(db: PrismaClient, ownerId: string, kind: string, token: string) {
  const [row] = await db.$queryRaw<Array<{ status: string; target: any }>>`
    SELECT "status", "target" FROM "task_run_request"
     WHERE "owner_id" = ${ownerId}::uuid AND "action_kind" = ${kind} AND "request_token" = ${token}`;
  return row;
}

/** The state a delivery that died after binding leaves: BOUND, unanswered, its lease run out. */
async function rewindToBound(db: PrismaClient, ownerId: string, kind: string, token: string) {
  const rewound = await db.$executeRaw`
    UPDATE "task_run_request"
       SET "status" = 'BOUND', "result" = NULL, "lease_holder" = 'dead-holder',
           "lease_expires_at" = statement_timestamp() - make_interval(secs => 1)
     WHERE "owner_id" = ${ownerId}::uuid AND "action_kind" = ${kind} AND "request_token" = ${token}`;
  assert.equal(rewound, 1, 'the fixture must actually leave a bound receipt');
}

/** A receipt a delivery bound and then died on, written as that delivery wrote it. */
async function boundReceipt(
  db: PrismaClient, ownerId: string, kind: string, token: string, fingerprint: string, target: unknown,
) {
  await db.$executeRaw`
    INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint",
                                    "status", "target", "bound_at", "lease_holder",
                                    "lease_expires_at", "attempt")
    VALUES (${ownerId}::uuid, ${kind}, ${token}, ${fingerprint}, 'BOUND',
            ${JSON.stringify(target)}::jsonb, statement_timestamp(), 'dead-holder',
            statement_timestamp() - make_interval(secs => 1), 1)`;
}

const decisionsOf = (db: PrismaClient, taskId: string) =>
  db.taskRouteDecision.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });

/** The route snapshot a target froze, as the row recording it reads. */
const snapshotOf = (row: Awaited<ReturnType<typeof decisionsOf>>[number]) => ({
  policyVersion: row.policyVersion, applied: row.applied, level: row.level, provider: row.provider,
  model: row.model, effort: row.effort, baseline: row.baseline, features: row.features,
  reasons: row.reasons,
});

/** What the run actually is, against what the decision says it would have been without routing. */
async function assertSessionIsBaseline(
  db: PrismaClient,
  sessionId: string,
  expected: { provider: string; model: string | null; effort: string | null },
  baseline: unknown,
) {
  const session = await db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { provider: true, model: true, effort: true },
  });
  assert.deepEqual(session, expected, 'smart selection is off, so the Session is what it was before routing');
  const recorded = baseline as { provider: string; model: string | null; effort: string | null };
  assert.deepEqual(
    { provider: recorded.provider, model: recorded.model, effort: recorded.effort }, expected,
    'and the decision\'s baseline names exactly the Session that ran',
  );
}

test('a fresh run records one shadow decision, frozen in a v2 target, and runs the baseline',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'single');
      const [taskId] = target.taskIds;
      const press = randomUUID();

      const sessionId = await runNow(services, target, taskId, press);

      assert.equal(sessionId, desiredIdFor(taskId, press));
      const rows = await decisionsOf(services.db, taskId);
      assert.equal(rows.length, 1, 'one fresh run, one decision');
      const [row] = rows;
      assert.equal(row.ownerId, target.ownerId);
      assert.equal(row.requestToken, press, 'keyed by the run request the lease was taken under');
      assert.equal(row.sessionId, sessionId, 'and joined to the Session its plan named');
      // Routing had something to say — tier M is Sonnet at medium — and it was not applied.
      assert.deepEqual(
        { applied: row.applied, policyVersion: row.policyVersion, level: row.level,
          provider: row.provider, model: row.model, effort: row.effort },
        { applied: false, policyVersion: 1, level: 'M', provider: 'claude', model: SONNET, effort: 'medium' },
      );
      assert.equal(row.reasons[0], `Tier M: suggested by the coordinator — ${HINT_REASON}`);
      assert.deepEqual(row.baseline, {
        provider: 'claude', providerSource: 'task-pin', model: null, runtimeDefaultModel: OPUS,
        effort: AGENT_EFFORT, permissionMode: 'auto',
      });
      const features = row.features as Record<string, unknown>;
      assert.equal(features.modelHint, 'M');
      assert.equal(features.modelRouting, false);
      assert.equal(features.priorRuns, 0);
      assert.equal(features.lastRun, null);
      assert.equal(features.escalatedFrom, null);
      assert.equal(features.dependents, 0);
      assert.ok((features.promptChars as number) > 0);

      // THE RUN TARGET IS v2: what is dispatched is the task's own pins and no effort, beside the
      // decision it was planned with.
      const bound = await receipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press);
      assert.equal(bound.status, 'COMPLETED');
      assert.equal(bound.target.v, 2);
      assert.equal(bound.target.kind, 'RUN');
      assert.deepEqual(
        { provider: bound.target.provider, model: bound.target.model, effort: bound.target.effort },
        { provider: 'claude', model: null, effort: null },
      );
      assert.deepEqual(bound.target.route, snapshotOf(row));

      await assertSessionIsBaseline(
        services.db, sessionId, { provider: 'claude', model: null, effort: AGENT_EFFORT }, row.baseline,
      );

      // The same press again is answered from its receipt, and adds nothing.
      assert.equal(await runNow(services, target, taskId, press), sessionId);
      assert.equal((await decisionsOf(services.db, taskId)).length, 1);
    } finally {
      await services.db.$disconnect();
    }
  });

test('a bulk run records one decision per fresh item, under that item\'s own request name',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      // A tier, no suggestion at all, and a model pin: the three answers a decision can give.
      const target = await fixture(services.db, 'bulk', [
        { modelHint: 'S' },
        { modelHint: null },
        { model: OPUS },
      ]);
      const [suggested, unsuggested, pinned] = target.taskIds;
      const press = randomUUID();

      const answer = await services.tasks.batchExecute(target.ownerId, target.taskIds, undefined, press);

      assert.equal(answer.dispatched, 3, JSON.stringify(answer));
      const bound = await receipt(services.db, target.ownerId, TASK_RUN_ACTION.batchExecute, press);
      assert.equal(bound.target.v, 2);
      assert.equal(bound.target.kind, 'BATCH');
      const expected = new Map([
        [suggested, {
          decision: { level: 'S', model: SONNET, effort: 'low' },
          session: { provider: 'claude', model: null, effort: AGENT_EFFORT },
          reason: `Tier S: suggested by the coordinator — ${HINT_REASON}`,
        }],
        [unsuggested, {
          // Not routed: the baseline, whose model is the runtime default the first claim resolves.
          decision: { level: null, model: null, effort: AGENT_EFFORT },
          session: { provider: 'claude', model: null, effort: AGENT_EFFORT },
          reason: "No suggestion — keeps the agent's model, as today",
        }],
        [pinned, {
          decision: { level: null, model: OPUS, effort: AGENT_EFFORT },
          session: { provider: 'claude', model: OPUS, effort: AGENT_EFFORT },
          reason: `Task pin: ${OPUS}`,
        }],
      ]);
      for (const [taskId, want] of expected) {
        const token = TASK_RUN_TRIGGER.batch(press, taskId);
        const sessionId = answer.results.find((r) => r.id === taskId)?.sessionId;
        assert.equal(sessionId, desiredIdFor(taskId, token));
        const rows = await decisionsOf(services.db, taskId);
        assert.equal(rows.length, 1, `one decision for ${taskId}`);
        const [row] = rows;
        assert.equal(row.requestToken, token);
        assert.equal(row.sessionId, sessionId);
        assert.equal(row.applied, false);
        assert.deepEqual({ level: row.level, model: row.model, effort: row.effort }, want.decision);
        assert.equal(row.reasons[0], want.reason);
        const item = bound.target.items.find((i: { taskId: string }) => i.taskId === taskId);
        assert.equal(item.effort, null);
        assert.deepEqual(item.route, snapshotOf(row));
        await assertSessionIsBaseline(services.db, sessionId!, want.session, row.baseline);
      }
    } finally {
      await services.db.$disconnect();
    }
  });

test('a takeover carries out the bound decision instead of routing again, and records it once',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'takeover');
      const [taskId] = target.taskIds;
      const press = randomUUID();
      // Decided at S by a holder that died between binding and recording; the task now says M.
      const route = {
        policyVersion: 1, applied: false, level: 'S', provider: 'claude', model: SONNET, effort: 'low',
        baseline: { provider: 'claude', model: null, effort: AGENT_EFFORT }, features: { modelHint: 'S' },
        reasons: ['decided by the holder that died'],
      };
      await boundReceipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press, `task:${taskId}`, {
        v: 2, kind: 'RUN', plan: { kind: 'CREATE', sessionId: desiredIdFor(taskId, press) },
        taskId, title: 'takeover', prompt: 'do it', workspaceId: target.agentId,
        runnerId: target.runnerId, provider: 'claude', model: null, effort: null, route,
        projectId: target.projectId, batch: null, dispatchOrigin: 'USER', runSource: 'MANUAL',
        runAt: null, clearFailed: false, auto: false,
      });

      const sessionId = await runNow(services, target, taskId, press);

      assert.equal(sessionId, desiredIdFor(taskId, press));
      const [row, ...more] = await decisionsOf(services.db, taskId);
      assert.equal(more.length, 0);
      assert.equal(row.sessionId, sessionId);
      assert.deepEqual(snapshotOf(row), route, 'the frozen decision, not a fresh one');

      // And replayed once more through another takeover, it is the same one row.
      await rewindToBound(services.db, target.ownerId, TASK_RUN_ACTION.execute, press);
      assert.equal(await runNow(services, target, taskId, press), sessionId);
      const again = await decisionsOf(services.db, taskId);
      assert.deepEqual(again.map((r) => r.id), [row.id], 'a replay writes no second decision');
      assert.equal(await services.db.session.count({ where: { taskId } }), 1);
    } finally {
      await services.db.$disconnect();
    }
  });

test('replaying an answered single run or bulk run through a takeover writes no second decision',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'replay', [{}, {}]);
      const [single, other] = target.taskIds;
      const press = randomUUID();
      const sessionId = await runNow(services, target, single, press);
      const [first] = await decisionsOf(services.db, single);

      await rewindToBound(services.db, target.ownerId, TASK_RUN_ACTION.execute, press);
      assert.equal(await runNow(services, target, single, press), sessionId);
      assert.deepEqual((await decisionsOf(services.db, single)).map((r) => r.id), [first.id]);

      // A bulk press over both, after the single run has ended: one fresh item each.
      await services.db.session.update({
        where: { id: sessionId }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
      });
      const bulk = randomUUID();
      const answer = await services.tasks.batchExecute(target.ownerId, target.taskIds, undefined, bulk);
      assert.equal(answer.dispatched, 2, JSON.stringify(answer));
      const written = await services.db.taskRouteDecision.findMany({
        where: { ownerId: target.ownerId }, orderBy: { id: 'asc' },
      });
      assert.equal(written.length, 3);

      await rewindToBound(services.db, target.ownerId, TASK_RUN_ACTION.batchExecute, bulk);
      const replayed = await services.tasks.batchExecute(target.ownerId, target.taskIds, undefined, bulk);
      assert.deepEqual(replayed.results, answer.results, 'the replay answers with the same runs');
      assert.deepEqual(
        (await services.db.taskRouteDecision.findMany({
          where: { ownerId: target.ownerId }, orderBy: { id: 'asc' },
        })).map((r) => r.id),
        written.map((r) => r.id),
        'and adds no decision',
      );
      assert.equal(await services.db.session.count({ where: { taskId: other } }), 1);
    } finally {
      await services.db.$disconnect();
    }
  });

test('a v1 target bound before the upgrade is still carried out, recording nothing; v3 is refused',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'v1', [{}, {}, {}]);
      const [single, bulk, unknown] = target.taskIds;
      const press = randomUUID();
      await boundReceipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press, `task:${single}`, {
        v: 1, kind: 'RUN', plan: { kind: 'CREATE', sessionId: desiredIdFor(single, press) },
        taskId: single, title: 'v1', prompt: 'do it', workspaceId: target.agentId,
        runnerId: target.runnerId, provider: 'claude', model: null, projectId: target.projectId,
        batch: null, dispatchOrigin: 'USER', runSource: 'MANUAL', runAt: null,
        clearFailed: false, auto: false,
      });
      assert.equal(await runNow(services, target, single, press), desiredIdFor(single, press));

      const bulkPress = randomUUID();
      const bulkToken = TASK_RUN_TRIGGER.batch(bulkPress, bulk);
      await boundReceipt(
        services.db, target.ownerId, TASK_RUN_ACTION.batchExecute, bulkPress, `tasks:${bulk}|max:`, {
          v: 1, kind: 'BATCH', batchId: null, maxConcurrent: null, skipped: [],
          runnerIds: [target.runnerId],
          items: [{
            kind: 'CREATE', sessionId: desiredIdFor(bulk, bulkToken), taskId: bulk, title: 'v1 bulk',
            prompt: 'do it', workspaceId: target.agentId, runnerId: target.runnerId,
            provider: 'claude', model: null, runAt: null, clearFailed: false,
            projectId: target.projectId,
          }],
        },
      );
      const answer = await services.tasks.batchExecute(target.ownerId, [bulk], undefined, bulkPress);
      assert.deepEqual(answer.results, [{ id: bulk, ok: true, sessionId: desiredIdFor(bulk, bulkToken) }]);

      assert.equal(await services.db.taskRouteDecision.count({ where: { ownerId: target.ownerId } }), 0,
        'a plan that predates routing decided nothing, so nothing is recorded for it');
      const detail = await services.tasks.get(target.ownerId, single) as unknown as {
        sessions: Array<{ route: unknown }>;
      };
      assert.equal(detail.sessions[0].route, null);

      const futurePress = randomUUID();
      await boundReceipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, futurePress,
        `task:${unknown}`, { v: 3, kind: 'RUN' });
      await assert.rejects(
        () => services.tasks.execute(target.ownerId, unknown, undefined, futurePress),
        (error: Error & { response?: { code?: string } }) =>
          error.response?.code === 'TASK_RUN_REQUEST_UNREADABLE',
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('a press that continues a paused run is not routed', { skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const services = connect();
  try {
    const target = await fixture(services.db, 'resume');
    const [taskId] = target.taskIds;
    const paused = await runNow(services, target, taskId, randomUUID());
    await services.db.session.update({
      where: { id: paused }, data: { status: RunStatus.AWAITING_INPUT },
    });
    const press = randomUUID();

    assert.equal(await runNow(services, target, taskId, press), paused, 'the paused run is continued');

    const bound = await receipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press);
    assert.equal(bound.target.plan.kind, 'RESUME');
    assert.equal(bound.target.route, null);
    assert.equal((await decisionsOf(services.db, taskId)).some((r) => r.requestToken === press), false);
  } finally {
    await services.db.$disconnect();
  }
});

test('earlier work runs feed the decision; task and session details carry each run\'s route',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'history');
      const [taskId] = target.taskIds;
      // Run 1 ran on Sonnet (tier M) and failed; run 2 stopped at a usage limit, which says nothing
      // about the task and is skipped.
      const run1 = await runNow(services, target, taskId, randomUUID());
      await services.db.session.update({
        where: { id: run1 },
        data: { status: RunStatus.FAILED, finishedAt: new Date(), model: SONNET, error: 'the engine exited 1' },
      });
      const run2 = await runNow(services, target, taskId, randomUUID());
      await services.db.session.update({
        where: { id: run2 },
        data: { status: RunStatus.FAILED, finishedAt: new Date(), model: OPUS,
          error: "You've hit your weekly limit · resets 1pm" },
      });
      const run3 = await runNow(services, target, taskId, randomUUID());

      const row = (await decisionsOf(services.db, taskId)).find((r) => r.sessionId === run3)!;
      assert.equal(row.level, 'L', 'one tier above run 1');
      assert.deepEqual({ model: row.model, effort: row.effort, applied: row.applied },
        { model: OPUS, effort: 'high', applied: false });
      const features = row.features as Record<string, unknown>;
      assert.deepEqual(
        { priorRuns: features.priorRuns, priorFailures: features.priorFailures,
          quotaFailuresSkipped: features.quotaFailuresSkipped, escalatedFrom: features.escalatedFrom },
        { priorRuns: 2, priorFailures: 1, quotaFailuresSkipped: 1, escalatedFrom: 'M' },
      );
      assert.deepEqual(features.lastRun, { ordinal: 1, level: 'M', model: SONNET, outcome: 'FAILED' });
      assert.ok(row.reasons.includes('Run 2 hit a usage limit — not counted'), row.reasons.join(' | '));
      await assertSessionIsBaseline(
        services.db, run3, { provider: 'claude', model: null, effort: AGENT_EFFORT }, row.baseline,
      );

      const summary = {
        level: 'L', provider: 'claude', model: OPUS, effort: 'high', applied: false, escalated: true,
        reasons: row.reasons, policyVersion: 1, decidedAt: row.createdAt,
      };
      const detail = await services.tasks.get(target.ownerId, taskId) as unknown as {
        sessions: Array<{ id: string; route: Record<string, unknown> | null }>;
        modelHintOptions: unknown;
      };
      assert.deepEqual(detail.sessions.find((s) => s.id === run3)?.route, summary);
      assert.equal(detail.sessions.find((s) => s.id === run1)?.route?.level, 'M');
      assert.equal(detail.sessions.find((s) => s.id === run1)?.route?.escalated, false);
      const session = await services.sessions.get(target.ownerId, run3) as unknown as { route: unknown };
      assert.deepEqual(session.route, summary);
      // The Suggested picker, resolved on the Agent's runner from the router's own tier table.
      assert.deepEqual(detail.modelHintOptions, [
        { level: 'S', provider: 'claude', model: SONNET, label: 'Sonnet 5.5', effort: 'low' },
        { level: 'M', provider: 'claude', model: SONNET, label: 'Sonnet 5.5', effort: 'medium' },
        { level: 'L', provider: 'claude', model: OPUS, label: 'Opus 5.5', effort: 'high' },
        { level: 'XL', provider: 'claude', model: OPUS, label: 'Opus 5.5', effort: 'max' },
      ]);
    } finally {
      await services.db.$disconnect();
    }
  });
