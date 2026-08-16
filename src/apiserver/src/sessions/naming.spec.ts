import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beautifySession,
  enqueueBeautifySession,
  sanitizeTags,
  TITLE_BEAUTIFY_CONCURRENCY,
} from './naming';

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
