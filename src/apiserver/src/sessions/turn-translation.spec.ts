import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { TRANSLATION_TIMEOUT_MS } from '@orbit/shared';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { SessionsService } from './sessions.service';
import { protectVerbatim, restoreVerbatim, translate, TranslationFailed, translationAvailable } from './translation';
import { ownerTranslationLanguage } from './turn-translation';

/**
 * Settings › Translation, the owner's messages (task A1, @orbit/shared translation.ts): with a stubbed
 * DeepSeek, a translated message is delivered in English with the owner's words kept; a failure or the
 * 20 s timeout holds it undelivered; Retry and Send as written release it; translation off, or no
 * server key, leaves a send exactly as it was.
 *
 * "Delivered" here is the turn the runner's inbox hands out: status PENDING (HELD is never leased — the
 * inbox and the claim read PENDING / IN_FLIGHT only, which turn-translation.pg.spec.ts proves on a real
 * database), its `content` what the engine receives, and the session moved and woken as a send wakes it.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ORIGINAL = '登录页在 Safari 上点 Google 登录没反应，帮我查一下 `signInWithPopup` 在 src/web/src/pages/LoginPage.tsx';
const ENGLISH = 'The Google sign-in on the login page does nothing in Safari; check ⟦0⟧ in src/web/src/pages/LoginPage.tsx';
const ENGLISH_RESTORED = 'The Google sign-in on the login page does nothing in Safari; check `signInWithPopup` in src/web/src/pages/LoginPage.tsx';

type Row = Record<string, unknown>;

/** A where clause as Prisma reads the ones this path writes: equality, `in`, `not`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'sessionId_clientTurnId') {
      const pair = want as { sessionId: string; clientTurnId: string };
      return row.sessionId === pair.sessionId && row.clientTurnId === pair.clientTurnId;
    }
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      const op = want as { in?: unknown[]; not?: unknown; lt?: number };
      if ('in' in op) return op.in!.includes(row[key]);
      if ('not' in op) return row[key] !== op.not;
      if ('lt' in op) return (row[key] as number) < op.lt!;
      return true;
    }
    return row[key] === want;
  });
}

function harness(opts: { status?: RunStatus; preferences?: Row } = {}) {
  const session: Row = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    status: opts.status ?? RunStatus.AWAITING_INPUT,
    deletedAt: null,
    cancelRequestedAt: null,
    prompt: 'opening prompt',
    numTurns: 1,
    assignedRunnerId: null,
    mergeStatus: null,
    commitStatus: null,
  };
  const preferences = opts.preferences ?? { translationEnabled: true, translationLanguage: 'zh-Hans' };
  const turns: Row[] = [];
  const sessionWrites: Row[] = [];
  const wakes = { queue: 0, inbox: 0, turnsChanged: 0 };
  const conversationTurn = {
    findUnique: async ({ where }: { where: Row }) => turns.find((t) => matches(t, where)) ?? null,
    findFirst: async ({ where, orderBy }: { where: Row; orderBy?: { seq: 'desc' } }) => {
      const found = turns.filter((t) => matches(t, where));
      if (orderBy) found.sort((a, b) => (b.seq as number) - (a.seq as number));
      return found[0] ?? null;
    },
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `00000000-0000-4000-8000-00000000000${turns.length + 1}`,
        sendIntent: null, targetTurnId: null, requestFingerprint: null, wikiContext: null,
        displayPrompt: null, translationState: null, translationLang: null,
        createdAt: new Date(), attachments: [],
        ...data,
      };
      turns.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = turns.find((t) => matches(t, where))!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = turns.filter((t) => matches(t, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const gone = turns.filter((t) => matches(t, where));
      gone.forEach((row) => turns.splice(turns.indexOf(row), 1));
      return { count: gone.length };
    },
    count: async ({ where }: { where: Row }) => turns.filter((t) => matches(t, where)).length,
  };
  const tx = {
    // The session lock answers with the session; nothing on this path is a live engine turn.
    $queryRaw: async (...args: unknown[]) =>
      renderRawQuery(args).text.includes('conversation_turn') ? [] : [{ id: SESSION_ID }],
    $executeRaw: async () => 1,
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async ({ data }: { data: Row }) => {
        sessionWrites.push(data);
        Object.assign(session, data);
        return { ...session };
      },
    },
    conversationTurn,
    attachment: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    user: { findUnique: async () => ({ preferences }) },
  };
  const prisma = {
    ...tx,
    session: { ...tx.session, findFirst: async () => ({ ...session }) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const queue = { notifySessionQueued: () => wakes.queue++ } as never;
  const realtime = {
    notifyInbox: () => wakes.inbox++,
    publishQueuedTurnsChanged: () => wakes.turnsChanged++,
  } as never;
  const service = new SessionsService(prisma, queue, realtime);
  const send = (content = ORIGINAL, clientTurnId = 'client-1') =>
    service.createTurn(OWNER_ID, SESSION_ID, { clientTurnId, content, intent: 'NEXT_TURN' }, { translate: true });
  return { service, session, turns, sessionWrites, wakes, send };
}

/** DeepSeek, stubbed: each call answers with the next of `replies` (a reply, an HTTP status, or 'hang'). */
function stubDeepSeek(replies: Array<string | number | 'hang'>) {
  const bodies: Array<{ messages: Array<{ role: string; content: string }>; temperature: number }> = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    bodies.push(JSON.parse(String(init?.body)));
    const reply = replies.shift();
    if (reply === 'hang' || reply === undefined) return new Promise<Response>(() => undefined);
    if (typeof reply === 'number') return Promise.resolve({ ok: false, status: reply, body: null } as Response);
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }),
    } as Response);
  }) as typeof fetch;
  return bodies;
}

