import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProvidersService } from './providers.service';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

const svc = () => new ProvidersService({} as never, {} as never, {} as never);

/** Stand in for the endpoint under probe, capturing the request the service builds. */
function stubFetch(reply: { status: number; body?: string }) {
  const seen: { url?: string; init?: RequestInit } = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.body ?? '',
    };
  }) as never;
  return { seen, restore: () => (globalThis.fetch = original) };
}

test('the claude probe identifies as Claude Code, so a subscription OAuth token is served', async () => {
  const { seen, restore } = stubFetch({ status: 200 });
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-oat01-x',
      model: 'claude-opus-4-5-20251101',
      runtime: 'claude',
    });
    assert.equal(r.ok, true);
    // Without this Anthropic turns an sk-ant-oat token away with a 429 whose message is "Error",
    // failing a key that drives sessions perfectly well.
    const body = JSON.parse(String(seen.init?.body)) as { system?: string };
    assert.match(body.system ?? '', /You are Claude Code/);
  } finally {
    restore();
  }
});

test('a codex probe asks the Responses API, the only dialect codex still speaks', async () => {
  const { seen, restore } = stubFetch({ status: 200 });
  try {
    await svc().testConnection({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-5',
      runtime: 'codex',
    });
    // The path the runner's codex will call (wire_api="responses"). Probing /chat/completions here
    // is what let a Chat Completions-only endpoint pass setup and then fail every session.
    assert.equal(seen.url, 'https://api.example.com/v1/responses');
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, { model: 'gpt-5', input: 'ping', max_output_tokens: 16 });
  } finally {
    restore();
  }
});

test('a kimi probe stays a plain chat completion', async () => {
  const { seen, restore } = stubFetch({ status: 200 });
  try {
    await svc().testConnection({
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-x',
      model: 'kimi-k2',
      runtime: 'kimi',
    });
    assert.equal(seen.url, 'https://api.moonshot.ai/v1/chat/completions');
    assert.equal((JSON.parse(String(seen.init?.body)) as { system?: string }).system, undefined);
  } finally {
    restore();
  }
});

test('a codex 404 says the endpoint lacks the Responses API instead of blaming the Base URL', async () => {
  // What Gemini's OpenAI-compatible endpoint answers for /responses.
  const { restore } = stubFetch({
    status: 404,
    body: '[{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}]',
  });
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'AIza-x',
      model: 'gemini-2.5-pro',
      runtime: 'codex',
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.match(r.message, /Responses API/);
    assert.doesNotMatch(r.message, /check the Base URL/);
  } finally {
    restore();
  }
});

test('an antigravity probe asks the Gemini API itself, with the header agy sends', async () => {
  const { seen, restore } = stubFetch({ status: 200 });
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://generativelanguage.googleapis.com/',
      apiKey: 'AIza-x',
      model: 'gemini-3.8-flash',
      runtime: 'antigravity',
    });
    assert.equal(r.ok, true);
    // The method agy streams ({base}/v1beta/models/{model}:streamGenerateContent), asked once.
    assert.equal(
      seen.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    const headers = seen.init?.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], 'AIza-x');
    // No Bearer and no Anthropic headers: Gemini reads neither, and the key belongs in its own.
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['anthropic-version'], undefined);
    assert.deepEqual(JSON.parse(String(seen.init?.body)), {
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1 },
    });
  } finally {
    restore();
  }
});

test("an antigravity probe asks for the API model agy calls, not agy's own name for it", async () => {
  const { seen, restore } = stubFetch({ status: 200 });
  try {
    // agy 1.2.16 runs `gemini-3.1-pro` (at any level) on the API's preview id; the bare name 404s.
    for (const model of ['gemini-3.1-pro', 'gemini-3.1-pro-low']) {
      await svc().testConnection({
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'AIza-x',
        model,
        runtime: 'antigravity',
      });
      assert.equal(
        seen.url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent',
        model,
      );
    }
    // A level-suffixed slug of any other model is its base name.
    await svc().testConnection({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'AIza-x',
      model: 'gemini-3.7-flash-high',
      runtime: 'antigravity',
    });
    assert.equal(
      seen.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent',
    );
  } finally {
    restore();
  }
});

