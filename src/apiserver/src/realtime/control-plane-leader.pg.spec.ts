/**
 * Several apiserver processes over one database, against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty (realtime/control-plane-leader.ts, runners/runner-presence.ts, migration 0449). Each "process" below is what an
 * apiserver process has of its own — a Prisma pool, a coordination connection, the services built over them — and the
 * last case runs two real ones (`node build/main.js`). What it is held to:
 *
 *   (1) the singleton sweeps run on one process at a time: of two processes, one holds the lock, and round after round
 *       the reaper's, the task sweep's and the auto-retry sweep's ticks sweep on that one and on no other; when its
 *       coordination connection is cut as a killed process's is, it stops at once, the other takes the lock within
 *       LEADER_POLL_MS and its ticks sweep from then on, and the first, connected again, waits;
 *   (2) a takeover is a start: the reaper of a process that takes over in the middle of a mass silence the reaper before
 *       it was holding for — the silence lifting, the runner of the session not heard from again yet — reaps nothing at
 *       its first sweep, where a reaper that had been up for an hour and swept on as soon as it held the lock reaps that
 *       session at once; and past its grace, the reaper that took over reaps as any reaper does;
 *   (3) a heartbeat write that failed on process A holds the reaper on process B: a silent runner's run is reaped in a
 *       quiet cell (the control), then not while A's row says a beat it took failed within RUNNER_OFFLINE_AFTER_MS —
 *       B's own record of failures empty all along — and reaped again once that has aged out;
 *   (4) a process that has stopped reporting holds the reaper too — still connected (its pool exhausted, say) for up to
 *       MASS_SILENCE_WINDOW_MS past the quiet line, gone for RUNNER_OFFLINE_AFTER_MS past it — and neither is a latch;
 *       a process that comes back from a quiet spell says a beat was lost then;
 *   (5) one apiserver alone behaves as it did: it takes the lock as it connects, its reaper's grace starts from there,
 *       and neither its own row nor the rows of the processes before it hold its reaper past that grace;
 *   (6) two production apiservers on one database: one runs the singleton sweeps and the other waits, both report
 *       themselves and are seen connected; SIGKILL the one that runs them and the other takes them over within
 *       LEADER_POLL_MS and a margin, the killed one's lock gone with it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/realtime/control-plane-leader.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates, on the disposable database the script creates; the
 * `apiserver_process` rows each case writes are deleted before the next.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Prisma, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  APISERVER_PROCESS_QUIET_AFTER_MS,
  RUNNER_OFFLINE_AFTER_MS,
  RunnerPresenceService,
} from '../runners/runner-presence';
import { AutoRetryService } from '../sessions/auto-retry.service';
import type { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  APISERVER_PROCESS_LOCK_PREFIX,
  ControlPlaneLeader,
  LEADER_POLL_MS,
  SINGLETON_SWEEPS_LOCK,
} from './control-plane-leader';
import type { RealtimeService } from './realtime.service';
import { MASS_SILENCE_WINDOW_MS, ReaperService, STARTUP_GRACE_MS } from './reaper.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const SECOND = 1_000;
const MINUTE = 60_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Whatever a service asks of these, it is answered with nothing: they are not what is under test. */
const nothing = new Proxy({}, { get: () => () => undefined });

async function until(what: string, holds: () => boolean | Promise<boolean>, withinMs: number): Promise<number> {
  const started = Date.now();
  while (!(await holds())) {
    assert.ok(Date.now() - started < withinMs, `${what}: not within ${withinMs} ms`);
    await sleep(25);
  }
  return Date.now() - started;
}

