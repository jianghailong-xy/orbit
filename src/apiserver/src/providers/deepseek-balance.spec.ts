import { strict as assert } from 'node:assert';
import { afterEach, mock, test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ProviderBalance } from '@orbit/shared';
import { isDeepSeekAccountRow, parseDeepSeekBalance } from './deepseek-balance';
import { BALANCE_FRESH_MS, BALANCE_REFRESH_THROTTLE_MS, DeepSeekBalanceService } from './deepseek-balance.service';
import { encryptSecret } from './provider-crypto';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

const KEY = 'sk-0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'sk-fedcba9876543210fedcba9876543210';

interface Row {
  id: string;
  ownerId: string;
  label: string;
  presetSlug: string | null;
  baseUrl: string;
  apiKeyEnc: string;
}

// Each row encrypts its key on its own, as saving it does: one key held by two providers is two
// different ciphertexts, which is exactly why the cache cannot be keyed by what is stored.
const row = (over: Partial<Row> & { key?: string }): Row => {
  const { key = KEY, ...rest } = over;
  return {
    id: 'ds',
    ownerId: 'owner',
    label: 'DeepSeek',
    presetSlug: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKeyEnc: encryptSecret(key),
    ...rest,
  };
};

/** The owner's rows as the service reads them: only that owner's, like the real query. */
function service(rows: Row[]) {
  const prisma = {
    modelProvider: {
      findMany: async ({ where }: { where: { ownerId: string } }) => rows.filter((r) => r.ownerId === where.ownerId),
    },
  };
  return new DeepSeekBalanceService(prisma as never);
}

type Reply = { status: number; body?: unknown } | Error;

/** Answers each request with the next reply (the last one repeats), recording what was asked. */
function stubFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => {
        if (typeof reply.body === 'string') throw new SyntaxError('Unexpected token');
        return reply.body;
      },
    };
  }) as never;
  restoreFetch = () => (globalThis.fetch = original);
  return calls;
}
let restoreFetch = () => {};

afterEach(() => {
  restoreFetch();
  mock.timers.reset();
});

