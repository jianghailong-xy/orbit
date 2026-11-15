import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunEventType, type NormalizedRunEvent } from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { approvalRequestEvent } from '../realtime/realtime.service';
import { replyTranslationsSettled, translateCardNow, translateStoredEvents, type TranslationDeps } from './reply-translation';
import { SessionsService } from './sessions.service';

/**
 * Settings › Translation, what the agent says (task A2), against the real schema (migration 0550) and the
 * real reads: a reply's translation is written into its run_event payload and comes back from the raw-SQL
 * /events/page; a failed one is retried; an approval card's translation is stored in approval.translation;
 * and a decision picked in translation is stored — what the runner's poll hands the engine — in English.
 * DeepSeek is stubbed. reply-translation.spec.ts covers the same paths over the ingest and the live stream.
 */
const PG_URL = process.env.COORDINATOR_PG_URL;

let prisma: ReturnType<typeof prismaClientFor>;
let sessions: SessionsService;
let deps: TranslationDeps;
let ownerId: string;
let runnerId: string;
let workspaceId: string;
const published: NormalizedRunEvent[] = [];

/** DeepSeek: `ZH[...]` into the owner's language, `EN[...]` into English, 500 while `failing`. */
let failing = false;
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;

function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the reply translation suite', concurrency: 1 }, body);
}

before(async () => {
  if (!PG_URL) return;
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.deepseek.com/')) return realFetch(url, init);
    if (failing) return { ok: false, status: 500, body: null } as Response;
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const english = /into English\./.test(body.messages.find((m) => m.role === 'system')!.content);
    const text = body.messages.find((m) => m.role === 'user')!.content;
    const content = english ? `EN[${text}]` : `ZH[${text}]`;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) } as Response;
  }) as typeof fetch;
  ownerId = randomUUID();
  runnerId = randomUUID();
  workspaceId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId, email: `reply-translation-${ownerId}@example.test`, name: 'reply translation', passwordHash: 'x',
      preferences: { translationEnabled: true, translationLanguage: 'zh-Hans' },
    },
  });
  await prisma.runner.create({
    data: { id: runnerId, ownerId, name: 'reply translation', tokenHash: `t-${runnerId}`, maxConcurrent: 4, status: 'ONLINE', lastHeartbeatAt: new Date() },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'reply translation', enabled: true, workDir: mkdtempSync(path.join(tmpdir(), 'reply-translation-')) },
  });
  const realtime = new Proxy({}, {
    get: (_target, key) => (key === 'then' ? undefined : key === 'publish' ? (_id: string, e: NormalizedRunEvent) => { published.push(e); } : () => undefined),
  });
  sessions = new SessionsService(prisma as unknown as PrismaService, {} as never, realtime as never);
  deps = {
    db: prisma as unknown as TranslationDeps['db'],
    publish: (_id, e) => { published.push(e); },
    approvalEvent: (approval) => approvalRequestEvent(approval, new Date().toISOString()),
  };
});

afterEach(async () => {
  failing = false;
  published.length = 0;
  await replyTranslationsSettled();
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

async function liveSession(): Promise<string> {
  const sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: 'reply translation', prompt: 'opening', provider: 'claude', providerBuiltin: true, engine: 'claude',
      status: RunStatus.RUNNING, numTurns: 1, dispatchOrigin: 'USER', startsTaskWork: false,
    },
  });
  return sessionId;
}

/** The events as the runner's ingest stores them. */
async function store(sessionId: string, events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>) {
  await prisma.runEvent.createMany({ data: events.map((e) => ({ sessionId, ...e })) as never });
  return events;
}

