import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PROMPT_OPTIMIZER_MAX_REPLYING_TO_CHARS, RunEventType } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UsersController } from '../users/users.controller';
import { WikiRetrieval } from '../wiki/wiki-retrieval';
import { PromptOptimizerController, PromptOptimizerService } from './prompt-optimizer';

/**
 * Prompt optimizer, the server half (docs/prompt-optimizer-design.md, "Wire contract"), over HTTP with
 * a stubbed DeepSeek: the switch (absent = on, false = off) and the key (409), `promptOptimizerAvailable` on
 * `/users/me`, the owner's own session, workspace and project (404), the draft's size (400), each 422
 * reason, `contextUsed` naming exactly the sources there were, protected code surviving, and
 * Translation on giving the account's agent language (English by default) with a gloss in the owner's.
 */

const OWNER = randomUUID();
const STRANGER = randomUUID();
const SESSION = randomUUID();
const BARE_SESSION = randomUUID();
const WORKSPACE = randomUUID();
const PLAIN_WORKSPACE = randomUUID();
const PROJECT = randomUUID();
const TASK_PROJECT = randomUUID();
const SPACE = randomUUID();
const FOREIGN_SESSION = randomUUID();
const FOREIGN_WORKSPACE = randomUUID();
const FOREIGN_PROJECT = randomUUID();

type Row = Record<string, unknown>;
let preferences: Row;

const sessions: Row[] = [
  {
    id: SESSION, ownerId: OWNER, recapText: 'Fixed the Safari sign-in; tests pass.', workspaceId: WORKSPACE,
    task: { projectId: TASK_PROJECT }, coordinatorForProject: null,
  },
  { id: BARE_SESSION, ownerId: OWNER, recapText: null, workspaceId: null, task: null, coordinatorForProject: null },
  { id: FOREIGN_SESSION, ownerId: STRANGER, recapText: 'secret', workspaceId: FOREIGN_WORKSPACE, task: null, coordinatorForProject: null },
];
const workspaces: Row[] = [
  { id: WORKSPACE, ownerId: OWNER, deletedAt: null, name: 'orbit', repoUrl: 'https://github.com/example/orbit.git' },
  { id: PLAIN_WORKSPACE, ownerId: OWNER, deletedAt: null, name: 'scratch', repoUrl: null },
  { id: FOREIGN_WORKSPACE, ownerId: STRANGER, deletedAt: null, name: 'theirs', repoUrl: null },
];
const projects: Row[] = [
  { id: PROJECT, ownerId: OWNER, title: 'Picked project', goal: 'Ship it', acceptanceCriterionDefinitions: [] },
  {
    id: TASK_PROJECT, ownerId: OWNER, title: 'Sign-in fixes', goal: 'Google sign-in works in every browser',
    acceptanceCriterionDefinitions: [{ text: 'Safari signs in' }, { text: 'Firefox signs in' }],
  },
  { id: FOREIGN_PROJECT, ownerId: STRANGER, title: 'Theirs', goal: null, acceptanceCriterionDefinitions: [] },
];
const runEvents: Row[] = [
  { seq: 1, type: RunEventType.USER, payload: { text: 'Why does Google sign-in fail in Safari?' } },
  { seq: 2, type: RunEventType.TOOL_USE, payload: { name: 'Read', input: { path: 'x' } } },
  { seq: 3, type: RunEventType.ASSISTANT, payload: { text: 'The popup is blocked; I switched to a redirect.' } },
];
let wikiSearches: Row[] = [];

const pick = (rows: Row[], where: Row) =>
  rows.find((row) => Object.entries(where).every(([key, want]) => row[key] === want)) ?? null;

