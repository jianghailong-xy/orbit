/**
 * A CONFIG CHANGE HANDS THE ENGINE THE MODE ASKED FOR, AS A CLAIM DOES; EVERY SUBSTITUTION IT STILL MAKES IS LOGGED AND
 * RECORDED, AND THE STORED INTENT IS NEVER REWRITTEN.
 *
 * Project 350NMcNDulzkqRAFFUsXZ, criterion 55f38yosCj1Nw2KIal3Sn6. On real PostgreSQL, through the production doors
 * (QueueService's claim, SessionsService.updateConfig and its detail, the runner inbox, /events and /turn-complete):
 *
 *   (1) On a Claude model whose catalogue row lists no Auto, a PATCH that keeps an Auto intent hands the engine Auto in
 *       its setconfig turn — a model move and a mode restatement alike — with no substitution carried and no line
 *       logged. The engine's init frame says what it settled on, and the stored intent stays Auto. An acknowledgement
 *       that sent the engine no mode ("nothing to change") records none: the engine's own report stands.
 *   (2) The same on a reload turn (a fast-mode change re-spawns the engine).
 *   (3) Bypass picked on a root runner is handed as Auto, in a Claude setconfig and reload and a Codex reload: each
 *       PATCH writes a `claim-permission-mode` line naming the path, the session, model, the mode asked for, the mode
 *       handed and the reason; the turn carries the substitution, and the mode change its acknowledgement or delivery
 *       records carries the mode asked for and the reason, which the session detail reads back. The intent stays the
 *       Bypass the owner picked.
 *   (4) A PATCH on a scheduled run on Claude Code that asks for Plan is handed Auto, logged and carried the same way,
 *       and the intent stays Plan.
 *   (5) The table now holds a reason on an OWNER_PICK or ORBIT_CHANGE row, and still on no other cause.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/config-change-permission-mode.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';

import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  AgentProvider,
  PermissionMode,
  RunEventType,
  RunStatus as SharedRunStatus,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { sessionLease } from '../test-support/dequeue-under-lease';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A Claude model with Auto, and one whose catalogue row withholds it (as the runner's probe reports one). The latter
 *  has fast mode, so a fast-mode change re-spawns its engine through a reload. */
