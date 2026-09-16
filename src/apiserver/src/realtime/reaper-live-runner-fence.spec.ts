import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { ReaperService } from './reaper.service';

/**
 * A runner is declared offline by ABSENCE: nothing wrote `lastHeartbeatAt` for 90s. Absence is
 * evidence only while the channel that records presence works — and that channel is a database
 * write, while the verdict that kills the session is a database read. Under connection-pool
 * exhaustion the write path fails first, so a live runner stops being able to say it is there at
 * exactly the moment the reaper keeps being able to say it is gone.
 *
 * Two things follow, and each is fenced here:
 *
 *  - the verdict is read from one snapshot at the top of a sweep and applied one transaction at a
 *    time afterwards, so it can be far older than the write it authorises; and
 *  - a sweep that has watched its own database refuse a unit of work has disqualified its own
 *    evidence, because that same refusal is what stops heartbeats being recorded.
 *
 * Field case this pins (2026-09-15 13:14:07–13:14:29Z): one sweep logged `reap of … failed:
 * Transaction API error: Unable to start a transaction`, and then finalized four sessions on two
 * live runners as `runner offline` over the next 22 seconds.
 */

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OFFLINE_AFTER_MS = 90_000;

/** Prisma's own name for "the transaction infrastructure failed", as the storm delivered it. */
function unableToStartATransaction(): Error {
  return Object.assign(
    new Error(
      'Transaction API error: Unable to start a transaction in the given time. ' +
        'Current state of the pool: ...',
    ),
    { code: 'P2028' },
  );
}

interface SweepPlan {
  sessions: string[];
  /** How old the runner's heartbeat is IN THE ROW when a finalizing transaction reads it. */
  liveHeartbeatAgeMs: number;
  /** Sessions whose finalizing transaction the database refuses, as it refused three that day. */
  failTransactionsFor?: string[];
}

/**
 * One ReaperService that can be swept more than once, because the question "does a storm stop this
 * reaper for good" is only askable across sweeps of the same instance.
 *
 * Every swept session's snapshot heartbeat is stale, which is what puts it in front of the offline
 * branch at all; `liveHeartbeatAgeMs` is the separate, later question of what the row says by the
 * time the write runs.
 */
function reaperUnderStorm() {
  const finalized: Array<{ sessionId: string; data: Record<string, unknown> }> = [];
  let plan: SweepPlan = { sessions: [], liveHeartbeatAgeMs: 2 * OFFLINE_AFTER_MS };
  // Which session the transaction now running belongs to. forceFinalize is awaited one session at
  // a time, so one cursor is enough to give each its own answer.
  let current = '';
  const tx = {
    session: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        finalized.push({ sessionId: current, data });
        return { count: 1 };
      },
      count: async () => 0,
    },
    runner: {
      findUnique: async () => ({
        status: 'ONLINE',
        lastHeartbeatAt: new Date(Date.now() - plan.liveHeartbeatAgeMs),
      }),
    },
    task: { updateMany: async () => ({ count: 1 }) },
    $executeRaw: async () => 1,
    conversationTurn: {
      updateMany: async () => ({ count: 1 }),
      findFirst: async () => null,
      findMany: async () => [],
    },
  };
  const prisma = {
    session: {
      findMany: async () =>
        plan.sessions.map((id) => ({
          id,
          taskId: null,
          assignedRunnerId: RUNNER_ID,
          status: RunStatus.RUNNING,
          provider: 'claude',
          providerBuiltin: true,
          runtimeSessionId: 'runtime-1',
          lastTurnAt: new Date(),
          cancelRequestedAt: null,
          endReason: null,
          startsTaskWork: true,
          task: null,
          // What the ONE snapshot at the top of the sweep saw: three missed heartbeats.
          assignedRunner: {
            status: 'ONLINE',
            lastHeartbeatAt: new Date(Date.now() - 2 * OFFLINE_AFTER_MS),
          },
        })),
    },
    runEvent: { findFirst: async () => null },
    $transaction: async (fn: (client: typeof tx) => unknown) => {
      if ((plan.failTransactionsFor ?? []).includes(current)) throw unableToStartATransaction();
      return fn(tx);
    },
  } as never;
  const realtime = {
    requestCancel: () => undefined,
    publish: () => undefined,
    publishTaskChanged: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
  } as never;
  const service = new ReaperService(prisma, realtime);
  const inner = service as unknown as {
    sweep(): Promise<void>;
    forceFinalize(sessionId: string, ...rest: unknown[]): Promise<void>;
  };
  // forceFinalize is given the session id first, so wrapping it is how the fixture learns which
  // session the next transaction is for without reaching into the service's internals.
  const forceFinalize = inner.forceFinalize.bind(inner);
  inner.forceFinalize = async (sessionId: string, ...rest: unknown[]) => {
    current = sessionId;
    return forceFinalize(sessionId, ...rest);
  };
  return {
    async sweep(next: SweepPlan): Promise<string[]> {
      plan = next;
      const before = finalized.length;
      await inner.sweep();
      return finalized.slice(before).map((f) => f.sessionId);
    },
    finalized,
  };
}

