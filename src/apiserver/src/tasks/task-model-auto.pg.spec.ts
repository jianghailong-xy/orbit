/**
 * A task runs only on a model that has Auto, and a pin to one without is refused when it is made
 * (owner rulings R1, R2; project 350NMcNDulzkqRAFFUsXZ, criterion 6F586VdqZSeVZBmveTMXYF).
 *
 * Driven through the doors the MCP tools, the REST API and the CLI all reach (TasksService create,
 * createMany/previewPlan, update, pinMany, execute, the auto-run and scheduled sweeps), on a real
 * PostgreSQL, with every run claimed through QueueService the way a runner claims it. Each fixture's
 * runner reports Claude Code signed in and a catalogue in which Opus 5.5 and Sonnet 5.5 have Auto and
 * Haiku 4.5 does not — the per-model answer the runner's probe gives (claude_models.go).
 *
 *  (1) create: a pin with Auto is written; one without is refused with TASK_MODEL_HAS_NO_AUTO, a
 *      reason naming the model and models that have Auto, and no row. A model pinned alone is judged
 *      on the engine the assignee's seed gives it; the same model on Cursor CLI, whose Auto is
 *      runtime-wide, is written.
 *  (2) batch create and its dry run: the item without Auto refuses the whole batch, naming its index.
 *  (3) update: a re-pin without Auto is refused and the stored pin stays; so is a move of a pinned task
 *      to an assignee whose runner withholds Auto from that model.
 *  (4) batch pin: a model without Auto is refused for the whole selection, and nothing is written.
 *  (5) hand start (Run Now / task_start): a stored pin from before the rule is refused before any
 *      session exists; a pin with Auto starts, stored and claimed in Auto.
 *  (6) automatic start, dependency sweep: the same pin is not started, no session is created, and the
 *      reason is left on the task once; re-pinned to a model with Auto, the next sweep starts it in Auto.
 *      A refused task does not keep its runner's slot from the task after it in the same pass.
 *  (7) automatic start, runAt: the same, for a due schedule.
 *  (8) the runtime default: a run that names no model on a runner whose default has no Auto is created
 *      on the runner's first model that has it, by hand and by the sweep; a default with Auto is kept.
 *  (9) routing: with smart selection on, the run is never created or claimed on the model without Auto.
 *
 * The code is written here as a literal rather than imported, so this file compiles on a tree without
 * the rule and its cases go red there instead of failing to build.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server:
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-model-auto.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { HttpException } from '@nestjs/common';
import { CreatorType, Prisma, PrismaClient, RunnerStatus, TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);

const CODE = 'TASK_MODEL_HAS_NO_AUTO';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';
const WITH_AUTO = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const WITHOUT_AUTO = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

type Row = [model: string, modes: string[]];
const STANDARD: Row[] = [[OPUS, WITH_AUTO], [SONNET, WITH_AUTO], [HAIKU, WITHOUT_AUTO]];

const signedIn = [{ engine: 'claude', installed: true, version: '2.1.300', auth: 'yes' }] as unknown as Prisma.InputJsonValue;

interface Harness {
  db: PrismaClient;
  tasks: TasksService;
  queue: QueueService;
  logs: string[];
  warns: string[];
}

function connect(): Harness {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    quiet,
  );
  const tasks = new TasksService(prisma, sessions, quiet);
  const h: Harness = { db, tasks, queue: new QueueService(prisma, quiet), logs: [], warns: [] };
  (tasks as unknown as { logger: unknown }).logger = {
    log: (m: string) => h.logs.push(m),
    warn: (m: string) => h.warns.push(m),
    error: (m: string) => h.warns.push(m),
    debug: () => undefined,
    verbose: () => undefined,
  };
  return h;
}

interface Agent {
  ownerId: string;
  runnerId: string;
  runnerName: string;
  workspaceId: string;
}

/** An account (its default mode Default, so Auto is never the account's doing), a runner reporting
 *  Claude Code signed in with this catalogue and default, and a workspace on it. */
