/**
 * Adversarial replay: the 2026-09-14 list-pause incident, re-enacted against the split design.
 *
 * NOT the implementer's spec. `task-list-pause-projection.pg.spec.ts` asserts the design as the
 * design states itself; this file was written from the incident and from the candidate predicates,
 * by trying to make the new code fail. Where the two overlap it is on purpose — an independent
 * replay that shares no case with the implementation's is the only kind that can find what the
 * implementation's author could not see.
 *
 * WHAT HAPPENED, AND WHAT THIS REPLAYS
 * ------------------------------------
 * Four 27,468-task lists were PATCHed paused. The PATCH ran `task.updateMany({ dispatch_hold })`
 * inside its own transaction, which holds the owner graph mutex (lock-order.ts I1). One sweep took
 * 5+ minutes — `task` carries 27 indexes — every same-owner request queued behind it, clients timed
 * out, retried, and re-ran the whole O(n) unit until the blocking statement was cancelled by hand.
 * So the replay drives the incident itself: the PATCH, at the incident's size, with the owner's
 * other requests arriving *while the projection is running* — the condition the incident was made
 * of and the one the implementation's own case (which runs with the projector switched off) does
 * not reproduce.
 *
 * THE FIVE THINGS IT TRIES TO BREAK
 * ---------------------------------
 *   (A) O(1) UNDER LOAD. The PATCH returns promptly at 27,468 tasks with the projector enabled and
 *       sweeping, and a same-owner request — the same `user` row lock the PATCH takes, held to a
 *       `lock_timeout` — never waits for more than a page of the projection. The control is the
 *       probe itself: held owner scope, probe MUST fail. Numbers recorded, not adjectives.
 *   (B) A PROJECTOR KILLED MID-CHUNK, twice over: really killed, as a separate OS process,
 *       `SIGKILL`ed while its second chunk transaction is blocked mid-`UPDATE` — and stopped at a
 *       chunk boundary through the documented seam. Then: does the watermark reclaim it, does it
 *       converge, and does re-running rewrite anything? The last one is measured with a
 *       whole-list digest of `xmin`, which moves if ANY row is rewritten even to the same value.
 *   (C) THE LAST DECISION WINS, with two sweeps running at once and decisions landing mid-flight;
 *       and a same-value PATCH changes nothing at all.
 *   (D) FAIL-CLOSED ON DELETE. A paused list whose tasks a real candidate sweep would otherwise
 *       start, deleted; and the same list deleted while the projection is still in the window.
 *       The 55,513-task release must not be reproducible.
 *   (E) THE SPEC CAN FAIL. Two negative controls: a projector that is switched off leaves the rows
 *       unconverged (so convergence is being measured, not assumed), and an UNGUARDED rewrite of
 *       the same rows moves the digest the idempotence assertions read (so those assertions bite).
 *
 * Destructive: it seeds tens of thousands of rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { Logger } from '@nestjs/common';

import { Deadline } from '../deadlock/pg-barrier';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  PAUSE_PROJECTION_CHUNK,
  PAUSE_PROJECTION_LAG_WARN_MS,
  TaskListPauseProjectorService,
  type PauseProjectionOptions,
} from './task-list-pause-projector.service';
import { TaskListsService } from './task-lists.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails and titles are unique, and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);
/** The list the incident was about, to the row. */
const BIG = 27_468;
/** The second, ordinary list. The same-owner request that must not queue behind the big one. */
const NORMAL = 1_234;
/**
 * How long a same-owner request will wait before the probe gives up.
 *
 * Deliberately far above the bound this file ASSERTS (~4 chunks): the timeout is what keeps a
 * broken implementation from turning into a fifteen-minute spec, and the assertion is the number
 * that decides whether the design's claim ("a waiter is granted before the sweep's next chunk")
 * held on the day. A probe that times out is failing either way; a probe that waits six seconds
 * should fail the assertion with its measured value and not as a lock timeout.
 */
const PROBE_LIMIT_MS = 15_000;
/** Where tsc put this file's tree; the killed child is loaded from it, not from cwd. */
const BUILD = resolve(__dirname, '..');

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

interface Stack {
  db: PrismaClient;
  lists: TaskListsService;
  tasks: TasksService;
  projector: TaskListPauseProjectorService;
}

/** One `$executeRaw` a chunk transaction issued, and how long it took. */
interface StatementTiming {
  kind: 'chunk' | 'watermark';
  ms: number;
}

/**
 * A world with one online runner and one workspace bound to it, and the list service backed by a
 * projector built from `options` — and, when `timings` is passed, by one whose chunk transactions
 * are timed instead of merely observed.
 */
function stack(options: PauseProjectionOptions = {}, timings?: StatementTiming[]): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  const projector = timings
    ? timedProjector(prisma, timings, options)
    : new TaskListPauseProjectorService(prisma, options);
  return {
    db,
    projector,
    lists: new TaskListsService(prisma, publishes, sessions, projector),
    tasks: new TasksService(prisma, sessions, publishes),
  };
}

/**
 * The projector with every chunk transaction timed, so "per-chunk timing" is a measurement of the
 * statements the projector actually ran rather than of the sweep's total divided by a guess.
 *
 * Only `$executeRaw` inside a chunk transaction is timed: both writes a chunk makes are statements
 * there, and the reads are not what a waiter queues behind. The two are told apart by their target,
 * because the page is `task` and the watermark is `task_list`.
 */
function timedProjector(
  prisma: PrismaService,
  timings: StatementTiming[],
  options: PauseProjectionOptions,
): TaskListPauseProjectorService {
  const textOf = (strings: unknown): string =>
    typeof strings === 'string'
      ? strings
      : Array.isArray(strings)
        ? String(strings[0])
        : '';

  const timedTransactionClient = (tx: object): object =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === '$executeRaw') {
          return async (strings: unknown, ...values: unknown[]) => {
            const startedAt = performance.now();
            const written = await (
              (target as Record<string, unknown>)['$executeRaw'] as (
                s: unknown,
                ...v: unknown[]
              ) => Promise<number>
            )(strings, ...values);
            const text = textOf(strings);
            timings.push({
              kind: text.includes('"task_list"') ? 'watermark' : 'chunk',
              ms: performance.now() - startedAt,
            });
            return written;
          };
        }
        const value = (target as Record<string, unknown>)[prop as string];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  const proxied = new Proxy(prisma as unknown as object, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (work: (tx: object) => Promise<unknown>, opts?: unknown) =>
          (
            (target as Record<string, unknown>)['$transaction'] as (
              w: (tx: object) => Promise<unknown>,
              o?: unknown,
            ) => Promise<unknown>
          ).call(target, (tx) => work(timedTransactionClient(tx)), opts);
      }
      const value = (target as Record<string, unknown>)[prop as string];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new TaskListPauseProjectorService(proxied as unknown as PrismaService, options);
}

