/**
 * NO SESSION RUNS ON A DEFAULT ITS OWNER REMOVED FROM ORBIT.
 *
 * A runner's owner may remove its Default account of an engine from Orbit (runner.default_removed)
 * while the runner reports another account of that engine. From then on Automatic chooses among the
 * accounts that remain, and every session that would have run on Default runs on that choice instead.
 * On real PostgreSQL:
 *
 *   (1) A new session on Automatic starts on a remaining account — the only one, or the one Automatic
 *       ranks first of two — and so does one whose workspace is set to Default.
 *   (2) A queued session on Default — picked by hand and pinned, set by its workspace, or created
 *       before accounts with none — is moved by the claim that starts it to Automatic's pick, unpinned,
 *       with a transcript line saying why, and is dispatched with that account's CODEX_HOME. So is one
 *       on a runner that cannot carry a conversation to another account.
 *   (3) An idle engine resident on Default gets the reload that re-spawns it on the pick ahead of the
 *       next message, and the reload is handed out with the pick's CODEX_HOME.
 *   (4) An engine resident on Default with a message queued behind its turn is handed nothing more
 *       there: the inbox puts the session back in the queue, and the claim moves it.
 *   (5) With every remaining account spent, the pick is the first to free up, and the session is
 *       dispatched there; with every one paused, the session waits for the first to free up — never on
 *       Default.
 *   (6) A Claude turn that ran on Default and met its usage limit moves the session to the pick, pinned
 *       or not, and the retry's quota gate judges the account it moved to: it is re-sent at once and
 *       dispatched there, though Default's week is spent for days.
 *   (7) With no other account reported, the record changes nothing: Default is where sessions start,
 *       stay and are dispatched, exactly as before.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-default-removed.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  AgentProvider,
  RunEventType,
  RunStatus as SharedRunStatus,
  type PlanUsage,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CLAUDE_ACCOUNT_MOVE_V1, CODEX_ACCOUNT_MOVE_V1 } from '../providers/account-move-capability';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { QueueService as RealQueueService } from '../queue/queue.service';
import { AutoRetryService } from './auto-retry.service';
import { SESSION_RUNNER_OFFLINE_AFTER_MS } from './session-state';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = '3fa91c2e';
const TEAM = '7b02d9e1';
const home = (engine: 'codex' | 'claude', id: string) =>
  id === 'default' ? `/root/.${engine}` : `/root/.orbit/${engine}-accounts/${id}`;
/** When windows reset and pauses end: far enough out that every clock reading them finds them ahead. */
const FIRST = '2099-01-01T04:00:00.000Z';
const SECOND = '2099-01-01T06:00:00.000Z';
const THIRD = '2099-01-01T08:00:00.000Z';
const MOVED = 'Switched to Work — Default is no longer used by Orbit';

/** Codex and Claude Code, each reporting Default and `others`, all signed in. */
function enginesWith(others: string[]): RunnerEngineHealth[] {
  return (['codex', 'claude'] as const).map((engine) => ({
    engine,
    installed: true,
    auth: 'yes' as const,
    accounts: ['default', ...others].map((id) => ({
      id,
      ...(id === WORK ? { name: 'Work' } : id === TEAM ? { name: 'Team' } : {}),
      home: home(engine, id),
      ...(engine === 'codex' ? { codexHome: home(engine, id) } : {}),
      auth: 'yes' as const,
    })),
  }));
}

/** Codex's quota: Default `defaultUsed`% of a window back FIRST — the soonest, so Automatic would start
 *  there were it in use — and each other account its own. */
function codexUsage(defaultUsed: number, others: Record<string, [used: number, resetsAt: string]>): PlanUsage {
  return {
    codex: {
      provider: AgentProvider.CODEX,
      primary: { utilization: defaultUsed, windowDurationMins: 10080, resetsAt: FIRST },
      accounts: Object.fromEntries(Object.entries(others).map(([id, [used, resetsAt]]) => [
        id,
        { provider: AgentProvider.CODEX, primary: { utilization: used, windowDurationMins: 10080, resetsAt } },
      ])),
    },
  } as PlanUsage;
}

