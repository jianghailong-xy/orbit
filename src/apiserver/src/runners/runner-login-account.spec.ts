import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { KIMI_LOGIN_REGION_V1, RunnerStatus, type LoginCommand, type RunnerLoginState } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import {
  CLAUDE_ACCOUNT_LOGIN_V1,
  CODEX_ACCOUNT_LOGIN_V1,
  KIMI_ACCOUNT_LOGIN_V1,
  RunnerApiController,
} from '../runner-api/runner-api.controller';
import { StartLoginDto } from './dto';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Signing a second Codex account in from the Providers page.
 *
 * A runner can hold more than one Codex account: Default is the CODEX_HOME its own environment
 * selects, every other one a slot it added. `POST /runners/:id/login` names the account — a slot
 * the runner has, or a new one it adds under a name — and what the runner is told to do is the
 * `loginRequest` of its next heartbeat. So the account named in the body has to arrive THERE, and
 * nowhere can it quietly become "no account", which the runner signs in as Default: that would
 * replace the machine's own login with the other account's.
 */

const OWNER = 'owner-1';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const SLOT = '1a2b3c4d';
const ADDED_SLOT = '5e6f7a8b';
const USER = { userId: OWNER } as AuthUser;
const ACCOUNT_CAPABLE = `session-worktree-ops-v1,${CODEX_ACCOUNT_LOGIN_V1}`;
const CLAUDE_ACCOUNT_CAPABLE = `session-worktree-ops-v1,${CLAUDE_ACCOUNT_LOGIN_V1}`;
/** A runner that chooses Kimi's site, with and without keeping more than one Kimi account. */
const KIMI_SITE_CAPABLE = `session-worktree-ops-v1,${KIMI_LOGIN_REGION_V1}`;
const KIMI_ACCOUNT_CAPABLE = `${KIMI_SITE_CAPABLE},${KIMI_ACCOUNT_LOGIN_V1}`;

type Row = Record<string, unknown>;

/** A where clause as the relay's statements write one: equality, a Date, or `{ not: null }`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    if (want && typeof want === 'object' && 'not' in want) return have != null;
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
  return {
    row,
    writes,
    /** POST /runners/:id/login, from the raw JSON body on. */
    async post(body: Row): Promise<RunnerLoginState> {
      const dto = (await pipe.transform(body, { type: 'body', metatype: StartLoginDto })) as StartLoginDto;
      return runners.startLogin(USER, RUNNER_ID, dto);
    },
    state: () => runners.loginState(USER, RUNNER_ID),
    cancel: () => runners.cancelLogin(USER, RUNNER_ID),
    /** POST /runners/:id/login/code: the authorization code the user pasted back. */
    code: (code: string) => runners.submitLoginCode(USER, RUNNER_ID, { code }),
    /** What the runner is told to do: the `loginRequest` of its next heartbeat. `null` is a
     *  runner that sends no capability header at all. */
    async beat(capabilities: string | null = ACCOUNT_CAPABLE): Promise<LoginCommand | undefined> {
      const response = await runnerApi.heartbeat(
        { id: RUNNER_ID, version: null },
        { status: RunnerStatus.ONLINE, idleCapacity: 1 },
        capabilities ?? undefined,
      );
      return response.loginRequest;
    },
    /** POST /runner/login-result, as the runner sends it. */
    report: (body: Row) =>
      (
        runnerApi as unknown as {
          loginResult: (runner: { id: string }, body: Row) => Promise<{ ok: boolean; applied: boolean }>;
        }
      ).loginResult({ id: RUNNER_ID }, body),
  };
}

const attemptOf = (row: Row) => (row.loginAt as Date).toISOString();

test('the account the body names is the account in the start the runner is handed', async () => {
  const h = harness();
  const state = await h.post({ engine: 'codex', account: SLOT });
  assert.equal(state.status, 'pending');
  assert.equal(state.account, SLOT);

  assert.deepEqual(await h.beat(), {
    action: 'start',
    engine: 'codex',
    attempt: attemptOf(h.row),
    account: SLOT,
  });
  // Redelivered, unchanged, until the runner's first report moves the row on.
  assert.deepEqual(await h.beat(), await h.beat());
  assert.equal((await h.beat())?.account, SLOT);

  // The device flow comes back the way it always has; the report also says which account it is.
  const applied = await h.report({
    status: 'awaiting_approval',
    url: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
    attempt: attemptOf(h.row),
    account: SLOT,
  });
  assert.deepEqual(applied, { ok: true, applied: true });
  assert.deepEqual(await h.state(), {
    status: 'awaiting_approval',
    engine: 'codex',
    url: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
    message: null,
    account: SLOT,
  });
  assert.equal(await h.beat(), undefined, 'nothing is redelivered once the runner has reported');
});

