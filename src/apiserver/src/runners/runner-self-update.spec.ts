import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { RUNNER_SELF_UPDATE_STATES, RunnerStatus, type RunnerSelfUpdate } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { sanitizeRunnerSelfUpdate } from '../common/runner-self-update';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

const OWNER = '22222222-2222-4222-8222-222222222222';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';

const REPORT: RunnerSelfUpdate = {
  state: 'failed',
  reason: 'installing 0.1.300: download failed: HTTP 502',
  installDir: '/home/u/.orbit/bin',
  lastUpdatedAt: '2026-10-06T06:00:00.000Z',
  lastUpdatedFrom: '0.1.200',
  lastUpdatedTo: '0.1.217',
};

// ── the report, as stored and as returned ─────────────────────────────────────────────────────

test('a report is kept field for field, under every state the runner can send', () => {
  assert.deepEqual(sanitizeRunnerSelfUpdate(REPORT), REPORT);
  for (const state of RUNNER_SELF_UPDATE_STATES) {
    assert.deepEqual(sanitizeRunnerSelfUpdate({ state }), { state });
  }
});

test('no usable report is null, never a guess', () => {
  for (const value of [undefined, null, 'enabled', 42, [], {}, { state: 'updating' }, { state: 7 }, { reason: 'x' }]) {
    assert.equal(sanitizeRunnerSelfUpdate(value), null, JSON.stringify(value));
  }
});

test('malformed fields are dropped one by one, and what Postgres cannot store is removed', () => {
  assert.deepEqual(
    sanitizeRunnerSelfUpdate({
      state: 'dirNotWritable',
      reason: '   ',
      installDir: '/usr/local/\u0000bin',
      lastUpdatedAt: 'yesterday',
      lastUpdatedFrom: 7,
      lastUpdatedTo: '0.1.217',
      extra: 'ignored',
    }),
    { state: 'dirNotWritable', installDir: '/usr/local/bin', lastUpdatedTo: '0.1.217' },
  );
  // The runner's RFC3339 seconds come back as the ISO the other dates in this API use.
  assert.equal(sanitizeRunnerSelfUpdate({ state: 'enabled', lastUpdatedAt: '2026-10-06T06:00:00Z' })?.lastUpdatedAt,
    '2026-10-06T06:00:00.000Z');
  assert.equal(sanitizeRunnerSelfUpdate({ state: 'failed', reason: 'x'.repeat(5000) })?.reason?.length, 1000);
});

// ── the heartbeat ─────────────────────────────────────────────────────────────────────────────

/** A heartbeat against one runner row: what each beat wrote, and the update request on the row. */
function heartbeatHarness(row: Record<string, unknown> = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const claims: Array<Record<string, unknown>> = [];
  const prisma = {
    runner: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        for (const [column, value] of Object.entries(data)) {
          if (value !== undefined) row[column] = value;
        }
        return { maxConcurrent: 2, ...row };
      },
      findUnique: async () => row,
      // The one-slot requests the beat claims: a conditional clear that matches only while one is
      // pending, as PostgreSQL's would.
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const [column] = Object.keys(args.data);
        if (args.where.id !== RUNNER_ID || row[column] == null) return { count: 0 };
        claims.push(args);
        row[column] = null;
        return { count: 1 };
      },
    },
    workspace: { findMany: async () => [] },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  } as never;
  const api = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  const beat = (extra: Record<string, unknown> = {}) =>
    api.heartbeat({ id: RUNNER_ID, version: null }, { status: RunnerStatus.ONLINE, idleCapacity: 1, ...extra });
  return { beat, writes, claims, row };
}

test('a heartbeat stores the runner’s self-update report', async () => {
  const h = heartbeatHarness();
  await h.beat({ selfUpdate: { ...REPORT, extra: 'dropped' } });
  assert.deepEqual(h.writes[0].selfUpdate, REPORT);
});

// Unlike engines or repos, an omitted report is not "no news": it is a binary that does not report
// one — an older release, or one a rollback put back — and the newer binary's state must not outlive it.
test('a beat without a report writes NULL rather than keeping the last one', async () => {
  const h = heartbeatHarness({ selfUpdate: REPORT });
  await h.beat();
  assert.equal(h.writes[0].selfUpdate, Prisma.DbNull);
  await h.beat({ selfUpdate: { state: 'restarting' } });
  assert.equal(h.writes[1].selfUpdate, Prisma.DbNull, 'a state this server cannot read is not stored');
});

test('Update Runner Now is handed to the next heartbeat once, and cleared as it goes', async () => {
  const h = heartbeatHarness({ selfUpdateRequestedAt: new Date('2026-10-06T06:00:00.000Z') });
  assert.equal((await h.beat()).checkSelfUpdate, true);
  assert.deepEqual(h.claims, [{
    where: { id: RUNNER_ID, selfUpdateRequestedAt: { not: null } },
    data: { selfUpdateRequestedAt: null },
  }]);
  assert.equal(h.row.selfUpdateRequestedAt, null);
  // The answer is the state later beats report, so a redelivered request would re-run the check on
  // every beat.
  assert.equal((await h.beat()).checkSelfUpdate, undefined);
});

