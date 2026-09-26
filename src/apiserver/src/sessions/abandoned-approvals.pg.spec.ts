/**
 * AN ABANDONED TOOL CALL STOPS COUNTING — ON A COMMITTED FACT, NEVER ON A DURATION.
 *
 * On 2026-09-09 an `AskUserQuestion` approval held the account owner's "Needs you" badge lit for
 * eight hours with nobody waiting: the engine's permission poll hit `connection reset by peer`, the
 * engine asked again, and the second ask was answered. Being abandoned wrote nothing anywhere,
 * because `approval` has no expiry column and `permissionPrompt` polls with no wall-clock cap.
 *
 * WHY THIS FILE IS NOT ALLOWED TO USE AGE
 * ---------------------------------------
 * "PENDING for longer than N" is elapsed time, not a fact — an hour of silence from a sleeping
 * owner and an hour of silence from a dead poll loop are the same hour, and one of them is a live
 * question. So the predicate is the turn that raised the call, and the cases below are built to
 * make age USELESS as an explanation of any of them:
 *
 *   (1) An approval raised INSIDE a live turn counts, and stays PENDING when the reaper runs —
 *       even with its `created_at` dragged a week into the past. Old and live is not collected.
 *   (2) The turn ends through the REAL turn-complete boundary, and the same row is collected: the
 *       badge falls to zero and the row is ABANDONED, with the reason on it and `decided_at` still
 *       null, because nobody decided anything. A brand-new approval raised inside that same turn
 *       goes with it. Young and dead IS collected.
 *   (3) An approval raised where the engine was running with no turn in flight — the shape a
 *       self-driven stretch leaves (`turn_id` null, no job) — is collected on the card's OWN fact:
 *       its call has returned, which is what the result the engine writes when it stops polling
 *       records. The turn rule can never reach such a row, and a self-driven stretch never reaches
 *       /turn-complete either, so it is collected by the very batch that records the result — before
 *       that, the badge stayed lit for as long as the stretch ran, with no card on any surface to
 *       press.
 *   (4) An approval whose opener is unknown and whose call has said nothing is never collected. The
 *       predicate needs a fact, and "we do not know who raised it" is not one.
 *
 * (1) and (2) together are what rule the clock out in both directions; (4) is the guard on the
 * clause that keeps `notIn: []` from becoming "collect everything", and (3) is what keeps that
 * guard from leaving a card nothing will ever be able to answer.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/abandoned-approvals.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to this owner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  APPROVAL_ABANDONED_CALL_MESSAGE,
  APPROVAL_ABANDONED_JOB_MESSAGE,
  APPROVAL_ABANDONED_MESSAGE,
  APPROVAL_ABANDONED_STATUS,
  APPROVAL_ORPHANED_MESSAGE,
  reapApprovalsOfEndedTurns,
} from './abandoned-approvals';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Stack {
  db: PrismaClient;
  api: RunnerApiController;
  sessions: SessionsService;
  /** Every live frame published, in order: what the clients are told. */
  published: Array<{ sessionId: string; type: string; payload: unknown }>;
}

/** The production wiring, over one client and with no seam in the paths under test. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const published: Stack['published'] = [];
  // Silent, except that `publish` is recorded: its frames are what a client re-reads a count on.
  const realtime = new Proxy({}, {
    get: (_target, name) =>
      name === 'publish'
        ? (sessionId: string, event: { type: string; payload: unknown }) => {
            published.push({ sessionId, type: event.type, payload: event.payload });
          }
        : () => undefined,
  }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const push = { notifyApprovalRequest: async () => undefined } as never;
  return {
    db,
    published,
    sessions: new SessionsService(prisma, queue, realtime),
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      push,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  sessionId: string;
  /** The turn the runner is executing — what the engine's permission prompts are raised inside. */
  turnId: string;
}

