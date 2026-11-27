/**
 * A SESSION THAT ASKED FOR AUTO IS CLAIMED IN AUTO; EVERY SUBSTITUTION A CLAIM STILL MAKES IS LOGGED AND RECORDED.
 *
 * Project 350NMcNDulzkqRAFFUsXZ, criterion 55f38yosCj1Nw2KIal3Sn6. On real PostgreSQL, through the production doors
 * (QueueService's claim, RunnerApiController's reclaim and /events, SessionsService's detail):
 *
 *   (1) Auto on a Claude model whose catalogue row lists no Auto is claimed in Auto, with nothing substituted and
 *       nothing logged. The engine's own report of the lower mode is what the session runs in, and the runner's
 *       report that the engine would not take Auto is kept with the session's events and changes no mode.
 *   (2) Bypass on a root runner is claimed, and reclaimed, in Auto. Each claim writes a `claim-permission-mode` line
 *       naming the session, model, the mode asked for, the mode handed and the reason, and the mode change it records
 *       carries the mode asked for and the reason, which the session detail reads back.
 *   (3) A scheduled run on Claude Code that asked for Default is claimed in Auto, logged and recorded the same way.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/queue/claim-permission-mode.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';

import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  AgentProvider,
  PERMISSION_MODE_CORRECTION_FAILED_EVENT_SUBTYPE,
  PermissionMode,
  RunEventType,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { QueueService } from './queue.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A Claude model with Auto, and one whose catalogue row withholds it (as the runner's probe reports one). */
