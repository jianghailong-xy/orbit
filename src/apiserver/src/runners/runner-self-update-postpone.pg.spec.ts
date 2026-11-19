import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { RunnerStatus, SELF_UPDATE_POSTPONE_V1, type RunnerSelfUpdate } from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RUNNER_SELF_UPDATE_POSTPONED_ACTIVITY, RunnersService } from './runners.service';

const url = process.env.COORDINATOR_PG_URL;

const DRAINING: RunnerSelfUpdate = {
  state: 'waitingForIdle',
  phase: 'draining',
  targetVersion: '0.1.254',
  availableSince: '2026-11-12T08:00:00Z',
  drainingSince: '2026-11-12T09:00:00Z',
  turnsInFlight: 1,
  turnsAtDrain: 2,
};

// Later (docs/runner-update-drain-design.md §4, migration 0571) against a real PostgreSQL:
// POST /runners/:id/self-update/postpone is the owner's alone, recorded as an activity row, refused
// for a runner too old to honour it, capped at 09:00 tomorrow in the owner's zone, and handed to one
// heartbeat as postponeSelfUpdateUntil.
test('Later: owner only, audited, old runner refused, until capped, handed to one heartbeat', { skip: !url, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  const wakes: string[] = [];
  const runners = new RunnersService(db as never, { notifyRunnerWake: (id: string) => wakes.push(id) } as never);
  const realtime = {
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  };
  const api = new RunnerApiController(db as never, {} as never, realtime as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  // Each beat declares what the runner declares (X-Orbit-Runner-Capabilities), as a real one does.
  const declared = new Map<string, string>();
  const beat = (runnerId: string, selfUpdate: RunnerSelfUpdate | undefined = DRAINING) =>
    api.heartbeat({ id: runnerId, version: null }, { status: RunnerStatus.ONLINE, idleCapacity: 1, ...(selfUpdate ? { selfUpdate } : {}) },
      declared.get(runnerId) ?? '');
  const stored = async (runnerId: string) =>
    (await db.runner.findUniqueOrThrow({ where: { id: runnerId }, select: { selfUpdatePostponeUntil: true } })).selfUpdatePostponeUntil;
  const audit = (ownerId: string) =>
    db.activity.findMany({ where: { actorId: ownerId, type: RUNNER_SELF_UPDATE_POSTPONED_ACTIVITY }, orderBy: { createdAt: 'asc' } });
  async function fixture(opts: { capabilities?: string[]; status?: 'ONLINE' | 'OFFLINE' } = {}) {
    const ownerId = randomUUID(), runnerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@postpone.invalid`, name: 'Postpone test', passwordHash: 'x' } });
    await db.runner.create({ data: {
      id: runnerId, ownerId, name: 'postpone-runner', tokenHash: randomUUID(), status: opts.status ?? 'ONLINE',
      lastHeartbeatAt: new Date(), capabilities: opts.capabilities ?? [SELF_UPDATE_POSTPONE_V1],
    } });
    declared.set(runnerId, (opts.capabilities ?? [SELF_UPDATE_POSTPONE_V1]).join(','));
    return { ownerId, runnerId };
  }
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  await t.test('another account’s Later is refused as not found and stores and records nothing', async () => {
    const f = await fixture();
    const other = await fixture();
    await beat(f.runnerId);
    await assert.rejects(() => runners.postponeSelfUpdate(other.ownerId, f.runnerId, { until: inAnHour(), timeZone: 'UTC' }), /runner not found/);
    assert.equal(await stored(f.runnerId), null);
    assert.equal((await audit(other.ownerId)).length, 0);
    assert.equal((await audit(f.ownerId)).length, 0);
    assert.equal(wakes.includes(f.runnerId), false);
  });

  await t.test('the owner’s Later is recorded, stored, woken, and handed to one heartbeat', async () => {
    const f = await fixture();
    await beat(f.runnerId);
    const until = inAnHour();
    const answer = await runners.postponeSelfUpdate(f.ownerId, f.runnerId, { until, timeZone: 'Asia/Shanghai' });
    assert.equal(answer.until, until);
    assert.equal((await stored(f.runnerId))?.toISOString(), until);
    assert.equal(wakes.at(-1), f.runnerId);

    const rows = await audit(f.ownerId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].credentialKind, 'LOGIN');
    assert.deepEqual(rows[0].payload, {
      runnerId: f.runnerId, until, asked: until, timeZone: 'Asia/Shanghai', capped: false, phase: 'draining', targetVersion: '0.1.254',
    });

    assert.equal((await beat(f.runnerId)).postponeSelfUpdateUntil, until);
    assert.equal(await stored(f.runnerId), null);
    assert.equal((await beat(f.runnerId)).postponeSelfUpdateUntil, undefined);
  });

  await t.test('until is capped at 09:00 tomorrow in the owner’s zone', async () => {
    const f = await fixture();
    await beat(f.runnerId);
    const before = Date.now();
    const answer = await runners.postponeSelfUpdate(f.ownerId, f.runnerId, {
      until: new Date(before + 3 * 86_400_000).toISOString(), timeZone: 'Asia/Shanghai',
    });
    // Asia/Shanghai is UTC+8 all year: 09:00 there tomorrow is 01:00Z on the day after Shanghai's today.
    const shanghai = new Date(before + 8 * 3_600_000);
    const cap = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + 1, 1));
    assert.equal(answer.until, cap.toISOString());
    assert.equal((await stored(f.runnerId))?.toISOString(), cap.toISOString());
    const [row] = await audit(f.ownerId);
    assert.equal((row.payload as { capped: boolean }).capped, true);
    assert.equal((row.payload as { until: string }).until, cap.toISOString());

    // Tomorrow 09:00 itself is allowed as asked.
    const g = await fixture();
    await beat(g.runnerId);
    assert.equal((await runners.postponeSelfUpdate(g.ownerId, g.runnerId, { until: cap.toISOString(), timeZone: 'Asia/Shanghai' })).until, cap.toISOString());

    // A past time, an unreadable one or an unknown zone is refused and records nothing.
    const h = await fixture();
    await beat(h.runnerId);
    await assert.rejects(() => runners.postponeSelfUpdate(h.ownerId, h.runnerId, { until: new Date(Date.now() - 1000).toISOString() }), /in the future/);
    await assert.rejects(() => runners.postponeSelfUpdate(h.ownerId, h.runnerId, { until: 'soon' }), /ISO time/);
    await assert.rejects(() => runners.postponeSelfUpdate(h.ownerId, h.runnerId, { until: inAnHour(), timeZone: 'Mars/Olympus' }), /IANA/);
    assert.equal(await stored(h.runnerId), null);
    assert.equal((await audit(h.ownerId)).length, 0);
  });

  await t.test('a runner too old to honour Later is refused with the "too old" sentence; one with nothing waiting too', async () => {
    const old = await fixture({ capabilities: [] });
    await beat(old.runnerId, { state: 'waitingForIdle' });
    await assert.rejects(
      () => runners.postponeSelfUpdate(old.ownerId, old.runnerId, { until: inAnHour() }),
      { message: 'Runner is too old to update on request — it reports no self-update state' },
    );
    assert.equal(await stored(old.runnerId), null);
    assert.equal((await audit(old.ownerId)).length, 0);

    const idle = await fixture();
    await beat(idle.runnerId, { state: 'enabled' });
    await assert.rejects(() => runners.postponeSelfUpdate(idle.ownerId, idle.runnerId, { until: inAnHour() }), /nothing to postpone/);
    assert.equal(await stored(idle.runnerId), null);

    const offline = await fixture({ status: 'OFFLINE' });
    await assert.rejects(() => runners.postponeSelfUpdate(offline.ownerId, offline.runnerId, { until: inAnHour() }), /offline/i);
    assert.equal(await stored(offline.runnerId), null);
  });
});
