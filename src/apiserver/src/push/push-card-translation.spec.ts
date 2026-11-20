/**
 * PUSH AND FEISHU USE THE CARD TRANSLATION (project 'Translate every owner card', criterion 6, decision 3A).
 *
 * An alert that quotes an agent's words — a coordinator question's push body, an owner request's and a crossing's
 * title, the Feishu card of each, and a FULL Feishu approval card — waits up to the translation timeout for the
 * card's translation when the owner's translation is on, and goes out in it when it is ready; otherwise in the
 * original. With translation off nothing waits.
 *
 * The translator is stubbed at fetch (the DeepSeek call), and the cards are translated by the real jobs
 * (`queueOwnerCardTranslation`, `translateApprovalCard`) over in-memory rows, so what wakes the push is what wakes it
 * in production.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { resetTranslationBreaker } from '../sessions/translation';
import { ConfigService } from '@nestjs/config';
import { TRANSLATION_TIMEOUT_MS } from '@orbit/shared';
import { PushService } from './push.service';
import { COORDINATOR_QUESTION_FIELDS, CROSSING_FIELDS, OWNER_REQUEST_FIELDS, queueOwnerCardTranslation, type CardFields } from '../sessions/card-translation';
import { replyTranslationsSettled, translateApprovalCard } from '../sessions/reply-translation';
import { renderFeishuCard, shownQuestionsOf, type FeishuAlert } from '../feishu/cards/feishu-cards';

// The translator's circuit breaker is the process's: each test starts with it closed and nothing counted.
beforeEach(() => resetTranslationBreaker());

function enabledConfig(): ConfigService {
  const values: Record<string, string> = {
    APNS_KEY_ID: 'key-id',
    APNS_TEAM_ID: 'team-id',
    APNS_KEY: Buffer.from('test-key').toString('base64'),
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

const ON = { translationEnabled: true, translationLanguage: 'zh-Hans' };
const OFF = { translationEnabled: false, translationLanguage: 'zh-Hans' };
const LANGS = { owner: 'zh-Hans', agent: 'en' } as const;
const zh = (text: string) => `ZH[${text}]`;

// ── the stubbed translator ─────────────────────────────────────────────────────────────────────────

const asked: string[] = [];
/** While set, every translation waits for it. */
let gate: Promise<void> | null = null;
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;

test.before(() => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('https://api.deepseek.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const text = body.messages.find((m) => m.role === 'user')!.content;
    asked.push(text);
    if (gate) await gate;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: zh(text) } }] }) } as Response;
  }) as typeof fetch;
});

test.after(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = realKey;
});

let releaseHeld: (() => void) | null = null;

/** Hold every translation until the returned function is called (or the test ends). */
function holdTranslator(): () => void {
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  releaseHeld = () => { gate = null; releaseHeld = null; release(); };
  return releaseHeld;
}

// A test that fails while the translator is held must not hold every later test's translations.
test.afterEach(() => releaseHeld?.());

// ── harness ────────────────────────────────────────────────────────────────────────────────────────

/** One card row in memory, with the store its translation job writes through. */
function cardRow(key: string, source: Record<string, unknown>, fields: CardFields) {
  const row: { source: Record<string, unknown>; translation: unknown } = { source, translation: null };
  const store = {
    key,
    read: async () => ({ source: row.source, fields, translation: row.translation }),
    write: async (translation: unknown) => { row.translation = translation; return true; },
    published: () => undefined,
  };
  return { row, queue: () => queueOwnerCardTranslation(store, LANGS) };
}

interface Sent { body: string; at: number }

