/**
 * WHICH OF ITS RUNNER'S KIMI CODE ACCOUNTS A SESSION RUNS ON — AND WHAT A RUNNER TOO OLD TO KEEP THEM
 * APART IS NEVER HANDED.
 *
 * Kimi Code keeps its whole login in one directory, KIMI_CODE_HOME, so a runner keeps Kimi accounts the
 * way it keeps Codex's CODEX_HOMEs and Claude Code's CLAUDE_CONFIG_DIRs: Default is the one its own
 * environment selects, every other one a directory it added, each reported in `runner.engines`. The
 * choice is migration 0408's workspace.kimi_account and session.kimi_account(_pinned). On real
 * PostgreSQL:
 *
 *   (0) The columns are the ones 0408 says: two nullable TEXT and one BOOLEAN NOT NULL DEFAULT false.
 *   (1) A Kimi session is dispatched with its account's directory as KIMI_CODE_HOME: the account its
 *       workspace picked, in place of one typed into the workspace's env; the one picked for the session
 *       ahead of the workspace's; and, with nothing picked, the one Automatic starts it on.
 *   (2) An account the runner does not report runs on Default: no KIMI_CODE_HOME is handed over.
 *   (3) A runner that does not declare kimi-account-login/v1 is refused a named Kimi sign-in and told to
 *       update; one that does is handed the name with the site it signs in on.
 *   (4) Without kimi-account-move/v1 a Kimi session that has said something stays on its account —
 *       refused in the words a Codex or Claude move is refused in, and not moved off a spent account at
 *       its claim either; with it the move is made, and its engine re-spawned in the other directory.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/kimi-account.pg.spec.ts
 *
 * Production code throughout: SessionsService, QueueService, RunnersService and RunnerApiController.
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { AgentProvider, KIMI_LOGIN_REGION_V1, type PlanUsage, type RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { KIMI_ACCOUNT_MOVE_V1 } from '../providers/account-move-capability';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { QueueService as RealQueueService } from '../queue/queue.service';
import { KIMI_ACCOUNT_LOGIN_V1, RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersService } from '../runners/runners.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = 'c41e0b7a';
/** An id no Kimi account on these runners has: removed, or one on another machine. */
const GONE = 'c0ffee42';
const DEFAULT_HOME = '/root/.kimi-code';
const WORK_HOME = '/root/.orbit/kimi-accounts/c41e0b7a';
const LATER = '2099-01-01T08:00:00Z';

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'kimi',
    installed: true,
    auth: 'yes',
    kimiRegion: 'mainland-cn',
    accounts: [
      { id: 'default', home: DEFAULT_HOME, auth: 'yes', kimiRegion: 'mainland-cn' },
      { id: WORK, name: 'Work', home: WORK_HOME, auth: 'yes', kimiRegion: 'global' },
    ],
  },
];

/** Default's coding month spent while its 5 hours read 0%; Work with room. */
const USAGE: PlanUsage = {
  kimi: {
    provider: AgentProvider.KIMI,
    fiveHour: { utilization: 0, resetsAt: LATER },
    monthCode: { utilization: 100, resetsAt: LATER },
    accounts: {
      [WORK]: {
        provider: AgentProvider.KIMI,
        fiveHour: { utilization: 12, resetsAt: LATER },
        month: { utilization: 30, resetsAt: LATER },
      },
    },
  },
};

