import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConflictException } from '@nestjs/common';
import { CreatorType, PrismaClient, RunnerStatus, TaskStatus } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import { AutoRetryService } from './auto-retry.service';
import { SessionsService } from './sessions.service';
import { turnStateOfWord } from './session-turn-state';
import { sessionWord } from '../test-support/session-word';

/**
 * ONE LIVE RUN PER TASK, RELEASE B: the rehearsal before 1444 drops 0130's index, and the drop itself.
 *
 * docs/session-three-state-plan.md §7 step 4.5; migration 1444's header says why each piece is there.
 *
 * The database: this branch's migrations by the real `prisma migrate deploy` (run-pg-spec.sh and the CI matrix
 * migrate the template so), put back to production's state at deploy 2 (a7f28ff0ac: 1426 applied, 1444 not, both
 * claim indexes, 0130's built first), then populated with a SYNTHETIC set of more than 2,000 sessions: released runs
 * of every terminal status, tasks whose run is held (each held status), and failure releases that can be revived.
 *
 *   (1) with both indexes: the four dispatch paths, each through the real services and raced from two stacks of
 *       them (two replicas): the auto-run sweep (TasksService.reconcileReadyTasks), manual start
 *       (TasksService.execute), resume (SessionsService.resume) and the auto-retry revive (AutoRetryService.sweep).
 *       Every statement any of them sends is watched at the pg driver: zero 42P10, and after each path zero tasks
 *       with more than one session whose finished_at is null
 *   (2) 1444 by the real `prisma migrate deploy`, first interrupted as production would interrupt it (a lock_timeout
 *       behind a transaction that holds `session`): the INVALID index left, P3009, `migrate resolve --rolled-back`,
 *       the deploy after it drops the index. Then the index list of `session`, and a second run of 1444 (IF EXISTS)
 *   (3) with the new index alone: the four paths again, the same counts. Release A's code is what runs here, so this
 *       is also what a deploy-2 server does against the database during deploy 3's hand-over
 *   (4) scripts/session-claim-index-drop-precheck.sql, before and after the drop, and its pg_stat_statements
 *       fingerprint of deploy 1's carrier against every statement the paths sent
 *   (5) how Prisma sends the file: the same drop with a SET before it is sent whole, as one transaction, and refused
 *       with 25001; the file as it is applies
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-claim-index-release-b.pg.spec.ts
 *
 * Not destructive beyond its own database: run-pg-spec.sh gives the spec a clone. It leaves that database migrated to
 * the head: the new index alone, 1444 recorded applied.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const NEW_INDEX = 'session_task_execution_claim_idx_finished_at';
const OLD_INDEX = 'session_task_execution_claim_idx';
const RELEASE_A = '1426_session_task_execution_claim_finished_at_idx';
const RELEASE_B = '1444_drop_session_task_execution_claim_idx';
const OLD_DEF = `CREATE UNIQUE INDEX ${OLD_INDEX} ON public.session USING btree (task_id) `
  + "WHERE ((task_id IS NOT NULL) AND (deleted_at IS NULL) AND (status = ANY (ARRAY['PENDING'::run_status, "
  + "'RUNNING'::run_status, 'AWAITING_INPUT'::run_status, 'INTERRUPTED'::run_status])))";
const NEW_DEF = `CREATE UNIQUE INDEX ${NEW_INDEX} ON public.session USING btree (task_id) `
  + 'WHERE ((task_id IS NOT NULL) AND (deleted_at IS NULL) AND (finished_at IS NULL))';
const API = join(__dirname, '..', '..');
const REPO = join(API, '..', '..');
const RUN = randomUUID().slice(0, 8);
const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];
const HELD: RunStatus[] = [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];

// ── Every statement the services send, and every error PostgreSQL answers, at the pg driver: the adapter Prisma
// runs on sends through pg's Client, so an error a service catches and swallows is counted here all the same.
interface Watch { statements: string[]; errors: Array<{ code: string; constraint?: string; message: string }> }
const watch: Watch = { statements: [], errors: [] };
let ownClient: Client | null = null;
const pgQuery = Client.prototype.query;
(Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function watched(
  this: Client, ...args: unknown[]
): unknown {
  const mine = this === ownClient;
  const first = args[0] as string | { text?: string } | undefined;
  const text = typeof first === 'string' ? first : first?.text;
  if (!mine && typeof text === 'string') watch.statements.push(text);
  const result = (pgQuery as unknown as (...a: unknown[]) => unknown).apply(this, args);
  if (!mine && result && typeof (result as Promise<unknown>).then === 'function') {
    return (result as Promise<unknown>).catch((error: unknown) => {
      const e = error as { code?: string; constraint?: string; message?: string };
      watch.errors.push({ code: String(e.code ?? ''), constraint: e.constraint, message: String(e.message ?? '') });
      throw error;
    });
  }
  return result;
};

// ── Prisma, as migrate deploy is run on an installation.
interface Run { code: number; out: string }
function prisma(url: string, args: string[], cwd = API): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
      cwd, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

interface SessionIndex { name: string; valid: boolean; ready: boolean; unique: boolean; def: string }
async function sessionIndexes(sql: Client): Promise<SessionIndex[]> {
  return (await sql.query(
    `SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique,
            pg_get_indexdef(c.oid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'public.session'::regclass
      ORDER BY c.relname`,
  )).rows as SessionIndex[];
}
const claimIndexes = async (sql: Client) => (await sessionIndexes(sql))
  .filter((i) => i.name.startsWith(OLD_INDEX)).map((i) => [i.name, i.valid, i.ready] as const);

async function recorded(sql: Client, migration: string): Promise<string> {
  const rows = (await sql.query(
    `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at`, [migration],
  )).rows as Array<{ finished: boolean; rolled_back: boolean }>;
  return rows.map((r) => (r.rolled_back ? 'rolled back' : r.finished ? 'applied' : 'failed')).join(', ') || 'absent';
}

/** Tasks with more than one session whose finished_at is null: in the Trash or not, and live ones only. */
async function doubled(sql: Client): Promise<{ any: number; live: number }> {
  return (await sql.query(
    `SELECT (SELECT count(*) FROM (SELECT task_id FROM session WHERE task_id IS NOT NULL AND finished_at IS NULL
                                    GROUP BY task_id HAVING count(*) > 1) d)::int AS any,
            (SELECT count(*) FROM (SELECT task_id FROM session WHERE task_id IS NOT NULL AND finished_at IS NULL
                                      AND deleted_at IS NULL GROUP BY task_id HAVING count(*) > 1) d)::int AS live`,
  )).rows[0] as { any: number; live: number };
}