function harness(preferences: Record<string, unknown>, prisma: Record<string, unknown>, opts: { feishuDetail?: 'FULL' | 'TITLES_ONLY' } = {}) {
  const sent: Sent[] = [];
  const cards: Array<{ spec: any; at: number; alert: FeishuAlert | null }> = [];
  const feishu = {
    post: async (_target: unknown, spec: any) => { cards.push({ spec, at: Date.now(), alert: await spec.render() }); return true; },
    approvalCard: (_target: unknown, sessionId: string, approvalId: string) => ({ kind: 'approval', sessionId, approvalId, render: async () => null }),
    joinApprovalStretch: async () => undefined,
  };
  const service = new PushService({
    user: { findUnique: async () => ({ preferences }) },
    // Whether an open item is one nobody owes any more (`openItemsNoLongerOwed`): it is still owed.
    $queryRaw: async () => [],
    ...prisma,
  } as any, enabledConfig(), feishu as any);
  (service as any).channels = async () => ({
    tokens: [{ token: 'device', environment: 'sandbox' }],
    feishu: { ownerId: 'owner-1', detail: opts.feishuDetail ?? 'FULL', approvalsInFeishu: true },
  });
  (service as any).deliver = async (_t: unknown, body: string) => { sent.push({ body, at: Date.now() }); };
  return { service, sent, cards };
}

const apsBody = (sent: Sent) => (JSON.parse(sent.body) as { aps: { alert: { title: string; body: string } } }).aps.alert;

const QUESTION = 'Take the slower fix?';

function questionItem(row: { source: Record<string, unknown>; translation: unknown }) {
  const item = {
    kind: 'COORDINATOR_QUESTION',
    state: 'OPEN',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    title: `Coordinator asks: ${QUESTION}`,
    payload: row.source,
    waitingSince: new Date('2026-11-18T10:00:00Z'),
    escalatedAt: null,
    ownerId: 'owner-1',
    projectId: '55555555-5555-4555-8555-555555555555',
    promotionId: null,
    project: { title: 'Translate', coordinatorSessionId: '44444444-4444-4444-8444-444444444444', coordinatorSession: null },
  };
  return {
    projectOpenItem: {
      findUnique: async (args: { select: Record<string, boolean> }) =>
        (args.select.translation && Object.keys(args.select).length === 1 ? { translation: row.translation } : item),
    },
  };
}

// ── coordinator question ───────────────────────────────────────────────────────────────────────────

test('the default wait is the translation timeout (20 s)', () => {
  const { service } = harness(ON, {});
  assert.equal(service.translationWaitMs, TRANSLATION_TIMEOUT_MS);
  assert.equal(TRANSLATION_TIMEOUT_MS, 20_000);
});

test('a coordinator question: translation ready in time → the push and the Feishu card carry it', async () => {
  const card = cardRow('open-item:q-ready', { question: QUESTION, options: [], ifUnanswered: null }, COORDINATOR_QUESTION_FIELDS);
  const { service, sent, cards } = harness(ON, questionItem(card.row));
  const release = holdTranslator();
  // Filed: the push and the translation start together, as `askOwner` starts them.
  const pushed = service.notifyOwnerItem('q-ready');
  card.queue();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 0, 'the push waits while the translation is running');
  release();
  await pushed;
  await service.feishuIdle();
  await replyTranslationsSettled();
  assert.equal(sent.length, 1);
  assert.equal(apsBody(sent[0]).body, `${zh(QUESTION)} · Translate`);
  assert.equal(cards.length, 1);
  const alert = cards[0].alert as Extract<FeishuAlert, { kind: 'owner-item' }>;
  assert.equal(alert.alert.body, `${zh(QUESTION)} · Translate`, 'the Feishu card quotes the translation too');
});

test('a coordinator question: translation not ready in time → the original, sent after at most the timeout', async () => {
  const card = cardRow('open-item:q-late', { question: QUESTION, options: [], ifUnanswered: null }, COORDINATOR_QUESTION_FIELDS);
  const { service, sent, cards } = harness(ON, questionItem(card.row));
  service.translationWaitMs = 300;
  const release = holdTranslator();
  const started = Date.now();
  const pushed = service.notifyOwnerItem('q-late');
  card.queue();
  await pushed;
  const waited = sent[0].at - started;
  assert.equal(apsBody(sent[0]).body, `${QUESTION} · Translate`);
  assert.ok(waited >= 290, `waited the timeout (${waited} ms)`);
  assert.ok(waited < 2_000, `and no longer (${waited} ms)`);
  await service.feishuIdle();
  assert.equal((cards[0].alert as Extract<FeishuAlert, { kind: 'owner-item' }>).alert.body, `${QUESTION} · Translate`);
  release();
  await replyTranslationsSettled();
});

