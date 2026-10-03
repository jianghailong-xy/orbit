import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatorType, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  ORCHESTRATOR_WORKSPACE_CREATE_FIELDS,
  RunnerAgentsController,
} from '../runner-api/runner-agents.controller';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { SessionsService } from '../sessions/sessions.service';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from '../workspaces/dto';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { TasksService } from './tasks.service';
import {
  TASK_RUN_TRIGGER,
  taskRunDesiredSessionId,
  taskRunRequestKey,
  taskRunResumeTurnId,
} from './task-run-identity';
import { TASK_RUN_ACTION } from './task-run-receipt';

/**
 * P3 of model routing (docs/model-routing-design.md §7.4, §8): with smart selection on, a fresh run
 * is created on what routing chose.
 *
 * Driven through `TasksService.execute` / `batchExecute` on a real PostgreSQL, as the shadow spec is
 * (task-model-routing-shadow.pg.spec.ts), because what is proven lives there: the receipt's frozen
 * target, `task_route_decision`, and the Session `sessions.create` writes. Each fixture's Agent has an
 * effort of its own and a runner reporting Opus and Sonnet, so the routed run and the baseline always
 * differ; its switch is turned on through `WorkspacesService.update`, the user API's door.
 *
 * What is settled here:
 *  - on: a fresh run is created on the routed provider, model and effort (single and bulk), and the
 *    task's own provider / model are never written back;
 *  - a model pinned on the task wins and is not routed; a provider pin only fixes the engine;
 *  - continuing a paused run (RESUME) is not routed again;
 *  - RESUME puts the paused run on the task's pinned model before handing it the prompt. It used to
 *    pass the pin to `resume`, whose live path (`createTurn`) has no model and dropped it. Of the two
 *    ways to fix that, this one moves the run with `sessions.updateConfig` and then delivers; the other
 *    — not resuming and starting a fresh run — would have to stop the paused run first, which still
 *    holds the task's execution claim;
 *  - the switch is the owner's: the user API writes it, and the agent tools (`agent_create` /
 *    `agent_update`, through RunnerAgentsController) cannot.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
/** The Agent's own effort, which no tier below XL picks: what a run that is not routed gets. */
const AGENT_EFFORT = 'max';

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  sessions: SessionsService;
  workspaces: WorkspacesService;
}

/** Publishes nothing: every realtime call is a no-op. */
const quiet = () => new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

/** A whole service stack over its own pool, as each delivery of a request has. */
function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = quiet();
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return {
    db,
    sessions,
    tasks: new TasksService(prisma, sessions, publishes),
    workspaces: new WorkspacesService(prisma),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
  taskIds: string[];
}

type TaskSeed = { provider?: string | null; model?: string | null; modelHint?: string | null };