const originalFetch = globalThis.fetch;
const originalKey = process.env.DEEPSEEK_API_KEY;
const originalBase = process.env.DEEPSEEK_BASE_URL;
beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  delete process.env.DEEPSEEK_BASE_URL;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = originalBase;
  mock.timers.reset();
});

// ── the translator ─────────────────────────────────────────────────────────────────────────────

test('code blocks, inline code and URLs never reach the model, and come back byte for byte', () => {
  const text = '看这段：\n```ts\n// 注释\nconst a = `x`;\n```\n再看 `foo()` 和 https://example.com/a?b=1 。';
  const { masked, spans } = protectVerbatim(text);
  assert.deepEqual(spans, ['```ts\n// 注释\nconst a = `x`;\n```', '`foo()`', 'https://example.com/a?b=1']);
  assert.equal(masked, '看这段：\n⟦0⟧\n再看 ⟦1⟧ 和 ⟦2⟧ 。');
  assert.equal(restoreVerbatim('Look:\n⟦0⟧\nand ⟦1⟧ and ⟦2⟧.', spans),
    'Look:\n```ts\n// 注释\nconst a = `x`;\n```\nand `foo()` and https://example.com/a?b=1.');
  // A reply that lost or doubled a span is a failure, never a best effort.
  assert.throws(() => restoreVerbatim('Look: ⟦0⟧ ⟦1⟧', spans), TranslationFailed);
  assert.throws(() => restoreVerbatim('⟦0⟧ ⟦0⟧ ⟦1⟧ ⟦2⟧', spans), TranslationFailed);
});

test('translate asks DeepSeek in plain prose, says what to keep, and restores the code', async () => {
  const bodies = stubDeepSeek([ENGLISH]);
  assert.equal(await translate(ORIGINAL, 'zh-Hans', 'en'), ENGLISH_RESTORED);
  const [body] = bodies;
  assert.equal(body.temperature, 0);
  assert.equal((body as unknown as { response_format?: unknown }).response_format, undefined);
  const system = body.messages.find((m) => m.role === 'system')!.content;
  assert.match(system, /from Chinese \(Simplified\) into English/);
  assert.match(system, /file paths/);
  assert.match(system, /markdown structure/);
  // The inline code went to the model as a placeholder.
  assert.equal(body.messages.find((m) => m.role === 'user')!.content.includes('signInWithPopup'), false);
});