/** What every runner too old to carry a conversation to another account is told, whatever the engine. */
const CANNOT_MOVE =
  "this session's runner cannot move a conversation to another account yet — it updates itself when no turn is running";

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('which of its runner’s Kimi Code accounts a session runs on', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, quiet);
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
    dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
      { kind: string; env?: Record<string, string> } | null
    >;
  };
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An owner, a runner with Default and Work signed in to Kimi Code, and a workspace on it. */
  async function machine(
    label: string,
    opts: { capabilities?: string[]; engines?: RunnerEngineHealth[]; workspace?: Partial<Prisma.WorkspaceUncheckedCreateInput> } = {},
  ) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@kimi-accounts.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: opts.capabilities ?? [],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
        engines: (opts.engines ?? ENGINES) as unknown as Prisma.InputJsonValue,
        planUsage: USAGE as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, ...opts.workspace },
    });
    return { ownerId, runnerId, workspaceId };
  }

  /** A built-in Kimi session on that machine, `status`, that has said something unless told otherwise. */
  async function kimiSession(
    m: { ownerId: string; runnerId: string; workspaceId: string },
    status: RunStatus,
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
        title: 'kimi session',
        prompt: 'fix the flaky test',
        provider: AgentProvider.KIMI,
        providerBuiltin: true,
        status,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
        numTurns: 2,
        ...extra,
      },
    });
    return id;
  }

  async function row(id: string) {
    const r = await sql.query(
      'SELECT kimi_account, kimi_account_pinned, pool_switch_notice FROM "session" WHERE id = $1::uuid',
      [id],
    );
    return r.rows[0] as { kimi_account: string | null; kimi_account_pinned: boolean; pool_switch_notice: string | null };
  }
  const reloads = async (id: string) =>
    (
      await sql.query(
        `SELECT content, status::text AS status FROM "conversation_turn" WHERE session_id = $1::uuid AND kind = 'reload' ORDER BY seq`,
        [id],
      )
    ).rows as Array<{ content: string; status: string }>;
  /** What the runner is handed when it claims its one PENDING session: that session's environment. */
  const claimedEnv = async (runnerId: string) => {
    const claimed = await claims.claimSessionForRunner({ id: runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    return claimed.agent.env ?? {};
  };

  await t.test('(0) the columns are the ones 0408 says', async () => {
    const { rows } = await sql.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name IN ('kimi_account', 'kimi_account_pinned')
        ORDER BY table_name, column_name`,
    );
    assert.deepEqual(rows, [
      { table_name: 'session', column_name: 'kimi_account', data_type: 'text', is_nullable: 'YES', column_default: null },
      { table_name: 'session', column_name: 'kimi_account_pinned', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      { table_name: 'workspace', column_name: 'kimi_account', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
  });

  await t.test("(1) a Kimi session is dispatched with its account's directory as KIMI_CODE_HOME", async () => {
    // The workspace's pick, in place of a directory typed into its env by hand.
    const picked = await machine('workspace-pick', {
      workspace: { kimiAccount: WORK, env: { KIMI_CODE_HOME: '/srv/typed-by-hand', ORBIT_TEST: '1' } },
    });
    await kimiSession(picked, RunStatus.PENDING, { numTurns: 0 });
    const env = await claimedEnv(picked.runnerId);
    assert.equal(env.KIMI_CODE_HOME, WORK_HOME);
    assert.equal(env.ORBIT_TEST, '1', "the rest of the workspace's env rides along");

    // The session's own pick comes ahead of its workspace's: Default, the runner's own directory.
    const own = await machine('session-pick', { workspace: { kimiAccount: WORK } });
    await kimiSession(own, RunStatus.PENDING, { numTurns: 0, kimiAccount: 'default', kimiAccountPinned: true });
    assert.equal((await claimedEnv(own.runnerId)).KIMI_CODE_HOME, undefined);

    // Nothing picked: Automatic starts it on the account whose quota will not stop it — Default's
    // coding month is spent — and a pick made by hand pins it.
    const auto = await machine('automatic');
    const automatic = await sessions.create(auto.ownerId, { prompt: 'hi', workspaceId: auto.workspaceId, provider: 'kimi' });
    assert.deepEqual(
      { account: (await row(automatic.id)).kimi_account, pinned: (await row(automatic.id)).kimi_account_pinned },
      { account: WORK, pinned: false },
    );
    assert.equal((await claimedEnv(auto.runnerId)).KIMI_CODE_HOME, WORK_HOME);
    const byHand = await sessions.create(auto.ownerId, { prompt: 'hi', workspaceId: auto.workspaceId, provider: 'kimi', kimiAccount: 'default' });
    assert.deepEqual(
      { account: (await row(byHand.id)).kimi_account, pinned: (await row(byHand.id)).kimi_account_pinned },
      { account: 'default', pinned: true },
    );
    await assert.rejects(
      sessions.create(auto.ownerId, { prompt: 'hi', workspaceId: auto.workspaceId, provider: 'kimi', kimiAccount: '../.kimi-code' }),
      /kimiAccount must be "default" or the id of one of the runner's accounts/,
    );
  });

  await t.test('(2) an account the runner does not report runs on Default', async () => {
    const gone = await machine('gone', { workspace: { kimiAccount: GONE } });
    await kimiSession(gone, RunStatus.PENDING, { numTurns: 0 });
    assert.equal((await claimedEnv(gone.runnerId)).KIMI_CODE_HOME, undefined);

    // So does every pick on a runner too old to list its Kimi accounts.
    const older = await machine('no-accounts', {
      engines: [{ engine: 'kimi', installed: true, auth: 'yes' }],
      workspace: { kimiAccount: WORK },
    });
    await kimiSession(older, RunStatus.PENDING, { numTurns: 0, kimiAccount: WORK });
    assert.equal((await claimedEnv(older.runnerId)).KIMI_CODE_HOME, undefined);
  });

  await t.test('(3) a named Kimi sign-in goes only to a runner that declares kimi-account-login/v1', async () => {
    const refusal = 'This runner is too old to sign in another Kimi account — update it, then try again.';
    // It chooses Kimi's site, but keeps one Kimi login: a named sign-in would land on Default's.
    const old = await machine('login-old', { capabilities: [KIMI_LOGIN_REGION_V1] });
    for (const dto of [
      { engine: 'kimi' as const, accountName: 'Work', region: 'global' as const },
      { engine: 'kimi' as const, account: WORK },
    ]) {
      await runners.startLogin(old.ownerId, old.runnerId, dto);
      assert.equal(await internals.drainLoginRequest(old.runnerId, KIMI_LOGIN_REGION_V1), undefined, JSON.stringify(dto));
      const state = await runners.getLoginState(old.ownerId, old.runnerId);
      assert.deepEqual({ status: state.status, message: state.message }, { status: 'failed', message: refusal });
    }

    const current = await machine('login-current', { capabilities: [KIMI_LOGIN_REGION_V1, KIMI_ACCOUNT_LOGIN_V1] });
    await runners.startLogin(current.ownerId, current.runnerId, { engine: 'kimi', accountName: ' Work ', region: 'global' });
    const stored = await db.runner.findUniqueOrThrow({ where: { id: current.runnerId } });
    assert.deepEqual(
      { name: stored.loginAccountName, region: stored.loginRegion, account: stored.loginAccount },
      { name: 'Work', region: 'global', account: null },
    );
    assert.deepEqual(await internals.drainLoginRequest(current.runnerId, `${KIMI_LOGIN_REGION_V1},${KIMI_ACCOUNT_LOGIN_V1}`), {
      action: 'start',
      engine: 'kimi',
      attempt: stored.loginAt!.toISOString(),
      accountName: 'Work',
      region: 'global',
    });
  });

  await t.test('(4) a Kimi session that has said something moves only on a runner that carries the conversation', async () => {
    const old = await machine('move-old');
    const id = await kimiSession(old, RunStatus.AWAITING_INPUT, { kimiAccount: 'default' });
    await assert.rejects(sessions.switchAccount(old.ownerId, id, WORK), (err: { getStatus?: () => number; message?: string }) => {
      assert.equal(err.getStatus?.(), 409);
      assert.equal(err.message, CANNOT_MOVE);
      return true;
    });
    assert.deepEqual(
      { account: (await row(id)).kimi_account, pinned: (await row(id)).kimi_account_pinned, notice: (await row(id)).pool_switch_notice },
      { account: 'default', pinned: false, notice: null },
    );
    assert.deepEqual(await reloads(id), []);
    // Nor is one on Automatic moved off its spent account when its next run is claimed there.
    const spent = await machine('claim-old');
    const waiting = await kimiSession(spent, RunStatus.PENDING, { kimiAccount: 'default' });
    assert.equal((await claimedEnv(spent.runnerId)).KIMI_CODE_HOME, undefined);
    assert.equal((await row(waiting)).kimi_account, 'default');

    // A runner that carries it moves it, pins it, owes the line, and re-spawns its engine on Work.
    const current = await machine('move-current', { capabilities: [KIMI_ACCOUNT_MOVE_V1] });
    const moved = await kimiSession(current, RunStatus.AWAITING_INPUT, { kimiAccount: 'default' });
    await sessions.switchAccount(current.ownerId, moved, WORK);
    assert.deepEqual(
      { account: (await row(moved)).kimi_account, pinned: (await row(moved)).kimi_account_pinned, notice: (await row(moved)).pool_switch_notice },
      { account: WORK, pinned: true, notice: 'Switched to Work' },
    );
    assert.deepEqual(await reloads(moved), [{ content: JSON.stringify({ provider: 'kimi' }), status: 'PENDING' }]);
    const turn = await internals.dequeueTurn(moved, current.runnerId, null);
    assert.equal(turn?.kind, 'reload');
    assert.equal(turn?.env?.KIMI_CODE_HOME, WORK_HOME);
  });
});