/**
 * One owner, one runner, and a session with a turn IN FLIGHT.
 *
 * RUNNING with `engineTurnActive`, because that is the state a blocked permission prompt holds a
 * session in (a prompt does not end the turn) and it is the state `pendingApprovals` counts
 * approvals in at all. `inbox_lease_owner` is left null so the real turn-complete boundary's
 * lease check passes with no lease token.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@abandoned.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} 的会话`,
      prompt: `${label} 的会话`,
      provider: 'claude',
      status: RunStatus.RUNNING,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  const turn = await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(sessionId),
      kind: 'message',
      content: 'ask me something',
      status: 'IN_FLIGHT',
      deliveredAt: new Date(),
    },
    select: { id: true },
  });
  return { ownerId, runnerId, workspaceId, sessionId, turnId: turn.id };
}

test('an approval whose turn ended stops counting, and says so in the row', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'ghost');

  /** How many things the session list says are waiting on this conversation. */
  async function pendingApprovals(): Promise<number> {
    const rows = await stack.sessions.list(f.ownerId, {});
    const row = rows.find((s: { id: string }) => s.id === f.sessionId) as
      | { pendingApprovals: number }
      | undefined;
    assert.ok(row, 'the conversation is in this owner’s Open list');
    return row.pendingApprovals;
  }

  function approval(id: string) {
    return db.approval.findUniqueOrThrow({
      where: { id },
      select: {
        status: true, message: true, decidedAt: true, decidedById: true, turnId: true,
        backgroundJobId: true,
      },
    });
  }

  // The ghost, raised through the real endpoint the runner's MCP server calls — so the turn it
  // records is the one production records, not one this fixture chose.
  const ghost = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'which way?', header: 'Way', options: [] }] },
    toolUseId: `toolu_${randomUUID()}`,
  });

  await t.test('(1) live turn: it counts, and age is not a reason to collect it', async () => {
    assert.equal((await approval(ghost.id)).turnId, f.turnId,
      'the approval records the turn that raised it — that is the whole fact this rests on');
    assert.equal(await pendingApprovals(), 1, 'and the badge is lit, correctly: it is a live ask');

    // A WEEK old, and still a live question. If the predicate were an age threshold, this is the
    // row it would collect; nothing here may.
    await db.approval.update({
      where: { id: ghost.id },
      data: { createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });
    const collected = await reapApprovalsOfEndedTurns(db as never, f.sessionId);
    assert.equal(collected, 0, 'nothing is collected while the turn that asked is still running');
    const after = await approval(ghost.id);
    assert.equal(after.status, 'PENDING', 'the row is untouched');
    assert.equal(await pendingApprovals(), 1, 'and it is still counted, however old it is');
  });

  await t.test('(2) the turn ends: collected, traced, and the badge falls', async () => {
    // A second ask raised in the same still-live turn, created NOW. It is here so that the
    // collection below cannot be explained by age in the other direction either.
    const young = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'and now?', header: 'Now', options: [] }] },
      toolUseId: `toolu_${randomUUID()}`,
    });
    assert.equal(await pendingApprovals(), 2, 'two asks are outstanding inside one live turn');

    // The workspace's reply, up the door the runner posts its transcript to. A turn is ANSWERED
    // because something answered it and not because the engine stopped, so a completion over a
    // turn with none of ANSWERS_USER_TURN under it hands that turn back to PENDING instead of
    // ending it — and the session, with a turn queued again, would stay RUNNING. This is the
    // ordinary turn that WAS answered, so its answer goes in first.
    await stack.api.events({ id: f.runnerId }, f.sessionId, {
      events: [{
        seq: 1,
        type: RunEventType.ASSISTANT,
        ts: new Date().toISOString(),
        turnId: f.turnId,
        payload: { text: 'both of them are the same question' },
      }],
    });

    // The real boundary. Nothing in this spec writes the turn's status by hand: the fact the
    // predicate reads is committed by the same handler the runner calls when a turn ends.
    const done = await stack.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId,
      status: SharedRunStatus.SUCCEEDED,
    });
    assert.deepEqual(done, { ok: true, status: RunStatus.AWAITING_INPUT },
      'the turn completed the ordinary way');
    assert.equal(
      (await db.conversationTurn.findUniqueOrThrow({ where: { id: f.turnId } })).status,
      'ANSWERED',
      'and the fact the reaper reads is on record',
    );

    assert.equal(await pendingApprovals(), 0,
      'the badge is dark: neither ask can ever be answered now');
    for (const [name, id] of [['the eight-hour ghost', ghost.id], ['the fresh one', young.id]]) {
      const row = await approval(id!);
      assert.equal(row.status, APPROVAL_ABANDONED_STATUS, `${name} is collected`);
      assert.equal(row.message, APPROVAL_ABANDONED_MESSAGE,
        `${name} carries the reason nobody will answer it — a trace, not a silent delete`);
      assert.equal(row.decidedAt, null, `${name} was not decided; nobody decided anything`);
      assert.equal(row.decidedById, null, `${name} names no decider, for the same reason`);
      assert.equal(row.turnId, f.turnId, `${name} still names the turn that asked it`);
    }
    assert.equal(await db.approval.count({ where: { sessionId: f.sessionId } }), 2,
      'both rows are still there: the question that was asked stays in the record');
  });

  await t.test('(3) a card raised with no turn at all is collected once its own call returns', async () => {
    // 2026-09-20, in production. The engine runs in stretches of its own — a background task
    // reporting in, a wake-up — that never reach /turn-complete and are recorded as no turn at
    // all (`common/session-generating.ts`). An ask raised in one has no opener to name, so the
    // turn rule above is inert on it by design, and its job is null, so the job rule cannot see it
    // either. What its reader was is the call itself: the MCP poll loop that runs inside it.
    assert.equal(
      await db.conversationTurn.count({ where: { sessionId: f.sessionId, status: { not: 'ANSWERED' } } }),
      0,
      'no turn of this session is in flight — so this card can name no opener',
    );

    const toolUseId = `toolu_${randomUUID()}`;
    const turnless = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: '每模型 A/B 档各跑几次?', header: '测试规模', options: [] }] },
      toolUseId,
    });
    const raised = await approval(turnless.id);
    assert.equal(raised.turnId, null, 'the card names no turn: there was none to name');
    assert.equal(raised.backgroundJobId, null, 'and no job: nothing here names a reader but the call');

    // The engine's own stream opens the call, the way the runtime reports a tool it is running.
    await stack.api.events({ id: f.runnerId }, f.sessionId, {
      events: [{
        seq: 2,
        type: RunEventType.TOOL_USE,
        ts: new Date().toISOString(),
        payload: { id: toolUseId, name: 'AskUserQuestion', input: { questions: [] } },
      }],
    });
    assert.equal(await reapApprovalsOfEndedTurns(db as never, f.sessionId), 0,
      'a call that has STARTED is not a call that has returned — the row is still a live question');
    assert.equal((await approval(turnless.id)).status, 'PENDING', 'and it is untouched');
    assert.equal(await pendingApprovals(), 1, 'so it is counted: somebody really is being asked');

    // The three-hour poll dies the way this one did — `context deadline exceeded` — and the engine
    // writes the result it got and runs on. This is the ONLY trace it leaves, and the same fact
    // `stillBeingAsked` stops offering the card on.
    await stack.api.events({ id: f.runnerId }, f.sessionId, {
      events: [{
        seq: 3,
        type: RunEventType.TOOL_RESULT,
        ts: new Date().toISOString(),
        payload: {
          toolUseId,
          content: 'approval poll failed: context deadline exceeded',
          isError: true,
        },
      }],
    });
    // No reap and no turn boundary in between: the batch that recorded the result is what
    // collected the row. Before, the count stayed lit here — the row that reads "Waiting for
    // approval" with no card to press — until some later /turn-complete ran the reaper.
    const after = await approval(turnless.id);
    assert.equal(after.status, APPROVAL_ABANDONED_STATUS,
      'the row is collected by the batch that recorded its call returning');
    assert.equal(after.message, APPROVAL_ABANDONED_CALL_MESSAGE,
      'with the sentence for the reader it actually lost — neither a turn nor a job');
    assert.equal(after.decidedAt, null, 'nobody decided anything');
    assert.equal(after.decidedById, null, 'so it names no decider');
    assert.equal(after.turnId, null, 'and it still names no turn: there never was one');
    assert.equal(await pendingApprovals(), 0, 'the badge is dark: nothing is waiting on anybody');
    assert.deepEqual(
      stack.published.filter((frame) =>
        frame.type === RunEventType.APPROVAL_RESOLVED
        && (frame.payload as { id?: string }).id === turnless.id),
      [{
        sessionId: f.sessionId,
        type: RunEventType.APPROVAL_RESOLVED,
        payload: { id: turnless.id, status: APPROVAL_ABANDONED_STATUS },
      }],
      'and the clients are told once, so the row stops saying it now rather than on its next poll',
    );
    assert.equal(await reapApprovalsOfEndedTurns(db as never, f.sessionId), 0,
      'the reaper finds nothing left to collect');
    assert.equal(await db.approval.count({ where: { sessionId: f.sessionId } }), 3,
      'the question stays in the record with the other two');
  });

  await t.test('(4) an approval whose opener is unknown is never collected', async () => {
    // Deliberately LAST, when this session has no live turn at all. That is the only state in
    // which the null-opener guard does any work: with no live turns the exclusion list is empty,
    // `NOT IN ()` is a tautology in SQL, and a reaper without the guard would sweep up every
    // PENDING row including the ones it knows nothing about. Run while a turn was still open, this
    // case passes whether the guard is there or not — which would make it decoration.
    assert.equal(
      await db.conversationTurn.count({ where: { sessionId: f.sessionId, status: { not: 'ANSWERED' } } }),
      0,
      'no turn of this session is live — the state the guard is load-bearing in',
    );
    // What every row filed before 0252 looks like, and what a call raised outside a turn looks like.
    const unknownOpener = await db.approval.create({
      data: {
        sessionId: f.sessionId,
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseId: `toolu_${randomUUID()}`,
        turnId: null,
      },
      select: { id: true },
    });
    const collected = await reapApprovalsOfEndedTurns(db as never, f.sessionId);
    assert.equal(collected, 0, 'the reaper declines to guess, so it collects nothing here');
    const row = await approval(unknownOpener.id);
    assert.equal(row.status, 'PENDING', 'an unknown opener is not a dead one');
    assert.equal(row.message, null, 'and nothing was written about it');
  });
});

