import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { RunStatus } from '@orbit/shared';
import { TRANSLATION_TIMEOUT_MS } from '@orbit/shared';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { SessionsService } from './sessions.service';
import {
  onTranslationAvailabilityChange,
  protectVerbatim,
  resetTranslationBreaker,
  restoreVerbatim,
  translate,
  TranslationFailed,
  translationAvailable,
  translationUnavailableUntil,
} from './translation';
import { isSlashCommand, translationLanguages, turnTranslationOf } from './turn-translation';
import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { ownerWordsForAgent } from './reply-translation';
import { ConfigService } from '@nestjs/config';
import { RealtimeService } from '../realtime/realtime.service';
import { HELD_MESSAGE_PUSH_BODY, PushService } from '../push/push.service';
import { turnStateOfWord } from './session-turn-state';
import { writtenWord } from '../test-support/session-word';

/**
 * Settings › Translation, the owner's messages (task A1, @orbit/shared translation.ts): with a stubbed
 * DeepSeek, a translated message is delivered in the account's agent language (absent = English) with the
 * owner's words kept; a failure or the 20 s timeout holds it undelivered; Retry and Send as written release
 * it; translation off, no server key, or the owner's language the agent's, leaves a send exactly as it was.
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

function harness(opts: { status?: RunStatus; preferences?: Row; session?: Row; realtime?: (prisma: never) => object } = {}) {
  const session: Row = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    status: opts.status ?? RunStatus.AWAITING_INPUT,
    turnState: turnStateOfWord(opts.status ?? RunStatus.AWAITING_INPUT),
    deletedAt: null,
    cancelRequestedAt: null,
    prompt: 'opening prompt',
    numTurns: 1,
    assignedRunnerId: null,
    mergeStatus: null,
    commitStatus: null,
    ...opts.session,
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
        // The writer writes the facts; the double keeps the word they give (deploy D3).
        session.status = writtenWord(data) ?? session.status;
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
  const realtime = Object.assign(opts.realtime?.(prisma) ?? {}, {
    notifyInbox: () => wakes.inbox++,
    publishQueuedTurnsChanged: () => wakes.turnsChanged++,
  }) as never;
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
  // The breaker is the process's: every test starts with it closed and nothing counted.
  resetTranslationBreaker();
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

  stubDeepSeek([400]);
  await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), (e: unknown) => e instanceof TranslationFailed && e.reason === 'HTTP');

  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(translationAvailable(), false);
  await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), (e: unknown) => e instanceof TranslationFailed && e.reason === 'NO_KEY');
});

test('translate tries a 429/5xx or unreachable translator again, three times in all, and not a 4xx', async () => {
  let bodies = stubDeepSeek([503, 429, ENGLISH]);
  assert.equal(await translate(ORIGINAL, 'zh-Hans', 'en'), ENGLISH_RESTORED);
  assert.equal(bodies.length, 3);

  bodies = stubDeepSeek([500, 502, 503, ENGLISH]);
  await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), (e: unknown) => e instanceof TranslationFailed && e.reason === 'HTTP');
  assert.equal(bodies.length, 3, 'gives up after the third');

  bodies = stubDeepSeek([400, ENGLISH]);
  await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), (e: unknown) => e instanceof TranslationFailed && e.reason === 'HTTP');
  assert.equal(bodies.length, 1, 'a 4xx is final');

  let calls = 0;
  globalThis.fetch = (async () => {
    if (calls++ === 0) throw new TypeError('fetch failed');
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: ENGLISH } }] }) } as Response;
  }) as typeof fetch;
  assert.equal(await translate(ORIGINAL, 'zh-Hans', 'en'), ENGLISH_RESTORED);
  assert.equal(calls, 2);
});

test('the owner preference: absent is off, a language defaults to zh-Hans, the agent\'s to English, and no key means none', async () => {
  const db = (preferences: unknown) => ({ user: { findUnique: async () => ({ preferences }) } });
  assert.equal(await translationLanguages(db({}), OWNER_ID), null);
  assert.equal(await translationLanguages(db({ translationEnabled: false, translationLanguage: 'ja' }), OWNER_ID), null);
  assert.deepEqual(await translationLanguages(db({ translationEnabled: true }), OWNER_ID), { owner: 'zh-Hans', agent: 'en' });
  assert.deepEqual(await translationLanguages(db({ translationEnabled: true, translationLanguage: 'ja' }), OWNER_ID), { owner: 'ja', agent: 'en' });
  assert.deepEqual(
    await translationLanguages(db({ translationEnabled: true, translationLanguage: 'zh-Hans', translationAgentLanguage: 'ja' }), OWNER_ID),
    { owner: 'zh-Hans', agent: 'ja' },
  );
  // A value outside the list reads as the default, as the owner language does.
  assert.deepEqual(
    await translationLanguages(db({ translationEnabled: true, translationAgentLanguage: 'klingon' }), OWNER_ID),
    { owner: 'zh-Hans', agent: 'en' },
  );
  // The same language on both sides: nothing to translate.
  assert.equal(await translationLanguages(db({ translationEnabled: true, translationLanguage: 'ja', translationAgentLanguage: 'ja' }), OWNER_ID), null);
  assert.equal(await translationLanguages(db({ translationEnabled: true, translationLanguage: 'en' }), OWNER_ID), null);
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(await translationLanguages(db({ translationEnabled: true, translationLanguage: 'ja' }), OWNER_ID), null);
});

// ── the owner's message ────────────────────────────────────────────────────────────────────────

test('translated: the engine is handed the English, the owner\'s words are kept, and the session wakes', async () => {
  const bodies = stubDeepSeek([ENGLISH]);
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
  // No agent language on the account: English, as before.
  assert.match(bodies[0].messages.find((m) => m.role === 'system')!.content, /from Chinese \(Simplified\) into English\./);
});

test('with a Japanese agent language the engine is handed Japanese; the wire still names the owner\'s language', async () => {
  const JAPANESE = 'Safari でログインページの Google ログインが反応しません。⟦0⟧ を確認してください';
  const bodies = stubDeepSeek([JAPANESE]);
  const h = harness({ preferences: { translationEnabled: true, translationLanguage: 'zh-Hans', translationAgentLanguage: 'ja' } });
  const answer = await h.send();
  assert.deepEqual(answer.translation, { state: 'TRANSLATING', from: 'zh-Hans', original: ORIGINAL });
  assert.equal(h.turns[0].status, 'HELD');
  await h.service.translationsSettled();
  assert.match(bodies[0].messages.find((m) => m.role === 'system')!.content, /from Chinese \(Simplified\) into Japanese\./);
  const [turn] = h.turns;
  assert.equal(turn.status, 'PENDING');
  assert.equal(turn.content, JAPANESE.replace('⟦0⟧', '`signInWithPopup`'));
  assert.equal(turn.displayPrompt, ORIGINAL);
  assert.equal(turn.translationState, 'DONE');
  assert.equal(turn.translationLang, 'zh-Hans');
  assert.equal(h.wakes.queue, 1);
});

test('the owner\'s language the agent\'s: the message goes as written, with no hold and no translation', async () => {
  for (const preferences of [
    { translationEnabled: true, translationLanguage: 'ja', translationAgentLanguage: 'ja' },
    { translationEnabled: true, translationLanguage: 'en' },
  ]) {
    const bodies = stubDeepSeek([ENGLISH]);
    const h = harness({ preferences });
    const answer = await h.send();
    assert.equal(answer.translation, undefined, JSON.stringify(preferences));
    assert.equal(h.turns[0].status, 'PENDING');
    assert.equal(h.turns[0].content, ORIGINAL);
    assert.equal(h.turns[0].displayPrompt, null);
    assert.equal(h.turns[0].translationState, null);
    assert.equal(h.session.status, RunStatus.PENDING);
    assert.equal(h.wakes.queue, 1);
    await h.service.translationsSettled();
    assert.equal(bodies.length, 0);
  }
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
  stubDeepSeek([500, 500, 500]);
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
  stubDeepSeek([500, 500, 500, ENGLISH]);
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
  stubDeepSeek([500, 500, 500]);
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

test('optimizedTranslation (the prompt optimizer under Translation): held as usual, released with the optimizer\'s text, DeepSeek not asked', async () => {
  const bodies = stubDeepSeek([ENGLISH]);
  const h = harness();
  const answer = await h.service.createTurn(
    OWNER_ID, SESSION_ID,
    { clientTurnId: 'optimized-2', content: ORIGINAL, intent: 'NEXT_TURN', optimizedTranslation: ENGLISH_RESTORED },
    { translate: true },
  );
  assert.equal(answer.translation?.state, 'TRANSLATING');
  await h.service.translationsSettled();
  assert.equal(bodies.length, 0);
  assert.equal(h.turns[0].status, 'PENDING');
  assert.equal(h.turns[0].content, ENGLISH_RESTORED);
  assert.equal(h.turns[0].displayPrompt, ORIGINAL);
  assert.equal(h.turns[0].translationState, 'DONE');
  assert.equal(h.turns[0].translationLang, 'zh-Hans');
  assert.equal(h.session.status, RunStatus.PENDING);
});

test('optimizedTranslation that is not a string is a 400, and nothing is written', async () => {
  const h = harness();
  await assert.rejects(
    h.service.createTurn(
      OWNER_ID, SESSION_ID,
      { clientTurnId: 'optimized-3', content: ORIGINAL, intent: 'NEXT_TURN', optimizedTranslation: 42 as never },
      { translate: true },
    ),
    /optimizedTranslation must be a string/,
  );
  assert.equal(h.turns.length, 0);
});

test('skipTranslation (the prompt optimizer\'s English): the send is not held, carries no translation, and DeepSeek is not asked', async () => {
  const bodies = stubDeepSeek([ENGLISH]);
  const h = harness();
  const answer = await h.service.createTurn(
    OWNER_ID, SESSION_ID,
    { clientTurnId: 'optimized-1', content: ENGLISH_RESTORED, intent: 'NEXT_TURN', skipTranslation: true },
    { translate: true },
  );
  assert.equal(answer.translation, undefined);
  assert.equal(h.turns[0].status, 'PENDING');
  assert.equal(h.turns[0].content, ENGLISH_RESTORED);
  assert.equal(h.turns[0].displayPrompt, null);
  assert.equal(h.turns[0].translationState, null);
  assert.equal(h.turns[0].translationLang, null);
  assert.equal(h.session.status, RunStatus.PENDING);
  assert.equal(h.wakes.queue, 1);
  await h.service.translationsSettled();
  assert.equal(bodies.length, 0);
});

test('a slash command goes as written: not held, no translation, DeepSeek not asked', async () => {
  for (const [i, command] of ['/compact', '/review 修一下登录跳转', '/plugin:cmd'].entries()) {
    const bodies = stubDeepSeek([ENGLISH]);
    const h = harness();
    const answer = await h.service.createTurn(
      OWNER_ID, SESSION_ID, { clientTurnId: `slash-${i}`, content: command, intent: 'NEXT_TURN' }, { translate: true },
    );
    assert.equal(answer.translation, undefined, command);
    assert.equal(h.turns[0].status, 'PENDING', command);
    assert.equal(h.turns[0].content, command);
    assert.equal(h.turns[0].translationState, null, command);
    await h.service.translationsSettled();
    assert.equal(bodies.length, 0, command);
  }
});

test('text that only starts with a slash (a path, a comment) is still translated', () => {
  assert.equal(isSlashCommand('/compact'), true);
  assert.equal(isSlashCommand('  /review the fix'), true);
  assert.equal(isSlashCommand('/tmp/foo 删掉吧'), false);
  assert.equal(isSlashCommand('// TODO 看一下'), false);
  assert.equal(isSlashCommand('/'), false);
  assert.equal(isSlashCommand('请运行 /compact'), false);
});

// ── "Resolve in session" with translation on ─────────────────────────────────────────────────────

const SETTLED_MERGE = {
  mergeStatus: 'conflict',
  mergeOperationId: '33333333-3333-4333-8333-333333333333',
  mergeOperationOwner: '44444444-4444-4444-8444-444444444444',
  mergeError: 'CONFLICT (content): Merge conflict in src/a.ts',
  mergedAt: null,
  mergedSourceSha: 'abc123',
  branchMerged: false,
};
const SETTLED_COMMIT = {
  commitStatus: 'error',
  commitOperationId: '55555555-5555-4555-8555-555555555555',
  commitOperationOwner: '66666666-6666-4666-8666-666666666666',
  commitError: 'nothing to commit',
  commitResultMessage: null,
};

test('Resolve in session with translation on clears the settled merge and commit results, as it does with it off', async () => {
  stubDeepSeek(['hang']);
  const h = harness({ session: { ...SETTLED_MERGE, ...SETTLED_COMMIT } });
  await h.service.resume(OWNER_ID, SESSION_ID, { clientTurnId: 'client-1', content: ORIGINAL }, { translate: true });
  // The message is held for its translation, not delivered yet…
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].status, 'HELD');
  // …and the stale failure is gone all the same, so the bar offers Merge again once the rebase is done
  // instead of drawing the old conflict over a branch that has moved on.
  for (const field of ['mergeStatus', 'mergeOperationId', 'mergeOperationOwner', 'mergeError', 'mergedAt', 'mergedSourceSha', 'branchMerged',
    'commitStatus', 'commitOperationId', 'commitOperationOwner', 'commitError', 'commitResultMessage']) {
    assert.equal(h.session[field], null, `${field} was left on the row`);
  }
});

test('Resolve in session with translation on leaves a merge or commit still pending alone', async () => {
  stubDeepSeek(['hang']);
  const pending = {
    ...SETTLED_MERGE, mergeStatus: 'pending', mergeError: null,
    ...SETTLED_COMMIT, commitStatus: 'pending', commitError: null,
  };
  const h = harness({ session: pending });
  await h.service.resume(OWNER_ID, SESSION_ID, { clientTurnId: 'client-1', content: ORIGINAL }, { translate: true });
  assert.equal(h.turns[0].status, 'HELD');
  assert.equal(h.session.mergeStatus, 'pending');
  assert.equal(h.session.mergeOperationId, pending.mergeOperationId);
  assert.equal(h.session.commitStatus, 'pending');
  assert.equal(h.session.commitOperationId, pending.commitOperationId);
});

test('an ordinary translated send leaves a settled merge result where it is', async () => {
  stubDeepSeek(['hang']);
  const h = harness({ session: SETTLED_MERGE });
  await h.send();
  assert.equal(h.turns[0].status, 'HELD');
  assert.equal(h.session.mergeStatus, 'conflict');
  assert.equal(h.session.mergeError, SETTLED_MERGE.mergeError);
});

// ── why it failed (policy B, criterion 1) ───────────────────────────────────────────────────────

/** A translator that fails one way, every time it is asked. */
function stubFailure(kind: 'NETWORK' | 'EMPTY' | 'TRUNCATED' | 'MANGLED' | { http: number }): void {
  globalThis.fetch = (async () => {
    if (kind === 'NETWORK') throw new TypeError('fetch failed');
    if (typeof kind === 'object') return { ok: false, status: kind.http, body: null } as Response;
    const choice = kind === 'EMPTY'
      ? { finish_reason: 'stop', message: { content: '   ' } }
      : kind === 'TRUNCATED'
        ? { finish_reason: 'length', message: { content: 'The Google sign' } }
        : { finish_reason: 'stop', message: { content: 'check ⟦0⟧ and ⟦7⟧' } };
    return { ok: true, json: async () => ({ choices: [choice] }) } as Response;
  }) as typeof fetch;
}

