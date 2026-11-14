import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CreatorType, Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import type { RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { dependentReadyFact } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectsService } from '../projects/projects.service';
import { encryptSecret } from '../providers/provider-crypto';
import { SessionsService } from '../sessions/sessions.service';
import { planTaskRunRoute, taskRouteReads } from '../tasks/task-route-decision';
import { TasksService } from '../tasks/tasks.service';
import { WorkspacesService } from './workspaces.service';

/**
 * The 2026-11-13 incident, against a real PostgreSQL (docs/workspace-default-model-design.md §0,
 * §2.1–§2.3): a project's coordinator runs on Claude Code, a person opens one Codex conversation in the
 * same workspace — and the project's next unpinned task run, a re-created coordinator, a coordinator
 * judgment and an MCP child of the coordinator must all still start on claude/claude.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/workspaces/start-anchor.pg.spec.ts
 *
 * Every start goes through its real door (TasksService.execute, ProjectsService.coordinator,
 * CoordinatorJudgmentService.wake, SessionsService.spawnFromSession) and the assertion reads the new
 * session row's engine and provider. The quota gate's plan (dispatchEngines) and the routing baseline
 * (planTaskRunRoute) are read for the same task. Then: a project with no coordinator falls back to the
 * person's conversation, and an anchor on a disabled key is refused in words naming that session.
 *
 * Destructive: COORDINATOR_PG_URL must pass coordinator-pg-test-safety and point at a disposable
 * database with all migrations applied.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
process.env.PROVIDER_SECRET_KEY ??= 'start-anchor-pg-spec';

const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });
const allow = async () => ({ allowed: true as const });

const ENGINES: RunnerEngineHealth[] = [
  { engine: 'codex', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' }] },
  { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }] },
] as RunnerEngineHealth[];

const CLAUDE = { engine: 'claude', provider: 'claude' };
const CODEX = { engine: 'codex', provider: 'codex' };

test('project work follows its coordinator, not a person’s one-off Codex conversation', {
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
    data: { id: ownerId, email: `anchor-${ownerId}@start-anchor.invalid`, name: 'The owner', passwordHash: 'x' },
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
  const workspaces = new WorkspacesService(db);

  let clock = Date.now() - 3_600_000;
  async function newest(id: string): Promise<void> {
    clock += 1_000;
    await prisma.session.update({ where: { id }, data: { createdAt: new Date(clock) } });
  }
  async function pairOf(id: string) {
    return prisma.session.findUniqueOrThrow({ where: { id }, select: { engine: true, provider: true } });
  }
  async function task(title: string, projectId: string | null): Promise<string> {
    return (await prisma.task.create({
      data: {
        ownerId, title, creatorType: CreatorType.USER, creatorId: ownerId, assigneeId: workspaceId,
        completionCriterion: 'EVIDENCE_JUDGMENT', projectId,
      },
      select: { id: true },
    })).id;
  }
  async function run(taskId: string): Promise<string> {
    const answer = await tasks.execute(ownerId, taskId) as { ok: boolean; sessionId?: string };
    assert.equal(answer.ok, true, `the run was refused: ${JSON.stringify(answer)}`);
    return answer.sessionId!;
  }
  /** What the sweep's quota gate plans this task's next fresh run on. */
  async function quotaGatePlan(taskId: string): Promise<{ provider: string; login: boolean } | undefined> {
    const engines = await (tasks as unknown as {
      dispatchEngines: (rows: unknown[]) => Promise<Map<string, { provider: string; login: boolean }>>;
    }).dispatchEngines([{ id: taskId, ownerId, workspaceId, runnerId, taskEngine: null, taskProvider: null, modelRouting: false }]);
    return engines.get(taskId);
  }

  // ── the incident ─────────────────────────────────────────────────────────────────────────────────
  const projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, ownerId, title: 'Unattended work', coordinatorEnabled: true } });
  let coordinatorId = '';

  await t.test('the coordinator opens on claude/claude', async () => {
    const opened = await projects.coordinator(ownerId, projectId, workspaceId);
    assert.equal(opened.created, true);
    coordinatorId = opened.sessionId;
    await newest(coordinatorId);
    assert.deepEqual(await pairOf(coordinatorId), CLAUDE);
  });

  await t.test('a person opens a Codex conversation in the same workspace: the workspace default is Codex', async () => {
    const mine = await sessions.create(ownerId, { workspaceId, prompt: 'one question on GPT', ...CODEX } as never, { source: 'user' });
    await newest(mine.id);
    const payload = await workspaces.get(ownerId, workspaceId) as unknown as { lastEngine: string; lastProvider: string };
    assert.deepEqual({ engine: payload.lastEngine, provider: payload.lastProvider }, CODEX,
      'the seed itself moved — every start below would read Codex if it read the seed');
  });

  await t.test('the project’s next unpinned task run starts on the coordinator’s claude/claude', async () => {
    const unpinned = await task('the next unpinned task', projectId);
    assert.deepEqual(await quotaGatePlan(unpinned), { provider: 'claude', login: true },
      'the quota gate plans the run on the coordinator’s credential');
    const sessionId = await run(unpinned);
    assert.deepEqual(await pairOf(sessionId), CLAUDE);
  });

  await t.test('with smart model selection on, routing starts from the coordinator’s pair', async () => {
    await prisma.user.update({ where: { id: ownerId }, data: { preferences: { modelRouting: true } } });
    try {
      const routed = await task('a routed task', projectId);
      const subject = await prisma.task.findUniqueOrThrow({ where: { id: routed } });
      const route = await planTaskRunRoute(taskRouteReads(db, ownerId), subject, { id: workspaceId, runnerId }, 'go');
      assert.ok(route, 'routing is on, so a route is planned');
      assert.equal(route.baseline.engine, 'claude', JSON.stringify(route.baseline));
      assert.equal(route.baseline.provider, 'claude', JSON.stringify(route.baseline));
    } finally {
      await prisma.user.update({ where: { id: ownerId }, data: { preferences: {} } });
    }
  });

  await t.test('an MCP child of the coordinator, naming no engine, starts on claude/claude', async () => {
    const child = await sessions.spawnFromSession(ownerId, coordinatorId, { prompt: 'look into it', workspaceId });
    assert.deepEqual({ engine: child.engine, provider: child.provider }, CLAUDE);
    assert.deepEqual(await pairOf(child.id), CLAUDE);
  });

  await t.test('a coordinator judgment starts on claude/claude', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { coordinatorWorkspaceId: workspaceId } });
    const ready = await task('Judge whether it can start', projectId);
    const judgments = new CoordinatorJudgmentService(db, new CoordinatorWakeService(db), sessions);
    const outcome = await judgments.wake(
      dependentReadyFact({ projectId, taskId: ready, title: 'Judge whether it can start', dispatchEpoch: 1 }), allow,
    );
    assert.equal(outcome.outcome, 'OPENED', JSON.stringify(outcome));
    assert.deepEqual(await pairOf((outcome as { sessionId: string }).sessionId), CLAUDE);
  });

  await t.test('a re-created coordinator (the old one trashed) starts on claude/claude', async () => {
    await prisma.session.update({ where: { id: coordinatorId }, data: { deletedAt: new Date() } });
    const reopened = await projects.coordinator(ownerId, projectId, workspaceId);
    assert.equal(reopened.created, true);
    assert.notEqual(reopened.sessionId, coordinatorId);
    assert.deepEqual(await pairOf(reopened.sessionId), CLAUDE);
    coordinatorId = reopened.sessionId;
  });

  await t.test('a replacing coordinator starts on claude/claude', async () => {
    const replaced = await projects.coordinator(ownerId, projectId, undefined, 'replace');
    assert.equal(replaced.created, true);
    assert.notEqual(replaced.sessionId, coordinatorId);
    assert.deepEqual(await pairOf(replaced.sessionId), CLAUDE);
  });

  // ── no anchor ────────────────────────────────────────────────────────────────────────────────────
  await t.test('a project with no coordinator falls back to the person’s conversation', async () => {
    const plain = randomUUID();
    await prisma.project.create({ data: { id: plain, ownerId, title: 'No coordinator', coordinatorEnabled: true } });
    const unpinned = await task('a task of a project with no coordinator', plain);
    assert.deepEqual(await quotaGatePlan(unpinned), { provider: 'codex', login: true });
    assert.deepEqual(await pairOf(await run(unpinned)), CODEX);

    // Coordination switched off counts as none, even with a coordinator session on record.
    const off = randomUUID();
    await prisma.project.create({ data: { id: off, ownerId, title: 'Coordination off', coordinatorEnabled: false } });
    const offCoordinator = await projects.coordinator(ownerId, off, workspaceId);
    const offTask = await task('a task of a project with coordination off', off);
    assert.ok((await prisma.project.findUniqueOrThrow({ where: { id: off } })).coordinatorSessionId === offCoordinator.sessionId);
    assert.deepEqual(await pairOf(await run(offTask)), CODEX);

    // And a task outside any project.
    assert.deepEqual(await pairOf(await run(await task('a task outside any project', null))), CODEX);
  });

  // ── an anchor whose credential is gone ───────────────────────────────────────────────────────────
  await t.test('an anchor on a disabled key is refused, naming the session; nothing switches engine', async () => {
    const key = await prisma.modelProvider.create({
      data: {
        slug: `anchor-key-${randomUUID().slice(0, 8)}`, label: 'Anthropic key', runtime: 'claude',
        baseUrl: 'https://api.anthropic.com', apiKeyEnc: encryptSecret('sk-ant-test'), ownerId,
      },
    });
    const keyed = randomUUID();
    await prisma.project.create({ data: { id: keyed, ownerId, title: 'Keyed project', coordinatorEnabled: true } });
    // A coordinator a person put on that key on Claude Code. A first coordinator opens on the workspace
    // seed — Codex by now — so the row is written onto the key as a fixture, past the trigger that keeps
    // a session's engine fixed (this connection alone, as workspace-default-opened-by.pg.spec.ts does).
    const opened = await projects.coordinator(ownerId, keyed, workspaceId);
    await sql.query('BEGIN');
    try {
      await sql.query("SET LOCAL session_replication_role = 'replica'");
      await sql.query(
        'UPDATE "session" SET "engine" = \'claude\', "provider" = $2, "provider_builtin" = false WHERE "id" = $1::uuid',
        [opened.sessionId, key.slug],
      );
      await sql.query('COMMIT');
    } catch (e) {
      await sql.query('ROLLBACK');
      throw e;
    }
    const title = (await prisma.session.findUniqueOrThrow({ where: { id: opened.sessionId }, select: { title: true } })).title;

    // While the key is on, the task runs on it.
    const before = await task('a task while the key is on', keyed);
    assert.deepEqual(await pairOf(await run(before)), { engine: 'claude', provider: key.slug });

    await prisma.modelProvider.update({ where: { id: key.id }, data: { enabled: false } });
    const sessionsBefore = await prisma.session.count({ where: { ownerId } });

    const refused = await task('a task after the key was disabled', keyed);
    const answer = await tasks.execute(ownerId, refused).then(
      (a) => JSON.stringify(a),
      (e: { message?: string; getResponse?: () => unknown }) => JSON.stringify(e.getResponse?.() ?? e.message),
    );
    assert.match(answer, /the project's coordinator session/, answer);
    assert.ok(answer.includes(title), `the refusal names the session "${title}": ${answer}`);
    assert.match(answer, /no longer available/, answer);

    await assert.rejects(
      sessions.spawnFromSession(ownerId, opened.sessionId, { prompt: 'a child', workspaceId }),
      (e: { getResponse: () => { message: string; code: string } }) => {
        const body = e.getResponse();
        assert.equal(body.code, 'ANCHOR_CREDENTIAL_UNAVAILABLE');
        assert.match(body.message, /^the parent session ".+" runs on a credential that is no longer available/);
        assert.ok(body.message.includes(title), body.message);
        return true;
      },
    );

    await assert.rejects(
      projects.coordinator(ownerId, keyed, undefined, 'replace'),
      (e: Error & { getResponse?: () => unknown }) => {
        const text = JSON.stringify(e.getResponse?.() ?? e.message);
        assert.match(text, /the project's previous coordinator session/, text);
        assert.ok(text.includes(title), text);
        return true;
      },
    );

    // Nothing started anywhere, on Codex or otherwise.
    assert.equal(await prisma.session.count({ where: { ownerId } }), sessionsBefore);
  });
});