/**
 * A CARD RAISED INSIDE A TURN IS OVER WHEN ITS CALL RETURNS, NOT WHEN THE TURN DOES.
 *
 * The same failed poll lands mid-turn as easily as mid-stretch: the engine is handed it as the
 * call's result, asks again, and works on inside the same turn — which may run for hours more.
 * The loop that would carry an answer to the first card went with its call, so the card is
 * collected when that result is recorded, with its turn still in flight. The card beside it, whose
 * call is still running, is the control: it stays a live question, and the count keeps it.
 */
test('a card whose call returns mid-turn is collected then, while its turn runs on', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'mid-turn');
  const pendingApprovals = async (): Promise<number> => {
    const rows = await stack.sessions.list(f.ownerId, {});
    const row = rows.find((s: { id: string }) => s.id === f.sessionId) as
      | { pendingApprovals: number }
      | undefined;
    assert.ok(row, 'the conversation is in this owner’s Open list');
    return row.pendingApprovals;
  };
  const approval = (id: string) =>
    db.approval.findUniqueOrThrow({
      where: { id },
      select: { status: true, message: true, decidedAt: true, turnId: true },
    });

  const returning = `toolu_${randomUUID()}`;
  const running = `toolu_${randomUUID()}`;
  const first = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
    toolName: 'ExitPlanMode',
    input: { plan: '# the first draft' },
    toolUseId: returning,
  });
  const control = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'which way?', header: 'Way', options: [] }] },
    toolUseId: running,
  });
  await stack.api.events({ id: f.runnerId }, f.sessionId, {
    events: [
      {
        seq: 1,
        type: RunEventType.TOOL_USE,
        ts: new Date().toISOString(),
        turnId: f.turnId,
        payload: { id: returning, name: 'ExitPlanMode', input: { plan: '# the first draft' } },
      },
      {
        seq: 2,
        type: RunEventType.TOOL_USE,
        ts: new Date().toISOString(),
        turnId: f.turnId,
        payload: { id: running, name: 'AskUserQuestion', input: { questions: [] } },
      },
    ],
  });
  assert.equal((await approval(first.id)).turnId, f.turnId, 'the card names the turn that raised it');
  assert.equal(await pendingApprovals(), 2, 'two calls are waiting on the owner inside one turn');

  // The deploy's 502, as the engine records it, and the turn runs on.
  await stack.api.events({ id: f.runnerId }, f.sessionId, {
    events: [{
      seq: 3,
      type: RunEventType.TOOL_RESULT,
      ts: new Date().toISOString(),
      turnId: f.turnId,
      payload: {
        toolUseId: returning,
        content: 'approval poll failed: GET /runner/sessions/…/approvals/… -> 502 error code: 502',
        isError: true,
      },
    }],
  });

  assert.equal(
    (await db.conversationTurn.findUniqueOrThrow({ where: { id: f.turnId } })).status,
    'IN_FLIGHT',
    'the turn is still running — this collection cannot be explained by the turn ending',
  );
  const collected = await approval(first.id);
  assert.equal(collected.status, APPROVAL_ABANDONED_STATUS, 'the card whose call returned is collected');
  assert.equal(collected.message, APPROVAL_ABANDONED_CALL_MESSAGE,
    'with the sentence for the call, which is the reader it lost — its turn is still there');
  assert.equal(collected.decidedAt, null, 'nobody decided anything');
  assert.equal((await approval(control.id)).status, 'PENDING',
    'the card whose call is still running is untouched: a returned call collects its own card only');
  assert.equal(await pendingApprovals(), 1, 'and the count keeps the one question still being asked');
  assert.deepEqual(
    stack.published
      .filter((frame) => frame.type === RunEventType.APPROVAL_RESOLVED)
      .map((frame) => (frame.payload as { id?: string }).id),
    [first.id],
    'one frame, for the collected card and not for the live one',
  );
});

