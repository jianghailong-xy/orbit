import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { GUEST_PROMPT_OPTIMIZER_DAILY_USES, PROMPT_OPTIMIZER_MAX_DRAFT_CHARS, RunEventType } from '@orbit/shared';
import { AttachmentsService } from '../attachments/attachments.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { ViewerStreamCaps } from '../sessions/viewer-stream-caps';
import { ViewerStreamService } from '../sessions/viewer-stream.service';
import { GuestSessionsController } from './session-guests.controller';
import { GUEST_SESSION_NOT_SHARED, SessionGuestsService } from './session-guests.service';

/**
 * A guest's ✦ Optimize, `POST /guest-sessions/:id/prompt-optimizations` (project 3504qZwKVUy7ccEQYo3HR, D2–D4), over
 * HTTP with a stubbed DeepSeek and a stubbed database: the live invitation first (the door's one 404), the GUEST's
 * switch and the server key (409), the draft (400), the day's cap (429 PROMPT_OPTIMIZER_DAILY_LIMIT), context read
 * only from the shared transcript's turns (contextUsed TURNS alone, no recap, workspace, project or wiki in the
 * prompt), the collaborator framing, the owner's Translation deciding the language, and the permission mode on the
 * guest page's head. The database half — the real conditional UPDATE, removed/left/Trash — is
 * session-guests-optimizer.pg.spec.ts.
 */

const OWNER = randomUUID();
const GUEST = randomUUID();
const STRANGER = randomUUID();
const SESSION = randomUUID();

type Row = Record<string, unknown>;
let caller: string;
let preferences: Record<string, Row>;
let uses: number;
let sharedTurnReads: Array<{ sessionId: string; take: number }>;

const sharedTurns = [
  { seq: 1, type: RunEventType.USER, payload: { text: 'Why does Google sign-in fail in Safari?' } },
  { seq: 3, type: RunEventType.ASSISTANT, payload: { text: 'The popup is blocked; I switched to a redirect.' } },
];

/** Every read the guest door may make; anything else (a recap, a workspace, a project, run events) is no function here. */
const prisma = {
  sessionGuest: {
    findFirst: async ({ where }: { where: Row }) =>
      where.userId === GUEST && where.sessionId === SESSION
        ? { id: 'guest-row', openedAt: new Date(), session: { ownerId: OWNER }, user: { name: 'Alice' } }
        : null,
    count: async () => 1,
  },
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => ({ preferences: preferences[where.id] ?? null }),
    findUniqueOrThrow: async () => ({ name: 'Lin Wei' }),
  },
  session: {
    findUnique: async ({ select }: { select: Row }) => {
      assert.deepEqual(Object.keys(select), ['permissionMode'], 'the head reads the permission mode and nothing else of the session');
      return { permissionMode: 'acceptEdits' };
    },
  },
  approval: { findMany: async () => [] },
  // countOptimizerUse's conditional UPDATE: passes while today's count is under the cap.
  $executeRaw: async () => {
    if (uses >= GUEST_PROMPT_OPTIMIZER_DAILY_USES) return 0;
    uses += 1;
    return 1;
  },
};

const sessions = {
  getSharedTurnEvents: async (sessionId: string, take: number) => {
    sharedTurnReads.push({ sessionId, take });
    return sharedTurns;
  },
  getSharedTranscript: async () => ({ title: 'A shared conversation', events: [], hasMore: false }),
  getSharedEventsAfter: async () => ({ title: 'A shared conversation', events: [], before: null, after: null, hasMore: false }),
};

@Module({
  controllers: [GuestSessionsController],
  providers: [
    JwtAuthGuard,
    Reflector,
    SessionGuestsService,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: caller }) } },
    { provide: PrismaService, useValue: prisma },
    { provide: SessionsService, useValue: sessions },
    { provide: AttachmentsService, useValue: {} },
    { provide: ViewerStreamService, useValue: {} },
    { provide: ViewerStreamCaps, useValue: {} },
  ],
})
class GuestOptimizerModule {}

