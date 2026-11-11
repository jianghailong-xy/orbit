import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';
import '../test-support/dequeue-under-lease';

/**
 * Settings › Translation against the real schema (migration 0531) and the real delivery SQL: a HELD
 * message is never leased by the inbox and never lets the claim hand out a session whose only work it
 * is; released, the runner is handed the English; its `user` event is stored with the owner's
 * original beside it, and the session list previews the original. DeepSeek is stubbed.
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

/** What DeepSeek answers next: a translation, or an HTTP error status. */
let deepSeekReplies: Array<string | number> = [];
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
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (!String(url).startsWith('https://api.deepseek.com/')) return realFetch(url);
    const reply = deepSeekReplies.shift();
    if (typeof reply !== 'string') return { ok: false, status: reply ?? 500, body: null } as Response;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }) } as Response;
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
      status, numTurns: 1, dispatchOrigin: 'USER', startsTaskWork: false,
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
  deepSeekReplies = [500, ENGLISH];
  const sent = await send(sessionId);
  await sessions.translationsSettled();
  assert.equal((await dequeue(sessionId)).turnId, '');
  await sessions.retryTurnTranslation(ownerId, sessionId, sent.turnId);
  await sessions.translationsSettled();
  const delivered = await dequeue(sessionId);
  assert.equal(delivered.turnId, sent.turnId);
  assert.equal(delivered.content, ENGLISH);
});

scenario('a held message can be withdrawn like a queued one', async () => {
  const sessionId = await liveSession(RunStatus.AWAITING_INPUT);
  deepSeekReplies = [500];
  const sent = await send(sessionId);
  await sessions.translationsSettled();
  await sessions.cancelQueuedTurn(ownerId, sessionId, sent.turnId);
  assert.equal(await prisma.conversationTurn.count({ where: { id: sent.turnId } }), 0);
  const { status } = await prisma.session.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true } });
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
