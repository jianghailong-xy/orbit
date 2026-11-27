/**
 * THE OWNER'S TYPED ANSWERS REACH THE AGENT IN THE AGENT LANGUAGE (project 'Translate every owner card', criterion 3;
 * decision 2A: refuse whole, record nothing, Send as written skips it).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/owner-answer-translation.pg.spec.ts
 *
 * Every door that hands the owner's own words to an agent, against the real schema and the owner's real preferences
 * row (owner language zh-Hans, agent language English), with DeepSeek stubbed to answer `AGENT[text]`:
 *
 *   coordinator question   POST /projects/:id/open-items/:itemId/answer        text → the coordinator's turn
 *   owner request          POST /owner-requests/:id/done {text}, /decline {reason} → the asking session's turn
 *   done request           POST /projects/:id/done-requests/:itemId/decline {note}  → the coordinator's turn
 *   owner confirmation     POST /tasks/:id/owner-confirmation SEND_BACK note → the run's turn;
 *                          CONFIRM answers[].text → the reviewer's turn
 *   completion evidence    POST /tasks/:id/evidence/decision SEND_BACK note (the owner's press) → the run's turn
 *   Feishu direct reply    a reply in a session's chain → that session's turn
 *
 * For each door:
 *   (a) translation on: the delivered turn carries the agent-language text and not the owner's words, and the owner's
 *       words are what is stored for display;
 *   (b) the translator fails: 422 TRANSLATION_FAILED (Feishu: the refusal is answered in the chat), the item, request
 *       or decision is unchanged and no turn is written;
 *   (c) sendAsWritten: the owner's words are delivered and the translator is never asked;
 *   (d) translation off: the owner's words are delivered and the translator is never asked.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { resetTranslationBreaker } from './translation';

import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { CreatorType, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { FeishuDirectService } from '../feishu/feishu-direct.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { readDoneState } from '../projects/project-done-request';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { OwnerSecretsService } from '../owner-requests/owner-secrets.service';
import type { PushService } from '../push/push.service';
import { EvidenceReviewService } from '../tasks/evidence-review.service';
import { OwnerConfirmationReviewService } from '../tasks/owner-confirmation-review.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { WatchDeliveryService } from '../watches/watch-delivery.service';
import { replyTranslationsSettled } from './reply-translation';
import { SessionsService } from './sessions.service';

// The translator's circuit breaker is the process's: each test starts with it closed and nothing counted.
beforeEach(() => resetTranslationBreaker());

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
process.env.PROVIDER_SECRET_KEY ??= 'owner-answer-translation-pg-spec-key';

const ON = { translationEnabled: true, translationLanguage: 'zh-Hans' };
const OFF = { translationEnabled: false, translationLanguage: 'zh-Hans' };

/** What the translator was asked, in order, and how it answers: `AGENT[text]`, or a 500 while `failing`. */
const asked: string[] = [];
let failing = false;
/** How the translator fails while `failing`: an HTTP status (500 by default, after its retries), or another way. */
let failure: number | 'NETWORK' | 'EMPTY' | 'TRUNCATED' | 'MANGLED' | 'HANG' = 500;
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;

const agent = (text: string) => `AGENT[${text}]`;
const WORDS = '周一再发布，先修好登录页';

interface Turn {
  id: string;
  content: string | null;
  displayPrompt: string | null;
  translationState: string | null;
  translationLang: string | null;
}

/** The four cases every door is held to. */
type Case = 'translated' | 'failed' | 'as-written' | 'off';
const CASES: readonly Case[] = ['translated', 'failed', 'as-written', 'off'];