test("a Gemini 404 names the model it is about; a bare one is still the Base URL's", async () => {
  // What the API answers for a model it doesn't serve: Google's own error, saying which.
  const missing = stubFetch({
    status: 404,
    body: '{"error":{"code":404,"message":"models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.","status":"NOT_FOUND"}}',
  });
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'AIza-x',
      model: 'gemini-9',
      runtime: 'antigravity',
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.match(r.message, /^HTTP 404 — models\/gemini-9 is not found/);
  } finally {
    missing.restore();
  }
  // What the host answers for a path it doesn't have, e.g. the old OpenAI-compatible base left in
  // front of /v1beta/models: an empty 404.
  const bare = stubFetch({ status: 404 });
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'AIza-x',
      model: 'gemini-3.8-flash',
      runtime: 'antigravity',
    });
    assert.equal(r.message, 'Endpoint not found — check the Base URL');
  } finally {
    bare.restore();
  }
});

test('an opaque vendor message is qualified with the status it came back on', async () => {
  const { restore } = stubFetch({
    status: 429,
    body: '{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}',
  });
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-oat01-x',
      model: 'claude-opus-4-5-20251101',
      runtime: 'claude',
    });
    assert.deepEqual(r, { ok: false, status: 429, message: 'HTTP 429 — Error' });
  } finally {
    restore();
  }
});

/** Answer each endpoint by its host, recording the URLs asked in order. */
function stubByHost(statusOf: (host: string) => number) {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    const status = statusOf(new URL(url).host);
    return { ok: status >= 200 && status < 300, status, text: async () => '' };
  }) as never;
  return { urls, restore: () => (globalThis.fetch = original) };
}

test('a MiniMax key the international platform refuses is tried on the China one, and named as China\'s', async () => {
  const { urls, restore } = stubByHost((host) => (host === 'api.minimaxi.com' ? 200 : 401));
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://api.minimax.io/anthropic',
      apiKey: 'sk-cn',
      model: 'MiniMax-M2.7',
      runtime: 'claude',
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.deepEqual(urls, ['https://api.minimax.io/anthropic/v1/messages', 'https://api.minimaxi.com/anthropic/v1/messages']);
    assert.deepEqual(r.region, { id: 'cn', label: 'China', baseUrl: 'https://api.minimaxi.com/anthropic' });
    assert.equal(r.message, 'This key is from the China platform (minimaxi.com), not the international platform');
  } finally {
    restore();
  }
});

test('a key both of a vendor\'s platforms refuse is invalid, and says both were tried', async () => {
  const { urls, restore } = stubByHost(() => 401);
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic/',
      apiKey: 'bad',
      model: 'glm-5.2',
      runtime: 'claude',
    });
    assert.equal(r.ok, false);
    assert.equal(r.region, undefined);
    assert.equal(urls[1], 'https://api.z.ai/api/anthropic/v1/messages');
    assert.equal(r.message, 'Invalid API key — refused on both bigmodel.cn and z.ai');
  } finally {
    restore();
  }
});

test('a refused key on a vendor with one platform is just invalid, with no second request', async () => {
  const { urls, restore } = stubByHost(() => 401);
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'bad',
      model: 'deepseek-flash',
      runtime: 'claude',
    });
    assert.equal(r.message, 'Invalid API key');
    assert.equal(urls.length, 1);
  } finally {
    restore();
  }
});

test('a Qwen key from Singapore, tried on Beijing, is named as the international platform\'s', async () => {
  const { urls, restore } = stubByHost((host) => (host === 'dashscope-intl.aliyuncs.com' ? 200 : 401));
  try {
    const r = await svc().testConnection({
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      apiKey: 'sk-intl',
      model: 'qwen3.7-max',
      runtime: 'claude',
    });
    assert.equal(urls[1], 'https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages');
    assert.equal(r.region?.id, 'global');
    assert.equal(r.message, 'This key is from the international platform (alibabacloud.com), not the China platform');
  } finally {
    restore();
  }
});
