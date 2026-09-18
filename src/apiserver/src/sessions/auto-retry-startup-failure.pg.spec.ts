/**
 * A TURN THAT PRODUCED NOTHING IS ONE THE SERVER CAN UNDO BY ITSELF.
 *
 * On 2026-09-17 a session's opening question was eaten by an engine that never came up: it was
 * spawned with `--resume` on a conversation that was never opened, printed `No conversation found
 * with session ID`, and the turn came back through /turn-complete as `error_during_execution` with
 * numTurns 0 and costUsd 0. The control plane put the question back in the queue (that is
 * `turn-complete-unanswered.pg.spec.ts`'s half) — and then nothing ever handed it to a runtime
 * again: `retry_at` was null and `retry_attempts` 0, because the auto-retry ladder only armed for a
 * spent quota and for a provider that said it was overloaded. The person's message sat in the queue
 * of a session nothing was going to start.
 *
 * WHY THIS IS THE SAME RETRY, NOT A THIRD ONE
 * -------------------------------------------
 * `auto-retry.service` already waits out a failure and re-sends the message: one sweeper, one
 * `retry_at`, one `BACKOFF_MS`, one release. What this adds is a class of failure to ARM for and
 * the ladder to arm it with — `nextAutoRetryAt`, the same list the sweep gives up after. No scan of
 * its own, no new column, no new state, and the release is left exactly as the other three classes
 * find it.
 *
 * The wait is asserted against the code's own `BACKOFF_MS` throughout — the cases below state
 * "the step this ladder is on", never a number of seconds, so a ladder that changes does not leave
 * a spec behind claiming the old schedule.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/auto-retry-startup-failure.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { AutoRetryService, BACKOFF_MS } from './auto-retry.service';
import { SESSION_RUNNER_OFFLINE_AFTER_MS } from './session-state';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;

/**
 * The ladder is `BACKOFF_MS`, imported from the service rather than restated here — these cases
 * state "the step this ladder is on", never a number of seconds. A spec holding its own copy of
 * the schedule could not tell whether ARMING and RELEASING agree on one, which is half of what it
 * is here to witness; and `BACKOFF_MS.length` is the cap for the same reason.
 */

/** The incident's report, byte for byte: an engine that stopped without saying anything. */
const ENGINE_NEVER_CAME_UP = {
  status: SharedRunStatus.INTERRUPTED,
  subtype: 'error_during_execution',
  numTurns: 0,
  costUsd: 0,
} as const;

interface Harness {
  db: PrismaClient;
  api: RunnerApiController;
  autoRetry: AutoRetryService;
  sql: Client;
  /** One owner, one runner, and a session RUNNING with its opening turn out on delivery. */
  fixture(label: string, opts?: { retryAttempts?: number; dispatchHold?: boolean }): Promise<Fixture>;
  /** What the sweep looks at, read back over a connection nothing else uses. */
  armOf(sessionId: string): Promise<{ retryAt: Date | null; attempts: number; status: string }>;
  /** A runner that is alive at the instant the sweep is handed. */
  heartbeatAt(runnerId: string, at: Date): Promise<void>;
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  sessionId: string;
  turnId: string;
  clientTurnId: string;
}

