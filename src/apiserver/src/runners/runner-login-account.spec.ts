import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { KIMI_LOGIN_REGION_V1, RunnerStatus, type LoginCommand, type RunnerLoginState } from '@orbit/shared';
import { ANTIGRAVITY_GOOGLE_LOGIN_V1 } from '../common/antigravity-readiness';
import type { AuthUser } from '../common/current-user.decorator';
import {
  CURSOR_ACCOUNT_LOGIN_V1,
  LOGIN_LINK_REFUSED,
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
const ACCOUNT_CAPABLE = `session-worktree-ops-v1,codex-account-login/v1`;
const CLAUDE_ACCOUNT_CAPABLE = `session-worktree-ops-v1,claude-account-login/v1`;
/** A runner that chooses Kimi's site, with and without keeping more than one Kimi account. */
const KIMI_SITE_CAPABLE = `session-worktree-ops-v1,${KIMI_LOGIN_REGION_V1}`;
const KIMI_ACCOUNT_CAPABLE = `${KIMI_SITE_CAPABLE},kimi-account-login/v1`;

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
    runnerPresence: { upsert: async () => ({}) },
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

test('a Claude account is signed in by name', async () => {
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
});

test('the link a runner reports ends at its first control character', async () => {
  const h = harness();
  await h.post({ engine: 'claude', accountName: 'Account 3' });
  const link = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge_method=S256&state=TfMnbWeC-gnq1qDovtlxarkcYLmrhINIdQoGp3OVZ4s';
  // What an older runner scraped from Claude Code 2.1.304's terminal output: the link with the escapes
  // that close its colour and its hyperlink still on, or the hyperlink's alone with no TERM. The page
  // copied them along — "…&state=…[39m]8;;" — and dropping only the control characters keeps that.
  for (const reported of [`${link}\x1b[39m\x1b]8;;`, `${link}\x1b]8;;`, link]) {
    await h.report({ status: 'awaiting_code', url: reported, attempt: attemptOf(h.row), account: ADDED_SLOT });
    assert.equal((await h.state()).url, link, JSON.stringify(reported));
  }
});

/** The sign-in link of each engine, in the shape its CLI prints it (runner-go's own login fixtures). */
const ENGINE_LINKS: Array<[string, 'awaiting_code' | 'awaiting_approval', string]> = [
  ['claude', 'awaiting_code', 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=frcAznfHKdQ3nNYn157q799r9SIaDMeJqq9HqdHD2JQ&code_challenge_method=S256&state=D_hsM6JpU6Uy2Ji8q0WtyOhF_Lq8iTIkuetcNISuRs'],
  ['codex', 'awaiting_approval', 'https://auth.openai.com/codex/device'],
  ['kimi', 'awaiting_approval', 'https://www.kimi.com/code/authorize_device?user_code=SHG3-0DSI'],
  ['kimi', 'awaiting_approval', 'https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86'],
  ['kimi', 'awaiting_approval', 'https://auth.kimi.com/verify?user_code=WDJB-MJHT'],
  ['antigravity', 'awaiting_code', 'https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&code_challenge=fixture'],
  ['cursor', 'awaiting_approval', 'https://cursor.com/loginDeepControl?challenge=Q2hhbGxlbmdl&uuid=7d2e0c1a-0000-4000-8000-000000000001&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true'],
];

/** Addresses no sign-in has: other schemes in the spellings a browser reads as them, and no address at all. */
const NOT_HTTPS_LINKS = [
  'javascript:void(0)', 'JAVASCRIPT:void(0)', 'JaVaScRiPt:void(0)', ' javascript:void(0)', '  JaVaScRiPt:void(0)',
  '\tjavascript:void(0)', '\njavascript:void(0)', '\x01javascript:void(0)', 'java\tscript:void(0)', 'java\nscript:void(0)',
  'java\rscript:void(0)', 'javascript\t:void(0)',
  'data:text/html,hello', 'DATA:text/html,hello', ' data:text/html,hello', 'data:text/html;base64,aGVsbG8=', 'da\tta:text/html,hello',
  'vbscript:msgbox(0)', 'VBScript:msgbox(0)', ' vbscript:msgbox(0)',
  'http://claude.com/cai/oauth/authorize?code=true', 'HTTP://claude.com/', 'http://localhost:1455/auth/callback',
  'file:///etc/hosts', 'blob:https://orbit.test/1', 'about:blank', 'ftp://claude.com/', 'mailto:someone@example.test', 'orbit-task:1',
  '/runners', 'claude.com/cai/oauth/authorize', '//claude.com/cai/oauth/authorize', 'https:', 'https://', '',
];

test('the link of every engine is kept as its CLI printed it', async () => {
  const h = harness();
  // What a start of Antigravity's and Cursor CLI's needs of the runner, before any link is reported.
  h.row.capabilities = [ANTIGRAVITY_GOOGLE_LOGIN_V1, CURSOR_ACCOUNT_LOGIN_V1];
  h.row.capabilitiesReportedAt = new Date();
  for (const [engine, status, link] of ENGINE_LINKS) {
    await h.post({ engine });
    const report = await h.report({ status, url: link, userCode: 'ABCD-1234', attempt: attemptOf(h.row) });
    assert.deepEqual(report, { ok: true, applied: true }, link);
    const state = await h.state();
    assert.equal(state.status, status, link);
    assert.equal(state.url, link);
    assert.equal(state.message, null, link);
    assert.equal(state.userCode, status === 'awaiting_approval' ? 'ABCD-1234' : null, link);
  }
});

test('a sign-in link that is not https is not kept, and ends the sign-in', async () => {
  const h = harness();
  for (const status of ['awaiting_code', 'awaiting_approval']) {
    for (const url of NOT_HTTPS_LINKS) {
      await h.post({ engine: 'claude' });
      const before = h.writes.length;
      const report = await h.report({
        status,
        url,
        userCode: 'ABCD-1234',
        message: 'from the runner',
        expiresAt: '2099-01-01T00:00:00.000Z',
        attempt: attemptOf(h.row),
      });
      const label = JSON.stringify([status, url]);
      assert.deepEqual(report, { ok: true, applied: true }, label);
      assert.equal(h.writes.length, before + 1, label);
      const write = h.writes[before];
      assert.equal(write.loginStatus, 'failed', label);
      assert.equal(write.loginUrl, null, label);
      assert.equal(write.loginUserCode, null, label);
      assert.equal(write.loginExpiresAt, null, label);
      assert.deepEqual(await h.state(), {
        status: 'failed',
        engine: 'claude',
        userCode: null,
        url: null,
        message: LOGIN_LINK_REFUSED,
        account: null,
      }, label);
    }
  }
});

test('the failure of a refused link says what happened in English, and repeats nothing of the link', () => {
  assert.match(LOGIN_LINK_REFUSED, /^[\x20-\x7e]+$/);
  assert.match(LOGIN_LINK_REFUSED, /isn't https/);
  assert.doesNotMatch(LOGIN_LINK_REFUSED, /javascript|data:|vbscript/i);
});

test('a report with no link is taken as before: there is nothing to refuse', async () => {
  const h = harness();
  await h.post({ engine: 'claude' });
  await h.report({ status: 'awaiting_code', attempt: attemptOf(h.row) });
  const state = await h.state();
  assert.equal(state.status, 'awaiting_code');
  assert.equal(state.url, null);
  assert.equal(state.message, null);
});

test('a sign-in that ended on a refused link can be started again', async () => {
  const h = harness();
  await h.post({ engine: 'claude' });
  await h.report({ status: 'awaiting_code', url: 'javascript:void(0)', attempt: attemptOf(h.row) });
  assert.equal((await h.state()).status, 'failed');

  await h.post({ engine: 'claude' });
  assert.equal((await h.state()).status, 'pending');
  assert.equal((await h.state()).message, null);
  const [, status, link] = ENGINE_LINKS[0];
  await h.report({ status, url: link, attempt: attemptOf(h.row) });
  assert.equal((await h.state()).status, status);
  assert.equal((await h.state()).url, link);
});

test('a refused link about a start this row has moved past changes nothing', async () => {
  const h = harness();
  await h.post({ engine: 'claude' });
  const stale = attemptOf(h.row);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await h.post({ engine: 'claude' });
  assert.notEqual(attemptOf(h.row), stale);
  const report = await h.report({ status: 'awaiting_code', url: 'javascript:void(0)', attempt: stale });
  assert.deepEqual(report, { ok: true, applied: false });
  assert.equal((await h.state()).status, 'pending');
  assert.equal((await h.state()).message, null);
});

test('a Kimi account is signed in by name on the site it is added on', async () => {
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

  // Its own login, on a site, is handed over as it always was.
  await h.post({ engine: 'kimi', region: 'global' });
  assert.deepEqual(await h.beat(KIMI_SITE_CAPABLE), { action: 'start', engine: 'kimi', attempt: attemptOf(h.row), region: 'global' });
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