type Reply = { content: string };
let replies: Reply[] = [];
let asked: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;
const realBase = process.env.DEEPSEEK_BASE_URL;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'server-key';
  delete process.env.DEEPSEEK_BASE_URL;
  caller = GUEST;
  preferences = {};
  uses = 0;
  sharedTurnReads = [];
  replies = [];
  asked = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.deepseek.com/')) return realFetch(url, init);
    asked.push(JSON.parse(String(init?.body)));
    const reply = replies.shift();
    if (!reply) return new Promise<Response>(() => undefined);
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: reply.content } }] }),
    } as Response);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = realKey;
  if (realBase === undefined) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = realBase;
});

async function boot(t: { after: (fn: () => Promise<void>) => void }) {
  const app = await NestFactory.create(GuestOptimizerModule, { logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await realFetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer signed-in' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Row };
  };
  return { call, optimize: (body: unknown) => call('POST', `/guest-sessions/${SESSION}/prompt-optimizations`, body) };
}

const json = (value: unknown): Reply => ({ content: JSON.stringify(value) });
const plain = (text: string, extra: Row = {}): Reply => json({ segments: [{ text, added: false }], language: 'en', ...extra });

test('a live guest is optimized from the shared turns alone: contextUsed is TURNS, the prompt carries no recap, workspace, project or wiki', async (t) => {
  const { optimize } = await boot(t);
  replies = [plain('Please retry only the tests tagged @flaky, at most twice.')];
  const answer = await optimize({ draft: 'retry the flaky ones' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.text, 'Please retry only the tests tagged @flaky, at most twice.');
  assert.deepEqual(answer.body.contextUsed, [{ kind: 'TURNS', count: 2 }]);
  assert.equal(answer.body.gloss, undefined);
  assert.deepEqual(sharedTurnReads, [{ sessionId: SESSION, take: 200 }], 'the turns come from the shared projection of this session');

  assert.equal(asked.length, 1);
  const [system, user] = asked[0].messages;
  assert.match(system.content, /collaborator/);
  assert.match(system.content, /another person's AI coding agent/);
  assert.match(system.content, /Never add a request that the agent act for its owner/);
  assert.match(system.content, /approving or denying anything, or changing settings, permissions/);
  assert.doesNotMatch(system.content, /Write as the owner/);
  assert.match(user.content, /Recent conversation:\nUSER: Why does Google sign-in fail in Safari\?\nASSISTANT: The popup is blocked/);
  for (const absent of ['Session recap', 'Workspace:', 'Project:', 'Goal:', 'Acceptance criteria', 'Wiki entries']) {
    assert.ok(!user.content.includes(absent), `the prompt carries no "${absent}"`);
  }
  assert.ok(user.content.endsWith('Draft:\nretry the flaky ones'));
  assert.equal(uses, 1, 'one use counted');
});

test('404, the guest door\'s one answer, for a caller with no live invitation; nothing is counted or asked', async (t) => {
  const { optimize } = await boot(t);
  caller = STRANGER;
  const refused = await optimize({ draft: 'retry the flaky ones' });
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.message, GUEST_SESSION_NOT_SHARED);
  // The invitation is checked before the draft: an empty one from a stranger is the same 404.
  const empty = await optimize({ draft: '' });
  assert.equal(empty.status, 404);
  assert.equal(uses, 0);
  assert.equal(asked.length, 0);
});

test('409 PROMPT_OPTIMIZER_OFF on the GUEST\'s switch or no server key; the owner\'s switch does not decide it', async (t) => {
  const { optimize } = await boot(t);
  preferences = { [GUEST]: { promptOptimizer: false } };
  const off = await optimize({ draft: 'retry the flaky ones' });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, 'PROMPT_OPTIMIZER_OFF');

  delete process.env.DEEPSEEK_API_KEY;
  preferences = {};
  const keyless = await optimize({ draft: 'retry the flaky ones' });
  assert.equal(keyless.status, 409);
  assert.equal(keyless.body.code, 'PROMPT_OPTIMIZER_OFF');
  assert.equal(asked.length, 0);
  assert.equal(uses, 0);

  // The owner turned their own ✦ off; the guest's is absent, so on.
  process.env.DEEPSEEK_API_KEY = 'server-key';
  preferences = { [OWNER]: { promptOptimizer: false } };
  replies = [plain('Retry the flaky tests.')];
  const guestOn = await optimize({ draft: 'retry the flaky ones' });
  assert.equal(guestOn.status, 200, JSON.stringify(guestOn.body));
});

test('400 for an empty draft or one over the limit, before a use is counted', async (t) => {
  const { optimize } = await boot(t);
  assert.equal((await optimize({ draft: '   ' })).status, 400);
  assert.equal((await optimize({})).status, 400);
  assert.equal((await optimize({ draft: 'x'.repeat(PROMPT_OPTIMIZER_MAX_DRAFT_CHARS + 1) })).status, 400);
  assert.equal(uses, 0);
  assert.equal(asked.length, 0);
});

test('past the day\'s last use: 429 PROMPT_OPTIMIZER_DAILY_LIMIT with an English message, and DeepSeek is not asked', async (t) => {
  const { optimize } = await boot(t);
  uses = GUEST_PROMPT_OPTIMIZER_DAILY_USES;
  const limited = await optimize({ draft: 'retry the flaky ones' });
  assert.equal(limited.status, 429, JSON.stringify(limited.body));
  assert.equal(limited.body.code, 'PROMPT_OPTIMIZER_DAILY_LIMIT');
  assert.match(String(limited.body.message), /100 drafts in this conversation today/);
  assert.equal(asked.length, 0);
});

test('language: the owner\'s Translation on writes the owner\'s agent language with a gloss in the guest\'s; none when equal; off keeps the draft\'s', async (t) => {
  const { optimize } = await boot(t);

  // Owner: Translation on, agent language English. Guest: Japanese.
  preferences = { [OWNER]: { translationEnabled: true, translationLanguage: 'zh-Hans' }, [GUEST]: { translationLanguage: 'ja' } };
  replies = [plain('Retry the flaky tests.', { gloss: 'フレーキーなテストを再試行してください。' })];
  const glossed = await optimize({ draft: 'フレーキーなテストを再試行' });
  assert.equal(glossed.status, 200, JSON.stringify(glossed.body));
  assert.equal(glossed.body.language, 'en');
  assert.equal(glossed.body.gloss, 'フレーキーなテストを再試行してください。');
  assert.match(asked[0].messages[0].content, /Write the improved prompt in English\. Also write "gloss": the same improved prompt translated into Japanese, for the person writing it to read/);

  // The guest's own language is the agent's: that language, no gloss.
  preferences = { [OWNER]: { translationEnabled: true, translationAgentLanguage: 'de' }, [GUEST]: { translationLanguage: 'de' } };
  replies = [json({ segments: [{ text: 'Bitte wiederhole die Tests.', added: false }], language: 'fr' })];
  const same = await optimize({ draft: 'wiederhole die Tests' });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.language, 'de', 'the agent language, whatever the model names');
  assert.equal(same.body.gloss, undefined);
  assert.match(asked[1].messages[0].content, /Write the improved prompt in German\. Set "language" to "de"\. Do not write "gloss"\./);

  // The owner's Translation off: the draft's own language.
  preferences = { [GUEST]: { translationLanguage: 'ja' } };
  replies = [json({ segments: [{ text: 'Réessaie les tests.', added: false }], language: 'fr' })];
  const off = await optimize({ draft: 'réessaie les tests' });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.language, 'fr');
  assert.equal(off.body.gloss, undefined);
  assert.match(asked[2].messages[0].content, /in the same language as the draft/);
});

test('the guest page\'s head and its following read carry the session\'s permission mode, and nothing about model, account or cost', async (t) => {
  const { call } = await boot(t);
  const head = await call('GET', `/guest-sessions/${SESSION}`);
  assert.equal(head.status, 200, JSON.stringify(head.body));
  assert.equal(head.body.permissionMode, 'acceptEdits');
  const after = await call('GET', `/guest-sessions/${SESSION}/events?after=0`);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.permissionMode, 'acceptEdits');
  for (const body of [head.body, after.body]) {
    for (const key of ['model', 'provider', 'account', 'costUsd', 'providerAccountId']) assert.ok(!(key in body), `no ${key}`);
  }
});