/** Every warn line the owner-translation logger writes while `run` runs. */
async function warnLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = mock.method(Logger.prototype, 'warn', function (this: Logger, message: unknown) {
    lines.push(String(message));
  });
  try {
    await run();
  } finally {
    spy.mock.restore();
  }
  return lines.filter((line) => line.startsWith('owner translation failed:'));
}

const REASON_CASES: Array<{ reason: string; httpStatus: number | null; arrange: () => void }> = [
  { reason: 'NETWORK', httpStatus: null, arrange: () => stubFailure('NETWORK') },
  { reason: 'HTTP', httpStatus: 401, arrange: () => stubFailure({ http: 401 }) },
  { reason: 'HTTP', httpStatus: 503, arrange: () => stubFailure({ http: 503 }) },
  { reason: 'EMPTY', httpStatus: null, arrange: () => stubFailure('EMPTY') },
  { reason: 'TRUNCATED', httpStatus: null, arrange: () => stubFailure('TRUNCATED') },
  { reason: 'MANGLED', httpStatus: null, arrange: () => stubFailure('MANGLED') },
];

/** The one line's fields: reason, HTTP status, a duration, the session — and never the owner's words. */
function assertOneFailureLine(lines: string[], reason: string, httpStatus: number | null, sessionId: string | null): void {
  assert.equal(lines.length, 1, `one line per failure: ${lines.join(' | ')}`);
  const [line] = lines;
  assert.match(line, new RegExp(`\\breason=${reason}\\b`));
  assert.match(line, new RegExp(`\\bhttpStatus=${httpStatus ?? '-'}(\\s|$)`));
  assert.match(line, /\bdurationMs=\d+\b/);
  assert.match(line, new RegExp(`\\bsessionId=${sessionId ?? '-'}(\\s|$)`));
  for (const words of ['登录', 'signInWithPopup', 'Safari', 'LoginPage']) assert.ok(!line.includes(words), `no message text: ${line}`);
}