const CNY = { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' };
const USD = { currency: 'USD', total_balance: '5.00', granted_balance: '0.00', topped_up_balance: '5.00' };
const OK = { status: 200, body: { is_available: true, balance_infos: [CNY] } };

/** A failure must carry no amount — and nothing in it may read as one. */
function assertNoAmount(result: ProviderBalance) {
  assert.equal(result.ok, false);
  assert.ok(!('balances' in result), 'a failure has no balances');
  assert.ok(!('isAvailable' in result), 'a failure says nothing about availability');
  assert.doesNotMatch(JSON.stringify(result), /"0(\.0+)?"|¥|\$0/);
}

test('asks DeepSeek’s fixed /user/balance with the stored key, never the provider’s /anthropic endpoint', async () => {
  const calls = stubFetch([OK]);
  const result = await service([row({})]).balance('owner', 'ds', false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.redirect, 'manual', 'a redirect must not carry the key anywhere');
  assert.deepEqual(result, {
    ok: true,
    balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' }],
    isAvailable: true,
    fetchedAt: result.fetchedAt,
    sharedWith: [],
  });
  assert.ok(!Number.isNaN(Date.parse(result.fetchedAt)));
  assert.ok(!JSON.stringify(result).includes(KEY), 'the key never leaves the server');
  assert.ok(!JSON.stringify(result).includes('0123456789'), 'nor any part of it');
});

test('every currency stays its own balance, amounts exactly as DeepSeek wrote them', async () => {
  stubFetch([{ status: 200, body: { is_available: true, balance_infos: [CNY, USD] } }]);
  const result = await service([row({})]).balance('owner', 'ds', false);
  assert.ok(result.ok);
  assert.deepEqual(result.balances.map((b) => [b.currency, b.totalBalance, b.grantedBalance, b.toppedUpBalance]), [
    ['CNY', '110.00', '10.00', '100.00'],
    ['USD', '5.00', '0.00', '5.00'],
  ]);
});

test('is_available=false comes back as such, with the real amount beside it', async () => {
  stubFetch([{ status: 200, body: { is_available: false, balance_infos: [{ ...CNY, total_balance: '0.42', granted_balance: '0.00', topped_up_balance: '0.42' }] } }]);
  const result = await service([row({})]).balance('owner', 'ds', false);
  assert.ok(result.ok);
  assert.equal(result.isAvailable, false);
  assert.equal(result.balances[0].totalBalance, '0.42');
});

test('a 401 is KEY_REJECTED with no amount, and none of DeepSeek’s error text (which can quote the key)', async () => {
  stubFetch([{ status: 401, body: { error: { message: `Authentication Fails, Your api key: ****cdef is invalid` } } }]);
  const result = await service([row({})]).balance('owner', 'ds', false);
  assertNoAmount(result);
  assert.ok(!result.ok);
  assert.equal(result.reason, 'KEY_REJECTED');
  assert.equal(result.message, 'DeepSeek rejected this API key (401 Authentication Fails).');
  assert.ok(!JSON.stringify(result).includes('cdef'));
});

test('a 403 is a rejected key too', async () => {
  stubFetch([{ status: 403 }]);
  const result = await service([row({})]).balance('owner', 'ds', false);
  assert.ok(!result.ok);
  assert.equal(result.reason, 'KEY_REJECTED');
});

test('no answer at all is NETWORK — and says the key was not checked', async () => {
  stubFetch([new TypeError('fetch failed')]);
  const unreachable = await service([row({})]).balance('owner', 'ds', false);
  assertNoAmount(unreachable);
  assert.ok(!unreachable.ok);
  assert.equal(unreachable.reason, 'NETWORK');
  assert.equal(unreachable.message, "Couldn't reach api.deepseek.com. The key itself wasn't checked.");

  stubFetch([Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]);
  const timedOut = await service([row({})]).balance('owner', 'ds', false);
  assertNoAmount(timedOut);
  assert.ok(!timedOut.ok);
  assert.equal(timedOut.reason, 'NETWORK');
  assert.equal(
    timedOut.message,
    "Couldn't reach api.deepseek.com — the request timed out after 10 s. The key itself wasn't checked.",
  );
});

test('an error status, a redirect or a body that is not a balance is UPSTREAM_ERROR', async () => {
  for (const [reply, message] of [
    [{ status: 503 }, "DeepSeek answered 503 Server Overloaded. The key itself wasn't checked."],
    [{ status: 429 }, "DeepSeek answered 429 Rate Limit Reached. The key itself wasn't checked."],
    [{ status: 302 }, "DeepSeek answered HTTP 302. The key itself wasn't checked."],
    [{ status: 200, body: '<html>' }, "DeepSeek answered with a balance Orbit couldn't read."],
    [{ status: 200, body: { is_available: true, balance_infos: [] } }, "DeepSeek answered with a balance Orbit couldn't read."],
    [{ status: 200, body: { is_available: true, balance_infos: [{ ...CNY, total_balance: null }] } }, "DeepSeek answered with a balance Orbit couldn't read."],
  ] as const) {
    stubFetch([reply]);
    const result = await service([row({})]).balance('owner', 'ds', false);
    assertNoAmount(result);
    assert.ok(!result.ok);
    assert.equal(result.reason, 'UPSTREAM_ERROR');
    assert.equal(result.message, message);
  }
});

test('providers holding the same key share one read, and each names the other', async () => {
  const calls = stubFetch([OK, { status: 200, body: { is_available: true, balance_infos: [USD] } }]);
  const svc = service([
    row({}),
    row({ id: 'dsh', label: 'DeepSeek Harness', presetSlug: 'deepseek-harness' }),
    row({ id: 'work', label: 'Work DeepSeek', key: OTHER_KEY }),
    row({ id: 'kimi', label: 'Kimi', presetSlug: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1' }),
  ]);
  const deepseek = await svc.balance('owner', 'ds', false);
  const harness = await svc.balance('owner', 'dsh', false);
  assert.equal(calls.length, 1, 'one key, one request');
  assert.deepEqual({ ...harness, sharedWith: [] }, { ...deepseek, sharedWith: [] }, 'the same read, fetchedAt included');
  assert.deepEqual(deepseek.sharedWith, [{ id: 'dsh', label: 'DeepSeek Harness' }]);
  assert.deepEqual(harness.sharedWith, [{ id: 'ds', label: 'DeepSeek' }]);

  const work = await svc.balance('owner', 'work', false);
  assert.equal(calls.length, 2, 'another key is another account');
  assert.ok(work.ok);
  assert.equal(work.balances[0].currency, 'USD');
  assert.deepEqual(work.sharedWith, []);
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, `Bearer ${OTHER_KEY}`);
});

test('reads that arrive together share the one request in flight', async () => {
  const calls = stubFetch([OK]);
  const svc = service([row({}), row({ id: 'dsh', presetSlug: 'deepseek-harness' })]);
  const [a, b] = await Promise.all([svc.balance('owner', 'ds', false), svc.balance('owner', 'dsh', true)]);
  assert.equal(calls.length, 1);
  assert.equal(a.fetchedAt, b.fetchedAt);
});

test('a read is served from the cache for 90 s, then DeepSeek is asked again', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const calls = stubFetch([OK]);
  const svc = service([row({})]);
  const first = await svc.balance('owner', 'ds', false);
  mock.timers.tick(BALANCE_FRESH_MS - 1);
  assert.equal((await svc.balance('owner', 'ds', false)).fetchedAt, first.fetchedAt);
  assert.equal(calls.length, 1);
  mock.timers.tick(1);
  const next = await svc.balance('owner', 'ds', false);
  assert.equal(calls.length, 2);
  assert.notEqual(next.fetchedAt, first.fetchedAt);
  assert.ok(BALANCE_FRESH_MS >= 60_000 && BALANCE_FRESH_MS <= 120_000);
});

test('a refresh skips the cache, but asks DeepSeek at most once per 10 s for a key', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const calls = stubFetch([OK, { status: 200, body: { is_available: false, balance_infos: [CNY] } }]);
  const svc = service([row({}), row({ id: 'dsh', presetSlug: 'deepseek-harness' })]);
  const first = await svc.balance('owner', 'ds', false);

  mock.timers.tick(BALANCE_REFRESH_THROTTLE_MS - 1);
  const throttled = await svc.balance('owner', 'ds', true);
  assert.equal(calls.length, 1, 'a refresh right after a read gets that read');
  assert.equal(throttled.fetchedAt, first.fetchedAt);

  mock.timers.tick(1);
  const refreshed = await svc.balance('owner', 'ds', true);
  assert.equal(calls.length, 2, 'past the throttle a refresh asks again, though the read is still fresh');
  assert.ok(refreshed.ok && refreshed.isAvailable === false);

  // The provider sharing the key reads the refreshed answer without asking again.
  const harness = await svc.balance('owner', 'dsh', false);
  assert.equal(calls.length, 2);
  assert.equal(harness.fetchedAt, refreshed.fetchedAt);

  // A refresh hammered in a loop is still one request per 10 s.
  for (let i = 0; i < 5; i++) await svc.balance('owner', 'dsh', true);
  assert.equal(calls.length, 2);
});