/**
 * A CARD CAN BE READ BY A PROCESS, AND A PROCESS OUTLIVES THE TURN.
 *
 * 2026-09-19. `orbit project resolve-blocker` run inside a runner-hosted background job raised a
 * card at 06:31:02. The CLI polling for that answer is a child of the job, and a job keeps running
 * after the turn that started it ends — that is what hosting it on the runner is FOR. The turn
 * ended, the reaper collected the row with `the turn that asked this ended`, the CLI was handed
 * exactly that sentence and exited — while the account owner's later Allow, pressed on a card
 * raised the same way INSIDE a turn (01a0b85d-2716-74fc-a36b-b820a4365fb4), was written normally.
 * The one that went through the job (01a0b85c-7627-715e-b9e5-fa71ae8bbdf0) reached nobody.
 *
 * The premise the reaper rests on — "the poll loop that would consume the answer runs INSIDE that
 * turn" — is the one thing a runner-hosted job makes false. So such a card names its job
 * (`approval.background_job_id`, migration 0291) and is collected only once that job is gone from
 * the session's `running_bg_shells`. The cases:
 *
 *   (1) The job's card is raised through the real endpoint, naming a job the runner reports as
 *       running; the in-turn card beside it names none. Both are live questions while the turn is,
 *       and the badge counts both.
 *   (2) The turn ends — through the real boundary, with nothing written by hand. The in-turn card
 *       is collected with the turn's sentence. The job's card is still PENDING, because the process
 *       that would consume the answer is still polling, and a second reap changes nothing.
 *   (3) The job goes — the runner's terminal report is what empties the set. NOW the card is
 *       collected, and the trace names the reader that was lost instead of blaming the turn.
 *   (4) A job that asks with no turn in flight at all — the shape a watch has an hour in, when the
 *       session is parked: `turn_id` null, the job named. The turn rule could never reach this row
 *       (an unknown opener is deliberately left alone), so it is the JOB's liveness that collects
 *       it, and it is collected rather than left PENDING forever the way an unreadable row is.
 *
 * (2)'s in-turn card is the negative control, and (3)+(4) are what keep the exception from being
 * indistinguishable from a card nothing will ever collect: together they pin the decision to the
 * job's liveness, and to nothing else — not the turn, not age, not who is looking.
 */
