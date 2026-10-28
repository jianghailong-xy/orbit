/**
 * Two sweeps that meet, against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty: what the
 * task scheduler's sweep and the auto-retry sweep do when two of them run at once over one database. With
 * several apiserver processes one of them runs these sweeps (realtime/control-plane-leader.ts), but two can
 * still meet — the sweep of a process that has just lost the lock, beside the one that took it — and each sweep
 * is built from two services over two Prisma clients, as two processes would have them. What it is held to:
 *
 *   (1) two task sweeps at once file one foreman for a stalled list, not one each: the scan reads without a
 *       lock, so both read the stall, and the filing asks again under the list's own transaction lock
 *       (TasksService.dispatchStalledListForemen);
 *   (2) two auto-retry sweeps at once end a retry once and announce its end once: both read the session armed
 *       and due, and the disarm is a compare-and-set on the arm they read (AutoRetryService.disarm).
 *
 * Each forces the meeting in PostgreSQL itself rather than hoping for it: a side connection holds the table the
 * write goes to in SHARE mode, which lets every read through and holds every write, until both sweeps have read
 * and reached their write (or one of them has finished without one); then it lets go. Without the forcing the
 * two sweeps would mostly run one after the other, and prove nothing.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/sweeps-overlap.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates, on the disposable database the script creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { RealtimeService } from '../realtime/realtime.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import type { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;

/** Whatever a service asks of these, it is answered with nothing: they are not what is under test. */
const nothing = new Proxy({}, { get: () => () => undefined });

test('two sweeps meeting over one database write once', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  // Two processes' worth of clients: each sweep has a pool of its own, as each apiserver does.
  const one: PrismaClient = prismaClientFor(url);
  const two: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await one.$disconnect().catch(() => undefined);
    await two.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  async function owner(name: string) {
    const id = randomUUID();
    await one.user.create({ data: { id, email: `${name}-${RUN}@sweeps-overlap.test`, name, passwordHash: 'x' } });
    return id;
  }

  /**
   * Run `sweeps` at once while `table` is held in SHARE mode, and let go once every sweep has either reached its
   * write to `table` (it waits there) or finished; then wait for them all. Returns what each one ended with.
   */
  async function meeting(table: string, sweeps: Array<() => Promise<unknown>>): Promise<PromiseSettledResult<unknown>[]> {
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`LOCK TABLE "${table}" IN SHARE MODE`);
      let finished = 0;
      const running = sweeps.map((sweep) => sweep().finally(() => { finished += 1; }));
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { rows: [{ waiting }] } = await sql.query<{ waiting: number }>(
          `SELECT count(*)::int AS "waiting" FROM pg_locks
            WHERE locktype = 'relation' AND relation = $1::regclass AND NOT granted`,
          [`"${table}"`],
        );
        if (waiting + finished >= sweeps.length) break;
        assert.ok(Date.now() < deadline, `the sweeps never met at "${table}": ${waiting} waiting, ${finished} finished`);
        await sleep(20);
      }
      await holder.query('COMMIT');
      return await Promise.allSettled(running);
    } finally {
      await holder.end().catch(() => undefined);
    }
  }

  await t.test('(1) two task sweeps at once file one foreman for a stalled list', async () => {
    const ownerId = await owner('foreman');
    const workspaceId = randomUUID();
    await one.workspace.create({ data: { id: workspaceId, ownerId, name: `foreman-${RUN}`, enabled: true } });
    const listId = randomUUID();
    // Stalled for the sweep: it opted in, it is old enough to have stalled, work remains in it, and nothing in it is
    // running or has started.
    await one.taskList.create({
      data: {
        id: listId, ownerId, title: `stalled-${RUN}`, foremanWorkspaceId: workspaceId, foremanStallMinutes: 1,
        createdAt: new Date(Date.now() - 10 * MINUTE),
      },
    });
    await one.task.create({
      data: {
        title: 'work left', ownerId, listId, creatorType: 'USER', creatorId: ownerId, autoRunWhenReady: false,
        completionCriterion: 'EVIDENCE_JUDGMENT', completionCriterionOverrideReason: 'a fixture of the foreman sweep',
      },
    });
    // Two task services, one per process. Their dispatch of the foreman they file is not under test: it is
    // answered with nothing, and a dispatch that fails is logged by the sweep, the filed row standing.
    const sweepOf = (db: PrismaClient) => {
      const tasks = new TasksService(
        db as unknown as PrismaService, nothing as SessionsService, nothing as RealtimeService,
      );
      (tasks as unknown as { logger: unknown }).logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
      return () => (tasks as unknown as { dispatchStalledListForemen(): Promise<void> }).dispatchStalledListForemen();
    };

    const ended = await meeting('task', [sweepOf(one), sweepOf(two)]);
    assert.deepEqual(ended.map((e) => e.status), ['fulfilled', 'fulfilled']);
    const foremen = await one.task.findMany({ where: { listId, isForeman: true }, select: { id: true } });
    assert.equal(foremen.length, 1, `one foreman for the list, not one per sweep: ${foremen.length}`);
  });

  await t.test('(2) two auto-retry sweeps at once end a retry once and announce its end once', async () => {
    const ownerId = await owner('retry');
    const runnerId = randomUUID();
    // A runner gone for two hours, and so for longer than auto-retry waits for one: the retry it was armed with
    // ends ('runner never came back'), and that end is told to the owner.
    await one.runner.create({
      data: {
        id: runnerId, ownerId, name: `gone-${RUN}`, tokenHash: `hash-${randomUUID()}`, status: 'ONLINE',
        lastHeartbeatAt: new Date(Date.now() - 120 * MINUTE),
      },
    });
    const workspaceId = randomUUID();
    await one.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `retry-${RUN}`, enabled: true } });
    const sessionId = randomUUID();
    await one.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: 'reaped as offline',
        prompt: 'reaped as offline', provider: 'claude', providerBuiltin: true, status: RunStatus.FAILED,
        error: 'runner offline', runtimeSessionId: randomUUID(), startedAt: new Date(Date.now() - 50 * MINUTE),
        finishedAt: new Date(Date.now() - 40 * MINUTE), retryAt: new Date(Date.now() - MINUTE),
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    // What reaches the owner: a STATUS event marked final, the one notification of a failure's settling.
    const announced: string[] = [];
    const realtime = {
      publish: (id: string, event: { payload?: { final?: boolean } }) => {
        if (event.payload?.final) announced.push(id);
      },
      publishSessionUpdated: () => undefined,
    } as unknown as RealtimeService;
    const sweepOf = (db: PrismaClient) => {
      const retries = new AutoRetryService(db as unknown as PrismaService, nothing as SessionsService, realtime);
      (retries as unknown as { log: unknown }).log = { log: () => undefined, warn: () => undefined, error: () => undefined };
      return () => retries.sweep();
    };

    const ended = await meeting('session', [sweepOf(one), sweepOf(two)]);
    assert.deepEqual(ended.map((e) => e.status), ['fulfilled', 'fulfilled']);
    const row = await one.session.findUniqueOrThrow({ where: { id: sessionId }, select: { retryAt: true, status: true } });
    assert.deepEqual(row, { retryAt: null, status: RunStatus.FAILED }, 'the retry has ended and the failure stands');
    assert.deepEqual(announced, [sessionId], 'its end is announced once, not once per sweep');
  });
});
