import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FEISHU_TEST_OPEN_PLATFORM_ENV,
  checkCredentials,
  openPlatformOrigin,
  type FeishuAppCredentials,
} from './feishu-open-platform';
import { FAKE_INVALID_PARAM, FAKE_SECRET_INVALID, FakeOpenPlatform } from './test-support/fake-open-platform';

/**
 * The token trade a save makes before it stores anything (docs/feishu-bot-design.md §4.1), through the official
 * SDK, against the fake open platform: which address each platform reaches, Feishu's refusals carried back with
 * their code and message, an open platform that cannot be asked, and nothing logged — the SDK logs a failed
 * request with the body it sent, which here is the App Secret.
 */

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const APP: FeishuAppCredentials = { platform: 'FEISHU', appId: 'cli_feishu_open_platform_spec', appSecret: 'feishu-open-platform-spec-secret' };

/** Run `fn` with the environment changed as given, restored after. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Everything written to the console while `fn` runs: where the SDK's own logger writes. */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const out: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const before = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...args: unknown[]) => void out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    const result = await fn();
    return { result, output: out.join('\n') };
  } finally {
    methods.forEach((m, i) => (console[m] = before[i]));
  }
}

test("each platform's address is its own; a test address is read only outside production", async () => {
  await withEnv({ [FEISHU_TEST_OPEN_PLATFORM_ENV]: undefined }, () => {
    assert.equal(openPlatformOrigin('FEISHU'), 'https://open.feishu.cn');
    assert.equal(openPlatformOrigin('LARK'), 'https://open.larksuite.com');
  });
  await withEnv({ [FEISHU_TEST_OPEN_PLATFORM_ENV]: 'http://127.0.0.1:9/', NODE_ENV: 'test' }, () => {
    assert.equal(openPlatformOrigin('FEISHU'), 'http://127.0.0.1:9/feishu');
    assert.equal(openPlatformOrigin('LARK'), 'http://127.0.0.1:9/lark');
  });
  await withEnv({ [FEISHU_TEST_OPEN_PLATFORM_ENV]: 'http://127.0.0.1:9', NODE_ENV: 'production' }, () => {
    assert.equal(openPlatformOrigin('FEISHU'), 'https://open.feishu.cn');
    assert.equal(openPlatformOrigin('LARK'), 'https://open.larksuite.com');
  });
});

test('the token trade: a good pair is accepted, Feishu\'s refusals come back with their code and message, an open platform that cannot be asked is said so, and nothing is logged', async (t) => {
  const fake = new FakeOpenPlatform();
  const url = await fake.start();
  t.after(() => fake.stop());
  fake.addApp(APP);
  const check = (app: Partial<FeishuAppCredentials> = {}) =>
    withEnv({ [FEISHU_TEST_OPEN_PLATFORM_ENV]: url, NODE_ENV: 'test' }, () => checkCredentials({ ...APP, ...app }));

  await t.test('a good pair: one token request, on its platform, carrying the pair; the token is not in the answer', async () => {
    const { result, output } = await captured(() => check());
    assert.deepEqual(result, { ok: true });
    const sent = fake.requestsTo(TOKEN_PATH);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].platform, 'FEISHU');
    assert.equal(sent[0].method, 'POST');
    assert.deepEqual(sent[0].body, { app_id: APP.appId, app_secret: APP.appSecret });
    assert.equal(fake.tenantAccessTokens.length, 1);
    assert.ok(!JSON.stringify(result).includes(fake.tenantAccessTokens[0]));
    assert.equal(output, '');
  });

  await t.test('a wrong secret: Feishu\'s 10014 and its message, nothing logged', async () => {
    const { result, output } = await captured(() => check({ appSecret: 'not-the-secret' }));
    assert.deepEqual(result, { ok: false, code: 'FEISHU_CREDENTIALS_REJECTED', feishuCode: FAKE_SECRET_INVALID.code, feishuMsg: FAKE_SECRET_INVALID.msg });
    assert.equal(output, '', 'the SDK would log the request body, the secret in it');
  });

  await t.test('an App ID Feishu does not know, and the right pair on the other platform: refused, and the request went to that platform', async () => {
    assert.deepEqual(await check({ appId: 'cli_nobody' }), { ok: false, code: 'FEISHU_CREDENTIALS_REJECTED', feishuCode: FAKE_INVALID_PARAM.code, feishuMsg: FAKE_INVALID_PARAM.msg });
    const before = fake.requestsTo(TOKEN_PATH, 'LARK').length;
    assert.deepEqual(await check({ platform: 'LARK' }), { ok: false, code: 'FEISHU_CREDENTIALS_REJECTED', feishuCode: FAKE_INVALID_PARAM.code, feishuMsg: FAKE_INVALID_PARAM.msg });
    assert.equal(fake.requestsTo(TOKEN_PATH, 'LARK').length, before + 1);
  });

  await t.test('a refusal answered 200 with a code is the same refusal', async () => {
    fake.refusalStatus = 200;
    try {
      assert.deepEqual(await check({ appSecret: 'not-the-secret' }), { ok: false, code: 'FEISHU_CREDENTIALS_REJECTED', feishuCode: FAKE_SECRET_INVALID.code, feishuMsg: FAKE_SECRET_INVALID.msg });
    } finally {
      fake.refusalStatus = 400;
    }
  });

  await t.test('no usable answer: a dropped connection and a page that is not JSON; neither is logged', async () => {
    fake.mode = 'unreachable';
    try {
      const { result, output } = await captured(() => check());
      assert.equal(result.ok, false);
      assert.equal((result as { code: string }).code, 'FEISHU_UNREACHABLE');
      assert.ok(!JSON.stringify(result).includes(APP.appSecret));
      assert.equal(output, '');
    } finally {
      fake.mode = 'ok';
    }
    fake.mode = 'not-json';
    try {
      assert.deepEqual(await check(), { ok: false, code: 'FEISHU_UNREACHABLE', reason: 'Feishu answered with something that is not JSON' });
    } finally {
      fake.mode = 'ok';
    }
  });

  await t.test('an open platform that is not there: ECONNREFUSED', async () => {
    const gone = new FakeOpenPlatform();
    const goneUrl = await gone.start();
    await gone.stop();
    const result = await withEnv({ [FEISHU_TEST_OPEN_PLATFORM_ENV]: goneUrl, NODE_ENV: 'test' }, () => checkCredentials(APP));
    assert.deepEqual(result, { ok: false, code: 'FEISHU_UNREACHABLE', reason: 'ECONNREFUSED' });
  });
});