async function agent(
  db: PrismaClient,
  label: string,
  opts: { rows?: Row[]; runtimeDefault?: string; modelRouting?: boolean; ownerId?: string; maxConcurrent?: number } = {},
): Promise<Agent> {
  const ownerId = opts.ownerId ?? randomUUID();
  if (!opts.ownerId) {
    await db.user.create({
      data: {
        id: ownerId, email: `${label}-${RUN}-${ownerId}@model-auto.invalid`, name: label, passwordHash: 'x',
        preferences: {
          defaultPermissionMode: 'default',
          modelRouting: opts.modelRouting ?? false,
          ...(opts.modelRouting ? { optimizeFor: 'cost' } : {}),
        },
      },
    });
  }
  const runnerId = randomUUID();
  const runnerName = `${label}-${RUN}-runner`;
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: runnerName, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(), maxConcurrent: opts.maxConcurrent ?? 8, engines: signedIn,
      runtimeDefaultModels: { claude: opts.runtimeDefault ?? OPUS },
      modelCatalog: {
        claude: (opts.rows ?? STANDARD).map(([value, permissionModes], priority) => ({
          value, label: value, priority, permissionModes,
        })),
      },
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-${RUN}`, enabled: true } });
  return { ownerId, runnerId, runnerName, workspaceId };
}

/** A task row written directly, as one pinned before the rule existed was. Not auto-run unless asked. */
async function storedTask(
  db: PrismaClient,
  a: Agent,
  title: string,
  extra: Partial<Prisma.TaskUncheckedCreateInput> = {},
): Promise<string> {
  const task = await db.task.create({
    data: {
      ownerId: a.ownerId, assigneeId: a.workspaceId, title: `${title}-${RUN}`, creatorType: CreatorType.USER,
      creatorId: a.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN,
      autoRunWhenReady: false, dispatchHold: false, ...extra,
    },
  });
  return task.id;
}

/** What a create through the API sends for one task on this agent: in no project, so a declaration that
 *  may stand there (EXECUTABLE; EVIDENCE_JUDGMENT is refused outside a project). */
const createDto = (a: Agent, title: string, pins: { engine?: string; provider?: string; model?: string }) => ({
  title: `${title}-${RUN}`,
  assigneeId: a.workspaceId,
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
  autoRunWhenReady: false,
  ...pins,
});

interface RefusalView {
  statusCode?: number;
  code?: string;
  message?: string;
  model?: string | null;
  runner?: string | null;
  autoModels?: string[];
  itemIndex?: number;
  taskId?: string;
}

/** The structured body of the refusal `run` must end in. */
async function refusalOf(run: () => Promise<unknown>): Promise<RefusalView> {
  let outcome: unknown;
  try {
    outcome = await run();
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected a refusal, got ${error instanceof Error ? error.stack : error}`);
    const body = error.getResponse();
    assert.ok(body && typeof body === 'object', `expected a structured refusal, got ${JSON.stringify(body)}`);
    return body as RefusalView;
  }
  throw new assert.AssertionError({ message: `expected a refusal; it was accepted: ${JSON.stringify(outcome)}` });
}

/** The refusal names its code, the model, the runner and the models to pick instead. */
function assertNoAutoRefusal(body: RefusalView, a: Agent, model = HAIKU): void {
  assert.equal(body.statusCode, 400, JSON.stringify(body));
  assert.equal(body.code, CODE, JSON.stringify(body));
  assert.equal(body.model, model);
  assert.equal(body.runner, a.runnerName);
  assert.ok(body.message?.includes(model), `the reason does not name ${model}: ${body.message}`);
  assert.ok(body.message?.includes(`runner "${a.runnerName}"`), `the reason does not name the runner: ${body.message}`);
  assert.ok(body.message?.includes(OPUS) && body.message.includes(SONNET),
    `the reason does not name what to pick instead: ${body.message}`);
  assert.ok(body.autoModels?.includes(OPUS) && !body.autoModels.includes(HAIKU), JSON.stringify(body.autoModels));
}