test('several apiserver processes over one database: one runs the singleton sweeps, and none reads another’s lost beats as silence', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const pools: PrismaClient[] = [];
  const leaders: ControlPlaneLeader[] = [];
  const servers: Apiserver[] = [];
  t.after(async () => {
    for (const server of servers) await server.stop().catch(() => undefined);
    for (const leader of leaders) await leader.onModuleDestroy().catch(() => undefined);
    for (const pool of pools) await pool.$disconnect().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  /** A process's own pool, as each apiserver has one. */
  const pool = () => {
    const client = prismaClientFor(url);
    pools.push(client);
    return client;
  };
  /** A process's own coordination connection and locks. */
  const leaderOf = () => {
    const leader = new ControlPlaneLeader({ databaseUrl: url });
    leaders.push(leader);
    return leader;
  };
  const holderOfTheLock = async (): Promise<string | null> => {
    const { rows } = await sql.query<{ name: string }>(
      `SELECT a.application_name AS "name"
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`,
      [SINGLETON_SWEEPS_LOCK],
    );
    assert.ok(rows.length <= 1, `one holder at most: ${JSON.stringify(rows)}`);
    return rows[0]?.name.replace(/^orbit-apiserver /, '') ?? null;
  };
  const connected = async (processId: string): Promise<boolean> => {
    const { rows: [row] } = await sql.query<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks l
                       WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
                         AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)) AS "held"`,
      [APISERVER_PROCESS_LOCK_PREFIX + processId],
    );
    return row.held;
  };

  // ── the cell the reaper reads ─────────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `cell-${RUN}@control-plane-leader.test`, name: 'cell', passwordHash: 'x' } });
  const runner = async (name: string, beatAgoMs: number) => {
    const id = randomUUID();
    await db.runner.create({
      data: {
        id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(randomBytes(16).toString('hex')), status: 'ONLINE',
        lastHeartbeatAt: new Date(Date.now() - 10 * MINUTE),
      },
    });
    await db.runnerPresence.create({ data: { runnerId: id, lastBeatAt: new Date(Date.now() - beatAgoMs), linkState: 'LINK' } });
    return id;
  };
  // Thirty runners beating: one silent runner among them is a machine, not an outage. They beat again before every
  // sweep that wants the cell quiet, as runners beating every thirty seconds would.
  const crowd: string[] = [];
  for (let i = 0; i < 30; i += 1) crowd.push(await runner(`crowd-${i}`, 5 * SECOND));
  const crowdBeats = (agoMs = 0) =>
    db.runnerPresence.updateMany({ where: { runnerId: { in: crowd } }, data: { lastBeatAt: new Date(Date.now() - agoMs) } });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: crowd[0], name: `cell-${RUN}`, enabled: true } });
  /** A runner gone quiet two minutes ago, past the line its sessions are reaped at. Signed off once its case is done. */
  const silentRunner = () => runner('silent', 2 * MINUTE);
  const signOff = (runnerId: string) => db.runner.update({ where: { id: runnerId }, data: { status: 'OFFLINE' } });
  const running = async (runnerId: string, title: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: title,
        provider: 'claude', providerBuiltin: true, status: RunStatus.RUNNING, runtimeSessionId: randomUUID(),
        startedAt: new Date(Date.now() - 10 * MINUTE), runClaimedAt: new Date(Date.now() - 10 * MINUTE),
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    return id;
  };
  const stateOf = (id: string) => db.session.findUniqueOrThrow({ where: { id }, select: { status: true, error: true } });
  const REAPED = { status: RunStatus.FAILED, error: 'runner offline' };
  /** A reaper over `presence`, sweeping through `client`, its log kept. Its timers are never started. */
  const reaperOf = (presence: RunnerPresenceService | undefined, leader?: ControlPlaneLeader, client: PrismaClient = db) => {
    const warns: string[] = [];
    const reaper = new ReaperService(
      client as unknown as PrismaService, nothing as RealtimeService, undefined, presence, leader,
    );
    (reaper as unknown as { log: unknown }).log = {
      warn: (message: string) => warns.push(message),
      log: () => undefined,
      error: (message: string) => warns.push(`ERROR ${message}`),
    };
    return {
      reaper,
      warns,
      /** One sweep, as a reaper that sweeps whenever it is asked. */
      sweep: () => (reaper as unknown as { sweep(): Promise<void> }).sweep(),
      /** As the reaper's timer would: up for this long already. */
      upFor: (ms: number) => { (reaper as unknown as { startedAt: number }).startedAt = Date.now() - ms; },
    };
  };
  const forgetProcesses = () => db.$executeRaw`DELETE FROM "apiserver_process"`;
  /** Until no process holds the singleton sweeps' lock: a leader lets its connection go without waiting for it. */
  const lockFree = () => until('the lock is let go', async () => (await holderOfTheLock()) === null, 10 * SECOND);

  await t.test('(1) the singleton sweeps run on one process at a time, and another takes them over within LEADER_POLL_MS of the first being cut off', async () => {
    /** One process: its leader, and its three sweeps with their sweeping counted rather than done. */
    const processOf = (name: string) => {
      const client = pool();
      const leader = leaderOf();
      const swept: string[] = [];
      const reaper = new ReaperService(client as unknown as PrismaService, nothing as RealtimeService, undefined, undefined, leader);
      (reaper as unknown as { sweep: unknown }).sweep = async () => { swept.push('reaper'); };
      const retries = new AutoRetryService(
        client as unknown as PrismaService, nothing as SessionsService, nothing as RealtimeService, undefined, undefined, leader,
      );
      (retries as unknown as { releaseExpiredClaims: unknown }).releaseExpiredClaims = async () => [];
      (retries as unknown as { sweep: unknown }).sweep = async () => { swept.push('auto-retry'); };
      const tasks = new TasksService(
        client as unknown as PrismaService, nothing as SessionsService, nothing as RealtimeService,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, leader,
      );
      const sweeps = tasks as unknown as Record<string, unknown>;
      sweeps.reconcileReadyTasks = async () => { swept.push('task sweep'); };
      for (const rest of ['dispatchDueScheduledTasks', 'dispatchStalledListForemen', 'deliverMentions']) {
        sweeps[rest] = async () => undefined;
      }
      return {
        name, leader, swept,
        tick: () => Promise.all([reaper.tick(), retries.tick(), tasks.reconcileTick()]),
      };
    };
    const a = processOf('A');
    const b = processOf('B');
    a.leader.onModuleInit();
    b.leader.onModuleInit();
    await until('one of the two takes the lock', () => a.leader.leads() || b.leader.leads(), 10 * SECOND);
    const [first, second] = a.leader.leads() ? [a, b] : [b, a];
    assert.equal(second.leader.leads(), false, 'and only one');
    assert.equal(await holderOfTheLock(), first.leader.processId, 'the lock is held on its coordination connection');

    const rounds = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await Promise.all([a.tick(), b.tick()]);
        assert.notEqual(a.leader.leads(), b.leader.leads(), 'exactly one process holds the lock in every round');
      }
    };
    await rounds(5);
    assert.deepEqual(first.swept.sort(), [
      ...Array(5).fill('auto-retry'), ...Array(5).fill('reaper'), ...Array(5).fill('task sweep'),
    ], 'the holder swept every round, each of the three sweeps once');
    assert.deepEqual(second.swept, [], 'the other swept nothing');

    // Cut off as a killed process is: its socket closed under it, with no word to the server.
    first.swept.length = 0;
    const cutAt = Date.now();
    (first.leader as unknown as { client: { connection: { stream: { destroy(): void } } } }).client.connection.stream.destroy();
    await until('the cut-off process stops at once', () => !first.leader.leads(), 2 * SECOND);
    const tookOver = await until('the other takes the lock over', () => second.leader.leads(), LEADER_POLL_MS + 5 * SECOND);
    t.diagnostic(`taken over ${Date.now() - cutAt} ms after the cut (waited ${tookOver} ms; LEADER_POLL_MS ${LEADER_POLL_MS})`);
    assert.ok(Date.now() - cutAt <= LEADER_POLL_MS + 2 * SECOND, `taken over within LEADER_POLL_MS and two seconds: ${Date.now() - cutAt} ms`);
    assert.equal(await holderOfTheLock(), second.leader.processId);

    await rounds(3);
    assert.deepEqual(first.swept, [], 'the process that lost the lock sweeps nothing');
    assert.equal(second.swept.length, 3 * 3, 'the one that took it sweeps every round, each of the three sweeps once');

    // The first one connects again and asks: the lock is the other's, so it waits.
    await first.leader.tick();
    assert.equal(first.leader.leads(), false);
    assert.equal(await connected(first.leader.processId), true, 'connected again, and seen to be');
    assert.equal(await holderOfTheLock(), second.leader.processId);
    await a.leader.onModuleDestroy();
    await b.leader.onModuleDestroy();
    await lockFree();
  });

  await t.test('(2) a process that takes the sweeps over in the middle of a mass silence reaps nothing at once', async () => {
    await forgetProcesses();
    const presence = new RunnerPresenceService(db as unknown as PrismaService);
    const silent = await silentRunner();
    const session = await running(silent, 'its runner went quiet in a mass silence');

    // The process that held the lock until now, sweeping through a silence of the whole cell — a link gateway gone,
    // say — and holding, then holding on as the cell is heard again, for the runners whose beats were lost in it.
    let sinceA: number | null = Date.now() - 60 * MINUTE;
    const leaderA = { leads: () => sinceA !== null, leadingSince: () => sinceA } as unknown as ControlPlaneLeader;
    const a = reaperOf(presence, leaderA);
    await crowdBeats(2 * MINUTE);
    await a.reaper.tick();
    assert.equal((await stateOf(session)).status, RunStatus.RUNNING, 'held through the mass silence');
    assert.match(a.warns.join('\n'), /have been silent for over 45s at once/);
    await crowdBeats();
    await a.reaper.tick();
    assert.equal((await stateOf(session)).status, RunStatus.RUNNING, 'and held on as the silence lifts');
    assert.match(a.warns.at(-1)!, /a fifth of the cell's runners went silent together less than 90s ago/);

    // That process is killed, its hold with it. Another, up as a follower for an hour, takes the lock.
    sinceA = null;
    let sinceB: number | null = null;
    const leaderB = { leads: () => sinceB !== null, leadingSince: () => sinceB } as unknown as ControlPlaneLeader;
    const b = reaperOf(presence, leaderB);
    b.upFor(60 * MINUTE);
    await b.reaper.tick();
    assert.equal(b.warns.length, 0, 'a follower does not sweep');
    sinceB = Date.now();
    await crowdBeats();
    await b.reaper.tick();
    assert.equal((await stateOf(session)).status, RunStatus.RUNNING, 'the reaper that took over reaps nothing at once');
    assert.match(b.warns.join('\n'), /the reaper started \d+s ago, inside its 180s startup grace/);

    // The control: a reaper up for an hour that sweeps as soon as it holds the lock, with nothing of the hold it took
    // over, reads a quiet cell and a runner two minutes silent, and reaps the session at its first sweep.
    const naive = reaperOf(presence);
    naive.upFor(60 * MINUTE);
    await naive.sweep();
    assert.deepEqual(await stateOf(session), REAPED, 'without the takeover rule the session is reaped at once');

    // Past its grace, the reaper that took over reaps as any reaper does.
    const later = await running(silent, 'its runner is still quiet after the grace');
    sinceB = Date.now() - STARTUP_GRACE_MS - MINUTE;
    await b.reaper.tick();
    assert.deepEqual(await stateOf(later), REAPED);
    await signOff(silent);
  });

  await t.test('(3) a heartbeat write that failed on process A holds the reaper on process B', async () => {
    await forgetProcesses();
    const leaderA = leaderOf();
    const leaderB = leaderOf();
    await leaderA.tick();
    await leaderB.tick();
    const presenceA = new RunnerPresenceService(pool() as unknown as PrismaService, leaderA);
    const presenceB = new RunnerPresenceService(db as unknown as PrismaService, leaderB);
    await presenceA.report();
    await presenceB.report();
    // B's reaper, long past its grace: it sweeps whenever it is asked.
    const b = reaperOf(presenceB);
    const silent = await silentRunner();

    await crowdBeats();
    const control = await running(silent, 'reaped in a quiet cell');
    await b.sweep();
    assert.deepEqual(await stateOf(control), REAPED, 'the control: nothing holds, and the silent runner’s run is reaped');

    // A heartbeat that reached process A, whose pool could not give it a connection: nothing recorded it.
    presenceA.beatNotRecorded(Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' }));
    await presenceA.report();
    const { rows: [row] } = await sql.query<{ lostAgoMs: number }>(
      `SELECT (extract(epoch FROM (now() - "beat_lost_at")) * 1000)::float8 AS "lostAgoMs" FROM "apiserver_process" WHERE "id" = $1`,
      [leaderA.processId],
    );
    assert.ok(row.lostAgoMs >= 0 && row.lostAgoMs < 10 * SECOND, `A's row says a beat was lost just now: ${row.lostAgoMs} ms`);

    const held = await running(silent, 'held while A cannot write the beats it takes');
    await crowdBeats();
    await b.sweep();
    assert.equal((await stateOf(held)).status, RunStatus.RUNNING, 'B does not read the silence A left as the runner gone');
    assert.match(b.warns.at(-1)!, new RegExp(`a heartbeat write failed on apiserver process ${leaderA.processId.slice(0, 8)} \\d+s ago, inside the 90s runner silence is read from`));
    assert.equal(presenceB.lastBeatNotRecordedAt(), null, 'B lost no beat of its own: the hold is A’s');

    // Not a latch: once A's lost beat is older than the window a runner's silence is read from, B reaps.
    await sql.query(
      `UPDATE "apiserver_process" SET "beat_lost_at" = now() - make_interval(secs => $2) WHERE "id" = $1`,
      [leaderA.processId, (RUNNER_OFFLINE_AFTER_MS + 10 * SECOND) / SECOND],
    );
    await crowdBeats();
    await b.sweep();
    assert.deepEqual(await stateOf(held), REAPED);
    await signOff(silent);
    await leaderA.onModuleDestroy();
    await leaderB.onModuleDestroy();
    await lockFree();
  });

  await t.test('(4) a process that has stopped reporting holds the reaper, while it is connected and for a while after it has gone', async () => {
    await forgetProcesses();
    const leaderA = leaderOf();
    const leaderB = leaderOf();
    await leaderA.tick();
    await leaderB.tick();
    const presenceA = new RunnerPresenceService(pool() as unknown as PrismaService, leaderA);
    const presenceB = new RunnerPresenceService(db as unknown as PrismaService, leaderB);
    await presenceA.report();
    const b = reaperOf(presenceB);
    const silent = await silentRunner();
    /** A's row as it reads once A has not written it for `ms`: its pool cannot, or A is gone. */
    const quietFor = (ms: number) => sql.query(
      `UPDATE "apiserver_process" SET "seen_at" = now() - make_interval(secs => $2), "beat_lost_at" = NULL WHERE "id" = $1`,
      [leaderA.processId, ms / SECOND],
    );
    const sweepAfter = async (ms: number) => {
      await quietFor(ms);
      await crowdBeats();
      await b.sweep();
    };
    const a8 = leaderA.processId.slice(0, 8);

    // Still connected, and not writing its row: its pool exhausted, the beats it takes not landing either.
    const connectedQuiet = await running(silent, 'held while A is quiet but connected');
    assert.equal(await connected(leaderA.processId), true);
    await sweepAfter(APISERVER_PROCESS_QUIET_AFTER_MS + 10 * SECOND);
    assert.equal((await stateOf(connectedQuiet)).status, RunStatus.RUNNING);
    assert.match(b.warns.at(-1)!, new RegExp(`apiserver process ${a8} has not reported for 40s though it is still connected`));
    await sweepAfter(APISERVER_PROCESS_QUIET_AFTER_MS + 5 * MINUTE);
    assert.equal((await stateOf(connectedQuiet)).status, RunStatus.RUNNING, 'for as long as it is connected, within the window');
    await sweepAfter(APISERVER_PROCESS_QUIET_AFTER_MS + MASS_SILENCE_WINDOW_MS + MINUTE);
    assert.deepEqual(await stateOf(connectedQuiet), REAPED, 'not a latch: quiet past the window, it holds nothing');

    // Gone: its coordination connection closed. Just past the quiet line it might be a process cut off from the
    // database rather than one that has gone, and it holds; RUNNER_OFFLINE_AFTER_MS past it, it does not.
    await leaderA.onModuleDestroy();
    await until('A is seen gone', async () => !(await connected(leaderA.processId)), 10 * SECOND);
    const gone = await running(silent, 'held while A has just gone quiet, connected or not');
    await sweepAfter(APISERVER_PROCESS_QUIET_AFTER_MS + 30 * SECOND);
    assert.equal((await stateOf(gone)).status, RunStatus.RUNNING);
    assert.match(b.warns.at(-1)!, new RegExp(`apiserver process ${a8} has not reported for 60s, so the heartbeats`));
    await sweepAfter(APISERVER_PROCESS_QUIET_AFTER_MS + RUNNER_OFFLINE_AFTER_MS + 30 * SECOND);
    assert.deepEqual(await stateOf(gone), REAPED);

    // Coming back from a quiet spell, a process says a beat was lost then: the beats it could not write while it was
    // quiet are silences, and the runners they belong to get a whole window to be heard again.
    const leaderC = leaderOf();
    await leaderC.tick();
    const presenceC = new RunnerPresenceService(pool() as unknown as PrismaService, leaderC);
    await presenceC.report();
    const lostAt = async () => (await db.apiserverProcess.findUniqueOrThrow({ where: { id: leaderC.processId } })).beatLostAt;
    assert.equal(await lostAt(), null, 'a process that reports on time has lost nothing');
    (presenceC as unknown as { reportedAt: number }).reportedAt = Date.now() - APISERVER_PROCESS_QUIET_AFTER_MS - 10 * SECOND;
    await presenceC.report();
    assert.notEqual(await lostAt(), null, 'one back from a spell longer than the quiet line says it lost a beat');
    await signOff(silent);
    await leaderB.onModuleDestroy();
    await leaderC.onModuleDestroy();
    await lockFree();
  });

  await t.test('(5) one apiserver alone takes the lock as it connects, and nothing of its own or of the processes before it holds its reaper', async () => {
    await forgetProcesses();
    // A process that ran before this one and has gone: last seen four minutes ago, a beat lost then.
    const before = randomUUID();
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "apiserver_process" ("id", "started_at", "seen_at", "beat_lost_at")
      VALUES (${before}::uuid, now() - interval '1 day', now() - interval '4 minutes', now() - interval '4 minutes')`);
    const leader = leaderOf();
    const startedAt = Date.now();
    leader.onModuleInit();
    const took = await until('a lone process takes the lock', () => leader.leads(), 5 * SECOND);
    t.diagnostic(`a lone process took the lock ${took} ms after it started`);
    assert.ok(leader.leadingSince()! - startedAt < 3 * SECOND, 'as it connects: its first pass');
    const presence = new RunnerPresenceService(db as unknown as PrismaService, leader);
    await presence.report();
    const silent = await silentRunner();
    const session = await running(silent, 'the lone process has just started');

    // Its reaper, built with the lock, starts its grace from the lock — which is to say from its start.
    const alone = reaperOf(presence, leader);
    await crowdBeats();
    await alone.reaper.tick();
    assert.equal((await stateOf(session)).status, RunStatus.RUNNING);
    assert.match(alone.warns.at(-1)!, /inside its 180s startup grace/);
    // A process gone just before this one started holds the reaping for at most this long past its last report, and the
    // grace a restart gives is longer: a lone apiserver's restart holds the reaping exactly as long as it did.
    assert.ok(APISERVER_PROCESS_QUIET_AFTER_MS + RUNNER_OFFLINE_AFTER_MS < STARTUP_GRACE_MS);

    // Its own row never holds its own reaper: a quiet spell and a lost beat of its own, as its row would say them. The
    // reaper beside it reads its own failures from memory, as it always has, and here it has none.
    await sql.query(
      `UPDATE "apiserver_process" SET "seen_at" = now() - interval '40 seconds', "beat_lost_at" = now() - interval '5 seconds' WHERE "id" = $1`,
      [leader.processId],
    );
    const pastGrace = reaperOf(presence);
    await crowdBeats();
    await pastGrace.sweep();
    assert.deepEqual(await stateOf(session), REAPED,
      'past its grace, nothing of its own row nor of the process before it holds the reaping');
    await leader.onModuleDestroy();
    await signOff(silent);
    await lockFree();
  });

  await t.test('(6) two production apiservers on one database: one runs the singleton sweeps; SIGKILL it and the other takes them over', async () => {
    await forgetProcesses();
    assert.equal(await holderOfTheLock(), null, 'no process of the cases above still holds the lock');
    const jwtSecret = `control-plane-leader-spec-${randomUUID()}`;
    const one = await startApiserver(url, jwtSecret);
    servers.push(one);
    const two = await startApiserver(url, jwtSecret);
    servers.push(two);
    const ledBy = (server: Apiserver, processId: string) =>
      server.output().includes(`apiserver process ${processId.slice(0, 8)} now runs the reaper, the task sweep and the auto-retry sweep`);

    // Both are up, both report themselves, both are seen connected; one holds the lock.
    await until('both report themselves', async () =>
      (await db.apiserverProcess.count()) === 2, 30 * SECOND);
    const ids = (await db.apiserverProcess.findMany({ select: { id: true } })).map((p) => p.id);
    for (const id of ids) assert.equal(await connected(id), true, `${id} is seen connected`);
    await until('one of them holds the lock', async () => (await holderOfTheLock()) !== null, 15 * SECOND);
    const leaderId = (await holderOfTheLock())!;
    const [leading, waiting] = ledBy(one, leaderId) ? [one, two] : [two, one];
    assert.ok(ledBy(leading, leaderId), 'the holder says it runs the sweeps');
    const waitingId = ids.find((id) => id !== leaderId)!;

    // Two polls' worth of the other one asking: the lock stays where it is, and the other never says it runs them.
    for (const deadline = Date.now() + 2 * LEADER_POLL_MS + SECOND; Date.now() < deadline;) {
      assert.equal(await holderOfTheLock(), leaderId);
      await sleep(250);
    }
    assert.equal(ledBy(waiting, waitingId), false, 'the other waits');

    // SIGKILL the holder: no shutdown of any kind. PostgreSQL lets its lock go as its sockets close.
    const killedAt = Date.now();
    leading.child.kill('SIGKILL');
    await until('the other takes the lock', async () => (await holderOfTheLock()) === waitingId, LEADER_POLL_MS + 10 * SECOND);
    const tookOverMs = Date.now() - killedAt;
    t.diagnostic(`the surviving apiserver took the singleton sweeps over ${tookOverMs} ms after the holder was killed`);
    assert.ok(tookOverMs <= LEADER_POLL_MS + 3 * SECOND, `within LEADER_POLL_MS and three seconds: ${tookOverMs} ms`);
    await until('and says so', () => ledBy(waiting, waitingId), 5 * SECOND);
    assert.equal(await connected(leaderId), false, 'the killed process is seen gone');
    assert.equal(await connected(waitingId), true);
  });
});
