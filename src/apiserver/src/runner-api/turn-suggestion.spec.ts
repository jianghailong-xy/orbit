import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { RunnerApiController } from './runner-api.controller';

/**
 * POST /runner/sessions/:id/turns/:turnId/suggestion — the server's guess at the person's next
 * message for an engine without one of its own (docs/prompt-suggestions-design.md §8 P2). Read
 * off the turn's own rows (the person's text from the turn, the agent's from its events), never
 * the transcript; a miss is `{}`, never an error.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '55555555-5555-4555-8555-555555555555';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fixture(rows: {
  assignedRunnerId?: string;
  turn?: { sessionId: string; content: string | null } | null;
  assistantEvents?: Array<{ payload: unknown }>;
}) {
  const prisma = {
    session: {
      findUnique: async () => ({ id: SESSION_ID, assignedRunnerId: rows.assignedRunnerId ?? RUNNER_ID }),
    },
    conversationTurn: {
      findUnique: async () =>
        rows.turn === undefined ? { id: TURN_ID, sessionId: SESSION_ID, content: '把登录修好' } : rows.turn,
    },
    runEvent: {
      findMany: async () => rows.assistantEvents ?? [{ payload: { text: '修好了，改动在 auth.ts' } }],
    },
  };
  const controller = new RunnerApiController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return {
    suggest: (sessionId = SESSION_ID, turnId = TURN_ID, runnerId = RUNNER_ID) =>
      controller.turnSuggestion({ id: runnerId }, sessionId, turnId),
  };
}

function stubFetch(text: string): { calls: () => number; restore: () => void } {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: text } }] }),
    } as Response);
  }) as typeof fetch;
  return { calls: () => calls, restore: () => (globalThis.fetch = originalFetch) };
}

test('a finished turn earns the server-written guess', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fetchStub = stubFetch('跑一遍测试');
  const f = fixture({});
  try {
    assert.deepEqual(await f.suggest(), { suggestion: '跑一遍测试' });
    assert.equal(fetchStub.calls(), 1);
  } finally {
    fetchStub.restore();
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('the agent half is the turn’s last own reply, not a sub-agent’s report', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  let prompt = '';
  globalThis.fetch = ((_input, init) => {
    prompt = String(init?.body);
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'commit it' } }] }),
    } as Response);
  }) as typeof fetch;
  // Highest seq first, as findMany(orderBy seq desc) hands them over: the newest is a
  // sub-agent's report and must be stepped over, and an empty text is not a reply.
  const f = fixture({
    assistantEvents: [
      { payload: { text: 'done', parentToolUseId: 'toolu_1' } },
      { payload: { text: '   ' } },
      { payload: { text: '修好了，改动在 auth.ts' } },
    ],
  });
  try {
    assert.deepEqual(await f.suggest(), { suggestion: 'commit it' });
    assert.match(prompt, /修好了，改动在 auth\.ts/);
    assert.doesNotMatch(prompt, /done/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('no key, no turn, an attachment-only turn, or a model with nothing to say is {} — never an error', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const fetchStub = stubFetch('');
  try {
    // The server holds no DeepSeek key: the claim never asks, but a stale runner may still call.
    delete process.env.DEEPSEEK_API_KEY;
    assert.deepEqual(await fixture({}).suggest(), {});
    assert.equal(fetchStub.calls(), 0);

    process.env.DEEPSEEK_API_KEY = 'test-key';
    // A turn id that does not exist, or belongs to another session.
    assert.deepEqual(await fixture({ turn: null }).suggest(), {});
    assert.deepEqual(await fixture({ turn: { sessionId: 'other', content: 'hi' } }).suggest(), {});
    // Opened with attachments and no words: nothing to predict from.
    assert.deepEqual(await fixture({ turn: { sessionId: SESSION_ID, content: null } }).suggest(), {});
    assert.deepEqual(await fixture({ turn: { sessionId: SESSION_ID, content: '   ' } }).suggest(), {});
    assert.equal(fetchStub.calls(), 0);
    // The model staying silent is the design's "not obvious" answer.
    assert.deepEqual(await fixture({}).suggest(), {});
    assert.equal(fetchStub.calls(), 1);
  } finally {
    fetchStub.restore();
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test("another runner's session is refused before anything is read", async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const fetchStub = stubFetch('never');
  const f = fixture({ assignedRunnerId: '33333333-3333-4333-8333-333333333333' });
  try {
    await assert.rejects(f.suggest(), ForbiddenException);
    assert.equal(fetchStub.calls(), 0);
  } finally {
    fetchStub.restore();
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});
