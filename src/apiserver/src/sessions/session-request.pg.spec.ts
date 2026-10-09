/**
 * One Orbit session asking another for a reply — every outcome, handed back once — against a real
 * PostgreSQL (docs/session-request-reply-contract.md §8, P1 criteria 5–10).
 *
 *   5. Each of the five outcomes, end to end: the request written beside its turn, the outcome written
 *      once, and the asker handed exactly one reply for it. A `session_reply` racing the NO_REPLY
 *      judgment of the same request: exactly one of them is the outcome.
 *   6. NO_REPLY is not judged while the recipient has any of the five wake sources — an ACTIVE watch,
 *      a running background job, a PENDING scheduled wakeup, an OPEN request of its own, an open
 *      `ask_owner` question — and is judged when it has none.
 *   7. Two outcomes arriving before the asker's runner takes the reply turn make one reply turn.
 *   8. An asker that has ended is not revived; the task it ran gets one comment, and handing the
 *      outcome back again writes no second one.
 *   9. A reply turn dropped by an interrupt is said on the asker's next delivered turn — and so is
 *      one the asker never read through: a reply turn that failed on a transient error is retried as
 *      one, and one its run ended with in flight is said on the next turn it is handed.
 *  10. (here, for the runner doors: the user doors are in session-reply-prefix-doors.spec.ts) the
 *      `session-reply:` prefix is refused as a caller's own key.
 *
 * And what the P1 review found (docs/session-request-reply-contract.md §4, §4.1):
 *
 *   - a request written into the recipient's running turn (a steer) is received when the engine takes
 *     it, not when the runner claims it: the turn ending first does not judge it, and the steer coming
 *     back to the queue as that turn ends — in either order, or at once — leaves it for the turn it
 *     then runs as. A steer the engine never took closes its request UNDELIVERED;
 *   - a run whose retry the auto-retry sweep gives up has ended, however the sweep gives up;
 *   - two sessions waiting on each other's reply wake neither, and an outcome on its way back to a
 *     session wakes it;
 *   - `session_reply` succeeds once REPLIED is written, whatever happens to the hand-off after it.
 *
 * And the auto-retry, from both ends of a request (§8 criteria 14, 17, 18, 20, 21 and 23–27):
 *
 *  14. a request whose turn the auto-retry re-sends goes with it — the request names the new turn,
 *      the block the engine reads asks for a reply, the echo's card names the request — and a session
 *      a transient failure stopped with its retry armed is not judged NO_REPLY meanwhile;
 *  17. an asker a transient failure stopped with its retry armed has not ended: its task is told
 *      nothing, the outcome waits for the retry's turn — including a reply turn its quota killed —
 *      and is said on its task once the retry is given up instead, whichever way it is; and a re-sent
 *      reply turn whose outcome another turn said first is not sent empty;
 *  18. a failure that produced NOTHING (no engine turn ran) keeps its request for the turn the retry
 *      re-sends — the request is not closed UNDELIVERED, and moves to the new turn with the words —
 *      while a request on a turn the retry does not re-send (queued behind it, or a run with no retry
 *      left to arm) is UNDELIVERED and its asker is told;
 *  20. a retry the sweep has CLAIMED but not yet written a turn for still counts as coming: an
 *      outcome handed to the asker in that window is held for the retry's turn and its task is told
 *      nothing, where reading the window as an ended asker would comment AND then say it again;
 *  21. a retry given up is said where the asker stands THEN — an ended one (FAILED with no retry,
 *      completed) gets §4.3's comment on the task it ran, and a merely idle one (parked and live, no
 *      task or with one) gets §4.2's reply turn;
 *  23. a failure with no echo — Claude's own delivery failure, whose only trace is the runner's receipt —
 *      is re-sent as itself, not as the message before it, and its request goes with it; a failure that
 *      left no trace at all closes its request UNDELIVERED at once instead of leaving it to its deadline;
 *  24. a claim whose re-send was never written (the process stopped between the two) is given up when
 *      its lease runs out, and what was held for it is said where the asker stands then — and a writer
 *      that comes back after its lease writes nothing;
 *  25. the owner turning the retry off while it is claimed is the retry given up: the re-send is not
 *      written, and the outcome held for it is said once;
 *  26. a request kept for a re-send that will not come is settled at once: when the owner takes over from
 *      the retry it is UNDELIVERED if no engine was handed it (no echo, or a receipt after the echo saying
 *      the frame failed or was put back unread), and judged as read when the owner's turn settles if one
 *      was; a FAILED run whose retry is turned off or given up closes it RECIPIENT_ENDED, said once;
 *  27. a run that ends with its runner holding a message it never echoed — reaped as offline, or finalized —
 *      has that message re-sent with its request, whatever the runner filed under it first; one the retry
 *      cannot find is UNDELIVERED as the run ends, and what a run's end keeps for the retry is exactly what
 *      the retry re-sends.
 *
 * And an outcome whose asker is armed again does not hold the request worker's place in line.
 *
 * The doors are the real controllers with the real orchestration credential; the inbox, the event
 * ingest and the turn completion are the real RunnerApiController methods, called as the runner does.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-request.pg.spec.ts
 *
 * Not destructive: every id is generated by the run.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import {
  type Prisma,
  type PrismaClient,
  type Runner,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
} from '@prisma/client';
import {
  RunEventType,
  RunStatus as SharedRunStatus,
  TURN_COMPLETE_STEER_REQUEUE,
  base62ToUuid,
  uuidToBase62,
} from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { ProjectsService } from '../projects/projects.service';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { AutoRetryService, BACKOFF_MS } from './auto-retry.service';
import {
  closeUnansweredRequests,
  MAX_OPEN_REQUESTS_PER_SESSION,
  replyToSessionRequest,
  REQUEST_CLOSED_CODE,
  RETRY_CLAIM_WINDOW_MS,
  SELF_REQUEST_CODE,
  SESSION_REPLY_TURN_PREFIX,
  TOO_MANY_OPEN_REQUESTS_CODE,
} from './session-request';
import { SessionRequestService, sessionReplyCommentId } from './session-request.service';
import { SessionRequestWorker } from './session-request.worker';
import { SessionsService } from './sessions.service';
import { AUTO_RETRY_TURN_KEY_PREFIX } from './watch-turn-key';

declare global {
  interface BigInt { toJSON(): string; }
}
// `main.ts` installs this before it creates the app; a session row carries BIGINT columns.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const HOUR = 60 * 60 * 1000;

/** A collaborator whose every method answers nothing: the broadcasts a turn's enqueue fires. */
const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });

/** The refusal an exception carries, as a caller reads it. */
function refusalOf(error: unknown): { status: number | undefined; body: Record<string, unknown> } {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  assert.ok(response && typeof response === 'object', `expected a structured refusal, got ${String(error)}`);
  return { status: (error as { getStatus?: () => number }).getStatus?.(), body: response as Record<string, unknown> };
}