test('the owner\'s typed answers reach the agent in the agent language', { skip, concurrency: 1, timeout: 600_000 }, async (t) => {
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
    const answer = (choice: unknown) => ({ ok: true, json: async () => ({ choices: [choice] }) }) as Response;
    if (failing) {
      if (typeof failure === 'number') return { ok: false, status: failure, body: null } as Response;
      if (failure === 'NETWORK') throw new TypeError('fetch failed');
      if (failure === 'HANG') return new Promise<Response>(() => undefined);
      if (failure === 'EMPTY') return answer({ finish_reason: 'stop', message: { content: '' } });
      if (failure === 'TRUNCATED') return answer({ finish_reason: 'length', message: { content: 'Ship on' } });
      return answer({ finish_reason: 'stop', message: { content: 'Ship \u27e64\u27e7' } });
    }
    return answer({ finish_reason: 'stop', message: { content: agent(text) } });
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = realKey;
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const realtime = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const push = { notifyOwnerRequest: async () => undefined, notifyWatchMatched: async () => undefined } as unknown as PushService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const items = new ProjectOpenItemService(prisma, sessions, undefined, realtime);
  const requests = new OwnerRequestsService(prisma, new OwnerSecretsService(prisma), push, undefined, realtime);
  const delivery = new WatchDeliveryService(prisma, sessions, push, { retryBaseMs: 0, retryMaxMs: 0, pollIntervalMs: 3_600_000 });
  const reviews = new OwnerConfirmationReviewService(prisma, sessions, realtime);
  const confirmations = new TaskOwnerConfirmationService(prisma, sessions, undefined, realtime, reviews);
  const evidenceReviews = new EvidenceReviewService(prisma, sessions);
  const evidence = new TaskCompletionEvidenceService(prisma, undefined, undefined, realtime, evidenceReviews);
  const feishuReplies: string[] = [];
  const feishu = new FeishuDirectService(
    prisma,
    { replyTo: async (_app: unknown, _messageId: string, text: string) => { feishuReplies.push(text); } } as never,
    {} as never,
    sessions,
    push,
  );

  const a = await account(db);
  const prefer = (preferences: object) => db.user.update({ where: { id: a.ownerId }, data: { preferences } });
  /** Set the switch and the translator for one case, and forget what earlier cases asked. */
  const begin = async (which: Case) => {
    // A card filed with translation on is translated for the owner in the background (agent → owner): let that
    // finish, so what the translator is asked from here on is the owner's answer alone.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await replyTranslationsSettled();
    }
    asked.length = 0;
    feishuReplies.length = 0;
    failing = which === 'failed';
    resetTranslationBreaker();
    await prefer(which === 'off' ? OFF : ON);
  };
  const session = (title: string, taskId: string | null = null) => newSession(db, a, title, taskId);
  const project = async (title: string, coordinatorSessionId: string | null) => {
    const id = randomUUID();
    await db.project.create({
      data: {
        id, ownerId: a.ownerId, title, goal: title,
        ...(coordinatorSessionId ? { coordinatorEnabled: true, coordinatorWorkspaceId: a.workspaceId, coordinatorSessionId } : {}),
      },
    });
    return id;
  };
  const task = async (projectId: string | null, title: string, completionCriterion: 'EVIDENCE_JUDGMENT' | 'OWNER_CONFIRMED') => {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, ownerId: a.ownerId, projectId, title, creatorType: CreatorType.USER, creatorId: a.ownerId,
        assigneeId: a.workspaceId, status: TaskStatus.OPEN, completionCriterion, acceptanceCriteria: 'the answers translate',
      },
    });
    return id;
  };
  const turnsOn = async (sessionId: string): Promise<Turn[]> => (await sql.query<Turn>(
    `SELECT "id", "content", "display_prompt" AS "displayPrompt", "translation_state" AS "translationState",
            "translation_lang" AS "translationLang"
       FROM "conversation_turn" WHERE "session_id" = $1 ORDER BY "seq"`,
    [sessionId],
  )).rows;
  const refusedUntranslated = (error: unknown) => {
    assert.ok(error instanceof UnprocessableEntityException, `a 422, not ${String(error)}`);
    // The translator answered 500 three times: the refusal says so (TranslationFailedBody).
    assert.deepEqual(error.getResponse(), {
      code: 'TRANSLATION_FAILED', message: "Couldn't translate, so it wasn't sent.", failureReason: 'HTTP', httpStatus: 500,
    });
    return true;
  };
  /** What a delivered turn must say for `which`: the agent-language words, or the owner's own, never both. */
  const deliveredFor = (which: Case, content: string | null | undefined) => {
    assert.ok(content, 'a turn was delivered');
    if (which === 'translated') {
      assert.ok(content.includes(agent(WORDS)), `the agent reads the translation: ${content}`);
      assert.ok(asked.includes(WORDS), 'the owner\'s words were translated');
    } else {
      assert.ok(content.includes(WORDS) && !content.includes(agent(WORDS)), `the agent reads the owner's words: ${content}`);
      assert.ok(!asked.some((text) => text.includes(WORDS)), 'the owner\'s words never reach the translator');
    }
  };
  const sendAsWritten = (which: Case) => (which === 'as-written' ? { sendAsWritten: true } : {});

  for (const which of CASES) {
    await t.test(`coordinator question answer: ${which}`, async () => {
      const coordinator = await session('coordinator');
      const projectId = await project('question project', coordinator);
      const { itemId } = await items.askOwner(a.ownerId, projectId, coordinator, {
        question: 'When do we ship?', options: [{ label: 'Today' }, { label: 'Later' }], blocksTaskIds: [], clientQuestionId: `q-${which}`,
      });
      const before = (await turnsOn(coordinator)).length;
      await begin(which);
      const answer = () => items.answerOpenItem(a.ownerId, projectId, itemId, { option: 1, text: WORDS, ...sendAsWritten(which) });
      const row = () => db.projectOpenItem.findUniqueOrThrow({ where: { id: itemId }, select: { state: true, answer: true } });
      if (which === 'failed') {
        await assert.rejects(answer(), refusedUntranslated);
        assert.deepEqual(await row(), { state: 'OPEN', answer: null }, 'the question is still open and unanswered');
        assert.equal((await turnsOn(coordinator)).length, before, 'the coordinator is told nothing');
        return;
      }
      await answer();
      const stored = (await row()).answer as { option?: number; text?: string; translation?: unknown };
      assert.equal(stored.option, 1, 'the option goes by index');
      assert.equal(stored.text, WORDS, 'the owner\'s words are stored for display');
      assert.deepEqual(stored.translation, which === 'translated' ? { lang: 'en', text: agent(WORDS) } : undefined);
      const turns = await turnsOn(coordinator);
      assert.equal(turns.length, before + 1);
      deliveredFor(which, turns.at(-1)!.content);
      assert.ok(turns.at(-1)!.content!.includes('Later'), 'with the option chosen, as written');
    });
  }

  for (const which of CASES) {
    for (const ending of ['done', 'decline'] as const) {
      await t.test(`owner request ${ending}: ${which}`, async () => {
        const asker = await session('asking session');
        const request = await requests.file(a.ownerId, asker, {
          kind: 'DECISION', title: 'Pick a day', why: 'The release needs one.',
          options: [{ label: 'Monday' }, { label: 'Friday' }], clientRequestId: `r-${ending}-${which}`,
        });
        await begin(which);
        const end = () => ending === 'done'
          ? requests.complete(a.ownerId, request.id, { text: WORDS, ...sendAsWritten(which) })
          : requests.decline(a.ownerId, request.id, WORDS, null, which === 'as-written');
        const row = () => db.ownerRequest.findUniqueOrThrow({
          where: { id: request.id }, select: { state: true, answer: true, resolutionNote: true },
        });
        if (which === 'failed') {
          await assert.rejects(end(), refusedUntranslated);
          assert.deepEqual(await row(), { state: 'PENDING', answer: null, resolutionNote: null }, 'the request is still pending');
          await delivery.drain();
          assert.deepEqual(await turnsOn(asker), [], 'the asking session is told nothing');
          return;
        }
        await end();
        const stored = await row();
        assert.equal(stored.state, ending === 'done' ? 'DONE' : 'DECLINED');
        if (ending === 'done') assert.equal((stored.answer as { text?: string }).text, WORDS, 'the owner\'s words are stored');
        else assert.equal(stored.resolutionNote, WORDS, 'the owner\'s reason is stored');
        await delivery.drain();
        const turns = await turnsOn(asker);
        assert.equal(turns.length, 1, 'the ending is one turn of the asking session');
        deliveredFor(which, turns[0].content);
      });
    }
  }

  for (const which of CASES) {
    await t.test(`done request decline: ${which}`, async () => {
      const coordinator = await session('coordinator');
      const projectId = await project('done project', coordinator);
      const tx = db as unknown as Parameters<typeof readDoneState>[0];
      const state = await readDoneState(tx, a.ownerId, projectId, coordinator);
      const itemId = randomUUID();
      const now = new Date();
      await db.projectOpenItem.create({
        data: {
          id: itemId, projectId, ownerId: a.ownerId, kind: 'DONE_REQUEST', state: 'OPEN', assignee: 'OWNER', assigneeReason: 'DEFAULT',
          askedBySessionId: coordinator, dedupeKey: 'DONE_REQUEST', title: 'Is this project done?',
          payload: { judgment: 'Everything holds.', gaps: [], criteriaDigest: state.criteriaDigest, stateDigest: state.stateDigest },
          waitingSince: now, assignedAt: now, escalateAt: null,
        },
      });
      const before = (await turnsOn(coordinator)).length;
      await begin(which);
      const decline = () => items.declineDoneRequest(a.ownerId, projectId, itemId, { note: WORDS, ...sendAsWritten(which) });
      const row = () => db.projectOpenItem.findUniqueOrThrow({ where: { id: itemId }, select: { state: true, answer: true, resolutionNote: true } });
      if (which === 'failed') {
        await assert.rejects(decline(), refusedUntranslated);
        assert.deepEqual(await row(), { state: 'OPEN', answer: null, resolutionNote: null }, 'the request is still open');
        assert.equal((await turnsOn(coordinator)).length, before, 'the coordinator is told nothing');
        return;
      }
      await decline();
      const stored = await row();
      assert.equal(stored.resolutionNote, WORDS, 'the owner\'s note is stored for display');
      assert.equal((stored.answer as { note?: string }).note, WORDS);
      const turns = await turnsOn(coordinator);
      assert.equal(turns.length, before + 1);
      deliveredFor(which, turns.at(-1)!.content);
    });
  }

  /** A task waiting on its owner's confirmation, with a review whose REVIEW record asks the owner one question. */
  const confirmationWaiting = async () => {
    const reviewer = await session('reviewer');
    const projectId = await project('confirmation project', null);
    const taskId = await task(projectId, 'confirmed work', 'OWNER_CONFIRMED');
    const runSessionId = await session('the run', taskId);
    const turnId = randomUUID();
    const claim = await db.taskOwnerConfirmationClaim.create({ data: { taskId, ownerId: a.ownerId, sessionId: runSessionId, turnId } });
    const request = await db.taskOwnerConfirmationRequest.create({
      data: { taskId, ownerId: a.ownerId, sessionId: runSessionId, turnId, claimId: claim.id },
    });
    const review = await db.taskOwnerConfirmationReview.create({
      data: {
        requestId: request.id, taskId, ownerId: a.ownerId, reviewerKind: 'TASK_CREATOR',
        reviewerSessionId: reviewer, windowSeconds: 600, dueAt: new Date(Date.now() + 600_000),
      },
    });
    const record = await db.taskOwnerConfirmationReviewRecord.create({
      data: {
        reviewId: review.id, requestId: request.id, taskId, ownerId: a.ownerId, kind: 'REVIEW', judgment: 'Done; one choice is yours.',
        body: { checked: [], notChecked: [], needsYou: [{ key: 'n1', text: 'When do we ship?', options: [{ label: 'Today' }, { label: 'Later' }], recommendedOption: 0 }], leftOpen: [] },
        sessionId: reviewer, turnId: randomUUID(), recordedAt: new Date(),
      },
    });
    return { taskId, runSessionId, reviewer, requestId: request.id, reviewRecordId: record.id };
  };
  const principal = () => ({ door: 'USER' as const, userId: a.ownerId, actingSessionId: undefined });
  const decisionsOf = (taskId: string) => db.taskOwnerDecision.findMany({ where: { taskId }, select: { decision: true, note: true, answers: true } });

  for (const which of CASES) {
    await t.test(`owner confirmation send-back note: ${which}`, async () => {
      const waiting = await confirmationWaiting();
      await begin(which);
      const sendBack = () => confirmations.decide(a.ownerId, waiting.taskId, principal(), {
        decision: 'SEND_BACK', requestId: waiting.requestId, note: WORDS, ...sendAsWritten(which),
      });
      if (which === 'failed') {
        await assert.rejects(sendBack(), refusedUntranslated);
        assert.deepEqual(await decisionsOf(waiting.taskId), [], 'no decision is recorded');
        assert.deepEqual(await turnsOn(waiting.runSessionId), [], 'the run is told nothing');
        return;
      }
      await sendBack();
      assert.deepEqual((await decisionsOf(waiting.taskId)).map((d) => d.note), [WORDS], 'the decision keeps the owner\'s words');
      const turns = await turnsOn(waiting.runSessionId);
      assert.equal(turns.length, 1);
      deliveredFor(which, turns[0].content);
      assert.deepEqual(
        { displayPrompt: turns[0].displayPrompt, state: turns[0].translationState, lang: turns[0].translationLang },
        which === 'translated'
          ? { displayPrompt: WORDS, state: 'DONE', lang: 'zh-Hans' }
          : { displayPrompt: null, state: null, lang: null },
        'a translated turn shows the owner their own words',
      );
    });
  }

  for (const which of CASES) {
    await t.test(`owner confirmation typed answer: ${which}`, async () => {
      const waiting = await confirmationWaiting();
      await begin(which);
      const confirm = () => confirmations.decide(a.ownerId, waiting.taskId, principal(), {
        decision: 'CONFIRM', requestId: waiting.requestId, reviewRecordId: waiting.reviewRecordId,
        answers: [{ key: 'n1', text: WORDS }], ...sendAsWritten(which),
      });
      if (which === 'failed') {
        await assert.rejects(confirm(), refusedUntranslated);
        assert.deepEqual(await decisionsOf(waiting.taskId), [], 'no decision is recorded');
        assert.equal((await db.task.findUniqueOrThrow({ where: { id: waiting.taskId } })).status, TaskStatus.OPEN, 'the task stays open');
        assert.deepEqual(await turnsOn(waiting.reviewer), [], 'the reviewer is told nothing');
        return;
      }
      await confirm();
      const [decision] = await decisionsOf(waiting.taskId);
      const [stored] = decision.answers as Array<{ text: string; translation?: unknown }>;
      assert.equal(stored.text, WORDS, 'the answer keeps the owner\'s words');
      assert.deepEqual(stored.translation, which === 'translated' ? { lang: 'en', text: agent(WORDS) } : undefined);
      const turns = await turnsOn(waiting.reviewer);
      assert.equal(turns.length, 1, 'the reviewer is told the answers');
      deliveredFor(which, turns[0].content);
    });
  }

  for (const which of CASES) {
    await t.test(`completion evidence send-back note (the owner's press): ${which}`, async () => {
      const taskId = await task(null, 'judged work', 'EVIDENCE_JUDGMENT');
      const runSessionId = await session('the run that did the work', taskId);
      const decider = await session('the deciding session');
      const toolUseId = `toolu_answer_${taskId.slice(0, 8)}`;
      await db.toolCall.create({ data: { sessionId: runSessionId, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false } });
      const filed = await evidence.submit(a.ownerId, taskId, { type: CreatorType.AGENT, id: a.workspaceId }, {
        sourceSessionId: runSessionId,
        evidence: { claim: 'It works.', checks: [{ kind: 'TOOL_CALL', ref: toolUseId }], gaps: [] },
      });
      const before = (await turnsOn(runSessionId)).length;
      await begin(which);
      const sendBack = () => evidence.decide(
        a.ownerId, taskId, { type: CreatorType.USER, id: a.ownerId },
        { decidingSessionId: decider, evidenceRevision: String(filed.revision), decision: 'SEND_BACK', note: WORDS, ...sendAsWritten(which) },
        principal(),
      );
      const decided = () => db.taskEvidenceDecision.findMany({ where: { taskId }, select: { note: true } });
      if (which === 'failed') {
        await assert.rejects(sendBack(), refusedUntranslated);
        assert.deepEqual(await decided(), [], 'no decision is recorded');
        assert.equal((await turnsOn(runSessionId)).length, before, 'the run is told nothing');
        return;
      }
      if (which === 'translated') {
        await db.session.update({
          where: { id: runSessionId }, data: { retryAt: new Date(Date.now() + 3_600_000) },
        });
      }
      await sendBack();
      assert.deepEqual(await decided(), [{ note: WORDS }], 'the decision keeps the owner\'s words');
      if (which === 'translated') {
        assert.equal((await turnsOn(runSessionId)).length, before, 'the translation waits for recovery');
        await db.session.update({ where: { id: runSessionId }, data: { retryAt: null } });
        await evidenceReviews.deliverSendBacksOwedTo(runSessionId);
      }
      const turns = await turnsOn(runSessionId);
      assert.equal(turns.length, before + 1);
      const sent = turns.at(-1)!;
      deliveredFor(which, sent.content);
      if (which === 'translated') {
        assert.ok(sent.displayPrompt?.includes(WORDS), 'the transcript shows the owner\'s words');
        await db.conversationTurn.update({
          where: { id: sent.id }, data: { status: 'ANSWERED', answeredAt: new Date(), deliveredAt: null },
        });
        await evidenceReviews.deliverSendBacksOwedTo(runSessionId);
        const retried = await turnsOn(runSessionId);
        assert.equal(retried.length, before + 2);
        assert.equal(retried.at(-1)!.content, sent.content);
        assert.equal(retried.at(-1)!.displayPrompt, sent.displayPrompt);
        assert.equal(retried.at(-1)!.translationLang, sent.translationLang);
      }
    });
  }

  for (const which of ['translated', 'failed', 'off'] as const) {
    await t.test(`Feishu direct reply: ${which}`, async () => {
      const target = await session('a session replied to in Feishu');
      const app = { appId: `cli_${randomUUID().slice(0, 8)}`, ownerId: a.ownerId };
      const internals = feishu as unknown as {
        sessionOfChain(): Promise<string>;
        registerChain(): Promise<void>;
        recordActivity(): Promise<void>;
        reply(app: unknown, actor: unknown, eventId: string, message: unknown, text: string): Promise<void>;
      };
      // The chain lookup and its bookkeeping are the Feishu tables' business, not this door's: stubbed.
      internals.sessionOfChain = async () => target;
      internals.registerChain = async () => undefined;
      internals.recordActivity = async () => undefined;
      await begin(which);
      await internals.reply(app, { credential: null }, `ev-${randomUUID()}`,
        { messageId: `om_${randomUUID()}`, chatId: 'oc_chat', rootId: 'om_root', parentId: null, text: WORDS }, WORDS);
      const turns = await turnsOn(target);
      if (which === 'failed') {
        assert.deepEqual(turns, [], 'nothing is sent to the session');
        assert.equal(feishuReplies.length, 1, 'the owner is told in the chat');
        assert.match(feishuReplies[0], /Couldn't translate, so it wasn't sent/);
        return;
      }
      assert.equal(turns.length, 1);
      deliveredFor(which, turns[0].content);
      assert.equal(turns[0].displayPrompt, which === 'translated' ? WORDS : null, 'the transcript shows the owner\'s words');
    });
  }

  // Translation failure policy B, criterion 1: the 422 says why the words could not be translated, each failure is
  // logged once with its reason, HTTP status and duration (never the words), and Send as written then delivers them.
  const REASONS: Array<{ reason: string; httpStatus: number | null; failure: typeof failure }> = [
    { reason: 'TIMEOUT', httpStatus: null, failure: 'HANG' },
    { reason: 'NETWORK', httpStatus: null, failure: 'NETWORK' },
    { reason: 'HTTP', httpStatus: 401, failure: 401 },
    { reason: 'HTTP', httpStatus: 503, failure: 503 },
    { reason: 'EMPTY', httpStatus: null, failure: 'EMPTY' },
    { reason: 'TRUNCATED', httpStatus: null, failure: 'TRUNCATED' },
    { reason: 'MANGLED', httpStatus: null, failure: 'MANGLED' },
  ];
  for (const { reason, httpStatus, failure: how } of REASONS) {
    const name = httpStatus ? `${reason} ${httpStatus}` : reason;
    await t.test(`coordinator question answer refused ${name}: the 422 says why, one log line, Send as written delivers`, async () => {
      const coordinator = await session(`coordinator ${name}`);
      const projectId = await project(`reason project ${name}`, coordinator);
      const { itemId } = await items.askOwner(a.ownerId, projectId, coordinator, {
        question: 'When do we ship?', options: [{ label: 'Today' }, { label: 'Later' }], blocksTaskIds: [],
        clientQuestionId: `q-reason-${name}`,
      });
      const before = (await turnsOn(coordinator)).length;
      await begin('failed');
      failure = how;
      const lines: string[] = [];
      const realWarn = Logger.prototype.warn;
      Logger.prototype.warn = function (this: Logger, message: unknown, ...rest: unknown[]) {
        if (String(message).startsWith('owner translation failed:')) lines.push(String(message));
        else return (realWarn as (...args: unknown[]) => void).call(this, message, ...rest);
      } as typeof realWarn;
      let body: unknown;
      try {
        await assert.rejects(items.answerOpenItem(a.ownerId, projectId, itemId, { option: 1, text: WORDS }), (error: unknown) => {
          assert.ok(error instanceof UnprocessableEntityException, `a 422, not ${String(error)}`);
          body = error.getResponse();
          return true;
        });
      } finally {
        Logger.prototype.warn = realWarn;
        failure = 500;
      }
      assert.deepEqual(body, {
        code: 'TRANSLATION_FAILED', message: "Couldn't translate, so it wasn't sent.",
        failureReason: reason, ...(httpStatus ? { httpStatus } : {}),
      });
      assert.equal(lines.length, 1, lines.join(' | '));
      assert.match(lines[0], new RegExp(`\\breason=${reason}\\b`));
      assert.match(lines[0], new RegExp(`\\bhttpStatus=${httpStatus ?? '-'}(\\s|$)`));
      assert.match(lines[0], /\bdurationMs=\d+\b/);
      if (reason === 'TIMEOUT') assert.match(lines[0], /durationMs=(1999\d|2\d{4})\b/);
      assert.ok(!lines[0].includes(WORDS), 'no message text');
      assert.equal((await turnsOn(coordinator)).length, before, 'nothing was recorded');

      await items.answerOpenItem(a.ownerId, projectId, itemId, { option: 1, text: WORDS, sendAsWritten: true });
      const turns = await turnsOn(coordinator);
      assert.equal(turns.length, before + 1);
      assert.ok(turns.at(-1)!.content?.includes(WORDS), 'Send as written delivers the owner\'s words');
    });
  }
});

interface Account {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

type Db = ReturnType<typeof prismaClientFor>;

async function newSession(db: Db, a: Account, title: string, taskId: string | null): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: a.ownerId, creatorId: a.ownerId, workspaceId: a.workspaceId, assignedRunnerId: a.runnerId, taskId,
      title, prompt: title, provider: 'claude', turnState: null,
      dispatchOrigin: SessionDispatchOrigin.USER, numTurns: 1, startedAt: new Date(), runtimeSessionId: randomUUID(),
      startsTaskWork: taskId !== null,
    },
  });
  return id;
}

async function account(db: Db): Promise<Account> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `owner-answer-translation-${ownerId}@example.invalid`, name: 'owner', passwordHash: 'x', preferences: OFF },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'owner-answer-translation', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'owner-answer-translation', enabled: true } });
  return { ownerId, runnerId, workspaceId };
}