test('a runner nobody asked is told nothing', async () => {
  const h = heartbeatHarness();
  assert.equal((await h.beat()).checkSelfUpdate, undefined);
});

// ── Update Runner Now, as the owner asks for it ───────────────────────────────────────────────

function serviceHarness(runner: Record<string, unknown> | null) {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const wakes: string[] = [];
  const prisma = {
    runner: {
      // Owner-scoped exactly as the service asks: someone else's runner is not found.
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
        runner && runner.id === where.id && runner.ownerId === where.ownerId ? runner : null,
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return { ...runner, ...args.data };
      },
    },
  } as unknown as PrismaService;
  const realtime = { notifyRunnerWake: (id: string) => wakes.push(id) } as unknown as RealtimeService;
  return { service: new RunnersService(prisma, realtime), updates, wakes };
}

const online = { id: RUNNER_ID, ownerId: OWNER, status: 'ONLINE', selfUpdate: { state: 'enabled' } };

test('the owner’s request is stamped on the runner, which is woken to collect it now', async () => {
  const h = serviceHarness(online);
  const before = Date.now();
  const { requestedAt } = await h.service.requestSelfUpdate(OWNER, RUNNER_ID);
  assert.equal(h.updates.length, 1);
  assert.deepEqual(h.updates[0].where, { id: RUNNER_ID });
  const stamped = h.updates[0].data.selfUpdateRequestedAt;
  assert.ok(stamped instanceof Date);
  assert.equal(stamped.toISOString(), requestedAt);
  assert.ok(stamped.getTime() >= before);
  assert.deepEqual(h.wakes, [RUNNER_ID]);
});

test('someone else’s runner is not found, and nothing is written or woken', async () => {
  const h = serviceHarness(online);
  await assert.rejects(() => h.service.requestSelfUpdate('33333333-3333-4333-8333-333333333333', RUNNER_ID),
    /runner not found/);
  assert.equal(h.updates.length, 0);
  assert.equal(h.wakes.length, 0);
});

test('an offline runner, or one too old to act on it, is refused rather than left holding the request', async () => {
  for (const [runner, message] of [
    [{ ...online, status: 'OFFLINE' }, /offline/i],
    [{ ...online, selfUpdate: null }, /too old/i],
  ] as const) {
    const h = serviceHarness(runner);
    await assert.rejects(() => h.service.requestSelfUpdate(OWNER, RUNNER_ID), message);
    assert.equal(h.updates.length, 0);
    assert.equal(h.wakes.length, 0);
  }
});

// ── the list and the detail ───────────────────────────────────────────────────────────────────

function viewHarness(rows: Array<Record<string, unknown>>) {
  const prisma = {
    runner: {
      findMany: async ({ where }: { where: { ownerId: string; id?: string } }) =>
        rows.filter((r) => r.ownerId === where.ownerId && (where.id === undefined || r.id === where.id))
          .map(({ ownerId: _ownerId, ...r }) => r),
    },
    session: { groupBy: async () => [] },
  } as unknown as PrismaService;
  return new RunnersService(prisma);
}

const row = (id: string, selfUpdate: unknown) => ({
  id, ownerId: OWNER, name: id, status: 'ONLINE', lastHeartbeatAt: new Date(), capabilities: [],
  engines: null, selfUpdate,
});
const OLD_ID = '44444444-4444-4444-8444-444444444444';

test('the list and the detail return the report, and null for a runner that never sent one', async () => {
  const service = viewHarness([row(RUNNER_ID, REPORT), row(OLD_ID, null)]);
  const listed = await service.listRunners(OWNER);
  assert.deepEqual(listed.map((r) => [r.id, r.selfUpdate]), [[RUNNER_ID, REPORT], [OLD_ID, null]]);
  assert.deepEqual((await service.getRunner(OWNER, RUNNER_ID)).selfUpdate, REPORT);
  assert.equal((await service.getRunner(OWNER, OLD_ID)).selfUpdate, null);
  // The same view, field for field: the detail is not a second shape to keep in step.
  assert.deepEqual(await service.getRunner(OWNER, RUNNER_ID), listed[0]);
  await assert.rejects(() => service.getRunner('33333333-3333-4333-8333-333333333333', RUNNER_ID), /runner not found/);
});

test('a stored report this server cannot read is returned as null', async () => {
  const service = viewHarness([row(RUNNER_ID, { state: 'restarting' })]);
  assert.equal((await service.getRunner(OWNER, RUNNER_ID)).selfUpdate, null);
});

// ── the routes ────────────────────────────────────────────────────────────────────────────────

test('the detail and Update Runner Now are routes of the owner-authenticated runners controller', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, RunnersController), [JwtAuthGuard]);
  const route = (name: keyof RunnersController) => {
    const handler = RunnersController.prototype[name] as object;
    return [Reflect.getMetadata(METHOD_METADATA, handler), Reflect.getMetadata(PATH_METADATA, handler)];
  };
  assert.deepEqual(route('get'), [RequestMethod.GET, ':id']);
  assert.deepEqual(route('requestSelfUpdate'), [RequestMethod.POST, ':id/self-update']);
});
