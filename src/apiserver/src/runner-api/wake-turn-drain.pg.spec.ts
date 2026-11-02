/**
 * A wakeup filed onto a queued `bg-wake:` turn that its session's end then drains unrun is settled, not left
 * DELIVERED onto a turn no engine was handed (runner-api/wake-turn-withdraw.ts; docs/long-running-loop-contract.md
 * §1.2, §1.6, §3, §4; project 34pUaJboWdDFzjftkEso8, task F).
 *
 * A wakeup that comes due while its session still reads RUNNING — its runner just died and the reaper has not
 * acted yet, or a long turn is running — is filed onto a queued wake turn and settled DELIVERED at once. When that
 * turn is then answered with the rest of the queue as the run ends, the wakeup has to be settled with it: a
 * one-shot wakeup goes back to waiting for an armed retry, or is dropped (and its owner told when the session
 * FAILED), and a loop's tick is dropped and taken out of the loop's runs. Before this, all of them stayed
 * DELIVERED: the one-shot wakeup was never filed again and nobody was told, and the tick went on counting as a run
 * (task E measured it: loop B's tick 9, turn seq 10 answered with no `delivered_at`, and the next block said 34
 * ticks missed where 35 had not run — docs/evidence/long-running-loops/ticks-b.md).
 *
 * Against real PostgreSQL, with the production code throughout: every drain the census found goes through its
 * real door — the reaper's sweep (ReaperService.tick → forceFinalize), a turn that fails its session
 * (RunnerApiController.turnComplete), the runner's finalize (RunnerApiController.finalize) and the owner's End
 * (SessionsService.end → transitionEnd, both of its branches) — and so do the interrupt and the withdrawal, whose
 * queued ticks now leave their loop's runs too. Wakeups are filed by the scheduled-wakeup worker, claims are the
 * queue's own, a recovery is the auto-retry sweep's, revives are the worker's, and session_get is read through the
 * runner's session door. The pushes go to a PushService double, which keeps every notifyLoopMissed.
 *
 *   1. Reap, retry armed: the one-shot wakeup goes back to PENDING — as a copy of itself, because the drained turn
 *      keeps its turn key — the worker holds it while the retry is armed, and once the auto-retry has brought the
 *      session back it is filed and delivered in a turn.
 *   2. Reap, no retry armed (a task's run, which its scheduler re-runs instead): DROPPED, one wakeup-dropped push;
 *      and a background job's wake on the same turn is deleted with it, as a withdrawal deletes it.
 *   3. Reap, retry armed, a newer one-shot wakeup already waiting: the drained one is SUPERSEDED, the newer one is
 *      left exactly as it was.
 *   4. A session that ended: DROPPED and nobody is told — an End the runner never honored (reaped CANCELLED), the
 *      owner's End of a running session and of a queued one, the runner's finalize SUCCEEDED.
 *   5. Task E's loop B: ticks 1–8 run, tick 9 is filed behind tick 8's turn when the runner dies, the reap drops
 *      it, and when tick 44 runs its block says 35 ticks missed and session_get reads 9 fired, 35 missed.
 *   6. A tick already handed to the engine ran: the reap leaves it DELIVERED and counted, and the two ticks queued
 *      behind it on one turn move one run, not two, to missed.
 *   7. A turn that fails its session (turn-complete): the one-shot wakeup behind it is dropped and its owner told
 *      through the runner door's PushService, and the tick beside it is dropped and uncounted.
 *   8. The runner's finalize FAILED, no retry armed: dropped and told, as the reaper does.
 *   9. An interrupt and a withdrawal leave the tick they take CANCELLED, as before, and take it out of the runs.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/wake-turn-drain.pg.spec.ts
 *
 * Not destructive: every row is made by the run, under owners it generates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { AgentProvider, RunEventType, SessionEndReason } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import type { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { ReaperService } from '../realtime/reaper.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { SessionsService } from '../sessions/sessions.service';
import { BackgroundWakeDto } from './background-job-wake';
import { RunnerApiController } from './runner-api.controller';
import { RunnerSessionsController } from './runner-sessions.controller';
import { lastLoopRun, ScheduledWakeupDto } from './scheduled-wakeup';
import { ScheduledWakeupWorker } from './scheduled-wakeup.worker';

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

/** What a door asked PushService to send. */
type WakeupMissedPush = Parameters<PushService['notifyLoopMissed']>[0];

/** A PushService double: it keeps every notifyLoopMissed it is asked for, and answers every other send with nothing. */
function recordingPush(): { push: PushService; rang: WakeupMissedPush[] } {
  const rang: WakeupMissedPush[] = [];
  const own: Record<string, unknown> = {
    notifyLoopMissed: async (input: WakeupMissedPush) => {
      rang.push(input);
    },
  };
  const push = new Proxy(own, {
    get: (target, key) => (key === 'then' ? undefined : key in target ? target[key as string] : async () => undefined),
  }) as unknown as PushService;
  return { push, rang };
}