function connect(url: string): Harness {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = {
    publish: () => undefined,
    publishSessionUpdated: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
    notifyInbox: () => undefined,
  } as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    // #references are expanded on the way out of the inbox; nothing here is about what is written
    // into the message.
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );

  return {
    db,
    api,
    autoRetry: new AutoRetryService(prisma, sessions, realtime),
    sql,
    async fixture(label, opts) {
      const ownerId = randomUUID();
      const runnerId = randomUUID();
      const workspaceId = randomUUID();
      const sessionId = randomUUID();
      await db.user.create({
        data: {
          id: ownerId,
          email: `${label}-${ownerId}@startup-failure.invalid`,
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
      // The list pause, when a case wants one: a task whose work this session is doing.
      let taskId: string | null = null;
      if (opts?.dispatchHold !== undefined) {
        taskId = randomUUID();
        await db.task.create({
          data: {
            id: taskId,
            ownerId,
            assigneeId: workspaceId,
            title: `${label} 的任务`,
            creatorType: 'AGENT',
            creatorId: workspaceId,
            provider: 'claude',
            status: 'OPEN',
            completionCriterion: 'EVIDENCE_JUDGMENT',
            dispatchHold: opts.dispatchHold,
          } as never,
        });
      }
      await db.session.create({
        data: {
          id: sessionId,
          ownerId,
          creatorId: ownerId,
          workspaceId,
          assignedRunnerId: runnerId,
          ...(taskId ? { taskId, startsTaskWork: true } : {}),
          title: `${label} 的会话`,
          prompt: '把这两张图里的报错讲清楚',
          provider: 'claude',
          status: RunStatus.RUNNING,
          engineTurnActive: true,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startedAt: new Date(),
          runtimeSessionId: randomUUID(),
          retryAttempts: opts?.retryAttempts ?? 0,
        },
      });
      // The person's opening message, out on a delivery — the row /turn-complete is about.
      const clientTurnId = `initial-${sessionId}`;
      const turn = await db.conversationTurn.create({
        data: {
          sessionId,
          seq: 1,
          clientTurnId,
          kind: 'message',
          content: '把这两张图里的报错讲清楚',
          status: 'IN_FLIGHT',
          deliveredAt: new Date(),
          leaseDeadlineAt: new Date(Date.now() + 300_000),
          leaseGeneration: randomUUID(),
        },
        select: { id: true },
      });
      await api.events({ id: runnerId }, sessionId, {
        events: [{
          seq: 1,
          type: RunEventType.USER,
          ts: new Date().toISOString(),
          turnId: turn.id,
          payload: { text: '把这两张图里的报错讲清楚' },
        }],
      });
      return { ownerId, runnerId, sessionId, turnId: turn.id, clientTurnId };
    },
    async armOf(sessionId) {
      // Read back through Prisma rather than the raw driver, and that is not a convenience:
      // `retry_at` is a naive timestamp column, so the driver parses it in the connection's own
      // timezone while the service (and every other writer) spells instants in UTC. Comparing a
      // raw read against `Date.now()` measures the two spellings against each other, not the wait
      // this service armed — which is the trap the dispatch-hold spec's own comment names.
      const row = await db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { retryAt: true, retryAttempts: true, status: true },
      });
      return { retryAt: row.retryAt, attempts: row.retryAttempts, status: row.status };
    },
    async heartbeatAt(runnerId, at) {
      // A runner that is up at the instant the sweep is handed: the sweep refuses to release a
      // retry into a machine it cannot see (RUNNER_OFFLINE), and these cases are about the ladder.
      // Half the window the service's own liveness check allows, so this stays a runner it can see
      // whatever that window is set to. An absolute instant in, so Prisma reads back the one meant.
      await sql.query(
        `UPDATE "runner" SET last_heartbeat_at = $2::timestamptz - ($3 || ' milliseconds')::interval
          WHERE id = $1::uuid`,
        [runnerId, at.toISOString(), String(SESSION_RUNNER_OFFLINE_AFTER_MS / 2)],
      );
    },
  };
}

/** What the runners' own inbox does with a turn: hands it over, out on a lease. */
function poll(h: Harness, f: Fixture) {
  return (
    h.api as unknown as {
      dequeueTurn: (
        sessionId: string, runnerId: string, leaseGeneration: string | null,
      ) => Promise<{ turnId: string; content?: string } | null>;
    }
  ).dequeueTurn.call(h.api, f.sessionId, f.runnerId, null);
}

/**
 * The turn_end the runner emits for a turn that ended saying nothing — the event both clients
 * render as the visible failure, and the only record of why the turn stopped. The runner flushes
 * its events before it reports the turn, so it lands before /turn-complete, exactly as here.
 */
function engineReportedItEnded(
  h: Harness,
  f: Fixture,
  turnId: string,
  seq: number,
  leaseOwner?: string | null,
) {
  return h.api.events({ id: f.runnerId }, f.sessionId, {
    events: [{
      seq,
      type: RunEventType.TURN_END,
      ts: new Date().toISOString(),
      turnId,
      payload: { subtype: ENGINE_NEVER_CAME_UP.subtype, numTurns: 0, costUsd: 0 },
    }],
    leaseOwner,
  } as never);
}

/** What the runner's own door does once it has given up on the run. */
function runnerGaveUp(h: Harness, f: Fixture, leaseOwner?: string | null) {
  return h.api.finalize({ id: f.runnerId }, f.sessionId, {
    status: SharedRunStatus.FAILED,
    error: 'No conversation found with session ID',
    leaseOwner,
  } as never);
}

/**
 * What a claim plus a lease activation leaves: a running session whose inbox this runner owns.
 *
 * The two write two different things and both matter here. The status is what the inbox's own
 * executable-turn clause requires, and the owner is what every later call from that runner is
 * checked against — a revived session is handed to its runner under a reserved handoff owner
 * (sessions.service), so the process that takes it must present the owner it now holds, exactly as
 * `activate-leases` does on the wire.
 */
