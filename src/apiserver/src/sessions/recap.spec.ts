import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { encryptSecret } from '../providers/provider-crypto';
import {
  buildRecapTask,
  enqueueRecap,
  estimateTokens,
  fitRecapActivity,
  generateRecap,
  parseRecap,
  recapDue,
  recapEnabled,
  recapSkipReason,
  RECAP_CONCURRENCY,
  RECAP_EVENT_CHARS,
  RECAP_INPUT_TOKEN_BUDGET,
  RECAP_MAX_CHARS,
  sanitizeRecap,
} from './recap';

// The held key's row is decrypted on the way out.
process.env.PROVIDER_SECRET_KEY ??= 'recap-spec';

const NOW = new Date('2026-10-10T12:00:00Z');
const RECAP_TYPES: readonly string[] = [RunEventType.USER, RunEventType.ASSISTANT, RunEventType.TOOL_USE];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A one-line event, the shape the recap pass renders. */
function event(seq: number, text: string, type: string = RunEventType.ASSISTANT) {
  return { seq, type, payload: { text } };
}

/** `count` events, seq 1..count, each long enough to exercise the per-event clip. */
function events(count: number, chars = 40) {
  return Array.from({ length: count }, (_, i) => event(i + 1, `step-${i + 1} ${'x'.repeat(chars)}`));
}

interface StoredSession {
  recapText: string | null;
  recapAt: Date | null;
  recapEventSeq: number | null;
  provider: string;
  providerBuiltin: boolean;
  ownerId: string;
  model: string | null;
}

interface FakeDbInit {
  session?: Partial<StoredSession>;
  events?: Array<{ seq: number; type: string; payload: unknown }>;
  providerRow?: unknown;
}

/**
 * The two tables a recap pass touches, with the CAS the write is: `updateMany` updates only a row
 * still at the cursor the pass read, exactly as the `where` Prisma builds would.
 */
function fakeDb(init: FakeDbInit = {}) {
  const stored: StoredSession = {
    recapText: null,
    recapAt: null,
    recapEventSeq: null,
    provider: 'claude',
    providerBuiltin: true,
    ownerId: 'owner-1',
    model: null,
    ...init.session,
  };
  const rows = init.events ?? [];
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const db = {
    session: {
      findFirst: async ({ select }: { select: Record<string, boolean> }) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(select)) out[key] = (stored as unknown as Record<string, unknown>)[key];
        return out;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push({ where, data });
        // Prisma's own reading of the clause: a cursor the write did not name is no filter at all,
        // and a named one matches only a row still at it (null matching null).
        if (where.recapEventSeq !== undefined && stored.recapEventSeq !== where.recapEventSeq) return { count: 0 };
        Object.assign(stored, data);
        return { count: 1 };
      },
    },
    runEvent: {
      count: async () => rows.filter((row) => RECAP_TYPES.includes(row.type)).length,
      findMany: async ({ where, take }: { where: { seq: { gt: number } }; take: number }) => {
        return rows
          .filter((row) => row.seq > where.seq.gt && RECAP_TYPES.includes(row.type))
          .sort((a, b) => b.seq - a.seq)
          .slice(0, take)
          .map((row) => ({ seq: row.seq, type: row.type, payload: row.payload }));
      },
    },
    modelProvider: { findFirst: async () => init.providerRow ?? null },
    user: { findUnique: async () => ({ role: 'USER' }) },
  };
  return { db: db as never, stored, writes };
}

/** An Anthropic endpoint row whose key a pass may spend, with the model a session runs it on. */
const ANTHROPIC_ROW = {
  runtime: 'claude',
  baseUrl: 'https://api.anthropic.com',
  apiKeyEnc: encryptSecret('sk-ant-api03-recap-spec'),
  enabled: true,
  presetSlug: null,
  followsPreset: false,
  models: [],
  defaultModel: 'claude-opus-5',
};

function textResponse(content: string): Response {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
}

test('the token estimate is pessimistic on wide scripts and caps the activity at the budget', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'.repeat(4)), 1);
  assert.equal(estimateTokens('中'.repeat(4)), 4);

  const budget = 1_000;
  const activity = fitRecapActivity(events(100, RECAP_EVENT_CHARS), budget);
  // The newest events are what a settled session's recap is about; the oldest fall out first.
  assert.ok(estimateTokens(activity.text) <= budget, 'the activity must stay inside the budget');
  assert.equal(activity.lastSeq, 100);
  assert.match(activity.text, /^ASSISTANT: step-/);
  assert.match(activity.text, /step-100 /);
  assert.doesNotMatch(activity.text, /step-90 /);
});

