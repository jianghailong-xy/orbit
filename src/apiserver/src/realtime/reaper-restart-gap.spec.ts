import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { ReaperService } from './reaper.service';
import { runtimeStartupClock } from './runtime-startup-clock';

// The reaper's "runtime not initialized" watchdog (2 min for most dynamic engines) must not count the
// time a runner restart or the owner's Update Now kept a turn waiting (task 34wNtnf94bNWNz0bmcieV).

const SESSION = '11111111-1111-4111-8111-111111111111';
const RUNNER = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const ago = (ms: number) => new Date(Date.now() - ms);

function sweepWith(opts: {
  lastTurnAt: Date;
  cut?: { reason: string; at: Date };
  turn?: { deliveredAt: Date | null; answeredAt: Date | null };
}): Promise<string[]> {
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: SESSION,
          taskId: null,
          assignedRunnerId: RUNNER,
          status: RunStatus.RUNNING,
          provider: AgentProvider.OPENCODE,
          engine: AgentProvider.OPENCODE,
          runtimeSessionId: null,
          lastTurnAt: opts.lastTurnAt,
          cancelRequestedAt: null,
          endReason: null,
          task: null,
          assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date() },
        },
      ],
    },
    runEvent: {
      findMany: async ({ where }: { where: { OR: Array<{ payload: { equals: string } }> } }) => {
        const asked = where.OR.map((o) => o.payload.equals);
        return opts.cut && asked.includes(opts.cut.reason)
          ? [{ turnId: TURN, createdAt: opts.cut.at, ingestedAt: opts.cut.at }]
          : [];
      },
    },
    conversationTurn: { findUnique: async () => opts.turn ?? null },
  } as never;
  const service = new ReaperService(prisma, {} as never);
  const finalized: string[] = [];
  (service as unknown as { forceFinalize(id: string, r: string | null, t: string | null, why: string): Promise<void> })
    .forceFinalize = async (_id, _r, _t, why) => { finalized.push(why); };
  return (service as unknown as { sweep(): Promise<Array<string>> }).sweep().then(() => finalized);
}

test('an ordinary turn past the runtime grace is still failed', async () => {
  assert.deepEqual(await sweepWith({ lastTurnAt: ago(3 * 60_000) }), ['opencode runtime not initialized']);
});

test('a turn Update Now cut 10 minutes ago and not yet re-delivered is not failed', async () => {
  const cutAt = ago(10 * 60_000);
  assert.deepEqual(
    await sweepWith({
      lastTurnAt: cutAt,
      cut: { reason: 'runner_update', at: cutAt },
      turn: { deliveredAt: ago(11 * 60_000), answeredAt: null },
    }),
    [],
  );
});

test('a turn a runner restart cut is not failed while it waits for the runner either', async () => {
  const cutAt = ago(10 * 60_000);
  assert.deepEqual(
    await sweepWith({
      lastTurnAt: cutAt,
      cut: { reason: 'runner_restart', at: cutAt },
      turn: { deliveredAt: ago(11 * 60_000), answeredAt: null },
    }),
    [],
  );
});

test('a cut turn re-delivered 30s ago counts from the re-delivery, not from the cut', async () => {
  const cutAt = ago(10 * 60_000);
  assert.deepEqual(
    await sweepWith({
      lastTurnAt: cutAt,
      cut: { reason: 'runner_update', at: cutAt },
      turn: { deliveredAt: ago(30_000), answeredAt: null },
    }),
    [],
  );
});

test('a cut turn re-delivered longer ago than the grace, whose runtime still never came up, is failed', async () => {
  const cutAt = ago(10 * 60_000);
  assert.deepEqual(
    await sweepWith({
      lastTurnAt: cutAt,
      cut: { reason: 'runner_update', at: cutAt },
      turn: { deliveredAt: ago(3 * 60_000), answeredAt: null },
    }),
    ['opencode runtime not initialized'],
  );
});

test('a cut of an earlier turn that has since been answered does not hold the watchdog', async () => {
  assert.deepEqual(
    await sweepWith({
      lastTurnAt: ago(3 * 60_000),
      cut: { reason: 'runner_update', at: ago(60 * 60_000) },
      turn: { deliveredAt: ago(61 * 60_000), answeredAt: ago(50 * 60_000) },
    }),
    ['opencode runtime not initialized'],
  );
});

test('runtimeStartupClock: no cut reads lastTurnAt; a pending cut reads nothing; a re-delivery reads the later', () => {
  const last = new Date(1_000);
  assert.equal(runtimeStartupClock({ lastTurnAt: last, cut: null }), 1_000);
  assert.equal(runtimeStartupClock({ lastTurnAt: last, cut: { at: new Date(2_000), turnDeliveredAt: new Date(500) } }), null);
  assert.equal(runtimeStartupClock({ lastTurnAt: last, cut: { at: new Date(2_000), turnDeliveredAt: null } }), null);
  assert.equal(runtimeStartupClock({ lastTurnAt: last, cut: { at: new Date(2_000), turnDeliveredAt: new Date(3_000) } }), 3_000);
});