async function liveRuns(sql: Client, taskIds: string[]): Promise<Map<string, number>> {
  const rows = (await sql.query(
    `SELECT t::text AS task, (SELECT count(*) FROM session s
                               WHERE s.task_id = t AND s.finished_at IS NULL AND s.deleted_at IS NULL)::int AS n
       FROM unnest($1::uuid[]) t`, [taskIds],
  )).rows as Array<{ task: string; n: number }>;
  return new Map(rows.map((r) => [r.task, r.n]));
}

// ── Two stacks of the real services over their own pools: two replicas.
interface Stack { db: PrismaClient; sessions: SessionsService; tasks: TasksService; autoRetry: AutoRetryService }
function stack(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const quiet = () => undefined;
  for (const service of [tasks, sessions] as unknown as Array<{ logger: unknown }>) {
    service.logger = { log: quiet, warn: quiet, error: quiet, debug: quiet, verbose: quiet, fatal: quiet };
  }
  // AutoRetryService keeps its log: each refusal it prints names the run holding the claim.
  const autoRetry = new AutoRetryService(prisma, sessions, realtime);
  return { db, sessions, tasks, autoRetry };
}

// ── Rows.
interface World { ownerId: string; runnerId: string; agentId: string; projectId: string }
/** An owner, an online runner with room, its workspace, a project. `started` makes the project move (the sweep). */
async function world(db: PrismaClient, label: string, started: boolean): Promise<World> {
  const w = { ownerId: randomUUID(), runnerId: randomUUID(), agentId: randomUUID(), projectId: randomUUID() };
  await db.user.create({ data: { id: w.ownerId, email: `${label}-${RUN}-${w.ownerId}@release-b.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: w.runnerId, ownerId: w.ownerId, name: `${label}-runner`, tokenHash: `hash-${w.runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      maxConcurrent: 500,
    },
  });
  await db.workspace.create({ data: { id: w.agentId, ownerId: w.ownerId, runnerId: w.runnerId, name: `${label}-agent`, enabled: true } });
  await db.project.create({
    data: {
      id: w.projectId, ownerId: w.ownerId, title: label, coordinatorEnabled: false, maxConcurrentTasks: 500,
      ...(started ? { startedAt: new Date() } : {}),
    },
  });
  await establishProjectContractForPgTest(db, w.ownerId, w.projectId, label);
  return w;
}

async function tasks(db: PrismaClient, w: World, n: number, title: string, autoRunWhenReady = false): Promise<string[]> {
  const ids = Array.from({ length: n }, () => randomUUID());
  await db.task.createMany({
    data: ids.map((id, i) => ({
      id, ownerId: w.ownerId, projectId: w.projectId, assigneeId: w.agentId, title: `${title} ${i}`,
      creatorType: CreatorType.USER, creatorId: w.ownerId, provider: 'claude', completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.OPEN, autoRunWhenReady, dispatchHold: false,
    })),
  });
  return ids;
}

/** A session that ran: resume refuses one that never started, or has turns and no engine session. */
function ran(w: World, taskId: string, status: RunStatus, extra: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.agentId,
    assignedRunnerId: w.runnerId, title: `rehearsal ${status}`, prompt: 'rehearsal', provider: 'claude',
    providerBuiltin: true, startsTaskWork: true, numTurns: 1, engineTurnActive: false,
    runtimeSessionId: randomUUID(), startedAt: new Date(), status,
    finishedAt: TERMINAL.includes(status) ? new Date() : null,
    // A failure is the turn's outcome copied to the session (design §12): deploy 3 no longer reads status FAILED alone.
    ...(status === RunStatus.FAILED ? { lastTurnOutcome: 'FAILED' } : {}), ...extra,
  };
}