const WITH_AUTO = 'claude-opus-5-5';
const WITHOUT_AUTO = 'claude-haiku-4-5-20251001';
const ALL_BUT_AUTO = [
  PermissionMode.DEFAULT, PermissionMode.ACCEPT_EDITS, PermissionMode.PLAN, PermissionMode.DONT_ASK, PermissionMode.BYPASS,
];
const MODEL_CATALOG = {
  claude: [
    { value: WITH_AUTO, label: 'Opus 5.5', permissionModes: [...ALL_BUT_AUTO, PermissionMode.AUTO] },
    { value: WITHOUT_AUTO, label: 'Haiku 4.5', permissionModes: ALL_BUT_AUTO, fastMode: true },
  ],
  codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
};
const ENGINES: RunnerEngineHealth[] = [
  { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }] },
  { engine: 'codex', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.codex', auth: 'yes' }] },
];
const LINE = 'claim-permission-mode ';

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('the mode a config change hands the engine, and every substitution it still makes', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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
  // Every line logged, as Nest's Logger would write them.
  const logged: string[] = [];
  const realLog = Logger.prototype.log;
  mock.method(Logger.prototype, 'log', function (this: Logger, message: unknown, ...rest: unknown[]) {
    if (typeof message === 'string') logged.push(message);
    return realLog.call(this, message, ...(rest as []));
  });
  t.after(async () => {
    mock.restoreAll();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type World = { ownerId: string; runnerId: string; workspaceId: string };
  async function world(label: string, runsAsRoot: boolean): Promise<World> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `${label}-${ownerId}@config-change-permission-mode.invalid`,
        name: 'The owner',
        passwordHash: 'x',
        preferences: { defaultPermissionMode: PermissionMode.AUTO },
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
        runsAsRoot,
        engines: ENGINES as unknown as Prisma.InputJsonValue,
        modelCatalog: MODEL_CATALOG as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/tmp/config-change-permission-mode' },
    });
    return { ownerId, runnerId, workspaceId };
  }

  /** A session claimed through the queue, which records the mode it hands over. */
  async function claimed(w: World, fields: Partial<Prisma.SessionUncheckedCreateInput>) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId: w.ownerId,
        creatorId: w.ownerId,
        workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId,
        title: 'config change permission mode',
        prompt: 'fix the login flow',
        provider: AgentProvider.CLAUDE,
        engine: AgentProvider.CLAUDE,
        model: WITH_AUTO,
        turnState: 'QUEUED',
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...fields,
      },
    });
    const job = await queue.claimSessionForRunner({ id: w.runnerId });
    assert.equal(job?.sessionId, id, 'the queue claimed the fixture session');
    return { id, handed: job!.agent.permissionMode };
  }

  async function stored(id: string) {
    return (await db.session.findUniqueOrThrow({ where: { id }, select: { permissionMode: true } })).permissionMode;
  }
  async function actual(id: string) {
    return (await db.session.findUniqueOrThrow({ where: { id }, select: { actualPermissionMode: true } })).actualPermissionMode;
  }
  async function changes(id: string) {
    return db.sessionPermissionModeChange.findMany({
      where: { sessionId: id },
      // The order they were recorded in (migration 1810): two can share a millisecond.
      orderBy: { seq: 'asc' },
      select: { fromMode: true, toMode: true, cause: true, client: true, requestedMode: true, reason: true },
    });
  }

  /** The runner fetching its next turn, as the inbox hands it out (a reload's delivery records its mode). */
  async function fetch(w: World, id: string) {
    const turn = await api.inbox({ id: w.runnerId }, id, await sessionLease(prisma, id));
    assert.ok(turn.turnId, 'the inbox handed a turn out');
    return { ...turn, payload: JSON.parse(turn.content ?? '{}') as Record<string, unknown> };
  }
  /** The runner saying the engine took a setconfig, in the words runner-go's setConfigApplied writes. */
  async function acknowledge(w: World, id: string, turnId: string, result: string) {
    await api.turnComplete({ id: w.runnerId }, id, {
      turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'setconfig', result,
    } as never);
  }
  let seq = 100;
  async function say(w: World, id: string, ...payloads: Array<Record<string, unknown>>) {
    await api.events({ id: w.runnerId }, id, {
      events: payloads.map((payload) => ({ seq: seq++, type: RunEventType.SYSTEM, ts: new Date().toISOString(), payload })),
    });
  }
  const init = (permissionMode: string) => ({
    subtype: 'agent_tools',
    agentTools: { v: 1, engine: 'claude', permissionMode, mcp: { status: 'connected', tools: 1 } },
  });

  /** The substitution lines logged for one session. */
  const linesFor = (id: string) =>
    logged.filter((l) => l.startsWith(LINE)).map((l) => JSON.parse(l.slice(LINE.length)) as Record<string, unknown>)
      .filter((l) => l.sessionId === id);

  await t.test('(1) a setconfig on a model whose catalogue row lists no Auto hands the engine Auto', async () => {
    const w = await world('setconfig', false);
    const { id, handed } = await claimed(w, { permissionMode: PermissionMode.AUTO });
    assert.equal(handed, PermissionMode.AUTO);

    // A model move that keeps the Auto intent.
    await sessions.updateConfig(w.ownerId, id, { model: WITHOUT_AUTO }, undefined, { origin: 'OWNER', senderClient: { client: 'web' } });
    assert.equal(await stored(id), PermissionMode.AUTO, 'the intent is not rewritten');
    const moved = await fetch(w, id);
    assert.equal(moved.kind, 'setconfig');
    assert.deepEqual(moved.payload, { model: WITHOUT_AUTO, permissionMode: PermissionMode.AUTO },
      'the engine is handed Auto, not the Default the catalogue row predicts, and no substitution is carried');
    await acknowledge(w, id, moved.turnId, `applied to the running engine: model "${WITHOUT_AUTO}"`);

    // The engine says it settled on Default on this model; a PATCH restating Auto hands it Auto again.
    await say(w, id, init(PermissionMode.DEFAULT));
    assert.equal(await actual(id), PermissionMode.DEFAULT, 'what runs is what the engine said');
    await sessions.updateConfig(w.ownerId, id, { permissionMode: PermissionMode.AUTO }, undefined, {
      origin: 'OWNER', senderClient: { client: 'ios' },
    });
    const restated = await fetch(w, id);
    assert.equal(restated.kind, 'setconfig');
    assert.deepEqual(restated.payload, { model: WITHOUT_AUTO, permissionMode: PermissionMode.AUTO });
    await acknowledge(w, id, restated.turnId, 'applied to the running engine: permission mode "auto"');
    assert.equal(await actual(id), PermissionMode.AUTO);
    assert.equal(await stored(id), PermissionMode.AUTO);

    // The engine settles lower again; a runner that sends it no mode for the next restatement (its config already
    // read Auto) answers "nothing to change", and the Default the engine reported is what still runs.
    await say(w, id, init(PermissionMode.DEFAULT));
    await sessions.updateConfig(w.ownerId, id, { permissionMode: PermissionMode.AUTO }, undefined, {
      origin: 'OWNER', senderClient: { client: 'web' },
    });
    const unsent = await fetch(w, id);
    assert.deepEqual(unsent.payload, { model: WITHOUT_AUTO, permissionMode: PermissionMode.AUTO });
    await acknowledge(w, id, unsent.turnId, 'nothing to change');
    assert.equal(await actual(id), PermissionMode.DEFAULT, 'a mode the engine was not sent is not recorded as running');

    assert.deepEqual(linesFor(id), [], 'nothing was substituted, so nothing is logged');
    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', client: null, requestedMode: null, reason: null },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ENGINE_REPORT', client: null, requestedMode: null, reason: null },
      { fromMode: PermissionMode.DEFAULT, toMode: PermissionMode.AUTO, cause: 'OWNER_PICK', client: 'ios', requestedMode: null, reason: null },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ENGINE_REPORT', client: null, requestedMode: null, reason: null },
    ]);
  });

  await t.test('(2) a reload on a model whose catalogue row lists no Auto hands the engine Auto', async () => {
    const w = await world('reload', false);
    const { id, handed } = await claimed(w, { model: WITHOUT_AUTO, permissionMode: PermissionMode.AUTO });
    assert.equal(handed, PermissionMode.AUTO, 'the claim handed Auto (the prerequisite)');

    // Fast mode is spawn-only on Claude Code, so this PATCH re-spawns the engine; the mode is the one running, so it
    // goes on the reload alone.
    await sessions.updateConfig(w.ownerId, id, { fastMode: true }, undefined, { origin: 'OWNER', senderClient: { client: 'web' } });
    const reload = await fetch(w, id);
    assert.equal(reload.kind, 'reload');
    assert.equal(reload.payload.permissionMode, PermissionMode.AUTO, 'the re-spawn is handed Auto');
    assert.equal(reload.payload.permissionModeSubstitution, undefined);
    assert.equal(reload.payload.fastMode, true);
    assert.equal(await stored(id), PermissionMode.AUTO, 'the intent is not rewritten');
    assert.deepEqual(linesFor(id), []);
    assert.equal(await actual(id), PermissionMode.AUTO, 'the delivered reload re-spawns the engine in Auto');
    assert.deepEqual((await changes(id)).map((c) => c.cause), ['CLAIM'], 'Auto all along: nothing lowered, nothing to record');
  });

  await t.test('(3) Bypass on a root runner is handed as Auto, logged and recorded with its reason', async () => {
    const w = await world('root', true);
    const { id } = await claimed(w, { model: WITHOUT_AUTO, permissionMode: PermissionMode.AUTO });
    await say(w, id, init(PermissionMode.DEFAULT));

    // setconfig.
    await sessions.updateConfig(w.ownerId, id, { permissionMode: PermissionMode.BYPASS }, undefined, {
      origin: 'OWNER', senderClient: { client: 'web' },
    });
    assert.equal(await stored(id), PermissionMode.BYPASS, 'the intent is the Bypass the owner picked');
    const live = await fetch(w, id);
    assert.equal(live.kind, 'setconfig');
    assert.deepEqual(live.payload, {
      model: WITHOUT_AUTO,
      permissionMode: PermissionMode.AUTO,
      permissionModeSubstitution: { requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' },
    });
    const expected = {
      sessionId: id,
      path: 'CONFIG_CHANGE',
      provider: AgentProvider.CLAUDE,
      model: WITHOUT_AUTO,
      from: PermissionMode.BYPASS,
      to: PermissionMode.AUTO,
      reason: 'ROOT_RUNNER',
    };
    assert.deepEqual(linesFor(id), [expected], 'the config change logged its substitution');
    await acknowledge(w, id, live.turnId, 'applied to the running engine: permission mode "auto"');
    assert.equal(await actual(id), PermissionMode.AUTO);

    // A Claude reload: fast mode re-spawns the engine, and the turn carries the substitution as well.
    await sessions.updateConfig(w.ownerId, id, { fastMode: true }, undefined, { origin: 'OWNER', senderClient: { client: 'macos' } });
    const reload = await fetch(w, id);
    assert.equal(reload.kind, 'reload');
    assert.equal(reload.payload.permissionMode, PermissionMode.AUTO);
    assert.deepEqual(reload.payload.permissionModeSubstitution, { requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' });
    assert.deepEqual(linesFor(id), [expected, expected], 'the reload logged it too');
    assert.equal(await stored(id), PermissionMode.BYPASS, 'still the intent');

    const bypassed = { requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' };
    const plain = { requestedMode: null, reason: null };
    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', client: null, ...plain },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ENGINE_REPORT', client: null, ...plain },
      { fromMode: PermissionMode.DEFAULT, toMode: PermissionMode.AUTO, cause: 'OWNER_PICK', client: 'web', ...bypassed },
    ], "the setconfig's acknowledgement recorded the substitution; the reload re-spawned the Auto already running");

    // What clients read: the substitution on the row that made one, and every other row as it was.
    const detail = (await sessions.get(w.ownerId, id)) as unknown as {
      permissionMode: string;
      permissionModeChanges: Array<Record<string, unknown>>;
    };
    assert.equal(detail.permissionMode, PermissionMode.BYPASS);
    assert.deepEqual(
      detail.permissionModeChanges.map(({ at: _at, seq: _seq, ...change }) => change).slice(1),
      [
        { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ENGINE_REPORT', client: null },
        { fromMode: PermissionMode.DEFAULT, toMode: PermissionMode.AUTO, cause: 'OWNER_PICK', client: 'web', ...bypassed },
      ],
    );

    // A Codex session on the same root runner, whose every config change is a reload: its delivery records the
    // substitution with the mode the engine re-spawns in.
    const { id: codex } = await claimed(w, {
      provider: AgentProvider.CODEX, engine: AgentProvider.CODEX, model: 'gpt-5.5', permissionMode: PermissionMode.PLAN,
    });
    await sessions.updateConfig(w.ownerId, codex, { permissionMode: PermissionMode.BYPASS }, undefined, {
      origin: 'OWNER', senderClient: { client: 'android' },
    });
    const codexReload = await fetch(w, codex);
    assert.equal(codexReload.kind, 'reload');
    assert.equal(codexReload.payload.permissionMode, PermissionMode.AUTO);
    assert.deepEqual(codexReload.payload.permissionModeSubstitution, bypassed);
    assert.deepEqual(linesFor(codex), [{ ...expected, sessionId: codex, provider: AgentProvider.CODEX, model: 'gpt-5.5' }]);
    assert.equal(await stored(codex), PermissionMode.BYPASS);
    assert.deepEqual(await changes(codex), [
      { fromMode: null, toMode: PermissionMode.PLAN, cause: 'CLAIM', client: null, ...plain },
      { fromMode: PermissionMode.PLAN, toMode: PermissionMode.AUTO, cause: 'OWNER_PICK', client: 'android', ...bypassed },
    ]);
  });

  await t.test('(4) a scheduled run on Claude Code that asks for Plan is handed Auto, logged and carried', async () => {
    const w = await world('scheduled', false);
    const schedule = await db.schedule.create({
      data: {
        ownerId: w.ownerId, workspaceId: w.workspaceId, intent: 'Every morning, check the nightly build',
        title: 'Nightly build check', prompt: 'Check the nightly build.', rule: { kind: 'DAILY' }, timezone: 'UTC',
        startAt: new Date(), accessLevel: 'CHECK_ONLY', envelopeWorkspaceId: w.workspaceId, envelopeAccessLevel: 'CHECK_ONLY',
        envelopeRunsPerWeek: 7, envelopeRunLimitMinutes: 30,
      },
    });
    const run = await db.scheduleRun.create({
      data: {
        scheduleId: schedule.id, scheduleRevision: 1, plannedAt: new Date(), trigger: 'SCHEDULED', state: 'RUNNING',
        startedAt: new Date(), accessLevel: 'CHECK_ONLY',
      },
    });
    const { id, handed } = await claimed(w, { model: WITHOUT_AUTO, permissionMode: PermissionMode.AUTO, scheduleRunId: run.id });
    assert.equal(handed, PermissionMode.AUTO);
    await sessions.updateConfig(w.ownerId, id, { permissionMode: PermissionMode.PLAN }, undefined, { origin: 'OWNER' });
    assert.equal(await stored(id), PermissionMode.PLAN, 'the intent is what the PATCH named');
    const turn = await fetch(w, id);
    assert.equal(turn.kind, 'setconfig');
    assert.deepEqual(turn.payload, {
      model: WITHOUT_AUTO,
      permissionMode: PermissionMode.AUTO,
      permissionModeSubstitution: { requestedMode: PermissionMode.PLAN, reason: 'SCHEDULED_RUN' },
    });
    assert.deepEqual(linesFor(id), [{
      sessionId: id,
      path: 'CONFIG_CHANGE',
      provider: AgentProvider.CLAUDE,
      model: WITHOUT_AUTO,
      from: PermissionMode.PLAN,
      to: PermissionMode.AUTO,
      reason: 'SCHEDULED_RUN',
    }]);
  });

  await t.test('(5) the table holds a reason to a claim or a config change, and to the substitutions there are', async () => {
    const w = await world('check', false);
    const { id } = await claimed(w, { permissionMode: PermissionMode.AUTO });
    const insert = (cause: string, requested: string | null, reason: string | null) => sql.query(
      `INSERT INTO "session_permission_mode_change" ("id", "session_id", "from_mode", "to_mode", "cause", "requested_mode", "reason")
       VALUES ($1, $2, 'default', 'auto', $3, $4, $5)`,
      [randomUUID(), id, cause, requested, reason],
    );
    await insert('OWNER_PICK', PermissionMode.BYPASS, 'ROOT_RUNNER');
    await insert('ORBIT_CHANGE', 'plan', 'SCHEDULED_RUN');
    for (const cause of ['ENGINE_REPORT', 'RUNNER_CORRECTION', 'RESPAWN']) {
      await assert.rejects(insert(cause, 'auto', 'ROOT_RUNNER'), /session_permission_mode_change_reason_chk/u, cause);
    }
    await assert.rejects(insert('OWNER_PICK', 'auto', 'BECAUSE'), /session_permission_mode_change_reason_chk/u);
    await assert.rejects(insert('OWNER_PICK', null, 'ROOT_RUNNER'), /session_permission_mode_change_reason_chk/u);
  });
});
