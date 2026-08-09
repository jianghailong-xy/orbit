import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AutoRetryService } from './auto-retry.service';
import type { SessionsService } from './sessions.service';

const NOW = new Date('2026-08-03T16:25:00Z');
const PAST = new Date('2026-08-03T16:20:00Z');
const FUTURE = '2026-08-03T21:20:00Z';

/** A runner snapshot whose 5-hour window is spent — the shape planUsageBlockedUntil reads. */
const stillBlocked = {
  provider: 'claude',
  fiveHour: { utilization: 100, resetsAt: FUTURE },
};

type SessionRow = Record<string, unknown>;

function makeService(
  rows: SessionRow[],
  opts: { resume?: () => Promise<unknown>; events?: Array<{ type: string; payload: unknown }> } = {},
) {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const resumed: Array<{ id: string; content: string }> = [];
  const prisma = {
    session: {
      // Honour the selection predicate rather than returning everything: the regression this
      // service shipped was a `where` that matched none of the sessions it exists for, and a
      // fake that ignores `where` cannot see that. Only the status/cancel branches are
      // evaluated — `retryAt` deliberately is not, so a fixture can model a row that was armed
      // when the query ran and lost the claim before this sweep reached it.
      findMany: async (args: { where: { OR?: Array<Record<string, unknown>> } }) =>
        rows.filter((r) =>
          (args.where.OR ?? []).some((cond) =>
            Object.entries(cond).every(([k, v]) => (r[k] ?? null) === v),
          ),
        ),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        // Honour the guards the service relies on: `retryAt: { not: null }` is the claim (a
        // fixture with retryAt null models a user message that already won it), and `status`
        // is the "nobody has taken over" gate the backoff path uses.
        const row = rows.find((r) => r.id === args.where.id);
        const where = args.where as { status?: string; retryAt?: { not: null } };
        const hit =
          !!row &&
          (where.retryAt === undefined || row.retryAt != null) &&
          (where.status === undefined || where.status === row.status);
        if (hit) Object.assign(row as object, args.data);
        return { count: hit ? 1 : 0 };
      },
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args as never);
        const target = rows.find((r) => r.id === args.where.id);
        if (target) Object.assign(target, args.data);
        return {};
      },
    },
    runEvent: {
      findMany: async () =>
        [...(opts.events ?? [{ type: 'user', payload: { text: 'the original message' } }])].reverse(),
    },
  };
  const sessions = {
    resume: async (_owner: string, id: string, dto: { content: string }) => {
      if (opts.resume) await opts.resume();
      resumed.push({ id, content: dto.content });
      return { turnId: 't', seq: 1 };
    },
  } as unknown as SessionsService;
  const service = new AutoRetryService(prisma as never, sessions);
  return { service, updates, resumed, rows };
}

function row(over: SessionRow = {}): SessionRow {
  return {
    id: 'session-1',
    ownerId: 'owner-1',
    provider: 'claude',
    prompt: 'opening prompt',
    numTurns: 3,
    retryAt: PAST,
    retryAttempts: 0,
    assignedRunnerId: 'runner-1',
    assignedRunner: { planUsage: null },
    status: RunStatus.AWAITING_INPUT,
    ...over,
  };
}

test('re-sends the last user message once the quota is back', async () => {
  const { service, resumed } = makeService([row()]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'the original message' }]);
});

// Either failure can settle the run FAILED with cancelRequestedAt set — turn-complete reclaims
// the runner slot that way — so this, not AWAITING_INPUT, is the state most armed retries are
// actually sitting in. A sweep that also demands cancelRequestedAt: null finds none of them.
test('retries a session the failure settled FAILED', async () => {
  const { service, resumed } = makeService([
    row({ status: RunStatus.FAILED, cancelRequestedAt: PAST }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'the original message' }]);
});

test('backs off a FAILED session instead of stranding it', async () => {
  const { service, rows } = makeService([row({ status: RunStatus.FAILED, cancelRequestedAt: PAST })], {
    resume: async () => {
      throw new Error('runner offline');
    },
  });
  await service.sweep(NOW);
  assert.equal(rows[0].retryAttempts, 1);
  assert.deepEqual(
    rows[0].retryAt,
    new Date(NOW.getTime() + 2 * 60_000),
    're-armed under the status it was parked in, not one it can never satisfy',
  );
});

test('skips an idle session that is being torn down', async () => {
  const { service, resumed } = makeService([row({ cancelRequestedAt: PAST })]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'its owner asked for it to end; do not start a turn behind that');
});

test('leaves a live session alone', async () => {
  const { service, resumed } = makeService([row({ status: RunStatus.RUNNING })]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'it is already working; nothing is waiting on us');
});

test('defers without spending an attempt while the snapshot still reports the quota spent', async () => {
  const { service, resumed, rows } = makeService([
    row({ assignedRunner: { planUsage: stillBlocked } }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'must not burn a turn against a quota known to be spent');
  assert.equal(rows[0].retryAttempts, 0, 'a deferral is not a failed attempt');
  assert.deepEqual(rows[0].retryAt, new Date(FUTURE), 're-armed for the reported reset');
});

test('releases one session per (runner, provider) per sweep', async () => {
  const { service, resumed } = makeService([
    row({ id: 'a' }),
    row({ id: 'b' }),
    row({ id: 'c', assignedRunnerId: 'runner-2' }),
    row({ id: 'd', provider: 'codex' }),
  ]);
  await service.sweep(NOW);
  assert.deepEqual(
    resumed.map((r) => r.id).sort(),
    ['a', 'c', 'd'],
    'b shares a provider with a and waits for the next sweep',
  );
});

test('hands back to the user once the attempts are spent', async () => {
  const { service, resumed, rows } = makeService([row({ retryAttempts: 5 })]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, []);
  assert.equal(rows[0].retryAt, null, 'disarmed');
});

test('spends an attempt on every dispatch, so a repeating failure runs out', async () => {
  // The count is reset only by a reply that is no longer one of these failures (on ingestion).
  // Refunding it here would restart the backoff after every retry and loop forever.
  const { service, rows } = makeService([row({ retryAttempts: 2 })]);
  await service.sweep(NOW);
  assert.equal(rows[0].retryAttempts, 3);
});

test('backs off and stays armed when the resume itself fails', async () => {
  const { service, rows } = makeService([row()], {
    resume: async () => {
      throw new Error('runner offline');
    },
  });
  await service.sweep(NOW);
  assert.equal(rows[0].retryAttempts, 1);
  assert.deepEqual(
    rows[0].retryAt,
    new Date(NOW.getTime() + 2 * 60_000),
    'first backoff step, measured from the sweep',
  );
});

test('does not re-send when there is nothing to re-send', async () => {
  const { service, resumed, rows } = makeService([row({ numTurns: 3 })], { events: [] });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'inventing a "continue" would be writing in the user’s voice');
  assert.equal(rows[0].retryAt, null);
});

test('falls back to the opening prompt when the very first turn hit the limit', async () => {
  const { service, resumed } = makeService([row({ numTurns: 0 })], { events: [] });
  await service.sweep(NOW);
  assert.deepEqual(resumed, [{ id: 'session-1', content: 'opening prompt' }]);
});

test('loses the claim to a user message that lands first', async () => {
  const { service, resumed } = makeService([row({ retryAt: null })]);
  await service.sweep(NOW);
  assert.deepEqual(resumed, [], 'the user took over; a second turn must not appear behind them');
});
