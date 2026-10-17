/**
 * AN ANSWERED QUESTION KEEPS WHAT IT ASKED.
 *
 * `GET /projects/:id/open-items` served a coordinator's question only while it was open
 * (`needsYou`). Once the owner answered it — or the conversation that asked withdrew it — the read
 * dropped it, so the card a conversation drew for it was left with whatever one device had kept in
 * memory: the chosen option's label, and nothing at all after a relaunch or on another device. The
 * question, its options, the recommendation and the owner's words were all still on the item row
 * the whole time (`payload`, `answer`, `resolved_at`, `resolution_note`, the ANSWER delivery).
 *
 * This file witnesses the group the read now carries for them, `closedQuestions` (contract §4.8,
 * §5.2 R10, R12): newest first, at most 50, each with the question as it was asked and what became
 * of it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/open-item-closed-questions.pg.spec.ts
 *
 * THE CASES
 * =========
 *   (a) an option alone: the record carries the question, every option and the recommendation, the
 *       option's index and no words, the moment it was answered, and the conversation the answer
 *       was delivered to — and a question still open is in `needsYou` and nowhere else;
 *   (b) an option and a note: both, as given;
 *   (c) words alone on a question that offered options (the card's Other row): no option;
 *   (d) a question with no options, answered in words;
 *   (e) answered while no conversation coordinated the project: no delivery, until the next
 *       coordinator's binding delivers it (R11) — and the read then names that conversation;
 *   (f) withdrawn: by the conversation that asked it, with its reason and no answer — and by the
 *       owner's own door, which the record says as well;
 *   (g) newest first and at most 50; other kinds' endings and other projects' questions are not in
 *       it, and an open question stays in `needsYou` only.
 *
 * WHY THE GROUP IS READ THROUGH AN OPTIONAL VIEW
 * ==============================================
 * `closedQuestions` is what the change under test adds. Typed through the real declaration, this
 * file would not compile on the tree before the change, and a compile error is not the red this
 * file owes: every case has to fail on an assertion about a record that is not there.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemService } from './project-open-item.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** One ended question as the read serves it — the shape this change adds, kept optional. */
interface ClosedView {
  itemId: string;
  question: {
    question: string;
    options: Array<{ label: string; description?: string }>;
    recommendedOption: number | null;
    blocksTaskIds: string[];
    ifUnanswered: string | null;
  };
  askedAt: Date;
  resolution: string;
  resolvedBy: string;
  resolvedAt: Date;
  answer: { option: number | null; text: string | null } | null;
  delivery: { sessionId: string; at: Date } | null;
  withdrawReason: string | null;
}

interface ReadView {
  needsYou: Array<{ itemId: string; kind: string }>;
  withCoordinator: Array<{ itemId: string }>;
  settled?: Array<{ itemId: string }>;
  closedQuestions?: ClosedView[];
}

interface Stack {
  db: PrismaClient;
  sql: Client;
  items: ProjectOpenItemService;
}