test('a coordinator question: translation off → the original, sent without waiting', async () => {
  const card = cardRow('open-item:q-off', { question: QUESTION, options: [], ifUnanswered: null }, COORDINATOR_QUESTION_FIELDS);
  const { service, sent } = harness(OFF, questionItem(card.row));
  // The full 20 s wait: a push that waited at all would time this test out of its bound below.
  const before = asked.length;
  const started = Date.now();
  await service.notifyOwnerItem('q-off');
  assert.equal(apsBody(sent[0]).body, `${QUESTION} · Translate`);
  assert.ok(sent[0].at - started < 500, `sent at once (${sent[0].at - started} ms)`);
  assert.equal(asked.length, before, 'nothing was asked of the translator');
});

test('a coordinator question whose translation failed → the original, at once', async () => {
  const card = cardRow('open-item:q-failed', { question: QUESTION, options: [], ifUnanswered: null }, COORDINATOR_QUESTION_FIELDS);
  card.row.translation = { lang: 'zh-Hans', failed: true };
  const { service, sent } = harness(ON, questionItem(card.row));
  const started = Date.now();
  await service.notifyOwnerItem('q-failed');
  assert.equal(apsBody(sent[0]).body, `${QUESTION} · Translate`);
  assert.ok(sent[0].at - started < 500, 'a translation already tried is not waited for again');
});

// ── owner request and crossing ─────────────────────────────────────────────────────────────────────

function requestPrisma(row: { translation: unknown }, kind = 'DECISION') {
  const request = { kind, state: 'PENDING', title: 'Pick the registry', ownerId: 'owner-1', askedBySessionId: '11111111-1111-4111-8111-111111111111', projectId: null };
  return {
    ownerRequest: {
      findUnique: async (args: { select: Record<string, boolean> }) =>
        (args.select.translation && Object.keys(args.select).length === 1 ? { translation: row.translation } : request),
    },
  };
}

test('an owner request: translation ready in time → translated title; not in time → the original after the timeout; off → at once', async () => {
  {
    const card = cardRow('owner-request:r-ready', { title: 'Pick the registry' }, OWNER_REQUEST_FIELDS);
    const { service, sent, cards } = harness(ON, requestPrisma(card.row));
    const pushed = service.notifyOwnerRequest('r-ready');
    card.queue();
    await pushed;
    await service.feishuIdle();
    assert.equal(apsBody(sent[0]).body, zh('Pick the registry'));
    assert.equal((cards[0].alert as Extract<FeishuAlert, { kind: 'other' }>).body, zh('Pick the registry'));
  }
  {
    const card = cardRow('owner-request:r-late', { title: 'Pick the registry' }, OWNER_REQUEST_FIELDS);
    const { service, sent } = harness(ON, requestPrisma(card.row));
    service.translationWaitMs = 300;
    const release = holdTranslator();
    const started = Date.now();
    const pushed = service.notifyOwnerRequest('r-late');
    card.queue();
    await pushed;
    assert.equal(apsBody(sent[0]).body, 'Pick the registry');
    assert.ok(sent[0].at - started >= 290 && sent[0].at - started < 2_000, `${sent[0].at - started} ms`);
    release();
    await replyTranslationsSettled();
  }
  {
    const card = cardRow('owner-request:r-off', { title: 'Pick the registry' }, OWNER_REQUEST_FIELDS);
    const { service, sent } = harness(OFF, requestPrisma(card.row));
    const started = Date.now();
    await service.notifyOwnerRequest('r-off');
    assert.equal(apsBody(sent[0]).body, 'Pick the registry');
    assert.ok(sent[0].at - started < 500);
  }
});