test('translate fails on the 20 s timeout, on an error answer, and without a key', async () => {
  assert.equal(TRANSLATION_TIMEOUT_MS, 20_000);
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek(['hang']);
  const pending = translate(ORIGINAL, 'zh-Hans', 'en');
  mock.timers.tick(TRANSLATION_TIMEOUT_MS - 1);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'still waiting one millisecond before 20 s');
  mock.timers.tick(1);
  await assert.rejects(pending, (e: unknown) => e instanceof TranslationFailed && e.reason === 'TIMEOUT');
  mock.timers.reset();

  stubDeepSeek([503]);
  await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), (e: unknown) => e instanceof TranslationFailed && e.reason === 'HTTP');

  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(translationAvailable(), false);
  await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), (e: unknown) => e instanceof TranslationFailed && e.reason === 'NO_KEY');
});

test('the owner preference: absent is off, a language defaults to zh-Hans, and no key means none', async () => {
  const db = (preferences: unknown) => ({ user: { findUnique: async () => ({ preferences }) } });
  assert.equal(await ownerTranslationLanguage(db({}), OWNER_ID), null);
  assert.equal(await ownerTranslationLanguage(db({ translationEnabled: false, translationLanguage: 'ja' }), OWNER_ID), null);
  assert.equal(await ownerTranslationLanguage(db({ translationEnabled: true }), OWNER_ID), 'zh-Hans');
  assert.equal(await ownerTranslationLanguage(db({ translationEnabled: true, translationLanguage: 'ja' }), OWNER_ID), 'ja');
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(await ownerTranslationLanguage(db({ translationEnabled: true, translationLanguage: 'ja' }), OWNER_ID), null);
});

// ── the owner's message ────────────────────────────────────────────────────────────────────────

test('translated: the engine is handed the English, the owner\'s words are kept, and the session wakes', async () => {
  stubDeepSeek([ENGLISH]);
  const h = harness();
  const answer = await h.send();
  // The send answers at once, held: nothing is deliverable and nothing was woken yet.
  assert.deepEqual(answer.translation, { state: 'TRANSLATING', from: 'zh-Hans', original: ORIGINAL });
  assert.equal(answer.placement, 'queued');
  assert.equal(h.turns[0].status, 'HELD');
  assert.equal(h.session.status, RunStatus.AWAITING_INPUT);
  assert.deepEqual({ queue: h.wakes.queue, inbox: h.wakes.inbox }, { queue: 0, inbox: 0 });
  assert.equal(h.sessionWrites[0].lastUserText, ORIGINAL, 'the row previews the owner\'s own words');

  await h.service.translationsSettled();
  const [turn] = h.turns;
  assert.equal(turn.status, 'PENDING');
  assert.equal(turn.content, ENGLISH_RESTORED, 'what the runner receives');
  assert.equal(turn.displayPrompt, ORIGINAL, 'what the owner wrote');
  assert.equal(turn.translationState, 'DONE');
  assert.equal(turn.kind, 'message');
  assert.equal(h.session.status, RunStatus.PENDING);
  assert.equal(h.wakes.queue, 1);
  assert.ok(h.wakes.turnsChanged >= 2, 'clients are told when it was held and when it was released');
});

test('a message sent while a turn runs is released into the queue behind it, and the inbox is told', async () => {
  stubDeepSeek([ENGLISH]);
  const h = harness({ status: RunStatus.RUNNING });
  await h.send();
  await h.service.translationsSettled();
  assert.equal(h.turns[0].status, 'PENDING');
  assert.equal(h.session.status, RunStatus.RUNNING);
  assert.deepEqual({ queue: h.wakes.queue, inbox: h.wakes.inbox }, { queue: 0, inbox: 1 });
});

test('a failed translation holds the message and delivers nothing (1A)', async () => {
  stubDeepSeek([500]);
  const h = harness();
  await h.send();
  await h.service.translationsSettled();
  const [turn] = h.turns;
  assert.equal(turn.status, 'HELD', 'never leased: the inbox reads PENDING only');
  assert.equal(turn.translationState, 'FAILED');
  assert.equal(turn.content, ORIGINAL);
  assert.equal(h.session.status, RunStatus.AWAITING_INPUT);
  assert.deepEqual({ queue: h.wakes.queue, inbox: h.wakes.inbox }, { queue: 0, inbox: 0 });
  assert.ok(h.wakes.turnsChanged >= 2, 'clients are told it failed');
});