test('a new account is started by its name, and the slot the runner reports is what the page reads', async () => {
  const h = harness();
  const state = await h.post({ engine: 'codex', accountName: '  Work  ' });
  assert.equal(state.account, null, 'no slot exists until the runner adds one');

  assert.deepEqual(await h.beat(), {
    action: 'start',
    engine: 'codex',
    attempt: attemptOf(h.row),
    accountName: 'Work',
  });

  await h.report({
    status: 'awaiting_approval',
    url: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
    attempt: attemptOf(h.row),
    account: ADDED_SLOT,
  });
  assert.equal((await h.state()).account, ADDED_SLOT);
  await h.report({ status: 'done', attempt: attemptOf(h.row), account: ADDED_SLOT });
  const done = await h.state();
  assert.equal(done.status, 'done');
  assert.equal(done.account, ADDED_SLOT);
});

test('a start naming no account — the runner’s own login — is the shape it always was', async () => {
  const h = harness();
  await h.post({ engine: 'codex' });
  assert.deepEqual(await h.beat(), { action: 'start', engine: 'codex', attempt: attemptOf(h.row) });
  assert.equal((await h.state()).account, null);

  await h.post({});
  assert.deepEqual(await h.beat(), { action: 'start', engine: 'claude', attempt: attemptOf(h.row) });

  // And an older runner, which declares nothing, is still handed it.
  await h.post({ engine: 'codex' });
  assert.deepEqual(await h.beat(null), { action: 'start', engine: 'codex', attempt: attemptOf(h.row) });
});

test('a body that cannot name an account is refused, never read as the runner’s own login', async () => {
  const h = harness();
  const refused = async (body: Row, why: RegExp | undefined, message: string) => {
    await assert.rejects(() => h.post(body), (error: unknown) => {
      assert.ok(error instanceof BadRequestException, `${message}: ${String(error)}`);
      if (why) assert.match(JSON.stringify(error.getResponse()), why, message);
      return true;
    });
  };
  await refused({ engine: 'codex', account: '../../.codex' }, /account/, 'a path is not an account');
  await refused({ engine: 'codex', account: 'Work' }, /account/, 'a name is not an account id');
  await refused({ engine: 'codex', accountName: '   ' }, /needs a name/, 'a blank name');
  await refused({ engine: 'codex', accountName: 'x'.repeat(61) }, /accountName/, 'an overlong name');
  await refused({ engine: 'codex', account: SLOT, accountName: 'Work' }, /not both/, 'both at once');
  await refused({ engine: 'kimi', account: SLOT, accountName: 'Work', region: 'global' }, /not both/, 'both at once, for kimi');
  assert.deepEqual(h.writes, [], 'a refused body starts nothing');
  assert.equal(await h.beat(), undefined);
});

test('a Claude account is signed in by name, on a runner that declares that', async () => {
  const h = harness();
  await h.post({ engine: 'claude', account: SLOT });
  assert.deepEqual(await h.beat(CLAUDE_ACCOUNT_CAPABLE), {
    action: 'start',
    engine: 'claude',
    attempt: attemptOf(h.row),
    account: SLOT,
  });

  // And the code the user pastes comes back naming the account it belongs to: with more than one
  // Claude account, a sign-in can be waiting in any of them, and the runner routes the paste by
  // this pair (loginAccountKey).
  await h.report({ status: 'awaiting_code', url: 'https://claude.com/oauth', attempt: attemptOf(h.row) });
  await h.code('the-code');
  assert.deepEqual(await h.beat(CLAUDE_ACCOUNT_CAPABLE), {
    action: 'code',
    engine: 'claude',
    account: SLOT,
    code: 'the-code',
    attempt: attemptOf(h.row),
  });
  // A runner that has only ever signed in Codex accounts is not handed this one: it would take the
  // named account for a plain sign-in and put the machine's own login on the line.
  await h.post({ engine: 'claude', account: SLOT });
  assert.equal(await h.beat(ACCOUNT_CAPABLE), undefined);
  assert.match((await h.state()).message ?? '', /too old to sign in another Claude account/);
});