for (const { reason, httpStatus, arrange } of REASON_CASES) {
  const name = httpStatus ? `${reason} ${httpStatus}` : reason;
  test(`a held message that fails ${name} stores why, answers it, logs it once, and Retry clears it`, async () => {
    arrange();
    const h = harness();
    let turnId = '';
    const lines = await warnLines(async () => {
      ({ turnId } = await h.send());
      await h.service.translationsSettled();
    });
    const [turn] = h.turns;
    assert.equal(turn.status, 'HELD');
    assert.equal(turn.translationState, 'FAILED');
    assert.equal(turn.translationFailureReason, reason);
    assert.equal(turn.translationHttpStatus, httpStatus);
    assert.deepEqual(turnTranslationOf(turn), {
      state: 'FAILED', from: 'zh-Hans', original: ORIGINAL, failureReason: reason, ...(httpStatus ? { httpStatus } : {}),
    });
    assertOneFailureLine(lines, reason, httpStatus, SESSION_ID);
    assert.match(lines[0], new RegExp(`turnId=${turnId}`));

    stubDeepSeek([ENGLISH]);
    const retried = await h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId);
    assert.deepEqual(retried.translation, { state: 'TRANSLATING', from: 'zh-Hans', original: ORIGINAL });
    assert.equal(turn.translationFailureReason, null);
    assert.equal(turn.translationHttpStatus, null);
    await h.service.translationsSettled();
    assert.equal(turn.translationState, 'DONE');
  });
}