test('a card a runner-hosted job is still reading outlives the turn that raised it', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'job-card');

  // The job the runner has reported as running for this session: an id it minted (`newBgJobID`),
  // which is the same token `bg_list` answers with and the one the job's own environment carries.
  const jobId = `bgj_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await db.session.update({
    where: { id: f.sessionId },
    data: { runningBgShells: [jobId] },
  });

  function approval(id: string) {
    return db.approval.findUniqueOrThrow({
      where: { id },
      select: {
        status: true, message: true, decidedAt: true, decidedById: true, turnId: true,
        backgroundJobId: true,
      },
    });
  }

  async function pendingApprovals(): Promise<number> {
    const rows = await stack.sessions.list(f.ownerId, {});
    const row = rows.find((s: { id: string }) => s.id === f.sessionId) as
      | { pendingApprovals: number }
      | undefined;
    assert.ok(row, 'the conversation is in this owner’s Open list');
    return row.pendingApprovals;
  }

  // The card the CLI inside that job raises: through the real endpoint, declaring the job its
  // environment carries — which is what makes the turn in flight incidental to who reads it.
  const fromJob = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
    toolName: 'orbit_blocker_resolve',
    input: { projectId: 'p1', blockerId: 'b1', reason: 'the migration landed' },
    backgroundJobId: jobId,
  });
  // The card the same session raises INSIDE the turn, with no job behind it: the control.
  const inTurn = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'which way?', header: 'Way', options: [] }] },
    toolUseId: `toolu_${randomUUID()}`,
  });

  await t.test('(1) while the turn runs, both are live questions and the badge counts both', async () => {
    for (const [name, id] of [['the job’s card', fromJob.id], ['the in-turn card', inTurn.id]]) {
      const row = await approval(id!);
      assert.equal(row.turnId, f.turnId, `${name} names the turn that was in flight when it was raised`);
      assert.equal(row.status, 'PENDING', `${name} is a pending question`);
    }
    assert.equal((await approval(fromJob.id)).backgroundJobId, jobId,
      'and the job’s card says which process is reading it — the fact the collection below turns on');
    assert.equal((await approval(inTurn.id)).backgroundJobId, null,
      'while one raised in the turn names no job, whatever else is running in the session');
    assert.equal(await pendingApprovals(), 2, 'both are questions the badge is right to light');
    assert.equal(await reapApprovalsOfEndedTurns(db as never, f.sessionId), 0,
      'and nothing is collected while the turn that raised them is still running');
  });

  await t.test('(2) the turn ends: the in-turn card is collected, the job’s card is not', async () => {
    // The workspace's reply first, for the reason the first test's case (2) has one: a turn nothing
    // answered goes back to the queue instead of ending, and this case needs the turn to END.
    await stack.api.events({ id: f.runnerId }, f.sessionId, {
      events: [{
        seq: 1,
        type: RunEventType.ASSISTANT,
        ts: new Date().toISOString(),
        turnId: f.turnId,
        payload: { text: 'both of them are the same question' },
      }],
    });
    const done = await stack.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId,
      status: SharedRunStatus.SUCCEEDED,
    });
    assert.deepEqual(done, { ok: true, status: RunStatus.AWAITING_INPUT },
      'the turn completed the ordinary way');
    assert.equal(await db.conversationTurn.count({
      where: { sessionId: f.sessionId, status: { not: 'ANSWERED' } },
    }), 0, 'every turn of this session is over — the state the collection below happens in');

    const control = await approval(inTurn.id);
    assert.equal(control.status, APPROVAL_ABANDONED_STATUS,
      'the card raised inside the turn is collected: its poll loop went with the turn');
    assert.equal(control.message, APPROVAL_ABANDONED_MESSAGE, 'and says so in the row');

    const survived = await approval(fromJob.id);
    assert.equal(survived.status, 'PENDING',
      'the job’s card is untouched: the process polling for that answer is still running, and the ' +
      'turn ending says nothing about it');
    assert.equal(survived.message, null, 'nothing was written about it');
    assert.equal(await reapApprovalsOfEndedTurns(db as never, f.sessionId), 0,
      'and a second reap over the same ended turn collects nothing here either');
    assert.equal((await approval(fromJob.id)).status, 'PENDING', 'it is still a live question');
  });

  await t.test('(3) the job goes: collected, and the trace names the reader that was lost', async () => {
    // What the runner's terminal report does to this column when a job exits or is killed — and the
    // CLI that was polling is a descendant of that job's process tree, so it went with it.
    await db.session.update({ where: { id: f.sessionId }, data: { runningBgShells: [] } });

    assert.equal(await reapApprovalsOfEndedTurns(db as never, f.sessionId), 1,
      'the card is collected now, and only now');
    const row = await approval(fromJob.id);
    assert.equal(row.status, APPROVAL_ABANDONED_STATUS, 'the row is collected');
    assert.equal(row.message, APPROVAL_ABANDONED_JOB_MESSAGE,
      'with the sentence for the reader it actually lost — the turn had nothing to do with it');
    assert.equal(row.decidedAt, null, 'nobody decided anything, here too');
    assert.equal(row.decidedById, null, 'so it names no decider');
    assert.equal(row.backgroundJobId, jobId, 'the row still names the job that asked');
    assert.equal(row.turnId, f.turnId, 'and the turn it was raised under');
    assert.equal(await db.approval.count({ where: { sessionId: f.sessionId } }), 2,
      'both questions stay in the record');
  });

  await t.test('(4) a job that asks with no turn in flight is collected when IT goes', async () => {
    // The shape a watch has an hour in: the session is parked, so there is no turn in flight to
    // name and `turn_id` is null. The turn rule can never reach such a row — by design, since an
    // unknown opener is not evidence of anything. This one's reader IS known, though: its job. So
    // the job's liveness is what settles it, in both directions.
    assert.equal(await db.conversationTurn.count({
      where: { sessionId: f.sessionId, status: { not: 'ANSWERED' } },
    }), 0, 'no turn of this session is in flight — what makes this card’s opener unknown');

    const watchJob = `bgj_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await db.session.update({ where: { id: f.sessionId }, data: { runningBgShells: [watchJob] } });
    const fromParkedJob = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
      toolName: 'orbit_task_create',
      input: { title: 'CI is green: open the follow-up' },
      backgroundJobId: watchJob,
    });
    assert.equal((await approval(fromParkedJob.id)).turnId, null,
      'the row names no turn, because there was none to name');
    assert.equal((await approval(fromParkedJob.id)).backgroundJobId, watchJob,
      'and names the process that is asking — which is the reader the collection below turns on');

    assert.equal(await reapApprovalsOfEndedTurns(db as never, f.sessionId), 0,
      'while that job is up the card is a live question, whatever the turn rule would say about it');

    // The job ends, the way the runner reports one: the set empties.
    await db.session.update({ where: { id: f.sessionId }, data: { runningBgShells: [] } });
    assert.equal(await reapApprovalsOfEndedTurns(db as never, f.sessionId), 1,
      'and then it is collected — not left PENDING for a turn rule that could never reach it');
    const row = await approval(fromParkedJob.id);
    assert.equal(row.status, APPROVAL_ABANDONED_STATUS, 'the row is collected');
    assert.equal(row.message, APPROVAL_ABANDONED_JOB_MESSAGE, 'with the sentence for the reader it lost');
    assert.equal(row.turnId, null, 'still naming no turn: there never was one');
    assert.equal(row.decidedAt, null, 'and nobody decided anything');
  });
});

