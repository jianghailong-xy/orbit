import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { resetTranslationBreaker } from './translation';
import { RunStatus } from '@orbit/shared';
import { RunEventType, TRANSLATION_TIMEOUT_MS } from '@orbit/shared';
import { Logger } from '@nestjs/common';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';
import '../test-support/dequeue-under-lease';
import { turnStateFilter, turnStateOfWord } from './session-turn-state';
import { sessionWord } from '../test-support/session-word';

// The translator's circuit breaker is the process's: each test starts with it closed and nothing counted.
beforeEach(() => resetTranslationBreaker());

/**
 * Settings › Translation against the real schema (migration 0532) and the real delivery SQL: a HELD
 * message is never leased by the inbox and never lets the claim hand out a session whose only work it
 * is; released, the runner is handed the translation into the account's agent language (absent = English;
 * Japanese below); its `user` event is stored with the owner's original beside it, and the session list
 * previews the original. With the owner's language the agent's, a send is not held at all. DeepSeek is stubbed.
 */
const PG_URL = process.env.COORDINATOR_PG_URL;

const ORIGINAL = '把登录页的 Google 按钮修好';
const ENGLISH = 'Fix the Google button on the login page';

let prisma: ReturnType<typeof prismaClientFor>;
let queue: QueueService;
let sessions: SessionsService;
let runnerApi: RunnerApiController;
let ownerId: string;
let runnerId: string;
let workspaceId: string;
let turnsChanged = 0;

/** A translator failure that is not an HTTP status: unreachable, no text, cut off, code lost, or no answer at all. */
type DeepSeekFailure = { fail: 'NETWORK' | 'EMPTY' | 'TRUNCATED' | 'MANGLED' | 'HANG' };
/** What DeepSeek answers next: a translation, an HTTP error status, or another failure. */
let deepSeekReplies: Array<string | number | DeepSeekFailure> = [];
/** The system prompt of every DeepSeek call, in order. */
let deepSeekSystems: string[] = [];
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;

function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the session translation suite', concurrency: 1 }, body);
}

const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });

before(async () => {
  if (!PG_URL) return;
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.deepseek.com/')) return realFetch(url);
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === 'system')!.content;
    // Only the translator is answered from deepSeekReplies: another DeepSeek caller in the background (a session's
    // title) must not take a reply a translation's retry is waiting for.
    if (!system.startsWith('You are a translator.')) return { ok: false, status: 500, body: null } as Response;
    deepSeekSystems.push(system);
    const reply = deepSeekReplies.shift();
    const answer = (choice: unknown) => ({ ok: true, json: async () => ({ choices: [choice] }) }) as Response;
    if (reply && typeof reply === 'object') {
      if (reply.fail === 'NETWORK') throw new TypeError('fetch failed');
      if (reply.fail === 'HANG') return new Promise<Response>(() => undefined);
      if (reply.fail === 'EMPTY') return answer({ finish_reason: 'stop', message: { content: '' } });
      if (reply.fail === 'TRUNCATED') return answer({ finish_reason: 'length', message: { content: 'Fix the' } });
      return answer({ finish_reason: 'stop', message: { content: 'Fix \u27e63\u27e7' } });
    }
    if (typeof reply !== 'string') return { ok: false, status: reply ?? 500, body: null } as Response;
    return answer({ finish_reason: 'stop', message: { content: reply } });
  }) as typeof fetch;
  ownerId = randomUUID();
  runnerId = randomUUID();
  workspaceId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `translation-${ownerId}@example.test`,
      name: 'translation',
      passwordHash: 'x',
      preferences: { translationEnabled: true, translationLanguage: 'zh-Hans' },
    },
  });
  await prisma.runner.create({
    data: { id: runnerId, ownerId, name: 'translation', tokenHash: `t-${runnerId}`, maxConcurrent: 4, status: 'ONLINE', lastHeartbeatAt: new Date() },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'translation', enabled: true, workDir: mkdtempSync(path.join(tmpdir(), 'translation-')) },
  });
  const realtime = new Proxy({}, {
    get: (_target, key) => (key === 'then' ? undefined : key === 'publishQueuedTurnsChanged' ? () => { turnsChanged++; } : () => undefined),
  });
  queue = new QueueService(prisma as unknown as PrismaService, silent() as never);
  sessions = new SessionsService(prisma as unknown as PrismaService, queue as never, realtime as never);
  runnerApi = new RunnerApiController(
    prisma as never, queue as never, realtime as never, {} as never, {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined, undefined, undefined, undefined, sessions,
  );
});

