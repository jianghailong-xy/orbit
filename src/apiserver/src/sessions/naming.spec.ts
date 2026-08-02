import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beautifyTitle,
  enqueueBeautifyTitle,
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

function namingResponse(title: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ title }) } }] }),
  } as Response;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('beautifyTitle has a hard timeout and actively aborts fetch', async () => {
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
    const title = await beautifyTitle(
      { prompt: 'Fix a stuck request' },
      { timeoutMs: 20, retries: 0 },
    );

    assert.equal(title, undefined);
    assert.ok(signal);
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - startedAt < 2_000, 'hard timeout should not wait for the hung fetch');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('beautifyTitle hard timeout also bounds response body parsing', async () => {
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
    const title = await beautifyTitle(
      { prompt: 'Response body never completes' },
      { timeoutMs: 20, retries: 0 },
    );

    assert.equal(title, undefined);
    assert.ok(signal);
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('beautifyTitle cancels an unused provider error body', async () => {
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
    const title = await beautifyTitle(
      { prompt: 'Provider rejects this request' },
      { timeoutMs: 100, retries: 0 },
    );
    assert.equal(title, undefined);
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
    enqueueBeautifyTitle(
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

    const titles = await Promise.all(jobs);
    assert.equal(titles.length, total);
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
