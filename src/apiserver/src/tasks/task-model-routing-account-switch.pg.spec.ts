import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatorType, Prisma, PrismaClient, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';

import { modelRoutingEnabled } from '../common/model-routing-switch';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { buildCoordinatorDeliveryContextKey, coordinatorOpeningIsCurrent } from '../projects/coordinator-opening';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { ProjectsService } from '../projects/projects.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController, SESSION_CLAUDE_COORDINATOR_CONTEXT_V1 } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { UpdatePreferencesDto } from '../users/dto';
import { UsersController } from '../users/users.controller';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { TasksService } from './tasks.service';
import { TASK_RUN_TRIGGER } from './task-run-identity';
import { TASK_RUN_ACTION } from './task-run-receipt';

/**
 * The account's smart model selection (Settings, `user.preferences.modelRouting`) is the master
 * switch over model routing (common/model-routing-switch.ts).
 *
 * Off — the default, an account that never touched it — and routing is as if it did not exist: a
 * fresh run, single or bulk, records no Route Decision, its frozen target routes nothing, and its
 * Session is what it was before routing (the task's pins, the runtime default, the Agent's effort),
 * whatever tier the task suggests and whatever its Agent's own switch says; the sweep's quota gate
 * judges the engine the run's pins give it, and plans no route to find out; a coordinator's standing
 * instructions say nothing about suggesting a tier. On, and everything is as before: a shadow
 * decision when the Agent's switch is off, a routed run when it is on, the gate judging the routed
 * engine, the coordinator asked for a tier. Flipping it is read by every door at once — the opening
 * a coordinator is created with, the check that the opening is still current, and the delivery key
 * that re-sends the instructions on the coordinator's next turn.
 *
 * On a real PostgreSQL, through the doors that start a run (`TasksService.execute` /
 * `batchExecute`, the sweep `reconcileReadyTasks`), the one that opens a coordinator
 * (`ProjectsService.coordinator`) and the runner's inbox and turn completion (RunnerApiController),
 * with the switch written either straight onto the account row or through the owner's own door,
 * `UsersController.updatePreferences` (`PATCH /users/me/preferences`). Each Agent has an effort of
 * its own and a runner reporting Opus and Sonnet (and Codex), so a route always differs from the
 * baseline and "the Session is the baseline" is a claim with something to lose.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const CODEX = 'gpt-5.5-codex';
/** The Agent's own effort, which no tier below XL picks: what a run that is not routed gets. */
const AGENT_EFFORT = 'max';
const HINT_REASON = 'one service plus its spec';
const TIER_M = `Tier M: suggested by the coordinator — ${HINT_REASON}`;
const MOVED_OFF_SPENT_CLAUDE = 'Engine codex: claude is at 100% of its weekly quota';
const WEEKLY_LIMIT = "You've hit your weekly limit · resets 1pm (Europe/Berlin)";
/** Three days out: a window that stays in force for the whole spec. */
const RESETS = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
const WEEK_MINS = 7 * 24 * 60;
/** What each tier routes a claude run to (the router's tier table on this runner's catalogue). */
const TIERS: Record<string, { model: string; effort: string }> = {
  S: { model: SONNET, effort: 'low' },
  M: { model: SONNET, effort: 'medium' },
  L: { model: OPUS, effort: 'high' },
  XL: { model: OPUS, effort: 'max' },
};
/** A claude-pinned task's run with no routing: the pin, the runtime default the claim resolves
 *  (model null), and the Agent's effort — what the shadow decision records as its baseline. */
const UNROUTED = { provider: 'claude', model: null, effort: AGENT_EFFORT };
const BASELINE = {
  provider: 'claude', providerSource: 'task-pin', model: null, runtimeDefaultModel: OPUS,
  effort: AGENT_EFFORT, permissionMode: 'auto',
};
/** The coordinator paragraph that asks for a tier, by its first words and its last sentence. */
const HINT_HEAD = '给你创建的每个任务填 modelHint';
const HINT_TAIL = '引擎仍用 provider 字段指定。';
const CONTEXT_TAG = '<orbit_project_coordinator_context>';

/** Publishes nothing: every realtime / queue call is a no-op. */
const quiet = <T>() => new Proxy({}, { get: () => () => undefined }) as unknown as T;

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  workspaces: WorkspacesService;
  projects: ProjectsService;
  users: UsersController;
  api: RunnerApiController;
}