async function moveTo(db: PrismaClient, sessionId: string, status: RunStatus): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.session.update({
      where: { id: sessionId },
      data: {
        turnState: turnStateOfWord(status), finishedAt: TERMINAL.includes(status) ? new Date() : null,
        ...(status === RunStatus.FAILED ? { lastTurnOutcome: 'FAILED' } : {}),
      },
    });
  });
}

function outcome(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return 'ok';
  const error = result.reason as unknown;
  if (error instanceof ConflictException) {
    const body = error.getResponse() as { code?: string };
    return `409 ${body.code ?? ''}`.trim();
  }
  const e = error as { name?: string; code?: string; message?: string };
  return `${e.name ?? 'Error'} ${e.code ?? ''} ${String(e.message ?? '').split('\n')[0].slice(0, 120)}`.trim();
}
function tally(outcomes: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of outcomes) counts[o] = (counts[o] ?? 0) + 1;
  return counts;
}

/** The population, synthetic: this many tasks, each with four released runs, some held, some failure releases. */
interface Population { w: World; free: string[]; held: string[]; heldRuns: Map<string, string>; failed: Map<string, string[]> }
async function populate(db: PrismaClient, tasksN: number): Promise<Population> {
  const w = await world(db, 'population', false);
  const ids = await tasks(db, w, tasksN, 'synthetic');
  const rows: Array<ReturnType<typeof ran>> = [];
  const failed = new Map<string, string[]>();
  const heldRuns = new Map<string, string>();
  const held: string[] = [];
  const free: string[] = [];
  ids.forEach((taskId, i) => {
    const mine: string[] = [];
    for (let r = 0; r < 4; r += 1) {
      const row = ran(w, taskId, TERMINAL[(i + r) % 3]);
      rows.push(row);
      if (row.status === RunStatus.FAILED) mine.push(row.id);
    }
    // A failure release, revivable by resume or by an armed retry, on every task.
    const failure = ran(w, taskId, RunStatus.FAILED, { error: 'engine crashed' });
    rows.push(failure);
    failed.set(taskId, [failure.id, ...mine]);
    if (i % 3 === 0) {
      const holder = ran(w, taskId, HELD[(i / 3) % 4]);
      rows.push(holder);
      heldRuns.set(taskId, holder.id);
      held.push(taskId);
    } else {
      free.push(taskId);
    }
  });
  for (let at = 0; at < rows.length; at += 500) await db.session.createMany({ data: rows.slice(at, at + 500) as never });
  return { w, free, held, heldRuns, failed };
}

interface PathReport { path: string; outcomes: Record<string, number>; doubled: { any: number; live: number } }

/**
 * The four dispatch paths, each raced from two stacks, each followed by the count of doubled tasks. `take` hands each
 * path its own slice of the population, so the two rounds (before and after the drop) never reuse a row.
 */