test('a Kimi account is signed in by name on the site it is added on, on a runner that declares that', async () => {
  const h = harness();
  await h.post({ engine: 'kimi', accountName: ' Work ', region: 'global' });
  assert.deepEqual(await h.beat(KIMI_ACCOUNT_CAPABLE), {
    action: 'start',
    engine: 'kimi',
    attempt: attemptOf(h.row),
    accountName: 'Work',
    region: 'global',
  });
  // One it already has, signed in again on its own site.
  await h.post({ engine: 'kimi', account: SLOT, region: 'mainland-cn' });
  assert.deepEqual(await h.beat(KIMI_ACCOUNT_CAPABLE), {
    action: 'start',
    engine: 'kimi',
    attempt: attemptOf(h.row),
    account: SLOT,
    region: 'mainland-cn',
  });

  // A runner that keeps one Kimi login — however it chooses the site, and whatever other engines'
  // accounts it keeps — is not handed a named one: it would sign the new account in over Default's.
  for (const capabilities of [KIMI_SITE_CAPABLE, `${KIMI_SITE_CAPABLE},${CODEX_ACCOUNT_LOGIN_V1},${CLAUDE_ACCOUNT_LOGIN_V1}`, null]) {
    await h.post({ engine: 'kimi', accountName: 'Work', region: 'global' });
    assert.equal(await h.beat(capabilities), undefined, String(capabilities));
    const state = await h.state();
    assert.equal(state.status, 'failed');
    assert.equal(state.message, 'This runner is too old to sign in another Kimi account — update it, then try again.');
  }
  await h.post({ engine: 'kimi', account: SLOT });
  assert.equal(await h.beat(KIMI_SITE_CAPABLE), undefined);
  assert.match((await h.state()).message ?? '', /too old to sign in another Kimi account/);
  // Its own login, on a site, is handed over as it always was.
  await h.post({ engine: 'kimi', region: 'global' });
  assert.deepEqual(await h.beat(KIMI_SITE_CAPABLE), { action: 'start', engine: 'kimi', attempt: attemptOf(h.row), region: 'global' });
});

test('a runner that does not declare account sign-in is never handed a start naming another account', async () => {
  const h = harness();
  await h.post({ engine: 'codex', account: SLOT });
  assert.equal(await h.beat('session-worktree-ops-v1'), undefined);
  const state = await h.state();
  assert.equal(state.status, 'failed');
  assert.match(state.message ?? '', /too old to sign in another Codex account/);

  await h.post({ engine: 'codex', accountName: 'Work' });
  assert.equal(await h.beat(null), undefined);
  assert.equal((await h.state()).status, 'failed');

  // Default is what such a runner signs in anyway, so asking for it by name is still handed over.
  await h.post({ engine: 'codex', account: 'default' });
  assert.deepEqual(await h.beat(null), {
    action: 'start',
    engine: 'codex',
    attempt: attemptOf(h.row),
    account: 'default',
  });
});

test('a report about a start the row has moved past changes nothing', async () => {
  const h = harness();
  await h.post({ engine: 'codex', account: SLOT });
  const first = attemptOf(h.row);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The user asks for another account while the first sign-in is still running on the runner.
  await h.post({ engine: 'codex', accountName: 'Work' });
  const second = attemptOf(h.row);
  assert.notEqual(first, second);

  const stale = await h.report({ status: 'failed', message: 'sign-in did not complete', attempt: first, account: SLOT });
  assert.deepEqual(stale, { ok: true, applied: false });
  assert.deepEqual(
    { status: (await h.state()).status, account: (await h.state()).account },
    { status: 'pending', account: null },
  );

  assert.deepEqual(
    await h.report({ status: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: 'WDJB-MJHT', attempt: second, account: ADDED_SLOT }),
    { ok: true, applied: true },
  );
  assert.equal((await h.state()).account, ADDED_SLOT);

  // Cancelled: nothing the runner still has to say about that sign-in lands.
  await h.cancel();
  assert.deepEqual(await h.report({ status: 'done', attempt: second, account: ADDED_SLOT }), { ok: true, applied: false });
  assert.deepEqual(await h.state(), { status: null, engine: null, url: null, userCode: null, message: null, account: null });

  // A runner too old to name its start is taken as it comes, as before.
  await h.post({ engine: 'codex' });
  assert.deepEqual(await h.report({ status: 'done' }), { ok: true, applied: true });
  assert.equal((await h.state()).status, 'done');
});

test('a report naming something that is not an account is refused', async () => {
  const h = harness();
  await h.post({ engine: 'codex', accountName: 'Work' });
  const writes = h.writes.length;
  await assert.rejects(
    () => h.report({ status: 'awaiting_approval', attempt: attemptOf(h.row), account: '../../.codex' }),
    BadRequestException,
  );
  await assert.rejects(() => h.report({ status: 'done', attempt: 'not a start' }), BadRequestException);
  assert.equal(h.writes.length, writes);
});