interface LoopRow {
  id: string;
  state: string;
  ticksFired: number;
  ticksMissed: number;
}

interface WakeupRow {
  id: string;
  state: string;
  dueAt: Date;
  clientTurnId: string | null;
  settledAt: Date | null;
  reason: string;
  prompt: string | null;
  delaySeconds: number;
  createdAt: Date;
}

test('a wakeup filed onto a queued turn that its session\'s end drains is settled with it, never left DELIVERED', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, quiet);
  const runnerPush = recordingPush();
  const runnerApi = new RunnerApiController(
    prisma,
    queue,
    quiet,
    runnerPush.push,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    sessions,
  );
  const worker = new ScheduledWakeupWorker(prisma, sessions);
  const claims = new QueueService(prisma, quiet, new ProviderPlanUsageService(quiet));
  const autoRetry = new AutoRetryService(prisma, sessions, quiet);
  /** The production reaper, built as RealtimeModule builds it but for a PushService double that keeps its pushes. */
  const reaperWithPush = (): { reaper: ReaperService; rang: WakeupMissedPush[] } => {
    const { push, rang } = recordingPush();
    return { reaper: new ReaperService(prisma, quiet, undefined, undefined, undefined, push), rang };
  };

  // Runners heartbeat for as long as the file runs, as real ones would, until a case takes one away.
  const runners: string[] = [];
  const beat = () =>
    sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = ANY($1::uuid[])`, [runners])
      .catch(() => undefined);
  const heartbeat = setInterval(() => void beat(), 5_000);
  t.after(async () => {
    clearInterval(heartbeat);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type Machine = { ownerId: string; runnerId: string; workspaceId: string; runner: { id: string; ownerId: string } };
  /** An owner with one runner and one workspace on it, its own: a claim on it can take nothing else's session. */
  async function machine(label: string): Promise<Machine> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@wake-turn-drain.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/tmp/wake-turn-drain' },
    });
    runners.push(runnerId);
    return { ownerId, runnerId, workspaceId, runner: { id: runnerId, ownerId } };
  }

  /** The runner dies under its run: no more heartbeats, and the run it claimed was claimed long enough ago that the
   *  reaper reads its silence as death (ReaperService `runnerLooksOffline`). */
  async function runnerDies(m: Machine, sessionId: string): Promise<void> {
    runners.splice(runners.indexOf(m.runnerId), 1);
    await sql.query(
      `UPDATE "runner" SET "status" = 'OFFLINE', "last_heartbeat_at" = clock_timestamp() - interval '10 minutes' WHERE "id" = $1::uuid`,
      [m.runnerId],
    );
    await sql.query(
      `UPDATE "session" SET "run_claimed_at" = clock_timestamp() - interval '10 minutes'
        WHERE "id" = $1::uuid AND "run_claimed_at" IS NOT NULL`,
      [sessionId],
    );
  }
  /** The runner is back, heartbeating again. */
  async function goOnline(m: Machine): Promise<void> {
    await sql.query(`UPDATE "runner" SET "status" = 'ONLINE', "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [m.runnerId]);
    runners.push(m.runnerId);
  }

  /** A session that has run a turn and is parked between turns, unless `data` says otherwise. */
  async function session(m: Machine, data: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId: m.ownerId,
        creatorId: m.ownerId,
        workspaceId: m.workspaceId,
        assignedRunnerId: m.runnerId,
        title: 'a migration that runs for days',
        prompt: 'move the archive, a batch at a time',
        provider: 'claude',
        providerBuiltin: true,
        engine: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: false,
        startedAt: new Date(),
        numTurns: 1,
        runtimeSessionId: randomUUID(),
        ...data,
      },
    });
    await db.conversationTurn.create({
      data: {
        sessionId: id,
        seq: 1,
        clientTurnId: SessionsService.initialTurnClientId(id),
        kind: 'message',
        content: 'move the archive, a batch at a time',
        status: 'ANSWERED',
        answeredAt: new Date(),
      },
    });
    return id;
  }

  /** A session working on a turn its runner was handed — the long turn a wakeup comes due behind. */
  async function working(m: Machine, data: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<{ id: string; turnId: string }> {
    const id = await session(m, { status: RunStatus.RUNNING, ...data });
    const turn = await db.conversationTurn.create({
      data: {
        sessionId: id, seq: 2, clientTurnId: randomUUID(), kind: 'message', content: 'migrate batch 7',
        status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    return { id, turnId: turn.id };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedule = (m: Machine, sessionId: string, body: Record<string, unknown>): Promise<any> =>
    runnerApi.scheduledWakeup(m.runner as never, sessionId, Object.assign(new ScheduledWakeupDto(), body));

  /** What session_get answers with about the session's wakeups, through the runner's session door, as JSON. */
  const sessionDoor = new RunnerSessionsController(sessions, {} as never, {} as never, {} as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wakeupsOf = async (m: Machine, sessionId: string): Promise<any> =>
    JSON.parse(JSON.stringify(await sessionDoor.getSession(m.runner as never, undefined, undefined, undefined, sessionId))).wakeups;

  const loopOf = async (sessionId: string): Promise<LoopRow> => {
    const loop = await db.sessionWakeupLoop.findFirstOrThrow({
      where: { sessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true, ticksFired: true, ticksMissed: true },
    });
    return loop;
  };
  const wakeupSelect = {
    id: true, state: true, dueAt: true, clientTurnId: true, settledAt: true, reason: true, prompt: true, delaySeconds: true, createdAt: true,
  } as const;
  const ticksOf = (loopId: string): Promise<WakeupRow[]> =>
    db.sessionScheduledWakeup.findMany({ where: { loopId }, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], select: wakeupSelect });
  const oneShotsOf = (sessionId: string): Promise<WakeupRow[]> =>
    db.sessionScheduledWakeup.findMany({ where: { sessionId, loopId: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: wakeupSelect });
  const oneShot = async (id: string): Promise<WakeupRow> =>
    db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id }, select: wakeupSelect });
  const pendingOf = async (loopId: string): Promise<WakeupRow> => {
    const waiting = (await ticksOf(loopId)).find((tick) => tick.state === 'PENDING');
    assert.ok(waiting, 'the loop has no tick waiting');
    return waiting;
  };
  const turnByKey = (sessionId: string, clientTurnId: string) =>
    db.conversationTurn.findUniqueOrThrow({ where: { sessionId_clientTurnId: { sessionId, clientTurnId } } });
  const sessionRow = (sessionId: string) => db.session.findUniqueOrThrow({ where: { id: sessionId } });

  /** Move the loop's whole timeline back so that the tick it has waiting came due a second ago. Returns that tick. */
  async function makeDue(loopId: string): Promise<WakeupRow> {
    const waiting = await pendingOf(loopId);
    const shiftMs = waiting.dueAt.getTime() - (Date.now() - 1_000);
    await sql.query(
      `UPDATE "session_scheduled_wakeup" SET "due_at" = "due_at" - $2::bigint * interval '1 millisecond' WHERE "loop_id" = $1::uuid`,
      [loopId, shiftMs],
    );
    await sql.query(
      `UPDATE "session_wakeup_loop"
          SET "first_due_at" = "first_due_at" - $2::bigint * interval '1 millisecond',
              "until_at" = "until_at" - $2::bigint * interval '1 millisecond'
        WHERE "id" = $1::uuid`,
      [loopId, shiftMs],
    );
    return (await ticksOf(loopId)).find((tick) => tick.id === waiting.id)!;
  }
  /** A one-shot wakeup the session asked for, due a moment ago, filed by the worker: DELIVERED onto a wake turn. */
  async function fileOneShot(m: Machine, sessionId: string, reason: string): Promise<WakeupRow> {
    const receipt = await schedule(m, sessionId, { delaySeconds: 60, reason });
    await sql.query(`UPDATE "session_scheduled_wakeup" SET "due_at" = clock_timestamp() - interval '2 seconds' WHERE "id" = $1::uuid`, [receipt.id]);
    assert.equal(await worker.deliver(receipt.id, sessionId, m.ownerId), 'DELIVERED', `the wakeup "${reason}" was not filed`);
    const filed = await oneShot(receipt.id);
    assert.equal(filed.state, 'DELIVERED');
    return filed;
  }

  /** What the runner is handed when it takes the session's next turn, as the inbox builds it. */
  async function handedOut(m: Machine, sessionId: string): Promise<{ turnId: string; content: string }> {
    const delivered = await (runnerApi as unknown as {
      dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: null) => Promise<{ turnId: string; content?: string } | null>;
    }).dequeueTurn(sessionId, m.runnerId, null);
    assert.ok(delivered?.turnId, 'the inbox handed out no turn');
    return { turnId: String(delivered.turnId), content: String(delivered.content ?? '') };
  }
  /** The runner's claim of a session queued for a turn — the queue's own — then the inbox. */
  async function claim(m: Machine, sessionId: string) {
    const claimed = await claims.claimSessionForRunner({ id: m.runnerId, supportedProviders: [AgentProvider.CLAUDE] }, 0, true);
    assert.equal(claimed?.sessionId, sessionId, 'the runner was offered another session, or none');
    return handedOut(m, sessionId);
  }
  /** The turn the runner took is over, and the session parked again. Only that turn: nothing queued is answered. */
  async function finishTurn(sessionId: string): Promise<void> {
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'ANSWERED', "answered_at" = clock_timestamp()
        WHERE "session_id" = $1::uuid AND "status" = 'IN_FLIGHT'`,
      [sessionId],
    );
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1::uuid`, [sessionId]);
  }
  /** The engine replied to the turn it is running, as the runner's events record it before turn-complete. */
  async function replied(sessionId: string, turnId: string): Promise<void> {
    const last = await db.runEvent.findFirst({ where: { sessionId }, orderBy: { seq: 'desc' }, select: { seq: true } });
    await db.runEvent.create({
      data: { sessionId, seq: (last?.seq ?? 0) + 1, type: RunEventType.ASSISTANT, turnId, payload: { text: 'batch 7 is half done' } },
    });
  }
  /** The auto-retry's own sweep, over this session's retry only. */
  async function retrySweepOf(sessionId: string): Promise<void> {
    await sql.query(`UPDATE "session" SET "retry_at" = NULL WHERE "retry_at" IS NOT NULL AND "id" <> $1::uuid`, [sessionId]);
    await autoRetry.sweep();
  }
  /** One pass of the worker over this session's due wakeups only. */
  async function drainOnly(sessionId: string) {
    await sql.query(
      `UPDATE "session_scheduled_wakeup" SET "due_at" = "due_at" + interval '1 day'
        WHERE "state" = 'PENDING' AND "session_id" <> $1::uuid`,
      [sessionId],
    );
    return worker.drain();
  }

  await t.test('reap with the retry armed: the one-shot wakeup goes back to waiting as a copy of itself, is held while the retry is armed, and is filed and delivered once the session is back', async () => {
    const m = await machine('held');
    const { id, turnId } = await working(m);
    const filed = await fileOneShot(m, id, 'check the deploy');
    const wakeTurn = await turnByKey(id, filed.clientTurnId!);
    assert.equal(wakeTurn.status, 'PENDING', 'the wakeup was not filed onto a queued turn behind the running one');
    const { reaper, rang } = reaperWithPush();

    await runnerDies(m, id);
    await reaper.tick();

    const reaped = await sessionRow(id);
    assert.equal(reaped.status, RunStatus.FAILED, 'the reaper did not finalize the run its runner died in');
    assert.ok(reaped.retryAt, 'the reap did not arm the retry this case is about');
    const drained = await turnByKey(id, wakeTurn.clientTurnId);
    assert.deepEqual([drained.status, drained.deliveredAt], ['ANSWERED', null], 'the wake turn was not drained unrun');
    // The wakeup waits again, as a copy of itself: its own row keeps the turn it was filed onto, which holds its
    // turn key for good, and says the copy replaced it.
    const [superseded, copy, ...more] = await oneShotsOf(id);
    assert.equal(more.length, 0, 'the drain left more than the wakeup and its copy');
    assert.deepEqual(
      [superseded.id, superseded.state, superseded.clientTurnId],
      [filed.id, 'SUPERSEDED', filed.clientTurnId],
      'the wakeup filed onto the drained turn was not replaced',
    );
    assert.ok(superseded.settledAt);
    assert.deepEqual(
      { ...copy, id: filed.id },
      { ...filed, state: 'PENDING', clientTurnId: null, settledAt: null },
      'the wakeup on the drained turn did not go back to waiting for the retry, as it was asked for',
    );
    assert.deepEqual(rang, [], 'a wakeup held for an armed retry was told as dropped');
    assert.deepEqual(await drainOnly(id), [], 'the worker took a wakeup held for an armed retry');
    assert.equal((await oneShot(copy.id)).state, 'PENDING');

    // The runner is back, and the auto-retry brings the session back: the wakeup is filed and delivered.
    await goOnline(m);
    await retrySweepOf(id);
    const back = await sessionRow(id);
    assert.equal(back.status, RunStatus.PENDING, 'the auto-retry did not bring the session back');
    assert.deepEqual(await drainOnly(id), ['DELIVERED'], 'the held wakeup was not filed once the session was back');
    const refiled = await oneShot(copy.id);
    assert.equal(refiled.state, 'DELIVERED', 'the worker answered DELIVERED and filed nothing');
    assert.notEqual(refiled.clientTurnId, null);
    let handed = await claim(m, id);
    while (handed.turnId !== (await turnByKey(id, refiled.clientTurnId!)).id) {
      // The retry's own re-send goes first; the runner finishes it and takes the next turn queued.
      await sql.query(`UPDATE "conversation_turn" SET "status" = 'ANSWERED', "answered_at" = clock_timestamp() WHERE "id" = $1::uuid`, [handed.turnId]);
      handed = await handedOut(m, id);
    }
    assert.ok(handed.content.includes('<scheduled-wakeup>'), handed.content);
    assert.ok(
      handed.content.includes(`${filed.createdAt.toISOString()} scheduled 60 seconds out, due ${filed.dueAt.toISOString()}`),
      `the delivered wakeup does not say when it was asked for and due, as the one the drain took away:\n${handed.content}`,
    );
    assert.ok(handed.content.includes('reason: check the deploy'), handed.content);
    assert.ok((await turnByKey(id, refiled.clientTurnId!)).deliveredAt, 'the turn the wakeup was filed onto was not handed to the engine');
    assert.deepEqual(rang, []);
  });

  await t.test('reap with no retry armed: the one-shot wakeup is DROPPED and its owner is told, once; a job\'s wake on the same turn is deleted', async () => {
    const m = await machine('dropped');
    // A task's run, which the task's scheduler runs again rather than the auto-retry: the reap arms nothing.
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId: m.ownerId, assigneeId: m.workspaceId, title: 'move the archive', creatorType: 'AGENT',
        creatorId: m.workspaceId, status: 'IN_PROGRESS', autoRunWhenReady: true, completionCriterion: 'EVIDENCE_JUDGMENT',
      } as never,
    });
    const { id } = await working(m, { taskId, startsTaskWork: true });
    const filed = await fileOneShot(m, id, 'check the deploy');
    // A background job's output wake, reported while the turn runs, joins the same queued wake turn.
    const jobWake = await runnerApi.backgroundWake(m.runner, id, Object.assign(new BackgroundWakeDto(), {
      wakeId: 'bgj_drain0000:output:1', jobId: 'bgj_drain0000', trigger: 'output', kind: 'job', command: 'tail -f build.log',
      status: 'running', outputPath: '/tmp/wake-turn-drain/bgj_drain0000.output', outputOffset: 0, outputSize: 12,
      outputExcerpt: 'building...',
    }));
    assert.equal(jobWake.outcome, 'MERGED', `the job's wake did not join the queued wake turn: ${JSON.stringify(jobWake)}`);
    assert.equal(await db.backgroundJobWake.count({ where: { sessionId: id, clientTurnId: filed.clientTurnId! } }), 1);
    const { reaper, rang } = reaperWithPush();

    await runnerDies(m, id);
    await reaper.tick();

    const reaped = await sessionRow(id);
    assert.deepEqual([reaped.status, reaped.retryAt], [RunStatus.FAILED, null], 'the reap armed a retry, or did not fail the run');
    const dropped = await oneShot(filed.id);
    assert.equal(dropped.state, 'DROPPED', 'the wakeup on the drained turn was not dropped');
    assert.equal(dropped.clientTurnId, filed.clientTurnId, 'the drop lost which turn the wakeup had been filed onto');
    assert.ok(dropped.settledAt, 'the drop does not say when');
    assert.deepEqual(rang, [{
      ownerId: m.ownerId,
      sessionId: id,
      title: 'a migration that runs for days',
      missed: { wakeupId: filed.id },
      reason: 'SESSION_FAILED',
    }], 'the owner was not told, once, that the wakeup was dropped with the FAILED session');
    assert.equal(
      await db.backgroundJobWake.count({ where: { sessionId: id } }),
      0,
      'the job\'s wake outlived the drained turn, under the key its next wake reuses',
    );

    // Another sweep, and the worker's own pass, say nothing more.
    await reaper.tick();
    assert.deepEqual(await drainOnly(id), []);
    assert.equal(rang.length, 1, 'one dropped wakeup was told twice');
  });

  await t.test('reap with the retry armed and a newer one-shot wakeup already waiting: the drained one is SUPERSEDED, the newer one left as it was', async () => {
    const m = await machine('superseded');
    const { id } = await working(m);
    const older = await fileOneShot(m, id, 'check the deploy');
    // The agent, still working on its turn, asks for another wakeup: it waits; the one already filed is not replaced.
    const receipt = await schedule(m, id, { delaySeconds: 600, reason: 'check the deploy again' });
    assert.equal(receipt.replaced, false, 'a wakeup already filed onto a turn was replaced');
    const newer = await oneShot(receipt.id);
    assert.equal(newer.state, 'PENDING');
    const { reaper, rang } = reaperWithPush();

    await runnerDies(m, id);
    await reaper.tick();

    assert.ok((await sessionRow(id)).retryAt, 'the reap did not arm the retry this case is about');
    const superseded = await oneShot(older.id);
    assert.deepEqual(
      [superseded.state, superseded.clientTurnId],
      ['SUPERSEDED', older.clientTurnId],
      'the drained wakeup was not superseded by the newer one waiting',
    );
    assert.ok(superseded.settledAt);
    assert.deepEqual(await oneShot(newer.id), newer, 'the newer wakeup waiting was touched');
    assert.deepEqual((await oneShotsOf(id)).map((row) => row.state), ['SUPERSEDED', 'PENDING']);
    assert.deepEqual(rang, []);
  });

  await t.test('a session that ended: the one-shot wakeup is DROPPED and nobody is told — an End the runner never honored, the owner\'s End of a running and of a queued session, and the runner\'s finalize', async () => {
    const m = await machine('ended');
    const { reaper, rang } = reaperWithPush();
    runnerPush.rang.length = 0;
    const settled: Array<[string, string]> = [];

    // The owner ended the session, and its runner never honored it: the reaper finalizes the end CANCELLED.
    {
      const { id } = await working(m);
      const filed = await fileOneShot(m, id, 'unhonored end');
      await sql.query(
        `UPDATE "session" SET "end_reason" = $2, "cancel_requested_at" = clock_timestamp() - interval '3 minutes' WHERE "id" = $1::uuid`,
        [id, SessionEndReason.ENDED],
      );
      await reaper.tick();
      assert.equal((await sessionRow(id)).status, RunStatus.CANCELLED, 'the reaper did not finalize the unhonored end');
      settled.push(['an End the runner never honored', (await oneShot(filed.id)).state]);
    }
    // The owner's End of a session working on a turn: the queued messages are retired, an end turn queued.
    {
      const { id } = await working(m);
      const filed = await fileOneShot(m, id, 'running end');
      await sessions.end(m.ownerId, id);
      assert.ok((await sessionRow(id)).cancelRequestedAt, 'the End was not recorded');
      assert.equal((await turnByKey(id, filed.clientTurnId!)).status, 'ANSWERED', 'the End left the wake turn queued');
      settled.push(['the owner\'s End of a running session', (await oneShot(filed.id)).state]);
    }
    // The owner's End of a session still queued for its turn: CANCELLED at once, every turn drained.
    {
      const id = await session(m);
      const filed = await fileOneShot(m, id, 'queued end');
      assert.equal((await sessionRow(id)).status, RunStatus.PENDING, 'the wakeup did not queue the session');
      await sessions.end(m.ownerId, id);
      assert.equal((await sessionRow(id)).status, RunStatus.CANCELLED);
      settled.push(['the owner\'s End of a queued session', (await oneShot(filed.id)).state]);
    }
    // The runner finishes the run: SUCCEEDED.
    {
      const { id } = await working(m);
      const filed = await fileOneShot(m, id, 'finished');
      await runnerApi.finalize(m.runner as never, id, { status: RunStatus.SUCCEEDED, result: 'the archive is moved' } as never);
      assert.equal((await sessionRow(id)).status, RunStatus.SUCCEEDED, 'the runner\'s finalize did not end the run');
      settled.push(['the runner\'s finalize SUCCEEDED', (await oneShot(filed.id)).state]);
    }

    assert.deepEqual(settled, [
      ['an End the runner never honored', 'DROPPED'],
      ['the owner\'s End of a running session', 'DROPPED'],
      ['the owner\'s End of a queued session', 'DROPPED'],
      ['the runner\'s finalize SUCCEEDED', 'DROPPED'],
    ], 'a wakeup on a turn drained with a session that ended was not dropped');
    assert.deepEqual([rang, runnerPush.rang], [[], []], 'a wakeup dropped with a session that ended was told');
  });

  await t.test('task E\'s loop B: tick 9, filed behind the turn the runner died in, is dropped with the reap; tick 44 says 35 ticks missed and session_get reads 9 fired, 35 missed', async () => {
    const m = await machine('loop-b');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 60, prompt: 'a tick of loop B; answer in one line', reason: 'loop B' });
    const loop = await loopOf(id);
    const { reaper } = reaperWithPush();

    // Ticks 1–8 run, one turn each; the runner is still in tick 8's turn when tick 9 comes due.
    for (let n = 1; n <= 8; n += 1) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'DELIVERED', `tick ${n}`);
      await claim(m, id);
      if (n < 8) await finishTurn(id);
    }
    const tick9 = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(tick9.id), 'DELIVERED', 'tick 9');
    const [tick8, filed9] = (await ticksOf(loop.id)).slice(7, 9);
    const turn8 = await turnByKey(id, tick8.clientTurnId!);
    const turn10 = await turnByKey(id, filed9.clientTurnId!);
    assert.deepEqual([turn8.seq, turn8.status, turn10.seq, turn10.status], [9, 'IN_FLIGHT', 10, 'PENDING']);
    assert.deepEqual([(await loopOf(id)).ticksFired, (await loopOf(id)).ticksMissed], [9, 0]);

    // The runner is killed, and the reaper finalizes the run (21:19:07.704 in task E): turn 10 is answered unrun.
    await runnerDies(m, id);
    await reaper.tick();
    const reaped = await sessionRow(id);
    assert.equal(reaped.status, RunStatus.FAILED);
    assert.ok(reaped.retryAt, 'the reap did not arm the retry task E\'s loop B had');
    const answered10 = await turnByKey(id, filed9.clientTurnId!);
    assert.deepEqual([answered10.status, answered10.deliveredAt], ['ANSWERED', null]);
    const states = (await ticksOf(loop.id)).map((tick) => tick.state);
    assert.deepEqual(states.slice(0, 10), [...Array(8).fill('DELIVERED'), 'DROPPED', 'PENDING'], 'tick 9 is not dropped, or tick 8 was touched');
    let counted = await loopOf(id);
    assert.deepEqual([counted.ticksFired, counted.ticksMissed], [8, 1], 'tick 9 still counts as a run');
    let wakeups = await wakeupsOf(m, id);
    assert.deepEqual([wakeups.loop.ticksFired, wakeups.loop.ticksMissed], [8, 1]);
    assert.equal(wakeups.loop.lastFiredAt, (await turnByKey(id, tick8.clientTurnId!)).deliveredAt?.toISOString());

    // Ticks 10–38 come due while the retry waits for the runner: missed.
    for (let n = 10; n <= 38; n += 1) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'MISSED', `tick ${n}, while the retry is armed`);
    }
    // MAX_OFFLINE_WAIT_MS after the reap, the auto-retry gives up on the runner; ticks 39–43 cannot revive it.
    await sql.query(
      `UPDATE "session" SET "finished_at" = clock_timestamp() - interval '31 minutes', "retry_at" = clock_timestamp() - interval '1 second'
        WHERE "id" = $1::uuid`,
      [id],
    );
    await retrySweepOf(id);
    assert.deepEqual([(await sessionRow(id)).status, (await sessionRow(id)).retryAt], [RunStatus.FAILED, null], 'the auto-retry did not give up');
    for (let n = 39; n <= 43; n += 1) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'MISSED', `tick ${n}, whose revive the runner was not there for`);
    }

    // The runner is back: tick 44 revives the session and runs, and says what did not.
    await goOnline(m);
    const tick44 = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(tick44.id), 'REVIVED', 'tick 44');
    const { content } = await claim(m, id);
    assert.ok(content.includes('loop: tick 44, every 60 seconds until'), content);
    assert.ok(content.includes('35 ticks missed since the last run'), `ticks 9 to 43 did not run, 35 of them:\n${content}`);
    counted = await loopOf(id);
    assert.deepEqual([counted.ticksFired, counted.ticksMissed], [9, 35], 'the loop\'s counts are not what ran: ticks 1–8 and 44');
    wakeups = await wakeupsOf(m, id);
    assert.deepEqual([wakeups.loop.ticksFired, wakeups.loop.ticksMissed], [9, 35], 'session_get does not read what ran');
    const ran44 = await turnByKey(id, (await ticksOf(loop.id)).find((tick) => tick.id === tick44.id)!.clientTurnId!);
    assert.equal(wakeups.loop.lastFiredAt, ran44.deliveredAt?.toISOString());
    assert.equal(wakeups.loop.lastFiredAt, (await lastLoopRun(prisma, loop.id))?.deliveredAt.toISOString());
  });

  await t.test('a tick already handed to the engine ran: the reap leaves it DELIVERED and counted, and the ticks queued behind it on one turn move one run, not two, to missed', async () => {
    const m = await machine('handed');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 120, prompt: 'check the queue depth' });
    const loop = await loopOf(id);
    const { reaper } = reaperWithPush();
    const first = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(first.id), 'DELIVERED');
    await claim(m, id);
    // Ticks 2 and 3 come due while tick 1's turn runs: one queued turn carries both, and a one-shot wakeup beside them.
    for (const n of [2, 3]) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'DELIVERED', `tick ${n}`);
    }
    const once = await fileOneShot(m, id, 'check the deploy');
    const [ran, second, third] = await ticksOf(loop.id);
    assert.equal(second.clientTurnId, third.clientTurnId, 'ticks 2 and 3 are not on one turn');
    assert.equal(once.clientTurnId, second.clientTurnId, 'the one-shot wakeup is not on the ticks\' turn');
    assert.deepEqual([(await loopOf(id)).ticksFired, (await loopOf(id)).ticksMissed], [2, 1]);
    const handedTurn = await turnByKey(id, ran.clientTurnId!);
    assert.equal(handedTurn.status, 'IN_FLIGHT');

    await runnerDies(m, id);
    await reaper.tick();

    const [ranAfter, secondAfter, thirdAfter] = await ticksOf(loop.id);
    assert.deepEqual(ranAfter, ran, 'the tick the engine was handed was settled as if it had not run');
    const drainedHanded = await turnByKey(id, ran.clientTurnId!);
    assert.equal(drainedHanded.status, 'ANSWERED');
    assert.equal(drainedHanded.deliveredAt?.getTime(), handedTurn.deliveredAt?.getTime(), 'the drain cleared when the turn was handed out');
    assert.deepEqual([secondAfter.state, thirdAfter.state], ['DROPPED', 'DROPPED'], 'the ticks queued behind it were not dropped');
    const counted = await loopOf(id);
    assert.deepEqual([counted.ticksFired, counted.ticksMissed], [1, 2], 'ticks 2 and 3 on one turn are counted as anything but one run fewer');
    assert.equal((await lastLoopRun(prisma, loop.id))?.deliveredAt.getTime(), handedTurn.deliveredAt?.getTime());
    assert.deepEqual(
      (await oneShotsOf(id)).map((row) => [row.state, row.reason, row.clientTurnId]),
      [['SUPERSEDED', 'check the deploy', once.clientTurnId], ['PENDING', 'check the deploy', null]],
      'the one-shot wakeup beside them did not go back to waiting for the retry',
    );
  });

  await t.test('a turn that fails its session (turn-complete): the one-shot wakeup behind it is DROPPED and its owner told, and the tick beside it is DROPPED and uncounted', async () => {
    const m = await machine('turn-failed');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 120, prompt: 'check the queue depth' });
    const loop = await loopOf(id);
    const first = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(first.id), 'DELIVERED');
    const { turnId } = await claim(m, id);
    const queuedTick = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(queuedTick.id), 'DELIVERED');
    const once = await fileOneShot(m, id, 'check the deploy');
    runnerPush.rang.length = 0;

    // The turn the engine is running fails, and fails its session: nothing armed (the engine replied before it failed).
    await replied(id, turnId);
    await runnerApi.turnComplete(m.runner as never, id, {
      turnId, status: RunStatus.FAILED, error: 'Prompt is too long', numTurns: 1, costUsd: 0.01,
    } as never);

    const failed = await sessionRow(id);
    assert.deepEqual([failed.status, failed.retryAt], [RunStatus.FAILED, null], 'the failed turn did not fail its session, or armed a retry');
    assert.equal((await turnByKey(id, once.clientTurnId!)).status, 'ANSWERED', 'the turn queued behind the failed one was not drained');
    assert.equal((await oneShot(once.id)).state, 'DROPPED');
    assert.deepEqual(runnerPush.rang, [{
      ownerId: m.ownerId,
      sessionId: id,
      title: 'a migration that runs for days',
      missed: { wakeupId: once.id },
      reason: 'SESSION_FAILED',
    }], 'the owner was not told, once, that the wakeup was dropped');
    const [ran, dropped] = await ticksOf(loop.id);
    assert.deepEqual([ran.state, dropped.state], ['DELIVERED', 'DROPPED']);
    const counted = await loopOf(id);
    assert.deepEqual([counted.ticksFired, counted.ticksMissed], [1, 1], 'the queued tick still counts as a run');

    // The runner sends the same completion again: absorbed, and nobody is told twice.
    await runnerApi.turnComplete(m.runner as never, id, {
      turnId, status: RunStatus.FAILED, error: 'Prompt is too long', numTurns: 1, costUsd: 0.01,
    } as never);
    assert.equal(runnerPush.rang.length, 1, 'a retried completion told the drop twice');
  });

  await t.test('the runner\'s finalize FAILED with no retry armed: the one-shot wakeup on the drained turn is DROPPED and its owner told', async () => {
    const m = await machine('finalize-failed');
    const { id } = await working(m);
    const filed = await fileOneShot(m, id, 'check the deploy');
    runnerPush.rang.length = 0;

    await runnerApi.finalize(m.runner as never, id, { status: RunStatus.FAILED, error: 'the engine exited' } as never);

    const finalized = await sessionRow(id);
    assert.deepEqual([finalized.status, finalized.retryAt], [RunStatus.FAILED, null]);
    assert.equal((await oneShot(filed.id)).state, 'DROPPED');
    assert.deepEqual(runnerPush.rang.map((push) => [push.sessionId, push.missed, push.reason]), [
      [id, { wakeupId: filed.id }, 'SESSION_FAILED'],
    ]);
  });

  await t.test('an interrupt and a withdrawal leave the tick they take CANCELLED, as before, and take it out of its loop\'s runs', async () => {
    const m = await machine('interrupt');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 120, prompt: 'check the queue depth' });
    const loop = await loopOf(id);
    const first = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(first.id), 'DELIVERED');
    await claim(m, id);

    // A plain interrupt takes the tick queued behind the running turn.
    const interrupted = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(interrupted.id), 'DELIVERED');
    assert.deepEqual([(await loopOf(id)).ticksFired, (await loopOf(id)).ticksMissed], [2, 0]);
    await sessions.interrupt(m.ownerId, id);
    assert.equal((await ticksOf(loop.id)).find((tick) => tick.id === interrupted.id)?.state, 'CANCELLED');
    let counted = await loopOf(id);
    assert.deepEqual([counted.state, counted.ticksFired, counted.ticksMissed], ['ACTIVE', 1, 1], 'the interrupted tick still counts as a run');
    // The runner honors the interrupt: the turn it stopped, and the interrupt itself, are over.
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'ANSWERED', "answered_at" = clock_timestamp()
        WHERE "session_id" = $1::uuid AND "status" <> 'ANSWERED'`,
      [id],
    );
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1::uuid`, [id]);

    // The owner withdraws the next one from the queue.
    const withdrawn = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(withdrawn.id), 'DELIVERED');
    const queued = await turnByKey(id, (await ticksOf(loop.id)).find((tick) => tick.id === withdrawn.id)!.clientTurnId!);
    await sessions.cancelQueuedTurn(m.ownerId, id, queued.id);
    assert.equal((await ticksOf(loop.id)).find((tick) => tick.id === withdrawn.id)?.state, 'CANCELLED');
    counted = await loopOf(id);
    assert.deepEqual([counted.ticksFired, counted.ticksMissed], [1, 2], 'the withdrawn tick still counts as a run');
    const wakeups = await wakeupsOf(m, id);
    assert.deepEqual([wakeups.loop.ticksFired, wakeups.loop.ticksMissed], [1, 2], 'session_get does not read what ran');

    // The next tick that runs says the two did not.
    const next = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(next.id), 'DELIVERED');
    const { content } = await claim(m, id);
    assert.ok(content.includes('loop: tick 4, every 120 seconds until'), content);
    assert.ok(content.includes('2 ticks missed since the last run'), content);
  });
});