/** An owner with one online runner and one workspace bound to it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `${label}-${RUN}-${ids.ownerId}@replay.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: `${label}-agent`,
      enabled: true,
    },
  });
  return ids;
}

const seedList = (db: PrismaClient, ids: World, title: string) =>
  db.taskList.create({
    data: { id: randomUUID(), ownerId: ids.ownerId, title: `${title}-${RUN}` },
    select: { id: true },
  });

/**
 * An automatic-dispatch candidate that is filed under a coordinated Project: the shape
 * PROJECT_INDEPENDENT_READY_SQL exists for, and the shape that RUNS — which is what makes an
 * assertion about a task not being offered about the pause rather than about the fixture.
 */
async function project(db: PrismaClient, ids: World, label: string): Promise<string> {
  const id = randomUUID();
  await db.project.create({
    data: {
      id,
      ownerId: ids.ownerId,
      title: `${label}-${RUN}`,
      coordinatorEnabled: true,
      maxConcurrentTasks: 8,
    },
  });
  await establishProjectContractForPgTest(db, ids.ownerId, id, `${label}-${RUN}`);
  return id;
}

/**
 * A list's tasks in bulk, the way the incident's list existed: many rows, one INSERT, every index
 * on `task` maintained by it. SQL, never an ORM loop — a 27,468-row seed through Prisma's client
 * would be a different test (of this file's patience) and not of the incident.
 */
async function seedTasks(
  db: PrismaClient,
  ids: World,
  listId: string,
  count: number,
  opts: { projectId?: string; held?: boolean } = {},
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "task"(
       "id", "title", "owner_id", "list_id", "project_id", "creator_type", "creator_id", "status",
       "auto_run_when_ready", "dispatch_hold", "assignee_id", "completion_criterion", "updated_at"
     )
     SELECT gen_random_uuid(), 'incident work ' || i, $1::uuid, $2::uuid, $3::uuid, 'USER',
            $1::uuid, 'OPEN', true, $4::boolean, $5::uuid, 'EVIDENCE_JUDGMENT', now()
       FROM generate_series(1, $6::int) AS i`,
    ids.ownerId,
    listId,
    opts.projectId ?? null,
    opts.held ?? false,
    ids.workspaceId,
    count,
  );
}

interface ListState {
  paused: boolean;
  pauseEpoch: number;
  pauseAppliedEpoch: number;
}

const state = (db: PrismaClient, listId: string): Promise<ListState> =>
  db.taskList.findUniqueOrThrow({
    where: { id: listId },
    select: { paused: true, pauseEpoch: true, pauseAppliedEpoch: true },
  });

const heldCount = (db: PrismaClient, listId: string): Promise<number> =>
  db.task.count({ where: { listId, dispatchHold: true } });

const unheldCount = (db: PrismaClient, listId: string): Promise<number> =>
  db.task.count({ where: { listId, dispatchHold: false } });

interface Snapshot {
  rows: number;
  held: number;
  /** Every row's value — `id:dispatch_hold:updated_at`. */
  values: string;
  /** Every row's tuple version. Moves if a row is rewritten AT ALL, even to the value it had. */
  tuples: string;
}

/**
 * The whole list in one read: how many rows, how many are held, and two digests.
 *
 * `tuples` is the one that matters for idempotence. A rewrite that sets a column to the value it
 * already held is invisible to `values` but is a new tuple version, which is exactly what the
 * chunk guard (`dispatch_hold <> target`) exists to prevent and exactly what a disabled guard would
 * leave behind. Without it, "re-running changes nothing" would be a claim about the column values
 * and not about the work.
 */
async function snapshot(db: PrismaClient, listId: string): Promise<Snapshot> {
  const [row] = await db.$queryRawUnsafe<
    Array<{ rows: bigint; held: bigint; values: string; tuples: string }>
  >(
    `SELECT count(*)::bigint AS rows,
            count(*) FILTER (WHERE "dispatch_hold")::bigint AS held,
            md5(coalesce(string_agg("id"::text || ':' || "dispatch_hold"::text || ':'
              || "updated_at"::text, ',' ORDER BY "id"), '')) AS values,
            md5(coalesce(string_agg("id"::text || ':' || "xmin"::text, ',' ORDER BY "id"), '')) AS tuples
       FROM "task" WHERE "list_id" = $1::uuid`,
    listId,
  );
  return {
    rows: Number(row.rows),
    held: Number(row.held),
    values: row.values,
    tuples: row.tuples,
  };
}

/** Rows still carrying the wrong `dispatch_hold` for the list's decision. Zero is convergence. */
async function wrongRows(db: PrismaClient, listId: string): Promise<number> {
  const [row] = await db.$queryRawUnsafe<Array<{ wrong: bigint }>>(
    `SELECT count(*)::bigint AS wrong FROM "task" t
      JOIN "task_list" l ON l."id" = t."list_id"
     WHERE t."list_id" = $1::uuid AND t."dispatch_hold" <> l."paused"`,
    listId,
  );
  return Number(row.wrong);
}

/** Poll a condition, failing with what was being waited for rather than with a bare timeout. */
async function waitUntil(
  what: string,
  condition: () => Promise<boolean>,
  { timeoutMs = 60_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<number> {
  const startedAt = performance.now();
  for (;;) {
    if (await condition()) return performance.now() - startedAt;
    if (performance.now() - startedAt > timeoutMs) {
      assert.fail(`waited ${timeoutMs}ms for: ${what}`);
    }
    await delay(pollMs);
  }
}

/** Whether the list is converged, without waiting for it: the predicate `converge` polls. */
async function converged(db: PrismaClient, listId: string): Promise<boolean> {
  const now = await state(db, listId);
  return now.pauseAppliedEpoch === now.pauseEpoch && (await wrongRows(db, listId)) === 0;
}

/**
 * Wait for a condition WITHOUT failing: how long it took, or null if it never held.
 *
 * For the questions whose answer is a measurement rather than a requirement — "did the kick alone
 * settle this, or did it take the catch-up tick?" — where an assertion would decide in advance the
 * thing the case exists to observe.
 */
async function attempt(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<number | null> {
  const startedAt = performance.now();
  for (;;) {
    if (await condition()) return performance.now() - startedAt;
    if (performance.now() - startedAt > timeoutMs) return null;
    await delay(50);
  }
}

/** Converged: the watermark has caught the decision and every row agrees with it. */
async function converge(
  db: PrismaClient,
  listId: string,
  { timeoutMs = 60_000, rows }: { timeoutMs?: number; rows?: number } = {},
): Promise<number> {
  return waitUntil(
    `list ${listId} to converge`,
    async () => {
      const now = await state(db, listId);
      if (now.pauseAppliedEpoch !== now.pauseEpoch) return false;
      if (rows === undefined) return true;
      return (await heldCount(db, listId)) === rows || (await unheldCount(db, listId)) === rows;
    },
    { timeoutMs },
  );
}

// ---------------------------------------------------------------------------------------------
// The owner scope: the lock the incident was queued behind, driven as a measurement.
// ---------------------------------------------------------------------------------------------

/**
 * A stream of same-owner requests, each bounded by `lock_timeout`.
 *
 * This is the incident's traffic reduced to what it was: `BEGIN; lock_timeout; SELECT … FOR UPDATE
 * user; COMMIT` is exactly the first thing every same-owner write does (rank 10, I1), so if the
 * projection ever held the owner scope for a sweep, this loop would be the requests that queued —
 * and each one would fail with 55P03 rather than wait for five minutes.
 */
function startOwnerScopeProbe(ownerId: string) {
  const waits: number[] = [];
  const failures: string[] = [];
  let stopped = false;
  const client = new Client({ connectionString: URL! });
  const loop = (async () => {
    await client.connect();
    while (!stopped) {
      const startedAt = performance.now();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
          `${PROBE_LIMIT_MS}ms`,
        ]);
        await client.query('SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE', [ownerId]);
        await client.query('COMMIT');
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
        await client.query('ROLLBACK').catch(() => undefined);
      }
      waits.push(performance.now() - startedAt);
    }
    await client.end();
  })();
  return {
    async stop(): Promise<{ waits: number[]; failures: string[] }> {
      stopped = true;
      await loop;
      return { waits, failures };
    },
  };
}

/** The same one-shot probe, as an assertion. 500ms or it fails — a probe that waits proves nothing. */
async function acquireOwnerScope(ownerId: string, label: string): Promise<void> {
  const client = new Client({ connectionString: URL! });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '500ms'`);
    await client.query('SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE', [ownerId]);
    await client.query('COMMIT');
  } catch (e) {
    throw new Error(`${label}: the owner scope was not free: ${e instanceof Error ? e.message : e}`);
  } finally {
    await client.end();
  }
}