test('a held message that times out stores TIMEOUT with no status, logs it once, and Send as written clears it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  stubDeepSeek(['hang']);
  const h = harness();
  let turnId = '';
  const lines = await warnLines(async () => {
    ({ turnId } = await h.send());
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(TRANSLATION_TIMEOUT_MS);
    await h.service.translationsSettled();
  });
  const [turn] = h.turns;
  assert.equal(turn.translationState, 'FAILED');
  assert.equal(turn.translationFailureReason, 'TIMEOUT');
  assert.equal(turn.translationHttpStatus, null);
  assert.deepEqual(turnTranslationOf(turn), { state: 'FAILED', from: 'zh-Hans', original: ORIGINAL, failureReason: 'TIMEOUT' });
  assertOneFailureLine(lines, 'TIMEOUT', null, SESSION_ID);
  assert.match(lines[0], new RegExp(`durationMs=${TRANSLATION_TIMEOUT_MS}\\b`));

  const sent = await h.service.sendTurnAsWritten(OWNER_ID, SESSION_ID, turnId);
  assert.deepEqual(sent.translation, { state: 'SENT_AS_WRITTEN', from: 'zh-Hans', original: ORIGINAL });
  assert.equal(turn.translationFailureReason, null);
  assert.equal(turn.translationHttpStatus, null);
});

