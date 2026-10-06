import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatorType, Prisma, PrismaClient, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
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

/**
 * P5 of model routing (docs/model-routing-design.md §6; contract §7.4 R1–R4): routing may move a
 * fresh run to another engine, but only to one the owner listed on the Agent
 * (`workspace.modelRoutingProviders`), and only for a reason it writes down.
 *
 * The router's rules are unit-tested (model-routing.spec.ts). What is proven here, on a real
 * PostgreSQL and through the doors that start a run — Run Now (`execute`) and the sweep
 * (`reconcileReadyTasks`, whose re-arm the task read reports as `autoRunSkipped`):
 *  - the list is the owner's: the user API writes it, the agent tools cannot, and with nothing on it
 *    a run never leaves the Agent's own engine;
 *  - an engine signed out on the runner, or with a window at 90% or more for the account the run
 *    would use, is not picked — the Agent's own engine included, when a listed one can take the run;
 *  - a verification run prefers an engine the task it verifies did not last run on;
 *  - a run that moved is a new Session on the other engine, the task's pins untouched, and a paused
 *    run is never moved;
 *  - the sweep's quota gate judges the engine the run will be created on — the routed one, else the
 *    task's provider pin — not the Agent's seed.
 *
 * Every task here is unpinned unless a case says otherwise, so its engine is the Agent's own: the
 * seed, which with no session opened by hand is claude. Each Agent has smart selection on unless a
 * case says otherwise, and the coordinator suggested M.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const CODEX = 'gpt-5.5-codex';
/** The Agent's own effort: what a run that is not routed gets. */
const AGENT_EFFORT = 'max';
const HINT_REASON = 'one service plus its spec';
const TIER_M = `Tier M: suggested by the coordinator — ${HINT_REASON}`;
const OWN = "Engine claude: this agent's own engine";
const WEEKLY_LIMIT = "You've hit your weekly limit · resets 1pm (Europe/Berlin)";
/** Three days out: a window that stays in force for the whole spec. */
const RESETS = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
const WEEK_MINS = 7 * 24 * 60;

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  workspaces: WorkspacesService;
}

/** Publishes nothing: every realtime call is a no-op. */
const quiet = () => new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

/** A whole service stack over its own pool. */
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
    tasks: new TasksService(prisma, sessions, publishes),
    workspaces: new WorkspacesService(prisma),
  };
}

type Auth = 'yes' | 'no';

/** The runner's engine report: both CLIs installed, each signed in unless said otherwise. */
const enginesReport = ({ claude = 'yes', codex = 'yes' }: { claude?: Auth; codex?: Auth } = {}) => [
  { engine: 'claude', installed: true, auth: claude },
  { engine: 'codex', installed: true, auth: codex },
];

/** The runner's quota: Claude's weekly window (all models) and Codex's weekly one, at these shares. */
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
 * An owner, a runner reporting Claude and Codex — both signed in, quota to spare unless `planUsage`
 * says otherwise — and its Agent, set up through the user API as the owner sets it up: smart
 * selection on unless `routing` says otherwise, and `allowed` the other engines its runs may use.
 * `started` makes the project one the sweep starts tasks in.
 */
async function fixture(
  services: Services,
  label: string,
  {
    allowed = ['codex'],
    routing = true,
    started = false,
    planUsage = quota(10),
  }: { allowed?: string[]; routing?: boolean; started?: boolean; planUsage?: object } = {},
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
      engines: enginesReport(),
      planUsage: planUsage as Prisma.InputJsonValue,
    },
  });
  await db.workspace.create({
    data: { id: agentId, ownerId, runnerId, name: `${label}-agent`, enabled: true, effort: AGENT_EFFORT },
  });
  // The owner's door, and the only one: what `PATCH /workspaces/:id` reaches.
  const agent = await services.workspaces.update(ownerId, agentId, {
    modelRouting: routing, modelRoutingProviders: allowed,
  });
  assert.deepEqual(agent.modelRoutingProviders, allowed);
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

