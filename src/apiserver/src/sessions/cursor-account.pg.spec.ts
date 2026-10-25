/**
 * WHICH OF ITS RUNNER'S CURSOR CLI ACCOUNTS A SESSION RUNS ON — AND WHAT A RUNNER TOO OLD TO KEEP THEM
 * APART IS NEVER HANDED.
 *
 * A runner keeps Cursor CLI accounts the way it keeps Codex's, Claude Code's, Antigravity's and Kimi
 * Code's (docs/cursor-runtime-contract.md §16): Default is <orbit home>/cursor/default, every other
 * account a directory it added under <orbit home>/cursor-accounts, each reported in `runner.engines`.
 * The choice is migration 0427's workspace.cursor_account and session.cursor_account(_pinned). On real
 * PostgreSQL (project P4a):
 *
 *   (0) The columns are the ones 0427 says: on `workspace` and `session` two nullable TEXT and one
 *       BOOLEAN NOT NULL DEFAULT false; on `runner` the sign-in link's expiry and a failure's reason.
 *   (1) A workspace and a session pick a Cursor CLI account by id, or leave it to Automatic, which
 *       starts a session on Default while no Cursor CLI quota is reported.
 *   (2) Dispatch hands the runner the account its session runs on, as ORBIT_CURSOR_ACCOUNT_DIR: the
 *       session's pick ahead of its workspace's, in place of one typed into the workspace's env.
 *   (3) An account the runner does not report runs on Default: no ORBIT_CURSOR_ACCOUNT_DIR is handed over.
 *   (4) A named Cursor CLI sign-in, Cursor CLI's own, and a removal go only to a runner that declares
 *       cursor-account-login/v1 and cursor-account-remove/v1; an older one is told to update.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/cursor-account.pg.spec.ts
 *
 * Production code throughout: WorkspacesService, SessionsService, QueueService, RunnersService and
 * RunnerApiController. Not destructive: every id is freshly generated and every assertion is scoped to
 * the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { AgentProvider, PermissionMode, type RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { QueueService as RealQueueService } from '../queue/queue.service';
import {
  CURSOR_ACCOUNT_LOGIN_V1,
  CURSOR_ACCOUNT_REMOVE_V1,
  CURSOR_LOGIN_TOO_OLD,
  RunnerApiController,
} from '../runner-api/runner-api.controller';
import { RunnersService } from '../runners/runners.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = 'c41e0b7a';
/** An id no Cursor CLI account on these runners has: removed, or one on another machine. */
const GONE = 'c0ffee42';
const DEFAULT_HOME = '/root/.orbit/cursor/default';
const WORK_HOME = '/root/.orbit/cursor-accounts/c41e0b7a';
const DIR_VAR = 'ORBIT_CURSOR_ACCOUNT_DIR';
/** What every runner that runs Cursor CLI sessions declares (P1): its heartbeat names the engine. */
const RUNS_CURSOR = ['provider:cursor'];
/** A claim from a runner that runs every engine, Cursor CLI's included. */
const CURRENT = [
  AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.OPENCODE,
  AgentProvider.ANTIGRAVITY, AgentProvider.DSH, AgentProvider.CURSOR,
];

