import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import {
  RUNNER_BEATS,
  RUNNER_DURABLE_BEAT_EVERY_MS,
  RUNNER_OFFLINE_AFTER_MS,
  durableBeatDue,
  runnerIsOnline,
  runnerLastBeatAt,
  withRunnerLastBeat,
} from './runner-presence';

/**
 * The one reading of a runner's liveness (runners/runner-presence.ts): its presence row and its own
 * low-frequency record, the later winning, judged by the rule every reader used to spell for itself.
 */

const NOW = Date.parse('2026-10-25T06:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms);

/** The rule as every reader spelled it before presence had a table: one column, one window. */
function oldRule(runner: { status: string; lastHeartbeatAt: Date | null }, now: number): boolean {
  return runner.status !== 'OFFLINE' && !!runner.lastHeartbeatAt
    && runner.lastHeartbeatAt.getTime() >= now - 90_000;
}

test('the last beat is the later of the presence row and the runner’s own record', () => {
  assert.equal(runnerLastBeatAt({ lastHeartbeatAt: ago(4 * 60_000), presence: { lastBeatAt: ago(10_000) } })?.getTime(), NOW - 10_000);
  // A presence row older than the record: a runner registered again since, or a row a crash took back.
  assert.equal(runnerLastBeatAt({ lastHeartbeatAt: ago(5_000), presence: { lastBeatAt: ago(60_000) } })?.getTime(), NOW - 5_000);
  // Either alone answers: a runner never heard since this table existed, or one never registered with a stamp.
  assert.equal(runnerLastBeatAt({ lastHeartbeatAt: ago(7_000), presence: null })?.getTime(), NOW - 7_000);
  assert.equal(runnerLastBeatAt({ lastHeartbeatAt: null, presence: { lastBeatAt: ago(8_000) } })?.getTime(), NOW - 8_000);
  // A payload that carries a reading already (the session list's rows, ISO strings from JSON).
  assert.equal(runnerLastBeatAt({ lastHeartbeatAt: ago(9_000).toISOString() })?.getTime(), NOW - 9_000);
  assert.equal(runnerLastBeatAt({ lastHeartbeatAt: null, presence: null }), null);
  assert.equal(runnerLastBeatAt({ lastHeartbeatAt: 'not a time' }), null);
  assert.equal(runnerLastBeatAt(null), null);
});

test('every reader’s verdict is the old one wherever the presence row holds the beat the column used to', () => {
  const ages = [0, 30_000, 89_999, 90_000, 90_001, 5 * 60_000, null];
  for (const status of ['ONLINE', 'DRAINING', 'OFFLINE']) {
    for (const age of ages) {
      const beat = age === null ? null : ago(age);
      const was = oldRule({ status, lastHeartbeatAt: beat }, NOW);
      // The beat in its presence row, the runner's own record up to five minutes behind it: the
      // low-frequency write this change introduces.
      for (const recordLag of [0, 60_000, RUNNER_DURABLE_BEAT_EVERY_MS - 1]) {
        const recorded = beat === null ? null : new Date(beat.getTime() - recordLag);
        const runner = { status, lastHeartbeatAt: recorded, presence: beat === null ? null : { lastBeatAt: beat } };
        assert.equal(runnerIsOnline(runner, NOW), was, `${status}, beat ${age} ms ago, record ${recordLag} ms behind`);
      }
      // A row read before the table existed, or by a reader whose payload already resolved it.
      assert.equal(runnerIsOnline({ status, lastHeartbeatAt: beat }, NOW), was, `${status}, beat ${age} ms ago, record only`);
    }
  }
  assert.equal(RUNNER_OFFLINE_AFTER_MS, 90_000);
  assert.equal(runnerIsOnline(null, NOW), false);
});

test('a presence row is what makes a runner whose own record is stale read as online', () => {
  const runner = { status: 'ONLINE', lastHeartbeatAt: ago(4 * 60_000), presence: { lastBeatAt: ago(20_000) } };
  assert.equal(runnerIsOnline(runner, NOW), true);
  assert.equal(runnerIsOnline({ ...runner, presence: null }, NOW), false, 'without it, the record alone is four minutes old');
});

test('a client is shown the last beat as lastHeartbeatAt, and never the presence row it came from', () => {
  const shown = withRunnerLastBeat({
    id: 'r', status: 'ONLINE', lastHeartbeatAt: ago(4 * 60_000), presence: { lastBeatAt: ago(20_000) },
  });
  assert.deepEqual(shown, { id: 'r', status: 'ONLINE', lastHeartbeatAt: ago(20_000) });
  assert.equal('presence' in shown, false);
  assert.deepEqual(RUNNER_BEATS, { lastHeartbeatAt: true, presence: { select: { lastBeatAt: true } } });
});

test('the runner’s own record is rewritten when it is missing or five minutes old, and not before', () => {
  const at = new Date(NOW);
  assert.equal(durableBeatDue(null, at), true);
  assert.equal(durableBeatDue(undefined, at), true);
  assert.equal(durableBeatDue(ago(RUNNER_DURABLE_BEAT_EVERY_MS - 1), at), false);
  assert.equal(durableBeatDue(ago(RUNNER_DURABLE_BEAT_EVERY_MS), at), true);
  assert.equal(RUNNER_DURABLE_BEAT_EVERY_MS, 5 * 60_000);
});

function heartbeatWorld() {
  const runnerWrites: Array<Record<string, unknown>> = [];
  const presenceWrites: Array<{ where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const prisma = {
    runner: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        runnerWrites.push(data);
        return { maxConcurrent: 4 };
      },
      findUnique: async () => null,
    },
    runnerPresence: {
      upsert: async (args: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        presenceWrites.push(args);
        return {};
      },
    },
    session: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    failAbandonedWorktreeOperations: async () => undefined,
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  } as never;
  const controller = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  return { controller, runnerWrites, presenceWrites };
}

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const LEASE_OWNER = '22222222-2222-4222-8222-222222222222';

