import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beautifySession,
  enqueueBeautifySession,
  sanitizeTags,
  TITLE_BEAUTIFY_CONCURRENCY,
  titleFromAttachments,
} from './naming';
import type { HeldKey } from '../providers/held-key';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function namingResponse(title: string, tags?: unknown): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ title, tags }) } }] }),
  } as Response;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('tags from the model are trimmed, deduped case-insensitively and capped', () => {
  assert.deepEqual(sanitizeTags(['  #登录  ', 'Login', 'login', 'auth', 'billing']), [
    '登录',
    'Login',
    'auth',
  ]);
  assert.deepEqual(sanitizeTags(['a'.repeat(40)]), ['a'.repeat(24)]);
  assert.deepEqual(sanitizeTags(['ok', 42, null, { name: 'x' }, '   ', '###']), ['ok']);
  // A model that answers with a bare string, or omits tags entirely, must not throw.
  assert.deepEqual(sanitizeTags('bug'), []);
  assert.deepEqual(sanitizeTags(undefined), []);
});

test('a session opened with attachments alone is titled by their file names', () => {
  assert.equal(titleFromAttachments(['testflight_feedback.zip']), 'testflight_feedback.zip');
  assert.equal(titleFromAttachments(['a.png', null, 'b.log']), 'a.png, b.log');
  assert.equal(titleFromAttachments([`${'x'.repeat(90)}.zip`]).length, 80);
  // Nothing to name it by (legacy rows carry no file name) still yields a title, never ''.
  assert.equal(titleFromAttachments([null]), 'Attachment');
});