async function claimed(h: Harness, sessionId: string): Promise<void> {
  await h.sql.query(
    `UPDATE "session" SET status = 'RUNNING', inbox_lease_owner = gen_random_uuid()
      WHERE id = $1::uuid`,
    [sessionId],
  );
}

/** The lease this session's inbox is owned by — what the runner running it presents. */
async function leaseOf(h: Harness, sessionId: string): Promise<string | null> {
  const r = await h.sql.query(
    `SELECT inbox_lease_owner FROM "session" WHERE id = $1::uuid`, [sessionId]);
  return (r.rows[0]?.inbox_lease_owner as string | null) ?? null;
}

/** Every executable turn this session still has queued, oldest first. */
async function queuedTurns(h: Harness, sessionId: string): Promise<Array<{
  id: string; status: string; client_turn_id: string; content: string | null;
}>> {
  const r = await h.sql.query(
    `SELECT id, status, client_turn_id, content FROM "conversation_turn"
      WHERE session_id = $1::uuid AND kind IN ('message','shell') AND status = 'PENDING'
      ORDER BY seq`,
    [sessionId],
  );
  return r.rows;
}

/** The instant an arm sits at, as a distance from the moment the failure was reported. */
function waitOf(arm: Date, reportedAt: number): number {
  return arm.getTime() - reportedAt;
}