test('every heartbeat upserts the runner’s presence row: the process, HTTP, no gateway, no hashes', async () => {
  const w = heartbeatWorld();
  const before = Date.now();
  await w.controller.heartbeat(
    { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() },
    { status: 'ONLINE', idleCapacity: 1, leaseOwner: LEASE_OWNER.toUpperCase() } as never,
  );
  assert.equal(w.presenceWrites.length, 1);
  const [write] = w.presenceWrites;
  assert.deepEqual(write.where, { runnerId: RUNNER_ID });
  const beat = write.update.lastBeatAt as Date;
  assert.ok(beat instanceof Date && beat.getTime() >= before && beat.getTime() <= Date.now());
  assert.deepEqual(write.update, {
    processId: LEASE_OWNER, gatewayId: null, lastBeatAt: beat, linkState: 'HTTP', factsHash: null, reconcileHash: null,
  });
  assert.deepEqual(write.create, { runnerId: RUNNER_ID, ...write.update });
});

test('a beat the link gateway forwarded is recorded as LINK; one over HTTPS stays HTTP', async () => {
  const w = heartbeatWorld();
  await w.controller.heartbeat(
    { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() },
    { status: 'ONLINE', idleCapacity: 1, leaseOwner: LEASE_OWNER } as never,
    undefined, undefined, undefined, undefined,
    { leaseOwner: LEASE_OWNER, requestId: 'hb-1', afterSeq: null },
  );
  await w.controller.heartbeat(
    { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date() },
    { status: 'ONLINE', idleCapacity: 1, leaseOwner: LEASE_OWNER } as never,
  );
  assert.deepEqual(w.presenceWrites.map((write) => write.update.linkState), ['LINK', 'HTTP']);
});

test('the runner row’s own record moves only when it is five minutes old — the beat itself always lands in presence', async () => {
  const fresh = heartbeatWorld();
  await fresh.controller.heartbeat(
    { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date(Date.now() - 60_000) },
    { status: 'ONLINE', idleCapacity: 1 } as never,
  );
  assert.equal(fresh.runnerWrites[0]?.lastHeartbeatAt, undefined, 'a record a minute old is left as it is');
  assert.equal(fresh.presenceWrites.length, 1);

  const stale = heartbeatWorld();
  await stale.controller.heartbeat(
    { id: RUNNER_ID, version: null, lastHeartbeatAt: new Date(Date.now() - RUNNER_DURABLE_BEAT_EVERY_MS) },
    { status: 'ONLINE', idleCapacity: 1 } as never,
  );
  assert.ok(stale.runnerWrites[0]?.lastHeartbeatAt instanceof Date, 'a record five minutes old is rewritten');
  assert.equal(stale.runnerWrites[0]?.lastHeartbeatAt, stale.presenceWrites[0]?.update.lastBeatAt, 'with the same beat');

  const never = heartbeatWorld();
  await never.controller.heartbeat({ id: RUNNER_ID, version: null, lastHeartbeatAt: null }, { status: 'ONLINE', idleCapacity: 1 } as never);
  assert.ok(never.runnerWrites[0]?.lastHeartbeatAt instanceof Date, 'a runner with no record gets one');
});

test('a beat whose runner row was refused writes no presence: the runner is not heard', async () => {
  const w = heartbeatWorld();
  (w.controller as unknown as { prisma: { runner: { update: () => Promise<never> } } }).prisma.runner.update = async () => {
    throw new Error('the runner row could not be written');
  };
  await assert.rejects(
    w.controller.heartbeat({ id: RUNNER_ID, version: null }, { status: 'ONLINE', idleCapacity: 1 } as never),
    /could not be written/,
  );
  assert.deepEqual(w.presenceWrites, []);
});
