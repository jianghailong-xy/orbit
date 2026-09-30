/**
 * WHICH OF ITS RUNNER'S ACCOUNTS A SESSION RUNS ON — PICKED BY HAND, OR LEFT TO ORBIT.
 *
 * A runner can hold several Codex accounts (one CODEX_HOME each) and several Claude Code accounts (one
 * CLAUDE_CONFIG_DIR each). A session picks one on the New Session screen or in the composer's Provider
 * menu — which pins it there — or leaves it to Orbit (Automatic): it starts on the account whose
 * quota resets soonest and moves when that account's usage limit stops it. On real PostgreSQL:
 *
 *   (1) A Claude session nothing picked an account for starts on the one Automatic picks; one picked
 *       by hand is pinned.
 *   (2) Picking another account for a live session pins it there, owes the transcript a line, and
 *       queues the reload that re-spawns its engine with that account's directory.
 *   (3) Back on Automatic it is unpinned and stays where it is — while its account has room.
 *   (4) A runner that cannot carry a conversation to another account is refused the move, and so is
 *       an account that is signed out.
 *   (5) An ended session just stores the pick for the claim that resumes it; one waiting out its old
 *       account's reset goes at once.
 *   (6) A Claude session on Automatic whose reply is its account's usage limit moves to the account
 *       with room, is re-sent at once, and gets the reload that moves its resident engine.
 *   (7) A session moved off an API key onto the built-in Claude engine starts on the account Automatic
 *       picks — not on Default because it followed its workspace — unless it is pinned, or its runner
 *       cannot carry the conversation it already has; a switch that names an account lands there
 *       pinned (or on Automatic, unpinned), live or with the message that revives an ended session.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-account-choice.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { AgentProvider, RunEventType, type PlanUsage, type RunnerEngineHealth } from '@orbit/shared';
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
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = '3fa91c2e';
const CODEX_WORK_HOME = '/root/.orbit/codex-accounts/3fa91c2e';
const CLAUDE_WORK_HOME = '/root/.orbit/claude-accounts/3fa91c2e';
const LATER = '2099-01-01T08:00:00Z';

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' },
      { id: WORK, name: 'Work', home: CODEX_WORK_HOME, codexHome: CODEX_WORK_HOME, auth: 'yes' },
    ],
  },
  {
    engine: 'claude',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.claude', auth: 'yes' },
      { id: WORK, name: 'Work', home: CLAUDE_WORK_HOME, auth: 'yes' },
    ],
  },
];

/** Room everywhere but on Claude's Default, whose weekly window is spent while its 5-hour one reads 0%. */
const USAGE: PlanUsage = {
  codex: {
    provider: AgentProvider.CODEX,
    primary: { utilization: 12, windowDurationMins: 300, resetsAt: LATER },
    accounts: { [WORK]: { provider: AgentProvider.CODEX, primary: { utilization: 3, windowDurationMins: 10080, resetsAt: LATER } } },
  },
  claude: {
    provider: AgentProvider.CLAUDE,
    fiveHour: { utilization: 0, resetsAt: LATER },
    sevenDay: { utilization: 100, resetsAt: LATER },
    accounts: {
      [WORK]: { provider: AgentProvider.CLAUDE, fiveHour: { utilization: 19, resetsAt: LATER }, sevenDay: { utilization: 28, resetsAt: LATER } },
    },
  },
} as PlanUsage;

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('which of its runner’s accounts a session runs on — picked by hand, or left to Orbit', {
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
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An owner, a runner with Default and Work signed in for both engines, and a workspace on it. */
  async function machine(label: string, capabilities = [CODEX_ACCOUNT_MOVE_V1, CLAUDE_ACCOUNT_MOVE_V1], engines = ENGINES) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@accounts.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities,
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
        engines: engines as unknown as Prisma.InputJsonValue,
        planUsage: USAGE as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
    return { ownerId, runnerId, workspaceId };
  }

  /** A session of `provider` on its Default account, `status`, with a turn out on delivery when live. */
  async function sessionOn(
    m: { ownerId: string; runnerId: string; workspaceId: string },
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
              (EXTRACT(EPOCH FROM retry_at) * 1000)::float8 AS retry_ms
         FROM "session" WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] as {
      codex_account: string | null;
      codex_account_pinned: boolean;
      claude_account: string | null;
      claude_account_pinned: boolean;
      pool_switch_notice: string | null;
      retry_ms: number | null;
    };
  }
  const reloads = async (id: string) =>
    (
      await sql.query(
        `SELECT content, status::text AS status FROM "conversation_turn" WHERE session_id = $1::uuid AND kind = 'reload' ORDER BY seq`,
        [id],
      )
    ).rows as Array<{ content: string; status: string }>;
  const refused = async (call: Promise<unknown>, status: number, what: string) => {
    await assert.rejects(call, (err: { getStatus?: () => number; message?: string }) => {
      assert.equal(err.getStatus?.(), status, `${what}: ${err.message}`);
      return true;
    });
  };

  await t.test('(1) a Claude session starts on the account Automatic picks, and a picked one is pinned', async () => {
    const m = await machine('create');
    const automatic = await sessions.create(m.ownerId, { prompt: 'hi', workspaceId: m.workspaceId, provider: 'claude' });
    // Default's weekly window is spent — though its 5-hour one reads 0% — so Work is where it starts.
    assert.deepEqual(
      { account: (await row(automatic.id)).claude_account, pinned: (await row(automatic.id)).claude_account_pinned },
      { account: WORK, pinned: false },
    );
    const picked = await sessions.create(m.ownerId, { prompt: 'hi', workspaceId: m.workspaceId, provider: 'claude', claudeAccount: 'default' });
    assert.deepEqual(
      { account: (await row(picked.id)).claude_account, pinned: (await row(picked.id)).claude_account_pinned },
      { account: 'default', pinned: true },
    );
    const codex = await sessions.create(m.ownerId, { prompt: 'hi', workspaceId: m.workspaceId, provider: 'codex', codexAccount: WORK });
    assert.equal((await row(codex.id)).codex_account_pinned, true);
    assert.equal((await row(codex.id)).claude_account, null, 'a Codex session gets no Claude account');
  });

  await t.test('(2) another account for a live session pins it, owes a line, and re-spawns its engine there', async () => {
    const m = await machine('pick');
    const id = await sessionOn(m, 'codex', RunStatus.AWAITING_INPUT);
    await sessions.switchAccount(m.ownerId, id, WORK);
    const after = await row(id);
    assert.equal(after.codex_account, WORK);
    assert.equal(after.codex_account_pinned, true);
    assert.equal(after.pool_switch_notice, 'Switched to Work');
    assert.deepEqual(await reloads(id), [{ content: JSON.stringify({ provider: 'codex' }), status: 'PENDING' }]);
    // The inbox hands it out with the new account's CODEX_HOME in the engine's environment.
    const dequeue = (api as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
        { kind: string; env?: Record<string, string> } | null
      >;
    }).dequeueTurn.bind(api);
    const turn = await dequeue(id, m.runnerId, null);
    assert.equal(turn?.kind, 'reload');
    assert.equal(turn?.env?.CODEX_HOME, CODEX_WORK_HOME);

    // (3) Back on Automatic: unpinned, and it stays on Work, which has room — no second reload.
    await sessions.switchAccount(m.ownerId, id, 'automatic');
    const automatic = await row(id);
    assert.equal(automatic.codex_account, WORK);
    assert.equal(automatic.codex_account_pinned, false);
    assert.equal((await reloads(id)).length, 1);
  });

  await t.test('(4) no move on a runner that cannot carry the conversation, nor onto a signed-out account', async () => {
    const old = await machine('old-runner', []);
    const onOld = await sessionOn(old, 'claude', RunStatus.AWAITING_INPUT);
    await refused(sessions.switchAccount(old.ownerId, onOld, WORK), 409, 'a runner too old to move it');
    assert.equal((await row(onOld)).claude_account, 'default');
    assert.deepEqual(await reloads(onOld), []);

    const signedOut = ENGINES.map((engine) =>
      engine.engine === 'claude'
        ? { ...engine, accounts: engine.accounts!.map((account) => (account.id === WORK ? { ...account, auth: 'no' as const } : account)) }
        : engine,
    );
    const m = await machine('signed-out', [CODEX_ACCOUNT_MOVE_V1, CLAUDE_ACCOUNT_MOVE_V1], signedOut);
    const id = await sessionOn(m, 'claude', RunStatus.AWAITING_INPUT);
    await refused(sessions.switchAccount(m.ownerId, id, WORK), 409, 'a signed-out account');
    await refused(sessions.switchAccount(m.ownerId, id, 'c0ffee42'), 400, 'an account the runner does not report');
  });

  await t.test('(5) an ended session stores the pick for its next claim; one waiting on the old reset goes now', async () => {
    const m = await machine('ended');
    const done = await sessionOn(m, 'codex', RunStatus.SUCCEEDED);
    await sessions.switchAccount(m.ownerId, done, WORK);
    assert.equal((await row(done)).codex_account, WORK);
    assert.deepEqual(await reloads(done), [], 'nothing is running to reload');

    const waiting = await sessionOn(m, 'codex', RunStatus.FAILED, { retryAt: new Date(LATER) });
    const before = Date.now();
    await sessions.switchAccount(m.ownerId, waiting, WORK);
    const after = await row(waiting);
    assert.ok(after.retry_ms !== null && after.retry_ms >= before - 1_000 && after.retry_ms <= Date.now() + 1_000,
      `not re-sent now: ${after.retry_ms}`);
  });

  await t.test('(6) a Claude session its account’s limit stopped moves, is re-sent now, and its engine is re-spawned', async () => {
    const m = await machine('claude-limit');
    const id = await sessionOn(m, 'claude', RunStatus.RUNNING, { engineTurnActive: true });
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
    const before = Date.now();
    await api.events({ id: m.runnerId }, id, {
      events: [{
        seq: 1,
        type: RunEventType.ASSISTANT,
        ts: new Date().toISOString(),
        turnId: turn.id,
        payload: { text: "You've hit your weekly limit · resets Oct 5, 11am" },
      }],
    });
    const after = await row(id);
    assert.equal(after.claude_account, WORK);
    assert.equal(after.pool_switch_notice, 'Switched to Work — the usage limit on Default is reached');
    assert.ok(after.retry_ms !== null && after.retry_ms >= before - 1_000 && after.retry_ms <= Date.now() + 1_000,
      `not re-sent now: ${after.retry_ms}`);
    assert.deepEqual(await reloads(id), [{ content: JSON.stringify({ provider: 'claude' }), status: 'PENDING' }]);
  });
  await t.test('(7) moved off an API key onto Claude, a session starts on the account Automatic picks', async () => {
    /** A configured provider on the claude runtime — an API key of the owner's own. */
    async function apiKey(ownerId: string) {
      const slug = `key-${randomUUID()}`;
      await db.modelProvider.create({
        data: { slug, label: 'An API key', runtime: 'claude', baseUrl: 'https://api.anthropic.com', apiKeyEnc: 'x', ownerId },
      });
      return slug;
    }
    const onKey = async (m: { ownerId: string; runnerId: string; workspaceId: string }, slug: string, extra = {}) =>
      sessionOn(m, 'claude', RunStatus.AWAITING_INPUT, {
        provider: slug,
        providerBuiltin: false,
        claudeAccount: null,
        model: 'claude-opus-5-5',
        ...extra,
      });

    const m = await machine('switch');
    const id = await onKey(m, await apiKey(m.ownerId));
    await sessions.updateConfig(m.ownerId, id, { provider: 'claude' });
    // Default's weekly window is spent, so Work — not Default, where following the workspace ran it.
    assert.deepEqual(
      { account: (await row(id)).claude_account, pinned: (await row(id)).claude_account_pinned },
      { account: WORK, pinned: false },
    );
    // The switch re-spawns the engine, which reads the account off the row (as in (2)).
    assert.equal((await reloads(id)).length, 1);

    // Pinned to Default by hand before, it stays there: Automatic is not the session's to take back.
    const pinned = await onKey(m, await apiKey(m.ownerId), { claudeAccount: 'default', claudeAccountPinned: true });
    await sessions.updateConfig(m.ownerId, pinned, { provider: 'claude' });
    assert.equal((await row(pinned)).claude_account, 'default');

    // On a runner that cannot carry a conversation to another account, one that has said something
    // resumes where it was; one that has said nothing has nothing to carry.
    const old = await machine('switch-old', []);
    const talked = await onKey(old, await apiKey(old.ownerId));
    await sessions.updateConfig(old.ownerId, talked, { provider: 'claude' });
    assert.equal((await row(talked)).claude_account, null);
    const fresh = await onKey(old, await apiKey(old.ownerId), { numTurns: 0 });
    await sessions.updateConfig(old.ownerId, fresh, { provider: 'claude' });
    assert.equal((await row(fresh)).claude_account, WORK);

    // The menu lists each engine's accounts under it, so the switch can name one: that one, pinned —
    // even Default, whose weekly window is spent, because somebody picked it.
    const named = await onKey(m, await apiKey(m.ownerId));
    await sessions.updateConfig(m.ownerId, named, { provider: 'claude', account: 'default' });
    assert.deepEqual(
      { account: (await row(named)).claude_account, pinned: (await row(named)).claude_account_pinned },
      { account: 'default', pinned: true },
    );
    // …or Automatic, which takes a pin back.
    const again = await onKey(m, await apiKey(m.ownerId), { claudeAccount: 'default', claudeAccountPinned: true });
    await sessions.updateConfig(m.ownerId, again, { provider: 'claude', account: 'automatic' });
    assert.deepEqual(
      { account: (await row(again)).claude_account, pinned: (await row(again)).claude_account_pinned },
      { account: WORK, pinned: false },
    );
    // Refused: an account the runner does not report, one a runner too old to carry the conversation
    // there would lose it for, and an account with no switch onto the engine to go with.
    await refused(sessions.updateConfig(m.ownerId, await onKey(m, await apiKey(m.ownerId)), { provider: 'claude', account: 'c0ffee42' }), 400, 'an unknown account');
    await refused(sessions.updateConfig(old.ownerId, await onKey(old, await apiKey(old.ownerId)), { provider: 'claude', account: WORK }), 409, 'a runner too old to carry it');
    await refused(sessions.updateConfig(m.ownerId, await onKey(m, await apiKey(m.ownerId)), { account: WORK }), 400, 'an account with no switch');

    // An ended session takes the same pick with the message that revives it.
    const ended = await onKey(m, await apiKey(m.ownerId), { status: RunStatus.FAILED, finishedAt: new Date() });
    await sessions.resume(m.ownerId, ended, { content: 'go on', clientTurnId: randomUUID(), provider: 'claude', account: WORK });
    assert.deepEqual(
      { account: (await row(ended)).claude_account, pinned: (await row(ended)).claude_account_pinned },
      { account: WORK, pinned: true },
    );
    const endedAuto = await onKey(m, await apiKey(m.ownerId), { status: RunStatus.FAILED, finishedAt: new Date() });
    await sessions.resume(m.ownerId, endedAuto, { content: 'go on', clientTurnId: randomUUID(), provider: 'claude' });
    assert.equal((await row(endedAuto)).claude_account, WORK);
  });
});