interface Owner {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

/** One project, the conversation coordinating it, and a task a question can block. */
interface Project extends Owner {
  projectId: string;
  coordinatorSessionId: string;
  taskId: string;
}

const QUESTION = [
  '灰度回退之后的收尾都做完了：',
  '',
  '- 新版本部署之后，维护任务恢复了',
  '- 三处修复都已经在生产上',
  '',
  '请批准重开灰度。',
].join('\n');
const OPTIONS = [
  { label: '现在重开，接受这个代价', description: '不专门挑时间。' },
  { label: '等新一轮刚开始时再切', description: '盯着下一轮维护一开始就切。' },
  { label: '先不重开' },
];
const IF_UNANSWERED = 'the rollout stays paused';

test('an ended coordinator question is read back with what it asked and how it ended', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // The production wiring over one client. Only the two notification transports are stand-ins:
  // what this file reads is the open-items read, and a runner being told to look is not part of it.
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const stack: Stack = { db, sql, items: new ProjectOpenItemService(prisma, sessions) };
  const owner = await accountOwner(stack);

  const read = async (p: Project): Promise<ReadView> =>
    (await stack.items.list(p.ownerId, p.projectId)) as unknown as ReadView;
  const closed = async (p: Project): Promise<ClosedView[]> => {
    const view = await read(p);
    assert.ok(Array.isArray(view.closedQuestions),
      'the read carries the questions that have ended, as a group of their own (§4.8)');
    return view.closedQuestions!;
  };
  const ask = async (
    p: Project,
    key: string,
    asked: { options?: typeof OPTIONS; recommendedOption?: number; blocks?: boolean } = {},
  ): Promise<string> => {
    const filed = await stack.items.askOwner(p.ownerId, p.projectId, p.coordinatorSessionId, {
      question: QUESTION,
      options: asked.options ?? OPTIONS,
      ...(asked.recommendedOption !== undefined ? { recommendedOption: asked.recommendedOption } : {}),
      blocksTaskIds: asked.blocks === false ? [] : [p.taskId],
      ifUnanswered: IF_UNANSWERED,
      clientQuestionId: key,
    });
    return filed.itemId;
  };

  await t.test('(a) an option alone: the question, every option and where the answer went', async () => {
    const p = await project(stack, owner, 'option');
    const itemId = await ask(p, 'option', { recommendedOption: 0 });

    const open = await read(p);
    assert.deepEqual(open.needsYou.map((row) => row.itemId), [itemId],
      'an open question is the owner’s to answer, in needsYou');
    assert.deepEqual(open.closedQuestions ?? [], [], 'and it has not ended, so it is not a record yet');

    const answered = await stack.items.answerOpenItem(p.ownerId, p.projectId, itemId, { option: 0 });
    assert.equal(answered.delivery?.sessionId, p.coordinatorSessionId);

    const after = await read(p);
    assert.deepEqual(after.needsYou, [], 'an answered question waits on nobody');
    const [record, ...rest] = await closed(p);
    assert.deepEqual(rest, []);
    const row = await itemRow(stack, itemId);
    const [delivery] = await answerDeliveries(stack, itemId);
    assert.ok(delivery, 'the answer was delivered to the coordinator, and the ledger says so');
    assert.deepEqual(record, {
      itemId,
      question: {
        question: QUESTION,
        options: OPTIONS,
        recommendedOption: 0,
        blocksTaskIds: [p.taskId],
        ifUnanswered: IF_UNANSWERED,
      },
      askedAt: row.created_at,
      resolution: 'ANSWERED',
      resolvedBy: 'USER',
      resolvedAt: row.resolved_at,
      answer: { option: 0, text: null },
      delivery: { sessionId: p.coordinatorSessionId, at: delivery.created_at },
      withdrawReason: null,
    }, 'the question as it was asked — Markdown, options, descriptions, recommendation — and how it '
      + 'ended: the option chosen, when, and the conversation that was told');
  });

  await t.test('(b) an option and a note: both, as given', async () => {
    const p = await project(stack, owner, 'note');
    const itemId = await ask(p, 'note', { recommendedOption: 0 });
    await stack.items.answerOpenItem(p.ownerId, p.projectId, itemId, {
      option: 1,
      text: '  今晚 22 点以后再切，白天有人在用。 ',
    });

    const [record] = await closed(p);
    assert.equal(record?.itemId, itemId);
    assert.deepEqual(record.answer, { option: 1, text: '今晚 22 点以后再切，白天有人在用。' },
      'the option chosen and the note beside it, as the door stored them (trimmed)');
    assert.equal(record.question.recommendedOption, 0,
      'the recommendation stays where the coordinator put it, whatever was chosen');
  });

  await t.test('(c) words alone on a question that offered options: no option', async () => {
    const p = await project(stack, owner, 'other');
    const itemId = await ask(p, 'other');
    await stack.items.answerOpenItem(p.ownerId, p.projectId, itemId, {
      text: '先别取文件，等我明天看过导出脚本再说。',
    });

    const [record] = await closed(p);
    assert.equal(record?.itemId, itemId);
    assert.deepEqual(record.answer, { option: null, text: '先别取文件，等我明天看过导出脚本再说。' },
      'none of the options: the owner’s own words, and an option of null rather than a guess');
    assert.deepEqual(record.question.options, OPTIONS, 'the options it was offered are still there');
    assert.equal(record.question.recommendedOption, null, 'and it recommended none of them');
  });

  await t.test('(d) a question with no options, answered in words', async () => {
    const p = await project(stack, owner, 'free');
    const itemId = await ask(p, 'free', { options: [], blocks: false });
    await stack.items.answerOpenItem(p.ownerId, p.projectId, itemId, { text: '夜里跑，出了问题等我早上看。' });

    const [record] = await closed(p);
    assert.equal(record?.itemId, itemId);
    assert.deepEqual(record.question.options, [], 'a question asked in prose only');
    assert.deepEqual(record.question.blocksTaskIds, []);
    assert.deepEqual(record.answer, { option: null, text: '夜里跑，出了问题等我早上看。' });
    assert.equal(record.delivery?.sessionId, p.coordinatorSessionId);
  });

  await t.test('(e) answered with no coordinator: no delivery until the next one is bound', async () => {
    const p = await project(stack, owner, 'no-coordinator');
    const itemId = await ask(p, 'no-coordinator');
    await sql.query(
      `UPDATE "project" SET "coordinator_session_id" = NULL WHERE "id" = $1::uuid`,
      [p.projectId],
    );
    const answered = await stack.items.answerOpenItem(p.ownerId, p.projectId, itemId, { option: 2 });
    assert.equal(answered.delivery, null, 'nobody coordinates the project, so nobody was told');

    const [waiting] = await closed(p);
    assert.equal(waiting?.itemId, itemId);
    assert.deepEqual(waiting.answer, { option: 2, text: null });
    assert.equal(waiting.delivery, null,
      'the record says the answer has not reached any coordinator — it waits for the next one');

    // The next coordinator is bound, and R11 tells it the answer: the question still blocks a task
    // nobody has settled.
    const next = await coordinatorConversation(stack, owner, 'no-coordinator-next');
    await sql.query(
      `UPDATE "project" SET "coordinator_session_id" = $1::uuid WHERE "id" = $2::uuid`,
      [next, p.projectId],
    );
    await stack.items.deliverOwed(p.projectId);

    const [delivered] = await closed(p);
    const [ledger] = await answerDeliveries(stack, itemId);
    assert.ok(ledger, 'the binding delivered the answer');
    assert.deepEqual(delivered.delivery, { sessionId: next, at: ledger.created_at },
      'and the record now names the conversation it reached, and when');
    assert.deepEqual(delivered.resolvedAt, waiting.resolvedAt, 'the moment it was answered is unmoved');
  });

  await t.test('(f) withdrawn: no answer, the reason, and who withdrew it', async () => {
    const p = await project(stack, owner, 'withdrawn');
    const byCoordinator = await ask(p, 'withdrawn-coordinator');
    const byOwner = await ask(p, 'withdrawn-owner');
    await stack.items.resolveOpenItem(p.ownerId, p.projectId, byCoordinator,
      { note: '灰度已经回退，这一步不需要了。' },
      { kind: 'SESSION', sessionId: p.coordinatorSessionId });
    await stack.items.resolveOpenItem(p.ownerId, p.projectId, byOwner,
      { note: 'asked twice; answered in the other card' }, { kind: 'OWNER' });

    const after = await read(p);
    assert.deepEqual(after.needsYou, [], 'a withdrawn question waits on nobody');
    const records = await closed(p);
    const coordinators = records.find((row) => row.itemId === byCoordinator);
    const owners = records.find((row) => row.itemId === byOwner);
    assert.ok(coordinators && owners, 'both are read back — a withdrawn card is a record too (R12)');
    assert.equal(coordinators.resolution, 'WITHDRAWN');
    assert.equal(coordinators.resolvedBy, 'COORDINATOR', 'the conversation that asked took it back');
    assert.equal(coordinators.withdrawReason, '灰度已经回退，这一步不需要了。');
    assert.equal(coordinators.answer, null, 'nobody answered it');
    assert.equal(coordinators.delivery, null, 'and nothing was delivered about it');
    assert.deepEqual(coordinators.question.options, OPTIONS, 'the question is still what was asked');
    assert.equal(coordinators.resolvedAt.getTime(), (await itemRow(stack, byCoordinator)).resolved_at.getTime());
    assert.equal(owners.resolution, 'WITHDRAWN');
    assert.equal(owners.resolvedBy, 'USER', 'closed through the owner’s door, and the record says so');
    assert.equal(owners.withdrawReason, 'asked twice; answered in the other card');
  });

  await t.test('(g) newest first, at most 50, questions of this project only', async () => {
    const p = await project(stack, owner, 'window');
    const elsewhere = await project(stack, owner, 'window-elsewhere');
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    // 52 ended questions, one a minute, written straight to the table: the order under test is the
    // read's, so the moments are this file's rather than whatever the clock said between presses.
    const seeded: string[] = [];
    for (let minute = 0; minute < 52; minute += 1) {
      seeded.push(await endedQuestion(stack, p, minute, new Date(base + minute * 60_000)));
    }
    // Not questions, not this project's, and not ended: none of them is in the group.
    const exception = await handledException(stack, p, new Date(base + 99 * 60_000));
    const theirs = await endedQuestion(stack, elsewhere, 0, new Date(base + 98 * 60_000));
    const stillOpen = await ask(p, 'window-open');

    const view = await read(p);
    const records = view.closedQuestions ?? [];
    assert.equal(records.length, 50, 'at most 50 — a count, not a window of days');
    assert.deepEqual(records.map((row) => row.itemId), seeded.slice(2).reverse(),
      'newest first: the 50 that ended last, the two oldest left out');
    assert.ok(records.every((row, i) => i === 0
      || row.resolvedAt.getTime() < records[i - 1]!.resolvedAt.getTime()));
    assert.ok(!records.some((row) => row.itemId === exception), 'an exception’s ending is not a question');
    assert.ok(!records.some((row) => row.itemId === theirs), 'another project’s question is not this one’s');
    assert.ok(!records.some((row) => row.itemId === stillOpen), 'an open question has not ended');
    assert.deepEqual(view.needsYou.map((row) => row.itemId), [stillOpen],
      'the open one is in needsYou, as it always was, and nothing that ended is');
    assert.deepEqual((await read(elsewhere)).closedQuestions?.map((row) => row.itemId), [theirs]);
  });
});

