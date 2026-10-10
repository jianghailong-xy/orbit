/**
 * An OWNER_CONFIRMED request reviewed before its owner is asked, against real PostgreSQL
 * (docs/owner-confirmation-review-contract.md §11.1's list; each case names its clauses):
 *
 *   (1) migration 0370's tables, columns and trigger;
 *   (2) who reviews: the project's coordinator, the session that filed the task, or nobody — and the
 *       refusals a delivery is written down with (S2, S4, D2);
 *   (3) the request and its review commit together, and a request under review is not counted: the
 *       run's row is dark and says "Under review", the task row too (D1, N1, N3);
 *   (4) one delivery per request, a refusal is final, and a delivery a crash cut off is made by the
 *       reviewer's next completion (D2, D4, D5);
 *   (5) the block a reviewer is queued and handed, the card its echo carries, and a failed review turn
 *       re-sent as itself (D2, D3, D6, D7);
 *   (6) the window: frozen at the request, and counted once it runs out (N4, T1);
 *   (7) a reviewer that read it and stopped with nothing to wake it — unless something will (T5);
 *   (8) "not reviewed" never goes back: the reviewer's end is written by the trigger, a retry armed is
 *       not an end, and a review turn taken away unread stops it; Automatic switched off mid-review
 *       changes nothing (§3.1, T1);
 *   (9) a recorded review is counted and drawn with Orbit's first line (§3.5, H2);
 *  (10) outdated: the branch moved, or a newer report came (T1, T3);
 *  (11) the review door's table (§3.5);
 *  (12) a reviewer cannot confirm, at either door (G1);
 *  (13) the owner's answers: Q3's table, Q4's columns, Q5's comment and the reviewer's turn;
 *  (14) the reviewer's return to the run, and B8's table (B3, B5, B7, B8);
 *  (15) the owner confirmed first: the late review under the receipt, problems and the push (L1, L2, L5).
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpException,
} from '@nestjs/common';
import {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
  type Prisma,
} from '@prisma/client';
import { Client } from 'pg';
import { RunEventType, RunStatus as SharedRunStatus, uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { countOwnerDecisionsBySession } from '../projects/owner-decision-signal';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerTaskOwnerConfirmationController } from '../runner-api/runner-task-owner-confirmation.controller';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { SessionsService } from '../sessions/sessions.service';
import type { DecideOwnerConfirmationDto } from './dto';
import { confirmationReviewStates } from './owner-confirmation-review';
import { ownerAnswersCommentId } from './owner-confirmation-review-turn';
import { OwnerConfirmationReviewService } from './owner-confirmation-review.service';
import { TaskOwnerConfirmationController } from './task-owner-confirmation.controller';
import { TaskOwnerConfirmationService } from './task-owner-confirmation.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const SHA_A = 'a1'.repeat(20);
const SHA_B = 'b2'.repeat(20);
const REVIEW_PREFIX = 'owner-confirmation-review:v1:';
const RETURN_PREFIX = 'confirmation-return:v1:';
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

interface RefusalBody {
  code?: string;
  requiredAction?: string;
  message?: string;
  latestRequestId?: string;
  missingKeys?: string[];
}

async function refusedWith(
  call: Promise<unknown>,
  kind: typeof ForbiddenException | typeof ConflictException | typeof BadRequestException,
): Promise<RefusalBody> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof kind, `expected ${kind.name}, got ${error instanceof Error ? error.stack : error}`);
    return (error as HttpException).getResponse() as RefusalBody;
  }
  assert.fail(`expected ${kind.name}, but the call was accepted`);
}

suite('OWNER_CONFIRMED: the reviewer reviews first, the owner still decides', { timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`
    TRUNCATE "task", "session", "project", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);

  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const pushed: string[] = [];
  const push = {
    notifyConfirmationProblems: async (recordId: string) => { pushed.push(recordId); },
  } as unknown as PushService;
  const reviews = new OwnerConfirmationReviewService(prisma, sessions, realtime, push);
  const confirmations = new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime, reviews);
  const userDoor = new TaskOwnerConfirmationController(confirmations);
  const runnerDoor = new RunnerTaskOwnerConfirmationController(confirmations, reviews);
  const runnerApi = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    { expand: async (_owner: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _id: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    undefined,
    sessions,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reviews,
  );

  // ── the account ─────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `owner-${ownerId}@invalid.test`, name: 'Owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'review-runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'review', enabled: true } });
  const runner = await db.runner.findUniqueOrThrow({ where: { id: runnerId } });
  const owner = { userId: ownerId, email: `owner-${ownerId}@invalid.test` };
  const decide = (dto: Record<string, unknown>) => dto as unknown as DecideOwnerConfirmationDto;

  /** A conversation of this account that runs no task: a coordinator, the session a task was filed from. */
  async function conversation(title: string, over: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId: null,
        workspaceId,
        assignedRunnerId: runnerId,
        title,
        prompt: title,
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: false,
        // A conversation that has run: it can be resumed, as a reviewer that failed is by its retry.
        numTurns: 1,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
        ...over,
      },
    });
    return id;
  }
  async function project(title: string, over: Partial<Prisma.ProjectUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.project.create({ data: { id, ownerId, title, ...over } });
    return id;
  }
  interface Run { taskId: string; sessionId: string; reviewer: string | null }
  /** An OWNER_CONFIRMED task filed from `creatorSessionId` (or from no session), and its run. */
  async function runOf(title: string, filed: { projectId?: string | null; creatorSessionId: string | null }): Promise<Run> {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    await db.task.create({
      data: {
        id: taskId,
        ownerId,
        title,
        // USER on purpose: the runner door files a task made inside a session as USER when its call
        // carries no agent header, and the session is what decides (S2).
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        creatorSessionId: filed.creatorSessionId,
        projectId: filed.projectId ?? null,
        assigneeId: workspaceId,
        status: TaskStatus.OPEN,
        completionCriterion: 'OWNER_CONFIRMED',
        acceptanceCriteria: `${title}: the work is on its branch and the suite passes.`,
        autoRunWhenReady: false,
      },
    });
    await db.session.create({
      data: {
        id: sessionId,
        ownerId,
        creatorId: ownerId,
        taskId,
        workspaceId,
        assignedRunnerId: runnerId,
        title,
        prompt: title,
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
        startedAt: new Date(),
        branch: `orbit/${taskId.slice(0, 8)}`,
        numTurns: 1,
      },
    });
    return { taskId, sessionId, reviewer: filed.creatorSessionId };
  }
  /** A task filed from a conversation of its own, outside any project: that conversation reviews it. */
  async function filedRun(title: string): Promise<Run & { reviewer: string }> {
    const reviewer = await conversation(`asked for: ${title}`);
    return { ...(await runOf(title, { creatorSessionId: reviewer })), reviewer };
  }

  let seq = 1_000;
  /** One turn of a session, handed out and spoken in, as the runner leaves it before reporting it. */
  async function turnOf(sessionId: string, words: string): Promise<string> {
    seq += 1;
    const turnId = randomUUID();
    await db.conversationTurn.create({
      data: {
        id: turnId,
        sessionId,
        seq,
        clientTurnId: `message:${turnId}`,
        kind: 'message',
        content: 'carry on',
        status: 'IN_FLIGHT',
        deliveredAt: new Date(),
      },
    });
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING } });
    await say(sessionId, turnId, words);
    return turnId;
  }
  async function say(sessionId: string, turnId: string, words: string) {
    seq += 1;
    await db.runEvent.create({ data: { sessionId, seq, type: 'assistant', payload: { text: words }, turnId } });
  }
  /** An event as the runner reports it, through the door that stores it (and arms a retry on a reply that asks for one). */
  async function ingest(sessionId: string, turnId: string, type: RunEventType, payload: Record<string, unknown>) {
    seq += 1;
    await runnerApi.events({ id: runnerId } as never, sessionId, {
      events: [{ seq, type, ts: new Date().toISOString(), turnId, payload }],
    } as never);
    return (await db.runEvent.findFirstOrThrow({ where: { sessionId, seq } })).payload as Record<string, unknown>;
  }
  function complete(sessionId: string, turnId: string, over: Record<string, unknown> = {}) {
    return runnerApi.turnComplete({ id: runnerId }, sessionId, {
      turnId, status: SharedRunStatus.SUCCEEDED, ...over,
    } as never);
  }
  /** The run declares the work finished in a turn and stops: the request is asked, with its review. */
  async function declare(run: Run, words: string, branchSha?: string): Promise<string> {
    const turnId = await turnOf(run.sessionId, words);
    await runnerDoor.claim(runner, run.taskId, run.sessionId);
    await complete(run.sessionId, turnId, branchSha ? { branchSha } : {});
    return (await latestRequest(run.taskId)).id;
  }
  /** The run is handed the turn queued for it (a return, say), declares in it, and stops. */
  async function declareInQueuedTurn(run: Run, words: string): Promise<string> {
    const handed = await handOut(run.sessionId);
    assert.ok(handed, 'the run had a turn queued');
    await say(run.sessionId, handed.turnId, words);
    await runnerDoor.claim(runner, run.taskId, run.sessionId);
    await complete(run.sessionId, handed.turnId);
    return (await latestRequest(run.taskId)).id;
  }
  /** What the runner's claim does: the next queued turn of a session, handed out. */
  async function handOut(sessionId: string) {
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING } });
    return (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: null): Promise<{ turnId: string; content?: string } | null>;
    }).dequeueTurn(sessionId, runnerId, null);
  }
  async function latestRequest(taskId: string) {
    return db.taskOwnerConfirmationRequest.findFirstOrThrow({
      where: { taskId },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
  }
  async function reviewRow(requestId: string) {
    return db.taskOwnerConfirmationReview.findUnique({ where: { requestId } });
  }
  async function card(taskId: string) {
    return confirmations.read(ownerId, taskId);
  }
  async function waitingOn(sessionId: string): Promise<number> {
    return (await countOwnerDecisionsBySession(db, ownerId, { sessionIds: [sessionId] })).get(sessionId) ?? 0;
  }
  async function row(sessionId: string) {
    const rows = await sessions.list(ownerId, { view: 'open' }) as unknown as Array<{
      id: string; pendingApprovals: number; waitingKind?: string | null;
      confirmationUnderReview?: { requestId: string; taskId: string; reviewerSessionId: string | null; since: Date; dueAt: Date } | null;
    }>;
    return rows.find((each) => each.id === sessionId);
  }
  async function taskRow(taskId: string) {
    return tasks.listRow(ownerId, taskId) as Promise<{ awaitingOwnerConfirmation: boolean; confirmationUnderReview: boolean }>;
  }
  async function turnsKeyed(sessionId: string, prefix: string) {
    return db.conversationTurn.findMany({
      where: { sessionId, clientTurnId: { startsWith: prefix } },
      orderBy: { seq: 'asc' },
    });
  }
  /** The review a reviewer in a turn records: one needsYou line by default. */
  function reviewInput(requestId: string, over: Record<string, unknown> = {}) {
    return {
      requestId,
      judgment: 'Ready, with one call for you.',
      checked: [{ text: 'the suite passes', evidenceRefs: ['ci run 812'] }],
      notChecked: [{ text: 'the load test', whyNotProven: 'no staging capacity', coordinatorChecked: 'read the query plan' }],
      needsYou: [{
        text: 'Ship it behind the flag?',
        options: [{ label: 'Behind the flag' }, { label: 'On for everyone' }],
        recommendedOption: 0,
      }],
      leftOpen: [],
      ...over,
    };
  }

  // (1) ------------------------------------------------------------------------------------------
  await t.test('(1) migration 0370: two tables, the request and session columns, the decision columns, the trigger', async () => {
    const tables = (await sql.query<{ review: string | null; record: string | null }>(
      `SELECT to_regclass('task_owner_confirmation_review')::text AS review,
              to_regclass('task_owner_confirmation_review_record')::text AS record`,
    )).rows[0];
    assert.deepEqual(tables, { review: 'task_owner_confirmation_review', record: 'task_owner_confirmation_review_record' });
    const columns = (await sql.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name, column_name) IN (('task_owner_confirmation_request', 'branch_sha'), ('session', 'branch_sha'),
              ('task_owner_decision', 'review_record_id'), ('task_owner_decision', 'review_state'),
              ('task_owner_decision', 'answers'))
        ORDER BY table_name, column_name`,
    )).rows.map((c) => `${c.table_name}.${c.column_name}`);
    assert.deepEqual(columns, [
      'session.branch_sha',
      'task_owner_confirmation_request.branch_sha',
      'task_owner_decision.answers',
      'task_owner_decision.review_record_id',
      'task_owner_decision.review_state',
    ]);
    const trigger = (await sql.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'task_owner_confirmation_review_reviewer_ended'`,
    )).rows;
    assert.equal(trigger.length, 1);
  });

  // (2) ------------------------------------------------------------------------------------------
  const coordinator = await conversation('the automatic project\'s coordinator');
  const automatic = await project('automatic', {
    coordinatorEnabled: true, coordinatorSessionId: coordinator, exceptionEscalationSeconds: 3_600,
  });
  let outside: Run & { reviewer: string };
  let outsideRequest = '';
  let inProject: Run;
  let inProjectRequest = '';
  let ownersOwn: Run;

  await t.test('(2) who reviews: the session that filed it, the project\'s coordinator, or nobody — and the refusals (S2, S4, D2)', async () => {
    // Outside a project: the conversation the task was filed from, though the task says USER.
    outside = await filedRun('rename the September invoices');
    outsideRequest = await declare(outside, 'Renamed and filed all 38.', SHA_A);
    const out = await reviewRow(outsideRequest);
    assert.ok(out, 'a task filed from a conversation has a reviewer');
    assert.equal(out.reviewerKind, 'TASK_CREATOR');
    assert.equal(out.reviewerSessionId, outside.reviewer);
    assert.equal(out.projectId, null);
    assert.equal(out.windowSeconds, 1_800, 'outside a project the window is 30 minutes (N4)');
    const request = await latestRequest(outside.taskId);
    assert.equal(out.dueAt.getTime(), request.requestedAt.getTime() + 1_800_000, 'counted from the request');
    assert.equal(request.branchSha, SHA_A, 'the request keeps the commit the run reported');
    assert.equal(out.delivery, 'DELIVERED');
    assert.equal(out.deliveryTurnClientId, `${REVIEW_PREFIX}${out.id}`);
    const [delivered] = await turnsKeyed(outside.reviewer, REVIEW_PREFIX);
    assert.ok(delivered, 'the review turn is queued on the reviewer');
    assert.equal(delivered.clientTurnId, out.deliveryTurnClientId);
    assert.equal(delivered.content, '', 'the turn carries nobody\'s words; its block is rendered at delivery');
    assert.equal(delivered.senderSessionId, null, 'a platform delivery, not a session\'s message');
    assert.equal(delivered.status, 'PENDING');

    // In an Automatic project: its coordinator, with the project's window frozen at the request.
    inProject = await runOf('sign off the Q3 vendor review', { projectId: automatic, creatorSessionId: coordinator });
    inProjectRequest = await declare(inProject, 'The vendor review is filed.');
    const inside = await reviewRow(inProjectRequest);
    assert.equal(inside?.reviewerKind, 'PROJECT_COORDINATOR');
    assert.equal(inside?.reviewerSessionId, coordinator);
    assert.equal(inside?.projectId, automatic);
    assert.equal(inside?.windowSeconds, 3_600);
    assert.equal(inside?.delivery, 'DELIVERED');
    await db.project.update({ where: { id: automatic }, data: { exceptionEscalationSeconds: 600 } });
    assert.equal((await reviewRow(inProjectRequest))?.windowSeconds, 3_600, 'a later setting changes no request already asked');

    // Filed by the owner in the app: nobody to ask, so the card is the owner's at once.
    ownersOwn = await runOf('the owner\'s own task', { creatorSessionId: null });
    const ownersRequest = await declare(ownersOwn, 'Done.');
    assert.equal(await reviewRow(ownersRequest), null);
    assert.equal((await card(ownersOwn.taskId)).waiting?.review, null);
    assert.equal(await waitingOn(ownersOwn.sessionId), 1, 'no reviewer: counted at once');

    // A project that is not Automatic: the owner reviews it themselves.
    const manual = await project('manual', { coordinatorEnabled: false });
    const manualRun = await runOf('a manual project task', { projectId: manual, creatorSessionId: await conversation('filer') });
    assert.equal(await reviewRow(await declare(manualRun, 'Done.')), null);

    // Refused at once or at delivery, and then the owner's: no coordinator, an ended reviewer, a pause.
    const headless = await project('automatic, no coordinator', { coordinatorEnabled: true });
    const noCoordinator = await runOf('nobody coordinates', { projectId: headless, creatorSessionId: await conversation('filer 2') });
    const refused = await reviewRow(await declare(noCoordinator, 'Done.'));
    assert.deepEqual([refused?.delivery, refused?.deliveryRefusal], ['REFUSED', 'NO_COORDINATOR']);
    const noCoordinatorCard = await card(noCoordinator.taskId);
    assert.equal(noCoordinatorCard.waiting?.review?.state, 'NOT_REVIEWED');
    assert.equal(noCoordinatorCard.waiting?.review?.notReviewedReason, 'NO_COORDINATOR');
    assert.equal(await waitingOn(noCoordinator.sessionId), 1);

    const ended = await conversation('a filer that has ended', { status: RunStatus.SUCCEEDED, completedAt: new Date() });
    const endedRun = await runOf('its filer ended', { creatorSessionId: ended });
    const endedReview = await reviewRow(await declare(endedRun, 'Done.'));
    assert.deepEqual([endedReview?.delivery, endedReview?.deliveryRefusal], ['REFUSED', 'REVIEWER_ENDED']);
    assert.equal(await turnsKeyed(ended, REVIEW_PREFIX).then((turns) => turns.length), 0, 'an ended session is not revived for it');

    const pausedCoordinator = await conversation('a paused coordinator');
    const paused = await project('paused', { coordinatorEnabled: true, coordinatorSessionId: pausedCoordinator });
    await db.projectFuseEpisode.create({
      data: {
        projectId: paused, ownerId, generation: 1, dimension: 'SELF_STARTED_TURNS', observed: 31, limitValue: 30,
        windowStart: new Date(Date.now() - 3_600_000),
        spend: { selfStartedTurns: 31, sessionsOpened: 0, successorRetries: 0 },
        crossingFact: { kind: 'SELF_STARTED_TURN' },
      },
    });
    const pausedRun = await runOf('its coordinator is paused', { projectId: paused, creatorSessionId: pausedCoordinator });
    const pausedReview = await reviewRow(await declare(pausedRun, 'Done.'));
    assert.deepEqual([pausedReview?.delivery, pausedReview?.deliveryRefusal], ['REFUSED', 'COORDINATOR_PAUSED']);
    assert.equal((await card(pausedRun.taskId)).waiting?.review?.notReviewedReason, 'COORDINATOR_PAUSED');
  });

  // (3) ------------------------------------------------------------------------------------------
  await t.test('(3) the first read after the turn is already "under review": the row is dark and says so (D1, N1, N3)', async () => {
    const view = await card(outside.taskId);
    assert.equal(view.waiting?.requestId, outsideRequest, 'the card is still drawn and can still be pressed');
    assert.equal(view.waiting?.review?.state, 'UNDER_REVIEW');
    assert.equal(view.waiting?.review?.reviewer.title, 'asked for: rename the September invoices');
    assert.equal(view.waiting?.review?.headline, null);
    assert.equal(await waitingOn(outside.sessionId), 0, 'not counted while its reviewer has it');
    const listed = await row(outside.sessionId);
    assert.equal(listed?.pendingApprovals, 0);
    assert.equal(listed?.waitingKind ?? null, null);
    assert.equal(listed?.confirmationUnderReview?.requestId, outsideRequest);
    assert.equal(listed?.confirmationUnderReview?.taskId, outside.taskId);
    assert.equal(listed?.confirmationUnderReview?.reviewerSessionId, outside.reviewer);
    assert.equal(new Date(listed!.confirmationUnderReview!.dueAt).getTime(),
      (await reviewRow(outsideRequest))!.dueAt.getTime());
    assert.deepEqual(await taskRow(outside.taskId).then((r) => [r.awaitingOwnerConfirmation, r.confirmationUnderReview]), [false, true]);
    // The same in an Automatic project: the run's row is dark while the coordinator reviews it.
    assert.equal(await waitingOn(inProject.sessionId), 0);
    assert.equal((await row(inProject.sessionId))?.confirmationUnderReview?.reviewerSessionId, coordinator);
    // A row with nothing under review says so with null, not by leaving the key out.
    assert.equal((await row(ownersOwn.sessionId))?.confirmationUnderReview, null);
  });

  // (4) ------------------------------------------------------------------------------------------
  await t.test('(4) one delivery per request; a refusal is final; a delivery a crash cut off is made later (D2, D4, D5)', async () => {
    const review = (await reviewRow(outsideRequest))!;
    await reviews.deliver(review.id);
    await reviews.deliver(review.id);
    assert.equal((await turnsKeyed(outside.reviewer, REVIEW_PREFIX)).length, 1, 'delivering again writes nothing');
    assert.equal((await reviewRow(outsideRequest))?.deliveredAt?.getTime(), review.deliveredAt?.getTime());

    // A request whose delivery never ran — the process died between the commit and the hand-off.
    const reviewerless = new RunnerApiController(
      prisma, queue, realtime, {} as never, {} as never,
      { expand: async (_owner: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _id: string, content?: string) => content } as never,
      undefined, undefined, tasks,
    );
    const crashed = await filedRun('the hand-off was cut off');
    const turnId = await turnOf(crashed.sessionId, 'Done.');
    await runnerDoor.claim(runner, crashed.taskId, crashed.sessionId);
    await reviewerless.turnComplete({ id: runnerId }, crashed.sessionId, { turnId, status: SharedRunStatus.SUCCEEDED } as never);
    const stuck = (await reviewRow((await latestRequest(crashed.taskId)).id))!;
    assert.equal(stuck.delivery, 'PENDING');
    assert.equal((await card(crashed.taskId)).waiting?.review?.state, 'UNDER_REVIEW', 'pending reads as under review');
    // The reviewer's next completion picks it up.
    const reviewerTurn = await turnOf(crashed.reviewer, 'Something else entirely.');
    await complete(crashed.reviewer, reviewerTurn);
    assert.equal((await reviewRow(stuck.requestId))?.delivery, 'DELIVERED');
    assert.equal((await turnsKeyed(crashed.reviewer, REVIEW_PREFIX)).length, 1);

    // A refused delivery is not tried again.
    const ended = await conversation('ended before it could review', { status: RunStatus.CANCELLED, completedAt: new Date() });
    const refusedRun = await runOf('reviewer gone', { creatorSessionId: ended });
    const refused = (await reviewRow(await declare(refusedRun, 'Done.')))!;
    await reviews.deliver(refused.id);
    assert.deepEqual([(await reviewRow(refused.requestId))?.delivery, (await reviewRow(refused.requestId))?.deliveryRefusal],
      ['REFUSED', 'REVIEWER_ENDED']);
  });

  // (5) ------------------------------------------------------------------------------------------
  await t.test('(5) the block queued is the block handed out, its echo is a card, and a failed review turn is re-sent as itself (D6, D7)', async () => {
    const review = (await reviewRow(outsideRequest))!;
    const queued = (await sessions.listQueuedTurns(ownerId, outside.reviewer)) as unknown as Array<{
      turnId: string; content: string; authoredByOrbit?: true;
      confirmationReviewRequest?: { requestId: string; reviewId: string; taskId: string; runSessionId: string; sha: string | null; branch: string | null };
    }>;
    const listed = queued.find((each) => each.confirmationReviewRequest);
    assert.ok(listed, 'the queued review turn is listed with its card');
    assert.equal(listed.authoredByOrbit, true);
    assert.deepEqual(
      [listed.confirmationReviewRequest?.requestId, listed.confirmationReviewRequest?.reviewId,
        listed.confirmationReviewRequest?.taskId, listed.confirmationReviewRequest?.runSessionId,
        listed.confirmationReviewRequest?.sha],
      [outsideRequest, review.id, outside.taskId, outside.sessionId, SHA_A],
    );
    assert.match(listed.content, new RegExp(`<orbit-confirmation-review task="${uuidToBase62(outside.taskId)}" request-id="${outsideRequest}"`));
    assert.match(listed.content, /What the run reported \(the report the owner's card shows, first 2000 characters\): Renamed and filed all 38\./);
    assert.match(listed.content, /What settles it \(the task's acceptance criteria, first 2000 characters\): rename the September invoices: the work is on its branch/);
    assert.match(listed.content, new RegExp(`Check the work on orbit/${outside.taskId.slice(0, 8)} at ${SHA_A}`));
    assert.match(listed.content, /If you cannot read .* say so under notChecked rather than guessing\./);

    const handed = await handOut(outside.reviewer);
    assert.equal(handed?.turnId, listed.turnId);
    assert.equal(handed?.content, listed.content, 'the same bytes, read by the same function');
    // The runner echoes what it was handed; the stored event carries the card and records the block as Orbit's.
    const echo = await ingest(outside.reviewer, handed!.turnId, RunEventType.USER, { text: handed!.content });
    assert.equal((echo.confirmationReviewRequest as { reviewId: string }).reviewId, review.id);
    assert.equal(echo.controlPlaneNote, handed!.content, 'nobody typed any of it');

    // A review turn that failed is re-sent as itself, not the message before it.
    const retried = await filedRun('the reviewer failed on an overload');
    await declare(retried, 'Done.');
    const retriedHanded = await handOut(retried.reviewer);
    await ingest(retried.reviewer, retriedHanded!.turnId, RunEventType.USER, { text: retriedHanded!.content });
    await ingest(retried.reviewer, retriedHanded!.turnId, RunEventType.ASSISTANT, { text: OVERLOADED });
    await runnerApi.turnComplete({ id: runnerId }, retried.reviewer, {
      turnId: retriedHanded!.turnId, status: SharedRunStatus.FAILED, subtype: 'error_during_execution',
      numTurns: 1, costUsd: 0, error: OVERLOADED,
    } as never);
    const failed = await db.session.findUniqueOrThrow({ where: { id: retried.reviewer } });
    assert.equal(failed.status, RunStatus.FAILED);
    assert.ok(failed.retryAt, 'an overload arms a retry');
    assert.equal((await card(retried.taskId)).waiting?.review?.state, 'UNDER_REVIEW', 'a failure with a retry armed has not ended the reviewer');
    await db.session.update({ where: { id: retried.reviewer }, data: { retryAt: new Date(Date.now() - 60_000) } });
    await db.runner.update({ where: { id: runnerId }, data: { lastHeartbeatAt: new Date() } });
    await new AutoRetryService(prisma, sessions, realtime).sweep();
    const resent = await turnsKeyed(retried.reviewer, `${REVIEW_PREFIX}${(await reviewRow((await latestRequest(retried.taskId)).id))!.id}:retry:`);
    assert.equal(resent.length, 1, 'the sweep re-sent the review turn itself');
    assert.equal(resent[0].content, '');
  });

  // (6) ------------------------------------------------------------------------------------------
  await t.test('(6) the window runs out: not reviewed, counted, and the row lights (N4, T1, N2)', async () => {
    const late = await filedRun('nobody got to it');
    const requestId = await declare(late, 'Done.');
    assert.equal(await waitingOn(late.sessionId), 0);
    const review = (await reviewRow(requestId))!;
    // Read at due_at itself, without moving any row: the clock is the read's.
    const [atDue] = [...(await confirmationReviewStates(db, [{
      id: requestId, taskId: late.taskId, sessionId: late.sessionId, requestedAt: (await latestRequest(late.taskId)).requestedAt,
    }], review.dueAt)).values()];
    assert.deepEqual([atDue.state, atDue.notReviewedReason], ['NOT_REVIEWED', 'TIMED_OUT']);
    await sql.query(`UPDATE "task_owner_confirmation_review" SET "due_at" = now() - interval '1 second' WHERE "id" = $1`, [review.id]);
    assert.equal((await card(late.taskId)).waiting?.review?.notReviewedReason, 'TIMED_OUT');
    assert.equal(await waitingOn(late.sessionId), 1);
    const listed = await row(late.sessionId);
    assert.equal(listed?.waitingKind, 'OWNER_CONFIRMATION');
    assert.equal(listed?.confirmationUnderReview, null);
    assert.deepEqual(await taskRow(late.taskId).then((r) => [r.awaitingOwnerConfirmation, r.confirmationUnderReview]), [true, false]);
  });

  // (7) ------------------------------------------------------------------------------------------
  await t.test('(7) a reviewer that read it and stopped, with nothing left to wake it, did not review it (T5)', async () => {
    const idle = await filedRun('the reviewer forgot the tool');
    const requestId = await declare(idle, 'Done.');
    const handed = await handOut(idle.reviewer);
    await say(idle.reviewer, handed!.turnId, 'Looks fine to me.');
    await complete(idle.reviewer, handed!.turnId);
    const view = await card(idle.taskId);
    assert.deepEqual([view.waiting?.review?.state, view.waiting?.review?.notReviewedReason], ['NOT_REVIEWED', 'REVIEWER_STOPPED']);
    assert.ok((await reviewRow(requestId))?.abandonedAt);
    assert.equal(await waitingOn(idle.sessionId), 1);

    // With a job of its own still running, it may yet answer.
    const busy = await filedRun('the reviewer is waiting on a build');
    await declare(busy, 'Done.');
    const busyTurn = await handOut(busy.reviewer);
    await say(busy.reviewer, busyTurn!.turnId, 'Waiting for the build.');
    await db.session.update({ where: { id: busy.reviewer }, data: { runningBgJobs: ['job-1'] } });
    await complete(busy.reviewer, busyTurn!.turnId);
    assert.equal((await card(busy.taskId)).waiting?.review?.state, 'UNDER_REVIEW');
    assert.equal(await waitingOn(busy.sessionId), 0);
  });

  // (8) ------------------------------------------------------------------------------------------
  await t.test('(8) "not reviewed" does not go back: the reviewer\'s end, a retry, a turn taken away, Automatic switched off (§3.1, T1)', async () => {
    const failing = await filedRun('the reviewer failed for good');
    const failingRequest = await declare(failing, 'Done.');
    await sql.query(`UPDATE "session" SET "status" = 'FAILED' WHERE "id" = $1`, [failing.reviewer]);
    assert.ok((await reviewRow(failingRequest))?.reviewerEndedAt, 'the trigger wrote the end');
    assert.equal((await card(failing.taskId)).waiting?.review?.notReviewedReason, 'REVIEWER_ENDED');
    assert.equal(await waitingOn(failing.sessionId), 1);
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1`, [failing.reviewer]);
    assert.equal((await card(failing.taskId)).waiting?.review?.state, 'NOT_REVIEWED', 'woken again, still not reviewed');
    assert.equal(await waitingOn(failing.sessionId), 1);

    const retrying = await filedRun('the reviewer has a retry armed');
    const retryingRequest = await declare(retrying, 'Done.');
    await sql.query(
      `UPDATE "session" SET "status" = 'FAILED', "retry_at" = now() + interval '1 hour' WHERE "id" = $1`,
      [retrying.reviewer],
    );
    assert.equal((await reviewRow(retryingRequest))?.reviewerEndedAt, null, 'a retry armed is not an end');
    assert.equal((await card(retrying.taskId)).waiting?.review?.state, 'UNDER_REVIEW');
    await sql.query(`UPDATE "session" SET "retry_at" = NULL WHERE "id" = $1`, [retrying.reviewer]);
    assert.ok((await reviewRow(retryingRequest))?.reviewerEndedAt, 'the retry given up is the end');

    const withdrawn = await filedRun('the review turn was withdrawn');
    await declare(withdrawn, 'Done.');
    await sql.query(`DELETE FROM "conversation_turn" WHERE "session_id" = $1 AND "client_turn_id" LIKE $2`,
      [withdrawn.reviewer, `${REVIEW_PREFIX}%`]);
    assert.equal((await card(withdrawn.taskId)).waiting?.review?.notReviewedReason, 'REVIEWER_STOPPED');

    const drained = await filedRun('the review turn was drained unread');
    await declare(drained, 'Done.');
    await sql.query(`UPDATE "conversation_turn" SET "status" = 'ANSWERED', "answered_at" = now()
                      WHERE "session_id" = $1 AND "client_turn_id" LIKE $2`, [drained.reviewer, `${REVIEW_PREFIX}%`]);
    assert.equal((await card(drained.taskId)).waiting?.review?.notReviewedReason, 'REVIEWER_STOPPED');

    // Automatic switched off while the coordinator reviews: the review it has goes on.
    const switching = await conversation('a coordinator whose project is switched off');
    const switched = await project('switched off mid-review', { coordinatorEnabled: true, coordinatorSessionId: switching });
    const switchedRun = await runOf('reviewed across the switch', { projectId: switched, creatorSessionId: switching });
    const switchedRequest = await declare(switchedRun, 'Done.');
    await db.project.update({ where: { id: switched }, data: { coordinatorEnabled: false } });
    assert.equal((await card(switchedRun.taskId)).waiting?.review?.state, 'UNDER_REVIEW');
    await handOut(switching);
    const receipt = await runnerDoor.review(runner, switchedRun.taskId, switching, reviewInput(switchedRequest, { needsYou: [] }));
    assert.equal(receipt.state, 'REVIEWED');
  });

  // (9) ------------------------------------------------------------------------------------------
  let reviewed: Run & { reviewer: string };
  let reviewedRequest = '';
  let reviewedRecord = '';
  let reviewedTurn = '';
  await t.test('(9) a recorded review: counted, and Orbit writes its first line from the lists (§3.5, H2)', async () => {
    reviewed = await filedRun('backfill the two missing days');
    reviewedRequest = await declare(reviewed, 'Both days are backfilled.', SHA_A);
    reviewedTurn = (await handOut(reviewed.reviewer))!.turnId;
    const receipt = await runnerDoor.review(runner, reviewed.taskId, reviewed.reviewer, reviewInput(reviewedRequest, {
      reviewedSha: SHA_A,
      needsYou: [
        { text: 'Ship it behind the flag?', options: [{ label: 'Behind the flag' }, { label: 'On for everyone' }], recommendedOption: 0 },
        { text: 'Keep the old export?', options: [{ label: 'Keep' }, { label: 'Drop' }], recommendedOption: 1 },
      ],
    }));
    assert.deepEqual([receipt.state, receipt.alreadyRecorded, receipt.requestId], ['REVIEWED', false, reviewedRequest]);
    reviewedRecord = receipt.recordId;
    const view = (await card(reviewed.taskId)).waiting!.review!;
    assert.equal(view.state, 'REVIEWED');
    assert.deepEqual(view.headline, { kind: 'NEEDS_YOU', text: 'Ship it behind the flag?', more: 1 });
    assert.equal(view.review?.judgment, 'Ready, with one call for you.');
    assert.ok(!JSON.stringify(view.headline).includes('Ready'), 'the judgment never reaches the first line');
    assert.deepEqual(view.review?.needsYou.map((item) => item.key), ['n1', 'n2']);
    assert.deepEqual(view.review?.checked.map((item) => item.key), ['c1']);
    assert.equal(view.review?.reviewedSha, SHA_A);
    assert.equal(await waitingOn(reviewed.sessionId), 1, 'reviewed: the owner is asked now');
    assert.equal((await row(reviewed.sessionId))?.waitingKind, 'OWNER_CONFIRMATION');
    assert.equal((await row(reviewed.sessionId))?.confirmationUnderReview, null);
    // A retry of the same call in the same turn is the record it wrote.
    const again = await runnerDoor.review(runner, reviewed.taskId, reviewed.reviewer, reviewInput(reviewedRequest, { reviewedSha: SHA_A }));
    assert.deepEqual([again.recordId, again.alreadyRecorded], [reviewedRecord, true]);

    // Nothing that needs the owner: the line counts what was not checked.
    const plain = await filedRun('nothing needs you');
    const plainRequest = await declare(plain, 'Done.');
    await handOut(plain.reviewer);
    await runnerDoor.review(runner, plain.taskId, plain.reviewer, reviewInput(plainRequest, { needsYou: [] }));
    assert.deepEqual((await card(plain.taskId)).waiting?.review?.headline, { kind: 'NOTHING_NEEDS_YOU', notChecked: 1 });
  });

  // (10) -----------------------------------------------------------------------------------------
  await t.test('(10) outdated: the branch moved under the review, or the run reported again (T1, T3)', async () => {
    const moving = await filedRun('the branch moved after its review');
    const movingRequest = await declare(moving, 'Done.', SHA_A);
    await handOut(moving.reviewer);
    await runnerDoor.review(runner, moving.taskId, moving.reviewer, reviewInput(movingRequest, { reviewedSha: SHA_A, needsYou: [] }));
    assert.equal((await card(moving.taskId)).waiting?.review?.state, 'REVIEWED');
    await db.session.update({ where: { id: moving.sessionId }, data: { branchSha: SHA_B } });
    const moved = (await card(moving.taskId)).waiting!.review!;
    assert.deepEqual([moved.state, moved.outdated], ['OUTDATED', { cause: 'BRANCH_MOVED', branchSha: SHA_B }]);
    assert.equal(await waitingOn(moving.sessionId), 1, 'outdated is still the owner\'s to decide');

    const reported = await filedRun('the run reported again');
    const firstRequest = await declare(reported, 'First report.');
    const firstReviewTurn = (await handOut(reported.reviewer))!.turnId;
    await runnerDoor.review(runner, reported.taskId, reported.reviewer, reviewInput(firstRequest, { needsYou: [] }));
    await say(reported.reviewer, firstReviewTurn, 'Recorded.');
    await complete(reported.reviewer, firstReviewTurn);
    const secondRequest = await declare(reported, 'Second report.');
    const first = await latestRequestById(firstRequest);
    const [old] = [...(await confirmationReviewStates(db, [first], new Date())).values()];
    assert.deepEqual([old.state, old.outdated?.cause], ['OUTDATED', 'NEWER_REPORT']);
    assert.equal((await card(reported.taskId)).waiting?.requestId, secondRequest);
    assert.equal((await card(reported.taskId)).waiting?.review?.state, 'UNDER_REVIEW', 'the new report has a review of its own');
  });
  async function latestRequestById(id: string) {
    const request = await db.taskOwnerConfirmationRequest.findUniqueOrThrow({ where: { id } });
    return { id, taskId: request.taskId, sessionId: request.sessionId, requestedAt: request.requestedAt };
  }

  // (11) -----------------------------------------------------------------------------------------
  await t.test('(11) the review door: the reviewer, inside a turn, about the newest request, once (§3.5)', async () => {
    const door = await filedRun('the door\'s table');
    const requestId = await declare(door, 'Done.', SHA_A);
    const stranger = await conversation('somebody else');
    let body = await refusedWith(runnerDoor.review(runner, door.taskId, undefined, reviewInput(requestId)), ForbiddenException);
    assert.equal(body.code, 'CONFIRMATION_REVIEW_REQUIRES_SESSION');
    body = await refusedWith(runnerDoor.review(runner, door.taskId, stranger, reviewInput(requestId)), ForbiddenException);
    assert.equal(body.code, 'CONFIRMATION_REVIEW_NOT_THE_REVIEWER');
    body = await refusedWith(runnerDoor.review(runner, door.taskId, door.sessionId, reviewInput(requestId)), ForbiddenException);
    assert.equal(body.code, 'CONFIRMATION_REVIEW_NOT_THE_REVIEWER', 'the run does not review itself');
    const ownersRequest = (await latestRequest(ownersOwn.taskId)).id;
    body = await refusedWith(runnerDoor.review(runner, ownersOwn.taskId, door.reviewer, reviewInput(ownersRequest)), ForbiddenException);
    assert.equal(body.code, 'CONFIRMATION_REVIEW_NOT_THE_REVIEWER');
    assert.match(body.message ?? '', /no reviewer/);
    body = await refusedWith(runnerDoor.review(runner, door.taskId, door.reviewer, reviewInput(requestId, { reviewedSha: SHA_A })), ConflictException);
    assert.equal(body.code, 'CONFIRMATION_REVIEW_OUTSIDE_TURN', 'queued is not yet read');

    const turn = (await handOut(door.reviewer))!.turnId;
    body = await refusedWith(runnerDoor.review(runner, door.taskId, door.reviewer, reviewInput(requestId)), BadRequestException);
    assert.match(body.message ?? '', /reviewedSha is required/);
    body = await refusedWith(runnerDoor.review(runner, door.taskId, door.reviewer, { ...reviewInput(requestId, { reviewedSha: SHA_A }), verdict: 'ok' }), BadRequestException);
    assert.match(body.message ?? '', /unknown field verdict/);
    const first = await runnerDoor.review(runner, door.taskId, door.reviewer, reviewInput(requestId, { reviewedSha: SHA_A, needsYou: [] }));
    // The run reports again while the reviewer is still in that turn: the request is superseded —
    // and a retry of the same call in the same turn still finds the record it wrote (row 4 before 5).
    const secondRequest = await declare(door, 'Again.', SHA_B);
    const retried = await runnerDoor.review(runner, door.taskId, door.reviewer, reviewInput(requestId, { reviewedSha: SHA_A, needsYou: [] }));
    assert.deepEqual([retried.recordId, retried.alreadyRecorded], [first.recordId, true]);
    await say(door.reviewer, turn, 'Recorded.');
    await complete(door.reviewer, turn);
    const nextTurn = (await handOut(door.reviewer))!.turnId;
    body = await refusedWith(runnerDoor.review(runner, door.taskId, door.reviewer, reviewInput(requestId, { reviewedSha: SHA_A })), ConflictException);
    assert.deepEqual([body.code, body.latestRequestId], ['CONFIRMATION_REVIEW_SUPERSEDED', secondRequest]);
    const second = await runnerDoor.review(runner, door.taskId, door.reviewer, reviewInput(secondRequest, { reviewedSha: SHA_B, needsYou: [] }));
    assert.notEqual(second.recordId, first.recordId);
    await say(door.reviewer, nextTurn, 'Recorded.');
    await complete(door.reviewer, nextTurn);
    const thirdTurn = await turnOf(door.reviewer, 'one more look');
    body = await refusedWith(runnerDoor.review(runner, door.taskId, door.reviewer, reviewInput(secondRequest, { reviewedSha: SHA_B })), ConflictException);
    assert.equal(body.code, 'CONFIRMATION_REVIEW_ALREADY_RECORDED');
    await complete(door.reviewer, thirdTurn);

    // A request with no commit takes no reviewedSha; questions are refused once the owner decided.
    const nosha = await filedRun('no commit reported');
    const noshaRequest = await declare(nosha, 'Done.');
    await handOut(nosha.reviewer);
    body = await refusedWith(runnerDoor.review(runner, nosha.taskId, nosha.reviewer, reviewInput(noshaRequest, { reviewedSha: SHA_A })), BadRequestException);
    assert.match(body.message ?? '', /must not be given/);
    await userDoor.decide(owner, nosha.taskId, undefined, decide({ decision: 'SEND_BACK', requestId: noshaRequest, note: 'Not yet.' }));
    body = await refusedWith(runnerDoor.review(runner, nosha.taskId, nosha.reviewer, reviewInput(noshaRequest)), BadRequestException);
    assert.deepEqual([body.code, body.requiredAction], ['CONFIRMATION_REVIEW_NEEDS_YOU_AFTER_DECISION', 'RETURN_IT_IF_SOMETHING_MUST_CHANGE']);
  });

  // (12) -----------------------------------------------------------------------------------------
  await t.test('(12) the reviewer cannot confirm, at either door, and nothing is written (G1)', async () => {
    const decisionsBefore = await db.taskOwnerDecision.count({ where: { taskId: reviewed.taskId } });
    let body = await refusedWith(
      runnerDoor.decide(runner, reviewed.taskId, reviewed.reviewer, decide({ decision: 'CONFIRM', requestId: reviewedRequest })),
      ForbiddenException,
    );
    assert.equal(body.code, 'OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER');
    body = await refusedWith(
      userDoor.decide(owner, reviewed.taskId, reviewed.reviewer, decide({ decision: 'CONFIRM', requestId: reviewedRequest })),
      ForbiddenException,
    );
    assert.equal(body.code, 'OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER');
    assert.equal(await db.taskOwnerDecision.count({ where: { taskId: reviewed.taskId } }), decisionsBefore);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: reviewed.taskId } })).status, TaskStatus.OPEN);
  });

  // (13) -----------------------------------------------------------------------------------------
  await t.test('(13) the owner answers the review\'s questions on the card: Q3\'s table, Q4\'s columns, Q5\'s comment and turn', async () => {
    let body = await refusedWith(userDoor.decide(owner, reviewed.taskId, undefined, decide({
      decision: 'CONFIRM', requestId: reviewedRequest, reviewRecordId: null,
    })), ConflictException);
    assert.deepEqual([body.code, body.missingKeys], ['OWNER_CONFIRMATION_ANSWERS_REQUIRED', ['n1', 'n2']]);
    body = await refusedWith(userDoor.decide(owner, reviewed.taskId, undefined, decide({
      decision: 'CONFIRM', requestId: reviewedRequest, reviewRecordId: randomUUID(), answers: [],
    })), ConflictException);
    assert.equal(body.code, 'OWNER_CONFIRMATION_REVIEW_STALE');
    body = await refusedWith(userDoor.decide(owner, reviewed.taskId, undefined, decide({
      decision: 'CONFIRM', requestId: reviewedRequest, reviewRecordId: reviewedRecord, answers: [{ key: 'n1', option: 0 }],
    })), ConflictException);
    assert.deepEqual([body.code, body.missingKeys], ['OWNER_CONFIRMATION_ANSWERS_REQUIRED', ['n2']]);
    body = await refusedWith(userDoor.decide(owner, reviewed.taskId, undefined, decide({
      decision: 'CONFIRM', requestId: reviewedRequest, reviewRecordId: reviewedRecord,
      answers: [{ key: 'n1', option: 5 }, { key: 'n2', option: 0 }],
    })), BadRequestException);
    assert.match(body.message ?? '', /nothing was written/);
    body = await refusedWith(userDoor.decide(owner, reviewed.taskId, undefined, decide({
      decision: 'SEND_BACK', requestId: reviewedRequest, note: 'More.', answers: [{ key: 'n1', option: 0 }],
    })), BadRequestException);
    assert.match(body.message ?? '', /nothing was written/);
    assert.equal(await db.taskOwnerDecision.count({ where: { taskId: reviewed.taskId } }), 0, 'every refusal wrote nothing');

    const receipt = await userDoor.decide(owner, reviewed.taskId, undefined, decide({
      decision: 'CONFIRM', requestId: reviewedRequest, reviewRecordId: reviewedRecord,
      answers: [{ key: 'n1', option: 0 }, { key: 'n2', text: 'Keep it until November.' }],
    }));
    assert.equal(receipt.completed, true);
    const decided = await db.taskOwnerDecision.findUniqueOrThrow({ where: { id: receipt.id } });
    assert.equal(decided.reviewState, 'REVIEWED');
    assert.equal(decided.reviewRecordId, reviewedRecord);
    assert.deepEqual(decided.answers, [
      { key: 'n1', option: 0, text: null, source: 'OWNER' },
      { key: 'n2', option: null, text: 'Keep it until November.', source: 'OWNER' },
    ]);
    const comment = await db.taskComment.findUniqueOrThrow({ where: { id: ownerAnswersCommentId(receipt.id) } });
    assert.match(comment.body, /Ship it behind the flag\? — 0\. Behind the flag/);
    assert.match(comment.body, /Keep the old export\? — “Keep it until November\.”/);
    const [told] = await turnsKeyed(reviewed.reviewer, 'owner-confirmation-answers:v1:');
    assert.equal(told?.clientTurnId, `owner-confirmation-answers:v1:${receipt.id}`);
    assert.match(told?.content ?? '', /Ship it behind the flag\? → 0\. Behind the flag/);
    const view = await card(reviewed.taskId);
    assert.equal(view.decisions.at(-1)?.reviewStateAtDecision, 'REVIEWED');
    assert.equal(view.decisions.at(-1)?.answers.length, 2);

    // A client older than reviews is not refused: the recommended options are recorded, marked unseen.
    const older = await filedRun('confirmed from an old client');
    const olderRequest = await declare(older, 'Done.');
    await handOut(older.reviewer);
    await runnerDoor.review(runner, older.taskId, older.reviewer, reviewInput(olderRequest));
    const olderReceipt = await userDoor.decide(owner, older.taskId, undefined, decide({ decision: 'CONFIRM', requestId: olderRequest }));
    const olderDecision = await db.taskOwnerDecision.findUniqueOrThrow({ where: { id: olderReceipt.id } });
    assert.deepEqual(olderDecision.answers, [{ key: 'n1', option: 0, text: null, source: 'NOT_SHOWN' }]);
    const olderComment = await db.taskComment.findUniqueOrThrow({ where: { id: ownerAnswersCommentId(olderReceipt.id) } });
    assert.match(olderComment.body, /the owner's app did not show this question/);

    // A send-back is never refused for a review, and records the state it was made in.
    const sentBack = await filedRun('sent back while under review');
    const sentBackRequest = await declare(sentBack, 'Done.');
    const sentBackReceipt = await userDoor.decide(owner, sentBack.taskId, undefined, decide({
      decision: 'SEND_BACK', requestId: sentBackRequest, note: 'The total is wrong.',
    }));
    assert.equal((await db.taskOwnerDecision.findUniqueOrThrow({ where: { id: sentBackReceipt.id } })).reviewState, 'UNDER_REVIEW');
  });

  // (14) -----------------------------------------------------------------------------------------
  await t.test('(14) the reviewer returns it to the run: the run is told, the owner is not asked (B3, B5, B7, B8)', async () => {
    const back = await filedRun('returned by its reviewer');
    const requestId = await declare(back, 'Done.', SHA_A);
    const reviewerTurn = (await handOut(back.reviewer))!.turnId;
    const returned = await runnerDoor.returnToRun(runner, back.taskId, back.reviewer, {
      requestId, reviewedSha: SHA_A, reason: 'The migration is missing from the branch.',
      problems: [{ text: 'no migration for the new column', evidenceRefs: ['git show --stat HEAD'] }],
    });
    assert.deepEqual([returned.kind, returned.state, returned.alreadyRecorded], ['RETURN', 'RETURNED', false]);
    const [turn] = await turnsKeyed(back.sessionId, RETURN_PREFIX);
    assert.equal(turn?.clientTurnId, `${RETURN_PREFIX}${returned.recordId}`);
    assert.equal(turn?.senderSessionId, null, 'Orbit carries it; it is not a session\'s message');
    assert.equal(turn?.content, '');
    const record = await db.taskOwnerConfirmationReviewRecord.findUniqueOrThrow({ where: { id: returned.recordId } });
    assert.equal(record.returnClientTurnId, turn?.clientTurnId);
    const view = await card(back.taskId);
    assert.equal(view.waiting, null, 'a returned request waits on nobody');
    assert.equal(view.reviewerReturns.length, 1);
    assert.equal(view.reviewerReturns[0].review.state, 'RETURNED');
    assert.equal(view.reviewerReturns[0].review.returned?.reason, 'The migration is missing from the branch.');
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: back.taskId } })).status, TaskStatus.OPEN);
    assert.equal(await waitingOn(back.sessionId), 0, 'nothing lights');
    // The run's queue shows the reviewer's card and block.
    const queued = (await sessions.listQueuedTurns(ownerId, back.sessionId)) as unknown as Array<{
      content: string; confirmationReturn?: { recordId: string; reviewerSessionId: string | null; reason: string };
    }>;
    const listed = queued.find((each) => each.confirmationReturn);
    assert.equal(listed?.confirmationReturn?.recordId, returned.recordId);
    assert.equal(listed?.confirmationReturn?.reviewerSessionId, back.reviewer);
    assert.match(listed?.content ?? '', /^<orbit-confirmation-return task=/);
    assert.match(listed?.content ?? '', /sent back by its reviewer, not by the account owner/);
    // The card the owner had is stale now, and says why; the same call again is the same return.
    let body = await refusedWith(userDoor.decide(owner, back.taskId, undefined, decide({ decision: 'CONFIRM', requestId })), ConflictException);
    assert.equal(body.code, 'OWNER_CONFIRMATION_STALE');
    assert.match(body.message ?? '', /the reviewer sent this report back to the run/);
    const again = await runnerDoor.returnToRun(runner, back.taskId, back.reviewer, {
      requestId, reviewedSha: SHA_A, reason: 'Again.', problems: [{ text: 'again' }],
    });
    assert.deepEqual([again.recordId, again.alreadyRecorded], [returned.recordId, true]);
    await say(back.reviewer, reviewerTurn, 'Returned.');
    await complete(back.reviewer, reviewerTurn);
    const afterTurn = await turnOf(back.reviewer, 'one more look');
    body = await refusedWith(runnerDoor.returnToRun(runner, back.taskId, back.reviewer, {
      requestId, reviewedSha: SHA_A, reason: 'Again.', problems: [{ text: 'again' }],
    }), ConflictException);
    assert.equal(body.code, 'CONFIRMATION_REVIEW_ALREADY_RECORDED');

    // B5: three returns between two decisions of the owner's, then a review for the owner instead.
    // The reviewer stays in its turn; each round the run is handed the return and declares again.
    for (let round = 2; round <= 4; round += 1) {
      const next = await declareInQueuedTurn(back, `Round ${round}.`);
      const call = runnerDoor.returnToRun(runner, back.taskId, back.reviewer, {
        requestId: next, reason: `Round ${round} is still wrong.`, problems: [{ text: 'still wrong' }],
      });
      if (round <= 3) {
        assert.equal((await call).kind, 'RETURN');
      } else {
        body = await refusedWith(call, ConflictException);
        assert.deepEqual([body.code, body.requiredAction], ['CONFIRMATION_RETURN_LIMIT', 'RECORD_A_REVIEW_FOR_THE_OWNER']);
      }
    }
    await complete(back.reviewer, afterTurn);
    // The fourth report is the owner's to decide, on its card.
    const fourth = (await card(back.taskId)).waiting;
    assert.ok(fourth, 'the request the reviewer could not return any more waits on the owner');
    assert.equal(fourth.review?.state, 'UNDER_REVIEW');
    assert.equal((await userDoor.decide(owner, back.taskId, undefined, decide({
      decision: 'CONFIRM', requestId: fourth.requestId, reviewRecordId: null,
    }))).completed, true);

    // B7: once the reviewer returned it, nothing waits — and the owner can still confirm from the
    // task's panel, whatever the reviewer did.
    const panelRun = await filedRun('confirmed from the panel after a return');
    const panelRequest = await declare(panelRun, 'Done.');
    await handOut(panelRun.reviewer);
    await runnerDoor.returnToRun(runner, panelRun.taskId, panelRun.reviewer, {
      requestId: panelRequest, reason: 'One more thing.', problems: [{ text: 'one more thing' }],
    });
    assert.equal((await card(panelRun.taskId)).waiting, null);
    const panel = await userDoor.decide(owner, panelRun.taskId, undefined, decide({ decision: 'CONFIRM', reviewRecordId: null }));
    assert.equal(panel.completed, true);

    // B8: sent back by the owner, the run ended, Automatic off.
    const ownerFirst = await filedRun('the owner sent it back first');
    const ownerFirstRequest = await declare(ownerFirst, 'Done.');
    await userDoor.decide(owner, ownerFirst.taskId, undefined, decide({ decision: 'SEND_BACK', requestId: ownerFirstRequest, note: 'No.' }));
    await handOut(ownerFirst.reviewer);
    body = await refusedWith(runnerDoor.returnToRun(runner, ownerFirst.taskId, ownerFirst.reviewer, {
      requestId: ownerFirstRequest, reason: 'Also no.', problems: [{ text: 'no' }],
    }), ConflictException);
    assert.equal(body.code, 'CONFIRMATION_RETURN_ALREADY_SENT_BACK');

    const endedRun = await filedRun('its run ended');
    const endedRequest = await declare(endedRun, 'Done.');
    await db.session.update({ where: { id: endedRun.sessionId }, data: { completedAt: new Date() } });
    await handOut(endedRun.reviewer);
    body = await refusedWith(runnerDoor.returnToRun(runner, endedRun.taskId, endedRun.reviewer, {
      requestId: endedRequest, reason: 'Fix it.', problems: [{ text: 'broken' }],
    }), ConflictException);
    assert.deepEqual([body.code, body.requiredAction], ['CONFIRMATION_RETURN_RUN_ENDED', 'RECORD_A_REVIEW_FOR_THE_OWNER']);

    // Superseded: the run reported again before the reviewer returned the first report.
    const twice = await filedRun('reported twice before the return');
    const twiceFirst = await declare(twice, 'First.');
    const twiceSecond = await declare(twice, 'Second.');
    await handOut(twice.reviewer);
    body = await refusedWith(runnerDoor.returnToRun(runner, twice.taskId, twice.reviewer, {
      requestId: twiceFirst, reason: 'Fix it.', problems: [{ text: 'broken' }],
    }), ConflictException);
    assert.deepEqual([body.code, body.latestRequestId], ['CONFIRMATION_REVIEW_SUPERSEDED', twiceSecond]);

    // Settled some other way than the owner's confirmation: nothing open to send back.
    const cancelled = await filedRun('cancelled while under review');
    const cancelledRequest = await declare(cancelled, 'Done.');
    await db.task.update({ where: { id: cancelled.taskId }, data: { status: TaskStatus.CANCELLED } });
    await handOut(cancelled.reviewer);
    body = await refusedWith(runnerDoor.returnToRun(runner, cancelled.taskId, cancelled.reviewer, {
      requestId: cancelledRequest, reason: 'Fix it.', problems: [{ text: 'broken' }],
    }), ConflictException);
    assert.equal(body.code, 'CONFIRMATION_RETURN_TASK_SETTLED');

    // A coordinator paused for its spend does not send work back: the card goes to the owner instead.
    const pausingCoordinator = await conversation('a coordinator paused mid-review');
    const pausing = await project('paused before the return', { coordinatorEnabled: true, coordinatorSessionId: pausingCoordinator });
    const pausingRun = await runOf('returned while paused', { projectId: pausing, creatorSessionId: pausingCoordinator });
    const pausingRequest = await declare(pausingRun, 'Done.');
    await db.projectFuseEpisode.create({
      data: {
        projectId: pausing, ownerId, generation: 1, dimension: 'SELF_STARTED_TURNS', observed: 31, limitValue: 30,
        windowStart: new Date(Date.now() - 3_600_000),
        spend: { selfStartedTurns: 31, sessionsOpened: 0, successorRetries: 0 },
        crossingFact: { kind: 'SELF_STARTED_TURN' },
      },
    });
    await handOut(pausingCoordinator);
    body = await refusedWith(runnerDoor.returnToRun(runner, pausingRun.taskId, pausingCoordinator, {
      requestId: pausingRequest, reason: 'Fix it.', problems: [{ text: 'broken' }],
    }), ConflictException);
    assert.deepEqual([body.code, body.requiredAction], ['PROJECT_FUSE_PAUSED', 'RECORD_A_REVIEW_FOR_THE_OWNER']);

    const offCoordinator = await conversation('a coordinator about to be switched off');
    const off = await project('switched off before the return', { coordinatorEnabled: true, coordinatorSessionId: offCoordinator });
    const offRun = await runOf('returned after the switch', { projectId: off, creatorSessionId: offCoordinator });
    const offRequest = await declare(offRun, 'Done.');
    await db.project.update({ where: { id: off }, data: { coordinatorEnabled: false } });
    await handOut(offCoordinator);
    body = await refusedWith(runnerDoor.returnToRun(runner, offRun.taskId, offCoordinator, {
      requestId: offRequest, reason: 'Fix it.', problems: [{ text: 'broken' }],
    }), ConflictException);
    assert.equal(body.code, 'COORDINATOR_DISABLED');
  });

  // (15) -----------------------------------------------------------------------------------------
  await t.test('(15) the owner confirmed first: the review hangs under the receipt, problems are pushed (L1, L2, L5)', async () => {
    const first = await filedRun('the owner did not wait');
    const requestId = await declare(first, 'Done.', SHA_A);
    const confirmed = await userDoor.decide(owner, first.taskId, undefined, decide({ decision: 'CONFIRM', requestId, reviewRecordId: null }));
    assert.equal(confirmed.completed, true);
    assert.equal((await db.taskOwnerDecision.findUniqueOrThrow({ where: { id: confirmed.id } })).reviewState, 'UNDER_REVIEW');
    // The review is still handed over: it is the safety net now.
    const handed = await handOut(first.reviewer);
    assert.match(handed?.content ?? '', /The owner confirmed this at/);
    const late = await runnerDoor.review(runner, first.taskId, first.reviewer, reviewInput(requestId, { reviewedSha: SHA_A, needsYou: [] }));
    assert.equal(late.state, 'REVIEWED');
    let view = await card(first.taskId);
    assert.equal(view.decisions.at(-1)?.review?.state, 'REVIEWED', 'the late review is under the receipt');
    // What it found is recorded as problems, the owner is told, and the run is not.
    const problems = await runnerDoor.returnToRun(runner, first.taskId, first.reviewer, {
      requestId, reviewedSha: SHA_A, reason: 'The export drops a column.', problems: [{ text: 'missing column' }, { text: 'no test' }],
    });
    assert.equal(problems.kind, 'PROBLEMS');
    assert.deepEqual(pushed, [problems.recordId]);
    assert.equal((await turnsKeyed(first.sessionId, RETURN_PREFIX)).length, 0);
    view = await card(first.taskId);
    assert.deepEqual(view.decisions.at(-1)?.review?.headline, { kind: 'PROBLEMS_AFTER_CONFIRM', problems: 2 });
    assert.equal(view.decisions.at(-1)?.review?.problems?.reason, 'The export drops a column.');
    assert.equal(await waitingOn(first.sessionId), 0, 'a settled task asks nobody anything');
  });
});