test('a Retry that translates releases the message DONE with the reason cleared', async () => {
  stubFailure({ http: 401 });
  const h = harness();
  const { turnId } = await h.send();
  await h.service.translationsSettled();
  assert.equal(h.turns[0].translationFailureReason, 'HTTP');
  stubDeepSeek([ENGLISH]);
  await h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId);
  await h.service.translationsSettled();
  assert.equal(h.turns[0].translationState, 'DONE');
  assert.equal(h.turns[0].translationFailureReason, null);
  assert.equal(h.turns[0].translationHttpStatus, null);
  assert.deepEqual(turnTranslationOf(h.turns[0]), { state: 'DONE', from: 'zh-Hans', original: ORIGINAL });
});

test('a reason stored on a turn that is no longer FAILED is not on the wire, nor a status beside another reason', () => {
  const row = { displayPrompt: 'x', translationLang: 'ja', translationFailureReason: 'HTTP', translationHttpStatus: 500 };
  assert.deepEqual(turnTranslationOf({ ...row, translationState: 'DONE' }), { state: 'DONE', from: 'ja', original: 'x' });
  assert.deepEqual(turnTranslationOf({ ...row, translationState: 'FAILED', translationFailureReason: 'EMPTY' }),
    { state: 'FAILED', from: 'ja', original: 'x', failureReason: 'EMPTY' });
  // A turn that failed before the reason was stored: FAILED with none (the generic line).
  assert.deepEqual(turnTranslationOf({ ...row, translationState: 'FAILED', translationFailureReason: null }),
    { state: 'FAILED', from: 'ja', original: 'x' });
});

test('NO_KEY and the reserved UNAVAILABLE are reasons the failure carries', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(translate('x', 'zh-Hans', 'en'), (e: unknown) =>
    e instanceof TranslationFailed && e.reason === 'NO_KEY' && e.httpStatus === undefined && e.durationMs === 0);
  const unavailable = new TranslationFailed('UNAVAILABLE', 'The translator is unavailable.');
  assert.equal(unavailable.reason, 'UNAVAILABLE');
});

// ── the 422 TRANSLATION_FAILED answer ─────────────────────────────────────────────────────────────

const LANGS = { owner: 'zh-Hans' as const, agent: 'en' as const };

/** The 422 body ownerWordsForAgent refuses `text` with, and the log lines it wrote. */
async function refusal(text: string, sessionId: string | null): Promise<{ body: Record<string, unknown>; lines: string[] }> {
  let body: Record<string, unknown> = {};
  const lines = await warnLines(async () => {
    await assert.rejects(
      ownerWordsForAgent(text, LANGS, false, { door: 'test-door', sessionId }),
      (e: unknown) => {
        assert.ok(e instanceof UnprocessableEntityException);
        body = e.getResponse() as Record<string, unknown>;
        return true;
      },
    );
  });
  return { body, lines };
}

for (const { reason, httpStatus, arrange } of REASON_CASES) {
  const name = httpStatus ? `${reason} ${httpStatus}` : reason;
  test(`a card answer whose words fail ${name} is refused 422 TRANSLATION_FAILED saying why, logged once`, async () => {
    arrange();
    const { body, lines } = await refusal(ORIGINAL, SESSION_ID);
    assert.deepEqual(body, {
      code: 'TRANSLATION_FAILED',
      message: "Couldn't translate, so it wasn't sent.",
      failureReason: reason,
      ...(httpStatus ? { httpStatus } : {}),
    });
    assertOneFailureLine(lines, reason, httpStatus, SESSION_ID);
    assert.match(lines[0], /door=test-door/);
  });
}

test('a card answer that times out is refused 422 with TIMEOUT, logged once with its duration', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  stubDeepSeek(['hang']);
  const pending = refusal(ORIGINAL, null);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(TRANSLATION_TIMEOUT_MS);
  const { body, lines } = await pending;
  assert.deepEqual(body, { code: 'TRANSLATION_FAILED', message: "Couldn't translate, so it wasn't sent.", failureReason: 'TIMEOUT' });
  assertOneFailureLine(lines, 'TIMEOUT', null, null);
  assert.match(lines[0], new RegExp(`durationMs=${TRANSLATION_TIMEOUT_MS}\\b`));
});

test('Send as written on a card answer asks no translator, so there is nothing to refuse or log', async () => {
  const bodies = stubDeepSeek([]);
  const lines = await warnLines(async () => {
    assert.equal(await ownerWordsForAgent(ORIGINAL, LANGS, true, { door: 'test-door' }), null);
  });
  assert.equal(bodies.length, 0);
  assert.deepEqual(lines, []);
});

// ── the held-message push (frame 4B of docs/ux/translation-failure-policy.html) ─────────────────

const SESSION_TITLE = 'Fix login redirect';

/**
 * The harness above with the real RealtimeService (whether the owner is viewing) and the real PushService behind it,
 * whose transport is stubbed: `pushes` is every alert it hands APNs, with the collapse id it rings under.
 */