test('a failure that produced nothing enters the auto-retry ladder', {
  skip: URL ? false : 'set COORDINATOR_PG_URL to run the startup-failure suite',
  concurrency: 1,
  timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const h = connect(url);
  await h.sql.connect();
  await verifyCoordinatorPgIdentity(h.sql);
  t.after(async () => {
    await h.db.$disconnect().catch(() => undefined);
    await h.sql.end().catch(() => undefined);
  });

  await t.test('(1) the incident: an engine that never came up is armed, not left waiting', async () => {
    const f = await h.fixture('incident');
    await engineReportedItEnded(h, f, f.turnId, 2);
    const before = Date.now();
    await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, ...ENGINE_NEVER_CAME_UP,
    });

    const arm = await h.armOf(f.sessionId);
    assert.ok(arm.retryAt instanceof Date,
      'a failure the server can undo itself must say when it comes back');
    const wait = waitOf(arm.retryAt, before);
    assert.ok(wait >= BACKOFF_MS[0] && wait <= BACKOFF_MS[0] * 1.5,
      `expected the first step of the ladder, got ${wait}ms`);
    assert.equal(arm.attempts, 0,
      'arming is not spending: the sweep owns the count (it spends one on each release)');

    // The other half, and the reason this class is one the ladder may arm at all: nothing was
    // answered, so the person is still owed a reply and their message is owed another delivery.
    const turn = await h.sql.query(
      `SELECT status FROM "conversation_turn" WHERE id = $1::uuid`, [f.turnId]);
    assert.notEqual(turn.rows[0].status, 'ANSWERED',
      'the same invariant turn-complete-unanswered pins: no answer, no ANSWERED');
  });

  await t.test('(2) the same report over a turn the engine spoke in arms nothing', async () => {
    const f = await h.fixture('spoken');
    await h.api.events({ id: f.runnerId }, f.sessionId, {
      events: [{
        seq: 2, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId: f.turnId,
        payload: { text: '两张图都是同一个 401。' },
      }],
    });
    await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, ...ENGINE_NEVER_CAME_UP,
    });

    const arm = await h.armOf(f.sessionId);
    assert.equal(arm.retryAt, null,
      'the engine spoke, so this failure is not the one with nothing to lose by re-sending');
  });

  await t.test('(3) a turn the person stopped arms nothing', async () => {
    const f = await h.fixture('stopped');
    // Stop pressed before the engine had said anything: numTurns 0 and costUsd 0 too, and no
    // assistant text either. Re-running what somebody just stopped is the one thing a retry must
    // never do, and that is decided by the interrupt event rather than by the counters.
    await h.api.events({ id: f.runnerId }, f.sessionId, {
      events: [{
        seq: 2, type: RunEventType.INTERRUPT, ts: new Date().toISOString(), turnId: f.turnId,
        payload: { requestId: randomUUID() },
      }],
    });
    await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, ...ENGINE_NEVER_CAME_UP,
    });

    assert.equal((await h.armOf(f.sessionId)).retryAt, null,
      'what the person withdrew is not a failure to retry');
  });

  await t.test('(4) each failure arms the step the ladder is on', async () => {
    for (const attempts of [1, BACKOFF_MS.length - 1]) {
      const f = await h.fixture(`step-${attempts}`, { retryAttempts: attempts });
      const before = Date.now();
      await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
        turnId: f.turnId, ...ENGINE_NEVER_CAME_UP,
      });

      const arm = await h.armOf(f.sessionId);
      const wait = waitOf(arm.retryAt!, before);
      assert.ok(wait >= BACKOFF_MS[attempts] && wait <= BACKOFF_MS[attempts] * 1.5,
        `with ${attempts} attempts spent, expected step ${attempts}, got ${wait}ms`);
      assert.equal(arm.attempts, attempts, 'and the count is the sweep\'s to move, not this path\'s');
    }
  });

  await t.test('(5) the last step is spent, and the failure is what is left', async () => {
    const f = await h.fixture('spent', { retryAttempts: BACKOFF_MS.length - 1 });
    await engineReportedItEnded(h, f, f.turnId, 2);
    const before = Date.now();
    await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, ...ENGINE_NEVER_CAME_UP,
    });

    // The last rung of the ladder is still a rung: this failure is armed for it...
    const last = await h.armOf(f.sessionId);
    const wait = waitOf(last.retryAt!, before);
    assert.ok(wait >= BACKOFF_MS[BACKOFF_MS.length - 1] && wait <= BACKOFF_MS[BACKOFF_MS.length - 1] * 1.5,
      `expected the last step of the ladder, got ${wait}ms`);

    await runnerGaveUp(h, f);
    const at = new Date(last.retryAt!.getTime() + 1_000);
    await h.heartbeatAt(f.runnerId, at);
    await h.autoRetry.sweep(at);
    assert.equal((await h.armOf(f.sessionId)).attempts, BACKOFF_MS.length,
      'the release spends the last attempt there is');

    // ...and the failure that comes back from it is armed no further. Past the last step a
    // countdown would be a promise the next sweep has to disarm again, on a message that has
    // produced nothing every single time it was sent.
    await claimed(h, f.sessionId);
    const lease = await leaseOf(h, f.sessionId);
    const again = await poll(h, f);
    await engineReportedItEnded(h, f, again?.turnId ?? f.turnId, 3, lease);
    await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: again?.turnId ?? f.turnId, leaseOwner: lease, ...ENGINE_NEVER_CAME_UP,
    } as never);

    const spent = await h.armOf(f.sessionId);
    assert.equal(spent.retryAt, null,
      'no further retry is armed once the ladder has nothing left to offer');
    assert.equal(spent.attempts, BACKOFF_MS.length, 'and nothing is spent on an arm never written');

    // What the person is left with: the failure, still theirs to see and act on. The marker is the
    // turn_end the clients render (both read the failure subtype), and it is durable under the turn
    // — the arms that ran out are not what says the run failed.
    const events = await h.sql.query(
      `SELECT payload -> 'subtype' AS subtype FROM "run_event"
        WHERE session_id = $1::uuid AND type = 'turn_end'
        ORDER BY seq`,
      [f.sessionId]);
    assert.deepEqual(events.rows.map((r) => r.subtype),
      [ENGINE_NEVER_CAME_UP.subtype, ENGINE_NEVER_CAME_UP.subtype],
      'the turn\'s own report of why it ended is still there to be drawn');
  });

  await t.test('(6) the sweep spends a step and the message goes back out — once', async () => {
    const f = await h.fixture('released');
    await engineReportedItEnded(h, f, f.turnId, 2);
    await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, ...ENGINE_NEVER_CAME_UP,
    });
    // ...and the runner gives up on the run, which is where the incident's session ended up: that
    // is the parked shape the sweep releases, and it leaves the arm this failure wrote standing.
    await runnerGaveUp(h, f);
    const armed = await h.armOf(f.sessionId);
    assert.equal(armed.status, 'FAILED', 'the run the runtime refused is reported as failed');
    assert.ok(armed.retryAt instanceof Date, 'with the retry it was armed with still standing');

    // The sweep the arm exists for, run at the instant it fires.
    const at = new Date(armed.retryAt!.getTime() + 1_000);
    await h.heartbeatAt(f.runnerId, at);
    await h.autoRetry.sweep(at);

    const after = await h.armOf(f.sessionId);
    assert.equal(after.attempts, 1, 'the release spends exactly one attempt');
    assert.equal(after.retryAt, null, 'and the countdown it fired on is gone');

    // ONE queued copy of the message, not two. Ending a run settles the turns it was over —
    // /turn-complete's failed-turn branch and both finalizes drain them — so the turn this failure
    // put back in the queue is spent by the time the sweep fires and the re-send is the only copy.
    // That is the assertion that matters either way: the person's question is queued exactly once.
    const queued = await queuedTurns(h, f.sessionId);
    assert.equal(queued.length, 1,
      `the message must be queued exactly once, found ${JSON.stringify(queued)}`);

    // Revived for it: the row is queued again, so a runner can be handed the turn.
    assert.equal(after.status, 'PENDING', 'the session is handed back to the queue with it');

    // And the turn really is handed over by the runners' own door, with the person's words.
    await claimed(h, f.sessionId);
    const offered = await poll(h, f);
    assert.equal(offered?.turnId, queued[0].id, 'the inbox offers the retry');
    assert.equal(offered?.content, '把这两张图里的报错讲清楚',
      'and what goes back to the engine is the person\'s message');
    assert.equal((await queuedTurns(h, f.sessionId)).length, 0, 'once only');
  });

  await t.test('(7) the next failure continues the ladder — one step further out', async () => {
      const f = await h.fixture('second');
      await engineReportedItEnded(h, f, f.turnId, 2);
      await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
        turnId: f.turnId, ...ENGINE_NEVER_CAME_UP,
      });
      await runnerGaveUp(h, f);
      const first = await h.armOf(f.sessionId);

      const at = new Date(first.retryAt!.getTime() + 1_000);
      await h.heartbeatAt(f.runnerId, at);
      await h.autoRetry.sweep(at);

      // The runner takes the turn the sweep handed back and fails it the same way. This is the
      // loop the bound is about: without the ladder moving, this failure would be armed at step 0
      // again, on a message that keeps producing nothing.
      await claimed(h, f.sessionId);
      const lease = await leaseOf(h, f.sessionId);
      const again = await poll(h, f);
      await engineReportedItEnded(h, f, again!.turnId, 3, lease);
      const secondReportedAt = Date.now();
      await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
        turnId: again!.turnId, leaseOwner: lease, ...ENGINE_NEVER_CAME_UP,
      } as never);

      const second = await h.armOf(f.sessionId);
      const waited = waitOf(second.retryAt!, secondReportedAt);
      assert.ok(waited >= BACKOFF_MS[1] && waited <= BACKOFF_MS[1] * 1.5,
        `the second wait is the second step of the ladder, got ${waited}ms`);
      assert.equal(second.attempts, 1,
        'and the attempt the release spent is what puts the ladder on that step');
    });

  await t.test('(8) a paused list holds the new arm where the sweep releases it', async () => {
    // The list pause, at the place auto-retry.service's own header insists it belongs: the
    // release. The arming path deliberately does not ask — a person pauses a list when things are
    // already going wrong, so at the moment a failure arms, the hold usually does not exist yet,
    // and an arm that was never written cannot be reconsidered when the pause lifts.
    const f = await h.fixture('held', { dispatchHold: true });
    await h.api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, ...ENGINE_NEVER_CAME_UP,
    });
    await runnerGaveUp(h, f);
    const armed = await h.armOf(f.sessionId);
    assert.ok(armed.retryAt instanceof Date, 'the failure is armed like any other');

    const at = new Date(armed.retryAt!.getTime() + 1_000);
    await h.heartbeatAt(f.runnerId, at);
    await h.autoRetry.sweep(at);

    const held = await h.armOf(f.sessionId);
    assert.equal(held.retryAt?.getTime(), armed.retryAt?.getTime(),
      'the paused task\'s work keeps the exact arm the sweep found');
    assert.equal(held.attempts, 0, 'and no attempt is spent on a retry that did not happen');
    assert.equal((await queuedTurns(h, f.sessionId)).length, 0,
      'the message does not go back out while the list is paused');

    // Lifting the pause is the whole of what makes it due again: the arm it kept IS the next
    // release, and the budget it never spent is still there to spend.
    await h.sql.query(`UPDATE "task" SET dispatch_hold = FALSE WHERE id = (
      SELECT task_id FROM "session" WHERE id = $1::uuid)`, [f.sessionId]);
    await h.autoRetry.sweep(at);

    const lifting = await h.armOf(f.sessionId);
    assert.equal(lifting.attempts, 1, 'the held retry is the one being spent now');
    assert.equal(lifting.retryAt, null, 'and its arm is used');
    assert.equal((await queuedTurns(h, f.sessionId)).length, 1,
      'only now does the message go back out, and once');
  });
});