/** Hold the owner scope on its own connection, for the control that proves the probe bites. */
async function holdOwnerScope(ownerId: string): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: URL! });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE', [ownerId]);
  return async () => {
    await client.query('ROLLBACK');
    await client.end();
  };
}

/** The median of a set of waits, which is the number a client would actually have felt. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const round = (value: number): number => Math.round(value);

// ---------------------------------------------------------------------------------------------
// The killable projector: a real process, killed where a crash actually lands.
// ---------------------------------------------------------------------------------------------

/**
 * The child: a real projector, over a real connection, sweeping one list.
 *
 * `-e` and absolute paths because the parent must not depend on cwd, and the child must load THIS
 * build's projector rather than whatever the main checkout left behind.
 */
const CHILD_SWEEP_SOURCE = [
  // `node -e '<source>' a b c` puts the first argument at argv[1], because argv[1] is the script
  // itself only when there is a script file.
  'const { prismaClientFor } = require(process.argv[1]);',
  'const { TaskListPauseProjectorService } = require(process.argv[2]);',
  'const db = prismaClientFor(process.env.COORDINATOR_PG_URL);',
  'const listId = process.argv[3];',
  'const chunkSize = Number(process.argv[4]);',
  'const projector = new TaskListPauseProjectorService(db, { chunkSize });',
  "process.stdout.write('SWEEP_READY\\n');",
  'projector.sweep(listId)',
  "  .then((r) => { process.stdout.write('SWEEP_DONE ' + JSON.stringify(r) + '\\n'); process.exit(0); })",
  "  .catch((e) => { process.stdout.write('SWEEP_FAILED ' + (e && e.message) + '\\n'); process.exit(3); });",
].join('\n');

function spawnSweeper(listId: string, chunkSize: number) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      CHILD_SWEEP_SOURCE,
      join(BUILD, 'prisma/prisma-client.js'),
      join(BUILD, 'task-lists/task-list-pause-projector.service.js'),
      listId,
      String(chunkSize),
    ],
    { env: { ...process.env, COORDINATOR_PG_URL: URL! }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let exitCode: number | null | undefined;
  let exitSignal: NodeJS.Signals | null = null;
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolveExit({ code, signal });
    });
  });
  return {
    child,
    exited,
    output: () => output,
    /** Whether it is gone, and how — a child that died is the difference between a slow sweep
     *  and a sweep that never started. */
    gone: () => exitCode !== undefined || exitSignal !== null,
    async kill(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
      child.kill('SIGKILL');
      return exited;
    },
    /** Kill it if it is still alive, swallowing the race with an exit already in flight. */
    async reap(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}

type Sweeper = ReturnType<typeof spawnSweeper>;

/**
 * Wait for the child to say it is running a sweep.
 *
 * The child's output is carried in the failure message on purpose: the first version of this file
 * got the argv indices wrong, the child died at `require` before touching the database, and the
 * parent spent ninety seconds reporting a sweep that had never started — with the child's own
 * error message sitting unread in a buffer nobody printed.
 */
async function awaitChildReady(sweeper: Sweeper, deadline: Deadline): Promise<void> {
  for (;;) {
    if (sweeper.output().includes('SWEEP_READY')) return;
    if (sweeper.gone()) {
      assert.fail(`the sweeper child exited before sweeping anything: ${sweeper.output()}`);
    }
    deadline.assertLive(`the sweeper child to start (output so far: ${sweeper.output() || 'none'})`);
    await delay(25);
  }
}

/** Hold a row on its own connection, so a chunk that must rewrite it cannot get past this point. */
async function holdTaskRow(
  taskId: string,
): Promise<{ pid: number; release: () => Promise<void> }> {
  const client = new Client({ connectionString: URL! });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE', [taskId]);
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return {
    pid: rows[0].pid,
    release: async () => {
      await client.query('ROLLBACK');
      await client.end();
    },
  };
}

/**
 * Wait for the sweeper's chunk to be parked behind that row — the moment the kill lands.
 *
 * Both halves of one snapshot, as the barrier harness insists on: a backend joins the wait queue
 * before it publishes its wait event, so `pg_blocking_pids` alone could advance before the wait is
 * real, and a wait event alone could be about some other lock. The statement is read back too,
 * because "killed mid-chunk" is the claim and the statement is its evidence.
 */
async function awaitChunkParkedBehind(
  observer: Client,
  blockerPid: number,
  deadline: Deadline,
): Promise<{ pid: number; statement: string }> {
  for (;;) {
    deadline.assertLive('the sweeper to park mid-chunk behind the held row');
    const { rows } = await observer.query<{ pid: number; query: string }>(
      `SELECT pid, query FROM pg_stat_activity
        WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`,
      [blockerPid],
    );
    if (rows[0]) return { pid: rows[0].pid, statement: rows[0].query };
    await delay(25);
  }
}

/** Wait for a backend to be gone, so the mutex it held is provably free before the next sweep. */
async function awaitBackendGone(observer: Client, pid: number, deadline: Deadline): Promise<void> {
  for (;;) {
    deadline.assertLive(`backend ${pid} to be reaped`);
    const { rows } = await observer.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS present',
      [pid],
    );
    if (!rows[0].present) return;
    await delay(25);
  }
}

/** Whether the sweep OFFERED a task to the run door — the receipt exists even for a refusal. */
const offered = (db: PrismaClient, ownerId: string, taskId: string) =>
  db.taskRunRequest.count({ where: { ownerId, fingerprint: `task:${taskId}` } });

/** Every receipt for those tasks, in one number. Run-door receipts survive the list's deletion. */
const offeredForTasks = (db: PrismaClient, ownerId: string, taskIds: string[]): Promise<number> =>
  db.taskRunRequest.count({
    where: { ownerId, fingerprint: { in: taskIds.map((taskId) => `task:${taskId}`) } },
  });