test('beautifySession offers the owner tags for reuse and returns the parsed labels', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let body: { messages: { role: string; content: string }[] } | undefined;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = ((_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return Promise.resolve(namingResponse('修复登录超时', ['登录', '性能']));
  }) as typeof fetch;

  try {
    const naming = await beautifySession(
      { prompt: '修复登录超时', knownTags: ['登录', '构建'] },
      { timeoutMs: 100, retries: 0 },
    );

    assert.deepEqual(naming, { title: '修复登录超时', tags: ['登录', '性能'] });
    // The reuse list rides on the system prompt: in the user turn a Chinese tag library answered
    // an English request in Chinese, title and all.
    const system = body!.messages.find((m) => m.role === 'system')!.content;
    assert.match(system, /The user's existing tags: 登录, 构建\./);
    assert.equal(body!.messages.find((m) => m.role === 'user')!.content, '修复登录超时');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('beautifySession omits the reuse list when the owner has no tags yet', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let body: { messages: { role: string; content: string }[] } | undefined;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = ((_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return Promise.resolve(namingResponse('Fix login timeout'));
  }) as typeof fetch;

  try {
    const naming = await beautifySession({ prompt: 'Fix login timeout' }, { timeoutMs: 100, retries: 0 });

    assert.deepEqual(naming, { title: 'Fix login timeout', tags: [] });
    assert.equal(body!.messages.find((m) => m.role === 'user')!.content, 'Fix login timeout');
    assert.doesNotMatch(body!.messages.find((m) => m.role === 'system')!.content, /existing tags/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('beautifySession has a hard timeout and actively aborts fetch', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let signal: AbortSignal | undefined;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = ((_input, init) => {
    signal = init?.signal as AbortSignal | undefined;
    // Deliberately ignore abort and never settle: Promise.race must still release the caller.
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;

  try {
    const startedAt = Date.now();
    const naming = await beautifySession(
      { prompt: 'Fix a stuck request' },
      { timeoutMs: 20, retries: 0 },
    );

    assert.deepEqual(naming, { tags: [] });
    assert.ok(signal);
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - startedAt < 2_000, 'hard timeout should not wait for the hung fetch');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('beautifySession hard timeout also bounds response body parsing', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let signal: AbortSignal | undefined;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = ((_input, init) => {
    signal = init?.signal as AbortSignal | undefined;
    return Promise.resolve({
      ok: true,
      json: () => new Promise<never>(() => undefined),
    } as unknown as Response);
  }) as typeof fetch;

  try {
    const naming = await beautifySession(
      { prompt: 'Response body never completes' },
      { timeoutMs: 20, retries: 0 },
    );

    assert.deepEqual(naming, { tags: [] });
    assert.ok(signal);
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('beautifySession cancels an unused provider error body', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let cancelled = 0;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: false,
      body: {
        cancel: async () => {
          cancelled += 1;
        },
      },
    } as unknown as Response)) as typeof fetch;

  try {
    const naming = await beautifySession(
      { prompt: 'Provider rejects this request' },
      { timeoutMs: 100, retries: 0 },
    );
    assert.deepEqual(naming, { tags: [] });
    assert.equal(cancelled, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('queued title beautification bounds concurrent DeepSeek calls', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const responders: Array<(response: Response) => void> = [];
  let started = 0;
  let active = 0;
  let maxActive = 0;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (() => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<Response>((resolve) => {
      responders.push((response) => {
        active -= 1;
        resolve(response);
      });
    });
  }) as typeof fetch;

  const total = TITLE_BEAUTIFY_CONCURRENCY + 2;
  const jobs = Array.from({ length: total }, (_, index) =>
    enqueueBeautifySession(
      { prompt: `Prompt ${index}` },
      { timeoutMs: 5_000, retries: 0 },
    ),
  );

  try {
    await waitUntil(
      () => started === TITLE_BEAUTIFY_CONCURRENCY,
      'initial naming workers did not start',
    );
    assert.equal(maxActive, TITLE_BEAUTIFY_CONCURRENCY);

    for (let index = 0; index < TITLE_BEAUTIFY_CONCURRENCY; index++) {
      responders.shift()!(namingResponse(`Title ${index}`));
    }
    await waitUntil(() => started === total, 'queued naming workers did not drain');
    while (responders.length > 0) responders.shift()!(namingResponse('Later title'));

    const named = await Promise.all(jobs);
    assert.equal(named.length, total);
    assert.equal(maxActive, TITLE_BEAUTIFY_CONCURRENCY);
  } finally {
    let settled = false;
    const settlement = Promise.allSettled(jobs).then(() => {
      settled = true;
    });
    while (!settled) {
      while (responders.length > 0) responders.shift()!(namingResponse('Cleanup title'));
      await flush();
    }
    await settlement;
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('with no DeepSeek key and no key of its own, nothing is asked', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let calls = 0;
  delete process.env.DEEPSEEK_API_KEY;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(namingResponse('never'));
  }) as typeof fetch;

  try {
    assert.deepEqual(await beautifySession({ prompt: 'Fix login timeout' }, { timeoutMs: 100, retries: 0 }), { tags: [] });
    assert.deepEqual(await enqueueBeautifySession({ prompt: 'Fix login timeout' }, { timeoutMs: 100, retries: 0 }), {
      tags: [],
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test("a session's own key is asked in its dialect, and the answer is read out of whatever surrounds it", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const cases: Array<{
    key: HeldKey;
    url: string;
    reply: unknown;
    check: (headers: Record<string, string>, body: Record<string, unknown>) => void;
    naming: { title: string; tags: string[] };
  }> = [
    {
      key: { dialect: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic/', apiKey: 'sk-ds', model: 'deepseek-v4-pro' },
      url: 'https://api.deepseek.com/anthropic/v1/messages',
      // A thinking model's thoughts are a block of their own, and may well contain braces.
      reply: {
        content: [
          { type: 'thinking', thinking: 'maybe {"title":"no"}' },
          { type: 'text', text: '{"title":"登录超时","tags":["登录"]}' },
        ],
      },
      check: (headers, body) => {
        assert.equal(headers.Authorization, 'Bearer sk-ds');
        assert.equal(headers['anthropic-version'], '2023-06-01');
        assert.equal(body.model, 'deepseek-v4-pro');
        assert.match(String(body.system), /The user's existing tags: 登录\./);
        assert.deepEqual(body.messages, [{ role: 'user', content: '修复登录超时' }]);
      },
      naming: { title: '登录超时', tags: ['登录'] },
    },
    {
      key: { dialect: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-oa', model: 'gpt-5.5-codex' },
      url: 'https://api.openai.com/v1/responses',
      reply: {
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: '```json\n{"title":"Login timeout","tags":["auth"]}\n```' }] },
        ],
      },
      check: (headers, body) => {
        assert.equal(headers.Authorization, 'Bearer sk-oa');
        assert.equal(body.model, 'gpt-5.5-codex');
        assert.match(String(body.instructions), /JSON object/);
        assert.equal(body.input, '修复登录超时');
      },
      naming: { title: 'Login timeout', tags: ['auth'] },
    },
    {
      key: { dialect: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'sk-moon', model: 'kimi-k2.6' },
      url: 'https://api.moonshot.ai/v1/chat/completions',
      reply: { choices: [{ message: { content: 'Sure: {"title":"Login\\n timeout","tags":[]}' } }] },
      check: (headers, body) => {
        assert.equal(headers.Authorization, 'Bearer sk-moon');
        assert.equal((body.messages as { role: string }[]).map((m) => m.role).join(','), 'system,user');
      },
      // A title is one line, whatever the model wrote.
      naming: { title: 'Login timeout', tags: [] },
    },
    {
      key: {
        dialect: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'AIza-g',
        model: 'gemini-3.1-pro-preview',
      },
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent',
      reply: {
        candidates: [
          { content: { parts: [{ text: 'thinking {', thought: true }, { text: '{"title":"Login timeout","tags":["auth"]}' }] } },
        ],
      },
      check: (headers, body) => {
        assert.equal(headers['x-goog-api-key'], 'AIza-g');
        assert.equal(headers.Authorization, undefined);
        assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '修复登录超时' }] }]);
      },
      naming: { title: 'Login timeout', tags: ['auth'] },
    },
  ];

  try {
    for (const c of cases) {
      let seen: { url: string; init: RequestInit } | undefined;
      globalThis.fetch = ((input, init) => {
        seen = { url: String(input), init: init! };
        return Promise.resolve({ ok: true, json: async () => c.reply } as Response);
      }) as typeof fetch;
      const naming = await beautifySession(
        { prompt: '修复登录超时', knownTags: ['登录'], key: c.key },
        { timeoutMs: 100, retries: 0 },
      );
      assert.deepEqual(naming, c.naming, c.key.dialect);
      assert.equal(seen!.url, c.url);
      // The key's endpoint is wherever its owner typed: no redirect is followed off it.
      assert.equal(seen!.init.redirect, 'manual');
      c.check(seen!.init.headers as Record<string, string>, JSON.parse(String(seen!.init.body)) as Record<string, unknown>);
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});
