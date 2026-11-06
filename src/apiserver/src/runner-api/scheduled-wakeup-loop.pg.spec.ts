/**
 * A wakeup loop is held by the control plane and is not broken by a failed turn, a FAILED session or a
 * one-shot wakeup: only `stop`, `until`, the session ending and the owner's Stop end it, and each end
 * leaves its reason (docs/long-running-loop-contract.md §1, project 34pUaJboWdDFzjftkEso8, task A1). A
 * loop that stops running, and a one-shot wakeup dropped with its FAILED session, are told to the owner
 * (§4, task C2). session_get says when the session is woken next, when a wakeup last reached its engine
 * and how the loop stands (§3, task C1).
 *
 * Against real PostgreSQL, with the production code throughout — the runner door
 * (RunnerApiController.scheduledWakeup), SessionsService (createTurn, resume, interrupt), the
 * scheduled-wakeup worker and the queue's claim — driven tick by tick: each case moves its loop's
 * timeline back until the tick waiting is due, then asks the worker to deliver it. Every case:
 *
 *   1. FAILED with no retry armed: the tick revives the session through `sessions.resume` with an empty
 *      content and its `bg-wake:` key, and the claim that picks the revive up writes the loop's block into
 *      the turn (the precondition the task asked to confirm first).
 *   2. A live session: the tick is a turn and the next tick is written with it; a tick joining a queued
 *      turn that carries the loop's previous one is missed and merged into one entry; due times skipped
 *      while the worker was late are missed, and the next run says so.
 *   3. FAILED with a retry armed: the tick is skipped (missed) and the retry is left to bring it back.
 *   4. Three revives in a row, each ending FAILED again: the next tick holds, missed only; once the
 *      session is healthy again the loop goes on, as turns.
 *   4b. An outage spends no revive: ticks skipped while the retry is armed and revives refused while the
 *      runner is away — past MAX_OFFLINE_WAIT_MS, when the auto-retry's own sweep gives up — leave the
 *      streak at 0, and the first tick after the runner is back revives the session.
 *   5. A one-shot wakeup and a loop live side by side: neither replaces the other, both can land on one
 *      turn, and a stop takes both and says how many of each.
 *   6. A one-shot wakeup whose session FAILED waits while its retry is armed, and is dropped when not.
 *   7. Each end reason, once: REQUESTED, REPLACED (in 5), OWNER_STOP (and a plain interrupt that is not
 *      one), SESSION_ENDED (for every way a session ends) and UNTIL_REACHED (with the last tick's block).
 *   8. A tick that cannot be filed waits for the next pass, and an interval late it is counted missed.
 *   9. The door's bounds: clamped and said so, refused when the loop cannot be what was asked.
 *  10. The dead-man signal, through a PushService double: a loop none of whose ticks has reached the engine
 *      for max(2 × every, 15 minutes) tells its owner once per silence — the runner offline, then the
 *      session FAILED — and again only after it has run, which clears the alert; the turn that runs after
 *      the silence tells the agent how many due times did not run.
 *  11. A busy session is not a silent loop: nothing is said while its turn runs on a runner that is there,
 *      and the alert comes once that runner is gone.
 *  12. A loop that never ran is silent from its start, a turn nobody hands out is said to be queued, and a
 *      loop whose session ended is over, not silent.
 *  13. A one-shot wakeup dropped with its FAILED session tells the owner, once; one held for an armed
 *      retry, or dropped with a session that ended, says nothing.
 *  14. session_get, through the runner's session door: the next due time, when a tick last reached the
 *      engine (its turn's `delivered_at`) and the ticks fired and missed. A tick filed onto a turn nobody
 *      has taken — the runner away — leaves lastFiredAt where it was until that turn is handed out.
 *  15. session_get's next is whichever wakeup is due first; a one-shot wakeup's run is the session's last
 *      firing and not its loop's; an ended loop says why and when, and a newer loop is the one shown.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/scheduled-wakeup-loop.pg.spec.ts
 *
 * Not destructive: every row is made by the run, under owners it generates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
import type { RealtimeService } from '../realtime/realtime.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { SessionsService } from '../sessions/sessions.service';
import { RunnerApiController } from './runner-api.controller';
import { RunnerSessionsController } from './runner-sessions.controller';
import { lastLoopRun, loopSilenceLimitMs, ScheduledWakeupDto } from './scheduled-wakeup';
import { ScheduledWakeupWorker } from './scheduled-wakeup.worker';
import '../test-support/dequeue-under-lease';

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

// The browser's reading of the block, loaded from the web client itself (as background-wake-queued-turn.pg.spec
// does): a tick's entry must stay one the clients already read, and its `loop:` line one they pass over.
const WEB_PARSER = path.resolve(__dirname, '../../../web/src/lib/backgroundWake.ts');
const stripTypeScriptTypes = (nodeModule as unknown as {
  stripTypeScriptTypes: (code: string, options: { mode: 'strip' }) => string;
}).stripTypeScriptTypes;
interface WebWakeup { askedAt: string | null; delaySeconds: number | null; dueAt: string | null; reason: string | null; prompt: string }
type ParseBackgroundWake = (note: string) => { jobs: unknown[]; wakeups: WebWakeup[] } | null;

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

interface LoopRow {
  id: string;
  state: string;
  everySeconds: number;
  firstDueAt: Date;
  untilAt: Date;
  ticksFired: number;
  ticksMissed: number;
  reviveStreak: number;
  endedReason: string | null;
  endedAt: Date | null;
  alertedAt: Date | null;
}

interface TickRow {
  id: string;
  state: string;
  dueAt: Date;
  clientTurnId: string | null;
  reason: string;
  prompt: string | null;
}

/** What the worker asked PushService to send. */
type WakeupMissedPush = Parameters<PushService['notifyLoopMissed']>[0];