async function rehearse(
  sql: Client, a: Stack, b: Stack, population: Population, take: <T>(list: T[], n: number) => T[], label: string,
): Promise<PathReport[]> {
  const reports: PathReport[] = [];
  const close = async (path: string, outcomes: string[]) => {
    const d = await doubled(sql);
    reports.push({ path, outcomes: tally(outcomes), doubled: d });
    console.log(`# ${label} | ${path} | ${JSON.stringify(tally(outcomes))} | tasks with >1 session finished_at NULL: ${d.any} (not in the Trash: ${d.live})`);
    assert.deepEqual(d, { any: 0, live: 0 }, `${label}, ${path}: no task has two unreleased sessions`);
  };

  // (a) The auto-run sweep: OPEN auto-run tasks whose prerequisite is DONE, swept by both replicas at once, twice.
  {
    const w = await world(a.db, `${label}-sweep`, true);
    const prerequisite = randomUUID();
    await a.db.task.create({
      data: {
        id: prerequisite, ownerId: w.ownerId, projectId: w.projectId, assigneeId: w.agentId, title: 'prerequisite',
        creatorType: CreatorType.USER, creatorId: w.ownerId, provider: 'claude', completionCriterion: 'EVIDENCE_JUDGMENT',
        status: TaskStatus.DONE, autoRunWhenReady: false,
      },
    });
    const ready = await tasks(a.db, w, 30, 'ready', true);
    await a.db.taskDependency.createMany({ data: ready.map((taskId) => ({ taskId, dependsOnTaskId: prerequisite })) });
    const sweep = (s: Stack) => (s.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();
    const outcomes: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      outcomes.push(...(await Promise.allSettled([sweep(a), sweep(b)])).map((r) => `sweep ${outcome(r)}`));
    }
    const live = await liveRuns(sql, ready);
    outcomes.push(...ready.map((t) => `task with ${live.get(t)} live run(s)`));
    assert.ok(ready.every((t) => live.get(t) === 1), `${label}, sweep: every ready task was started once`);
    await close('auto-run sweep', outcomes);
  }

  // (b) Manual start: two presses at once (two tokens, two replicas) on a free task, and one on a task already held.
  {
    const w = await world(a.db, `${label}-start`, false);
    const fresh = await tasks(a.db, w, 30, 'manual');
    const outcomes: string[] = [];
    for (const taskId of fresh) {
      const pair = await Promise.allSettled([
        a.tasks.execute(w.ownerId, taskId, undefined, randomUUID()),
        b.tasks.execute(w.ownerId, taskId, undefined, randomUUID()),
      ]);
      outcomes.push(`free task: ${pair.map(outcome).sort().join(' + ')}`);
      assert.ok(pair.some((r) => r.status === 'fulfilled'), `${label}, manual start: one press of the two runs the task`);
    }
    // A second press after the run ended: the next run of the task.
    for (const taskId of take(fresh, 10)) {
      const run = await a.db.session.findFirstOrThrow({ where: { taskId, finishedAt: null }, select: { id: true } });
      await moveTo(a.db, run.id, RunStatus.FAILED);
      const next = await Promise.allSettled([
        a.tasks.execute(w.ownerId, taskId, undefined, randomUUID()),
        b.tasks.execute(w.ownerId, taskId, undefined, randomUUID()),
      ]);
      outcomes.push(`after its run ended: ${next.map(outcome).sort().join(' + ')}`);
    }
    // A press on a task whose run is held: refused while that run is live; on an idle parked run (AWAITING_INPUT,
    // INTERRUPTED) the press is a turn on that run, which is its plan RESUME, and no second run.
    for (const taskId of take(population.held, 20)) {
      const status = await sessionWord(a.db, population.heldRuns.get(taskId)!);
      const press = await Promise.allSettled([a.tasks.execute(population.w.ownerId, taskId, undefined, randomUUID())]);
      const run = press[0].status === 'fulfilled' ? (press[0].value as { sessionId?: string }).sessionId : undefined;
      const onto = run === undefined ? '' : run === population.heldRuns.get(taskId) ? ' (onto the held run)' : ' (a new run)';
      outcomes.push(`task held by a ${status} run: ${outcome(press[0])}${onto}`);
    }
    const live = await liveRuns(sql, fresh);
    assert.ok(fresh.every((t) => live.get(t) === 1), `${label}, manual start: every pressed task has one live run`);
    await close('manual start', outcomes);
  }

  // (c) Resume: two released runs of one free task resumed at once (two replicas); a released run of a held task.
  {
    const outcomes: string[] = [];
    const free = take(population.free, 30);
    for (const taskId of free) {
      const [first, second] = population.failed.get(taskId)!;
      const pair = await Promise.allSettled([
        a.sessions.resume(population.w.ownerId, first, { clientTurnId: randomUUID(), content: 'go on' } as never),
        b.sessions.resume(population.w.ownerId, second, { clientTurnId: randomUUID(), content: 'go on' } as never),
      ]);
      outcomes.push(`two released runs of a free task: ${pair.map(outcome).sort().join(' + ')}`);
      assert.equal(pair.filter((r) => r.status === 'fulfilled').length, 1, `${label}, resume: exactly one of the two revives`);
    }
    for (const taskId of take(population.held, 20)) {
      const [released] = population.failed.get(taskId)!;
      const press = await Promise.allSettled([
        a.sessions.resume(population.w.ownerId, released, { clientTurnId: randomUUID(), content: 'go on' } as never),
      ]);
      outcomes.push(`released run of a held task: ${outcome(press[0])}`);
    }
    const live = await liveRuns(sql, free);
    assert.ok(free.every((t) => live.get(t) === 1), `${label}, resume: every resumed task has one live run`);
    await close('resume', outcomes);
  }

  // (d) The auto-retry revive: armed failure releases, swept by both replicas at once. On free tasks (two armed runs
  // of one task, both due), and on tasks whose run is held. One release per runner and provider a sweep, so a sweep
  // per instant, in the past (only these rows are due then).
  {
    const outcomes: string[] = [];
    const free = take(population.free, 12);
    const held = take(population.held, 8);
    const base = Date.UTC(1999, 0, 1) + (label.length * 86_400_000);
    const armed: Array<{ id: string; taskId: string; at: Date; contended: boolean }> = [];
    let i = 0;
    for (const taskId of free) {
      for (const id of population.failed.get(taskId)!.slice(0, 2)) {
        armed.push({ id, taskId, at: new Date(base + i * 60_000), contended: false });
      }
      i += 1;
    }
    for (const taskId of held) {
      armed.push({ id: population.failed.get(taskId)![0], taskId, at: new Date(base + i * 60_000), contended: true });
      i += 1;
    }
    // One instant at a time: arm its rows, sweep, read them, disarm what is still armed, so a row re-armed after a
    // refusal never takes the next instant's slot (one release per runner and provider a sweep).
    const byId = new Map<string, { status: RunStatus; finishedAt: Date | null }>();
    const instants = [...new Set(armed.map((r) => r.at.getTime()))].sort((x, y) => x - y);
    for (const at of instants) {
      const rows = armed.filter((r) => r.at.getTime() === at);
      for (const row of rows) {
        await a.db.session.update({ where: { id: row.id }, data: { retryAt: row.at, retryAttempts: 0 } });
      }
      await a.db.runner.update({ where: { id: population.w.runnerId }, data: { lastHeartbeatAt: new Date() } });
      const now = new Date(at + 1_000);
      // Two due on one runner and provider: a sweep releases one, so each replica sweeps twice, both at once.
      for (let round = 0; round < 2; round += 1) {
        outcomes.push(...(await Promise.allSettled([a.autoRetry.sweep(now), b.autoRetry.sweep(now)])).map((r) => `sweep ${outcome(r)}`));
      }
      for (const row of await a.db.session.findMany({
        where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, status: true, finishedAt: true },
      })) byId.set(row.id, row);
      await a.db.session.updateMany({ where: { id: { in: rows.map((r) => r.id) }, retryAt: { not: null } }, data: { retryAt: null } });
    }
    for (const row of armed) {
      const now = byId.get(row.id)!;
      outcomes.push(`${row.contended ? 'armed on a held task' : 'armed on a free task'}: ${now.finishedAt ? 'still released' : `revived (${now.status})`}`);
    }
    const live = await liveRuns(sql, free);
    assert.ok(free.every((t) => live.get(t) === 1), `${label}, auto-retry: each free task was revived once, by one of its two armed runs`);
    assert.ok(armed.filter((r) => r.contended).every((r) => byId.get(r.id)!.finishedAt !== null),
      `${label}, auto-retry: no armed run of a held task was revived beside its holder`);
    await close('auto-retry revive', outcomes);
  }
  return reports;
}

