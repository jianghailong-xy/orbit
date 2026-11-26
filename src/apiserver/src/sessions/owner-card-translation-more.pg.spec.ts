/**
 * MORE OWNER CARDS ARE TRANSLATED (project 'Translate every owner card', criterion 4; decisions 1A–5A).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/owner-card-translation-more.pg.spec.ts
 *
 * owner-card-translation.pg.spec.ts holds the coordinator question and the owner request to these rules; this holds
 * the other six cards to the same ones, against the real schema (migration 1080) and the owner's real preferences
 * row, with DeepSeek stubbed:
 *
 *   START_REQUEST       why                                              open-items view `startRequest`
 *   DONE_REQUEST        judgment, gaps[].title/whyNotProven/coordinatorChecked   open-items view `doneRequest`
 *   owner confirmation  REVIEW judgment + needsYou, PROBLEMS reason + problems   GET /tasks/:id/owner-confirmation
 *   completion evidence claim, gaps                                      the deciding session's pending evidence
 *   criteria proposal   proposed[].text/verificationMethod               the owner's pending criteria decisions
 *   crossing            title, reason                                    GET /projects/:id/handoffs
 *
 * For each card kind:
 *   (a) translated after filing: every agent-written field is stored in `translation` in the owner's language, the
 *       card's own fields are unchanged, the refresh event is published and the owner's read serves it; fields that
 *       are keys or references (a gap's criterionKey and evidenceRefs, a check's ref) never reach the translator;
 *   (b) a failed translation is stored as `{ lang, failed: true }` and the card is served in the original;
 *   (c) translation off: nothing is asked of the translator and nothing is stored or served;
 *   (d) the switch turned on after filing: reading the still-open card queues one translation, served next read.
 * And (e): the owner-confirmation REPORT (the run's last assistant text) is never translated here — it is served with
 * the run event's existing `translation` when that is in the owner's current language, and without it otherwise.
 *
 * Evidence and criteria proposals are filed through their real doors (TaskCompletionEvidenceService.submit,
 * ProjectsService.update holding a loosening edit). Start/done requests, the confirmation review records and the
 * crossing are written as their doors write them, then handed to the same post-filing method each door calls.
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
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { readDoneState } from '../projects/project-done-request';
import { readStartPlan } from '../projects/project-start-request';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectsService } from '../projects/projects.service';
import { OwnerConfirmationReviewService } from '../tasks/owner-confirmation-review.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { replyTranslationsSettled } from './reply-translation';
import { SessionsService } from './sessions.service';

// The translator's circuit breaker is the process's: each test starts with it closed and nothing counted.
beforeEach(() => resetTranslationBreaker());

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
process.env.PROVIDER_SECRET_KEY ??= 'owner-card-translation-more-pg-spec-key';

const ON = { translationEnabled: true, translationLanguage: 'zh-Hans' };
const OFF = { translationEnabled: false, translationLanguage: 'zh-Hans' };

/** What the translator was asked, in order, and how it answers: `ZH[text]`, or a 500 while `failing`. */
const asked: string[] = [];
let failing = false;
const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;

const zh = (text: string) => `ZH[${text}]`;

async function settle(): Promise<void> {
  // A filing reads the owner's languages before it queues, so the queue may still be empty for a moment.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await replyTranslationsSettled();
  }
}

/** One card kind, as the cases below drive it. */
interface CardKind {
  name: string;
  /** File one card (its door, or what its door writes followed by the door's post-filing method). */
  file(): Promise<string>;
  /** What the owner's read serves as the card's `translation` (undefined or null when none). */
  served(id: string): Promise<unknown>;
  /** The card's own agent-written words as the owner's read serves them, to show they are unchanged. */
  original(id: string): Promise<unknown>;
  /** The stored `translation`. */
  stored(id: string): Promise<unknown>;
  /** What a successful translation of the card is. */
  translated: Record<string, unknown>;
  /** The original the read must still serve. */
  originalValue: unknown;
  /** The refresh event filing it publishes once the translation is stored. */
  published(id: string): string;
  /** Text that must never reach the translator. */
  neverSent?: string[];
}