/** What the runner reports now: its quota, its sign-ins, or both — and that it is alive. */
async function runnerReports(
  db: PrismaClient,
  target: Fixture,
  report: { planUsage?: object; engines?: object },
) {
  await db.runner.update({
    where: { id: target.runnerId },
    data: {
      lastHeartbeatAt: new Date(),
      ...(report.planUsage ? { planUsage: report.planUsage as Prisma.InputJsonValue } : {}),
      ...(report.engines ? { engines: report.engines as Prisma.InputJsonValue } : {}),
    },
  });
}

/** A task of the fixture's, unpinned, with the coordinator's suggestion of M. */
async function taskIn(db: PrismaClient, target: Fixture, seed: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
  const task = await db.task.create({
    data: {
      ownerId: target.ownerId, projectId: target.projectId, assigneeId: target.agentId,
      title: `${target.label} task`, creatorType: CreatorType.USER, creatorId: target.ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT', modelHint: 'M', modelHintReason: HINT_REASON, ...seed,
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

/** The run ends as the runner's /finalize leaves it. */
async function end(db: PrismaClient, sessionId: string, status: RunStatus, error: string | null = null) {
  await db.session.update({ where: { id: sessionId }, data: { status, error, finishedAt: new Date() } });
}

/** What a run actually is: the three values routing decides. */
const sessionOf = (db: PrismaClient, id: string) => db.session.findUniqueOrThrow({
  where: { id }, select: { provider: true, model: true, effort: true },
});

const decisionOf = (db: PrismaClient, sessionId: string) =>
  db.taskRouteDecision.findFirstOrThrow({ where: { sessionId } });

/** What a decision chose, and why. */
async function routed(db: PrismaClient, sessionId: string) {
  const row = await decisionOf(db, sessionId);
  return { applied: row.applied, provider: row.provider, model: row.model, effort: row.effort, reasons: row.reasons };
}

/** The sweep, once: what the minute timer runs. */
const sweep = (services: Services) =>
  (services.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

const workRuns = (db: PrismaClient, taskId: string) => db.session.findMany({
  where: { taskId, startsTaskWork: true },
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  select: { id: true },
});

/** A task the sweep starts by itself: READY on a finished prerequisite, in a started project. */
async function readyTask(db: PrismaClient, target: Fixture, seed: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
  const prerequisite = await taskIn(db, target, { status: TaskStatus.DONE, autoRunWhenReady: false });
  const taskId = await taskIn(db, target, { autoRunWhenReady: true, ...seed });
  await db.taskDependency.create({ data: { taskId, dependsOnTaskId: prerequisite } });
  return taskId;
}

test('the engines a run may move to are the owner\'s to list: the user API writes them, the agent tools cannot',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      // The user API validates with a whitelist (main.ts): engines with a tier table are kept, nothing else.
      for (const Dto of [CreateWorkspaceDto, UpdateWorkspaceDto]) {
        const ok = plainToInstance(Dto, { name: 'agent', modelRoutingProviders: ['codex', 'claude'] });
        assert.deepEqual(await validate(ok, { whitelist: true }), []);
        assert.deepEqual(ok.modelRoutingProviders, ['codex', 'claude'], `${Dto.name} keeps it`);
        for (const refused of [['kimi'], ['codex', 'opencode'], 'codex', ['claude', 'codex', 'claude']]) {
          const errors = await validate(plainToInstance(Dto, { name: 'agent', modelRoutingProviders: refused }), { whitelist: true });
          assert.deepEqual(errors.map((error) => error.property), ['modelRoutingProviders'], JSON.stringify(refused));
        }
      }

      const target = await fixture(services, 'owner-only', { allowed: [] });
      const { db, workspaces } = services;
      const listOf = async (id: string) =>
        (await db.workspace.findUniqueOrThrow({ where: { id }, select: { modelRoutingProviders: true } }))
          .modelRoutingProviders;

      const ownerMade = await workspaces.create(target.ownerId, {
        name: 'owner-made', runnerId: target.runnerId, modelRoutingProviders: ['codex', 'claude'],
      });
      assert.deepEqual(await listOf(ownerMade.id), ['claude', 'codex'], 'stored once each, in the router\'s order');
      const plain = await workspaces.create(target.ownerId, { name: 'owner-default', runnerId: target.runnerId });
      assert.deepEqual(await listOf(plain.id), [], 'empty unless the owner lists one');
      await workspaces.update(target.ownerId, ownerMade.id, { description: 'renamed' });
      assert.deepEqual(await listOf(ownerMade.id), ['claude', 'codex'], 'a patch that says nothing about it leaves it');
      await workspaces.update(target.ownerId, ownerMade.id, { modelRoutingProviders: [] });
      assert.deepEqual(await listOf(ownerMade.id), []);

      // The agent tools: MCP `agent_create` / `agent_update` and `orbit agent` reach this controller.
      assert.equal((ORCHESTRATOR_WORKSPACE_CREATE_FIELDS as readonly string[]).includes('modelRoutingProviders'), false);
      const runner = await db.runner.findUniqueOrThrow({ where: { id: target.runnerId } });
      const agents = new RunnerAgentsController(
        workspaces,
        { assert: async () => 'orchestrating-session' } as unknown as RunnerOrchestrationAuthorizer,
        quiet(),
      );
      const spawned = await agents.createWorkspace(runner, 'orchestrating-session', 'credential', {
        name: 'agent-made', modelRoutingProviders: ['codex'],
      });
      assert.deepEqual(await listOf(spawned.id), [], 'an agent cannot create an Agent that may change engines');
      await agents.updateWorkspace(runner, 'orchestrating-session', 'credential', target.agentId, {
        modelRoutingProviders: ['codex'], description: 'touched by an agent',
      });
      assert.deepEqual(
        await db.workspace.findUniqueOrThrow({
          where: { id: target.agentId }, select: { modelRoutingProviders: true, description: true },
        }),
        { modelRoutingProviders: [], description: 'touched by an agent' },
        'nor list one for an Agent: the update went through and left the list where the owner put it',
      );
      await workspaces.update(target.ownerId, target.agentId, { modelRoutingProviders: ['codex'] });
      await agents.updateWorkspace(runner, 'orchestrating-session', 'credential', target.agentId, {
        modelRoutingProviders: [],
      });
      assert.deepEqual(await listOf(target.agentId), ['codex'], 'nor take one off');
    } finally {
      await services.db.$disconnect();
    }
  });

test('a run leaves the agent\'s engine only for one the owner listed, and only when its own is at 90% or signed out',
  { skip, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      // Claude's weekly window is at 95%: the Agent's own engine is not one to start a run on.
      const target = await fixture(services, 'quota', { allowed: [], planUsage: quota(95) });

      // Nothing listed: the run stays on claude, at the suggested tier.
      const unlisted = await runNow(services, target, await taskIn(db, target));
      assert.deepEqual(await routed(db, unlisted), {
        applied: true, provider: 'claude', model: SONNET, effort: 'medium', reasons: [TIER_M, OWN],
      });
      assert.deepEqual(await sessionOf(db, unlisted), { provider: 'claude', model: SONNET, effort: 'medium' });

      // The owner lists codex: the same tier, on Codex's tier table.
      await services.workspaces.update(target.ownerId, target.agentId, { modelRoutingProviders: ['codex'] });
      const movedTask = await taskIn(db, target);
      const moved = await runNow(services, target, movedTask);
      assert.deepEqual(await routed(db, moved), {
        applied: true, provider: 'codex', model: CODEX, effort: 'medium',
        reasons: [TIER_M, 'Engine codex: claude is at 95% of its weekly quota'],
      });
      assert.deepEqual(await sessionOf(db, moved), { provider: 'codex', model: CODEX, effort: 'medium' });
      const row = await decisionOf(db, moved);
      assert.equal((row.baseline as Record<string, unknown>).provider, 'claude', 'the baseline is still the agent\'s engine');
      const features = row.features as Record<string, unknown>;
      assert.deepEqual(
        {
          modelRoutingProviders: features.modelRoutingProviders,
          engineStates: features.engineStates,
          verifiedRunEngine: features.verifiedRunEngine,
        },
        {
          modelRoutingProviders: ['codex'],
          engineStates: {
            claude: { signedOut: false, quota: { utilization: 95, window: 'weekly' } },
            codex: { signedOut: false, quota: { utilization: 10, window: 'weekly' } },
          },
          verifiedRunEngine: null,
        },
      );
      assert.deepEqual(
        await db.task.findUniqueOrThrow({ where: { id: movedTask }, select: { provider: true, model: true } }),
        { provider: null, model: null },
        'the route is never written back onto the task',
      );

      // Claude has room again: a listed engine is no reason to leave the agent's own.
      await runnerReports(db, target, { planUsage: quota(40) });
      const roomy = await runNow(services, target, await taskIn(db, target));
      assert.deepEqual(await routed(db, roomy), {
        applied: true, provider: 'claude', model: SONNET, effort: 'medium', reasons: [TIER_M, OWN],
      });

      // The moved run was paused, and is asked to go on: it continues on codex, and is not routed again —
      // a run never changes engine, only a fresh one starts on another (R4).
      await db.session.update({ where: { id: moved }, data: { status: RunStatus.AWAITING_INPUT, numTurns: 1 } });
      assert.equal(await runNow(services, target, movedTask), moved, 'the paused run is continued');
      assert.deepEqual(await sessionOf(db, moved), { provider: 'codex', model: CODEX, effort: 'medium' });
      assert.equal(await db.taskRouteDecision.count({ where: { taskId: movedTask } }), 1, 'only the fresh run was decided');

      // Claude signed out on the runner: the run goes to codex.
      await runnerReports(db, target, { engines: enginesReport({ claude: 'no' }) });
      const signedOut = await runNow(services, target, await taskIn(db, target));
      assert.deepEqual(await routed(db, signedOut), {
        applied: true, provider: 'codex', model: CODEX, effort: 'medium',
        reasons: [TIER_M, 'Engine codex: claude is signed out on this runner'],
      });
      assert.deepEqual(await sessionOf(db, signedOut), { provider: 'codex', model: CODEX, effort: 'medium' });

      // Claude at 95% again, and codex is the one signed out: codex is not picked, so the run stays put.
      await runnerReports(db, target, { planUsage: quota(95), engines: enginesReport({ codex: 'no' }) });
      const codexSignedOut = await runNow(services, target, await taskIn(db, target));
      assert.deepEqual(await routed(db, codexSignedOut), {
        applied: true, provider: 'claude', model: SONNET, effort: 'medium',
        reasons: [
          TIER_M,
          `${OWN} — no other engine it may use is available`,
          'claude is at 95% of its weekly quota',
          'codex is signed out on this runner',
        ],
      });
      assert.deepEqual(await sessionOf(db, codexSignedOut), { provider: 'claude', model: SONNET, effort: 'medium' });

      // Signed in, but at 92% of its own week: not picked either.
      await runnerReports(db, target, { planUsage: quota(95, 92), engines: enginesReport() });
      const codexFull = await runNow(services, target, await taskIn(db, target));
      assert.deepEqual((await routed(db, codexFull)).reasons, [
        TIER_M,
        `${OWN} — no other engine it may use is available`,
        'claude is at 95% of its weekly quota',
        'codex is at 92% of its weekly quota',
      ]);
      assert.equal((await sessionOf(db, codexFull)).provider, 'claude');

      // Smart selection off: the decision says where it would have gone, and the run is the baseline.
      await runnerReports(db, target, { planUsage: quota(95) });
      await services.workspaces.update(target.ownerId, target.agentId, { modelRouting: false });
      const shadow = await runNow(services, target, await taskIn(db, target));
      assert.deepEqual(await routed(db, shadow), {
        applied: false, provider: 'codex', model: CODEX, effort: 'medium',
        reasons: [TIER_M, 'Engine codex: claude is at 95% of its weekly quota'],
      });
      assert.deepEqual(await sessionOf(db, shadow), { provider: 'claude', model: null, effort: AGENT_EFFORT });
    } finally {
      await services.db.$disconnect();
    }
  });

test('the quota judged is the account the run would use: a full account the agent is pinned to moves it, a full one it is not does not',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'account');
      // Two Claude accounts on the runner: Default with room, and "Team" at 96% of its week.
      await runnerReports(db, target, {
        engines: [
          {
            engine: 'claude', installed: true, auth: 'yes', accounts: [
              { id: 'default', home: '/home/orbit/.claude', auth: 'yes' },
              { id: 'a1b2c3d4', name: 'Team', home: '/home/orbit/.orbit/claude/a1b2c3d4', auth: 'yes' },
            ],
          },
          { engine: 'codex', installed: true, auth: 'yes' },
        ],
        planUsage: {
          ...quota(10),
          claude: {
            sevenDay: { utilization: 10, resetsAt: RESETS },
            accounts: { a1b2c3d4: { sevenDay: { utilization: 96, resetsAt: RESETS } } },
          },
        },
      });

      // The Agent runs its Claude sessions on Team.
      await services.workspaces.update(target.ownerId, target.agentId, { claudeAccount: 'a1b2c3d4' });
      const pinned = await runNow(services, target, await taskIn(db, target));
      assert.deepEqual(await routed(db, pinned), {
        applied: true, provider: 'codex', model: CODEX, effort: 'medium',
        reasons: [TIER_M, 'Engine codex: claude is at 96% of its weekly quota'],
      });

      // Automatic: a new Claude session would start on Default, which has room.
      await services.workspaces.update(target.ownerId, target.agentId, { claudeAccount: null });
      const automatic = await runNow(services, target, await taskIn(db, target));
      assert.deepEqual(await routed(db, automatic), {
        applied: true, provider: 'claude', model: SONNET, effort: 'medium', reasons: [TIER_M, OWN],
      });
    } finally {
      await services.db.$disconnect();
    }
  });

