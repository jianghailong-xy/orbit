import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { AgentProvider, RunEventType, type NormalizedRunEvent } from '@orbit/shared';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RealtimeService } from '../realtime/realtime.service';
import { replyTranslationsSettled } from './reply-translation';
import { SessionsService } from './sessions.service';

/**
 * Settings › Translation, what the agent says (task A2, @orbit/shared translation.ts), with a stubbed DeepSeek:
 *
 *  - a reply the runner stored whole is translated: the result is written into that event's own payload, so
 *    /events/page replays it, and a live TRANSLATION reaches the session's stream;
 *  - a failed translation is a `failed` marker, and Retry translates it again;
 *  - deltas, thinking, tool calls and results, and a sub-agent's report are never translated;
 *  - an approval card's questions, options and description are translated as extra display fields, and an
 *    answer picked or typed in translation is stored — what the runner hands the engine — in English;
 *  - prompt suggestions are translated;
 *  - with translation off, nothing changes.
 *
 * The ingest is the real RunnerApiController.events and the stream the real RealtimeService; only Prisma is a
 * double, an in-memory run_event and approval table.
 */

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION = '019fc086-c7c7-7c92-8215-778ad8a6280a';
const TURN = '019fc086-c7c7-7c92-8215-000000000001';
const TS = '2026-11-12T08:00:00.000Z';

type Row = { sessionId: string; seq: number; type: string; payload: Record<string, unknown>; turnId: string | null; createdAt: Date };
type ApprovalRow = Record<string, unknown> & { id: string; sessionId: string; status: string; input: unknown };

/** DeepSeek, stubbed: answers `ZH[<what it was sent>]`, or fails with 500 while `failing`. */
const deepSeek = { calls: [] as string[], failing: false };
const ZH = (text: string) => `ZH[${text}]`;
const EN = (text: string) => `EN[${text}]`;
function stubDeepSeek() {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === 'system')!.content;
    const text = body.messages.find((m) => m.role === 'user')!.content;
    deepSeek.calls.push(text);
    if (deepSeek.failing) return { ok: false, status: 500, body: null } as Response;
    const intoEnglish = /into English\./.test(system);
    return {
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: intoEnglish ? EN(text) : ZH(text) } }] }),
    } as Response;
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;
const originalKey = process.env.DEEPSEEK_API_KEY;
beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  deepSeek.calls = [];
  deepSeek.failing = false;
  stubDeepSeek();
});
afterEach(async () => {
  await replyTranslationsSettled();
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
});