const engines = (defaultAuth: 'yes' | 'no' = 'yes'): RunnerEngineHealth[] => [
  {
    engine: 'cursor',
    installed: true,
    auth: defaultAuth,
    accounts: [
      { id: 'default', home: DEFAULT_HOME, auth: defaultAuth },
      { id: WORK, name: 'Work', home: WORK_HOME, auth: 'yes' },
    ],
  },
];

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('P4a Cursor CLI accounts on PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, quiet);
  const workspaces = new WorkspacesService(prisma);
  const runners = new RunnersService(prisma);
  const claims = new RealQueueService(prisma, quiet, new ProviderPlanUsageService(quiet));
  const api = new RunnerApiController(
    prisma,
    queue,
    quiet,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  const internals = api as unknown as {
    drainLoginRequest(runnerId: string, capabilities: string): Promise<unknown>;
    drainAccountRemoveRequest(runnerId: string, capabilities: string): Promise<unknown>;
  };
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An owner, a runner that runs Cursor CLI with Default and Work, and a workspace on it. */
  async function machine(
    label: string,
    opts: { capabilities?: string[]; engines?: RunnerEngineHealth[]; workspace?: Partial<Prisma.WorkspaceUncheckedCreateInput> } = {},
  ) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@cursor-accounts.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: opts.capabilities ?? RUNS_CURSOR,
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
        engines: (opts.engines ?? engines()) as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, ...opts.workspace },
    });
    return { ownerId, runnerId, workspaceId };
  }

  /** A built-in Cursor CLI session on that machine, waiting to be claimed. */
  async function cursorSession(
    m: { ownerId: string; runnerId: string; workspaceId: string },
    extra: Partial<Prisma.SessionUncheckedCreateInput> = {},
  ) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId: m.ownerId,
        creatorId: m.ownerId,
        workspaceId: m.workspaceId,
        assignedRunnerId: m.runnerId,
        title: 'cursor session',
        prompt: 'fix the flaky test',
        provider: AgentProvider.CURSOR,
        providerBuiltin: true,
        engine: AgentProvider.CURSOR,
        model: 'default[]',
        usesRuntimeDefaultModel: true,
        permissionMode: PermissionMode.ACCEPT_EDITS,
        status: RunStatus.PENDING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...extra,
      },
    });
    return id;
  }

  async function row(id: string) {
    const r = await sql.query('SELECT cursor_account, cursor_account_pinned FROM "session" WHERE id = $1::uuid', [id]);
    return r.rows[0] as { cursor_account: string | null; cursor_account_pinned: boolean };
  }
  /** What the runner is handed when it claims its one PENDING session: that session's environment. */
  const claimedEnv = async (runnerId: string) => {
    const claimed = await claims.claimSessionForRunner({ id: runnerId, supportedProviders: CURRENT });
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.agent.provider, AgentProvider.CURSOR);
    return claimed.agent.env ?? {};
  };

  await t.test('P4a the columns are the ones 0427 says', async () => {
    const { rows } = await sql.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name IN ('cursor_account', 'cursor_account_pinned', 'login_expires_at', 'login_reason')
        ORDER BY table_name, column_name`,
    );
    assert.deepEqual(rows, [
      { table_name: 'runner', column_name: 'login_expires_at', data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null },
      { table_name: 'runner', column_name: 'login_reason', data_type: 'text', is_nullable: 'YES', column_default: null },
      { table_name: 'session', column_name: 'cursor_account', data_type: 'text', is_nullable: 'YES', column_default: null },
      { table_name: 'session', column_name: 'cursor_account_pinned', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      { table_name: 'workspace', column_name: 'cursor_account', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
  });

  await t.test('P4a a workspace and a session pick a Cursor CLI account, or leave it to Automatic', async () => {
    // A workspace stores the id it is given, clears it with null, and leaves it alone when a patch says
    // nothing about it. NULL is Automatic.
    const m = await machine('picks');
    const created = await workspaces.create(m.ownerId, { name: 'picked', runnerId: m.runnerId, cursorAccount: WORK });
    assert.equal(created.cursorAccount, WORK);
    assert.equal((await workspaces.update(m.ownerId, created.id, { name: 'renamed' })).cursorAccount, WORK);
    assert.equal((await workspaces.update(m.ownerId, created.id, { cursorAccount: 'default' })).cursorAccount, 'default');
    assert.equal((await workspaces.update(m.ownerId, created.id, { cursorAccount: null })).cursorAccount, null);
    assert.equal((await workspaces.get(m.ownerId, created.id)).cursorAccount, null);

    // Automatic: nothing reports Cursor CLI's quota yet, so a new session starts on Default — chosen,
    // not pinned, so Orbit may move it once there is something to move it by.
    const automatic = await sessions.create(m.ownerId, { prompt: 'hi', workspaceId: m.workspaceId, provider: 'cursor' });
    assert.deepEqual(await row(automatic.id), { cursor_account: 'default', cursor_account_pinned: false });
    // Default signed out: the account that is not.
    const lapsed = await machine('lapsed', { engines: engines('no') });
    const elsewhere = await sessions.create(lapsed.ownerId, { prompt: 'hi', workspaceId: lapsed.workspaceId, provider: 'cursor' });
    assert.deepEqual(await row(elsewhere.id), { cursor_account: WORK, cursor_account_pinned: false });
    // Picked by hand: pinned there.
    const byHand = await sessions.create(m.ownerId, { prompt: 'hi', workspaceId: m.workspaceId, provider: 'cursor', cursorAccount: WORK });
    assert.deepEqual(await row(byHand.id), { cursor_account: WORK, cursor_account_pinned: true });
    // A workspace that picked one decides: the session follows it.
    const decided = await machine('decided', { workspace: { cursorAccount: WORK } });
    const follows = await sessions.create(decided.ownerId, { prompt: 'hi', workspaceId: decided.workspaceId, provider: 'cursor' });
    assert.deepEqual(await row(follows.id), { cursor_account: null, cursor_account_pinned: false });
    // An account is an id, never a path.
    await assert.rejects(
      sessions.create(m.ownerId, { prompt: 'hi', workspaceId: m.workspaceId, provider: 'cursor', cursorAccount: '../.cursor' }),
      /cursorAccount must be "default" or the id of one of the runner's accounts/,
    );
    // Another engine's session takes no Cursor CLI account, whatever is asked.
    const claude = await sessions.create(m.ownerId, { prompt: 'hi', workspaceId: m.workspaceId, provider: 'claude', cursorAccount: WORK });
    assert.deepEqual(await row(claude.id), { cursor_account: null, cursor_account_pinned: false });
  });

  await t.test('P4a dispatch hands the runner the account its session runs on', async () => {
    // The workspace's pick, in place of a directory typed into its env by hand.
    const picked = await machine('workspace-pick', {
      workspace: { cursorAccount: WORK, env: { [DIR_VAR]: '/srv/typed-by-hand', ORBIT_TEST: '1' } },
    });
    await cursorSession(picked);
    const env = await claimedEnv(picked.runnerId);
    assert.equal(env[DIR_VAR], WORK_HOME);
    assert.equal(env.ORBIT_TEST, '1', "the rest of the workspace's env rides along");

    // The session's own pick comes ahead of its workspace's.
    const own = await machine('session-pick');
    await cursorSession(own, { cursorAccount: WORK, cursorAccountPinned: true });
    assert.equal((await claimedEnv(own.runnerId))[DIR_VAR], WORK_HOME);
    // Default is the runner's own directory: nothing to hand over.
    const onDefault = await machine('default-pick', { workspace: { cursorAccount: WORK } });
    await cursorSession(onDefault, { cursorAccount: 'default', cursorAccountPinned: true });
    assert.equal((await claimedEnv(onDefault.runnerId))[DIR_VAR], undefined);
  });

  await t.test('P4a an account the runner does not report runs a Cursor CLI session on Default', async () => {
    const gone = await machine('gone', { workspace: { cursorAccount: GONE } });
    await cursorSession(gone);
    assert.equal((await claimedEnv(gone.runnerId))[DIR_VAR], undefined);
    const goneSession = await machine('gone-session');
    await cursorSession(goneSession, { cursorAccount: GONE, cursorAccountPinned: true });
    assert.equal((await claimedEnv(goneSession.runnerId))[DIR_VAR], undefined);

    // So does every pick on a runner that lists no Cursor CLI accounts.
    const unlisted = await machine('no-accounts', {
      engines: [{ engine: 'cursor', installed: true, auth: 'yes' }],
      workspace: { cursorAccount: WORK },
    });
    await cursorSession(unlisted, { cursorAccount: WORK, cursorAccountPinned: true });
    assert.equal((await claimedEnv(unlisted.runnerId))[DIR_VAR], undefined);
  });

  await t.test('P4a a Cursor CLI sign-in or removal goes only to a runner that declares it, and an older one is told to update', async () => {
    const NAMED = 'This runner is too old to sign in another Cursor account — update it, then try again.';
    const REMOVE = 'This runner is too old to remove a Cursor account — update it, then try again.';
    const OLD = RUNS_CURSOR.join(',');
    const CAPABLE = [...RUNS_CURSOR, CURSOR_ACCOUNT_LOGIN_V1, CURSOR_ACCOUNT_REMOVE_V1];

    // It runs Cursor CLI sessions and keeps no Cursor CLI accounts: refused at the start.
    const old = await machine('old');
    await assert.rejects(runners.startLogin(old.ownerId, old.runnerId, { engine: 'cursor', accountName: 'Work' }), { message: NAMED });
    await assert.rejects(runners.startLogin(old.ownerId, old.runnerId, { engine: 'cursor' }), { message: CURSOR_LOGIN_TOO_OLD });
    await assert.rejects(runners.removeAccount(old.ownerId, old.runnerId, 'cursor', WORK), { message: REMOVE });
    const untouched = await db.runner.findUniqueOrThrow({ where: { id: old.runnerId } });
    assert.deepEqual(
      { login: untouched.loginStatus, removal: untouched.codexAccountRemoveStatus },
      { login: null, removal: null },
      'a refused request writes nothing',
    );

    // One that declares both: the name, and the account to remove, are handed over.
    const current = await machine('current', { capabilities: CAPABLE });
    await runners.startLogin(current.ownerId, current.runnerId, { engine: 'cursor', accountName: ' Work ' });
    const started = await db.runner.findUniqueOrThrow({ where: { id: current.runnerId } });
    assert.deepEqual(await internals.drainLoginRequest(current.runnerId, CAPABLE.join(',')), {
      action: 'start',
      engine: 'cursor',
      attempt: started.loginAt!.toISOString(),
      accountName: 'Work',
    });
    await runners.removeAccount(current.ownerId, current.runnerId, 'cursor', WORK);
    const removing = await db.runner.findUniqueOrThrow({ where: { id: current.runnerId } });
    assert.deepEqual(await internals.drainAccountRemoveRequest(current.runnerId, CAPABLE.join(',')), {
      engine: 'cursor',
      account: WORK,
      attempt: removing.codexAccountRemoveAt!.toISOString(),
    });

    // Declared at its last heartbeat, and not by the process polling now: refused at the heartbeat.
    await runners.startLogin(current.ownerId, current.runnerId, { engine: 'cursor' });
    assert.equal(await internals.drainLoginRequest(current.runnerId, OLD), undefined);
    const refused = await runners.getLoginState(current.ownerId, current.runnerId);
    assert.deepEqual({ status: refused.status, message: refused.message }, { status: 'failed', message: CURSOR_LOGIN_TOO_OLD });
    await runners.removeAccount(current.ownerId, current.runnerId, 'cursor', WORK);
    assert.equal(await internals.drainAccountRemoveRequest(current.runnerId, OLD), undefined);
    const removal = await db.runner.findUniqueOrThrow({ where: { id: current.runnerId } });
    assert.deepEqual(
      { status: removal.codexAccountRemoveStatus, message: removal.codexAccountRemoveMessage },
      { status: 'failed', message: REMOVE },
    );
  });
});