const WITH_AUTO = 'claude-opus-5-5';
const WITHOUT_AUTO = 'claude-haiku-4-5-20251001';
const ALL_BUT_AUTO = [
  PermissionMode.DEFAULT, PermissionMode.ACCEPT_EDITS, PermissionMode.PLAN, PermissionMode.DONT_ASK, PermissionMode.BYPASS,
];
const MODEL_CATALOG = {
  claude: [
    { value: WITH_AUTO, label: 'Opus 5.5', permissionModes: [...ALL_BUT_AUTO, PermissionMode.AUTO] },
    { value: WITHOUT_AUTO, label: 'Haiku 4.5', permissionModes: ALL_BUT_AUTO },
  ],
};
const ENGINES: RunnerEngineHealth[] = [
  { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }] },
];
const LINE = 'claim-permission-mode ';

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('the mode a claim hands the runner, and every substitution it still makes', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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
    // The orchestration authorizer: the reclaim issues a credential to a session that may orchestrate.
    {
      assert: async (_runner: unknown, callingSessionId?: string) => callingSessionId ?? randomUUID(),
      issue: async () => 'orchestration-credential',
    } as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sessions,
  );
  // Every line the claim paths log, as Nest's Logger would write them.
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
        email: `${label}-${ownerId}@claim-permission-mode.invalid`,
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
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/tmp/claim-permission-mode' },
    });
    return { ownerId, runnerId, workspaceId };
  }

  /** A session waiting for its first claim, then claimed through the queue. */
  async function claimed(w: World, fields: Partial<Prisma.SessionUncheckedCreateInput>) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId: w.ownerId,
        creatorId: w.ownerId,
        workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId,
        title: 'claim permission mode',
        prompt: 'fix the login flow',
        provider: AgentProvider.CLAUDE,
        engine: AgentProvider.CLAUDE,
        model: WITH_AUTO,
        status: RunStatus.PENDING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...fields,
      },
    });
    const job = await queue.claimSessionForRunner({ id: w.runnerId });
    assert.equal(job?.sessionId, id, 'the queue claimed the fixture session');
    return { id, handed: job!.agent.permissionMode };
  }

  async function changes(id: string) {
    return db.sessionPermissionModeChange.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
      select: { fromMode: true, toMode: true, cause: true, requestedMode: true, reason: true },
    });
  }

  async function actual(id: string) {
    return (await db.session.findUniqueOrThrow({ where: { id }, select: { actualPermissionMode: true } })).actualPermissionMode;
  }

  /** The substitution lines logged for one session. */
  const linesFor = (id: string) =>
    logged.filter((l) => l.startsWith(LINE)).map((l) => JSON.parse(l.slice(LINE.length)) as Record<string, unknown>)
      .filter((l) => l.sessionId === id);

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

  await t.test('(1) Auto on a model whose catalogue row lists no Auto is claimed in Auto, and the engine says the rest', async () => {
    const w = await world('no-auto-row', false);
    const { id, handed } = await claimed(w, { model: WITHOUT_AUTO, permissionMode: PermissionMode.AUTO });
    assert.equal(handed, PermissionMode.AUTO, 'the claim handed the runner the Auto the session asked for');
    assert.deepEqual(linesFor(id), [], 'nothing was substituted, so nothing is logged');

    // The engine settles on Default and says so; the runner asks for Auto and the engine refuses it.
    await say(w, id, init(PermissionMode.DEFAULT));
    await say(w, id, {
      subtype: PERMISSION_MODE_CORRECTION_FAILED_EVENT_SUBTYPE,
      mode: PermissionMode.DEFAULT,
      requested: PermissionMode.AUTO,
      reason: 'Cannot set permission mode to auto: auto mode unavailable for this model',
    });
    assert.equal(await actual(id), PermissionMode.DEFAULT, 'what runs is what the engine said, not what was handed');
    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', requestedMode: null, reason: null },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ENGINE_REPORT', requestedMode: null, reason: null },
    ], 'the refused correction is no mode change');
    const kept = await db.runEvent.findMany({ where: { sessionId: id, type: RunEventType.SYSTEM }, select: { payload: true } });
    assert.ok(
      kept.some((e) => (e.payload as { subtype?: unknown }).subtype === PERMISSION_MODE_CORRECTION_FAILED_EVENT_SUBTYPE),
      "the runner's report of the refusal is kept with the session's events",
    );

    // The same session on a model whose row has Auto is claimed in Auto as well, which is no news.
    const { id: other, handed: otherHanded } = await claimed(w, { model: WITH_AUTO, permissionMode: PermissionMode.AUTO });
    assert.equal(otherHanded, PermissionMode.AUTO);
    assert.deepEqual(linesFor(other), []);
  });

  await t.test('(2) Bypass on a root runner is claimed and reclaimed in Auto, each logged and recorded with its reason', async () => {
    const w = await world('root', true);
    const { id, handed } = await claimed(w, { permissionMode: PermissionMode.BYPASS });
    assert.equal(handed, PermissionMode.AUTO, 'Claude Code exits under root in Bypass, so the claim hands Auto');
    const expected = {
      sessionId: id,
      provider: AgentProvider.CLAUDE,
      model: WITH_AUTO,
      from: PermissionMode.BYPASS,
      to: PermissionMode.AUTO,
      reason: 'ROOT_RUNNER',
    };
    assert.deepEqual(linesFor(id), [expected], 'the claim logged its substitution');
    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' },
    ]);

    // The engine came up below Auto, and the runner then lost contact: the reclaim hands Auto again.
    await say(w, id, init(PermissionMode.DEFAULT));
    const reclaimed = (await api.reclaim({ id: w.runnerId, ownerId: w.ownerId, runsAsRoot: true })).sessions
      .find((s) => s.sessionId === id);
    assert.ok(reclaimed, 'the reclaim re-handed the session');
    assert.equal(reclaimed.agent.permissionMode, PermissionMode.AUTO);
    assert.deepEqual(linesFor(id), [expected, expected], 'the reclaim logged its substitution too');
    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' },
      { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ENGINE_REPORT', requestedMode: null, reason: null },
      { fromMode: PermissionMode.DEFAULT, toMode: PermissionMode.AUTO, cause: 'CLAIM', requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' },
    ]);

    // What clients read: the substitution on the claim's rows, and every other row as it was.
    const detail = (await sessions.get(w.ownerId, id)) as unknown as {
      permissionMode: string;
      permissionModeChanges: Array<Record<string, unknown>>;
    };
    assert.equal(detail.permissionMode, PermissionMode.BYPASS, 'the intent is still the Bypass the owner picked');
    assert.deepEqual(
      detail.permissionModeChanges.map(({ at: _at, ...change }) => change),
      [
        { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', client: null, requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' },
        { fromMode: PermissionMode.AUTO, toMode: PermissionMode.DEFAULT, cause: 'ENGINE_REPORT', client: null },
        { fromMode: PermissionMode.DEFAULT, toMode: PermissionMode.AUTO, cause: 'CLAIM', client: null, requestedMode: PermissionMode.BYPASS, reason: 'ROOT_RUNNER' },
      ],
    );

    // On the same root runner, a session that asked for Auto substitutes nothing.
    const { id: auto, handed: autoHanded } = await claimed(w, { permissionMode: PermissionMode.AUTO });
    assert.equal(autoHanded, PermissionMode.AUTO);
    assert.deepEqual(linesFor(auto), []);
  });

  await t.test('(3) a scheduled run on Claude Code that asked for Default is claimed in Auto, logged and recorded', async () => {
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
    const { id, handed } = await claimed(w, { permissionMode: PermissionMode.DEFAULT, scheduleRunId: run.id });
    assert.equal(handed, PermissionMode.AUTO, 'a scheduled run on Claude Code runs in Auto, whatever it asked for');
    assert.deepEqual(linesFor(id), [{
      sessionId: id,
      provider: AgentProvider.CLAUDE,
      model: WITH_AUTO,
      from: PermissionMode.DEFAULT,
      to: PermissionMode.AUTO,
      reason: 'SCHEDULED_RUN',
    }]);
    assert.deepEqual(await changes(id), [
      { fromMode: null, toMode: PermissionMode.AUTO, cause: 'CLAIM', requestedMode: PermissionMode.DEFAULT, reason: 'SCHEDULED_RUN' },
    ]);
  });

  await t.test('the table holds a reason to a claim, and to the substitutions there are', async () => {
    const w = await world('check', false);
    const { id } = await claimed(w, { permissionMode: PermissionMode.AUTO });
    const insert = (cause: string, requested: string | null, reason: string | null) => sql.query(
      `INSERT INTO "session_permission_mode_change" ("id", "session_id", "from_mode", "to_mode", "cause", "requested_mode", "reason")
       VALUES ($1, $2, 'auto', 'default', $3, $4, $5)`,
      [randomUUID(), id, cause, requested, reason],
    );
    await assert.rejects(insert('ENGINE_REPORT', 'auto', 'ROOT_RUNNER'), /session_permission_mode_change_reason_chk/u);
    await assert.rejects(insert('CLAIM', 'auto', 'BECAUSE'), /session_permission_mode_change_reason_chk/u);
    await assert.rejects(insert('CLAIM', null, 'ROOT_RUNNER'), /session_permission_mode_change_reason_chk/u);
  });
});