function world(opts: { translation?: boolean } = {}) {
  const preferences: Record<string, unknown> = opts.translation === false
    ? {}
    : { translationEnabled: true, translationLanguage: 'zh-Hans' };
  const runEvents: Row[] = [];
  const approvals: ApprovalRow[] = [];
  const at = (sessionId: string, seq: number) => runEvents.find((r) => r.sessionId === sessionId && r.seq === seq);
  const runEvent = {
    createMany: async ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const row of data) {
        if (at(row.sessionId, row.seq)) continue;
        runEvents.push({ ...row, payload: structuredClone(row.payload) });
        count += 1;
      }
      return { count };
    },
    findMany: async ({ where }: { where: { sessionId: string; seq?: { in?: number[] } } }) =>
      runEvents.filter((r) => r.sessionId === where.sessionId && (!where.seq?.in || where.seq.in.includes(r.seq))),
    findUnique: async ({ where }: { where: { sessionId_seq: { sessionId: string; seq: number } } }) => {
      const row = at(where.sessionId_seq.sessionId, where.sessionId_seq.seq);
      return row ? structuredClone(row) : null;
    },
    update: async ({ where, data }: { where: { sessionId_seq: { sessionId: string; seq: number } }; data: { payload: Record<string, unknown> } }) => {
      const row = at(where.sessionId_seq.sessionId, where.sessionId_seq.seq)!;
      row.payload = structuredClone(data.payload);
      return { seq: row.seq };
    },
  };
  const approvalMatches = (row: ApprovalRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const approval = {
    findUnique: async () => null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const row = approvals.find((a) => approvalMatches(a, where));
      return row ? structuredClone(row) : null;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      approvals.filter((a) => a.sessionId === where.sessionId).map((a) => structuredClone(a)),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: ApprovalRow = {
        id: `0190a0b0-0000-7000-8000-00000000000${approvals.length + 1}`,
        status: 'PENDING', toolUseId: null, backgroundJobId: null, coordinatorFallback: null, translation: null,
        message: null, answers: null, decidedAt: null, decidedCredentialKind: null, createdAt: new Date(TS),
        ...(data as { sessionId: string; input: unknown }),
      };
      approvals.push(row);
      return structuredClone(row);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = approvals.filter((a) => approvalMatches(a, where));
      for (const row of rows) Object.assign(row, structuredClone(data));
      return { count: rows.length };
    },
    updateManyAndReturn: async () => [],
  };
  const sessionRow = {
    id: SESSION, ownerId: OWNER, status: RunStatus.RUNNING, runtimeSessionId: 'runtime-1', cancelRequestedAt: null,
    runningBgShells: [], runningBgJobs: [], runningSubagents: [], coordinatorContextEpoch: 0,
    assignedRunnerId: RUNNER_ID, provider: AgentProvider.CLAUDE, providerBuiltin: true, workspaceId: null,
    sessionKind: 'ENGINE', taskId: null, retryAttempts: 0, codexAccount: null, claudeAccount: null,
    claudeAccountPinned: false, poolSwitchNotice: null, workspace: { env: null, codexAccount: null, claudeAccount: null },
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION, leaseOwnerMatches: true }],
    $executeRaw: async () => 1,
    runEvent,
    approval,
    toolCall: { createMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }), findMany: async () => [] },
    sessionRequest: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    conversationTurn: { findMany: async () => [], findFirst: async () => null },
    projectCoordinatorWake: { findMany: async () => [] },
    session: {
      findUniqueOrThrow: async () => ({ ...sessionRow }),
      findUnique: async () => ({ ...sessionRow }),
      findFirst: async ({ where }: { where: { id: string; ownerId?: string } }) =>
        where.id === SESSION && (where.ownerId === undefined || where.ownerId === OWNER) ? { ...sessionRow } : null,
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
    user: { findUnique: async () => ({ preferences }) },
    workspacePermissionRule: { findMany: async () => [] },
    modelProvider: { findFirst: async () => null },
    activity: { create: async () => ({}) },
  };
  // The page reads run_event raw; this double answers it newest first, as `ORDER BY seq DESC LIMIT n` would.
  const pageRows = async () =>
    [...runEvents]
      .filter((r) => r.sessionId === SESSION && r.type !== RunEventType.TEXT_DELTA)
      .sort((a, b) => b.seq - a.seq)
      .map((r) => ({ seq: r.seq, type: r.type, payload: structuredClone(r.payload), turnId: r.turnId, createdAt: r.createdAt }));
  const prisma = {
    ...tx,
    $queryRaw: pageRows,
    $executeRawUnsafe: async () => 0, // the realtime NOTIFY
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  };
  const realtime = new RealtimeService(prisma as never, { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined } as never);
  const live: NormalizedRunEvent[] = [];
  realtime.streamForRun(SESSION).subscribe((e) => live.push(e));
  const push = { notifyApprovalRequest: async () => undefined } as never;
  const controller = new RunnerApiController(
    prisma as never,
    { sharedPoolRetryAt: async () => null, loginPoolRetryAt: async () => null } as never,
    realtime,
    push,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  const sessions = new SessionsService(prisma as never, {} as never, realtime);
  const ingest = (events: Array<{ seq: number; type: RunEventType; payload: Record<string, unknown> }>) =>
    controller.events({ id: RUNNER_ID }, SESSION, { events: events.map((e) => ({ ...e, turnId: TURN, ts: TS })) });
  const translations = () => live.filter((e) => e.type === RunEventType.TRANSLATION).map((e) => e.payload);
  const cards = () => live.filter((e) => e.type === RunEventType.APPROVAL_REQUEST).map((e) => e.payload as Record<string, unknown>);
  return { runEvents, approvals, preferences, live, translations, cards, controller, sessions, ingest, at };
}

const REPLY = 'The login button does nothing in Safari because `signInWithPopup` is blocked.';

// ── agent replies ──────────────────────────────────────────────────────────────────────────────────

