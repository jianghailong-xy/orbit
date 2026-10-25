import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  enqueueTurnSuggestion,
  generateTurnSuggestion,
  MAX_TURN_SUGGESTION_CHARS,
  sanitizeTurnSuggestion,
} from './turn-suggestion';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function suggestionResponse(content: unknown): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

test('the guess is one clean line, unquoted, and capped', () => {
  assert.equal(sanitizeTurnSuggestion('  run the tests  '), 'run the tests');
  assert.equal(sanitizeTurnSuggestion('run the tests\nand then commit'), 'run the tests');
  // A model that wraps its answer means the words without the wrapping.
  assert.equal(sanitizeTurnSuggestion('"run the tests"'), 'run the tests');
  assert.equal(sanitizeTurnSuggestion('`deploy it`'), 'deploy it');
  assert.equal(sanitizeTurnSuggestion('  '), undefined);
  assert.equal(sanitizeTurnSuggestion('""'), undefined);
  assert.equal(sanitizeTurnSuggestion('x'.repeat(MAX_TURN_SUGGESTION_CHARS + 1)), undefined);
  // Anything but a string is no suggestion, never an error.
  assert.equal(sanitizeTurnSuggestion(undefined), undefined);
  assert.equal(sanitizeTurnSuggestion(42), undefined);
});

test('the model sees just this turn, and the answer comes back sanitized', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let body: { messages: { role: string; content: string }[]; response_format?: unknown } | undefined;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = ((_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return Promise.resolve(suggestionResponse('跑一遍测试\n再提交'));
  }) as typeof fetch;

  try {
    const suggestion = await generateTurnSuggestion(
      { userText: '把登录修好', assistantText: '修好了，改动在 auth.ts' },
      { timeoutMs: 100 },
    );

    // One line, in the person's language.
    assert.equal(suggestion, '跑一遍测试');
    const user = body!.messages.find((m) => m.role === 'user')!.content;
    assert.equal(user, "The user's message:\n把登录修好\n\nThe agent's reply:\n修好了，改动在 auth.ts");
    // Plain prose, not naming's JSON object.
    assert.equal(body!.response_format, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a turn that answered with no words is predicted from the message alone', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let body: { messages: { role: string; content: string }[] } | undefined;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = ((_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return Promise.resolve(suggestionResponse('looks good'));
  }) as typeof fetch;

  try {
    const suggestion = await generateTurnSuggestion({ userText: 'ship it' }, { timeoutMs: 100 });
    assert.equal(suggestion, 'looks good');
    assert.equal(body!.messages.find((m) => m.role === 'user')!.content, "The user's message:\nship it");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('every failure is no suggestion, never an error', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;

  try {
    // No key: nothing is asked.
    delete process.env.DEEPSEEK_API_KEY;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(suggestionResponse('never'));
    }) as typeof fetch;
    assert.equal(await generateTurnSuggestion({ userText: 'x' }, { timeoutMs: 100 }), undefined);
    assert.equal(await enqueueTurnSuggestion({ userText: 'x' }), undefined);
    assert.equal(calls, 0);

    process.env.DEEPSEEK_API_KEY = 'test-key';
    // A rejected request.
    globalThis.fetch = (() =>
      Promise.resolve({ ok: false, body: { cancel: async () => undefined } } as unknown as Response)) as typeof fetch;
    assert.equal(await generateTurnSuggestion({ userText: 'x' }, { timeoutMs: 100 }), undefined);
    // A thrown fetch.
    globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;
    assert.equal(await generateTurnSuggestion({ userText: 'x' }, { timeoutMs: 100 }), undefined);
    // A body without the expected shape.
    globalThis.fetch = (() => Promise.resolve({ ok: true, json: async () => ({}) } as unknown as Response)) as typeof fetch;
    assert.equal(await generateTurnSuggestion({ userText: 'x' }, { timeoutMs: 100 }), undefined);
    // The model staying silent is the design's "not obvious" answer.
    globalThis.fetch = (() => Promise.resolve(suggestionResponse(''))) as typeof fetch;
    assert.equal(await generateTurnSuggestion({ userText: 'x' }, { timeoutMs: 100 }), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a hung model call is released by the hard timeout', async () => {
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
    const suggestion = await generateTurnSuggestion({ userText: 'x' }, { timeoutMs: 20 });
    assert.equal(suggestion, undefined);
    assert.ok(signal);
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - startedAt < 2_000, 'hard timeout should not wait for the hung fetch');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('the queue caps the turn text it retains and the calls in flight', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const bodies: string[] = [];
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = ((_input, init) => {
    bodies.push(String(init?.body));
    return Promise.resolve(suggestionResponse('next'));
  }) as typeof fetch;

  try {
    const suggestion = await enqueueTurnSuggestion({
      userText: 'u'.repeat(900),
      assistantText: 'a'.repeat(3000),
    });
    assert.equal(suggestion, 'next');
    const user = (JSON.parse(bodies[0]) as { messages: { content: string }[] }).messages[1].content;
    assert.ok(user.includes('u'.repeat(600)));
    assert.ok(!user.includes('u'.repeat(601)), 'the message is capped at 600');
    assert.ok(user.includes('a'.repeat(2000)));
    assert.ok(!user.includes('a'.repeat(2001)), 'the reply is capped at 2000');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});
