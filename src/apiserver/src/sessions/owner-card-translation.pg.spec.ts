/**
 * OWNER CARDS OUTSIDE A SESSION ARE TRANSLATED (project 'Translate every owner card', criterion 2; decisions 1A–5A).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/owner-card-translation.pg.spec.ts
 *
 * For both a coordinator's question (ask_owner → ProjectOpenItemService.askOwner, read through the open-items view)
 * and an owner request (request_owner_action → OwnerRequestsService.file, read through the owner's list), against the
 * real schema (migration 1070) and the owner's real preferences row. DeepSeek is stubbed.
 *
 *   (a) translated after filing: every agent-written field is stored in `translation` in the owner's language,
 *       the card's own fields are unchanged, the refresh event is published, and the read serves it; code, URLs
 *       and a step's command and link stay verbatim;
 *   (b) a failed translation is stored as `{ lang, failed: true }` and the card is served in the original;
 *   (c) translation off: nothing is asked of the translator and no translation is stored or served;
 *   (d) the switch turned on after filing: reading the still-open card queues one translation — two reads while
 *       it runs still translate the card once — and the next read serves it;
 *   (e) a card that has ended (answered question, done request) is not translated on read;
 *   (f) a question's translation in a language the owner no longer reads is served as stored, with no translated
 *       row title or detail line beside it.
 *
 * A translated question's row is served a translated `title` too ("Coordinator asks: " kept in English) beside a
 * whole translation in the owner's language, and none beside a failed one, an absent one or another language's.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { resetTranslationBreaker } from './translation';

import { CreatorType, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { OwnerSecretsService } from '../owner-requests/owner-secrets.service';
import { replyTranslationsSettled } from './reply-translation';
import { SessionsService } from './sessions.service';

// The translator's circuit breaker is the process's: each test starts with it closed and nothing counted.
beforeEach(() => resetTranslationBreaker());

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
process.env.PROVIDER_SECRET_KEY ??= 'owner-card-translation-pg-spec-key';

const ON = { translationEnabled: true, translationLanguage: 'zh-Hans' };
const OFF = { translationEnabled: false, translationLanguage: 'zh-Hans' };

const QUESTION = {
  question: 'Reopen the rollout? See `deploy.sh` and https://example.test/runbook',
  options: [{ label: 'Reopen now', description: 'Accept the cost.' }, { label: 'Wait' }],
  ifUnanswered: 'the rollout stays paused',
};
const DECISION = {
  kind: 'DECISION' as const,
  title: 'Pick a region',
  why: 'The deploy needs one.',
  ifUnanswered: 'nothing is deployed',
  options: [{ label: 'us-east', description: 'Closest to users.' }, { label: 'eu-west' }],
};
const STEPS = {
  kind: 'MANUAL_STEP' as const,
  title: 'Sign in to the registry',
  why: 'The push needs a login.',
  steps: [
    { text: 'Run the login', command: 'docker login ghcr.io' },
    { text: 'Open the token page', link: 'https://github.com/settings/tokens' },
  ],
  verifyHint: 'docker pull works',
};

/** What the translator was asked, in order, and how it answers: `ZH[text]`, a 500 while `failing`, or held
 *  until `gate` resolves. */
const asked: string[] = [];
let failing = false;
let gate: Promise<void> | null = null;
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;

const zh = (text: string) => `ZH[${text}]`;

async function settle(): Promise<void> {
  // The filing reads the owner's languages before it queues, so the queue may still be empty for a moment.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await replyTranslationsSettled();
  }
}