/**
 * THE OTHER WAY A CARD DIES: ITS READER IS REPLACED, AND ITS TURN RUNS ON.
 *
 * 2026-09-16. A create card was raised at 05:53; the runner restarted at 06:01; the turn was
 * re-delivered to the new process at 06:03 and kept its id, so every fact the reaper above reads
 * still said "live" — and it was live. The account owner answered at 06:02, on two identical cards
 * by then, and nothing happened either time: both poll loops had died with the process nine
 * minutes earlier.
 *
 * The cases below are built so that the collection cannot be explained by the turn ending (it does
 * not end anywhere in this test) nor by a rotation on its own:
 *
 *   (1) The card is raised the way `askBeforeCreate` raises one — no `tool_use_id`, the shape that
 *       neither the client's pairing rule nor `stillBeingAsked` can ever settle — and the
 *       turn-ended reaper correctly declines to collect it.
 *   (2) A different process takes the session over. The card is collected, the trace says why, and
 *       the turn it was raised in is STILL IN FLIGHT at the end of the case.
 *   (3) A takeover that does not rotate the owner collects nothing: the process reading the card
 *       is the one that was already reading it.
 *   (4) A first claim collects nothing. A session whose lease owner was null lost no process, and
 *       "nobody was supervising it" is not evidence about who is reading its cards.
 */