function pushHarness() {
  const pushes: Array<{ title: string; body: string; sessionID: string; kind: string; collapseId?: string }> = [];
  let realtime!: RealtimeService;
  const h = harness({
    session: { title: SESSION_TITLE, notificationsMuted: false },
    realtime: (prisma) => {
      const config = {
        get: (key: string) => ({ APNS_KEY_ID: 'key-id', APNS_TEAM_ID: 'team-id', APNS_KEY: Buffer.from('k').toString('base64') } as Record<string, string>)[key],
      } as ConfigService;
      const device = { id: 'd-1', token: 'device', userId: OWNER_ID, platform: 'ios', bundleId: 'io.orbitd.app', environment: 'production', loginSessionId: null };
      const push = new PushService({ ...(prisma as object), deviceToken: { findMany: async () => [device] } } as never, config);
      (push as unknown as { deliver: unknown }).deliver = async (_t: unknown, body: string, _type: unknown, _p: unknown, collapseId?: string) => {
        const payload = JSON.parse(body) as { aps: { alert: { title: string; body: string } }; sessionID: string; kind: string };
        pushes.push({ ...payload.aps.alert, sessionID: payload.sessionID, kind: payload.kind, collapseId });
        return 1;
      };
      realtime = new RealtimeService(prisma, push);
      return realtime;
    },
  });
  /** Pass `ms` on the fake clock and let what it fired settle. */
  const after = async (ms: number) => {
    mock.timers.tick(ms);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** The owner opens the session (GET /sessions/:id/events) until the result is called. */
  const view = () => {
    const sub = realtime.streamForRun(SESSION_ID, { owner: true }).subscribe();
    return () => sub.unsubscribe();
  };
  return { ...h, pushes, after, view, realtime };
}

/** Send a message whose translation the translator refuses (HTTP 400: not retried), and let it go FAILED. */
async function sendFailed(h: ReturnType<typeof pushHarness>) {
  const { turnId } = await h.send();
  await h.service.translationsSettled();
  assert.equal(h.turns[0].translationState, 'FAILED');
  return turnId;
}

test('held and unseen for 60 s: exactly one push, titled with the session, the 4B copy, opening that session', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400]);
  const h = pushHarness();
  const turnId = await sendFailed(h);
  await h.after(SessionsService.HELD_MESSAGE_PUSH_DELAY_MS - 1);
  assert.equal(h.pushes.length, 0, 'not before 60 s');
  await h.after(1);
  assert.deepEqual(h.pushes, [{
    title: SESSION_TITLE,
    body: "Your message wasn't sent: it couldn't be translated.",
    sessionID: SESSION_ID, // what OrbitKit and Android route a tap to: that session
    kind: 'held-message',
    collapseId: `held-${turnId}`,
  }]);
  assert.equal(HELD_MESSAGE_PUSH_BODY, "Your message wasn't sent: it couldn't be translated.");
  await h.after(10 * SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 1, 'never repeated for the same turn');
});

test('a new session\'s held opening message is pushed the same way', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400]);
  const h = pushHarness();
  // The opening turn as createSession holds it, then translated by the same path (startTurnTranslation).
  const openingId = '00000000-0000-4000-8000-0000000000aa';
  h.turns.push({
    id: openingId, sessionId: SESSION_ID, seq: 1, kind: 'message', clientTurnId: `initial-${SESSION_ID}`,
    content: ORIGINAL, status: 'HELD', displayPrompt: ORIGINAL, translationState: 'TRANSLATING', translationLang: 'zh-Hans',
  });
  (h.service as unknown as { startTurnTranslation(o: string, s: string, t: string): void }).startTurnTranslation(OWNER_ID, SESSION_ID, openingId);
  await h.service.translationsSettled();
  assert.equal(h.turns[0].translationState, 'FAILED');
  await h.after(SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].collapseId, `held-${openingId}`);
});

test('the owner viewing the session when the 60 s are up: no push', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400]);
  const h = pushHarness();
  const leave = h.view();
  await sendFailed(h);
  await h.after(SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 0);
  // Leaving afterwards does not bring the push back: there was one check, and they had seen it.
  leave();
  await h.after(10 * SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 0);
});

test('a guest\'s stream of the session is not the owner viewing it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400]);
  const h = pushHarness();
  h.realtime.streamForRun(SESSION_ID).subscribe();
  await sendFailed(h);
  await h.after(SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 1);
});

test('Retry that translates before 60 s: no push', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400, ENGLISH]);
  const h = pushHarness();
  const turnId = await sendFailed(h);
  await h.after(30_000);
  await h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId);
  await h.service.translationsSettled();
  assert.equal(h.turns[0].translationState, 'DONE');
  await h.after(10 * SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 0);
});

test('Retry still translating when the 60 s are up: no push', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400, 'hang']);
  const h = pushHarness();
  const turnId = await sendFailed(h);
  await h.after(50_000);
  await h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  await h.after(10_000);
  assert.equal(h.turns[0].translationState, 'TRANSLATING');
  assert.equal(h.pushes.length, 0);
  // Let the Retry time out here, so it does not outlive the test.
  await h.after(TRANSLATION_TIMEOUT_MS);
  await h.service.translationsSettled();
});

