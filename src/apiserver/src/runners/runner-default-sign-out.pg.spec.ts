/**
 * SIGNING A RUNNER'S DEFAULT ACCOUNT OUT — THE SERVER'S HALF (docs/default-sign-out-design.md), ON REAL POSTGRESQL.
 *
 * `POST /runners/:id/accounts/:engine/default/sign-out` asks the runner to delete Default's login credential. It rides
 * on the account removal's relay: the same request columns with `account_remove_action` 'sign-out', handed over on the
 * heartbeat as `accountRemoveRequest`, answered on /runner/account-remove-result.
 *
 *   (1) Refused, with nothing written and nobody woken: an engine that keeps no accounts; a runner that has not declared
 *       `<engine>-default-sign-out/v1`, in words that say to update the runner on that machine; and an offline runner,
 *       "<machine> is offline. Sign out once it is back." — signed off, or not heard from in time.
 *   (2) A sign-out is delivered on the heartbeat as accountRemoveRequest {engine, account: "default", action:
 *       "sign-out"}, Codex's included (never on the codex-named field an older runner reads as a removal), and the
 *       runner is woken. `runner.default_removed` is not touched.
 *   (3) A refusal naming the sessions running on Default reaches the runner's page as accountRemove with those
 *       sessions, and leaves them where they are (a removal would move them to another account). The retry the person
 *       confirms is delivered with force true; its done keeps Default's Orbit name and Default itself.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-default-sign-out.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import type { AccountRemoveCommand, LoginEngine, RunnerAccountRemoveState, RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = '7c2d9e41';
const SIGN_OUT = ['claude-default-sign-out/v1', 'codex-default-sign-out/v1'];
/** What a runner declares today for removals, without sign-out. */
const OLDER = ['claude-account-remove/v1', 'codex-account-remove/v1'];

/** Default and one added account of an engine, as a runner reports them. */
function reported(engine: LoginEngine): RunnerEngineHealth {
  return {
    engine,
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: `/root/.${engine}`, auth: 'yes' },
      { id: WORK, home: `/root/.orbit/${engine}-accounts/${WORK}`, auth: 'yes' },
    ],
  };
}

