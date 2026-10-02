/**
 * Which of the ChatGPT accounts a Codex pool of its owner's own holds a session runs on, chosen at every
 * door that builds its engine (QueueService.resolveLoginPool, pool-login-select.ts), and when work held
 * back on such a pool goes again (QueueService.loginPoolRetryAt and accountPoolResumesAt) — on real
 * PostgreSQL:
 *
 *  (1) Two accounts, the weekly window of the one the session runs on (A) used up: the claim moves it to B
 *      and owes the transcript "Switched to <B> — the weekly window on <A> is spent", in place of the line
 *      the gateway owed for A; a resident engine is handed a reload that changes nothing, ahead of the
 *      turn, and its `resumed` carries the line. The session's first claim is where it starts, not a move.
 *  (2) A not used up — 99% is not 100% — the session stays on A, though a session starting now goes to B;
 *      nothing is owed and nothing queued, and a failure there is not the account's.
 *  (3) Both used up: the session stays on A; the retry its failed turn arms, and the pool's brakes, wait
 *      for the earliest of the two resets — B's 5-hour window, not A's week — and once B is back, the claim
 *      that runs the retry moves the session there.
 *  (4) A spent while B can run: the failed turn is re-sent at once, and its claim moves the session to B —
 *      the move's line in place of the gateway's "waits for its reset", queued ahead of the turn.
 *  (5) A signed out by OpenAI: the move says so, and the pool still takes sessions while an account is
 *      ACTIVE. Every account signed out: the doors refuse it, the session stays, and no wait brings one back.
 *  (6) Among the rest: none nearly spent before one that is, then the quota that resets soonest; a session
 *      stays on its account while that can run.
 *  (7) A restarted runner's reclaim and a provider-switch reload choose the same way; the engine they
 *      re-spawn carries the line on its own start, so no reload is queued for it.
 *
 * Production code throughout: QueueService's claim, RunnerApiController's turn-complete, events, reclaim
 * and inbox, SessionsService, ProvidersService and CodexLoginService. It only adds rows, and refuses to run
 * anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { RunEventType, type ClaimedSession, type PlanUsageSnapshot, type TurnCompleteRequest } from '@orbit/shared';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { loginSpentNotice } from './codex-login-gateway';
import { CodexLoginService } from './codex-login.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { PoolNotices } from './pool-notice';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'pool-login-claim-spec';
// Where runners reach this deployment; the gateway lives under it.
process.env.PUBLIC_ORIGIN = 'https://orbit.pool-login-claim.invalid';
const GATEWAY = 'https://orbit.pool-login-claim.invalid/api/gw/codex';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** `ms` from now. */
const fromNow = (ms: number) => new Date(Date.now() + ms);

/** A Codex window reading as the gateway stores one off an answer's x-codex-* headers (codexUsageSnapshot). */
function reading(fiveHour: { used: number; resetsAt: Date }, weekly: { used: number; resetsAt: Date }): PlanUsageSnapshot {
  return {
    provider: 'codex',
    limitId: 'codex',
    primary: { utilization: fiveHour.used, resetsAt: fiveHour.resetsAt.toISOString(), windowDurationMins: 300 },
    secondary: { utilization: weekly.used, resetsAt: weekly.resetsAt.toISOString(), windowDurationMins: 10080 },
    fetchedAt: new Date().toISOString(),
  } as PlanUsageSnapshot;
}

interface Person { name: string; id: string; runnerId: string; workspaceId: string }