test('a session asks another for a reply, and every request comes to exactly one outcome, handed back once', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = prisma as unknown as PrismaService;

  // ── the world: one account, one machine, a workspace for the workers and one for coordinators ──
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workerWorkspaceId = randomUUID();
  const landingWorkspaceId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `session-request-${ownerId}@runner-door.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: 'the machine every session runs on', tokenHash: sha256(`token-${runnerId}`),
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await prisma.workspace.create({ data: { id: workerWorkspaceId, ownerId, runnerId, name: 'orbit-worker', enabled: true } });
  await prisma.workspace.create({ data: { id: landingWorkspaceId, ownerId, runnerId, name: 'orbit-coordinator', enabled: true } });
  const runner = { id: runnerId, ownerId } as Runner;
  /** The runner says it is alive: a sweep releases no retry onto a machine it believes is down. */
  const heartbeat = () => prisma.runner.update({ where: { id: runnerId }, data: { lastHeartbeatAt: new Date() } });

  /** A session on this runner, parked between turns — the shape a live orchestrating caller has. */
  async function session(title: string, data: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId: workerWorkspaceId, assignedRunnerId: runnerId,
        title, prompt: title, provider: 'claude', status: RunStatus.AWAITING_INPUT,
        numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${id}`,
        dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
        ...data,
      },
    });
    return id;
  }

  async function task(title: string): Promise<string> {
    const created = await prisma.task.create({
      data: { ownerId, title, creatorType: 'USER', creatorId: ownerId, completionCriterion: 'OWNER_CONFIRMED' },
      select: { id: true },
    });
    return created.id;
  }

  // ── the doors ─────────────────────────────────────────────────────────────────────────────────
  const queue = { notifySessionQueued: () => undefined };
  const realtime = silent();
  const sessions = new SessionsService(db, queue as never, realtime as never);
  const requests = new SessionRequestService(db, sessions, realtime as never);
  // Never started: each case drives its passes by hand.
  const worker = new SessionRequestWorker(db, requests, { pollIntervalMs: HOUR });
  const orchestration = new RunnerOrchestrationAuthorizer(db, new JwtService({ secret: 'session-request-pg' }));
  const attempts = { chargeSteer: async () => undefined };
  const sendDoor = new RunnerSessionsController(sessions, orchestration, {} as never, attempts as never, undefined, requests);
  const projects = new ProjectsService(db, new ProjectAcceptanceService(db), sessions);
  const projectDoor = new RunnerProjectsController(
    projects, new ProjectAcceptanceService(db), {} as never, orchestration, undefined, attempts as never,
  );
  const api = new RunnerApiController(
    db,
    queue as never,
    realtime as never,
    {} as never,
    orchestration,
    // The messages here carry no `#`-references and reach no list console.
    { expand: async (_owner: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _id: string, content?: string) => content } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    sessions,
    undefined,
    undefined,
    undefined,
    undefined,
    requests,
  );

  /** `session_send` as the runner calls it: from a session with its own credential, or headless. */
  async function sessionSend(
    from: string | null,
    to: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return sendDoor.sendMessage(
      runner,
      undefined,
      from ?? undefined,
      from ? await orchestration.issue(runnerId, from) : undefined,
      to,
      { message, clientTurnId: randomUUID(), ...extra } as never,
    ) as Promise<Record<string, unknown>>;
  }

  /** `session_send` with `expectReply`: the receipt, and the request's uuid beside its public id. */
  async function ask(
    from: string,
    to: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ requestId: string; replyBy: string; id: string; turnId: string }> {
    const receipt = await sessionSend(from, to, message, { expectReply: true, ...extra });
    assert.equal(typeof receipt.requestId, 'string', `the send answered no request: ${JSON.stringify(receipt)}`);
    assert.equal(typeof receipt.replyBy, 'string', `the send answered no deadline: ${JSON.stringify(receipt)}`);
    return {
      requestId: String(receipt.requestId),
      replyBy: String(receipt.replyBy),
      turnId: String(receipt.turnId),
      id: base62ToUuid(String(receipt.requestId)),
    };
  }

  /**
   * `session_reply` as the runner calls it, from the calling session's own credential. The route's
   * PublicIdPipe decodes the public id the request was answered with; called directly, the door is
   * handed what that pipe hands it.
   */
  async function reply(from: string, requestId: string, body: { message?: string; option?: number }) {
    return sendDoor.replyToRequest(
      runner, undefined, from, await orchestration.issue(runnerId, from), base62ToUuid(requestId), body as never,
    );
  }

  /**
   * The claim's own write, as the runner's lease routes make it: PENDING -> RUNNING is dropped in
   * silence for a session that has a recorded engine unless the same transaction declares it reads
   * that engine (migration 0414, `common/session-scheduling.ts`). A fixture that claims a session
   * the way the runner does therefore says so, in the transaction that moves the row.
   */
  async function claimSession(sessionId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
      await tx.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING } });
    });
  }

  /**
   * What the runner's claim does to a queued session, then the polls that follow it until a message
   * comes out — a control turn (an interrupt) is handed out first and answered on the spot. The poll
   * declares no steer support, so a steer stays queued until its turn ends and is re-filed. `on` is
   * the machine polling: this file's own, unless the session runs on another.
   */
  async function deliver(sessionId: string, on = runnerId): Promise<{ turnId: string; content: string; clientTurnId: string }> {
    await claimSession(sessionId);
    for (;;) {
      const handed = await (api as unknown as {
        dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<Record<string, unknown> | null>;
      }).dequeueTurn.call(api, sessionId, on, null);
      assert.ok(handed, `the inbox of ${sessionId} handed nothing out`);
      const turn = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: String(handed.turnId) } });
      if (turn.kind !== 'message') continue;
      return { turnId: turn.id, content: String(handed.content ?? ''), clientTurnId: turn.clientTurnId };
    }
  }

  /**
   * The runner's claim of a steer: a poll from a runner that can write a message into the turn that is
   * running (a claude session always can). The claim stamps `delivered_at` — and no engine has read the
   * message yet: the runner still has to write it in and hear back.
   */
  async function deliverSteer(sessionId: string): Promise<{ turnId: string; content: string }> {
    const handed = await (api as unknown as {
      dequeueTurn: (
        sessionId: string, runnerId: string, leaseGeneration: string | null, acceptsSteer: boolean,
      ) => Promise<Record<string, unknown> | null>;
    }).dequeueTurn.call(api, sessionId, runnerId, null, true);
    assert.ok(handed, `the inbox of ${sessionId} handed no steer out`);
    const turn = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: String(handed.turnId) } });
    assert.equal(turn.kind, 'steer', `the inbox handed out a ${turn.kind}, not the steer`);
    assert.equal(turn.status, 'IN_FLIGHT');
    assert.ok(turn.deliveredAt, 'the claim stamped no delivered_at');
    return { turnId: turn.id, content: String(handed.content ?? '') };
  }

  /** The runner settles a steer: the engine echoed it, or it could not be delivered. */
  function settleSteer(sessionId: string, turnId: string, delivered: boolean) {
    return api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId,
      status: delivered ? SharedRunStatus.SUCCEEDED : SharedRunStatus.FAILED,
      subtype: 'steer',
      ...(delivered ? {} : { result: 'steer not delivered to the engine: the engine exited before this message was written to it' }),
    } as never);
  }

  /** The runner hands a steer back: the engine provably never read it, so it runs as the next message. */
  function requeueSteer(sessionId: string, turnId: string) {
    return api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId, status: SharedRunStatus.SUCCEEDED, subtype: TURN_COMPLETE_STEER_REQUEUE,
    } as never);
  }

  /** A recipient in the middle of a turn of its own: the owner's message, handed to its engine. */
  async function busy(recipient: string): Promise<string> {
    await sessions.createTurn(ownerId, recipient, { clientTurnId: randomUUID(), content: 'the owner\'s own task' });
    return (await deliver(recipient)).turnId;
  }

  const seqs = new Map<string, number>();
  /** The runner's events for one turn, through the real ingest. Answers what was stored. */
  async function say(sessionId: string, turnId: string, type: RunEventType, payload: Record<string, unknown>, on = runnerId) {
    const seq = (seqs.get(sessionId) ?? 100) + 1;
    seqs.set(sessionId, seq);
    await api.events({ id: on } as never, sessionId, {
      events: [{ seq, type, ts: new Date().toISOString(), turnId, payload }],
    } as never);
    return (await prisma.runEvent.findFirstOrThrow({ where: { sessionId, seq } })).payload as Record<string, unknown>;
  }

  /** The turn ends as the runner reports it: something said, then the completion. */
  async function finish(sessionId: string, turnId: string, words = 'done looking', on = runnerId) {
    await say(sessionId, turnId, RunEventType.ASSISTANT, { text: words }, on);
    await api.turnComplete({ id: on } as never, sessionId, {
      turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0,
    } as never);
  }

  const requestRow = (id: string) => prisma.sessionRequest.findUniqueOrThrow({ where: { id } });
  const replyTurnsOf = (sessionId: string) => prisma.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: SESSION_REPLY_TURN_PREFIX } },
    orderBy: { seq: 'asc' },
  });
  /** How many `<orbit-session-reply>` blocks for this request a text carries. */
  const blocksFor = (content: string, requestId: string) =>
    content.split(`<orbit-session-reply request-id="${uuidToBase62(requestId)}"`).length - 1;

  // ── 5. REPLIED, end to end ────────────────────────────────────────────────────────────────────

  await t.test('REPLIED: the recipient reads the request, answers it, and the asker is handed the answer once', async () => {
    const asker = await session('Worker: needs a decision');
    const recipient = await session('Coordinator: decides');
    const options = [{ label: 'merge now', description: 'the checks are green' }, { label: 'wait for review' }];
    const request = await ask(asker, recipient, 'criterion 3 is ready — merge now or wait for review?', {
      replyOptions: options, replyWithinSeconds: 3_600,
    });
    const row = await requestRow(request.id);
    assert.equal(row.state, 'OPEN');
    assert.equal(row.fromSessionId, asker);
    assert.equal(row.toSessionId, recipient);
    assert.deepEqual(row.options, options);
    assert.ok(Math.abs(row.replyBy.getTime() - (Date.now() + 3_600_000)) < 60_000, 'the deadline is not an hour away');
    assert.equal(new Date(String(request.replyBy)).getTime(), row.replyBy.getTime());

    // The recipient reads the request in its block: who, which request, by when, how to answer.
    const handed = await deliver(recipient);
    assert.equal(handed.turnId, row.turnId);
    assert.match(handed.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`));
    assert.match(handed.content, /reply-by="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"/);
    assert.match(handed.content, new RegExp(`session_reply\\(requestId="${uuidToBase62(request.id)}"\\)`));
    assert.match(handed.content, /NO_REPLY/);
    assert.match(handed.content, /\n0\. merge now：the checks are green\n1\. wait for review\n/);
    // The echo carries the request on its card, so a client can read the request's state.
    const echoed = await say(recipient, handed.turnId, RunEventType.USER, { text: handed.content });
    assert.equal((echoed.sessionMessage as Record<string, unknown>).requestId, uuidToBase62(request.id));

    // Refusals: only the recipient answers; an answer must say something the request can take.
    await assert.rejects(() => reply(asker, request.requestId, { message: 'I answer myself' }), (e: unknown) => {
      assert.equal(refusalOf(e).status, 403);
      return true;
    });
    await assert.rejects(() => reply(recipient, request.requestId, {}), (e: unknown) => {
      assert.equal(refusalOf(e).status, 400);
      return true;
    });
    await assert.rejects(() => reply(recipient, request.requestId, { option: 2 }), (e: unknown) => {
      assert.equal(refusalOf(e).status, 400);
      return true;
    });

    const answered = await reply(recipient, request.requestId, { option: 1, message: 'the reviewer is back at 3' });
    assert.equal(answered.state, 'REPLIED');
    assert.equal(answered.handOff, 'QUEUED');
    const closed = await requestRow(request.id);
    assert.equal(closed.state, 'REPLIED');
    assert.equal(closed.replyOption, 1);
    assert.equal(closed.replyText, 'the reviewer is back at 3');
    // Once answered, always answered: the second answer is refused with the first's outcome.
    await assert.rejects(() => reply(recipient, request.requestId, { option: 0 }), (e: unknown) => {
      const refusal = refusalOf(e);
      assert.equal(refusal.status, 409);
      assert.equal(refusal.body.code, REQUEST_CLOSED_CODE);
      assert.equal(refusal.body.outcome, 'REPLIED');
      return true;
    });
    // The recipient's turn settling now finds nothing OPEN to judge.
    await finish(recipient, handed.turnId);
    assert.equal((await requestRow(request.id)).state, 'REPLIED');

    // The asker: one reply turn, nobody's words in it, and the answer said at delivery.
    const replyTurns = await replyTurnsOf(asker);
    assert.equal(replyTurns.length, 1);
    assert.equal(replyTurns[0].content, '');
    assert.equal(replyTurns[0].sendIntent, 'NEXT_TURN');
    assert.equal(replyTurns[0].senderSessionId, null, 'a reply turn was signed and counted as a message');
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: asker } })).status, RunStatus.PENDING);
    const back = await deliver(asker);
    assert.equal(back.turnId, replyTurns[0].id);
    assert.equal(blocksFor(back.content, request.id), 1);
    assert.match(back.content, new RegExp(`from-session="${uuidToBase62(recipient)}"`));
    assert.match(back.content, /outcome="REPLIED"/);
    assert.match(back.content, /你问的是：criterion 3 is ready — merge now or wait for review\?/);
    assert.match(back.content, /选择：1\. wait for review/);
    assert.match(back.content, /回复：the reviewer is back at 3/);
    // ...and stored as reply cards, not as the owner's words.
    const card = await say(asker, back.turnId, RunEventType.USER, { text: back.content });
    const cards = card.sessionReplies as Array<Record<string, unknown>>;
    assert.equal(cards.length, 1);
    assert.equal(cards[0].requestId, uuidToBase62(request.id));
    assert.equal(cards[0].outcome, 'REPLIED');
    assert.equal(cards[0].fromSessionId, recipient);
    assert.equal(cards[0].replyOptionLabel, 'wait for review');
    assert.equal(card.controlPlaneNote, back.content, 'the whole delivery is the control plane\'s note');
    // Handing it back again is nothing.
    assert.equal(await requests.handOff(request.id), 'ALREADY');
    assert.equal((await replyTurnsOf(asker)).length, 1);
  });

  // ── 5 + 6. NO_REPLY ───────────────────────────────────────────────────────────────────────────

  await t.test('NO_REPLY: the recipient read it, went idle with nothing left to wake it, and never answered', async () => {
    const asker = await session('Worker: asks and moves on');
    const recipient = await session('Worker: forgets to answer');
    const request = await ask(asker, recipient, 'which port does the gateway listen on?');
    const handed = await deliver(recipient);
    await finish(recipient, handed.turnId, 'The gateway listens on 8443 — I checked compose.yml.');
    const closed = await requestRow(request.id);
    assert.equal(closed.state, 'NO_REPLY');
    assert.equal(closed.excerpt, 'The gateway listens on 8443 — I checked compose.yml.');
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).status, RunStatus.AWAITING_INPUT);
    // Handed back by the completion itself, after its commit.
    const back = await deliver(asker);
    assert.equal(blocksFor(back.content, request.id), 1);
    assert.match(back.content, /outcome="NO_REPLY"/);
    assert.match(back.content, /不是正式回复/);
    assert.match(back.content, /The gateway listens on 8443/);
  });

  await t.test('NO_REPLY waits while any of the five wake sources is pending, and is judged once none is', async () => {
    const askers = new Map<string, string>();
    /** A recipient with one wake source, asked a question it reads and does not answer. */
    async function judged(
      label: string,
      arm: (recipient: string) => Promise<void>,
      data: Partial<Prisma.SessionUncheckedCreateInput> = {},
    ) {
      const asker = await session(`Worker: asks the one with ${label}`);
      const recipient = await session(`Worker: has ${label}`, data);
      askers.set(label, asker);
      const request = await ask(asker, recipient, `are you still on it? (${label})`);
      await arm(recipient);
      const handed = await deliver(recipient);
      await finish(recipient, handed.turnId, `still going (${label})`);
      return (await requestRow(request.id)).state;
    }

    assert.equal(await judged('an ACTIVE watch', async (recipient) => {
      await prisma.watch.create({
        data: {
          ownerId, observerType: 'SESSION', observerSessionId: recipient,
          predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
          action: 'RESUME_SESSION', state: 'ACTIVE', expiresAt: new Date(Date.now() + 24 * HOUR),
        },
      });
    }), 'OPEN', 'an ACTIVE watch will wake it, and it may answer then');

    assert.equal(await judged('a running background job', async (recipient) => {
      await prisma.session.update({ where: { id: recipient }, data: { runningBgJobs: ['bgj_0123456789ab'] } });
    }), 'OPEN', 'a running job is work that comes back to it');

    assert.equal(await judged('a pending scheduled wakeup', async (recipient) => {
      await prisma.sessionScheduledWakeup.create({
        data: { sessionId: recipient, delaySeconds: 600, reason: 'check the build', dueAt: new Date(Date.now() + 600_000) },
      });
    }), 'OPEN', 'a wakeup it asked for will wake it');

    assert.equal(await judged('an open request of its own', async (recipient) => {
      const third = await session('Worker: asked by the recipient');
      await ask(recipient, third, 'I need your numbers before I can answer');
    }), 'OPEN', 'the answer to its own request will come back to it as a turn');

    assert.equal(await judged('an open ask_owner question', async (recipient) => {
      const projectId = randomUUID();
      await prisma.project.create({
        data: { id: projectId, ownerId, title: 'asks the owner', coordinatorEnabled: true, coordinatorWorkspaceId: landingWorkspaceId },
      });
      await establishProjectContractForPgTest(prisma, ownerId, projectId, 'asks the owner');
      await prisma.project.update({ where: { id: projectId }, data: { coordinatorSessionId: recipient } });
      await prisma.projectOpenItem.create({
        data: {
          projectId, ownerId, kind: 'COORDINATOR_QUESTION', state: 'OPEN', assignee: 'OWNER', assigneeReason: 'DEFAULT',
          askedBySessionId: recipient, dedupeKey: `CQ:${randomUUID()}`, title: 'Coordinator asks: ship it?',
          payload: { question: 'ship it?', options: [], blocksTaskIds: [], ifUnanswered: null },
          waitingSince: new Date(), assignedAt: new Date(),
        },
      } as never);
    }, { workspaceId: landingWorkspaceId, titleManagedByProject: true }), 'OPEN', 'the owner\'s answer to its question will wake it');

    assert.equal(await judged('nothing at all', async () => undefined), 'NO_REPLY');
    // None of the five waiting ones was handed anything back; the last one was.
    for (const [label, asker] of askers) {
      assert.equal((await replyTurnsOf(asker)).length, label === 'nothing at all' ? 1 : 0, label);
    }
  });

  await t.test('two sessions waiting on each other\'s reply wake neither: both come to NO_REPLY, not to the deadline', async () => {
    const a = await session('Worker A: asks B, and is asked by B');
    const b = await session('Worker B: asks A, and is asked by A');
    const aAsksB = await ask(a, b, 'A asks: which schema version?');
    const bAsksA = await ask(b, a, 'B asks: which port?');
    const bReads = await deliver(b);
    const aReads = await deliver(a);
    assert.equal(aReads.turnId, (await requestRow(bAsksA.id)).turnId);
    // A's turn ends without answering. Its own question to B would be a wake source, but B is
    // waiting on A as well, and neither is going to wake the other: B's question is NO_REPLY.
    await finish(a, aReads.turnId, 'A: waiting for B to tell me the schema');
    assert.equal((await requestRow(bAsksA.id)).state, 'NO_REPLY', 'held open by a wait that wakes nobody');
    assert.equal((await requestRow(aAsksB.id)).state, 'OPEN');
    // B's turn ends without answering either. That outcome is queued to B behind the turn, so B does
    // not park, and nothing is judged yet.
    await finish(b, bReads.turnId, 'B: waiting for A to tell me the port');
    assert.equal((await requestRow(aAsksB.id)).state, 'OPEN');
    // B reads that A did not answer, still does not answer A, and settles: judged now.
    const told = await deliver(b);
    assert.equal(blocksFor(told.content, bAsksA.id), 1);
    await finish(b, told.turnId, 'B: A never answered me');
    const closed = await requestRow(aAsksB.id);
    assert.equal(closed.state, 'NO_REPLY');
    assert.equal(closed.excerpt, 'B: A never answered me');
    // ...and A is told.
    const toldA = await deliver(a);
    assert.equal(blocksFor(toldA.content, aAsksB.id), 1);
    assert.match(toldA.content, /outcome="NO_REPLY"/);
  });

  await t.test('an outcome on its way back to a session wakes it: what it was asked waits for that turn', async () => {
    const asker = await session('Worker: asked a question of its own, and is asked one');
    const helper = await session('Worker: answers the asker');
    const third = await session('Worker: asks the asker');
    const own = await ask(asker, helper, 'is the build green?');
    const incoming = await ask(third, asker, 'and which port?');
    await deliver(helper);
    const reading = await deliver(asker);
    assert.equal(reading.turnId, (await requestRow(incoming.id)).turnId);
    // The helper's answer is written — the one compare-and-set session_reply makes — and the hand-off
    // that queues it to the asker has not run yet.
    await prisma.$transaction((tx) => replyToSessionRequest(tx, {
      ownerId, callerSessionId: helper, requestId: own.id, reply: { message: 'green' },
    }));
    // The asker's turn ends without answering third. The answer on its way back is going to wake it,
    // so it may yet answer: not NO_REPLY.
    await finish(asker, reading.turnId, 'checking the build first');
    assert.equal((await requestRow(incoming.id)).state, 'OPEN', 'judged with an answer on its way to wake it');
    // The hand-off lands; the asker reads it, still does not answer third, and settles: judged now.
    assert.equal(await requests.handOff(own.id), 'QUEUED');
    const back = await deliver(asker);
    assert.equal(blocksFor(back.content, own.id), 1);
    await finish(asker, back.turnId, 'the build is green');
    assert.equal((await requestRow(incoming.id)).state, 'NO_REPLY');
  });

  await t.test('a request the recipient has not read yet is not judged when another turn of it settles', async () => {
    const asker = await session('Worker: asks a busy one');
    const recipient = await session('Worker: busy with something else');
    // The recipient is working on a turn of its own when the request arrives, so it queues behind it.
    await sessions.createTurn(ownerId, recipient, { clientTurnId: randomUUID(), content: 'the owner\'s own task' });
    const running = await deliver(recipient);
    const request = await ask(asker, recipient, 'when you are done, which branch?');
    assert.equal((await requestRow(request.id)).state, 'OPEN');
    await finish(recipient, running.turnId);
    assert.equal((await requestRow(request.id)).state, 'OPEN', 'judged before it was ever read');
    const handed = await deliver(recipient);
    assert.equal(handed.turnId, (await requestRow(request.id)).turnId);
    await finish(recipient, handed.turnId, 'main');
    assert.equal((await requestRow(request.id)).state, 'NO_REPLY');

    // And the rule itself, where nothing else holds the judgment off. The completion above never
    // reached the judgment, because the request still queued kept the session busy; asked directly,
    // the one function that judges (contract §4.1) passes over a request no engine has been handed,
    // even with nothing left that would wake its recipient.
    const idle = await session('Worker: idle, a request still queued');
    const queued = await ask(asker, idle, 'which branch, once you get to it?');
    const judged = await prisma.$transaction((tx) =>
      closeUnansweredRequests(tx, { id: idle, runningBgJobs: [], retryAt: null, lastAssistantText: 'not started' }));
    assert.deepEqual(judged, [], 'a request was judged before any engine read it');
    assert.equal((await requestRow(queued.id)).state, 'OPEN');
    const read = await deliver(idle);
    await finish(idle, read.turnId, 'main, again');
    assert.equal((await requestRow(queued.id)).state, 'NO_REPLY');
  });

  // ── 5 + 6. a request written into the recipient's running turn: a steer ──────────────────────

  await t.test('a steer is received when its engine takes it, not when its runner claims it', async () => {
    // The ordinary order: the engine echoes the steer while its turn runs, and then the turn ends.
    const asker = await session('Worker: asks a busy one mid-turn');
    const steered = await session('Worker: busy, and steered');
    const running = await busy(steered);
    const request = await ask(asker, steered, 'quick one while you are at it: which branch?');
    const steer = await deliverSteer(steered);
    assert.equal(steer.turnId, (await requestRow(request.id)).turnId);
    assert.match(steer.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`), 'a steer carries its request block too');
    await settleSteer(steered, steer.turnId, true);
    await finish(steered, running, 'main — and no session_reply');
    assert.equal((await requestRow(request.id)).state, 'NO_REPLY');

    // The turn ends before the engine takes the steer. The claim stamped `delivered_at`, but no engine
    // has read the request, so the turn ending does not judge it...
    const late = await session('Worker: its turn ends under a steer');
    const lateRunning = await busy(late);
    const lateRequest = await ask(asker, late, 'and which port?');
    const lateSteer = await deliverSteer(late);
    await finish(late, lateRunning, 'all done before the steer landed');
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: late } })).status, RunStatus.AWAITING_INPUT);
    assert.equal((await requestRow(lateRequest.id)).state, 'OPEN', 'judged on the runner\'s claim, before any engine read it');
    // ...and the engine taking it after its turn's result is not a settle either: it is judged when a
    // later turn settles (or by its deadline).
    await settleSteer(late, lateSteer.turnId, true);
    assert.equal((await requestRow(lateRequest.id)).state, 'OPEN');
    await sessions.createTurn(ownerId, late, { clientTurnId: randomUUID(), content: 'anything else?' });
    const next = await deliver(late);
    await finish(late, next.turnId, 'port 8443, and nothing else');
    const judged = await requestRow(lateRequest.id);
    assert.equal(judged.state, 'NO_REPLY');
    assert.equal(judged.excerpt, 'port 8443, and nothing else');
  });

  await t.test('a steer handed back to the queue and the end of the turn it missed, in either order or at once: the request waits for the message it becomes', async () => {
    async function round(label: string, order: 'the turn ends first' | 'the steer comes back first' | 'at once') {
      const asker = await session(`Worker: asks (${label})`);
      const recipient = await session(`Worker: steered as its turn ends (${label})`);
      const running = await busy(recipient);
      const request = await ask(asker, recipient, `which port? (${label})`);
      const steer = await deliverSteer(recipient);
      await say(recipient, running, RunEventType.ASSISTANT, { text: `wrapping up (${label})` });
      const complete = () => api.turnComplete({ id: runnerId } as never, recipient, {
        turnId: running, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0,
      } as never);
      if (order === 'the turn ends first') {
        await complete();
        assert.equal((await requestRow(request.id)).state, 'OPEN', `${label}: judged while its steer was still out`);
        await requeueSteer(recipient, steer.turnId);
      } else if (order === 'the steer comes back first') {
        await requeueSteer(recipient, steer.turnId);
        await complete();
      } else {
        const [completed, requeued] = await Promise.allSettled([complete(), requeueSteer(recipient, steer.turnId)]);
        assert.equal(completed.status, 'fulfilled', `${label}: ${String((completed as PromiseRejectedResult).reason)}`);
        assert.equal(requeued.status, 'fulfilled', `${label}: ${String((requeued as PromiseRejectedResult).reason)}`);
      }
      // Whichever came first, the request is OPEN on a message queued to run next...
      assert.equal((await requestRow(request.id)).state, 'OPEN', `${label}: judged before it was read`);
      const queued = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: steer.turnId } });
      assert.equal(queued.kind, 'message');
      assert.equal(queued.status, 'PENDING');
      assert.equal(queued.deliveredAt, null);
      assert.notEqual(
        (await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).status,
        RunStatus.AWAITING_INPUT,
        `${label}: a message is queued behind nothing`,
      );
      // ...which the recipient reads as the request it is, and the turn it runs as is what is judged.
      const handed = await deliver(recipient);
      assert.equal(handed.turnId, steer.turnId);
      assert.match(handed.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`));
      await finish(recipient, handed.turnId, `port 8443 (${label}), and no session_reply`);
      const closed = await requestRow(request.id);
      assert.equal(closed.state, 'NO_REPLY', label);
      assert.equal(closed.excerpt, `port 8443 (${label}), and no session_reply`);
      await worker.drain();
      assert.equal((await replyTurnsOf(asker)).length, 1, `${label}: handed back other than once`);
    }
    await round('the turn ends first', 'the turn ends first');
    await round('the steer comes back first', 'the steer comes back first');
    for (let i = 0; i < 6; i++) await round(`at once ${i}`, 'at once');
  });

  await t.test('a steer the engine never takes closes its request UNDELIVERED, and the asker is told', async () => {
    // The runner reports the steer undelivered: it closes as it settles, and the asker is handed that.
    const asker = await session('Worker: steers a request into a turn that loses it');
    const recipient = await session('Worker: its engine exits under a steer');
    const running = await busy(recipient);
    const request = await ask(asker, recipient, 'still on the migration?');
    const steer = await deliverSteer(recipient);
    await settleSteer(recipient, steer.turnId, false);
    const closed = await requestRow(request.id);
    assert.equal(closed.state, 'UNDELIVERED');
    assert.equal(closed.closeReason, 'STEER_UNCONFIRMED');
    // The turn it was aimed at ending afterwards changes nothing.
    await finish(recipient, running, 'still on it');
    assert.equal((await requestRow(request.id)).state, 'UNDELIVERED');
    assert.equal((await replyTurnsOf(asker)).length, 1, 'the steer\'s own completion handed nothing back');
    const back = await deliver(asker);
    assert.equal(blocksFor(back.content, request.id), 1);
    assert.match(back.content, /outcome="UNDELIVERED"/);
    assert.match(back.content, /对方的引擎没有确认收到它/);

    // The turn it was joining fails with a retry armed while the steer is still out: the run goes on,
    // and the drain that answers the steer without its engine takes the request with it.
    const failing = await session('Worker: its turn fails under a steer, retry armed');
    const failingRunning = await busy(failing);
    const drained = await ask(asker, failing, 'and this one?');
    await deliverSteer(failing);
    await api.turnComplete({ id: runnerId } as never, failing, {
      turnId: failingRunning, status: SharedRunStatus.FAILED, subtype: 'error_during_execution',
      numTurns: 0, costUsd: 0, error: 'the engine never came up',
    } as never);
    const failed = await prisma.session.findUniqueOrThrow({ where: { id: failing } });
    assert.equal(failed.status, RunStatus.FAILED);
    assert.ok(failed.retryAt, 'no retry was armed — that would be RECIPIENT_ENDED\'s case');
    const drainedRow = await requestRow(drained.id);
    assert.equal(drainedRow.state, 'UNDELIVERED');
    assert.equal(drainedRow.closeReason, 'STEER_UNCONFIRMED');
    assert.ok((await worker.drain()).handedOff.includes(drained.id));
    // Disarmed by hand, so this retry is not the one a later case's sweep finds due.
    await prisma.session.update({ where: { id: failing }, data: { retryAt: null } });
  });

  // ── 5. the race ───────────────────────────────────────────────────────────────────────────────

  await t.test('session_reply racing the NO_REPLY judgment: exactly one is the outcome, handed back once', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 6; round++) {
      const asker = await session(`Worker: races ${round}`);
      const recipient = await session(`Worker: answers as it stops ${round}`);
      const request = await ask(asker, recipient, `race ${round}`);
      const handed = await deliver(recipient);
      await say(recipient, handed.turnId, RunEventType.ASSISTANT, { text: `my last words ${round}` });
      const [answered, completed] = await Promise.allSettled([
        reply(recipient, request.requestId, { message: `the answer ${round}` }),
        api.turnComplete({ id: runnerId } as never, recipient, {
          turnId: handed.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0,
        } as never),
      ]);
      assert.equal(completed.status, 'fulfilled', `the completion failed: ${String((completed as PromiseRejectedResult).reason)}`);
      const row = await requestRow(request.id);
      if (answered.status === 'fulfilled') {
        assert.equal(row.state, 'REPLIED');
        assert.equal(row.replyText, `the answer ${round}`);
      } else {
        const refusal = refusalOf(answered.reason);
        assert.equal(refusal.body.code, REQUEST_CLOSED_CODE, `the answer failed some other way: ${String(answered.reason)}`);
        assert.equal(row.state, 'NO_REPLY');
        assert.equal(row.replyText, null);
      }
      outcomes.push(row.state);
      // Whichever won, one hand-off. Run the worker too: it must find nothing left to hand.
      await worker.drain();
      const turns = await replyTurnsOf(asker);
      assert.equal(turns.length, 1, `round ${round} handed back ${turns.length} turns`);
      const back = await deliver(asker);
      assert.equal(blocksFor(back.content, request.id), 1);
    }
    assert.ok(outcomes.every((state) => state === 'REPLIED' || state === 'NO_REPLY'));
  });

  await t.test('session_reply succeeds once REPLIED is written, whatever its hand-off then meets: the worker hands it back', async () => {
    const asker = await session('Worker: asks; handing its answer back fails');
    const recipient = await session('Worker: answers');
    const request = await ask(asker, recipient, 'ready to merge?');
    await deliver(recipient);
    // A hand-off that cannot reach the asker's conversation: a fault, not a state of the world.
    const unreachable = Object.assign(Object.create(sessions) as SessionsService, {
      createTurn: async () => {
        throw new Error('Connection terminated unexpectedly');
      },
    });
    const door = new RunnerSessionsController(
      sessions, orchestration, {} as never, attempts as never, undefined,
      new SessionRequestService(db, unreachable, realtime as never),
    );
    const answered = await door.replyToRequest(
      runner, undefined, recipient, await orchestration.issue(runnerId, recipient), request.id, { message: 'yes' } as never,
    );
    assert.equal(answered.state, 'REPLIED');
    assert.equal(answered.handOff, 'DEFERRED');
    const row = await requestRow(request.id);
    assert.equal(row.state, 'REPLIED');
    assert.equal(row.replyText, 'yes');
    assert.equal(row.replyClientTurnId, null);
    assert.equal(row.replyHeldAt, null);
    assert.equal((await replyTurnsOf(asker)).length, 0);
    // The worker's next pass hands it back, once.
    assert.ok((await worker.drain()).handedOff.includes(request.id));
    assert.equal((await replyTurnsOf(asker)).length, 1);
    const back = await deliver(asker);
    assert.equal(blocksFor(back.content, request.id), 1);
    assert.match(back.content, /回复：yes/);
  });

  // ── 5. RECIPIENT_ENDED ────────────────────────────────────────────────────────────────────────

  await t.test('RECIPIENT_ENDED: the recipient completed, failed, or went to Trash — whichever writer ended it', async () => {
    // Completed: the owner files it.
    const asker = await session('Worker: asks three that end');
    const completed = await session('Worker: completed by the owner');
    const viaComplete = await ask(asker, completed, 'please confirm the schema');
    const handed = await deliver(completed);
    await say(completed, handed.turnId, RunEventType.ASSISTANT, { text: 'half way through the schema' });
    await prisma.session.update({ where: { id: completed }, data: { runningBgJobs: ['bgj_keepsitopen1'] } });
    await finish(completed, handed.turnId, 'half way through the schema');
    assert.equal((await requestRow(viaComplete.id)).state, 'OPEN', 'the job should have kept it open');
    await sessions.complete(ownerId, completed);
    const ended = await requestRow(viaComplete.id);
    assert.equal(ended.state, 'RECIPIENT_ENDED');
    assert.match(String(ended.closeReason), /^COMPLETED/);
    assert.equal(ended.excerpt, 'half way through the schema');

    // Failed with no retry: the runner's turn fails and the run ends with it.
    const failing = await session('Worker: fails');
    const viaFailure = await ask(asker, failing, 'can you reproduce the crash?');
    const failingTurn = await deliver(failing);
    await say(failing, failingTurn.turnId, RunEventType.ASSISTANT, { text: 'reproducing…' });
    await api.turnComplete({ id: runnerId } as never, failing, {
      turnId: failingTurn.turnId, status: SharedRunStatus.FAILED, subtype: 'error_during_execution', numTurns: 1, costUsd: 0,
      error: 'the engine crashed',
    } as never);
    assert.equal((await requestRow(viaFailure.id)).state, 'RECIPIENT_ENDED');
    assert.match(String((await requestRow(viaFailure.id)).closeReason), /^FAILED/);

    // Trash, while the request is still queued and unread: the end wins over the undelivered queue.
    const trashed = await session('Worker: moved to Trash');
    const viaTrash = await ask(asker, trashed, 'is this still needed?');
    await sessions.remove(ownerId, trashed);
    const trashedRow = await requestRow(viaTrash.id);
    assert.equal(trashedRow.state, 'RECIPIENT_ENDED');
    assert.match(String(trashedRow.closeReason), /^TRASHED/);

    // Nothing in application code hands these back: the worker does, once each, in one turn.
    const drained = await worker.drain();
    for (const id of [viaComplete.id, viaFailure.id, viaTrash.id]) {
      assert.ok(drained.handedOff.includes(id), `the worker did not hand back ${id}`);
    }
    assert.deepEqual((await worker.drain()).handedOff, []);
    const turns = await replyTurnsOf(asker);
    assert.equal(turns.length, 1, 'three outcomes queued together were not one reply turn');
    const back = await deliver(asker);
    for (const id of [viaComplete.id, viaFailure.id, viaTrash.id]) assert.equal(blocksFor(back.content, id), 1);
    assert.match(back.content, /对方的会话已经结束（COMPLETED/);
  });

  await t.test('a run with a retry armed has not ended, and the sweep giving the retry up ends it — whichever way it gives up', async () => {
    const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    /**
     * A recipient that read a request and then failed on an overloaded provider: the reply arms a
     * retry, the turn fails, and the run is FAILED with the same session going on — not an end, so
     * the request is OPEN. The arm is then made the oldest due, so the sweep that follows takes it
     * first (one release per runner and provider a sweep).
     */
    async function failedWithRetry(label: string, data: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
      const asker = await session(`Worker: asks one that fails (${label})`);
      const recipient = await session(`Worker: fails with a retry armed (${label})`, data);
      const request = await ask(asker, recipient, `are you still there? (${label})`);
      const handed = await deliver(recipient);
      await say(recipient, handed.turnId, RunEventType.USER, { text: handed.content });
      await say(recipient, handed.turnId, RunEventType.ASSISTANT, { text: OVERLOADED });
      await api.turnComplete({ id: runnerId } as never, recipient, {
        turnId: handed.turnId, status: SharedRunStatus.FAILED, subtype: 'error_during_execution',
        numTurns: 1, costUsd: 0, error: OVERLOADED,
      } as never);
      const failed = await prisma.session.findUniqueOrThrow({ where: { id: recipient } });
      assert.equal(failed.status, RunStatus.FAILED);
      assert.ok(failed.retryAt, `${label}: the overload armed no retry`);
      assert.equal((await requestRow(request.id)).state, 'OPEN', `${label}: a failure with a retry armed ended the run`);
      await prisma.session.update({ where: { id: recipient }, data: { retryAt: new Date(Date.now() - HOUR) } });
      return { recipient, request };
    }

    // The sweep claims the retry — the arm cleared and an attempt spent in one statement — and the
    // revive goes through: the same session goes on, so nothing has ended.
    {
      const { recipient, request } = await failedWithRetry('the retry goes through');
      await heartbeat();
      await new AutoRetryService(db, sessions, realtime as never).sweep();
      const revived = await prisma.session.findUniqueOrThrow({ where: { id: recipient } });
      assert.equal(revived.retryAt, null, 'the sweep did not take this retry');
      assert.notEqual(revived.status, RunStatus.FAILED, 'the retry was not sent');
      assert.equal((await requestRow(request.id)).state, 'OPEN', 'the claim or the revive ended the run');
    }

    // Given up by handing the attempt back: the sweep claims the retry, the task the run was for is
    // abandoned before the revive, the revive is refused for it, and the sweep gives the retry up by
    // putting the attempt it spent back — `retry_attempts` alone, the arm already cleared by the claim.
    {
      const taskId = await task('the task a failing run was for');
      const { recipient, request } = await failedWithRetry('its task is abandoned under the retry', {
        taskId, startsTaskWork: true,
      });
      const before = await prisma.session.findUniqueOrThrow({ where: { id: recipient } });
      let revives = 0;
      const abandoning = Object.assign(Object.create(sessions) as SessionsService, {
        resume: async (...args: Parameters<SessionsService['resume']>) => {
          revives += 1;
          await sql.query(
            `UPDATE "task" SET "status" = 'FAILED', "terminal_reason" = 'ABANDONED' WHERE "id" = $1::uuid`,
            [taskId],
          );
          return sessions.resume(...args);
        },
      });
      await heartbeat();
      await new AutoRetryService(db, abandoning, realtime as never).sweep();
      assert.equal(revives, 1, 'the sweep never claimed this retry, so it never reached the revive');
      const after = await prisma.session.findUniqueOrThrow({ where: { id: recipient } });
      assert.equal(after.status, RunStatus.FAILED);
      assert.equal(after.retryAt, null);
      assert.equal(after.retryAttempts, before.retryAttempts, 'the attempt the claim spent was not handed back');
      const ended = await requestRow(request.id);
      assert.equal(ended.state, 'RECIPIENT_ENDED', 'the retry was given up, and its run left open');
      assert.match(String(ended.closeReason), /^FAILED/);
    }

    // Given up because every attempt is spent: the sweep disarms it.
    {
      const { recipient, request } = await failedWithRetry('its attempts are spent');
      await prisma.session.update({ where: { id: recipient }, data: { retryAttempts: BACKOFF_MS.length } });
      assert.equal((await requestRow(request.id)).state, 'OPEN');
      await heartbeat();
      await new AutoRetryService(db, sessions, realtime as never).sweep();
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).retryAt, null);
      assert.equal((await requestRow(request.id)).state, 'RECIPIENT_ENDED');
    }
  });

  // ── 5. EXPIRED ────────────────────────────────────────────────────────────────────────────────

  await t.test('EXPIRED: the deadline passed with the request open, and the asker is told how the recipient stood', async () => {
    const asker = await session('Worker: asks with a deadline');
    const recipient = await session('Worker: slow');
    const request = await ask(asker, recipient, 'need this within the minute', { replyWithinSeconds: 60 });
    const handed = await deliver(recipient);
    await say(recipient, handed.turnId, RunEventType.ASSISTANT, { text: 'still compiling…' });
    // Not due yet: the worker leaves it.
    assert.deepEqual((await worker.drain()).expired, []);
    const due = new Date((await requestRow(request.id)).replyBy.getTime() + 1_000);
    const pass = await worker.drain(due);
    assert.deepEqual(pass.expired, [request.id]);
    const expired = await requestRow(request.id);
    assert.equal(expired.state, 'EXPIRED');
    assert.equal(expired.closeReason, 'RUNNING');
    assert.equal(expired.excerpt, 'still compiling…');
    // The answer that comes after it is refused with the outcome it already has.
    await assert.rejects(() => reply(recipient, request.requestId, { message: 'done!' }), (e: unknown) => {
      assert.equal(refusalOf(e).body.outcome, 'EXPIRED');
      return true;
    });
    const back = await deliver(asker);
    assert.equal(blocksFor(back.content, request.id), 1);
    assert.match(back.content, /outcome="EXPIRED"/);
    assert.match(back.content, /对方当时的状态：RUNNING/);
  });

  await t.test('a request that expired in the queue tells its reader there is nothing to answer', async () => {
    const asker = await session('Worker: asks a queue');
    const recipient = await session('Worker: has a long queue');
    await sessions.createTurn(ownerId, recipient, { clientTurnId: randomUUID(), content: 'a long job first' });
    const running = await deliver(recipient);
    const request = await ask(asker, recipient, 'quick one', { replyWithinSeconds: 60 });
    await worker.drain(new Date(Date.now() + 120_000));
    assert.equal((await requestRow(request.id)).state, 'EXPIRED');
    await finish(recipient, running.turnId);
    const handed = await deliver(recipient);
    assert.match(handed.content, /已经以 EXPIRED 结案，不必再调用 session_reply/);
    assert.doesNotMatch(handed.content, /对方在等你回复/);
  });

  // ── 5. UNDELIVERED ────────────────────────────────────────────────────────────────────────────

  await t.test('UNDELIVERED: the owner withdrew the message, or an interrupt dropped it, before it was read', async () => {
    const asker = await session('Worker: asks one that gets stopped');
    const recipient = await session('Worker: about to be interrupted');
    // Idle, so the request waits as the next message — which the owner takes back.
    const withdrawn = await ask(asker, recipient, 'and this too');
    await sessions.cancelQueuedTurn(ownerId, recipient, (await requestRow(withdrawn.id)).turnId);
    const withdrawnRow = await requestRow(withdrawn.id);
    assert.equal(withdrawnRow.state, 'UNDELIVERED');
    assert.equal(withdrawnRow.closeReason, 'WITHDRAWN');
    // Busy, so the next request is written into the running turn (a steer) — and the owner stops the
    // session before it gets there, which drops it with the rest of the queue.
    await sessions.createTurn(ownerId, recipient, { clientTurnId: randomUUID(), content: 'something long' });
    await deliver(recipient);
    const interrupted = await ask(asker, recipient, 'and after that, this');
    assert.equal(
      (await prisma.conversationTurn.findUniqueOrThrow({ where: { id: (await requestRow(interrupted.id)).turnId } })).kind,
      'steer',
    );
    await sessions.interrupt(ownerId, recipient);
    const interruptedRow = await requestRow(interrupted.id);
    assert.equal(interruptedRow.state, 'UNDELIVERED');
    assert.equal(interruptedRow.closeReason, 'INTERRUPTED');
    assert.equal(await prisma.conversationTurn.count({ where: { id: interruptedRow.turnId } }), 0, 'the turn was not dropped');

    const drained = await worker.drain();
    for (const id of [interrupted.id, withdrawn.id]) {
      assert.ok(drained.handedOff.includes(id), `the worker did not hand back ${id}`);
    }
    const back = await deliver(asker);
    assert.equal(blocksFor(back.content, interrupted.id), 1);
    assert.equal(blocksFor(back.content, withdrawn.id), 1);
    assert.match(back.content, /被账号 owner 撤回了/);
    assert.match(back.content, /随队列一起被清掉了/);
  });

  // ── 7. two outcomes, one reply turn ───────────────────────────────────────────────────────────

  await t.test('outcomes that arrive before the asker is handed its reply turn are one turn', async () => {
    const asker = await session('Coordinator: asks two workers');
    const first = await session('Worker: answers first');
    const second = await session('Worker: answers second');
    const one = await ask(asker, first, 'status of shard 1?');
    const two = await ask(asker, second, 'status of shard 2?');
    await deliver(first);
    await deliver(second);
    assert.equal((await reply(first, one.requestId as string, { message: 'shard 1 done' })).handOff, 'QUEUED');
    assert.equal((await reply(second, two.requestId as string, { message: 'shard 2 done' })).handOff, 'MERGED');
    const turns = await replyTurnsOf(asker);
    assert.equal(turns.length, 1);
    const back = await deliver(asker);
    assert.equal(back.turnId, turns[0].id);
    assert.equal(blocksFor(back.content, one.id), 1);
    assert.equal(blocksFor(back.content, two.id), 1);
    assert.ok(back.content.indexOf('shard 1 done') < back.content.indexOf('shard 2 done'), 'out of the order they came');
    const stored = await say(asker, back.turnId, RunEventType.USER, { text: back.content });
    assert.equal((stored.sessionReplies as unknown[]).length, 2);

    // A third answer once that turn is out is a turn of its own.
    const third = await session('Worker: answers late');
    const three = await ask(asker, third, 'status of shard 3?');
    await deliver(third);
    assert.equal((await reply(third, three.requestId as string, { message: 'shard 3 done' })).handOff, 'QUEUED');
    assert.equal((await replyTurnsOf(asker)).length, 2);
  });

  // ── 8. the asker has ended ────────────────────────────────────────────────────────────────────

  await t.test('an asker that has ended is not revived; its task is told once', async () => {
    const taskId = await task('the task the asker ran');
    const asker = await session('Worker: ends before the answer comes', { taskId });
    const recipient = await session('Coordinator: answers late');
    const request = await ask(asker, recipient, 'which migration number is free?');
    await sessions.complete(ownerId, asker);
    const before = await prisma.session.findUniqueOrThrow({ where: { id: asker } });
    await deliver(recipient);
    const answered = await reply(recipient, request.requestId, { message: '0348' });
    assert.equal(answered.handOff, 'HELD');
    const after = await prisma.session.findUniqueOrThrow({ where: { id: asker } });
    assert.equal(after.status, before.status, 'the asker was revived');
    assert.ok(after.completedAt, 'the asker was taken out of Completed');
    assert.equal((await replyTurnsOf(asker)).length, 0);
    const held = await requestRow(request.id);
    assert.ok(held.replyHeldAt);
    assert.equal(held.replyClientTurnId, null);
    const comments = await prisma.taskComment.findMany({ where: { taskId } });
    assert.equal(comments.length, 1);
    assert.equal(comments[0].id, sessionReplyCommentId(request.id));
    assert.match(comments[0].body, /0348/);
    // Processed again — by hand, by the worker, and once the hold is lifted — no second comment.
    assert.equal(await requests.handOff(request.id), 'ALREADY');
    await worker.drain();
    await prisma.sessionRequest.update({ where: { id: request.id }, data: { replyHeldAt: null } });
    assert.equal(await requests.handOff(request.id), 'HELD');
    assert.equal(await prisma.taskComment.count({ where: { taskId } }), 1);

    // An asker with no task has nowhere to be told: held, and nothing written.
    const loose = await session('Worker: no task, ends');
    const looseRequest = await ask(loose, recipient, 'anything?');
    await sessions.remove(ownerId, loose);
    assert.equal((await reply(recipient, looseRequest.requestId as string, { message: 'no' })).handOff, 'HELD');
    assert.equal((await replyTurnsOf(loose)).length, 0);
  });

  // ── 9. the asker was interrupted ──────────────────────────────────────────────────────────────

  await t.test('a reply turn an interrupt dropped is said on the asker\'s next delivered turn', async () => {
    const asker = await session('Worker: interrupted while an answer is queued');
    const recipient = await session('Coordinator: answers');
    const request = await ask(asker, recipient, 'go or no-go?');
    // The asker is busy with a turn of its own when the answer comes, so the reply turn queues.
    await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: 'keep working' });
    await deliver(asker);
    await deliver(recipient);
    assert.equal((await reply(recipient, request.requestId, { option: undefined, message: 'go' })).handOff, 'QUEUED');
    assert.equal((await replyTurnsOf(asker)).length, 1);
    // While it waits, both queue views list it with the reply cards its echo will carry, so a client
    // draws the cards rather than the blocks in the owner's bubble.
    for (const [view, listed] of [
      ['queue', await sessions.listQueuedTurns(ownerId, asker)],
      ['active', await sessions.listQueuedTurns(ownerId, asker, 'active')],
    ] as const) {
      const cards = (listed as Array<{ sessionReplies?: Array<Record<string, unknown>> }>)
        .flatMap((turn) => turn.sessionReplies ?? []);
      assert.equal(cards.length, 1, `the ${view} view did not carry the reply card`);
      assert.equal(cards[0].requestId, request.requestId);
      assert.equal(cards[0].replyText, 'go');
    }
    // Stopped: the queued reply turn goes with the queue, and nothing starts it running again.
    await sessions.interrupt(ownerId, asker);
    assert.equal((await replyTurnsOf(asker)).length, 0);
    const held = await requestRow(request.id);
    assert.ok(held.replyHeldAt, 'the outcome was not held for the next turn');
    assert.equal(held.replyClientTurnId, null);
    assert.deepEqual((await worker.drain()).handedOff, [], 'the worker queued it again, after a stop');
    assert.equal((await replyTurnsOf(asker)).length, 0);
    // The asker's next turn — the owner's own message — carries it.
    const ownerKey = randomUUID();
    await sessions.createTurn(ownerId, asker, { clientTurnId: ownerKey, content: 'what did the coordinator say?' });
    // The interrupted turn finishes first.
    const inFlight = await prisma.conversationTurn.findFirstOrThrow({ where: { sessionId: asker, status: 'IN_FLIGHT', kind: 'message' } });
    await finish(asker, inFlight.id);
    const next = await deliver(asker);
    assert.equal(next.clientTurnId, ownerKey);
    assert.ok(next.content.startsWith('what did the coordinator say?'), 'the owner\'s words were not first');
    assert.equal(blocksFor(next.content, request.id), 1);
    assert.equal((await requestRow(request.id)).replyClientTurnId, ownerKey);
    const stored = await say(asker, next.turnId, RunEventType.USER, { text: next.content });
    assert.equal((stored.sessionReplies as unknown[]).length, 1);
    // Said once: the turn after that carries nothing.
    await finish(asker, next.turnId);
    await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: 'thanks' });
    assert.equal(blocksFor((await deliver(asker)).content, request.id), 0);
  });

  await t.test('a reply turn that fails on a transient error is retried as a reply turn, and says its outcome again', async () => {
    const asker = await session('Worker: its reply turn meets an overloaded provider');
    const recipient = await session('Coordinator: answers');
    const request = await ask(asker, recipient, 'go or no-go?');
    await deliver(recipient);
    assert.equal((await reply(recipient, request.requestId, { message: 'go' })).handOff, 'QUEUED');
    const handed = await deliver(asker);
    assert.equal(blocksFor(handed.content, request.id), 1);
    await say(asker, handed.turnId, RunEventType.USER, { text: handed.content });
    // The provider is overloaded: the engine says so, which arms a retry, and the turn fails.
    const overloaded = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    await say(asker, handed.turnId, RunEventType.ASSISTANT, { text: overloaded });
    await api.turnComplete({ id: runnerId } as never, asker, {
      turnId: handed.turnId, status: SharedRunStatus.FAILED, subtype: 'error_during_execution',
      numTurns: 1, costUsd: 0, error: overloaded,
    } as never);
    const failed = await prisma.session.findUniqueOrThrow({ where: { id: asker } });
    assert.equal(failed.status, RunStatus.FAILED);
    assert.ok(failed.retryAt, 'the overload armed no retry');
    // The turn that carried the outcome failed, so the outcome is not taken for read: it is held for
    // the turn the retry hands the asker — not handed back to an asker that is waiting for that retry.
    const held = await requestRow(request.id);
    assert.equal(held.replyClientTurnId, null, 'the outcome went down with the turn that failed');
    assert.ok(held.replyHeldAt);
    assert.ok(!(await worker.drain()).handedOff.includes(request.id));
    // The retry comes due, and the reply turn is re-sent as one.
    await prisma.session.update({ where: { id: asker }, data: { retryAt: new Date(Date.now() - HOUR) } });
    await heartbeat();
    await new AutoRetryService(db, sessions, realtime as never).sweep();
    assert.notEqual((await prisma.session.findUniqueOrThrow({ where: { id: asker } })).status, RunStatus.FAILED, 'the retry was not sent');
    const replyTurns = await replyTurnsOf(asker);
    assert.equal(replyTurns.length, 2);
    assert.equal(replyTurns[1].content, '');
    assert.equal(replyTurns[1].senderSessionId, null);
    const back = await deliver(asker);
    assert.equal(back.turnId, replyTurns[1].id);
    assert.equal(blocksFor(back.content, request.id), 1);
    assert.match(back.content, /回复：go/);
    assert.equal((await requestRow(request.id)).replyClientTurnId, replyTurns[1].clientTurnId);
  });

  await t.test('a reply turn its run ends with in flight is not taken for read: the asker\'s next turn says it', async () => {
    const asker = await session('Worker: its engine exits while it reads an answer');
    const recipient = await session('Coordinator: answers');
    const request = await ask(asker, recipient, 'which migration number is free?');
    await deliver(recipient);
    await reply(recipient, request.requestId, { message: '0350' });
    const handed = await deliver(asker);
    assert.equal((await requestRow(request.id)).replyClientTurnId, handed.clientTurnId);
    // The runner finalizes the run with that turn still in flight: its engine is gone, and the drain
    // answers the turn without it.
    await api.finalize({ id: runnerId } as never, asker, { status: 'FAILED', error: 'the engine exited' } as never);
    assert.equal(
      (await prisma.conversationTurn.findUniqueOrThrow({ where: { id: handed.turnId } })).status,
      'ANSWERED',
    );
    assert.equal((await requestRow(request.id)).replyClientTurnId, null, 'the outcome was taken for read with a turn its engine never finished');
    // The run is over: the hand-off finds an asker that has ended, and holds the outcome for it.
    await worker.drain();
    assert.ok((await requestRow(request.id)).replyHeldAt);
    assert.equal((await replyTurnsOf(asker)).length, 1, 'an ended asker was queued a reply turn');
    // The owner takes the conversation up again: the turn that starts says it.
    const ownerKey = randomUUID();
    await sessions.resume(ownerId, asker, { content: 'so what did the coordinator say?', clientTurnId: ownerKey });
    const next = await deliver(asker);
    assert.equal(next.clientTurnId, ownerKey);
    assert.ok(next.content.startsWith('so what did the coordinator say?'));
    assert.equal(blocksFor(next.content, request.id), 1);
    assert.match(next.content, /回复：0350/);
  });

  // ── §8 criteria 14 and 17: an auto-retry, and the requests and outcomes that ride on it ──────────

  /** Claude Code's own words when a session's quota runs out: a plain reply on a `success` result,
   *  which ingest reads as the quota and arms a retry for, at the reset it names (`retryPlanFor`). */
  const SESSION_LIMIT = "You've hit your session limit · resets 11:59pm (UTC)";
  const OVERLOADED_REPLY = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  type HandedTurn = { turnId: string; content: string };

  /** A turn its quota killed: the engine's reply is the limit, and the turn settles the session idle
   *  with a retry armed — the real park, through ingest and turn-complete. */
  async function quotaKilled(sessionId: string, turn: HandedTurn) {
    await say(sessionId, turn.turnId, RunEventType.USER, { text: turn.content });
    await say(sessionId, turn.turnId, RunEventType.ASSISTANT, { text: SESSION_LIMIT });
    await api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId: turn.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0,
    } as never);
    const parked = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(parked.status, RunStatus.AWAITING_INPUT, 'a turn its quota killed did not park the session idle');
    assert.ok(parked.retryAt, 'the quota armed no retry');
    return parked;
  }

  /** A turn the provider failed: overloaded, and the run FAILED with a retry armed. */
  async function overloaded(sessionId: string, turn: HandedTurn) {
    await say(sessionId, turn.turnId, RunEventType.USER, { text: turn.content });
    await say(sessionId, turn.turnId, RunEventType.ASSISTANT, { text: OVERLOADED_REPLY });
    await api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId: turn.turnId, status: SharedRunStatus.FAILED, subtype: 'error_during_execution',
      numTurns: 1, costUsd: 0, error: OVERLOADED_REPLY,
    } as never);
    const failed = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(failed.status, RunStatus.FAILED);
    assert.ok(failed.retryAt, 'the overload armed no retry');
    return failed;
  }

  /**
   * A turn the engine never started: the runner echoed the message and the engine produced nothing at
   * all — no ASSISTANT, no RESULT. The turn is put back in the queue and the ladder arms a retry from
   * zero (`retryArmAt`'s third branch: `numTurns === 0`, no cost). The other helpers all say something
   * first, which is why this failure mode went untested (§8 criterion 18).
   */
  async function engineNeverCameUp(sessionId: string, turn: HandedTurn) {
    await say(sessionId, turn.turnId, RunEventType.USER, { text: turn.content });
    await api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId: turn.turnId, status: SharedRunStatus.FAILED, subtype: 'error_during_execution',
      numTurns: 0, costUsd: 0, error: 'the runtime never started this turn',
    } as never);
    const failed = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(failed.status, RunStatus.FAILED);
    return failed;
  }

  /** The armed retry comes due — made the oldest due, so the sweep releases it first (one release per
   *  runner and provider a sweep) — and the real sweep runs. */
  async function retryComesDue(sessionId: string, sweeper = new AutoRetryService(db, sessions, realtime as never)) {
    await prisma.session.update({ where: { id: sessionId }, data: { retryAt: new Date(Date.now() - HOUR) } });
    await heartbeat();
    await sweeper.sweep();
  }

  /** The same, without waiting for the sweep: what a caller holding its resume open needs. */
  async function retryDue(sessionId: string, sweeper: AutoRetryService): Promise<void> {
    await prisma.session.update({ where: { id: sessionId }, data: { retryAt: new Date(Date.now() - HOUR) } });
    await heartbeat();
    return sweeper.sweep();
  }

  const resentOn = (sessionId: string) => prisma.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: AUTO_RETRY_TURN_KEY_PREFIX } },
    orderBy: { seq: 'asc' },
  });

  await t.test('a request the auto-retry re-sends goes with it: asked again on the new turn, and not judged while the retry is armed', async () => {
    // Re-sent on the live path: a quota killed the turn, and the session parked idle with a retry armed.
    {
      const asker = await session('Worker: asks just before the quota runs out');
      const recipient = await session('Coordinator: its quota runs out mid-answer');
      const options = [{ label: 'merge now' }, { label: 'wait for review' }];
      const request = await ask(asker, recipient, 'merge now or wait for review?', { replyOptions: options });
      const original = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: request.turnId } });
      const handed = await deliver(recipient);
      assert.equal(handed.turnId, original.id);
      await quotaKilled(recipient, handed);
      // §4.1's sixth wake source: received, unanswered, idle — and still OPEN, because the retry runs
      // the session again.
      assert.equal((await requestRow(request.id)).state, 'OPEN', 'judged NO_REPLY with a retry armed');

      await retryComesDue(recipient);
      const [resent, ...more] = await resentOn(recipient);
      assert.ok(resent, 'the sweep re-sent nothing');
      assert.equal(more.length, 0, 'the sweep re-sent the message twice');
      assert.equal(resent.senderSessionId, asker, 'the re-send dropped its sender');
      const moved = await requestRow(request.id);
      assert.equal(moved.turnId, resent.id, 'the request stayed on the turn the quota killed');
      assert.equal(moved.clientTurnId, original.clientTurnId, 'the request lost the key it was sent under');
      assert.equal(moved.state, 'OPEN');

      // The engine is asked again: which request, by when, how to answer, and the options.
      const again = await deliver(recipient);
      assert.equal(again.turnId, resent.id);
      assert.match(again.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`));
      assert.match(again.content, /reply-by="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"/);
      assert.match(again.content, new RegExp(`session_reply\\(requestId="${uuidToBase62(request.id)}"\\)`));
      assert.match(again.content, /\n0\. merge now\n1\. wait for review\n/);
      // ...and the card its echo is stored with names the request.
      const echoed = await say(recipient, again.turnId, RunEventType.USER, { text: again.content });
      assert.equal((echoed.sessionMessage as Record<string, unknown>).requestId, uuidToBase62(request.id));
      // The asker retrying its send under the key it chose still reads its own receipt.
      const receipt = await sessionSend(asker, recipient, 'merge now or wait for review?', {
        clientTurnId: original.clientTurnId, expectReply: true, replyOptions: options,
      });
      assert.equal(receipt.requestId, request.requestId);
      // Judged on the turn it rides on now: read, idle, nothing left to wake it, unanswered.
      await finish(recipient, again.turnId, 'still reading the diff');
      assert.equal((await requestRow(request.id)).state, 'NO_REPLY');
    }

    // Re-sent by the revive: the provider failed the turn, and the run is FAILED with a retry armed.
    {
      const asker = await session('Worker: asks one the provider fails');
      const recipient = await session('Coordinator: overloaded');
      const request = await ask(asker, recipient, 'is the release branch cut?');
      await overloaded(recipient, await deliver(recipient));
      assert.equal((await requestRow(request.id)).state, 'OPEN');
      await retryComesDue(recipient);
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).status, RunStatus.PENDING,
        'the failed session was not revived');
      const [resent] = await resentOn(recipient);
      assert.equal(resent?.senderSessionId, asker);
      assert.equal((await requestRow(request.id)).turnId, resent.id);
      const again = await deliver(recipient);
      assert.equal(again.turnId, resent.id);
      assert.match(again.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`));
      assert.match(again.content, /对方在等你回复/);
    }
  });

  await t.test('a failure that produced nothing keeps its request for the retry that re-sends it (§8 criterion 18)', async () => {
    // The request rides on the turn the retry re-sends: it stays OPEN and moves with it.
    {
      const asker = await session('Worker: asks a session whose engine never came up');
      const recipient = await session('Coordinator: the engine never started its turn');
      const request = await ask(asker, recipient, 'is the release branch cut?');
      const handed = await deliver(recipient);
      assert.equal(handed.turnId, request.turnId);
      await engineNeverCameUp(recipient, handed);
      // The turn was put back in the queue and drained with the run's end; the request is not closed
      // with it, because those words come back as the sweeper's next turn.
      assert.equal((await requestRow(request.id)).state, 'OPEN',
        'the request was closed UNDELIVERED for words the retry re-sends');
      assert.equal((await requestRow(request.id)).closeReason, null);

      await retryComesDue(recipient);
      const [resent, ...more] = await resentOn(recipient);
      assert.ok(resent, 'the sweep re-sent nothing');
      assert.equal(more.length, 0, 'the sweep re-sent the message twice');
      assert.equal(resent.senderSessionId, asker, 'the re-send dropped its sender');
      const moved = await requestRow(request.id);
      assert.equal(moved.turnId, resent.id, 'the request did not move to the re-sent turn');
      assert.equal(moved.state, 'OPEN');
      // The engine is asked again, by the turn the request now rides on.
      const again = await deliver(recipient);
      assert.equal(again.turnId, resent.id);
      assert.match(again.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`));
      assert.match(again.content, /对方在等你回复/);
    }

    // A request on a turn of its own, behind the one the retry re-sends: those words are gone with
    // the queue and are not re-sent, so that request IS closed UNDELIVERED — and the asker is told.
    {
      const asker = await session('Worker: asks behind a turn that produced nothing');
      const recipient = await session('Coordinator: fails with one of its own queued behind');
      const own = await sessions.createTurn(ownerId, recipient, { clientTurnId: randomUUID(), content: 'the run\'s own work' });
      const running = await deliver(recipient);
      assert.equal(running.turnId, own.turnId);
      const request = await ask(asker, recipient, 'and is the tag pushed?');
      await engineNeverCameUp(recipient, running);
      const row = await requestRow(request.id);
      assert.equal(row.state, 'UNDELIVERED', 'a request the retry does not re-send was left open');
      assert.equal(row.closeReason, 'DRAINED');
      // The drain's outcomes are handed back by the worker, not inside the failing turn's transaction.
      assert.ok((await worker.drain()).handedOff.includes(request.id), 'the worker did not hand it back');
      const told = await deliver(asker);
      assert.equal(blocksFor(told.content, request.id), 1, 'the asker was not told');
      assert.match(told.content, /outcome="UNDELIVERED"/);
    }

    // Nothing left on the ladder to arm: the words are gone for good, and the request with them.
    {
      const asker = await session('Worker: asks a session with no retry left to arm');
      const recipient = await session('Coordinator: its ladder is spent');
      await prisma.session.update({ where: { id: recipient }, data: { retryAttempts: BACKOFF_MS.length } });
      const request = await ask(asker, recipient, 'one more thing?');
      await engineNeverCameUp(recipient, await deliver(recipient));
      const spent = await prisma.session.findUniqueOrThrow({ where: { id: recipient } });
      assert.equal(spent.retryAt, null, 'a retry was armed past the end of the ladder');
      const row = await requestRow(request.id);
      // No retry is coming, so the failed turn's request is not kept: the run ended and closed it,
      // which is RECIPIENT_ENDED — the outcome §4 gives when both describe the same ending.
      assert.equal(row.state, 'RECIPIENT_ENDED');
      assert.ok((await worker.drain()).handedOff.includes(request.id), 'the worker did not hand it back');
      const told = await deliver(asker);
      assert.equal(blocksFor(told.content, request.id), 1);
      assert.match(told.content, /outcome="RECIPIENT_ENDED"/);
    }
  });

  await t.test('a reply turn a quota killed is held for the retry, which says it again on a reply turn', async () => {
    const asker = await session('Worker: its quota runs out as the answer arrives');
    const recipient = await session('Coordinator: answers');
    const request = await ask(asker, recipient, 'go or no-go?');
    await deliver(recipient);
    assert.equal((await reply(recipient, request.requestId, { message: 'go' })).handOff, 'QUEUED');
    const handed = await deliver(asker);
    assert.equal(blocksFor(handed.content, request.id), 1);
    await quotaKilled(asker, handed);
    // The turn is answered — the limit was its reply — but no engine read what it said: held for the
    // retry, and not handed back to an asker that is waiting for that retry.
    const held = await requestRow(request.id);
    assert.equal(held.replyClientTurnId, null, 'the outcome stayed on a turn its engine never read through');
    assert.ok(held.replyHeldAt);
    assert.ok(!(await worker.drain()).handedOff.includes(request.id));

    await retryComesDue(asker);
    const after = await prisma.session.findUniqueOrThrow({ where: { id: asker } });
    assert.equal(after.retryAt, null);
    assert.notEqual(after.status, RunStatus.AWAITING_INPUT, 'the retry was given up as having nothing to re-send');
    const replyTurns = await replyTurnsOf(asker);
    assert.equal(replyTurns.length, 2);
    assert.ok(replyTurns[1].clientTurnId.startsWith(`${SESSION_REPLY_TURN_PREFIX}retry:`), replyTurns[1].clientTurnId);
    assert.equal(replyTurns[1].content, '');
    // Taken onto it as it was written: nothing else can say it first and leave this turn empty.
    assert.equal((await requestRow(request.id)).replyClientTurnId, replyTurns[1].clientTurnId);
    const back = await deliver(asker);
    assert.equal(back.turnId, replyTurns[1].id);
    assert.equal(blocksFor(back.content, request.id), 1);
    assert.match(back.content, /回复：go/);
  });

  await t.test('an asker a transient failure stopped with its retry armed has not ended: the outcome waits for the retry, and its task is told nothing', async () => {
    // Failed by the provider: the run is FAILED, the retry armed.
    {
      const taskId = await task('the task an overloaded asker runs');
      const asker = await session('Worker: overloaded with a question out', { taskId });
      const recipient = await session('Coordinator: answers while it is down');
      const request = await ask(asker, recipient, 'which port?');
      await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: 'carry on with the port work' });
      await overloaded(asker, await deliver(asker));
      await deliver(recipient);
      assert.equal((await reply(recipient, request.requestId, { message: '8443' })).handOff, 'HELD');
      assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0, 'an asker waiting on its retry was told it had ended');
      assert.equal((await replyTurnsOf(asker)).length, 0);
      await worker.drain();
      assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0);
      // The retry re-sends the message the provider failed, and that turn says the outcome.
      await retryComesDue(asker);
      const again = await deliver(asker);
      assert.ok(again.content.startsWith('carry on with the port work'), 'the failed message was not re-sent');
      assert.equal(blocksFor(again.content, request.id), 1);
      assert.match(again.content, /回复：8443/);
      await worker.drain();
      assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0, 'the retry going ahead was read as one given up');
    }

    // Stopped by its quota: idle with the retry armed — and a reply turn now would take the retry's place.
    {
      const taskId = await task('the task a quota-stopped asker runs');
      const asker = await session('Worker: its quota runs out with a question out', { taskId });
      const recipient = await session('Coordinator: answers while it waits');
      const request = await ask(asker, recipient, 'which region?');
      await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: 'deploy to the region they pick' });
      const parked = await quotaKilled(asker, await deliver(asker));
      await deliver(recipient);
      assert.equal((await reply(recipient, request.requestId, { message: 'eu-west-1' })).handOff, 'HELD');
      const waiting = await prisma.session.findUniqueOrThrow({ where: { id: asker } });
      assert.equal(waiting.status, RunStatus.AWAITING_INPUT, 'the asker was woken ahead of its retry');
      assert.equal(waiting.retryAt?.getTime(), parked.retryAt?.getTime(), 'the reply disarmed the retry');
      assert.equal((await replyTurnsOf(asker)).length, 0);
      assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0);
      await retryComesDue(asker);
      const again = await deliver(asker);
      assert.ok(again.content.startsWith('deploy to the region they pick'), 'the message the quota killed was not re-sent');
      assert.equal(blocksFor(again.content, request.id), 1);
      assert.match(again.content, /回复：eu-west-1/);
      assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0);
    }
  });

  await t.test('a retry given up is said where the asker stands then: the task for an ended one, a reply turn for an idle one (§8 criterion 21)', async () => {
    /** An asker `stop` parked with a retry armed, the outcome of its request held for that retry. */
    async function heldForRetry(
      label: string,
      stop: (sessionId: string, turn: HandedTurn) => Promise<unknown>,
      { task: withTask = true }: { task?: boolean } = {},
    ) {
      const taskId = withTask ? await task(`the task (${label})`) : null;
      const asker = await session(`Worker: parked (${label})`, withTask ? { taskId: taskId! } : {});
      const recipient = await session(`Coordinator (${label})`);
      const request = await ask(asker, recipient, `still need the answer? (${label})`);
      await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: `the work (${label})` });
      await stop(asker, await deliver(asker));
      await deliver(recipient);
      assert.equal((await reply(recipient, request.requestId, { message: `the answer: ${label}` })).handOff, 'HELD');
      // Nothing yet: the retry is still armed.
      assert.ok(!(await worker.drain()).commented.includes(request.id), `${label}: told before the retry was given up`);
      if (taskId) assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0);
      assert.equal((await replyTurnsOf(asker)).length, 0, `${label}: woken ahead of its retry`);
      return { taskId, asker, request };
    }
    /** Ended: §4.3's comment on the task it ran, once, and the outcome stays held for a turn it may yet get. */
    async function toldOnce(label: string, taskId: string, requestId: string) {
      assert.ok((await worker.drain()).commented.includes(requestId), `${label}: the task was not told`);
      const comments = await prisma.taskComment.findMany({ where: { taskId } });
      assert.equal(comments.length, 1, `${label}`);
      assert.equal(comments[0].id, sessionReplyCommentId(requestId));
      assert.match(comments[0].body, /自动重试被放弃/);
      assert.ok(comments[0].body.includes(`the answer: ${label}`), `${label}: the comment does not carry the outcome`);
      const row = await requestRow(requestId);
      assert.equal(row.replyCommentDueAt, null);
      assert.ok(row.replyHeldAt);
      assert.equal(row.replyClientTurnId, null);
      assert.ok(!(await worker.drain()).commented.includes(requestId));
      assert.equal(await prisma.taskComment.count({ where: { taskId } }), 1, `${label}: told twice`);
    }
    /** Merely idle: §4.2's reply turn, on a session with no task of its own as readily as one with. */
    async function handedBack(label: string, asker: string, taskId: string | null, requestId: string) {
      const told = await worker.drain();
      assert.ok(told.handedBack.includes(requestId), `${label}: the outcome was not handed back`);
      assert.deepEqual(told.commented, [], `${label}: told on a task instead`);
      const turns = await replyTurnsOf(asker);
      assert.equal(turns.length, 1, `${label}`);
      assert.equal((await requestRow(requestId)).replyClientTurnId, turns[0].clientTurnId);
      const back = await deliver(asker);
      assert.equal(back.turnId, turns[0].id);
      assert.equal(blocksFor(back.content, requestId), 1, `${label}: the reply turn does not carry the outcome`);
      assert.match(back.content, new RegExp(`the answer: ${label}`));
      const row = await requestRow(requestId);
      assert.equal(row.replyHeldAt, null);
      assert.equal(row.replyCommentDueAt, null);
      if (taskId) assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0, `${label}: told on a task too`);
    }

    // Ended: the run failed and the ladder is spent. FAILED with no retry is a run that is over.
    {
      const { taskId, asker, request } = await heldForRetry('failed, every attempt spent', overloaded);
      await prisma.session.update({ where: { id: asker }, data: { retryAttempts: BACKOFF_MS.length } });
      await retryComesDue(asker);
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: asker } })).retryAt, null, 'not given up');
      await toldOnce('failed, every attempt spent', taskId!, request.id);
    }
    // Ended: completed while it waits.
    {
      const { taskId, asker, request } = await heldForRetry('completed while it waits', overloaded);
      await sessions.complete(ownerId, asker);
      await toldOnce('completed while it waits', taskId!, request.id);
    }
    // Merely idle: its quota stopped it and the ladder is spent — parked, live, and running no task.
    {
      const { taskId, asker, request } = await heldForRetry('quota, every attempt spent', quotaKilled, { task: false });
      assert.equal(taskId, null);
      await prisma.session.update({ where: { id: asker }, data: { retryAttempts: BACKOFF_MS.length } });
      await retryComesDue(asker);
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: asker } })).retryAt, null, 'not given up');
      await handedBack('quota, every attempt spent', asker, taskId, request.id);
    }
    // Merely idle: the owner turns the retry off.
    {
      const { taskId, asker, request } = await heldForRetry('turned off', quotaKilled);
      await sessions.cancelAutoRetry(ownerId, asker);
      await handedBack('turned off', asker, taskId, request.id);
    }
  });

  await t.test('a retry claimed but not yet re-sent still counts as coming (§8 criterion 20)', async () => {
    const taskId = await task('the task a claimed asker runs');
    const asker = await session('Worker: its retry is claimed and not yet written', { taskId });
    const recipient = await session('Coordinator: answers while the claim is open');
    const request = await ask(asker, recipient, 'which port?');
    await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: 'carry on with the port work' });
    await overloaded(asker, await deliver(asker));
    assert.ok((await prisma.session.findUniqueOrThrow({ where: { id: asker } })).retryAt);

    // The window itself: the sweep's claim is one statement and its resume is the next transaction.
    // Held open here so the moment the criterion is about is the one under test, not a race to hope
    // for — the claim has committed and the turn it promised has not been written.
    let claimed!: () => void;
    const claimedNow = new Promise<void>((resolve) => { claimed = resolve; });
    let release!: () => void;
    const windowOpen = new Promise<void>((resolve) => { release = resolve; });
    const pausing = Object.assign(Object.create(sessions) as SessionsService, {
      resume: async (...args: Parameters<SessionsService['resume']>) => {
        claimed();
        await windowOpen;
        return sessions.resume(...args);
      },
    });
    const sweeping = retryDue(asker, new AutoRetryService(db, pausing, realtime as never));
    await claimedNow;
    const claimedRow = await prisma.session.findUniqueOrThrow({ where: { id: asker } });
    assert.equal(claimedRow.retryAt, null, 'the claim did not clear retry_at');
    assert.ok(claimedRow.retryClaimedAt, 'the claim left nothing behind saying a turn is on its way');

    // The asker has NOT ended: the outcome is held for the retry's turn, and its task is told nothing
    // — neither by the hand-off nor by the worker's next pass.
    const held = await reply(recipient, request.requestId, { message: '8443' });
    assert.equal(held.handOff, 'HELD', 'the claim window was read as an asker that had ended');
    assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0, 'told it had ended mid-claim');
    const toldByWorker = await worker.drain();
    assert.deepEqual(toldByWorker.commented, [], 'the worker told its task too');
    assert.deepEqual(toldByWorker.handedBack, []);
    const heldRow = await requestRow(request.id);
    assert.ok(heldRow.replyHeldAt, 'the outcome was not held for the retry turn');
    assert.equal(heldRow.replyClientTurnId, null);

    // The retry's turn is written, and IT says the outcome — once.
    release();
    await sweeping;
    const again = await deliver(asker);
    assert.ok(again.content.startsWith('carry on with the port work'), 'the failed message was not re-sent');
    assert.equal(blocksFor(again.content, request.id), 1);
    assert.match(again.content, /回复：8443/);
    await worker.drain();
    assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0, 'the retry going ahead was read as given up');
  });

  await t.test('a re-sent reply turn whose outcome another turn said first is not sent empty', async () => {
    const asker = await session('Worker: its reply turn fails, and the owner gets there first');
    const recipient = await session('Coordinator: answers');
    const request = await ask(asker, recipient, 'go or no-go?');
    await deliver(recipient);
    await reply(recipient, request.requestId, { message: 'go' });
    await overloaded(asker, await deliver(asker));
    assert.ok((await requestRow(request.id)).replyHeldAt);
    // The sweep looks, finds the outcome held and claims the retry; before its re-send is written, the
    // owner takes the conversation up and the turn that starts says the outcome.
    let reached = 0;
    const overtaken = Object.assign(Object.create(sessions) as SessionsService, {
      resume: async (...args: Parameters<SessionsService['resume']>) => {
        if (reached++ === 0) {
          await sessions.resume(ownerId, asker, { clientTurnId: 'the-owner-first', content: 'so, go or no-go?' });
          const first = await deliver(asker);
          assert.equal(blocksFor(first.content, request.id), 1, 'the owner\'s turn did not say the held outcome');
        }
        return sessions.resume(...args);
      },
    });
    await retryComesDue(asker, new AutoRetryService(db, overtaken, realtime as never));
    assert.equal(reached, 1, 'the sweep never reached its re-send');
    const resentReplies = await prisma.conversationTurn.findMany({
      where: { sessionId: asker, clientTurnId: { startsWith: `${SESSION_REPLY_TURN_PREFIX}retry:` } },
    });
    assert.deepEqual(resentReplies, [], 'a reply turn with nothing left to say was written');
    assert.equal((await requestRow(request.id)).replyClientTurnId, 'the-owner-first');
  });

  // ── §8 criteria 23–25: a failure with no echo, a claim nobody finished, a retry turned off mid-claim ──

  /**
   * The real Claude delivery failure (runner-go session.go, `failUndeliveredTurn`): the runtime refused
   * the message before it was written — a CLI that stopped reading stdin, a process already gone — so the
   * runner writes NO `user` echo. What it does write is its receipt — a `user_delivery`, failed, naming
   * the turn — and then the completion: FAILED as `delivery_failed`, nothing run and nothing billed.
   * `receipt: false` is the same failure from a runner that writes no receipt either.
   */
  async function refusedBeforeWritten(sessionId: string, turn: HandedTurn, { receipt = true } = {}) {
    const why = 'write |1: broken pipe';
    if (receipt) {
      await say(sessionId, turn.turnId, RunEventType.USER_DELIVERY, {
        turnId: turn.turnId, delivery: 'failed', reason: why, retryable: true,
      });
    }
    await api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId: turn.turnId, status: SharedRunStatus.FAILED, subtype: 'delivery_failed',
      numTurns: 0, costUsd: 0, result: `message not delivered to the engine: ${why}`,
    } as never);
    const failed = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(failed.status, RunStatus.FAILED);
    assert.equal(await prisma.runEvent.count({ where: { sessionId, turnId: turn.turnId, type: RunEventType.USER } }), 0,
      'the fixture echoed the message it says was never written');
    return failed;
  }

  /**
   * The retry comes due and the real sweep claims it — and its re-send is held at `resume`, the moment
   * between the claim and the turn it promised, until `release`. `claimed` settles once the claim has
   * committed; `sweeping` once the sweep is done with the row. Begun with a `now` twenty minutes old, as
   * a sweep that waited behind others' resumes would be: the claim is stamped with its own instant.
   */
  async function sweepHeldAtTheClaim(sessionId: string) {
    let claimedIt = false;
    let claimedNow!: () => void;
    const claimed = new Promise<void>((resolve) => { claimedNow = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holding = Object.assign(Object.create(sessions) as SessionsService, {
      resume: async (...args: Parameters<SessionsService['resume']>) => {
        claimedIt = args[1] === sessionId;
        claimedNow();
        await released;
        return sessions.resume(...args);
      },
    });
    const sweeper = new AutoRetryService(db, holding, realtime as never);
    // The oldest due by far, so this is the one row the sweep releases (one per runner and provider).
    await prisma.session.update({ where: { id: sessionId }, data: { retryAt: new Date(Date.now() - 3 * HOUR) } });
    await heartbeat();
    const sweeping = sweeper.sweep(new Date(Date.now() - 20 * 60_000));
    // A sweep that finished without reaching the re-send claimed nothing: said here, not as a hang.
    await Promise.race([claimed, sweeping]);
    assert.ok(claimedIt, `the sweep did not claim the retry of ${sessionId}`);
    const row = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(row.retryAt, null, 'the claim did not clear retry_at');
    assert.ok(row.retryClaimedAt, 'the claim left nothing behind saying a turn is on its way');
    assert.ok(Date.now() - row.retryClaimedAt.getTime() < 60_000,
      'the claim was stamped with the instant its sweep began, not its own: a lease already spent');
    return { sweeper, sweeping, release, claim: row };
  }

  await t.test('a failure with no echo — Claude’s own delivery failure — is re-sent as itself, and the request goes with it (§8 criterion 23)', async () => {
    // The runner's receipt is the only trace of the failed message. An earlier message of the
    // recipient's, echoed and answered, is the one a retry reading echoes alone would re-send.
    {
      const asker = await session('Worker: asks a session whose CLI stopped reading');
      const recipient = await session('Coordinator: its CLI stops reading stdin');
      const earlier = await sessions.createTurn(ownerId, recipient, {
        clientTurnId: randomUUID(), content: 'the owner’s earlier question',
      });
      const first = await deliver(recipient);
      assert.equal(first.turnId, earlier.turnId);
      await say(recipient, first.turnId, RunEventType.USER, { text: first.content });
      await finish(recipient, first.turnId, 'the earlier answer');

      const request = await ask(asker, recipient, 'is the release branch cut?');
      const handed = await deliver(recipient);
      assert.equal(handed.turnId, request.turnId);
      const failed = await refusedBeforeWritten(recipient, handed);
      assert.ok(failed.retryAt, 'a turn that ran nothing armed no retry');
      assert.equal((await requestRow(request.id)).state, 'OPEN', 'closed although the retry re-sends its words');

      await retryComesDue(recipient);
      const [resent, ...more] = await resentOn(recipient);
      assert.ok(resent, 'the sweep re-sent nothing');
      assert.equal(more.length, 0, 'the sweep re-sent twice');
      assert.equal(resent.content, 'is the release branch cut?',
        'the sweep re-sent the message before the one that failed — an answered question, asked again');
      assert.equal(resent.senderSessionId, asker, 'the re-send dropped its sender');
      const moved = await requestRow(request.id);
      assert.equal(moved.turnId, resent.id, 'the request stayed on a turn nothing will deliver');
      assert.equal(moved.state, 'OPEN');
      // The engine is asked again, and the request is judged on the turn it rides now — not left to
      // its deadline. (The revive handed the session to whichever runner process claims it next; the
      // claim that takes it back is this file's runner, which keeps no process owner.)
      const again = await deliver(recipient);
      assert.equal(again.turnId, resent.id);
      assert.match(again.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`));
      await prisma.session.update({ where: { id: recipient }, data: { inboxLeaseOwner: null } });
      await say(recipient, again.turnId, RunEventType.USER, { text: again.content });
      await finish(recipient, again.turnId, 'still checking the branch');
      assert.equal((await requestRow(request.id)).state, 'NO_REPLY');
    }

    // The same failure from a runner that leaves no trace at all — no echo, no receipt — is one the
    // retry cannot find again. Its request is UNDELIVERED at once, and the asker is told.
    {
      const asker = await session('Worker: asks a session that fails without a trace');
      const recipient = await session('Coordinator: fails without a trace');
      const request = await ask(asker, recipient, 'and is the tag pushed?');
      const failed = await refusedBeforeWritten(recipient, await deliver(recipient), { receipt: false });
      assert.ok(failed.retryAt);
      const row = await requestRow(request.id);
      assert.equal(row.state, 'UNDELIVERED', 'left OPEN on a turn nothing will deliver, until its deadline');
      assert.equal(row.closeReason, 'DRAINED');
      assert.ok((await worker.drain()).handedOff.includes(request.id), 'the worker did not hand it back');
      const told = await deliver(asker);
      assert.equal(blocksFor(told.content, request.id), 1, 'the asker was not told');
      assert.match(told.content, /outcome="UNDELIVERED"/);
    }
  });

  await t.test('a claim whose re-send was never written is given up when its lease runs out, and what it held is said where the asker stands (§8 criterion 24)', async () => {
    /**
     * An asker `stop` parked with a retry armed. The sweep claims the retry and the process stops
     * before the re-send is written — the resume never returns — and the recipient answers meanwhile:
     * the outcome is held for a turn that is now never coming. Nothing is said while the claim's lease
     * runs; when it has run out, the claim is given up.
     */
    async function claimedThenAbandoned(
      label: string,
      stop: (sessionId: string, turn: HandedTurn) => Promise<unknown>,
      { task: withTask = true }: { task?: boolean } = {},
    ) {
      const taskId = withTask ? await task(`the task (${label})`) : null;
      const asker = await session(`Worker: its sweep stopped mid-claim (${label})`, taskId ? { taskId } : {});
      const recipient = await session(`Coordinator (${label})`);
      const request = await ask(asker, recipient, `which port? (${label})`);
      await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: `the port work (${label})` });
      await stop(asker, await deliver(asker));
      const held = await sweepHeldAtTheClaim(asker);
      await deliver(recipient);
      assert.equal((await reply(recipient, request.requestId, { message: `8443 (${label})` })).handOff, 'HELD',
        `${label}: the claim was not believed while its lease ran`);
      const early = await worker.drain();
      assert.deepEqual([early.commented, early.handedBack], [[], []], `${label}: said before the lease ran out`);
      assert.ok(!(await held.sweeper.releaseExpiredClaims()).includes(asker), `${label}: given up inside its lease`);
      return { taskId, asker, request, ...held };
    }
    /** The lease runs out, and the claim is given up the way a retry is: the attempt it spent goes back. */
    async function leaseRunsOut(label: string, asker: string, claimed: { sweeper: AutoRetryService; claim: { retryClaimedAt: Date | null; retryAttempts: number } }) {
      const after = new Date(claimed.claim.retryClaimedAt!.getTime() + RETRY_CLAIM_WINDOW_MS + 1_000);
      assert.ok((await claimed.sweeper.releaseExpiredClaims(after)).includes(asker), `${label}: the lapsed claim was not given up`);
      const given = await prisma.session.findUniqueOrThrow({ where: { id: asker } });
      assert.equal(given.retryClaimedAt, null);
      assert.equal(given.retryAt, null);
      assert.equal(given.retryAttempts, claimed.claim.retryAttempts - 1, `${label}: the attempt the claim spent was kept`);
      return given;
    }

    // Ended: its run failed, and with the retry given up nothing will run it again — §4.3's comment on
    // the task it ran, once. The writer that comes back after its lease writes nothing.
    {
      const label = 'failed';
      const { taskId, asker, request, sweeping, release, ...claimed } = await claimedThenAbandoned(label, overloaded);
      const given = await leaseRunsOut(label, asker, claimed);
      assert.equal(given.status, RunStatus.FAILED);
      const told = await worker.drain();
      assert.ok(told.commented.includes(request.id), 'the task of an asker that ended was not told');
      assert.deepEqual(told.handedBack, []);
      const comments = await prisma.taskComment.findMany({ where: { taskId: taskId! } });
      assert.deepEqual(comments.map((comment) => comment.id), [sessionReplyCommentId(request.id)]);
      assert.ok(comments[0].body.includes(`8443 (${label})`), 'the comment does not carry the outcome');
      release();
      await sweeping;
      assert.deepEqual(await resentOn(asker), [], 'a re-send written after its claim was given up');
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: asker } })).status, RunStatus.FAILED);
      await worker.drain();
      assert.equal(await prisma.taskComment.count({ where: { taskId: taskId! } }), 1, 'told twice');
    }
    // Merely idle: its quota stopped it, and it runs no task — §4.2's reply turn, once.
    {
      const label = 'idle';
      const { taskId, asker, request, sweeping, release, ...claimed } = await claimedThenAbandoned(label, quotaKilled, { task: false });
      assert.equal(taskId, null);
      const given = await leaseRunsOut(label, asker, claimed);
      assert.equal(given.status, RunStatus.AWAITING_INPUT);
      const told = await worker.drain();
      assert.ok(told.handedBack.includes(request.id), 'the idle asker was not handed its outcome back');
      assert.deepEqual(told.commented, []);
      release();
      await sweeping;
      assert.deepEqual(await resentOn(asker), [], 'a re-send written after its claim was given up');
      const [turn, ...others] = await replyTurnsOf(asker);
      assert.ok(turn, 'no reply turn was queued');
      assert.equal(others.length, 0);
      const back = await deliver(asker);
      assert.equal(back.turnId, turn.id);
      assert.equal(blocksFor(back.content, request.id), 1);
      assert.match(back.content, new RegExp(`8443 \\(${label}\\)`));
    }
  });

  await t.test('the owner turns the retry off while it is claimed: its re-send is not written, and the outcome is said once (§8 criterion 25)', async () => {
    // Ended: the asker's run failed. Turning the retry off mid-claim is the retry given up, and the
    // request worker says the outcome on its task — and the re-send the claim promised is not written
    // after that, to say it a second time.
    {
      const taskId = await task('the task whose retry is turned off mid-claim');
      const asker = await session('Worker: its retry is turned off mid-claim', { taskId });
      const recipient = await session('Coordinator: answers while the claim is open');
      const request = await ask(asker, recipient, 'which port? (turned off)');
      await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: 'carry on with the port work' });
      await overloaded(asker, await deliver(asker));
      const { sweeping, release } = await sweepHeldAtTheClaim(asker);
      await deliver(recipient);
      assert.equal((await reply(recipient, request.requestId, { message: '8443' })).handOff, 'HELD');

      await sessions.cancelAutoRetry(ownerId, asker);
      // The request worker gets there while the re-send is still on its way.
      assert.ok((await worker.drain()).commented.includes(request.id), 'the retry turned off was not read as given up');
      release();
      await sweeping;
      assert.deepEqual(await resentOn(asker), [], 'the re-send went out after the retry was turned off');
      const after = await prisma.session.findUniqueOrThrow({ where: { id: asker } });
      assert.equal(after.status, RunStatus.FAILED);
      assert.equal(after.retryAt, null, 'the retry the owner turned off was armed again');
      // Said once: the comment, and no turn of the asker's carrying it.
      assert.equal(await prisma.taskComment.count({ where: { taskId } }), 1);
      assert.equal((await requestRow(request.id)).replyClientTurnId, null);
      assert.equal(await prisma.conversationTurn.count({ where: { sessionId: asker, status: { not: 'ANSWERED' } } }), 0,
        'a turn is waiting to say it again');
    }
    // Merely idle: a quota stopped it. Turning the retry off mid-claim leaves it parked and live, so the
    // outcome goes back to it as a reply turn — and only that turn says it.
    {
      const asker = await session('Worker: its quota retry is turned off mid-claim');
      const recipient = await session('Coordinator: answers while that claim is open');
      const request = await ask(asker, recipient, 'which region? (turned off)');
      await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: 'deploy where they say' });
      await quotaKilled(asker, await deliver(asker));
      const { sweeping, release } = await sweepHeldAtTheClaim(asker);
      await deliver(recipient);
      assert.equal((await reply(recipient, request.requestId, { message: 'eu-west-1' })).handOff, 'HELD');

      await sessions.cancelAutoRetry(ownerId, asker);
      release();
      await sweeping;
      assert.deepEqual(await resentOn(asker), [], 'the re-send went out after the retry was turned off');
      const told = await worker.drain();
      assert.ok(told.handedBack.includes(request.id), 'the outcome held for a retry turned off was never said');
      const [turn, ...others] = await replyTurnsOf(asker);
      assert.ok(turn);
      assert.equal(others.length, 0);
      const back = await deliver(asker);
      assert.equal(back.turnId, turn.id);
      assert.equal(blocksFor(back.content, request.id), 1);
      assert.match(back.content, /回复：eu-west-1/);
    }
  });

  await t.test('an outcome whose asker is armed again does not hold the worker’s place in line', async () => {
    // Two askers whose retry was turned off, each with an outcome marked for the request worker; then
    // the first is armed again. It waits for its retry's turn — and the pass, one row at a time, must
    // still reach the one behind it rather than reading the waiting one first on every pass for ever.
    const batchOfOne = new SessionRequestWorker(db, requests, { pollIntervalMs: HOUR, batch: 1 });
    const parked: Array<{ asker: string; request: { id: string } }> = [];
    for (const label of ['armed again', 'turned off']) {
      const asker = await session(`Worker: ${label}, its outcome marked`);
      const recipient = await session(`Coordinator (${label})`);
      const request = await ask(asker, recipient, `still need it? (${label})`);
      await sessions.createTurn(ownerId, asker, { clientTurnId: randomUUID(), content: `the work (${label})` });
      await quotaKilled(asker, await deliver(asker));
      await deliver(recipient);
      assert.equal((await reply(recipient, request.requestId, { message: label })).handOff, 'HELD');
      await sessions.cancelAutoRetry(ownerId, asker);
      assert.ok((await requestRow(request.id)).replyCommentDueAt, `${label}: the retry turned off left no mark`);
      parked.push({ asker, request });
    }
    const [armedAgain, turnedOff] = parked;
    await sessions.armAutoRetry(ownerId, armedAgain.asker, new Date(Date.now() + HOUR).toISOString());
    let told = false;
    for (let pass = 0; pass < 10 && !told; pass++) {
      told = (await batchOfOne.drain()).handedBack.includes(turnedOff.request.id);
    }
    assert.ok(told, 'an asker waiting on its retry held the head of the line, and the one behind it was never told');
    const waiting = await requestRow(armedAgain.request.id);
    assert.equal(waiting.replyCommentDueAt, null, 'the waiting asker kept its mark');
    assert.ok(waiting.replyHeldAt, 'the outcome stopped being held for the retry');
    assert.equal(waiting.replyClientTurnId, null);
    // Turned off again later, it is marked again — and told.
    await sessions.cancelAutoRetry(ownerId, armedAgain.asker);
    assert.ok((await requestRow(armedAgain.request.id)).replyCommentDueAt, 'given up again, it was not marked again');
    told = false;
    for (let pass = 0; pass < 10 && !told; pass++) {
      told = (await batchOfOne.drain()).handedBack.includes(armedAgain.request.id);
    }
    assert.ok(told, 'given up again, it was never told');
  });

  // ── 3.1: what a send may ask, and what it is refused ─────────────────────────────────────────

  await t.test('the send door refuses a headless request, a request to oneself, the fifty-first, and a malformed one', async () => {
    const asker = await session('Worker: tries everything');
    const recipient = await session('Worker: the one asked');
    await assert.rejects(() => sessionSend(null, recipient, 'from a bridge', { expectReply: true }), (e: unknown) => {
      assert.equal(refusalOf(e).status, 403);
      return true;
    });
    await assert.rejects(() => sessionSend(asker, asker, 'me to me', { expectReply: true }), (e: unknown) => {
      const refusal = refusalOf(e);
      assert.equal(refusal.status, 400);
      assert.equal(refusal.body.code, SELF_REQUEST_CODE);
      return true;
    });
    for (const extra of [
      { replyOptions: [{ label: 'a' }, { label: 'b' }] },
      { replyWithinSeconds: 600 },
      { expectReply: true, replyOptions: [{ label: 'only one' }] },
      { expectReply: true, replyOptions: [{ label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }, { label: '5' }] },
      { expectReply: true, replyWithinSeconds: 59 },
      { expectReply: true, replyWithinSeconds: 2_592_001 },
      { expectReply: true, replyOptions: [{ label: 'a', colour: 'red' }, { label: 'b' }] },
    ]) {
      await assert.rejects(() => sessionSend(asker, recipient, 'malformed', extra), (e: unknown) => {
        assert.equal(refusalOf(e).status, 400, JSON.stringify(extra));
        return true;
      });
    }
    assert.equal(await prisma.conversationTurn.count({ where: { sessionId: recipient } }), 0, 'a refused send wrote a turn');

    // Fifty OPEN requests is the most one session may have waiting.
    const others = await Promise.all([1, 2, 3].map((i) => session(`Worker: asked in bulk ${i}`)));
    for (let i = 0; i < MAX_OPEN_REQUESTS_PER_SESSION - 1; i++) {
      await prisma.sessionRequest.create({
        data: {
          ownerId, fromSessionId: asker, toSessionId: others[i % 3], turnId: randomUUID(), clientTurnId: randomUUID(),
          requestPreview: `bulk ${i}`, replyBy: new Date(Date.now() + HOUR),
        },
      });
    }
    const fiftieth = await ask(asker, recipient, 'the fiftieth');
    await assert.rejects(() => ask(asker, recipient, 'the fifty-first'), (e: unknown) => {
      const refusal = refusalOf(e);
      assert.equal(refusal.status, 409);
      assert.equal(refusal.body.code, TOO_MANY_OPEN_REQUESTS_CODE);
      assert.equal(refusal.body.retryable, false);
      return true;
    });
    // A plain message is no request, and is not held back by them.
    await sessionSend(asker, recipient, 'just saying');
    // A retry of the fiftieth is the fiftieth, not a fifty-first.
    const key = randomUUID();
    await prisma.sessionRequest.update({ where: { id: fiftieth.id }, data: { state: 'NO_REPLY', closedAt: new Date() } });
    const once = await sessionSend(asker, recipient, 'retried', { expectReply: true, clientTurnId: key });
    const twice = await sessionSend(asker, recipient, 'retried', { expectReply: true, clientTurnId: key });
    assert.equal(twice.requestId, once.requestId);
    assert.equal(twice.turnId, once.turnId);
    // ...and a key used for a request cannot come back as a plain message, nor the other way round.
    await assert.rejects(() => sessionSend(asker, recipient, 'retried', { clientTurnId: key }), (e: unknown) => {
      assert.equal(refusalOf(e).status, 409);
      return true;
    });
    const plainKey = randomUUID();
    await sessionSend(asker, recipient, 'plain', { clientTurnId: plainKey });
    await assert.rejects(() => sessionSend(asker, recipient, 'plain', { clientTurnId: plainKey, expectReply: true }), (e: unknown) => {
      assert.equal(refusalOf(e).status, 409);
      return true;
    });
  });

  // ── 3.1: project_send ─────────────────────────────────────────────────────────────────────────

  await t.test('project_send records the coordinator it delivered to, and the request stays with it through a rotation', async () => {
    const projectId = randomUUID();
    await prisma.project.create({
      data: { id: projectId, ownerId, title: 'rotates', coordinatorEnabled: true, coordinatorWorkspaceId: landingWorkspaceId },
    });
    await establishProjectContractForPgTest(prisma, ownerId, projectId, 'rotates');
    const coordinator = await session('coordinator: rotates', { workspaceId: landingWorkspaceId, titleManagedByProject: true });
    await prisma.project.update({ where: { id: projectId }, data: { coordinatorSessionId: coordinator } });
    const worker1 = await session('Worker: reports to the coordinator');

    const sent = await projectDoor.sendToCoordinator(
      runner, projectId, worker1, await orchestration.issue(runnerId, worker1),
      { message: 'criterion 2 is blocked on a decision', expectReply: true, replyOptions: [{ label: 'skip' }, { label: 'wait' }] } as never,
    ) as Record<string, unknown>;
    assert.equal(sent.sessionId, coordinator);
    const request = await requestRow(base62ToUuid(String(sent.requestId)));
    assert.equal(request.toSessionId, coordinator);
    assert.equal(typeof sent.replyBy, 'string');

    // The coordinator asking its own project is asking itself.
    const coordinatorToken = await orchestration.issue(runnerId, coordinator);
    await assert.rejects(() => projectDoor.sendToCoordinator(
      runner, projectId, coordinator, coordinatorToken, { message: 'self', expectReply: true } as never,
    ), (e: unknown) => {
      assert.equal(refusalOf(e).body.code, SELF_REQUEST_CODE);
      return true;
    });

    // The project rotates to another conversation; the request stays with the one it was put to,
    // and that conversation ending is its outcome.
    const replacement = await session('coordinator: the replacement', { workspaceId: landingWorkspaceId, titleManagedByProject: true });
    await prisma.project.update({ where: { id: projectId }, data: { coordinatorSessionId: replacement } });
    assert.equal((await requestRow(request.id)).toSessionId, coordinator);
    await sessions.complete(ownerId, coordinator);
    assert.equal((await requestRow(request.id)).state, 'RECIPIENT_ENDED');
  });

  // ── 10. the runner doors refuse the reserved prefix ───────────────────────────────────────────

  await t.test('the session-reply: prefix is the platform\'s: the runner doors refuse it as a caller\'s key', async () => {
    const asker = await session('Worker: picks a bad key');
    const recipient = await session('Worker: receives');
    await assert.rejects(
      () => sessionSend(asker, recipient, 'sneaky', { clientTurnId: `${SESSION_REPLY_TURN_PREFIX}${randomUUID()}` }),
      (e: unknown) => {
        assert.equal(refusalOf(e).status, 400);
        return true;
      },
    );
    await assert.rejects(
      async () => sendDoor.interruptSession(
        runner, undefined, asker, await orchestration.issue(runnerId, asker), recipient,
        { message: 'stop and do this', clientTurnId: `${SESSION_REPLY_TURN_PREFIX}x` },
      ),
      (e: unknown) => {
        assert.equal(refusalOf(e).status, 400);
        return true;
      },
    );
    assert.equal(await prisma.conversationTurn.count({ where: { sessionId: recipient } }), 0);
  });

  // ── §8 criteria 26–27: a re-send that will never come, and the message a runner went away with ─────

  await t.test('the owner takes over from a retry: what was kept for its re-send is settled at once — unread, UNDELIVERED; read, judged as read (§8 criterion 26)', async () => {
    /** The owner sends a message of their own instead of pressing Retry. */
    async function ownerTakesOver(recipient: string, content: string) {
      await sessions.resume(ownerId, recipient, { clientTurnId: randomUUID(), content });
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).retryAt, null,
        'the owner’s message left the retry armed');
    }
    /** ...and that turn runs and settles: the request it took the place of is not judged by it. */
    async function ownersTurnSettles(recipient: string, words: string) {
      const own = await deliver(recipient);
      // The revive handed the session to whichever runner process claims it next; this file's keeps none.
      await prisma.session.update({ where: { id: recipient }, data: { inboxLeaseOwner: null } });
      await say(recipient, own.turnId, RunEventType.USER, { text: own.content });
      await finish(recipient, own.turnId, words);
    }
    /** UNDELIVERED the moment the owner's turn is written, said to the asker once, and left so. */
    async function undeliveredOnce(label: string, asker: string, recipient: string, request: { id: string }) {
      const row = await requestRow(request.id);
      assert.equal(row.state, 'UNDELIVERED', `${label}: left OPEN on a turn the retry will never re-send, until its deadline`);
      assert.equal(row.closeReason, 'NOT_RESENT');
      assert.ok((await worker.drain()).handedOff.includes(request.id), `${label}: the worker did not hand it back`);
      assert.ok(!(await worker.drain()).handedOff.includes(request.id), `${label}: handed back twice`);
      const told = await deliver(asker);
      assert.equal(blocksFor(told.content, request.id), 1, `${label}: the asker was not told once`);
      assert.match(told.content, /outcome="UNDELIVERED"/);
      assert.match(told.content, /不会再重发/);
      await ownersTurnSettles(recipient, `the build is green again (${label})`);
      const after = await requestRow(request.id);
      assert.equal(after.state, 'UNDELIVERED', `${label}: judged by the owner’s turn`);
      assert.equal(after.excerpt, null);
      assert.equal((await replyTurnsOf(asker)).length, 1, `${label}: told twice`);
    }

    // No engine read it: Claude refused the message before writing it — the runner's receipt, no echo.
    {
      const asker = await session('Worker: asks one whose owner takes over after a refused delivery');
      const recipient = await session('Coordinator: its CLI stops reading, and its owner takes over');
      const request = await ask(asker, recipient, 'is the release branch cut? (taken over)');
      const failed = await refusedBeforeWritten(recipient, await deliver(recipient));
      assert.ok(failed.retryAt, 'a turn that ran nothing armed no retry');
      assert.equal((await requestRow(request.id)).state, 'OPEN', 'closed although the retry would re-send it');
      await ownerTakesOver(recipient, 'never mind that, look at the failing build instead');
      await undeliveredOnce('refused before written', asker, recipient, request);
    }

    // Nor this one: the runner echoed it as it queued it for the CLI, and the write then failed — its
    // receipt after the echo says the engine was never handed it.
    {
      const asker = await session('Worker: asks one whose write fails after its echo');
      const recipient = await session('Coordinator: the write to its CLI fails after the echo');
      const request = await ask(asker, recipient, 'and is the tag pushed? (taken over)');
      const handed = await deliver(recipient);
      await say(recipient, handed.turnId, RunEventType.USER, { text: handed.content, delivery: 'enqueued' });
      await say(recipient, handed.turnId, RunEventType.USER_DELIVERY, {
        turnId: handed.turnId, delivery: 'failed', reason: 'write |1: broken pipe', retryable: true,
      });
      await api.turnComplete({ id: runnerId } as never, recipient, {
        turnId: handed.turnId, status: SharedRunStatus.FAILED, subtype: 'delivery_failed',
        numTurns: 0, costUsd: 0, result: 'message not delivered to the engine: write |1: broken pipe',
      } as never);
      assert.ok((await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).retryAt);
      assert.equal((await requestRow(request.id)).state, 'OPEN', 'closed although the retry would re-send it');
      await ownerTakesOver(recipient, 'leave the tag, check the changelog');
      await undeliveredOnce('written and refused', asker, recipient, request);
    }

    // The engine was handed this one: the runner echoed it, and the engine then never started a turn. It
    // was read, so it is judged as read — when the owner's turn settles, with nothing left to wake the
    // session, NO_REPLY — and not left to its deadline.
    {
      const asker = await session('Worker: asks one that read it, failed, and was taken over');
      const recipient = await session('Coordinator: read it, its engine never came up, its owner takes over');
      const request = await ask(asker, recipient, 'which migration number is free? (taken over)');
      const failed = await engineNeverCameUp(recipient, await deliver(recipient));
      assert.ok(failed.retryAt, 'a turn that ran nothing armed no retry');
      assert.equal((await requestRow(request.id)).state, 'OPEN');
      await ownerTakesOver(recipient, 'skip that, just rebase the branch');
      assert.equal((await requestRow(request.id)).state, 'OPEN', 'closed UNDELIVERED although an engine was handed it');
      await ownersTurnSettles(recipient, 'rebased onto main');
      const judged = await requestRow(request.id);
      assert.equal(judged.state, 'NO_REPLY', 'a request an engine read was left OPEN until its deadline');
      assert.equal(judged.excerpt, 'rebased onto main');
      // Handed back by the turn that settled, as every NO_REPLY is — and only by it.
      assert.ok(!(await worker.drain()).handedOff.includes(request.id), 'handed back twice');
      const told = await deliver(asker);
      assert.equal(blocksFor(told.content, request.id), 1);
      assert.match(told.content, /outcome="NO_REPLY"/);
    }
  });

  await t.test('a failed run whose retry is turned off or given up has ended: what was kept for the re-send is RECIPIENT_ENDED at once, and said once (§8 criterion 26, §4)', async () => {
    /** Claude refused the request before writing it: FAILED, a retry armed, the request kept for it. */
    async function keptForTheRetry(label: string) {
      const asker = await session(`Worker: asks one whose retry ends (${label})`);
      const recipient = await session(`Coordinator: its retry ends (${label})`);
      const request = await ask(asker, recipient, `still on for the release? (${label})`);
      const failed = await refusedBeforeWritten(recipient, await deliver(recipient));
      assert.ok(failed.retryAt, `${label}: a turn that ran nothing armed no retry`);
      assert.equal((await requestRow(request.id)).state, 'OPEN', `${label}: closed although the retry would re-send it`);
      return { asker, recipient, request };
    }
    /** The run's end closes it then and there — §4: the end, not the undelivered turn — and it is said once. */
    async function endedOnce(label: string, kept: { asker: string; recipient: string; request: { id: string } }) {
      const row = await requestRow(kept.request.id);
      assert.equal(row.state, 'RECIPIENT_ENDED', `${label}: not closed as the run's end`);
      assert.match(String(row.closeReason), /^FAILED/);
      assert.ok(row.replyBy.getTime() - row.closedAt!.getTime() > HOUR, `${label}: closed by its deadline, not by the end`);
      assert.ok((await worker.drain()).handedOff.includes(kept.request.id), `${label}: the worker did not hand it back`);
      assert.ok(!(await worker.drain()).handedOff.includes(kept.request.id), `${label}: handed back twice`);
      const [turn, ...others] = await replyTurnsOf(kept.asker);
      assert.ok(turn, `${label}: no reply turn was queued`);
      assert.equal(others.length, 0, `${label}: told twice`);
      const told = await deliver(kept.asker);
      assert.equal(told.turnId, turn.id);
      assert.equal(blocksFor(told.content, kept.request.id), 1, `${label}: not said once`);
      assert.match(told.content, /outcome="RECIPIENT_ENDED"/);
      // The owner takes the recipient up again afterwards: nothing about the request is said again.
      await sessions.resume(ownerId, kept.recipient, { clientTurnId: randomUUID(), content: `start over (${label})` });
      assert.equal((await requestRow(kept.request.id)).state, 'RECIPIENT_ENDED');
      assert.ok(!(await worker.drain()).handedOff.includes(kept.request.id), `${label}: handed back again`);
      assert.equal((await replyTurnsOf(kept.asker)).length, 1, `${label}: told twice`);
    }

    // The owner turns the retry off.
    {
      const kept = await keptForTheRetry('turned off');
      await sessions.cancelAutoRetry(ownerId, kept.recipient);
      await endedOnce('turned off', kept);
    }
    // The sweep gives the retry up: every attempt is spent. The oldest due by far, so this sweep reaches it.
    {
      const kept = await keptForTheRetry('given up');
      await prisma.session.update({
        where: { id: kept.recipient },
        data: { retryAttempts: BACKOFF_MS.length, retryAt: new Date(Date.now() - 24 * HOUR) },
      });
      await heartbeat();
      await new AutoRetryService(db, sessions, realtime as never).sweep();
      const after = await prisma.session.findUniqueOrThrow({ where: { id: kept.recipient } });
      assert.equal(after.status, RunStatus.FAILED);
      assert.equal(after.retryAt, null, 'the sweep did not give the retry up');
      assert.deepEqual(await resentOn(kept.recipient), [], 'the sweep re-sent it anyway');
      await endedOnce('given up', kept);
    }
  });

  await t.test('a run that ends with its runner holding a message it never echoed: the retry re-sends that message with its request, and one it cannot find is UNDELIVERED at once (§8 criterion 27)', async () => {
    // A machine of its own, so that its silence reaps none of this file's other sessions.
    const lostRunnerId = randomUUID();
    const lostWorkspaceId = randomUUID();
    await prisma.runner.create({
      data: {
        id: lostRunnerId, ownerId, name: 'the machine that goes away', tokenHash: sha256(`token-${lostRunnerId}`),
        status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
      },
    });
    await prisma.workspace.create({ data: { id: lostWorkspaceId, ownerId, runnerId: lostRunnerId, name: 'orbit-lost', enabled: true } });
    const lostHeartbeat = (at = new Date()) =>
      prisma.runner.update({ where: { id: lostRunnerId }, data: { lastHeartbeatAt: at } });
    const reaper = new ReaperService(db, realtime as never);
    const reap = async () => {
      // The machine stops answering; this file's own keeps beating, so only this machine's run is reaped.
      await lostHeartbeat(new Date(Date.now() - 10 * 60_000));
      await heartbeat();
      await (reaper as unknown as { sweep(): Promise<void> }).sweep();
    };
    const retrier = new AutoRetryService(db, sessions, realtime as never);
    /** What a runner writes under a turn once it points its output at it, before it echoes it (runner-go
     *  session.go and codex_appserver.go): a stderr line, and the engine refusing the turn. */
    const stderr = { type: RunEventType.SYSTEM, payload: { stderr: 'warning: falling back to the bundled ripgrep\n' } };
    const refusal = { type: RunEventType.ERROR, payload: { message: 'codex app-server already has an active turn' } };

    /**
     * A recipient on that machine that has answered the owner once, and is then asked `question`. The
     * runner takes the turn, files `before` under it, and the run ends with the turn still in flight —
     * `reaped` (the machine goes silent, the reaper reaps the run as 'runner offline') or `finalized` (the
     * runner finalizes it FAILED on a spent quota) — before the runner echoes it. A retry is armed either way.
     */
    async function heldWhenTheRunEnded(
      label: string,
      question: string,
      { before = [], ending = 'reaped' }: {
        before?: Array<{ type: RunEventType; payload: Record<string, unknown> }>;
        ending?: 'reaped' | 'finalized';
      } = {},
    ) {
      const asker = await session(`Worker: asks one whose runner goes away (${label})`);
      const recipient = await session(`Coordinator: its run ends with the question in flight (${label})`, {
        workspaceId: lostWorkspaceId, assignedRunnerId: lostRunnerId,
      });
      await lostHeartbeat();
      await sessions.createTurn(ownerId, recipient, {
        clientTurnId: randomUUID(), content: `the owner’s earlier question (${label})`,
      });
      const first = await deliver(recipient, lostRunnerId);
      await say(recipient, first.turnId, RunEventType.USER, { text: first.content }, lostRunnerId);
      await finish(recipient, first.turnId, `the earlier answer (${label})`, lostRunnerId);

      const request = await ask(asker, recipient, question);
      const taken = await deliver(recipient, lostRunnerId);
      assert.equal(taken.turnId, request.turnId);
      for (const event of before) await say(recipient, taken.turnId, event.type, event.payload, lostRunnerId);
      if (ending === 'reaped') {
        await reap();
      } else {
        await api.finalize({ id: lostRunnerId } as never, recipient, { status: 'FAILED', error: SESSION_LIMIT } as never);
      }
      const ended = await prisma.session.findUniqueOrThrow({ where: { id: recipient } });
      assert.equal(ended.status, RunStatus.FAILED, `${label}: the run did not end`);
      if (ending === 'reaped') assert.equal(ended.error, 'runner offline');
      assert.ok(ended.retryAt, `${label}: no retry was armed`);
      const held = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: taken.turnId } });
      assert.equal(held.status, 'ANSWERED');
      assert.ok(held.deliveredAt, `${label}: the claim left no stamp`);
      assert.equal(await prisma.runEvent.count({ where: { sessionId: recipient, turnId: taken.turnId } }), before.length,
        `${label}: the fixture recorded more of the message than it says`);
      return { asker, recipient, request };
    }

    /** The machine comes back and the retry comes due: it re-sends `question` with its request, asked and
     *  judged on the turn it rides now — not the owner's earlier, answered question. */
    async function resentWithItsRequest(
      label: string,
      held: { asker: string; recipient: string; request: { id: string; requestId: string } },
      question: string,
    ) {
      const { asker, recipient, request } = held;
      assert.equal((await requestRow(request.id)).state, 'OPEN', `${label}: closed although the retry re-sends it`);
      // The failure card promises what the sweep is about to do.
      const card = await retrier.retryMessage(ownerId, recipient);
      assert.equal(card.text, question, `${label}: the failure card offers the message before the one the run ended under`);
      assert.equal(card.sessionMessage?.requestId, request.requestId);

      await lostHeartbeat();
      await retryComesDue(recipient, retrier);
      const [resent, ...more] = await resentOn(recipient);
      assert.ok(resent, `${label}: the sweep re-sent nothing`);
      assert.equal(more.length, 0, `${label}: the sweep re-sent twice`);
      assert.equal(resent.content, question,
        `${label}: the sweep re-sent the message before the one the run ended under — an answered question, asked again`);
      assert.equal(resent.senderSessionId, asker, `${label}: the re-send dropped its sender`);
      const moved = await requestRow(request.id);
      assert.equal(moved.turnId, resent.id, `${label}: the request stayed on the turn the run ended under`);
      assert.equal(moved.state, 'OPEN');

      const again = await deliver(recipient, lostRunnerId);
      assert.equal(again.turnId, resent.id);
      assert.match(again.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`));
      assert.match(again.content, /对方在等你回复/);
      await prisma.session.update({ where: { id: recipient }, data: { inboxLeaseOwner: null } });
      await say(recipient, again.turnId, RunEventType.USER, { text: again.content }, lostRunnerId);
      await finish(recipient, again.turnId, `looking into it now (${label})`, lostRunnerId);
      const judged = await requestRow(request.id);
      assert.equal(judged.state, 'NO_REPLY');
      assert.equal(judged.excerpt, `looking into it now (${label})`, `${label}: judged against words about something else`);
    }

    /** Nothing the retry reads finds the turn: its request is UNDELIVERED as the run ends — not left OPEN to
     *  be judged NO_REPLY against the words of whatever the retry re-sends instead — and said once. */
    async function undeliveredAsTheRunEnds(label: string, asker: string, request: { id: string }) {
      const row = await requestRow(request.id);
      assert.equal(row.state, 'UNDELIVERED', `${label}: left OPEN on a turn the retry will not re-send`);
      assert.equal(row.closeReason, 'LOST_IN_FLIGHT');
      assert.equal(row.excerpt, null);
      assert.ok((await worker.drain()).handedOff.includes(request.id), `${label}: the worker did not hand it back`);
      assert.ok(!(await worker.drain()).handedOff.includes(request.id), `${label}: handed back twice`);
      const told = await deliver(asker);
      assert.equal(blocksFor(told.content, request.id), 1, `${label}: the asker was not told once`);
      assert.match(told.content, /outcome="UNDELIVERED"/);
      assert.match(told.content, /找不回这一轮/);
    }

    // Reaped, with a stderr line and the engine refusing the turn filed under it before any echo.
    {
      const question = 'is the release branch cut? (reaped)';
      const held = await heldWhenTheRunEnded('reaped', question, { before: [stderr, refusal] });
      await resentWithItsRequest('reaped', held, question);
    }
    // Finalized by its runner on a spent quota, with a stderr line under it.
    {
      const question = 'is the release branch cut? (finalized)';
      const held = await heldWhenTheRunEnded('finalized', question, { before: [stderr], ending: 'finalized' });
      await resentWithItsRequest('finalized', held, question);
    }
    // The engine had replied to it, and no echo or receipt says so: it is not a message the runner went away
    // with before recording it, and nothing else the retry reads names it.
    {
      const { asker, request } = await heldWhenTheRunEnded('replied, reaped', 'and is the tag pushed? (reaped)', {
        before: [stderr, { type: RunEventType.ASSISTANT, payload: { text: 'checking the tags…' } }],
      });
      await undeliveredAsTheRunEnds('replied, reaped', asker, request);
    }
    {
      const { asker, request } = await heldWhenTheRunEnded('replied, finalized', 'and is the tag pushed? (finalized)', {
        before: [{ type: RunEventType.ASSISTANT, payload: { text: 'checking the tags…' } }],
        ending: 'finalized',
      });
      await undeliveredAsTheRunEnds('replied, finalized', asker, request);
    }

    // The owner sends a message of their own instead: the lost words will never be re-sent, and no engine
    // read them — UNDELIVERED at once, not NO_REPLY with the words of the owner's turn.
    {
      const { asker, recipient, request } = await heldWhenTheRunEnded('taken over', 'and the changelog? (taken over)', {
        before: [stderr],
      });
      await lostHeartbeat();
      await sessions.resume(ownerId, recipient, { clientTurnId: randomUUID(), content: 'forget it, rebase onto main' });
      const row = await requestRow(request.id);
      assert.equal(row.state, 'UNDELIVERED', 'left OPEN on a turn that will never be re-sent');
      assert.equal(row.closeReason, 'NOT_RESENT');
      const own = await deliver(recipient, lostRunnerId);
      await prisma.session.update({ where: { id: recipient }, data: { inboxLeaseOwner: null } });
      await say(recipient, own.turnId, RunEventType.USER, { text: own.content }, lostRunnerId);
      await finish(recipient, own.turnId, 'rebased onto main', lostRunnerId);
      const after = await requestRow(request.id);
      assert.equal(after.state, 'UNDELIVERED', 'judged NO_REPLY by the owner’s turn');
      assert.equal(after.excerpt, null, 'given the words of the owner’s turn');
      assert.ok((await worker.drain()).handedOff.includes(request.id), 'the worker did not hand it back');
      const told = await deliver(asker);
      assert.equal(blocksFor(told.content, request.id), 1, 'the asker was not told once');
      assert.match(told.content, /outcome="UNDELIVERED"/);
      assert.deepEqual(await resentOn(recipient), [], 'the lost words were re-sent after all');
    }

    // The owner revives it with a shell command instead: the shell is the newer turn the runner takes, so the
    // message the earlier run ended under is no longer the last one — and when the shell's own run is lost
    // too, the failure card does not offer the message the owner moved on from.
    {
      const question = 'and the release notes? (a shell after it)';
      const { recipient, request } = await heldWhenTheRunEnded('a shell after it', question, { before: [stderr] });
      await lostHeartbeat();
      await sessions.resume(ownerId, recipient, { clientTurnId: randomUUID(), content: 'git status', kind: 'shell' });
      assert.equal((await requestRow(request.id)).state, 'UNDELIVERED', 'the shell took the retry’s place and left the request OPEN');
      await claimSession(recipient);
      const handed = await (api as unknown as {
        dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<Record<string, unknown> | null>;
      }).dequeueTurn.call(api, recipient, lostRunnerId, null);
      assert.equal((await prisma.conversationTurn.findUniqueOrThrow({ where: { id: String(handed?.turnId) } })).kind, 'shell');
      await reap();
      assert.ok((await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).retryAt);
      const card = await retrier.retryMessage(ownerId, recipient);
      assert.notEqual(card.text, question, 'the message the owner moved on from is offered again, as if it were the last');
    }
  });

  await t.test('what a run’s end keeps for the retry is what the retry re-sends: a message echoed and put back, and a steer put back unread (§8 criteria 18, 26, 27)', async () => {
    // A message the runner echoed and put back in the queue — its engine never came up — then drained by the
    // runner finalizing the run: the retry finds it by its echo and re-sends it, so its request is kept for
    // that re-send and moves with it, rather than closed DRAINED and re-sent all the same.
    {
      const asker = await session('Worker: asks one whose engine never comes up');
      const recipient = await session('Coordinator: its engine never comes up, and its runner finalizes the run');
      await sessions.createTurn(ownerId, recipient, { clientTurnId: randomUUID(), content: 'the owner’s earlier question (put back)' });
      const first = await deliver(recipient);
      await say(recipient, first.turnId, RunEventType.USER, { text: first.content });
      await finish(recipient, first.turnId, 'the earlier answer (put back)');
      const request = await ask(asker, recipient, 'which migration number is free? (put back)');
      const handed = await deliver(recipient);
      await say(recipient, handed.turnId, RunEventType.USER, { text: handed.content });
      await api.turnComplete({ id: runnerId } as never, recipient, {
        turnId: handed.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 0, costUsd: 0,
      } as never);
      const putBack = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: handed.turnId } });
      assert.equal(putBack.status, 'PENDING', 'the turn that produced nothing was not put back in the queue');
      assert.ok((await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).retryAt, 'no retry was armed');
      await api.finalize({ id: runnerId } as never, recipient, { status: 'FAILED', error: 'the engine exited before its first turn' } as never);
      assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: recipient } })).status, RunStatus.FAILED);
      assert.equal((await requestRow(request.id)).state, 'OPEN', 'closed DRAINED although the retry re-sends it');

      await retryComesDue(recipient);
      const [resent, ...more] = await resentOn(recipient);
      assert.ok(resent, 'the sweep re-sent nothing');
      assert.equal(more.length, 0);
      assert.equal(resent.content, 'which migration number is free? (put back)');
      assert.equal((await requestRow(request.id)).turnId, resent.id, 'the request stayed on the turn the run ended with');
      const again = await deliver(recipient);
      assert.match(again.content, new RegExp(`request-id="${uuidToBase62(request.id)}"`));
    }

    // A steer the runner echoed and then put back unread — its engine was fenced before it read the frame —
    // runs as a message of its own; the run ends with it in flight, and the owner takes over from the retry.
    // Its echo is not the engine reading it: the receipt after it says so, and it is UNDELIVERED — not left
    // OPEN to be judged NO_REPLY as a request read and left unanswered.
    {
      const asker = await session('Worker: steers a request that comes back unread');
      const recipient = await session('Coordinator: its steer comes back unread, and its owner takes over');
      const running = await busy(recipient);
      await say(recipient, running, RunEventType.USER, { text: 'the owner\'s own task' });
      const request = await ask(asker, recipient, 'quick one: which port? (put back unread)');
      const steer = await deliverSteer(recipient);
      assert.equal(steer.turnId, request.turnId);
      await say(recipient, steer.turnId, RunEventType.USER, { text: steer.content, steer: true, delivery: 'enqueued' });
      await say(recipient, running, RunEventType.USER_DELIVERY, { turnId: steer.turnId, delivery: 'requeued' });
      await requeueSteer(recipient, steer.turnId);
      await finish(recipient, running, 'done with the task');
      const asMessage = await deliver(recipient);
      assert.equal(asMessage.turnId, steer.turnId);
      await api.finalize({ id: runnerId } as never, recipient, { status: 'FAILED', error: SESSION_LIMIT } as never);
      const failed = await prisma.session.findUniqueOrThrow({ where: { id: recipient } });
      assert.equal(failed.status, RunStatus.FAILED);
      assert.ok(failed.retryAt, 'no retry was armed');
      assert.equal((await requestRow(request.id)).state, 'OPEN', 'closed although the retry would re-send it');

      await heartbeat();
      await sessions.resume(ownerId, recipient, { clientTurnId: randomUUID(), content: 'never mind, check the logs instead' });
      const row = await requestRow(request.id);
      assert.equal(row.state, 'UNDELIVERED', 'an echo put back unread was taken for the engine reading it');
      assert.equal(row.closeReason, 'NOT_RESENT');
      const own = await deliver(recipient);
      await prisma.session.update({ where: { id: recipient }, data: { inboxLeaseOwner: null } });
      await say(recipient, own.turnId, RunEventType.USER, { text: own.content });
      await finish(recipient, own.turnId, 'the logs are clean');
      assert.equal((await requestRow(request.id)).state, 'UNDELIVERED');
      assert.ok((await worker.drain()).handedOff.includes(request.id), 'the worker did not hand it back');
    }
  });
});