const prisma = {
  user: {
    findUnique: async () => ({
      id: OWNER, email: 'owner@example.test', name: 'Owner', createdAt: new Date(0), role: 'USER',
      preferences, avatar: null, passwordHash: 'scrypt-hash', identities: [],
    }),
    update: async (args: { data: { preferences: Row } }) => {
      preferences = args.data.preferences;
      return { id: OWNER, email: 'owner@example.test', preferences, avatar: null, passwordHash: 'scrypt-hash', identities: [] };
    },
  },
  session: { findFirst: async ({ where }: { where: Row }) => pick(sessions, where) },
  workspace: { findFirst: async ({ where }: { where: Row }) => pick(workspaces, where) },
  project: { findFirst: async ({ where }: { where: Row }) => pick(projects, where) },
  runEvent: {
    findMany: async ({ where }: { where: { sessionId: string; type: { in: string[] } } }) =>
      where.sessionId === SESSION ? runEvents.filter((e) => where.type.in.includes(e.type as string)).reverse() : [],
  },
  wikiSpaceWorkspace: { findFirst: async () => null },
  wikiSpace: {
    findFirst: async ({ where }: { where: Row }) =>
      where.ownerId === OWNER && where.repoUrlNorm === 'github.com/example/orbit' ? { id: SPACE } : null,
  },
  // The preferences PATCH reads the row it updates under a lock, inside one transaction (users.controller.ts).
  $queryRaw: async () => [{ preferences }],
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
};

const wiki = {
  search: async (request: Row) => {
    wikiSearches.push(request);
    return {
      q: String(request.q), semantic: false,
      hits: [
        { title: 'Safari blocks popups', summary: 'Use signInWithRedirect on WebKit.' },
        { title: 'Login page', summary: 'src/web/src/pages/LoginPage.tsx owns the buttons.' },
        { title: 'Third', summary: 'Three.' },
        { title: 'Fourth', summary: 'Never read.' },
      ],
    };
  },
};

@Module({
  controllers: [UsersController, PromptOptimizerController],
  providers: [
    JwtAuthGuard,
    Reflector,
    PromptOptimizerService,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER }) } },
    { provide: PrismaService, useValue: prisma },
    { provide: WikiRetrieval, useValue: wiki },
  ],
})
class OptimizerModule {}

/** What DeepSeek is asked, and how it answers the next call. */
type Reply = { content?: string; finish?: string } | number | 'hang' | 'network';
let replies: Reply[] = [];
let asked: Array<{ url: string; headers: Record<string, string>; body: { messages: Array<{ role: string; content: string }>; response_format?: unknown } }> = [];
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;
const realBase = process.env.DEEPSEEK_BASE_URL;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'server-key';
  delete process.env.DEEPSEEK_BASE_URL;
  preferences = { promptOptimizer: true };
  replies = [];
  asked = [];
  wikiSearches = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.deepseek.com/')) return realFetch(url, init);
    asked.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift();
    if (reply === 'hang' || reply === undefined) return new Promise<Response>(() => undefined);
    if (reply === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (typeof reply === 'number') return Promise.resolve({ ok: false, status: reply, body: null } as Response);
    return Promise.resolve({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: reply.finish ?? 'stop', message: { content: reply.content } }] }),
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
  const app = await NestFactory.create(OptimizerModule, { logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  const call = (method: string, path: string, body?: unknown) =>
    realFetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer signed-in' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    call,
    optimize: async (body: unknown) => {
      const response = await call('POST', '/prompt-optimizations', body);
      return { status: response.status, body: (await response.json()) as Row };
    },
  };
}

const json = (value: unknown): Reply => ({ content: JSON.stringify(value) });
const plain = (text: string, extra: Row = {}): Reply => json({ segments: [{ text, added: false }], language: 'en', ...extra });

test('me says whether the server can optimize, and the switch persists through the preferences patch; absent is on', async (t) => {
  const { call } = await boot(t);
  preferences = { theme: 'dark' };
  const me = (await (await call('GET', '/users/me')).json()) as Row;
  assert.equal(me.promptOptimizerAvailable, true);
  assert.equal((me.preferences as Row).promptOptimizer, undefined, 'absent: on');

  const off = await call('PATCH', '/users/me/preferences', { promptOptimizer: false });
  assert.equal(off.status, 200, await off.clone().text());
  const account = (await off.json()) as Row;
  assert.equal((account.preferences as Row).promptOptimizer, false);
  assert.equal(account.promptOptimizerAvailable, true);
  assert.equal(preferences.promptOptimizer, false, 'turning it off writes false');
  assert.equal(preferences.theme, 'dark', 'the other preferences stand');

  const malformed = await call('PATCH', '/users/me/preferences', { promptOptimizer: 'yes' });
  assert.equal(malformed.status, 400, await malformed.text());

  delete process.env.DEEPSEEK_API_KEY;
  const keyless = (await (await call('GET', '/users/me')).json()) as Row;
  assert.equal(keyless.promptOptimizerAvailable, false);
});