test('a verification run looks at the work with an engine the task it verifies did not last run on',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'verifier');
      // The work ran on claude: with room on it, a listed codex is no reason to leave.
      const subject = await taskIn(db, target);
      const work = await runNow(services, target, subject);
      assert.deepEqual(await routed(db, work), {
        applied: true, provider: 'claude', model: SONNET, effort: 'medium', reasons: [TIER_M, OWN],
      });
      await end(db, work, RunStatus.SUCCEEDED);

      const verifier = await taskIn(db, target, { verifiesTaskId: subject, title: 'verify the work' });
      const check = await runNow(services, target, verifier);
      assert.deepEqual(await routed(db, check), {
        applied: true, provider: 'codex', model: CODEX, effort: 'medium',
        reasons: [TIER_M, 'Engine codex: the task it verifies last ran on claude'],
      });
      assert.deepEqual(await sessionOf(db, check), { provider: 'codex', model: CODEX, effort: 'medium' });
      const features = (await decisionOf(db, check)).features as Record<string, unknown>;
      assert.deepEqual(
        { verifiesTask: features.verifiesTask, verifiedRunEngine: features.verifiedRunEngine },
        { verifiesTask: true, verifiedRunEngine: 'claude' },
      );

      // The owner takes codex off the list: the next check stays on claude — a preference, never a
      // licence to use an engine nobody listed.
      await end(db, check, RunStatus.SUCCEEDED);
      await services.workspaces.update(target.ownerId, target.agentId, { modelRoutingProviders: [] });
      const recheck = await runNow(services, target, verifier);
      assert.deepEqual(await routed(db, recheck), {
        applied: true, provider: 'claude', model: SONNET, effort: 'medium', reasons: [TIER_M, OWN],
      });
      assert.deepEqual(await sessionOf(db, recheck), { provider: 'claude', model: SONNET, effort: 'medium' });
    } finally {
      await services.db.$disconnect();
    }
  });