afterEach(() => {
  deepSeekReplies = [];
  deepSeekSystems = [];
});

after(async () => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = realKey;
  if (!prisma) return;
  await prisma.session.deleteMany({ where: { ownerId } });
  await prisma.workspace.deleteMany({ where: { ownerId } });
  await prisma.runner.deleteMany({ where: { ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

/** A session that ran its opening turn and is now in `status`. */
async function liveSession(status: RunStatus): Promise<string> {
  const sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: 'translation', prompt: 'opening', provider: 'claude', providerBuiltin: true, engine: 'claude',
      turnState: turnStateOfWord(status), numTurns: 1, dispatchOrigin: 'USER', startsTaskWork: false,
      ...(['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)
        ? { finishedAt: new Date()}
        : {}),
    },
  });
  await prisma.conversationTurn.create({
    data: { sessionId, seq: 1, clientTurnId: SessionsService.initialTurnClientId(sessionId), kind: 'message', content: 'opening', status: 'ANSWERED' },
  });
  return sessionId;
}

/** What the runner's inbox hands out next for the session. */
async function dequeue(sessionId: string): Promise<{ turnId: string; content?: string }> {
  const turn = await (runnerApi as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, generation: null) => Promise<{ turnId: string; content?: string } | null>;
  }).dequeueTurn(sessionId, runnerId, null);
  // Nothing to hand out is null here (the route answers it as an empty turnId).
  return turn ?? { turnId: '' };
}

const send = (sessionId: string, content = ORIGINAL) =>
  sessions.createTurn(ownerId, sessionId, { clientTurnId: randomUUID(), content, intent: 'NEXT_TURN' }, { translate: true });

scenario('a held message is not leased; translated, the runner gets the English and the transcript keeps the original', async () => {
  const sessionId = await liveSession(RunStatus.RUNNING);
  // DeepSeek has not answered yet: the send is held.
  deepSeekReplies = [];
  let answer!: (reply: string) => void;
  const pending = new Promise<string>((resolve) => { answer = resolve; });
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async () => {
    const reply = await pending;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }) } as Response;
  }) as typeof fetch;
  try {
    const sent = await send(sessionId);
    assert.equal(sent.translation?.state, 'TRANSLATING');
    assert.equal((await dequeue(sessionId)).turnId, '', 'a message being translated is not deliverable');

    // Both projections list it with its chip; the default one is what the native clients read.
    const [queued] = await sessions.listQueuedTurns(ownerId, sessionId);
    assert.deepEqual(queued.translation, { state: 'TRANSLATING', from: 'zh-Hans', original: ORIGINAL });
    const [active] = await sessions.listQueuedTurns(ownerId, sessionId, 'active');
    assert.equal(active.placement, 'queued');

    answer(ENGLISH);
    await sessions.translationsSettled();
  } finally {
    globalThis.fetch = stubbed;
  }
  const delivered = await dequeue(sessionId);
  assert.ok(delivered.turnId);
  assert.equal(delivered.content, ENGLISH, 'the engine is handed the English');
  const row = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: delivered.turnId } });
  assert.equal(row.displayPrompt, ORIGINAL);
  assert.equal(row.translationState, 'DONE');

  // The runner echoes what it delivered; the stored event carries the owner's original beside it.
  await runnerApi.events({ id: runnerId } as never, sessionId, {
    events: [{ seq: 1, type: RunEventType.USER, ts: new Date().toISOString(), turnId: delivered.turnId, payload: { text: ENGLISH } }],
  } as never);
  const event = await prisma.runEvent.findFirstOrThrow({ where: { sessionId, type: RunEventType.USER } });
  assert.deepEqual((event.payload as { translation?: unknown }).translation, { state: 'DONE', from: 'zh-Hans', original: ORIGINAL });
  assert.equal((event.payload as { text?: unknown }).text, ENGLISH);
  const preview = await prisma.session.findUniqueOrThrow({ where: { id: sessionId }, select: { lastUserText: true } });
  assert.equal(preview.lastUserText, ORIGINAL, 'the session list previews the owner\'s own words');
});