test('a translation past 20 s counts as failed, and the message is not delivered', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek(['hang']);
  const h = harness();
  await h.send();
  // Let the queued job reach fetch, then pass the 20 s.
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(TRANSLATION_TIMEOUT_MS);
  await h.service.translationsSettled();
  assert.equal(h.turns[0].status, 'HELD');
  assert.equal(h.turns[0].translationState, 'FAILED');
  assert.equal(h.wakes.queue + h.wakes.inbox, 0);
});

test('Retry translates a failed message again and delivers it', async () => {
  stubDeepSeek([500, ENGLISH]);
  const h = harness();
  const { turnId } = await h.send();
  await h.service.translationsSettled();
  assert.equal(h.turns[0].translationState, 'FAILED');

  const retried = await h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId);
  assert.deepEqual(retried, { turnId, translation: { state: 'TRANSLATING', from: 'zh-Hans', original: ORIGINAL } });
  await h.service.translationsSettled();
  assert.equal(h.turns[0].status, 'PENDING');
  assert.equal(h.turns[0].content, ENGLISH_RESTORED);
  assert.equal(h.turns[0].translationState, 'DONE');
  assert.equal(h.wakes.queue, 1);
  // A delivered message has nothing left to retry.
  await assert.rejects(h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId), /not waiting on a translation/);
});

test('Send as written delivers the original, untranslated', async () => {
  stubDeepSeek([500]);
  const h = harness();
  const { turnId } = await h.send();
  await h.service.translationsSettled();

  const sent = await h.service.sendTurnAsWritten(OWNER_ID, SESSION_ID, turnId);
  assert.deepEqual(sent, { turnId, translation: { state: 'SENT_AS_WRITTEN', from: 'zh-Hans', original: ORIGINAL } });
  assert.equal(h.turns[0].status, 'PENDING');
  assert.equal(h.turns[0].content, ORIGINAL);
  assert.equal(h.session.status, RunStatus.PENDING);
  assert.equal(h.wakes.queue, 1);
  await assert.rejects(h.service.sendTurnAsWritten(OWNER_ID, SESSION_ID, turnId), /not waiting on a translation/);
});

test('a resent clientTurnId replays the held message instead of refusing its original words', async () => {
  stubDeepSeek([ENGLISH]);
  const h = harness();
  const first = await h.send();
  await h.service.translationsSettled();
  const again = await h.send();
  assert.equal(again.turnId, first.turnId);
  assert.equal(h.turns.length, 1);
});

test('translation off: the message goes as written, exactly as before, and DeepSeek is not asked', async () => {
  const bodies = stubDeepSeek([ENGLISH]);
  const h = harness({ preferences: {} });
  const answer = await h.send();
  assert.equal(answer.translation, undefined);
  assert.equal(h.turns[0].status, 'PENDING');
  assert.equal(h.turns[0].content, ORIGINAL);
  assert.equal(h.turns[0].displayPrompt, null);
  assert.equal(h.turns[0].translationState, null);
  assert.equal(h.session.status, RunStatus.PENDING);
  assert.equal(h.wakes.queue, 1);
  await h.service.translationsSettled();
  assert.equal(bodies.length, 0);
});

test('no server key: nothing is translated whatever the owner chose', async () => {
  const bodies = stubDeepSeek([ENGLISH]);
  delete process.env.DEEPSEEK_API_KEY;
  const h = harness({ preferences: { translationEnabled: true, translationLanguage: 'ja' } });
  const answer = await h.send();
  assert.equal(answer.translation, undefined);
  assert.equal(h.turns[0].status, 'PENDING');
  assert.equal(h.turns[0].content, ORIGINAL);
  await h.service.translationsSettled();
  assert.equal(bodies.length, 0);
});

test('a platform delivery is never translated, even with the owner\'s switch on', async () => {
  const bodies = stubDeepSeek([ENGLISH]);
  const h = harness();
  await h.service.createTurn(OWNER_ID, SESSION_ID, { clientTurnId: 'platform-1', content: ORIGINAL, intent: 'NEXT_TURN' });
  assert.equal(h.turns[0].status, 'PENDING');
  assert.equal(h.turns[0].translationState, null);
  assert.equal(bodies.length, 0);
});