test('a completed assistant text block is translated, kept on its event for /events/page, and pushed live', async () => {
  const w = world();
  await w.ingest([
    { seq: 1, type: RunEventType.TEXT_DELTA, payload: { text: 'The login ' } },
    { seq: 2, type: RunEventType.ASSISTANT, payload: { text: REPLY } },
  ]);
  await replyTranslationsSettled();

  // One DeepSeek call, for the completed block, with the inline code masked: never the delta.
  assert.deepEqual(deepSeek.calls, ['The login button does nothing in Safari because ⟦0⟧ is blocked.']);
  const expected = { lang: 'zh-Hans', text: ZH('The login button does nothing in Safari because `signInWithPopup` is blocked.') };

  // Durable: the event's own payload, the runner's text untouched beside it, at the runner's seq.
  assert.deepEqual(w.at(SESSION, 2)!.payload, { text: REPLY, translation: expected });
  // No event of its own: run_event holds the runner's seqs and nothing else (the delta is live-only).
  assert.deepEqual(w.runEvents.map((r) => r.seq), [2]);

  // Replayed: the tail page carries it on the assistant event.
  const page = await w.sessions.getEventPage(OWNER, SESSION, { tail: 50 });
  const replayed = page.events.find((e) => e.seq === 2)!;
  assert.deepEqual((replayed.payload as { translation?: unknown }).translation, expected);

  // Live: one seq-0 TRANSLATION naming the event it translates.
  assert.deepEqual(w.translations(), [{ of: 2, ...expected }]);
  const event = w.live.find((e) => e.type === RunEventType.TRANSLATION)!;
  assert.equal(event.seq, 0);
  assert.equal(event.turnId, TURN);
});

test('the same batch sent again is not translated twice', async () => {
  const w = world();
  const batch = [{ seq: 2, type: RunEventType.ASSISTANT, payload: { text: REPLY } }];
  await w.ingest(batch);
  await replyTranslationsSettled();
  await w.ingest(batch);
  await replyTranslationsSettled();
  assert.equal(deepSeek.calls.length, 1);
  assert.equal((w.at(SESSION, 2)!.payload.translation as { text?: string }).text?.startsWith('ZH['), true);
});

test('a failed translation is a failed marker, and Retry translates it', async () => {
  const w = world();
  deepSeek.failing = true;
  await w.ingest([{ seq: 7, type: RunEventType.ASSISTANT, payload: { text: 'Done.' } }]);
  await replyTranslationsSettled();

  assert.deepEqual(w.at(SESSION, 7)!.payload.translation, { lang: 'zh-Hans', failed: true });
  assert.deepEqual(w.translations(), [{ of: 7, lang: 'zh-Hans', failed: true }]);
  const page = await w.sessions.getEventPage(OWNER, SESSION, { tail: 50 });
  assert.deepEqual((page.events[0].payload as { translation?: unknown }).translation, { lang: 'zh-Hans', failed: true });

  deepSeek.failing = false;
  assert.deepEqual(await w.sessions.retryReplyTranslation(OWNER, SESSION, 7), { of: 7, lang: 'zh-Hans' });
  await replyTranslationsSettled();
  assert.deepEqual(w.at(SESSION, 7)!.payload.translation, { lang: 'zh-Hans', text: ZH('Done.') });
  assert.deepEqual(w.translations().at(-1), { of: 7, lang: 'zh-Hans', text: ZH('Done.') });

  // Retry refuses what is not a reply, another owner's session, and an account with translation off.
  await assert.rejects(w.sessions.retryReplyTranslation(OWNER, SESSION, 99), /no reply to translate/);
  await assert.rejects(w.sessions.retryReplyTranslation('33333333-3333-4333-8333-333333333333', SESSION, 7), /session not found/);
  w.preferences.translationEnabled = false;
  await assert.rejects(w.sessions.retryReplyTranslation(OWNER, SESSION, 7), ConflictException);
});

test('tool calls, tool results, thinking, deltas and a sub-agent\'s report are never translated', async () => {
  const w = world();
  await w.ingest([
    { seq: 1, type: RunEventType.THINKING_DELTA, payload: { text: 'thinking about it' } },
    { seq: 2, type: RunEventType.THINKING, payload: { text: 'I should read the file.' } },
    { seq: 3, type: RunEventType.TOOL_USE, payload: { id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } } },
    { seq: 4, type: RunEventType.TOOL_RESULT, payload: { toolUseId: 't1', content: 'a.txt\nb.txt', isError: false } },
    { seq: 5, type: RunEventType.ASSISTANT, payload: { text: 'Report for the caller.', parentToolUseId: 'agent-1' } },
    { seq: 6, type: RunEventType.TEXT_DELTA, payload: { text: 'Here' } },
  ]);
  await replyTranslationsSettled();
  assert.deepEqual(deepSeek.calls, []);
  assert.deepEqual(w.translations(), []);
  for (const row of w.runEvents) assert.equal('translation' in row.payload, false, `${row.type} was translated`);
  // And Retry will not translate one either.
  await assert.rejects(w.sessions.retryReplyTranslation(OWNER, SESSION, 3), /no reply to translate/);
});