/** An Agent with smart selection on — unless `routing` says otherwise — and its tasks. */
async function fixture(
  services: Services,
  label: string,
  tasks: TaskSeed[] = [{}],
  routing = true,
): Promise<Fixture> {
  const { db } = services;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@routing.invalid`, name: label, passwordHash: 'x' },
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
  if (routing) {
    // The owner's door, and the only one: what `PATCH /workspaces/:id` reaches.
    const turnedOn = await services.workspaces.update(ownerId, agentId, { modelRouting: true });
    assert.equal(turnedOn.modelRouting, true);
  }
  // LEGACY dispatch authority: these presses go through `execute`, not through a Coordinator.
  await db.project.create({ data: { id: projectId, ownerId, title: label, coordinatorEnabled: false } });
  const taskIds: string[] = [];
  for (const [index, seed] of tasks.entries()) {
    const task = await db.task.create({
      data: {
        ownerId, projectId, assigneeId: agentId, title: `${label} ${index + 1}`,
        creatorType: CreatorType.USER, creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
        provider: 'claude', modelHint: 'M', modelHintReason: 'one service plus its spec', ...seed,
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

/** A routed single-run target as a delivery that died after binding it left it. */
function routedTarget(target: Fixture, taskId: string, press: string, route: Record<string, unknown>) {
  return {
    v: 2, kind: 'RUN', plan: { kind: 'CREATE', sessionId: desiredIdFor(taskId, press) },
    taskId, title: 'routed', prompt: 'do it', workspaceId: target.agentId, runnerId: target.runnerId,
    provider: route.provider, model: route.model, effort: route.effort, route,
    projectId: target.projectId, batch: null, dispatchOrigin: 'USER', runSource: 'MANUAL',
    runAt: null, clearFailed: false, auto: false,
  };
}

const decisionsOf = (db: PrismaClient, taskId: string) =>
  db.taskRouteDecision.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });

/** The route snapshot a target froze, as the row recording it reads. */
const snapshotOf = (row: Awaited<ReturnType<typeof decisionsOf>>[number]) => ({
  policyVersion: row.policyVersion, applied: row.applied, level: row.level, provider: row.provider,
  model: row.model, effort: row.effort, baseline: row.baseline, features: row.features,
  reasons: row.reasons,
});

/** What a run actually is: the three values routing decides. */
const sessionOf = (db: PrismaClient, id: string) => db.session.findUniqueOrThrow({
  where: { id }, select: { provider: true, model: true, effort: true },
});

const dispatchedBy = (target: { provider: unknown; model: unknown; effort: unknown }) =>
  ({ provider: target.provider, model: target.model, effort: target.effort });

const turnsOf = (db: PrismaClient, sessionId: string) => db.conversationTurn.findMany({
  where: { sessionId }, orderBy: { seq: 'asc' }, select: { kind: true, content: true, clientTurnId: true, seq: true },
});

/** A run that was claimed, did a turn, and is now parked with nothing to wake it. */
async function pause(db: PrismaClient, sessionId: string) {
  await db.session.update({
    where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT, numTurns: 1 },
  });
}

test('smart selection on: a fresh run is created on the routed model and effort, and the task keeps its pins',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services, 'applied');
      const [taskId] = target.taskIds;
      const press = randomUUID();

      const sessionId = await runNow(services, target, taskId, press);

      assert.equal(sessionId, desiredIdFor(taskId, press));
      const [row, ...more] = await decisionsOf(services.db, taskId);
      assert.equal(more.length, 0, 'one fresh run, one decision');
      assert.deepEqual(
        { applied: row.applied, level: row.level, provider: row.provider, model: row.model, effort: row.effort },
        { applied: true, level: 'M', provider: 'claude', model: SONNET, effort: 'medium' },
      );
      assert.equal((row.features as Record<string, unknown>).modelRouting, true);
      // The baseline is still recorded as what would have run without routing.
      assert.deepEqual(row.baseline, {
        provider: 'claude', providerSource: 'task-pin', model: null, runtimeDefaultModel: OPUS,
        effort: AGENT_EFFORT, permissionMode: 'auto',
      });

      // THE RUN IS THE ROUTE: the frozen target names it, and the Session was created on it.
      const bound = await receipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press);
      assert.equal(bound.status, 'COMPLETED');
      assert.deepEqual(dispatchedBy(bound.target), { provider: 'claude', model: SONNET, effort: 'medium' });
      assert.deepEqual(bound.target.route, snapshotOf(row));
      assert.deepEqual(await sessionOf(services.db, sessionId), { provider: 'claude', model: SONNET, effort: 'medium' });

      // Never written back: the task's provider and model are what a person pinned, and nobody did.
      assert.deepEqual(
        await services.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { provider: true, model: true } }),
        { provider: 'claude', model: null },
      );
      const detail = await services.tasks.get(target.ownerId, taskId) as unknown as {
        sessions: Array<{ id: string; route: { applied: boolean; level: string | null } | null }>;
      };
      const summary = detail.sessions.find((s) => s.id === sessionId)?.route;
      assert.deepEqual({ applied: summary?.applied, level: summary?.level }, { applied: true, level: 'M' });

      // Turned off again by the owner: the next fresh run is the baseline, routed in shadow only.
      await services.db.session.update({
        where: { id: sessionId }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
      });
      await services.workspaces.update(target.ownerId, target.agentId, { modelRouting: false });
      const next = await runNow(services, target, taskId, randomUUID());
      assert.deepEqual(await sessionOf(services.db, next), { provider: 'claude', model: null, effort: AGENT_EFFORT });
      const shadow = (await decisionsOf(services.db, taskId)).find((r) => r.sessionId === next)!;
      assert.deepEqual({ applied: shadow.applied, level: shadow.level }, { applied: false, level: 'M' });
    } finally {
      await services.db.$disconnect();
    }
  });

test('a bulk run applies routing per item: a provider pin only fixes the engine, a model pin is never routed',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services, 'bulk', [
        { modelHint: 'S' },
        { provider: null, modelHint: 'L' },
        { modelHint: null },
        { model: OPUS, modelHint: 'S' },
      ]);
      const [enginePinned, unpinned, unsuggested, modelPinned] = target.taskIds;
      const press = randomUUID();

      const answer = await services.tasks.batchExecute(target.ownerId, target.taskIds, undefined, press);

      assert.equal(answer.dispatched, 4, JSON.stringify(answer));
      const bound = await receipt(services.db, target.ownerId, TASK_RUN_ACTION.batchExecute, press);
      const expected = new Map([
        // Pinned to claude, so routed within claude.
        [enginePinned, {
          applied: true, level: 'S', reason: 'Tier S: suggested by the coordinator — one service plus its spec',
          dispatched: { provider: 'claude', model: SONNET, effort: 'low' },
          session: { provider: 'claude', model: SONNET, effort: 'low' },
        }],
        // No pin at all: routed on the Agent's own engine, which the target writes out.
        [unpinned, {
          applied: true, level: 'L', reason: 'Tier L: suggested by the coordinator — one service plus its spec',
          dispatched: { provider: 'claude', model: OPUS, effort: 'high' },
          session: { provider: 'claude', model: OPUS, effort: 'high' },
        }],
        // Nothing to route on: the baseline, with or without the switch.
        [unsuggested, {
          applied: false, level: null, reason: "No suggestion — keeps the agent's model, as today",
          dispatched: { provider: 'claude', model: null, effort: null },
          session: { provider: 'claude', model: null, effort: AGENT_EFFORT },
        }],
        // The pin wins over the suggestion.
        [modelPinned, {
          applied: false, level: null, reason: `Task pin: ${OPUS}`,
          dispatched: { provider: 'claude', model: OPUS, effort: null },
          session: { provider: 'claude', model: OPUS, effort: AGENT_EFFORT },
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
        assert.deepEqual({ applied: row.applied, level: row.level }, { applied: want.applied, level: want.level });
        assert.equal(row.reasons[0], want.reason);
        const item = bound.target.items.find((i: { taskId: string }) => i.taskId === taskId);
        assert.deepEqual(dispatchedBy(item), want.dispatched, `what ${taskId} is dispatched with`);
        assert.deepEqual(item.route, snapshotOf(row));
        assert.deepEqual(await sessionOf(services.db, sessionId!), want.session, `the Session of ${taskId}`);
      }
      const unpinnedRow = (await decisionsOf(services.db, unpinned))[0];
      assert.equal((unpinnedRow.baseline as Record<string, unknown>).providerSource, 'agent-seed');
      // And not one task was written back.
      assert.deepEqual(
        await services.db.task.findMany({
          where: { id: { in: target.taskIds } }, orderBy: { title: 'asc' }, select: { provider: true, model: true },
        }),
        [
          { provider: 'claude', model: null },
          { provider: null, model: null },
          { provider: 'claude', model: null },
          { provider: 'claude', model: OPUS },
        ],
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('a model pinned on the task wins: the run is created on the pin, and the decision says why',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      // XL would route to Opus at max; the pin says Sonnet.
      const target = await fixture(services, 'pin', [{ model: SONNET, modelHint: 'XL' }]);
      const [taskId] = target.taskIds;
      const press = randomUUID();

      const sessionId = await runNow(services, target, taskId, press);

      const [row] = await decisionsOf(services.db, taskId);
      assert.deepEqual(
        { applied: row.applied, level: row.level, model: row.model, reasons: row.reasons },
        { applied: false, level: null, model: SONNET, reasons: [`Task pin: ${SONNET}`] },
      );
      const bound = await receipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press);
      assert.deepEqual(dispatchedBy(bound.target), { provider: 'claude', model: SONNET, effort: null });
      assert.deepEqual(await sessionOf(services.db, sessionId), { provider: 'claude', model: SONNET, effort: AGENT_EFFORT });
    } finally {
      await services.db.$disconnect();
    }
  });

test('continuing a paused run is not routed again, with smart selection on',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services, 'resume', [{ modelHint: 'S' }]);
      const [taskId] = target.taskIds;
      const run = await runNow(services, target, taskId, randomUUID());
      assert.deepEqual(await sessionOf(services.db, run), { provider: 'claude', model: SONNET, effort: 'low' });
      await pause(services.db, run);
      // The suggestion has gone up since: routing afresh would pick Opus at max.
      await services.db.task.update({ where: { id: taskId }, data: { modelHint: 'XL' } });
      const press = randomUUID();

      assert.equal(await runNow(services, target, taskId, press), run, 'the paused run is continued');

      const bound = await receipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press);
      assert.equal(bound.target.plan.kind, 'RESUME');
      assert.equal(bound.target.route, null);
      assert.deepEqual(dispatchedBy(bound.target), { provider: 'claude', model: null, effort: null });
      assert.equal((await decisionsOf(services.db, taskId)).length, 1, 'only the fresh run was decided');
      assert.deepEqual(
        await sessionOf(services.db, run), { provider: 'claude', model: SONNET, effort: 'low' },
        'the run goes on with the model and effort it started with',
      );
      const turns = await turnsOf(services.db, run);
      assert.equal(turns.some((t) => t.kind === 'setconfig' || t.kind === 'reload'), false, 'nothing was reconfigured');
      assert.ok(turns.some((t) => t.clientTurnId === taskRunResumeTurnId(press, run)), 'the prompt was delivered');
    } finally {
      await services.db.$disconnect();
    }
  });

test('continuing a paused run moves it onto the task\'s pinned model first — resume used to drop the pin',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services, 'resume-pin', [{ modelHint: 'S' }, { model: OPUS }]);
      const [repinned, pinnedFromTheStart] = target.taskIds;
      // Run 1 started on Sonnet at low, and the owner has since pinned the task to Opus.
      const run = await runNow(services, target, repinned, randomUUID());
      await pause(services.db, run);
      await services.db.task.update({ where: { id: repinned }, data: { model: OPUS } });
      const press = randomUUID();

      assert.equal(await runNow(services, target, repinned, press), run, 'the paused run is continued');

      assert.deepEqual(
        await sessionOf(services.db, run), { provider: 'claude', model: OPUS, effort: 'low' },
        'the pin is in force on the run that continues, and nothing else moved: it is not routed again',
      );
      const turns = await turnsOf(services.db, run);
      const moves = turns.filter((t) => t.kind === 'setconfig' || t.kind === 'reload');
      assert.equal(moves.length, 1, JSON.stringify(turns));
      assert.equal(moves[0].kind, 'setconfig', 'a resident claude engine is told, as the model picker tells it');
      assert.equal(JSON.parse(moves[0].content!).model, OPUS);
      const prompt = turns.find((t) => t.clientTurnId === taskRunResumeTurnId(press, run));
      assert.ok(prompt, 'the prompt was delivered');
      assert.ok(moves[0].seq < prompt.seq, 'the model moves before the prompt that is to run on it');
      const bound = await receipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press);
      assert.equal(bound.target.plan.kind, 'RESUME');
      assert.equal(bound.target.route, null);
      assert.equal((await decisionsOf(services.db, repinned)).length, 1, 'nothing was routed for it');

      // A repeat of the press is answered from its receipt, and moves nothing a second time.
      assert.equal(await runNow(services, target, repinned, press), run);
      assert.equal(
        (await turnsOf(services.db, run)).filter((t) => t.kind === 'setconfig' || t.kind === 'reload').length, 1,
      );

      // A paused run already on the pinned model is handed the prompt with nothing in front of it.
      const onPin = await runNow(services, target, pinnedFromTheStart, randomUUID());
      assert.equal((await sessionOf(services.db, onPin)).model, OPUS);
      await pause(services.db, onPin);
      const again = randomUUID();
      assert.equal(await runNow(services, target, pinnedFromTheStart, again), onPin);
      const quietTurns = await turnsOf(services.db, onPin);
      assert.equal(quietTurns.some((t) => t.kind === 'setconfig' || t.kind === 'reload'), false);
      assert.ok(quietTurns.some((t) => t.clientTurnId === taskRunResumeTurnId(again, onPin)));
    } finally {
      await services.db.$disconnect();
    }
  });

test('a takeover creates the run on the route that was bound, not on one decided again',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services, 'takeover');
      const [taskId] = target.taskIds;
      const press = randomUUID();
      // Decided at S by a holder that died between binding and creating; the task now says M.
      const route = {
        policyVersion: 1, applied: true, level: 'S', provider: 'claude', model: SONNET, effort: 'low',
        baseline: { provider: 'claude', providerSource: 'task-pin', model: null, effort: AGENT_EFFORT },
        features: { modelHint: 'S', modelRouting: true }, reasons: ['decided by the holder that died'],
      };
      await boundReceipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press, `task:${taskId}`,
        routedTarget(target, taskId, press, route));

      const sessionId = await runNow(services, target, taskId, press);

      assert.equal(sessionId, desiredIdFor(taskId, press));
      assert.deepEqual(await sessionOf(services.db, sessionId), { provider: 'claude', model: SONNET, effort: 'low' });
      const rows = await decisionsOf(services.db, taskId);
      assert.equal(rows.length, 1);
      assert.deepEqual(snapshotOf(rows[0]), route, 'the bound decision, recorded once');
    } finally {
      await services.db.$disconnect();
    }
  });

test('a routed run refused by a run already holding the task names no pin the task does not have',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services, 'holder');
      const [taskId] = target.taskIds;
      // Another run holds the task, on Opus.
      const holder = await runNow(services, target, taskId, randomUUID());
      await services.db.session.update({ where: { id: holder }, data: { model: OPUS } });
      // A press whose delivery bound a routed plan — Sonnet — and died before its Session was written.
      const press = randomUUID();
      await boundReceipt(services.db, target.ownerId, TASK_RUN_ACTION.execute, press, `task:${taskId}`,
        routedTarget(target, taskId, press, {
          policyVersion: 1, applied: true, level: 'M', provider: 'claude', model: SONNET, effort: 'medium',
          baseline: { provider: 'claude', providerSource: 'task-pin', model: null, effort: AGENT_EFFORT },
          features: { modelHint: 'M', modelRouting: true }, reasons: ['decided by the holder that died'],
        }));

      // Sonnet is what routing chose, not a pin: the task is already running, not pinned elsewhere.
      await assert.rejects(
        () => services.tasks.execute(target.ownerId, taskId, undefined, press),
        (error: Error & { response?: { code?: string } }) => error.response?.code === 'TASK_ALREADY_RUNNING',
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('the switch is the owner\'s: the user API turns it on and off, the agent tools cannot touch it',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      // The user API validates with a whitelist (main.ts): a boolean is kept, anything else is refused.
      for (const Dto of [CreateWorkspaceDto, UpdateWorkspaceDto]) {
        const ok = plainToInstance(Dto, { name: 'agent', modelRouting: true });
        assert.deepEqual(await validate(ok, { whitelist: true }), []);
        assert.equal(ok.modelRouting, true, `${Dto.name} keeps it`);
        const refused = await validate(plainToInstance(Dto, { name: 'agent', modelRouting: 'yes' }), { whitelist: true });
        assert.deepEqual(refused.map((error) => error.property), ['modelRouting']);
      }

      const target = await fixture(services, 'switch', [], false);
      const { db, workspaces } = services;
      const routingOf = async (id: string) =>
        (await db.workspace.findUniqueOrThrow({ where: { id }, select: { modelRouting: true } })).modelRouting;

      const ownerMade = await workspaces.create(target.ownerId, {
        name: 'owner-made', runnerId: target.runnerId, modelRouting: true,
      });
      assert.equal(await routingOf(ownerMade.id), true);
      const plain = await workspaces.create(target.ownerId, { name: 'owner-default', runnerId: target.runnerId });
      assert.equal(await routingOf(plain.id), false, 'off unless the owner turns it on');
      await workspaces.update(target.ownerId, ownerMade.id, { description: 'renamed' });
      assert.equal(await routingOf(ownerMade.id), true, 'a patch that says nothing about it leaves it');
      await workspaces.update(target.ownerId, ownerMade.id, { modelRouting: false });
      assert.equal(await routingOf(ownerMade.id), false);

      // The agent tools: MCP `agent_create` / `agent_update` and `orbit agent` reach this controller.
      assert.equal((ORCHESTRATOR_WORKSPACE_CREATE_FIELDS as readonly string[]).includes('modelRouting'), false);
      const runner = await db.runner.findUniqueOrThrow({ where: { id: target.runnerId } });
      const agents = new RunnerAgentsController(
        workspaces,
        { assert: async () => 'orchestrating-session' } as unknown as RunnerOrchestrationAuthorizer,
        quiet(),
      );
      const spawned = await agents.createWorkspace(runner, 'orchestrating-session', 'credential', {
        name: 'agent-made', modelRouting: true,
      });
      assert.equal(await routingOf(spawned.id), false, 'an agent cannot create an Agent with it on');
      await agents.updateWorkspace(runner, 'orchestrating-session', 'credential', spawned.id, { modelRouting: true });
      assert.equal(await routingOf(spawned.id), false, 'nor turn it on');
      await workspaces.update(target.ownerId, target.agentId, { modelRouting: true });
      await agents.updateWorkspace(runner, 'orchestrating-session', 'credential', target.agentId, {
        modelRouting: false, description: 'touched by an agent',
      });
      assert.deepEqual(
        await db.workspace.findUniqueOrThrow({
          where: { id: target.agentId }, select: { modelRouting: true, description: true },
        }),
        { modelRouting: true, description: 'touched by an agent' },
        'nor turn it off: the update went through and left the switch where the owner put it',
      );
    } finally {
      await services.db.$disconnect();
    }
  });