const A = '11111111-1111-4111-8111-11111111111a';
const B = '11111111-1111-4111-8111-11111111111b';
const C = '11111111-1111-4111-8111-11111111111c';

// The negative control for both fences below: a runner still silent when the write lands, on a
// sweep whose database answered every time, is finalized exactly as it always was. Both fences are
// meant to withdraw a verdict that stopped being true, not to stop reaping.
test('still reaps a session whose runner is silent at write time too', async () => {
  const reaper = reaperUnderStorm();
  const reaped = await reaper.sweep({ sessions: [A], liveHeartbeatAgeMs: 2 * OFFLINE_AFTER_MS });
  assert.deepEqual(reaped, [A], 'a genuinely gone runner is still reaped');
  assert.equal(reaper.finalized[0]?.data.status, RunStatus.FAILED);
  assert.equal(reaper.finalized[0]?.data.error, 'runner offline');
});

// The verdict is computed from one snapshot at the top of the sweep and written one transaction at
// a time afterwards. Under the database stress that produces the verdict that gap is seconds to
// minutes — the loop awaits a transaction per session — and the runner can be back inside it.
// Nothing in the finalizing transaction re-asks, so the stale verdict beats the live fact.
test('does not reap a runner that heartbeated between the sweep read and the write', async () => {
  const reaper = reaperUnderStorm();
  const reaped = await reaper.sweep({ sessions: [A], liveHeartbeatAgeMs: 1_000 });
  assert.deepEqual(reaped, [], 'the runner is answering; there is nothing to reap');
});

// The 2026-09-15 sweep, in its order: a reap dies with P2028, and the finalizes that follow it in
// the SAME loop still write `runner offline`. By then the sweep has watched its own database refuse
// a unit of work — the same refusal that stops a live runner's heartbeat reaching its row — so a
// silence read after it is the control plane's silence, not the runner's.
test('stops calling runners offline once its own database has refused a transaction', async () => {
  const reaper = reaperUnderStorm();
  const reaped = await reaper.sweep({
    sessions: [A, B, C],
    // Still unrecorded at write time: the storm is what stopped the heartbeat reaching the row,
    // so re-reading it inside the transaction cannot save these two. Only the fault can.
    liveHeartbeatAgeMs: 2 * OFFLINE_AFTER_MS,
    failTransactionsFor: [A],
  });
  assert.deepEqual(reaped, [], 'B and C follow the fault in the same sweep, and are not evidence');
});

// A storm reaches the sweep AFTER it has already finalized someone, so the fence outlives the sweep
// it was raised in: the 90s of silence a next-sweep verdict rests on overlaps the sweep that just
// failed. It is disqualified evidence, not a latch — one sweep that the database answers in full
// re-arms the reaper, or the first storm would stop it for the life of the process.
test('carries the fence into the next sweep, and drops it after a clean one', async () => {
  const reaper = reaperUnderStorm();
  assert.deepEqual(
    await reaper.sweep({ sessions: [A], liveHeartbeatAgeMs: 2 * OFFLINE_AFTER_MS, failTransactionsFor: [A] }),
    [],
    'the fault is this sweep\'s own',
  );
  assert.deepEqual(
    await reaper.sweep({ sessions: [B], liveHeartbeatAgeMs: 2 * OFFLINE_AFTER_MS }),
    [],
    'the silence B is judged on overlaps the sweep that just failed',
  );
  assert.deepEqual(
    await reaper.sweep({ sessions: [C], liveHeartbeatAgeMs: 2 * OFFLINE_AFTER_MS }),
    [C],
    'a sweep the database answered in full re-arms the reaper',
  );
});
