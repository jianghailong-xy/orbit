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
 *   (3) An approval whose opener is unknown (`turn_id` null: a row from before 0252, or one raised
 *       outside a turn) is never collected. The predicate needs a fact, and "we do not know who
 *       raised it" is not one.
 *
 * (1) and (2) together are what rule the clock out in both directions; (3) is the guard on the
 * clause that keeps `notIn: []` from becoming "collect everything".
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/abandoned-approvals.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to this owner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
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
  APPROVAL_ABANDONED_MESSAGE,
  APPROVAL_ABANDONED_STATUS,
  reapApprovalsOfEndedTurns,
} from './abandoned-approvals';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Stack {
  db: PrismaClient;
  api: RunnerApiController;
  sessions: SessionsService;
}

/** The production wiring, over one client and with no seam in the paths under test. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const push = { notifyApprovalRequest: async () => undefined } as never;
  return {
    db,
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

  await t.test('(3) an approval whose opener is unknown is never collected', async () => {
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
