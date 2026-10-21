import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RunnerStatus, type AccountRemoveCommand, type LoginCommand, type RunnerAccountRemoveState, type RunnerLoginState } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { engineKeepsAccounts, isLoginEngine, sanitizeRunnerEngines } from '../common/runner-engines';
import {
  CODEX_ACCOUNT_LOGIN_V1,
  CURSOR_ACCOUNT_LOGIN_V1,
  CURSOR_ACCOUNT_REMOVE_V1,
  CURSOR_LOGIN_TOO_OLD,
  RunnerApiController,
} from '../runner-api/runner-api.controller';
import { StartLoginDto } from './dto';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Signing Cursor CLI accounts in, and removing them, through the relay every engine that keeps accounts
 * uses (docs/cursor-runtime-contract.md §16.1; project P4a).
 *
 * A Cursor CLI sign-in is one `agent login` in the account's own directory, which prints a link and
 * waits on it for about 27 minutes (§9). Only a runner that declares cursor-account-login/v1 is handed
 * one — Default's included, since an older runner signs Claude Code in for an engine it does not know —
 * and only one that declares cursor-account-remove/v1 a removal; any other is refused, at the start and
 * at the heartbeat, in the words that say to update it. What the runner says about the link — when it
 * stops working, and that it did — reaches the page as the runner said it.
 */

const OWNER = 'owner-1';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const SLOT = '1a2b3c4d';
const ADDED_SLOT = '5e6f7a8b';
const USER = { userId: OWNER } as AuthUser;
/** A runner that runs Cursor CLI sessions and keeps Codex accounts, but signs no Cursor CLI account in. */
const CURSOR_OLD = 'session-worktree-ops-v1,provider:cursor,' + CODEX_ACCOUNT_LOGIN_V1;
const CURSOR_CAPABLE = `${CURSOR_OLD},${CURSOR_ACCOUNT_LOGIN_V1},${CURSOR_ACCOUNT_REMOVE_V1}`;
const NAMED_TOO_OLD = 'This runner is too old to sign in another Cursor account — update it, then try again.';
const REMOVE_TOO_OLD = 'This runner is too old to remove a Cursor account — update it, then try again.';
const LINK = 'https://cursor.com/loginDeepControl?challenge=abc&uuid=0b5e77d1-0000-4000-8000-000000000000&mode=login';
const EXPIRED = 'The sign-in link expired before anyone signed in with it.';

type Row = Record<string, unknown>;

/** A where clause as the relay's statements write one: equality, a Date, or `{ not: … }`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    if (want && typeof want === 'object' && 'not' in want) return have != null && have !== (want as Row).not;
    return have === want;
  });
}

function harness() {
  const row: Row = { id: RUNNER_ID, ownerId: OWNER, status: 'ONLINE', maxConcurrent: 4, minFreeDiskMb: null };
  const writes: Row[] = [];
  const runnerModel = {
    findFirst: async ({ where }: { where: Row }) => (matches(row, where) ? { ...row } : null),
    findUnique: async ({ where }: { where: Row }) => (matches(row, where) ? { ...row } : null),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      assert.ok(matches(row, where), 'update of a row that is not there');
      writes.push(data);
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      if (!matches(row, where)) return { count: 0 };
      writes.push(data);
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  const prisma = {
    runner: runnerModel,
    workspace: { findMany: async () => [] },
    codexRateLimitResetOperation: { findMany: async () => [] },
    // The Orbit name a removal takes with it, and a rename: neither is about the relay.
    $executeRaw: async () => 1,
  } as never;
  const realtime = { drainCancellations: async () => [], drainArtifactRequests: async () => [] } as never;
  const runnerApi = new RunnerApiController(
    prisma,
    {} as never,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  const runners = new RunnersController(new RunnersService(prisma));
  // The pipe main.ts installs: a body field the DTO does not declare is stripped, not refused.
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
  const internals = runnerApi as unknown as {
    loginResult: (runner: { id: string }, body: Row) => Promise<{ ok: boolean; applied: boolean }>;
    accountRemoveResult: (runner: { id: string }, body: Row) => Promise<{ ok: boolean; applied: boolean }>;
  };
  return {
    row,
    writes,
    /** POST /runners/:id/login, from the raw JSON body on. */
    async post(body: Row): Promise<RunnerLoginState> {
      const dto = (await pipe.transform(body, { type: 'body', metatype: StartLoginDto })) as StartLoginDto;
      return runners.startLogin(USER, RUNNER_ID, dto);
    },
    state: () => runners.loginState(USER, RUNNER_ID),
    /** DELETE /runners/:id/accounts/:engine/:account. */
    remove: (account: string): Promise<RunnerAccountRemoveState> => runners.removeAccount(USER, RUNNER_ID, 'cursor', account),
    /** What the runner is told to do on its next heartbeat. `null` sends no capability header at all. */
    async beat(capabilities: string | null = CURSOR_CAPABLE): Promise<{
      login?: LoginCommand;
      remove?: AccountRemoveCommand;
      codexRemove?: unknown;
    }> {
      const response = await runnerApi.heartbeat(
        { id: RUNNER_ID, version: null },
        { status: RunnerStatus.ONLINE, idleCapacity: 1 },
        capabilities ?? undefined,
      );
      return {
        login: response.loginRequest,
        remove: response.accountRemoveRequest,
        codexRemove: response.codexAccountRemoveRequest,
      };
    },
    /** POST /runner/login-result, as the runner sends it. */
    report: (body: Row) => internals.loginResult({ id: RUNNER_ID }, body),
    /** POST /runner/account-remove-result, as the runner sends it. */
    removed: (body: Row) => internals.accountRemoveResult({ id: RUNNER_ID }, body),
  };
}