test('a schedule\'s owner request is never translated, so its push never waits', async () => {
  const { service, sent } = harness(ON, requestPrisma({ translation: null }, 'SCHEDULE_FAILED'));
  const started = Date.now();
  await service.notifyOwnerRequest('r-schedule');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].at - started < 500);
});

function crossingPrisma(row: { translation: unknown }) {
  const crossing = {
    ownerId: 'owner-1',
    state: 'PENDING',
    kind: 'MOVE_TASK',
    title: 'Fix the login redirect',
    fromProjectId: '22222222-2222-4222-8222-222222222222',
    toProjectId: '33333333-3333-4333-8333-333333333333',
    fromProject: { title: 'Web', coordinatorSessionId: null, coordinatorSession: null },
    toProject: { title: 'Auth', coordinatorSessionId: null, coordinatorSession: null },
  };
  return {
    projectHandoffApproval: {
      findUnique: async (args: { select: Record<string, unknown> }) =>
        (args.select.translation && Object.keys(args.select).length === 1 ? { translation: row.translation } : crossing),
    },
  };
}

test('a crossing: translation ready in time → translated title; not in time → the original after the timeout', async () => {
  {
    const card = cardRow('crossing:c-ready', { title: 'Fix the login redirect', reason: 'It belongs to auth' }, CROSSING_FIELDS);
    const { service, sent, cards } = harness(ON, crossingPrisma(card.row));
    const pushed = service.notifyCrossingRequest('c-ready');
    card.queue();
    await pushed;
    await service.feishuIdle();
    assert.equal(apsBody(sent[0]).body, zh('Fix the login redirect'));
    assert.equal((cards[0].alert as Extract<FeishuAlert, { kind: 'other' }>).body, zh('Fix the login redirect'));
  }
  {
    const card = cardRow('crossing:c-late', { title: 'Fix the login redirect', reason: 'It belongs to auth' }, CROSSING_FIELDS);
    const { service, sent } = harness(ON, crossingPrisma(card.row));
    service.translationWaitMs = 300;
    const release = holdTranslator();
    const started = Date.now();
    const pushed = service.notifyCrossingRequest('c-late');
    card.queue();
    await pushed;
    assert.equal(apsBody(sent[0]).body, 'Fix the login redirect');
    assert.ok(sent[0].at - started >= 290 && sent[0].at - started < 2_000, `${sent[0].at - started} ms`);
    release();
    await replyTranslationsSettled();
  }
});

// ── Feishu approval cards ──────────────────────────────────────────────────────────────────────────

const QUESTION_INPUT = {
  questions: [{
    question: 'Which database?',
    header: 'Storage',
    multiSelect: false,
    options: [{ label: 'Postgres', description: 'Already running' }, { label: 'SQLite', description: '' }],
  }],
};
const QUESTION_TRANSLATION = {
  lang: 'zh-Hans' as const,
  questions: [{
    question: zh('Which database?'),
    header: zh('Storage'),
    options: [{ label: zh('Postgres'), description: zh('Already running') }, { label: zh('SQLite') }],
  }],
};

const cardText = (alert: FeishuAlert): string => JSON.stringify(renderFeishuCard(alert, {
  detail: 'FULL', approvalsInFeishu: true, showOrbit: true, openUrl: 'https://orbit.test/s',
}));