test('an activity with nothing to send covers no seq', () => {
  const activity = fitRecapActivity(
    [
      { seq: 1, type: RunEventType.ASSISTANT, payload: { text: '   ' } },
      { seq: 2, type: RunEventType.TOOL_USE, payload: { input: {} } },
    ],
    8_000,
  );
  assert.deepEqual(activity, { text: '', lastSeq: null });
});

test('a stored recap is one capped line, and a wrapped or fenced answer is still read', () => {
  assert.equal(sanitizeRecap('  fixed   the bug\nand shipped it  '), 'fixed the bug and shipped it');
  assert.equal(sanitizeRecap(''), undefined);
  assert.equal(sanitizeRecap(42), undefined);
  const long = sanitizeRecap('x'.repeat(200))!;
  assert.equal(long.length, RECAP_MAX_CHARS);
  assert.ok(long.endsWith('…'));

  assert.equal(parseRecap('Fixed the login flow, tests pass.'), 'Fixed the login flow, tests pass.');
  assert.equal(parseRecap('{"recap": "Shipped the migration."}'), 'Shipped the migration.');
  assert.equal(parseRecap('```\nShipped the fix.\n```'), 'Shipped the fix.');
  assert.equal(parseRecap('   '), undefined);
});

test('the task carries the previous recap before the new activity', () => {
  assert.equal(
    buildRecapTask('Earlier: parsed the schema.', 'USER: go on\nASSISTANT: done'),
    'Previous recap:\nEarlier: parsed the schema.\n\nNew activity:\nUSER: go on\nASSISTANT: done',
  );
  assert.equal(buildRecapTask(null, 'USER: go on'), 'New activity:\nUSER: go on');
});

test('the throttle window skips a settle within two minutes of the last recap', () => {
  const fresh = { recapAt: new Date(NOW.getTime() - 60_000) };
  assert.equal(recapSkipReason(fresh, 10, { now: NOW }), 'throttled');
  assert.equal(recapSkipReason(fresh, 10, { now: NOW, finalize: true }), null);
  assert.equal(recapSkipReason({ recapAt: new Date(NOW.getTime() - 121_000) }, 10, { now: NOW }), null);
  assert.equal(recapSkipReason({ recapAt: null }, 10, { now: NOW }), null);
});

test('a session with fewer than four events is never recapped', () => {
  assert.equal(recapSkipReason({ recapAt: null }, 3, { now: NOW }), 'too-few-events');
  assert.equal(recapSkipReason({ recapAt: null }, 4, { now: NOW }), null);
});

test('ORBIT_RECAP_ENABLED=0 turns every path off before anything is read or asked', async () => {
  const original = process.env.ORBIT_RECAP_ENABLED;
  process.env.ORBIT_RECAP_ENABLED = '0';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(textResponse('never asked'));
  }) as typeof fetch;
  try {
    assert.equal(recapEnabled(), false);
    assert.equal(recapSkipReason({ recapAt: null }, 100, { now: NOW }), 'disabled');

    const { db, writes } = fakeDb({ events: events(10) });
    const outcome = await generateRecap({ db, sessionId: 's1' });
    assert.deepEqual(outcome, { written: false, reason: 'disabled' });
    assert.equal(await recapDue({ db, sessionId: 's1' }), false);
    assert.deepEqual(await enqueueRecap({ db, sessionId: 's1' }), { written: false, reason: 'disabled' });
    assert.equal(calls, 0);
    assert.equal(writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ORBIT_RECAP_ENABLED', original);
  }
});