const attemptOf = (row: Row) => (row.loginAt as Date).toISOString();

/** The refusal a start answers with, in the words the page shows. */
function refusedWith(message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BadRequestException, String(error));
    assert.equal((error.getResponse() as { message?: string }).message, message);
    return true;
  };
}

test('P4a a Cursor CLI account is signed in by name, and Cursor CLI’s own, only on a runner that declares cursor-account-login/v1', async () => {
  const h = harness();
  assert.equal((await h.beat()).login, undefined, 'nothing is in flight yet');

  // A new account, by the name it is added under.
  await h.post({ engine: 'cursor', accountName: ' Work ' });
  assert.deepEqual((await h.beat()).login, { action: 'start', engine: 'cursor', attempt: attemptOf(h.row), accountName: 'Work' });
  // One the runner has, signed in again in its own directory.
  await h.post({ engine: 'cursor', account: SLOT });
  assert.deepEqual((await h.beat()).login, { action: 'start', engine: 'cursor', attempt: attemptOf(h.row), account: SLOT });
  // Default, Cursor CLI's own: a start naming no account, the shape every engine's always was.
  await h.post({ engine: 'cursor' });
  assert.deepEqual((await h.beat()).login, { action: 'start', engine: 'cursor', attempt: attemptOf(h.row) });
});

test('P4a a runner too old for Cursor CLI’s sign-in is refused it at the start and at the heartbeat, in the upgrade words', async () => {
  // It runs Cursor CLI sessions, and signs Codex accounts in — but no Cursor CLI account, Default's
  // included: it would run `claude auth login` for an engine it does not know.
  const old = harness();
  await old.beat(CURSOR_OLD);
  const before = old.writes.length;
  await assert.rejects(old.post({ engine: 'cursor', accountName: 'Work' }), refusedWith(NAMED_TOO_OLD));
  await assert.rejects(old.post({ engine: 'cursor', account: SLOT }), refusedWith(NAMED_TOO_OLD));
  await assert.rejects(old.post({ engine: 'cursor' }), refusedWith(CURSOR_LOGIN_TOO_OLD));
  await assert.rejects(old.post({ engine: 'cursor', account: 'default' }), refusedWith(CURSOR_LOGIN_TOO_OLD));
  assert.equal(old.writes.length, before, 'a refused start writes nothing');
  assert.equal((await old.state()).status, null);
  // Another engine's sign-in on that runner is handed over as it always was.
  await old.post({ engine: 'codex', account: SLOT });
  assert.deepEqual((await old.beat(CURSOR_OLD)).login, { action: 'start', engine: 'codex', attempt: attemptOf(old.row), account: SLOT });

  // One that never said what it declares is the same answer.
  const silent = harness();
  await assert.rejects(silent.post({ engine: 'cursor' }), refusedWith(CURSOR_LOGIN_TOO_OLD));

  // Declared at the last heartbeat, and not by the process polling now: refused there, never handed over.
  for (const [body, message] of [
    [{ engine: 'cursor', accountName: 'Work' }, NAMED_TOO_OLD],
    [{ engine: 'cursor' }, CURSOR_LOGIN_TOO_OLD],
  ] as const) {
    for (const polling of [CURSOR_OLD, null]) {
      const stale = harness();
      await stale.beat(CURSOR_CAPABLE);
      await stale.post(body);
      assert.equal((await stale.beat(polling)).login, undefined, `${String(polling)} was handed a Cursor CLI sign-in`);
      const state = await stale.state();
      assert.deepEqual({ status: state.status, message: state.message }, { status: 'failed', message });
    }
  }
});

