/**
 * A DECISION CARD THAT BECOMES THE OWNER'S PUSHES THEM, ONCE (task 354adqnR5U6CZFIfyR5df), against real PostgreSQL.
 *
 * The owner saw "Does this evidence settle the task?" in a task's session and nothing had told them: an evidence card
 * becomes the owner's with no write to hang a push on. `PushService.notifyDecisionCards` is the reconcile tick's pass
 * over the cards that are the owner's now (`owner-cards.ts`, the rows the Needs-you count reads), claiming each in
 * `owner_card_push` before it pushes. Each path by which a card becomes the owner's is a case here:
 *
 *   (1) evidence of a dispatched task: held while its dispatching session has not taken it up and for 30 minutes after
 *       it has; the minute after, one push opening that session — and a second sweep, and a second apiserver (a
 *       restart), push nothing;
 *   (2) the dispatching session ends while it holds the revision: one push at once, opening it;
 *   (3) a task no session dispatched: its card is in its run from the start, and so is the push;
 *   (4) decided while held, or replaced by a later revision, it is never pushed, however late the sweep;
 *   (5) a conversation the owner muted, or set "needs you" off on: claimed, never rung, and not rung later either;
 *   (6) an owner confirmation: with no reviewer at once, and with one, not while it reviews — pushed when its window
 *       runs out, or when the reviewer ends;
 *   (7) a coordinator's request to record the project done: one push, in the coordinator conversation.
 *
 * Project evidence (the coordinator switched off; a paused coordinator, which keeps it), held criteria decisions,
 * unconfirmed standard sets and Record as done… are pushed in the fixtures that count them,
 * `sessions/needs-you-owner-decision.pg.spec.ts`.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/push/decision-card-push.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to this owner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreatorType, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import { RunStatus, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { turnStateOfWord } from '../sessions/session-turn-state';
import { EvidenceReviewService } from '../tasks/evidence-review.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TasksService } from '../tasks/tasks.service';
import type { SessionFixture } from '../test-support/session-word';
import { DECISION_CARD_PUSH_KIND } from './owner-cards';
import { recordedPush, type RecordedPush } from './test-support/recorded-push';

const URL = process.env.COORDINATOR_PG_URL;
const PREFIX = 'evidence-review:v1:';
const WINDOW_MS = 30 * 60_000;
const STANDARD = 'npm test passes and the report names the file it wrote';

test('a decision card that becomes the owner’s pushes them once, where the card is drawn', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  const second = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await second.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const reviews = new EvidenceReviewService(prisma, sessions);
  const evidence = new TaskCompletionEvidenceService(prisma, tasks, undefined, realtime, reviews);
  const one = recordedPush(db);
  // A second apiserver, or the same one after a restart: its own client and nothing in memory.
  const other = recordedPush(second);

  // ── the account: one iPhone, one machine ─────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `owner-${ownerId}@decision-cards.invalid`, name: 'Owner', passwordHash: 'x' } });
  await db.deviceToken.create({
    data: { userId: ownerId, token: `apns-${ownerId}`, platform: 'ios', bundleId: 'io.orbitd.app', environment: 'sandbox' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'decision-cards-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'decision-cards', enabled: true, canCreateTasks: true } });
  const agent = { type: CreatorType.AGENT, id: workspaceId };

  async function conversation(title: string, fixture: SessionFixture = {}) {
    const id = randomUUID();
    const { status: word = RunStatus.AWAITING_INPUT, ...over } = fixture;
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: title, provider: 'claude',
        turnState: turnStateOfWord(word), dispatchOrigin: SessionDispatchOrigin.USER, numTurns: 1, startedAt: new Date(),
        runtimeSessionId: randomUUID(), ...over,
      },
    });
    return id;
  }

  interface Work { taskId: string; run: string }

  /** A task a session files in no project, through the create door, and its run with a check to cite. */
  async function dispatched(title: string, dispatcher: string): Promise<Work> {
    const created = await tasks.create(ownerId, {
      title, completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD, assigneeId: workspaceId,
      autoRunWhenReady: false,
    } as never, agent, dispatcher);
    return { taskId: created.id, run: await runOf(created.id, title) };
  }

  async function runOf(taskId: string, title: string): Promise<string> {
    const run = await conversation(`${title} — run`, { taskId, startsTaskWork: true });
    await db.toolCall.create({
      data: {
        sessionId: run, name: 'Bash', toolUseId: `toolu_${run.slice(0, 8)}`,
        input: { command: 'npm test', description: 'the suite' }, isError: false,
      },
    });
    return run;
  }

  async function submit(work: Work, claim: string) {
    await evidence.submit(ownerId, work.taskId, agent, {
      sourceSessionId: work.run,
      evidence: {
        claim,
        criterion: { key: uuidToBase62(work.taskId), text: STANDARD },
        checks: [{ kind: 'TOOL_CALL', ref: `toolu_${work.run.slice(0, 8)}`, command: 'npm test', succeeded: true }],
        gaps: [],
      },
      idempotencyKey: randomUUID(),
    });
    return db.taskCompletionEvidence.findFirstOrThrow({ where: { taskId: work.taskId }, orderBy: { revision: 'desc' } });
  }

  /** The dispatching session takes the delivery up now: the 30 minutes start here. */
  async function takeUp(dispatcher: string, evidenceId: string, at = new Date()) {
    const taken = await db.conversationTurn.updateMany({
      where: { sessionId: dispatcher, clientTurnId: `${PREFIX}${evidenceId}` },
      data: { deliveredAt: at },
    });
    assert.equal(taken.count, 1, 'the revision was delivered to its dispatching session as a platform turn');
  }

  const later = (ms: number) => new Date(Date.now() + ms);
  const about = (pushes: RecordedPush[], sessionId: string) => pushes.filter((p) => p.payload.sessionID === sessionId);
  const ledger = (key: string) => db.ownerCardPush.count({ where: { ownerId, cardKey: key } });

  await t.test('(1) the 30 minutes lapse: one push, opening the dispatching session — and never a second', async () => {
    const dispatcher = await conversation('files work, then is busy elsewhere');
    const work = await dispatched('archive the August receipts', dispatcher);
    const revision = await submit(work, 'archived all 51');

    assert.deepEqual(about(await one.sweep(ownerId), dispatcher), [], 'delivered and not taken up: the session holds it');
    assert.deepEqual(about(await one.sweep(ownerId, later(10 * WINDOW_MS)), dispatcher), [],
      'queue age starts no window: an unread delivery is held however late the sweep');
    // The delivery is aged rather than the sweep's clock moved: the badge the push carries reads the real clock too.
    await takeUp(dispatcher, revision.id, new Date(Date.now() - WINDOW_MS + 60_000));
    assert.deepEqual(about(await one.sweep(ownerId), dispatcher), [], 'inside the window nobody is asked');

    await takeUp(dispatcher, revision.id, new Date(Date.now() - WINDOW_MS - 30_000));
    const lapsed = about(await one.sweep(ownerId), dispatcher);
    assert.equal(lapsed.length, 1, 'the sweep after the window ran out pushes once');
    const [push] = lapsed;
    assert.equal(push.payload.kind, DECISION_CARD_PUSH_KIND);
    assert.equal(push.payload.cardKind, 'EVIDENCE');
    assert.equal(push.payload.sessionID, dispatcher, 'the tap opens the conversation the card is drawn in');
    assert.equal(push.payload.taskID, work.taskId);
    assert.equal(push.payload.aps.alert.title, 'archive the August receipts');
    assert.equal(push.payload.aps.alert.body, 'Does this evidence settle the task? · Revision 1');
    assert.equal(push.collapseId, `decision-card-evidence:${revision.id}`, 'collapsed per revision');
    assert.ok((push.payload.aps.badge ?? 0) >= 1, 'and it carries the badge, which counts that conversation');
    assert.ok((await one.push.needsYouSessions(ownerId)).includes(dispatcher), 'the badge’s own read counts it');

    assert.deepEqual(about(await one.sweep(ownerId), dispatcher), [], 'a second sweep finds it pushed');
    assert.deepEqual(about(await other.sweep(ownerId, later(60_000)), dispatcher), [],
      'and so does another apiserver, or this one after a restart: the ledger is the memory');
    assert.equal(await ledger(`evidence:${revision.id}`), 1, 'one ledger row for the revision');
  });

  await t.test('(2) the dispatching session ends while it holds the revision: one push, at once', async () => {
    const dispatcher = await conversation('files work, then is ended');
    const work = await dispatched('reconcile the ledger', dispatcher);
    const revision = await submit(work, 'reconciled');
    await takeUp(dispatcher, revision.id);
    assert.deepEqual(about(await one.sweep(ownerId), dispatcher), [], 'held while it is open');

    await db.session.update({ where: { id: dispatcher }, data: { turnState: null, finishedAt: new Date(), completedAt: new Date() } });
    const ended = about(await one.sweep(ownerId), dispatcher);
    assert.equal(ended.length, 1, 'its end hands the card to the owner without the window, and the push with it');
    assert.equal(ended[0].payload.cardKind, 'EVIDENCE');
    assert.equal(ended[0].payload.taskID, work.taskId);
    assert.deepEqual(about(await one.sweep(ownerId), dispatcher), [], 'once');
    assert.ok(!(await one.push.needsYouSessions(ownerId)).includes(dispatcher),
      'a conversation filed away lights no badge, as on the clients; the push still opens it');
  });

  await t.test('(3) a task no session dispatched: the card is in its run from the start, and so is the push', async () => {
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId, title: 'the owner’s standalone task', creatorType: CreatorType.USER, creatorId: ownerId,
        assigneeId: workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCriteria: STANDARD,
      },
    });
    const work = { taskId, run: await runOf(taskId, 'standalone') };
    const revision = await submit(work, 'done');
    const pushed = about(await one.sweep(ownerId), work.run);
    assert.equal(pushed.length, 1, 'nobody holds it, so the first sweep pushes it');
    assert.equal(pushed[0].payload.cardKind, 'EVIDENCE');
    assert.equal(pushed[0].payload.sessionID, work.run, 'opening the run, the one conversation it is drawn in');
    assert.deepEqual(about(await one.sweep(ownerId), work.run), [], 'and only once');
    assert.equal(await ledger(`evidence:${revision.id}`), 1);
  });

  await t.test('(4) decided while held, or replaced by a later revision: never pushed, however late the sweep', async () => {
    const dispatcher = await conversation('files work and reviews it');
    const decided = await dispatched('rename the September invoices', dispatcher);
    const first = await submit(decided, 'renamed all 38');
    await takeUp(dispatcher, first.id);
    await evidence.decide(ownerId, decided.taskId, agent, {
      decidingSessionId: dispatcher, evidenceRevision: '1', decision: 'CONFIRM',
    });
    assert.deepEqual(about(await one.sweep(ownerId, later(2 * WINDOW_MS)), dispatcher), [],
      'a decided revision is nobody’s question');

    const replaced = await dispatched('back up the photo library', dispatcher);
    const old = await submit(replaced, 'backed up most of it');
    await takeUp(dispatcher, old.id, new Date(Date.now() - 2 * WINDOW_MS));
    const newer = await submit(replaced, 'backed up all of it');
    assert.notEqual(newer.id, old.id);
    assert.deepEqual(about(await one.sweep(ownerId, later(WINDOW_MS / 2)), dispatcher), [],
      'the old revision is superseded and the new one is held: nothing to push');
    assert.equal(await ledger(`evidence:${old.id}`), 0, 'and the superseded revision was never claimed');
  });

  await t.test('(5) a muted conversation, or one with "needs you" off: claimed, not rung, and not rung later', async () => {
    for (const quiet of [{ notificationsMuted: true }, { notifyNeedsYou: 'off' }] as const) {
      const taskId = randomUUID();
      await db.task.create({
        data: {
          id: taskId, ownerId, title: `quiet ${JSON.stringify(quiet)}`, creatorType: CreatorType.USER, creatorId: ownerId,
          assigneeId: workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'EVIDENCE_JUDGMENT',
          acceptanceCriteria: STANDARD,
        },
      });
      const work = { taskId, run: await runOf(taskId, 'quiet') };
      await db.session.update({ where: { id: work.run }, data: quiet });
      const revision = await submit(work, 'done');
      assert.deepEqual(about(await one.sweep(ownerId), work.run), [], `${JSON.stringify(quiet)} does not ring`);
      assert.equal(await ledger(`evidence:${revision.id}`), 1, 'but the card is claimed, so it never rings late');
      await db.session.update({ where: { id: work.run }, data: { notificationsMuted: false, notifyNeedsYou: null } });
      assert.deepEqual(about(await one.sweep(ownerId), work.run), [], 'switching it back on rings nothing old');
    }
  });

  // ── an owner confirmation ────────────────────────────────────────────────────────────────────────
  /** An OWNER_CONFIRMED task whose run declared it done and stopped: the request the card asks about. */
  async function confirmation(title: string) {
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId, title, creatorType: CreatorType.USER, creatorId: ownerId, assigneeId: workspaceId,
        status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED', acceptanceCriteria: STANDARD,
      },
    });
    const run = await conversation(`${title} — run`, { taskId, startsTaskWork: true });
    const request = await db.taskOwnerConfirmationRequest.create({
      data: { taskId, ownerId, sessionId: run, turnId: randomUUID() },
      select: { id: true },
    });
    return { taskId, run, requestId: request.id };
  }

  await t.test('(6) an owner confirmation: at once with no reviewer; with one, when its window runs out or it ends', async () => {
    const unreviewed = await confirmation('publish the release notes');
    const now = about(await one.sweep(ownerId), unreviewed.run);
    assert.equal(now.length, 1, 'nobody reviews it, so the card is the owner’s at once');
    assert.equal(now[0].payload.cardKind, 'OWNER_CONFIRMATION');
    assert.equal(now[0].payload.taskID, unreviewed.taskId);
    assert.equal(now[0].payload.aps.alert.body, 'Waiting for your confirmation');
    assert.deepEqual(about(await one.sweep(ownerId), unreviewed.run), [], 'once');

    for (const how of ['timed out', 'reviewer ended'] as const) {
      const reviewer = await conversation(`reviews it (${how})`);
      const reviewed = await confirmation(`rotate the keys (${how})`);
      const clientTurnId = `confirmation-review:${randomUUID()}`;
      await db.conversationTurn.create({
        data: { sessionId: reviewer, seq: 1, clientTurnId, kind: 'message', content: '', status: 'ANSWERED', deliveredAt: new Date() },
      });
      const review = await db.taskOwnerConfirmationReview.create({
        data: {
          requestId: reviewed.requestId, taskId: reviewed.taskId, ownerId, reviewerKind: 'TASK_CREATOR',
          reviewerSessionId: reviewer, windowSeconds: 1_800, dueAt: later(WINDOW_MS), delivery: 'DELIVERED',
          deliveryTurnClientId: clientTurnId, deliveredAt: new Date(),
        },
        select: { id: true },
      });
      assert.deepEqual(about(await one.sweep(ownerId), reviewed.run), [], `under review: nobody else is asked (${how})`);
      if (how === 'timed out') {
        await db.conversationTurn.updateMany({
          where: { sessionId: reviewer, clientTurnId }, data: { deliveredAt: new Date(Date.now() - WINDOW_MS - 60_000) },
        });
      } else {
        await db.taskOwnerConfirmationReview.update({ where: { id: review.id }, data: { reviewerEndedAt: new Date() } });
      }
      const fell = about(await one.sweep(ownerId), reviewed.run);
      assert.equal(fell.length, 1, `${how}: the card is the owner’s, and one push says so`);
      assert.equal(fell[0].payload.cardKind, 'OWNER_CONFIRMATION');
      assert.deepEqual(about(await one.sweep(ownerId), reviewed.run), [], `${how}: once`);
    }
  });

  await t.test('(7) a coordinator asking to record the project done: one push, in the coordinator conversation', async () => {
    const coordinator = await conversation('coordinates the bookkeeping');
    const projectId = randomUUID();
    await db.project.create({
      data: { id: projectId, ownerId, title: 'Bookkeeping', coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId: coordinator },
    });
    const at = new Date();
    const item = await db.projectOpenItem.create({
      data: {
        projectId, ownerId, kind: 'DONE_REQUEST', state: 'OPEN', assignee: 'OWNER', assigneeReason: 'DEFAULT',
        askedBySessionId: coordinator, dedupeKey: 'done-request', title: 'Is this project done?', payload: {},
        waitingSince: at, assignedAt: at, escalateAt: null,
      },
      select: { id: true },
    });
    const pushed = about(await one.sweep(ownerId), coordinator);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].payload.cardKind, 'DONE_REQUEST');
    assert.equal(pushed[0].payload.projectID, projectId);
    assert.equal(pushed[0].payload.aps.alert.body, 'Is this project done?');
    assert.deepEqual(about(await one.sweep(ownerId), coordinator), [], 'once');
    assert.equal(await ledger(`done-request:${item.id}`), 1);
  });
});