test('409 PROMPT_OPTIMIZER_OFF: the switch false, or no server key; DeepSeek is not asked', async (t) => {
  const { optimize } = await boot(t);
  preferences = { promptOptimizer: false };
  const off = await optimize({ draft: 'fix the login' });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, 'PROMPT_OPTIMIZER_OFF');
  preferences = {};
  delete process.env.DEEPSEEK_API_KEY;
  const keyless = await optimize({ draft: 'fix the login' });
  assert.equal(keyless.status, 409);
  assert.equal(keyless.body.code, 'PROMPT_OPTIMIZER_OFF');
  assert.equal(asked.length, 0);
});

test('on by default: an account whose preferences have no promptOptimizer key is optimized', async (t) => {
  const { optimize } = await boot(t);
  preferences = { theme: 'dark' };
  replies = [plain('Fix the login.')];
  const answer = await optimize({ draft: 'fix the login' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.text, 'Fix the login.');
  assert.equal(asked.length, 1);
});

test('404 for a session, workspace or project the caller does not own; nothing of theirs is read or sent', async (t) => {
  const { optimize } = await boot(t);
  for (const body of [
    { draft: 'x', sessionId: FOREIGN_SESSION },
    { draft: 'x', workspaceId: FOREIGN_WORKSPACE },
    { draft: 'x', projectId: FOREIGN_PROJECT },
    { draft: 'x', sessionId: randomUUID() },
  ]) {
    const refused = await optimize(body);
    assert.equal(refused.status, 404, JSON.stringify(body));
  }
  assert.equal(asked.length, 0);
});

test('400 for an empty draft or one over 8,000 characters; 8,000 exactly is taken', async (t) => {
  const { optimize } = await boot(t);
  for (const draft of ['', '   \n', 'x'.repeat(8001)]) {
    const refused = await optimize({ draft });
    assert.equal(refused.status, 400, JSON.stringify(draft.slice(0, 10)));
  }
  assert.equal((await optimize({})).status, 400, 'no draft at all');
  assert.equal(asked.length, 0);
  replies = [plain('y'.repeat(10))];
  assert.equal((await optimize({ draft: 'x'.repeat(8000) })).status, 200);
});

test('422 PROMPT_OPTIMIZATION_FAILED names the reason: HTTP, NETWORK, EMPTY, TRUNCATED, MALFORMED', async (t) => {
  const { optimize } = await boot(t);
  const cases: Array<[Reply, string]> = [
    [500, 'HTTP'],
    ['network', 'NETWORK'],
    [{ content: '' }, 'EMPTY'],
    [{ content: '{"segments": [{"text": "cut', finish: 'length' }, 'TRUNCATED'],
    [{ content: 'Here is a better prompt: fix the login' }, 'MALFORMED'],
    [json({ segments: [] }), 'MALFORMED'],
    [json({ language: 'en' }), 'MALFORMED'],
    [json({ segments: [{ added: true }] }), 'MALFORMED'],
    [plain('Fix the login and check ⟦0⟧ and ⟦0⟧'), 'MALFORMED'],
  ];
  for (const [reply, reason] of cases) {
    replies = [reply];
    const failed = await optimize({ draft: 'fix the login in `LoginPage.tsx`' });
    assert.equal(failed.status, 422, `${reason}: ${JSON.stringify(failed.body)}`);
    assert.equal(failed.body.code, 'PROMPT_OPTIMIZATION_FAILED');
    assert.equal(failed.body.reason, reason, JSON.stringify(reply));
  }
});

test('422 TIMEOUT when DeepSeek takes longer than the hard timeout', async () => {
  const service = new PromptOptimizerService(prisma as never, wiki as never);
  replies = ['hang'];
  await assert.rejects(
    service.optimize(OWNER, { draft: 'fix the login' }, { timeoutMs: 20 }),
    (err: { getStatus(): number; getResponse(): Row }) => {
      assert.equal(err.getStatus(), 422);
      assert.equal(err.getResponse().code, 'PROMPT_OPTIMIZATION_FAILED');
      assert.equal(err.getResponse().reason, 'TIMEOUT');
      return true;
    },
  );
});

test('a session supplies every source it has, and contextUsed lists exactly those; the call is JSON on the server key', async (t) => {
  const { optimize } = await boot(t);
  replies = [json({
    segments: [
      { text: 'Fix the Google sign-in in Safari', added: false },
      { text: ' by using signInWithRedirect on WebKit', added: true },
      { text: '.', added: false },
    ],
    language: 'en',
  })];
  const answer = await optimize({ draft: 'fix sign-in', sessionId: SESSION });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    segments: [
      { text: 'Fix the Google sign-in in Safari', added: false },
      { text: ' by using signInWithRedirect on WebKit', added: true },
      { text: '.', added: false },
    ],
    text: 'Fix the Google sign-in in Safari by using signInWithRedirect on WebKit.',
    language: 'en',
    contextUsed: [
      { kind: 'TURNS', count: 2 },
      { kind: 'RECAP' },
      { kind: 'PROJECT', title: 'Sign-in fixes' },
      { kind: 'WIKI', count: 3 },
      { kind: 'WORKSPACE', name: 'orbit' },
    ],
  });
  const [request] = asked;
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer server-key', 'only the server key');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  const task = request.body.messages[1].content;
  for (const expected of [
    'Workspace: orbit',
    'Project: Sign-in fixes',
    'Goal: Google sign-in works in every browser',
    '1. Safari signs in',
    '2. Firefox signs in',
    'Session recap:\nFixed the Safari sign-in; tests pass.',
    'USER: Why does Google sign-in fail in Safari?',
    'ASSISTANT: The popup is blocked; I switched to a redirect.',
    '- Safari blocks popups: Use signInWithRedirect on WebKit.',
    'Draft:\nfix sign-in',
  ]) assert.ok(task.includes(expected), `the task carries ${JSON.stringify(expected)}`);
  assert.ok(!task.includes('Fourth'), 'at most three wiki entries');
  assert.deepEqual(wikiSearches, [{ ownerId: OWNER, spaceId: SPACE, q: 'fix sign-in', limit: 3 }]);
  const system = request.body.messages[0].content;
  assert.match(system, /never invent file paths/);
  assert.match(system, /Do not answer, carry out or comment on the request/);
});