const sessionsOf = (db: PrismaClient, taskId: string) => db.session.count({ where: { taskId } });
const tasksTitled = (db: PrismaClient, title: string) => db.task.count({ where: { title: `${title}-${RUN}` } });
const sweep = (h: Harness) => (h.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();
const scheduledSweep = (h: Harness) =>
  (h.tasks as unknown as { dispatchDueScheduledTasks(): Promise<void> }).dispatchDueScheduledTasks();

/** The task's run, claimed by its runner: the model and mode the runner is handed. */
async function claimed(h: Harness, a: Agent, taskId: string) {
  const run = await h.db.session.findFirstOrThrow({ where: { taskId } });
  const claim = await h.queue.claimSessionForRunner({ id: a.runnerId });
  assert.equal(claim?.sessionId, run.id, 'the runner claimed another session');
  return { run, model: claim!.agent.model, permissionMode: claim!.agent.permissionMode };
}

async function noAutoComments(db: PrismaClient, taskId: string) {
  return db.taskComment.findMany({ where: { taskId, body: { contains: CODE } }, select: { body: true } });
}

test('task create, pin and start keep every task run on a model that has Auto', { skip, timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const h = connect();
  t.after(() => h.db.$disconnect());

  await t.test('(1) create: a pin with Auto is written, one without is refused with its reason and writes nothing', async () => {
    const a = await agent(h.db, 'create');
    const written = await h.tasks.create(a.ownerId, createDto(a, 'create-opus', { provider: 'claude', model: OPUS }) as never);
    assert.equal((await h.db.task.findUniqueOrThrow({ where: { id: (written as { id: string }).id } })).model, OPUS);

    assertNoAutoRefusal(await refusalOf(() =>
      h.tasks.create(a.ownerId, createDto(a, 'create-haiku', { provider: 'claude', model: HAIKU }) as never)), a);
    assert.equal(await tasksTitled(h.db, 'create-haiku'), 0, 'a refused create wrote a task');

    // A model pinned alone runs on the engine the assignee's seed gives it: Claude Code, where it has no Auto.
    assertNoAutoRefusal(await refusalOf(() =>
      h.tasks.create(a.ownerId, createDto(a, 'create-haiku-alone', { model: HAIKU }) as never)), a);
    assert.equal(await tasksTitled(h.db, 'create-haiku-alone'), 0);

    // Cursor CLI's Auto is runtime-wide (permissionSemantics.ts autoAvailable): the same model is not refused there.
    await h.tasks.create(a.ownerId, createDto(a, 'create-cursor', { engine: 'cursor', provider: 'cursor', model: HAIKU }) as never);
    assert.equal(await tasksTitled(h.db, 'create-cursor'), 1);
  });

  await t.test('(2) batch create and its dry run: the item without Auto refuses the whole batch', async () => {
    const a = await agent(h.db, 'batch');
    const plan = {
      tasks: [
        createDto(a, 'batch-opus', { provider: 'claude', model: OPUS }),
        createDto(a, 'batch-haiku', { provider: 'claude', model: HAIKU }),
      ],
    };
    const refused = await refusalOf(() => h.tasks.createMany(a.ownerId, plan as never));
    assertNoAutoRefusal(refused, a);
    assert.equal(refused.itemIndex, 1);
    assert.ok(refused.message?.startsWith('tasks[1]: '), String(refused.message));
    assert.equal(await tasksTitled(h.db, 'batch-opus') + await tasksTitled(h.db, 'batch-haiku'), 0,
      'a refused batch wrote some of its tasks');
    assertNoAutoRefusal(await refusalOf(() => h.tasks.previewPlan(a.ownerId, plan as never)), a);

    await h.tasks.createMany(a.ownerId, {
      tasks: [plan.tasks[0], createDto(a, 'batch-sonnet', { provider: 'claude', model: SONNET })],
    } as never);
    assert.equal(await tasksTitled(h.db, 'batch-opus') + await tasksTitled(h.db, 'batch-sonnet'), 2);
  });

  await t.test('(3) update: a re-pin or a move to a runner without Auto for the pin is refused, and the pin stays', async () => {
    const a = await agent(h.db, 'update');
    const id = (await h.tasks.create(a.ownerId, createDto(a, 'update', { provider: 'claude', model: OPUS }) as never) as { id: string }).id;
    await h.tasks.update(a.ownerId, id, { model: SONNET } as never);
    assert.equal((await h.db.task.findUniqueOrThrow({ where: { id } })).model, SONNET);

    const refused = await refusalOf(() => h.tasks.update(a.ownerId, id, { model: HAIKU } as never));
    assertNoAutoRefusal(refused, a);
    assert.equal(refused.taskId, id);
    assert.equal((await h.db.task.findUniqueOrThrow({ where: { id } })).model, SONNET, 'the refused pin was written');

    // The same account's second runner, whose CLI withholds Auto from Sonnet 5.5.
    const older = await agent(h.db, 'update-older', {
      ownerId: a.ownerId, rows: [[OPUS, WITH_AUTO], [SONNET, WITHOUT_AUTO]],
    });
    const moved = await refusalOf(() => h.tasks.update(a.ownerId, id, { assigneeId: older.workspaceId } as never));
    assert.equal(moved.code, CODE);
    assert.equal(moved.model, SONNET);
    assert.equal(moved.runner, older.runnerName);
    assert.equal((await h.db.task.findUniqueOrThrow({ where: { id } })).assigneeId, a.workspaceId, 'the refused move was written');
  });

  await t.test('(4) batch pin: a model without Auto is refused for the whole selection, and nothing is written', async () => {
    const a = await agent(h.db, 'pin');
    const ids = [await storedTask(h.db, a, 'pin-1', { provider: 'claude', engine: 'claude', model: OPUS }),
      await storedTask(h.db, a, 'pin-2', { provider: 'claude', engine: 'claude', model: OPUS })];
    const refused = await refusalOf(() => h.tasks.pinMany(a.ownerId, { taskIds: ids, model: HAIKU }));
    assertNoAutoRefusal(refused, a);
    assert.match(refused.message ?? '', /2 of the selected tasks would run on it\.$/);
    for (const id of ids) assert.equal((await h.db.task.findUniqueOrThrow({ where: { id } })).model, OPUS);

    assert.deepEqual(await h.tasks.pinMany(a.ownerId, { taskIds: ids, model: SONNET }), { changed: 2 });
  });

  await t.test('(5) hand start: a stored pin without Auto is refused before any session; one with Auto runs in Auto', async () => {
    const a = await agent(h.db, 'hand');
    const legacy = await storedTask(h.db, a, 'hand-haiku', { provider: 'claude', engine: 'claude', model: HAIKU });
    const refused = await refusalOf(() => h.tasks.execute(a.ownerId, legacy));
    assertNoAutoRefusal(refused, a);
    assert.equal(refused.taskId, legacy);
    assert.match(refused.message ?? '', /this task is pinned to claude-haiku-4-5, which has no Auto on runner/);
    assert.match(refused.message ?? '', /then start the task again\.$/);
    assert.equal(await sessionsOf(h.db, legacy), 0, 'a refused start created a session');

    const pinned = await storedTask(h.db, a, 'hand-opus', { provider: 'claude', engine: 'claude', model: OPUS });
    const started = await h.tasks.execute(a.ownerId, pinned);
    assert.ok(started.sessionId, JSON.stringify(started));
    const { run, model, permissionMode } = await claimed(h, a, pinned);
    assert.equal(run.permissionMode, 'auto');
    assert.equal(model, OPUS);
    assert.equal(permissionMode, 'auto', 'the hand-started run was not claimed in Auto');
  });

  await t.test('(6) dependency sweep: the pin without Auto is not started and says why once; re-pinned, it starts in Auto', async () => {
    const a = await agent(h.db, 'sweep');
    const prerequisite = await storedTask(h.db, a, 'sweep-prereq', { status: TaskStatus.DONE, assigneeId: null });
    const legacy = await storedTask(h.db, a, 'sweep-haiku', {
      provider: 'claude', engine: 'claude', model: HAIKU, autoRunWhenReady: true,
    });
    await h.db.taskDependency.create({ data: { taskId: legacy, dependsOnTaskId: prerequisite } });

    await sweep(h);
    await sweep(h);
    assert.equal(await sessionsOf(h.db, legacy), 0, 'the sweep created a session for a model without Auto');
    const comments = await noAutoComments(h.db, legacy);
    assert.equal(comments.length, 1, `expected the reason once, got ${JSON.stringify(comments)}`);
    assert.ok(comments[0].body.includes(HAIKU) && comments[0].body.includes(OPUS), comments[0].body);
    assert.match(comments[0].body, /this task is pinned to claude-haiku-4-5, which has no Auto on runner/);
    assert.deepEqual(h.warns.filter((m) => m.includes(legacy)), [], 'the sweep warned per task on every pass');
    assert.ok(h.logs.some((m) => /auto-run: 1 ready task\(s\) not started — their model has no Auto/.test(m)),
      JSON.stringify(h.logs.filter((m) => m.startsWith('auto-run'))));

    await h.tasks.update(a.ownerId, legacy, { model: SONNET } as never);
    await sweep(h);
    assert.equal(await sessionsOf(h.db, legacy), 1, 'the re-pinned task was not started');
    const { run, model, permissionMode } = await claimed(h, a, legacy);
    assert.equal(run.permissionMode, 'auto');
    assert.equal(model, SONNET);
    assert.equal(permissionMode, 'auto', 'the auto-dispatched run was not claimed in Auto');
  });

  await t.test("(6b) a refused task does not keep its runner's only slot from the next task in the pass", async () => {
    const a = await agent(h.db, 'slot', { maxConcurrent: 1 });
    const prerequisite = await storedTask(h.db, a, 'slot-prereq', { status: TaskStatus.DONE, assigneeId: null });
    const legacy = await storedTask(h.db, a, 'slot-haiku', {
      provider: 'claude', engine: 'claude', model: HAIKU, autoRunWhenReady: true,
    });
    const pinned = await storedTask(h.db, a, 'slot-opus', {
      provider: 'claude', engine: 'claude', model: OPUS, autoRunWhenReady: true,
    });
    for (const taskId of [legacy, pinned]) {
      await h.db.taskDependency.create({ data: { taskId, dependsOnTaskId: prerequisite } });
    }
    await sweep(h);
    assert.equal(await sessionsOf(h.db, legacy), 0);
    assert.equal(await sessionsOf(h.db, pinned), 1, 'the refused task kept the runner slot from the task after it');
  });

  await t.test('(7) runAt: a due schedule on a pin without Auto starts nothing and says why; one with Auto starts', async () => {
    const a = await agent(h.db, 'runat');
    const due = new Date(Date.now() - 60_000);
    const legacy = await storedTask(h.db, a, 'runat-haiku', { provider: 'claude', engine: 'claude', model: HAIKU, runAt: due });
    await scheduledSweep(h);
    assert.equal(await sessionsOf(h.db, legacy), 0, 'the schedule started a model without Auto');
    assert.equal((await noAutoComments(h.db, legacy)).length, 1);
    assert.ok((await h.db.task.findUniqueOrThrow({ where: { id: legacy } })).runAt, 'the schedule was spent on a refused start');

    const pinned = await storedTask(h.db, a, 'runat-opus', { provider: 'claude', engine: 'claude', model: OPUS, runAt: due });
    await scheduledSweep(h);
    assert.equal(await sessionsOf(h.db, pinned), 1);
    const { model, permissionMode } = await claimed(h, a, pinned);
    assert.equal(model, OPUS);
    assert.equal(permissionMode, 'auto');
  });

  await t.test("(8) the runtime default: a default without Auto gives way to the runner's first model with Auto", async () => {
    const a = await agent(h.db, 'default', {
      rows: [[HAIKU, WITHOUT_AUTO], [SONNET, WITH_AUTO], [OPUS, WITH_AUTO]], runtimeDefault: HAIKU,
    });
    const byHand = await storedTask(h.db, a, 'default-hand');
    await h.tasks.execute(a.ownerId, byHand);
    const hand = await claimed(h, a, byHand);
    assert.equal(hand.run.model, SONNET, 'the run was left to a runtime default without Auto');
    assert.equal(hand.model, SONNET);
    assert.equal(hand.permissionMode, 'auto');

    const prerequisite = await storedTask(h.db, a, 'default-prereq', { status: TaskStatus.DONE, assigneeId: null });
    const automatic = await storedTask(h.db, a, 'default-auto', { autoRunWhenReady: true });
    await h.db.taskDependency.create({ data: { taskId: automatic, dependsOnTaskId: prerequisite } });
    await sweep(h);
    const swept = await claimed(h, a, automatic);
    assert.equal(swept.model, SONNET);
    assert.equal(swept.permissionMode, 'auto');

    // A default with Auto is the runner's to keep: the run names no model, and the claim runs that default.
    const b = await agent(h.db, 'default-kept');
    const kept = await storedTask(h.db, b, 'default-kept');
    await h.tasks.execute(b.ownerId, kept);
    const claim = await claimed(h, b, kept);
    assert.equal(claim.run.model, null);
    assert.equal(claim.model, OPUS);
    assert.equal(claim.permissionMode, 'auto');
  });

  await t.test('(9) routing: with smart selection on, the run is not created or claimed on the model without Auto', async () => {
    const a = await agent(h.db, 'routed', {
      rows: [[OPUS, WITH_AUTO], [SONNET, WITHOUT_AUTO]], runtimeDefault: SONNET, modelRouting: true,
    });
    // Tier M asks for Sonnet, which has no Auto on this runner.
    const routed = await storedTask(h.db, a, 'routed', { provider: 'claude', engine: 'claude', modelHint: 'M' });
    await h.tasks.execute(a.ownerId, routed);
    const decision = await h.db.taskRouteDecision.findFirst({ where: { taskId: routed } });
    assert.notEqual(decision?.model, SONNET, JSON.stringify(decision));
    const { run, model, permissionMode } = await claimed(h, a, routed);
    assert.notEqual(run.model, SONNET);
    assert.equal(model, OPUS);
    assert.equal(permissionMode, 'auto');
  });
});