/** One person per case, with a runner and an agent of their own: a claim only ever finds that case's sessions. */
async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id, email: `${name}-${id}@pool-login-claim.invalid`, name, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}` },
  });
  return { name, id, runnerId, workspaceId };
}

interface Account { accountId: string; email: string }

const suite = URL ? test : test.skip;

suite("a login pool's sessions: which ChatGPT account each runs on, and when they go again — on real PostgreSQL", { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const logins = new CodexLoginService(prisma, realtime);
  const notices = new PoolNotices(prisma, realtime);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never,
    // Delivering a message expands its #references; this spec's messages have none.
    { expand: async (_ownerId: string, content?: string) => content } as never,
  );
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  /**
   * A Codex pool of `who`'s own holding one ChatGPT account per name, stored as the sign-in stores one —
   * signed in in that order, a minute apart, so the first is the oldest.
   */
  async function loginPool(who: Person, label: string, names: string[]) {
    const made = await providers.createPool(who.id, { label, engine: 'codex' });
    const accounts: Account[] = [];
    for (const [index, name] of names.entries()) {
      const accountId = `acct-${randomUUID()}`;
      const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@chatgpt.invalid`;
      await db.poolCodexLogin.create({
        data: {
          poolId: made.id, userId: who.id, accountId, email, plan: 'plus',
          accessTokenEnc: encryptSecret(`access-${randomUUID()}`), refreshTokenEnc: encryptSecret(`rt_${randomUUID()}`),
          expiresAt: new Date('2100-01-01T00:00:00.000Z'),
          createdAt: new Date(Date.now() - (names.length - index) * 60_000),
        },
      });
      accounts.push({ accountId, email });
    }
    return { id: made.id, slug: made.slug, label, accounts };
  }
  /** What the gateway writes onto an account off the backend's answers: the last window reading, the spent mark. */
  const setAccount = (poolId: string, account: Account, data: { usage?: PlanUsageSnapshot; spentUntil?: Date | null }) =>
    db.poolCodexLogin.update({
      where: { poolId_accountId: { poolId, accountId: account.accountId } },
      data: {
        ...(data.usage ? { usage: data.usage as never, usageReadAt: new Date() } : {}),
        ...(data.spentUntil !== undefined ? { spentUntil: data.spentUntil } : {}),
      },
    });

  const sessionOn = async (who: Person, pool: { slug: string; label: string }) =>
    (await sessions.create(who.id, { prompt: 'hello', title: pool.label, workspaceId: who.workspaceId, provider: pool.slug })).id;
  /** The runner asking for work — which has to be `sessionId` — leaving it RUNNING or parked, as a turn would. */
  async function claim(who: Person, sessionId: string, park = true): Promise<ClaimedSession> {
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING, cancelRequestedAt: null } });
    const claimed = await queue.claimSessionForRunner({ id: who.runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    assert.equal(claimed.agent.env?.OPENAI_BASE_URL, GATEWAY, 'a login pool session goes to the gateway, whatever its account');
    if (park) await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    return claimed;
  }
  const sessionRow = (sessionId: string) =>
    db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { ownerId: true, provider: true, poolCodexAccountId: true, poolSwitchNotice: true, retryAt: true, status: true },
    });
  /** The account the session is on, and the transcript line it is owed. */
  const standing = async (sessionId: string) => {
    const row = await sessionRow(sessionId);
    return { account: row.poolCodexAccountId, notice: row.poolSwitchNotice };
  };
  const carriers = (sessionId: string) =>
    db.conversationTurn.findMany({ where: { sessionId, kind: 'reload' }, select: { content: true, status: true } });
  const dequeue = (who: Person, sessionId: string) =>
    (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
        { turnId: string; kind: string; env?: Record<string, string> } | null
      >;
    }).dequeueTurn(sessionId, who.runnerId, null);
  /** The session's message, handed to its engine and failed, as codex reports a turn the backend refused. */
  async function failTurn(who: Person, sessionId: string) {
    const turn = await dequeue(who, sessionId);
    assert.equal(turn?.kind, 'message');
    await runnerApi.turnComplete({ id: who.runnerId }, sessionId, {
      turnId: turn!.turnId,
      status: 'FAILED' as TurnCompleteRequest['status'],
      result: "You've hit your usage limit.",
      numTurns: 0,
      costUsd: 0,
    });
    return sessionRow(sessionId);
  }
  const unavailable = async (who: Person, poolId: string) =>
    ((await providers.getPool(who.id, poolId)) as unknown as { unavailable: string | null }).unavailable;

  await t.test("(1) A's weekly window used up: the claim moves the session to B and says why, in place of the gateway's line, ahead of the turn", async () => {
    const owner = await person(db, 'Ann');
    const pool = await loginPool(owner, 'Two accounts', ['A', 'B']);
    const [a, b] = pool.accounts;
    const session = await sessionOn(owner, pool);
    // Its first claim is where it starts — the older account, neither having been read — and no move.
    await claim(owner, session);
    assert.deepEqual(await standing(session), { account: a.accountId, notice: null });
    assert.deepEqual(await carriers(session), []);

    // A's last answer said its weekly window is full, and the gateway owed the session the line saying so.
    const weekEnds = fromNow(3 * DAY);
    const full = reading({ used: 40, resetsAt: fromNow(2 * HOUR) }, { used: 100, resetsAt: weekEnds });
    await setAccount(pool.id, a, { usage: full });
    assert.equal(await notices.owe(session, loginSpentNotice(a, full, weekEnds)), true);

    await claim(owner, session, false);
    const line = `Switched to ${b.email} — the weekly window on ${a.email} is spent`;
    assert.deepEqual(await standing(session), { account: b.accountId, notice: line });
    // A resident engine says it before the turn: the claim queued a reload that changes nothing, which the
    // inbox hands out ahead of the message, with no environment — nothing is re-spawned for it.
    assert.deepEqual(await carriers(session), [{ content: '{}', status: 'PENDING' }]);
    const carrier = await dequeue(owner, session);
    assert.equal(carrier?.kind, 'reload');
    assert.equal(carrier?.env, undefined);
    await runnerApi.events({ id: owner.runnerId }, session, {
      events: [{ seq: 1, type: RunEventType.SYSTEM, ts: new Date().toISOString(), payload: { subtype: 'resumed', reason: 'config_changed', runtime: 'app-server' } }],
    });
    const [said] = await db.runEvent.findMany({ where: { sessionId: session }, select: { payload: true } });
    assert.equal((said.payload as { notice?: string }).notice, line);
    assert.equal((await sessionRow(session)).poolSwitchNotice, null, 'the line is owed once');
    // On B, which can run: a failure there is not the account's, and the pool arms nothing for it.
    assert.equal(await queue.loginPoolRetryAt(db, await sessionRow(session), new Date()), null);
  });

  await t.test('(2) A not used up: the session stays on A, though a session starting now goes to B', async () => {
    const owner = await person(db, 'Bea');
    const pool = await loginPool(owner, 'Sticky', ['A', 'B']);
    const [a, b] = pool.accounts;
    const session = await sessionOn(owner, pool);
    await claim(owner, session);
    assert.equal((await standing(session)).account, a.accountId);

    // A at 99% of its week and 95% of its 5 hours — nearly spent, not spent; B barely touched, and its week
    // resets first. Choosing afresh would take B.
    await setAccount(pool.id, a, { usage: reading({ used: 95, resetsAt: fromNow(2 * HOUR) }, { used: 99, resetsAt: fromNow(6 * DAY) }) });
    await setAccount(pool.id, b, { usage: reading({ used: 3, resetsAt: fromNow(4 * HOUR) }, { used: 10, resetsAt: fromNow(DAY) }) });
    await claim(owner, session);
    assert.deepEqual(await standing(session), { account: a.accountId, notice: null });
    assert.deepEqual(await carriers(session), []);
    assert.equal(await queue.loginPoolRetryAt(db, await sessionRow(session), new Date()), null, "a failure on an account that can run is not the account's");
    const at = new Date();
    assert.deepEqual(await queue.accountPoolResumesAt(owner.id, pool.slug, at), at);

    const fresh = await sessionOn(owner, pool);
    await claim(owner, fresh);
    assert.deepEqual(await standing(fresh), { account: b.accountId, notice: null });
  });

  await t.test("(3) both used up: the session stays on A, its retry waits for the earliest reset — B's — and the claim then moves it to B", async () => {
    const owner = await person(db, 'Cy');
    const pool = await loginPool(owner, 'Both spent', ['A', 'B']);
    const [a, b] = pool.accounts;
    const session = await sessionOn(owner, pool);
    await claim(owner, session);
    assert.equal((await standing(session)).account, a.accountId);

    // A's week is gone — the backend said so too — for three days; B's 5 hours, for twenty.
    const aBack = fromNow(3 * DAY);
    const bBack = fromNow(20 * HOUR);
    await setAccount(pool.id, a, { spentUntil: aBack, usage: reading({ used: 30, resetsAt: fromNow(HOUR) }, { used: 100, resetsAt: aBack }) });
    await setAccount(pool.id, b, { usage: reading({ used: 100, resetsAt: bBack }, { used: 70, resetsAt: fromNow(5 * DAY) }) });

    // No account can run: the session stays where it is, and nothing is owed for a move that did not happen.
    await claim(owner, session, false);
    assert.deepEqual(await standing(session), { account: a.accountId, notice: null });
    const now = new Date();
    assert.deepEqual(await queue.loginPoolRetryAt(db, await sessionRow(session), now), bBack);
    assert.deepEqual(await queue.accountPoolResumesAt(owner.id, pool.slug, now), bBack);
    // The turn the limit ends arms its retry there.
    const failed = await failTurn(owner, session);
    assert.equal(failed.status, RunStatus.FAILED);
    assert.ok(failed.retryAt, 'no retry was armed for a turn every account had spent');
    assert.ok(
      failed.retryAt.getTime() >= bBack.getTime() && failed.retryAt.getTime() < bBack.getTime() + 60_000,
      `the retry is not the earliest reset: ${failed.retryAt.toISOString()} against ${bBack.toISOString()}`,
    );
    assert.equal(failed.poolCodexAccountId, a.accountId);

    // B's 5-hour window turns over: the claim that runs the retry moves the session there, saying why it left A.
    await setAccount(pool.id, b, { usage: reading({ used: 100, resetsAt: new Date(Date.now() - 1_000) }, { used: 70, resetsAt: fromNow(5 * DAY) }) });
    await claim(owner, session);
    assert.deepEqual(await standing(session), {
      account: b.accountId,
      notice: `Switched to ${b.email} — the weekly window on ${a.email} is spent`,
    });
  });

  await t.test('(4) A spent while B can run: the failed turn is re-sent at once, and its claim moves the session to B', async () => {
    const owner = await person(db, 'Dee');
    const pool = await loginPool(owner, 'One spent', ['A', 'B']);
    const [a, b] = pool.accounts;
    const session = await sessionOn(owner, pool);
    await claim(owner, session, false);
    assert.equal((await standing(session)).account, a.accountId);

    // The backend says A's usage limit is reached, with no window to name — recorded as the gateway records
    // it, and the session owed the gateway's line.
    const reset = fromNow(4 * HOUR);
    await logins.markSpent(pool.id, a.accountId, reset, null, new Date());
    const owed = loginSpentNotice(a, null, reset);
    assert.equal(await notices.owe(session, owed), true);

    const before = Date.now();
    const failed = await failTurn(owner, session);
    assert.equal(failed.status, RunStatus.FAILED);
    assert.ok(failed.retryAt, 'no retry was armed');
    assert.ok(
      failed.retryAt.getTime() >= before && failed.retryAt.getTime() < Date.now() + 60_000,
      `B can run, yet the retry waits: ${failed.retryAt.toISOString()}`,
    );
    assert.deepEqual({ account: failed.poolCodexAccountId, notice: failed.poolSwitchNotice }, { account: a.accountId, notice: owed });
    const at = new Date();
    assert.deepEqual(await queue.loginPoolRetryAt(db, failed, at), at);
    assert.deepEqual(await queue.accountPoolResumesAt(owner.id, pool.slug, at), at);

    await claim(owner, session);
    assert.deepEqual(await standing(session), {
      account: b.accountId,
      notice: `Switched to ${b.email} — the usage limit on ${a.email} is reached`,
    });
    assert.deepEqual(await carriers(session), [{ content: '{}', status: 'PENDING' }]);
  });

  await t.test('(5) A signed out by OpenAI: the move says so, and the pool takes sessions while an account is ACTIVE; with none, nothing comes back by waiting', async () => {
    const owner = await person(db, 'Eve');
    const pool = await loginPool(owner, 'Signed out', ['A', 'B']);
    const [a, b] = pool.accounts;
    const session = await sessionOn(owner, pool);
    await claim(owner, session);
    assert.equal((await standing(session)).account, a.accountId);

    assert.equal(await logins.markSignedOut(pool.id, a.accountId, 'Your refresh token was revoked.'), true);
    // B is still ACTIVE: no door refuses the pool, and a new session is taken.
    assert.equal(await queue.accountPoolRefusal(owner.id, pool.slug), null);
    assert.equal(await unavailable(owner, pool.id), null);
    await claim(owner, session);
    assert.deepEqual(await standing(session), {
      account: b.accountId,
      notice: `Switched to ${b.email} — ${a.email} was signed out by OpenAI`,
    });
    assert.deepEqual(await carriers(session), [{ content: '{}', status: 'PENDING' }]);

    // B too: the doors refuse the pool, naming its oldest account; the session stays where it is, and no
    // wait brings either back — only their owner signing in again.
    assert.equal(await logins.markSignedOut(pool.id, b.accountId, 'This account is deactivated.'), true);
    const refusal = `the ChatGPT account ${a.email} on the pool "Signed out" was rejected by OpenAI — sign in again on its page, or pick another provider`;
    assert.equal(await queue.accountPoolRefusal(owner.id, pool.slug), refusal);
    assert.equal(await unavailable(owner, pool.id), refusal);
    await claim(owner, session);
    assert.equal((await standing(session)).account, b.accountId);
    const now = new Date();
    assert.equal(await queue.loginPoolRetryAt(db, await sessionRow(session), now), null);
    assert.equal(await queue.accountPoolResumesAt(owner.id, pool.slug, now), null);
  });

  await t.test('(6) among the rest: none nearly spent before one that is, then the quota that resets soonest; a session stays while its account can run', async () => {
    const owner = await person(db, 'Fay');
    const pool = await loginPool(owner, 'Three accounts', ['A', 'B', 'C']);
    const [a, b, c] = pool.accounts;
    // A used up; B nearly (92% of its 5 hours), though its week resets first; C with room, its week in five days.
    await setAccount(pool.id, a, { usage: reading({ used: 100, resetsAt: fromNow(HOUR) }, { used: 50, resetsAt: fromNow(2 * DAY) }) });
    await setAccount(pool.id, b, { usage: reading({ used: 92, resetsAt: fromNow(HOUR) }, { used: 40, resetsAt: fromNow(DAY) }) });
    await setAccount(pool.id, c, { usage: reading({ used: 10, resetsAt: fromNow(3 * HOUR) }, { used: 20, resetsAt: fromNow(5 * DAY) }) });
    const first = await sessionOn(owner, pool);
    await claim(owner, first);
    assert.deepEqual(await standing(first), { account: c.accountId, notice: null });

    // B with room again: what is left of its week is lost first, so it is spent first.
    await setAccount(pool.id, b, { usage: reading({ used: 10, resetsAt: fromNow(HOUR) }, { used: 40, resetsAt: fromNow(DAY) }) });
    const second = await sessionOn(owner, pool);
    await claim(owner, second);
    assert.deepEqual(await standing(second), { account: b.accountId, notice: null });
    await claim(owner, first);
    assert.deepEqual(await standing(first), { account: c.accountId, notice: null });
  });

  await t.test("(7) a restarted runner's reclaim and a provider-switch reload choose the same way, and queue no reload for the line", async () => {
    const owner = await person(db, 'Gus');
    const pool = await loginPool(owner, 'Rebuilt', ['A', 'B']);
    const [a, b] = pool.accounts;
    const session = await sessionOn(owner, pool);
    await claim(owner, session);
    assert.equal((await standing(session)).account, a.accountId);

    await setAccount(pool.id, a, { usage: reading({ used: 100, resetsAt: fromNow(3 * HOUR) }, { used: 80, resetsAt: fromNow(4 * DAY) }) });
    const reclaimed = (await runnerApi.reclaim({ id: owner.runnerId, ownerId: owner.id })).sessions.find((s) => s.sessionId === session);
    assert.ok(reclaimed, 'the session on the pool was left out of the reclaim');
    assert.equal(reclaimed.agent.env?.OPENAI_BASE_URL, GATEWAY);
    assert.deepEqual(await standing(session), {
      account: b.accountId,
      notice: `Switched to ${b.email} — the 5-hour window on ${a.email} is spent`,
    });
    // The reclaim re-spawns its engine, whose own start carries the line.
    assert.deepEqual(await carriers(session), []);

    // A live built-in Codex session switched onto the pool re-spawns on the account the choosing gives it —
    // B, with A spent — and that is where it starts, not a move.
    const live = (await db.session.create({
      data: {
        title: 'switched onto the pool', prompt: 'hello', status: RunStatus.AWAITING_INPUT,
        ownerId: owner.id, creatorId: owner.id, workspaceId: owner.workspaceId, assignedRunnerId: owner.runnerId,
        provider: 'codex', providerBuiltin: true, model: 'gpt-5.5', permissionMode: 'default', usesRuntimeDefaultModel: true,
        numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date(),
      },
      select: { id: true },
    })).id;
    await sessions.updateConfig(owner.id, live, { provider: pool.slug });
    let reload: { kind: string; env?: Record<string, string> } | null = null;
    for (let polls = 0; polls < 4 && reload?.kind !== 'reload'; polls += 1) reload = await dequeue(owner, live);
    assert.equal(reload?.kind, 'reload', 'the inbox never handed out the reload');
    assert.equal(reload.env?.OPENAI_BASE_URL, GATEWAY);
    assert.deepEqual(await standing(live), { account: b.accountId, notice: null });
  });
});