/** Room on every account; of those left, Team's quota goes to waste first, then Work's. */
const ROOM = codexUsage(0, { [WORK]: [3, THIRD], [TEAM]: [10, SECOND] });

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('no session runs on a Default its owner removed from Orbit', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, quiet);
  const api = new RunnerApiController(
    prisma,
    queue,
    quiet,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  const claims = new RealQueueService(prisma, quiet, new ProviderPlanUsageService(quiet));
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type Machine = { ownerId: string; runnerId: string; workspaceId: string };

  /** An owner, a runner whose Codex Default is removed from Orbit (unless `removed` says otherwise),
   *  and a workspace on it. */
  async function machine(label: string, options: {
    others?: string[];
    removed?: string[];
    planUsage?: unknown;
    pauses?: unknown;
    capabilities?: string[];
    workspaceCodexAccount?: string;
  } = {}): Promise<Machine> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@default-removed.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: options.capabilities ?? [CODEX_ACCOUNT_MOVE_V1, CLAUDE_ACCOUNT_MOVE_V1],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
        engines: enginesWith(options.others ?? [WORK]) as unknown as Prisma.InputJsonValue,
        planUsage: (options.planUsage ?? ROOM) as Prisma.InputJsonValue,
        ...(options.pauses ? { accountPauses: options.pauses as Prisma.InputJsonValue } : {}),
        defaultRemoved: options.removed ?? ['codex'],
      },
    });
    await db.workspace.create({
      data: {
        id: workspaceId,
        ownerId,
        runnerId,
        name: `${label}-workspace`,
        enabled: true,
        ...(options.workspaceCodexAccount ? { codexAccount: options.workspaceCodexAccount } : {}),
      },
    });
    return { ownerId, runnerId, workspaceId };
  }

  /** A session of `provider` that ran before, `status`, on the account `extra` names (Default unless). */
  async function sessionOn(
    m: Machine,
    provider: 'codex' | 'claude',
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
        title: `${provider} session`,
        prompt: 'fix the flaky test',
        provider,
        providerBuiltin: true,
        ...(provider === 'codex' ? { codexAccount: 'default' } : { claudeAccount: 'default' }),
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
      `SELECT codex_account, codex_account_pinned, claude_account, claude_account_pinned, pool_switch_notice,
              status::text AS status, error, (EXTRACT(EPOCH FROM retry_at) * 1000)::float8 AS retry_ms
         FROM "session" WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] as {
      codex_account: string | null;
      codex_account_pinned: boolean;
      claude_account: string | null;
      claude_account_pinned: boolean;
      pool_switch_notice: string | null;
      status: string;
      error: string | null;
      retry_ms: number | null;
    };
  }
  const queued = async (id: string) =>
    (
      await sql.query(
        `SELECT kind, content FROM "conversation_turn" WHERE session_id = $1::uuid AND status = 'PENDING' ORDER BY seq`,
        [id],
      )
    ).rows as Array<{ kind: string; content: string }>;
  const reloads = async (id: string) =>
    (
      await sql.query(
        `SELECT content FROM "conversation_turn" WHERE session_id = $1::uuid AND kind = 'reload' AND status = 'PENDING' ORDER BY seq`,
        [id],
      )
    ).rows as Array<{ content: string }>;
  const claimOn = async (runnerId: string) => {
    const claimed = await claims.claimSessionForRunner({ id: runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    return claimed;
  };
  const dequeue = (api as unknown as {
    dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
      { kind: string; env?: Record<string, string> } | null
    >;
  }).dequeueTurn.bind(api);
  const moved = (r: Awaited<ReturnType<typeof row>>) =>
    ({ account: r.codex_account, pinned: r.codex_account_pinned, notice: r.pool_switch_notice });

  await t.test('(1) a new session on Automatic starts on a remaining account, the only one included', async () => {
    // Default has all the room there is and resets first; Work is all that remains.
    const one = await machine('create-one', { planUsage: codexUsage(0, { [WORK]: [70, THIRD] }) });
    const onOne = await sessions.create(one.ownerId, { prompt: 'hi', workspaceId: one.workspaceId, provider: 'codex' });
    assert.deepEqual(moved(await row(onOne.id)), { account: WORK, pinned: false, notice: null });

    // Two remain: Team's quota goes to waste first, so Team takes it — never Default.
    const two = await machine('create-two', { others: [WORK, TEAM] });
    const onTwo = await sessions.create(two.ownerId, { prompt: 'hi', workspaceId: two.workspaceId, provider: 'codex' });
    assert.equal((await row(onTwo.id)).codex_account, TEAM);

    // A workspace set to Default runs its sessions on Automatic.
    const setToDefault = await machine('create-workspace', { workspaceCodexAccount: 'default' });
    const onWorkspace = await sessions.create(setToDefault.ownerId, { prompt: 'hi', workspaceId: setToDefault.workspaceId, provider: 'codex' });
    assert.deepEqual(moved(await row(onWorkspace.id)), { account: WORK, pinned: false, notice: null });
  });

  await t.test('(2) the claim moves a queued session off Default — pinned, by its workspace, or with none — and dispatches it on the pick', async () => {
    const cases: Array<[string, Partial<Prisma.SessionUncheckedCreateInput>, Parameters<typeof machine>[1]]> = [
      ['picked by hand and pinned', { codexAccountPinned: true }, {}],
      ['set by its workspace', { codexAccount: null }, { workspaceCodexAccount: 'default' }],
      ['created before accounts, with none', { codexAccount: null }, {}],
      ['on a slot the runner no longer reports', { codexAccount: 'c0ffee42', codexAccountPinned: true }, {}],
      ['on a runner that cannot carry the conversation', { codexAccountPinned: true }, { capabilities: [] }],
    ];
    for (const [what, extra, options] of cases) {
      const m = await machine(`claim-${what.replace(/\W+/g, '-')}`, options);
      const id = await sessionOn(m, 'codex', RunStatus.PENDING, extra);
      const claimed = await claimOn(m.runnerId);
      assert.equal(claimed.agent.env?.CODEX_HOME, home('codex', WORK), what);
      assert.deepEqual(moved(await row(id)), { account: WORK, pinned: false, notice: MOVED }, what);
      // An engine already resident on Default is re-spawned on Work before the turn this claim hands it.
      assert.deepEqual(await reloads(id), [{ content: JSON.stringify({ provider: 'codex' }) }], what);
    }
  });

  await t.test('(3) an idle engine on Default is re-spawned on the pick ahead of its next message', async () => {
    const m = await machine('idle');
    const id = await sessionOn(m, 'codex', RunStatus.AWAITING_INPUT, { codexAccountPinned: true });
    await sessions.createTurn(m.ownerId, id, { content: 'go on', clientTurnId: randomUUID() });
    assert.deepEqual(await queued(id), [
      { kind: 'reload', content: JSON.stringify({ provider: 'codex' }) },
      { kind: 'message', content: 'go on' },
    ]);
    assert.deepEqual(moved(await row(id)), { account: WORK, pinned: false, notice: MOVED });
    const turn = await dequeue(id, m.runnerId, null);
    assert.equal(turn?.kind, 'reload');
    assert.equal(turn?.env?.CODEX_HOME, home('codex', WORK));
  });

  await t.test('(4) an engine on Default is handed no further message there: the session goes back to the claim', async () => {
    const m = await machine('resident');
    const id = await sessionOn(m, 'codex', RunStatus.RUNNING, { codexAccountPinned: true });
    await db.conversationTurn.create({
      data: { sessionId: id, seq: 1, clientTurnId: `turn-${randomUUID()}`, kind: 'message', content: 'and the next', status: 'PENDING' },
    });
    await assert.rejects(dequeue(id, m.runnerId, null), (err: { getStatus?: () => number; message?: string }) => {
      assert.equal(err.getStatus?.(), 409);
      assert.match(err.message ?? '', /no longer used by Orbit/);
      return true;
    });
    const back = await row(id);
    assert.deepEqual({ status: back.status, error: back.error, account: back.codex_account }, { status: 'PENDING', error: null, account: 'default' });
    // The claim that picks it up moves it, and its engine starts on Work with the message waiting.
    const claimed = await claimOn(m.runnerId);
    assert.equal(claimed.agent.env?.CODEX_HOME, home('codex', WORK));
    assert.deepEqual(moved(await row(id)), { account: WORK, pinned: false, notice: MOVED });
  });

  await t.test('(5) every remaining account spent: the first to free up; every one paused: it waits — never on Default', async () => {
    // Work back THIRD, Team back SECOND; Default, with room, is no candidate.
    const spent = codexUsage(0, { [WORK]: [100, THIRD], [TEAM]: [100, SECOND] });
    const fresh = await machine('all-spent-create', { others: [WORK, TEAM], planUsage: spent });
    const created = await sessions.create(fresh.ownerId, { prompt: 'hi', workspaceId: fresh.workspaceId, provider: 'codex' });
    assert.equal((await row(created.id)).codex_account, TEAM);
    const m = await machine('all-spent-claim', { others: [WORK, TEAM], planUsage: spent });
    const id = await sessionOn(m, 'codex', RunStatus.PENDING, { codexAccountPinned: true });
    const claimed = await claimOn(m.runnerId);
    assert.equal(claimed.agent.env?.CODEX_HOME, home('codex', TEAM));
    assert.equal((await row(id)).codex_account, TEAM);

    // Both paused by hand: Team's pause ends first, and the session waits for it, still not running.
    const paused = await machine('all-paused', { others: [WORK, TEAM], pauses: { codex: { [WORK]: THIRD, [TEAM]: SECOND } } });
    const held = await sessionOn(paused, 'codex', RunStatus.PENDING, { codexAccountPinned: true });
    assert.equal(await claims.claimSessionForRunner({ id: paused.runnerId }, 0, false, false), null, 'dispatched while every account is paused');
    const waiting = await row(held);
    assert.deepEqual({ status: waiting.status, error: waiting.error }, { status: 'PENDING', error: `Account paused until ${SECOND}` });
    // Team resumed: the claim starts it there.
    await db.runner.update({ where: { id: paused.runnerId }, data: { accountPauses: { codex: { [WORK]: THIRD } } } });
    const resumed = await claimOn(paused.runnerId);
    assert.equal(resumed.agent.env?.CODEX_HOME, home('codex', TEAM));
    assert.equal((await row(held)).codex_account, TEAM);
  });

  await t.test('(6) a turn that met Default’s usage limit moves the session, and its retry is judged on the account it moved to', async () => {
    // Claude's Default is removed: its week is spent for days, Work has room.
    const claudeUsage = {
      claude: {
        provider: AgentProvider.CLAUDE,
        sevenDay: { utilization: 100, resetsAt: THIRD },
        accounts: { [WORK]: { provider: AgentProvider.CLAUDE, fiveHour: { utilization: 8, resetsAt: SECOND } } },
      },
    };
    const m = await machine('limit', { removed: ['claude'], planUsage: claudeUsage });
    const id = await sessionOn(m, 'claude', RunStatus.RUNNING, { engineTurnActive: true, claudeAccountPinned: true });
    const turn = await db.conversationTurn.create({
      data: {
        sessionId: id,
        seq: 1,
        clientTurnId: `turn-${randomUUID()}`,
        kind: 'message',
        content: 'and the second one',
        status: 'IN_FLIGHT',
        deliveredAt: new Date(),
        leaseDeadlineAt: new Date(Date.now() + 300_000),
        leaseGeneration: randomUUID(),
      },
      select: { id: true },
    });
    const limit = "You've hit your weekly limit";
    await api.events({ id: m.runnerId }, id, {
      events: [{ seq: 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId: turn.id, payload: { text: limit } }],
    });
    await api.turnComplete({ id: m.runnerId }, id, {
      turnId: turn.id, status: SharedRunStatus.FAILED, subtype: 'success', result: limit, numTurns: 1, costUsd: 0,
    });
    const after = await row(id);
    assert.deepEqual(
      { account: after.claude_account, pinned: after.claude_account_pinned, notice: after.pool_switch_notice },
      { account: WORK, pinned: false, notice: MOVED },
    );
    assert.ok(after.retry_ms !== null && after.retry_ms <= Date.now() + 1_000, `armed for ${after.retry_ms}, not now`);

    // The sweep's quota gate judges Work, which has room: it re-sends now rather than waiting for
    // Default's week, and the claim dispatches it on Work.
    const at = new Date(Math.max(after.retry_ms!, Date.now()) + 1_000);
    await db.runner.update({ where: { id: m.runnerId }, data: { lastHeartbeatAt: new Date(at.getTime() - SESSION_RUNNER_OFFLINE_AFTER_MS / 2) } });
    await new AutoRetryService(prisma, sessions, quiet).sweep(at);
    const revived = await db.session.findUniqueOrThrow({ where: { id }, select: { status: true, retryAttempts: true } });
    assert.deepEqual(revived, { status: RunStatus.PENDING, retryAttempts: 1 }, 'held back by the quota of a Default nobody uses');
    const claimed = await claims.claimSessionForRunner({ id: m.runnerId }, 0, true, false);
    assert.equal(claimed?.agent.env?.CLAUDE_CONFIG_DIR, home('claude', WORK));
  });

  await t.test('(7) with no other account reported, sessions start, stay and are dispatched on Default as before', async () => {
    const fresh = await machine('alone-create', { others: [], planUsage: codexUsage(0, {}) });
    const created = await sessions.create(fresh.ownerId, { prompt: 'hi', workspaceId: fresh.workspaceId, provider: 'codex' });
    assert.deepEqual(moved(await row(created.id)), { account: null, pinned: false, notice: null });
    const m = await machine('alone-claim', { others: [], planUsage: codexUsage(0, {}) });
    const id = await sessionOn(m, 'codex', RunStatus.PENDING, { codexAccountPinned: true });
    const claimed = await claimOn(m.runnerId);
    assert.equal(claimed.agent.env?.CODEX_HOME, undefined);
    assert.deepEqual(moved(await row(id)), { account: 'default', pinned: true, notice: null });
    assert.deepEqual(await reloads(id), []);
  });
});