test('a Feishu approval card draws approval.translation when present, and the original when absent or failed', () => {
  const approval = (translation: unknown) => ({
    kind: 'approval' as const,
    sessionTitle: 'Session',
    approvals: [{ id: 'a-1', toolName: 'AskUserQuestion', input: QUESTION_INPUT, translation: translation as never }],
  });
  const translated = cardText(approval(QUESTION_TRANSLATION));
  assert.match(translated, /ZH\[Storage\]: ZH\[Which database\?\]/);
  assert.match(translated, /ZH\[Postgres\] — ZH\[Already running\]/);
  assert.doesNotMatch(translated, /Storage: Which database\?/);
  // The form still sends back each option's place in the agent's list.
  assert.match(translated, /"text":\{"tag":"plain_text","content":"ZH\[Postgres\]"\},"value":"0"/);
  for (const none of [null, undefined, { lang: 'zh-Hans', failed: true }]) {
    const original = cardText(approval(none));
    assert.match(original, /Storage: Which database\?/);
    assert.doesNotMatch(original, /ZH\[/);
  }
  // A translation that does not line up with the input is not drawn.
  assert.equal(shownQuestionsOf(QUESTION_INPUT, { lang: 'zh-Hans', questions: [] })[0].question, 'Which database?');
});

function approvalHarness(preferences: Record<string, unknown>, detail: 'FULL' | 'TITLES_ONLY') {
  const approval: { id: string; sessionId: string; status: string; toolName: string; input: unknown; translation: unknown; toolUseId: null; backgroundJobId: null } = {
    id: `a-${detail}-${preferences.translationEnabled}`, sessionId: 's-1', status: 'PENDING', toolName: 'AskUserQuestion',
    input: QUESTION_INPUT, translation: null, toolUseId: null, backgroundJobId: null,
  };
  const h = harness(preferences, {
    session: { findFirst: async () => ({ title: 'Session', ownerId: 'owner-1', notificationsMuted: false, notifyNeedsYou: null, runSource: null }) },
    approval: { findFirst: async () => approval },
  }, { feishuDetail: detail });
  (h.service as any).needsYouSessions = async () => ['s-1'];
  (h.service as any).claimApprovalAlert = async () => true;
  const translateNow = () => translateApprovalCard({
    db: {
      approval: {
        findFirst: async () => approval,
        updateMany: async (args: { data: { translation: unknown } }) => { approval.translation = args.data.translation; return { count: 1 }; },
      },
    } as any,
    publish: () => undefined,
    approvalEvent: () => ({}) as any,
  }, 's-1', approval.id, approval.input, preferences.translationEnabled ? LANGS : null, approval.toolName);
  return { ...h, approval, translateNow };
}

test('a FULL Feishu approval card waits for the approval\'s translation; the phone and a titles-only card never do', async () => {
  {
    const { service, sent, cards, approval, translateNow } = approvalHarness(ON, 'FULL');
    const release = holdTranslator();
    await service.notifyApprovalRequest('s-1', approval.id, 'AskUserQuestion');
    translateNow();
    assert.equal(sent.length, 1, 'the banner (no agent words) is not held');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cards.length, 0, 'the Feishu card waits for the translation');
    release();
    await service.feishuIdle();
    await replyTranslationsSettled();
    assert.equal(cards.length, 1);
    assert.deepEqual((approval.translation as { questions: unknown[] }).questions.length, 1,
      'drawn after the translation was stored, so its render reads it');
  }
  {
    const { service, cards, approval } = approvalHarness(ON, 'FULL');
    service.translationWaitMs = 300;
    const release = holdTranslator();
    const started = Date.now();
    await service.notifyApprovalRequest('s-1', approval.id, 'AskUserQuestion');
    // Nothing translates this one in time: the card goes out after the timeout, in the original.
    await service.feishuIdle();
    assert.ok(cards[0].at - started >= 290 && cards[0].at - started < 2_000, `${cards[0].at - started} ms`);
    release();
  }
  for (const [preferences, detail] of [[OFF, 'FULL'], [ON, 'TITLES_ONLY']] as const) {
    const { service, cards, approval } = approvalHarness(preferences, detail);
    const started = Date.now();
    await service.notifyApprovalRequest('s-1', approval.id, 'AskUserQuestion');
    await service.feishuIdle();
    assert.ok(cards[0].at - started < 500, `${JSON.stringify(preferences)} ${detail}: no wait (${cards[0].at - started} ms)`);
  }
});