test('the sweep\'s quota gate judges the engine routing picks: a spent agent engine holds a run only when it is the one it would run on',
  { skip, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      // Claude's weekly window is spent until RESETS; Codex has room.
      const target = await fixture(services, 'gate', { allowed: [], started: true, planUsage: quota(100) });
      const taskId = await readyTask(db, target);

      // Nothing listed: the run would be on claude, whose quota is spent — held, nothing started.
      await sweep(services);
      assert.deepEqual(await workRuns(db, taskId), [], 'held: the run would spend a spent quota');

      // Codex listed, smart selection off: the run would still be the baseline on claude — held.
      await services.workspaces.update(target.ownerId, target.agentId, {
        modelRouting: false, modelRoutingProviders: ['codex'],
      });
      await sweep(services);
      assert.deepEqual(await workRuns(db, taskId), [], 'held: in shadow the run is claude\'s');

      // Smart selection on: routing moves the run to codex, which the gate finds with room, so it starts.
      await services.workspaces.update(target.ownerId, target.agentId, { modelRouting: true });
      await sweep(services);
      const [run] = await workRuns(db, taskId);
      assert.ok(run, 'the sweep did not start the task on the engine it would run on');
      assert.deepEqual(await sessionOf(db, run.id), { provider: 'codex', model: CODEX, effort: 'medium' });
      assert.deepEqual((await routed(db, run.id)).reasons, [TIER_M, 'Engine codex: claude is at 100% of its weekly quota']);
    } finally {
      await services.db.$disconnect();
    }
  });

