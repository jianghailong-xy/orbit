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