test('Send as written before 60 s: no push', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400]);
  const h = pushHarness();
  const turnId = await sendFailed(h);
  await h.after(30_000);
  await h.service.sendTurnAsWritten(OWNER_ID, SESSION_ID, turnId);
  assert.equal(h.turns[0].translationState, 'SENT_AS_WRITTEN');
  await h.after(10 * SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 0);
});

test('withdrawn before 60 s: no push', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400]);
  const h = pushHarness();
  await sendFailed(h);
  await h.after(30_000);
  // What DELETE /sessions/:id/turns/:turnId does to a held message (cancelQueuedTurn): the row is deleted.
  h.turns.splice(0, 1);
  await h.after(10 * SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 0);
});

test('a Retry that fails again before 60 s: one push, 60 s after the second failure', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400, 400]);
  const h = pushHarness();
  const turnId = await sendFailed(h);
  await h.after(30_000);
  await h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId);
  await h.service.translationsSettled();
  assert.equal(h.turns[0].translationState, 'FAILED');
  await h.after(30_000);
  assert.equal(h.pushes.length, 0, 'the first failure\'s check was replaced');
  await h.after(30_000);
  assert.equal(h.pushes.length, 1);
  await h.after(10 * SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 1);
});

test('a second failure after Retry, once the first was pushed, sends at most one more', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400, 400]);
  const h = pushHarness();
  const turnId = await sendFailed(h);
  await h.after(SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 1);
  await h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId);
  await h.service.translationsSettled();
  assert.equal(h.turns[0].translationState, 'FAILED');
  await h.after(10 * SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 2);
  assert.equal(h.pushes[1].collapseId, h.pushes[0].collapseId, 'the second replaces the first banner');
});

test('a muted session is not pushed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubDeepSeek([400]);
  const h = pushHarness();
  h.session.notificationsMuted = true;
  await sendFailed(h);
  await h.after(SessionsService.HELD_MESSAGE_PUSH_DELAY_MS);
  assert.equal(h.pushes.length, 0);
});

// ── the circuit breaker (policy B, criterion 4; board frame 6) ────────────────────────────────────

/** Settle `pending` under mocked setTimeout, stepping the clock 250 ms at a time (the retries pause 0.5 s and 1.5 s). */
async function drain<T>(pending: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let result: { value?: T; error?: unknown } | undefined;
  pending.then((value) => { result = { value }; }, (error: unknown) => { result = { error }; });
  for (let i = 0; i < 400 && !result; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!result) mock.timers.tick(250);
  }
  assert.ok(result, 'settled');
  return result;
}

/** A fetch that counts its calls and fails each one as `kind` says, or answers ENGLISH for 'ok'. */
function countingTranslator(kind: () => 'NETWORK' | 'ok' | { http: number } | 'MANGLED' | 'EMPTY' | 'TRUNCATED') {
  const calls = { n: 0 };
  globalThis.fetch = (async () => {
    calls.n++;
    const k = kind();
    if (k === 'NETWORK') throw new TypeError('fetch failed');
    if (typeof k === 'object') return { ok: false, status: k.http, body: null } as Response;
    const content = k === 'ok' ? ENGLISH : k === 'EMPTY' ? ' ' : k === 'MANGLED' ? 'check ⟦0⟧ and ⟦7⟧' : 'The Google';
    return { ok: true, json: async () => ({ choices: [{ finish_reason: k === 'TRUNCATED' ? 'length' : 'stop', message: { content } }] }) } as Response;
  }) as typeof fetch;
  return calls;
}

const isReason = (reason: string) => (e: unknown) => e instanceof TranslationFailed && e.reason === reason;

/** Three transient failures in a row — unreachable, 503 and 429 after their retries — which open the breaker. */
async function openBreaker(): Promise<void> {
  for (const kind of ['NETWORK', { http: 503 }, { http: 429 }] as const) {
    countingTranslator(() => kind);
    const { error } = await drain(translate(ORIGINAL, 'zh-Hans', 'en'));
    assert.ok(error instanceof TranslationFailed && error.reason !== 'UNAVAILABLE', 'each one asked the translator');
  }
}

test('three transient failures within a minute open the breaker: the next translate() is UNAVAILABLE at once, fetch untouched', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let announced = 0;
  const off = onTranslationAvailabilityChange(() => announced++);
  try {
    countingTranslator(() => 'NETWORK');
    await drain(translate(ORIGINAL, 'zh-Hans', 'en'));
    countingTranslator(() => ({ http: 502 }));
    await drain(translate(ORIGINAL, 'zh-Hans', 'en'));
    assert.equal(translationUnavailableUntil(), null, 'two failures are not enough');
    assert.equal(announced, 0);
    // The third: a timeout.
    stubDeepSeek(['hang']);
    const { error } = await drain(translate(ORIGINAL, 'zh-Hans', 'en'));
    assert.ok(isReason('TIMEOUT')(error));
    assert.equal(announced, 1, 'opening is announced once');
    const until = translationUnavailableUntil();
    assert.equal(until?.getTime(), Date.now() + 60_000);

    const calls = countingTranslator(() => 'ok');
    await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), (e: unknown) =>
      isReason('UNAVAILABLE')(e) && (e as TranslationFailed).durationMs === 0);
    mock.timers.tick(59_999);
    await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), isReason('UNAVAILABLE'));
    assert.equal(calls.n, 0, 'nothing asked the translator while it was open');
    assert.equal(announced, 1);
  } finally {
    off();
  }
});