test('the sweep\'s quota gate judges a task\'s provider pin, not the agent\'s seed',
  { skip, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      // Claude, the Agent's seed, has room; Codex's week is spent. Smart selection is off, so nothing is
      // routed: a run is created on the task's pin, else the seed.
      const target = await fixture(services, 'pin-gate', {
        allowed: [], routing: false, started: true, planUsage: quota(10, 100),
      });
      const pinned = await readyTask(db, target, { provider: 'codex' });
      const unpinned = await readyTask(db, target);

      await sweep(services);

      assert.deepEqual(await workRuns(db, pinned), [], 'held: it would run on codex, whose quota is spent');
      const [run] = await workRuns(db, unpinned);
      assert.ok(run, 'the unpinned task runs on the seed, which has room');
      assert.equal((await sessionOf(db, run.id)).provider, 'claude');
    } finally {
      await services.db.$disconnect();
    }
  });

test('an automatic re-run after a usage limit is held, or not, by the engine it would run on',
  { skip, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const { db } = services;
      const target = await fixture(services, 'rearm', { allowed: [], started: true });
      const taskId = await readyTask(db, target);
      await sweep(services);
      const [run1] = await workRuns(db, taskId);
      assert.ok(run1, 'the sweep did not start the task');
      assert.equal((await sessionOf(db, run1.id)).provider, 'claude');

      // Run 1 stopped at claude's weekly limit, which the runner now reports spent until RESETS.
      await end(db, run1.id, RunStatus.FAILED, WEEKLY_LIMIT);
      await runnerReports(db, target, { planUsage: quota(100) });
      const skipped = async () =>
        ((await services.tasks.get(target.ownerId, taskId)) as unknown as {
          autoRunSkipped: { code: string; retryAt: Date | null } | null;
        }).autoRunSkipped;

      // The re-run would be on claude: held until the reset, as the task read says.
      const held = await skipped();
      assert.equal(held?.code, 'QUOTA_EXHAUSTED');
      assert.equal(held?.retryAt?.toISOString(), RESETS);
      await sweep(services);
      assert.equal((await workRuns(db, taskId)).length, 1, 'held: nothing re-run');

      // The owner lists codex: the re-run would be on codex, which has room — due now.
      await services.workspaces.update(target.ownerId, target.agentId, { modelRoutingProviders: ['codex'] });
      assert.equal(await skipped(), null, 'nothing holds it');
      await sweep(services);
      const runs = await workRuns(db, taskId);
      assert.equal(runs.length, 2, 'the sweep did not re-run the task');
      assert.deepEqual(await sessionOf(db, runs[1].id), { provider: 'codex', model: CODEX, effort: 'medium' });
      assert.deepEqual((await routed(db, runs[1].id)).reasons, [
        TIER_M, 'Run 1 hit a usage limit — not counted', 'Engine codex: claude is at 100% of its weekly quota',
      ]);
    } finally {
      await services.db.$disconnect();
    }
  });