test('a failed read is cached like any other, and a refresh past the throttle retries it', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const calls = stubFetch([new TypeError('fetch failed'), OK]);
  const svc = service([row({})]);
  assert.equal((await svc.balance('owner', 'ds', false)).ok, false);
  assert.equal((await svc.balance('owner', 'ds', false)).ok, false);
  assert.equal(calls.length, 1);
  mock.timers.tick(BALANCE_REFRESH_THROTTLE_MS);
  assert.equal((await svc.balance('owner', 'ds', true)).ok, true);
  assert.equal(calls.length, 2);
});

test('only the owner’s own DeepSeek keys have a balance', async () => {
  const calls = stubFetch([OK]);
  const svc = service([
    row({}),
    row({ id: 'theirs', ownerId: 'someone-else' }),
    row({ id: 'claude', presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
    row({ id: 'custom', presetSlug: null, baseUrl: 'https://api.deepseek.com/anthropic' }),
    row({ id: 'proxy', presetSlug: null, baseUrl: 'https://llm-proxy.example.com/anthropic' }),
    row({ id: 'keyless', apiKeyEnc: '' }),
  ]);
  await assert.rejects(svc.balance('owner', 'theirs', false), NotFoundException);
  await assert.rejects(svc.balance('owner', 'missing', false), NotFoundException);
  await assert.rejects(svc.balance('owner', 'claude', false), BadRequestException);
  await assert.rejects(svc.balance('owner', 'proxy', false), BadRequestException);
  await assert.rejects(svc.balance('owner', 'keyless', false), NotFoundException);
  assert.equal(calls.length, 0, 'none of those asked DeepSeek anything');
  const custom = await svc.balance('owner', 'custom', false);
  assert.ok(custom.ok, 'a custom endpoint on api.deepseek.com is a DeepSeek key');
  assert.deepEqual(custom.sharedWith, [{ id: 'ds', label: 'DeepSeek' }]);
});

test('which rows are DeepSeek keys: the two presets, else a custom endpoint on api.deepseek.com', () => {
  assert.equal(isDeepSeekAccountRow({ presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' }), true);
  assert.equal(isDeepSeekAccountRow({ presetSlug: 'deepseek-harness', baseUrl: 'https://api.deepseek.com/anthropic' }), true);
  assert.equal(isDeepSeekAccountRow({ presetSlug: null, baseUrl: 'https://API.DeepSeek.com/v1' }), true);
  assert.equal(isDeepSeekAccountRow({ presetSlug: null, baseUrl: 'https://api.deepseek.com.evil.example/v1' }), false);
  assert.equal(isDeepSeekAccountRow({ presetSlug: null, baseUrl: 'not a url' }), false);
  assert.equal(isDeepSeekAccountRow({ presetSlug: 'moonshot', baseUrl: 'https://api.deepseek.com/anthropic' }), false);
});

test('the parser takes DeepSeek’s string amounts as they are and refuses anything that is not one', () => {
  assert.deepEqual(parseDeepSeekBalance({ is_available: true, balance_infos: [{ ...CNY, currency: 'cny' }] }), {
    isAvailable: true,
    balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '10.00', toppedUpBalance: '100.00' }],
  });
  assert.equal(parseDeepSeekBalance({ is_available: 'yes', balance_infos: [CNY] }), null);
  assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [{ ...CNY, granted_balance: 'ten' }] }), null);
  assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [{ ...CNY, currency: '' }] }), null);
  assert.equal(parseDeepSeekBalance({ is_available: true }), null);
  assert.equal(parseDeepSeekBalance(null), null);
});