test('signing a runner’s Default account out: refusals, the heartbeat relay, a refusal over sessions and its forced retry', {
  skip, concurrency: 1, timeout: 180_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const woken: string[] = [];
  const realtime = new Proxy({}, {
    get: (_target, prop) => (prop === 'notifyRunnerWake' ? (id: string) => woken.push(id) : () => undefined),
  }) as unknown as RealtimeService;
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  const runners = new RunnersService(prisma, realtime);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  // Optional on the controller; the real one, as Nest hands it over, so a removal would really move sessions.
  (api as unknown as { sessions: SessionsService }).sessions = sessions;
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An owner and a runner on `name`, signed into Claude Code and Codex, Default named in Orbit. */
  async function machine(name: string, opts: { capabilities?: string[]; status?: RunnerStatus; lastBeat?: Date } = {}) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const capabilities = opts.capabilities ?? [...OLDER, ...SIGN_OUT];
    await db.user.create({ data: { id: ownerId, email: `${name}-${ownerId}@sign-out.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name,
        tokenHash: `hash-${runnerId}`,
        status: opts.status ?? RunnerStatus.ONLINE,
        capabilities,
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: opts.lastBeat ?? new Date(),
        maxConcurrent: 8,
        engines: [reported('claude'), reported('codex')] as unknown as Prisma.InputJsonValue,
        accountNames: { claude: { default: 'Personal' } },
      },
    });
    return { ownerId, runnerId, capabilities };
  }
  type Machine = Awaited<ReturnType<typeof machine>>;

  const relayColumns = async (runnerId: string) =>
    db.runner.findUniqueOrThrow({
      where: { id: runnerId },
      select: {
        accountRemoveEngine: true,
        codexAccountRemoveAccount: true,
        codexAccountRemoveStatus: true,
        accountRemoveAction: true,
        accountRemoveForce: true,
        defaultRemoved: true,
        accountNames: true,
      },
    });
  /** One heartbeat as the runner sends it, declaring what it declares. */
  const beat = async (m: Machine) =>
    (await api.heartbeat({ id: m.runnerId, version: null } as never, {} as never, m.capabilities.join(','))) as {
      accountRemoveRequest?: AccountRemoveCommand;
      codexAccountRemoveRequest?: unknown;
    };
  const refused = async (call: Promise<unknown>, words: string, what: string) => {
    await assert.rejects(call, (err: { getStatus?: () => number; message?: string }) => {
      assert.equal(err.getStatus?.(), 400, `${what}: ${err.message}`);
      assert.equal(err.message, words, what);
      return true;
    });
  };

  await t.test('(1) refusals: no accounts, no capability, offline — nothing written, nobody woken', async () => {
    const old = await machine('old-box', { capabilities: OLDER });
    await refused(
      runners.signOutDefault(old.ownerId, old.runnerId, 'claude', false),
      'The runner on old-box is too old to sign Claude Code out. Update the runner on old-box, then try again.',
      'a runner without claude-default-sign-out/v1',
    );
    await refused(
      runners.signOutDefault(old.ownerId, old.runnerId, 'codex', true),
      'The runner on old-box is too old to sign Codex out. Update the runner on old-box, then try again.',
      'a runner without codex-default-sign-out/v1',
    );
    // Declaring one engine's sign-out does not sign another's out.
    const claudeOnly = await machine('claude-only', { capabilities: [...OLDER, 'claude-default-sign-out/v1'] });
    await refused(
      runners.signOutDefault(claudeOnly.ownerId, claudeOnly.runnerId, 'codex', false),
      'The runner on claude-only is too old to sign Codex out. Update the runner on claude-only, then try again.',
      'codex on a runner that signs only Claude Code out',
    );

    const signedOff = await machine('laptop', { status: RunnerStatus.OFFLINE });
    await refused(
      runners.signOutDefault(signedOff.ownerId, signedOff.runnerId, 'claude', false),
      'laptop is offline. Sign out once it is back.',
      'a runner that signed off',
    );
    const silent = await machine('desk', { lastBeat: new Date(Date.now() - 60 * 60_000) });
    await refused(
      runners.signOutDefault(silent.ownerId, silent.runnerId, 'codex', false),
      'desk is offline. Sign out once it is back.',
      'a runner not heard from for an hour',
    );
    // The name the owner gave the machine is the one they read.
    await db.runner.update({ where: { id: silent.runnerId }, data: { displayName: 'Studio Mac' } });
    await refused(
      runners.signOutDefault(silent.ownerId, silent.runnerId, 'codex', false),
      'Studio Mac is offline. Sign out once it is back.',
      'an offline runner the owner renamed',
    );

    await refused(
      runners.signOutDefault(old.ownerId, old.runnerId, 'opencode' as LoginEngine, false),
      'Only an engine that keeps accounts has a Default to sign out of',
      'an engine that keeps no accounts',
    );
    for (const m of [old, claudeOnly, signedOff, silent]) {
      const row = await relayColumns(m.runnerId);
      assert.equal(row.codexAccountRemoveStatus, null, 'a refusal writes no request');
      assert.equal(row.accountRemoveAction, null);
      assert.ok(!woken.includes(m.runnerId), 'a refusal wakes nobody');
    }
  });

  await t.test('(2) a sign-out is delivered on the heartbeat as accountRemoveRequest, Codex included', async () => {
    const m = await machine('build-box');
    for (const engine of ['claude', 'codex'] as const) {
      const state = await runners.signOutDefault(m.ownerId, m.runnerId, engine, false);
      assert.deepEqual(
        { engine: state.engine, account: state.account, status: state.status },
        { engine, account: 'default', status: 'pending' },
      );
      assert.equal(woken.at(-1), m.runnerId, 'the runner is woken to take it now');
      const row = await relayColumns(m.runnerId);
      assert.deepEqual(
        { engine: row.accountRemoveEngine, account: row.codexAccountRemoveAccount, action: row.accountRemoveAction, force: row.accountRemoveForce },
        { engine, account: 'default', action: 'sign-out', force: false },
      );
      const answer = await beat(m);
      assert.equal(answer.codexAccountRemoveRequest, undefined, `${engine}: never on the codex-named field`);
      const { attempt, ...request } = answer.accountRemoveRequest ?? ({} as AccountRemoveCommand);
      assert.deepEqual(request, { engine, account: 'default', action: 'sign-out' }, `${engine}: the request on the heartbeat`);
      assert.ok(attempt && !Number.isNaN(Date.parse(attempt)), 'it names its attempt');
      // Redelivered until the runner answers.
      assert.deepEqual((await beat(m)).accountRemoveRequest?.action, 'sign-out');
      // Signing out is not removing: Orbit keeps listing Default.
      assert.deepEqual(row.defaultRemoved, []);
    }
    // A removal asked after it replaces it, one request per runner as before, and is a removal again.
    await runners.removeAccount(m.ownerId, m.runnerId, 'claude', WORK);
    const removal = (await beat(m)).accountRemoveRequest;
    assert.equal(removal?.account, WORK);
    assert.equal(removal?.action, undefined, 'a removal carries no action, as an older runner expects');
    assert.equal(removal?.force, undefined);
    assert.equal((await relayColumns(m.runnerId)).accountRemoveAction, null);
  });

  await t.test('(3) a refusal over sessions on Default lists them; the confirmed retry is delivered with force', async () => {
    const m = await machine('gpu-box');
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId: m.ownerId, runnerId: m.runnerId, name: 'gpu-box-repo', enabled: true, claudeAccount: 'default' } });
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId,
        ownerId: m.ownerId,
        creatorId: m.ownerId,
        workspaceId,
        assignedRunnerId: m.runnerId,
        title: 'Fix the flaky test',
        prompt: 'fix the flaky test',
        provider: 'claude',
        providerBuiltin: true,
        turnState: 'IN_FLIGHT',
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
        claudeAccount: 'default',
      },
    });
    // Another owner's session the runner might name is not listed.
    const strangerId = randomUUID();

    await runners.signOutDefault(m.ownerId, m.runnerId, 'claude', false);
    const first = (await beat(m)).accountRemoveRequest!;
    assert.equal(first.force, undefined, 'unforced the first time');
    const message = '1 session is running on Default.';
    assert.deepEqual(
      await api.accountRemoveResult({ id: m.runnerId }, {
        engine: 'claude', account: 'default', status: 'failed', message, attempt: first.attempt, sessionIds: [sessionId, strangerId],
      }),
      { ok: true, applied: true },
    );
    const page = (await runners.getRunner(m.ownerId, m.runnerId)) as unknown as { accountRemove: RunnerAccountRemoveState };
    assert.deepEqual(page.accountRemove, {
      engine: 'claude',
      account: 'default',
      status: 'failed',
      message,
      sessions: [{ id: sessionId, title: 'Fix the flaky test', status: RunStatus.RUNNING }],
    }, 'the runner’s page lists the sessions running on Default');
    const stayed = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { claudeAccount: true } });
    assert.equal(stayed.claudeAccount, 'default', 'a sign-out moves no session off Default');
    assert.equal(await beat(m).then((a) => a.accountRemoveRequest), undefined, 'a refused sign-out is not redelivered');

    // The person confirms: the retry reaches the runner with force.
    const retry = await runners.signOutDefault(m.ownerId, m.runnerId, 'claude', true);
    assert.equal(retry.status, 'pending');
    assert.deepEqual(retry.sessions ?? [], [], 'the new request lists no sessions of the last');
    const forced = (await beat(m)).accountRemoveRequest!;
    const { attempt: forcedAttempt, ...forcedRequest } = forced;
    assert.deepEqual(forcedRequest, { engine: 'claude', account: 'default', action: 'sign-out', force: true });
    assert.notEqual(forcedAttempt, first.attempt, 'a new attempt');
    // The first attempt's answer, arriving late, no longer applies.
    assert.deepEqual(
      await api.accountRemoveResult({ id: m.runnerId }, { engine: 'claude', account: 'default', status: 'done', attempt: first.attempt }),
      { ok: true, applied: false },
    );
    assert.deepEqual(
      await api.accountRemoveResult({ id: m.runnerId }, { engine: 'claude', account: 'default', status: 'done', attempt: forcedAttempt }),
      { ok: true, applied: true },
    );
    const done = await relayColumns(m.runnerId);
    assert.equal(done.codexAccountRemoveStatus, 'done');
    assert.deepEqual(done.defaultRemoved, [], 'Default stays in Orbit');
    assert.deepEqual(done.accountNames, { claude: { default: 'Personal' } }, 'and keeps its Orbit name');
  });
});
