/**
 * What a heartbeat the link gateway forwarded is answered with in `linkHints.approvals` (runner-link-hints.ts;
 * docs/runner-link-design.md §5.5): the approvals of the runner's sessions that a person allowed or denied, while the
 * reader the card names is still there to take the answer. The gateway states them in HeartbeatAck's HintState, so a
 * runner that lost an ApprovalHint reads its decision at the next beat.
 *
 * Over a real PostgreSQL (`scripts/run-pg-spec.sh` migrates it from empty), on rows written as the doors write them:
 *
 *   1. the statement names, for the runner it is asked about and no other, each decided card whose reader is up: a
 *      card of the running turn whose call has not returned (or not been reported yet), a card the turn asked that
 *      names no call, a call's card raised with no turn in flight, a card a runner-hosted job asked while that job is
 *      up, and a card asked in a stretch the engine started for itself;
 *   2. it leaves out a card nobody decided, one collected as ABANDONED, one whose call returned, one of an answered
 *      turn, one that names no reader at all, one of a session that does not generate, one whose job ended, and the
 *      cards of a session that ended; the inbox and the claim it answers beside them are what they were;
 *   3. each card leaves the list when its reader goes: its call returns, its turn is answered, its job ends, the
 *      session stops generating;
 *   4. the heartbeat route answers a link call with them, and an HTTPS heartbeat without linkHints at all.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-link-hints.pg.spec.ts
 *
 * Not destructive: every row belongs to the account this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { type PrismaClient, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from './runner-api.controller';
import { readRunnerLinkHints } from './runner-link-hints';

const URL_ = process.env.COORDINATOR_PG_URL;

type Named = { sessionId: string; approvalId: string };
const byApproval = (xs: Named[]) => [...xs].sort((a, b) => a.approvalId.localeCompare(b.approvalId));

test('linkHints.approvals: the decided approvals whose reader is still waiting, for their runner alone', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `link-hints-${ownerId}@runner-link.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  const machine = async (name: string) => {
    const id = randomUUID();
    await prisma.runner.create({ data: { id, ownerId, name, tokenHash: sha256(`link-hints-${id}`) } });
    return id;
  };
  const runnerA = await machine('machine A');
  const runnerB = await machine('machine B');
  const idle = await machine('a machine with nothing on it');

  const session = async (runnerId: string, status: RunStatus, extra: { runningBgShells?: string[]; engineTurnActive?: boolean } = {}) => {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id, ownerId, creatorId: ownerId, title: 'a session', prompt: 'work', provider: 'claude', status,
        dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false, assignedRunnerId: runnerId, numTurns: 1, ...extra,
      },
    });
    return id;
  };
  let turnSeq = 0;
  const turn = async (sessionId: string, status: 'PENDING' | 'IN_FLIGHT' | 'ANSWERED') => {
    const id = randomUUID();
    await prisma.conversationTurn.create({
      data: { id, sessionId, seq: ++turnSeq, clientTurnId: randomUUID(), status, content: 'a message' },
    });
    // In the database's own clock, as the inbox reads it: a lease that is still running.
    if (status === 'IN_FLIGHT') {
      await sql.query(`UPDATE "conversation_turn" SET "lease_deadline_at" = now() + interval '5 minutes' WHERE id = $1::uuid`, [id]);
    }
    return id;
  };
  /** A card as the runner door files it, and as the decision door leaves it. */
  const card = async (sessionId: string, status: 'PENDING' | 'ALLOWED' | 'DENIED' | 'ABANDONED',
    reader: { turnId?: string; toolUseId?: string; backgroundJobId?: string } = {}) => {
    const decided = status === 'ALLOWED' || status === 'DENIED';
    const row = await prisma.approval.create({
      data: {
        sessionId, toolName: 'Bash', input: { command: 'npm test' }, status,
        turnId: reader.turnId ?? null, toolUseId: reader.toolUseId ?? null, backgroundJobId: reader.backgroundJobId ?? null,
        ...(decided ? { decidedAt: new Date(), decidedById: ownerId } : {}),
      },
    });
    return { sessionId, approvalId: row.id };
  };
  /** The tool call the ingest records from a tool_use, and the result that finishes it. */
  const call = async (sessionId: string, toolUseId: string, returned: boolean) => {
    await prisma.toolCall.create({
      data: { sessionId, name: 'Bash', toolUseId, input: {}, startedAt: new Date(), ...(returned ? { finishedAt: new Date() } : {}) },
    });
  };
  const approvalsOf = async (runnerId: string) => byApproval((await readRunnerLinkHints(prisma, runnerId)).approvals);

  // ── machine A ──────────────────────────────────────────────────────────────────────────────────────────
  // A dispatched turn, running: an earlier turn answered, the current one in flight.
  const running = await session(runnerA, RunStatus.RUNNING);
  const answeredTurn = await turn(running, 'ANSWERED');
  const liveTurn = await turn(running, 'IN_FLIGHT');
  const waited = await card(running, 'ALLOWED', { turnId: liveTurn, toolUseId: 'toolu_waited' }); // no tool_call yet
  const executing = await card(running, 'DENIED', { turnId: liveTurn, toolUseId: 'toolu_executing' });
  await call(running, 'toolu_executing', false);
  const returned = await card(running, 'ALLOWED', { turnId: liveTurn, toolUseId: 'toolu_returned' });
  await call(running, 'toolu_returned', true);
  const undecided = await card(running, 'PENDING', { turnId: liveTurn, toolUseId: 'toolu_undecided' });
  const collected = await card(running, 'ABANDONED', { turnId: liveTurn, toolUseId: 'toolu_collected' });
  const ofAnsweredTurn = await card(running, 'ALLOWED', { turnId: answeredTurn, toolUseId: 'toolu_earlier' });
  const createCard = await card(running, 'ALLOWED', { turnId: liveTurn }); // a create card: the turn asked, no call named
  const turnless = await card(running, 'ALLOWED', { toolUseId: 'toolu_turnless' }); // raised with no turn in flight
  const readerless = await card(running, 'ALLOWED'); // names no turn, no call, no job
  // Parked between turns, with a runner-hosted job up.
  const parked = await session(runnerA, RunStatus.AWAITING_INPUT, { runningBgShells: ['bgj_up'] });
  await turn(parked, 'PENDING');
  const jobCard = await card(parked, 'ALLOWED', { backgroundJobId: 'bgj_up' });
  const goneJobCard = await card(parked, 'ALLOWED', { backgroundJobId: 'bgj_gone' });
  const notGenerating = await card(parked, 'ALLOWED', { toolUseId: 'toolu_parked' });
  // A stretch the engine runs for itself (a scheduled wake-up): AWAITING_INPUT, engine turn active, no turn in flight.
  const selfDriven = await session(runnerA, RunStatus.AWAITING_INPUT, { engineTurnActive: true });
  const wakeCard = await card(selfDriven, 'ALLOWED', { toolUseId: 'toolu_wake' });
  // A session that ended, its job set left as it was.
  const ended = await session(runnerA, RunStatus.SUCCEEDED, { runningBgShells: ['bgj_stale'] });
  const endedCard = await card(ended, 'ALLOWED', { backgroundJobId: 'bgj_stale' });
  // Waiting to be claimed.
  const queued = await session(runnerA, RunStatus.PENDING);

  // ── machine B ──────────────────────────────────────────────────────────────────────────────────────────
  const onB = await session(runnerB, RunStatus.RUNNING);
  const turnOnB = await turn(onB, 'IN_FLIGHT');
  const cardOnB = await card(onB, 'ALLOWED', { turnId: turnOnB, toolUseId: 'toolu_on_b' });

  await t.test('1–2. each decided card whose reader is up is named, for its runner alone; nothing else is', async () => {
    assert.deepEqual(await approvalsOf(runnerA), byApproval([waited, executing, createCard, turnless, jobCard, wakeCard]));
    const named = new Set((await approvalsOf(runnerA)).map((a) => a.approvalId));
    for (const [why, left] of Object.entries({
      undecided, collected, returned, ofAnsweredTurn, readerless, notGenerating, goneJobCard, endedCard, cardOnB,
    })) {
      assert.equal(named.has(left.approvalId), false, `${why} is not named`);
    }
    assert.deepEqual(await approvalsOf(runnerB), [cardOnB], 'B is told of its own card and of nothing of A\'s');
    assert.deepEqual(await approvalsOf(idle), []);
    // The two members it answered before are what they were.
    const a = await readRunnerLinkHints(prisma, runnerA);
    assert.deepEqual(a.inboxSessionIds, [parked], 'the inbox names the session with a message waiting');
    assert.equal(a.claim, true, `${queued} waits to be claimed`);
    const nothing = await readRunnerLinkHints(prisma, idle);
    assert.deepEqual(nothing, { inboxSessionIds: [], claim: false, approvals: [] });
  });

  await t.test('3. a card leaves the list when its reader goes', async () => {
    // Its call returns: the tool_result the ingest pairs with the tool_use.
    await call(running, 'toolu_waited', true);
    assert.deepEqual(await approvalsOf(runnerA), byApproval([executing, createCard, turnless, jobCard, wakeCard]));
    // The turn is answered: its cards go, the one raised with no turn stays while its call is out.
    await prisma.conversationTurn.update({ where: { id: liveTurn }, data: { status: 'ANSWERED' } });
    assert.deepEqual(await approvalsOf(runnerA), byApproval([turnless, jobCard, wakeCard]));
    // The job ends.
    await prisma.session.update({ where: { id: parked }, data: { runningBgShells: [] } });
    assert.deepEqual(await approvalsOf(runnerA), byApproval([turnless, wakeCard]));
    // The sessions stop generating.
    await prisma.session.update({ where: { id: running }, data: { status: RunStatus.AWAITING_INPUT } });
    await prisma.session.update({ where: { id: selfDriven }, data: { engineTurnActive: false } });
    assert.deepEqual(await approvalsOf(runnerA), []);
  });

  await t.test('4. the heartbeat route answers a link call with them, and an HTTPS heartbeat without linkHints', async () => {
    const realtime = {
      drainCancellations: async () => [],
      failAbandonedWorktreeOperations: async () => undefined,
      drainMergeRequests: async () => [],
      drainCommitRequests: async () => [],
      drainArtifactRequests: async () => [],
      linkWatchersOf: () => null,
    } as never;
    const door = new RunnerApiController(prisma as never, {} as never, realtime, {} as never, {} as never, {} as never,
      { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
    const leaseOwner = randomUUID();
    const beat = { status: 'ONLINE', idleCapacity: 1, leaseOwner, supervisedSessionIds: [onB] } as never;
    const machineB = { id: runnerB, version: null, lastHeartbeatAt: new Date(), ownerId } as never;
    const overHttps = await door.heartbeat(machineB, beat);
    assert.equal('linkHints' in overHttps, false, 'an HTTPS heartbeat is answered as it always was');
    const overLink = await door.heartbeat(machineB, beat, undefined, undefined, undefined, undefined,
      { leaseOwner, requestId: null, afterSeq: null, gatewayId: 'orbit-link-gateway-1' });
    assert.deepEqual(overLink.linkHints?.approvals, [cardOnB]);
  });
});