/** One account owner with a workspace on a runner that is heartbeating. */
async function accountOwner({ db }: Stack): Promise<Owner> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `closed-questions-${ownerId}@open-items.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'closed-questions-runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'closed-questions-workspace', enabled: true },
  });
  return { ownerId, runnerId, workspaceId };
}

/** A project with a coordinator conversation and one open task under it. */
async function project(stack: Stack, owner: Owner, label: string): Promise<Project> {
  const { db } = stack;
  const projectId = randomUUID();
  const taskId = randomUUID();
  const coordinatorSessionId = await coordinatorConversation(stack, owner, label);
  await db.project.create({
    data: {
      id: projectId,
      ownerId: owner.ownerId,
      title: `closed questions: ${label}`,
      goal: 'an answered question is still readable as what it asked',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: owner.workspaceId,
      coordinatorSessionId,
    },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId: owner.ownerId,
      projectId,
      title: `the work the question is about (${label})`,
      creatorType: CreatorType.USER,
      creatorId: owner.ownerId,
      assigneeId: owner.workspaceId,
      status: TaskStatus.OPEN,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    },
  });
  return { ...owner, projectId, coordinatorSessionId, taskId };
}

/** A conversation parked between turns: what a coordinator is when a turn is queued onto it. */
async function coordinatorConversation({ db }: Stack, owner: Owner, label: string): Promise<string> {
  const sessionId = randomUUID();
  const title = `coordinator: ${label}`;
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: owner.ownerId,
      creatorId: owner.ownerId,
      workspaceId: owner.workspaceId,
      assignedRunnerId: owner.runnerId,
      title,
      prompt: title,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      numTurns: 1,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(sessionId),
      kind: 'message',
      content: title,
      status: 'ANSWERED',
    },
  });
  return sessionId;
}

/** A question answered at `at`, written as the answer door writes one. */
async function endedQuestion({ db }: Stack, p: Project, n: number, at: Date): Promise<string> {
  const row = await db.projectOpenItem.create({
    data: {
      projectId: p.projectId,
      ownerId: p.ownerId,
      kind: 'COORDINATOR_QUESTION',
      state: 'RESOLVED',
      assignee: 'OWNER',
      assigneeReason: 'DEFAULT',
      askedBySessionId: p.coordinatorSessionId,
      dedupeKey: `CQ:seeded-${n}`,
      title: `Coordinator asks: question ${n}`,
      payload: {
        question: `question ${n}`,
        options: [],
        recommendedOption: null,
        blocksTaskIds: [],
        ifUnanswered: null,
      },
      waitingSince: new Date(at.getTime() - 60_000),
      assignedAt: new Date(at.getTime() - 60_000),
      resolution: 'ANSWERED',
      resolvedAt: at,
      resolvedBy: 'USER',
      resolvedByUserId: p.ownerId,
      answer: { text: `answer ${n}`, answeredByUserId: p.ownerId },
    },
    select: { id: true },
  });
  return row.id;
}

/** An exception the coordinator closed by hand at `at` — an ending, but not a question's. */
async function handledException({ db }: Stack, p: Project, at: Date): Promise<string> {
  const row = await db.projectOpenItem.create({
    data: {
      projectId: p.projectId,
      ownerId: p.ownerId,
      kind: 'INTEGRATION_ERROR',
      state: 'RESOLVED',
      assignee: 'COORDINATOR',
      assigneeReason: 'DEFAULT',
      taskId: p.taskId,
      dedupeKey: `IE:${p.taskId}`,
      title: 'The landing stopped on an error',
      payload: {},
      waitingSince: new Date(at.getTime() - 60_000),
      assignedAt: new Date(at.getTime() - 60_000),
      resolution: 'HANDLED',
      resolvedAt: at,
      resolvedBy: 'COORDINATOR',
      resolvedBySessionId: p.coordinatorSessionId,
      resolutionNote: 'landed by hand',
    },
    select: { id: true },
  });
  return row.id;
}

async function itemRow(
  { sql }: Stack,
  itemId: string,
): Promise<{ created_at: Date; resolved_at: Date }> {
  const { rows } = await sql.query<{ created_at: Date; resolved_at: Date }>(
    `SELECT "created_at", "resolved_at" FROM "project_open_item" WHERE "id" = $1::uuid`,
    [itemId],
  );
  assert.ok(rows[0], `item ${itemId} exists`);
  return rows[0];
}

/** The ANSWER deliveries of one item, oldest first. */
async function answerDeliveries(
  { sql }: Stack,
  itemId: string,
): Promise<Array<{ session_id: string; created_at: Date }>> {
  const { rows } = await sql.query<{ session_id: string; created_at: Date }>(
    `SELECT "session_id", "created_at" FROM "project_open_item_delivery"
      WHERE "item_id" = $1::uuid AND "purpose" = 'ANSWER' ORDER BY "created_at", "id"`,
    [itemId],
  );
  return rows;
}
