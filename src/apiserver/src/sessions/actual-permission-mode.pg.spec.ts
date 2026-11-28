/**
 * THE OWNER'S MODE STAYS WHAT THEY PICKED; THE MODE RUNNING IS A RECORDED FACT; THE CEILING READS IT.
 *
 * Project 350NMcNDulzkqRAFFUsXZ, criterion 2V4yjx4YWd9EJr0tK9oiWM (owner ruling R3). On real PostgreSQL, through the
 * production doors (QueueService's claim, SessionsService.updateConfig, the runner inbox, /events and
 * /turn-complete):
 *
 *   (1) A Claude session in Auto moved to a model with no Auto and back keeps Auto as its stored mode; the engine is
 *       told Default and then Auto, and the actual mode follows each acknowledgement, naming the owner's app.
 *   (2) The actual mode follows what the engine says: the claim's mode, Claude Code's init frame (ENGINE_REPORT), the
 *       init frame after a re-spawn (RESPAWN) and a runner's correction (RUNNER_CORRECTION). A report that restates
 *       the recorded mode records nothing. For Codex, which reports no mode, it is the mode handed at claim and on a
 *       reload, and its own report is not read.
 *   (3) Every change is one session_permission_mode_change row naming its cause, and the session detail and list
 *       carry the actual mode beside the intent.
 *   (4) The mode ceiling rules judge the starting session by the mode it runs in: stored Auto running Default may not
 *       start an Auto session or reach a wider one; stored Default running Auto may; with no actual mode recorded the
 *       stored mode decides.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/actual-permission-mode.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  AgentProvider,
  PERMISSION_MODE_CORRECTED_EVENT_SUBTYPE,
  PermissionMode,
  RunEventType,
  RunStatus as SharedRunStatus,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { Client } from 'pg';

import { PERMISSION_MODE_WIDER_THAN_SESSION, SESSION_WIDER_THAN_CALLER } from '../common/permission-mode';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { sessionLease } from '../test-support/dequeue-under-lease';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A Claude model with Auto, and one whose catalogue row withholds it (as the runner's probe reports one). */
const WITH_AUTO = 'claude-opus-5-5';
const WITHOUT_AUTO = 'claude-haiku-5-5';
const ALL_BUT_AUTO = [
  PermissionMode.DEFAULT, PermissionMode.ACCEPT_EDITS, PermissionMode.PLAN, PermissionMode.DONT_ASK, PermissionMode.BYPASS,
];
const MODEL_CATALOG = {
  claude: [
    { value: WITH_AUTO, label: 'Opus 5.5', permissionModes: [...ALL_BUT_AUTO, PermissionMode.AUTO] },
    { value: WITHOUT_AUTO, label: 'Haiku 5.5', permissionModes: ALL_BUT_AUTO },
  ],
  codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
};
const ENGINES: RunnerEngineHealth[] = [
  { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }] },
  { engine: 'codex', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.codex', auth: 'yes' }] },
];

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('the stored mode, the mode running, and the ceiling on PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = new QueueService(prisma, quiet);
  const sessions = new SessionsService(prisma, queue, quiet);
  const api = new RunnerApiController(
    prisma,
    queue,
    quiet,
    new Proxy({}, { get: () => async () => undefined }) as never,
    { assert: async (_runner: unknown, callingSessionId?: string) => callingSessionId ?? randomUUID() } as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sessions,
  );
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type World = { ownerId: string; runnerId: string; workspaceId: string };
  /** An owner whose account default is `accountMode`, a runner reporting MODEL_CATALOG, and a workspace on it. */
  async function world(label: string, accountMode: PermissionMode = PermissionMode.AUTO): Promise<World> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `${label}-${ownerId}@actual-permission-mode.invalid`,
        name: 'The owner',
        passwordHash: 'x',
        preferences: { defaultPermissionMode: accountMode },
      },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        maxConcurrent: 4,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
        engines: ENGINES as unknown as Prisma.InputJsonValue,
        modelCatalog: MODEL_CATALOG as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/tmp/actual-permission-mode' },
    });
    return { ownerId, runnerId, workspaceId };
  }

  /** A session waiting for its first claim. */
  async function pending(w: World, fields: Partial<Prisma.SessionUncheckedCreateInput>): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId: w.ownerId,
        creatorId: w.ownerId,
        workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId,
        title: 'actual permission mode',
        prompt: 'fix the login flow',
        provider: AgentProvider.CLAUDE,
        engine: AgentProvider.CLAUDE,
        model: WITH_AUTO,
        turnState: 'QUEUED',
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...fields,
      },
    });
    return id;
  }

  /** A session as the runner has it running: claimed through the queue, which records the mode it hands over. */
  async function claimed(w: World, fields: Partial<Prisma.SessionUncheckedCreateInput>) {
    const id = await pending(w, fields);
    const job = await queue.claimSessionForRunner({ id: w.runnerId });
    assert.equal(job?.sessionId, id, 'the queue claimed the fixture session');
    return { id, handed: job!.agent.permissionMode };
  }

  async function row(id: string) {
    return db.session.findUniqueOrThrow({
      where: { id },
      select: { permissionMode: true, actualPermissionMode: true, actualPermissionModeAt: true },
    });
  }

  async function changes(id: string) {
    return db.sessionPermissionModeChange.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
      select: { fromMode: true, toMode: true, cause: true, client: true },
    });
  }

  /** The runner fetching its next turn, as the inbox hands it out. */
  async function fetch(w: World, id: string) {
    const turn = await api.inbox({ id: w.runnerId }, id, await sessionLease(prisma, id));
    assert.ok(turn.turnId, 'the inbox handed a turn out');
    return turn;
  }

  /** The runner saying the engine took a setconfig, in the words runner-go's setConfigApplied writes. */
  async function acknowledge(w: World, id: string, turnId: string, result: string) {
    await api.turnComplete({ id: w.runnerId }, id, {
      turnId,
      status: SharedRunStatus.SUCCEEDED,
      subtype: 'setconfig',
      result,
    } as never);
  }

  let seq = 100;
  /** Runner events through the real ingest. */
  async function say(w: World, id: string, ...payloads: Array<Record<string, unknown>>) {
    await api.events({ id: w.runnerId }, id, {
      events: payloads.map((payload) => ({ seq: seq++, type: RunEventType.SYSTEM, ts: new Date().toISOString(), payload })),
    });
  }
  const init = (engine: string, permissionMode: string) => ({
    subtype: 'agent_tools',
    agentTools: { v: 1, engine, permissionMode, mcp: { status: 'connected', tools: 1 } },
  });

  await t.test('(1) a model without Auto and back leaves the stored mode Auto', async () => {
    const w = await world('roundtrip');
    const { id, handed } = await claimed(w, { permissionMode: PermissionMode.AUTO });
    assert.equal(handed, PermissionMode.AUTO, 'the claim handed the runner Auto');

    await sessions.updateConfig(w.ownerId, id, { model: WITHOUT_AUTO }, undefined, {
      origin: 'OWNER',
      senderClient: { client: 'web' },
    });
    assert.equal((await row(id)).permissionMode, PermissionMode.AUTO, 'a model with no Auto did not write Default over the intent');
    const away = await fetch(w, id);
    assert.equal(away.kind, 'setconfig');
    assert.deepEqual(
      JSON.parse(away.content ?? '{}'),
      { model: WITHOUT_AUTO, permissionMode: PermissionMode.DEFAULT },
      'the engine is told Default, the model having no Auto',
    );
    await acknowledge(w, id, away.turnId, `applied to the running engine: model "${WITHOUT_AUTO}", permission mode "default"`);
    assert.equal((await row(id)).actualPermissionMode, PermissionMode.DEFAULT, 'the acknowledgement recorded Default as running');

    await sessions.updateConfig(w.ownerId, id, { model: WITH_AUTO }, undefined, {
      origin: 'OWNER',
      senderClient: { client: 'ios', detail: 'iphone' },
    });
    assert.equal((await row(id)).permissionMode, PermissionMode.AUTO, 'back on a model with Auto, the intent is still Auto');
    const back = await fetch(w, id);
    assert.deepEqual(
      JSON.parse(back.content ?? '{}'),
      { model: WITH_AUTO, permissionMode: PermissionMode.AUTO },
      'the engine is told Auto again',
    );
    await acknowledge(w, id, back.turnId, `applied to the running engine: model "${WITH_AUTO}", permission mode "auto"`);
    const after = await row(id);
    assert.equal(after.permissionMode, PermissionMode.AUTO);
    assert.equal(after.actualPermissionMode, PermissionMode.AUTO);
    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', client: null },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'OWNER_PICK', client: 'web' },
      { fromMode: PermissionMode.DEFAULT, toMode: PermissionMode.AUTO, cause: 'OWNER_PICK', client: 'ios' },
    ]);
  });

  await t.test('(3) a model move Orbit makes itself is not put down to the owner', async () => {
    const w = await world('orbit-change');
    const { id } = await claimed(w, { permissionMode: PermissionMode.AUTO });
    // As TasksService.movePausedRunToPinnedModel moves a paused run onto its task's pinned model.
    await sessions.updateConfig(w.ownerId, id, { model: WITHOUT_AUTO }, undefined, { origin: 'ORBIT' });
    const turn = await fetch(w, id);
    await acknowledge(w, id, turn.turnId, `applied to the running engine: model "${WITHOUT_AUTO}", permission mode "default"`);
    const after = await row(id);
    assert.equal(after.permissionMode, PermissionMode.AUTO);
    assert.equal(after.actualPermissionMode, PermissionMode.DEFAULT);
    assert.deepEqual((await changes(id)).slice(1), [
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ORBIT_CHANGE', client: 'orbit' },
    ]);
  });

  await t.test('Run Now and due runAt store and claim Auto while a composer keeps its pick', async () => {
    const w = await world('start-modes', PermissionMode.DEFAULT);
    const tasks = new TasksService(prisma, sessions, quiet);
    const taskFields = {
      assigneeId: w.workspaceId,
      engine: AgentProvider.CLAUDE,
      model: WITH_AUTO,
      autoRunWhenReady: false,
      completionCriterion: 'EXECUTABLE' as const,
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    };
    const hand = await tasks.create(w.ownerId, { ...taskFields, title: 'Start by hand' });
    const manual = await tasks.execute(w.ownerId, hand.id);
    assert.ok(manual.sessionId);
    assert.equal((await row(manual.sessionId)).permissionMode, PermissionMode.AUTO, 'Run Now stored Auto');
    const first = await queue.claimSessionForRunner({ id: w.runnerId });
    assert.equal(first?.sessionId, manual.sessionId);
    assert.equal(first.agent.permissionMode, PermissionMode.AUTO, 'Run Now claim carries Auto');

    const due = await tasks.create(w.ownerId, { ...taskFields, title: 'Start when due' });
    await db.task.update({ where: { id: due.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await (tasks as unknown as { dispatchDueScheduledTasks(): Promise<void> }).dispatchDueScheduledTasks();
    const scheduled = await db.session.findFirstOrThrow({ where: { taskId: due.id } });
    assert.equal(scheduled.permissionMode, PermissionMode.AUTO, 'the due task stored Auto');
    const second = await queue.claimSessionForRunner({ id: w.runnerId });
    assert.equal(second?.sessionId, scheduled.id);
    assert.equal(second.agent.permissionMode, PermissionMode.AUTO, 'the due task claim carries Auto');

    const composer = await sessions.create(w.ownerId, {
      workspaceId: w.workspaceId, engine: AgentProvider.CLAUDE, model: WITH_AUTO,
      prompt: 'Draft a plan', permissionMode: PermissionMode.PLAN,
    });
    assert.equal((await row(composer.id)).permissionMode, PermissionMode.PLAN);
    const third = await queue.claimSessionForRunner({ id: w.runnerId });
    assert.equal(third?.sessionId, composer.id);
    assert.equal(third.agent.permissionMode, PermissionMode.PLAN, 'the composer claim carries the selected Plan');
  });

  await t.test('(2)(3) the actual mode follows the engine, and each change names its cause', async () => {
    const w = await world('reports');
    const { id } = await claimed(w, { permissionMode: PermissionMode.AUTO });
    assert.equal((await row(id)).actualPermissionMode, PermissionMode.AUTO, 'the claim recorded the mode it handed over');

    // Claude Code's init frame settles below what it was asked for: the incident of 11-18/19, now on record.
    await say(w, id, init('claude', PermissionMode.DEFAULT));
    assert.equal((await row(id)).actualPermissionMode, PermissionMode.DEFAULT, 'the init frame is what runs');
    // The same report again changes nothing and records nothing.
    await say(w, id, init('claude', PermissionMode.DEFAULT));
    // The runner corrects it.
    await say(w, id, { subtype: PERMISSION_MODE_CORRECTED_EVENT_SUBTYPE, mode: PermissionMode.AUTO });
    assert.equal((await row(id)).actualPermissionMode, PermissionMode.AUTO);
    // A re-spawn: the runner says it restarted the engine, and the new init frame says what it came up in.
    await say(w, id, { subtype: 'resumed' }, init('claude', PermissionMode.DEFAULT));
    assert.equal((await row(id)).actualPermissionMode, PermissionMode.DEFAULT, 'the init frame after the re-spawn');
    // A mode this server does not know is no report.
    await say(w, id, init('claude', 'sideways'));

    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', client: null },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ENGINE_REPORT', client: null },
      { fromMode: PermissionMode.DEFAULT, toMode: PermissionMode.AUTO, cause: 'RUNNER_CORRECTION', client: null },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'RESPAWN', client: null },
    ]);
    const stored = await row(id);
    assert.equal(stored.permissionMode, PermissionMode.AUTO, 'no report touched the intent');

    // The reads clients have: the detail carries both and the changes; the list row carries both.
    const detail = (await sessions.get(w.ownerId, id)) as unknown as {
      permissionMode: string;
      actualPermissionMode: string;
      actualPermissionModeAt: Date;
      permissionModeChanges: Array<{ fromMode: string | null; toMode: string; cause: string; client: string | null; at: string }>;
    };
    assert.equal(detail.permissionMode, PermissionMode.AUTO);
    assert.equal(detail.actualPermissionMode, PermissionMode.DEFAULT);
    assert.ok(detail.actualPermissionModeAt instanceof Date);
    assert.deepEqual(detail.permissionModeChanges.map((c) => c.cause), ['CLAIM', 'ENGINE_REPORT', 'RUNNER_CORRECTION', 'RESPAWN']);
    assert.ok(detail.permissionModeChanges.every((c) => typeof c.at === 'string'));
    const listed = (await sessions.list(w.ownerId, { workspaceId: w.workspaceId })) as unknown as
      | Array<{ id: string; permissionMode: string; actualPermissionMode: string }>
      | { sessions: Array<{ id: string; permissionMode: string; actualPermissionMode: string }> };
    const rows = Array.isArray(listed) ? listed : listed.sessions;
    const item = rows.find((r) => r.id === id);
    assert.ok(item, 'the list has the session');
    assert.equal(item.permissionMode, PermissionMode.AUTO);
    assert.equal(item.actualPermissionMode, PermissionMode.DEFAULT);
  });

  await t.test('(2) an engine that reports no mode runs in the mode it was handed', async () => {
    const w = await world('codex');
    const { id, handed } = await claimed(w, {
      provider: AgentProvider.CODEX,
      engine: AgentProvider.CODEX,
      model: 'gpt-5.5',
      permissionMode: PermissionMode.AUTO,
    });
    assert.equal(handed, PermissionMode.AUTO);
    // Codex's Agent Tools report restates the mode it was spawned with; it is not the engine's own word.
    await say(w, id, init('codex', PermissionMode.PLAN));
    assert.equal((await row(id)).actualPermissionMode, PermissionMode.AUTO, "Codex's report is not read as a mode");
    // A config change reaches Codex as a reload, and the reload handed to the runner is the mode it re-spawns in.
    await sessions.updateConfig(w.ownerId, id, { permissionMode: PermissionMode.PLAN }, undefined, {
      origin: 'OWNER',
      senderClient: { client: 'android' },
    });
    assert.equal((await row(id)).actualPermissionMode, PermissionMode.AUTO, 'not before the runner is handed it');
    const reload = await fetch(w, id);
    assert.equal(reload.kind, 'reload');
    const after = await row(id);
    assert.equal(after.permissionMode, PermissionMode.PLAN, 'an explicit pick writes the intent');
    assert.equal(after.actualPermissionMode, PermissionMode.PLAN, 'handed to the runner, it is what runs');
    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', client: null },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.PLAN, cause: 'OWNER_PICK', client: 'android' },
    ]);
  });

  await t.test('(4) the ceiling judges the starting session by the mode it runs in', async () => {
    const w = await world('ceiling', PermissionMode.AUTO);
    const NEXT = 'Ask the account owner.';
    const refusedWith = (code: string) => (error: unknown) =>
      error instanceof ForbiddenException && (error.getResponse() as { code?: string }).code === code;

    // Stored Auto, running Default: it may not start a session at the account's Auto, nor reach a wider one.
    const { id: settledLow } = await claimed(w, { permissionMode: PermissionMode.AUTO });
    await say(w, settledLow, init('claude', PermissionMode.DEFAULT));
    assert.equal((await row(settledLow)).permissionMode, PermissionMode.AUTO);
    await assert.rejects(
      sessions.assertMayStartInMode(w.ownerId, settledLow, { engine: AgentProvider.CLAUDE, workspaceId: w.workspaceId }, NEXT),
      refusedWith(PERMISSION_MODE_WIDER_THAN_SESSION),
      'a session running Default may not start one in Auto, whatever its stored mode says',
    );
    const wider = await pending(w, { permissionMode: PermissionMode.AUTO, turnState: null });
    await assert.rejects(
      sessions.assertMayReach(w.ownerId, settledLow, wider, 'end'),
      refusedWith(SESSION_WIDER_THAN_CALLER),
      'nor end an unrelated session in Auto',
    );

    // Corrected to Auto, the same session may.
    await say(w, settledLow, { subtype: PERMISSION_MODE_CORRECTED_EVENT_SUBTYPE, mode: PermissionMode.AUTO });
    await sessions.assertMayStartInMode(w.ownerId, settledLow, { engine: AgentProvider.CLAUDE, workspaceId: w.workspaceId }, NEXT);
    assert.deepEqual(await sessions.assertMayReach(w.ownerId, settledLow, wider, 'end'), { narrower: false });

    // Stored Default, running Auto (the intent narrower than what runs): judged by what runs. On a runner of its own,
    // which the queue hands a session while the first is still running there.
    const w2 = await world('ceiling-2', PermissionMode.AUTO);
    const { id: runsAuto } = await claimed(w2, { permissionMode: PermissionMode.DEFAULT });
    assert.equal((await row(runsAuto)).actualPermissionMode, PermissionMode.DEFAULT, 'claimed in its stored Default');
    await assert.rejects(
      sessions.assertMayStartInMode(w2.ownerId, runsAuto, { engine: AgentProvider.CLAUDE, workspaceId: w2.workspaceId }, NEXT),
      refusedWith(PERMISSION_MODE_WIDER_THAN_SESSION),
      'running Default, it may not',
    );
    await say(w2, runsAuto, init('claude', PermissionMode.AUTO));
    await sessions.assertMayStartInMode(w2.ownerId, runsAuto, { engine: AgentProvider.CLAUDE, workspaceId: w2.workspaceId }, NEXT);

    // No actual mode recorded (claimed before migration 1805): the stored mode decides, as before R3.
    const unrecorded = await pending(w, { permissionMode: PermissionMode.DEFAULT, turnState: null });
    assert.equal((await row(unrecorded)).actualPermissionMode, null);
    await assert.rejects(
      sessions.assertMayStartInMode(w.ownerId, unrecorded, { engine: AgentProvider.CLAUDE, workspaceId: w.workspaceId }, NEXT),
      refusedWith(PERMISSION_MODE_WIDER_THAN_SESSION),
      'the fallback is the stored mode',
    );
    const unrecordedAuto = await pending(w, { permissionMode: PermissionMode.AUTO, turnState: null });
    await sessions.assertMayStartInMode(w.ownerId, unrecordedAuto, { engine: AgentProvider.CLAUDE, workspaceId: w.workspaceId }, NEXT);
  });
});