test('prompt suggestions are translated, the engine\'s and Orbit\'s alike', async () => {
  const w = world();
  await w.ingest([
    { seq: 10, type: RunEventType.PROMPT_SUGGESTION, payload: { text: 'Run the tests', source: 'engine' } },
    { seq: 11, type: RunEventType.PROMPT_SUGGESTION, payload: { text: 'Open a PR', source: 'orbit' } },
  ]);
  await replyTranslationsSettled();
  assert.deepEqual(w.at(SESSION, 10)!.payload, { text: 'Run the tests', source: 'engine', translation: { lang: 'zh-Hans', text: ZH('Run the tests') } });
  assert.deepEqual(w.at(SESSION, 11)!.payload, { text: 'Open a PR', source: 'orbit', translation: { lang: 'zh-Hans', text: ZH('Open a PR') } });
  assert.deepEqual(w.translations().map((p) => (p as { of: number }).of).sort(), [10, 11]);
});

// ── question cards and approvals ───────────────────────────────────────────────────────────────────

const QUESTION = {
  questions: [
    {
      question: 'Which database should I use?',
      header: 'Database',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'The one we run in production' },
        { label: 'SQLite', description: 'A file next to the app' },
      ],
    },
  ],
};

async function askQuestion(w: ReturnType<typeof world>) {
  await w.controller.createApproval({ id: RUNNER_ID }, SESSION, { toolName: 'AskUserQuestion', input: QUESTION, toolUseId: 'ask-1' });
  await replyTranslationsSettled();
  return w.approvals[0];
}

test('a question card is published at once, then again with its question and options translated', async () => {
  const w = world();
  const row = await askQuestion(w);
  const [first, second] = w.cards();
  assert.equal(first.translation, undefined, 'the card is not held back for its translation');
  const translation = {
    lang: 'zh-Hans',
    questions: [{
      question: ZH('Which database should I use?'),
      header: ZH('Database'),
      options: [
        { label: ZH('Postgres'), description: ZH('The one we run in production') },
        { label: ZH('SQLite'), description: ZH('A file next to the app') },
      ],
    }],
  };
  assert.deepEqual(second.translation, translation);
  assert.equal(second.id, first.id);
  assert.deepEqual(second.input, QUESTION, 'input stays the engine\'s English');
  assert.deepEqual(row.translation, translation);
  const [listed] = await w.sessions.listApprovals(OWNER, SESSION);
  assert.deepEqual(listed?.translation, translation);
});

test('an approval\'s description is translated', async () => {
  const w = world();
  await w.controller.createApproval({ id: RUNNER_ID }, SESSION, {
    toolName: 'Bash', input: { command: 'rm -rf build', description: 'Delete the build folder' }, toolUseId: 'bash-1',
  });
  await replyTranslationsSettled();
  assert.deepEqual(w.cards()[1]?.translation, { lang: 'zh-Hans', description: ZH('Delete the build folder') });
  assert.deepEqual(deepSeek.calls, ['Delete the build folder'], 'the command itself is never sent');
});

test('a translated option the owner picks is stored as the original label', async () => {
  const w = world();
  const row = await askQuestion(w);
  await w.sessions.decideApproval(OWNER, SESSION, row.id, {
    behavior: 'allow',
    answers: { [ZH('Which database should I use?')]: [ZH('SQLite')] },
  });
  assert.deepEqual(w.approvals[0].answers, { 'Which database should I use?': ['SQLite'] });
});