test('P4a a Cursor CLI sign-in link’s expiry, and that it expired, reach the page as the runner reported them', async () => {
  const h = harness();
  await h.beat();
  await h.post({ engine: 'cursor', accountName: 'Work' });
  await h.beat();
  const attempt = attemptOf(h.row);
  const expiresAt = new Date((h.row.loginAt as Date).getTime() + 27 * 60_000);

  // The link, and when it stops working — normalized to an instant and nothing else.
  assert.deepEqual(
    await h.report({ status: 'awaiting_approval', url: LINK, attempt, account: ADDED_SLOT, expiresAt: expiresAt.toISOString().replace('.000Z', 'Z') }),
    { ok: true, applied: true },
  );
  assert.deepEqual(await h.state(), {
    status: 'awaiting_approval', engine: 'cursor', url: LINK, userCode: null, message: null, account: ADDED_SLOT,
    expiresAt: expiresAt.toISOString(),
  });

  // Nobody signed in in time: a failure the page answers with a new link, said in words too.
  assert.deepEqual(await h.report({ status: 'failed', reason: 'expired', message: EXPIRED, attempt, account: ADDED_SLOT }), { ok: true, applied: true });
  assert.deepEqual(await h.state(), {
    status: 'failed', engine: 'cursor', url: null, userCode: null, message: EXPIRED, account: ADDED_SLOT, reason: 'expired',
  });

  // A new start forgets both.
  await h.post({ engine: 'cursor', account: ADDED_SLOT });
  assert.deepEqual(await h.state(), { status: 'pending', engine: 'cursor', url: null, userCode: null, message: null, account: ADDED_SLOT });
  await h.beat();
  const next = attemptOf(h.row);
  // What the runner sends that is not a time, or a reason this control plane does not know, is not
  // passed on — and the report it came in still lands.
  assert.deepEqual(await h.report({ status: 'awaiting_approval', url: LINK, attempt: next, expiresAt: 'in 27 minutes' }), { ok: true, applied: true });
  assert.equal('expiresAt' in (await h.state()), false);
  assert.deepEqual(await h.report({ status: 'failed', reason: 'cancelled-by-moon', message: 'gone', attempt: next }), { ok: true, applied: true });
  const failed = await h.state();
  assert.deepEqual({ status: failed.status, message: failed.message, reason: 'reason' in failed }, { status: 'failed', message: 'gone', reason: false });

  // A sign-in that went through says neither.
  await h.post({ engine: 'cursor' });
  await h.beat();
  await h.report({ status: 'awaiting_approval', url: LINK, attempt: attemptOf(h.row), expiresAt: expiresAt.toISOString() });
  await h.report({ status: 'done', attempt: attemptOf(h.row) });
  assert.deepEqual(await h.state(), { status: 'done', engine: 'cursor', url: null, userCode: null, message: null, account: null });
});