scenario('a failed translation is never delivered; Send as written delivers the original', async () => {
  const sessionId = await liveSession(RunStatus.RUNNING);
  deepSeekReplies = [503];
  const sent = await send(sessionId);
  await sessions.translationsSettled();
  const held = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: sent.turnId } });
  assert.equal(held.status, 'HELD');
  assert.equal(held.translationState, 'FAILED');
  assert.equal((await dequeue(sessionId)).turnId, '', 'not delivered (1A)');
  const [listed] = await sessions.listQueuedTurns(ownerId, sessionId);
  assert.equal(listed.translation?.state, 'FAILED');

  await sessions.sendTurnAsWritten(ownerId, sessionId, sent.turnId);
  const delivered = await dequeue(sessionId);
  assert.equal(delivered.turnId, sent.turnId);
  assert.equal(delivered.content, ORIGINAL);
});

scenario('Retry after a failure delivers the translation', async () => {
  const sessionId = await liveSession(RunStatus.RUNNING);
  // Three failures: the automatic tries are spent, so the message is held for the owner's Retry.
  deepSeekReplies = [500, 500, 500, ENGLISH];
  const sent = await send(sessionId);
  await sessions.translationsSettled();
  assert.equal((await dequeue(sessionId)).turnId, '');
  await sessions.retryTurnTranslation(ownerId, sessionId, sent.turnId);
  await sessions.translationsSettled();
  const delivered = await dequeue(sessionId);
  assert.equal(delivered.turnId, sent.turnId);
  assert.equal(delivered.content, ENGLISH);
  // The account names no agent language: English, as before.
  assert.equal(deepSeekSystems.length, 4);
  for (const system of deepSeekSystems) assert.match(system, /from Chinese \(Simplified\) into English\./);
});

scenario('a held message can be withdrawn like a queued one', async () => {
  const sessionId = await liveSession(RunStatus.AWAITING_INPUT);
  deepSeekReplies = [500];
  const sent = await send(sessionId);
  await sessions.translationsSettled();
  await sessions.cancelQueuedTurn(ownerId, sessionId, sent.turnId);
  assert.equal(await prisma.conversationTurn.count({ where: { id: sent.turnId } }), 0);
  const status = await sessionWord(prisma, sessionId);
  assert.equal(status, RunStatus.AWAITING_INPUT, 'a held message never moved the session');
});

scenario('a new session whose opening message is held is not claimed until it is released', async () => {
  deepSeekReplies = [500];
  const created = await sessions.create(ownerId, { workspaceId, prompt: ORIGINAL } as never, { translate: true });
  await sessions.translationsSettled();
  const opening = await prisma.conversationTurn.findUniqueOrThrow({
    where: { sessionId_clientTurnId: { sessionId: created.id, clientTurnId: SessionsService.initialTurnClientId(created.id) } },
  });
  assert.equal(opening.status, 'HELD');
  assert.equal(opening.translationState, 'FAILED');
  assert.equal(created.prompt, ORIGINAL, 'the title and the prompt are the owner\'s words');
  assert.equal(await queue.claimSessionForRunner({ id: runnerId }), null, 'a session whose only work is held is not claimed');
  // The queue is where its chip is drawn from, though it is the opening.
  const [listed] = await sessions.listQueuedTurns(ownerId, created.id);
  assert.equal(listed.translation?.state, 'FAILED');

  deepSeekReplies = [ENGLISH];
  await sessions.retryTurnTranslation(ownerId, created.id, opening.id);
  await sessions.translationsSettled();
  const claimed = await queue.claimSessionForRunner({ id: runnerId });
  assert.equal(claimed?.sessionId, created.id);
  // The claim seeded nothing beside it: the opening the runner gets is the translated one.
  const turns = await prisma.conversationTurn.findMany({ where: { sessionId: created.id } });
  assert.equal(turns.length, 1);
  const delivered = await dequeue(created.id);
  assert.equal(delivered.content, ENGLISH);
});

scenario('translation off, or no server key: a send is written and delivered as before', async () => {
  const sessionId = await liveSession(RunStatus.RUNNING);
  await prisma.user.update({ where: { id: ownerId }, data: { preferences: {} } });
  try {
    const off = await send(sessionId, 'as written');
    assert.equal(off.translation, undefined);
    assert.equal((await dequeue(sessionId)).content, 'as written');
  } finally {
    await prisma.user.update({ where: { id: ownerId }, data: { preferences: { translationEnabled: true } } });
  }
  const other = await liveSession(RunStatus.RUNNING);
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const noKey = await send(other, ORIGINAL);
    assert.equal(noKey.translation, undefined);
    assert.equal((await dequeue(other)).content, ORIGINAL);
  } finally {
    process.env.DEEPSEEK_API_KEY = 'test-key';
  }
  assert.ok(turnsChanged > 0);
});