test('after 60 s one call is let through: a translation closes the breaker, and the count starts again', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let announced = 0;
  const off = onTranslationAvailabilityChange(() => announced++);
  try {
    await openBreaker();
    assert.equal(announced, 1);
    mock.timers.tick(60_000);
    assert.equal(translationUnavailableUntil(), null, 'not reported once the 60 s are up');
    const calls = countingTranslator(() => 'ok');
    assert.equal(await translate(ORIGINAL, 'zh-Hans', 'en'), ENGLISH_RESTORED);
    assert.equal(calls.n, 1);
    assert.equal(announced, 2, 'closing is announced');
    assert.equal(translationUnavailableUntil(), null);
    // Closed with nothing counted: two more transient failures do not open it.
    countingTranslator(() => 'NETWORK');
    await drain(translate(ORIGINAL, 'zh-Hans', 'en'));
    await drain(translate(ORIGINAL, 'zh-Hans', 'en'));
    assert.equal(translationUnavailableUntil(), null);
    assert.equal(announced, 2);
  } finally {
    off();
  }
});

test('the trial call failing opens it for another 60 s, and other calls meet UNAVAILABLE while the trial runs', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let announced = 0;
  const off = onTranslationAvailabilityChange(() => announced++);
  try {
    await openBreaker();
    mock.timers.tick(60_000);
    const calls = countingTranslator(() => 'NETWORK');
    const trial = drain(translate(ORIGINAL, 'zh-Hans', 'en'));
    await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), isReason('UNAVAILABLE'));
    const { error } = await trial;
    assert.ok(isReason('NETWORK')(error));
    assert.equal(calls.n, 3, 'only the trial asked, with its retries');
    assert.equal(announced, 2, 'opening again is announced');
    assert.equal(translationUnavailableUntil()?.getTime(), Date.now() + 60_000);
    await assert.rejects(translate(ORIGINAL, 'zh-Hans', 'en'), isReason('UNAVAILABLE'));
    assert.equal(calls.n, 3);
  } finally {
    off();
  }
});

test('4xx, MANGLED, EMPTY and TRUNCATED never open the breaker, and failures more than a minute apart do not either', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  for (const kind of [{ http: 400 }, { http: 401 }, { http: 404 }, 'MANGLED', 'EMPTY', 'TRUNCATED'] as const) {
    const calls = countingTranslator(() => kind);
    for (let i = 0; i < 5; i++) {
      const { error } = await drain(translate(ORIGINAL, 'zh-Hans', 'en'));
      assert.ok(error instanceof TranslationFailed && error.reason !== 'UNAVAILABLE');
    }
    assert.equal(calls.n, 5, `${JSON.stringify(kind)} asked every time`);
    assert.equal(translationUnavailableUntil(), null);
  }
  for (let i = 0; i < 4; i++) {
    countingTranslator(() => ({ http: 500 }));
    await drain(translate(ORIGINAL, 'zh-Hans', 'en'));
    mock.timers.tick(31_000);
  }
  assert.equal(translationUnavailableUntil(), null, 'never three inside one minute');
});

test('while open, a held message stores UNAVAILABLE at once and a card answer is refused 422 with it; fetch untouched', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  await openBreaker();
  const calls = countingTranslator(() => 'ok');
  const h = harness();
  let turnId = '';
  const lines = await warnLines(async () => {
    ({ turnId } = await h.send());
    await h.service.translationsSettled();
  });
  const [turn] = h.turns;
  assert.equal(turn.status, 'HELD');
  assert.equal(turn.translationState, 'FAILED');
  assert.equal(turn.translationFailureReason, 'UNAVAILABLE');
  assert.equal(turn.translationHttpStatus, null);
  assert.deepEqual(turnTranslationOf(turn), { state: 'FAILED', from: 'zh-Hans', original: ORIGINAL, failureReason: 'UNAVAILABLE' });
  assertOneFailureLine(lines, 'UNAVAILABLE', null, SESSION_ID);
  assert.match(lines[0], /durationMs=0\b/);

  const { body } = await refusal(ORIGINAL, SESSION_ID);
  assert.deepEqual(body, { code: 'TRANSLATION_FAILED', message: "Couldn't translate, so it wasn't sent.", failureReason: 'UNAVAILABLE' });
  assert.equal(calls.n, 0, 'neither asked the translator');

  // Once the 60 s are up, Retry is the trial call: it translates, delivers, and closes the breaker.
  mock.timers.tick(60_000);
  await h.service.retryTurnTranslation(OWNER_ID, SESSION_ID, turnId);
  await h.service.translationsSettled();
  assert.equal(turn.translationState, 'DONE');
  assert.equal(calls.n, 1);
  assert.equal(translationUnavailableUntil(), null);
});