function sqlOf(path: string): string {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '\\gx').join('\n');
}

test('one live run per task, release B (migration 1444): rehearsal before and after the drop', {
  skip, concurrency: 1, timeout: 1_800_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  ownClient = sql;
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const database = ((await sql.query('SELECT current_database() AS d')).rows[0] as { d: string }).d;
  const a = stack(url);
  const b = stack(url);
  t.after(async () => {
    await sql.query(`ALTER DATABASE "${database}" RESET lock_timeout`).catch(() => undefined);
    await a.db.$disconnect().catch(() => undefined);
    await b.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    (Client.prototype as unknown as { query: unknown }).query = pgQuery;
  });

  // ── Production's state at deploy 2: every migration of a7f28ff0ac applied, 1444 not; 0130's index, then 1426's.
  const migrations = (await sql.query(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1`,
  )).rows.map((r: { migration_name: string }) => r.migration_name);
  // Not "last": main's later migrations (1447, 1462, ...) number above 1444, and the rehearsal only needs 1444 applied.
  assert.ok(migrations.includes(RELEASE_B), 'the template was migrated to this branch\'s head, 1444 among it');
  if ((await claimIndexes(sql)).some(([name]) => name === OLD_INDEX) === false) {
    await sql.query(`DROP INDEX "${NEW_INDEX}"`);
    await sql.query(OLD_DEF);
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [RELEASE_A]);
    const rebuilt = await prisma(url, ['migrate', 'deploy']);
    assert.equal(rebuilt.code, 0, `1426 by migrate deploy:\n${rebuilt.out}`);
  }
  await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [RELEASE_B]);
  const status = await prisma(url, ['migrate', 'status']);
  console.log(`# migrate status at production's state:\n${status.out.split('\n').map((l) => `#   ${l}`).join('\n')}`);
  assert.match(status.out, new RegExp(RELEASE_B), 'migrate status names 1444 as not yet applied');
  assert.equal(await recorded(sql, RELEASE_A), 'applied');
  assert.equal(await recorded(sql, RELEASE_B), 'absent');
  assert.deepEqual(await claimIndexes(sql), [[OLD_INDEX, true, true], [NEW_INDEX, true, true]]);
  const order = (await sql.query(
    `SELECT relname FROM pg_class WHERE relname IN ($1, $2) ORDER BY oid`, [OLD_INDEX, NEW_INDEX],
  )).rows.map((r: { relname: string }) => r.relname);
  assert.deepEqual(order, [OLD_INDEX, NEW_INDEX], '0130\'s index built first, as in production');

  // ── The population, synthetic.
  const population = await populate(a.db, 480);
  await sql.query('ANALYZE session');
  const size = (await sql.query(
    `SELECT count(*)::int AS sessions, count(*) FILTER (WHERE finished_at IS NULL)::int AS held,
            count(*) FILTER (WHERE status = 'FAILED')::int AS failure_releases,
            count(DISTINCT task_id)::int AS tasks
       FROM session WHERE owner_id = $1::uuid`, [population.w.ownerId],
  )).rows[0] as { sessions: number; held: number; failure_releases: number; tasks: number };
  console.log(`# synthetic population before the rehearsal: ${JSON.stringify(size)}; whole table: ${((await sql.query('SELECT count(*)::int AS n FROM session')).rows[0] as { n: number }).n} sessions`);
  assert.ok(size.sessions >= 2000, 'at least 2,000 sessions before the rehearsal');
  assert.deepEqual(await doubled(sql), { any: 0, live: 0 });

  const used = new Set<unknown>();
  const take = <T>(list: T[], n: number): T[] => {
    const picked = list.filter((x) => !used.has(x)).slice(0, n);
    for (const x of picked) used.add(x);
    assert.equal(picked.length, n, 'the population is large enough for both rounds');
    return picked;
  };
  const precheck = join(REPO, 'scripts', 'session-claim-index-drop-precheck.sql');

  await t.test('(1) both indexes: the four dispatch paths, zero 42P10, zero doubled tasks', async () => {
    const from = watch.errors.length;
    const fromStatements = watch.statements.length;
    await rehearse(sql, a, b, population, take, 'both indexes');
    const errors = watch.errors.slice(from);
    console.log(`# both indexes: ${watch.statements.length - fromStatements} statements, errors by SQLSTATE `
      + `${JSON.stringify(tally(errors.map((e) => `${e.code}${e.constraint ? ` ${e.constraint}` : ''}`)))}`);
    assert.ok(watch.statements.length - fromStatements > 1000, 'the driver watch saw the services\' statements');
    assert.equal(errors.filter((e) => e.code === '42P10').length, 0, 'zero 42P10');

    const before = (await sql.query(sqlOf(precheck))).rows[0] as Record<string, unknown>;
    console.log(`# precheck before the drop: ${JSON.stringify(before)}`);
    assert.equal(before.release_a_applied, true);
    assert.equal(before.new_index_valid, true);
    assert.equal(before.old_index_valid, true);
    assert.equal(before.invalid_session_indexes, '');
    assert.equal(before.tasks_doubled, '0');
  });

  await t.test('(2) 1444 by prisma migrate deploy: interrupted behind a transaction, resolved, applied', async () => {
    // Production's lock_timeout is 30 s (docker-compose.yml); 2 s here, for the same failure sooner.
    await sql.query(`ALTER DATABASE "${database}" SET lock_timeout = '2s'`);
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM session LIMIT 1');
      const interrupted = await prisma(url, ['migrate', 'deploy']);
      console.log(`# 1444 behind an open transaction: exit ${interrupted.code}\n${interrupted.out.split('\n').map((l) => `#   ${l}`).join('\n')}`);
      assert.notEqual(interrupted.code, 0, 'the deploy fails');
      assert.match(interrupted.out, /lock timeout/);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
    await sql.query(`ALTER DATABASE "${database}" RESET lock_timeout`);
    const left = await claimIndexes(sql);
    console.log(`# left behind: ${JSON.stringify(left)}`);
    assert.deepEqual(left, [[OLD_INDEX, false, true], [NEW_INDEX, true, true]],
      '0130\'s index is left INVALID, and 1426\'s is untouched');
    assert.equal(await recorded(sql, RELEASE_B), 'failed');

    // While it is so: a second live run is still refused, by the index that enforces the claim.
    const w = await world(a.db, 'between', false);
    const [taskId] = await tasks(a.db, w, 1, 'between');
    await a.db.session.create({ data: ran(w, taskId, RunStatus.RUNNING) as never });
    const second = await a.db.session.create({ data: ran(w, taskId, RunStatus.PENDING) as never }).then(() => null, (e: unknown) => e);
    assert.equal((second as { code?: string })?.code, 'P2002', 'a second live run is refused while the old index is INVALID');

    const stopped = await prisma(url, ['migrate', 'deploy']);
    console.log(`# next deploy: exit ${stopped.code}: ${stopped.out.match(/P3009[^\n]*/)?.[0] ?? stopped.out}`);
    assert.notEqual(stopped.code, 0);
    assert.match(stopped.out, /P3009/);
    assert.match(stopped.out, new RegExp(RELEASE_B));
    const resolved = await prisma(url, ['migrate', 'resolve', '--rolled-back', RELEASE_B]);
    assert.equal(resolved.code, 0, resolved.out);

    const applied = await prisma(url, ['migrate', 'deploy']);
    console.log(`# after resolve, migrate deploy: exit ${applied.code}\n${applied.out.split('\n').map((l) => `#   ${l}`).join('\n')}`);
    assert.equal(applied.code, 0, applied.out);
    assert.match(applied.out, new RegExp(`Applying migration \`${RELEASE_B}\``));
    assert.equal(await recorded(sql, RELEASE_B), 'rolled back, applied');

    const indexes = await sessionIndexes(sql);
    console.log(`# indexes of session after 1444 (${indexes.length}):\n${indexes.map((i) => `#   ${i.name} valid=${i.valid} ready=${i.ready} unique=${i.unique} | ${i.def}`).join('\n')}`);
    assert.equal(indexes.some((i) => i.name === OLD_INDEX), false, 'the old index is gone');
    const claim = indexes.find((i) => i.name === NEW_INDEX);
    assert.deepEqual(claim && [claim.valid, claim.ready, claim.unique, claim.def], [true, true, true, NEW_DEF]);
    assert.deepEqual(indexes.filter((i) => !i.valid), [], 'no INVALID index on session');

    // Run again (an operator's re-run, or a deploy that resolves it as rolled back by mistake): IF EXISTS.
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [RELEASE_B]);
    const again = await prisma(url, ['migrate', 'deploy']);
    assert.equal(again.code, 0, again.out);
    assert.deepEqual(await claimIndexes(sql), [[NEW_INDEX, true, true]]);
  });

  await t.test('(3) the new index alone: the four dispatch paths again, zero 42P10, zero doubled tasks', async () => {
    const from = watch.errors.length;
    const fromStatements = watch.statements.length;
    await rehearse(sql, a, b, population, take, 'new index alone');
    const errors = watch.errors.slice(from);
    console.log(`# new index alone: ${watch.statements.length - fromStatements} statements, errors by SQLSTATE `
      + `${JSON.stringify(tally(errors.map((e) => `${e.code}${e.constraint ? ` ${e.constraint}` : ''}`)))}`);
    assert.ok(watch.statements.length - fromStatements > 1000, 'the driver watch saw the services\' statements');
    assert.equal(errors.filter((e) => e.code === '42P10').length, 0, 'zero 42P10');
    assert.equal(errors.filter((e) => e.constraint === OLD_INDEX).length, 0, 'nothing names the old index');
  });

  await t.test('(4) the precheck after the drop, and its fingerprint of deploy 1\'s carrier', async () => {
    const after = (await sql.query(sqlOf(precheck))).rows[0] as Record<string, unknown>;
    console.log(`# precheck after the drop (no pg_stat_statements here): ${JSON.stringify(after)}`);
    assert.equal(after.new_index_valid, true);
    assert.equal(after.old_index_valid, null);
    assert.equal(after.tasks_doubled, '0');
    assert.equal(after.old_carrier_calls, null, 'null without pg_stat_statements');

    // Deploy 1's carrier, as 45c327a903 states it (sessions/task-work-carrier.ts sessionCarriesTaskSql), under each
    // alias its callers give it; and every statement release A's services sent in this rehearsal.
    const deploy1Carrier = (s: string) => `(${s}."starts_task_work" = true
    AND ${s}."deleted_at" IS NULL
    AND ${s}."status" IN ('PENDING'::"run_status", 'RUNNING'::"run_status", 'AWAITING_INPUT'::"run_status")
    AND (${s}."status" <> 'AWAITING_INPUT'::"run_status" OR true))`;
    const deploy1 = ['carrier', 's', 'work_session', 'runnable_carrier'].map((s) => `SELECT 1 FROM "session" ${s} WHERE ${deploy1Carrier(s)}`);
    const releaseA = [...new Set(watch.statements)];
    const carriers = releaseA.filter((q) => /"starts_task_work" = true\s+AND (\w+)\."deleted_at" IS NULL\s+AND \1\."finished_at" IS NULL/.test(q));
    console.log(`# distinct statements the services sent: ${releaseA.length}; of them stating release A's carrier: ${carriers.length}`);
    assert.ok(carriers.length > 0, 'the paths sent the carrier the fingerprint is about');
    await sql.query('CREATE TEMP TABLE pg_stat_statements (query text, calls bigint)');
    try {
      await sql.query(`INSERT INTO pg_stat_statements SELECT q, 1 FROM unnest($1::text[]) q`, [releaseA]);
      const quiet = (await sql.query(sqlOf(precheck))).rows[0] as Record<string, unknown>;
      assert.deepEqual([quiet.old_carrier_statements, quiet.old_carrier_calls], ['0', '0'],
        'no statement of release A matches deploy 1\'s carrier');
      await sql.query(`INSERT INTO pg_stat_statements SELECT q, 7 FROM unnest($1::text[]) q`, [deploy1]);
      const loud = (await sql.query(sqlOf(precheck))).rows[0] as Record<string, unknown>;
      console.log(`# fingerprint: release A's ${releaseA.length} statements → ${quiet.old_carrier_statements}; with deploy 1's ${deploy1.length} carriers → ${loud.old_carrier_statements} statements, ${loud.old_carrier_calls} calls`);
      assert.deepEqual([loud.old_carrier_statements, loud.old_carrier_calls], [String(deploy1.length), String(7 * deploy1.length)],
        'each of deploy 1\'s carriers matches, with its calls');
    } finally {
      await sql.query('DROP TABLE pg_temp.pg_stat_statements');
    }
  });

  await t.test('(5) how Prisma sends the file: with a SET before it, 25001; alone, applied', async () => {
    // A scratch Prisma project on a schema of its own (the drop names no table there, so it touches nothing).
    const dir = mkdtempSync(join(tmpdir(), 'release-b-'));
    const schema = `release_b_probe_${RUN}`;
    try {
      const file = readFileSync(join(API, 'prisma', 'migrations', RELEASE_B, 'migration.sql'), 'utf8');
      const results: Record<string, Run> = {};
      for (const [variant, body] of [['with a SET before it', `SET lock_timeout = '2s';\n\n${file}`], ['as it is', file]] as const) {
        const project = join(dir, variant.replace(/\W+/g, '-'));
        mkdirSync(join(project, 'prisma', 'migrations', RELEASE_B), { recursive: true });
        writeFileSync(join(project, 'prisma', 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n}\n');
        writeFileSync(join(project, 'prisma.config.ts'), "export default { schema: 'prisma/schema.prisma', datasource: { url: process.env.DATABASE_URL } };\n");
        writeFileSync(join(project, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
        writeFileSync(join(project, 'prisma', 'migrations', RELEASE_B, 'migration.sql'), body);
        await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        const probeUrl = `${url}${url.includes('?') ? '&' : '?'}schema=${schema}`;
        results[variant] = await prisma(probeUrl, ['migrate', 'deploy'], project);
        const where = (await sql.query(`SELECT to_regclass($1) IS NOT NULL AS here`, [`"${schema}"._prisma_migrations`])).rows[0] as { here: boolean };
        assert.equal(where.here, true, `${variant}: the probe ran in its own schema`);
        console.log(`# ${variant}: exit ${results[variant].code}: ${results[variant].out.match(/ERROR:[^\n]*|All migrations have been successfully applied\./)?.[0] ?? results[variant].out}`);
      }
      assert.notEqual(results['with a SET before it'].code, 0);
      assert.match(results['with a SET before it'].out, /25001/);
      assert.match(results['with a SET before it'].out, /DROP INDEX CONCURRENTLY cannot run inside a transaction block/);
      assert.equal(results['as it is'].code, 0, results['as it is'].out);
    } finally {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(await claimIndexes(sql), [[NEW_INDEX, true, true]], 'the probe left session\'s indexes as they were');
  });
});