scenario('skipTranslation (the prompt optimizer\'s English): an opening message and a revive are not held, and carry no translation', async () => {
  // The opening message: claimable at once, delivered as sent.
  const created = await sessions.create(ownerId, { workspaceId, prompt: ENGLISH, skipTranslation: true } as never, { translate: true });
  await sessions.translationsSettled();
  // Not held, so no turn row is laid down at create: the claim seeds the opening, as it does with
  // Translation off. A held opening would be a HELD row here.
  const held = await prisma.conversationTurn.findMany({ where: { sessionId: created.id } });
  assert.deepEqual(held.map((turn) => [turn.status, turn.translationState]), []);
  // The scenarios above leave sessions running on this one runner; settle them so its capacity is free
  // and the claim answers only whether this session's work is held.
  await prisma.session.updateMany({
    where: { ownerId, id: { not: created.id }, ...turnStateFilter(['IN_FLIGHT', 'QUEUED', null]) },
    data: { turnState: null, finishedAt: new Date()},
  });
  const claimed = await queue.claimSessionForRunner({ id: runnerId });
  assert.equal(claimed?.sessionId, created.id, 'not held: the claim hands it out');
  assert.equal((await dequeue(created.id)).content, ENGLISH);
  const seeded = await prisma.conversationTurn.findMany({ where: { sessionId: created.id } });
  assert.deepEqual(seeded.map((turn) => [turn.content, turn.translationState, turn.displayPrompt]), [[ENGLISH, null, null]]);

  // A revive of an ended session: the same send without the flag is held (the control), with it not.
  for (const skipTranslation of [false, true]) {
    deepSeekReplies = [500];
    const sessionId = await liveSession(RunStatus.SUCCEEDED);
    // An ended session that ran, so it may be revived (session-state.ts deriveSessionCapabilities).
    await prisma.session.update({ where: { id: sessionId }, data: { startedAt: new Date(), runtimeSessionId: `engine-${sessionId}` } });
    const clientTurnId = randomUUID();
    const answer = await sessions.resume(
      ownerId, sessionId,
      { clientTurnId, content: skipTranslation ? ENGLISH : ORIGINAL, ...(skipTranslation ? { skipTranslation } : {}) } as never,
      { translate: true },
    );
    await sessions.translationsSettled();
    const turn = await prisma.conversationTurn.findUniqueOrThrow({ where: { sessionId_clientTurnId: { sessionId, clientTurnId } } });
    if (skipTranslation) {
      assert.equal((answer as { translation?: unknown }).translation, undefined);
      assert.notEqual(turn.status, 'HELD');
      assert.equal(turn.translationState, null);
      assert.equal(turn.content, ENGLISH);
    } else {
      assert.equal(turn.status, 'HELD', 'the control: without the flag a revive is held');
    }
  }
});

scenario('with a Japanese agent language the runner is handed Japanese; the turn still names the owner\'s language', async () => {
  const JAPANESE = 'ログインページの Google ボタンを直して';
  await prisma.user.update({
    where: { id: ownerId },
    data: { preferences: { translationEnabled: true, translationLanguage: 'zh-Hans', translationAgentLanguage: 'ja' } },
  });
  try {
    const sessionId = await liveSession(RunStatus.RUNNING);
    deepSeekReplies = [JAPANESE];
    const sent = await send(sessionId);
    assert.deepEqual(sent.translation, { state: 'TRANSLATING', from: 'zh-Hans', original: ORIGINAL });
    await sessions.translationsSettled();
    assert.equal(deepSeekSystems.length, 1);
    assert.match(deepSeekSystems[0], /from Chinese \(Simplified\) into Japanese\./);
    const delivered = await dequeue(sessionId);
    assert.equal(delivered.turnId, sent.turnId);
    assert.equal(delivered.content, JAPANESE, 'the engine is handed Japanese');
    const row = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: sent.turnId } });
    assert.equal(row.displayPrompt, ORIGINAL);
    assert.equal(row.translationLang, 'zh-Hans');
    assert.equal(row.translationState, 'DONE');
  } finally {
    await prisma.user.update({ where: { id: ownerId }, data: { preferences: { translationEnabled: true, translationLanguage: 'zh-Hans' } } });
  }
});