/** The same, for every task a list holds right now. */
async function offeredFromList(db: PrismaClient, ownerId: string, listId: string): Promise<number> {
  const tasks = await db.task.findMany({ where: { listId }, select: { id: true } });
  return offeredForTasks(db, ownerId, tasks.map((task) => task.id));
}

const runCandidateSweeps = (tasks: TasksService): Promise<void> =>
  (tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

// ---------------------------------------------------------------------------------------------
// (A) The incident itself: a 27,468-task PATCH, under load, while the projection runs.
// ---------------------------------------------------------------------------------------------

test('(A) the incident replayed: a 27,468-task pause returns promptly and no same-owner request queues behind the projection', { skip, timeout: 480_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const timings: StatementTiming[] = [];
  const s = stack({}, timings);
  // Registered as they are acquired so an assertion that fails halfway still tears them down: a
  // probe left mid-request and a scope left held would each stall the next case rather than this
  // one, which is the least useful place for a failure to land.
  let stopProbe: (() => Promise<{ waits: number[]; failures: string[] }>) | null = null;
  let releaseScope: (() => Promise<void>) | null = null;
  try {
    const ids = await world(s.db, 'a');
    const projectId = await project(s.db, ids, 'a');
    const big = await seedList(s.db, ids, 'a-big');
    const normal = await seedList(s.db, ids, 'a-normal');
    // The control list: the same shape, in the same Project, one row per task so that "was it
    // offered" is a number a reader can check rather than a claim about a shape.
    const control = await seedList(s.db, ids, 'a-control');

    const seededAt = performance.now();
    await seedTasks(s.db, ids, big.id, BIG, { projectId });
    await seedTasks(s.db, ids, normal.id, NORMAL, { projectId });
    console.log(
      `(A) seeded ${BIG} + ${NORMAL} tasks in ${round(performance.now() - seededAt)}ms`,
    );
    const controlTasks: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = randomUUID();
      controlTasks.push(id);
      await s.db.task.create({
        data: {
          id,
          ownerId: ids.ownerId,
          listId: control.id,
          projectId,
          assigneeId: ids.workspaceId,
          title: `control-${i}-${RUN}`,
          creatorType: CreatorType.USER,
          creatorId: ids.ownerId,
          completionCriterion: 'EVIDENCE_JUDGMENT',
          status: TaskStatus.OPEN,
          autoRunWhenReady: true,
          dispatchHold: false,
        },
      });
    }

    // The traffic. Started before the PATCH so the first request is already in flight when the
    // projection begins, which is the incident's shape: the PATCH was slow because the requests
    // AROUND it were already queued.
    const probe = startOwnerScopeProbe(ids.ownerId);
    stopProbe = () => probe.stop();

    // (A.1) the PATCH itself
    const patchStartedAt = performance.now();
    await s.lists.update(ids.ownerId, big.id, { paused: true });
    const patchMs = performance.now() - patchStartedAt;
    const decided = await state(s.db, big.id);
    assert.equal(decided.paused, true, 'the pause was not decided');
    assert.equal(decided.pauseEpoch, 1, 'the decision did not bump the epoch');
    assert.equal(
      decided.pauseAppliedEpoch,
      0,
      'the request claimed to have projected the pause, which is the thing that wedged it',
    );
    assert.equal(await heldCount(s.db, big.id), 0, 'the PATCH wrote task rows');
    assert.equal(await unheldCount(s.db, big.id), BIG, 'the PATCH wrote task rows');

    // (A.2) a same-owner request ARRIVING WHILE THE PROJECTION RUNS. This is the case the incident
    // was made of and the one the implementation's own spec cannot see, because it switches the
    // projector off before it probes. It is a real service call — a PATCH of the ordinary list —
    // and it takes the same owner mutex the sweeper takes per chunk.
    const secondStartedAt = performance.now();
    await s.lists.update(ids.ownerId, normal.id, { paused: true });
    const secondPatchMs = performance.now() - secondStartedAt;

    // The projection window, measured rather than asserted: PATCH returned -> first row held ->
    // every row held. The design accepts this window; the replay's job is to put a number on it.
    const firstHeldMs = await waitUntil(
      'the first task of the big list to be held',
      async () => (await heldCount(s.db, big.id)) > 0,
      { timeoutMs: 90_000, pollMs: 10 },
    );
    const convergenceMs = await converge(s.db, big.id, { rows: BIG, timeoutMs: 120_000 });
    const settledAt = await state(s.db, big.id);
    assert.equal(settledAt.pauseAppliedEpoch, settledAt.pauseEpoch, 'the watermark never caught up');
    assert.equal(await wrongRows(s.db, big.id), 0, 'a row of the paused list is still dispatchable');

    // (A.3) a same-value PATCH: a client retrying what it already sent, which is what turned one
    // slow write into fourteen minutes of them on 2026-09-14.
    const before = await snapshot(s.db, big.id);
    const repeatStartedAt = performance.now();
    await s.lists.update(ids.ownerId, big.id, { paused: true });
    const repeatMs = performance.now() - repeatStartedAt;
    const repeatState = await state(s.db, big.id);
    assert.equal(repeatState.pauseEpoch, 1, 'a same-value PATCH bumped the epoch');
    const afterRepeat = await snapshot(s.db, big.id);
    assert.equal(afterRepeat.tuples, before.tuples, 'a same-value PATCH rewrote task rows');

    const probes = await probe.stop();
    const worstProbe = probes.waits.length > 0 ? Math.max(...probes.waits) : 0;
    const chunkTimings = timings.filter((t) => t.kind === 'chunk').map((t) => t.ms);
    const slowestChunk = chunkTimings.length > 0 ? Math.max(...chunkTimings) : 0;
    console.log(
      `(A) PATCH of a ${BIG}-task list: ${round(patchMs)}ms `
        + `(task rows written: 0). Same-owner PATCH while the projection ran: ${round(secondPatchMs)}ms. `
        + `Same-value PATCH: ${round(repeatMs)}ms, epoch still ${repeatState.pauseEpoch}.`,
    );
    console.log(
      `(A) projection: first row held ${round(firstHeldMs)}ms after the PATCH, all ${BIG} held `
        + `${round(convergenceMs)}ms after it, in ${chunkTimings.length} chunk update(s) of `
        + `${PAUSE_PROJECTION_CHUNK} (min ${round(Math.min(...chunkTimings))}ms / median `
        + `${round(median(chunkTimings))}ms / max ${round(slowestChunk)}ms per chunk).`,
    );
    console.log(
      `(A) owner-scope probes during all of it: ${probes.waits.length} requests, median `
        + `${round(median(probes.waits))}ms, worst ${round(worstProbe)}ms, `
        + `${probes.failures.length} timed out at ${PROBE_LIMIT_MS}ms.`,
    );

    // The assertions on those numbers. A same-owner request may wait for ONE page of the
    // projection — that is the design's claim and the reason the page size is the knob — but not
    // for the sweep: a wait of the sweep's own length is the incident.
    assert.equal(
      probes.failures.length,
      0,
      `a same-owner request waited more than ${PROBE_LIMIT_MS}ms for the owner scope: `
        + `${probes.failures[0]}`,
    );
    assert.ok(
      probes.waits.length >= 20,
      `only ${probes.waits.length} same-owner requests were driven during the projection, which `
        + 'is too few for "none of them queued" to mean anything',
    );
    assert.ok(
      chunkTimings.length >= 2,
      'fewer than two chunk statements were timed, so no per-chunk number was measured',
    );
    const bound = Math.max(2_000, 4 * slowestChunk);
    assert.ok(
      worstProbe < bound,
      `the worst same-owner wait was ${round(worstProbe)}ms against a slowest chunk of `
        + `${round(slowestChunk)}ms — a request waited for the sweep rather than for a page`,
    );
    assert.ok(
      patchMs < bound && secondPatchMs < bound,
      `a PATCH took ${round(patchMs)}ms / ${round(secondPatchMs)}ms against a slowest chunk of `
        + `${round(slowestChunk)}ms`,
    );

    // The probe control: with the owner scope held, the SAME probe must fail. Without this, "the
    // scope was free" would be equally consistent with a probe that never waits at all.
    await acquireOwnerScope(ids.ownerId, 'after the projection');
    const release = await holdOwnerScope(ids.ownerId);
    releaseScope = release;
    await assert.rejects(
      () => acquireOwnerScope(ids.ownerId, 'control'),
      /owner scope was not free/,
      'the lock_timeout probe did not fail with the owner scope held, so it proves nothing',
    );
    await release();
    releaseScope = null;
    await acquireOwnerScope(ids.ownerId, 'after the control released it');

    // (A.4) The candidate sweeps, run for real, at scale. Two predicates on one pass; the control
    // list is the same fixture in the same Project, unpaused, so it must be offered. The ordinary
    // list is converged first so the only unheld tasks left in this world are the control's.
    await converge(s.db, normal.id, { rows: NORMAL, timeoutMs: 120_000 });
    await runCandidateSweeps(s.tasks);
    const offeredBig = await offeredFromList(s.db, ids.ownerId, big.id);
    const offeredControl = await offeredFromList(s.db, ids.ownerId, control.id);
    const sessionsForControl = await s.db.session.count({
      where: { ownerId: ids.ownerId, taskId: { in: controlTasks } },
    });
    console.log(
      `(A) candidate sweeps over a paused ${BIG}-task list: ${offeredBig} of ${BIG} tasks offered; `
        + `same-shaped control list: ${offeredControl} of 5 offered, ${sessionsForControl} started.`,
    );
    assert.equal(
      offeredBig,
      0,
      `${offeredBig} tasks of a paused list were offered to the run door — the projection left them `
        + 'dispatchable',
    );
    assert.equal(
      offeredControl,
      5,
      'the control list was not offered, so the assertion above is about the fixture and not about '
        + 'the pause',
    );
    assert.equal(sessionsForControl, 5, 'the control list was offered but nothing started');

    // (A.5) Resume: the same list, the same shape, and the tasks ARE offered — the mirror image of
    // the assertion above, on a list nobody could accuse of being un-dispatchable.
    await s.lists.update(ids.ownerId, big.id, { paused: false });
    await converge(s.db, big.id, { rows: 0, timeoutMs: 120_000 });
    const resumed = await state(s.db, big.id);
    assert.equal(resumed.pauseEpoch, 2);
    assert.equal(resumed.pauseAppliedEpoch, 2);
    assert.equal(await heldCount(s.db, big.id), 0, 'a task stayed held after the resume');

    // (A.6) Idempotence at scale: an already-converged sweep rewrites nothing, values AND tuples.
    const beforeIdle = await snapshot(s.db, big.id);
    const idle = await s.projector.sweep(big.id);
    const afterIdle = await snapshot(s.db, big.id);
    assert.equal(idle.changed, 0, 'a converged list was rewritten');
    assert.equal(afterIdle.tuples, beforeIdle.tuples, 'a row was rewritten by a converged sweep');
    assert.equal(afterIdle.values, beforeIdle.values);
  } finally {
    if (stopProbe) await stopProbe().catch(() => undefined);
    if (releaseScope) await releaseScope().catch(() => undefined);
    await s.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (B) A projector killed mid-sweep — really killed, and stopped at a boundary.
// ---------------------------------------------------------------------------------------------

test('(B) a projector SIGKILLed mid-chunk and a projector stopped at a chunk boundary both strand nothing', { skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const deciding = stack({ enabled: false });
  const observer = new Client({ connectionString: URL! });
  // Held outside the body so every one of them is released on the way out: a `pg` client left in a
  // transaction holds row locks (and its socket keeps this process alive), and a child left running
  // holds the owner mutex for the whole file.
  let barrier: { pid: number; release: () => Promise<void> } | null = null;
  let sweeper: Sweeper | null = null;
  let recovering: Stack | null = null;
  try {
    await observer.connect();
    const ids = await world(deciding.db, 'b');
    const list = await seedList(deciding.db, ids, 'b-midchunk');
    await seedTasks(deciding.db, ids, list.id, 6_000);
    // Decided with the projector off, so what the crash leaves behind is built rather than raced
    // for: three chunks of 2,000 rows, and a watermark that has not moved.
    await deciding.lists.update(ids.ownerId, list.id, { paused: true });
    assert.equal(await heldCount(deciding.db, list.id), 0);
    const horizon = await snapshot(deciding.db, list.id);
    assert.equal(horizon.rows, 6_000);

    // The row the SECOND chunk has to rewrite. Chunk 1 (the first 2,000 ids) commits first; this
    // transaction can never get past the row below, so the kill is guaranteed to land in chunk 2
    // with chunk 1 already durable — which is the state a crash leaves and the state the watermark
    // has to be able to reclaim.
    const [parkedRow] = await deciding.db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "task" WHERE "list_id" = $1::uuid ORDER BY "id" OFFSET 2500 LIMIT 1`,
      list.id,
    );
    barrier = await holdTaskRow(parkedRow.id);

    sweeper = spawnSweeper(list.id, PAUSE_PROJECTION_CHUNK);
    const deadline = new Deadline(90_000);
    await awaitChildReady(sweeper, deadline);
    const chunkOneMs = await waitUntil(
      "the sweeper's first chunk to commit",
      async () => (await heldCount(deciding.db, list.id)) === PAUSE_PROJECTION_CHUNK,
      { timeoutMs: 60_000, pollMs: 10 },
    );
    const parked = await awaitChunkParkedBehind(observer, barrier.pid, deadline);
    assert.match(
      parked.statement,
      /UPDATE "task"/,
      'the parked statement is not the chunk update, so this kill is not a mid-chunk kill',
    );
    console.log(
      `(B) first chunk committed ${round(chunkOneMs)}ms in; the second is parked mid-UPDATE `
        + `(${parked.statement.slice(0, 60).replace(/\s+/g, ' ')}…); SIGKILL.`,
    );

    const killed = await sweeper.kill();
    assert.equal(killed.signal, 'SIGKILL', 'the sweeper was not killed by SIGKILL');
    // The process is gone; the statement it left parked is not. A backend waiting on a row lock
    // does not notice that its client died — MEASURED, not assumed: the first version of this kill
    // sat here for ninety seconds waiting for the backend to be reaped while it was still there,
    // blocked, holding the owner mutex. What ends it is the server, which is also how a real
    // crash's leftover transaction ends, so this is the honest completion of the kill rather than a
    // substitute for it: the client dies first and cannot retry, then the transaction it left is
    // aborted mid-statement.
    await observer.query('SELECT pg_terminate_backend($1)', [parked.pid]);
    await awaitBackendGone(observer, parked.pid, deadline);
    await barrier.release();
    barrier = null;

    // What a mid-chunk death leaves: one chunk's worth of work committed, the other transaction
    // rolled back whole (its row locks died with it), and a watermark that has not moved.
    const crashed = await snapshot(deciding.db, list.id);
    const crashedState = await state(deciding.db, list.id);
    assert.equal(
      crashed.held,
      PAUSE_PROJECTION_CHUNK,
      'the killed chunk left a partial page behind',
    );
    assert.equal(
      crashedState.pauseAppliedEpoch,
      0,
      'an interrupted sweep advanced the watermark, so nothing would reclaim it',
    );
    assert.ok(crashed.tuples !== horizon.tuples, 'the first chunk did not commit');

    // The reclaim, by the route the design names for a crash: the catch-up scan. A restarted
    // process runs it on its first tick; it finds this list from the watermark alone — no cursor,
    // no lease, nothing written by the run that died — and walks it.
    recovering = stack();
    const tick = await recovering.projector.catchUp();
    const reclaimMs = await converge(recovering.db, list.id, { rows: 6_000, timeoutMs: 120_000 });
    const reclaimedState = await state(recovering.db, list.id);
    assert.equal(
      tick.changed,
      4_000,
      'the catch-up reclaimed a different number of rows than the page the crash lost',
    );
    assert.equal(reclaimedState.pauseAppliedEpoch, 1, 'the watermark did not reach the decision');
    assert.equal(await wrongRows(recovering.db, list.id), 0, 'a row was left stranded');
    console.log(
      `(B) mid-chunk kill: 2,000 rows durable, 4,000 reclaimed by the catch-up scan `
        + `(${tick.lists} list(s) behind) in ${round(reclaimMs)}ms; stranded rows: 0.`,
    );

    // And re-running the reclaim rewrites NOTHING — the property the watermark's safety rests on.
    const beforeRerun = await snapshot(recovering.db, list.id);
    const rerun = await recovering.projector.sweep(list.id);
    const afterRerun = await snapshot(recovering.db, list.id);
    assert.equal(rerun.changed, 0, 'the reclaim rewrote rows it had already applied');
    assert.equal(afterRerun.tuples, beforeRerun.tuples, 'a tuple was rewritten by a no-op sweep');
    assert.equal(afterRerun.values, beforeRerun.values);

    // The boundary kill, through the seam the design documents for exactly this: a pass that stops
    // after one committed chunk is what a process killed at a chunk boundary leaves.
    const boundary = await seedList(deciding.db, ids, 'b-boundary');
    await seedTasks(deciding.db, ids, boundary.id, 3_000);
    await deciding.lists.update(ids.ownerId, boundary.id, { paused: true });
    const stopping = new TaskListPauseProjectorService(
      deciding.db as unknown as PrismaService,
      { chunkSize: 1_000, maxChunksPerPass: 1 },
    );
    const stopped = await stopping.sweep(boundary.id);
    assert.equal(stopped.changed, 1_000, 'the seam did not stop after exactly one chunk');
    assert.equal(await heldCount(deciding.db, boundary.id), 1_000);
    assert.equal(
      (await state(deciding.db, boundary.id)).pauseAppliedEpoch,
      0,
      'a stopped pass advanced the watermark',
    );
    const resumed = await new TaskListPauseProjectorService(
      deciding.db as unknown as PrismaService,
    ).sweep(boundary.id);
    assert.equal(resumed.changed, 2_000, 'the resumed pass did not finish the remaining rows');
    await converge(deciding.db, boundary.id, { rows: 3_000 });
    const boundaryBefore = await snapshot(deciding.db, boundary.id);
    const boundaryRerun = await new TaskListPauseProjectorService(
      deciding.db as unknown as PrismaService,
    ).sweep(boundary.id);
    const boundaryAfter = await snapshot(deciding.db, boundary.id);
    assert.equal(boundaryRerun.changed, 0);
    assert.equal(boundaryAfter.tuples, boundaryBefore.tuples);
    console.log('(B) boundary kill: 1,000 rows durable, 2,000 reclaimed, re-run changed 0 rows.');
  } finally {
    if (sweeper) await sweeper.reap().catch(() => undefined);
    if (barrier) await barrier.release().catch(() => undefined);
    if (recovering) await recovering.db.$disconnect().catch(() => undefined);
    await observer.end().catch(() => undefined);
    await deciding.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (C) The last decision wins, with sweeps racing each other and decisions landing mid-flight.
// ---------------------------------------------------------------------------------------------

test('(C) pause->resume->pause with two sweeps in flight settles on the last decision, and a same-value PATCH changes nothing', { skip, timeout: 180_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  // The projector is ENABLED here, unlike the cases that want the decision and the projection
  // separated on purpose. What this case is about is the design's own racing machinery — the kick
  // each PATCH fires, racing the sweeps below — and a disabled projector would leave the final
  // decision resting on a sweep this file happened to start, which is not what a reader would take
  // "settles on the last decision" to mean.
  const s = stack();
  try {
    const ids = await world(s.db, 'c');
    const list = await seedList(s.db, ids, 'c-races');
    await seedTasks(s.db, ids, list.id, 2_600);

    // Two projectors of their own, on top of the one the kicks use: the claim is that two replicas
    // sweeping one list is duplicated work and not corruption, and this is where that is worth
    // something — all three are walked over by decisions that land underneath them.
    const racerA = new TaskListPauseProjectorService(s.db as unknown as PrismaService, {
      chunkSize: 500,
    });
    const racerB = new TaskListPauseProjectorService(s.db as unknown as PrismaService, {
      chunkSize: 500,
    });

    await s.lists.update(ids.ownerId, list.id, { paused: true });
    assert.equal((await state(s.db, list.id)).pauseEpoch, 1);
    const firstPass = racerA.sweep(list.id);
    // The resume lands while that pass is between chunks, and the pause again before either sweep
    // can finish the pass it started: the state the design says must settle on the LAST decision.
    await waitUntil('the first rows to be held', async () => (await heldCount(s.db, list.id)) > 0, {
      timeoutMs: 30_000,
      pollMs: 5,
    });
    const racing = racerB.sweep(list.id);
    await s.lists.update(ids.ownerId, list.id, { paused: false });
    await s.lists.update(ids.ownerId, list.id, { paused: true });
    const finalDecision = await state(s.db, list.id);
    assert.equal(finalDecision.pauseEpoch, 3, 'the three decisions did not bump the epoch three times');
    assert.equal(finalDecision.paused, true);

    await Promise.all([firstPass, racing]);

    // SETTLED BY WHAT, MEASURED RATHER THAN ASSUMED. A decision that lands while a sweep is in
    // flight is picked up either by that sweep's next pass or by the next catch-up tick, and the
    // design quotes both ("sub-second when the kick fires, at most one tick when it does not").
    // Which of the two this interleaving needed is a fact about the implementation, so it is
    // observed and printed instead of asserted into existence.
    const byKick = await attempt(() => converged(s.db, list.id), 20_000);
    let byTick: number | null = null;
    if (byKick === null) {
      await s.projector.catchUp();
      byTick = await attempt(() => converged(s.db, list.id), 60_000);
      assert.ok(
        byTick !== null,
        'the list was still not converged one catch-up tick after the last decision, so the '
          + 'watermark did not name the work',
      );
    }
    const settled = await state(s.db, list.id);
    assert.equal(settled.pauseAppliedEpoch, 3, 'the watermark stopped at an older decision');
    assert.equal(await wrongRows(s.db, list.id), 0, 'a row is carrying an older decision');
    assert.equal(await heldCount(s.db, list.id), 2_600, 'not every row reached the last decision');

    // The mirror: the same interleaving ending on a RESUME, so the assertions above cannot pass by
    // the rows being held for an unrelated reason.
    await s.lists.update(ids.ownerId, list.id, { paused: false });
    if ((await attempt(() => converged(s.db, list.id), 20_000)) === null) {
      await s.projector.catchUp();
    }
    await converge(s.db, list.id, { rows: 0, timeoutMs: 60_000 });
    const resumed = await state(s.db, list.id);
    assert.equal(resumed.pauseEpoch, 4);
    assert.equal(resumed.pauseAppliedEpoch, 4);
    assert.equal(await wrongRows(s.db, list.id), 0);

    // A same-value PATCH, twice, against a settled list: no epoch, and not one row rewritten.
    const before = await snapshot(s.db, list.id);
    await s.lists.update(ids.ownerId, list.id, { paused: false });
    await s.lists.update(ids.ownerId, list.id, { paused: false, note: 'still running' });
    const after = await snapshot(s.db, list.id);
    assert.equal((await state(s.db, list.id)).pauseEpoch, 4, 'a same-value PATCH bumped the epoch');
    assert.equal(after.tuples, before.tuples, 'a same-value PATCH rewrote a task row');
    assert.equal(after.values, before.values);
    console.log(
      `(C) three decisions under three sweeps of one list: settled to epoch `
        + `${finalDecision.pauseEpoch} ${
          byKick === null
            ? `by ONE catch-up tick (${round(byTick!)}ms; the kick alone did not settle it in 20s)`
            : `by the kick alone (${round(byKick)}ms)`
        }; ${await wrongRows(s.db, list.id)} rows left on an older decision; resume to epoch `
        + `${resumed.pauseEpoch} then two same-value PATCHes: epoch still ${resumed.pauseEpoch}, `
        + '0 rows rewritten.',
    );
  } finally {
    await s.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (D) Fail-closed on delete: the 55,513-task release, and the window the split design opens.
// ---------------------------------------------------------------------------------------------

test('(D) deleting a paused list leaves nothing dispatchable, inside the projection window and outside it', { skip, timeout: 240_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = stack();
  let windowed: Stack | null = null;
  try {
    const ids = await world(s.db, 'd');
    const projectId = await project(s.db, ids, 'd');
    const watched = await seedList(s.db, ids, 'd-watched');
    await seedTasks(s.db, ids, watched.id, 300, { projectId });

    // (D.1) A pause that converged, and the sweep proving the fixture is dispatchable in principle:
    // the candidate tasks are held, the control list's are not, and the control list starts.
    const control = await seedList(s.db, ids, 'd-control');
    const controlTask = randomUUID();
    await s.db.task.create({
      data: {
        id: controlTask,
        ownerId: ids.ownerId,
        listId: control.id,
        projectId,
        assigneeId: ids.workspaceId,
        title: `d-control-${RUN}`,
        creatorType: 'USER',
        creatorId: ids.ownerId,
        provider: 'claude',
        completionCriterion: 'EVIDENCE_JUDGMENT',
        status: 'OPEN',
        autoRunWhenReady: true,
        dispatchHold: false,
      },
    });

    await s.lists.update(ids.ownerId, watched.id, { paused: true });
    await converge(s.db, watched.id, { rows: 300, timeoutMs: 120_000 });
    assert.equal(await wrongRows(s.db, watched.id), 0);

    await runCandidateSweeps(s.tasks);
    assert.equal(await offered(s.db, ids.ownerId, controlTask), 1, 'the control was not offered');
    assert.equal(
      await offeredFromList(s.db, ids.ownerId, watched.id),
      0,
      'a paused list was offered to the run door',
    );

    // (D.2) Delete it. This is the incident's other half: 112 paused lists deleted released 55,513
    // tasks that ran for a fortnight, because the veto was spelled as a join to a row that had just
    // been deleted and an unexpressible veto reads as permission.
    const watchedTaskIds = (
      await s.db.task.findMany({ where: { listId: watched.id }, select: { id: true } })
    ).map((task) => task.id);
    const beforeDelete = await snapshot(s.db, watched.id);
    await s.lists.remove(ids.ownerId, watched.id);
    const detached = await s.db.task.findMany({
      where: { id: { in: watchedTaskIds } },
      select: { listId: true, dispatchHold: true, autoRunWhenReady: true },
    });
    const stillHeld = detached.filter((task) => task.dispatchHold).length;
    const released = watchedTaskIds.length - stillHeld;
    const armed = detached.filter((task) => task.autoRunWhenReady).length;
    const withAList = detached.filter((task) => task.listId !== null).length;

    // MEASURED, AND THE ONE PLACE THE BRIEF AND THE CODE DISAGREE — stated rather than dropped.
    // The brief for this replay says "assert its tasks stay held (dispatch_hold still true)". They
    // do not: `TaskListsService.remove` RELEASES the hold and DISARMS the task (`autoRunWhenReady:
    // false`) in the same write, which is its documented, pre-existing behaviour and explicitly out
    // of scope for this change ("do not fix: list deletion"). Asserting `dispatch_hold = true`
    // would be asserting something the implementation never claimed. What makes the 55,513-task
    // release unreproducible is the DISARM plus the veto being read off the task row, and both are
    // asserted below; the released/held split is recorded as a number, and pinned so that a change
    // to delete semantics cannot pass unnoticed.
    console.log(
      `(D) delete of a paused 300-task list: ${released} holds released, ${stillHeld} still held, `
        + `${armed} tasks left armed for auto-run, ${withAList} left attached to a list.`,
    );
    assert.equal(detached.length, 300, 'the delete detached a different number of tasks');
    assert.equal(withAList, 0, 'a task survived the delete still pointing at a deleted list');
    assert.equal(armed, 0, 'a task of the deleted list is still armed for automatic dispatch');
    assert.equal(released, 300, 'the delete did not release the holds it documents releasing');
    assert.equal(stillHeld, 0);

    // The release must not be reproducible: the same sweep that offered the control must still
    // offer none of these, and none of them may start.
    await runCandidateSweeps(s.tasks);
    const offeredAfterDelete = await offeredForTasks(s.db, ids.ownerId, watchedTaskIds);
    const sessionsAfterDelete = await s.db.session.count({
      where: { ownerId: ids.ownerId, taskId: { in: watchedTaskIds } },
    });
    assert.equal(
      offeredAfterDelete,
      0,
      'a released task of the deleted list was offered to the run door',
    );
    assert.equal(
      sessionsAfterDelete,
      0,
      'a task of the deleted list started a run — the 55,513-task release, reproduced',
    );

    // (D.3) The window: a list deleted while its pause is DECIDED and NOT YET PROJECTED. This is
    // the state the split design creates and the old one did not have, and it is where a fail-open
    // would live if the disarm were keyed off the projection rather than off the delete.
    const w = stack({ enabled: false });
    windowed = w;
    const inWindow = await seedList(w.db, ids, 'd-window');
    await seedTasks(w.db, ids, inWindow.id, 50, { projectId });
    await w.lists.update(ids.ownerId, inWindow.id, { paused: true });
    const windowState = await state(s.db, inWindow.id);
    assert.equal(windowState.pauseAppliedEpoch, 0, 'the window closed itself');
    assert.equal(await heldCount(s.db, inWindow.id), 0, 'the window projected without a projector');
    const windowTaskIds = (
      await w.db.task.findMany({ where: { listId: inWindow.id }, select: { id: true } })
    ).map((task) => task.id);
    await w.lists.remove(ids.ownerId, inWindow.id);
    const windowTasks = await w.db.task.findMany({
      where: { id: { in: windowTaskIds } },
      select: { autoRunWhenReady: true, dispatchHold: true },
    });
    assert.equal(
      windowTasks.filter((task) => task.autoRunWhenReady || task.dispatchHold).length,
      0,
      'a task deleted inside the projection window was left dispatchable',
    );
    await runCandidateSweeps(s.tasks);
    assert.equal(await offeredForTasks(s.db, ids.ownerId, windowTaskIds), 0);
    console.log(
      `(D) windowed delete: ${windowTasks.length} tasks detached before the projection reached `
        + 'them; 0 armed, 0 held, 0 offered.',
    );
  } finally {
    if (windowed) await windowed.db.$disconnect().catch(() => undefined);
    await s.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (E) Negative controls: the spec can fail.
// ---------------------------------------------------------------------------------------------

test('(E) negative controls: a switched-off projector leaves the rows unconverged, and an unguarded rewrite moves the idempotence digest', { skip, timeout: 180_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const off = stack({ enabled: false });
  let on: Stack | null = null;
  try {
    const ids = await world(off.db, 'e');
    const list = await seedList(off.db, ids, 'e-off');
    await seedTasks(off.db, ids, list.id, 400);

    // (E.1) The projector is off. The decision is durable, the tasks are not converged, and the
    // catch-up scan — which runs whether or not sweeps do, so the lag can be reported — converges
    // nothing. This is what makes (A)-(D) measurements of the projector rather than of the fixture.
    await off.lists.update(ids.ownerId, list.id, { paused: true });
    const tick = await off.projector.catchUp();
    assert.equal(await heldCount(off.db, list.id), 0, 'something projected with the projector off');
    assert.equal((await state(off.db, list.id)).pauseAppliedEpoch, 0);
    assert.ok(tick.lagging >= 1, 'the catch-up did not even report the list it could not converge');

    // ...and the decision is not silent about it. A projector that is off, wedged or crash-looping
    // is exactly the state the warning exists for, so the detector has to run while the sweeps do
    // not — the reason it sits outside the enable check — and it has to say which list and how far
    // behind. This is the project's own acceptance criterion, checked by somebody other than the
    // implementation's author.
    const warnings: string[] = [];
    const originalWarn = Logger.prototype.warn;
    Logger.prototype.warn = function (line: unknown) {
      warnings.push(String(line));
    } as never;
    try {
      const t0 = new Date();
      await off.projector.catchUp(t0);
      assert.deepEqual(
        warnings.filter((line) => line.includes(list.id)),
        [],
        'a list was warned about before the lag bound had elapsed',
      );
      await off.projector.catchUp(new Date(t0.getTime() + PAUSE_PROJECTION_LAG_WARN_MS + 1_000));
      const about = warnings.filter((line) => line.includes(list.id));
      assert.equal(about.length, 1, 'a projector down past the lag bound reported nothing');
      assert.match(about[0], /pause_epoch=1/);
      assert.match(about[0], /pause_applied_epoch=0/);
    } finally {
      Logger.prototype.warn = originalWarn;
    }
    console.log('(E) control: projector disabled -> 0 of 400 rows converged, watermark 0, '
      + `catch-up reports ${tick.lagging} list(s) behind and warns once past the lag bound.`);

    // (E.2) And then the projector is on. The same call converges the same list, so (E.1) is about
    // the projector and not about a list that could never be converged.
    const enabled = stack();
    on = enabled;
    await enabled.projector.sweep(list.id);
    await converge(enabled.db, list.id, { rows: 400 });
    assert.equal(await wrongRows(enabled.db, list.id), 0);

    // (E.3) The idempotence device itself. The sweep's guard is `dispatch_hold <> target`; a chunk
    // written WITHOUT it — the same rows, the same values, a fresh `updated_at` — must move the
    // digest the idempotence assertions read. If this stays put, those assertions are reading a
    // digest that cannot detect the very failure they exist to catch.
    const small = await seedList(off.db, ids, 'e-guard');
    await seedTasks(off.db, ids, small.id, 200);
    await off.lists.update(ids.ownerId, small.id, { paused: true });
    const guardProjector = new TaskListPauseProjectorService(
      off.db as unknown as PrismaService,
    );
    await guardProjector.sweep(small.id);
    await converge(off.db, small.id, { rows: 200 });
    const guarded = await snapshot(off.db, small.id);
    const guardless = await guardProjector.sweep(small.id);
    assert.equal(guardless.changed, 0, 'the guarded sweep rewrote rows it had already applied');
    const afterGuarded = await snapshot(off.db, small.id);
    assert.equal(afterGuarded.tuples, guarded.tuples, 'the guarded sweep moved a tuple');

    await off.db.$executeRawUnsafe(
      `UPDATE "task" SET "dispatch_hold" = true, "updated_at" = now() WHERE "list_id" = $1::uuid`,
      small.id,
    );
    const afterUnguarded = await snapshot(off.db, small.id);
    assert.notEqual(
      afterUnguarded.tuples,
      guarded.tuples,
      'an unguarded rewrite of the same rows left the digest unchanged, so the idempotence '
        + 'assertions in this file could not have failed',
    );
    console.log('(E) control: guard disabled -> the whole-list xmin digest moves; with the guard, '
      + 'a re-run changes 0 rows and 0 tuples.');
  } finally {
    if (on) await on.db.$disconnect().catch(() => undefined);
    await off.db.$disconnect();
  }
});