/** A whole service stack over its own pool. */
function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = quiet<RealtimeService>();
  const queue = quiet<QueueService>();
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    tasks: new TasksService(prisma, sessions, realtime),
    workspaces: new WorkspacesService(prisma),
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma), sessions),
    users: new UsersController(prisma),
    // The runner's inbox and turn completion. The messages here carry no `#`-references and reach
    // no list console; every other port answers as a no-op.
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      quiet(),
      {} as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

/** The runner's quota: Claude's weekly window and Codex's weekly one, at these shares. */
const quota = (claude: number, codex = 10) => ({
  claude: { sevenDay: { utilization: claude, resetsAt: RESETS } },
  codex: { primary: { utilization: codex, resetsAt: RESETS, windowDurationMins: WEEK_MINS } },
});

interface Fixture {
  label: string;
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
}

/**
 * An owner, a runner reporting Claude (Opus, Sonnet) and Codex — both signed in — and its Agent with
 * an effort of its own. `account` is the account's switch as written on its row: absent unless a
 * case writes it. `agent` turns the Agent's own switch on through the owner's door, with `allowed`
 * the other engines its runs may move to. `started` makes the project one the sweep starts tasks in.
 */
async function fixture(
  services: Services,
  label: string,
  {
    account,
    agent = false,
    allowed = [],
    started = false,
    planUsage = quota(10),
  }: { account?: boolean; agent?: boolean; allowed?: string[]; started?: boolean; planUsage?: object } = {},
): Promise<Fixture> {
  const { db } = services;
  const target = { label, ownerId: randomUUID(), runnerId: randomUUID(), agentId: randomUUID(), projectId: randomUUID() };
  const { ownerId, runnerId, agentId, projectId } = target;
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${RUN}-${ownerId}@routing.invalid`, name: label, passwordHash: 'x',
      ...(account === undefined ? {} : { preferences: { modelRouting: account } }),
    },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [],
      capabilitiesReportedAt: new Date(), maxConcurrent: 10,
      modelCatalog: {
        claude: [
          { value: OPUS, label: 'Opus 5.5', priority: 0, permissionModes: ['default', 'auto'] },
          { value: SONNET, label: 'Sonnet 5.5', priority: 2, permissionModes: ['default', 'auto'] },
        ],
        codex: [
          { value: CODEX, label: 'GPT-5.5 Codex', priority: 0, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
        ],
      },
      runtimeDefaultModels: { claude: OPUS, codex: CODEX },
      engines: [
        { engine: 'claude', installed: true, auth: 'yes' },
        { engine: 'codex', installed: true, auth: 'yes' },
      ],
      planUsage: planUsage as Prisma.InputJsonValue,
    },
  });
  await db.workspace.create({
    data: { id: agentId, ownerId, runnerId, name: `${label}-agent`, enabled: true, effort: AGENT_EFFORT },
  });
  if (agent || allowed.length > 0) {
    // The owner's door for the Agent's own switch: what `PATCH /workspaces/:id` reaches.
    const updated = await services.workspaces.update(ownerId, agentId, {
      modelRouting: agent, modelRoutingProviders: allowed,
    });
    assert.equal(updated.modelRouting, agent);
  }
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

/** A task of the fixture's, pinned to claude unless the seed says otherwise, suggested at M. */
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

/** A task the sweep starts by itself: READY on a finished prerequisite, in a started project. */
async function readyTask(db: PrismaClient, target: Fixture, seed: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
  const prerequisite = await taskIn(db, target, { status: TaskStatus.DONE, autoRunWhenReady: false });
  const taskId = await taskIn(db, target, { autoRunWhenReady: true, ...seed });
  await db.taskDependency.create({ data: { taskId, dependsOnTaskId: prerequisite } });
  return taskId;
}

/**
 * `PATCH /users/me/preferences` as the owner sends it: the body through main.ts's whitelist, then
 * the controller. Answers the preferences `me` now reports.
 */
async function patchPreferences(services: Services, ownerId: string, body: Record<string, unknown>) {
  const dto = plainToInstance(UpdatePreferencesDto, body);
  assert.deepEqual(await validate(dto, { whitelist: true }), [], 'the body passes the whitelist');
  const me = await services.users.updatePreferences({ userId: ownerId, email: `${ownerId}@routing.invalid` }, dto);
  return me.preferences as Record<string, unknown>;
}

/** The account's switch as every door reads it: the row, now. */
async function accountSwitch(db: PrismaClient, ownerId: string): Promise<boolean> {
  return modelRoutingEnabled(await db.user.findUnique({ where: { id: ownerId }, select: { preferences: true } }));
}

/** One press of Run Now: a new run request. Answers the Session and the press. */
async function runNow(services: Services, target: Fixture, taskId: string) {
  const press = randomUUID();
  const result = await services.tasks.execute(target.ownerId, taskId, undefined, press);
  assert.ok(result.sessionId, 'Run Now must answer with a Session');
  return { sessionId: result.sessionId, press };
}

async function receipt(db: PrismaClient, ownerId: string, kind: string, token: string) {
  const [row] = await db.$queryRaw<Array<{ status: string; target: any }>>`
    SELECT "status", "target" FROM "task_run_request"
     WHERE "owner_id" = ${ownerId}::uuid AND "action_kind" = ${kind} AND "request_token" = ${token}`;
  return row;
}

const decisionsOf = (db: PrismaClient, taskId: string) =>
  db.taskRouteDecision.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });

/** What a run actually is: the three values routing decides. */
const sessionOf = (db: PrismaClient, id: string) => db.session.findUniqueOrThrow({
  where: { id }, select: { provider: true, model: true, effort: true },
});

const dispatchedBy = (target: { provider: unknown; model: unknown; effort: unknown }) =>
  ({ provider: target.provider, model: target.model, effort: target.effort });

/**
 * A fresh run with routing as if it did not exist: no decision recorded for the task, a frozen target
 * that routes nothing and names only the task's pins, and a Session that is `expected` — not the
 * tier the task suggests.
 */
async function assertNotRouted(
  db: PrismaClient,
  taskId: string,
  sessionId: string,
  frozen: { provider: unknown; model: unknown; effort: unknown; route?: unknown },
  expected: { provider: string; model: string | null; effort: string | null },
  hint: string | null,
) {
  assert.equal((await decisionsOf(db, taskId)).length, 0, 'no Route Decision is recorded, shadow or not');
  assert.equal(frozen.route ?? null, null, 'the frozen target routes nothing');
  assert.equal(frozen.effort, null, 'and names no effort, as before routing');
  const session = await sessionOf(db, sessionId);
  assert.deepEqual(session, expected, 'the Session is what it was before routing existed');
  if (hint) {
    assert.notDeepEqual(
      { model: session.model, effort: session.effort }, TIERS[hint], `the suggested tier ${hint} did not take effect`,
    );
  }
}

/** The sweep, once: what the minute timer runs. */
const sweep = (services: Services) =>
  (services.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

const workRuns = (db: PrismaClient, taskId: string) => db.session.findMany({
  where: { taskId, startsTaskWork: true },
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  select: { id: true },
});

/**
 * Counts the routes planned for these tasks: a spy on the TasksService instance's `routeFreshRun`,
 * the one place dispatch and the sweep's engine choice (dispatchEngines) plan a route.
 */
function countRoutes(tasks: TasksService): (taskIds: string[]) => number {
  const planned: string[] = [];
  const own = tasks as unknown as { routeFreshRun: (...args: unknown[]) => Promise<unknown> };
  const original = own.routeFreshRun.bind(tasks);
  own.routeFreshRun = (...args: unknown[]) => {
    planned.push((args[1] as { id: string }).id);
    return original(...args);
  };
  return (taskIds) => planned.filter((id) => taskIds.includes(id)).length;
}

test('off by default: a single and a bulk Run record no decision and run exactly as before routing; false is the same',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      // An account that never touched the switch: no `modelRouting` key on its row at all.
      const target = await fixture(services, 'default-off');
      assert.deepEqual(
        (await db.user.findUniqueOrThrow({ where: { id: target.ownerId }, select: { preferences: true } })).preferences,
        {},
      );

      const single = await taskIn(db, target);
      const run = await runNow(services, target, single);
      const bound = await receipt(db, target.ownerId, TASK_RUN_ACTION.execute, run.press);
      assert.equal(bound.status, 'COMPLETED');
      assert.equal(bound.target.v, 2);
      assert.deepEqual(dispatchedBy(bound.target), { provider: 'claude', model: null, effort: null });
      await assertNotRouted(db, single, run.sessionId, bound.target, UNROUTED, 'M');
      const detail = await services.tasks.get(target.ownerId, single) as unknown as {
        sessions: Array<{ id: string; route: unknown }>;
      };
      assert.equal(detail.sessions.find((s) => s.id === run.sessionId)?.route, null, 'the run reads as unrouted');

      // A bulk press: two suggested tiers and a model pin, which is honoured as it always was.
      const bulk = [
        { taskId: await taskIn(db, target, { modelHint: 'S' }), hint: 'S', session: UNROUTED },
        { taskId: await taskIn(db, target, { modelHint: 'L' }), hint: 'L', session: UNROUTED },
        {
          taskId: await taskIn(db, target, { model: SONNET, modelHint: 'XL' }), hint: 'XL',
          session: { provider: 'claude', model: SONNET, effort: AGENT_EFFORT },
        },
      ];
      const press = randomUUID();
      const answer = await services.tasks.batchExecute(target.ownerId, bulk.map((b) => b.taskId), undefined, press);
      assert.equal(answer.dispatched, bulk.length);
      const bulkReceipt = await receipt(db, target.ownerId, TASK_RUN_ACTION.batchExecute, press);
      assert.equal(bulkReceipt.target.v, 2);
      for (const item of bulk) {
        const sessionId = answer.results.find((r) => r.id === item.taskId)?.sessionId;
        assert.ok(sessionId, `the bulk Run started ${item.taskId}`);
        const frozen = bulkReceipt.target.items.find((i: { taskId: string }) => i.taskId === item.taskId);
        assert.deepEqual(dispatchedBy(frozen), { provider: 'claude', model: item.session.model, effort: null });
        await assertNotRouted(db, item.taskId, sessionId, frozen, item.session, item.hint);
        assert.equal(
          (await decisionsOf(db, item.taskId)).some((r) => r.requestToken === TASK_RUN_TRIGGER.batch(press, item.taskId)),
          false,
        );
      }
      assert.equal(await db.taskRouteDecision.count({ where: { ownerId: target.ownerId } }), 0);

      // Written as false — what turning it off writes — is the same as never having touched it.
      const offTarget = await fixture(services, 'explicit-off', { account: false });
      const offTask = await taskIn(db, offTarget, { modelHint: 'S' });
      const offRun = await runNow(services, offTarget, offTask);
      const offReceipt = await receipt(db, offTarget.ownerId, TASK_RUN_ACTION.execute, offRun.press);
      await assertNotRouted(db, offTask, offRun.sessionId, offReceipt.target, UNROUTED, 'S');
    } finally {
      await services.db.$disconnect();
    }
  });

test('the Agent\'s own switch on, the account\'s off: a Run is not routed — not to the tier, not to another engine',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      // The Agent has smart selection on and may move to codex; claude is at 95% of its week, so a
      // route would move an unpinned run to codex. The account never turned the feature on.
      const target = await fixture(services, 'agent-on', { agent: true, allowed: ['codex'], planUsage: quota(95) });
      assert.equal(await accountSwitch(db, target.ownerId), false);

      const pinned = await taskIn(db, target);
      const pinnedRun = await runNow(services, target, pinned);
      const pinnedReceipt = await receipt(db, target.ownerId, TASK_RUN_ACTION.execute, pinnedRun.press);
      assert.deepEqual(dispatchedBy(pinnedReceipt.target), { provider: 'claude', model: null, effort: null });
      await assertNotRouted(db, pinned, pinnedRun.sessionId, pinnedReceipt.target, UNROUTED, 'M');

      // Unpinned: the Agent's own engine, the seed — claude — and not codex.
      const unpinned = await taskIn(db, target, { provider: null });
      const unpinnedRun = await runNow(services, target, unpinned);
      const unpinnedReceipt = await receipt(db, target.ownerId, TASK_RUN_ACTION.execute, unpinnedRun.press);
      assert.deepEqual(dispatchedBy(unpinnedReceipt.target), { provider: null, model: null, effort: null });
      await assertNotRouted(db, unpinned, unpinnedRun.sessionId, unpinnedReceipt.target, UNROUTED, 'M');

      // Nothing was cleared: the Agent's switch and engines are where the owner put them.
      assert.deepEqual(
        await db.workspace.findUniqueOrThrow({
          where: { id: target.agentId }, select: { modelRouting: true, modelRoutingProviders: true },
        }),
        { modelRouting: true, modelRoutingProviders: ['codex'] },
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('the sweep plans no route while the account switch is off: its quota gate judges the un-routed engine',
  { skip, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      // Claude's week is spent; codex has room and is listed; the Agent's switch is on. Both tasks are
      // unpinned, so routing would move them to codex — and without it they would run on claude, the
      // Agent's seed. One is reached by each of the sweep's two scans: READY on a prerequisite, and
      // a started project's task that depends on nothing.
      const target = await fixture(services, 'gate', {
        agent: true, allowed: ['codex'], started: true, planUsage: quota(100),
      });
      const dependent = await readyTask(db, target, { provider: null });
      const independent = await taskIn(db, target, { provider: null, autoRunWhenReady: true });
      const both = [dependent, independent];
      const routesFor = countRoutes(services.tasks);

      await sweep(services);

      for (const taskId of both) {
        assert.deepEqual(await workRuns(db, taskId), [], 'held: un-routed, the run would spend claude\'s spent quota');
      }
      assert.equal(routesFor(both), 0, 'and no route was planned to decide that');
      assert.equal(await db.taskRouteDecision.count({ where: { ownerId: target.ownerId } }), 0);

      // The owner turns the feature on: the sweep routes as before, and the gate judges codex.
      assert.equal((await patchPreferences(services, target.ownerId, { modelRouting: true })).modelRouting, true);
      await sweep(services);

      assert.ok(routesFor(both) >= 1, 'with the switch on the sweep plans routes again');
      for (const taskId of both) {
        const [run, ...more] = await workRuns(db, taskId);
        assert.ok(run, `the sweep did not start ${taskId} on the engine routing picks`);
        assert.equal(more.length, 0);
        assert.deepEqual(await sessionOf(db, run.id), { provider: 'codex', model: CODEX, effort: 'medium' });
        const decision = await db.taskRouteDecision.findFirstOrThrow({ where: { sessionId: run.id } });
        assert.equal(decision.applied, true);
        assert.deepEqual(decision.reasons, [TIER_M, MOVED_OFF_SPENT_CLAUDE]);
      }
    } finally {
      await services.db.$disconnect();
    }
  });

test('an automatic re-run is held by the engine its pins give it while the account switch is off, and routed once it is on',
  { skip, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'rearm', { agent: true, allowed: ['codex'], started: true });
      const taskId = await readyTask(db, target, { provider: null });

      // The sweep's own dispatch, switch off: the baseline on claude, and no decision.
      await sweep(services);
      const [run1] = await workRuns(db, taskId);
      assert.ok(run1, 'the sweep did not start the task');
      assert.deepEqual(await sessionOf(db, run1.id), UNROUTED);
      assert.equal((await decisionsOf(db, taskId)).length, 0);

      // Run 1 stopped at claude's weekly limit, which the runner now reports spent until RESETS.
      await db.session.update({
        where: { id: run1.id }, data: { status: RunStatus.FAILED, error: WEEKLY_LIMIT, finishedAt: new Date() },
      });
      await db.runner.update({
        where: { id: target.runnerId },
        data: { lastHeartbeatAt: new Date(), planUsage: quota(100) as Prisma.InputJsonValue },
      });
      const skipped = async () =>
        ((await services.tasks.get(target.ownerId, taskId)) as unknown as {
          autoRunSkipped: { code: string; retryAt: Date | null } | null;
        }).autoRunSkipped;

      // Routed, the re-run would go to codex, which has room. Not routed, it is claude's: held —
      // and neither the task read nor the sweep's re-arm planned a route to decide that.
      const routesFor = countRoutes(services.tasks);
      const held = await skipped();
      assert.equal(held?.code, 'QUOTA_EXHAUSTED');
      assert.equal(held?.retryAt?.toISOString(), RESETS);
      await sweep(services);
      assert.equal((await workRuns(db, taskId)).length, 1, 'held: nothing re-run');
      assert.equal(routesFor([taskId]), 0, 'no route was planned for the ended moment while the switch is off');

      // On: the re-run would be on codex — due now, and started there.
      await patchPreferences(services, target.ownerId, { modelRouting: true });
      assert.equal(await skipped(), null, 'nothing holds it');
      assert.ok(routesFor([taskId]) >= 1, 'with the switch on the re-arm decision plans a route again');
      await sweep(services);
      const runs = await workRuns(db, taskId);
      assert.equal(runs.length, 2, 'the sweep did not re-run the task');
      assert.deepEqual(await sessionOf(db, runs[1].id), { provider: 'codex', model: CODEX, effort: 'medium' });
      const decision = await db.taskRouteDecision.findFirstOrThrow({ where: { sessionId: runs[1].id } });
      assert.equal(decision.applied, true);
      assert.ok(decision.reasons.includes(MOVED_OFF_SPENT_CLAUDE), decision.reasons.join(' | '));
    } finally {
      await services.db.$disconnect();
    }
  });

/** Whether this text asks for a tier: the whole paragraph, or none of it. */
function asksForTier(text: string): boolean {
  const head = text.includes(HINT_HEAD);
  assert.equal(text.includes(HINT_TAIL), head, 'the paragraph is there whole or not at all');
  return head;
}

/** The coordinator block a delivery appended, or null. */
const blockOf = (content: string) => (content.includes(CONTEXT_TAG) ? content.slice(content.indexOf(CONTEXT_TAG)) : null);

interface Engine { sessionId: string; leaseOwner: string; generation: string }

/**
 * What the runner's claim and the engine's activation leave behind — the Session RUNNING on this
 * runner, its opening seeded as the claim seeds it (`initial-<id>`, the prompt), one lease
 * generation active — from a runner that declares the sparse coordinator context, so the
 * instructions are re-sent only when the context key moves.
 */
async function startEngine(services: Services, target: Fixture, sessionId: string): Promise<Engine> {
  const { db, api } = services;
  const engine = { sessionId, leaseOwner: randomUUID(), generation: randomUUID() };
  // The claim and the lease in one write, in a transaction that declares it reads the session's
  // recorded engine: migration 0414 drops a PENDING -> RUNNING write in silence and REFUSES a lease
  // write for a session with one, unless the transaction says so (`common/session-scheduling.ts`).
  const session = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    return tx.session.update({
      where: { id: sessionId },
      data: { assignedRunnerId: target.runnerId, status: RunStatus.RUNNING, inboxLeaseOwner: engine.leaseOwner },
      select: { prompt: true, provider: true },
    });
  });
  assert.equal(session.provider, 'claude', 'a claude engine: the runtime the declared capability is for');
  await queueTurn(db, sessionId, session.prompt, `initial-${sessionId}`);
  await api.activateLeases({ id: target.runnerId }, sessionId, {
    leaseOwner: engine.leaseOwner, leaseGeneration: engine.generation,
  } as never);
  return engine;
}

/** A queued message turn, after every turn the session already has. */
async function queueTurn(db: PrismaClient, sessionId: string, content: string, clientTurnId = `turn-${randomUUID()}`) {
  const last = await db.conversationTurn.aggregate({ where: { sessionId }, _max: { seq: true } });
  await db.conversationTurn.create({
    data: { sessionId, seq: (last._max.seq ?? 0) + 1, clientTurnId, kind: 'message', content, status: 'PENDING' },
  });
}

/**
 * One turn, through the runner's inbox and back: what it was handed, the engine's reply (a message
 * turn nothing answered goes back in the queue), then its completion.
 */
async function turn(services: Services, target: Fixture, engine: Engine): Promise<string> {
  const { db, api } = services;
  // The claim's part: the session is running again — in a transaction that declares it reads the
  // session's recorded engine, which migration 0414 requires of every PENDING -> RUNNING write
  // (`common/session-scheduling.ts`).
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.session.update({ where: { id: engine.sessionId }, data: { status: RunStatus.RUNNING } });
  });
  const handed = await (api as unknown as {
    dequeueTurn(
      sessionId: string, runnerId: string, leaseGeneration: string, acceptsSteer: boolean, declared: string[],
    ): Promise<{ turnId: string; content?: string } | null>;
  }).dequeueTurn(engine.sessionId, target.runnerId, engine.generation, false, [SESSION_CLAUDE_COORDINATOR_CONTEXT_V1]);
  assert.ok(handed?.turnId, 'the inbox handed out the queued turn');
  const last = await db.runEvent.aggregate({ where: { sessionId: engine.sessionId }, _max: { seq: true } });
  await api.events({ id: target.runnerId }, engine.sessionId, {
    leaseOwner: engine.leaseOwner,
    events: [{
      seq: (last._max.seq ?? 0) + 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(),
      turnId: handed.turnId, payload: { text: 'noted' },
    }],
  } as never);
  await api.turnComplete({ id: target.runnerId }, engine.sessionId, {
    turnId: handed.turnId, leaseOwner: engine.leaseOwner, status: 'SUCCEEDED', subtype: 'success',
    numTurns: 1, costUsd: 0,
  } as never);
  return handed.content ?? '';
}

/** The context key the coordinator acknowledged, against the one each value of the switch names. */
async function acknowledged(db: PrismaClient, engine: Engine, projectId: string, modelRouting: boolean) {
  const session = await db.session.findUniqueOrThrow({
    where: { id: engine.sessionId }, select: { coordinatorContextAckKey: true, coordinatorContextEpoch: true },
  });
  const key = buildCoordinatorDeliveryContextKey(
    projectId, engine.generation, session.coordinatorContextEpoch, true, modelRouting,
  );
  return session.coordinatorContextAckKey === key;
}

test('a coordinator is asked for a tier only while the account switch is on; flipping it re-delivers the instructions',
  { skip, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db, projects } = services;
      const target = await fixture(services, 'coordinator');
      const [projectA, projectB, projectC] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [projectA, projectB, projectC]) {
        await db.project.create({ data: { id, ownerId: target.ownerId, title: `coordinated ${id}`, coordinatorEnabled: true } });
      }
      const promptOf = async (sessionId: string) =>
        (await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { prompt: true } })).prompt;
      const isCurrent = async (prompt: string, projectId: string) =>
        coordinatorOpeningIsCurrent(prompt, projectId, true, await accountSwitch(db, target.ownerId));

      // Off: the opening says nothing about tiers, and it is current.
      const a = await projects.coordinator(target.ownerId, projectA, target.agentId);
      assert.equal(a.created, true);
      const promptA = await promptOf(a.sessionId);
      assert.equal(asksForTier(promptA), false, 'off: the coordinator is not asked for a tier');
      assert.equal(await isCurrent(promptA, projectA), true);

      // On, through the owner's door: A's opening is no longer current; one opened now asks for a tier.
      assert.equal((await patchPreferences(services, target.ownerId, { modelRouting: true })).modelRouting, true);
      assert.equal(await isCurrent(promptA, projectA), false, 'an opening rendered off is not current once it is on');
      const b = await projects.coordinator(target.ownerId, projectB, target.agentId);
      const promptB = await promptOf(b.sessionId);
      assert.equal(asksForTier(promptB), true, 'on: the coordinator is asked for a tier');
      assert.equal(await isCurrent(promptB, projectB), true);
      // Opened on and first delivered on: the opening and the inbox read the same switch, so the
      // opening is the context and nothing is appended to it.
      const c = await projects.coordinator(target.ownerId, projectC, target.agentId);
      const promptC = await promptOf(c.sessionId);
      assert.equal(asksForTier(promptC), true);
      const engineC = await startEngine(services, target, c.sessionId);
      assert.equal(await turn(services, target, engineC), promptC, 'on and on: the opening is not sent twice');
      assert.equal(await acknowledged(db, engineC, projectC, true), true);
      const generation = randomUUID();
      assert.notEqual(
        buildCoordinatorDeliveryContextKey(projectA, generation, 0, true, false),
        buildCoordinatorDeliveryContextKey(projectA, generation, 0, true, true),
        'the delivery key names the switch',
      );

      // Off again: the other way round.
      assert.equal((await patchPreferences(services, target.ownerId, { modelRouting: false })).modelRouting, false);
      assert.equal(await isCurrent(promptB, projectB), false, 'an opening rendered on is not current once it is off');
      assert.equal(await isCurrent(promptA, projectA), true);

      // Delivered: A's engine starts with the switch as A's opening was rendered, so the opening is the
      // context and nothing is appended — and its completion acknowledges the key for "off".
      const engineA = await startEngine(services, target, a.sessionId);
      assert.equal(await turn(services, target, engineA), promptA);
      assert.equal(await acknowledged(db, engineA, projectA, false), true);
      // The same switch, the next turn: acknowledged, so nothing is re-sent.
      await queueTurn(db, a.sessionId, 'what is next?');
      assert.equal(await turn(services, target, engineA), 'what is next?');

      // On: the same engine's next turn carries the instructions again, now asking for a tier.
      await patchPreferences(services, target.ownerId, { modelRouting: true });
      await queueTurn(db, a.sessionId, 'and now?');
      const turnedOn = await turn(services, target, engineA);
      assert.ok(turnedOn.startsWith('and now?'), turnedOn);
      assert.equal(asksForTier(blockOf(turnedOn) ?? assert.fail(`no coordinator block:\n${turnedOn}`)), true);
      assert.equal(await acknowledged(db, engineA, projectA, true), true);
      await queueTurn(db, a.sessionId, 'and then?');
      assert.equal(await turn(services, target, engineA), 'and then?', 'acknowledged: not re-sent while it stays on');

      // Off: re-sent once more, without the paragraph.
      await patchPreferences(services, target.ownerId, { modelRouting: false });
      await queueTurn(db, a.sessionId, 'and finally?');
      const turnedOff = await turn(services, target, engineA);
      assert.ok(turnedOff.startsWith('and finally?'), turnedOff);
      assert.equal(asksForTier(blockOf(turnedOff) ?? assert.fail(`no coordinator block:\n${turnedOff}`)), false);
      assert.equal(await acknowledged(db, engineA, projectA, false), true);

      // B was opened on and is first delivered off: its opening is not the context the key names, so
      // the block is appended to it, and the block does not ask for a tier.
      const engineB = await startEngine(services, target, b.sessionId);
      const firstB = await turn(services, target, engineB);
      assert.ok(firstB.startsWith(promptB), 'the opening is still handed over');
      assert.equal(asksForTier(blockOf(firstB) ?? assert.fail(`no coordinator block:\n${firstB}`)), false);
      assert.equal(await acknowledged(db, engineB, projectB, false), true);
    } finally {
      await services.db.$disconnect();
    }
  });

test('on: a Run is decided in shadow while the Agent\'s switch is off and routed when it is on; off again restores the baseline',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      // The owner's door keeps a boolean and refuses anything else.
      const refused = await validate(plainToInstance(UpdatePreferencesDto, { modelRouting: 'yes' }), { whitelist: true });
      assert.deepEqual(refused.map((error) => error.property), ['modelRouting']);

      const target = await fixture(services, 'on');
      const preferences = await patchPreferences(services, target.ownerId, { modelRouting: true });
      assert.equal(preferences.modelRouting, true);
      assert.equal(await accountSwitch(db, target.ownerId), true);

      // The Agent's switch off: one shadow decision, and the Session is its baseline — the very run
      // an account with the switch off gets.
      const shadowTask = await taskIn(db, target);
      const shadow = await runNow(services, target, shadowTask);
      const [row, ...more] = await decisionsOf(db, shadowTask);
      assert.equal(more.length, 0);
      assert.deepEqual(
        { applied: row.applied, level: row.level, provider: row.provider, model: row.model, effort: row.effort, sessionId: row.sessionId },
        { applied: false, level: 'M', provider: 'claude', model: SONNET, effort: 'medium', sessionId: shadow.sessionId },
      );
      assert.deepEqual(row.baseline, BASELINE);
      assert.equal((row.features as Record<string, unknown>).modelRouting, false);
      const shadowReceipt = await receipt(db, target.ownerId, TASK_RUN_ACTION.execute, shadow.press);
      assert.deepEqual(dispatchedBy(shadowReceipt.target), { provider: 'claude', model: null, effort: null });
      assert.equal(shadowReceipt.target.route.applied, false);
      assert.deepEqual(await sessionOf(db, shadow.sessionId), UNROUTED);

      // The Agent's switch on: routed — the Session is on the tier's model and effort.
      await services.workspaces.update(target.ownerId, target.agentId, { modelRouting: true });
      const routedTask = await taskIn(db, target);
      const routed = await runNow(services, target, routedTask);
      const [applied] = await decisionsOf(db, routedTask);
      assert.deepEqual(
        { applied: applied.applied, level: applied.level, model: applied.model, effort: applied.effort },
        { applied: true, level: 'M', model: SONNET, effort: 'medium' },
      );
      assert.equal((applied.features as Record<string, unknown>).modelRouting, true);
      const routedReceipt = await receipt(db, target.ownerId, TASK_RUN_ACTION.execute, routed.press);
      assert.deepEqual(dispatchedBy(routedReceipt.target), { provider: 'claude', model: SONNET, effort: 'medium' });
      assert.deepEqual(await sessionOf(db, routed.sessionId), { provider: 'claude', model: SONNET, effort: 'medium' });

      // Off again, through the same door: the next run is as before routing, and nothing was cleared —
      // the Agent's switch is still on, ready for the account's to come back.
      assert.equal((await patchPreferences(services, target.ownerId, { modelRouting: false })).modelRouting, false);
      const afterTask = await taskIn(db, target);
      const after = await runNow(services, target, afterTask);
      const afterReceipt = await receipt(db, target.ownerId, TASK_RUN_ACTION.execute, after.press);
      await assertNotRouted(db, afterTask, after.sessionId, afterReceipt.target, UNROUTED, 'M');
      assert.equal(
        (await db.workspace.findUniqueOrThrow({ where: { id: target.agentId }, select: { modelRouting: true } })).modelRouting,
        true,
      );
    } finally {
      await services.db.$disconnect();
    }
  });