test('a wakeup loop outlives failed turns and FAILED sessions, and ends only for a reason it records', {
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
  const runnerApi = new RunnerApiController(
    prisma,
    queue,
    quiet,
    {} as never,
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
  /** A worker whose PushService is a double keeping every notifyLoopMissed it was asked for. */
  const signallingWorker = (): { worker: ScheduledWakeupWorker; rang: WakeupMissedPush[] } => {
    const rang: WakeupMissedPush[] = [];
    const push = {
      notifyLoopMissed: async (input: WakeupMissedPush) => {
        rang.push(input);
      },
    } as unknown as PushService;
    return { worker: new ScheduledWakeupWorker(prisma, sessions, {}, push), rang };
  };
  /** The loop alert a push was for; it fails the case when the push was for a one-shot wakeup. */
  const loopAlertOf = (push: WakeupMissedPush) => {
    assert.ok('loopId' in push.missed, `not a loop's alert: ${JSON.stringify(push)}`);
    return push.missed;
  };

  assert.ok(existsSync(WEB_PARSER), `${WEB_PARSER} was not found: the block is read against the web client's own parser`);
  const stripped = path.join(mkdtempSync(path.join(os.tmpdir(), 'orbit-wakeup-loop-')), 'backgroundWake.mjs');
  writeFileSync(stripped, stripTypeScriptTypes(readFileSync(WEB_PARSER, 'utf8'), { mode: 'strip' }));
  const parseWake = ((await import(pathToFileURL(stripped).href)) as { parseBackgroundWake: ParseBackgroundWake }).parseBackgroundWake;

  // Runners heartbeat for as long as the file runs, as real ones would: a revive needs its runner online.
  const runners: string[] = [];
  const beat = () =>
    sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = ANY($1::uuid[])`, [runners])
      .catch(() => undefined);
  const heartbeat = setInterval(() => void beat(), 5_000);
  t.after(async () => {
    clearInterval(heartbeat);
    rmSync(path.dirname(stripped), { recursive: true, force: true });
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type Machine = { ownerId: string; runnerId: string; workspaceId: string; runner: { id: string; ownerId: string } };
  /** An owner with one runner and one workspace on it, its own: a claim on it can take nothing else's session. */
  async function machine(label: string): Promise<Machine> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@wakeup-loop.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/tmp/wakeup-loop' },
    });
    runners.push(runnerId);
    return { ownerId, runnerId, workspaceId, runner: { id: runnerId, ownerId } };
  }

  /** The runner goes away: it stops heartbeating and reads offline. */
  async function goOffline(m: Machine): Promise<void> {
    runners.splice(runners.indexOf(m.runnerId), 1);
    await sql.query(
      `UPDATE "runner" SET "status" = 'OFFLINE', "last_heartbeat_at" = clock_timestamp() - interval '10 minutes' WHERE "id" = $1::uuid`,
      [m.runnerId],
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
        title: 'an archive migration that runs for days',
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedule = (m: Machine, sessionId: string, body: Record<string, unknown>): Promise<any> =>
    runnerApi.scheduledWakeup(m.runner as never, sessionId, Object.assign(new ScheduledWakeupDto(), body));

  /** What session_get answers with about the session's wakeups, as the runner's session door serves it to a
   *  caller with the runner's own credential, in its JSON form: the times as the wire spells them. */
  const sessionDoor = new RunnerSessionsController(sessions, {} as never, {} as never, {} as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wakeupsOf = async (m: Machine, sessionId: string): Promise<any> =>
    JSON.parse(JSON.stringify(await sessionDoor.getSession(m.runner as never, undefined, undefined, undefined, sessionId))).wakeups;

  const loopsOf = async (sessionId: string): Promise<LoopRow[]> => (await sql.query(
    `SELECT "id", "state", "every_seconds" AS "everySeconds", "first_due_at" AS "firstDueAt", "until_at" AS "untilAt",
            "ticks_fired" AS "ticksFired", "ticks_missed" AS "ticksMissed", "revive_streak" AS "reviveStreak",
            "ended_reason" AS "endedReason", "ended_at" AS "endedAt", "alerted_at" AS "alertedAt"
       FROM "session_wakeup_loop" WHERE "session_id" = $1::uuid ORDER BY "created_at", "id"`,
    [sessionId],
  )).rows;
  const loopOf = async (sessionId: string): Promise<LoopRow> => {
    const loops = await loopsOf(sessionId);
    assert.ok(loops.length > 0, 'the session has no loop');
    return loops[loops.length - 1];
  };
  const ticksOf = async (loopId: string): Promise<TickRow[]> => (await sql.query(
    `SELECT "id", "state", "due_at" AS "dueAt", "client_turn_id" AS "clientTurnId", "reason", "prompt"
       FROM "session_scheduled_wakeup" WHERE "loop_id" = $1::uuid ORDER BY "due_at", "id"`,
    [loopId],
  )).rows;
  const oneShotsOf = async (sessionId: string): Promise<TickRow[]> => (await sql.query(
    `SELECT "id", "state", "due_at" AS "dueAt", "client_turn_id" AS "clientTurnId", "reason", "prompt"
       FROM "session_scheduled_wakeup" WHERE "session_id" = $1::uuid AND "loop_id" IS NULL ORDER BY "created_at", "id"`,
    [sessionId],
  )).rows;
  const statesOf = async (loopId: string) => (await ticksOf(loopId)).map((tick) => tick.state);
  const pendingOf = async (loopId: string): Promise<TickRow | undefined> =>
    (await ticksOf(loopId)).find((tick) => tick.state === 'PENDING');
  const turnsOf = (sessionId: string) =>
    db.conversationTurn.findMany({ where: { sessionId, kind: 'message', seq: { gt: 1 } }, orderBy: { seq: 'asc' } });
  const sessionRow = (sessionId: string) => db.session.findUniqueOrThrow({ where: { id: sessionId } });

  /** Move the loop's whole timeline back — its ticks, its first due time and its until — so that the tick it
   *  has waiting came due `lateSeconds` ago. Returns that tick. */
  async function makeDue(loopId: string, lateSeconds = 1): Promise<TickRow> {
    const waiting = await pendingOf(loopId);
    assert.ok(waiting, 'the loop has no tick waiting');
    const shiftMs = waiting.dueAt.getTime() - (Date.now() - lateSeconds * 1_000);
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

  /** Let the loop's clock run until the tick it has waiting came due `lateSeconds` ago: makeDue, with the rest
   *  of its history moved back by the same amount — when it started, when it last alerted, and when its
   *  session's turns were handed to the engine — so the time since its last run grows as it would have.
   *  Shifted in SQL: `delivered_at` has no zone, and this host's `pg` client would read it eight hours off. */
  async function elapse(loopId: string, sessionId: string, lateSeconds = 1): Promise<TickRow> {
    const waiting = await pendingOf(loopId);
    assert.ok(waiting, 'the loop has no tick waiting');
    const shiftMs = waiting.dueAt.getTime() - (Date.now() - lateSeconds * 1_000);
    const back = `- $2::bigint * interval '1 millisecond'`;
    await sql.query(`UPDATE "session_scheduled_wakeup" SET "due_at" = "due_at" ${back} WHERE "loop_id" = $1::uuid`, [loopId, shiftMs]);
    await sql.query(
      `UPDATE "session_wakeup_loop"
          SET "first_due_at" = "first_due_at" ${back}, "until_at" = "until_at" ${back},
              "created_at" = "created_at" ${back}, "alerted_at" = "alerted_at" ${back}
        WHERE "id" = $1::uuid`,
      [loopId, shiftMs],
    );
    await sql.query(
      `UPDATE "conversation_turn" SET "delivered_at" = "delivered_at" ${back} WHERE "session_id" = $1::uuid AND "delivered_at" IS NOT NULL`,
      [sessionId, shiftMs],
    );
    return (await ticksOf(loopId)).find((tick) => tick.id === waiting.id)!;
  }

  /** What the runner is handed when it takes the session's next turn, as the inbox claim builds it. */
  async function handedOut(m: Machine, sessionId: string): Promise<{ turnId: string; content: string }> {
    const delivered = await (runnerApi as unknown as {
      dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: null) => Promise<{ turnId: string; content?: string } | null>;
    }).dequeueTurn(sessionId, m.runnerId, null);
    assert.ok(delivered?.turnId, 'the inbox handed out no turn');
    return { turnId: String(delivered.turnId), content: String(delivered.content ?? '') };
  }
  /** The runner's claim of a session queued for a turn — the queue's own, the one a runner makes — then
   *  the inbox. Each case has a runner of its own, so the claim can take no other case's session. */
  async function claim(m: Machine, sessionId: string) {
    const claimed = await claims.claimSessionForRunner({ id: m.runnerId, supportedProviders: [AgentProvider.CLAUDE] });
    assert.equal(claimed?.sessionId, sessionId, 'the runner was offered another session, or none');
    return handedOut(m, sessionId);
  }
  /** The turn the runner took is over, and the session parked again. */
  async function finishTurn(sessionId: string): Promise<void> {
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'ANSWERED', "answered_at" = clock_timestamp()
        WHERE "session_id" = $1::uuid AND "kind" = 'message' AND "status" IN ('PENDING', 'IN_FLIGHT')`,
      [sessionId],
    );
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1::uuid`, [sessionId]);
  }
  /** A turn failed the session, as turn-complete records it: FAILED, its runner slot reclaimed. */
  async function failSession(sessionId: string, retryAt: Date | null = null): Promise<void> {
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'ANSWERED', "answered_at" = clock_timestamp()
        WHERE "session_id" = $1::uuid AND "kind" = 'message' AND "status" IN ('PENDING', 'IN_FLIGHT')`,
      [sessionId],
    );
    await sql.query(
      `UPDATE "session" SET "status" = 'FAILED', "finished_at" = clock_timestamp(), "cancel_requested_at" = clock_timestamp(),
              "error" = 'Prompt is too long', "retry_at" = $2::timestamptz(3)
        WHERE "id" = $1::uuid`,
      [sessionId, retryAt],
    );
  }
  /** One pass of the worker over these sessions' due wakeups only: what earlier cases left waiting is moved
   *  a day out first, so a tick of theirs coming due while this file runs is not counted here. */
  async function drainOnly(...sessionIds: string[]) {
    await sql.query(
      `UPDATE "session_scheduled_wakeup" SET "due_at" = "due_at" + interval '1 day'
        WHERE "state" = 'PENDING' AND NOT ("session_id" = ANY($1::uuid[]))`,
      [sessionIds],
    );
    return worker.drain();
  }
  const timingLines = (content: string) =>
    content.split('\n').filter((line) => /^ {4}\S+ scheduled \d+ seconds out, due \S+$/.test(line));

  await t.test('FAILED with no retry armed: the tick revives the session through resume, with no words and its bg-wake: key, and the claim writes the block in', async () => {
    const m = await machine('revive');
    const id = await session(m);
    const receipt = await schedule(m, id, {
      recurring: true,
      everySeconds: 300,
      prompt: 'advance the archive migration by one batch',
      reason: 'the archive migration',
    });
    assert.equal(receipt.recurring, true, JSON.stringify(receipt));
    await failSession(id);
    const loop = await loopOf(id);
    const tick = await makeDue(loop.id);

    assert.equal(await worker.deliverTick(tick.id), 'REVIVED');

    const [turn, ...more] = await turnsOf(id);
    assert.equal(more.length, 0, 'the revive wrote more than one turn');
    assert.equal(turn.clientTurnId, `bg-wake:wakeup:${tick.id}`, 'the revive turn is not the tick\'s bg-wake: turn');
    assert.equal(turn.content, '', `the revive turn records words: ${JSON.stringify(turn.content)}`);
    assert.equal(turn.status, 'PENDING');
    const revived = await sessionRow(id);
    assert.equal(revived.status, RunStatus.PENDING, 'the session was not revived');
    assert.equal(revived.cancelRequestedAt, null);
    assert.equal(revived.lastUserText, null, 'the list would preview the tick as the person\'s message');
    const [settled, next] = await ticksOf(loop.id);
    assert.deepEqual([settled.state, settled.clientTurnId], ['DELIVERED', turn.clientTurnId], 'the tick is not settled onto the revive turn');
    assert.equal(next?.state, 'PENDING', 'the revive left the loop without its next tick');
    assert.equal(next.dueAt.getTime() - settled.dueAt.getTime(), 300_000, 'the next tick is not one interval on');
    const after = await loopOf(id);
    assert.deepEqual(
      [after.state, after.ticksFired, after.ticksMissed, after.reviveStreak],
      ['ACTIVE', 1, 0, 1],
      JSON.stringify(after),
    );

    // The runner's claim of the revived session, then its inbox: the block is written in at the claim.
    const { turnId, content } = await claim(m, id);
    assert.ok([turn.id].includes(turnId), `the inbox handed out ${turnId}, not the revive turn ${turn.id}`);
    for (const fact of [
      '<scheduled-wakeup>',
      'A tick of the loop you started with schedule_wakeup is due',
      'loop: tick 1, every 300 seconds until',
      '0 ticks missed since the last run',
      'reason: the archive migration',
      'advance the archive migration by one batch',
      'do not schedule its next tick',
      'mcp__orbit__schedule_wakeup with stop: true',
    ]) {
      assert.ok(content.includes(fact), `the delivered turn does not say ${fact}:\n${content}`);
    }
    const web = parseWake(content);
    assert.equal(web?.wakeups.length, 1, `the web client does not read one wakeup out of:\n${content}`);
    assert.deepEqual(
      [web.wakeups[0].reason, web.wakeups[0].prompt, web.wakeups[0].delaySeconds, web.wakeups[0].dueAt],
      ['the archive migration', 'advance the archive migration by one batch', 300, settled.dueAt.toISOString()],
    );
  });

  await t.test('a live session: the tick is a turn with the next tick written beside it; a tick folded into its predecessor\'s turn and due times skipped while late are missed', async () => {
    const m = await machine('live');
    const id = await session(m);
    const receipt = await schedule(m, id, { recurring: true, everySeconds: 120, prompt: 'check the queue depth', reason: 'the drain' });
    assert.deepEqual(
      [receipt.outcome, receipt.everySeconds, receipt.delaySeconds, receipt.clamped, receipt.replaced],
      ['SCHEDULED', 120, 120, false, false],
      JSON.stringify(receipt),
    );
    const untilIn = new Date(receipt.until).getTime() - Date.now();
    assert.ok(Math.abs(untilIn - 7 * 86_400_000) < 60_000, `a loop with no until runs ${untilIn} ms, not seven days`);
    const loop = await loopOf(id);
    assert.equal(loop.alertedAt, null, 'a new loop starts with nothing alerted');
    assert.equal(receipt.loopId, loop.id);

    const first = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(first.id), 'DELIVERED');
    const [turn] = await turnsOf(id);
    assert.equal(turn.clientTurnId, `bg-wake:wakeup:${first.id}`);
    assert.equal(turn.content, '');
    assert.equal((await sessionRow(id)).status, RunStatus.PENDING, 'the tick did not ask for a runner slot');
    let ticks = await ticksOf(loop.id);
    assert.deepEqual(ticks.map((tick) => tick.state), ['DELIVERED', 'PENDING']);
    assert.equal(ticks[1].dueAt.getTime() - ticks[0].dueAt.getTime(), 120_000);
    assert.equal(ticks[1].prompt, null, 'a tick carries the loop\'s prompt instead of reading it from the loop');

    // The next tick comes due while that turn is still queued: it joins it, and is the missed one.
    const second = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(second.id), 'DELIVERED');
    assert.equal((await turnsOf(id)).length, 1, 'the second tick opened a second turn behind the queued one');
    ticks = await ticksOf(loop.id);
    assert.deepEqual(ticks.map((tick) => [tick.state, tick.clientTurnId]), [
      ['DELIVERED', turn.clientTurnId], ['DELIVERED', turn.clientTurnId], ['PENDING', null],
    ]);
    let counted = await loopOf(id);
    assert.deepEqual([counted.ticksFired, counted.ticksMissed], [1, 1], JSON.stringify(counted));
    const merged = (await claim(m, id)).content;
    assert.equal(timingLines(merged).length, 1, `two ticks on one turn are not one entry:\n${merged}`);
    assert.ok(merged.includes('loop: tick 2, every 120 seconds until'), merged);
    assert.ok(merged.includes('1 tick missed since the last run'), merged);
    assert.equal(parseWake(merged)?.wakeups.length, 1);
    await finishTurn(id);

    // The worker comes back two and a half intervals late: this tick is filed, the two due times after it
    // are skipped, and the next tick is due on the loop's own grid.
    const third = await makeDue(loop.id, 300);
    assert.equal(await worker.deliverTick(third.id), 'DELIVERED');
    ticks = await ticksOf(loop.id);
    const waiting = ticks.find((tick) => tick.state === 'PENDING')!;
    assert.equal(waiting.dueAt.getTime() - third.dueAt.getTime(), 3 * 120_000, 'the next tick is not on the loop\'s grid');
    counted = await loopOf(id);
    assert.deepEqual([counted.ticksFired, counted.ticksMissed], [2, 3], JSON.stringify(counted));
    const thirdTurn = (await claim(m, id)).content;
    assert.ok(thirdTurn.includes('loop: tick 3, every 120 seconds'), thirdTurn);
    assert.ok(thirdTurn.includes('0 ticks missed since the last run'), thirdTurn);
    await finishTurn(id);
    const sixth = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(sixth.id), 'DELIVERED');
    const sixthTurn = (await claim(m, id)).content;
    assert.ok(sixthTurn.includes('loop: tick 6, every 120 seconds'), sixthTurn);
    assert.ok(sixthTurn.includes('2 ticks missed since the last run'), sixthTurn);
    assert.equal((await loopOf(id)).state, 'ACTIVE');
  });

  await t.test('FAILED with a retry armed: the tick is skipped as missed, the loop goes on, and the retry is left to recover the session', async () => {
    const m = await machine('armed');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 60, prompt: 'look at the import' });
    const retryAt = new Date(Date.now() + 5 * 60_000);
    await failSession(id, retryAt);
    const loop = await loopOf(id);
    const tick = await makeDue(loop.id);

    assert.equal(await worker.deliverTick(tick.id), 'MISSED');
    assert.deepEqual(await statesOf(loop.id), ['DROPPED', 'PENDING'], 'the loop was not carried on to its next tick');
    const after = await loopOf(id);
    assert.deepEqual(
      [after.state, after.ticksFired, after.ticksMissed, after.reviveStreak],
      ['ACTIVE', 0, 1, 0],
      JSON.stringify(after),
    );
    const failed = await sessionRow(id);
    assert.equal(failed.status, RunStatus.FAILED, 'the tick revived a session whose retry is armed');
    assert.equal(failed.retryAt?.getTime(), retryAt.getTime(), 'the tick touched the armed retry');
    assert.equal((await turnsOf(id)).length, 0, 'a turn was filed for a session the retry is to bring back');
  });

  await t.test('three revives in a row that each end FAILED again: the next tick holds and only counts missed; once healthy the loop goes on', async () => {
    const m = await machine('streak');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 60, prompt: 'retry the batch', reason: 'the import' });
    const loop = await loopOf(id);
    await failSession(id);
    for (let n = 1; n <= 3; n += 1) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'REVIVED', `tick ${n} of the streak did not revive the session`);
      assert.equal((await sessionRow(id)).status, RunStatus.PENDING);
      assert.equal((await loopOf(id)).reviveStreak, n);
      // The revived turn fails again, as a full context does at once.
      await failSession(id);
    }
    const turnsBefore = (await turnsOf(id)).length;
    assert.equal(turnsBefore, 3);
    for (let n = 4; n <= 5; n += 1) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'MISSED', `tick ${n} of the streak revived the session again`);
      const held = await sessionRow(id);
      assert.equal(held.status, RunStatus.FAILED, `tick ${n} revived the session`);
      assert.equal((await turnsOf(id)).length, turnsBefore, `tick ${n} filed a turn`);
    }
    let after = await loopOf(id);
    // A tick held at the limit spends nothing: the streak is still the three revives.
    assert.deepEqual(
      [after.state, after.ticksFired, after.ticksMissed, after.reviveStreak],
      ['ACTIVE', 3, 2, 3],
      JSON.stringify(after),
    );

    // The session is healthy again — its owner brought it back — and the loop goes on by itself.
    await sql.query(
      `UPDATE "session" SET "status" = 'AWAITING_INPUT', "cancel_requested_at" = NULL, "finished_at" = NULL, "error" = NULL WHERE "id" = $1::uuid`,
      [id],
    );
    const tick = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(tick.id), 'DELIVERED');
    after = await loopOf(id);
    assert.deepEqual(
      [after.state, after.ticksFired, after.ticksMissed, after.reviveStreak],
      ['ACTIVE', 4, 2, 0],
      JSON.stringify(after),
    );
    const content = (await claim(m, id)).content;
    assert.ok(content.includes('loop: tick 6, every 60 seconds'), content);
    assert.ok(content.includes('2 ticks missed since the last run'), content);
  });

  await t.test('an outage spends no revive: armed skips and refused revives leave the streak, and the first tick after the runner is back revives the session', async () => {
    const m = await machine('outage');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 60, prompt: 'advance the migration by one batch' });
    const loop = await loopOf(id);
    // The runner goes away mid-turn: the reaper fails the session and arms a retry that waits for the runner.
    await goOffline(m);
    await failSession(id, new Date(Date.now() + 30_000));
    for (let n = 1; n <= 2; n += 1) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'MISSED', `tick ${n}, while the retry is armed`);
      assert.equal((await loopOf(id)).reviveStreak, 0, `tick ${n}, skipped for the armed retry, spent a revive`);
    }

    // MAX_OFFLINE_WAIT_MS later the runner is still away, and the auto-retry's own sweep gives up on it: the
    // session stays FAILED with nothing armed. Only this case's retry is left for the sweep to find.
    await sql.query(
      `UPDATE "session" SET "retry_at" = NULL WHERE "retry_at" IS NOT NULL AND "id" <> $1::uuid`,
      [id],
    );
    await sql.query(
      `UPDATE "session" SET "finished_at" = clock_timestamp() - interval '31 minutes',
              "retry_at" = clock_timestamp() - interval '1 second'
        WHERE "id" = $1::uuid`,
      [id],
    );
    await autoRetry.sweep();
    const disarmed = await sessionRow(id);
    assert.deepEqual([disarmed.status, disarmed.retryAt], [RunStatus.FAILED, null], 'the auto-retry did not give up on the runner');

    // Now the ticks try to revive it, and every resume is refused while the runner is away.
    for (let n = 3; n <= 4; n += 1) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'MISSED', `tick ${n}, whose revive the runner was not there for`);
      assert.equal((await sessionRow(id)).status, RunStatus.FAILED);
      assert.equal((await loopOf(id)).reviveStreak, 0, `tick ${n}: a refused revive was counted as one`);
    }
    assert.equal((await turnsOf(id)).length, 0, 'a turn was filed while the runner was away');

    // The runner is back: the next tick revives the session — the first revive of a streak, not the fifth.
    await goOnline(m);
    const back = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(back.id), 'REVIVED', 'the loop did not revive the session once its runner was back');
    assert.equal((await sessionRow(id)).status, RunStatus.PENDING);
    const after = await loopOf(id);
    assert.deepEqual(
      [after.state, after.ticksFired, after.ticksMissed, after.reviveStreak],
      ['ACTIVE', 1, 4, 1],
      JSON.stringify(after),
    );
    const content = (await claim(m, id)).content;
    assert.ok(content.includes('loop: tick 5, every 60 seconds'), content);
    assert.ok(content.includes('4 ticks missed since the last run'), content);
  });

  await t.test('a one-shot wakeup and a loop live side by side: neither replaces the other, both land on one turn, and a stop takes both', async () => {
    const m = await machine('beside');
    const id = await session(m);
    const once = await schedule(m, id, { delaySeconds: 60, reason: 'check CI run 4242' });
    assert.equal(once.outcome, 'SCHEDULED');
    assert.equal(once.recurring, undefined, 'a one-shot receipt changed shape');
    const started = await schedule(m, id, { recurring: true, everySeconds: 300, prompt: 'advance the migration', reason: 'the migration' });
    assert.equal(started.replaced, false, 'a loop replaced something');
    assert.deepEqual((await oneShotsOf(id)).map((row) => row.state), ['PENDING'], 'starting a loop touched the one-shot wakeup');

    const again = await schedule(m, id, { delaySeconds: 90, reason: 'check CI run 4243' });
    assert.equal(again.replaced, true, JSON.stringify(again));
    assert.deepEqual((await oneShotsOf(id)).map((row) => row.state), ['SUPERSEDED', 'PENDING']);
    const first = await loopOf(id);
    assert.equal(first.state, 'ACTIVE', 'a one-shot wakeup ended the loop');
    assert.deepEqual(await statesOf(first.id), ['PENDING'], 'a one-shot wakeup took the loop\'s tick');

    // REPLACED: a later recurring request ends the running loop, and leaves the one-shot wakeup alone.
    const replacing = await schedule(m, id, { recurring: true, everySeconds: 600, prompt: 'advance the migration, slower', reason: 'the migration' });
    assert.equal(replacing.replaced, true, JSON.stringify(replacing));
    const [old, current] = await loopsOf(id);
    assert.deepEqual([old.state, old.endedReason], ['ENDED', 'REPLACED']);
    assert.ok(old.endedAt, 'a replaced loop does not say when it ended');
    assert.deepEqual(await statesOf(old.id), ['CANCELLED']);
    assert.deepEqual([current.state, current.everySeconds], ['ACTIVE', 600]);
    assert.deepEqual((await oneShotsOf(id)).map((row) => row.state), ['SUPERSEDED', 'PENDING'], 'replacing a loop touched the one-shot wakeup');

    // Both come due: one pass of the worker files them onto one turn.
    await sql.query(
      `UPDATE "session_scheduled_wakeup" SET "due_at" = clock_timestamp() - interval '2 seconds' WHERE "session_id" = $1::uuid AND "loop_id" IS NULL AND "state" = 'PENDING'`,
      [id],
    );
    await makeDue(current.id);
    const outcomes = await drainOnly(id);
    assert.deepEqual(outcomes, ['DELIVERED', 'DELIVERED'], 'the pass did not deliver both');
    const turns = await turnsOf(id);
    assert.equal(turns.length, 1, 'the one-shot wakeup and the tick opened two turns');
    assert.equal((await oneShotsOf(id))[1].clientTurnId, turns[0].clientTurnId);
    const content = (await claim(m, id)).content;
    assert.ok(content.includes('What you asked for with schedule_wakeup is due'), content);
    assert.equal(timingLines(content).length, 2, content);
    for (const fact of ['reason: check CI run 4243', 'loop: tick 1, every 600 seconds', 'To wait again, call mcp__orbit__schedule_wakeup again.', 'The loop goes on by itself']) {
      assert.ok(content.includes(fact), `the shared turn does not say ${fact}:\n${content}`);
    }
    assert.equal(parseWake(content)?.wakeups.length, 2);
    await finishTurn(id);
    assert.equal((await loopOf(id)).state, 'ACTIVE');

    // REQUESTED: a stop takes the waiting one-shot wakeup and the loop, and says how many of each; again, nothing.
    await schedule(m, id, { delaySeconds: 60, reason: 'one more look' });
    const stopped = await schedule(m, id, { stop: true });
    assert.deepEqual(stopped, { outcome: 'CANCELLED', cancelled: 1, loopsStopped: 1 });
    const ended = await loopOf(id);
    assert.deepEqual([ended.state, ended.endedReason], ['ENDED', 'REQUESTED']);
    assert.ok(ended.endedAt);
    assert.deepEqual(await statesOf(ended.id), ['DELIVERED', 'CANCELLED']);
    assert.deepEqual(await schedule(m, id, { stop: true }), { outcome: 'CANCELLED', cancelled: 0, loopsStopped: 0 }, 'a second stop is not idempotent');
  });

  await t.test('a one-shot wakeup whose session FAILED waits while the retry is armed, and is dropped when it is not', async () => {
    const m = await machine('one-shot');
    const armed = await session(m);
    await schedule(m, armed, { delaySeconds: 60, reason: 'look at the deploy' });
    await failSession(armed, new Date(Date.now() + 10 * 60_000));
    await sql.query(`UPDATE "session_scheduled_wakeup" SET "due_at" = clock_timestamp() - interval '2 seconds' WHERE "session_id" = $1::uuid`, [armed]);
    const [held] = await oneShotsOf(armed);
    assert.deepEqual(await drainOnly(armed), [], 'a pass picked up a wakeup held for its session\'s retry');
    assert.equal(await worker.deliver(held.id, armed, m.ownerId), 'HELD');
    assert.deepEqual((await oneShotsOf(armed)).map((row) => row.state), ['PENDING'], 'the held wakeup was dropped');

    // The retry brought the session back: the wakeup is delivered.
    await sql.query(
      `UPDATE "session" SET "status" = 'AWAITING_INPUT', "retry_at" = NULL, "cancel_requested_at" = NULL WHERE "id" = $1::uuid`,
      [armed],
    );
    assert.deepEqual(await drainOnly(armed), ['DELIVERED']);
    assert.deepEqual((await oneShotsOf(armed)).map((row) => row.state), ['DELIVERED']);

    const unarmed = await session(m);
    await schedule(m, unarmed, { delaySeconds: 60, reason: 'look at the deploy' });
    await failSession(unarmed);
    const [dropped] = await oneShotsOf(unarmed);
    assert.equal(await worker.deliver(dropped.id, unarmed, m.ownerId), 'DROPPED');
    assert.deepEqual((await oneShotsOf(unarmed)).map((row) => row.state), ['DROPPED']);
  });

  await t.test('OWNER_STOP: the composer\'s Stop ends the loop, while a plain interrupt only withdraws the tick it had queued', async () => {
    const m = await machine('stop');
    const id = await session(m, { status: RunStatus.RUNNING });
    // The session is working on a turn when the tick comes due.
    await db.conversationTurn.create({
      data: {
        sessionId: id, seq: 2, clientTurnId: randomUUID(), kind: 'message', content: 'migrate batch 7',
        status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    await schedule(m, id, { recurring: true, everySeconds: 60, prompt: 'advance the migration' });
    const loop = await loopOf(id);
    const queuedTick = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(queuedTick.id), 'DELIVERED');
    assert.ok((await turnsOf(id)).some((turn) => turn.clientTurnId === `bg-wake:wakeup:${queuedTick.id}` && turn.status === 'PENDING'));

    // A plain interrupt (session_interrupt, Esc): the queued tick goes with the rest of the queue, the loop stays.
    await sessions.interrupt(m.ownerId, id);
    assert.ok(!(await turnsOf(id)).some((turn) => turn.clientTurnId === `bg-wake:wakeup:${queuedTick.id}`), 'the queued tick survived the interrupt');
    assert.deepEqual(await statesOf(loop.id), ['CANCELLED', 'PENDING']);
    assert.equal((await loopOf(id)).state, 'ACTIVE', 'a plain interrupt ended the loop');
    const next = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(next.id), 'DELIVERED', 'the tick after a plain interrupt was not filed');

    // The composer's Stop: background work ends, the loop with it.
    await sessions.interrupt(m.ownerId, id, { stopBackgroundWork: true });
    const ended = await loopOf(id);
    assert.deepEqual([ended.state, ended.endedReason], ['ENDED', 'OWNER_STOP']);
    assert.ok(ended.endedAt);
    assert.equal(await pendingOf(loop.id), undefined, 'the Stop left a tick waiting');
    assert.deepEqual(await statesOf(loop.id), ['CANCELLED', 'CANCELLED', 'CANCELLED']);
  });

  await t.test('SESSION_ENDED: a tick that finds its session over ends the loop, for every way a session ends', async () => {
    const m = await machine('ended');
    const ways: Array<[string, Partial<Prisma.SessionUncheckedUpdateInput>]> = [
      ['ended by its owner (CANCELLED)', { status: RunStatus.CANCELLED, endReason: 'ended', finishedAt: new Date() }],
      ['moved to Completed', { completedAt: new Date() }],
      ['moved to Trash', { deletedAt: new Date() }],
      ['finished (SUCCEEDED)', { status: RunStatus.SUCCEEDED, finishedAt: new Date() }],
      ['being ended', { status: RunStatus.RUNNING, cancelRequestedAt: new Date() }],
    ];
    for (const [how, end] of ways) {
      const id = await session(m);
      await schedule(m, id, { recurring: true, everySeconds: 60, prompt: 'advance the migration' });
      await db.session.update({ where: { id }, data: end });
      const loop = await loopOf(id);
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'LOOP_ENDED', `a session ${how}`);
      const ended = await loopOf(id);
      assert.deepEqual([ended.state, ended.endedReason], ['ENDED', 'SESSION_ENDED'], `a session ${how}`);
      assert.ok(ended.endedAt, `a session ${how}: the loop does not say when it ended`);
      assert.deepEqual(await statesOf(loop.id), ['DROPPED'], `a session ${how}`);
      assert.equal((await turnsOf(id)).length, 0, `a session ${how} was woken`);
    }
  });

  await t.test('UNTIL_REACHED: the last tick is due at until, says it is the last, and ends the loop', async () => {
    const m = await machine('until');
    const id = await session(m);
    const until = new Date(Date.now() + 150_000);
    const receipt = await schedule(m, id, { recurring: true, everySeconds: 60, prompt: 'advance the migration', until: until.toISOString() });
    assert.equal(receipt.until, until.toISOString());
    const loop = await loopOf(id);
    for (const n of [1, 2]) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'DELIVERED', `tick ${n}`);
      await claim(m, id);
      await finishTurn(id);
    }
    const shifted = await loopOf(id);
    const last = (await pendingOf(loop.id))!;
    assert.equal(last.dueAt.getTime(), shifted.untilAt.getTime(), 'the last tick is not due at until');
    await makeDue(loop.id);
    assert.equal(await worker.deliverTick(last.id), 'DELIVERED');
    const ended = await loopOf(id);
    assert.deepEqual([ended.state, ended.endedReason, ended.ticksFired], ['ENDED', 'UNTIL_REACHED', 3]);
    assert.ok(ended.endedAt);
    assert.equal(await pendingOf(loop.id), undefined, 'a tick was written after the last one');
    const content = (await claim(m, id)).content;
    assert.ok(content.includes('loop: tick 3, every 60 seconds'), content);
    assert.ok(content.includes('this is its last tick: the loop has reached its until'), content);
    assert.ok(!content.includes('The loop goes on by itself'), `the last tick says the loop goes on:\n${content}`);
  });

  await t.test('a tick that cannot be filed waits for the next pass, and is counted missed once it is an interval late', async () => {
    const m = await machine('stuck');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 60, prompt: 'advance the migration' });
    const failing = Object.create(sessions) as SessionsService;
    failing.createTurn = async () => {
      throw new Error('the database went away mid-turn');
    };
    const flaky = new ScheduledWakeupWorker(prisma, failing);
    const loop = await loopOf(id);
    const tick = await makeDue(loop.id);
    await assert.rejects(flaky.deliverTick(tick.id), /the database went away/);
    assert.deepEqual(await statesOf(loop.id), ['PENDING'], 'a tick that could not be filed was settled before it was late');

    await makeDue(loop.id, 90);
    assert.equal(await flaky.deliverTick(tick.id), 'MISSED');
    assert.deepEqual(await statesOf(loop.id), ['DROPPED', 'PENDING'], 'the late tick held its loop up');
    const after = await loopOf(id);
    // The tick itself, and the due time a minute after it that also passed.
    assert.deepEqual([after.state, after.ticksMissed], ['ACTIVE', 2], JSON.stringify(after));
    const next = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(next.id), 'DELIVERED', 'the loop did not go on once filing worked again');
  });

  await t.test('the runner door clamps what is out of bounds and says so, and refuses a loop that cannot be what was asked', async () => {
    const m = await machine('door');
    const id = await session(m);
    const errorsOf = async (body: Record<string, unknown>) =>
      (await validate(plainToInstance(ScheduledWakeupDto, body), { whitelist: true })).map((error) => error.property);
    assert.deepEqual(await errorsOf({ recurring: true, everySeconds: 300, prompt: 'p' }), [], 'a loop needs neither a delay nor a reason');
    assert.deepEqual(await errorsOf({ recurring: true, prompt: 'p' }), ['everySeconds']);
    assert.deepEqual(await errorsOf({ recurring: true, everySeconds: 300, prompt: 'p', until: 'next tuesday' }), ['until']);
    assert.deepEqual(await errorsOf({ delaySeconds: 60 }), ['reason'], 'a one-shot wakeup still needs its reason');
    assert.deepEqual(await errorsOf({ reason: 'r' }), ['delaySeconds'], 'a one-shot wakeup still needs its delay');
    assert.deepEqual(await errorsOf({ stop: true }), []);

    const fast = await schedule(m, id, { recurring: true, everySeconds: 10, prompt: 'p' });
    assert.deepEqual([fast.everySeconds, fast.delaySeconds, fast.clamped, fast.clampedFrom], [60, 60, true, { everySeconds: 10 }]);
    const asked = new Date(Date.now() + 60 * 86_400_000).toISOString();
    const slow = await schedule(m, id, { recurring: true, everySeconds: 100_000, delaySeconds: 30, prompt: 'p', until: asked });
    assert.deepEqual([slow.everySeconds, slow.delaySeconds, slow.clamped, slow.replaced], [86_400, 60, true, true]);
    assert.deepEqual(slow.clampedFrom, { everySeconds: 100_000, delaySeconds: 30, until: asked });
    const untilIn = new Date(slow.until).getTime() - Date.now();
    assert.ok(Math.abs(untilIn - 30 * 86_400_000) < 60_000, `until was clamped to ${slow.until}, not thirty days out`);

    const loopsBefore = (await loopsOf(id)).length;
    for (const [refused, body] of [
      ['no prompt', { recurring: true, everySeconds: 300 }],
      ['until before the first tick', { recurring: true, everySeconds: 300, prompt: 'p', until: new Date(Date.now() + 60_000).toISOString() }],
      ['a loop\'s fields without recurring', { delaySeconds: 60, reason: 'r', everySeconds: 300 }],
    ] as const) {
      await assert.rejects(schedule(m, id, body), BadRequestException, refused);
    }
    assert.equal((await loopsOf(id)).length, loopsBefore, 'a refused request wrote a loop');
    assert.equal((await loopOf(id)).state, 'ACTIVE', 'a refused request ended the running loop');
  });

  // Every loop below ticks every 400 seconds, so its silence limit — max(2 × 400 s, 15 minutes) = 900 s — falls
  // between two of its ticks, 100 seconds after one and 300 before the next, wherever the run being counted
  // from was handed out within the second each tick is late.

  await t.test('a silent loop tells its owner once per silence: not before max(2 × every, 15 minutes) without a run, never twice for one, and again after it has run', async () => {
    // The limit: two intervals, and never under 15 minutes.
    assert.deepEqual(
      [60, 400, 450, 600, 3_600].map(loopSilenceLimitMs),
      [900_000, 900_000, 900_000, 1_200_000, 7_200_000],
    );
    const { worker: signalling, rang } = signallingWorker();
    const m = await machine('silent');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 400, prompt: 'advance the archive migration by one batch', reason: 'the archive migration' });
    const loop = await loopOf(id);

    // Tick 1 runs: filed, handed to the engine, answered.
    let tick = await elapse(loop.id, id);
    assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED');
    await claim(m, id);
    await finishTurn(id);

    // The runner goes away. Ticks 2 and 3 go onto one queued turn nobody takes: 400 and 800 seconds without a
    // run are under the limit.
    await goOffline(m);
    for (const n of [2, 3]) {
      tick = await elapse(loop.id, id);
      assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED', `tick ${n}`);
      assert.equal(rang.length, 0, `tick ${n}, ${(n - 1) * 400} seconds after the last run, alerted`);
    }
    // Tick 4, 1200 seconds after it: silent. One push, with how many due times have not run and why.
    tick = await elapse(loop.id, id);
    assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED');
    assert.equal(rang.length, 1, 'a silent loop did not alert');
    const first = loopAlertOf(rang[0]);
    assert.equal((await loopOf(id)).alertedAt?.getTime(), first.alertedAt.getTime(), 'the push is not for the alert the loop recorded');
    assert.deepEqual(
      [rang[0].ownerId, rang[0].sessionId, rang[0].title, first.loopId, first.ticks, rang[0].reason],
      [m.ownerId, id, 'an archive migration that runs for days', loop.id, 3, 'RUNNER_OFFLINE'],
    );
    // The same silence goes on: nothing more is said, and the alert stays where it was.
    for (const n of [5, 6]) {
      tick = await elapse(loop.id, id);
      assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED', `tick ${n}`);
    }
    assert.equal(rang.length, 1, 'one silence alerted twice');
    assert.ok((await loopOf(id)).alertedAt, 'the alert went while the silence lasted');

    // The runner is back and the queued turn runs: it tells the agent how many due times did not run.
    await goOnline(m);
    const { content } = await claim(m, id);
    assert.ok(content.includes('loop: tick 6, every 400 seconds'), content);
    assert.ok(content.includes('4 ticks missed since the last run'), content);
    await finishTurn(id);
    // The next tick finds the loop running again: the alert is cleared, and nothing is said.
    tick = await elapse(loop.id, id);
    assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED');
    assert.equal((await loopOf(id)).alertedAt, null, 'a run after the alert left it standing');
    assert.equal(rang.length, 1);
    await claim(m, id);
    await finishTurn(id);

    // A second silence: the session FAILED with its retry armed an hour out, so its ticks are skipped. The third
    // after the last run tells the owner again, this time that the session failed.
    await failSession(id, new Date(Date.now() + 3_600_000));
    for (const n of [8, 9]) {
      tick = await elapse(loop.id, id);
      assert.equal(await signalling.deliverTick(tick.id), 'MISSED', `tick ${n}`);
    }
    assert.equal(rang.length, 1, 'a second silence alerted before the limit');
    tick = await elapse(loop.id, id);
    assert.equal(await signalling.deliverTick(tick.id), 'MISSED');
    assert.equal(rang.length, 2, 'a silence after the loop ran again did not alert');
    const second = loopAlertOf(rang[1]);
    assert.equal((await loopOf(id)).alertedAt?.getTime(), second.alertedAt.getTime());
    assert.deepEqual([rang[1].sessionId, second.loopId, second.ticks, rang[1].reason], [id, loop.id, 3, 'SESSION_FAILED']);
  });

  await t.test('a busy session is not a silent loop: nothing is said while its turn runs on a runner that is there, and the alert comes once that runner is gone', async () => {
    const { worker: signalling, rang } = signallingWorker();
    const m = await machine('busy');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 400, prompt: 'advance the archive migration by one batch' });
    const loop = await loopOf(id);

    // Tick 1's turn is handed to the engine and runs long: the ticks after it queue behind it, the last of
    // them 1600 seconds after it was handed out, well past the limit.
    let tick = await elapse(loop.id, id);
    assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED');
    await claim(m, id);
    for (const n of [2, 3, 4, 5]) {
      tick = await elapse(loop.id, id);
      assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED', `tick ${n}`);
    }
    assert.equal((await sessionRow(id)).status, RunStatus.RUNNING);
    assert.equal(rang.length, 0, 'a loop queued behind a turn that is still running alerted');
    assert.equal((await loopOf(id)).alertedAt, null);

    // The runner running that turn goes away: the turn is not running anywhere any more, and the loop is silent.
    await goOffline(m);
    tick = await elapse(loop.id, id);
    assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED');
    assert.equal(rang.length, 1, 'a turn on a runner that is gone held the alert back');
    assert.deepEqual([loopAlertOf(rang[0]).ticks, rang[0].reason], [5, 'RUNNER_OFFLINE']);
  });

  await t.test('a loop that never ran is silent from its start, a turn nobody hands out is said to be queued, and a loop whose session ended is over, not silent', async () => {
    const { worker: signalling, rang } = signallingWorker();
    const m = await machine('queued');
    const id = await session(m);
    await schedule(m, id, { recurring: true, everySeconds: 400, prompt: 'advance the archive migration by one batch' });
    const loop = await loopOf(id);

    // The runner is there, but the turn tick 1 opened is never handed out; tick 2 joins it, 800 seconds in.
    for (const n of [1, 2]) {
      const tick = await elapse(loop.id, id);
      assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED', `tick ${n}`);
    }
    assert.equal(rang.length, 0, 'a loop 800 seconds old alerted');
    const tick = await elapse(loop.id, id);
    assert.equal(await signalling.deliverTick(tick.id), 'DELIVERED');
    assert.equal(rang.length, 1, 'a loop that never ran in 1200 seconds did not alert');
    assert.deepEqual([loopAlertOf(rang[0]).ticks, rang[0].reason], [3, 'TURN_QUEUED']);

    // Just as silent, but its owner ended the session: the tick ends the loop and says nothing.
    const over = await session(m);
    await schedule(m, over, { recurring: true, everySeconds: 400, prompt: 'advance the archive migration by one batch' });
    const overLoop = await loopOf(over);
    for (const n of [1, 2]) {
      const filed = await elapse(overLoop.id, over);
      assert.equal(await signalling.deliverTick(filed.id), 'DELIVERED', `tick ${n} of the loop whose session ends`);
    }
    await db.session.update({ where: { id: over }, data: { status: RunStatus.CANCELLED, endReason: 'ended', finishedAt: new Date() } });
    const last = await elapse(overLoop.id, over);
    assert.equal(await signalling.deliverTick(last.id), 'LOOP_ENDED');
    assert.equal(rang.length, 1, 'a loop that ended with its session was told as silent');
  });

  await t.test('a one-shot wakeup dropped with its FAILED session tells the owner, once; held for an armed retry, or dropped with a session that ended, it says nothing', async () => {
    const { worker: signalling, rang } = signallingWorker();
    const m = await machine('dropped');

    const failed = await session(m);
    await schedule(m, failed, { delaySeconds: 60, reason: 'look at the deploy' });
    await failSession(failed);
    const [dropped] = await oneShotsOf(failed);
    assert.equal(await signalling.deliver(dropped.id, failed, m.ownerId), 'DROPPED');
    assert.deepEqual(rang, [{
      ownerId: m.ownerId,
      sessionId: failed,
      title: 'an archive migration that runs for days',
      missed: { wakeupId: dropped.id },
      reason: 'SESSION_FAILED',
    }]);
    // Another pass reaching the same wakeup finds it settled, and says nothing more.
    assert.equal(await signalling.deliver(dropped.id, failed, m.ownerId), 'SETTLED_ELSEWHERE');
    assert.equal(rang.length, 1, 'one dropped wakeup alerted twice');

    const armed = await session(m);
    await schedule(m, armed, { delaySeconds: 60, reason: 'look at the deploy' });
    await failSession(armed, new Date(Date.now() + 10 * 60_000));
    const [held] = await oneShotsOf(armed);
    assert.equal(await signalling.deliver(held.id, armed, m.ownerId), 'HELD');

    const ways: Array<[string, Partial<Prisma.SessionUncheckedUpdateInput>]> = [
      ['ended by its owner (CANCELLED)', { status: RunStatus.CANCELLED, endReason: 'ended', finishedAt: new Date() }],
      ['FAILED and moved to Completed', { status: RunStatus.FAILED, finishedAt: new Date(), completedAt: new Date() }],
    ];
    for (const [how, end] of ways) {
      const id = await session(m);
      await schedule(m, id, { delaySeconds: 60, reason: 'look at the deploy' });
      await db.session.update({ where: { id }, data: end });
      const [wakeup] = await oneShotsOf(id);
      assert.equal(await signalling.deliver(wakeup.id, id, m.ownerId), 'DROPPED', `a session ${how}`);
    }
    assert.equal(rang.length, 1, 'a held wakeup, or one dropped with a session that ended, alerted');
  });

  // session_get (contract §3). Every turn time below is read through Prisma, which reads the zoneless
  // `delivered_at` as the product does.

  await t.test('session_get tells when the loop fires next, when a tick last reached the engine and how many it missed: a tick filed onto a turn nobody has taken leaves lastFiredAt where it was', async () => {
    const m = await machine('truth');
    const id = await session(m);
    assert.deepEqual(await wakeupsOf(m, id), { next: null, lastFiredAt: null, loop: null }, 'a session that never asked for a wakeup');

    const receipt = await schedule(m, id, { recurring: true, everySeconds: 120, prompt: 'check the queue depth', reason: 'the drain' });
    assert.deepEqual(await wakeupsOf(m, id), {
      next: { dueAt: receipt.dueAt, kind: 'LOOP_TICK', reason: 'the drain' },
      lastFiredAt: null,
      loop: {
        state: 'ACTIVE', everySeconds: 120, until: receipt.until, nextDueAt: receipt.dueAt, lastFiredAt: null,
        ticksFired: 0, ticksMissed: 0, endedReason: null, endedAt: null,
      },
    }, 'a loop that has not ticked yet');
    const loop = await loopOf(id);

    // Tick 1 is filed as a turn of its own, and nobody has been handed that turn yet: it has not fired.
    const first = await makeDue(loop.id);
    assert.equal(await worker.deliverTick(first.id), 'DELIVERED');
    let wakeups = await wakeupsOf(m, id);
    assert.equal(wakeups.lastFiredAt, null, 'a tick on a turn the engine was never handed counts as fired');
    assert.equal(wakeups.loop.lastFiredAt, null, 'a tick on a turn the engine was never handed counts as the loop\'s run');
    assert.deepEqual([wakeups.loop.ticksFired, wakeups.loop.ticksMissed], [1, 0]);
    const second = (await pendingOf(loop.id))!;
    assert.deepEqual(wakeups.next, { dueAt: second.dueAt.toISOString(), kind: 'LOOP_TICK', reason: 'the drain' });
    assert.equal(wakeups.loop.nextDueAt, second.dueAt.toISOString());
    assert.equal(wakeups.loop.until, (await loopOf(id)).untilAt.toISOString());

    // The runner takes it: it fired when the turn was handed out, and that is the run the dead-man signal counts from.
    await claim(m, id);
    const [ran] = await turnsOf(id);
    assert.ok(ran.deliveredAt, 'the claim did not hand the turn out');
    wakeups = await wakeupsOf(m, id);
    assert.equal(wakeups.lastFiredAt, ran.deliveredAt.toISOString());
    assert.equal(wakeups.loop.lastFiredAt, ran.deliveredAt.toISOString());
    assert.equal(wakeups.loop.lastFiredAt, (await lastLoopRun(prisma, loop.id))?.deliveredAt.toISOString());
    await finishTurn(id);

    // The runner goes away. Ticks 2 and 3 are filed onto one queued turn that nobody takes: the loop counts one
    // more run and one missed tick, and its last firing is still tick 1's.
    await goOffline(m);
    for (const n of [2, 3]) {
      const tick = await makeDue(loop.id);
      assert.equal(await worker.deliverTick(tick.id), 'DELIVERED', `tick ${n}`);
    }
    assert.equal((await turnsOf(id))[1]?.deliveredAt, null, 'the turn ticks 2 and 3 are on was handed out');
    wakeups = await wakeupsOf(m, id);
    assert.equal(wakeups.lastFiredAt, ran.deliveredAt.toISOString(), 'ticks queued while the runner was away moved lastFiredAt');
    assert.equal(wakeups.loop.lastFiredAt, ran.deliveredAt.toISOString(), 'ticks queued while the runner was away moved the loop\'s lastFiredAt');
    assert.deepEqual([wakeups.loop.ticksFired, wakeups.loop.ticksMissed], [2, 1]);
    const fourth = (await pendingOf(loop.id))!;
    assert.deepEqual(wakeups.next, { dueAt: fourth.dueAt.toISOString(), kind: 'LOOP_TICK', reason: 'the drain' });
    assert.equal(wakeups.loop.state, 'ACTIVE');

    // The runner is back and takes the queued turn: that is the loop's last firing now.
    await goOnline(m);
    await claim(m, id);
    const resumed = (await turnsOf(id))[1];
    assert.ok(resumed.deliveredAt, 'the claim did not hand the queued turn out');
    assert.ok(resumed.deliveredAt.getTime() > ran.deliveredAt.getTime());
    wakeups = await wakeupsOf(m, id);
    assert.equal(wakeups.lastFiredAt, resumed.deliveredAt.toISOString());
    assert.equal(wakeups.loop.lastFiredAt, resumed.deliveredAt.toISOString());
    assert.equal(wakeups.loop.lastFiredAt, (await lastLoopRun(prisma, loop.id))?.deliveredAt.toISOString());
  });

  await t.test('session_get\'s next is whichever wakeup is due first; a one-shot wakeup\'s run is the session\'s last firing and not the loop\'s; an ended loop says why and when', async () => {
    const m = await machine('truth-beside');
    const id = await session(m);
    const started = await schedule(m, id, { recurring: true, everySeconds: 600, prompt: 'advance the migration' });
    const once = await schedule(m, id, { delaySeconds: 60, reason: 'check CI run 4242' });
    let wakeups = await wakeupsOf(m, id);
    assert.deepEqual(wakeups.next, { dueAt: once.dueAt, kind: 'ONE_SHOT', reason: 'check CI run 4242' }, 'the wakeup due in a minute is not the next one');
    assert.equal(wakeups.loop.nextDueAt, started.dueAt, 'the loop\'s waiting tick is not its own');

    // The one-shot wakeup comes due, and its turn is handed out.
    const [waiting] = await oneShotsOf(id);
    await sql.query(`UPDATE "session_scheduled_wakeup" SET "due_at" = clock_timestamp() - interval '2 seconds' WHERE "id" = $1::uuid`, [waiting.id]);
    assert.equal(await worker.deliver(waiting.id, id, m.ownerId), 'DELIVERED');
    await claim(m, id);
    const [woke] = await turnsOf(id);
    assert.ok(woke.deliveredAt, 'the claim did not hand the turn out');
    wakeups = await wakeupsOf(m, id);
    assert.equal(wakeups.lastFiredAt, woke.deliveredAt.toISOString(), 'the one-shot wakeup\'s run is not the session\'s last firing');
    assert.equal(wakeups.loop.lastFiredAt, null, 'a one-shot wakeup\'s run was counted as the loop\'s');
    // The loop's tick is next now. The loop was given no reason, so it shows none.
    assert.deepEqual(wakeups.next, { dueAt: started.dueAt, kind: 'LOOP_TICK', reason: null });
    await finishTurn(id);

    // A stop ends the loop: it says why and when, it has no tick waiting, and nothing is next.
    await schedule(m, id, { stop: true });
    const ended = await loopOf(id);
    assert.ok(ended.endedAt);
    assert.deepEqual(await wakeupsOf(m, id), {
      next: null,
      lastFiredAt: woke.deliveredAt.toISOString(),
      loop: {
        state: 'ENDED', everySeconds: 600, until: started.until, nextDueAt: null, lastFiredAt: null,
        ticksFired: 0, ticksMissed: 0, endedReason: 'REQUESTED', endedAt: ended.endedAt.toISOString(),
      },
    }, 'a stopped loop');

    // A loop started after it is the one shown.
    const again = await schedule(m, id, { recurring: true, everySeconds: 300, prompt: 'advance the migration again', reason: 'the second pass' });
    wakeups = await wakeupsOf(m, id);
    assert.deepEqual(wakeups.next, { dueAt: again.dueAt, kind: 'LOOP_TICK', reason: 'the second pass' });
    assert.deepEqual(wakeups.loop, {
      state: 'ACTIVE', everySeconds: 300, until: again.until, nextDueAt: again.dueAt, lastFiredAt: null,
      ticksFired: 0, ticksMissed: 0, endedReason: null, endedAt: null,
    }, 'the loop shown is not the newest');
  });
});
