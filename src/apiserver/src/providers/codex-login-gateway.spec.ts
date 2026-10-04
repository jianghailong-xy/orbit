/**
 * The login pools' gateway, held to what the official codex CLI does with a ChatGPT login
 * (fixtures/codex-chatgpt-backend-recording.json, recorded by runner-go
 * codex_chatgpt_backend_recording_test.go): where it sends, how it authenticates and refreshes, which
 * answers it reads a spent subscription and its windows from — and the words a session is told. The
 * end-to-end half is pool-login-gateway.pg.spec.ts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CHATGPT_CODEX_BASE,
  CODEX_OAUTH_CLIENT_ID,
  codexUsageSnapshot,
  loginForwardedHeaders,
  loginMissingReason,
  loginSignedOutNotice,
  loginSpentNotice,
  OPENAI_OAUTH_TOKEN_URL,
  refreshRefusal,
  refreshRequestBody,
  usageLimitResetAt,
} from './codex-login-gateway';
import { loginPoolResumesAt } from './pool-login-select';
import { SPENT_ERROR_CODES } from './pool-gateway.service';

interface Exchange { method: string; path: string; headers: Array<[string, string]>; bodyBase64: string }
interface Answered { status: number; headers: Array<[string, string]>; bodyBase64: string }
const CLI = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../src/providers/fixtures/codex-chatgpt-backend-recording.json'), 'utf8'),
) as {
  codex: string;
  refreshToken: string;
  turn: { request: Exchange; response: Answered; codex: { rateLimits: unknown } };
  refresh: { token: { request: Exchange } };
  usageLimit: { response: Answered; codex: { codexErrorInfo: unknown; errorMessage: string } };
  rateLimit: { response: Answered };
};
const headersOf = (answered: { headers: Array<[string, string]> }) => Object.fromEntries(answered.headers);
const bodyOf = (answered: { bodyBase64: string }) => Buffer.from(answered.bodyBase64, 'base64').toString('utf8');
const NOW = new Date('2026-09-28T12:00:00.000Z');

test('the backend is the one the codex CLI sends a ChatGPT login to, and the refresh goes where the CLI refreshes, as the CLI\'s client', () => {
  // The CLI's turn went to <backend>/codex/responses: the gateway appends `/responses` to its base.
  assert.equal(CLI.turn.request.path, '/backend-api/codex/responses');
  assert.equal(new URL(CHATGPT_CODEX_BASE).pathname + '/responses', CLI.turn.request.path);
  assert.equal(new URL(CHATGPT_CODEX_BASE).origin, 'https://chatgpt.com');
  assert.equal(OPENAI_OAUTH_TOKEN_URL, 'https://auth.openai.com/oauth/token');
  assert.equal(CLI.refresh.token.request.path, '/oauth/token');
  assert.equal(JSON.parse(bodyOf(CLI.refresh.token.request)).client_id, CODEX_OAUTH_CLIENT_ID);
});

test('the credential goes as the CLI sends it — a bearer access token and the account header — and nothing else codex sent changes', () => {
  const cli = headersOf(CLI.turn.request);
  assert.match(cli.authorization, /^Bearer /);
  assert.ok(cli['chatgpt-account-id']);
  const incoming = {
    authorization: 'Bearer orbit-gwl-session-token',
    'chatgpt-account-id': 'acct-somebody-else',
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: 'orbit',
    'session-id': 's-1',
    'x-codex-turn-metadata': '{"a":1}',
    connection: 'keep-alive',
    host: 'orbit.example',
    'x-forwarded-for': '203.0.113.9',
    'cf-connecting-ip': '203.0.113.9',
    'accept-encoding': 'gzip',
    'content-length': '999',
  };
  assert.deepEqual(loginForwardedHeaders(incoming, 'ey.access', 'acct-owner', 42), {
    authorization: 'Bearer ey.access',
    'chatgpt-account-id': 'acct-owner',
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: 'orbit',
    'session-id': 's-1',
    'x-codex-turn-metadata': '{"a":1}',
    'content-length': '42',
  });
});

test('the refresh is the codex CLI\'s own request, byte for byte but the token', () => {
  const recorded = bodyOf(CLI.refresh.token.request);
  assert.equal(refreshRequestBody(CLI.refreshToken), recorded);
  assert.equal(headersOf(CLI.refresh.token.request)['content-type'], 'application/json');
  assert.equal(CLI.refresh.token.request.method, 'POST');
});

test('a refusal from the token endpoint is final exactly where the codex CLI says so, in its words', () => {
  const expired = refreshRefusal(401, { error: { code: 'refresh_token_expired', message: 'x' } });
  assert.deepEqual(expired, {
    permanent: true,
    message: 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
  });
  assert.match(refreshRefusal(400, { error: { code: 'refresh_token_reused' } }).message, /already used/);
  assert.match(refreshRefusal(400, { error_code: 'refresh_token_invalidated' }).message, /was revoked/);
  assert.equal(refreshRefusal(401, {}).permanent, true, 'a 401 is final whatever it says');
  assert.equal(refreshRefusal(400, { error: 'invalid_grant', error_description: 'bad' }).permanent, true);
  assert.equal(refreshRefusal(400, { error: 'invalid_request' }).permanent, false);
  assert.equal(refreshRefusal(500, undefined).permanent, false, 'a server error is tried again, never a sign-out');
  assert.equal(refreshRefusal(429, { error: { code: 'rate_limited' } }).permanent, false);
});

test('the windows are read off the backend\'s headers as codex reads them, and so are its limits', () => {
  const snapshot = codexUsageSnapshot(Object.fromEntries(CLI.turn.response.headers), NOW);
  assert.deepEqual(snapshot, {
    provider: 'codex',
    limitId: 'codex',
    primary: { utilization: 42, resetsAt: '2100-01-01T00:00:00.000Z', windowDurationMins: 300 },
    secondary: { utilization: 64, resetsAt: '2100-01-04T00:00:00.000Z', windowDurationMins: 10080 },
    fetchedAt: NOW.toISOString(),
  });
  // What the CLI itself reported off the same headers.
  const reported = CLI.turn.codex.rateLimits as {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number };
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number };
  };
  for (const which of ['primary', 'secondary'] as const) {
    assert.equal(snapshot![which]!.utilization, reported[which].usedPercent);
    assert.equal(snapshot![which]!.windowDurationMins, reported[which].windowDurationMins);
    assert.equal(Date.parse(snapshot![which]!.resetsAt!), reported[which].resetsAt * 1000);
  }
  assert.equal(codexUsageSnapshot({ 'content-type': 'text/event-stream' }, NOW), null, 'an API key\'s answers carry no windows');
  assert.deepEqual(
    codexUsageSnapshot({
      'x-codex-primary-used-percent': '5', 'x-codex-credits-has-credits': 'true', 'x-codex-credits-unlimited': 'false',
      'x-codex-credits-balance': ' 12.5 ',
    }, NOW)?.credits,
    { hasCredits: true, unlimited: false, balance: '12.5' },
  );
});

test('a spent subscription waits for the reset the backend named — then a spent window\'s, then retry-after, then five hours', () => {
  const recorded = CLI.usageLimit.response;
  assert.equal(recorded.status, 429);
  const body = JSON.parse(bodyOf(recorded)) as { error: { type: string; resets_at: number } };
  // What the CLI reads it as.
  assert.equal(CLI.usageLimit.codex.codexErrorInfo, 'usageLimitExceeded');
  assert.ok(SPENT_ERROR_CODES.has(body.error.type), 'the recorded spent answer is not read as spent');
  assert.ok(!SPENT_ERROR_CODES.has('rate_limit_exceeded'), 'a rate limit would not be waited out');
  const headers = Object.fromEntries(recorded.headers);
  assert.deepEqual(usageLimitResetAt(body, headers, NOW), new Date(body.error.resets_at * 1000));
  assert.deepEqual(usageLimitResetAt({ error: { type: 'usage_limit_reached' } }, headers, NOW), new Date('2100-01-01T00:00:00.000Z'));
  assert.deepEqual(usageLimitResetAt(undefined, { 'retry-after': '120' }, NOW), new Date(NOW.getTime() + 120_000));
  assert.deepEqual(usageLimitResetAt(undefined, {}, NOW), new Date(NOW.getTime() + 5 * 3_600_000));
  // A reset already past is not a reset.
  assert.deepEqual(usageLimitResetAt({ error: { resets_at: 1 } }, {}, NOW), new Date(NOW.getTime() + 5 * 3_600_000));
});

test('a login pool resumes at its account\'s reset, now when it is not spent, and never by waiting when there is no account or it is signed out', () => {
  const reset = new Date(NOW.getTime() + 3_600_000);
  const account = (state: string, spentUntil: Date | null) => ({ accountId: 'acct-0000-AB12', email: null, state, spentUntil, usage: null });
  assert.deepEqual(loginPoolResumesAt([account('ACTIVE', reset)], NOW), reset);
  assert.deepEqual(loginPoolResumesAt([account('ACTIVE', new Date(NOW.getTime() - 1))], NOW), NOW);
  assert.deepEqual(loginPoolResumesAt([account('ACTIVE', null)], NOW), NOW);
  assert.equal(loginPoolResumesAt([account('SIGNED_OUT', reset)], NOW), null);
  assert.equal(loginPoolResumesAt([], NOW), null);
  // Several: now while one of them can run, else the first to come back; a signed-out one never does.
  const later = new Date(NOW.getTime() + 7_200_000);
  assert.deepEqual(loginPoolResumesAt([account('ACTIVE', later), account('ACTIVE', null)], NOW), NOW);
  assert.deepEqual(loginPoolResumesAt([account('SIGNED_OUT', null), account('ACTIVE', later), account('ACTIVE', reset)], NOW), reset);
});

test('the session is told which window of which account is spent and when it goes again — never that it switched', () => {
  const login = { email: 'owner@example.invalid', accountId: 'acct-0000-AB12' };
  const reading = codexUsageSnapshot(Object.fromEntries(CLI.usageLimit.response.headers), NOW);
  const reset = new Date('2100-01-01T00:00:00.000Z');
  assert.equal(
    loginSpentNotice(login, reading, reset),
    'The 5-hour window on owner@example.invalid is spent — this session waits for its reset at 2100-01-01 00:00 UTC',
  );
  const weekly = { provider: 'codex' as never, secondary: { utilization: 100, windowDurationMins: 10080 } };
  assert.match(loginSpentNotice(login, weekly, reset), /^The weekly window on owner@example\.invalid is spent/);
  assert.equal(
    loginSpentNotice({ email: null, accountId: login.accountId }, null, reset),
    'The usage limit on …AB12 is reached — this session waits for its reset at 2100-01-01 00:00 UTC',
  );
  assert.doesNotMatch(loginSpentNotice(login, reading, reset), /Switched/);
  assert.equal(
    loginSignedOutNotice(login, 'My Codex'),
    'The ChatGPT account owner@example.invalid on "My Codex" was signed out by OpenAI — only you can sign in again, on the pool\'s page',
  );
  assert.equal(loginMissingReason('My Codex'), '"My Codex" has no ChatGPT account signed in — sign one in on the pool\'s page');
  // An account somebody else in the pool signed in (migration 0371) is put back by them alone: the press
  // is named as theirs, not as the reader's.
  assert.equal(
    loginSignedOutNotice(login, 'My Codex', false),
    'The ChatGPT account owner@example.invalid on "My Codex" was signed out by OpenAI — only the person who signed it in can sign in again, on the pool\'s page',
  );
  // No word of these names the account's id.
  for (const words of [loginSpentNotice(login, reading, reset), loginSignedOutNotice(login, 'My Codex')]) {
    assert.ok(!words.includes(login.accountId));
  }
});
