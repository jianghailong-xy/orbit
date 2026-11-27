/**
 * What the runner, session and task gauges count (metrics/fleet-metrics.ts), held against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/metrics/fleet-metrics.pg.spec.ts
 *
 * One account's runners in every state, its sessions in every status and its work sessions carrying tasks, written with
 * SQL on Postgres' clock; then one read of the gauges. Counted as the difference from a read before them, so whatever
 * else the database holds does not come into it.
 *
 *  - runners: online and draining heard from within 90 s (by their presence row or their own record, whichever is
 *    later), silent not heard from for longer or ever, offline signed off whatever its last beat;
 *  - the oldest heartbeat age is the oldest beat of the online and draining runners alone;
 *  - sessions: PENDING is queued, RUNNING is running, and a session in the Trash is neither;
 *  - tasks: a work session carrying its task, queued when PENDING, running when RUNNING or parked with a wake source;
 *    a parked one with none carries nothing.
 *
 * Not destructive: every row belongs to the account this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { type FleetGauges, readFleetGauges } from './fleet-metrics';

const URL_ = process.env.COORDINATOR_PG_URL;

function minus(after: FleetGauges, before: FleetGauges) {
  const each = <K extends string>(a: Record<K, number>, b: Record<K, number>) =>
    Object.fromEntries(Object.keys(a).map((key) => [key, a[key as K] - b[key as K]])) as Record<K, number>;
  return { runners: each(after.runners, before.runners), sessions: each(after.sessions, before.sessions), tasks: each(after.tasks, before.tasks) };
}

test('the fleet gauges count runners by state, queued and running sessions and the tasks they carry', {
  skip: !URL_, concurrency: 1, timeout: 120_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const before = await readFleetGauges(prisma);

  const owner = randomUUID();
  await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, 'fleet', 'x', 'MEMBER')`,
    [owner, `fleet-${owner.slice(0, 8)}@fleet-metrics.invalid`]);

  /** A runner whose own record and presence row say `record` and `presence` (SQL on Postgres' clock, or null). */
  const runner = async (status: string, record: string | null, presence: string | null = null) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO runner (id, owner_id, name, token_hash, status, last_heartbeat_at)
       VALUES ($1, $2, $3, 'x', $4::runner_status, ${record ?? 'NULL'})`,
      [id, owner, `fleet-${id.slice(0, 8)}`, status]);
    if (presence) {
      await sql.query(`INSERT INTO runner_presence (runner_id, last_beat_at, link_state) VALUES ($1, ${presence}, 'HTTP')`, [id]);
    }
    return id;
  };
  const ago = (seconds: number) => `(now() - interval '${seconds} seconds')`;

  await t.test('runners by state, and the oldest beat of the reachable ones', async () => {
    const start = await readFleetGauges(prisma);
    await runner('ONLINE', ago(5));
    // Its own record is old; the presence row a beat wrote since is what counts.
    await runner('ONLINE', ago(3_600), ago(20));
    await runner('DRAINING', ago(70));
    // Silent: did not sign off, and was last heard from long ago, or never.
    await runner('ONLINE', ago(91));
    await runner('ONLINE', ago(7 * 86_400));
    await runner('DRAINING', null);
    // Signed off, whatever it last said.
    await runner('OFFLINE', ago(1));
    await runner('OFFLINE', null);

    const after = await readFleetGauges(prisma);
    assert.deepEqual(minus(after, start).runners, { online: 2, draining: 1, silent: 3, offline: 2 });
    // The draining runner's 70 s is the oldest beat of the reachable ones; the week-old silent one is not one of them.
    assert.ok(after.oldestHeartbeatAgeSeconds >= 70 && after.oldestHeartbeatAgeSeconds < 85,
      `the oldest reachable beat is about 70 s old: ${after.oldestHeartbeatAgeSeconds}`);
  });

  await t.test('queued and running sessions and tasks', async () => {
    const start = await readFleetGauges(prisma);
    const session = async (status: string, extra: { task?: boolean; deleted?: boolean; bgJob?: boolean } = {}) => {
      let task: string | null = null;
      if (extra.task) {
        task = randomUUID();
        await sql.query(
          `INSERT INTO task (id, title, owner_id, creator_type, creator_id, completion_criterion, updated_at) VALUES ($1, 'fleet', $2, 'USER', $2, 'OWNER_CONFIRMED', now())`,
          [task, owner]);
      }
      await sql.query(
        `INSERT INTO "session" ("id", "title", "prompt", "creator_id", "provider", "owner_id", "turn_state", "task_id", "starts_task_work", "deleted_at", "running_bg_jobs", "updated_at", "finished_at")
         VALUES ($1, 'fleet', 'fleet', $2, 'claude', $2, (CASE ($3)::text WHEN 'PENDING' THEN 'QUEUED' WHEN 'RUNNING' THEN 'IN_FLIGHT' WHEN 'INTERRUPTED' THEN 'ABANDONED' END), $4, $5, ${extra.deleted ? 'now()' : 'NULL'}, $6, now(),
                 CASE WHEN $3 IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN now() END)`,
        [randomUUID(), owner, status, task, extra.task ?? false, extra.bgJob ? ['bgj_fleet'] : []]);
    };
    await session('PENDING');
    await session('PENDING');
    await session('RUNNING');
    await session('PENDING', { deleted: true });
    await session('AWAITING_INPUT');
    await session('SUCCEEDED');
    // Work sessions: one queued, one running, one parked on a background job, one parked with nothing to wake it.
    await session('PENDING', { task: true });
    await session('RUNNING', { task: true });
    await session('AWAITING_INPUT', { task: true, bgJob: true });
    await session('AWAITING_INPUT', { task: true });

    const delta = minus(await readFleetGauges(prisma), start);
    assert.deepEqual(delta.sessions, { queued: 3, running: 2 });
    assert.deepEqual(delta.tasks, { queued: 1, running: 2 });
  });

  const end = minus(await readFleetGauges(prisma), before);
  assert.deepEqual(end.runners, { online: 2, draining: 1, silent: 3, offline: 2 });
});