test('P4a a Cursor CLI sign-in waits out its link, not the relay’s usual eleven minutes', async () => {
  const h = harness();
  await h.beat();
  await h.post({ engine: 'cursor' });
  await h.beat();
  await h.report({ status: 'awaiting_approval', url: LINK, attempt: attemptOf(h.row) });
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  // Twenty minutes in, the link still works: nothing sweeps it.
  h.row.loginAt = minutesAgo(20);
  await h.beat();
  assert.equal((await h.state()).status, 'awaiting_approval');
  // Past the link's life and the runner's own wait on it, the sign-in has nothing behind it.
  h.row.loginAt = minutesAgo(31);
  await h.beat();
  assert.deepEqual(
    { status: (await h.state()).status, message: (await h.state()).message },
    { status: 'failed', message: 'Sign-in timed out — start it again.' },
  );

  // Every other engine's sign-in keeps the window it had.
  await h.post({ engine: 'codex' });
  await h.beat();
  await h.report({ status: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: 'WDJB-MJHT', attempt: attemptOf(h.row) });
  h.row.loginAt = minutesAgo(12);
  await h.beat();
  assert.equal((await h.state()).status, 'failed');
});

test('P4a a Cursor CLI account is removed only by a runner that declares cursor-account-remove/v1', async () => {
  const h = harness();
  await h.beat();
  assert.deepEqual(await h.remove(SLOT), { engine: 'cursor', account: SLOT, status: 'pending', message: null });
  // Handed over on the engine-tagged field, never the codex-named one an older runner reads as Codex's.
  const handed = await h.beat();
  assert.deepEqual(handed.remove, { engine: 'cursor', account: SLOT, attempt: (h.row.codexAccountRemoveAt as Date).toISOString() });
  assert.equal(handed.codexRemove, undefined);
  assert.deepEqual(
    await h.removed({ engine: 'cursor', account: SLOT, status: 'done', attempt: (h.row.codexAccountRemoveAt as Date).toISOString() }),
    { ok: true, applied: true },
  );
  // Default is the runner's own Cursor CLI login, never handed to the runner: it is removed from Orbit
  // alone, and not while it is the only Cursor CLI account the runner reports (runner-default-remove.spec.ts).
  await assert.rejects(h.remove('default'), refusedWith('Add another Cursor CLI account to this machine before removing Default.'));
  assert.equal(h.row.codexAccountRemoveAccount, SLOT, 'a refused removal writes nothing: the relay still names the slot it removed');

  // A runner that does not declare it is refused in the words the page shows, and stores nothing.
  const old = harness();
  await old.beat(CURSOR_OLD);
  await assert.rejects(old.remove(SLOT), refusedWith(REMOVE_TOO_OLD));
  assert.equal(old.row.codexAccountRemoveStatus, undefined);
  // Declared at the last heartbeat and not by the process polling now: refused at the heartbeat too.
  const stale = harness();
  await stale.beat();
  await stale.remove(SLOT);
  assert.equal((await stale.beat(CURSOR_OLD)).remove, undefined);
  assert.deepEqual(
    { status: stale.row.codexAccountRemoveStatus, message: stale.row.codexAccountRemoveMessage },
    { status: 'failed', message: REMOVE_TOO_OLD },
  );
});

test('P4a Cursor CLI’s accounts come through the engine report, and its sign-in and account routes take cursor', async () => {
  const accounts = [
    { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
    { id: SLOT, name: 'Work', home: `/root/.orbit/cursor-accounts/${SLOT}`, auth: 'no' },
  ];
  const [cursor] = sanitizeRunnerEngines([{ engine: 'cursor', installed: true, auth: 'yes', accounts }])!;
  assert.deepEqual(cursor.accounts, accounts);
  assert.equal(engineKeepsAccounts('cursor'), true);
  assert.equal(isLoginEngine('cursor'), true);

  // The DTO takes the engine, and the account routes the engine name in their path.
  const h = harness();
  await h.beat();
  assert.equal((await h.post({ engine: 'cursor' })).engine, 'cursor');
  h.row.engines = [{ engine: 'cursor', installed: true, auth: 'yes', accounts }];
  const runners = new RunnersController(new RunnersService({
    runner: {
      findFirst: async () => ({ ...h.row }),
    },
    $executeRaw: async () => 1,
  } as never));
  assert.deepEqual(await runners.renameAccount(USER, RUNNER_ID, 'cursor', SLOT, { name: 'Team' }), { ...accounts[1], name: 'Team' });
});