test('a settle inside the throttle window writes nothing and asks nobody', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(textResponse('should never be asked'));
  }) as typeof fetch;
  try {
    const { db, writes } = fakeDb({
      session: { recapAt: new Date(NOW.getTime() - 30_000) },
      events: events(10),
    });
    assert.deepEqual(await generateRecap({ db, sessionId: 's1' }, { now: NOW }), {
      written: false,
      reason: 'throttled',
    });
    assert.equal(calls, 0);
    assert.equal(writes.length, 0);
    // A finalize is the recap the session keeps: it ignores the window.
    assert.equal(
      (await generateRecap({ db, sessionId: 's1', finalize: true }, { now: NOW })).written,
      true,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a pass assembles the prompt, holds the 8k ceiling and compare-and-sets the cursor', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let body:
    | { model: string; max_tokens: number; response_format?: unknown; messages: { role: string; content: string }[] }
    | undefined;
  globalThis.fetch = ((_input: unknown, init: { body: string }) => {
    body = JSON.parse(init.body) as typeof body;
    return Promise.resolve(textResponse('Fixed the login flow; tests pass. Next: ship it.'));
  }) as typeof fetch;
  try {
    // A long backlog in a wide script: the pass must both clip and fall back to the newest events.
    const backlog = Array.from({ length: 300 }, (_, i) => event(i + 1, `步骤 ${i + 1} ${'改'.repeat(RECAP_EVENT_CHARS)}`));
    const { db, stored, writes } = fakeDb({
      session: { recapText: 'Earlier: parsed the schema.', recapEventSeq: 2, recapAt: null },
      events: backlog,
    });

    const outcome = await generateRecap({ db, sessionId: 's1' }, { now: NOW, retries: 0 });

    assert.deepEqual(outcome, {
      written: true,
      recapText: 'Fixed the login flow; tests pass. Next: ship it.',
      recapEventSeq: 300,
    });
    assert.equal(stored.recapText, 'Fixed the login flow; tests pass. Next: ship it.');
    assert.equal(stored.recapAt, NOW);
    assert.equal(stored.recapEventSeq, 300);
    assert.deepEqual(writes[0].where, { id: 's1', recapEventSeq: 2 });

    const [system, task] = body!.messages;
    assert.equal(body!.model, 'deepseek-chat', 'the server key is spent on the fixed cheap model');
    assert.equal(body!.response_format, undefined, 'the recap is plain text, not a JSON object');
    assert.match(system!.content, /SAME language as the conversation/);
    assert.match(system!.content, new RegExp(`At most ${RECAP_MAX_CHARS} characters`));
    assert.match(task!.content, /^Previous recap:\nEarlier: parsed the schema\.\n\nNew activity:\n/);
    assert.ok(
      estimateTokens(system!.content) + estimateTokens(task!.content) <= RECAP_INPUT_TOKEN_BUDGET,
      'the whole request must stay inside the 8k ceiling',
    );
    assert.match(task!.content, /步骤 300/, 'the newest event is what the recap is about');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('without a server key the pass spends the held key on the dialect-fixed cheap model', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let url: string | undefined;
  let body: { model?: string; messages: { role: string; content: string }[] } | undefined;
  globalThis.fetch = ((input: string, init: { body: string }) => {
    url = input;
    body = JSON.parse(init.body) as typeof body;
    return Promise.resolve({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Shipped the fix.' }] }) } as Response);
  }) as unknown as typeof fetch;
  try {
    const { db, stored } = fakeDb({
      session: {
        provider: 'anthropic',
        providerBuiltin: false,
        model: 'claude-opus-5',
      },
      events: events(8),
      providerRow: ANTHROPIC_ROW,
    });

    const outcome = await generateRecap({ db, sessionId: 's1' }, { now: NOW, retries: 0 });

    assert.equal(outcome.written, true);
    assert.equal(stored.recapText, 'Shipped the fix.');
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    // The session runs an Opus; the recap must not inherit it.
    assert.equal(body!.model, 'claude-haiku-4-5-20251001');
    assert.notEqual(body!.model, 'claude-opus-5');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a provider 4xx is a silent skip: no write, no throw, bounded retries', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let calls = 0;
  let cancelled = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve({
      ok: false,
      body: {
        cancel: async () => {
          cancelled += 1;
        },
      },
    } as unknown as Response);
  }) as typeof fetch;
  try {
    const { db, stored, writes } = fakeDb({ events: events(10) });
    const outcome = await generateRecap({ db, sessionId: 's1' }, { now: NOW, retries: 1, backoffMs: 0 });

    assert.deepEqual(outcome, { written: false, reason: 'llm-failed' });
    assert.equal(calls, 2, 'the attempt is retried, then given up');
    assert.equal(cancelled, 2);
    assert.equal(stored.recapText, null);
    assert.equal(stored.recapEventSeq, null);
    assert.equal(writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a provider that refuses the connection or answers with junk is a silent skip too', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const { db, stored, writes } = fakeDb({ events: events(10) });
  const shapes: Array<() => Promise<Response>> = [
    () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1')),
    () => Promise.resolve({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } } as unknown as Response),
  ];
  try {
    for (const shape of shapes) {
      globalThis.fetch = (() => shape()) as typeof fetch;
      assert.deepEqual(await generateRecap({ db, sessionId: 's1' }, { now: NOW, retries: 0 }), {
        written: false,
        reason: 'llm-failed',
      });
    }
    assert.equal(stored.recapText, null);
    assert.equal(writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a hung provider is bounded by the timeout and writes nothing', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let signal: AbortSignal | undefined;
  globalThis.fetch = ((_input: unknown, init: { signal: AbortSignal }) => {
    signal = init.signal;
    // Deliberately ignore abort and never settle: the explicit race must still release the pass.
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  try {
    const { db, stored, writes } = fakeDb({ events: events(10) });
    const startedAt = Date.now();
    const outcome = await generateRecap({ db, sessionId: 's1' }, { now: NOW, retries: 0, timeoutMs: 20 });

    assert.deepEqual(outcome, { written: false, reason: 'llm-failed' });
    assert.equal(signal?.aborted, true);
    assert.ok(Date.now() - startedAt < 2_000, 'the timeout bounds the pass without waiting on the fetch');
    assert.equal(stored.recapText, null);
    assert.equal(writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a pass that loses the cursor race to another writer concedes without writing', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const { db, stored, writes } = fakeDb({ session: { recapEventSeq: 5 }, events: events(12) });
  globalThis.fetch = (() => {
    // The other pass lands while this one is waiting on the model: the cursor moves on.
    stored.recapEventSeq = 12;
    return Promise.resolve(textResponse('Stale by construction.'));
  }) as typeof fetch;
  try {
    const outcome = await generateRecap({ db, sessionId: 's1' }, { now: NOW, retries: 0 });

    assert.deepEqual(outcome, { written: false, reason: 'cas-lost' });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].where, { id: 's1', recapEventSeq: 5 });
    assert.equal(stored.recapText, null, 'the newer pass keeps its recap');
    assert.equal(stored.recapEventSeq, 12);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('a pass with nothing new to fold in asks nobody', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(textResponse('unreached'));
  }) as typeof fetch;
  try {
    const { db, writes } = fakeDb({ session: { recapEventSeq: 10 }, events: events(10) });
    assert.deepEqual(await generateRecap({ db, sessionId: 's1' }, { now: NOW }), {
      written: false,
      reason: 'no-events',
    });
    assert.equal(calls, 0);
    assert.equal(writes.length, 0);
    assert.equal(await recapDue({ db, sessionId: 's1' }), true, 'the count is still worth a queue slot');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});

test('recapDue reads the session and its event count, and never throws on a broken read', async () => {
  const fresh = fakeDb({ session: { recapAt: new Date(Date.now() - 30_000) }, events: events(10) });
  assert.equal(await recapDue({ db: fresh.db, sessionId: 's1' }), false);
  assert.equal(await recapDue({ db: fresh.db, sessionId: 's1', finalize: true }), true);
  const thin = fakeDb({ events: events(3) });
  assert.equal(await recapDue({ db: thin.db, sessionId: 's1' }), false);

  const broken = { session: { findFirst: async () => { throw new Error('database is down'); } } } as never;
  assert.equal(await recapDue({ db: broken, sessionId: 's1' }), false);
  assert.deepEqual(await generateRecap({ db: broken, sessionId: 's1' }), { written: false, reason: 'error' });
});

test('queued recaps bound how many passes are in flight at once', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const release: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      release.push(() => {
        active -= 1;
        resolve(textResponse('queued recap'));
      });
    })) as typeof fetch;
  try {
    let settled = 0;
    const jobs = Array.from({ length: 5 }, (_, i) => {
      const { db } = fakeDb({ events: events(10) });
      const job = enqueueRecap({ db, sessionId: `s${i}` }, { now: NOW, retries: 0 });
      void job.then(() => {
        settled += 1;
      });
      return job;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(release.length, RECAP_CONCURRENCY, 'only the queue width is in flight');
    // Every answer frees a slot, so the queue keeps starting the jobs still waiting.
    while (settled < jobs.length) {
      await new Promise((resolve) => setImmediate(resolve));
      for (const answer of release.splice(0)) answer();
    }
    const outcomes = await Promise.all(jobs);
    assert.ok(outcomes.every((outcome) => outcome.written));
    assert.equal(maxActive, RECAP_CONCURRENCY);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
});