test('a card whose reader is replaced stops counting, while its turn runs on', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'orphan');
  const predecessor = randomUUID();
  await db.session.update({
    where: { id: f.sessionId },
    data: { inboxLeaseOwner: predecessor, inboxLeaseGeneration: randomUUID() },
  });

  async function pendingApprovals(): Promise<number> {
    const rows = await stack.sessions.list(f.ownerId, {});
    const row = rows.find((s: { id: string }) => s.id === f.sessionId) as
      | { pendingApprovals: number }
      | undefined;
    assert.ok(row, 'the conversation is in this owner’s Open list');
    return row.pendingApprovals;
  }

  const approval = (id: string) =>
    db.approval.findUniqueOrThrow({
      where: { id },
      select: { status: true, message: true, decidedAt: true, decidedById: true, turnId: true },
    });
  const turnIsLive = async () =>
    (await db.conversationTurn.findUniqueOrThrow({ where: { id: f.turnId } })).status === 'IN_FLIGHT';

  // Raised as `askBeforeCreate` raises one: Orbit's own confirmation card, with no tool_use id to
  // pair a result against. It is the shape with no other way of ever being settled.
  const card = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
    toolName: 'orbit_task_create',
    input: { title: '撤回排队中的唤醒轮次会把它承载的 wake/wakeup 行丢在半空' },
  });

  await t.test('(1) the turn is live, so the turn-ended reaper leaves it alone', async () => {
    assert.equal((await approval(card.id)).turnId, f.turnId, 'it records the turn that raised it');
    assert.equal(await pendingApprovals(), 1, 'and the badge is lit');
    assert.equal(await reapApprovalsOfEndedTurns(db as never, f.sessionId), 0,
      'nothing there is wrong: the turn really is still running');
  });

  await t.test('(2) a different process takes over: collected, traced, turn still in flight', async () => {
    const successor = randomUUID();
    await stack.api.takeoverLeases({ id: f.runnerId }, f.sessionId, {
      leaseOwner: successor, expectedLeaseOwner: predecessor,
    } as never);

    assert.ok(await turnIsLive(),
      'the turn is untouched — this collection cannot be explained by the turn ending');
    const row = await approval(card.id);
    assert.equal(row.status, APPROVAL_ABANDONED_STATUS, 'the card is collected');
    assert.equal(row.message, APPROVAL_ORPHANED_MESSAGE,
      'and carries the reason nobody will answer it — a trace, not a silent delete');
    assert.equal(row.decidedAt, null, 'nobody decided anything');
    assert.equal(row.decidedById, null, 'so it names no decider');
    assert.equal(await db.approval.count({ where: { sessionId: f.sessionId } }), 1,
      'the question that was asked stays in the record');

    // The state the account owner was actually in at 06:02, and the only one in which the badge
    // proves anything: the successor is generating again (a takeover clears `engineTurnActive`,
    // and `stillBeingAsked` counts nothing at all while it is false), the turn is live, and the
    // card is still on their screen. Restored by hand because the re-delivery that does it in
    // production is a different boundary; what is under test is whether the card can be answered.
    await db.session.update({ where: { id: f.sessionId }, data: { engineTurnActive: true } });
    assert.equal(await pendingApprovals(), 0, 'the badge is dark: an answer would reach nobody');
  });

  await t.test('(3) a takeover that rotates nothing collects nothing', async () => {
    const holder = randomUUID();
    await db.session.update({ where: { id: f.sessionId }, data: { inboxLeaseOwner: holder } });
    const live = await stack.api.createApproval({ id: f.runnerId }, f.sessionId, {
      toolName: 'orbit_task_create',
      input: { title: '还在问的那张' },
    });

    await stack.api.takeoverLeases({ id: f.runnerId }, f.sessionId, {
      leaseOwner: holder, expectedLeaseOwner: holder,
    } as never);

    assert.equal((await approval(live.id)).status, 'PENDING',
      'the process reading this card is the one that was already reading it');
    assert.equal(await pendingApprovals(), 1, 'so it is still a live question');
  });

  await t.test('(4) a first claim collects nothing — there was no reader to lose', async () => {
    const g = await fixture(db, 'first-claim');
    const fresh = await stack.api.createApproval({ id: g.runnerId }, g.sessionId, {
      toolName: 'orbit_task_create',
      input: { title: '刚发出的那张' },
    });
    assert.equal(
      (await db.session.findUniqueOrThrow({ where: { id: g.sessionId } })).inboxLeaseOwner,
      null,
      'nobody has claimed this session yet — the state the null-predecessor guard is for',
    );

    await stack.api.takeoverLeases({ id: g.runnerId }, g.sessionId, {
      leaseOwner: randomUUID(), expectedLeaseOwner: null,
    } as never);

    assert.equal((await approval(fresh.id)).status, 'PENDING',
      'a claim with no predecessor says nothing about who is reading this card');
  });
});
