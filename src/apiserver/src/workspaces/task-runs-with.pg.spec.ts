import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CreatorType, Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import type { RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectsService } from '../projects/projects.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { planTaskRunRoute, taskRouteReads } from '../tasks/task-route-decision';
import { TasksService } from '../tasks/tasks.service';
import type { TaskRunsWith } from './start-anchor';

/**
 * The read-only surfaces say what dispatch will use (docs/workspace-default-model-design.md, P0c):
 * the task payload's `runsWith` (TasksService.get, which web "Runs with" reads) and `GET /runner/me`
 * (`orbit status`) against what a run of the same task is actually created on, by its real door
 * (TasksService.execute), and the routing baseline (planTaskRunRoute) — for a project with a
 * coordinator, one without, and a pinned task — after a person's one-off Codex conversation moved
 * the workspace's seed.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/workspaces/task-runs-with.pg.spec.ts
 *
 * Destructive: COORDINATOR_PG_URL must pass coordinator-pg-test-safety and point at a disposable
 * database with all migrations applied.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });

const ENGINES: RunnerEngineHealth[] = [
  { engine: 'codex', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' }] },
  { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }] },
] as RunnerEngineHealth[];

const CLAUDE = { engine: 'claude', provider: 'claude' };
const CODEX = { engine: 'codex', provider: 'codex' };

test('task runsWith and orbit status say what dispatch starts the task on', {
  skip, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const db = prisma as unknown as PrismaService;
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `runs-with-${ownerId}@task-runs-with.invalid`, name: 'The owner', passwordHash: 'x' },
  });
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: 'the machine', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      engines: ENGINES as unknown as Prisma.InputJsonValue,
    },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'orbit-develop', enabled: true, workDir: '/srv/orbit' },
  });

  const queue = { notifySessionQueued: () => undefined };
  const sessions = new SessionsService(db, queue as never, silent() as never);
  const tasks = new TasksService(db, sessions, silent() as never);
  const projects = new ProjectsService(db, new ProjectAcceptanceService(db), sessions, silent() as never);
  // The runner's own door, as RunnerAuthGuard hands it the asking runner; SessionsService is its 12th.
  const runnerApi = new RunnerApiController(
    db, queue as never, silent() as never, {} as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, undefined, sessions,
  );

  let clock = Date.now() - 3_600_000;
  async function newest(id: string): Promise<void> {
    clock += 1_000;
    await prisma.session.update({ where: { id }, data: { createdAt: new Date(clock) } });
  }
  async function task(title: string, projectId: string | null, pin: { engine?: string; provider?: string } = {}) {
    return (await prisma.task.create({
      data: {
        ownerId, title, creatorType: CreatorType.USER, creatorId: ownerId, assigneeId: workspaceId,
        completionCriterion: 'EVIDENCE_JUDGMENT', projectId, ...pin,
      },
      select: { id: true },
    })).id;
  }
  async function payload(taskId: string): Promise<TaskRunsWith> {
    const read = await tasks.get(ownerId, taskId) as unknown as { runsWith: TaskRunsWith | null };
    assert.ok(read.runsWith, 'the task payload carries runsWith');
    return read.runsWith;
  }
  /** What a run of the task is created on, by the door every start of it takes. */
  async function dispatched(taskId: string) {
    const answer = await tasks.execute(ownerId, taskId) as { ok: boolean; sessionId?: string };
    assert.equal(answer.ok, true, `the run was refused: ${JSON.stringify(answer)}`);
    return prisma.session.findUniqueOrThrow({ where: { id: answer.sessionId! }, select: { engine: true, provider: true } });
  }
  /** Smart model selection's baseline for the same task. */
  async function routingBaseline(taskId: string) {
    await prisma.user.update({ where: { id: ownerId }, data: { preferences: { modelRouting: true } } });
    try {
      const subject = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
      const route = await planTaskRunRoute(taskRouteReads(db, ownerId), subject, { id: workspaceId, runnerId }, 'go');
      assert.ok(route, 'routing is on, so a route is planned');
      return { engine: route.baseline.engine, provider: route.baseline.provider };
    } finally {
      await prisma.user.update({ where: { id: ownerId }, data: { preferences: {} } });
    }
  }
  const pair = (r: { engine: string | null; provider: string | null }) => ({ engine: r.engine, provider: r.provider });

  // ── fixture: a coordinator on Claude Code, then a person's Codex question ───────────────────────────
  const withCoordinator = randomUUID();
  await prisma.project.create({ data: { id: withCoordinator, ownerId, title: 'With a coordinator', coordinatorEnabled: true } });
  const coordinator = await projects.coordinator(ownerId, withCoordinator, workspaceId);
  await newest(coordinator.sessionId);
  const withoutCoordinator = randomUUID();
  await prisma.project.create({ data: { id: withoutCoordinator, ownerId, title: 'Without a coordinator', coordinatorEnabled: true } });
  const mine = await sessions.create(ownerId, { workspaceId, prompt: 'one question on GPT', ...CODEX } as never, { source: 'user' });
  await newest(mine.id);

  const coordinated = await task('an unpinned task of the coordinated project', withCoordinator);
  const uncoordinated = await task('an unpinned task of the project with no coordinator', withoutCoordinator);
  // Pinned against its project's anchor, so the pin is what decides.
  const pinned = await task('a task pinned to Codex', withCoordinator, CODEX);

  await t.test('project with a coordinator: runsWith is the coordinator’s pair, and so is the run', async () => {
    const shown = await payload(coordinated);
    assert.deepEqual(pair(shown), CLAUDE);
    assert.equal(shown.source, 'PROJECT_COORDINATOR');
    assert.equal(shown.anchorSessionId, coordinator.sessionId);
    assert.equal(shown.refusal, null);
    assert.deepEqual(await routingBaseline(coordinated), pair(shown));
    assert.deepEqual(await dispatched(coordinated), pair(shown));
  });

  await t.test('project without a coordinator: runsWith is the workspace’s person-opened session, and so is the run', async () => {
    const shown = await payload(uncoordinated);
    assert.deepEqual(pair(shown), CODEX);
    assert.equal(shown.source, 'WORKSPACE');
    assert.equal(shown.anchorSessionId, null);
    assert.deepEqual(await routingBaseline(uncoordinated), pair(shown));
    assert.deepEqual(await dispatched(uncoordinated), pair(shown));
  });

  await t.test('pinned task: runsWith is the pin, and so is the run', async () => {
    const shown = await payload(pinned);
    assert.deepEqual(pair(shown), CODEX);
    assert.equal(shown.source, 'TASK_PIN');
    assert.deepEqual(await dispatched(pinned), pair(shown));
  });

  await t.test('orbit status (GET /runner/me) says the same per project, pins set aside', async () => {
    const fresh = {
      coordinated: await task('another unpinned task of the coordinated project', withCoordinator),
      uncoordinated: await task('another unpinned task of the project with no coordinator', withoutCoordinator),
    };
    const runner = await prisma.runner.findUniqueOrThrow({ where: { id: runnerId } });
    const me = await runnerApi.me(runner) as unknown as {
      workspaces: Array<{
        id: string;
        runsWith?: TaskRunsWith;
        projects?: Array<{ id: string; title: string; runsWith: TaskRunsWith }>;
      }>;
    };
    const ws = me.workspaces.find((w) => w.id === workspaceId);
    assert.ok(ws?.runsWith && ws.projects, JSON.stringify(me));
    // Outside any project: the workspace's person-opened session.
    assert.deepEqual(pair(ws.runsWith), CODEX);
    assert.equal(ws.runsWith.source, 'WORKSPACE');
    const of = (id: string) => ws.projects!.find((p) => p.id === id)?.runsWith;
    assert.deepEqual(of(withCoordinator), await payload(fresh.coordinated));
    assert.deepEqual(of(withoutCoordinator), await payload(fresh.uncoordinated));
    assert.deepEqual(pair(of(withCoordinator)!), pair(await dispatched(fresh.coordinated)));
    assert.deepEqual(pair(of(withoutCoordinator)!), pair(await dispatched(fresh.uncoordinated)));
  });
});