test('an answer the owner types is translated into English; a failure records nothing until Send as written', async () => {
  const w = world();
  const row = await askQuestion(w);
  const typed = { behavior: 'allow' as const, answers: { 'Which database should I use?': ['用 MySQL'] }, message: '谢谢' };

  deepSeek.failing = true;
  await assert.rejects(w.sessions.decideApproval(OWNER, SESSION, row.id, typed), (error: unknown) => {
    assert.ok(error instanceof UnprocessableEntityException);
    assert.equal((error.getResponse() as { code: string }).code, 'TRANSLATION_FAILED');
    return true;
  });
  assert.equal(w.approvals[0].status, 'PENDING', 'nothing reached the engine');

  deepSeek.failing = false;
  await w.sessions.decideApproval(OWNER, SESSION, row.id, typed);
  assert.deepEqual(w.approvals[0].answers, { 'Which database should I use?': [EN('用 MySQL')] });
  assert.equal(w.approvals[0].message, EN('谢谢'));
});

test('Send as written stores the owner\'s own words untranslated', async () => {
  const w = world();
  const row = await askQuestion(w);
  deepSeek.failing = true;
  await w.sessions.decideApproval(OWNER, SESSION, row.id, {
    behavior: 'allow', answers: { [ZH('Which database should I use?')]: ['用 MySQL'] }, sendAsWritten: true,
  });
  assert.deepEqual(w.approvals[0].answers, { 'Which database should I use?': ['用 MySQL'] });
});

// ── translation off ────────────────────────────────────────────────────────────────────────────────

test('with translation off nothing is translated and nothing changes', async () => {
  const w = world({ translation: false });
  await w.ingest([
    { seq: 1, type: RunEventType.ASSISTANT, payload: { text: REPLY } },
    { seq: 2, type: RunEventType.PROMPT_SUGGESTION, payload: { text: 'Run the tests', source: 'orbit' } },
  ]);
  const row = await askQuestion(w);
  await w.sessions.decideApproval(OWNER, SESSION, row.id, {
    behavior: 'allow', answers: { 'Which database should I use?': ['Something else'] }, message: 'thanks',
  });
  await replyTranslationsSettled();

  assert.deepEqual(deepSeek.calls, []);
  assert.deepEqual(w.translations(), []);
  assert.deepEqual(w.at(SESSION, 1)!.payload, { text: REPLY });
  assert.deepEqual(w.at(SESSION, 2)!.payload, { text: 'Run the tests', source: 'orbit' });
  assert.equal(w.cards().length, 1, 'the card is published once');
  assert.equal('translation' in w.cards()[0], false);
  assert.equal(w.approvals[0].translation, null);
  assert.deepEqual(w.approvals[0].answers, { 'Which database should I use?': ['Something else'] });
  assert.equal(w.approvals[0].message, 'thanks');
  const [listed] = await w.sessions.listApprovals(OWNER, SESSION);
  assert.equal(listed ? 'translation' in listed : true, false);
  await assert.rejects(w.sessions.retryReplyTranslation(OWNER, SESSION, 1), ConflictException);
});

test('without a server key nothing is translated whatever the preference says', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const w = world();
  await w.ingest([{ seq: 1, type: RunEventType.ASSISTANT, payload: { text: REPLY } }]);
  await replyTranslationsSettled();
  assert.deepEqual(deepSeek.calls, []);
  assert.deepEqual(w.at(SESSION, 1)!.payload, { text: REPLY });
});

// ── across replicas ────────────────────────────────────────────────────────────────────────────────

test('a translation too big for a NOTIFY reaches the other replicas read back from the event it translates', async () => {
  const notified: string[] = [];
  const big = 'word '.repeat(3000);
  const row = { seq: 5, payload: { text: 'x', translation: { lang: 'zh-Hans', text: big } }, turnId: TURN };
  const prisma = {
    $executeRawUnsafe: async (_sql: string, _channel: string, payload: string) => { notified.push(payload); return 0; },
    runEvent: { findUnique: async () => row },
  };
  const origin = new RealtimeService(prisma as never, {} as never);
  origin.publish(SESSION, { seq: 0, type: RunEventType.TRANSLATION, payload: { of: 5, lang: 'zh-Hans', text: big }, ts: TS });
  assert.deepEqual(JSON.parse(notified[0]), { i: origin.instance, r: SESSION, x: 5 });

  const replica = new RealtimeService(prisma as never, {} as never);
  const seen: NormalizedRunEvent[] = [];
  replica.streamForRun(SESSION).subscribe((e) => seen.push(e));
  (replica as unknown as { onNotify(channel: string, payload: string): void }).onNotify('orbit_event', notified[0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, RunEventType.TRANSLATION);
  assert.deepEqual(seen[0].payload, { of: 5, lang: 'zh-Hans', text: big });
});