scenario('the owner\'s language the agent\'s: a send is written and delivered as written, never held', async () => {
  await prisma.user.update({
    where: { id: ownerId },
    data: { preferences: { translationEnabled: true, translationLanguage: 'ja', translationAgentLanguage: 'ja' } },
  });
  try {
    const sessionId = await liveSession(RunStatus.RUNNING);
    const sent = await send(sessionId, 'ボタンを直して');
    assert.equal(sent.translation, undefined);
    const row = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: sent.turnId } });
    assert.equal(row.status, 'PENDING');
    assert.equal(row.translationState, null);
    assert.equal(row.displayPrompt, null);
    const delivered = await dequeue(sessionId);
    assert.equal(delivered.turnId, sent.turnId);
    assert.equal(delivered.content, 'ボタンを直して');
    await sessions.translationsSettled();
    assert.equal(deepSeekSystems.length, 0, 'DeepSeek was never asked');
  } finally {
    await prisma.user.update({ where: { id: ownerId }, data: { preferences: { translationEnabled: true, translationLanguage: 'zh-Hans' } } });
  }
});

// ── why it failed (translation failure policy B, criterion 1; migration 1100) ─────────────────────

/** Every owner-translation failure line the logger writes while `run` runs. */
async function failureLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const realWarn = Logger.prototype.warn;
  Logger.prototype.warn = function (this: Logger, message: unknown, ...rest: unknown[]) {
    if (String(message).startsWith('owner translation failed:')) lines.push(String(message));
    else return (realWarn as (...args: unknown[]) => void).call(this, message, ...rest);
  } as typeof realWarn;
  try {
    await run();
  } finally {
    Logger.prototype.warn = realWarn;
  }
  return lines;
}

function assertOneLine(lines: string[], reason: string, httpStatus: number | null, sessionId: string): void {
  assert.equal(lines.length, 1, lines.join(' | '));
  assert.match(lines[0], new RegExp(`\\breason=${reason}\\b`));
  assert.match(lines[0], new RegExp(`\\bhttpStatus=${httpStatus ?? '-'}(\\s|$)`));
  assert.match(lines[0], /\bdurationMs=\d+\b/);
  assert.match(lines[0], new RegExp(`\\bsessionId=${sessionId}\\b`));
  assert.ok(!lines[0].includes(ORIGINAL) && !lines[0].includes('登录'), 'no message text');
}

const REASONS: Array<{ reason: string; httpStatus: number | null; replies: Array<string | number | DeepSeekFailure>; release: 'retry' | 'as-written' }> = [
  { reason: 'NETWORK', httpStatus: null, replies: [{ fail: 'NETWORK' }, { fail: 'NETWORK' }, { fail: 'NETWORK' }], release: 'retry' },
  { reason: 'HTTP', httpStatus: 401, replies: [401], release: 'as-written' },
  { reason: 'HTTP', httpStatus: 503, replies: [503, 503, 503], release: 'retry' },
  { reason: 'EMPTY', httpStatus: null, replies: [{ fail: 'EMPTY' }], release: 'as-written' },
  { reason: 'TRUNCATED', httpStatus: null, replies: [{ fail: 'TRUNCATED' }], release: 'retry' },
  { reason: 'MANGLED', httpStatus: null, replies: [{ fail: 'MANGLED' }], release: 'as-written' },
  { reason: 'TIMEOUT', httpStatus: null, replies: [{ fail: 'HANG' }], release: 'retry' },
];

