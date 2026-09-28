import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CODEX_USAGE_UNREAD,
  CodexAuthError,
  codexDeviceChallenge,
  codexLoginUnavailableReason,
  codexLoginView,
  maskedAccount,
  parseCodexAuthJson,
} from './codex-login';

/**
 * What the codex sign-in makes of the CLI's own words and of the login it leaves behind (migration 0323,
 * providers/codex-login.ts). The state machine and the encryption are the pg spec's (codex-login.pg.spec.ts);
 * this is the half that needs no database: what a person is shown, and what they are never shown.
 *
 * The device output below is verbatim, colour codes and all (codex-cli 0.146.0, the same fixture the
 * runner's own sign-in relay is held to, runner-go login_test.go) — the scrape is the one thing here that
 * a CLI upgrade can silently break, so it is asserted against the real thing rather than a cleaned-up
 * version of it.
 */
const realCodexDeviceOutput =
  '\r\nWelcome to Codex [v\x1b[90m0.146.0\x1b[0m]\r\n' +
  "\x1b[90mOpenAI's command-line coding agent\x1b[0m\r\n\r\n" +
  'Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n' +
  '1. Open this link in your browser and sign in to your account\r\n' +
  '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n' +
  '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n' +
  '   \x1b[94mZXHO-K06HC\x1b[0m\r\n\r\n' +
  '\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you ' +
  'this code, cancel.\x1b[0m\r\n';

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token of the shape codex holds: three parts, the claims in the middle, nothing verified here. */
const jwt = (claims: object) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature`;

const ACCOUNT_ID = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const ACCESS_TOKEN = jwt({
  email: 'owner@example.invalid',
  exp: 1_800_000_000,
  'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID, chatgpt_plan_type: 'plus' },
});
const REFRESH_TOKEN = 'rt-1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f';

/** The file `codex login --device-auth` leaves in CODEX_HOME when the owner approved. */
const authJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: ACCESS_TOKEN, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, account_id: ACCOUNT_ID, ...over },
    last_refresh: '2026-09-28T15:00:00.000Z',
  });

test('the code the person is shown is scraped off the CLI output, colour codes and all', () => {
  assert.deepEqual(codexDeviceChallenge(realCodexDeviceOutput), {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ZXHO-K06HC',
  });
});

test('half a challenge is no challenge: a page with no code leaves the person stuck on it', () => {
  const urlOnly = realCodexDeviceOutput.slice(0, realCodexDeviceOutput.indexOf('2. Enter this'));
  assert.equal(codexDeviceChallenge(urlOnly), null);
  assert.equal(codexDeviceChallenge(''), null);
  // And a code that arrives before the line announcing it is not one — the anchor is what keeps a version
  // tag or an id out of the person's browser.
  const before = realCodexDeviceOutput.replace('one-time code', 'one time code');
  assert.equal(codexDeviceChallenge(before), null);
});

test('the login the CLI leaves is read into the four values this server stores — and nothing else is kept', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  const tokens = parseCodexAuthJson(authJson(), now);
  assert.deepEqual(tokens, {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    accountId: ACCOUNT_ID,
    email: 'owner@example.invalid',
    plan: 'plus',
    expiresAt: new Date(1_800_000_000_000),
  });
});

test('an account id is required: a file without one is not a completed login', () => {
  const noAccount = jwt({ email: 'owner@example.invalid', exp: 1_800_000_000 });
  for (const file of [
    'not json at all',
    '{"tokens":{}}',
    '{"tokens":{"access_token":"a"}}',
    JSON.stringify({ tokens: { access_token: noAccount, refresh_token: REFRESH_TOKEN } }),
  ]) {
    assert.throws(() => parseCodexAuthJson(file), CodexAuthError);
  }
  // The id token's claims are the account's identity; the access token's are read only when it alone has
  // them, which is a login that is still a login.
  const accessOnly = JSON.stringify({
    tokens: { access_token: jwt({ email: 'owner@example.invalid', exp: 1_800_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID, chatgpt_plan_type: 'pro' } }),
      refresh_token: REFRESH_TOKEN },
  });
  assert.deepEqual(
    (({ accountId, email, plan }) => ({ accountId, email, plan }))(parseCodexAuthJson(accessOnly)),
    { accountId: ACCOUNT_ID, email: 'owner@example.invalid', plan: 'pro' },
  );
});

test('a refusal about a login never repeats the login', () => {
  const secret = 'sk-codex-never-in-a-message';
  try {
    parseCodexAuthJson(JSON.stringify({ tokens: { access_token: secret, refresh_token: secret } }));
    assert.fail('a file with no account id was accepted');
  } catch (e) {
    assert.ok(e instanceof CodexAuthError);
    assert.equal(e.message.includes(secret), false, 'the refusal carried the token');
  }
});

test('an account is named by its email and its last four characters — never by its account id', () => {
  assert.equal(maskedAccount(ACCOUNT_ID), '…4e5f');
  const view = codexLoginView({
    accountId: ACCOUNT_ID,
    email: 'owner@example.invalid',
    plan: 'plus',
    state: 'ACTIVE',
    lastError: null,
    expiresAt: new Date('2026-09-28T12:00:00.000Z'),
    createdAt: new Date('2026-09-27T12:00:00.000Z'),
  })!;
  assert.deepEqual(view, {
    state: 'ACTIVE',
    email: 'owner@example.invalid',
    plan: 'plus',
    fingerprint: '…4e5f',
    lastError: null,
    expiresAt: '2026-09-28T12:00:00.000Z',
    linkedAt: '2026-09-27T12:00:00.000Z',
    usage: null,
    usageUnavailable: CODEX_USAGE_UNREAD,
  });
  const whole = JSON.stringify(view);
  for (const secret of [ACCOUNT_ID, ACCESS_TOKEN, REFRESH_TOKEN]) {
    assert.equal(whole.includes(secret), false, `the view carries ${secret.slice(0, 12)}…`);
  }
  assert.equal(codexLoginView(null), null);
});

test('a quota nobody has read is not a refusal: it leaves the account runnable and says why it is empty', () => {
  const account = { email: 'owner@example.invalid', state: 'ACTIVE' };
  assert.equal(codexLoginUnavailableReason('Mine', account), null);
  assert.equal(codexLoginUnavailableReason('Mine', { email: null, state: 'ACTIVE' }), null);
  assert.match(codexLoginUnavailableReason('Mine', null)!, /no ChatGPT account signed in/u);
  assert.match(codexLoginUnavailableReason('Mine', { email: 'owner@example.invalid', state: 'SIGNED_OUT' })!,
    /owner@example\.invalid .* was rejected by OpenAI/u);
});

/**
 * The credential path does not log. Every value this server holds for a login arrives in `codex-login.ts`
 * and is written by `codex-login.service.ts`, so this is where "明文与密文都不写日志" is either true or
 * not — and a `Logger`/`console` call added later is exactly how it would stop being true without any
 * assertion above noticing.
 */
test('nothing on the login path writes to a log', () => {
  // Read from the tree, not from `build`: this runs compiled, and the spec is about the sources shipped.
  const source = (file: string) => readFileSync(path.resolve(__dirname, '../../src/providers', file), 'utf8');
  const sources = ['codex-login.ts', 'codex-login.service.ts'].map(source);
  for (const source of sources) {
    for (const sink of [/\bconsole\s*\./u, /\bnew Logger\(/u, /Logger\b/u, /\bprocess\.stdout\b/u, /\bprocess\.stderr\b/u]) {
      assert.doesNotMatch(source, sink, `a logging call on the credential path (${sink})`);
    }
  }
});