test('six more owner cards are translated, once, whole or failed', { skip, concurrency: 1, timeout: 600_000 }, async (t) => {
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
      if (key === 'publishForUser') {
        return (_owner: string, type: string, id: unknown) => {
          const ids = typeof id === 'string' ? [id] : ((id as { taskIds?: string[] } | null)?.taskIds ?? []);
          for (const each of ids) published.push(`${type}:${each}`);
        };
      }
      if (key === 'publishSessionUpdated') return (id: string) => { published.push(`session:${id}`); };
      return () => undefined;
    },
  }) as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const items = new ProjectOpenItemService(prisma, sessions, undefined, realtime);
  const evidence = new TaskCompletionEvidenceService(prisma, undefined, undefined, realtime);
  const acceptance = new ProjectAcceptanceService(prisma);
  const projects = new ProjectsService(prisma, acceptance, undefined, realtime);
  const reviews = new OwnerConfirmationReviewService(prisma, sessions, realtime);
  const confirmations = new TaskOwnerConfirmationService(prisma, sessions, undefined, realtime);
  const handoffs = new ProjectHandoffService(prisma);
  handoffs.bindChangeListener(({ id }) => { published.push(`crossing:${id}`); });

  const a = await account(db);
  const prefer = (preferences: object) => db.user.update({ where: { id: a.ownerId }, data: { preferences } });
  const reset = async () => {
    await settle();
    asked.length = 0;
    published.length = 0;
    failing = false;
    resetTranslationBreaker();
  };
  const storedIn = async (table: string, id: string, key = 'id') =>
    (await sql.query(`SELECT translation FROM ${table} WHERE ${key} = $1`, [id])).rows[0]?.translation ?? null;
  /** A project of this account with no coordinator. */
  const project = async (title: string) => {
    const id = randomUUID();
    await db.project.create({ data: { id, ownerId: a.ownerId, title, goal: title } });
    return id;
  };
  const task = async (projectId: string, title: string, completionCriterion: 'EVIDENCE_JUDGMENT' | 'OWNER_CONFIRMED') => {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, ownerId: a.ownerId, projectId, title, creatorType: CreatorType.USER, creatorId: a.ownerId,
        assigneeId: a.workspaceId, status: TaskStatus.OPEN, completionCriterion,
        acceptanceCriteria: 'the cards work',
      },
    });
    return id;
  };
  const session = (title: string, taskId: string | null = null) => newSession(db, a, title, taskId);

  // ── START_REQUEST ────────────────────────────────────────────────────────────────────────────────
  const WHY = 'The plan is ready: every criterion has a task.';
  /** A request as its door files it: about the project as it stands, so the read does not supersede it as stale. */
  const openItem = async (kind: 'START_REQUEST' | 'DONE_REQUEST', payload: Record<string, unknown>) => {
    const projectId = await project(`${kind} project`);
    const tx = db as unknown as Parameters<typeof readStartPlan>[0];
    if (kind === 'START_REQUEST') {
      const plan = await readStartPlan(tx, a.ownerId, projectId);
      Object.assign(payload, { criteriaDigest: plan.criteriaDigest, planDigest: plan.planDigest });
    } else {
      const state = await readDoneState(tx, a.ownerId, projectId, a.coordinatorSessionId);
      Object.assign(payload, { criteriaDigest: state.criteriaDigest, stateDigest: state.stateDigest });
    }
    const id = randomUUID();
    const now = new Date();
    await db.projectOpenItem.create({
      data: {
        id, projectId, ownerId: a.ownerId, kind, state: 'OPEN', assignee: 'OWNER', assigneeReason: 'DEFAULT',
        askedBySessionId: a.coordinatorSessionId, dedupeKey: kind,
        title: kind === 'START_REQUEST' ? 'Start this project?' : 'Is this project done?',
        payload: payload as object, waitingSince: now, assignedAt: now, escalateAt: null,
      },
    });
    // What requestStart / requestDone call once the request has committed.
    (items as unknown as { translateFiledItem(o: string, p: string, i: string, w: string): void })
      .translateFiledItem(a.ownerId, projectId, id, kind);
    itemProject.set(id, projectId);
    return id;
  };
  const itemProject = new Map<string, string>();
  const view = (id: string) => items.list(a.ownerId, itemProject.get(id)!);
  const startRequest: CardKind = {
    name: 'start request',
    file: () => openItem('START_REQUEST', {
      settings: { line: 'MAIN', automatic: true, maxConcurrentTasks: 2, mergeCheckCommand: null },
      why: WHY, repository: null, warnings: [],
    }),
    served: async (id) => (await view(id)).startRequest?.translation,
    original: async (id) => (await view(id)).startRequest?.startRequest?.why,
    stored: (id) => storedIn('project_open_item', id),
    translated: { lang: 'zh-Hans', why: zh(WHY) },
    originalValue: WHY,
    published: (id) => `project_changed:${itemProject.get(id)}`,
  };

  // ── DONE_REQUEST ─────────────────────────────────────────────────────────────────────────────────
  const JUDGMENT = 'Every criterion holds; one gap is accepted.';
  const GAP = {
    criterionKey: 'crit-key-one', title: 'Phone check', whyNotProven: 'No device is attached.',
    coordinatorChecked: 'The emulator run passed.', evidenceRefs: ['bgj_evidence_ref'],
  };
  const doneRequest: CardKind = {
    name: 'done request',
    file: () => openItem('DONE_REQUEST', { judgment: JUDGMENT, gaps: [GAP] }),
    served: async (id) => (await view(id)).doneRequest?.translation,
    original: async (id) => (await view(id)).doneRequest?.doneRequest?.gaps,
    stored: (id) => storedIn('project_open_item', id),
    translated: {
      lang: 'zh-Hans',
      judgment: zh(JUDGMENT),
      gaps: [{ title: zh(GAP.title), whyNotProven: zh(GAP.whyNotProven), coordinatorChecked: zh(GAP.coordinatorChecked) }],
    },
    originalValue: [GAP],
    published: (id) => `project_changed:${itemProject.get(id)}`,
    neverSent: ['crit-key-one', 'bgj_evidence_ref'],
  };

  // ── task owner confirmation: REVIEW and PROBLEMS records ─────────────────────────────────────────
  const REVIEW_JUDGMENT = 'The work is done; one choice is yours.';
  const NEEDS_YOU = { key: 'n1', text: 'Ship it today?', options: [{ label: 'Ship', description: 'Users get it now.' }, { label: 'Wait' }], recommendedOption: 0 };
  const PROBLEM_REASON = 'The header overlaps on small screens.';
  const PROBLEM = { key: 'p1', text: 'Header overlaps the title.', evidenceRefs: ['toolu_problem_ref'] };
  const confirmation = new Map<string, { taskId: string; runSessionId: string; problemsId: string; turnId: string }>();
  /** A task waiting on its owner's confirmation, its run's report, and a review with both records. */
  const fileConfirmation = async (report?: object) => {
    const projectId = await project('confirmation project');
    const taskId = await task(projectId, 'confirmed work', 'OWNER_CONFIRMED');
    const runSessionId = await session('the run', taskId);
    const turnId = randomUUID();
    const claim = await db.taskOwnerConfirmationClaim.create({ data: { taskId, ownerId: a.ownerId, sessionId: runSessionId, turnId } });
    const request = await db.taskOwnerConfirmationRequest.create({
      data: { taskId, ownerId: a.ownerId, sessionId: runSessionId, turnId, claimId: claim.id },
    });
    await db.runEvent.create({
      data: {
        sessionId: runSessionId, seq: 1, type: 'assistant', turnId,
        payload: { text: 'All done: the cards work.', ...(report ? { translation: report } : {}) },
      },
    });
    const review = await db.taskOwnerConfirmationReview.create({
      data: {
        requestId: request.id, taskId, ownerId: a.ownerId, reviewerKind: 'TASK_CREATOR',
        reviewerSessionId: a.coordinatorSessionId, windowSeconds: 600, dueAt: new Date(Date.now() + 600_000),
      },
    });
    const record = (kind: 'REVIEW' | 'PROBLEMS', fields: object, body: object) => db.taskOwnerConfirmationReviewRecord.create({
      data: {
        reviewId: review.id, requestId: request.id, taskId, ownerId: a.ownerId, kind, ...fields, body,
        sessionId: a.coordinatorSessionId, turnId: randomUUID(), recordedAt: new Date(),
      },
    });
    const reviewRecord = await record('REVIEW', { judgment: REVIEW_JUDGMENT },
      { checked: [], notChecked: [], needsYou: [NEEDS_YOU], leftOpen: [] });
    const problemsRecord = await record('PROBLEMS', { reason: PROBLEM_REASON }, { problems: [PROBLEM] });
    // What review() and recordProblems() call once their record has committed.
    const later = reviews as unknown as { translateLater(o: string, t: string, r: string, s: string): void };
    later.translateLater(a.ownerId, taskId, reviewRecord.id, runSessionId);
    later.translateLater(a.ownerId, taskId, problemsRecord.id, runSessionId);
    confirmation.set(reviewRecord.id, { taskId, runSessionId, problemsId: problemsRecord.id, turnId });
    return reviewRecord.id;
  };
  const waitingReview = async (id: string) => {
    const read = await confirmations.read(a.ownerId, confirmation.get(id)!.taskId);
    assert.ok(read.waiting?.review, 'the owner is asked, with the review beside the question');
    return read.waiting;
  };
  const confirmationReview: CardKind = {
    name: 'owner-confirmation review',
    file: () => fileConfirmation(),
    served: async (id) => {
      const waiting = await waitingReview(id);
      return waiting.review!.review?.translation;
    },
    original: async (id) => (await waitingReview(id)).review!.review?.judgment,
    stored: (id) => storedIn('task_owner_confirmation_review_record', id),
    translated: {
      lang: 'zh-Hans',
      judgment: zh(REVIEW_JUDGMENT),
      needsYou: [{ text: zh(NEEDS_YOU.text), options: [{ label: zh('Ship'), description: zh('Users get it now.') }, { label: zh('Wait') }] }],
    },
    originalValue: REVIEW_JUDGMENT,
    published: (id) => `task_changed:${confirmation.get(id)!.taskId}`,
  };
  const confirmationProblems: CardKind = {
    name: 'owner-confirmation problems',
    // The same filing: its PROBLEMS record is the card here, addressed by the REVIEW record's id.
    file: () => fileConfirmation(),
    served: async (id) => (await waitingReview(id)).review!.problems?.translation,
    original: async (id) => (await waitingReview(id)).review!.problems?.problems,
    stored: (id) => storedIn('task_owner_confirmation_review_record', confirmation.get(id)!.problemsId),
    translated: { lang: 'zh-Hans', reason: zh(PROBLEM_REASON), problems: [{ text: zh(PROBLEM.text) }] },
    originalValue: [PROBLEM],
    published: (id) => `session:${confirmation.get(id)!.runSessionId}`,
    neverSent: ['toolu_problem_ref'],
  };

  // ── completion evidence ──────────────────────────────────────────────────────────────────────────
  const CLAIM = 'The cards are translated on every client.';
  const EVIDENCE_GAPS = ['Physical phones were not checked.'];
  const evidenceProject = await project('evidence project');
  const reader = await session('the deciding session');
  const evidenceTask = new Map<string, string>();
  const pendingRow = async (id: string) => {
    const row = (await evidence.pending(a.ownerId, reader)).pending.find((r) => r.taskId === evidenceTask.get(id));
    assert.ok(row, 'the revision is pending for the deciding session');
    return row;
  };
  const completionEvidence: CardKind = {
    name: 'completion evidence',
    file: async () => {
      const taskId = await task(evidenceProject, 'judged work', 'EVIDENCE_JUDGMENT');
      const runSessionId = await session('the run that did the work', taskId);
      const toolUseId = `toolu_card_${taskId.slice(0, 8)}`;
      await db.toolCall.create({ data: { sessionId: runSessionId, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false } });
      const filed = await evidence.submit(a.ownerId, taskId, { type: CreatorType.AGENT, id: a.workspaceId }, {
        sourceSessionId: runSessionId,
        evidence: { claim: CLAIM, checks: [{ kind: 'TOOL_CALL', ref: toolUseId }], gaps: EVIDENCE_GAPS },
      });
      evidenceTask.set(filed.id, taskId);
      return filed.id;
    },
    served: async (id) => (await pendingRow(id)).translation,
    original: async (id) => ({ claim: (await pendingRow(id)).claim, gaps: (await pendingRow(id)).gaps }),
    stored: (id) => storedIn('task_completion_evidence', id),
    translated: { lang: 'zh-Hans', claim: zh(CLAIM), gaps: EVIDENCE_GAPS.map(zh) },
    originalValue: { claim: CLAIM, gaps: EVIDENCE_GAPS },
    published: (id) => `task_changed:${evidenceTask.get(id)}`,
    neverSent: ['toolu_card_', 'npm test'],
  };

  // ── criteria-change proposal ─────────────────────────────────────────────────────────────────────
  const FIRST = 'The web card is translated.';
  const SECOND = 'The phone card is translated.';
  const THIRD = 'The copy is identical on every client.';
  const METHOD = 'A unit test renders it with a fixture.';
  const proposalProject = new Map<string, string>();
  const pendingProposal = async (id: string) => {
    const row = (await projects.pendingCriteriaDecisions(a.ownerId, proposalProject.get(id)!)).pending.find((r) => r.intentId === id);
    assert.ok(row, 'the proposal is pending for its owner');
    return row;
  };
  const criteriaProposal: CardKind = {
    name: 'criteria proposal',
    file: async () => {
      const projectId = await project('proposal project');
      const state = (texts: string[], known: Map<string, string> = new Map()) => projects.update(a.ownerId, projectId, {
        acceptanceCriteriaItems: texts.map((text) => ({ ...(known.has(text) ? { id: known.get(text) } : {}), text, verificationMethod: METHOD })),
      } as never);
      await state([FIRST, SECOND, THIRD]);
      const definitions = await db.projectAcceptanceCriterionDefinition.findMany({ where: { projectId }, select: { id: true, text: true } });
      // Dropping a criterion loosens the ruler, so the edit is held as a proposal for the owner.
      const held = await state([FIRST, THIRD], new Map(definitions.map((d) => [d.text, d.id]))) as { acceptanceCriteriaHold?: { intentId: string } };
      assert.ok(held.acceptanceCriteriaHold, 'the loosening edit is held, not applied');
      proposalProject.set(held.acceptanceCriteriaHold.intentId, projectId);
      return held.acceptanceCriteriaHold.intentId;
    },
    served: async (id) => (await pendingProposal(id)).translation,
    original: async (id) => (await pendingProposal(id)).proposed.map((p) => p.text),
    stored: (id) => storedIn('project_criteria_change_translation', id, 'intent_id'),
    translated: {
      lang: 'zh-Hans',
      proposed: [{ text: zh(FIRST), verificationMethod: zh(METHOD) }, { text: zh(THIRD), verificationMethod: zh(METHOD) }],
    },
    originalValue: [FIRST, THIRD],
    published: (id) => `project_criteria_decisions_changed:${proposalProject.get(id)}`,
  };

  // ── crossing ─────────────────────────────────────────────────────────────────────────────────────
  const CROSSING_TITLE = 'Fix the login page';
  const CROSSING_REASON = 'It belongs to the web project.';
  const crossingFrom = new Map<string, string>();
  const listed = async (id: string) => {
    const row = (await handoffs.listForProject(a.ownerId, crossingFrom.get(id)!)).find((r) => r.id === id);
    assert.ok(row, 'the crossing is listed on its project');
    return row;
  };
  const crossing: CardKind = {
    name: 'crossing',
    file: async () => {
      const from = await project('crossing source');
      const to = await project('crossing target');
      const id = randomUUID();
      // The row `declare` inserts for a question a person has to answer.
      await sql.query(
        `INSERT INTO "project_handoff_approval" (
           "id","owner_id","from_project_id","to_project_id","kind","subject_task_id",
           "payload_digest","crossing_key","state","title","reason","requested_by_session_id","requested_at")
         VALUES ($1,$2,$3,$4,'FILE_TASK',NULL,$5,$6,'PENDING',$7,$8,$9,now())`,
        [id, a.ownerId, from, to, randomUUID().replace(/-/g, '').padEnd(64, '0'), randomUUID().replace(/-/g, '').padEnd(64, '1'),
          CROSSING_TITLE, CROSSING_REASON, a.coordinatorSessionId]);
      // What declare() calls once a PENDING question has committed.
      handoffs.translateFiled(a.ownerId, id);
      crossingFrom.set(id, from);
      return id;
    },
    served: async (id) => (await listed(id)).translation,
    original: async (id) => {
      const row = await listed(id);
      return { title: row.title, reason: row.reason };
    },
    stored: (id) => storedIn('project_handoff_approval', id),
    translated: { lang: 'zh-Hans', title: zh(CROSSING_TITLE), reason: zh(CROSSING_REASON) },
    originalValue: { title: CROSSING_TITLE, reason: CROSSING_REASON },
    published: (id) => `crossing:${id}`,
  };

  const kinds = [startRequest, doneRequest, confirmationReview, confirmationProblems, completionEvidence, criteriaProposal, crossing];

  for (const kind of kinds) {
    await t.test(`${kind.name}: (a) translated after filing and served with it`, async () => {
      await reset();
      await prefer(ON);
      const id = await kind.file();
      await settle();
      assert.deepEqual(await kind.stored(id), kind.translated, 'the translation is stored beside the card');
      assert.deepEqual(await kind.served(id), kind.translated, 'the owner\'s read serves it');
      assert.deepEqual(await kind.original(id), kind.originalValue, 'and the card as the agent wrote it beside it');
      assert.ok(published.includes(kind.published(id)), `${kind.published(id)} is published (got ${published.join(', ')})`);
      for (const text of kind.neverSent ?? []) {
        assert.ok(!asked.some((sent) => sent.includes(text)), `${text} never reaches the translator`);
      }
    });

    await t.test(`${kind.name}: (b) a failed translation is stored as failed and the original is served`, async () => {
      await reset();
      await prefer(ON);
      failing = true;
      resetTranslationBreaker();
      const id = await kind.file();
      await settle();
      failing = false;
      resetTranslationBreaker();
      assert.deepEqual(await kind.stored(id), { lang: 'zh-Hans', failed: true });
      assert.deepEqual(await kind.served(id), { lang: 'zh-Hans', failed: true });
      assert.deepEqual(await kind.original(id), kind.originalValue, 'the original, untouched');
      asked.length = 0;
      await kind.served(id);
      await settle();
      assert.deepEqual(asked, [], 'a card already tried in this language is not translated again on read');
    });

    await t.test(`${kind.name}: (c) translation off: nothing is translated, stored or served`, async () => {
      await reset();
      await prefer(OFF);
      const id = await kind.file();
      await settle();
      await kind.served(id);
      await settle();
      assert.deepEqual(asked, [], 'the translator is never asked');
      assert.equal(await kind.stored(id), null);
      assert.equal(await kind.served(id) ?? undefined, undefined, 'the read carries no translation');
      assert.deepEqual(await kind.original(id), kind.originalValue);
    });

    await t.test(`${kind.name}: (d) switched on after filing: the still-open card is translated on read`, async () => {
      await reset();
      await prefer(OFF);
      const id = await kind.file();
      await settle();
      await prefer(ON);
      assert.equal(await kind.served(id) ?? undefined, undefined, 'the read that queues it serves the original');
      await settle();
      assert.deepEqual(await kind.served(id), kind.translated, 'the next read serves it');
    });
  }

  await t.test('(e) the confirmation report reuses the run event\'s translation and is never translated here', async () => {
    await reset();
    const reportOf = async (id: string) => (await waitingReview(id)).report;
    await prefer(ON);
    const ready = { lang: 'zh-Hans', text: 'ZH[All done: the cards work.]' };
    const inLanguage = await fileConfirmation(ready);
    await settle();
    assert.equal((await reportOf(inLanguage))?.text, 'All done: the cards work.');
    assert.deepEqual((await reportOf(inLanguage))?.translation, ready, 'the event\'s own translation is served');
    assert.ok(!asked.some((text) => text.includes('All done')), 'the report is never sent to the translator');

    const failed = { lang: 'zh-Hans', failed: true };
    assert.deepEqual((await reportOf(await fileConfirmation(failed)))?.translation, failed, 'a failed one is served as failed');

    const otherLanguage = await fileConfirmation({ lang: 'ja', text: 'JA[All done]' });
    assert.equal((await reportOf(otherLanguage))?.translation, undefined, 'one in another language is not served');
    assert.equal((await reportOf(await fileConfirmation()))?.translation, undefined, 'and an untranslated event has none');

    await prefer(OFF);
    assert.equal((await reportOf(inLanguage))?.translation, undefined, 'with translation off none is served');
    await settle();
    assert.ok(!asked.some((text) => text.includes('All done')), 'still never sent to the translator');
  });
});

interface Account {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  coordinatorSessionId: string;
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
    data: { id: ownerId, email: `owner-card-translation-more-${ownerId}@example.invalid`, name: 'owner', passwordHash: 'x', preferences: { translationEnabled: false } },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'owner-card-translation-more', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'owner-card-translation-more', enabled: true } });
  const a = { ownerId, runnerId, workspaceId, coordinatorSessionId: '' };
  a.coordinatorSessionId = await newSession(db, a, 'coordinator', null);
  return a;
}