for (const { reason, httpStatus, replies, release } of REASONS) {
  const name = httpStatus ? `${reason} ${httpStatus}` : reason;
  scenario(`a held message that fails ${name} stores why, lists it, logs it once, and ${release === 'retry' ? 'Retry' : 'Send as written'} clears it`, async () => {
    const sessionId = await liveSession(RunStatus.AWAITING_INPUT);
    deepSeekReplies = [...replies];
    let turnId = '';
    const startedAt = Date.now();
    const lines = await failureLines(async () => {
      ({ turnId } = await send(sessionId));
      await sessions.translationsSettled();
    });
    if (reason === 'TIMEOUT') assert.ok(Date.now() - startedAt >= TRANSLATION_TIMEOUT_MS - 50);
    const held = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: turnId } });
    assert.equal(held.status, 'HELD');
    assert.equal(held.translationState, 'FAILED');
    assert.equal(held.translationFailureReason, reason);
    assert.equal(held.translationHttpStatus, httpStatus);
    const expected = { state: 'FAILED', from: 'zh-Hans', original: ORIGINAL, failureReason: reason, ...(httpStatus ? { httpStatus } : {}) };
    const [queued] = await sessions.listQueuedTurns(ownerId, sessionId);
    assert.deepEqual(queued.translation, expected);
    const [active] = await sessions.listQueuedTurns(ownerId, sessionId, 'active');
    assert.deepEqual(active.translation, expected);
    assertOneLine(lines, reason, httpStatus, sessionId);
    if (reason === 'TIMEOUT') assert.match(lines[0], /durationMs=(1999\d|2\d{4})\b/);

    if (release === 'retry') {
      deepSeekReplies = [ENGLISH];
      const retried = await sessions.retryTurnTranslation(ownerId, sessionId, turnId);
      assert.deepEqual(retried.translation, { state: 'TRANSLATING', from: 'zh-Hans', original: ORIGINAL });
      await sessions.translationsSettled();
    } else {
      const sent = await sessions.sendTurnAsWritten(ownerId, sessionId, turnId);
      assert.deepEqual(sent.translation, { state: 'SENT_AS_WRITTEN', from: 'zh-Hans', original: ORIGINAL });
    }
    const released = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: turnId } });
    assert.equal(released.translationState, release === 'retry' ? 'DONE' : 'SENT_AS_WRITTEN');
    assert.equal(released.translationFailureReason, null);
    assert.equal(released.translationHttpStatus, null);
  });
}

scenario('a new session\'s held opening message stores why it failed, and Retry clears it', async () => {
  deepSeekReplies = [429, 429, 429];
  let createdId = '';
  const lines = await failureLines(async () => {
    createdId = (await sessions.create(ownerId, { workspaceId, prompt: ORIGINAL } as never, { translate: true })).id;
    await sessions.translationsSettled();
  });
  const opening = await prisma.conversationTurn.findUniqueOrThrow({
    where: { sessionId_clientTurnId: { sessionId: createdId, clientTurnId: SessionsService.initialTurnClientId(createdId) } },
  });
  assert.equal(opening.translationFailureReason, 'HTTP');
  assert.equal(opening.translationHttpStatus, 429);
  const [listed] = await sessions.listQueuedTurns(ownerId, createdId);
  assert.equal(listed.translation?.failureReason, 'HTTP');
  assert.equal(listed.translation?.httpStatus, 429);
  assertOneLine(lines, 'HTTP', 429, createdId);

  deepSeekReplies = [{ fail: 'HANG' }];
  await sessions.retryTurnTranslation(ownerId, createdId, opening.id);
  const retrying = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: opening.id } });
  assert.equal(retrying.translationState, 'TRANSLATING');
  assert.equal(retrying.translationFailureReason, null);
  assert.equal(retrying.translationHttpStatus, null);
  await sessions.translationsSettled();
});

scenario('the schema keeps a reason to a FAILED turn and a status to HTTP', async () => {
  const sessionId = await liveSession(RunStatus.AWAITING_INPUT);
  deepSeekReplies = [{ fail: 'EMPTY' }];
  const { turnId } = await send(sessionId);
  await sessions.translationsSettled();
  const refused = (data: Record<string, unknown>) =>
    assert.rejects(prisma.conversationTurn.update({ where: { id: turnId }, data }), /conversation_turn_translation_failure_chk/);
  await refused({ translationFailureReason: 'COSMIC_RAY' });
  await refused({ translationHttpStatus: 500 });
  await refused({ translationFailureReason: 'HTTP', translationHttpStatus: 42 });
  await refused({ translationState: 'TRANSLATING' });
  await prisma.conversationTurn.update({ where: { id: turnId }, data: { translationFailureReason: 'UNAVAILABLE' } });
  await prisma.conversationTurn.update({ where: { id: turnId }, data: { translationFailureReason: 'NO_KEY' } });
  await prisma.conversationTurn.update({ where: { id: turnId }, data: { translationFailureReason: 'HTTP', translationHttpStatus: 500 } });
});