test('owner cards outside a session are translated, once, whole or failed', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  process.env.DEEPSEEK_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('https://api.deepseek.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const text = body.messages.find((m) => m.role === 'user')!.content;
    asked.push(text);
    if (gate) await gate;
    if (failing) return { ok: false, status: 500, body: null } as Response;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: zh(text) } }] }) } as Response;
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = realKey;
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const published: string[] = [];
  const realtime = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === 'publishForUser') return (_owner: string, type: string, id: string) => { published.push(`${type}:${id}`); };
      if (key === 'publishSessionUpdated') return (id: string) => { published.push(`session:${id}`); };
      return () => undefined;
    },
  }) as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const items = new ProjectOpenItemService(prisma, sessions, undefined, realtime);
  const requests = new OwnerRequestsService(prisma, new OwnerSecretsService(prisma), undefined, undefined, realtime);

  const p = await account(db);
  const prefer = (preferences: object) => db.user.update({ where: { id: p.ownerId }, data: { preferences } });
  const reset = async () => {
    await settle();
    asked.length = 0;
    published.length = 0;
    failing = false;
    resetTranslationBreaker();
    gate = null;
  };
  const ask = async (key: string) =>
    (await items.askOwner(p.ownerId, p.projectId, p.coordinatorSessionId, { ...QUESTION, blocksTaskIds: [], clientQuestionId: key })).itemId;
  const openRow = async (itemId: string) => {
    const view = await items.list(p.ownerId, p.projectId);
    const row = view.needsYou.find((r) => r.itemId === itemId);
    assert.ok(row, 'the question is in needsYou');
    return row;
  };
  const listed = async (id: string) => {
    const row = (await requests.list(p.ownerId, 'all')).requests.find((r) => r.id === id);
    assert.ok(row, 'the request is in the owner\'s list');
    return row;
  };
  const stored = async (table: 'project_open_item' | 'owner_request', id: string) =>
    (await sql.query(`SELECT translation FROM ${table} WHERE id = $1`, [id])).rows[0].translation as unknown;

  const translatedQuestion = {
    lang: 'zh-Hans',
    question: 'ZH[Reopen the rollout? See ⟦0⟧ and ⟦1⟧]'
      .replace('⟦0⟧', '`deploy.sh`').replace('⟦1⟧', 'https://example.test/runbook'),
    options: [{ label: zh('Reopen now'), description: zh('Accept the cost.') }, { label: zh('Wait') }],
    ifUnanswered: zh('the rollout stays paused'),
  };
  // What the open-items read serves: the stored translation, the detail line built from its ifUnanswered and the
  // row title built from its question, Orbit's own "If you don’t answer:" and "Coordinator asks: " kept in English.
  const servedQuestion = {
    ...translatedQuestion,
    detailLine: `If you don’t answer: ${zh('the rollout stays paused')}`,
    title: `Coordinator asks: ${translatedQuestion.question}`,
  };

  await t.test('(a) a question and a request are translated after filing and served with it', async () => {
    await reset();
    await prefer(ON);
    const itemId = await ask('a');
    const decision = await requests.file(p.ownerId, p.workerSessionId, { ...DECISION, clientRequestId: 'a-decision' });
    const steps = await requests.file(p.ownerId, p.workerSessionId, { ...STEPS, clientRequestId: 'a-steps' });
    await settle();

    assert.ok(!asked.some((text) => text.includes('deploy.sh') || text.includes('https://')),
      'code and links never reach the translator');
    assert.ok(!asked.some((text) => text.includes('docker login') || text.includes('github.com/settings')),
      'a step\'s command and link are never sent');
    assert.deepEqual(await stored('project_open_item', itemId), translatedQuestion);
    const row = await openRow(itemId);
    assert.deepEqual(row.translation, servedQuestion, 'the open-items read serves it, with its detail line translated');
    assert.equal(row.question?.question, QUESTION.question, 'and the question as the agent wrote it beside it');
    assert.equal(row.detailLine, 'If you don’t answer: the rollout stays paused', 'and the detail line as built from it');
    assert.equal(row.title, `Coordinator asks: ${QUESTION.question}`, 'and the row title as the agent asked it');
    assert.ok(row.translation?.title?.startsWith('Coordinator asks: ZH['), 'the translated title keeps Orbit\'s prefix');
    assert.ok(published.includes(`project_changed:${p.projectId}`), 'the project is announced changed');

    assert.deepEqual((await listed(decision.id)).translation, {
      lang: 'zh-Hans',
      title: zh('Pick a region'),
      why: zh('The deploy needs one.'),
      ifUnanswered: zh('nothing is deployed'),
      options: [{ label: zh('us-east'), description: zh('Closest to users.') }, { label: zh('eu-west') }],
    });
    const stepsRow = await listed(steps.id);
    assert.deepEqual(stepsRow.translation, {
      lang: 'zh-Hans',
      title: zh('Sign in to the registry'),
      why: zh('The push needs a login.'),
      steps: [{ text: zh('Run the login') }, { text: zh('Open the token page') }],
      verifyHint: zh('docker pull works'),
    });
    assert.deepEqual(stepsRow.steps, STEPS.steps, 'the steps as written, command and link included');
    assert.ok(published.includes(`session:${p.workerSessionId}`), 'the asking session\'s row is announced');
  });

  await t.test('(b) a failed translation is stored as failed and the card is served in the original', async () => {
    await reset();
    await prefer(ON);
    failing = true;
    resetTranslationBreaker();
    const itemId = await ask('b');
    const decision = await requests.file(p.ownerId, p.workerSessionId, { ...DECISION, clientRequestId: 'b-decision' });
    await settle();
    failing = false;
    resetTranslationBreaker();

    assert.deepEqual(await stored('project_open_item', itemId), { lang: 'zh-Hans', failed: true });
    const row = await openRow(itemId);
    assert.deepEqual(row.translation, { lang: 'zh-Hans', failed: true }, 'no translated title or detail line beside a failed one');
    assert.equal(row.detailLine, 'If you don’t answer: the rollout stays paused');
    assert.equal(row.question?.question, QUESTION.question);
    assert.deepEqual(row.question?.options, QUESTION.options, 'the original, untouched');
    const request = await listed(decision.id);
    assert.deepEqual(request.translation, { lang: 'zh-Hans', failed: true });
    assert.equal(request.title, DECISION.title);
    assert.equal(request.why, DECISION.why);

    asked.length = 0;
    await openRow(itemId);
    await listed(decision.id);
    await settle();
    assert.deepEqual(asked, [], 'a card already tried in this language is not translated again on every read');
  });

  await t.test('(c) translation off: nothing is translated, stored or served', async () => {
    await reset();
    await prefer(OFF);
    const itemId = await ask('c');
    const decision = await requests.file(p.ownerId, p.workerSessionId, { ...DECISION, clientRequestId: 'c-decision' });
    await settle();
    await openRow(itemId);
    await listed(decision.id);
    await settle();

    assert.deepEqual(asked, [], 'the translator is never asked');
    assert.equal(await stored('project_open_item', itemId), null);
    assert.equal(await stored('owner_request', decision.id), null);
    assert.equal((await openRow(itemId)).translation, undefined, 'the row carries no translation, so no translated title');
    assert.equal((await listed(decision.id)).translation, null);
    // Ended, so (d) counts only its own cards: a read with translation on queues every open card without one.
    await items.answerOpenItem(p.ownerId, p.projectId, itemId, { option: 0 });
    await requests.complete(p.ownerId, decision.id, { option: 0 });
  });

  await t.test('(d) switched on after filing: reading the open card queues one translation, then serves it', async () => {
    await reset();
    await prefer(OFF);
    const itemId = await ask('d');
    const decision = await requests.file(p.ownerId, p.workerSessionId, { ...DECISION, clientRequestId: 'd-decision' });
    await settle();
    assert.deepEqual(asked, []);

    await prefer(ON);
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    // Two reads of each while the first translation is still running.
    assert.equal((await openRow(itemId)).translation, undefined, 'the read that queues it serves the original');
    await openRow(itemId);
    assert.equal((await listed(decision.id)).translation, null);
    await listed(decision.id);
    release();
    await settle();

    const questionPieces = 5; // question, two labels, one description, ifUnanswered
    const decisionPieces = 6; // title, why, ifUnanswered, two labels, one description
    assert.equal(asked.length, questionPieces + decisionPieces, 'each card was translated exactly once');
    assert.deepEqual((await openRow(itemId)).translation, servedQuestion, 'and the next read serves it');
    assert.equal(((await listed(decision.id)).translation as { title?: string } | null)?.title, zh('Pick a region'));
  });

  await t.test('(e) a card that has ended is not translated on read', async () => {
    await reset();
    await prefer(OFF);
    const itemId = await ask('e');
    const decision = await requests.file(p.ownerId, p.workerSessionId, { ...DECISION, clientRequestId: 'e-decision' });
    await items.answerOpenItem(p.ownerId, p.projectId, itemId, { option: 0 });
    await requests.complete(p.ownerId, decision.id, { option: 1 });
    await settle();

    await prefer(ON);
    const view = await items.list(p.ownerId, p.projectId);
    const closed = view.closedQuestions.find((q) => q.itemId === itemId);
    assert.ok(closed, 'the answered question is a closed record');
    assert.equal(closed.translation, undefined);
    assert.equal((await listed(decision.id)).translation, null);
    await settle();
    assert.deepEqual(asked, [], 'nothing is asked of the translator');
    assert.equal(await stored('project_open_item', itemId), null);
    assert.equal(await stored('owner_request', decision.id), null);
  });

  await t.test('(f) a translation in another language is served without a translated title or detail line', async () => {
    await reset();
    await prefer(OFF);
    const itemId = await ask('f');
    await settle();
    const other = { ...translatedQuestion, lang: 'ja' };
    await sql.query(`UPDATE project_open_item SET translation = $2::jsonb WHERE id = $1`, [itemId, JSON.stringify(other)]);
    await prefer(ON);
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const row = await openRow(itemId);
    assert.deepEqual(row.translation, other, 'the stored one as it is: no title, no detail line');
    assert.equal(row.title, `Coordinator asks: ${QUESTION.question}`);
    release();
    await settle();
    await items.answerOpenItem(p.ownerId, p.projectId, itemId, { option: 0 });
  });

  await t.test('cleanup', async () => {
    await settle();
    await db.ownerRequest.deleteMany({ where: { ownerId: p.ownerId } });
    await db.projectOpenItem.deleteMany({ where: { ownerId: p.ownerId } });
  });
});

interface Account {
  ownerId: string;
  projectId: string;
  coordinatorSessionId: string;
  workerSessionId: string;
}

type Db = ReturnType<typeof prismaClientFor>;

async function account(db: Db): Promise<Account> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `owner-card-translation-${ownerId}@example.invalid`, name: 'owner', passwordHash: 'x', preferences: OFF },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'owner-card-translation', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'owner-card-translation', enabled: true } });
  const session = async (title: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: title, provider: 'claude',
        turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, numTurns: 1, startedAt: new Date(),
        runtimeSessionId: randomUUID(),
      },
    });
    return id;
  };
  const coordinatorSessionId = await session('coordinator');
  const workerSessionId = await session('worker');
  await db.project.create({
    data: {
      id: projectId, ownerId, title: 'owner card translation', goal: 'cards in the owner\'s language',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.task.create({
    data: {
      ownerId, projectId, title: 'some work', creatorType: CreatorType.USER, creatorId: ownerId, assigneeId: workspaceId,
      status: TaskStatus.OPEN, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    },
  });
  return { ownerId, projectId, coordinatorSessionId, workerSessionId };
}