test('contextUsed names only what was there: a picked workspace with no wiki, a picked project, a bare session, nothing', async (t) => {
  const { optimize } = await boot(t);
  replies = [plain('A'), plain('B'), plain('C'), plain('D')];
  assert.deepEqual((await optimize({ draft: 'x', workspaceId: PLAIN_WORKSPACE })).body.contextUsed, [
    { kind: 'WORKSPACE', name: 'scratch' },
  ]);
  assert.deepEqual((await optimize({ draft: 'x', workspaceId: PLAIN_WORKSPACE, projectId: PROJECT })).body.contextUsed, [
    { kind: 'PROJECT', title: 'Picked project' },
    { kind: 'WORKSPACE', name: 'scratch' },
  ]);
  assert.deepEqual((await optimize({ draft: 'x', sessionId: BARE_SESSION })).body.contextUsed, []);
  assert.deepEqual((await optimize({ draft: 'x' })).body.contextUsed, []);
  assert.deepEqual(wikiSearches, [], 'no wiki space: the wiki is not searched');
  assert.equal(asked[3].body.messages[1].content, 'Draft:\nx');
});

test('a reply to a card carries what it answers, in front of the draft, cut to the most the server reads', async (t) => {
  const { optimize } = await boot(t);
  replies = [plain('A'), plain('B'), plain('C')];
  const question = 'Runner full: which way should the subtitle go?\n- Add the count — "Runner full · 16/16"';
  assert.equal((await optimize({ draft: 'mock it first', sessionId: BARE_SESSION, replyingTo: `  ${question}\n` })).status, 200);
  assert.equal(
    asked[0].body.messages[1].content,
    `The draft is the owner's reply to this, which the agent is waiting on:\n${question}\n\n` +
      'Keep it a reply to that: make clear which question or option it answers, and do not turn it into a new request.' +
      '\n\nDraft:\nmock it first',
  );
  await optimize({ draft: 'x', replyingTo: 'q'.repeat(PROMPT_OPTIMIZER_MAX_REPLYING_TO_CHARS + 50) });
  assert.ok(asked[1].body.messages[1].content.includes(`${'q'.repeat(PROMPT_OPTIMIZER_MAX_REPLYING_TO_CHARS)}\n\nKeep`));
  assert.ok(!asked[1].body.messages[1].content.includes('q'.repeat(PROMPT_OPTIMIZER_MAX_REPLYING_TO_CHARS + 1)));
  // Blank says nothing.
  await optimize({ draft: 'x', replyingTo: '  ' });
  assert.equal(asked[2].body.messages[1].content, 'Draft:\nx');
});