scenario('a reply\'s translation is written into its run_event payload and replayed by /events/page; a tool call is not', async () => {
  const sessionId = await liveSession();
  const events = await store(sessionId, [
    { seq: 1, type: RunEventType.TOOL_USE, payload: { id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } } },
    { seq: 2, type: RunEventType.ASSISTANT, payload: { text: 'All tests pass.' } },
    { seq: 3, type: RunEventType.PROMPT_SUGGESTION, payload: { text: 'Open a PR', source: 'orbit' } },
  ]);
  translateStoredEvents(deps, sessionId, 'zh-Hans', events);
  await replyTranslationsSettled();

  const page = await sessions.getEventPage(ownerId, sessionId, { tail: 50 });
  const bySeq = new Map(page.events.map((e) => [e.seq, e.payload as Record<string, unknown>]));
  assert.deepEqual(bySeq.get(2), { text: 'All tests pass.', translation: { lang: 'zh-Hans', text: 'ZH[All tests pass.]' } });
  assert.deepEqual(bySeq.get(3), { text: 'Open a PR', source: 'orbit', translation: { lang: 'zh-Hans', text: 'ZH[Open a PR]' } });
  assert.equal('translation' in bySeq.get(1)!, false);
  assert.equal(await prisma.runEvent.count({ where: { sessionId } }), 3, 'no row of its own');
  assert.deepEqual(
    published.filter((e) => e.type === RunEventType.TRANSLATION).map((e) => (e.payload as { of: number }).of).sort(),
    [2, 3],
  );
});

scenario('a failed reply translation is stored as failed, and Retry writes the translation', async () => {
  const sessionId = await liveSession();
  const events = await store(sessionId, [{ seq: 4, type: RunEventType.ASSISTANT, payload: { text: 'Done.' } }]);
  failing = true;
  translateStoredEvents(deps, sessionId, 'zh-Hans', events);
  await replyTranslationsSettled();
  const failed = await prisma.runEvent.findUnique({ where: { sessionId_seq: { sessionId, seq: 4 } } });
  assert.deepEqual((failed!.payload as { translation?: unknown }).translation, { lang: 'zh-Hans', failed: true });

  failing = false;
  assert.deepEqual(await sessions.retryReplyTranslation(ownerId, sessionId, 4), { of: 4, lang: 'zh-Hans' });
  await replyTranslationsSettled();
  const page = await sessions.getEventPage(ownerId, sessionId, { tail: 10 });
  assert.deepEqual((page.events[0].payload as { translation?: unknown }).translation, { lang: 'zh-Hans', text: 'ZH[Done.]' });
});

scenario('a question card\'s translation is stored in approval.translation, and a translated pick is stored in English', async () => {
  const sessionId = await liveSession();
  const input = {
    questions: [{
      question: 'Which database?', header: 'Database', multiSelect: false,
      options: [{ label: 'Postgres', description: 'Production' }, { label: 'SQLite' }],
    }],
  };
  const card = await prisma.approval.create({ data: { sessionId, toolName: 'AskUserQuestion', input, toolUseId: 'ask-1' } });
  const translation = await translateCardNow(deps, sessionId, card.id, 'zh-Hans');
  const stored = await prisma.approval.findUniqueOrThrow({ where: { id: card.id } });
  assert.deepEqual(stored.translation, translation);
  assert.deepEqual(stored.translation, {
    lang: 'zh-Hans',
    questions: [{
      question: 'ZH[Which database?]', header: 'ZH[Database]',
      options: [{ label: 'ZH[Postgres]', description: 'ZH[Production]' }, { label: 'ZH[SQLite]' }],
    }],
  });
  assert.deepEqual(stored.input, input, 'input stays the engine\'s English');

  await sessions.decideApproval(ownerId, sessionId, card.id, {
    behavior: 'allow', answers: { 'ZH[Which database?]': ['ZH[SQLite]'] }, message: '谢谢',
  });
  const decided = await prisma.approval.findUniqueOrThrow({ where: { id: card.id } });
  assert.equal(decided.status, 'ALLOWED');
  assert.deepEqual(decided.answers, { 'Which database?': ['SQLite'] });
  assert.equal(decided.message, 'EN[谢谢]');
});