test('code blocks, inline code and URLs never reach the model and come back byte for byte', async (t) => {
  const { optimize } = await boot(t);
  const fence = '```ts\nconst a = "保留";\n```';
  const draft = `看一下 \`signInWithPopup\` 和 https://example.test/a?b=1\n${fence}`;
  replies = [json({
    segments: [
      { text: 'Check ⟦0⟧ and ⟦1⟧', added: false },
      { text: ' in the login page', added: true },
      { text: ':\n⟦2⟧', added: false },
    ],
    language: 'zh-Hans',
  })];
  const answer = await optimize({ draft });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const sent = asked[0].body.messages[1].content;
  assert.ok(!sent.includes('signInWithPopup') && !sent.includes('example.test') && !sent.includes('保留'));
  assert.equal(answer.body.text, `Check \`signInWithPopup\` and https://example.test/a?b=1 in the login page:\n${fence}`);
  assert.equal((answer.body.segments as Row[])[2].text, `:\n${fence}`);
  // Translation off: the draft's own language, and no gloss.
  assert.equal(answer.body.language, 'zh-Hans');
  assert.equal('gloss' in answer.body, false);
});

test('Translation on: the default agent language (English) plus a gloss in the owner\'s language, from the same call', async (t) => {
  const { optimize } = await boot(t);
  preferences = { promptOptimizer: true, translationEnabled: true, translationLanguage: 'ja' };
  replies = [json({
    segments: [{ text: 'Fix the sign-in in ⟦0⟧.', added: false }],
    language: 'ja',
    gloss: '⟦0⟧ のサインインを直してください。',
  })];
  const answer = await optimize({ draft: '`LoginPage.tsx` のサインインを直して' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.language, 'en', 'the agent language whatever the model called it');
  assert.equal(answer.body.text, 'Fix the sign-in in `LoginPage.tsx`.');
  assert.equal(answer.body.gloss, '`LoginPage.tsx` のサインインを直してください。');
  assert.equal(asked.length, 1, 'one call');
  const system = asked[0].body.messages[0].content;
  assert.match(system, /in English/);
  assert.match(system, /Japanese/);
  assert.match(system, /"gloss"/);

  // A gloss missing under Translation is not the contract's answer.
  replies = [plain('Fix it')];
  const noGloss = await optimize({ draft: 'なおして' });
  assert.equal(noGloss.status, 422);
  assert.equal(noGloss.body.reason, 'MALFORMED');
});

test('Translation on with a chosen agent language: the prompt in it, the gloss in the owner\'s; the same two languages give no gloss', async (t) => {
  const { optimize } = await boot(t);
  preferences = { promptOptimizer: true, translationEnabled: true, translationLanguage: 'zh-Hans', translationAgentLanguage: 'ja' };
  replies = [json({
    segments: [{ text: 'ログインページのサインインを直してください。', added: false }],
    language: 'en',
    gloss: '修复登录页的登录。',
  })];
  const answer = await optimize({ draft: '修一下登录' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.language, 'ja', 'the agent language, whatever the model called it');
  assert.equal(answer.body.gloss, '修复登录页的登录。');
  const system = asked[0].body.messages[0].content;
  assert.match(system, /Write the improved prompt in Japanese\./);
  assert.match(system, /translated into Chinese \(Simplified\)/);
  assert.match(system, /set "language" to "ja"/);
  assert.doesNotMatch(system, /English/);

  // The owner's language the agent's: nothing is translated, so the draft's own language and no gloss.
  preferences = { promptOptimizer: true, translationEnabled: true, translationLanguage: 'ja', translationAgentLanguage: 'ja' };
  replies = [json({ segments: [{ text: 'サインインを直してください。', added: false }], language: 'ja' })];
  const same = await optimize({ draft: 'サインインを直して' });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.language, 'ja');
  assert.equal('gloss' in same.body, false);
  assert.match(asked[1].body.messages[0].content, /same language as the draft/);
});
